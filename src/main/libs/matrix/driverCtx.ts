/**
 * 矩阵 driver 运行器 —— 让发布 driver 零改跑在指纹内核上。
 *
 * 提供与旧 remoteDrivers.buildDriverCtx 完全相同的 ctx 契约(cmd / uploadVideo /
 * waitForSelector / clickWithText / insertEditorText / setInputValue / mainWorldClick /
 * sleep / log),但底层全部路由到 kernelPool 中该 accountId 的 CDP 会话,而不是扩展。
 * 这样 backend/matrix/drivers 下发的脚本(从旧 driver fork)无需改动即可运行。
 *
 * 与旧 remoteDrivers 的差异:
 *   · ctx.uploadVideo 走 CDP DOM.setFileInputFiles(原生本地注入),不走 upload_file_from_url。
 *   · 命令源是 GET /api/matrix/drivers(矩阵 fork),不是 /api/video/publish-drivers。
 */

import { coworkLog } from '../coworkLogger';
import type { VideoPlatform, PublishInput, PublishResult } from '../video/publishers/types';
import { PUBLISHER_ANCHOR_URL } from '../video/publishers/publisherUtils';
import { matrixCmd } from './cdpCommands';
import { kernelNavigate, kernelSetFileInput } from './kernelPool';

const DEFAULT_BASE_URL = 'https://api.noobclaw.com';
function baseUrl(): string {
  return process.env.NOOBCLAW_API_BASE_URL || DEFAULT_BASE_URL;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── ctx 辅助函数(对齐 publisherUtils,但按 accountId 走 matrixCmd) ──

async function waitForSelector(
  accountId: string, selector: string,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<boolean> {
  const deadline = Date.now() + (opts?.timeoutMs || 15000);
  const interval = opts?.intervalMs || 500;
  while (Date.now() < deadline) {
    try {
      const r: any = await matrixCmd(accountId, 'query_selector', { selector, limit: 1 });
      if (((r && r.elements) || []).length > 0) return true;
    } catch { /* keep polling */ }
    await sleep(interval);
  }
  return false;
}

async function clickWithText(
  accountId: string,
  opts: { containerSel?: string; acceptedTexts: string[]; retries?: number },
): Promise<{ ok: boolean; reason?: string }> {
  const retries = opts.retries || 6;
  for (let i = 0; i < retries; i++) {
    if (i > 0) await sleep(1500);
    try {
      const r: any = await matrixCmd(accountId, 'click_with_text', {
        containerSel: opts.containerSel, acceptedTexts: opts.acceptedTexts,
      });
      if (r && r.ok) return { ok: true };
    } catch { /* retry */ }
  }
  return { ok: false, reason: 'click_with_text_no_match' };
}

async function insertEditorText(
  accountId: string, selector: string, text: string,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    await matrixCmd(accountId, 'main_world_click', { selector });
    await sleep(400);
    const r: any = await matrixCmd(accountId, 'editor_insert_text', { selector, text });
    if (!r || r.ok === false) return { ok: false, reason: 'editor_insert_failed:' + (r?.error || 'unknown') };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: 'editor_failed:' + String(e?.message || e).slice(0, 80) };
  }
}

async function setInputValue(accountId: string, selector: string, value: string): Promise<boolean> {
  try {
    const r: any = await matrixCmd(accountId, 'set_input_value', { selector, value });
    return !!(r && r.ok !== false);
  } catch { return false; }
}

async function mainWorldClick(accountId: string, selector: string): Promise<boolean> {
  try {
    const r: any = await matrixCmd(accountId, 'main_world_click', { selector });
    return !!(r && r.ok !== false);
  } catch { return false; }
}

// ── ctx 构造 ──

function buildMatrixDriverCtx(
  accountId: string,
  platform: VideoPlatform,
  input: PublishInput,
  onLog: (msg: string) => void,
) {
  return {
    platform,
    input: { title: input.title, description: input.description, tags: input.tags },
    cmd: (command: string, params: any, timeoutMs?: number) =>
      matrixCmd(accountId, command, params, timeoutMs),
    uploadVideo: async (targetSelector: string, _opts?: { mimeType?: string; ttlMs?: number }) => {
      const r = await kernelSetFileInput(accountId, targetSelector, [input.videoPath]);
      return r.ok ? { ok: true } : { ok: false, reason: r.reason || 'set_file_input_failed' };
    },
    // 视频号 wujie open shadow 里的 file input:深遍历(穿 shadowRoot)找到 → CDP objectId 直接灌文件。
    // 比扩展那套「sidecar HTTP + fetch 注入」简单:setFileInputFiles 认 objectId,不在乎元素在不在 shadow 里。
    uploadVideoDeep: async (_opts?: { acceptHint?: string; mimeType?: string; ttlMs?: number }) => {
      const r = await kernelSetFileInput(accountId, '', [input.videoPath], { deep: true });
      return r.ok ? { ok: true } : { ok: false, reason: r.reason || 'deep_set_file_input_failed' };
    },
    waitForSelector: (selector: string, opts?: { timeoutMs?: number; intervalMs?: number }) =>
      waitForSelector(accountId, selector, opts),
    clickWithText: (opts: { containerSel?: string; acceptedTexts: string[]; retries?: number }) =>
      clickWithText(accountId, opts),
    insertEditorText: (selector: string, text: string) =>
      insertEditorText(accountId, selector, text),
    setInputValue: (selector: string, value: string) =>
      setInputValue(accountId, selector, value),
    mainWorldClick: (selector: string) => mainWorldClick(accountId, selector),
    sleep,
    log: (msg: string) => { try { onLog(msg); } catch { /* ignore */ } },
  };
}

