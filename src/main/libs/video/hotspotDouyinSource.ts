/**
 * hotspotDouyinSource — 热搜成片【抖音混剪】素材源(路线 A:塞进现有热搜成片,不新建卡)。
 *
 * video pipeline(主进程)在配画面那步,若用户选「素材来源 = 抖音视频」,就调本模块:
 *   1. 确认抖音登录(没登录 → 开抖音 tab + 轮询等扫码,最多 3 分钟)
 *   2. 跑 backend 下发的 douyin_search 脚本(走 publish-drivers 热更新,放 video_drivers/
 *      douyin_search.js)——在浏览器里按标题搜抖音、进详情页 main world fetch 取【无水印】
 *      play_addr url,返回 url 列表
 *   3. 主进程 fetch 把这些 url 下到任务素材目录,返回本地 mp4 路径
 * 上层再把这些路径当作镜头 clips(开底部黑条盖原字幕)喂进 compose 混剪 + 配音。
 *
 * 全程「降级不报错」:没登录 / 没下发脚本 / 没取到源 → 返回空 paths,上层退回图片配图兜底。
 * 浏览器命令复用发布那套桥(pubCmd → sendBrowserCommand,按抖音 tabPattern 路由)。
 */

import fs from 'fs';
import path from 'path';
import { fetchPublishDrivers } from './publishers/remoteDrivers';
import { pubCmd, sleep } from './publishers/publisherUtils';
import { checkPlatformLogin, openPlatformLogin } from '../scenario/platformLoginDriver';
import { ensureVideoRunTab } from './videoRunWindow';

/** 真 async 函数沙箱(同 remoteDrivers.runRemoteDriver:无 require/fs/global,只能用注入的 ctx)。 */
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as
  (new (arg: string, body: string) => (ctx: any) => Promise<any>);

const LOGIN_WAIT_MS = 3 * 60 * 1000;

/** 可中断等待:每 0.5s 查一次 signal —— 重试间隔里点「停止」立即结束,不再干等整段(停止卡顿源之一)。 */
async function abortableWait(ms: number, signal?: AbortSignal): Promise<void> {
  for (let waited = 0; waited < ms && !signal?.aborted; waited += 500) await sleep(Math.min(500, ms - waited));
}

export interface DouyinClipsDiag {
  reached: boolean;       // 脚本是否跑起来并返回
  loggedIn: boolean;      // 抖音登录态
  gotUrls: number;        // 脚本取到的无水印 url 数
  downloaded: number;     // 实际下到本地的数量
  reason?: string;        // 失败原因(no_driver / not_logged_in / script_threw / no_urls / ...)
  scriptDiag?: unknown;   // 脚本自带诊断(搜了哪些词、命中几个、错误列表)
}

export interface DouyinClipsResult {
  paths: string[];
  /** 命中帖子的标题(desc)—— 拿真实抖音标题给 AI 写口播稿(替掉 Serper 联网取材)。 */
  titles: string[];
  diag: DouyinClipsDiag;
}

/**
 * 矩阵 edition 取材:智能选一个【已关联】抖音矩阵账号,用它的指纹内核搜+下素材。
 * 不走插件/扫码登录;账号都不可用 → 清晰报错(上层据此提示去关联抖音号),绝不抛。
 */
