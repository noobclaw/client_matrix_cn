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
 *   · 真访问受【lastAliveAt 超过 ALIVE_THRESHOLD(3 天)】门槛,常跑任务的号 markAccountAlive 后进不了名单;
 *   · 扫描每 12h 一次(只比时间戳,几乎零成本)+ app 启动扫一次;
 *   · 串行 + 随机抖动,跳过正被占用(getSession 存活)的号,不并发不抢;
 *   · headless 优先(不打扰),失败回退普通(可见后台)窗;成功更新 lastAliveAt,失败标 login_required + 推 SSE。
 */

import { listAccounts, getAccount, setAccountStatus, markAccountAlive, accountBadgeLabel, platformKey } from './accountManager';
import { launchKernel, kernelNavigate, checkKernelLogin, closeKernel, getSession } from './kernelPool';
import { loginUrlFor } from './reloginPrompt';

// ⚠️ 续期门槛:超过这么久没活跃就主动续(尽量让登录态别过期)。5 天→3 天:更早续上,覆盖 cookie 寿命较短的平台
//   (固定天数仍不贴各平台真实 TTL,精准做法是按 cookie expires 续(可选增强))。12h 扫一次让跨过门槛的号更快被续。
const ALIVE_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000;  // 3 天没活跃就保活续期
const SCAN_INTERVAL_MS = 12 * 60 * 60 * 1000;        // 每 12h 扫一遍名单(只比时间戳,几乎零成本)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 动态 require 避免与 sidecar-server 静态循环依赖;SSE 不可用不致命(状态已落盘)。
function emitAccount(data: Record<string, unknown>): void {
  try { const { broadcastSSE } = require('../../sidecar-server'); broadcastSSE('matrix:account', data); } catch { /* ignore */ }
}

let sweeping = false;
let scheduled = false;

/** 扫一遍名单,对「idle 且超 3 天没活跃且没被占用」的号逐个保活。串行 + 抖动。同时只跑一遍(去重)。 */
export async function runKeepAliveSweep(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const now = Date.now();
    const due = listAccounts().filter((a) =>
      !getSession(a.id)                                     // 没有活跃内核会话 = 当前没在被用
      && (
        // idle 且超 3 天没活跃 → 常规保活续期
        (a.status === 'idle' && (now - (a.lastAliveAt || 0)) > ALIVE_THRESHOLD_MS)
        // login_required → 每轮都复验(误标自愈)。runner 预检单次误判(慢代理/导航失败/CDP 抖动)
        // 标红后,原来没有任何机制再查一遍 → 好号永久红(用户实测「好多号显示过期、点开却登录着」)。
        // 复验成功走 markAccountAlive → login_required 翻回 idle;真过期的复验仍失败,保持红,无副作用。
        // ⚠️ 用户【主动断开】的号除外(manualDisconnect):cookie 已清、永远验不过,复验只会每 12h 白开窗闪屏。
        || (a.status === 'login_required' && !a.manualDisconnect)
      ),
    );
    for (const acc of due) {
      // 串行期间状态/占用可能变 → 临用前再确认一次。
      const cur = getAccount(acc.id);
      if (!cur || (cur.status !== 'idle' && cur.status !== 'login_required') || cur.manualDisconnect || getSession(acc.id)) continue;
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
    // 复验(2026-07-05,治小红书等「账号标过期、点开内核页面却登录着」的误报):headless 下部分平台
    // 会被风控降级当游客(如小红书 /me 返回 guest)→ 单次「未登录」不可信。换【可见后台窗】重开重验,
    // 仍未登录才标 login_required —— 宁可这轮漏标(保持 idle,下轮再查),绝不误杀登录着的好号。
    if (!ok) {
      try { closeKernel(acc.id); } catch { /* ignore */ }
      launched = false; // 已关;下面重开若失败(kernelPool 已回退计数/锁),finally 不能再 closeKernel(会错放别的流程)
      try {
        await launchKernel({
          accountId: acc.id, kernelVersion: acc.kernelVersion, userDataDir: acc.userDataDir,
          fingerprint: acc.fingerprint, proxy: acc.proxy, groupTitle: accountBadgeLabel(acc),
        });
        launched = true;
        if (home) { try { await kernelNavigate(acc.id, home); } catch { /* ignore */ } }
        await sleep(6000);
        try { ok = await checkKernelLogin(acc.id, pk); } catch { ok = true; }
      } catch { ok = true; } // 复验开窗失败 → 不标过期(维持 idle)
    }
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

/** 启动主动保活调度:立即扫一遍 + 每 12h 扫一遍。重复调用只生效一次。 */
export function startKeepAliveScheduler(): void {
  if (scheduled) return;
  scheduled = true;
  void runKeepAliveSweep();
  setInterval(() => { void runKeepAliveSweep(); }, SCAN_INTERVAL_MS);
}
