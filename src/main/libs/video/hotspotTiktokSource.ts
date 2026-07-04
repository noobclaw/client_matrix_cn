/**
 * hotspotTiktokSource — 热搜成片【TikTok 取材】素材源(英文/小语种话题用,对称抖音 hotspotDouyinSource)。
 *
 * video pipeline(主进程)在配画面那步,若话题是英文/小语种(detectLang 非 zh),就调本模块:
 *   1. 确认 TikTok 登录(cookie 快路径 → 没登录则开 tiktok.com tab + 轮询,最多 3 分钟;大陆需 VPN)
 *   2. 跑 backend 下发的 tiktok_search 脚本(走 publish-drivers 热更新,放 video_drivers/
 *      tiktok_search.js)——按标题搜 TikTok、SSR 解析【无水印】视频 url(video 模式)/ 图集图 url
 *      (image 模式),并抓真实帖子标题,返回 { urls, titles, diag }
 *   3. 主进程把 url 下到任务素材目录:【浏览器 fetch base64 优先】(TikTok CDN 在日本/大陆常单点
 *      失败,浏览器自带网络栈最稳)→ Node fetch 兜底,返回本地路径
 * 上层再把路径当镜头 clips(视频开底部黑条盖原字幕)/ 配图(图集图缓慢运镜);标题给 AI 写口播稿。
 *
 * 全程「降级不报错」:没登录 / 没下发脚本 / 没取到源 → 返回空 paths,上层退回文字卡兜底。
 * 浏览器命令复用发布那套桥(pubCmd → sendBrowserCommand,钉【视频专用窗口】tab,隔离 scenario)。
 * 【串行】:多条 pipeline 并发时排队,避免共用 tab 串台(同抖音 runExclusiveDouyin)。
 */

import fs from 'fs';
import path from 'path';
import { fetchPublishDrivers } from './publishers/remoteDrivers';
import { pubCmd, sleep } from './publishers/publisherUtils';
import { checkPlatformLogin, openPlatformLogin } from '../scenario/platformLoginDriver';
import { ensureVideoRunTab } from './videoRunWindow';

/** 真 async 函数沙箱(同 hotspotDouyinSource:无 require/fs/global,只能用注入的 ctx)。 */
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as
  (new (arg: string, body: string) => (ctx: any) => Promise<any>);

const LOGIN_WAIT_MS = 3 * 60 * 1000;
const TIKTOK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface TiktokClipsDiag {
  reached: boolean;       // 脚本是否跑起来并返回
  loggedIn: boolean;      // TikTok 登录态
  gotUrls: number;        // 脚本取到的 url 数
  downloaded: number;     // 实际下到本地的数量
  reason?: string;        // 失败原因(no_driver / not_logged_in / script_threw / no_urls / ...)
  scriptDiag?: unknown;   // 脚本自带诊断(搜了哪些词、命中几条、错误列表)
}

export interface TiktokClipsResult {
  paths: string[];
  /** 命中帖子的标题(desc)—— 拿真实 TikTok 标题给 AI 写口播稿(替掉 Serper 联网取材)。 */
  titles: string[];
  diag: TiktokClipsDiag;
}

function unwrap(res: any): any {
  if (!res) return res;
  if (res.result !== undefined) return res.result;
  if (res.data !== undefined) return res.data;
  return res;
}

/** 浏览器 fetch 取字节(MAIN world,base64)——TikTok CDN 最稳的下载路径(浏览器自带 DNS/TLS 栈)。 */
async function browserFetchToFile(url: string, dest: string, videoTabId?: number): Promise<boolean> {
  try {
    const res = unwrap(await pubCmd('tiktok', 'main_world_fetch_api', {
      url, method: 'GET', credentials: 'include', responseType: 'base64',
    }, 180_000, videoTabId));
    const body: string | undefined = res && res.body;
    const enc = res && res.encoding;
    if (res && res.ok && body && enc === 'base64') {
      const buf = Buffer.from(body, 'base64');
      if (buf.length > 10_000) { fs.writeFileSync(dest, buf); return true; }
    }
  } catch { /* 走 Node 兜底 */ }
  return false;
}