async function fetchDouyinClipsViaKernel(
  keywords: string[], wantCount: number, destDir: string,
  onLog: (m: string) => void, signal: AbortSignal | undefined, mode: 'video' | 'image',
  preferredAccountId?: string,
): Promise<DouyinClipsResult> {
  const diag: DouyinClipsDiag = { reached: false, loggedIn: false, gotUrls: 0, downloaded: 0 };
  if (signal?.aborted) { diag.reason = 'aborted'; return { paths: [], titles: [], diag }; }
  // 懒加载矩阵模块(避免顶层循环依赖)。
  const { accountsByPlatform, accountBadgeLabel, setAccountStatus } = require('../matrix/accountManager');
  const { launchKernel, kernelNavigate, checkKernelLogin, closeKernel } = require('../matrix/kernelPool');
  const { runMatrixDouyinSearch } = require('../matrix/driverCtx');

  const usable = (accountsByPlatform('douyin') as any[]).filter((a) => a.status !== 'login_required' && a.status !== 'banned' && a.status !== 'limited');
  if (usable.length === 0) {
    onLog('⚠️ 没有已关联的抖音矩阵账号,无法取材 —— 请到「我的矩阵账号」扫码关联一个抖音号');
    diag.reason = 'no_matrix_douyin_account';
    return { paths: [], titles: [], diag };
  }
  // 选号顺序:用户在向导里【指定的取材账号】排最前,其余作为登录失效时的兜底;没指定就智能选第一个已关联。
  let ordered = usable;
  if (preferredAccountId) {
    const pref = usable.find((a) => a.id === preferredAccountId);
    ordered = pref ? [pref, ...usable.filter((a) => a.id !== preferredAccountId)] : usable;
  }
  // 逐个候选号:起内核 + 验登录,找到第一个真登录的就用它取材。
  let accountId = '';
  for (const cand of ordered) {
    if (signal?.aborted) { diag.reason = 'aborted'; return { paths: [], titles: [], diag }; }
    try {
      await launchKernel({ accountId: cand.id, kernelVersion: cand.kernelVersion, userDataDir: cand.userDataDir, fingerprint: cand.fingerprint, proxy: cand.proxy, label: accountBadgeLabel(cand) });
    } catch { onLog(`   「${cand.displayName}」内核启动失败,换下一个…`); continue; }
    // 先导航到 www.douyin.com 再验登录:checkKernelLogin('douyin') 走 user/profile/self 接口判定,须同源(在 about:blank
    //   上跨域拿不到 cookie → 会误判已登录,正是"卡片已连接但抖音 session 已死→搜索撞登录墙→0 条"的根因)。
    try { await kernelNavigate(cand.id, 'https://www.douyin.com/'); await sleep(2500); } catch { /* 导航失败也继续,checkKernelLogin 自身兜底 */ }
    let loggedIn = false, checkFailed = false;
    try { loggedIn = await checkKernelLogin(cand.id, 'douyin'); } catch { checkFailed = true; } // 读失败不误杀
    if (loggedIn) { accountId = cand.id; onLog(`🧬 用抖音账号「${cand.displayName}」的指纹浏览器取材`); break; }
    // 明确判「未登录」才把卡片标「登录过期」(读失败只换下一个、不误标)→「我的矩阵账号」立即变红、下次也不再选它。
    if (!checkFailed) setAccountStatus(cand.id, 'login_required');
    onLog(`   「${cand.displayName}」登录态失效${checkFailed ? '(读取失败)' : ',已标「登录过期」'},换下一个…`);
    try { closeKernel(cand.id); } catch { /* ignore */ } // 引用计数 -1(refcount 决定真关与否)
  }
  if (!accountId) {
    onLog('⚠️ 已关联的抖音账号登录态都失效了,无法取材(请到「我的矩阵账号」重新扫码关联)');
    diag.reason = 'not_logged_in';
    return { paths: [], titles: [], diag };
  }
  diag.loggedIn = true;

  try {
    // 搜+取源(带重试,口径同插件版)。
    const MAX_TRIES = 3, RETRY_WAIT_MS = 8000;
    let urls: string[] = [], titles: string[] = [];
    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
      if (signal?.aborted) { diag.reason = 'aborted'; break; }
      onLog(mode === 'image' ? '🔎 按标题搜抖音图文、取图…' : '🔎 按标题搜抖音、取无水印源…');
      const r = await runMatrixDouyinSearch(accountId, keywords, wantCount, mode, onLog);
      diag.reached = true; diag.scriptDiag = r.diag;
      if (Array.isArray(r.titles) && r.titles.length > titles.length) titles = r.titles;
      if (Array.isArray(r.urls) && r.urls.length) { urls = r.urls; break; }
      if (r.reason && r.reason.startsWith('no_matrix_driver')) { onLog('⚠️ ' + r.reason); diag.reason = r.reason; break; }
      if (attempt < MAX_TRIES) { onLog(`   ⚠️ 第 ${attempt}/${MAX_TRIES} 次没搜到,等 ${Math.round(RETRY_WAIT_MS / 1000)}s 再试…`); await abortableWait(RETRY_WAIT_MS, signal); }
    }
    diag.gotUrls = urls.length;
    if (urls.length === 0) {
      if (!diag.reason) diag.reason = 'no_urls';
      onLog(mode === 'image' ? '⚠️ 抖音没取到可用图文图片' : '⚠️ 抖音没取到可用视频源');
      return { paths: [], titles, diag };
    }
    onLog(`⬇️ 下载 ${urls.length} 个抖音${mode === 'image' ? '图片' : '视频'}…`);
    try { fs.mkdirSync(destDir, { recursive: true }); } catch { /* 已存在 */ }
    const ext = mode === 'image' ? 'jpg' : 'mp4';
    const base = mode === 'image' ? 'img' : 'clip';
    const paths: string[] = [];
    const { matrixCmd } = require('../matrix/cdpCommands');
    for (let i = 0; i < urls.length; i++) {
      if (signal?.aborted) break;
      onLog(`⬇️ 下载 ${i + 1}/${urls.length}…`);
      const dest = path.join(destDir, `${base}_${String(i).padStart(2, '0')}.${ext}`);
      // 【内核同源下载】:内核页就在 www.douyin.com,play_addr 取的也是 douyin.com 同源域 →
      //   用 main_world_fetch_api(base64)在内核里下(带账号 cookie/同 IP),绕开主进程跨网络
      //   下 zjcdn 被 CORS/IP 绑定拒的问题(实测主进程下 zjcdn 全失败、内核下 douyin.com 域 OK)。
      let ok = false;
      try {
        const res: any = await matrixCmd(accountId, 'main_world_fetch_api', { url: String(urls[i]).replace(/playwm/g, 'play'), responseType: 'base64', credentials: 'include' });
        if (res && res.ok !== false && typeof res.body === 'string' && res.body.length > 100) {
          const buf = Buffer.from(res.body, 'base64');
          if (buf.length > 10000) { fs.writeFileSync(dest, buf); ok = true; }
        }
      } catch { /* 内核下失败 → 回落主进程直连 */ }
      // 兜底:内核下不到(极少数 douyin.com 也拒)→ 再试一次主进程直连。
      if (!ok) ok = await downloadOne(urls[i], dest);
      if (ok) { paths.push(dest); diag.downloaded++; }
      else onLog(`   ⏭️ 第 ${i + 1} 个下载失败,跳过`);
    }
    onLog(`✅ 抖音素材就绪:${paths.length}/${urls.length} 个${titles.length ? ` · ${titles.length} 个标题` : ''}`);
    return { paths, titles, diag };
  } finally {
    // 取完【强制关】取材窗:取材走 runExclusiveDouyin 串行锁,跑完时本流程是该号唯一使用者,直接关掉别留窗。
    //   (普通 closeKernel 是引用计数式,若之前「扫码连接/刷新信息」等漏关留了计数 → 归不了 0 → 窗口不关;
    //    force 跳过计数确保关闭。后续发布到抖音会自己重新起内核,不受影响。)
    try { if (accountId) closeKernel(accountId, { force: true }); } catch { /* ignore */ }
  }
}

