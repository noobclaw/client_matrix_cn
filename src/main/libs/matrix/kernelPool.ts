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
import { ensureProxyBridge, probeProxy } from './proxyBridge';
import { getAccount, proxyBadgeInfo, getLocalEgressIp } from './accountManager';
import { acquireSystemKeepAwake, releaseSystemKeepAwake } from './powerKeepAwake';
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
  fileChooserWaiter?: ((params: any) => void) | null; // 等 Page.fileChooserOpened(真实文件选择器拦截上传)
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
  label?: string;                 // 窗口左上角常驻角标文案(一般是账号备注名 + 分组);设了才往页面注入绿色角标
  groupTitle?: string;            // 标签分组(蓝色 pill)标题。属浏览器 chrome、不进页面 → 跑任务也该给友好名,
                                  //   跟 label(页面角标/足迹)解耦:不传 label 不注入页面角标,但 groupTitle 仍可友好。
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

// ── 防最小化 + 防系统休眠(对齐旧客户端 chrome-extension 的 unminimizeManagedWindows + chrome.power)──
// 矩阵内核是独立 fingerprint-chromium、纯 CDP 控,用不到扩展的 chrome.windows/chrome.power → 照搬【行为】换实现:
//   · 防最小化:周期轮询每个内核窗口,windowState==='minimized' → setWindowBounds normal(不抢焦点,对齐扩展 drawAttention:false)。
//   · 防休眠:有内核存活就 OS 级保活(见 powerKeepAwake),全部关闭后释放。
// 单一所有者 = windowGuardTimer:launch 时 ensureWindowGuards 起;tick 见 sessions 空则自停 + 释放保活(免在每个
//   sessions.delete 点挂钩)。扩展用 onFocusChanged 毫秒级 + 30s alarm 兜底;CDP 无廉价焦点事件,2.5s 轮询足够快
//   (扩展注释:最小化节流要几分钟才坏)。
const WINDOW_GUARD_INTERVAL_MS = 2500;
let windowGuardTimer: ReturnType<typeof setInterval> | null = null;

function ensureWindowGuards(): void {
  if (windowGuardTimer) return;
  acquireSystemKeepAwake();
  windowGuardTimer = setInterval(() => { void windowGuardTick(); }, WINDOW_GUARD_INTERVAL_MS);
}

function stopWindowGuards(): void {
  if (windowGuardTimer) { clearInterval(windowGuardTimer); windowGuardTimer = null; }
  releaseSystemKeepAwake();
}

