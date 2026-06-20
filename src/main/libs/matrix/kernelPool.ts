/**
 * 指纹内核连接池 —— 矩阵号的命门基础设施。
 *
 * 按 accountId 起多个 fingerprint-chromium 实例(一号一实例:固定指纹种子 +
 * 持久 user-data-dir + 绑定代理 + 独立 debug-port),各自一条 CDP 连接。
 * 发布 driver 只认 ctx.cmd(),与浏览器实现解耦 → 把 driver 的浏览器命令路由到
 * 这里对应 accountId 的 CDP 会话,现有 driver 一行不改即可在指纹内核里跑。
 *
 * 与单实例的 cdpBrowser.ts 区别:这里是 Map<accountId, session> 的池,且每个
 * 会话有【独立的消息 id 空间与 pending 表】,避免多实例间 CDP 响应串话。
 *
 * 并发安全(2026-06-20 审计修复):
 *   · launchKernel / getPage 都用 in-flight Promise 去重,杜绝同 accountId 并发
 *     双开进程 / 建多条 WS 泄漏(TOCTOU)。
 *   · WS close/error / 进程 exit → failSession 立即 reject 所有挂起命令,不再干等 30s。
 *
 * 内核选型:adryfish/fingerprint-chromium(BSD-3,引擎级指纹)。MVP 阶段内核
 * 二进制还没 bundle 时,可传普通 Chrome 路径先验证连接池+driver 链路。
 */

import { spawn, type ChildProcess } from 'child_process';
import WebSocket from 'ws';
import path from 'path';
import fs from 'fs';
import { coworkLog } from '../coworkLogger';
import { isPackaged, getResourcesPath, getUserDataPath } from '../platformAdapter';
import type { Fingerprint, Proxy } from './types';

// ── bundle 进包的 fingerprint-chromium 定位(镜像 ffmpegRuntime 的探测) ──
const KERNEL_PLATFORM_DIR = process.platform === 'win32' ? 'fingerprint-chromium-win'
  : process.platform === 'darwin' ? 'fingerprint-chromium-mac' : 'fingerprint-chromium-linux';
const KERNEL_EXE_REL = process.platform === 'win32' ? 'chrome.exe'
  : process.platform === 'darwin' ? path.join('Chromium.app', 'Contents', 'MacOS', 'Chromium') : 'chrome';

function resolveBundledKernel(): string | null {
  const roots: string[] = [];
  const pushRoot = (root: string) => roots.push(path.join(root, KERNEL_PLATFORM_DIR));
  if (isPackaged()) {
    const res = getResourcesPath();
    const exeDir = path.dirname(process.execPath);
    pushRoot(res);
    pushRoot(path.join(res, 'resources'));
    pushRoot(path.join(exeDir, 'resources'));
    pushRoot(path.join(exeDir, '..', 'Resources'));
    pushRoot(path.join(exeDir, '..', 'Resources', 'resources'));
  } else {
    pushRoot(path.join(path.resolve(__dirname, '..', '..', '..', '..'), 'resources'));
  }
  pushRoot(path.join(getUserDataPath(), 'runtimes'));
  for (const r of roots) {
    const cand = path.join(r, KERNEL_EXE_REL);
    try { if (fs.existsSync(cand)) return cand; } catch { /* ignore */ }
  }
  return null;
}

export interface KernelSession {
  accountId: string;
  process: ChildProcess | null;
  debugPort: number;
  userDataDir: string;
  pageWs: WebSocket | null;       // 当前操作的 page 连接
  pageTargetId: string | null;
  pageInit: Promise<KernelSession> | null; // getPage 去重(并发共享同一次初始化)
  msgId: number;                  // 本会话独立 id 空间
  pending: Map<number, { resolve: (d: any) => void; reject: (e: Error) => void }>;
  proxyAuth?: { username: string; password: string }; // 带 auth 代理:经 CDP 提供凭据
  fetchEnabled?: boolean;         // 是否正在 Fetch 拦截(拿到代理凭据后即关)
}

