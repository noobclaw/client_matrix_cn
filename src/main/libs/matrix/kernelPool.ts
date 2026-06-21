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
 * 内核选型:adryfish/fingerprint-chromium(BSD-3,引擎级指纹)。内核按需从自家
 * OSS 下载(见 kernelInstaller)。不再回退系统 Chrome:没有指纹内核就不启动
 * (无指纹隔离的矩阵号没有意义),抛 NO_KERNEL 让 UI 引导用户先下载。
 * 仍保留显式 kernelPath(手动指定),供调试。
 */

import { spawn, type ChildProcess } from 'child_process';
import WebSocket from 'ws';
import fs from 'fs';
import { coworkLog } from '../coworkLogger';
import { installedKernelPath } from './kernelInstaller';
import type { Fingerprint, Proxy } from './types';

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
  label?: string;                 // 账号标签(窗口左上角常驻角标,多窗区分用)
  slot: number;                   // 第几个窗口(用于错开层叠位置)
}

export interface LaunchKernelOptions {
  accountId: string;
  kernelPath?: string;            // 显式内核路径(手动覆盖);优先级最高
  kernelVersion?: string;         // 该号绑定的内核版本(从已下载版本里取)
  userDataDir: string;            // 持久 profile 目录
  fingerprint: Fingerprint;
  proxy?: Proxy;
  headless?: boolean;
  label?: string;                 // 窗口左上角常驻角标文案(一般是账号备注名 + 分组)
}

const sessions = new Map<string, KernelSession>();
const launching = new Map<string, Promise<KernelSession>>(); // 启动去重
let nextDebugPort = 9300;        // 每号一个端口,递增分配
let nextSlot = 0;                // 第几个窗口(错开层叠位置用)

/**
 * 注入「账号角标」脚本:窗口左上角常驻绿色标签显示账号名,多窗叠在一起也能分清。
 * 防风控:① 账号名文字放进 closed shadowRoot —— 页面 JS 读不到内容;② 宿主元素不带
 * id/class、状态只存闭包(不挂 window)—— 抖音侧基本无法枚举/识别这个角标。
 */
function badgeScript(label: string): string {
  const L = JSON.stringify(label);
  return `(function(){var node=null;function m(){try{var root=document.body||document.documentElement;if(!root)return;if(node&&node.isConnected)return;var host=document.createElement('div');host.style.cssText='position:fixed;top:0;left:0;z-index:2147483647;pointer-events:none';var sr=host.attachShadow?host.attachShadow({mode:'closed'}):null;var b=document.createElement('div');b.textContent=${L};b.style.cssText='background:#16a34a;color:#fff;font:bold 13px/1.5 system-ui,sans-serif;padding:3px 12px;border-bottom-right-radius:8px';(sr||host).appendChild(b);root.appendChild(host);node=host;}catch(e){}}m();setInterval(m,2000);})();`;
}

// 内核缺失的统一错误标记:UI 据此弹「去下载内核」引导,不再回退系统 Chrome。
export const NO_KERNEL_ERROR = 'NO_KERNEL';

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
  // 优先级:显式路径(手动指定)> 该号绑定版本 > 任意已装版本。
  // 不再回退系统 Chrome:没有我们的指纹内核就不跑(无指纹隔离=矩阵号无意义),
  // 抛 NO_KERNEL 让上层弹「去下载内核」。
  const kernelPath = opts.kernelPath || installedKernelPath(opts.kernelVersion) || installedKernelPath();
  if (!kernelPath) throw new Error(`${NO_KERNEL_ERROR}: 指纹浏览器内核未安装,请先在矩阵号界面下载内核`);
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
    label: opts.label,
    slot: nextSlot++,
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
  // 命令执行器:跨整页导航常驻(addScriptToEvaluateOnNewDocument)+ 立即给当前页注入一次,
  // 让 window.__nbExec 在位。源服务端下发(命令行为改后端不打包)。失败不致命(kernelExec 会兜底重注)。
  try {
    const execSrc = await getExecutorSource();
    if (execSrc) {
      await send(s, 'Page.addScriptToEvaluateOnNewDocument', { source: execSrc });
      await send(s, 'Runtime.evaluate', { expression: execSrc });
    }
  } catch { /* 非关键:kernelExec 调用时会再确保 */ }
  // 账号角标:窗口左上角常驻账号名,多窗叠在一起也能分清扫哪个码。
  // addScriptToEvaluateOnNewDocument 让它跨整页导航也在;立即再注入一次给当前页。
  if (s.label) {
    try {
      await send(s, 'Page.addScriptToEvaluateOnNewDocument', { source: badgeScript(s.label) });
      await send(s, 'Runtime.evaluate', { expression: badgeScript(s.label) });
    } catch { /* 角标非关键 */ }
  }
  // 错开窗口位置:多个号别完全重叠,便于分辨。
  try {
    const win = await send(s, 'Browser.getWindowForTarget', { targetId: s.pageTargetId });
    if (win?.windowId != null) {
      const off = (s.slot % 6) * 40;
      await send(s, 'Browser.setWindowBounds', { windowId: win.windowId, bounds: { left: 60 + off, top: 60 + off, width: 1180, height: 820 } });
    }
  } catch { /* 窗口定位非关键 */ }
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