/** Node fetch 兜底:视频/图片 CDN 只要 Referer(无 cookies/签名)。 */
async function nodeFetchToFile(url: string, dest: string): Promise<boolean> {
  try {
    if (!/^https?:\/\//i.test(url)) return false;
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 5 * 60 * 1000);
    let buf: Buffer;
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': TIKTOK_UA, Referer: 'https://www.tiktok.com/' },
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

/** 下单个 url:浏览器 fetch 优先(TikTok CDN 最稳)→ Node fetch 兜底。 */
async function downloadOne(url: string, dest: string, videoTabId?: number): Promise<boolean> {
  if (await browserFetchToFile(url, dest, videoTabId)) return true;
  return nodeFetchToFile(url, dest);
}

/**
 * 矩阵 edition 取材:用【向导里指定的取材账号(没指定则智能选一个已关联 TikTok 号)】的指纹内核搜+下素材。
 * 对称抖音 hotspotDouyinSource.fetchDouyinClipsViaKernel:不走插件/扫码登录,直接起该号内核 CDP。
 * 账号都不可用 → 清晰报错(上层据此提示去关联 TikTok 号),绝不抛。
 */
async function fetchTiktokClipsViaKernel(
  keywords: string[], wantCount: number, destDir: string,
  onLog: (m: string) => void, signal: AbortSignal | undefined, mode: 'video' | 'image',
  preferredAccountId?: string,
): Promise<TiktokClipsResult> {
  const diag: TiktokClipsDiag = { reached: false, loggedIn: false, gotUrls: 0, downloaded: 0 };
  if (signal?.aborted) { diag.reason = 'aborted'; return { paths: [], titles: [], diag }; }
  // 懒加载矩阵模块(避免顶层循环依赖)。
  const { accountsByPlatform, accountBadgeLabel } = require('../matrix/accountManager');
  const { launchKernel, kernelNavigate, checkKernelLogin, closeKernel } = require('../matrix/kernelPool');
  const { runMatrixTiktokSearch } = require('../matrix/driverCtx');

  const usable = (accountsByPlatform('tiktok') as any[]).filter((a) => a.status !== 'login_required' && a.status !== 'banned' && a.status !== 'limited');
  if (usable.length === 0) {
    onLog('⚠️ 没有已关联的 TikTok 矩阵账号,无法取材 —— 请到「我的矩阵账号」关联一个 TikTok 号(大陆需 VPN)');
    diag.reason = 'no_matrix_tiktok_account';
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
    // 先导航到 www.tiktok.com 再验登录(须同源才拿得到 cookie,about:blank 上会误判)。
    try { await kernelNavigate(cand.id, 'https://www.tiktok.com/'); await sleep(2500); } catch { /* 导航失败也继续,checkKernelLogin 自身兜底 */ }
    const loggedIn = await checkKernelLogin(cand.id, 'tiktok').catch(() => false);
    if (loggedIn) { accountId = cand.id; onLog(`🧬 用 TikTok 账号「${cand.displayName}」的指纹浏览器取材`); break; }
    onLog(`   「${cand.displayName}」登录态失效,换下一个…`);
    try { closeKernel(cand.id); } catch { /* ignore */ } // 引用计数 -1
  }
  if (!accountId) {
    onLog('⚠️ 已关联的 TikTok 账号登录态都失效了,无法取材(请到「我的矩阵账号」重新登录关联,大陆需 VPN)');
    diag.reason = 'not_logged_in';
    return { paths: [], titles: [], diag };
  }
  diag.loggedIn = true;

  try {
    // 搜+取源(带重试,口径同抖音内核版)。
    const MAX_TRIES = 3, RETRY_WAIT_MS = 8000;
    let urls: string[] = [], titles: string[] = [];
    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
      if (signal?.aborted) { diag.reason = 'aborted'; break; }
      onLog(mode === 'image' ? '🔎 按标题搜 TikTok 图集、取图…' : '🔎 按标题搜 TikTok、取无水印源…');
      const r = await runMatrixTiktokSearch(accountId, keywords, wantCount, mode, onLog);
      diag.reached = true; diag.scriptDiag = r.diag;
      if (Array.isArray(r.titles) && r.titles.length > titles.length) titles = r.titles;
      if (Array.isArray(r.urls) && r.urls.length) { urls = r.urls; break; }
      if (r.reason && r.reason.startsWith('no_matrix_driver')) { onLog('⚠️ ' + r.reason); diag.reason = r.reason; break; }
      if (attempt < MAX_TRIES) { onLog(`   ⚠️ 第 ${attempt}/${MAX_TRIES} 次没搜到,等 ${Math.round(RETRY_WAIT_MS / 1000)}s 再试(可能瞬时没网/VPN 抖动)…`); await sleep(RETRY_WAIT_MS); }
    }
    diag.gotUrls = urls.length;
    if (urls.length === 0) {
      if (!diag.reason) diag.reason = 'no_urls';
      onLog(mode === 'image' ? '⚠️ TikTok 没取到可用图集图片' : '⚠️ TikTok 没取到可用视频源');
      return { paths: [], titles, diag };
    }
    onLog(`⬇️ 下载 ${urls.length} 个 TikTok ${mode === 'image' ? '图片' : '视频'}…`);
    try { fs.mkdirSync(destDir, { recursive: true }); } catch { /* 已存在 */ }
    const ext = mode === 'image' ? 'jpg' : 'mp4';
    const base = mode === 'image' ? 'img' : 'clip';
    const paths: string[] = [];
    const { matrixCmd } = require('../matrix/cdpCommands');
    for (let i = 0; i < urls.length; i++) {
      if (signal?.aborted) break;
      onLog(`⬇️ 下载 ${i + 1}/${urls.length}…`);
      const dest = path.join(destDir, `${base}_${String(i).padStart(2, '0')}.${ext}`);
      // 【内核同源下载】:内核页在 tiktok.com,用 main_world_fetch_api(base64)带账号 cookie/同 IP 下,
      //   绕开主进程直连 TikTok CDN 被 IP 绑定/防盗链拒(TikTok CDN 在日本/大陆尤其易单点失败)。
      let ok = false;
      try {
        const res: any = await matrixCmd(accountId, 'main_world_fetch_api', { url: String(urls[i]), responseType: 'base64', credentials: 'include' });
        if (res && res.ok !== false && typeof res.body === 'string' && res.body.length > 100) {
          const buf = Buffer.from(res.body, 'base64');
          if (buf.length > 10000) { fs.writeFileSync(dest, buf); ok = true; }
        }
      } catch { /* 内核下失败 → 回落主进程直连 */ }
      // 兜底:内核下不到 → 主进程直连(带 Referer,无 cookie)。
      if (!ok) ok = await nodeFetchToFile(urls[i], dest);
      if (ok) { paths.push(dest); diag.downloaded++; }
      else onLog(`   ⏭️ 第 ${i + 1} 个下载失败,跳过`);
    }
    onLog(`✅ TikTok 素材就绪:${paths.length}/${urls.length} 个${titles.length ? ` · ${titles.length} 个标题` : ''}`);
    return { paths, titles, diag };
  } finally {
    // 取完【强制关】取材窗(取材走 runExclusiveTiktok 串行锁,跑完本流程是该号唯一使用者)。
    try { if (accountId) closeKernel(accountId, { force: true }); } catch { /* ignore */ }
  }
}

/** 等 TikTok 登录:cookie 快路径 → 先探一次 → 没登录就开 tiktok.com tab + 轮询(最多 3 分钟)。 */
async function ensureTiktokLoggedIn(onLog: (m: string) => void, signal?: AbortSignal): Promise<boolean> {
  // ⚠️ 不再用 cookie 快路径:checkVideoLoginByCookie 会开「运行检查」窗读 cookie 但取材不负责关 → 孤儿窗。
  //   取材反正要开 TikTok tab 搜素材,直接 tab 校验(不开窗),没登录再开 TikTok。
  let st = await checkPlatformLogin('tiktok').catch(() => ({ loggedIn: false } as { loggedIn: boolean }));
  if (st.loggedIn) return true;
  onLog('🌐 打开 TikTok,等待登录(请在窗口里登录,大陆用户需开 VPN,最多 3 分钟)…');
  try { await openPlatformLogin('tiktok'); } catch { /* 开 tab 失败也继续轮询 */ }
  const deadline = Date.now() + LOGIN_WAIT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    await sleep(2500);
    st = await checkPlatformLogin('tiktok').catch(() => ({ loggedIn: false } as { loggedIn: boolean }));
    if (st.loggedIn) return true;
  }
  return false;
}