/** 主进程 fetch 下载单个无水印视频到本地(参考 phaseRunner.downloadVideoToDisk)。 */
async function downloadOne(url: string, dest: string): Promise<boolean> {
  try {
    if (!/^https?:\/\//i.test(url)) return false;
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 5 * 60 * 1000);
    let buf: Buffer;
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 NoobClaw/1.0', Referer: 'https://www.douyin.com/' },
        signal: ctl.signal,
      });
      clearTimeout(to);
      if (!resp.ok) return false;
      buf = Buffer.from(await resp.arrayBuffer());
    } catch {
      clearTimeout(to);
      return false;
    }
    fs.writeFileSync(dest, buf);
    return buf.length > 10_000; // 太小基本是错误页/防盗链 HTML
  } catch {
    return false;
  }
}

/** 等抖音登录:先探一次,没登录就开抖音 tab + 轮询(最多 3 分钟)。 */
async function ensureDouyinLoggedIn(onLog: (m: string) => void, signal?: AbortSignal): Promise<boolean> {
  // ⚠️ 不再用 cookie 快路径:checkVideoLoginByCookie 会开「运行检查」(video_check)窗读 cookie,
  //   但取材【不负责关它】→ 跑完热搜成片后那个 about:blank 窗永远留着(用户实测的孤儿窗根因)。
  //   取材反正要开抖音 tab 搜素材,直接用 tab 校验(不开任何窗)即可,没登录再开抖音。
  let st = await checkPlatformLogin('douyin').catch(() => ({ loggedIn: false } as { loggedIn: boolean }));
  if (st.loggedIn) return true;
  onLog('🌐 打开抖音,等待登录(请在窗口里扫码,最多 3 分钟)…');
  try { await openPlatformLogin('douyin'); } catch { /* 开 tab 失败也继续轮询 */ }
  const deadline = Date.now() + LOGIN_WAIT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    await sleep(2500);
    st = await checkPlatformLogin('douyin').catch(() => ({ loggedIn: false } as { loggedIn: boolean }));
    if (st.loggedIn) return true;
  }
  return false;
}

