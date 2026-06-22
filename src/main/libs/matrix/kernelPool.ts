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

import { spawn, execFileSync, type ChildProcess } from 'child_process';
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import { coworkLog } from '../coworkLogger';
import { installedKernelPath, ensureTabGroupExtension } from './kernelInstaller';
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
  startUrl?: string;              // 启动即打开的 URL(扫码登录用):内核直接开到平台登录页,
                                  //   避免「先开新标签页再 navigate」的 target 竞态(导航落到看不见的后台 tab)。
  skipLease?: boolean;            // 不占「按账号使用互斥锁」(openLogin:用户交互、只读 cookie 轮询,不驱动页面)
}

const sessions = new Map<string, KernelSession>();
const launching = new Map<string, Promise<KernelSession>>(); // 启动去重
// 按 accountId 的【引用计数】:每次 launchKernel +1、closeKernel -1;>0 说明还有别的流程在用
// 这个号 → closeKernel 不真关(防「A 任务用着、B 流程把窗关了」误关 + 防并发撞同一 profile 损坏)。
const refCount = new Map<string, number>();
// 正在【优雅关闭】中的子进程:closeKernel 已把 session 从表里删了,但进程还会再活最多 4s(等 Browser.close
// 干净退出)才被强杀,这期间它【仍占着 profile 锁】。若此时同号被重开,doLaunch 见 sessions 里没有 → 误清锁 +
// 又开一个新进程 → 两进程抢同一 user-data-dir → 弹「打开个人资料出了点问题」+ 开出两个窗。记下这些将死进程,
// doLaunch 重开前先把它彻底收走(kill + 等退出)再清锁,保证【串行】不并发抢锁。
const closingProcs = new Map<string, ChildProcess>();

// 按 accountId 的【使用互斥锁(异步队列)】:同一账号同一时刻只允许一个流程操作,其他【排队等】。
// 防「涨粉任务和视频任务同时驱动同一个号的页面 → 命令打架/串台」。launchKernel 时占锁、
// closeKernel 时释放。openLogin(用户交互、只读 cookie 轮询)用 skipLease 不占锁,不阻塞任务。
const leaseTail = new Map<string, Promise<void>>();   // 每号一条队尾 promise
const leaseHeld = new Map<string, () => void>();       // 当前持有者的释放函数
function acquireLease(accountId: string): Promise<void> {
  let release!: () => void;
  const mine = new Promise<void>((res) => { release = res; });
  const prev = leaseTail.get(accountId) || Promise.resolve();
  leaseTail.set(accountId, prev.then(() => mine));      // 后来者排在我后面
  return prev.then(() => { leaseHeld.set(accountId, release); }); // 等前一个用完才返回
}
function releaseLease(accountId: string): void {
  const r = leaseHeld.get(accountId);
  if (r) { leaseHeld.delete(accountId); r(); }
}
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

/**
 * 清理上次实例残留的单例锁。
 * 同一 user-data-dir 第二次启动时,Chromium 见到陈旧的 SingletonLock/lockfile 会把命令
 * 转交「上一个实例」后【自身立即退出】→ 调试端口永不打开 → 上层表现为「浏览器意外退出 /
 * read ECONNRESET」。只在【没有存活 session】时清(有存活 session 走复用,绝不清)。
 */
function clearSingletonLocks(dir: string): void {
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']) {
    try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* ignore */ }
  }
}

/**
 * 收走仍占着该 profile 的【活孤儿】内核(本 sidecar 没有句柄的残留:上次 app 崩溃 / 被 SIGKILL
 * 强杀后,mac 上内核子进程不随父进程死而成的孤儿)。mac/Linux 的 SingletonLock 是软链,target
 * 形如 `<hostname>-<pid>`:读出 pid,确认它还活着且确是 chromium,就 SIGKILL 并等它退出。
 *
 * 为什么必须杀进程而不能只删锁:删锁文件不会让活着的孤儿松手,反而让新内核与孤儿【抢同一
 * user-data-dir】→ 弹「打开您的个人资料时出了点问题」+ 开出双窗。Windows 走 Job Object 级联杀
 * (sidecar 一死内核也死),无此孤儿,直接跳过。
 */