// ── 命令执行器(window.__nbExec)服务端下发 + 注入 ──
// 复用扩展 content.js/background.js 的 DOM 命令实现(见 backend/matrix/drivers/command_executor.js)。
// 改命令行为只改后端 + 重启,不打包 client。
function matrixApiBase(): string {
  return process.env.NOOBCLAW_API_BASE_URL || 'https://api.noobclaw.com';
}
let executorSource: string | null = null;        // lastGood 缓存
let executorFetch: Promise<string | null> | null = null;
async function getExecutorSource(): Promise<string | null> {
  if (executorSource) return executorSource;
  if (executorFetch) return executorFetch;
  executorFetch = (async () => {
    try {
      const res = await fetch(`${matrixApiBase()}/api/matrix/command-executor`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`http_${res.status}`);
      const data: any = await res.json();
      if (typeof data?.source === 'string' && data.source) { executorSource = data.source; return executorSource; }
      throw new Error('no_source');
    } catch (e) {
      coworkLog('WARN', 'kernelPool', 'fetch command-executor failed', { err: String(e) });
      return executorSource; // 失败保 lastGood(可能为 null:首次失败 → 命令层不可用,上层会报错)
    } finally { executorFetch = null; }
  })();
  return executorFetch;
}

/** 把执行器注入该号当前页(定义 window.__nbExec)。getPage 时也会装 init 脚本跨导航生效。 */
async function injectExecutor(accountId: string): Promise<boolean> {
  const src = await getExecutorSource();
  if (!src) return false;
  const s = await getPage(accountId);
  try { await send(s, 'Runtime.evaluate', { expression: src }); return true; } catch { return false; }
}

/** 执行页面类命令:确保 __nbExec 在位 → window.__nbExec(command, params)。返回执行器结果对象。 */
export async function kernelExec(accountId: string, command: string, params: any): Promise<any> {
  let present = false;
  try { present = await kernelEval(accountId, "typeof window.__nbExec==='function'"); } catch { present = false; }
  if (!present) {
    const ok = await injectExecutor(accountId);
    if (!ok) return { ok: false, error: 'executor_unavailable(后端 /api/matrix/command-executor 未就绪?)' };
  }
  const expr = 'window.__nbExec(' + JSON.stringify(command) + ',' + JSON.stringify(params || {}) + ')';
  return await kernelEval(accountId, expr);
}

// 可信按键(CDP Input.dispatchKeyEvent;比 JS 合成 KeyboardEvent 的 isTrusted=false 强)。
// 剧本搜索框提交用 keypress Enter。
export async function kernelKeypress(accountId: string, key: string): Promise<void> {
  const s = await getPage(accountId);
  const KEYS: Record<string, any> = {
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' },
  };
  const k = KEYS[key] || { key, code: key };
  await send(s, 'Input.dispatchKeyEvent', { type: 'keyDown', ...k });
  await send(s, 'Input.dispatchKeyEvent', { type: 'keyUp', ...k });
}

