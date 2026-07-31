/**
 * remoteDrivers — 视频发布 driver 的【服务端下发】执行器(v6.14)。
 *
 * 为什么:9 个平台的上传 selector(抖音转码进度条、币安发文按钮、B 站投稿页…)是最容易
 * 被平台改版打烂的东西,编译进客户端意味着烂一个就要发一版 Electron。对齐 scenario
 * orchestrator 的热更新机制 —— 脚本放 backend/video_drivers/{platform}.js,每次发布前
 * GET /api/video/publish-drivers 拉最新源码,backend 改文件即全网热更新,client 不发版。
 *
 * ── 下发脚本契约(ctx API)────────────────────────────────────────────
 * 脚本通过 `new AsyncFunction('ctx', code)` 执行(同 phaseRunner.runOrchestrator 的
 * 沙箱方式:无 require / 无 fs / 无 global,只能用 ctx)。脚本体 = 原 TS driver 的
 * upload() 函数体直译,必须 return { ok: boolean, reason?: string }。
 *
 *   ctx.platform                         平台 id('douyin' | 'xhs' | …)
 *   ctx.input                            { title?, description?, tags? }(videoPath 不暴露,上传走 uploadVideo)
 *   ctx.cmd(command, params, timeoutMs)  浏览器命令(pubCmd 预绑定 platform + tabId)
 *   ctx.uploadVideo(targetSelector, opts?)  上传本次成片到 file input;opts { mimeType?, ttlMs? };返回 { ok, reason? }
 *   ctx.waitForSelector(selector, opts?) 轮询等元素;opts { timeoutMs?, intervalMs? };返回 boolean
 *   ctx.clickWithText({ containerSel?, acceptedTexts, retries? })  文本匹配点击;返回 { ok, reason? }
 *   ctx.insertEditorText(selector, text) 富文本插入(execCommand 路径);返回 { ok, reason? }
 *   ctx.setInputValue(selector, value)   普通 input 赋值;返回 boolean
 *   ctx.mainWorldClick(selector)         主世界 click(穿透 React 合成事件);返回 boolean
 *   ctx.sleep(ms)                        等待。**用户点停止时会抛错**(不是提前返回)——
 *                                        故意的:脚本常写「sleep 等平台处理完 → 点发布」,
 *                                        提前返回会把没传完的视频真发出去。抛错会让本平台
 *                                        算失败并跳过后续平台。**不要 catch 它。**
 *   ctx.aborted                          用户是否已点停止(长轮询/重试循环里可自查提前 return)
 *   ctx.log(msg)                         进度日志(直通 UI)
 *
 * 所有 ctx.* 浏览器操作都预绑定了 (platform, tabId, videoPath) —— 单 tab 复用模式下
 * 命令自动钉到固定发布 tab;tabId 缺省(回退模式)走 tabPattern 路由,脚本无感知。
 *
 * ── Fallback 策略 ──────────────────────────────────────────────────
 *   · fetch 失败 / 该平台无下发脚本 → 用编译内置的 TS driver(老行为,离线可用)
 *   · 下发脚本【执行中】throw → 算该平台失败,绝不 fallback 内置重跑
 *     (脚本可能已经传了一半,重跑内置会重复上传/重复发文)
 */

import { coworkLog } from '../../coworkLogger';
import type { VideoPlatform, PublishInput, PublishResult, PublishCtx } from './types';
import {
  pubCmd, uploadFileToInput, uploadVideoToInputDeep, waitForSelector, clickWithText,
  insertEditorText, setInputValue, mainWorldClick, sleep, publishAborted,
} from './publisherUtils';

const DEFAULT_BASE_URL = 'https://api.noobclaw.com';

function baseUrl(): string {
  return process.env.NOOBCLAW_API_BASE_URL || DEFAULT_BASE_URL;
}

export interface RemoteDriverPack {
  /** platform id → 脚本源码字符串。 */
  drivers: Record<string, string>;
}

/** 对齐 viralPoolClient.fetchScenarioPack:每次都拉最新(热更新立即生效),
 *  网络失败用上一次成功的内存副本兜底(离线可跑),都没有返回 null(走内置 driver)。 */
let lastGood: RemoteDriverPack | null = null;

export async function fetchPublishDrivers(): Promise<RemoteDriverPack | null> {
  try {
    // 10s 超时:发布 step 在拉脚本【之后】才开窗,backend 假死不能卡住整个发布流程
    // (超时落到 catch → lastGood / 编译内置 driver 兜底,行为不变)。
    const res = await fetch(`${baseUrl()}/api/video/publish-drivers`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      coworkLog('WARN', 'remoteDrivers', 'fetch non-2xx', { status: res.status });
      return lastGood;
    }
    const json = await res.json();
    // 只有非空集合才算「好数据」—— 空集(backend 未部署 drivers)不能覆盖 lastGood,
    // 否则一次空响应会把之前拉到的好脚本兜底冲掉。
    if (json && typeof json.drivers === 'object' && json.drivers !== null
        && Object.keys(json.drivers).length > 0) {
      lastGood = { drivers: json.drivers };
      return lastGood;
    }
    return lastGood;
  } catch (err) {
    coworkLog('WARN', 'remoteDrivers', 'fetch failed', { err: String(err) });
    return lastGood;
  }
}