// ── 抖音取材【串行锁】──────────────────────────────────────────────────
// 同一进程内可能有多条 video pipeline 同时在跑(手动任务走 main IPC、定时/scenario 任务走
// sidecar-server,两条都调 generateVideoBatch),而它们【共用同一个抖音浏览器 tab】。不串行的话,
// A 正在搜「黄大炜」时 B 把同一个 tab 导航去搜「范丞丞」→ A 抓到 B 的页面 → 出现「口播 A 配画面 B」
// 的串台(用户实测)。这里用一条 promise 链把所有抖音取材【逐个排队】跑,彻底杜绝交错。
let _douyinChain: Promise<unknown> = Promise.resolve();
let _douyinBusy = false;
const _douyinNoop = (): void => { /* 吞掉结果/异常,只为推进链尾 */ };
function runExclusiveDouyin<T>(onLog: (m: string) => void, fn: () => Promise<T>): Promise<T> {
  if (_douyinBusy) { try { onLog('⏳ 抖音浏览器忙(另一条视频正在取材),排队等待…'); } catch { /* ignore */ } }
  const next = _douyinChain.then(async (): Promise<T> => {
    _douyinBusy = true;
    try { return await fn(); } finally { _douyinBusy = false; }
  });
  // 链尾吞掉成功/失败,保证下一个排队者不被上一个的异常打断。
  _douyinChain = next.then(_douyinNoop, _douyinNoop);
  return next;
}

/**
 * 按关键词搜抖音、下素材到 destDir。mode='video' 下无水印视频(.mp4);'image' 下【图文笔记】的图(.jpg)。
 * 返回本地路径 + 诊断。绝不抛(降级返空)。【串行】:多条 pipeline 并发时排队,避免共用 tab 串台。
 */
export function fetchDouyinClips(
  keywords: string[],
  wantCount: number,
  destDir: string,
  onLog: (m: string) => void,
  signal?: AbortSignal,
  mode: 'video' | 'image' = 'video',
  preferredAccountId?: string,
): Promise<DouyinClipsResult> {
  return runExclusiveDouyin(onLog, () => fetchDouyinClipsImpl(keywords, wantCount, destDir, onLog, signal, mode, preferredAccountId));
}

