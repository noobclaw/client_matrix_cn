/**
 * runPublish —— 给 pipeline 调用的统一 publish step。
 *
 * 用户硬约束(写在 PublisherDriver 契约里 + 这里再实现一遍):
 *   · 单平台未登录 → 跳过,日志推一条「⚠️ 抖音未登录,跳过(本条视频不再补传)」
 *   · 单平台上传失败 → 跳过,日志推 reason,继续下一个
 *   · 全部跳过/失败 → 任务仍 done(本地 mp4 还在),不杀任务
 *
 * pipeline.ts 和 template-pipeline.ts 都调这个函数 → 行为一致,Bug 修一处全好。
 *
 * v6.13 单 tab 复用(本次改动核心):
 *   旧版每个平台调 openCreatorCenter/openPlatformLogin,各开一个【独立窗口】(一平台一
 *   子域一窗口一 tab),9 个平台 = 9 个窗口爆炸。现在改成开【一个专用 video_publish 窗口
 *   的固定 tab】,9 个平台【共用这一个 tab】靠 navigate 串行切上传页,命令全部按 tabId 钉
 *   到这个 tab(extension chrome.tabs.get 直接寻址,绕过 tabPattern)。
 *
 *   未登录的:在进度里提醒,反复检测,【最多等 3 分钟】仍未登录 → 跳过该平台,且【只针对
 *   本条视频不补传】(下次出新片是新 run,照常重试所有平台 —— 不持久化任何"放弃"标记)。
 *
 *   向后兼容:旧扩展(无 window_registry_v6 能力)/开窗失败时,tabId 拿不到 → 自动回退到
 *   旧的「每平台独立窗口」模式(ensureLoggedInTab + driver.upload 不带 tabId),行为不变。
 */

import type { VideoPlatform, PublishInput, PublishCtx } from './types';
import { VIDEO_PLATFORMS } from './types';
import { getDriver } from './registry';
import { fetchPublishDrivers, runRemoteDriver } from './remoteDrivers';
import {
  openCreatorCenter, openPlatformLogin, platformHasCreatorCenter,
  checkCreatorCenter, checkPlatformLogin, type LoginPlatform,
} from '../../scenario/platformLoginDriver';
import { sendBrowserCommand, connectionHasCapability } from '../../browserBridge';
import { getStandardBounds } from '../../scenario/subPlatformRegistry';
import { PUBLISHER_ANCHOR_URL, bridgeOptsFor, setPublishAbortSignal } from './publisherUtils';
import { videoWindowTitle } from '../videoRunWindow';
import { checkVideoLoginByCookie } from '../videoLoginCheck';
import { getVideoConfig } from '../videoConfig';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/**
 * 可被「停止」打断的等待:用户点停止时立刻返回,不用等满。
 * 发布阶段的等待动辄 2 分钟(postSubmitWaitMs),纯 sleep 会把 abort 吞掉整段,
 * 用户点了停止还得眼看着浏览器又等两分钟 —— 这是「视频任务停不下来」的主要观感来源。
 */