/** 沙箱构造器 —— 同 phaseRunner.runOrchestrator:真 async 函数,非 eval/vm。 */
// eslint-disable-next-line @typescript-eslint/no-empty-function
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/** 给下发脚本拼 ctx:所有浏览器操作预绑定 (platform, tabId, videoPath)。 */
function buildDriverCtx(
  platform: VideoPlatform,
  input: PublishInput,
  onLog: (msg: string) => void,
  pubCtx?: PublishCtx,
) {
  const tabId = pubCtx?.tabId;
  return {
    platform,
    // videoPath 不暴露给脚本(脚本无文件系统概念,上传一律走 uploadVideo)。
    input: { title: input.title, description: input.description, tags: input.tags },
    cmd: (command: string, params: any, timeoutMs: number) =>
      pubCmd(platform, command, params, timeoutMs, tabId),
    uploadVideo: (targetSelector: string, opts?: { mimeType?: string; ttlMs?: number }) =>
      uploadFileToInput({
        platform,
        filePath: input.videoPath,
        targetSelector,
        mimeType: opts?.mimeType,
        ttlMs: opts?.ttlMs,
        tabId,
      }),
    // 视频号专用:把视频注入【wujie shadowRoot 里】的 file input(扩展 upload_file_from_url
    // 不穿 shadow → 必须走 cdp_eval 深遍历 + fetch 注入)。普通平台用上面的 uploadVideo 即可。
    uploadVideoDeep: (opts?: { acceptHint?: string; mimeType?: string; ttlMs?: number }) =>
      uploadVideoToInputDeep({
        platform,
        filePath: input.videoPath,
        acceptHint: opts?.acceptHint,
        mimeType: opts?.mimeType,
        ttlMs: opts?.ttlMs,
        tabId,
      }),
    waitForSelector: (selector: string, opts?: { timeoutMs?: number; intervalMs?: number }) =>
      waitForSelector(platform, selector, { ...opts, tabId }),
    clickWithText: (opts: { containerSel?: string; acceptedTexts: string[]; retries?: number }) =>
      clickWithText(platform, { ...opts, tabId }),
    insertEditorText: (selector: string, text: string) =>
      insertEditorText(platform, selector, text, tabId),
    setInputValue: (selector: string, value: string) =>
      setInputValue(platform, selector, value, tabId),
    mainWorldClick: (selector: string) => mainWorldClick(platform, selector, tabId),
    // sleep / waitForSelector / clickWithText 都来自 publisherUtils,已统一响应
    // 模块级停止信号(runPublishStep 设的)→ 停止时立刻返回、不等满。
    // 这里再给脚本一个显式开关:自己的轮询/重试循环里查它就能提前 return。
    get aborted(): boolean { return publishAborted(); },
    sleep,
    log: (msg: string) => { try { onLog(msg); } catch { /* ignore */ } },
  };
}

/**
 * 执行一段下发的 driver 脚本。绝不抛 —— 编译失败 / 运行 throw / 返回值不合规
 * 都归一成 { ok:false, reason },由 runPublish 当「该平台失败」处理(不 fallback 重跑)。
 */
export async function runRemoteDriver(
  platform: VideoPlatform,
  code: string,
  input: PublishInput,
  onLog: (msg: string) => void,
  pubCtx?: PublishCtx,
): Promise<PublishResult> {
  let fn: (ctx: any) => Promise<any>;
  try {
    fn = new AsyncFunction('ctx', code);
  } catch (e: any) {
    // 语法错误 = 脚本还没跑、没有副作用 → 这种情况【可以】安全 fallback 内置,
    // 用特殊 reason 告知调用方。
    return { ok: false, reason: 'remote_compile_failed:' + String(e?.message || e).slice(0, 100) };
  }
  try {
    const ctx = buildDriverCtx(platform, input, onLog, pubCtx);
    const r = await fn(ctx);
    if (r && typeof r.ok === 'boolean') {
      return {
        ok: r.ok,
        reason: typeof r.reason === 'string' ? r.reason : undefined,
        publishedUrl: typeof r.publishedUrl === 'string' ? r.publishedUrl : undefined,
      };
    }
    return { ok: false, reason: 'remote_bad_return:' + JSON.stringify(r).slice(0, 80) };
  } catch (e: any) {
    return { ok: false, reason: 'remote_driver_threw:' + String(e?.message || e).slice(0, 120) };
  }
}