async function fetchDouyinClipsImpl(
  keywords: string[],
  wantCount: number,
  destDir: string,
  onLog: (m: string) => void,
  signal?: AbortSignal,
  mode: 'video' | 'image' = 'video',
  preferredAccountId?: string,
): Promise<DouyinClipsResult> {
  const diag: DouyinClipsDiag = { reached: false, loggedIn: false, gotUrls: 0, downloaded: 0 };
  // 排队等待期间任务可能已被取消 → 直接降级返空,不再驱动浏览器。
  if (signal?.aborted) { diag.reason = 'aborted'; return { paths: [], titles: [], diag }; }

  // 矩阵 edition:没有浏览器插件 —— 取材走【向导里指定的取材账号(没指定则智能选一个已关联抖音号)+ 它的指纹内核 CDP】。
  let MATRIX = false;
  try { MATRIX = require('../../matrixEdition').MATRIX_EDITION === true; } catch { /* 非矩阵构建 */ }
  if (MATRIX) return fetchDouyinClipsViaKernel(keywords, wantCount, destDir, onLog, signal, mode, preferredAccountId);

  // 1. 拉下发脚本(走发布 driver 同款 publish-drivers 热更新;key = 文件名 douyin_search)
  const pack = await fetchPublishDrivers();
  const code = pack?.drivers?.['douyin_search'];
  if (!code) {
    onLog('⚠️ 后端没下发抖音搜索脚本(video_drivers/douyin_search.js),无法取材');
    diag.reason = 'no_driver';
    return { paths: [], titles: [], diag };
  }

  // 2. 抖音登录
  const ok = await ensureDouyinLoggedIn(onLog, signal);
  if (!ok) {
    onLog('⚠️ 抖音未登录,跳过抖音取材(退回图片配图)');
    diag.reason = 'not_logged_in';
    return { paths: [], titles: [], diag };
  }
  diag.loggedIn = true;

  // 3. 跑搜+取源脚本 —— 钉到【视频运行窗口】的固定 tab(video_publish,跟发布共用),不抢 scenario
  //    的抖音 tab、也不跟别的视频 pipeline 抢(物理隔离,堵串台)。拿不到(旧扩展)→ videoTabId
  //    为 undefined,pubCmd 自动回退 tabPattern 路由(行为同改动前)。
  const videoTabId = await ensureVideoRunTab(onLog);
  if (typeof videoTabId === 'number') onLog('🪟 抖音取材走【视频专用窗口】(与发布共用,隔离 scenario)');
  onLog(mode === 'image' ? '🔎 按标题搜抖音图文、取图…' : '🔎 按标题搜抖音、取无水印源…');
  // 【搜空重试】(用户要求:搜了没视频多重试 2 次 + 每次重试前给固定等待 —— 有时只是瞬时没网,等一下再搜就有了)。
  //   根因:driver(douyin_search.js)每次搜索已等 ~22s 结果渲染,但【没网时 navigate 直接失败 → 不等就返 0】
  //   → 表现为"同一秒就没视频"。所以重跑整个搜索 driver(网络恢复后下一次 navigate 就成);登录/开窗在循环外
  //   只做一次,只重试【搜+取源】这步。每次重试前固定等 RETRY_WAIT_MS,给瞬断网络/SPA 恢复时间。
  const MAX_TRIES = 3;          // 1 次 + 2 次重试
  const RETRY_WAIT_MS = 8000;   // 每次重试前的固定等待
  let ret: any = null;
  let urls: string[] = [];
  let titles: string[] = [];
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    if (signal?.aborted) { diag.reason = 'aborted'; return { paths: [], titles: [], diag }; }
    try {
      const fn = new AsyncFunction('ctx', code);
      const sctx = {
        input: { keywords, wantCount, mode },
        cmd: (command: string, params: any, timeoutMs: number) => pubCmd('douyin', command, params, timeoutMs, videoTabId),
        sleep,
        log: (m: string) => { try { onLog('   ' + m); } catch { /* ignore */ } },
      };
      ret = await fn(sctx);
    } catch (e: any) {
      onLog('⚠️ 抖音取材脚本异常:' + String(e?.message || e).slice(0, 100));
      ret = null;
    }
    diag.reached = true;
    urls = Array.isArray(ret?.urls) ? ret.urls.filter((u: any) => typeof u === 'string') : [];
    // 真实抖音帖子标题(去重去空)—— 给 AI 写口播稿当素材(替掉 Serper)。
    const t = Array.isArray(ret?.titles)
      ? Array.from(new Set((ret.titles as any[]).filter((s) => typeof s === 'string' && s.trim()).map((s: string) => s.trim())))
      : [];
    if (t.length > titles.length) titles = t; // 跨重试保留拿到最多标题的那次(标题没视频也能给 AI 写稿用)
    if (urls.length > 0) break;
    if (attempt < MAX_TRIES) {
      onLog(`   ⚠️ 第 ${attempt}/${MAX_TRIES} 次没搜到${mode === 'image' ? '图文' : '视频'},等 ${Math.round(RETRY_WAIT_MS / 1000)}s 再试(可能瞬时没网)…`);
      await abortableWait(RETRY_WAIT_MS, signal);
    }
  }
  diag.scriptDiag = ret?.diag;
  diag.gotUrls = urls.length;
  if (urls.length === 0) {
    onLog(mode === 'image' ? `⚠️ 抖音没取到可用图文图片(已试 ${MAX_TRIES} 次)` : `⚠️ 抖音没取到可用视频源(已试 ${MAX_TRIES} 次)`);
    diag.reason = ret?.reason || 'no_urls';
    return { paths: [], titles: [], diag };
  }

  // 4. 主进程下载到本地素材目录
  onLog(`⬇️ 下载 ${urls.length} 个抖音${mode === 'image' ? '图片' : '视频'}…`);
  try { fs.mkdirSync(destDir, { recursive: true }); } catch { /* 已存在 */ }
  const ext = mode === 'image' ? 'jpg' : 'mp4';
  const base = mode === 'image' ? 'img' : 'clip'; // 文件名不带平台名(用户要求)
  const paths: string[] = [];
  for (let i = 0; i < urls.length; i++) {
    if (signal?.aborted) break;
    // 逐个报下载进度(大视频走 VPN 可能几十秒/个,不报的话用户以为卡死)。
    onLog(`⬇️ 下载 ${i + 1}/${urls.length}…`);
    const dest = path.join(destDir, `${base}_${String(i).padStart(2, '0')}.${ext}`);
    if (await downloadOne(urls[i], dest)) {
      paths.push(dest);
      diag.downloaded++;
    } else {
      onLog(`   ⏭️ 第 ${i + 1} 个下载失败,跳过`);
    }
  }
  onLog(`✅ 抖音素材就绪:${paths.length}/${urls.length} 个${titles.length ? ` · ${titles.length} 个标题` : ''}`);
  return { paths, titles, diag };
}