export async function kernelClick(accountId: string, x: number, y: number): Promise<void> {
  const s = await getPage(accountId);
  await send(s, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send(s, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

// 可信滚轮(CDP Input.dispatchMouseEvent mouseWheel):部分平台(小红书/快手创作中心)懒加载
// 只认真实 wheel,JS scrollTop/scrollIntoView 触发不了。
export async function kernelWheel(accountId: string, x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
  const s = await getPage(accountId);
  await send(s, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: x || 400, y: y || 400, deltaX: deltaX || 0, deltaY: deltaY || 0 });
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

// 清空该号浏览器全部 cookie(断开关联用:登出但保留 profile/指纹/配置)。
export async function kernelClearCookies(accountId: string): Promise<void> {
  const s = await getPage(accountId);
  try { await send(s, 'Network.clearBrowserCookies', {}); } catch { /* ignore */ }
}

// ── 登录态检测(读 cookie;httpOnly 也能经 CDP 读到,document.cookie 读不到) ──

// 各平台「已登录」的标志性 cookie(命中任一即视为已登录)。2026-06-21 全平台真机 CDP 实测核对:
//   kuaishou 原 web_st 是错的 → 真实 webday7_st;binance/youtube 原本没有 → 补上。
const LOGIN_COOKIES: Record<string, string[]> = {
  douyin: ['sessionid', 'sessionid_ss', 'sid_guard', 'passport_auth_status'],
  xhs: ['web_session'],
  bilibili: ['SESSDATA', 'DedeUserID'],
  shipinhao: ['sessionid', 'wxuin'],
  kuaishou: ['userId', 'kuaishou.server.webday7_st'],   // ⚠️ 实测:是 webday7_st 不是 web_st
  toutiao: ['sessionid', 'sso_uid_tt'],
  tiktok: ['sessionid', 'sid_tt'],
  x: ['auth_token'],
  binance: ['logined', 'p20t'],                          // 新增(实测)
  youtube: ['SID', 'SAPISID', 'LOGIN_INFO'],             // 新增(实测)
};

/** 该号当前是否已登录对应平台(按标志性 cookie 判断)。session 不在/读失败返回 false。
 *  ⚠️ 用 getAllCookies(读 profile 里【所有域】的 cookie),而不是当前页域 —— 否则在创作者中心
 *  子域(creator./member./cp./mp.toutiao 等)判断时会漏掉挂在主站父域的登录 cookie。 */
export async function checkKernelLogin(accountId: string, platform: string): Promise<boolean> {
  if (!sessions.get(accountId)) return false;
  try {
    const s = await getPage(accountId);
    let cookies: any[] = [];
    try { const r = await send(s, 'Network.getAllCookies', {}); cookies = r?.cookies || []; } catch { /* fallback below */ }
    if (!cookies.length) { const r2 = await send(s, 'Network.getCookies', {}); cookies = r2?.cookies || []; }
    const names = new Set<string>(cookies.map((c: any) => String(c.name)));
    const need = LOGIN_COOKIES[platform] || [];
    return need.some((n) => names.has(n));
  } catch { return false; }
}

// 读登录后的真实身份(昵称 / 平台号 / uid / 头像)。【昵称不在 cookie】—— 登录 cookie 是 httpOnly
// 令牌;昵称要从各平台的页面 SSR / 接口读,uid 部分在明文 cookie、部分在页面。来源全部 2026-06-21
// 真机 CDP 实测确定(见 reference_matrix_account_identity_sources)。
export interface KernelIdentity { uid?: string; nickname?: string; displayId?: string; avatar?: string }

// 各平台「读身份」的页面表达式(在内核页里 eval;async 的靠 awaitPromise 兜)。返回 JSON 字符串。
const IDENTITY_EXPR: Record<string, string> = {
  // 抖音:RENDER_DATA(SSR JSON)。nickname/uid/抖音号(unique_id)/头像。
  douyin: '(function(){try{var el=document.getElementById("RENDER_DATA");var d="";try{d=decodeURIComponent((el&&el.textContent)||"");}catch(e){d=(el&&el.textContent)||"";}var n=d.match(/"nickname":"([^"]{1,40})"/),u=d.match(/"uid":"(\\d{6,25})"/),s=d.match(/"unique_id":"([^"]{1,40})"/),a=d.match(/"avatar_thumb":\\{"uri":"[^"]*","url_list":\\["([^"]+)"/)||d.match(/"avatarUrl":"([^"]+)"/);return JSON.stringify({nickname:n&&n[1],uid:u&&u[1],displayId:s&&s[1]||null,avatar:a&&(a[1]||"").replace(/\\\\u002F/g,"/")});}catch(e){return "{}";}})()',
  // 小红书:/me 接口(edith 子域,带 cred 可跨子域)。nickname/小红书号(red_id)/uid(user_id)/头像。
  xhs: '(async function(){try{var r=await fetch("https://edith.xiaohongshu.com/api/sns/web/v2/user/me",{credentials:"include"});var j=await r.json();var d=(j&&j.data)||{};if(d.guest)return "{}";return JSON.stringify({nickname:d.nickname,displayId:d.red_id,uid:d.user_id,avatar:d.images||d.imageb});}catch(e){return "{}";}})()',
  // B站:nav 接口最干净。uname/mid/face。
  bilibili: '(async function(){try{var r=await fetch("https://api.bilibili.com/x/web-interface/nav",{credentials:"include"});var j=await r.json();var d=(j&&j.data)||{};if(!d.isLogin)return "{}";return JSON.stringify({nickname:d.uname,uid:String(d.mid||""),avatar:d.face});}catch(e){return "{}";}})()',
  // TikTok:app-context.user;不行回落 user-detail(在自己主页时)。nickname/uniqueId(handle)/secUid/头像。
  tiktok: '(function(){try{var U=window.__UNIVERSAL_DATA_FOR_REHYDRATION__,u={};if(U){var sc=U.__DEFAULT_SCOPE__||{};u=(sc["webapp.app-context"]&&sc["webapp.app-context"].user)||{};if((!u||!u.uniqueId)&&sc["webapp.user-detail"]&&sc["webapp.user-detail"].userInfo)u=sc["webapp.user-detail"].userInfo.user||u;}return JSON.stringify({nickname:u.nickname||u.nickName||null,displayId:u.uniqueId||null,uid:u.uid||u.secUid||null,avatar:u.avatarThumb||u.avatarLarger||null});}catch(e){return "{}";}})()',
  // 快手:页面 state(自己主页最准)。user_name/快手号(kwaiId)/头像;uid 另从 userId cookie 补。
  kuaishou: '(function(){try{var h=document.documentElement.innerHTML;var n=h.match(/"user_name":"([^"]{1,40})"/)||h.match(/"userName":"([^"]{1,40})"/);var k=h.match(/"kwaiId":"([^"]{1,40})"/);var a=h.match(/"headurl":"([^"]+)"/)||h.match(/"headUrl":"([^"]+)"/);return JSON.stringify({nickname:n&&n[1],displayId:k&&k[1]||null,avatar:a&&a[1]||null});}catch(e){return "{}";}})()',
  // 头条:创作端页 screen_name;uid 从 sso_uid_tt cookie 补。
  toutiao: '(function(){try{var h=document.documentElement.innerHTML;var n=h.match(/"screen_name":"([^"]{1,40})"/)||h.match(/"nick_name":"([^"]{1,40})"/)||h.match(/"name":"([^"]{1,40})"/);var a=h.match(/"avatar_url":"([^"]+)"/);return JSON.stringify({nickname:n&&n[1],avatar:a&&a[1]||null});}catch(e){return "{}";}})()',
  // 视频号:助手页 finder 信息。nickname/视频号ID(finderUsername)/头像。
  shipinhao: '(function(){try{var h=document.documentElement.innerHTML;var n=h.match(/"nickname":"([^"]{1,40})"/);var f=h.match(/"finderUsername":"([^"]{1,60})"/)||h.match(/"username":"(v2_[^"]{1,60})"/)||h.match(/视频号ID[^A-Za-z0-9]*([A-Za-z0-9]{10,30})/);var a=h.match(/"headImgUrl":"([^"]+)"/)||h.match(/"headUrl":"([^"]+)"/);return JSON.stringify({nickname:n&&n[1]||null,displayId:f&&f[1]||null,avatar:a&&a[1]||null});}catch(e){return "{}";}})()',
  // 币安广场:localStorage uid + 主页 URL handle + 标题昵称。
  binance: '(function(){try{var uid=null;try{uid=localStorage.getItem("operation_list_user_id");}catch(e){}var nm=(document.title.match(/(.+?)的个人资料/)||[])[1]||null;var hd=(location.href.match(/square\\/profile\\/([A-Za-z0-9_.\\-]+)/)||[])[1]||null;return JSON.stringify({uid:uid,nickname:nm,displayId:hd});}catch(e){return "{}";}})()',
  // YouTube:头像从 masthead 取;昵称/handle 待用频道页补(account_menu 结构刁钻,先给头像)。
  youtube: '(function(){try{var img=document.querySelector("#avatar-btn img, button#avatar-btn img, ytd-topbar-menu-button-renderer img");return JSON.stringify({avatar:img&&img.src||null});}catch(e){return "{}";}})()',
};
// uid 在明文 cookie 里的平台(页面 expr 拿不到 uid 时,从 cookie 补)。
const UID_COOKIE: Record<string, string> = { kuaishou: 'userId', toutiao: 'sso_uid_tt', bilibili: 'DedeUserID' };

export async function kernelReadIdentity(accountId: string, platform: string): Promise<KernelIdentity> {
  try {
    const s = await getPage(accountId);
    const out: KernelIdentity = {};
    const expr = IDENTITY_EXPR[platform];
    if (expr) {
      try { const o = JSON.parse((await kernelEval(accountId, expr)) || '{}'); if (o && typeof o === 'object') { out.uid = o.uid || undefined; out.nickname = o.nickname || undefined; out.displayId = o.displayId || undefined; out.avatar = o.avatar || undefined; } } catch { /* ignore */ }
    }
    // uid 兜底:从明文 cookie 取(getAllCookies 跨域)。
    if (!out.uid && UID_COOKIE[platform]) {
      try { const cr = await send(s, 'Network.getAllCookies', {}); const c = (cr?.cookies || []).find((x: any) => String(x.name) === UID_COOKIE[platform]); if (c) out.uid = String(c.value); } catch { /* ignore */ }
    }
    // 读不到任何身份 → 记一条诊断(便于后续按真实结构补),不影响登录。
    if (!out.nickname && !out.uid) coworkLog('INFO', 'matrix-identity', `identity empty for ${platform}`, {});
    return out;
  } catch { return {}; }
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