async function reapProfileHolder(userDataDir: string): Promise<void> {
  if (process.platform === 'win32') return;
  let target = '';
  try { target = fs.readlinkSync(path.join(userDataDir, 'SingletonLock')); } catch { return; }
  const m = /-(\d+)$/.exec(target);
  if (!m) return;
  const pid = parseInt(m[1], 10);
  if (!Number.isFinite(pid) || pid <= 1 || pid === process.pid) return;
  try { process.kill(pid, 0); } catch { return; } // 进程已不在 → 陈旧锁,交给 clearSingletonLocks 清
  // pid 复用防误杀:确认它确实是浏览器进程(best-effort)。ps 明确说「不是浏览器」才放过;
  // ps 不可用(cmd 为空)时该 SingletonLock 只出现在我们私有 profile 目录,极大概率是我们内核 → 仍杀。
  let cmd = '';
  try { cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 3000 }).toString(); } catch { /* ps 不可用 */ }
  if (cmd && !/chromium|chrome|--user-data-dir/i.test(cmd)) return;
  try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
  for (let i = 0; i < 20 && pid; i++) { try { process.kill(pid, 0); } catch { break; } await sleep(100); } // 等它真退出(锁释放)最多 ~2s
  coworkLog('INFO', 'kernelPool', `reaped orphan kernel holding profile ${path.basename(userDataDir)} (pid ${pid})`);
}

/**
 * sidecar 启动时清扫上次 app 残留的孤儿指纹内核(被强杀/崩溃后仍占着 profile 锁的僵尸窗):
 * 逐个账号 profile 目录收孤儿 + 清陈旧锁。best-effort,失败不影响启动。Windows 无孤儿(reapProfileHolder 直接跳过)。
 */
export async function reapOrphanKernels(userDataDirs: string[]): Promise<void> {
  for (const dir of userDataDirs) {
    try { await reapProfileHolder(dir); clearSingletonLocks(dir); } catch { /* ignore */ }
  }
}

// ── 启动参数:指纹 + 代理 + 防泄漏 ──