// ── TikTok 取材【串行锁】──────────────────────────────────────────────────
// 同抖音:多条 video pipeline 可能并发(手动走 main IPC、定时/scenario 走 sidecar-server),共用同一个
// TikTok tab。不串行的话 A 搜词时 B 把 tab 导航走 → A 抓到 B 的页面(口播 A 配画面 B 串台)。用一条
// promise 链把所有 TikTok 取材逐个排队。注意:跟抖音是各自独立的锁(不同平台 tab,互不阻塞)。
let _tiktokChain: Promise<unknown> = Promise.resolve();
let _tiktokBusy = false;
const _tiktokNoop = (): void => { /* 吞掉结果/异常,只为推进链尾 */ };
function runExclusiveTiktok<T>(onLog: (m: string) => void, fn: () => Promise<T>): Promise<T> {
  if (_tiktokBusy) { try { onLog('⏳ TikTok 浏览器忙(另一条视频正在取材),排队等待…'); } catch { /* ignore */ } }
  const next = _tiktokChain.then(async (): Promise<T> => {
    _tiktokBusy = true;
    try { return await fn(); } finally { _tiktokBusy = false; }
  });
  _tiktokChain = next.then(_tiktokNoop, _tiktokNoop);
  return next;
}

/**
 * 按关键词搜 TikTok、下素材到 destDir。mode='video' 下无水印视频(.mp4);'image' 下【图集帖】的图(.jpg)。
 * 返回本地路径 + 标题 + 诊断。绝不抛(降级返空)。【串行】:多条 pipeline 并发时排队,避免共用 tab 串台。
 */