export interface LaunchKernelOptions {
  accountId: string;
  kernelPath?: string;            // fingerprint-chromium 路径;缺省回落到普通 Chrome(仅 MVP 验证用)
  userDataDir: string;            // 持久 profile 目录
  fingerprint: Fingerprint;
  proxy?: Proxy;
  headless?: boolean;
}

const sessions = new Map<string, KernelSession>();
const launching = new Map<string, Promise<KernelSession>>(); // 启动去重
let nextDebugPort = 9300;        // 每号一个端口,递增分配

// ── 内核/浏览器路径探测(MVP 回落用) ──

function detectChromePath(): string | null {
  const c: string[] = [];
  if (process.platform === 'win32') {
    const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files';
    const pfx = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const lad = process.env['LOCALAPPDATA'] || '';
    c.push(
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pfx, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    );
  } else if (process.platform === 'darwin') {
    c.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    c.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium');
  }
  for (const p of c) if (fs.existsSync(p)) return p;
  return null;
}

// ── 启动参数:指纹 + 代理 + 防泄漏 ──

function buildKernelArgs(opts: LaunchKernelOptions, debugPort: number): string[] {
  const { fingerprint: fp, proxy } = opts;
  const args = [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${opts.userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--fingerprint=${fp.seed}`,
  ];
  if (fp.platformOs) args.push(`--fingerprint-platform=${fp.platformOs}`);
  if (fp.brand) args.push(`--fingerprint-brand=${fp.brand}`);
  if (fp.hardwareConcurrency) args.push(`--fingerprint-hardware-concurrency=${fp.hardwareConcurrency}`);
  if (fp.lang) { args.push(`--lang=${fp.lang}`, `--accept-lang=${fp.lang}`); }
  if (fp.timezone) args.push(`--timezone=${fp.timezone}`);

  if (proxy) {
    // socks5h 在 chromium 里用 socks5(socks5 默认远程 DNS,防 DNS 泄漏)。
    // 带 auth 的代理【不内联账密】(Chromium 不支持)→ 经 CDP Fetch.authRequired
    // 在 getPage 里提供凭据。
    const scheme = proxy.protocol === 'socks5h' ? 'socks5' : proxy.protocol;
    args.push(`--proxy-server=${scheme}://${proxy.host}:${proxy.port}`);
    args.push('--disable-non-proxied-udp'); // 防 WebRTC 漏真实 IP
  }

  if (opts.headless) args.push('--headless=new');
  return args;
}

// ── 启动一个号的内核实例(in-flight 去重,杜绝同号双开) ──

export async function launchKernel(opts: LaunchKernelOptions): Promise<KernelSession> {
  const existing = sessions.get(opts.accountId);
  if (existing && existing.process && !existing.process.killed) {
    return existing;
  }
  const inflight = launching.get(opts.accountId);
  if (inflight) return inflight;

  const p = doLaunch(opts).finally(() => {
    if (launching.get(opts.accountId) === p) launching.delete(opts.accountId);
  });
  launching.set(opts.accountId, p);
  return p;
}

async function doLaunch(opts: LaunchKernelOptions): Promise<KernelSession> {
  // 优先级:显式传入 > bundle 进包的指纹内核 > 系统 Chrome(回落,无真指纹隔离)
  const kernelPath = opts.kernelPath || resolveBundledKernel() || detectChromePath();
  if (!kernelPath) throw new Error('fingerprint-chromium / Chrome not found');
  coworkLog('INFO', 'kernelPool', `using kernel: ${kernelPath}`);

  if (!fs.existsSync(opts.userDataDir)) fs.mkdirSync(opts.userDataDir, { recursive: true });

  const prev = sessions.get(opts.accountId);
  const debugPort = prev?.debugPort ?? nextDebugPort++;
  const args = buildKernelArgs(opts, debugPort);

  coworkLog('INFO', 'kernelPool', `launch kernel ${opts.accountId}`, { debugPort, seed: opts.fingerprint.seed });
  const proc = spawn(kernelPath, args, { detached: false, stdio: 'ignore' });
  proc.on('error', (err) => coworkLog('ERROR', 'kernelPool', `kernel ${opts.accountId} error: ${err.message}`));

  let ready = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const r = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (r.ok) { ready = true; break; }
    } catch { /* not ready */ }
  }
  if (!ready) {
    try { proc.kill(); } catch { /* ignore */ }
    throw new Error(`kernel ${opts.accountId} failed to open debug port ${debugPort}`);
  }

  const session: KernelSession = {
    accountId: opts.accountId,
    process: proc,
    debugPort,
    userDataDir: opts.userDataDir,
    pageWs: null,
    pageTargetId: null,
    pageInit: null,
    msgId: 1,
    pending: new Map(),
    proxyAuth: (opts.proxy?.username && opts.proxy?.password)
      ? { username: opts.proxy.username, password: opts.proxy.password }
      : undefined,
  };
  // 进程崩溃/退出 → 清 session + reject 挂起命令,避免后续复用死 session 卡满超时。
  proc.on('exit', () => {
    failSession(session, 'kernel process exited');
    if (sessions.get(opts.accountId) === session) sessions.delete(opts.accountId);
  });
  sessions.set(opts.accountId, session);
  coworkLog('INFO', 'kernelPool', `kernel ${opts.accountId} ready on ${debugPort}`);
  return session;
}

