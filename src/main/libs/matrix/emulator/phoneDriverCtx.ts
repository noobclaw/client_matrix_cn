/**
 * 手机版 driver 运行器:服务端下发的 phone_* 脚本在这里跑,ctx 指令路由到该号的模拟器。
 * 与浏览器 driver(driverCtx.ts)同一套热更新模式:GET /api/matrix/drivers → drivers['phone_<...>']。
 *
 * 开发期覆写:matrix/emulator/drivers/<key>.js 存在时优先用本地文件(方便对着导出的画面结构写脚本,
 * 不用每改一次都发后端)。正式环境没有这个目录,不受影响。
 *
 * 脚本契约:async (ctx) => ({ ok: boolean, reason?: string, ... })。绝不抛,失败归一成 { ok:false, reason }。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { coworkLog } from '../../coworkLogger';
import { ensureRunning, appStart, appStop, isAppInstalled, pushMedia } from './emulatorPool';
import { findAll, findOne, parseHierarchy, summarize, UiNode, UiSelector } from './uiTree';
import { sleep } from './exec';
import { BUILTIN_DRIVERS } from './builtinDrivers';

function apiBase(): string { return process.env.NOOBCLAW_API_BASE_URL || 'https://api.noobclaw.com'; }
function localDriverDir(): string {
  const base = process.env.NOOBCLAW_MATRIX_DIR || path.join(os.homedir(), 'NoobClaw', 'matrix');
  return path.join(base, 'emulator', 'drivers');
}

let lastGood: Record<string, string> | null = null;

// 内置脚本(后端没下发时兜底)。源码在 docs/emulator-drivers/,由 scripts/gen-emulator-drivers.js 生成(BUILTIN_DRIVERS)。

export async function loadPhoneDriver(key: string): Promise<string | null> {
  if (!/^phone_[\w]+$/.test(key)) return null;
  const local = path.join(localDriverDir(), `${key}.js`);
  try { if (fs.existsSync(local)) return fs.readFileSync(local, 'utf8'); } catch { /* ignore */ }
  try {
    const res = await fetch(`${apiBase()}/api/matrix/drivers`, { signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      const j: any = await res.json();
      if (j && j.drivers && typeof j.drivers === 'object') lastGood = j.drivers;
    }
  } catch (e) {
    coworkLog('WARN', 'phoneDriver', 'fetch drivers failed', { err: String(e) });
  }
  return lastGood?.[key] || BUILTIN_DRIVERS[key] || null;
}

/** 给脚本的 ctx。所有坐标都是模拟器屏幕像素(720x1280 默认)。 */
export async function buildPhoneCtx(accountId: string, input: Record<string, unknown>, onLog: (m: string) => void) {
  const s = await ensureRunning(accountId, onLog);
  const a = s.agent;
  const dump = async (): Promise<UiNode[]> => parseHierarchy(await a.dumpXml());
  const waitFor = async (sel: UiSelector, timeoutMs = 10_000, intervalMs = 800): Promise<UiNode | null> => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const n = findOne(await dump(), sel);
      if (n) return n;
      await sleep(intervalMs);
    }
    return null;
  };
  return {
    input,
    accountId,
    dump,
    find: async (sel: UiSelector) => findOne(await dump(), sel) || null,
    findAll: async (sel: UiSelector) => findAll(await dump(), sel),
    waitFor,
    summary: async (max?: number) => summarize(await dump(), max),
    tap: (x: number, y: number) => a.click(x, y),
    click: async (sel: UiSelector, timeoutMs = 8000): Promise<boolean> => {
      const n = await waitFor(sel, timeoutMs);
      if (!n) return false;
      await a.click(n.cx, n.cy);
      return true;
    },
    longPress: (x: number, y: number, ms?: number) => a.longPress(x, y, ms),
    swipe: (x1: number, y1: number, x2: number, y2: number, ms?: number) => a.swipe(x1, y1, x2, y2, ms),
    back: () => a.pressKey('back'),
    home: () => a.pressKey('home'),
    enter: () => a.pressKey('enter'),
    inputText: (text: string) => a.inputText(String(text)),
    clearText: () => a.clearText(),
    appStart: (pkg: string) => appStart(accountId, pkg),
    appStop: (pkg: string) => appStop(accountId, pkg),
    appInstalled: (pkg: string) => isAppInstalled(accountId, pkg),
    appCurrent: async (): Promise<string> => String((await a.deviceInfo().catch(() => ({} as any)))?.currentPackageName || ''),
    screen: async (): Promise<{ width: number; height: number }> => {
      const i: any = await a.deviceInfo().catch(() => ({}));
      return { width: Number(i?.displayWidth) || 720, height: Number(i?.displayHeight) || 1280 };
    },
    pushMedia: (localPath: string) => pushMedia(accountId, localPath),
    screenshot: () => a.screenshotBase64(),
    sleep,
    log: (m: string) => { try { onLog(String(m)); } catch { /* ignore */ } },
  };
}

const AsyncFunction = Object.getPrototypeOf(async function () { /* noop */ }).constructor;

export async function runPhoneDriver(
  accountId: string,
  key: string,
  input: Record<string, unknown>,
  onLog: (m: string) => void,
): Promise<{ ok: boolean; reason?: string; [k: string]: unknown }> {
  try {
    const code = await loadPhoneDriver(key);
    if (!code) return { ok: false, reason: 'no_phone_driver:' + key };
    let fn: (ctx: any) => Promise<any>;
    try { fn = new AsyncFunction('ctx', code); } catch (e: any) { return { ok: false, reason: 'compile_failed:' + String(e?.message || e).slice(0, 100) }; }
    const ctx = await buildPhoneCtx(accountId, input, onLog);
    const r = await fn(ctx);
    if (r && typeof r.ok === 'boolean') return r;
    return { ok: false, reason: 'bad_return:' + JSON.stringify(r).slice(0, 80) };
  } catch (e: any) {
    return { ok: false, reason: (e?.code ? e.code + ':' : '') + String(e?.message || e).slice(0, 160) };
  }
}