export function fetchTiktokClips(
  keywords: string[],
  wantCount: number,
  destDir: string,
  onLog: (m: string) => void,
  signal?: AbortSignal,
  mode: 'video' | 'image' = 'video',
  preferredAccountId?: string,
): Promise<TiktokClipsResult> {
  return runExclusiveTiktok(onLog, () => fetchTiktokClipsImpl(keywords, wantCount, destDir, onLog, signal, mode, preferredAccountId));
}

async function fetchTiktokClipsImpl(
  keywords: string[],
  wantCount: number,
  destDir: string,
  onLog: (m: string) => void,
  signal?: AbortSignal,
  mode: 'video' | 'image' = 'video',
  preferredAccountId?: string,
): Promise<TiktokClipsResult> {
  const diag: TiktokClipsDiag = { reached: false, loggedIn: false, gotUrls: 0, downloaded: 0 };
  // 排队等待期间任务可能已被取消 → 直接降级返空,不再驱动浏览器。
  if (signal?.aborted) { diag.reason = 'aborted'; return { paths: [], titles: [], diag }; }

  // 矩阵 edition:没有浏览器插件 —— 取材走【向导里指定的取材账号(没指定则智能选一个已关联 TikTok 号)+ 它的指纹内核 CDP】,
  //   不再新开 TikTok tab 扫码登录(对称抖音 fetchDouyinClipsViaKernel)。
  let MATRIX = false;
  try { MATRIX = require('../../matrixEdition').MATRIX_EDITION === true; } catch { /* 非矩阵构建 */ }
  if (MATRIX) return fetchTiktokClipsViaKernel(keywords, wantCount, destDir, onLog, signal, mode, preferredAccountId);

  // 1. 拉下发脚本(走发布 driver 同款 publish-drivers 热更新;key = 文件名 tiktok_search)
  const pack = await fetchPublishDrivers();
  const code = pack?.drivers?.['tiktok_search'];
  if (!code) {
    onLog('⚠️ 后端没下发 TikTok 搜索脚本(video_drivers/tiktok_search.js),无法取材');
    diag.reason = 'no_driver';
    return { paths: [], titles: [], diag };
  }

  // 2. TikTok 登录
  const ok = await ensureTiktokLoggedIn(onLog, signal);
  if (!ok) {
    onLog('⚠️ TikTok 未登录,跳过 TikTok 取材(退回文字卡)');
    diag.reason = 'not_logged_in';
    return { paths: [], titles: [], diag };
  }
  diag.loggedIn = true;

  // 3. 跑搜+取源脚本 —— 钉到【视频运行窗口】的固定 tab(跟发布共用,不抢 scenario tab、也不跟别的
  //    视频 pipeline 抢)。拿不到(旧扩展)→ videoTabId 为 undefined,pubCmd 自动回退 tabPattern 路由。
  const videoTabId = await ensureVideoRunTab(onLog);
  if (typeof videoTabId === 'number') onLog('🪟 TikTok 取材走【视频专用窗口】(与发布共用,隔离 scenario)');
  onLog(mode === 'image' ? '🔎 按标题搜 TikTok 图集、取图…' : '🔎 按标题搜 TikTok、取无水印源…');
  // 【搜空重试】(对称抖音 hotspotDouyinSource:搜了没视频多重试 2 次 + 每次重试前固定等待)。
  //   TikTok 走 VPN、更易瞬断 → 没网时 driver navigate 失败就返 0(同一秒没视频)→ 重跑整个搜索(网络/VPN 恢复
  //   后下一次就成);登录/开窗在循环外只做一次,只重试【搜+取源】。
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
        cmd: (command: string, params: any, timeoutMs: number) => pubCmd('tiktok', command, params, timeoutMs, videoTabId),
        sleep,
        log: (m: string) => { try { onLog('   ' + m); } catch { /* ignore */ } },
      };
      ret = await fn(sctx);
    } catch (e: any) {
      onLog('⚠️ TikTok 取材脚本异常:' + String(e?.message || e).slice(0, 100));
      ret = null;
    }
    diag.reached = true;
    urls = Array.isArray(ret?.urls) ? ret.urls.filter((u: any) => typeof u === 'string') : [];
    // 真实 TikTok 帖子标题(去重去空)—— 给 AI 写口播稿当素材(替掉 Serper)。
    const t = Array.isArray(ret?.titles)
      ? Array.from(new Set((ret.titles as any[]).filter((s) => typeof s === 'string' && s.trim()).map((s: string) => s.trim())))
      : [];
    if (t.length > titles.length) titles = t; // 跨重试保留拿到最多标题的那次
    if (urls.length > 0) break;
    if (attempt < MAX_TRIES) {
      onLog(`   ⚠️ 第 ${attempt}/${MAX_TRIES} 次没搜到${mode === 'image' ? '图集' : '视频'},等 ${Math.round(RETRY_WAIT_MS / 1000)}s 再试(可能瞬时没网/VPN 抖动)…`);
      await sleep(RETRY_WAIT_MS);
    }
  }
  diag.scriptDiag = ret?.diag;
  diag.gotUrls = urls.length;
  if (urls.length === 0) {
    onLog(mode === 'image' ? `⚠️ TikTok 没取到可用图集图片(已试 ${MAX_TRIES} 次)` : `⚠️ TikTok 没取到可用视频源(已试 ${MAX_TRIES} 次)`);
    diag.reason = ret?.reason || 'no_urls';
    return { paths: [], titles, diag };
  }

  // 4. 主进程下载到本地素材目录(浏览器 fetch 优先 → Node 兜底)
  onLog(`⬇️ 下载 ${urls.length} 个 TikTok ${mode === 'image' ? '图片' : '视频'}…`);
  try { fs.mkdirSync(destDir, { recursive: true }); } catch { /* 已存在 */ }
  const ext = mode === 'image' ? 'jpg' : 'mp4';
  const base = mode === 'image' ? 'img' : 'clip'; // 文件名不带平台名(对齐抖音,用户要求)
  const paths: string[] = [];
  for (let i = 0; i < urls.length; i++) {
    if (signal?.aborted) break;
    // 逐个报下载进度(大视频走 VPN 可能几十秒/个,不报的话用户以为卡死)。
    onLog(`⬇️ 下载 ${i + 1}/${urls.length}…`);
    const dest = path.join(destDir, `${base}_${String(i).padStart(2, '0')}.${ext}`);
    if (await downloadOne(urls[i], dest, videoTabId)) {
      paths.push(dest);
      diag.downloaded++;
    } else {
      onLog(`   ⏭️ 第 ${i + 1} 个下载失败,跳过`);
    }
  }
  onLog(`✅ TikTok 素材就绪:${paths.length}/${urls.length} 个${titles.length ? ` · ${titles.length} 个标题` : ''}`);
  return { paths, titles, diag };
}