// ── 单会话 CDP 通信(每会话独立 id 空间;getPage 去重) ──

async function getPage(accountId: string): Promise<KernelSession> {
  const s = sessions.get(accountId);
  if (!s) throw new Error(`no kernel session for ${accountId}`);
  if (s.pageWs && s.pageWs.readyState === WebSocket.OPEN) return s;
  if (s.pageInit) return s.pageInit;

  const p = doGetPage(s).finally(() => { if (s.pageInit === p) s.pageInit = null; });
  s.pageInit = p;
  return p;
}

async function doGetPage(s: KernelSession): Promise<KernelSession> {
  const list: any[] = await (await fetch(`http://127.0.0.1:${s.debugPort}/json/list`)).json();
  let target = list.find((t) => t.type === 'page');
  if (!target) {
    target = await (await fetch(`http://127.0.0.1:${s.debugPort}/json/new`)).json();
  }
  s.pageTargetId = target.id;

  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${s.debugPort}/devtools/page/${target.id}`);
    sock.on('open', () => resolve(sock));
    sock.on('error', (e) => reject(e));
    sock.on('message', (data) => onMessage(s, data));
  });
  s.pageWs = ws;
  // 连上后:WS 断开 → reject 所有挂起命令并标记 session 需重连(不再干等 30s)。
  ws.on('close', () => failSession(s, 'page websocket closed'));
  ws.on('error', () => failSession(s, 'page websocket error'));

  await send(s, 'Page.enable');
  // 带 auth 代理:开 Fetch 拦截以应答代理认证挑战;拿到凭据后立即 Fetch.disable
  // 止损(代理会缓存凭据),避免长期暂停全量请求拖慢/卡死页面。
  if (s.proxyAuth) {
    await send(s, 'Fetch.enable', { handleAuthRequests: true, patterns: [{ urlPattern: '*' }] });
    s.fetchEnabled = true;
  }
  return s;
}

function onMessage(s: KernelSession, data: WebSocket.RawData): void {
  let msg: any;
  try { msg = JSON.parse(data.toString()); } catch { return; }
  // 命令响应
  if (msg.id && s.pending.has(msg.id)) {
    const h = s.pending.get(msg.id)!;
    s.pending.delete(msg.id);
    if (msg.error) h.reject(new Error(msg.error.message)); else h.resolve(msg.result);
    return;
  }
  // 代理认证拦截(Fetch 域事件)
  if (msg.method === 'Fetch.authRequired') {
    const resp = s.proxyAuth
      ? { response: 'ProvideCredentials', username: s.proxyAuth.username, password: s.proxyAuth.password }
      : { response: 'Default' };
    sendNoWait(s, 'Fetch.continueWithAuth', { requestId: msg.params?.requestId, authChallengeResponse: resp });
    // 代理凭据已给 → 关 Fetch,停止暂停后续全量请求(止损 #审计高1)。
    if (s.proxyAuth && s.fetchEnabled) {
      s.fetchEnabled = false;
      sendNoWait(s, 'Fetch.disable');
    }
  } else if (msg.method === 'Fetch.requestPaused') {
    sendNoWait(s, 'Fetch.continueRequest', { requestId: msg.params?.requestId });
  }
}

/** WS 断开/进程退出:reject 所有挂起命令并清理,使后续 getPage 重建连接。 */
function failSession(s: KernelSession, reason: string): void {
  for (const [, h] of s.pending) { try { h.reject(new Error(reason)); } catch { /* ignore */ } }
  s.pending.clear();
  try { s.pageWs?.close(); } catch { /* ignore */ }
  s.pageWs = null;
  s.pageInit = null;
  s.fetchEnabled = false;
}

/** 发命令不等响应(用于 Fetch 拦截应答)。 */
function sendNoWait(s: KernelSession, method: string, params: Record<string, unknown> = {}): void {
  try { s.pageWs?.send(JSON.stringify({ id: s.msgId++, method, params })); } catch { /* ignore */ }
}

function send(s: KernelSession, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = s.msgId++;
  return new Promise((resolve, reject) => {
    if (!s.pageWs || s.pageWs.readyState !== WebSocket.OPEN) {
      reject(new Error(`CDP not connected: ${method}`));
      return;
    }
    const timer = setTimeout(() => { s.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
    s.pending.set(id, {
      resolve: (d) => { clearTimeout(timer); resolve(d); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    s.pageWs.send(JSON.stringify({ id, method, params }));
  });
}

// ── 高层操作(按 accountId) ──

export async function kernelNavigate(accountId: string, url: string): Promise<void> {
  const s = await getPage(accountId);
  await send(s, 'Page.navigate', { url });
  await sleep(1000);
}

export async function kernelEval(accountId: string, expression: string): Promise<any> {
  const s = await getPage(accountId);
  const r = await send(s, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r?.result?.value;
}

export async function kernelClick(accountId: string, x: number, y: number): Promise<void> {
  const s = await getPage(accountId);
  await send(s, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send(s, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

/**
 * 原生文件注入 —— 把本地文件直接灌进 file input(CDP DOM.setFileInputFiles)。
 * 比扩展的 upload_file_from_url 干净:CDP 直接给元素 objectId + 本地路径,内核侧零网络。
 */
export async function kernelSetFileInput(accountId: string, selector: string, filePaths: string[]): Promise<boolean> {
  const s = await getPage(accountId);
  const evalRes = await send(s, 'Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(selector)})`,
    returnByValue: false,
  });
  const objectId = evalRes?.result?.objectId;
  if (!objectId) return false;
  await send(s, 'DOM.setFileInputFiles', { files: filePaths, objectId });
  return true;
}

// ── 生命周期 ──

export function getSession(accountId: string): KernelSession | undefined {
  return sessions.get(accountId);
}

export function listSessions(): string[] {
  return Array.from(sessions.keys());
}

export function closeKernel(accountId: string): void {
  const s = sessions.get(accountId);
  if (!s) return;
  failSession(s, 'kernel closed');
  try { if (s.process && !s.process.killed) s.process.kill(); } catch { /* ignore */ }
  sessions.delete(accountId);
  coworkLog('INFO', 'kernelPool', `closed kernel ${accountId}`);
}

export function closeAllKernels(): void {
  for (const id of Array.from(sessions.keys())) closeKernel(id);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
