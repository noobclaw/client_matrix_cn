/**
 * 矩阵号「主动保活续期」。
 *
 * 原理:滑动会话平台(抖音/B站/快手/小红书/X/TikTok)每次带登录态访问,服务器会重发续期 cookie;矩阵内核是
 * 持久 profile(--user-data-dir),续期 cookie 会被存下来。所以定期让【超过 N 天没活跃】的 idle 号悄悄访问一次
 * 平台主页,就把会话续上了;顺带 checkKernelLogin 复验,真过期的标 login_required(后台静默,不弹窗)。
 *
 * 边界(诚实):
 *   · 视频号/微信扫码 token 硬过期,保活续不了(且漏 B 修好前检测也不准)→ 对它无效,只能重扫;
 *   · 只在 app 开着时跑(矩阵本来如此);app 长期不开,会话照样自然到期。
 *
 * 节流设计:
 *   · 真访问受【lastAliveAt 超过 ALIVE_THRESHOLD(5 天)】门槛,常跑任务的号 markAccountAlive 后进不了名单;
 *   · 扫描每 24h 一次(只比时间戳,几乎零成本)+ app 启动扫一次;
 *   · 串行 + 随机抖动,跳过正被占用(getSession 存活)的号,不并发不抢;
 *   · headless 优先(不打扰),失败回退普通(可见后台)窗;成功更新 lastAliveAt,失败标 login_required + 推 SSE。
 */

import { listAccounts, getAccount, setAccountStatus, markAccountAlive, accountBadgeLabel, platformKey } from './accountManager';
import { launchKernel, kernelNavigate, checkKernelLogin, closeKernel, getSession } from './kernelPool';
import { loginUrlFor } from './reloginPrompt';

const ALIVE_THRESHOLD_MS = 5 * 24 * 60 * 60 * 1000;  // 5 天没活跃才保活(真正的节流闸)
const SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000;        // 每 24h 扫一遍名单(只比时间戳)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 动态 require 避免与 sidecar-server 静态循环依赖;SSE 不可用不致命(状态已落盘)。
function emitAccount(data: Record<string, unknown>): void {
  try { const { broadcastSSE } = require('../../sidecar-server'); broadcastSSE('matrix:account', data); } catch { /* ignore */ }
}

let sweeping = false;
let scheduled = false;

/** 扫一遍名单,对「idle 且超 5 天没活跃且没被占用」的号逐个保活。串行 + 抖动。同时只跑一遍(去重)。 */
export async function runKeepAliveSweep(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const now = Date.now();
    const due = listAccounts().filter((a) =>
      a.status === 'idle'
      && !getSession(a.id)                                  // 没有活跃内核会话 = 当前没在被用
      && (now - (a.lastAliveAt || 0)) > ALIVE_THRESHOLD_MS, // 超 5 天没活跃
    );
    for (const acc of due) {
      // 串行期间状态/占用可能变 → 临用前再确认一次。
      const cur = getAccount(acc.id);
      if (!cur || cur.status !== 'idle' || getSession(acc.id)) continue;
      await keepAliveOne(acc.id);
      await sleep(8000 + Math.floor(Math.random() * 7000)); // 抖动 8~15s,别形成机器人式规律
    }
  } catch { /* best-effort,不抛 */ } finally {
    sweeping = false;
  }
}

/** 对一个号:headless 访问平台主页续 cookie + 复验登录态;成功更新 lastAliveAt,失败标 login_required。完后关窗。 */
async function keepAliveOne(accountId: string): Promise<void> {
  const acc = getAccount(accountId);
  if (!acc) return;
  const pk = platformKey(acc);
  const home = loginUrlFor(acc.platform, acc.loginScope);
  let launched = false;
  try {
    // headless 优先(不打扰);指纹内核 headless 跑不通时回退可见(后台、不置顶)窗。
    try {
      await launchKernel({
        accountId: acc.id, kernelVersion: acc.kernelVersion, userDataDir: acc.userDataDir,
        fingerprint: acc.fingerprint, proxy: acc.proxy, groupTitle: accountBadgeLabel(acc), headless: true,
      });
      launched = true;
    } catch {
      await launchKernel({
        accountId: acc.id, kernelVersion: acc.kernelVersion, userDataDir: acc.userDataDir,
        fingerprint: acc.fingerprint, proxy: acc.proxy, groupTitle: accountBadgeLabel(acc),
      });
      launched = true;
    }
    if (home) { try { await kernelNavigate(acc.id, home); } catch { /* ignore */ } }
    await sleep(4000); // 等服务器下发续期 cookie 落盘
    let ok = true;
    try { ok = await checkKernelLogin(acc.id, pk); } catch { ok = true; } // cookie 读失败不误杀(不标过期)
    if (ok) {
      markAccountAlive(acc.id);
      try { const { probeAndSaveHealth } = await import('./proxyBridge'); await probeAndSaveHealth(acc); } catch { /* 代理探测失败不影响保活 */ }
    } else {
      setAccountStatus(acc.id, 'login_required');
      emitAccount({ id: acc.id, status: 'login_required' }); // 静默标记;弹窗留给下次真发布
    }
  } catch { /* ignore:保活失败不影响其它 */ } finally {
    if (launched) { try { closeKernel(acc.id); } catch { /* ignore */ } }
  }
}

/** 启动主动保活调度:立即扫一遍 + 每 24h 扫一遍。重复调用只生效一次。 */
export function startKeepAliveScheduler(): void {
  if (scheduled) return;
  scheduled = true;
  void runKeepAliveSweep();
  setInterval(() => { void runKeepAliveSweep(); }, SCAN_INTERVAL_MS);
}