const sleepAbortable = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => { clearTimeout(timer); resolve(); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
// 提交后默认等这么久:平台(尤其抖音)是「点提交后才真正开始上传视频」,过早进入下一动作/刷新会白提交。
// ⚠️ 默认值;runPublishStep 开头用 /api/video/config 的 postSubmitWaitMs 覆盖 → 改这个时间【只改后端
//    system_config(admin 后台)、客户端不打包】(用户要求:这种时间不该发版本)。
let POST_SUBMIT_WAIT_MS = 120_000;

/** 未登录的等待上限:默认 3 分钟(反复检测,超时跳过本条视频不补传)。
 *  默认值;runPublishStep 开头用 /api/video/config 的 loginWaitMs 覆盖(后端可调、不打包)。 */
let LOGIN_WAIT_MS = 3 * 60 * 1000;

/** 专用发布窗口的 sub_platform / windowKey(见 subPlatformRegistry.video_publish)。 */
const PUBLISH_SUB_PLATFORM = 'video_publish';
const PUBLISH_WINDOW_KEY = `${PUBLISH_SUB_PLATFORM}::default`;

/**
 * 开【一个】专用 video_publish 窗口的固定 tab,返回它的 tabId。9 个平台共用这一个 tab。
 *
 * 走 v6 windowRegistry(task_open_tab + windowKey):同 windowKey 幂等,这里第一次开就建
 * 一个新窗口。返回 res.tabId 给后续 navigate/upload 钉用。
 *
 * 拿不到 tabId(旧扩展无 v6 能力 / 开窗超时)→ 返回 undefined,调用方回退「每平台独立窗口」。
 */
async function openPublishTab(
  firstUrl: string,
  onLog: (m: string) => void,
): Promise<number | undefined> {
  if (!connectionHasCapability(undefined, 'window_registry_v6')) {
    onLog('ℹ️ 当前扩展无 v6 窗口注册表,回退「每平台独立窗口」模式');
    return undefined;
  }
  const title = videoWindowTitle(); // 标当前任务 id+类型(取材/发布共用同一窗口、同一 title)
  const bounds = getStandardBounds(PUBLISH_SUB_PLATFORM, 'default');
  try {
    const res: any = await sendBrowserCommand(
      'task_open_tab',
      {
        windowKey: PUBLISH_WINDOW_KEY,
        groupTitle: title,
        role: 'publisher',
        url: firstUrl,
        bounds,
        // taskId omitted —— video publish 不是 scenario 任务,不进 taskTabRegistry。
      },
      12000,
    );
    const tabId = res?.tabId ?? res?.data?.tabId;
    if (typeof tabId === 'number') return tabId;
    onLog('ℹ️ 开发布窗口未返回 tabId,回退「每平台独立窗口」模式');
    return undefined;
  } catch {
    onLog('ℹ️ 开发布窗口失败,回退「每平台独立窗口」模式');
    return undefined;
  }
}

/** 把固定发布 tab 导航到指定 URL(按 tabId 直接寻址,不走 tabPattern)。 */
async function navigateTab(url: string, tabId: number): Promise<void> {
  await sendBrowserCommand('navigate', { url, tabId }, 30_000);
}

/**
 * 登录成功后,把该平台的 tab 导航到【上传页】(PUBLISHER_ANCHOR_URL)。
 *
 * 为什么需要:openCreatorCenter 开的是创作中心【首页】,但 driver.upload 要在【上传页】
 * 找 file input。anchor 预检只在「没有匹配 tabPattern 的 tab」时才开新 tab —— 而首页 tab
 * 已存在且 tabPattern(如 creator\.douyin\.com)宽泛匹配它,预检不会导航到上传页 →
 * driver 在首页找不到 file input。所以这里显式 navigate 到精确上传页。失败不阻塞(driver
 * 内部 waitForSelector 还会再等;真不行就 upload 失败,不影响其它平台)。
 *
 * (回退模式专用 —— 单 tab 模式直接 navigateTab,见下。)
 */
async function navigateToUploadPage(platform: VideoPlatform, onLog: (m: string) => void): Promise<void> {
  const url = PUBLISHER_ANCHOR_URL[platform];
  if (!url) return;
  try {
    await sendBrowserCommand('navigate', { url }, 30_000, bridgeOptsFor(platform));
    await sleep(1500); // 给页面加载一点时间
  } catch {
    onLog('导航到上传页未成功,driver 将自行等待页面元素');
  }
}

/**
 * 【单 tab 模式】登录前置:把【固定发布 tab】导航到该平台上传页 + 轮询等登录态 OK。
 *
 * 跟旧 ensureLoggedInTab 的区别:不再 openCreatorCenter/openPlatformLogin 开【新窗口】,
 * 而是 navigate【同一个 video_publish tab】过去 —— 用户就在这一个窗口里扫码 / 登录各平台,
 * 不会窗口爆炸。登录态检测仍走 checkCreatorCenter/checkPlatformLogin(扫全局 tab_list,
 * navigate 过去后这个 tab 的 URL 就匹配上,所以现成函数直接复用,不需要 tabId)。
 *
 * 绝不抛。返回 'logged_in' / 'not_logged_in'(超时)/ 'browser_not_connected'。
 */
async function ensureLoggedInOnTab(
  platform: VideoPlatform,
  tabId: number,
  onLog: (m: string) => void,
  signal?: AbortSignal,
  timeoutMs = LOGIN_WAIT_MS,
): Promise<'logged_in' | 'not_logged_in' | 'browser_not_connected'> {
  const p = platform as unknown as LoginPlatform;
  const hasCreator = platformHasCreatorCenter(p);
  const check = () => (hasCreator ? checkCreatorCenter(p) : checkPlatformLogin(p));
  const anchor = PUBLISHER_ANCHOR_URL[platform];

  // 先把发布 tab 切到该平台上传页(创作中心 / 主站发布页)。
  onLog(`🌐 切到${hasCreator ? '创作中心' : '平台'}上传页…`);
  try { await navigateTab(anchor, tabId); } catch { /* 继续,下面轮询会再等 */ }
  await sleep(1500);

  // cookie 快路径:读该平台(创作中心走 creator 子域)登录 cookie,有效直接过 —— 不依赖创作中心页
  //   是否加载好、是否被弹登录。拿不准(null/false)再退老的 tab 校验,fail-safe。
  const ckWhich = hasCreator ? 'creator' : 'main';
  const ck0 = await checkVideoLoginByCookie(p, ckWhich, tabId).catch((): { loggedIn: boolean } | null => null);
  if (ck0?.loggedIn) return 'logged_in';
  // 先探一次:用户可能早就登录了(cookie 在),navigate 过去直接就是登录态。
  let st = await check().catch(() => ({ loggedIn: false, reason: 'check_threw' } as any));
  if (st.loggedIn) return 'logged_in';
  if (st.reason === 'browser_not_connected') {
    onLog('🔌 浏览器未连接(请先打开装了 NoobClaw 插件的 Chrome/Edge)');
    return 'browser_not_connected';
  }

  onLog('⏳ 未登录 · 请在发布窗口里登录该平台(最多等 3 分钟,超时跳过本条视频)…');
  const deadline = Date.now() + timeoutMs;
  let lastBeat = 0;
  while (Date.now() < deadline) {
    if (signal?.aborted) return 'not_logged_in';
    await sleep(2500);
    const ckN = await checkVideoLoginByCookie(p, ckWhich, tabId).catch((): { loggedIn: boolean } | null => null);
    if (ckN?.loggedIn) return 'logged_in';
    st = await check().catch(() => ({ loggedIn: false } as any));
    if (st.loggedIn) return 'logged_in';
    if (st.reason === 'browser_not_connected') {
      onLog('🔌 浏览器连接断开,放弃该平台');
      return 'browser_not_connected';
    }
    const elapsed = timeoutMs - (deadline - Date.now());
    if (elapsed - lastBeat >= 15_000) {
      lastBeat = elapsed;
      onLog(`⏳ 仍在等登录… ${Math.round(elapsed / 1000)}s(请在发布窗口扫码 / 登录)`);
    }
  }
  return 'not_logged_in';
}

/**
 * 【回退模式】登录前置:自动开浏览器对应平台的 tab(创作中心 / 主站)+ 轮询等登录态 OK。
 * 只在 tabId 拿不到(旧扩展)时走这条 —— 每平台开一个独立窗口(老行为)。
 */
async function ensureLoggedInTab(
  platform: VideoPlatform,
  onLog: (m: string) => void,
  signal?: AbortSignal,
  timeoutMs = LOGIN_WAIT_MS,
): Promise<'logged_in' | 'not_logged_in' | 'browser_not_connected'> {
  const p = platform as unknown as LoginPlatform;
  const hasCreator = platformHasCreatorCenter(p);
  const check = () => (hasCreator ? checkCreatorCenter(p) : checkPlatformLogin(p));

  // 先探一次:可能用户早就开着 tab + 登录了,不用再开。
  let st = await check().catch(() => ({ loggedIn: false, reason: 'check_threw' } as any));
  if (st.loggedIn) return 'logged_in';
  if (st.reason === 'browser_not_connected') {
    onLog('🔌 浏览器未连接(请先打开装了 NoobClaw 插件的 Chrome/Edge)');
    return 'browser_not_connected';
  }

  // 没登录 / tab 不在 → 自动开 tab(创作中心优先)。
  onLog(`🌐 打开${hasCreator ? '创作中心' : '平台'} tab,等待登录…`);
  try {
    const opened = hasCreator ? await openCreatorCenter(p) : await openPlatformLogin(p);
    if (!opened.ok) onLog(`   开 tab 未成功(${opened.reason || 'unknown'}),继续轮询登录态…`);
  } catch { /* 开 tab 失败也继续轮询,也许用户手动开了 */ }

  // 轮询等登录(给扫码 / 加载时间)。
  const deadline = Date.now() + timeoutMs;
  let lastBeat = 0;
  while (Date.now() < deadline) {
    if (signal?.aborted) return 'not_logged_in';
    await sleep(2500);
    st = await check().catch(() => ({ loggedIn: false } as any));
    if (st.loggedIn) return 'logged_in';
    if (st.reason === 'browser_not_connected') {
      onLog('🔌 浏览器连接断开,放弃该平台');
      return 'browser_not_connected';
    }
    // 心跳:每 ~15s 提示一次还在等
    const elapsed = timeoutMs - (deadline - Date.now());
    if (elapsed - lastBeat >= 15_000) {
      lastBeat = elapsed;
      onLog(`⏳ 等待登录中… ${Math.round(elapsed / 1000)}s(请在打开的窗口扫码 / 登录)`);
    }
  }
  return 'not_logged_in';
}

export interface RunPublishOptions {
  /** 用户在向导里勾选的平台 id 列表(来自 input.publishPlatforms)。 */
  platforms: string[];
  /** 视频 mp4 本地路径。 */
  videoPath: string;
  /** 标题(若 task 有的话;用户文案 / AI 生成的标题)。 */
  title?: string;
  /** 描述 / 正文(口播稿 / dataText / scriptMode='strict' 的 script 等,driver 自行 truncate)。 */
  description?: string;
  /** 标签(driver 自行格式化成 #tag / 话题等)。 */
  tags?: string[];
  /** 日志回调:每条进度推给 tracker.progress(让 UI 看到)。 */
  onLog?: (msg: string) => void;
  /** 中断信号:用户停止任务时跳过剩余平台。 */
  signal?: AbortSignal;
}

export interface RunPublishResult {
  /** 真的发出去的平台数。 */
  publishedCount: number;
  /** 跳过的平台数(未登录 / driver 未实装)。 */
  skippedCount: number;
  /** 上传失败的平台数(driver 跑了但返回 ok:false)。 */
  failedCount: number;
  /** 每个平台的最终结果(顺序跟输入一致)。 */
  details: Array<{ platform: string; status: 'published' | 'skipped' | 'failed'; reason?: string }>;
}

function platformLabel(id: string): string {
  const m = VIDEO_PLATFORMS.find((p) => p.id === id);
  return m ? `${m.emoji} ${m.zh}` : id;
}

/**
 * 跑 publish step:iterate 用户勾选的平台 → 对每个调 driver(已登录就上传,未登录跳过)。
 * 任何单平台异常都吞掉、记日志、继续下一个。绝不抛。
 *
 * v6.13:开头开【一个】专用发布窗口,9 平台共用其 tab 串行 navigate + 上传(见文件头注释)。
 */
export async function runPublishStep(opts: RunPublishOptions): Promise<RunPublishResult> {
  const list = Array.isArray(opts.platforms) ? opts.platforms.filter(Boolean) : [];
  const result: RunPublishResult = {
    publishedCount: 0, skippedCount: 0, failedCount: 0, details: [],
  };

  if (list.length === 0) {
    opts.onLog?.('📂 未选发布平台 · 仅存本地');
    return result;
  }

  // 把本次的停止信号挂到 publisherUtils 的模块级槽位 —— 9 个 driver 的长等待
  // (waitForSelector 最长 5 分钟、clickWithText 重试、sleep 间隔)都走那边的 helper,
  // 挂上之后整体可打断,不用改 driver 签名。finally 里务必清掉,免得泄漏到下一次发布。
  setPublishAbortSignal(opts.signal);
  try {

  // 发布时间从服务端配置拉(后端 system_config 可调、改这些不打包客户端)。拉不到用默认。
  //   覆盖模块级 POST_SUBMIT_WAIT_MS / LOGIN_WAIT_MS —— 下面 helper 的默认参数在【调用时】求值,会拿到新值。
  try {
    const vc = await getVideoConfig();
    if (vc.postSubmitWaitMs > 0) POST_SUBMIT_WAIT_MS = vc.postSubmitWaitMs;
    if (vc.loginWaitMs > 0) LOGIN_WAIT_MS = vc.loginWaitMs;
  } catch { /* 用默认 */ }

  opts.onLog?.(`🚀 准备发布到 ${list.length} 个平台:${list.map(platformLabel).join(' / ')}`);

  // v6.14:拉服务端下发的 driver 脚本(热更新 selector,不发版)。fetch 失败 →
  //   remotePack=null,全部走编译内置 driver(离线/老 backend 兼容)。
  const remotePack = await fetchPublishDrivers();
  if (remotePack && Object.keys(remotePack.drivers).length > 0) {
    opts.onLog?.(`☁️ 已拉取云端发布脚本(${Object.keys(remotePack.drivers).length} 个平台)`);
  }

  // 已停止就别开窗了 —— 上面拉配置/拉云端 driver 有网络耗时,用户很可能在这期间点了停止,
  // 此时再开一个发布窗口纯属打扰(还会让人以为"停不掉")。
  if (opts.signal?.aborted) {
    opts.onLog?.('⏹ 已停止 · 跳过发布(不开发布窗口)');
    return result;
  }

  // 开一个专用发布窗口的固定 tab(9 平台共用)。拿不到 tabId → 回退每平台独立窗口模式。
  const firstUrl = PUBLISHER_ANCHOR_URL[list[0] as VideoPlatform] || 'about:blank';
  const publishTabId = await openPublishTab(firstUrl, (m) => opts.onLog?.(m));
  if (typeof publishTabId === 'number') {
    opts.onLog?.('🪟 已开【单个】发布窗口,所有平台将在同一窗口依次上传(不再每平台开窗)');
  }

  for (const id of list) {
    if (opts.signal?.aborted) {
      // 发布窗口不在这里关:客户端没有关 tab 的浏览器命令(要动扩展),所以只保证
      // 不再对它发任何指令,并明确告诉用户窗口留着、可手动关。
      opts.onLog?.('⏹ 已停止 · 后续平台跳过(发布窗口保留,可手动关闭)');
      break;
    }
    const label = platformLabel(id);
    // 该平台的执行体:优先云端下发脚本;没有(fetch 失败/backend 未配)→ 编译内置 driver。
    const remoteCode = remotePack?.drivers?.[id];
    const driver = getDriver(id as VideoPlatform);
    if (!remoteCode && !driver) {
      // 云端没下发 + 本地也没实装 → 跳过
      opts.onLog?.(`⚠️ ${label} driver 未实装 · 跳过(后续版本会补)`);
      result.skippedCount++;
      result.details.push({ platform: id, status: 'skipped', reason: 'driver_not_implemented' });
      continue;
    }

    // 登录前置:单 tab 模式 navigate 同一发布 tab;回退模式开独立窗口。两者都轮询等登录(最多 3 分钟)。
    const loginStatus = typeof publishTabId === 'number'
      ? await ensureLoggedInOnTab(id as VideoPlatform, publishTabId, (m) => opts.onLog?.(`   ${m}`), opts.signal)
      : await ensureLoggedInTab(id as VideoPlatform, (m) => opts.onLog?.(`   ${m}`), opts.signal);
    if (loginStatus === 'browser_not_connected') {
      opts.onLog?.(`⚠️ ${label} 跳过 · 浏览器未连接(请打开装了 NoobClaw 插件的 Chrome/Edge 再跑)`);
      result.skippedCount++;
      result.details.push({ platform: id, status: 'skipped', reason: 'browser_not_connected' });
      continue;
    }
    if (loginStatus !== 'logged_in') {
      // 决策②:只针对本条视频不补传 —— 不写"下次补传",也不持久化任何放弃标记。
      opts.onLog?.(`⚠️ ${label} 未登录(等了 3 分钟仍未登录)· 跳过本条视频(不再补传)`);
      result.skippedCount++;
      result.details.push({ platform: id, status: 'skipped', reason: 'not_logged_in' });
      continue;
    }
    // 等登录最长 3 分钟,期间用户很容易点停止 —— 别等完了还接着上传。
    if (opts.signal?.aborted) {
      opts.onLog?.('⏹ 已停止 · 不再上传');
      break;
    }
    opts.onLog?.(`✅ ${label} 已登录,准备上传`);
    // 导航到精确上传页(创作中心首页 → 上传页),否则 driver 在首页找不到 file input。
    if (typeof publishTabId === 'number') {
      const anchor = PUBLISHER_ANCHOR_URL[id as VideoPlatform];
      if (anchor) { try { await navigateTab(anchor, publishTabId); await sleep(1500); } catch { /* driver 内部还会等 */ } }
    } else {
      await navigateToUploadPage(id as VideoPlatform, (m) => opts.onLog?.(`   ${m}`));
    }

    // 上传 —— 单平台异常吞掉,继续下一个。单 tab 模式把 tabId 透传给 driver(命令钉到该 tab)。
    //   优先云端下发脚本(热更新);编译失败(语法错,零副作用)→ 安全 fallback 内置 driver;
    //   运行中失败/抛错 → 算该平台失败,绝不再跑内置(可能已传一半,重跑会重复发文)。
    opts.onLog?.(`📤 ${label} · 开始上传…`);
    const ctx: PublishCtx | undefined = typeof publishTabId === 'number' ? { tabId: publishTabId } : undefined;
    const input: PublishInput = {
      videoPath: opts.videoPath,
      title: opts.title,
      description: opts.description,
      tags: opts.tags,
    };
    const driverLog = (msg: string) => opts.onLog?.(`   ${msg}`);
    let pr: { ok: boolean; reason?: string };
    if (remoteCode) {
      pr = await runRemoteDriver(id as VideoPlatform, remoteCode, input, driverLog, ctx);
      if (!pr.ok && pr.reason?.startsWith('remote_compile_failed') && driver) {
        opts.onLog?.(`   ☁️→💾 云端脚本编译失败,改用内置 driver`);
        try {
          pr = await driver.upload(input, driverLog, ctx);
        } catch (e: any) {
          pr = { ok: false, reason: 'driver_threw:' + String(e?.message || e).slice(0, 120) };
        }
      }
    } else {
      try {
        pr = await driver!.upload(input, driverLog, ctx);
      } catch (e: any) {
        pr = { ok: false, reason: 'driver_threw:' + String(e?.message || e).slice(0, 120) };
      }
    }
    if (pr.ok) {
      opts.onLog?.(`✅ ${label} 提交完成`);
      result.publishedCount++;
      result.details.push({ platform: id, status: 'published' });
      // 提交后默认等上传完成:多数平台点提交后才真正上传视频,过早进入下一动作/刷新会把刚提交的作品弄丢。
      // 例外【用户要求】:小红书/币安/推特是【点发布前就要求视频传完】→ 提交时视频已在平台,不用久等 → 封顶 20s。
      const postWaitMs = (id === 'xhs' || id === 'binance' || id === 'x') ? Math.min(20_000, POST_SUBMIT_WAIT_MS) : POST_SUBMIT_WAIT_MS;
      opts.onLog?.(`   ⏳ 等 ${Math.round(postWaitMs / 1000)}s 让平台把视频上传完…`);
      await sleepAbortable(postWaitMs, opts.signal);
      if (opts.signal?.aborted) opts.onLog?.('   ⏹ 已停止 · 不再等待');
    } else {
      opts.onLog?.(`❌ ${label} 发布失败:${pr.reason || 'unknown'}`);
      result.failedCount++;
      result.details.push({ platform: id, status: 'failed', reason: pr.reason });
    }
  }

  // 汇总日志:具体列出每个平台落在哪一类(已发/跳过/失败),失败和跳过附简短原因。
  const reasonZh = (r?: string): string => {
    if (!r) return '';
    // 用户停止:driver 的等待被打断会以 PUBLISH_ABORTED 冒泡成 driver_threw,
    // 别把它显示成「driver 异常」让人以为出 bug 了。
    if (r.includes('aborted') || r.includes('PUBLISH_ABORTED')) return '已停止';
    if (r.startsWith('not_logged_in')) return '未登录';
    if (r.startsWith('browser_not_connected')) return '浏览器未连接';
    if (r.startsWith('driver_not_implemented')) return '未实装';
    if (r.startsWith('upload_input_not_found')) return '没找到上传框';
    if (r.startsWith('video_upload_failed')) return '视频上传失败';
    if (r.startsWith('publish_click_failed')) return '点发布失败';
    if (r.startsWith('remote_compile_failed')) return '脚本编译失败';
    if (r.startsWith('driver_threw')) return 'driver 异常';
    return r.slice(0, 40);
  };
  const named = (list: typeof result.details, withReason: boolean) =>
    list.map((d) => platformLabel(d.platform) + (withReason && d.reason ? `(${reasonZh(d.reason)})` : '')).join('、');
  const pub  = result.details.filter((d) => d.status === 'published');
  const skip = result.details.filter((d) => d.status === 'skipped');
  const fail = result.details.filter((d) => d.status === 'failed');
  opts.onLog?.('📊 发布汇总:');
  if (pub.length)  opts.onLog?.(`   ✅ 已发(${pub.length}):${named(pub, false)}`);
  if (skip.length) opts.onLog?.(`   ⏭️ 跳过(${skip.length}):${named(skip, true)}`);
  if (fail.length) opts.onLog?.(`   ❌ 失败(${fail.length}):${named(fail, true)}`);
  if (!pub.length && !skip.length && !fail.length) opts.onLog?.('   (无平台结果)');

  return result;
  } finally {
    setPublishAbortSignal(undefined); // 清掉,别把本次的 signal 泄漏给下一次发布
  }
}