// ── 矩阵 driver 下发(GET /api/matrix/drivers,fork 自旧 publish-drivers) ──

let lastGood: Record<string, string> | null = null;

async function fetchMatrixDrivers(): Promise<Record<string, string> | null> {
  try {
    const res = await fetch(`${baseUrl()}/api/matrix/drivers`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return lastGood;
    const json: any = await res.json();
    if (json && json.drivers && typeof json.drivers === 'object' && Object.keys(json.drivers).length > 0) {
      lastGood = json.drivers;
      return lastGood;
    }
    return lastGood;
  } catch (err) {
    coworkLog('WARN', 'matrixDriver', 'fetch drivers failed', { err: String(err) });
    return lastGood;
  }
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/**
 * 在指定账号的指纹内核里跑【抖音取材】driver(douyin_search)。
 * 与发布同源:走 /api/matrix/drivers 拉脚本、ctx.cmd 路由到该号 CDP(matrixCmd)。
 * 与插件版 hotspotDouyinSource 的 ctx 契约一致:{ input:{keywords,wantCount,mode}, cmd, sleep, log }。
 * 绝不抛 —— 失败归一成 { urls:[], reason }。
 */
export async function runMatrixDouyinSearch(
  accountId: string,
  keywords: string[],
  wantCount: number,
  mode: 'video' | 'image',
  onLog: (msg: string) => void,
): Promise<{ urls: string[]; titles: string[]; reason?: string; diag?: unknown }> {
  try {
    const drivers = await fetchMatrixDrivers();
    const code = drivers?.['douyin_search'];
    if (!code) return { urls: [], titles: [], reason: 'no_matrix_driver:douyin_search(后端 /api/matrix/drivers 未下发)' };
    let fn: (ctx: any) => Promise<any>;
    try { fn = new AsyncFunction('ctx', code) as (ctx: any) => Promise<any>; }
    catch (e: any) { return { urls: [], titles: [], reason: 'compile_failed:' + String(e?.message || e).slice(0, 80) }; }
    const ctx = {
      input: { keywords, wantCount, mode },
      cmd: (command: string, params: any, timeoutMs?: number) => matrixCmd(accountId, command, params, timeoutMs),
      sleep,
      log: (m: string) => { try { onLog('   ' + m); } catch { /* ignore */ } },
    };
    const ret: any = await fn(ctx);
    const urls = Array.isArray(ret?.urls) ? ret.urls.filter((u: any) => typeof u === 'string') : [];
    const titles = Array.isArray(ret?.titles) ? ret.titles.filter((s: any) => typeof s === 'string' && s.trim()).map((s: string) => s.trim()) : [];
    return { urls, titles, reason: ret?.reason, diag: ret?.diag };
  } catch (e: any) {
    return { urls: [], titles: [], reason: 'matrix_search_threw:' + String(e?.message || e).slice(0, 120) };
  }
}

/**
 * 在指定账号的指纹内核里跑该平台的发布 driver。
 * 流程:导航到创作者中心 anchor → 拉矩阵 driver 脚本 → 同契约 ctx 执行。
 * 绝不抛,归一成 PublishResult。
 */
export async function runMatrixDriver(
  accountId: string,
  platform: VideoPlatform,
  input: PublishInput,
  onLog: (msg: string) => void,
): Promise<PublishResult> {
  try {
    const anchor = PUBLISHER_ANCHOR_URL[platform];
    if (anchor) {
      onLog(`导航到 ${platform} 创作者中心`);
      await kernelNavigate(accountId, anchor);
      await sleep(2000);
    }

    const drivers = await fetchMatrixDrivers();
    const code = drivers?.[platform];
    if (!code) return { ok: false, reason: 'no_matrix_driver:' + platform };

    let fn: (ctx: any) => Promise<any>;
    try {
      fn = new AsyncFunction('ctx', code);
    } catch (e: any) {
      return { ok: false, reason: 'matrix_compile_failed:' + String(e?.message || e).slice(0, 100) };
    }

    const ctx = buildMatrixDriverCtx(accountId, platform, input, onLog);
    const r = await fn(ctx);
    if (r && typeof r.ok === 'boolean') {
      return {
        ok: r.ok,
        reason: typeof r.reason === 'string' ? r.reason : undefined,
        publishedUrl: typeof r.publishedUrl === 'string' ? r.publishedUrl : undefined,
      };
    }
    return { ok: false, reason: 'matrix_bad_return:' + JSON.stringify(r).slice(0, 80) };
  } catch (e: any) {
    return { ok: false, reason: 'matrix_driver_threw:' + String(e?.message || e).slice(0, 120) };
  }
}