async function windowGuardTick(): Promise<void> {
  // 没有内核了 → 自停轮询 + 释放保活。
  if (sessions.size === 0) { stopWindowGuards(); return; }
  for (const s of Array.from(sessions.values())) {
    // 只在有活页面连接时被动检查(最小化不会断 CDP);headless 保活窗无窗口,getWindowForTarget 报错即跳过。
    if (!s.pageWs || s.pageWs.readyState !== WebSocket.OPEN || !s.pageTargetId) continue;
    try {
      const win = await send(s, 'Browser.getWindowForTarget', { targetId: s.pageTargetId });
      if (win?.windowId == null || win?.bounds?.windowState !== 'minimized') continue;
      // CDP 版 unminimize:set normal(不带 left/top → 不挪位、不抢焦点);二次确认兜底(部分平台 ack 但没动作,对齐扩展双 update)。
      await send(s, 'Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'normal' } });
      const after = await send(s, 'Browser.getWindowForTarget', { targetId: s.pageTargetId });
      if (after?.bounds?.windowState === 'minimized') {
        await send(s, 'Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'normal' } });
      }
      coworkLog('INFO', 'kernelPool', `防最小化:已复原内核窗口 ${s.accountId}`);
    } catch { /* 非关键:窗口/连接瞬态,下一拍再来 */ }
  }
}

/**
 * 注入「账号角标」脚本:窗口左上角常驻绿色标签显示账号名,多窗叠在一起也能分清。
 * 防风控:① 账号名文字放进 closed shadowRoot —— 页面 JS 读不到内容;② 宿主元素不带
 * id/class、状态只存闭包(不挂 window)—— 抖音侧基本无法枚举/识别这个角标。
 */
// 绿色身份角标 + 第二行【代理IP】角标。proxyMode:'ok'=能通/本机(绿)、'down'=代理不通(黄)、'dup'=撞IP(红+风控提示)。
function badgeScript(label: string, proxyText: string, proxyMode: 'ok' | 'down' | 'dup'): string {
  const L = JSON.stringify(label);
  let line2 = '代理IP: ' + proxyText;
  if (proxyMode === 'dup') line2 += '  ⚠️ 多个账号都在用该IP,存在风控风险,请尽早更换代理IP';
  else if (proxyMode === 'down') line2 += '  ⚠️ 代理不通,请检查';
  const P = JSON.stringify(line2);
  const bg2 = proxyMode === 'dup' ? '#dc2626' : proxyMode === 'down' ? '#d97706' : '#16a34a';
  // 只在【顶层文档】渲染:addScriptToEvaluateOnNewDocument 会对所有 frame(含 iframe)生效,
  //   视频号登录二维码等页面把内容放在 iframe 里,不守卫会在 iframe 内再渲染一个 position:fixed 角标盖住二维码。
  //   cross-origin iframe 访问 window.top 可能抛,catch 即判定为子 frame → 不渲染。
  return `(function(){try{if(window.top!==window.self)return;}catch(e){return;}var node=null;function m(){try{var root=document.body||document.documentElement;if(!root)return;if(node&&node.isConnected)return;`
    + `var host=document.createElement('div');host.style.cssText='position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;display:flex;flex-direction:column;align-items:center';`
    + `var sr=host.attachShadow?host.attachShadow({mode:'closed'}):null;var box=sr||host;`
    + `var b=document.createElement('div');b.textContent=${L};b.style.cssText='background:#16a34a;color:#fff;font:bold 13px/1.5 system-ui,sans-serif;padding:3px 12px;border-radius:0 0 8px 8px';box.appendChild(b);`
    + `var p=document.createElement('div');p.textContent=${P};p.style.cssText='background:${bg2};color:#fff;font:bold 12px/1.4 system-ui,sans-serif;padding:3px 12px;border-radius:0 0 8px 8px;margin-top:1px';box.appendChild(p);`
    + `root.appendChild(host);node=host;}catch(e){}}m();setInterval(m,2000);})();`;
}

// 黄色「登录已过期」角标(左上角,closed shadow,自愈)—— 跟 badgeScript 同款隐身,黄底 + 过期文案。
// 用户要求「角标不横幅」:左上角小标,占绿色身份角标那个位(top:0);出现时把绿色身份角标隐藏(按样式特征找到它
// 设 display:none —— 不改 badgeScript 本身)。登录成功跳页后本页 document 销毁、绿标在新页正常恢复。
function expiredBadgeScript(text: string): string {
  const T = JSON.stringify(text);
  return `(function(){try{if(window.top!==window.self)return;}catch(e){return;}var node=null;`
    // 隐藏绿色身份角标:它是 body 直接子节点、position:fixed、top/left:0、z-index 拉满的 div(badgeScript 的签名);排除自己(node)。
    + `function hideGreen(root){try{var ch=root.children;for(var i=0;i<ch.length;i++){var el=ch[i];if(el!==node&&el.tagName==='DIV'&&el.style&&el.style.position==='fixed'&&el.style.top==='0px'&&el.style.zIndex==='2147483647'){el.style.display='none';}}}catch(e){}}`
    + `function m(){try{var root=document.body||document.documentElement;if(!root)return;hideGreen(root);if(node&&node.isConnected)return;var host=document.createElement('div');host.style.cssText='position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none';var sr=host.attachShadow?host.attachShadow({mode:'closed'}):null;var b=document.createElement('div');b.textContent=${T};b.style.cssText='background:#facc15;color:#1f2937;font:bold 13px/1.5 system-ui,sans-serif;padding:4px 14px;border-radius:0 0 8px 8px;box-shadow:0 1px 6px rgba(0,0,0,.3)';(sr||host).appendChild(b);root.appendChild(host);node=host;}catch(e){}}m();setInterval(m,2000);})();`;
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

function buildKernelArgs(opts: LaunchKernelOptions, debugPort: number, bridgePort?: number | null): string[] {
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
    if (bridgePort) {
      // 带账密 SOCKS5:Chromium 不支持 SOCKS5 账密 → 指向本地无认证中转(proxyBridge),由它替我们做上游账密握手。
      args.push(`--proxy-server=socks5://127.0.0.1:${bridgePort}`);
    } else {
      // socks5h 在 chromium 里用 socks5(socks5 默认远程 DNS,防 DNS 泄漏)。
      // 带 auth 的 HTTP/HTTPS 代理【不内联账密】(Chromium 不支持)→ 经 CDP Fetch.authRequired 在 getPage 里提供凭据。
      const scheme = proxy.protocol === 'socks5h' ? 'socks5' : proxy.protocol;
      args.push(`--proxy-server=${scheme}://${proxy.host}:${proxy.port}`);
    }
    args.push('--disable-non-proxied-udp'); // 防 WebRTC 漏真实 IP
  }

  // 【tab group 可行性验证版】给内核挂一个极小 MV3 扩展:窗口内标签自动归到「账号名」彩色分组。
  // --disable-features 那条是为新版 chromium 把 --load-extension 重新放开(新版把它关进了默认禁用的
  // feature 开关);旧版/fingerprint-chromium 无此 feature 会忽略,无害。能不能真加载,mac 真机见分晓。
  try {
    const extDir = ensureTabGroupExtension(opts.accountId, opts.groupTitle || opts.label || opts.accountId);
    if (extDir) {
      args.push(`--load-extension=${extDir}`);
      args.push('--disable-features=DisableLoadExtensionCommandLineSwitch');
    }
  } catch { /* 扩展非关键,失败不挡启动 */ }

  if (opts.headless) args.push('--headless=new');
  else args.push('--window-size=1180,820'); // 启动即按目标尺寸开,消除åå¤§åç¼©çè·³å¨
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
  // 带账密 SOCKS5:先起本地无认证中转(Chromium 不支持 SOCKS5 账密),拿到本地端口让 args 指向它。
  //   失败回退 null → 直连(仍连不上认证 SOCKS5,但不比现状差);HTTP/HTTPS 认证不走这里(还是 Fetch.authRequired)。
  let bridgePort: number | null = null;
  if (opts.proxy?.username && opts.proxy?.password && (opts.proxy.protocol === 'socks5' || opts.proxy.protocol === 'socks5h')) {
    try { bridgePort = await ensureProxyBridge(opts.proxy); } catch { bridgePort = null; }
  }
  const args = buildKernelArgs(opts, debugPort, bridgePort);

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
    // 走了本地中转(bridgePort)就不再开 Fetch 认证(中转已替我们认证);仅 HTTP/HTTPS 认证代理才需 Fetch.authRequired。
    proxyAuth: (!bridgePort && opts.proxy?.username && opts.proxy?.password)
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
  ensureWindowGuards(); // 有内核存活 → 起防最小化轮询 + 系统防休眠(全部关闭后自停)。
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
  // 本机出口 IP 探测(仅【无代理】号):内核里 fetch ip 服务读真实出口(反映这个内核到底走没走 VPN;主进程 undici
  //   不一定走 VPN,必须内核侧探)。【在注入角标之前探】→ 角标一次性带上「本机 <ip>」,不再二次重注入。
  //   ⚠️ 之前探到后二次注入 badgeScript 会叠出【第二个角标】(各自 setInterval 维护、互不删)→ 两个角标重叠串成
  //   「本机默认 …206.35」那种乱码。改为:没缓存就等(封顶 3s)再注入;有缓存先用、后台刷新供下次起窗。
  const IPIFY_EXPR = '(async function(){try{var r=await fetch("https://api.ipify.org?format=text",{cache:"no-store"});var t=((await r.text())||"").trim();return /^[0-9a-fA-F:.]{3,45}$/.test(t)?t:"";}catch(e){return "";}})()';
  try {
    const accForIp = getAccount(s.accountId);
    if (accForIp && !accForIp.proxy) {
      if (!getLocalEgressIp()) {
        const ip = await Promise.race([
          kernelEval(s.accountId, IPIFY_EXPR).catch(() => ''),
          new Promise<string>((r) => setTimeout(() => r(''), 3000)),
        ]);
        if (ip) { const { setLocalEgressIp } = await import('./accountManager'); setLocalEgressIp(String(ip)); }
      } else {
        void (async () => {
          try { const ip = await kernelEval(s.accountId, IPIFY_EXPR); if (ip) { const { setLocalEgressIp } = await import('./accountManager'); setLocalEgressIp(String(ip)); } } catch { /* ignore */ }
        })();
      }
    }
  } catch { /* ignore */ }
  // 账号角标:窗口左上角常驻账号名 + 代理/本机 IP(IP 已在上面探好、写进 proxyBadgeInfo)。
  //   addScriptToEvaluateOnNewDocument 让它跨整页导航也在;立即再注入一次给当前页。【只注入这一次】,别在别处二次注入。
  if (s.label) {
    try {
      // 代理 IP 角标:撞 IP→红(风控提示)、有代理且探测能通→绿/不通→黄、本机→绿。探测仅在有代理且未撞 IP 时跑(≤6s)。
      const info = proxyBadgeInfo(s.accountId);
      let pmode: 'ok' | 'down' | 'dup' = 'ok';
      if (info.duplicate) pmode = 'dup';
      else if (info.hasProxy) {
        try { const acc = getAccount(s.accountId); pmode = (acc?.proxy && await probeProxy(acc.proxy)) ? 'ok' : 'down'; } catch { pmode = 'ok'; }
      }
      const script = badgeScript(s.label, info.text, pmode);
      await send(s, 'Page.addScriptToEvaluateOnNewDocument', { source: script });
      await send(s, 'Runtime.evaluate', { expression: script });
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
  } else if (msg.method === 'Page.fileChooserOpened') {
    // 真实文件选择器被拦下(点了页面的上传按钮触发)→ 把事件交给等待者去 setFileInputFiles。
    if (s.fileChooserWaiter) { const w = s.fileChooserWaiter; s.fileChooserWaiter = null; try { w(msg.params); } catch { /* ignore */ } }
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

/** 把该号窗口的页面提到前台(登录过期提醒:让用户一眼看到要重扫的那个窗口)。非关键,失败忽略。 */
export async function kernelBringToFront(accountId: string): Promise<void> {
  try { const s = await getPage(accountId); await send(s, 'Page.bringToFront'); } catch { /* 非关键 */ }
}

/** 在该号当前页注入红色「登录已过期,请重新扫码」角标(自愈;登录后导航离开会自然消失)。非关键,失败忽略。 */
export async function kernelShowExpiredBadge(accountId: string, text: string): Promise<void> {
  try { const s = await getPage(accountId); await send(s, 'Runtime.evaluate', { expression: expiredBadgeScript(text) }); } catch { /* 非关键 */ }
}

// ── 命令执行器(window.__nbExec)服务端下发 + 注入 ──
// 复用扩展 content.js/background.js 的 DOM 命令实现(见 backend/matrix/drivers/command_executor.js)。
// 改命令行为只改后端 + 重启,不打包 client。
function matrixApiBase(): string {
  return process.env.NOOBCLAW_API_BASE_URL || 'https://api.noobclaw.com';
}
let executorSource: string | null = null;        // lastGood 缓存
let executorFetchedAt = 0;                         // 上次成功拉取时间(TTL 刷新用)
const EXECUTOR_TTL_MS = 60_000;                    // 缓存新鲜窗口:超过则下次取用前刷新
let executorFetch: Promise<string | null> | null = null;
async function getExecutorSource(): Promise<string | null> {
  // 旧实现永久缓存(进程一辈子只拉一次)→ 改后端要重启 app 才生效。改成 TTL 刷新:
  //   TTL 内复用(避免一次运行内 N 个账号各拉一遍),超过 TTL 下次取用前重拉 →
  //   后端 git pull + restart 后,下一轮任务(>60s)自动拿到新执行器,不用重启客户端。
  if (executorSource && (Date.now() - executorFetchedAt) < EXECUTOR_TTL_MS) return executorSource;
  if (executorFetch) return executorFetch;
  executorFetch = (async () => {
    try {
      const res = await fetch(`${matrixApiBase()}/api/matrix/command-executor`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`http_${res.status}`);
      const data: any = await res.json();
      if (typeof data?.source === 'string' && data.source) { executorSource = data.source; executorFetchedAt = Date.now(); return executorSource; }
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

// 可信文本插入(CDP Input.insertText):像真键盘那样把整段文本插入【当前聚焦元素】,isTrusted=true、
// 穿 shadow、ProseMirror/Slate 等富文本编辑器认(合成 KeyboardEvent + execCommand 它们都不认 → 字进不去,
// 典型:B站评论 .brt-editor)。调用前需先把目标编辑器聚焦(可信点击)。
export async function kernelInsertText(accountId: string, text: string): Promise<void> {
  const s = await getPage(accountId);
  await send(s, 'Input.insertText', { text: String(text || '') });
}

// 可信滚轮(CDP Input.dispatchMouseEvent mouseWheel):部分平台(小红书/快手创作中心)懒加载
// 只认真实 wheel,JS scrollTop/scrollIntoView 触发不了。
export async function kernelWheel(accountId: string, x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
  const s = await getPage(accountId);
  await send(s, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: x || 400, y: y || 400, deltaX: deltaX || 0, deltaY: deltaY || 0 });
}

/**
 * 文件注入 —— 把本地视频灌进 file input(CDP DOM.setFileInputFiles)。
 *
 * setFileInputFiles 是标准 CDP 上传原语(Puppeteer/Playwright 同款),抖音/小红书/B站已验证可用。
 * 唯一被改对的是【成功判据】:CDP 只在把文件真设进一个合法 file input 后才成功 resolve,所以"至少一个
 * setFileInputFiles 没抛"本身就是成功信号。【不】事后回读 input.files.length —— React/受控组件(推特/
 * TikTok/快手/头条)的 onChange 会立刻读走文件并清空 input.value → 回读恒 0 → 误报失败(抖音/小红书/B站
 * 不清空才"碰巧"过)。旧扩展 upload_file_from_url 注入完也不回读,故无此坑。
 *
 * 深遍历 light DOM + open shadowRoot + 同源 iframe 收集候选 → 按 selector 过滤(没命中且 deep 时回退
 * accept 含 video/mp4/空)→ 给所有命中的都 setFileInputFiles(多候选不确定哪个真,全设最稳)。
 */
export async function kernelSetFileInput(
  accountId: string, selector: string, filePaths: string[], opts?: { deep?: boolean; single?: boolean },
): Promise<{ ok: boolean; reason?: string; found: number; attached: number }> {
  // 0) 本地文件先校验存在(对齐旧 uploadFileToInput 的 fs.existsSync 前置):路径错时给明确
  //    file_not_found,而不是笼统的 set_file_input_failed —— 否则成片路径/合成失败也只会显示同一个错。
  for (const fp of filePaths) {
    if (!fp || !fs.existsSync(fp)) {
      return { ok: false, reason: 'file_not_found:' + String(fp || '∅').slice(0, 120), found: 0, attached: 0 };
    }
  }
  const s = await getPage(accountId);
  const sel = selector || '';
  const deep = !!opts?.deep;
  const single = !!opts?.single;
  // 1) 深遍历收集候选 input 到 window.__mtxFI,返回数量。
  //    ⚠️ 旧版只穿 shadowRoot 漏了同源 iframe;对齐旧客户端 uploadVideoToInputDeep 的三层深遍历,补 iframe.contentDocument。
  //    single=true(图文上传用):最终只灌【一个】input(优先 accept 含 image 的),对齐扩展 uploadFileFromUrl 的
  //    querySelector 单设 —— 否则"全设"把图也灌进图文页「添加文件」附件 input(accept 空/*),帖子冒出多余
  //    nbmx_img.jpg 文件(图片本身 4 张仍正常)。视频上传不传 single,多候选仍"全设最稳"。
  const collectExpr = `(function(sel, deep, single){
    function collect(root, out){
      try { root.querySelectorAll('input[type=file]').forEach(function(el){ out.push(el); }); } catch(e){}
      var nodes=[]; try { nodes = root.querySelectorAll('*'); } catch(e){}
      for (var i=0;i<nodes.length;i++){ var sr=null; try{ sr=nodes[i].shadowRoot; }catch(e){} if(sr) collect(sr,out); }
      var fr=[]; try { fr = root.querySelectorAll('iframe,frame'); } catch(e){}
      for (var j=0;j<fr.length;j++){ var idoc=null; try{ idoc=fr[j].contentDocument; }catch(e){} if(idoc) collect(idoc,out); }
    }
    var all=[]; collect(document, all);
    var pick=[];
    if(sel){ for(var i=0;i<all.length;i++){ try{ if(all[i].matches(sel)) pick.push(all[i]); }catch(e){} } }
    if(!pick.length && (deep || !sel)){ pick = all.filter(function(el){ var a=(el.accept||'').toLowerCase(); return a.indexOf('video')>=0||a.indexOf('mp4')>=0||a===''; }); }
    if(!pick.length && deep) pick = all;
    if(single && pick.length > 1){
      var imgs = pick.filter(function(el){ return (el.accept||'').toLowerCase().indexOf('image')>=0; });
      pick = [ imgs.length ? imgs[0] : pick[0] ];
    }
    window.__mtxFI = pick;
    return pick.length;
  })(${JSON.stringify(sel)}, ${deep}, ${single})`;
  const cnt: any = await send(s, 'Runtime.evaluate', { expression: collectExpr, returnByValue: true });
  const n = Number(cnt?.result?.value || 0);
  if (!n) return { ok: false, reason: 'no_input_matched(sel=' + (sel || '∅') + ',deep=' + deep + ')', found: 0, attached: 0 };
  // 2) 逐个取 objectId → setFileInputFiles(单个失败继续,但记录第一条错误便于定位)。
  //    ⚠️【成功判据 = setFileInputFiles 成功返回】CDP 只在把文件真设进一个合法 file input 后才成功 resolve,
  //    所以"至少一个 setFileInputFiles 没抛"本身就是成功信号。不能再靠事后回读 input.files.length:
  //    React/受控组件(推特/TikTok/快手/头条)的 onChange 会立刻读走文件并清空 input.value → 回读恒为 0 →
  //    对这些平台误报失败(抖音/小红书/B站不清空才"碰巧"过)。旧扩展 upload_file_from_url 注入完不回读,故无此坑。
  let firstErr = '';
  let anySet = false;
  for (let i = 0; i < n; i++) {
    try {
      const elRes: any = await send(s, 'Runtime.evaluate', { expression: `window.__mtxFI[${i}]`, returnByValue: false });
      const objectId = elRes?.result?.objectId;
      if (!objectId) { if (!firstErr) firstErr = 'no_objectId'; continue; }
      await send(s, 'DOM.setFileInputFiles', { files: filePaths, objectId });
      anySet = true;
    } catch (e: any) { if (!firstErr) firstErr = String(e?.message || e).slice(0, 120); }
  }
  // 3) 辅助诊断:回读 files.length(仅作 attached 计数,不作成功/失败判据 —— 见上)。
  const verify: any = await send(s, 'Runtime.evaluate', {
    expression: `(function(){ var n=0; (window.__mtxFI||[]).forEach(function(el){ try{ if(el.files&&el.files.length) n++; }catch(e){} }); try{ delete window.__mtxFI; }catch(e){} return n; })()`,
    returnByValue: true,
  });
  const attached = Number(verify?.result?.value || 0);
  if (anySet) return { ok: true, found: n, attached };
  // 找到了候选但每个 setFileInputFiles 都抛 → 真失败,带出 CDP 错误便于定位。
  return { ok: false, reason: 'set_files_all_threw(found=' + n + (firstErr ? ',cdpErr=' + firstErr : '') + ')', found: n, attached: 0 };
}

/**
 * 文件注入(页面世界 DataTransfer)—— 把视频字节构造成真 File 灌进 file input,再派 change/input 事件,
 *   = 模拟【真人选文件】。这是 TikTok 创作端反爬 SDK(webmssdk)认的方式;CDP DOM.setFileInputFiles 会被它
 *   识别/拒绝 → 上传到一半「task not exist」崩成「出错了请重试」。
 *
 * 字节怎么进页面(2026-06-24 改):**base64 经 CDP 直接灌**,不走网络。
 *   原来走本地 sidecar http URL + 页面 fetch,但 TikTok Studio 是 https → 页面 fetch http://127.0.0.1 被挡
 *   (混合内容/代理/CSP)→ 实测「inject_Failed to fetch」→ 回落 CDP → 还是被 TikTok 拒。改成把文件读成 base64、
 *   用 Runtime.callFunctionOn 当【参数】传进页面(不进表达式源码、不走网络)→ 页面里 atob 解码成 File → DataTransfer。
 *   彻底绕开 fetch 的所有坑。大文件(>80MB)base64 太大伤 CDP 通道 → 放弃这条让上层回落。
 */
export async function kernelSetFileInputViaDataTransfer(
  accountId: string,
  filePath: string,
  opts?: { mimeType?: string; ttlMs?: number },
): Promise<{ ok: boolean; reason?: string; bytes?: number }> {
  if (!sessions.get(accountId)) return { ok: false, reason: 'no_session' };
  const fsMod = require('fs');
  if (!fsMod.existsSync(filePath)) return { ok: false, reason: 'file_not_found' };
  const s = await getPage(accountId);
  const pathMod = require('path');
  const fileName = pathMod.basename(filePath);
  const mime = opts?.mimeType || 'video/mp4';
  let b64: string;
  try {
    const buf: Buffer = fsMod.readFileSync(filePath);
    if (buf.length > 80 * 1024 * 1024) return { ok: false, reason: 'file_too_large_for_b64(' + buf.length + ')' };
    b64 = buf.toString('base64');
  } catch (e: any) { return { ok: false, reason: 'read_failed:' + String(e?.message || e).slice(0, 60) }; }
  // 三层深遍历底座(顶层 + 同源 iframe + open shadowRoot)定位 file input。
  const DEEP = 'function nbDeepAll(sel){var out=[];function walk(root,d){if(!root||d>6)return;'
    + 'try{var m=root.querySelectorAll(sel);for(var i=0;i<m.length;i++)out.push(m[i]);}catch(e){}'
    + 'var all=[];try{all=root.querySelectorAll("*");}catch(e){}'
    + 'for(var k=0;k<all.length;k++){var sr=null;try{sr=all[k].shadowRoot;}catch(e){}if(sr)walk(sr,d+1);}'
    + 'var fr=[];try{fr=root.querySelectorAll("iframe,frame");}catch(e){}'
    + 'for(var j=0;j<fr.length;j++){var idoc=null;try{idoc=fr[j].contentDocument;}catch(e){}if(idoc)walk(idoc,d+1);}}'
    + 'walk(document,0);return out;}';
  const findExpr = '(function(){' + DEEP
    + 'var ins=nbDeepAll(\'input[type="file"]\');var input=null;'
    + 'for(var i=0;i<ins.length;i++){var ac=ins[i].getAttribute("accept")||"";if(ac.indexOf("video")>=0||ac.indexOf("mp4")>=0){input=ins[i];break;}}'
    + 'if(!input&&ins.length)input=ins[0];return input;})()';
  // 在页面里:base64(参数) → Uint8Array → File → DataTransfer → input.files → 派 change/input。
  const fnDecl = 'function(b64,name,mime){try{'
    + 'var input=this;if(!input)return JSON.stringify({ok:false,reason:"no_input"});'
    + 'var bin=atob(b64);var len=bin.length;var bytes=new Uint8Array(len);for(var i=0;i<len;i++)bytes[i]=bin.charCodeAt(i);'
    + 'var win=(input.ownerDocument&&input.ownerDocument.defaultView)||window;'
    + 'var file=new win.File([bytes],name,{type:mime});'
    + 'var dt=new win.DataTransfer();dt.items.add(file);input.files=dt.files;'
    + 'input.dispatchEvent(new win.Event("change",{bubbles:true}));'
    + 'input.dispatchEvent(new win.Event("input",{bubbles:true}));'
    + 'return JSON.stringify({ok:true,bytes:len});'
    + '}catch(e){return JSON.stringify({ok:false,reason:"inject_"+String(e&&e.message||e).slice(0,80)});}}';
  try {
    try { await send(s, 'Page.setBypassCSP', { enabled: true }); } catch { /* 非关键 */ }
    const found: any = await send(s, 'Runtime.evaluate', { expression: findExpr, returnByValue: false });
    const objectId = found?.result?.objectId;
    if (!objectId) return { ok: false, reason: 'no_input_matched' };
    const r: any = await send(s, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: fnDecl,
      arguments: [{ value: b64 }, { value: fileName }, { value: mime }],
      returnByValue: true,
    });
    let v: any = null;
    try { v = r?.result?.value ? JSON.parse(r.result.value) : null; } catch { /* ignore */ }
    if (v && v.ok === true) return { ok: true, bytes: v.bytes };
    return { ok: false, reason: (v && v.reason) || 'inject_no_result' };
  } catch (e: any) {
    return { ok: false, reason: 'dt_inject_threw:' + String(e?.message || e).slice(0, 100) };
  }
}

/**
 * 文件注入(真实文件选择器拦截)—— 最贴近【人手动选文件】,TikTok 专用:
 *   合成 DataTransfer(isTrusted=false)被 webmssdk 拒;直接 setFileInputFiles(跳过站点上传按钮)→ 上传会话
 *   没初始化 →「task not exist / 出错了」。手动之所以行,是【点了站点自己的上传按钮】(跑 onClick 初始化会话+埋点)
 *   且 change 事件 isTrusted=true。本函数把两者都满足:
 *     ① Page.setInterceptFileChooserDialog 开拦截(原生选择器不真弹);
 *     ② 在上传按钮中心派【可信鼠标点击】(Input 域 = 真实用户手势)→ 站点 onClick → input.click() → 触发选择器;
 *     ③ 拦到 fileChooserOpened 的 backendNodeId → DOM.setFileInputFiles 喂文件(浏览器原生设置 = isTrusted=true)。
 *   findButtonExpr:页面里定位上传按钮、scrollIntoView 后返回其中心【视口坐标】{x,y} 的 JS(找不到返回 null)。
 */
export async function kernelSetFileInputViaChooser(
  accountId: string,
  filePath: string,
  findButtonExpr: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (!sessions.get(accountId)) return { ok: false, reason: 'no_session' };
  const fsMod = require('fs');
  if (!fsMod.existsSync(filePath)) return { ok: false, reason: 'file_not_found' };
  const s = await getPage(accountId);
  try {
    // ① 找上传按钮中心坐标(页面 JS 算 getBoundingClientRect 中心)。
    const posRes: any = await send(s, 'Runtime.evaluate', { expression: findButtonExpr, returnByValue: true });
    const pos = posRes?.result?.value;
    if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') {
      return { ok: false, reason: 'upload_button_not_found' };
    }
    // ② 开文件选择器拦截 + 武装等待者(onMessage 收到 fileChooserOpened 时 resolve)。
    await send(s, 'Page.setInterceptFileChooserDialog', { enabled: true });
    const chooserP = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { s.fileChooserWaiter = null; reject(new Error('fileChooser_timeout')); }, 15000);
      s.fileChooserWaiter = (params) => { clearTimeout(timer); resolve(params); };
    });
    // ③ 在按钮中心派可信鼠标点击(Input 域 = isTrusted=true 用户手势)→ 站点 onClick → input.click() → 弹选择器(被拦)。
    await send(s, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
    await send(s, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', buttons: 1, clickCount: 1 });
    await send(s, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', buttons: 0, clickCount: 1 });
    // ④ 等 fileChooserOpened → setFileInputFiles 喂文件(原生设置,触发 isTrusted=true 的 change)。
    let params: any;
    try { params = await chooserP; }
    catch (e: any) { try { await send(s, 'Page.setInterceptFileChooserDialog', { enabled: false }); } catch { /* ignore */ } return { ok: false, reason: String(e?.message || e).slice(0, 60) }; }
    const backendNodeId = params?.backendNodeId;
    if (!backendNodeId) { try { await send(s, 'Page.setInterceptFileChooserDialog', { enabled: false }); } catch { /* ignore */ } return { ok: false, reason: 'no_backendNodeId' }; }
    await send(s, 'DOM.setFileInputFiles', { files: [filePath], backendNodeId });
    try { await send(s, 'Page.setInterceptFileChooserDialog', { enabled: false }); } catch { /* ignore */ }
    return { ok: true };
  } catch (e: any) {
    try { s.fileChooserWaiter = null; await send(s, 'Page.setInterceptFileChooserDialog', { enabled: false }); } catch { /* ignore */ }
    return { ok: false, reason: 'chooser_inject_threw:' + String(e?.message || e).slice(0, 100) };
  }
}

/**
 * 往可编辑框「真键盘」打字(CDP Input 域,isTrusted=true)—— TikTok caption 专用:
 *   合成打字(execCommand insertText,isTrusted=false)会被 webmssdk 识破 → 上传后「出错了」掐掉。
 *   手动填描述是真键盘,所以没事。本函数复刻:可信点击聚焦 → 真键 Ctrl+A/Cmd+A 全选清空预填文件名 →
 *   Input.insertText 原生提交文本(isTrusted=true)。selector 支持逗号多选,取首个匹配。
 */
export async function kernelTypeIntoEditorNative(
  accountId: string,
  selector: string,
  text: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (!sessions.get(accountId)) return { ok: false, reason: 'no_session' };
  const s = await getPage(accountId);
  try {
    const findExpr = '(function(){var el=document.querySelector(' + JSON.stringify(selector) + ');if(!el)return null;'
      + 'try{el.scrollIntoView({block:"center"});}catch(e){}var r=el.getBoundingClientRect();'
      + 'if(r.width<1||r.height<1)return null;return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+Math.min(r.height/2,18))};})()';
    const posRes: any = await send(s, 'Runtime.evaluate', { expression: findExpr, returnByValue: true });
    const pos = posRes?.result?.value;
    if (!pos || typeof pos.x !== 'number') return { ok: false, reason: 'editor_not_found' };
    // 可信点击聚焦(Input 域 = isTrusted=true)。
    await send(s, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
    await send(s, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', buttons: 1, clickCount: 1 });
    await send(s, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', buttons: 0, clickCount: 1 });
    await new Promise((r) => setTimeout(r, 200));
    // 清掉 TikTok 预填的文件名:真键全选 → Backspace 删除。⚠️ 之前只发 keyDown A(modifiers:2)不生效,
    //   DraftEditor 要【修饰键先真按下】才认全选 → 用完整序列(modifier rawKeyDown → A down/up → modifier up),
    //   Ctrl+A 与 Cmd+A 各来一遍(内核按仿真 OS 认其一),再 Backspace 删掉选区。
    const selectAll = async (mKey: string, mCode: string, mVk: number, mBit: number) => {
      await send(s, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: mBit, key: mKey, code: mCode, windowsVirtualKeyCode: mVk, nativeVirtualKeyCode: mVk });
      await send(s, 'Input.dispatchKeyEvent', { type: 'keyDown', modifiers: mBit, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
      await send(s, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers: mBit, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
      await send(s, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 0, key: mKey, code: mCode, windowsVirtualKeyCode: mVk, nativeVirtualKeyCode: mVk });
    };
    await selectAll('Control', 'ControlLeft', 17, 2);
    await selectAll('Meta', 'MetaLeft', 91, 8);
    // Backspace 删除选区(真键)。
    await send(s, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
    await send(s, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
    await new Promise((r) => setTimeout(r, 80));
    // 原生提交文本(isTrusted=true)。
    await send(s, 'Input.insertText', { text });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: 'type_native_threw:' + String(e?.message || e).slice(0, 100) };
  }
}

// 清空该号浏览器全部 cookie(断开关联用:登出但保留 profile/指纹/配置)。
export async function kernelClearCookies(accountId: string): Promise<void> {
  const s = await getPage(accountId);
  try { await send(s, 'Network.clearBrowserCookies', {}); } catch { /* ignore */ }
}

// ── 导入 cookie 登录:把外部(普通浏览器 Cookie-Editor 导出)的登录 cookie 灌进本号 profile ──
//   行业标准做法:海外号(Google/Apple 登录)、已在其它浏览器登录过的号,不在指纹内核里跑 OAuth,而是注入已登录 cookie。
//   cookie 项对齐 Cookie-Editor 导出格式({name,value,domain,path,secure,httpOnly,sameSite,expirationDate})。
//   走 CDP Network.setCookie(与 checkKernelLogin 的 getAllCookies 同一套通道)。
export async function kernelSetCookies(accountId: string, cookies: any[]): Promise<{ set: number; failed: number }> {
  const s = await getPage(accountId);
  let set = 0, failed = 0;
  for (const c of (Array.isArray(cookies) ? cookies : [])) {
    try {
      const name = String((c && c.name) || '').trim();
      if (!name) { failed++; continue; }
      const p: any = { name, value: String((c && c.value) != null ? c.value : ''), path: (c && c.path) || '/', httpOnly: !!(c && c.httpOnly), secure: (c && c.secure) !== false };
      const domain = String((c && c.domain) || '').trim();
      if (domain) p.domain = domain; else if (c && c.url) p.url = c.url;
      const ss = String((c && c.sameSite) || '').toLowerCase();
      if (ss === 'no_restriction' || ss === 'none') p.sameSite = 'None';
      else if (ss === 'lax') p.sameSite = 'Lax';
      else if (ss === 'strict') p.sameSite = 'Strict';
      if (typeof (c && c.expirationDate) === 'number') p.expires = c.expirationDate;
      else if (typeof (c && c.expires) === 'number') p.expires = c.expires;
      if (p.sameSite === 'None') p.secure = true; // SameSite=None 必须 Secure,否则被拒
      const r = await send(s, 'Network.setCookie', p);
      if (r && r.success === false) failed++; else set++;
    } catch { failed++; }
  }
  return { set, failed };
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
  kuaishou: ['kuaishou.server.webday7_st'],   // 主站 www.kuaishou.com 登录令牌(⚠️ 只认 webday7_st:userId 游客也有、登出后残留会误放行)
  // 快手创作者中心 cp.kuaishou.com:独立登录态(主站登录不覆盖,实测)。cp 专属会话令牌。
  kuaishou_creator: ['kuaishou.web.cp.api_st'],
  toutiao: ['sessionid', 'sso_uid_tt'],
  tiktok: ['sessionid', 'sid_tt'],
  x: ['auth_token'],
  binance: ['logined', 'p20t'],                          // 新增(实测)
  youtube: ['SID', 'SAPISID', 'LOGIN_INFO'],             // 新增(实测)
  // ⚠️ 待 VPN 真机确认(2026-07-03 加):IG 登录态标志 cookie = sessionid + ds_user_id(后者明文=uid);
  //   FB = c_user(明文=uid)+ xs。海外平台,须 VPN 真机核对 cookie 名。
  instagram: ['sessionid', 'ds_user_id'],
  facebook: ['c_user', 'xs'],
  // Reddit 登录态:reddit_session(会话)+ token_v2(新版 JWT)。任一在即过快筛;活体/身份用 /api/me.json 确认。
  reddit: ['reddit_session', 'token_v2'],
};

/** 该号当前【是否真的登录】对应平台 —— 统一活体校验(发布/涨粉/保活都调它)。分层:
 *  ① cookie 快筛:标志性 cookie 不在 → 必然没登录(不开窗折腾);
 *  ② 服务器活体确认:有认证接口的平台(小红书 /me、B站 /nav)直接问服务器,给明确答案就以它为准(最准);
 *  ③ 通用兜底:没接口的平台,看【当前页是否被重定向到登录页】= 服务端判未登录(cookie 还在但已失效)。
 *     仅当调用方已导航到【需登录才能进的页】(创作中心)时有意义;游客可看的首页 URL 不变 → 退回 cookie 结果。
 *  关键认知:cookie 在 ≠ 登录有效(服务端可作废 session,cookie 仍在 profile 里)→ 必须有 ②/③ 的活体确认。
 *  ⚠️ cookie 用 getAllCookies(读所有域),否则在 creator./cp./mp. 子域会漏掉挂在父域的登录 cookie。 */
export async function checkKernelLogin(accountId: string, platform: string): Promise<boolean> {
  if (!sessions.get(accountId)) return false;
  try {
    const s = await getPage(accountId);
    let cookies: any[] = [];
    try { const r = await send(s, 'Network.getAllCookies', {}); cookies = r?.cookies || []; } catch { /* fallback below */ }
    if (!cookies.length) { const r2 = await send(s, 'Network.getCookies', {}); cookies = r2?.cookies || []; }
    const names = new Set<string>(cookies.map((c: any) => String(c.name)));
    const need = LOGIN_COOKIES[platform] || [];
    // ① cookie 快筛(binance 例外:重 WAF、session cookie 名多变,登录着也常没 logined/p20t → 硬卡会误判过期。
    //    币安改成【不卡 cookie,交给下面 DOM/localStorage 正向判据】,绝不因 cookie 名对不上误杀好号)。
    if (platform !== 'binance' && !need.some((n) => names.has(n))) return false;
    // ② 活体判定:对齐成熟开源 social-auto-upload(导航到创作/上传页 → 检测登录墙标记)。
    //   【铁律:只在检到「明确未登录」证据(登录墙文字/元素、或接口明说未登录)时才判未登录;否则一律 "?" 交回 ③/cookie
    //    → 绝不把登录着的好号误判过期】。有官方 isLogin 接口的(小红书/B站)用接口最准;其余用 social-auto-upload 的 DOM 标记。
    //   ⚠️ DOM 标记须【已导航到创作页】后查(调用方 runMatrixPublish/taskRunner 发布前已导航 PUBLISHER_ANCHOR_URL=各创作页)。
    let probe = '';
    if (platform === 'xhs') {
      // 小红书:/me 的 guest 标志(web_session 游客也下发 → 必须问接口)。guest:true=未登录,guest:false+user_id=已登录。
      // ⚠️ 裸 fetch user/me 现在会被当【游客】返回 guest:true(接口要签名头 x-s/x-t)——
      //   不能拿它当「未登录」证据(真机实测:页面登录着却被误判过期)。只信【正向】guest:false+user_id="1";
      //   拿不到正向就查页面登录墙文字,有才判 "0",否则 "?" 交回兜底 —— 绝不误杀登录着的好号(铁律)。
      probe = '(async function(){try{var r=await fetch("https://edith.xiaohongshu.com/api/sns/web/v2/user/me",{credentials:"include"});var j=await r.json();var d=(j&&j.data)||{};if(d.guest===false&&d.user_id)return "1";}catch(e){}try{var t=(document.body&&document.body.innerText)||"";if(/扫码登录|手机号登录|新用户.*扫码|登录后查看更多|登录发现更多/.test(t))return "0";}catch(e){}return "?";})()';
    } else if (platform === 'bilibili') {
      probe = '(async function(){try{var r=await fetch("https://api.bilibili.com/x/web-interface/nav",{credentials:"include"});var j=await r.json();var d=(j&&j.data)||{};if(d.isLogin===true)return "1";if(d.isLogin===false)return "0";return "?";}catch(e){return "?";}})()';
    } else if (platform === 'toutiao') {
      // 头条创作端:get_media_info 游客明说「user not login」(code 100004);登录态 code:0+data。
      probe = '(async function(){try{var r=await fetch("https://mp.toutiao.com/mp/agw/media/get_media_info",{credentials:"include"});var j=await r.json();if(j){if(j.code===100004||/not login/i.test(String(j.message||"")))return "0";if(j.code===0&&j.data)return "1";}return "?";}catch(e){return "?";}})()';
    } else if (platform === 'douyin') {
      // social-auto-upload:creator.douyin.com 上传页未登录有「手机号登录/扫码登录」文字。登录着的页面没有。
      probe = '(function(){try{var t=(document.body&&document.body.innerText)||"";if(/手机号登录|扫码登录|验证码登录|二维码登录|登录后即可/.test(t))return "0";return "?";}catch(e){return "?";}})()';
    } else if (platform === 'kuaishou' || platform === 'kuaishou_creator') {
      // 未登录判据:创作端 cp 落到「机构服务」;主站 www.kuaishou.com 登出显「立即登录/登录即可享受」(真机实测,原来漏了主站 → 误判已登录空搜)。
      probe = '(function(){try{var t=(document.body&&document.body.innerText)||"";if(/机构服务/.test(t)||/扫码登录|手机号登录|立即登录|登录即可享受|登录后即可享受|登录发现更多/.test(t))return "0";return "?";}catch(e){return "?";}})()';
    } else if (platform === 'shipinhao') {
      // social-auto-upload:channels 发表页未登录有「扫码登录」,登录态有「发表视频」。
      //   视频号是 wujie 重前端、跳登录页慢 → 靠调用方【先强制等 20s 让页面加载/跳转完】再查(见 runMatrixPublish),
      //   这样这条 DOM 快照才可靠(否则赶在跳登录页前查会误判已登录)。
      probe = '(function(){try{var t=(document.body&&document.body.innerText)||"";if(/扫码登录/.test(t))return "0";if(/发表视频/.test(t))return "1";return "?";}catch(e){return "?";}})()';
    } else if (platform === 'tiktok') {
      // social-auto-upload:未登录的 studio 上传页有 select.tiktok-*-SelectFormContainer*(地区/登录选择表单)。
      probe = '(function(){try{if(document.querySelector(\'select[class*="SelectFormContainer"]\'))return "0";return "?";}catch(e){return "?";}})()';
    } else if (platform === 'binance') {
      // 币安广场【正向优先】:登录态才有的 localStorage(operation_list_user_id / BN_FEED_KOL)或「分享您的洞见/
      //   Share your」发帖框 → 明确判 "1"。这些是登录后才存在的强正向信号,拿它当权威(真机实测:登录着却被判过期,
      //   根因是原来靠「顶部有登录/注册按钮」的反向扫描误命中促销位)。只在【登录墙文字】出现时才 "0",否则 "?"。
      //   去掉原来的顶部 login/register CTA 扫描(误杀源)。
      probe = '(function(){try{'
        + 'try{if(localStorage.getItem("operation_list_user_id")||localStorage.getItem("BN_FEED_KOL"))return "1";}catch(e){}'
        + 'var t=(document.body&&document.body.innerText)||"";'
        + 'if(/分享您的洞见|分享你的洞见|Share your|发帖|发布动态/.test(t))return "1";'
        + 'if(/Sign up to earn rewards|Join global crypto users|Discover real insights from verified|Log in to Binance|登录后即可|扫码登录|请先登录/i.test(t))return "0";'
        + 'return "?";}catch(e){return "?";}})()';
    } else if (platform === 'instagram') {
      // IG:【语言无关】判据(UI 随 locale 变,不能靠文字)—— 登录墙有 username 输入框 / 或重定向到 /accounts/login。
      //   登录态没有登录表单。只判 0,否则 "?" 交回 cookie。待 VPN 真机确认正向标记(如导航头像)。
      probe = '(function(){try{if(document.querySelector(\'input[name="username"]\')||/\\/accounts\\/login/.test(location.pathname))return "0";return "?";}catch(e){return "?";}})()';
    } else if (platform === 'facebook') {
      // FB(2026-07-03 真机验):登录墙有 email 输入框 / 重定向 /login → "0";登录态有 [role=navigation]
      //   + c_user 明文 cookie → 明确 "1"(真机实测 onLogin:false/hasNav:true)。都不是则 "?"。语言无关。
      probe = '(function(){try{if(document.querySelector(\'input[name="email"]\')||/\\/login/.test(location.pathname))return "0";if(document.querySelector(\'[role="navigation"]\')&&document.cookie.indexOf("c_user=")>=0)return "1";return "?";}catch(e){return "?";}})()';
    } else if (platform === 'reddit') {
      // Reddit:/api/me.json 是 cookie 鉴权的 JSON 接口(不需 oauth)。登录态返回 {data:{name,...}} 或 {name,...};
      //   未登录返回空 / 无 name。最准,语言无关。异常落 "?" 交回 cookie 快筛。
      probe = '(async function(){try{var r=await fetch("/api/me.json",{credentials:"include",headers:{accept:"application/json"}});var j=await r.json();var d=(j&&j.data)||j||{};if(d&&d.name)return "1";return "0";}catch(e){return "?";}})()';
    }
    if (probe) {
      try {
        const v = await kernelEval(accountId, probe);
        if (v === '1') return true; if (v === '0') return false;
      } catch { /* "?"/异常 → 落 ③,绝不误杀 */ }
    }
    // ③ 通用兜底:当前页被重定向到登录页 = 服务端已判未登录(cookie 还在但失效)。读不到 URL 就只信 cookie。
    try {
      const href = await kernelEval(accountId, 'location.href');
      if (/(login|passport|signin|sign-in|account\/security)/i.test(String(href || ''))) return false;
    } catch { /* ignore */ }
    return true;
  } catch { return false; }
}

// 读登录后的真实身份(昵称 / 平台号 / uid / 头像)。【昵称不在 cookie】—— 登录 cookie 是 httpOnly
// 令牌;昵称要从各平台的页面 SSR / 接口读,uid 部分在明文 cookie、部分在页面。来源全部 2026-06-21
// 真机 CDP 实测确定(见 reference_matrix_account_identity_sources)。
export interface KernelIdentity { uid?: string; nickname?: string; displayId?: string; avatar?: string }

// 各平台「读身份」的页面表达式(在内核页里 eval;async 的靠 awaitPromise 兜)。返回 JSON 字符串。
const IDENTITY_EXPR: Record<string, string> = {
  // 抖音:RENDER_DATA(SSR JSON)。nickname/uid/抖音号/头像。本人块可能是【驼峰】命名(头像兜底命中 avatarUrl 即印证),
  //   所以抖音号同时认 unique_id/short_id(蛇形)与 uniqueId/shortId(驼峰)、short_id 兼容带引号或纯数字;
  //   且 displayId 只在【本人昵称附近 ±1500 的块】里找(不全局乱抓推荐流里别人的号)。抓不到时回传 _dbg 本人块片段供定位。
  douyin: '(function(){try{var el=document.getElementById("RENDER_DATA");var d="";try{d=decodeURIComponent((el&&el.textContent)||"");}catch(e){d=(el&&el.textContent)||"";}var n=d.match(/"nickname":"([^"]{1,40})"/),u=d.match(/"uid":"(\\d{6,25})"/),a=d.match(/"avatar_thumb":\\{"uri":"[^"]*","url_list":\\["([^"]+)"/)||d.match(/"avatarUrl":"([^"]+)"/);var ni=n?d.indexOf(n[0]):-1;var blk=ni>=0?d.slice(Math.max(0,ni-1500),ni+1500):d;var s=blk.match(/"unique_id":"([^"]{1,40})"/)||blk.match(/"uniqueId":"([^"]{1,40})"/),s2=blk.match(/"short_id":"?(\\d{3,40})"?/)||blk.match(/"shortId":"?(\\d{3,40})"?/);var did=(s&&s[1])||(s2&&s2[1])||null;var dbg=did?null:blk.slice(0,600);return JSON.stringify({nickname:n&&n[1],uid:u&&u[1],displayId:did,avatar:a&&(a[1]||"").replace(/\\\\u002F/g,"/"),_dbg:dbg});}catch(e){return "{}";}})()',
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
  // 快手创作者中心(cp.kuaishou.com):cp 接口需页面签名(裸 fetch 返回 result:10001/500002)、localStorage 也空;
  //   身份在【Vue store】里(页面用签名接口拿到后缓存)。真机实测 2026-06-23:#app.__vue__.$store.state.user =
  //   { userName(昵称), userKwaiId(快手号), userId(uid), userAvatar(头像 yximgs), logined }。读它最稳。
  kuaishou_creator: '(function(){try{var app=document.querySelector("#app")||document.querySelector("[id*=app]")||document.body.firstElementChild;var vue=app&&(app.__vue__||(app.__vue_app__&&app.__vue_app__._instance&&app.__vue_app__._instance.proxy));var store=vue&&(vue.$store||(vue.$root&&vue.$root.$store));var st=store&&store.state;var u=st&&st.user;if(!(u&&(u.userName||u.userAvatar))&&st){for(var k in st){var v=st[k];if(v&&typeof v==="object"&&(v.userName||v.userAvatar)&&(v.userId||v.userKwaiId)){u=v;break;}}}if(u&&(u.userName||u.userAvatar)){return JSON.stringify({nickname:u.userName||null,displayId:u.userKwaiId||null,uid:u.userId?String(u.userId):null,avatar:u.userAvatar||null});}return "{}";}catch(e){return "{}";}})()',
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
  // ⚠️ TODO(VPN 真机调):IG/FB 昵称/头像的确切来源要登录态 DOM 才能定。uid 已由 UID_COOKIE 从明文
  //   cookie 补(IG=ds_user_id、FB=c_user),所以即使这里抓不到昵称,账号也能建(uid 做去重键,昵称可手动改)。
  //   下面是【best-effort 占位】:IG 从导航头像 img.alt / og:title 试,FB 从 og:title / 头像试;抓不到回 {}。
  instagram: '(function(){try{var nick=null,av=null;var m=document.querySelector(\'meta[property="og:title"]\');if(m){nick=((m.getAttribute("content")||"").split("(")[0]||"").trim()||null;}var a=document.querySelector(\'header img\')||document.querySelector(\'nav img[alt]\');if(a)av=a.src||null;return JSON.stringify({nickname:nick,avatar:av});}catch(e){return "{}";}})()',
  // FB(2026-07-03 真机验):uid=c_user 明文 cookie;昵称在【自己主页 profile.php?id=<c_user>】的 og:title(首页 feed
  //   ogTitle 为 null,故靠 IDENTITY_SELF_URL 先跳主页再读),兜底 h1 / document.title(去掉"(N)"和"| Facebook");
  //   头像=fbcdn 里 t1.30497-1(FB 头像路径)的 <image xlink:href>(首页/主页都有,与 rsrc.php UI 精灵、t39 帖图区分)。
  facebook: '(function(){try{var uid=(document.cookie.match(/c_user=(\\d+)/)||[])[1]||null;var nick=null;var ogt=document.querySelector(\'meta[property="og:title"]\');if(ogt)nick=(ogt.getAttribute("content")||"").trim()||null;if(!nick){var h1=document.querySelector("h1");if(h1)nick=((h1.textContent||"").trim().slice(0,40))||null;}if(!nick){nick=((document.title||"").replace(/^\\(\\d+\\)\\s*/,"").replace(/\\s*[|\\-]\\s*Facebook.*$/i,"").trim())||null;}var av=null,ims=document.querySelectorAll("image");for(var i=0;i<ims.length;i++){var h=ims[i].getAttribute("xlink:href")||ims[i].getAttribute("href")||"";if(/t1\\.30497/.test(h)){av=h;break;}}return JSON.stringify({nickname:nick,uid:uid,displayId:uid,avatar:av});}catch(e){return "{}";}})()',
  // Reddit:/api/me.json(cookie 鉴权)一把出 name(用户名)/ id(t2 uid)/ icon_img|snoovatar_img(头像)。
  //   头像 URL 里的 &amp; 要还原成 &。displayId = u/<name>。同 xhs/B站 的「问接口」路子,最稳。
  reddit: '(async function(){try{var r=await fetch("/api/me.json",{credentials:"include",headers:{accept:"application/json"}});var j=await r.json();var d=(j&&j.data)||j||{};if(!d.name)return "{}";var av=String(d.snoovatar_img||d.icon_img||"").replace(/&amp;/g,"&").split("?")[0];return JSON.stringify({nickname:d.name,displayId:"u/"+d.name,uid:d.id?("t2_"+d.id):d.name,avatar:av});}catch(e){return "{}";}})()',
};
// uid 在明文 cookie 里的平台(页面 expr 拿不到 uid 时,从 cookie 补)。
const UID_COOKIE: Record<string, string> = { kuaishou: 'userId', toutiao: 'sso_uid_tt', bilibili: 'DedeUserID', instagram: 'ds_user_id', facebook: 'c_user' };

// 有些平台首页 feed 上【没有本人信息】(乱扫 nickname 会抓到推荐流里别人的号 → 见 reference 的血泪教训),
// 必须先导航到「自己主页」再读身份。URL 用明文 cookie 里的 uid 拼。这是对齐抖音「在带本人 SSR 的页面读」
// 的统一做法:抖音/小红书/B站/YouTube 的源(RENDER_DATA / /me / /nav / account_menu)本身就含本人,无需跳;
// 快手 feed 不含本人 → 跳 profile/<uid>(cookie 有 uid);TikTok 首页 SSR 已空、昵称只在主页 DOM → 见 IDENTITY_NAV_HINT。
const IDENTITY_SELF_URL: Record<string, (uid: string) => string> = {
  kuaishou: (uid) => `https://www.kuaishou.com/profile/${uid}`,
  // FB 首页 feed 没本人昵称(og:title=null)→ 跳自己主页读(uid=c_user 明文 cookie)。真机验 2026-07-03。
  facebook: (uid) => `https://www.facebook.com/profile.php?id=${uid}`,
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
      // ⚠️ 单次读在【登录刚成功】时常拿空:扫码连接首读时,抖音/小红书/B站等的 SSR(RENDER_DATA)/CSR 还没把
      //   本人信息渲染出来 → 读到空,要等用户手动「刷新信息」才出。改成轮询到读出再停(最多 ~12s):已经在上面
      //   selfUrl/navHint 分支轮询拿到的平台(快手/TikTok)这里第一次就 break、不增耗时;抖音等给它时间等渲染。
      let lastDbg: string | undefined;
      for (let i = 0; i < 8; i++) {
        try {
          const o = JSON.parse((await kernelEval(accountId, expr)) || '{}');
          if (o && typeof o === 'object') {
            out.uid = o.uid || out.uid; out.nickname = o.nickname || out.nickname;
            out.displayId = o.displayId || out.displayId; out.avatar = o.avatar || out.avatar;
            if (o._dbg) lastDbg = String(o._dbg);
          }
        } catch { /* 还没渲染好,继续等 */ }
        if (out.nickname || out.avatar || out.displayId) {
          // 抖音号可能比昵称/头像晚渲染:缺号时再多等几轮(最多 ~6s);其它平台一拿到就停。
          if (!(platform === 'douyin' && !out.displayId && i < 4)) break;
        }
        await sleep(1500);
      }
      // 抖音抓到了昵称却没抓到抖音号 → 把本人块片段记一条,便于按真实键名精修(不写进身份)。
      if (platform === 'douyin' && out.nickname && !out.displayId && lastDbg) {
        coworkLog('INFO', 'matrix-identity', 'douyin displayId miss', { snippet: lastDbg.slice(0, 600) });
      }
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
  stopWindowGuards(); // 同步停轮询 + 释放系统保活(process.exit 不会等定时器自停)。
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