function buildKernelArgs(opts: LaunchKernelOptions, debugPort: number): string[] {
  const { fingerprint: fp, proxy } = opts;
  const args = [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${opts.userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    // 抑制「Chromium 未正确关闭 · 要恢复页面吗」气泡 + 启动不自动恢复上次会话(自动化里气泡盖页面会点错)。
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    '--no-crash-upload',
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

  // 【tab group 可行性验证版】给内核挂一个极小 MV3 扩展:窗口内标签自动归到「账号名」彩色分组。
  // --disable-features 那条是为新版 chromium 把 --load-extension 重新放开(新版把它关进了默认禁用的
  // feature 开关);旧版/fingerprint-chromium 无此 feature 会忽略,无害。能不能真加载,mac 真机见分晓。
  try {
    const extDir = ensureTabGroupExtension(opts.accountId, opts.label || opts.accountId);
    if (extDir) {
      args.push(`--load-extension=${extDir}`);
      args.push('--disable-features=DisableLoadExtensionCommandLineSwitch');
    }
  } catch { /* 扩展非关键,失败不挡启动 */ }

  if (opts.headless) args.push('--headless=new');
  // 启动 URL 作为最后一个位置参数:内核在首个可见窗口直接打开它(扫码登录页),
  // 不再依赖启动后再 navigate(那条路有 target 竞态,会把页开到后台 tab)。
  if (opts.startUrl) args.push(opts.startUrl);
  return args;
}

// ── 启动一个号的内核实例(in-flight 去重,杜绝同号双开) ──

export async function launchKernel(opts: LaunchKernelOptions): Promise<KernelSession> {
  // 占「按账号使用互斥锁」:同号有别的流程正在用 → 在这里【排队等】,直到它 closeKernel 释放。
  //   openLogin(skipLease)不占锁,不阻塞任务。
  if (!opts.skipLease) await acquireLease(opts.accountId);
  // 引用计数 +1:任何流程要用这个号都先 +1,closeKernel 时 -1,归 0 才真关。
  refCount.set(opts.accountId, (refCount.get(opts.accountId) || 0) + 1);
  const existing = sessions.get(opts.accountId);
  // 复用前确认进程【真活着】:崩溃的子进程 .killed 仍是 false(那只代表我们没主动 kill),
  // 必须再查 exitCode===null,否则会复用到已死进程 → 后续 CDP 全部 ECONNRESET。
  if (existing && existing.process && !existing.process.killed && existing.process.exitCode === null) {
    return existing;
  }
  const inflight = launching.get(opts.accountId);
  if (inflight) return inflight;

  const p = doLaunch(opts).finally(() => {
    if (launching.get(opts.accountId) === p) launching.delete(opts.accountId);
  });
  // 启动失败时调用方拿到 reject、不会再 closeKernel → 这里回退它的 +1 并释放锁,防计数/锁泄漏。
  p.catch(() => { refCount.set(opts.accountId, Math.max(0, (refCount.get(opts.accountId) || 1) - 1)); if (!opts.skipLease) releaseLease(opts.accountId); });
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

  // 同号上一个进程还在「优雅关闭」中(占着 profile 锁)→ 先立即强杀并等它真退出,再清锁开新窗,
  // 否则两进程抢同一 user-data-dir → 「打开个人资料出了点问题」+ 双窗(见 closingProcs 注释)。
  const dying = closingProcs.get(opts.accountId);
  if (dying && dying.exitCode === null) {
    try { dying.kill(); } catch { /* ignore */ }
    for (let i = 0; i < 30 && dying.exitCode === null; i++) await sleep(100); // 等退出最多 ~3s
  }
  closingProcs.delete(opts.accountId);

  const prev = sessions.get(opts.accountId);
  // 没有【本进程的】存活实例才动锁:先收走仍占着该 profile 的活孤儿(上次 app 崩溃/被强杀后残留,
  // 见 reapProfileHolder),再清陈旧单例锁。防「二次启动撞上活孤儿 → 双开抢同一 user-data-dir →
  // 打开您的个人资料时出了点问题 / 内核秒退 ECONNRESET」。
  if (!prev || !prev.process || prev.process.killed) {
    await reapProfileHolder(opts.userDataDir);
    clearSingletonLocks(opts.userDataDir);
  }
  const debugPort = prev?.debugPort ?? nextDebugPort++;
  const args = buildKernelArgs(opts, debugPort);

  // 把内核 stdout/stderr 落到 profile 下的 kernel.log:崩了能看到真实原因(原来 stdio:'ignore' 完全瞎)。
  let outFd: number | 'ignore' = 'ignore';
  const logPath = path.join(opts.userDataDir, 'kernel.log');
  try { outFd = fs.openSync(logPath, 'a'); } catch { outFd = 'ignore'; }

  coworkLog('INFO', 'kernelPool', `launch kernel ${opts.accountId}`, { debugPort, seed: opts.fingerprint.seed });
  const proc = spawn(kernelPath, args, { detached: false, stdio: ['ignore', outFd, outFd] });
  if (typeof outFd === 'number') { try { fs.closeSync(outFd); } catch { /* 子进程已持有 fd */ } }
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
    // 端口没起来 = 内核启动后秒退(单例锁/参数/损坏)。把日志路径带出去便于排查。
    throw new Error(`指纹浏览器启动失败(调试端口 ${debugPort} 未就绪),日志: ${logPath}`);
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
    if (sessions.get(opts.accountId) === session) { sessions.delete(opts.accountId); refCount.delete(opts.accountId); }
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
  // 把当前操作的 page 提到前台:复用已运行内核走 navigate 这条路时,确保用户看到的就是这一页
  // (而不是停在旧的新标签页)。非关键,失败忽略。
  try { await send(s, 'Page.bringToFront'); } catch { /* 非关键 */ }
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
 * 原生文件注入 —— 把本地文件灌进 file input(CDP DOM.setFileInputFiles)。健壮版。
 *
 * 旧版只 `document.querySelector(selector)`(顶层 light DOM、取第一个)+ 设完无脑 return true,有三个坑:
 *   ① 命中错的 input:B 站投稿页有 2 个视频 input,querySelector 取第一个常是错的 → 设了没用、B 站没反应;
 *   ② shadow DOM 里的 input 完全找不到:视频号 wujie 微前端表单在 open shadowRoot 里 → querySelector 摸不到;
 *   ③ 假成功:没真挂上也 return true,driver 收到 ok 往下走,误报「视频已上传」。
 *
 * 新版:深遍历 light DOM + 所有 open shadowRoot 收集 <input type=file> → 按 selector 过滤(没 selector/没命中
 * 且 deep 时回退「accept 含 video/mp4 或为空」)→ 给【所有】命中的 input 都 setFileInputFiles(多候选不确定哪个
 * 真,全设最稳)→ 回读 files.length 校验,至少一个真挂上才 return true(不再假成功)。
 */
export async function kernelSetFileInput(
  accountId: string, selector: string, filePaths: string[], opts?: { deep?: boolean },
): Promise<boolean> {
  const s = await getPage(accountId);
  const sel = selector || '';
  const deep = !!opts?.deep;
  // 1) 深遍历收集候选 input 到 window.__mtxFI,返回数量。
  const collectExpr = `(function(sel, deep){
    function collect(root, out){
      try { root.querySelectorAll('input[type=file]').forEach(function(el){ out.push(el); }); } catch(e){}
      var nodes=[]; try { nodes = root.querySelectorAll('*'); } catch(e){}
      for (var i=0;i<nodes.length;i++){ var sr=null; try{ sr=nodes[i].shadowRoot; }catch(e){} if(sr) collect(sr,out); }
    }
    var all=[]; collect(document, all);
    var pick=[];
    if(sel){ for(var i=0;i<all.length;i++){ try{ if(all[i].matches(sel)) pick.push(all[i]); }catch(e){} } }
    if(!pick.length && (deep || !sel)){ pick = all.filter(function(el){ var a=(el.accept||'').toLowerCase(); return a.indexOf('video')>=0||a.indexOf('mp4')>=0||a===''; }); }
    if(!pick.length && deep) pick = all;
    window.__mtxFI = pick;
    return pick.length;
  })(${JSON.stringify(sel)}, ${deep})`;
  const cnt: any = await send(s, 'Runtime.evaluate', { expression: collectExpr, returnByValue: true });
  const n = Number(cnt?.result?.value || 0);
  if (!n) return false;
  // 2) 逐个取 objectId → setFileInputFiles(单个失败继续)。
  for (let i = 0; i < n; i++) {
    try {
      const elRes: any = await send(s, 'Runtime.evaluate', { expression: `window.__mtxFI[${i}]`, returnByValue: false });
      const objectId = elRes?.result?.objectId;
      if (!objectId) continue;
      await send(s, 'DOM.setFileInputFiles', { files: filePaths, objectId });
    } catch { /* 单个失败继续 */ }
  }
  // 3) 校验:至少一个 input 真挂上文件才算成功。
  const verify: any = await send(s, 'Runtime.evaluate', {
    expression: `(function(){ var n=0; (window.__mtxFI||[]).forEach(function(el){ try{ if(el.files&&el.files.length) n++; }catch(e){} }); try{ delete window.__mtxFI; }catch(e){} return n; })()`,
    returnByValue: true,
  });
  return Number(verify?.result?.value || 0) > 0;
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
  // ⚠️ 只认真正登录态的 session cookie。原来还带 sid_guard / passport_auth_status,但抖音对【未登录
  // 游客】访问 douyin.com 也会下发这俩 → 一打开登录页就被误判「已关联」(跟小红书 web_session 同款坑)。
  // sessionid / sessionid_ss 是登录后才有的会话令牌,游客没有。【须真机复核:游客态确认无这两个】。
  douyin: ['sessionid', 'sessionid_ss'],
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
    if (!need.some((n) => names.has(n))) return false;
    // ⚠️ 小红书的 web_session 对【未登录游客】也会下发 → cookie 命中不代表已登录(否则一打开登录页
    // 就被误判「已关联」)。用 /me 接口的 guest 标志二次确认;接口异常不误杀(回落 cookie 结果)。
    if (platform === 'xhs') {
      try {
        const v = await kernelEval(accountId, '(async function(){try{var r=await fetch("https://edith.xiaohongshu.com/api/sns/web/v2/user/me",{credentials:"include"});var j=await r.json();var d=(j&&j.data)||{};return (d&&d.guest===false&&d.user_id)?"1":"0";}catch(e){return "?";}})()');
        if (v === '0') return false; // 明确是游客 → 未登录
      } catch { /* 接口异常不误杀 */ }
    }
    return true;
  } catch { return false; }
}

// 读登录后的真实身份(昵称 / 平台号 / uid / 头像)。【昵称不在 cookie】—— 登录 cookie 是 httpOnly
// 令牌;昵称要从各平台的页面 SSR / 接口读,uid 部分在明文 cookie、部分在页面。来源全部 2026-06-21
// 真机 CDP 实测确定(见 reference_matrix_account_identity_sources)。
export interface KernelIdentity { uid?: string; nickname?: string; displayId?: string; avatar?: string }

// 各平台「读身份」的页面表达式(在内核页里 eval;async 的靠 awaitPromise 兜)。返回 JSON 字符串。
const IDENTITY_EXPR: Record<string, string> = {
  // 抖音:RENDER_DATA(SSR JSON)。nickname/uid/抖音号(unique_id)/头像。
  douyin: '(function(){try{var el=document.getElementById("RENDER_DATA");var d="";try{d=decodeURIComponent((el&&el.textContent)||"");}catch(e){d=(el&&el.textContent)||"";}var n=d.match(/"nickname":"([^"]{1,40})"/),u=d.match(/"uid":"(\\d{6,25})"/),s=d.match(/"unique_id":"([^"]{1,40})"/),s2=d.match(/"short_id":"(\\d{3,40})"/),a=d.match(/"avatar_thumb":\\{"uri":"[^"]*","url_list":\\["([^"]+)"/)||d.match(/"avatarUrl":"([^"]+)"/);var did=(s&&s[1])||(s2&&s2[1])||null;return JSON.stringify({nickname:n&&n[1],uid:u&&u[1],displayId:did,avatar:a&&(a[1]||"").replace(/\\\\u002F/g,"/")});}catch(e){return "{}";}})()',
  // 小红书:/me 接口(edith 子域,带 cred 可跨子域)。nickname/小红书号(red_id)/uid(user_id)/头像。
  xhs: '(async function(){try{var r=await fetch("https://edith.xiaohongshu.com/api/sns/web/v2/user/me",{credentials:"include"});var j=await r.json();var d=(j&&j.data)||{};if(d.guest)return "{}";return JSON.stringify({nickname:d.nickname,displayId:d.red_id,uid:d.user_id,avatar:d.images||d.imageb});}catch(e){return "{}";}})()',
  // B站:nav 接口最干净。uname/mid/face。
  bilibili: '(async function(){try{var r=await fetch("https://api.bilibili.com/x/web-interface/nav",{credentials:"include"});var j=await r.json();var d=(j&&j.data)||{};if(!d.isLogin)return "{}";var mid=String(d.mid||"");return JSON.stringify({nickname:d.uname,uid:mid,displayId:mid,avatar:(d.face||"").replace(/^http:/,"https:")});}catch(e){return "{}";}})()',
  // 推特X(真机实测 2026-06-22):本人 handle 从左侧导航 [data-testid="AppTabBar_Profile_Link"] 的 href 取
  //   (任何登录页都在 → 比抓「第一个头像容器」稳:status/profile 页第一个是别人);再按 handle 精确取
  //   [data-testid="UserAvatar-Container-<handle>"] 的 img.alt=昵称、img.src=头像(pbs.twimg.com,https);
  //   uid 从 twid=u%3D<id> cookie。找不到导航时回落第一个头像容器。
  x: '(function(){try{var prof=document.querySelector(\'[data-testid="AppTabBar_Profile_Link"]\');var handle=prof?((prof.getAttribute("href")||"").replace(/^\\//,"")||null):null;var avc=handle?document.querySelector(\'[data-testid="UserAvatar-Container-\'+handle+\'"]\'):null;if(!avc)avc=document.querySelector(\'[data-testid^="UserAvatar-Container-"]\');var avatar=null,nickname=null;if(avc){if(!handle)handle=((avc.getAttribute("data-testid")||"").match(/UserAvatar-Container-(.+)/)||[])[1]||null;var img=avc.querySelector("img");if(img){avatar=img.src||null;nickname=img.getAttribute("alt")||null;}if(!avatar){var nn=avc.querySelectorAll("*");for(var i=0;i<nn.length;i++){var bg=getComputedStyle(nn[i]).backgroundImage;var m=bg&&bg.match(/url\\((.+?)\\)/);if(m){avatar=m[1].replace(/[\\x22\\x27]/g,"");break;}}}}var uid=(document.cookie.match(/twid=u%3D(\\d+)/)||[])[1]||null;return JSON.stringify({nickname:nickname,displayId:handle?("@"+handle):null,uid:uid,avatar:avatar});}catch(e){return "{}";}})()',
  // TikTok(真机实测 2026-06-22):__UNIVERSAL_DATA__ 的 SSR scope 现在恒空(旧 app-context 法已废)。
  //   改读【个人主页 DOM】(由 IDENTITY_NAV_HINT 先跳 /@<号>):data-e2e="user-title"=昵称(如"Mochi Monkey")、
  //   "user-subtitle"=TikTok号(如 mochimonkeyton)、"user-avatar" img=头像。兜底读左侧导航 nav-profile(任何页都在,
  //   含号+头像,但无昵称)。uid 用 uniqueId(TikTok 数字 uid 要签名接口,不取;uniqueId 已足够做去重键)。
  tiktok: '(function(){try{var nick=null,uniq=null,av=null;var t=document.querySelector(\'[data-e2e="user-title"]\');if(t)nick=(t.textContent||"").trim()||null;var s=document.querySelector(\'[data-e2e="user-subtitle"]\');if(s)uniq=(s.textContent||"").trim()||null;var a1=document.querySelector(\'[data-e2e="user-avatar"] img\');if(a1)av=a1.src||null;var p=document.querySelector(\'[data-e2e="nav-profile"]\')||document.querySelector(\'a[href^="/@"]\');if(p){if(!uniq){var h=p.getAttribute("href")||"";uniq=(h.match(/\\/@([^\\/?#]+)/)||[])[1]||null;}var ni=p.querySelector("img");if(!av&&ni)av=ni.src||null;}return JSON.stringify({nickname:nick,displayId:uniq?("@"+uniq):null,uid:uniq,avatar:av});}catch(e){return "{}";}})()',
  // 快手:window.INIT_STATE 里的 profile 对象(信息流页 /new-reco 就有,真机实测 2026-06-22)。
  //   userName=昵称, userDefineId=快手号, userId=uid, userHead=头像。(键名被 +1 凯撒位移混淆,靠值里有 userName+userId 定位。)
  kuaishou: '(function(){try{var s=window.INIT_STATE||{};for(var k in s){var v=s[k];if(v&&typeof v==="object"&&v.userName&&v.userId){return JSON.stringify({nickname:v.userName,displayId:v.userDefineId||null,uid:String(v.userId),avatar:v.userHead||null});}}return "{}";}catch(e){return "{}";}})()',
  // 头条:mp.toutiao.com 创作端 SSR script JSON 里的账号对象(真机实测 2026-06-22)。
  //   页面有多个用户对象(feed 作者等),必须锚定【同时含 screen_name + https_avatar_url + id_str】的账号块,
  //   否则乱扫抓到别人。nickname=screen_name, avatar=https_avatar_url, 头条号ID/uid=id_str。
  toutiao: '(function(){try{var h=document.documentElement.innerHTML;var re=/"screen_name":"([^"]{1,40})"/g,m,best=null;while((m=re.exec(h))){var s=m.index;var blk=h.slice(Math.max(0,s-700),s+200);if(/https_avatar_url/.test(blk)){var a=(blk.match(/"https_avatar_url":"([^"]+?)"/)||blk.match(/"avatar_url":"([^"]+?)"/)||[])[1]||null;var id=(blk.match(/"id_str":"(\\d{6,25})"/)||[])[1]||null;best={nickname:m[1],avatar:a,id:id};break;}}if(!best){var n=(h.match(/"screen_name":"([^"]{1,40})"/)||[])[1];best={nickname:n||null,avatar:null,id:null};}return JSON.stringify({nickname:best.nickname,displayId:best.id,uid:best.id,avatar:best.avatar});}catch(e){return "{}";}})()',
  // 视频号:助手页(channels.weixin.qq.com)调 auth_data 接口拿当前 finder(真机实测 2026-06-22)。
  //   finderUser.nickname=昵称, uniqId=视频号ID(sph...), headImgUrl=头像, finderUsername=内部 v2_..@finder。
  shipinhao: '(async function(){try{var r=await fetch("/cgi-bin/mmfinderassistant-bin/auth/auth_data",{method:"POST",headers:{"content-type":"application/json"},credentials:"include",body:JSON.stringify({scene:7,timestamp:Date.now()})});var j=await r.json();var f=(j&&j.data&&j.data.finderUser)||{};if(!f.nickname&&!f.uniqId)return "{}";return JSON.stringify({nickname:f.nickname||null,displayId:f.uniqId||null,uid:f.uniqId||f.finderUsername||null,avatar:f.headImgUrl||null});}catch(e){return "{}";}})()',
  // 币安广场(真机实测 2026-06-22):昵称+头像不在 DOM、私有接口要签名,但页面把广场创作者信息缓存进了
  //   localStorage『BN_FEED_KOL』(单条 = 本人:displayName=广场创作者名/avatar=头像,与签名接口返回的本人头像一致);
  //   uid 在 localStorage『operation_list_user_id』。squareUid 从『__FEED_POST_COACH_HISTORY__<squareUid>__』键名取。
  //   → 全部读 localStorage,不碰签名接口。
  binance: '(function(){try{var uid=null;try{uid=localStorage.getItem("operation_list_user_id")||null;}catch(e){}var nick=null,av=null;try{var kol=JSON.parse(localStorage.getItem("BN_FEED_KOL")||"{}");var ks=Object.keys(kol);if(ks.length){var e0=kol[ks[0]]||{};nick=e0.displayName||null;av=e0.avatar||null;}}catch(e){}return JSON.stringify({uid:uid,nickname:nick,avatar:av,displayId:uid});}catch(e){return "{}";}})()',
  // YouTube:innertube account_menu 接口(和 YouTube 自家 JS 一样,SAPISID cookie 算 SAPISIDHASH 鉴权)。
  // activeAccountHeaderRenderer 里有 频道名(accountName)/handle(channelHandle,@xx)/头像;接口失败回落 masthead 头像。
  youtube: '(async function(){try{function gc(n){var m=document.cookie.match(new RegExp("(^|; )"+n+"=([^;]+)"));return m?decodeURIComponent(m[2]):null;}var cfg=(window.ytcfg&&ytcfg.data_)||{};var out={};var apiKey=cfg.INNERTUBE_API_KEY,ctx=cfg.INNERTUBE_CONTEXT;if(apiKey&&ctx){var origin="https://www.youtube.com";var hdr={"Content-Type":"application/json"};var sapisid=gc("SAPISID")||gc("__Secure-3PAPISID")||gc("__Secure-1PAPISID");if(sapisid){var t=Math.floor(Date.now()/1000);var buf=await crypto.subtle.digest("SHA-1",new TextEncoder().encode(t+" "+sapisid+" "+origin));var hex=Array.from(new Uint8Array(buf)).map(function(b){return b.toString(16).padStart(2,"0");}).join("");hdr["Authorization"]="SAPISIDHASH "+t+"_"+hex;hdr["X-Origin"]=origin;hdr["X-Goog-AuthUser"]="0";}var r=await fetch(origin+"/youtubei/v1/account/account_menu?prettyPrint=false",{method:"POST",credentials:"include",headers:hdr,body:JSON.stringify({context:ctx})});var j=await r.json();var acts=(j&&j.actions)||[],h=null;for(var i=0;i<acts.length;i++){var p=acts[i]&&acts[i].openPopupAction&&acts[i].openPopupAction.popup&&acts[i].openPopupAction.popup.multiPageMenuRenderer;if(p&&p.header&&p.header.activeAccountHeaderRenderer){h=p.header.activeAccountHeaderRenderer;break;}}if(h){out.nickname=(h.accountName&&h.accountName.simpleText)||null;out.displayId=(h.channelHandle&&h.channelHandle.simpleText)||null;var th=h.accountPhoto&&h.accountPhoto.thumbnails;out.avatar=(th&&th.length&&th[th.length-1].url)||null;}}if(!out.avatar){var img=document.querySelector("#avatar-btn img, button#avatar-btn img, ytd-topbar-menu-button-renderer img");out.avatar=(img&&img.src)||out.avatar||null;}return JSON.stringify(out);}catch(e){return "{}";}})()',
};
// uid 在明文 cookie 里的平台(页面 expr 拿不到 uid 时,从 cookie 补)。
const UID_COOKIE: Record<string, string> = { kuaishou: 'userId', toutiao: 'sso_uid_tt', bilibili: 'DedeUserID' };

// 有些平台首页 feed 上【没有本人信息】(乱扫 nickname 会抓到推荐流里别人的号 → 见 reference 的血泪教训),
// 必须先导航到「自己主页」再读身份。URL 用明文 cookie 里的 uid 拼。这是对齐抖音「在带本人 SSR 的页面读」
// 的统一做法:抖音/小红书/B站/YouTube 的源(RENDER_DATA / /me / /nav / account_menu)本身就含本人,无需跳;
// 快手 feed 不含本人 → 跳 profile/<uid>(cookie 有 uid);TikTok 首页 SSR 已空、昵称只在主页 DOM → 见 IDENTITY_NAV_HINT。
const IDENTITY_SELF_URL: Record<string, (uid: string) => string> = {
  kuaishou: (uid) => `https://www.kuaishou.com/profile/${uid}`,
};

// 同上,但「自己主页 URL」cookie 里没有、要【从当前页面读】出来(如 TikTok 的号在左侧导航栏链接里)。
// 这个 expr 在当前页跑、返回要跳的完整 URL(读不到返回空串 → 不跳,按当前页读)。跳过去后同样轮询 expr。
const IDENTITY_NAV_HINT: Record<string, string> = {
  // TikTok:左侧导航「主页」链接 = /@<号> → 跳过去才有 user-title(昵称)等 profile DOM(首页 feed 没有)。
  tiktok: '(function(){try{var p=document.querySelector(\'[data-e2e="nav-profile"]\')||document.querySelector(\'a[href^="/@"]\');var h=p?(p.getAttribute("href")||""):"";return (h.indexOf("/@")===0)?("https://www.tiktok.com"+h):"";}catch(e){return "";}})()',
};

export async function kernelReadIdentity(accountId: string, platform: string): Promise<KernelIdentity> {
  try {
    const s = await getPage(accountId);
    const out: KernelIdentity = {};
    const expr = IDENTITY_EXPR[platform];
    // 先取明文 cookie 里的 uid(快手等要用它拼自己主页 URL;也作 uid 兜底)。
    let cookieUid: string | undefined;
    if (UID_COOKIE[platform]) {
      try { const cr = await send(s, 'Network.getAllCookies', {}); const c = (cr?.cookies || []).find((x: any) => String(x.name) === UID_COOKIE[platform]); if (c) cookieUid = String(c.value); } catch { /* ignore */ }
    }
    // 首页无本人信息的平台(快手):先跳到 profile/<uid> 那页再读 —— 否则在推荐 feed 上读到空/别人的号。
    // 主页是 SPA,本人信息【异步渲染】,固定等待不稳 → 轮询到读出昵称/平台号/头像再停(最多 ~9s)。
    const selfUrl = IDENTITY_SELF_URL[platform];
    if (selfUrl && cookieUid && expr) {
      try { await kernelNavigate(accountId, selfUrl(cookieUid)); } catch { /* 导航失败就按当前页读,不阻塞 */ }
      for (let i = 0; i < 6; i++) {
        await sleep(1500);
        try { const probe = JSON.parse((await kernelEval(accountId, expr)) || '{}'); if (probe && (probe.nickname || probe.displayId || probe.avatar)) break; } catch { /* 还没渲染好,继续等 */ }
      }
    }
    // 自己主页 URL 不在 cookie、要从当前页读出来的平台(TikTok):先读导航栏拿到 /@号 → 跳过去 → 轮询到昵称出来。
    const navHint = IDENTITY_NAV_HINT[platform];
    if (navHint && expr && !(selfUrl && cookieUid)) {
      try {
        // 导航栏是 CSR 异步渲染的(TikTok 重 SPA),首次读常为空 → 轮询等它出来(最多 ~10s)再拿自己主页 URL。
        let url = '';
        for (let i = 0; i < 10 && !url; i++) {
          try { const u = await kernelEval(accountId, navHint); if (u && typeof u === 'string' && u) url = u; } catch { /* 继续等 */ }
          if (!url) await sleep(1000);
        }
        if (url) {
          await kernelNavigate(accountId, url);
          // 跳到自己主页后,等 user-title(昵称)等 profile DOM 渲染出来(最多 ~12s)。
          for (let i = 0; i < 8; i++) {
            await sleep(1500);
            try { const probe = JSON.parse((await kernelEval(accountId, expr)) || '{}'); if (probe && probe.nickname) break; } catch { /* 还没渲染好,继续等 */ }
          }
        }
      } catch { /* 读不到导航/导航失败 → 按当前页读,不阻塞 */ }
    }
    if (expr) {
      try { const o = JSON.parse((await kernelEval(accountId, expr)) || '{}'); if (o && typeof o === 'object') { out.uid = o.uid || undefined; out.nickname = o.nickname || undefined; out.displayId = o.displayId || undefined; out.avatar = o.avatar || undefined; } } catch { /* ignore */ }
    }
    // uid 兜底:用 cookie 里的 uid(getAllCookies 跨域)。
    if (!out.uid && cookieUid) out.uid = cookieUid;
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

export function closeKernel(accountId: string, opts?: { force?: boolean }): void {
  // 释放「使用互斥锁」:本流程对该号的操作结束 → 让排队的下一个流程能进(不受 refcount/下面早返回影响)。
  releaseLease(accountId);
  // 引用计数 -1:还有别的流程在用(>0)就【不关】,只有归 0(或 force)才真关 → 防误关在用的窗。
  const n = Math.max(0, (refCount.get(accountId) || 1) - 1);
  refCount.set(accountId, n);
  const s = sessions.get(accountId);
  if (!s) return;
  if (!opts?.force && n > 0) {
    coworkLog('INFO', 'kernelPool', `kernel ${accountId} 还有 ${n} 个流程在用,暂不关闭`);
    return;
  }
  refCount.delete(accountId);
  // 优雅关闭:CDP Browser.close 让 Chromium 正常退出(写「干净退出」标记)→ 下次启动不弹
  //   「未正确关闭 / 恢复页面」、也不会损坏 profile。失败/超时再强杀兜底(防卡住不退)。
  let graceful = false;
  try {
    if (s.pageWs && s.pageWs.readyState === WebSocket.OPEN) { sendNoWait(s, 'Browser.close'); graceful = true; }
  } catch { /* ignore */ }
  const proc = s.process;
  // 记进「将死表」:重开同号时 doLaunch 会先确保它退出(见 closingProcs 注释)。进程真正退出后自动摘除。
  if (proc && proc.exitCode === null) {
    closingProcs.set(accountId, proc);
    proc.once('exit', () => { if (closingProcs.get(accountId) === proc) closingProcs.delete(accountId); });
  }
  setTimeout(() => { try { if (proc && !proc.killed && proc.exitCode === null) proc.kill(); } catch { /* ignore */ } }, graceful ? 4000 : 0);
  failSession(s, 'kernel closed');
  sessions.delete(accountId);
  coworkLog('INFO', 'kernelPool', `closing kernel ${accountId}${graceful ? ' (graceful)' : ' (kill)'}`);
}

export function closeAllKernels(): void {
  // app 退出 / 急停:无视引用计数,全部强关。
  for (const id of Array.from(sessions.keys())) closeKernel(id, { force: true });
}

/**
 * 同步【立即强杀】所有内核子进程 —— sidecar 收到终止信号 / app 退出时用。
 * closeKernel/closeAllKernels 经 setTimeout 才真正 kill,但 process.exit 不会等定时器触发 →
 * 必须在这里同步 SIGKILL,否则内核成孤儿窗口(mac 无 Win32 Job Object 兜底,不随 sidecar 死)。
 */
export function killAllKernelsSync(): void {
  for (const id of Array.from(sessions.keys())) {
    try { sessions.get(id)?.process?.kill('SIGKILL'); } catch { /* ignore */ }
    sessions.delete(id);
  }
  for (const [id, proc] of Array.from(closingProcs.entries())) {
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    closingProcs.delete(id);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
