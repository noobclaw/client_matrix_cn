/**
 * NoobClaw Sidecar Server — HTTP + SSE server for Tauri mode.
 * Replaces Electron IPC with HTTP API + Server-Sent Events.
 *
 * Architecture:
 * - Tauri WebView ←→ HTTP/SSE ←→ This server ←→ CoworkRunner ←→ AI APIs
 * - No Electron dependency. Uses platformAdapter for OS integration.
 */

import http from 'http';
import path from 'path';
import { ensureDataDirs, getUserDataPath } from './libs/platformAdapter';
import { coworkLog } from './libs/coworkLogger';
// v5.x+: statically imported so attachBrowserBridge + server.listen can
// run at module-load time, BEFORE getRunner()'s 4 awaits (~200-1000ms
// on cold disk). Browser-bridge module has no Electron deps that load
// synchronously — its electron require is gated behind isElectronMode()
// and wrapped in try/catch, so importing it in sidecar/Tauri mode is safe.
import { attachBrowserBridge, cleanupLegacyNmResidueOnce } from './libs/browserBridge';
import { MATRIX_EDITION } from './matrixEdition';

// Top-level crash handlers — without these, a synchronous throw during
// module init (e.g. sql.js failing to load WASM, or a bad require()) kills
// the sidecar with an opaque stack trace that Tauri's stderr capture may
// miss or truncate. Emit a clearly-marked line so the Rust side's
// sidecar.log capture always contains something actionable on the final
// output before the process exits.
process.on('uncaughtException', (err) => {
  try {
    console.error('[sidecar] uncaughtException:', err?.stack || err);
  } catch {}
  // Exit with a distinctive code so the Rust side's Terminated event
  // logs it and we can distinguish a crash from a clean shutdown.
  process.exit(91);
});
process.on('unhandledRejection', (reason) => {
  try {
    console.error('[sidecar] unhandledRejection:', reason);
  } catch {}
});

// ── Native Messaging residual-spawn guard (v2.8) ────────────────────────
// NM transport was removed. If a leftover registry entry from a pre-v2.8
// install causes a browser to spawn us with `--native-messaging-host`, exit
// cleanly so we don't double-bind 18801 with the main sidecar process. The
// main sidecar runs cleanupLegacyNmResidueOnce() on startup to remove the
// stale registry / .bat residue, so this guard becomes vacuous within one
// boot cycle of upgrading.
if (process.argv.slice(1).some((a) => a === '--native-messaging-host')) {
  try { process.stderr.write('[sidecar] --native-messaging-host invoked but NM is removed in v2.8; exiting\n'); } catch {}
  process.exit(0);
}
// Legacy flag retained as a permanently-false constant so the few
// `if (!IS_NATIVE_MESSAGING_HOST) { ... }` guards scattered below compile
// without further surgery. The guarded branches are now always taken.
const IS_NATIVE_MESSAGING_HOST = false;

// Ensure directories exist before anything else
ensureDataDirs();

// Workaround: pkg binary on macOS may fail SSL cert validation.
// Node.js bundled in pkg doesn't always find the system CA store.
if (process.platform === 'darwin' && !process.env.NODE_EXTRA_CA_CERTS) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // Allow self-signed certs as fallback
  // TODO: Use proper CA certs from macOS keychain
}

// Pick the first bare numeric argv token as the port. Flags like
// --tauri-pid=12345 are skipped so argv order doesn't matter.
const portArg = process.argv.slice(2).find((a) => /^\d+$/.test(a));
const PORT = parseInt(portArg || '18801', 10);

// ── Sleep/wake wiring (macOS NSWorkspace / Windows PowerRegisterSuspendResumeNotification) ─
// On willSleep we ask the CoworkRunner to pause every active session
// (saves context to SQLite, closes outbound HTTP connections) so the
// system suspend doesn't leave us with half-streamed SSE responses
// stranded on a dead TCP socket. On didWake we broadcast a signal so
// the renderer can show a "resumed from sleep" toast and we auto-resume
// the previously running sessions with a 5-second delay for the network
// to settle.
//
// Session ids that were running when the system went to sleep. Refilled
// on willSleep, drained on didWake where we kick off auto-resume.
// Declared at module scope so both branches of the power-event callback
// share the same list.
let pausedForSleep: string[] = [];

function handlePowerEvent(kind: 'willSleep' | 'didWake') {
  coworkLog('INFO', 'sidecar-server', `Power event: ${kind}`);
  if (kind === 'willSleep') {
    if (runnerInstance) {
      try {
        const running = runnerInstance.store
          .listSessions()
          .filter((s: any) => s.status === 'running');
        pausedForSleep = running.map((s: any) => s.id);
        for (const s of running) {
          try {
            runnerInstance.stopSession(s.id);
            runnerInstance.store.updateSession(s.id, { status: 'idle' });
          } catch (e) {
            coworkLog('WARN', 'sidecar-server', `Failed to pause session ${s.id}: ${e}`);
          }
        }
        coworkLog('INFO', 'sidecar-server', `Paused ${running.length} active session(s) before sleep`, {
          sessionIds: pausedForSleep,
        });
      } catch (e) {
        coworkLog('WARN', 'sidecar-server', `Pause-on-sleep enumeration failed: ${e}`);
      }
    }
    broadcastSSE('system:will-sleep', {});
  } else if (kind === 'didWake') {
    // Auto-resume the sessions we stopped at sleep time. We wait a
    // few seconds after wake for network + file system + the renderer
    // IPC to settle, otherwise resumed turns may hit "connection
    // refused" on their first API call.
    const toResume = pausedForSleep.slice();
    pausedForSleep = [];
    broadcastSSE('system:did-wake', { willResumeCount: toResume.length });
    if (toResume.length > 0 && runnerInstance) {
      setTimeout(async () => {
        for (const sid of toResume) {
          try {
            const session = runnerInstance.store.getSession(sid);
            if (!session) continue;
            const lastUser = [...session.messages]
              .reverse()
              .find((m: any) => m.type === 'user');
            const resumePrompt = lastUser?.content
              || '[System] Session resumed after sleep — continue where you left off.';
            coworkLog('INFO', 'sidecar-server', 'Resuming session after wake', { sessionId: sid });
            runnerInstance
              .continueSession(sid, resumePrompt)
              .catch((e: unknown) => {
                coworkLog('WARN', 'sidecar-server', `Resume failed for ${sid}: ${e}`);
              });
          } catch (e) {
            coworkLog('WARN', 'sidecar-server', `Resume enumeration failed: ${e}`);
          }
        }
      }, 5000);
    }
  }
}

if (process.platform === 'darwin' && !IS_NATIVE_MESSAGING_HOST) {
  // Lazy import so non-macOS builds don't pull in the addon bridge.
  setImmediate(async () => {
    try {
      const { nativeOnPowerEvent } = await import('./libs/nativeDesktopMac');
      nativeOnPowerEvent(handlePowerEvent);
      coworkLog('INFO', 'sidecar-server', 'Sleep/wake listener installed (macOS)');
    } catch (e) {
      coworkLog('WARN', 'sidecar-server', `Sleep/wake listener install failed: ${e}`);
    }
  });
} else if (process.platform === 'win32' && !IS_NATIVE_MESSAGING_HOST) {
  // Windows: uses PowerRegisterSuspendResumeNotification via the native
  // .node addon in native/win-desktop/. If the addon didn't ship with
  // this build (older binary, rebuild pending), nativeWinOnPowerEvent
  // returns false and we simply skip — the sidecar still works, just
  // without the pause/resume dance around system sleep.
  setImmediate(async () => {
    try {
      const { nativeWinOnPowerEvent } = await import('./libs/nativeDesktopWin');
      const ok = nativeWinOnPowerEvent(handlePowerEvent);
      if (ok) {
        coworkLog('INFO', 'sidecar-server', 'Sleep/wake listener installed (Windows)');
      } else {
        coworkLog('INFO', 'sidecar-server', 'Windows sleep/wake addon not available, skipping');
      }
    } catch (e) {
      coworkLog('WARN', 'sidecar-server', `Sleep/wake listener install failed: ${e}`);
    }
  });
}

// ── SSE Client Management ──

const sseClients = new Set<http.ServerResponse>();
// 运行中的视频任务注册表(taskId → AbortController),供「停止」中断 pipeline + kill 子进程。
// 对齐 Electron main.ts 的 activeVideoRuns;Tauri 下视频跑在 sidecar,停止必须在这里 abort。
const activeVideoRuns = new Map<string, AbortController>();
// 扫码连接的后台轮询去重(accountId):重复点「扫码连接」不再叠加轮询/引用计数(对齐 reloginPrompt 的 watching)。
const matrixScanWatching = new Set<string>();

// 矩阵号运行锁:按【平台】并发(参照老客户端 scenarioManager 的 runningByResource 按资源并发)——
// 不同平台的任务可同时跑(各平台账号是独立指纹内核,互不冲突);同一平台同时只跑一个。封顶防开爆内核。
const MATRIX_MAX_CONCURRENT = 3;
const runningPlatforms = new Set<string>();                 // 正在跑的平台集合(并发锁的键)
const abortByPlatform = new Map<string, AbortController>();  // 各平台的停止句柄(matrix:stopTask 用)
const runAccountsByPlatform = new Map<string, string[]>();  // 各平台正在跑的账号(停某平台时强关这些号的窗口,立即止损)
const anyMatrixRunning = (): boolean => runningPlatforms.size > 0;

// 实时进度(供 matrix:getRunProgress 轮询 → 适配成 ScenarioRunProgress 给真 TaskDetailPage)。
// 老 scenario 进度面板是「轮询」不是 SSE,所以这里把运行态聚合存成模块变量;N 账号求和。
interface MatrixLiveProgress {
  taskId: string;
  status: 'running' | 'done' | 'error';
  startedAt: number;
  targets: { like: number; follow: number; comment: number };
  done: { like: number; follow: number; comment: number };
  // 本次运行累计扣费(各账号实际扣费之和):credits=积分(钱包真实扣的),usd=按 token_price_per_million 算好的美元。
  cost: { credits: number; usd: number };
  perAccountTargets: Record<string, { like: number; follow: number; comment: number }>;
  // 每个账号独立进度(详情页可切换查看):各号目标/完成/状态/日志/扣费互不影响。
  perAccount: Record<string, { displayName: string; status: string; targets: { like: number; follow: number; comment: number }; done: { like: number; follow: number; comment: number }; cost: { credits: number; usd: number }; logs: Array<{ ts: number; msg: string }> }>;
  logs: Array<{ ts: number; accountId: string; msg: string }>;
  error?: string;
}
// 实时进度按【任务】隔离:并发跑多个任务时各自进度互不覆盖。getRunProgress(taskId) 取对应那条。
const liveProgressByTask = new Map<string, MatrixLiveProgress>();

function broadcastSSE(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { sseClients.delete(client); }
  }
}

// 让 accountManager.setAccountStatus 变更时也能广播 'matrix:account'(否则任务里标 login_required 只落盘,
// 开着的「我的矩阵账号」页不刷新)。动态 import 避免与 accountManager 循环依赖;启动时注册一次即可。
void import('./libs/matrix/accountManager').then((m) => m.setAccountSSEBroadcast?.(broadcastSSE)).catch(() => { /* ignore */ });

// 矩阵任务运行(手动 IPC 与定时调度共用,保证「全局同时只跑一个」+ 进度 SSE 一致)。
async function runMatrixTaskById(taskId: string, kernelPath?: string): Promise<{ ok: boolean; error?: string }> {
  // 按【平台】并发:先取任务拿平台,再做「同平台已在跑?」+「并发已满?」检查;check→add 之间无 await(原子占锁,杜绝双跑)。
  const { getTask, setTaskLastRun } = await import('./libs/matrix/taskStore');
  const task = getTask(taskId);
  if (!task) return { ok: false, error: 'task_not_found' };
  // engage(互动涨粉)+ reply_fan(自动回复粉丝评论)都由 engageRunner 跑(共用内核/登录/进度链路,
  // 仅剧本与 task 字段不同)。其它类型未支持。
  if (task.type !== 'engage' && task.type !== 'reply_fan' && task.type !== 'video_download' && task.type !== 'image_text' && task.type !== 'viral_rewrite' && task.type !== 'x_post' && task.type !== 'binance_post' && task.type !== 'binance_repost' && task.type !== 'facebook_post' && task.type !== 'reddit_post' && task.type !== 'instagram_post') return { ok: false, error: 'unsupported_task_type' };
  const platform = task.platform;
  if (runningPlatforms.has(platform)) return { ok: false, error: 'another_task_running' };       // 同平台已在跑
  if (runningPlatforms.size >= MATRIX_MAX_CONCURRENT) return { ok: false, error: 'concurrency_full' }; // 并发已满
  runningPlatforms.add(platform);
  // 供 stopTask 强关本平台窗口。binance_repost 还要带上采集号(在源平台,跨平台窗口)一起强关。
  const forceCloseIds = [...(task.accountIds || [])];
  if (task.type === 'binance_repost' && task.binanceRepost?.sourceAccountId) forceCloseIds.push(task.binanceRepost.sourceAccountId);
  runAccountsByPlatform.set(platform, forceCloseIds);
  const abort = new AbortController();
  abortByPlatform.set(platform, abort);
  const release = () => { runningPlatforms.delete(platform); abortByPlatform.delete(platform); runAccountsByPlatform.delete(platform); };
  try {
    const { runEngageTask } = await import('./libs/matrix/engageRunner');
    const { runImageTextTask } = await import('./libs/matrix/imageTextRunner');
    const { runViralRewriteTask } = await import('./libs/matrix/viralRewriteRunner');
    const { runTweetPostTask } = await import('./libs/matrix/tweetPostRunner');
    const { runBinancePostTask } = await import('./libs/matrix/binancePostRunner');
    const { runBinanceRepostTask } = await import('./libs/matrix/binanceRepostRunner');
    const { addRun } = await import('./libs/matrix/runStore');
    const { getAccount, loadAccounts } = await import('./libs/matrix/accountManager');
    const { getPlanLimit, allowedAccountIds } = await import('./libs/matrix/planLimit');
    const startedAt = Date.now();
    const collected = new Map<string, any>(); // 每号最后一条结果(用于运行记录)
    const planLimit = getPlanLimit();
    const platformAccts = loadAccounts().filter((a) => a.platform === platform);
    // 只保留【当前平台真实存在】的号:删号后 tasks.json 里可能残留已删账号 id(removeAccount
    //   过去不回改 task.accountIds),这些幽灵 id 在账号库查不到 → getAccount 返回 null,以前会
    //   被当「超额号」暂停,UI 冒出一个不存在的号(displayName 回退成 id,如 douyin_xxx_yyy)还
    //   报「超出会员号数」误导用户。在源头剔除,不显示也不判暂停;suspendedIds 就只剩真正超档的真号。
    const validIds = new Set(platformAccts.map((a) => a.id));
    const accIds: string[] = (task.accountIds || []).filter((id) => validIds.has(id));
    // 会员号数墙:按当前生效档位上限,本平台只跑【最早绑定的前 N 个】号;超额号(会员到期/降级后
    //   多出来的)暂停跳过——数据不删,续费/升级即恢复。limit 由渲染进程从 /api/ai/balance 推下来
    //   (planLimit store);从未推送 → 默认很大 → 不暂停任何号(宁可不拦绝不误杀)。
    const allowSet = allowedAccountIds(platformAccts, planLimit.maxAccountsPerPlatform);
    const runIds: string[] = accIds.filter((id) => allowSet.has(id));
    const suspendedIds: string[] = accIds.filter((id) => !allowSet.has(id));
    const accN = runIds.length || 1;
    const q: any = task.quota || {};
    const zero = () => ({ like: 0, follow: 0, comment: 0 });
    const perAccount: MatrixLiveProgress['perAccount'] = {};
    for (const aid of accIds) {
      const suspended = suspendedIds.includes(aid);
      perAccount[aid] = {
        displayName: getAccount(aid)?.displayName || aid,
        status: suspended ? 'skipped' : 'running',
        targets: { like: q.daily_like_max || 0, follow: q.daily_follow_max || 0, comment: q.daily_comment_max || 0 },
        done: zero(), cost: { credits: 0, usd: 0 }, logs: [],
      };
    }
    // 本任务独立进度(并发时各任务互不覆盖),存进 liveProgressByTask[taskId]。
    const live: MatrixLiveProgress = {
      taskId: task.id, status: 'running', startedAt,
      targets: { like: (q.daily_like_max || 0) * accN, follow: (q.daily_follow_max || 0) * accN, comment: (q.daily_comment_max || 0) * accN },
      done: zero(),
      cost: { credits: 0, usd: 0 },
      perAccountTargets: {}, perAccount, logs: [],
    };
    liveProgressByTask.set(task.id, live);
    const pushLog = (accountId: string, msg: string) => {
      live.logs.push({ ts: Date.now(), accountId, msg });
      if (live.logs.length > 400) live.logs.splice(0, live.logs.length - 400);
      const pa = live.perAccount[accountId];
      if (pa) { pa.logs.push({ ts: Date.now(), msg }); if (pa.logs.length > 200) pa.logs.splice(0, pa.logs.length - 200); }
    };
    const recomputeTargets = () => {
      const pa = live.perAccountTargets;
      if (!Object.keys(pa).length) return;
      const sum = zero();
      for (const t of Object.values(pa)) { sum.like += t.like || 0; sum.follow += t.follow || 0; sum.comment += t.comment || 0; }
      live.targets = sum;
    };
    broadcastSSE('matrix:progress', { type: 'taskStart', taskId: task.id });
    // reply_fan 走专属剧本(*_reply_fans_comment),不要关键词、带引流尾巴;video_download 走 *_video_download
    // 剧本(单账号、粘贴链接逐个下载);image_text 走【独立 runner】imageTextRunner(N 号各自生成图文+发布);
    // engage 走平台互动剧本。
    const isReplyFan = task.type === 'reply_fan';
    const isVideoDownload = task.type === 'video_download';
    const isImageText = task.type === 'image_text';
    const isViralRewrite = task.type === 'viral_rewrite';
    const isTweetPost = task.type === 'x_post';
    const isBinancePost = task.type === 'binance_post';
    const isFacebookPost = task.type === 'facebook_post';
    const isRedditPost = task.type === 'reddit_post';
    const isInstagramPost = task.type === 'instagram_post';
    const isBinanceRepost = task.type === 'binance_repost';
    // 三个进度回调:image_text 与 engage 共用同款签名(EngageItemResult / EngageReport),闭包零改动复用。
    const cbOnLog = (accountId: string, msg: string) => { pushLog(accountId, msg); broadcastSSE('matrix:progress', { type: 'log', accountId, msg, taskId: task.id }); };
    const cbOnTargets = (accountId: string, t: { like?: number; follow?: number; comment?: number }) => {
      const tg = { like: t.like || 0, follow: t.follow || 0, comment: t.comment || 0 };
      live.perAccountTargets[accountId] = tg;
      if (live.perAccount[accountId]) live.perAccount[accountId].targets = tg; // 该号真实随机配额覆盖兜底
      recomputeTargets();
    };
    // 运行中余额不足 → 弹窗信号(含定时任务:调度也走本 run 块)。runner 命中 402 会把
    //   '余额不足…' 写进 item.reason 或让整个任务 reject → 这里一次性广播,renderer 弹充值/续费
    //   弹窗,用户不必盯着流式日志才知道该充值。每次运行只播一次(避免多号刷屏)。
    let insufficientNotified = false;
    const INSUFFICIENT_RE = /余额不足|insufficient|INSUFFICIENT_TOKENS|积分.*不足/i;
    const notifyInsufficient = (why: unknown) => {
      if (insufficientNotified) return;
      if (!INSUFFICIENT_RE.test(String(why ?? ''))) return;
      insufficientNotified = true;
      broadcastSSE('noobclaw:token-insufficient', { taskId: task.id, source: 'matrix-run' });
    };
    const cbOnItem = (item: any) => {
        collected.set(item.accountId, item);
        notifyInsufficient(item?.reason);
        // 聚合 done = 各号最新累计 counts 之和;聚合 cost = 各号最新累计扣费之和(每号是到目前的累计,直接相加不重复)。
        const sum = zero();
        const costSum = { credits: 0, usd: 0 };
        for (const it of collected.values()) {
          sum.like += it.counts?.like || 0; sum.follow += it.counts?.follow || 0; sum.comment += it.counts?.comment || 0;
          costSum.credits += it.chargedCredits || 0; costSum.usd += it.chargedUsd || 0;
        }
        live.done = sum;
        live.cost = costSum;
        const pa = live.perAccount[item.accountId];
        if (pa) {
          if (item.counts) pa.done = { like: item.counts.like || 0, follow: item.counts.follow || 0, comment: item.counts.comment || 0 };
          pa.cost = { credits: item.chargedCredits || 0, usd: item.chargedUsd || 0 };
        }
        broadcastSSE('matrix:progress', { type: 'item', accountId: item.accountId, state: item.state, reason: item.reason, counts: item.counts, chargedCredits: item.chargedCredits, chargedUsd: item.chargedUsd, taskId: task.id });
    };

    // 启动瞬间就给反馈 —— 各 runner 内每号会先「错峰等待」3-15s、再花几秒启动指纹浏览器,
    //   这段时间一行日志都没有,用户以为卡死。任务一开始立刻给每个号播一条「排队中」日志,
    //   并解释为什么有延迟。所有任务类型(engage/reply_fan/image_text/viral/x_post/binance_post)
    //   都经过这里,单点覆盖,无需改各 runner。
    for (const aid of runIds) {
      cbOnLog(aid, '⏳ 已加入运行队列,正在启动指纹浏览器…(为防多窗同时打开被风控,各账号错峰启动,首个最长约 15 秒,请稍候)');
    }
    // 超额号:播一条暂停说明 + 立刻广播 skipped item,让 UI 与运行记录都体现「会员到期已暂停」。
    for (const aid of suspendedIds) {
      cbOnLog(aid, '⏸️ 已暂停:超出当前会员可用号数(会员到期/降级后多出的账号)。续费或升级会员即可恢复;数据与任务均已保留。');
      cbOnItem({ accountId: aid, state: 'skipped', reason: 'plan_limit_suspended', counts: zero(), chargedCredits: 0, chargedUsd: 0 });
    }

    const runP: Promise<any> = isBinanceRepost
      ? runBinanceRepostTask({
          platform: task.platform, taskId: task.id, accountIds: runIds, config: task.binanceRepost as any,
          concurrency: task.concurrency, kernelPath, signal: abort.signal,
          onLog: cbOnLog, onTargets: cbOnTargets, onItem: cbOnItem,
        })
      : isBinancePost
      ? runBinancePostTask({
          platform: task.platform, taskId: task.id, accountIds: runIds, config: task.binancePost as any,
          concurrency: task.concurrency, kernelPath, signal: abort.signal,
          onLog: cbOnLog, onTargets: cbOnTargets, onItem: cbOnItem,
        })
      : isFacebookPost
      ? runBinancePostTask({
          platform: task.platform, taskId: task.id, accountIds: runIds, config: task.facebookPost as any,
          concurrency: task.concurrency, kernelPath, signal: abort.signal,
          onLog: cbOnLog, onTargets: cbOnTargets, onItem: cbOnItem,
        })
      : isRedditPost
      ? runBinancePostTask({
          platform: task.platform, taskId: task.id, accountIds: runIds, config: task.redditPost as any,
          concurrency: task.concurrency, kernelPath, signal: abort.signal,
          onLog: cbOnLog, onTargets: cbOnTargets, onItem: cbOnItem,
        })
      : isInstagramPost
      ? runBinancePostTask({
          platform: task.platform, taskId: task.id, accountIds: runIds, config: task.instagramPost as any,
          concurrency: task.concurrency, kernelPath, signal: abort.signal,
          onLog: cbOnLog, onTargets: cbOnTargets, onItem: cbOnItem,
        })
      : isTweetPost
      ? runTweetPostTask({
          platform: task.platform, taskId: task.id, accountIds: runIds, config: task.tweetPost as any,
          concurrency: task.concurrency, kernelPath, signal: abort.signal,
          onLog: cbOnLog, onTargets: cbOnTargets, onItem: cbOnItem,
        })
      : isViralRewrite
      ? runViralRewriteTask({
          platform: task.platform, taskId: task.id, accountIds: runIds, config: task.viralRewrite as any,
          concurrency: task.concurrency, kernelPath, signal: abort.signal,
          onLog: cbOnLog, onTargets: cbOnTargets, onItem: cbOnItem,
        })
      : isImageText
      ? runImageTextTask({
          platform: task.platform, taskId: task.id, accountIds: runIds, config: task.imageText as any,
          concurrency: task.concurrency, kernelPath, signal: abort.signal,
          onLog: cbOnLog, onTargets: cbOnTargets, onItem: cbOnItem,
        })
      : runEngageTask({
          platform: task.platform, taskId: task.id, accountIds: runIds, quota: task.quota, concurrency: task.concurrency, kernelPath, signal: abort.signal,
          taskType: task.type as any,
          scenarioId: isReplyFan ? `${task.platform}_reply_fans_comment` : isVideoDownload ? `${task.platform}_video_download` : undefined,
          // 引流尾巴配置:reply_fan(回复粉丝)+ engage(互动评论)都带上。
          // engage 由客户端 makeAiCall 对 comment_composer 输出按概率融入;reply_fan 走后端剧本。
          // 老任务没配 funnel → undefined → 两条路径都视作未填,行为不变(向后兼容)。
          funnel: task.funnel,
          urls: isVideoDownload ? task.urls : undefined,
          onLog: cbOnLog, onTargets: cbOnTargets, onItem: cbOnItem,
        });
    runP.then((report) => {
      for (const it of (report?.items || [])) { const pa = live.perAccount[it.accountId]; if (pa) pa.status = it.state; }
      live.status = 'done';
      setTaskLastRun(task.id, Date.now());
      // 存运行记录(供「矩阵涨粉运行记录」页)
      try {
        const items = Array.from(collected.values()).map((it: any) => ({ accountId: it.accountId, displayName: getAccount(it.accountId)?.displayName, state: it.state, reason: it.reason, counts: it.counts, chargedCredits: it.chargedCredits, chargedUsd: it.chargedUsd }));
        const totals: any = items.reduce((acc, it: any) => ({ like: acc.like + (it.counts?.like || 0), follow: acc.follow + (it.counts?.follow || 0), comment: acc.comment + (it.counts?.comment || 0) }), { like: 0, follow: 0, comment: 0 });
        // 非互动任务的完成维度:图文创作累计「发帖数」、视频下载累计「下载条数」。只给对应 type 加键,
        // 不污染 engage(否则累计/上次完成会多出 📤0/⬇️0)。
        if (isImageText || isTweetPost || isBinancePost || isFacebookPost || isRedditPost || isInstagramPost || isBinanceRepost) totals.post = items.reduce((s, it: any) => s + (it.counts?.post || 0), 0);
        if (isVideoDownload) totals.download = items.reduce((s, it: any) => s + (it.counts?.download || 0), 0);
        const cost = items.reduce((acc, it: any) => ({ credits: acc.credits + (it.chargedCredits || 0), usd: acc.usd + (it.chargedUsd || 0) }), { credits: 0, usd: 0 });
        addRun({ taskId: task.id, taskName: task.name, platform: task.platform, type: task.type, startedAt, finishedAt: Date.now(), success: report?.success ?? 0, failed: report?.failed ?? 0, skipped: report?.skipped ?? 0, totals, cost, items });
      } catch (e) { coworkLog('WARN', 'sidecar-server', 'addRun failed', { err: String(e) }); }
      broadcastSSE('matrix:progress', { type: 'done', report, taskId: task.id });
    })
      .catch((e: any) => { live.status = 'error'; live.error = e?.message || String(e); notifyInsufficient(e?.message || String(e)); broadcastSSE('matrix:progress', { type: 'error', error: e?.message || String(e), taskId: task.id }); })
      .finally(() => { release(); });
    return { ok: true };
  } catch (e: any) {
    release();
    return { ok: false, error: e?.message || String(e) };
  }
}

// 矩阵定时调度:跑在 sidecar(app 开着即在,切到别的页面也不停),对齐老客户端 60s tick。
// 全局同时只跑一个;到点的取最早的一个跑。AI/计费 token 在 engageRunner 内回落 getNoobClawAuthToken。
function startMatrixScheduler(): void {
  setInterval(async () => {
    try {
      const { dueTasks } = await import('./libs/matrix/taskStore');
      const due = dueTasks(Date.now());
      if (!due.length) return;
      // 没装指纹浏览器内核 → 定时任务【不跑】(否则每分钟空转 + 每号失败 + 报错刷屏);
      // 用户进「我的矩阵账号」会被提示下载,装好后下个 tick 自然恢复。
      const { installedKernelPath } = await import('./libs/matrix/kernelInstaller');
      if (!installedKernelPath()) return;
      due.sort((a, b) => (a.nextPlannedRunAt || 0) - (b.nextPlannedRunAt || 0));
      // 按平台并发:每个【平台空闲】的到点任务都起一个(runMatrixTaskById 内部再做原子占锁 + 封顶,races 也安全)。
      for (const t of due) {
        if (runningPlatforms.size >= MATRIX_MAX_CONCURRENT) break;
        if (runningPlatforms.has(t.platform)) continue;
        await runMatrixTaskById(t.id);
      }
    } catch (e) { coworkLog('WARN', 'sidecar-server', 'matrix scheduler tick failed', { err: String(e) }); }
  }, 60_000);
}

// ── CoworkRunner Integration (lazy loaded to avoid Electron imports at module level) ──

let runnerInstance: any = null;

async function getRunner() {
  if (runnerInstance) return runnerInstance;

  // Dynamic import to avoid top-level Electron dependencies
  try {
    const { CoworkRunner } = await import('./libs/coworkRunner');
    const { CoworkStore } = await import('./coworkStore');
    const { SqliteStore } = await import('./sqliteStore');

    // Initialize SQLite store (loads existing DB from disk if available)
    const sqliteStore = await SqliteStore.create(getUserDataPath());
    const store = new CoworkStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());

    // Wire up claudeSettings store getter so API config resolution works
    const { setStoreGetter } = await import('./libs/claudeSettings');
    setStoreGetter(() => sqliteStore);
    // v6.x: also wire engage_history dedup so headless sidecar runs (CI /
    // automated agents) benefit from the same dedup as the desktop app.
    // news_usage is not wired here because the writing scenarios that use
    // it currently never run sidecar-side.
    const { setStoreGetter: setEngageHistoryStoreGetter } = await import('./libs/scenario/engageHistoryStore');
    setEngageHistoryStoreGetter(() => sqliteStore);

    runnerInstance = new CoworkRunner(store);
    // Expose sqliteStore for KV operations (store:get/set)
    (runnerInstance as any)._sqliteStore = sqliteStore;

    // Wire events to SSE broadcasts
    runnerInstance.on('message', (sessionId: string, message: any) => {
      broadcastSSE('cowork:stream:message', { sessionId, message });
    });
    runnerInstance.on('messageUpdate', (sessionId: string, messageId: string, content: string) => {
      broadcastSSE('cowork:stream:messageUpdate', { sessionId, messageId, content });
    });
    runnerInstance.on('messageMetadata', (sessionId: string, messageId: string, metadata: Record<string, unknown>) => {
      broadcastSSE('cowork:stream:messageMetadata', { sessionId, messageId, metadata });
    });
    runnerInstance.on('stuck', (sessionId: string, detail: { idleMs: number }) => {
      broadcastSSE('cowork:stream:stuck', { sessionId, ...detail });
    });
    runnerInstance.on('permissionRequest', (sessionId: string, request: any) => {
      broadcastSSE('cowork:stream:permission', { sessionId, request });
    });
    runnerInstance.on('complete', (sessionId: string) => {
      broadcastSSE('cowork:stream:complete', { sessionId });
    });
    runnerInstance.on('error', (sessionId: string, error: string) => {
      broadcastSSE('cowork:stream:error', { sessionId, error });
    });

    // Register extension prompt callback — broadcasts SSE to frontend for user decision.
    // v5.x+: attachBrowserBridge + server.listen moved to module-level
    // (right after createServer at the bottom of this file) so the WS
    // upgrade handler is live the instant sidecar boots, NOT after these
    // four awaits. Only the prompt callback hook stays here because it
    // needs broadcastSSE to be defined and is fine being late.
    try {
      const { setExtensionPromptCallback } = await import('./libs/browserBridge');
      setExtensionPromptCallback(async (opts) => {
        return new Promise<'install' | 'cancel'>((resolve) => {
          const requestId = `ext-${Date.now()}`;
          broadcastSSE('extension:install-prompt', { requestId, ...opts });
          // Wait for frontend response or timeout
          const timer = setTimeout(() => resolve('install'), 60000);
          extensionPromptResolvers.set(requestId, (result: string) => {
            clearTimeout(timer);
            resolve(result === 'cancel' ? 'cancel' : 'install');
          });
        });
      });

      coworkLog('INFO', 'sidecar-server', 'Browser bridge started');
    } catch (e: any) {
      coworkLog('WARN', 'sidecar-server', `Browser bridge failed: ${e.message}`);
    }

    coworkLog('INFO', 'sidecar-server', 'CoworkRunner initialized');

    // Start OpenAI compatibility proxy AFTER returning runner (non-blocking)
    // This prevents the proxy startup from blocking the entire init chain
    setImmediate(async () => {
      try {
        console.log('[sidecar] Starting OpenAI compat proxy...');
        const { startCoworkOpenAICompatProxy, getCoworkOpenAICompatProxyStatus, setSSEBroadcast } = await import('./libs/coworkOpenAICompatProxy');
        // Register SSE broadcast callback (avoids circular import)
        setSSEBroadcast(broadcastSSE);
        await startCoworkOpenAICompatProxy();
        const status = getCoworkOpenAICompatProxyStatus();
        console.log(`[sidecar] OpenAI compat proxy started: running=${status.running}, baseURL=${status.baseURL}`);
      } catch (e: any) {
        console.error(`[sidecar] OpenAI compat proxy failed: ${e.message || e}`);
      }
    });
    return runnerInstance;
  } catch (e: any) {
    console.error('[sidecar] FATAL: Failed to init CoworkRunner:', e?.message || e, e?.stack || '');
    coworkLog('ERROR', 'sidecar-server', `Failed to init CoworkRunner: ${e}`);
    return null;
  }
}

// ── Extension prompt resolvers (for browser extension install dialog) ──
const extensionPromptResolvers = new Map<string, (result: string) => void>();

// ── SkillManager (lazy loaded) ──

let skillManagerInstance: any = null;

async function getSkillManagerInstance(): Promise<any> {
  if (skillManagerInstance) return skillManagerInstance;
  try {
    const runner = await getRunner();
    if (!runner?._sqliteStore) return null;
    const { SkillManager } = await import('./skillManager');
    const sqlStore = runner._sqliteStore;
    skillManagerInstance = new SkillManager(() => sqlStore);
    // Copy bundled skills to userData on first run
    try { skillManagerInstance.syncBundledSkillsToUserData(); } catch (e) { console.warn('[sidecar] syncBundledSkills failed:', e); }
    coworkLog('INFO', 'sidecar-server', `SkillManager initialized, skills: ${skillManagerInstance.listSkills()?.length ?? 0}`);
    return skillManagerInstance;
  } catch (e) {
    coworkLog('WARN', 'sidecar-server', `SkillManager init failed: ${e}`);
    return null;
  }
}

// ── McpStore (lazy loaded) ──

let mcpStoreInstance: any = null;

async function getMcpStoreInstance(): Promise<any> {
  if (mcpStoreInstance) return mcpStoreInstance;
  try {
    const runner = await getRunner();
    if (!runner?._sqliteStore) return null;
    const { McpStore } = await import('./mcpStore');
    const db = runner._sqliteStore.getDatabase();
    const saveFn = runner._sqliteStore.getSaveFunction();
    mcpStoreInstance = new McpStore(db, saveFn);
    return mcpStoreInstance;
  } catch (e) {
    coworkLog('WARN', 'sidecar', `McpStore init failed: ${e}`);
    return null;
  }
}

// ── ScheduledTaskStore + Scheduler (lazy loaded) ──

let scheduledTaskStoreInstance: any = null;
let schedulerInstance: any = null;

async function getScheduledTaskStoreInstance(): Promise<any> {
  if (scheduledTaskStoreInstance) return scheduledTaskStoreInstance;
  try {
    const runner = await getRunner();
    if (!runner?._sqliteStore) return null;
    const { ScheduledTaskStore } = await import('./scheduledTaskStore');
    const db = runner._sqliteStore.getDatabase();
    const saveFn = runner._sqliteStore.getSaveFunction();
    scheduledTaskStoreInstance = new ScheduledTaskStore(db, saveFn);
    return scheduledTaskStoreInstance;
  } catch (e) {
    coworkLog('WARN', 'sidecar', `ScheduledTaskStore init failed: ${e}`);
    return null;
  }
}

async function getSchedulerInstance(): Promise<any> {
  if (MATRIX_EDITION) return null; // 矩阵 edition:不跑旧 AI 定时任务调度
  if (schedulerInstance) return schedulerInstance;
  try {
    const sts = await getScheduledTaskStoreInstance();
    const runner = await getRunner();
    if (!sts || !runner) return null;
    const { Scheduler } = await import('./libs/scheduler');
    schedulerInstance = new Scheduler({
      scheduledTaskStore: sts,
      coworkStore: runner.store,
      getCoworkRunner: () => runner,
      getIMGatewayManager: () => imGatewayManagerInstance,
      getSkillsPrompt: async () => '',
    });
    schedulerInstance.start?.();
    return schedulerInstance;
  } catch (e) {
    coworkLog('WARN', 'sidecar', `Scheduler init failed: ${e}`);
    return null;
  }
}

// ── IMGatewayManager (lazy loaded) ──

let imGatewayManagerInstance: any = null;

async function getIMGatewayManagerInstance(): Promise<any> {
  if (imGatewayManagerInstance) return imGatewayManagerInstance;
  try {
    const runner = await getRunner();
    if (!runner?._sqliteStore) return null;
    const { IMGatewayManager } = await import('./im/imGatewayManager');
    const db = runner._sqliteStore.getDatabase();
    const saveFn = runner._sqliteStore.getSaveFunction();
    imGatewayManagerInstance = new IMGatewayManager(db, saveFn, {
      coworkRunner: runner,
      coworkStore: runner.store,
    });
    // Wire IM events to SSE
    imGatewayManagerInstance.on?.('statusChange', (status: any) => broadcastSSE('im:status:change', status));
    imGatewayManagerInstance.on?.('message', (msg: any) => broadcastSSE('im:message:received', msg));

    // CRITICAL: call initialize() to wire LLM config provider and set up
    // per-gateway onMessageCallback handlers. Electron's main.ts does this
    // in main.ts:693 but sidecar-server.ts was missing the equivalent call.
    // Without it, every gateway's onMessageCallback stays undefined, so
    // handleInboundMessage() silently drops every incoming IM event at the
    // "if (this.onMessageCallback)" check — exactly why Lark bot never
    // replied even though Inbound im.message.receive_v1 appeared in the log.
    try {
      imGatewayManagerInstance.initialize({
        getLLMConfig: async () => {
          // Resolve the currently-active API config the same way cowork
          // does. We reuse claudeSettings.getCurrentApiConfig so the bot
          // uses whatever model the user has selected in Settings.
          const { getCurrentApiConfig } = await import('./libs/claudeSettings');
          const cfg = getCurrentApiConfig('local');
          if (!cfg) return null;
          return {
            apiKey: cfg.apiKey,
            baseUrl: (cfg as any).baseURL ?? (cfg as any).baseUrl ?? '',
            model: cfg.model,
            provider: (cfg as any).provider,
          };
        },
        getSkillsPrompt: async () => {
          try {
            const sm = await getSkillManagerInstance();
            return sm?.buildAutoRoutingPrompt?.() ?? null;
          } catch {
            return null;
          }
        },
      });
      coworkLog('INFO', 'sidecar-server', 'IMGatewayManager.initialize() complete — message callbacks wired');
    } catch (initErr: any) {
      coworkLog('ERROR', 'sidecar-server', `IMGatewayManager.initialize() failed: ${initErr?.message || initErr}`);
    }

    return imGatewayManagerInstance;
  } catch (e) {
    coworkLog('WARN', 'sidecar', `IMGatewayManager init failed: ${e}`);
    return null;
  }
}

// ── HTTP Server ──

const server = http.createServer(async (req, res) => {
  // v2.8: /browser-bridge/* is owned by attachBrowserBridgeSse (registered
  // as a second 'request' listener on this same server). Early-return so
  // we don't double-respond and trigger "Cannot set headers after they
  // are sent". The WS upgrade path `/browser-bridge` (no trailing slash)
  // doesn't fire 'request' events — it goes through 'upgrade' — but the
  // prefix check covers it anyway.
  if (req.url && req.url.startsWith('/browser-bridge')) return;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const pathname = url.pathname;

  try {
    // ── SSE Stream ──
    if (pathname === '/api/stream' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      sseClients.add(res);
      const heartbeat = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); } }, 30000);
      req.on('close', () => { sseClients.delete(res); clearInterval(heartbeat); });
      return;
    }

    // ── Status ──
    if (pathname === '/api/status') {
      return writeJSON(res, 200, { status: 'ok', port: PORT, mode: 'tauri-sidecar', clients: sseClients.size });
    }

    // ── Local file token-based serving ──
    // For chrome-extension to fetch large files (videos) the sidecar holds on
    // disk, bypassing native messaging IPC base64 limits. Token is registered
    // by phaseRunner via registerFile(), URL is built and passed to extension's
    // upload_file_from_url command. See libs/localFileServer.ts.
    if (pathname === '/api/local-file' && req.method === 'GET') {
      const { handleLocalFileRequest } = require('./libs/localFileServer');
      return handleLocalFileRequest(req, res, url.searchParams);
    }

    // ── Sessions ──
    if (pathname === '/api/sessions' && req.method === 'GET') {
      const runner = await getRunner();
      if (!runner) return writeJSON(res, 200, { success: true, sessions: [] });
      const sessions = runner.store.listSessions();
      return writeJSON(res, 200, { success: true, sessions });
    }

    // ── Cost / token usage (B2d) ─────────────────────────────
    if (pathname === '/api/cost/summary' && req.method === 'GET') {
      const range = (url.searchParams.get('range') || 'all') as 'today' | 'week' | 'month' | 'all';
      const runner = await getRunner();
      if (!runner) return writeJSON(res, 200, { success: false, error: 'Runner not ready' });
      try {
        const now = Date.now();
        const DAY = 24 * 60 * 60 * 1000;
        let since = 0;
        if (range === 'today') {
          const t = new Date();
          t.setHours(0, 0, 0, 0);
          since = t.getTime();
        } else if (range === 'week') {
          since = now - 7 * DAY;
        } else if (range === 'month') {
          since = now - 30 * DAY;
        }
        const summary = runner.store.getCostSummary(since);
        return writeJSON(res, 200, { success: true, range, since, summary });
      } catch (e: any) {
        return writeJSON(res, 200, { success: false, error: String(e?.message || e) });
      }
    }

    if (pathname === '/api/cost/histogram' && req.method === 'GET') {
      const days = parseInt(url.searchParams.get('days') || '14', 10);
      const runner = await getRunner();
      if (!runner) return writeJSON(res, 200, { success: false, error: 'Runner not ready' });
      try {
        const buckets = runner.store.getCostHistogramDaily(Number.isFinite(days) ? days : 14);
        return writeJSON(res, 200, { success: true, buckets });
      } catch (e: any) {
        return writeJSON(res, 200, { success: false, error: String(e?.message || e) });
      }
    }

    if (pathname === '/api/cost/session' && req.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId') || '';
      const runner = await getRunner();
      if (!runner) return writeJSON(res, 200, { success: false, error: 'Runner not ready' });
      try {
        const stats = runner.store.getSessionCost(sessionId);
        return writeJSON(res, 200, { success: true, stats });
      } catch (e: any) {
        return writeJSON(res, 200, { success: false, error: String(e?.message || e) });
      }
    }

    if (pathname === '/api/session/start' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const runner = await getRunner();
      if (!runner) return writeJSON(res, 200, { success: false, error: 'Runner not ready' });

      try {
        const config = runner.store.getConfig();
        const cwd = body.cwd || config.workingDirectory || require('os').homedir();
        const title = body.prompt?.split('\n')[0]?.slice(0, 50) || 'New Session';
        const session = runner.store.createSession(title, cwd, body.systemPrompt || config.systemPrompt || '', config.executionMode || 'local', body.activeSkillIds || []);
        runner.store.addMessage(session.id, { type: 'user', content: body.prompt, metadata: body.imageAttachments?.length ? { imageAttachments: body.imageAttachments } : undefined });
        runner.store.updateSession(session.id, { status: 'running' });

        // Start async (don't await)
        runner.startSession(session.id, body.prompt, {
          skipInitialUserMessage: true,
          systemPrompt: body.systemPrompt,
          imageAttachments: body.imageAttachments,
          skillIds: body.activeSkillIds,
          workspaceRoot: cwd,
        }).catch((e: any) => {
          coworkLog('ERROR', 'sidecar', `Session error: ${e}`);
          runner.store.updateSession(session.id, { status: 'error' });
          runner.store.addMessage(session.id, { type: 'system', content: `Error: ${e.message || e}` });
          broadcastSSE('cowork:stream:error', { sessionId: session.id, error: String(e) });
        });

        const updatedSession = runner.store.getSession(session.id) || session;
        return writeJSON(res, 200, { success: true, session: updatedSession });
      } catch (e: any) {
        return writeJSON(res, 200, { success: false, error: e.message });
      }
    }

    if (pathname === '/api/session/continue' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const runner = await getRunner();
      if (!runner) return writeJSON(res, 200, { success: false, error: 'Runner not ready' });

      try {
        runner.continueSession(body.sessionId, body.prompt, {
          systemPrompt: body.systemPrompt,
          imageAttachments: body.imageAttachments,
        }).catch((e: any) => {
          coworkLog('ERROR', 'sidecar', `Continue error: ${e}`);
          broadcastSSE('cowork:stream:error', { sessionId: body.sessionId, error: String(e) });
        });

        const session = runner.store.getSession(body.sessionId);
        return writeJSON(res, 200, { success: true, session });
      } catch (e: any) {
        return writeJSON(res, 200, { success: false, error: e.message });
      }
    }

    if (pathname === '/api/session/stop' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const runner = await getRunner();
      if (runner) {
        runner.stopSession(body.sessionId);
        runner.store.updateSession(body.sessionId, { status: 'idle' });
      }
      return writeJSON(res, 200, { success: true });
    }

    if (pathname === '/api/session/delete' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const runner = await getRunner();
      if (runner) runner.store.deleteSession(body.sessionId);
      return writeJSON(res, 200, { success: true });
    }

    // ── Permission ──
    if (pathname === '/api/permission/respond' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const runner = await getRunner();
      if (runner) runner.respondToPermission(body.requestId, body.result);
      return writeJSON(res, 200, { success: true });
    }

    // ── Config ──
    if (pathname === '/api/config' && req.method === 'GET') {
      const runner = await getRunner();
      if (!runner) {
        const os = require('os');
        return writeJSON(res, 200, { success: true, config: { workingDirectory: os.homedir(), executionMode: 'local' } });
      }
      return writeJSON(res, 200, { success: true, config: runner.store.getConfig() });
    }

    if (pathname === '/api/config' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const runner = await getRunner();
      if (runner) runner.store.setConfig(body);
      return writeJSON(res, 200, { success: true });
    }

    // ── API Config ──
    if (pathname === '/api/apiConfig' && req.method === 'GET') {
      try {
        const runner = await getRunner(); // ensure store is initialized
        const { getCurrentApiConfig } = await import('./libs/claudeSettings');
        const config = getCurrentApiConfig();
        if (config) return writeJSON(res, 200, { hasConfig: true, config });
        // Even if resolveCurrentApiConfig fails (e.g., no auth token for noobclawAI),
        // return the raw app_config so frontend knows a provider IS configured
        const ss = runner?._sqliteStore;
        const appConfig = ss?.get?.('app_config');
        if (appConfig?.providers) {
          // Find any enabled provider
          const enabledProvider = Object.entries(appConfig.providers).find(([_, v]: [string, any]) => v?.enabled);
          if (enabledProvider) {
            return writeJSON(res, 200, {
              hasConfig: true,
              config: {
                apiKey: '',
                baseURL: (enabledProvider[1] as any).baseUrl || '',
                model: appConfig.model?.defaultModel || '',
                apiType: (enabledProvider[1] as any).apiFormat || 'openai',
                providerName: enabledProvider[0],
                isOpenAICompat: (enabledProvider[1] as any).apiFormat === 'openai',
              },
              needsAuth: enabledProvider[0] === 'noobclawAI',
            });
          }
        }
        return writeJSON(res, 200, { hasConfig: false, config: null });
      } catch (e) {
        return writeJSON(res, 200, { hasConfig: false, config: null, error: String(e) });
      }
    }

    if (pathname === '/api/apiConfig/check' && req.method === 'POST') {
      try {
        const runner = await getRunner(); // ensure store + proxy initialized
        const { resolveCurrentApiConfig, getNoobClawAuthToken } = await import('./libs/claudeSettings');
        const { config, error } = resolveCurrentApiConfig();
        if (config) {
          return writeJSON(res, 200, { hasConfig: true, config });
        }
        // If noobclawAI is configured but auth token is missing, tell frontend to login
        const ss = runner?._sqliteStore;
        const appConfig = ss?.get?.('app_config');
        const noobclawEnabled = appConfig?.providers?.noobclawAI?.enabled;
        if (noobclawEnabled && !getNoobClawAuthToken()) {
          return writeJSON(res, 200, { hasConfig: false, error: 'Missing auth token — please connect your wallet to use NoobClaw AI.' });
        }
        return writeJSON(res, 200, { hasConfig: false, config: null, error });
      } catch (e) {
        return writeJSON(res, 200, { hasConfig: false, config: null, error: String(e) });
      }
    }

    if (pathname === '/api/apiConfig/save' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      try {
        await getRunner(); // ensure store is initialized
        const { saveCoworkApiConfig } = await import('./libs/coworkConfigStore');
        saveCoworkApiConfig(body);
        return writeJSON(res, 200, { success: true });
      } catch (e) {
        return writeJSON(res, 500, { error: String(e) });
      }
    }

    // ── Session detail ──
    if (pathname.startsWith('/api/session/') && req.method === 'GET' && !pathname.includes('/api/session/start') && !pathname.includes('/api/session/stop') && !pathname.includes('/api/session/delete') && !pathname.includes('/api/session/pin') && !pathname.includes('/api/session/rename')) {
      const sessionId = pathname.split('/api/session/')[1];
      if (sessionId) {
        const runner = await getRunner();
        if (!runner) return writeJSON(res, 200, { success: false, error: 'Runner not ready' });
        const session = runner.store.getSession(sessionId); // includes messages
        return writeJSON(res, 200, { success: true, session });
      }
    }

    if (pathname === '/api/session/deleteBatch' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const runner = await getRunner();
      if (runner) for (const id of (body.sessionIds || [])) runner.store.deleteSession(id);
      return writeJSON(res, 200, { success: true });
    }

    if (pathname === '/api/session/pin' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const runner = await getRunner();
      if (runner) runner.store.updateSession(body.sessionId, { pinned: body.pinned });
      return writeJSON(res, 200, { status: 'ok' });
    }

    if (pathname === '/api/session/rename' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const runner = await getRunner();
      if (runner) runner.store.updateSession(body.sessionId, { title: body.title });
      return writeJSON(res, 200, { status: 'ok' });
    }

    // ── Memory ──
    if (pathname === '/api/memory/list' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const runner = await getRunner();
      if (!runner) return writeJSON(res, 200, { entries: [], total: 0 });
      return writeJSON(res, 200, runner.store.listMemoryEntries?.(body) || []);
    }

    if (pathname === '/api/memory/create' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const runner = await getRunner();
      if (!runner) return writeJSON(res, 503, { error: 'Runner not ready' });
      const entry = runner.store.createMemoryEntry?.(body);
      return writeJSON(res, 200, { success: true, entry });
    }

    if (pathname === '/api/memory/update' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const runner = await getRunner();
      if (runner) runner.store.updateMemoryEntry?.(body);
      return writeJSON(res, 200, { success: true });
    }

    if (pathname === '/api/memory/delete' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const runner = await getRunner();
      if (runner) runner.store.deleteMemoryEntry?.(body.id);
      return writeJSON(res, 200, { success: true });
    }

    if (pathname === '/api/memory/stats' && req.method === 'GET') {
      const runner = await getRunner();
      if (!runner) return writeJSON(res, 200, { total: 0 });
      return writeJSON(res, 200, runner.store.getMemoryStats?.() || { total: 0 });
    }

    // ── Sandbox ──
    if (pathname === '/api/sandbox/status' && req.method === 'GET') {
      return writeJSON(res, 200, { ready: false, mode: 'tauri-sidecar' });
    }

    if (pathname === '/api/sandbox/install' && req.method === 'POST') {
      return writeJSON(res, 200, { status: 'not-supported', message: 'Sandbox not available in Tauri mode' });
    }

    // ── Generic IPC invoke (for features not yet ported to dedicated routes) ──
    if (pathname === '/api/ipc/invoke' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const { channel, args } = body;
      const runner = await getRunner();

      // Route IPC channels to runner methods
      const ss = runner?._sqliteStore;
      try {
        switch (channel) {
          // ── Store KV ──
          case 'store:get': return writeJSON(res, 200, ss?.get?.(args[0]) ?? null);
          case 'store:set': ss?.set?.(args[0], args[1]); return writeJSON(res, 200, { status: 'ok' });
          case 'store:remove': ss?.delete?.(args[0]); return writeJSON(res, 200, { status: 'ok' });

          // ── Skills ──
          case 'skills:list': {
            const sm = await getSkillManagerInstance();
            return writeJSON(res, 200, { success: true, skills: sm?.listSkills?.() ?? [] });
          }
          case 'skills:setEnabled': {
            const sm = await getSkillManagerInstance();
            if (!sm) return writeJSON(res, 200, { success: false, error: 'SkillManager not initialized' });
            try {
              sm.setSkillEnabled(args[0]?.id, args[0]?.enabled);
              return writeJSON(res, 200, { success: true, skills: sm.listSkills() });
            } catch (e: any) { return writeJSON(res, 200, { success: false, error: e.message }); }
          }
          case 'skills:delete': {
            const sm = await getSkillManagerInstance();
            if (!sm) return writeJSON(res, 200, { success: false, error: 'SkillManager not initialized' });
            try {
              sm.deleteSkill(args[0]);
              return writeJSON(res, 200, { success: true, skills: sm.listSkills() });
            } catch (e: any) { return writeJSON(res, 200, { success: false, error: e.message }); }
          }
          case 'skills:download': {
            const sm = await getSkillManagerInstance();
            try {
              const result = await sm?.downloadSkill?.(args[0], args[1]);
              return writeJSON(res, 200, result ?? { success: true });
            } catch (e: any) {
              return writeJSON(res, 200, { success: false, error: e.message });
            }
          }
          case 'skills:getRoot': {
            const sm = await getSkillManagerInstance();
            return writeJSON(res, 200, sm?.getSkillsRoot?.() ?? '');
          }
          case 'skills:autoRoutingPrompt': {
            const sm = await getSkillManagerInstance();
            try {
              const prompt = sm?.buildAutoRoutingPrompt?.() ?? '';
              return writeJSON(res, 200, { success: true, prompt });
            } catch { return writeJSON(res, 200, { success: true, prompt: '' }); }
          }
          case 'skills:getConfig': {
            const sm = await getSkillManagerInstance();
            return writeJSON(res, 200, sm?.getSkillConfig?.(args[0]) ?? {});
          }
          case 'skills:setConfig': {
            const sm = await getSkillManagerInstance();
            sm?.setSkillConfig?.(args[0], args[1]);
            return writeJSON(res, 200, { success: true });
          }
          case 'skills:testEmailConnectivity':
            return writeJSON(res, 200, { success: false, error: 'Not available in Tauri mode' });

          // ── MCP ──
          case 'mcp:list': {
            const ms = await getMcpStoreInstance();
            return writeJSON(res, 200, { success: true, servers: ms?.listServers?.() ?? [] });
          }
          case 'mcp:create': {
            const ms = await getMcpStoreInstance();
            ms?.createServer?.(args[0]);
            return writeJSON(res, 200, { success: true, servers: ms?.listServers?.() ?? [] });
          }
          case 'mcp:update': {
            const ms = await getMcpStoreInstance();
            ms?.updateServer?.(args[0], args[1]);
            return writeJSON(res, 200, { success: true, servers: ms?.listServers?.() ?? [] });
          }
          case 'mcp:delete': {
            const ms = await getMcpStoreInstance();
            ms?.deleteServer?.(args[0]);
            return writeJSON(res, 200, { success: true, servers: ms?.listServers?.() ?? [] });
          }
          case 'mcp:setEnabled': {
            const ms = await getMcpStoreInstance();
            ms?.setEnabled?.(args[0]?.id, args[0]?.enabled);
            return writeJSON(res, 200, { success: true, servers: ms?.listServers?.() ?? [] });
          }
          case 'mcp:oauth:begin': {
            // Kick off the OAuth authorization-code flow for a given MCP
            // server. Opens the authorize URL via platformAdapter's
            // openExternal (which in sidecar mode delegates to xdg-open /
            // powershell start / tauri's shell plugin through the Tauri
            // bridge), waits for the loopback callback, and persists the
            // resulting tokens back onto the McpServerRecord via setOAuth.
            const opts = args[0] || {};
            try {
              const ms = await getMcpStoreInstance();
              if (!ms) return writeJSON(res, 200, { success: false, error: 'McpStore not initialized' });
              const server = ms.getServer?.(opts.id);
              if (!server) return writeJSON(res, 200, { success: false, error: 'MCP server not found' });

              const { beginMcpOAuthFlow } = await import('./libs/mcpOAuth');
              const flow = await beginMcpOAuthFlow({
                authorizeUrl: opts.authorizeUrl,
                tokenUrl: opts.tokenUrl,
                clientId: opts.clientId,
                clientSecret: opts.clientSecret,
                scope: opts.scope,
              });
              try {
                const { openExternal } = await import('./libs/platformAdapter');
                await openExternal(flow.authorizeUrl);
              } catch (e) {
                console.warn('[mcp:oauth] openExternal failed:', e);
              }
              const oauth = await flow.waitForCallback;
              ms.setOAuth?.(opts.id, oauth);
              return writeJSON(res, 200, { success: true, servers: ms.listServers?.() ?? [] });
            } catch (e: any) {
              console.warn('[mcp:oauth] flow failed:', e?.message || e);
              return writeJSON(res, 200, { success: false, error: e?.message || String(e) });
            }
          }
          case 'mcp:oauth:clear': {
            const id = args[0];
            const ms = await getMcpStoreInstance();
            if (!ms) return writeJSON(res, 200, { success: false, error: 'McpStore not initialized' });
            const server = ms.getServer?.(id);
            if (!server) return writeJSON(res, 200, { success: false, error: 'MCP server not found' });
            if (server.oauth) {
              ms.setOAuth?.(id, {
                type: 'oauth',
                authorizeUrl: server.oauth.authorizeUrl,
                tokenUrl: server.oauth.tokenUrl,
                clientId: server.oauth.clientId,
                clientSecret: server.oauth.clientSecret,
                scope: server.oauth.scope,
              });
            }
            return writeJSON(res, 200, { success: true, servers: ms.listServers?.() ?? [] });
          }
          case 'mcp:fetchMarketplace': {
            try {
              const mpRes = await fetch('https://api-overmind.noobclaw.com/api/v1/kv/mcp-marketplace');
              const mpJson = await mpRes.json() as any;
              return writeJSON(res, 200, { success: true, data: mpJson?.data?.value ?? [] });
            } catch { return writeJSON(res, 200, { success: true, data: [] }); }
          }

          // ── API fetch proxy ──
          // Contract must match Electron's ipcMain.handle('api:fetch') in main.ts:
          // returns { ok, status, statusText, headers, data } where data is a parsed
          // object when the response content-type is JSON, otherwise the raw text.
          case 'api:fetch': {
            const opts = args[0];
            try {
              const fetchRes = await fetch(opts.url, {
                method: opts.method || 'GET',
                headers: opts.headers || {},
                body: opts.body || undefined,
              });
              const contentType = fetchRes.headers.get('content-type') || '';
              const headersObj: Record<string, string> = {};
              fetchRes.headers.forEach((v, k) => { headersObj[k] = v; });
              let data: unknown;
              if (contentType.includes('application/json')) {
                try { data = await fetchRes.json(); }
                catch { data = await fetchRes.text(); }
              } else {
                data = await fetchRes.text();
              }
              return writeJSON(res, 200, {
                ok: fetchRes.ok,
                status: fetchRes.status,
                statusText: fetchRes.statusText,
                headers: headersObj,
                data,
              });
            } catch (e: any) {
              return writeJSON(res, 200, { ok: false, status: 0, statusText: '', headers: {}, data: null, error: e.message });
            }
          }

          // ── Log ──
          case 'log:getPath': {
            const { getCoworkLogPath } = await import('./libs/coworkLogger');
            return writeJSON(res, 200, getCoworkLogPath());
          }
          case 'log:openFolder': {
            const { getCoworkLogPath } = await import('./libs/coworkLogger');
            const { openExternal } = await import('./libs/platformAdapter');
            await openExternal(require('path').dirname(getCoworkLogPath()));
            return writeJSON(res, 200, { status: 'ok' });
          }

          // ── Shell ──
          case 'shell:openPath':
          case 'shell:showItemInFolder': {
            const { openExternal: oe } = await import('./libs/platformAdapter');
            await oe(args[0]);
            return writeJSON(res, 200, { status: 'ok' });
          }

          // ── Multi-platform Video Creation (local synthesis) ──
          // 文件选择弹窗在渲染端走 Tauri 原生 dialog,不到这里。这里只处理:
          //   读图 dataURL(渲染端 CSP 加载不了 file://)、跑出片流水线、
          //   打开成片、在文件管理器里定位。出片进度通过 SSE 'video:progress' 推回。
          case 'video:readImageDataUrl': {
            try {
              const fs = await import('fs');
              const path = await import('path');
              const buf = fs.readFileSync(args[0]);
              // 缩略图不需要超大文件,挡掉异常大的图。
              if (buf.length > 12 * 1024 * 1024) return writeJSON(res, 200, '');
              const ext = path.extname(args[0]).toLowerCase().replace('.', '');
              const mime =
                ext === 'png' ? 'image/png'
                : ext === 'webp' ? 'image/webp'
                : ext === 'bmp' ? 'image/bmp'
                : ext === 'gif' ? 'image/gif'
                : 'image/jpeg';
              return writeJSON(res, 200, `data:${mime};base64,${buf.toString('base64')}`);
            } catch {
              return writeJSON(res, 200, '');
            }
          }
          case 'video:scanLocalFolder': {
            // 本地混剪:Tauri 下文件夹选择走渲染端原生弹窗,选完由这里扫顶层文件数
            // (视频/图片各多少),向导据此展示"找到 N 个"并定素材形态。
            try {
              const { scanLocalMediaFolder } = await import('./libs/video/pipeline');
              const media = scanLocalMediaFolder(String(args[0] || ''));
              return writeJSON(res, 200, { videoCount: media.videos.length, imageCount: media.images.length });
            } catch {
              return writeJSON(res, 200, { videoCount: 0, imageCount: 0 });
            }
          }
          case 'video:resolveBgmPath': {
            // 返回该 BGM 所在【目录】(不下载、不要求文件已存在),供「打开文件夹」直接打开,
            // 让用户自己进去双击试听。builtin→内置目录;remote→缓存目录;上传→文件目录。
            try {
              const fs = await import('fs');
              const { resolveBgmFolder } = await import('./libs/video/bgm');
              const dir = resolveBgmFolder(args[0]);
              return writeJSON(res, 200, dir && fs.existsSync(dir) ? dir : '');
            } catch {
              return writeJSON(res, 200, '');
            }
          }
          case 'video:validateMedia': {
            // Tauri 下文件选择走渲染端原生弹窗,无法在那里 fs.stat;由这里按
            // 格式 + 大小白名单校验选中的路径,回 { valid, rejected } 给 shim 提示用户。
            try {
              const { validateMediaFiles } = await import('./libs/video/mediaLimits');
              const paths = Array.isArray(args[0]) ? args[0] : [];
              const kind = args[1] === 'audio' ? 'audio' : 'video';
              return writeJSON(res, 200, validateMediaFiles(paths, kind));
            } catch {
              return writeJSON(res, 200, { valid: [], rejected: [] });
            }
          }
          case 'video:generate': {
            // Fire-and-forget (same pattern as scenario:runTaskNow above).
            // The pipeline runs for minutes (TTS + stock downloads + ffmpeg).
            // Awaiting here would exceed Node's default 5-min requestTimeout,
            // the socket gets destroyed, and the renderer's fetch rejects →
            // ipc_error. Instead we start it, stream progress over the
            // video:progress SSE (the pipeline already emits a terminal
            // done/error event), and return immediately. The renderer resolves
            // its generate() promise on that terminal SSE event.
            try {
              const { generateVideoBatch } = await import('./libs/video/pipeline');
              // 建 AbortController 并按 taskId 注册,供「停止」中断 pipeline + SIGKILL 子进程。
              const vTaskId = (args[0] && (args[0] as { taskId?: unknown }).taskId)
                ? String((args[0] as { taskId?: unknown }).taskId) : '';
              const ctrl = new AbortController();
              if (vTaskId) { activeVideoRuns.get(vTaskId)?.abort(); activeVideoRuns.set(vTaskId, ctrl); }
              const cleanup = () => { if (vTaskId && activeVideoRuns.get(vTaskId) === ctrl) activeVideoRuns.delete(vTaskId); };
              generateVideoBatch(args[0] as any, (progress: unknown) => {
                broadcastSSE('video:progress', progress);
              }, ctrl.signal).then((result) => {
                // Belt-and-suspenders terminal event (no `steps` so it can't
                // wipe the renderer's step list); harmless duplicate of the
                // pipeline's own done/error emit.
                broadcastSSE('video:progress', {
                  jobId: 'final',
                  status: result.ok ? 'done' : 'error',
                  outputPath: result.outputPath,
                  error: result.error,
                });
                // 运行中(含定时视频任务)余额不足 → 弹充值/续费弹窗(同矩阵涨粉任务口径)。
                if (!result.ok && /余额不足|insufficient|积分.*不足/i.test(String(result.error ?? ''))) {
                  broadcastSSE('noobclaw:token-insufficient', { source: 'video-run' });
                }
              }).catch((e: any) => {
                broadcastSSE('video:progress', {
                  jobId: 'final',
                  status: 'error',
                  error: e?.message || String(e),
                });
                if (/余额不足|insufficient|积分.*不足/i.test(String(e?.message ?? ''))) {
                  broadcastSSE('noobclaw:token-insufficient', { source: 'video-run' });
                }
              }).finally(cleanup);
              return writeJSON(res, 200, { ok: true, status: 'started' });
            } catch (e: any) {
              return writeJSON(res, 200, { ok: false, error: e?.message || String(e) });
            }
          }
          case 'video:stop': {
            // 停止某个正在出片的视频任务:abort → pipeline 步骤边界退出 + ffmpeg/seedance/tts SIGKILL。
            try {
              const ctrl = activeVideoRuns.get(String(args[0] || ''));
              if (ctrl) { ctrl.abort(); return writeJSON(res, 200, { ok: true }); }
              return writeJSON(res, 200, { ok: false });
            } catch (e: any) {
              return writeJSON(res, 200, { ok: false, error: e?.message || String(e) });
            }
          }
          case 'video:openFile': {
            try {
              const { openExternal: oe } = await import('./libs/platformAdapter');
              await oe(args[0]);
            } catch {}
            return writeJSON(res, 200, true);
          }

          // ── Matrix(矩阵号:多账号同平台铺内容)──
          // 账号池全本地;driver/计费走 backend/matrix。进度经 matrix:progress SSE。
          case 'matrix:listAccounts': {
            const { listAccounts, getLocalEgressIp } = await import('./libs/matrix/accountManager');
            // 无代理号附上真实本机出口 IP(内核侧探到的),供卡片显示「本机 <ip>」而非「本地IP(默认)」。
            const localIp = getLocalEgressIp();
            const accounts = listAccounts().map((a: any) => (a.proxy ? a : { ...a, egressIp: localIp || undefined }));
            return writeJSON(res, 200, { ok: true, accounts });
          }
          case 'matrix:createAccount': {
            const { createAccount } = await import('./libs/matrix/accountManager');
            return writeJSON(res, 200, { ok: true, account: createAccount(args[0]) });
          }
          case 'matrix:setAccountProxy': {
            const { setAccountProxy } = await import('./libs/matrix/accountManager');
            setAccountProxy(args[0]?.id, args[0]?.proxy);
            return writeJSON(res, 200, { ok: true });
          }
          case 'matrix:setAccountStatus': {
            const { setAccountStatus } = await import('./libs/matrix/accountManager');
            setAccountStatus(args[0]?.id, args[0]?.status);
            return writeJSON(res, 200, { ok: true });
          }
          case 'matrix:setAccountKeywords': {
            const { setAccountKeywords } = await import('./libs/matrix/accountManager');
            setAccountKeywords(args[0]?.id, args[0]?.keywords || [], args[0]?.track);
            return writeJSON(res, 200, { ok: true });
          }
          case 'matrix:removeAccount': {
            const { removeAccount } = await import('./libs/matrix/accountManager');
            removeAccount(args[0]?.id);
            return writeJSON(res, 200, { ok: true });
          }
          case 'matrix:validateProxy': {
            // 配代理时校验:① 连通性(probeProxy)② 同平台撞 IP(platformKey 同 host 的别的号,创作端/主站分开)。
            try {
              const a = args[0] as any;
              const proxy = a?.proxy;
              if (!proxy || !proxy.host) return writeJSON(res, 200, { ok: true, reachable: false, error: 'no_proxy' });
              const { listAccounts, platformKey } = await import('./libs/matrix/accountManager');
              const { probeProxyDetailed } = await import('./libs/matrix/proxyBridge');
              const pk = platformKey({ platform: a?.platform, loginScope: a?.loginScope });
              const dup = listAccounts().find((x: any) => x.id !== a?.accountId && x.proxy && x.proxy.host === proxy.host && platformKey(x) === pk);
              const probe = await probeProxyDetailed(proxy).catch(() => ({ ok: false } as any));
              return writeJSON(res, 200, {
                ok: true, reachable: probe.ok, error: probe.error, suggestProtocol: probe.suggestProtocol,
                geo: probe.geo,
                duplicateName: dup ? (dup.displayName || dup.nickname || dup.id) : undefined,
              });
            } catch (e: any) {
              return writeJSON(res, 200, { ok: false, reachable: false, error: e?.message || String(e) });
            }
          }
          case 'matrix:openLogin': {
            // 起该号的指纹内核并导航到平台登录页,供用户扫码;轮询到登录成功(或超时/窗口被关)才收尾。
            try {
              const { getAccount, setAccountStatus, accountBadgeLabel, platformKey } = await import('./libs/matrix/accountManager');
              const { launchKernel, kernelNavigate, checkKernelLogin, getSession, closeKernel, kernelBringToFront, isAccountBusy } = await import('./libs/matrix/kernelPool');
              const a = args[0] as any;
              const acc = getAccount(a?.accountId);
              if (!acc) return writeJSON(res, 200, { ok: false, error: 'account_not_found' });
              // 忙碌预检:该号正被任务/保活/刷新占用 → 明确拒绝。skipLease 虽不排队,但下面的 navigate 会把
              //   正在跑的任务页面导走(毁任务),所以这里必须拦。
              if (isAccountBusy(acc.id)) return writeJSON(res, 200, { ok: false, error: '该账号正在执行任务,请等任务结束后再扫码连接' });
              // 去重:已有扫码轮询在跑 → 不重复起(否则引用计数只加不减、多个轮询打架),把窗提到前台即可。
              if (matrixScanWatching.has(acc.id)) {
                try { await kernelBringToFront(acc.id); } catch { /* 非关键 */ }
                return writeJSON(res, 200, { ok: true, already: true });
              }
              const pk = platformKey(acc);
              // 去重标记在 launch 【前】置位:连点两下时第二下才能被上面的去重挡住(launch 要几秒,加晚了两个轮询都起来)。
              matrixScanWatching.add(acc.id);
              try {
                await launchKernel({
                  accountId: acc.id, kernelPath: a?.kernelPath, kernelVersion: acc.kernelVersion,
                  userDataDir: acc.userDataDir, fingerprint: acc.fingerprint, proxy: acc.proxy,
                  label: accountBadgeLabel(acc),   // 角标:平台名 · 昵称 · 备注
                  startUrl: a?.loginUrl || undefined,   // 新起内核直接开到登录页(避免新标签页竞态)
                  skipLease: true,                  // 用户扫码场景:不占使用互斥锁,不阻塞任务(忙碌预检已在上面拦过)
                });
              } catch (e) {
                matrixScanWatching.delete(acc.id); // 没起来 → 撤去重标记(kernelPool 已回退计数),让用户能重试
                throw e;
              }
              // 后台轮询登录态:扫码成功后自动把状态翻成 idle 并推 matrix:account SSE
              // (~10min,对齐 reloginPrompt —— 原来只 3min,拿手机/收验证码常超时,登录成功了状态却不翻;窗口关了就停)。
              (async () => {
                try {
                // 导航到登录页:复用内核不按 startUrl 重开、新起内核 CDP 偶尔就绪晚于此刻 →
                //   原来只在第 0 轮 navigate 一次、失败就吞掉,页面永远停在 about:blank
                //   (2026-07-21 用户实测「唤起指纹浏览器但不打开网址」)。改成重试到成功一次即停
                //   (最多 ~8s),既补上首次失败,又不反复打断用户扫码。
                if (a?.loginUrl) {
                  for (let n = 0; n < 6; n++) {
                    try { await kernelNavigate(acc.id, a.loginUrl); break; }
                    catch { await new Promise((r) => setTimeout(r, 1300)); }
                  }
                }
                for (let i = 0; i < 200; i++) {
                  await new Promise((r) => setTimeout(r, 3000));
                  if (!getSession(acc.id)) break; // 窗口被关
                  let ok = false;
                  try { ok = await checkKernelLogin(acc.id, pk); } catch { ok = false; }
                  if (ok) {
                    // 登录刚成功时页面常还停在登录/回跳页 → 先导航到平台主页并稍等,确保在「有本人信息」的页面
                    // 读身份(否则读太早拿到空 → 这就是之前必须手动点「刷新信息」才出头像的原因)。和 refreshIdentity 一致。
                    try { if (a?.loginUrl) await kernelNavigate(acc.id, a.loginUrl); } catch { /* ignore */ }
                    await new Promise((r) => setTimeout(r, 3000));
                    // 关键:把刚扫到的【会话 cookie】固化落盘,否则内核被强杀后 sessionid 丢失 →
                    //   下次任务新起内核读空 cookie 又判「登录过期」(见 persistKernelCookies 注释)。
                    try { const { persistKernelCookies } = await import('./libs/matrix/kernelPool'); await persistKernelCookies(acc.id); } catch { /* ignore */ }
                    // 读真实身份(昵称 + uid)。
                    let ident: any = {};
                    try {
                      const { kernelReadIdentity } = await import('./libs/matrix/kernelPool');
                      ident = await kernelReadIdentity(acc.id, pk);
                    } catch { /* 身份读取失败不影响登录 */ }
                    // 去重(B):这个真实账号(uid)已被别的矩阵号关联 → 拒绝本次关联,清 cookie + 标未关联 + 提示换号。
                    const { findAccountByUid, setAccountStatus: setStat, setAccountIdentity } = await import('./libs/matrix/accountManager');
                    const dup = ident.uid ? findAccountByUid(pk, String(ident.uid), acc.id) : undefined;
                    if (dup) {
                      try { const { kernelClearCookies } = await import('./libs/matrix/kernelPool'); await kernelClearCookies(acc.id); } catch { /* ignore */ }
                      setStat(acc.id, 'login_required');
                      broadcastSSE('matrix:account', { id: acc.id, status: 'login_required', error: `该账号已被「${dup.displayName}」关联,一个真实账号只能关联一个矩阵号,请换一个号扫码` });
                      break;
                    }
                    setStat(acc.id, 'idle');
                    try { setAccountIdentity(acc.id, { nickname: ident.nickname, displayId: ident.displayId, avatar: ident.avatar, boundUid: ident.uid }); } catch { /* ignore */ }
                    try { const { probeAndSaveHealth } = await import('./libs/matrix/proxyBridge'); await probeAndSaveHealth(acc); } catch { /* 代理探测失败不影响登录 */ }
                    broadcastSSE('matrix:account', { id: acc.id, status: 'idle', nickname: ident.nickname, displayId: ident.displayId, avatar: ident.avatar, boundUid: ident.uid });
                    break;
                  }
                }
                } finally {
                  matrixScanWatching.delete(acc.id);
                  // 平衡本次 launchKernel 的 +1:轮询收尾(登录成功/去重拒绝/超时/窗口被手关)即释放 ——
                  // 原来这条路永不 closeKernel,引用计数被 pin 住,后续任务复用同内核后窗口永远关不掉、越积越多。
                  // skipLease 起的 → 关闭也 skipLease(绝不能去动别的流程持有的使用锁)。
                  try { closeKernel(acc.id, { skipLease: true }); } catch { /* ignore */ }
                }
              })();
              return writeJSON(res, 200, { ok: true });
            } catch (e: any) {
              return writeJSON(res, 200, { ok: false, error: e?.message || String(e) });
            }
          }
          case 'matrix:importCookieLogin': {
            // 导入 cookie 登录:把外部导出的登录 cookie 灌进本号 profile → 导航验活体 → 读身份 → 关联。
            //   海外 Google/Apple 登录号、已在其它浏览器登录过的号走这条(不在指纹内核里跑 OAuth,行业标准做法)。
            try {
              const { getAccount, setAccountStatus, accountBadgeLabel, platformKey, setAccountIdentity, findAccountByUid } = await import('./libs/matrix/accountManager');
              const { launchKernel, kernelNavigate, checkKernelLogin, kernelReadIdentity, kernelSetCookies, kernelClearCookies, closeKernel, isAccountBusy } = await import('./libs/matrix/kernelPool');
              const a = args[0] as any;
              const acc = getAccount(a?.accountId);
              if (!acc) return writeJSON(res, 200, { ok: false, error: 'account_not_found' });
              // 忙碌预检:该号正被任务/保活/刷新占用 → 明确拒绝(灌 cookie + navigate 会毁掉正在跑的任务页面)。
              if (isAccountBusy(acc.id)) return writeJSON(res, 200, { ok: false, error: '该账号正在执行任务,请等任务结束后再导入 cookie' });
              let cookies: any[] = [];
              if (Array.isArray(a?.cookies)) {
                cookies = a.cookies;
              } else {
                let parsed: any;
                try { parsed = JSON.parse(String(a?.cookiesRaw || '[]')); }
                catch { return writeJSON(res, 200, { ok: false, error: 'cookie 解析失败:请粘贴 Cookie-Editor 导出的 JSON 数组' }); }
                if (Array.isArray(parsed)) cookies = parsed;
                else if (parsed && Array.isArray(parsed.cookies)) cookies = parsed.cookies;
                else if (parsed && typeof parsed === 'object' && parsed.data && (parsed.version || parsed.url)) {
                  return writeJSON(res, 200, { ok: false, error: '这是【加密导出】(Cookie-Editor 的 Encrypt 导出),导不进。请改用官方 Cookie-Editor,点 Export 选【JSON】(得到的是 [ {name,value,...} ] 明文数组),再粘进来。' });
                }
              }
              if (!Array.isArray(cookies) || !cookies.length) return writeJSON(res, 200, { ok: false, error: 'cookie 为空或格式不对:应是 [ {name,value,domain,...} ] 这样的明文数组(Cookie-Editor → Export → JSON)' });
              const pk = platformKey(acc);
              await launchKernel({
                accountId: acc.id, kernelPath: a?.kernelPath, kernelVersion: acc.kernelVersion,
                userDataDir: acc.userDataDir, fingerprint: acc.fingerprint, proxy: acc.proxy,
                label: accountBadgeLabel(acc), skipLease: true,
              });
              // launch 成功后无论哪条路退出(无效/重复/成功/异常)都关窗收尾(对齐 refreshIdentity 的「读完不留窗」;
              // 原来三条路都把窗留着、引用计数 pin 在 1 → 窗口永远关不掉)。skipLease 起的 → 关闭也 skipLease。
              try {
                const inj = await kernelSetCookies(acc.id, cookies);
                try { await kernelNavigate(acc.id, a?.navUrl || 'about:blank'); } catch { /* ignore */ }
                await new Promise((r) => setTimeout(r, 2500));
                let ok = false;
                try { ok = await checkKernelLogin(acc.id, pk); } catch { ok = false; }
                if (!ok) {
                  setAccountStatus(acc.id, 'login_required');
                  broadcastSSE('matrix:account', { id: acc.id, status: 'login_required', error: `cookie 无效或非该平台登录态(注入 ${inj.set} 条/失败 ${inj.failed})。请确认导出的是该号在 ${pk} 已登录的 cookie` });
                  return writeJSON(res, 200, { ok: false, error: `cookie 未通过活体校验(注入 ${inj.set}/失败 ${inj.failed})` });
                }
                let ident: any = {};
                try { ident = await kernelReadIdentity(acc.id, pk); } catch { /* 身份读取失败不影响登录 */ }
                const dup = ident.uid ? findAccountByUid(pk, String(ident.uid), acc.id) : undefined;
                if (dup) {
                  try { await kernelClearCookies(acc.id); } catch { /* ignore */ }
                  setAccountStatus(acc.id, 'login_required');
                  broadcastSSE('matrix:account', { id: acc.id, status: 'login_required', error: `该账号已被「${dup.displayName}」关联,一个真实账号只能关联一个矩阵号` });
                  return writeJSON(res, 200, { ok: false, error: `该账号已被「${dup.displayName}」关联` });
                }
                setAccountStatus(acc.id, 'idle');
                try { setAccountIdentity(acc.id, { nickname: ident.nickname, displayId: ident.displayId, avatar: ident.avatar, boundUid: ident.uid }); } catch { /* ignore */ }
                try { const { probeAndSaveHealth } = await import('./libs/matrix/proxyBridge'); await probeAndSaveHealth(acc); } catch { /* ignore */ }
                broadcastSSE('matrix:account', { id: acc.id, status: 'idle', nickname: ident.nickname, displayId: ident.displayId, avatar: ident.avatar, boundUid: ident.uid });
                return writeJSON(res, 200, { ok: true, account: getAccount(acc.id) });
              } finally {
                try { closeKernel(acc.id, { skipLease: true }); } catch { /* ignore */ }
              }
            } catch (e: any) {
              return writeJSON(res, 200, { ok: false, error: e?.message || String(e) });
            }
          }
          // (删)matrix:checkLogin:tauriShim 暴露过但渲染层从无调用;且其「无内核会话直接返回未登录」的
          // 语义容易被误用成登录判定。需要即时校验请用 refreshIdentity(拉起内核真验)。
          case 'matrix:refreshIdentity': {
            // 「刷新信息」:对任意账号(尤其已登录但没读过身份的),拉起内核→导航平台→读 昵称/平台号/头像
            // (cookie 在持久 profile,自然登录态)→存+广播。读完若不是原本在跑的内核则关掉,不留窗。
            try {
              const { getAccount, setAccountStatus, setAccountIdentity, accountBadgeLabel, platformKey } = await import('./libs/matrix/accountManager');
              const { launchKernel, kernelNavigate, checkKernelLogin, kernelReadIdentity, closeKernel, isAccountBusy } = await import('./libs/matrix/kernelPool');
              const a = args[0] as any;
              const acc = getAccount(a?.accountId);
              if (!acc) return writeJSON(res, 200, { ok: false, error: 'account_not_found' });
              // 忙碌预检:该号正被任务/保活占用时,launchKernel 会在使用锁上无限期排队(锁无超时)→
              //   UI 一直「正在读取…」看着像卡死。直接明确告知,让用户等任务结束再刷新。
              if (isAccountBusy(acc.id)) return writeJSON(res, 200, { ok: false, error: '该账号正在执行任务,请等任务结束后再刷新信息' });
              const pk = platformKey(acc);
              await launchKernel({
                accountId: acc.id, kernelPath: a?.kernelPath, kernelVersion: acc.kernelVersion,
                userDataDir: acc.userDataDir, fingerprint: acc.fingerprint, proxy: acc.proxy,
                label: accountBadgeLabel(acc),   // 角标:平台名 · 昵称 · 备注
              });
              // launchKernel 成功后无论中途是否异常,都必须 closeKernel(否则使用锁 + 引用计数泄漏 → 该号卡死)。
              try {
                if (a?.homeUrl) await kernelNavigate(acc.id, a.homeUrl);
                await new Promise((r) => setTimeout(r, 3500)); // 等页面/SSR 就绪
                const loggedIn = await checkKernelLogin(acc.id, pk);
                let ident: any = {};
                if (loggedIn) {
                  try { ident = await kernelReadIdentity(acc.id, pk); } catch { /* ignore */ }
                  // 去重(B):该真实账号(uid)已被别的矩阵号关联 → 拒绝,清 cookie + 标未关联 + 提示。
                  const { findAccountByUid } = await import('./libs/matrix/accountManager');
                  const dup = ident.uid ? findAccountByUid(pk, String(ident.uid), acc.id) : undefined;
                  if (dup) {
                    try { const { kernelClearCookies } = await import('./libs/matrix/kernelPool'); await kernelClearCookies(acc.id); } catch { /* ignore */ }
                    setAccountStatus(acc.id, 'login_required');
                    const dupMsg = `该账号已被「${dup.displayName}」关联,一个真实账号只能关联一个矩阵号`;
                    broadcastSSE('matrix:account', { id: acc.id, status: 'login_required', error: dupMsg });
                    // error 同时带在 HTTP 响应里:渲染层直接显示,不再被显示成误导性的「未检测到登录」。
                    return writeJSON(res, 200, { ok: true, loggedIn: false, duplicate: true, error: dupMsg });
                  }
                  setAccountStatus(acc.id, 'idle');
                  try { setAccountIdentity(acc.id, { nickname: ident.nickname, displayId: ident.displayId, avatar: ident.avatar, boundUid: ident.uid }); } catch { /* ignore */ }
                } else {
                  setAccountStatus(acc.id, 'login_required');
                }
                if (loggedIn) { try { const { probeAndSaveHealth } = await import('./libs/matrix/proxyBridge'); await probeAndSaveHealth(acc); } catch { /* ignore */ } }
                broadcastSSE('matrix:account', { id: acc.id, status: loggedIn ? 'idle' : 'login_required', nickname: ident.nickname, displayId: ident.displayId, avatar: ident.avatar, boundUid: ident.uid });
                return writeJSON(res, 200, { ok: true, loggedIn, nickname: ident.nickname, displayId: ident.displayId });
              } finally {
                try { closeKernel(acc.id); } catch { /* ignore */ } // -1 引用计数 + 释放使用锁
              }
            } catch (e: any) {
              return writeJSON(res, 200, { ok: false, error: e?.message || String(e) });
            }
          }
          case 'matrix:disconnectAccount': {
            // 断开关联:清登录 cookie + 清身份,状态回「需关联」;保留账号配置(赛道/关键词/人设/代理/指纹)。
            try {
              const { getAccount, setAccountStatus, clearAccountIdentity, markManualDisconnect, accountBadgeLabel } = await import('./libs/matrix/accountManager');
              const { launchKernel, kernelClearCookies, closeKernel, isAccountBusy } = await import('./libs/matrix/kernelPool');
              const a = args[0] as any;
              const acc = getAccount(a?.accountId);
              if (!acc) return writeJSON(res, 200, { ok: false, error: 'account_not_found' });
              // 忙碌预检:任务占着锁时 launchKernel 会无限期排队(UI 看着像卡死)→ 明确拒绝。
              if (isAccountBusy(acc.id)) return writeJSON(res, 200, { ok: false, error: '该账号正在执行任务,请等任务结束后再断开' });
              let launched = false;
              try {
                await launchKernel({ accountId: acc.id, kernelPath: a?.kernelPath, kernelVersion: acc.kernelVersion, userDataDir: acc.userDataDir, fingerprint: acc.fingerprint, proxy: acc.proxy, label: accountBadgeLabel(acc) });
                launched = true;
                await kernelClearCookies(acc.id);
              } catch { /* 内核拉不起也要把本地状态清掉 */ }
              // launch 失败时 kernelPool 已回退计数/锁,不能再 closeKernel(会错关/错放别的流程)。
              if (launched) { try { closeKernel(acc.id); } catch { /* ignore */ } } // 引用计数 -1(别的流程用着不会真关)
              setAccountStatus(acc.id, 'login_required');
              // 标「主动断开」:与意外过期区分,keepAlive 不再对它每 12h 开窗复验(cookie 已清、永远验不过)。
              markManualDisconnect(acc.id);
              clearAccountIdentity(acc.id);
              broadcastSSE('matrix:account', { id: acc.id, status: 'login_required', nickname: null, displayId: null, avatar: null });
              return writeJSON(res, 200, { ok: true });
            } catch (e: any) {
              return writeJSON(res, 200, { ok: false, error: e?.message || String(e) });
            }
          }
          case 'matrix:runTask': {
            // Fire-and-forget(同 video:generate):任务跑数分钟,进度走 matrix:progress SSE。
            try {
              const { runMatrixTask } = await import('./libs/matrix/taskRunner');
              const a = args[0] as any;
              const getInput = a?.inputs
                ? (id: string) => a.inputs[id]
                : () => a?.input;
              runMatrixTask({
                platform: a?.platform,
                taskId: a?.taskId,
                accountIds: a?.accountIds || [],
                getInput,
                concurrency: a?.concurrency,
                jitterMinMs: a?.jitterMinMs,
                jitterMaxMs: a?.jitterMaxMs,
                kernelPath: a?.kernelPath,
                headless: a?.headless,
                authToken: a?.authToken,
                onLog: (accountId, msg) => broadcastSSE('matrix:progress', { type: 'log', accountId, msg }),
                onItem: (item) => broadcastSSE('matrix:progress', { type: 'item', ...item }),
              }).then((report) => {
                broadcastSSE('matrix:progress', { type: 'done', report });
              }).catch((e: any) => {
                broadcastSSE('matrix:progress', { type: 'error', error: e?.message || String(e) });
              });
              return writeJSON(res, 200, { ok: true, status: 'started' });
            } catch (e: any) {
              return writeJSON(res, 200, { ok: false, error: e?.message || String(e) });
            }
          }
          case 'matrix:runEngage': {
            // 多号自动互动(点赞/评论/关注)即时跑。按平台并发:同平台同时只跑一个。
            try {
              const a = args[0] as any;
              const platform = a?.platform || 'douyin';
              if (runningPlatforms.has(platform)) return writeJSON(res, 200, { ok: false, error: 'another_task_running' });
              if (runningPlatforms.size >= MATRIX_MAX_CONCURRENT) return writeJSON(res, 200, { ok: false, error: 'concurrency_full' });
              runningPlatforms.add(platform);          // 占锁:check→add 无 await(原子)
              runAccountsByPlatform.set(platform, a?.accountIds || []); // 供 stopTask 强关本平台窗口
              const abort = new AbortController();
              abortByPlatform.set(platform, abort);
              const release = () => { runningPlatforms.delete(platform); abortByPlatform.delete(platform); runAccountsByPlatform.delete(platform); };
              try {
                const { runEngageTask } = await import('./libs/matrix/engageRunner');
                broadcastSSE('matrix:progress', { type: 'taskStart' });
                runEngageTask({
                  platform,
                  taskId: a?.taskId,
                  accountIds: a?.accountIds || [],
                  quota: a?.quota,
                  concurrency: a?.concurrency,
                  kernelPath: a?.kernelPath,
                  authToken: a?.authToken,
                  signal: abort.signal,
                  onLog: (accountId, msg) => broadcastSSE('matrix:progress', { type: 'log', accountId, msg }),
                  onItem: (item) => broadcastSSE('matrix:progress', { type: 'item', accountId: item.accountId, state: item.state, reason: item.reason, counts: item.counts }),
                }).then((report) => {
                  broadcastSSE('matrix:progress', { type: 'done', report });
                }).catch((e: any) => {
                  broadcastSSE('matrix:progress', { type: 'error', error: e?.message || String(e) });
                }).finally(() => { release(); });
                return writeJSON(res, 200, { ok: true, status: 'started' });
              } catch (e: any) {
                release();
                return writeJSON(res, 200, { ok: false, error: e?.message || String(e) });
              }
            } catch (e: any) {
              return writeJSON(res, 200, { ok: false, error: e?.message || String(e) });
            }
          }
          case 'matrix:stopTask': {
            // 停止矩阵任务:传 platform → 只停该平台(abort 信号,运行中的号下个动作前优雅退出);
            // 不传 platform → 全停(abort 所有 + 强关全部窗口立即止损,跟以前一致)。
            try {
              const sp = (args[0] as any)?.platform as string | undefined;
              if (sp) {
                if (!runningPlatforms.has(sp)) return writeJSON(res, 200, { ok: true, status: 'idle' });
                abortByPlatform.get(sp)?.abort();
                // 强关该平台正在跑的号窗口立即止损(参照旧客户端 closeAllKernels,但只关本平台,不连累别的平台)。
                try {
                  const { closeKernel } = await import('./libs/matrix/kernelPool');
                  for (const aid of (runAccountsByPlatform.get(sp) || [])) closeKernel(aid, { force: true });
                } catch { /* ignore */ }
                broadcastSSE('matrix:progress', { type: 'log', accountId: '系统', msg: `⏹ 已停止 ${sp},正在关闭窗口…` });
                return writeJSON(res, 200, { ok: true, status: 'stopping' });
              }
              if (!runningPlatforms.size) return writeJSON(res, 200, { ok: true, status: 'idle' });
              for (const [, c] of abortByPlatform) c.abort();
              const { closeAllKernels } = await import('./libs/matrix/kernelPool');
              closeAllKernels();
              broadcastSSE('matrix:progress', { type: 'log', accountId: '系统', msg: '⏹ 已请求停止全部,正在关闭窗口…' });
              return writeJSON(res, 200, { ok: true, status: 'stopping' });
            } catch (e: any) {
              return writeJSON(res, 200, { ok: false, error: e?.message || String(e) });
            }
          }
          // ── 矩阵任务(可保存 + 调度;每平台≤5、同类型唯一、按平台并发)──
          case 'matrix:listTasks': {
            const { listTasks } = await import('./libs/matrix/taskStore');
            // running:整体是否有在跑;runningPlatforms:具体哪些平台在跑(渲染端按平台判断各任务状态)。
            return writeJSON(res, 200, { ok: true, tasks: listTasks(), running: anyMatrixRunning(), runningPlatforms: Array.from(runningPlatforms) });
          }
          case 'matrix:listRuns': {
            const { listRuns } = await import('./libs/matrix/runStore');
            return writeJSON(res, 200, { ok: true, runs: listRuns((args[0] as any)?.taskId) });
          }
          case 'matrix:getRunProgress': {
            // 实时进度轮询(真 TaskDetailPage 每 2s 拉一次,带本任务 taskId)。按任务隔离:并发时各取各的进度。
            // 不传 taskId(老调用)→ 兜底返回任一在跑的进度。
            const wantTaskId = (args[0] as any)?.taskId as string | undefined;
            const progress = wantTaskId
              ? (liveProgressByTask.get(wantTaskId) || null)
              : (liveProgressByTask.size ? Array.from(liveProgressByTask.values()).find((p) => p.status === 'running') || Array.from(liveProgressByTask.values()).pop() || null : null);
            const isRunning = wantTaskId
              ? (liveProgressByTask.get(wantTaskId)?.status === 'running')
              : anyMatrixRunning();
            return writeJSON(res, 200, { ok: true, running: isRunning, progress });
          }
          case 'matrix:saveTask': {
            const { saveTask } = await import('./libs/matrix/taskStore');
            return writeJSON(res, 200, saveTask(args[0] as any));
          }
          case 'matrix:removeTask': {
            const { removeTask } = await import('./libs/matrix/taskStore');
            removeTask((args[0] as any)?.id);
            return writeJSON(res, 200, { ok: true });
          }
          case 'matrix:setTaskEnabled': {
            const { setTaskEnabled } = await import('./libs/matrix/taskStore');
            setTaskEnabled((args[0] as any)?.id, !!(args[0] as any)?.enabled);
            return writeJSON(res, 200, { ok: true });
          }
          case 'matrix:setPlanLimit': {
            // 渲染进程从 /api/ai/balance 拿到当前生效号数上限后推下来,持久化给 sidecar 的运行时截断用
            //   (定时任务无 auth token,靠这个本地镜像按档位封顶)。
            try {
              const { setPlanLimit } = await import('./libs/matrix/planLimit');
              const a = args[0] as any;
              const v = setPlanLimit({ maxAccountsPerPlatform: a?.maxAccountsPerPlatform, planCode: a?.planCode, subExpireAt: a?.subExpireAt ?? null });
              return writeJSON(res, 200, { ok: true, value: v });
            } catch (e: any) {
              return writeJSON(res, 200, { ok: false, error: e?.message || String(e) });
            }
          }
          case 'matrix:runTaskById': {
            // 按保存的任务手动跑(定时调度走 sidecar startMatrixScheduler,同一个 helper)。
            try {
              const a = args[0] as any;
              const r = await runMatrixTaskById(a?.taskId, a?.kernelPath);
              return writeJSON(res, 200, r.ok ? { ok: true, status: 'started' } : r);
            } catch (e: any) {
              return writeJSON(res, 200, { ok: false, error: e?.message || String(e) });
            }
          }
          case 'matrix:updateAccountMeta': {
            const { updateAccountMeta } = await import('./libs/matrix/accountManager');
            const a = args[0] as any;
            updateAccountMeta(a?.id, { displayName: a?.displayName, group: a?.group, persona: a?.persona, keywords: a?.keywords, track: a?.track, contentLang: a?.contentLang });
            return writeJSON(res, 200, { ok: true });
          }
          case 'matrix:kernelStatus': {
            const { kernelInfo } = await import('./libs/matrix/kernelInstaller');
            return writeJSON(res, 200, { ok: true, ...(await kernelInfo()) });
          }
          case 'matrix:kernelLocalStatus': {
            // 只读本地(不请求服务端),毫秒级返回 → UI 先据此判就绪。
            const { localKernelInfo } = await import('./libs/matrix/kernelInstaller');
            return writeJSON(res, 200, { ok: true, ...localKernelInfo() });
          }
          case 'matrix:ensureKernel': {
            // 按需下载指定版本指纹内核(走后端下发的 OSS 地址)。进度走 matrix:kernel SSE。
            try {
              const { ensureKernel } = await import('./libs/matrix/kernelInstaller');
              const version = (args[0] as any)?.version;
              let lastMsg = ''; // 记住最后一条进度消息,失败时回传具体原因(而非笼统「内核安装失败」)
              ensureKernel(version, (pct, msg) => { lastMsg = msg; broadcastSSE('matrix:kernel', { pct, msg }); })
                .then((p) => broadcastSSE('matrix:kernel', { pct: p ? 100 : 0, msg: p ? '内核就绪' : (lastMsg || '内核安装失败'), done: true, path: p || '', version }))
                .catch((e: any) => broadcastSSE('matrix:kernel', { pct: 0, msg: '失败:' + (e?.message || e), done: true }));
              return writeJSON(res, 200, { ok: true, status: 'started' });
            } catch (e: any) {
              return writeJSON(res, 200, { ok: false, error: e?.message || String(e) });
            }
          }
          case 'matrix:deleteKernel': {
            // 删除某个已装内核版本(下拉里「删除」按钮)。
            try {
              const { deleteKernelVersion } = await import('./libs/matrix/kernelInstaller');
              const version = (args[0] as any)?.version;
              if (!version) return writeJSON(res, 200, { ok: false, error: 'missing_version' });
              const ok = deleteKernelVersion(String(version));
              return writeJSON(res, 200, { ok });
            } catch (e: any) {
              return writeJSON(res, 200, { ok: false, error: e?.message || String(e) });
            }
          }
          case 'matrix:setSelectedKernel': {
            // 设置全局选中版本(落盘,作为所有启动路径的唯一来源)。
            try {
              const { setSelectedVersion } = await import('./libs/matrix/kernelInstaller');
              setSelectedVersion(String((args[0] as any)?.version || ''));
              return writeJSON(res, 200, { ok: true });
            } catch (e: any) {
              return writeJSON(res, 200, { ok: false, error: e?.message || String(e) });
            }
          }
          case 'matrix:selftest': {
            try {
              const { runKernelSelfTest } = await import('./libs/matrix/selftest');
              const report = await runKernelSelfTest(args[0] || {});
              return writeJSON(res, 200, { ok: true, report });
            } catch (e: any) {
              return writeJSON(res, 200, { ok: false, error: e?.message || String(e) });
            }
          }
          case 'matrix:buildContent': {
            // 内容差异化:逐号产片(慢),进度走 matrix:content SSE,完成回传 inputs 映射。
            try {
              const { buildDifferentiatedInputs } = await import('./libs/matrix/contentPlan');
              const a = args[0] as any;
              buildDifferentiatedInputs(
                a?.accountIds || [], a?.base, a?.opts || {},
                (p: unknown) => broadcastSSE('matrix:content', { type: 'progress', progress: p }),
              ).then((inputs) => {
                broadcastSSE('matrix:content', { type: 'done', inputs });
              }).catch((e: any) => {
                broadcastSSE('matrix:content', { type: 'error', error: e?.message || String(e) });
              });
              return writeJSON(res, 200, { ok: true, status: 'started' });
            } catch (e: any) {
              return writeJSON(res, 200, { ok: false, error: e?.message || String(e) });
            }
          }

          // ── User slash commands ──
          // Composer autocomplete reads this list when the user types
          // "/" at the start of the input; body is NOT returned (too
          // expensive, not needed until the command actually fires
          // and the runner expands it server-side).
          case 'slashCommands:list': {
            try {
              const { loadUserSlashCommands } = await import('./libs/userSlashCommands');
              const cmds = loadUserSlashCommands().map(c => ({
                name: c.name,
                description: c.description,
                file: c.file,
              }));
              return writeJSON(res, 200, { success: true, commands: cmds });
            } catch (e: any) {
              return writeJSON(res, 200, { success: false, error: e?.message || String(e) });
            }
          }
          case 'slashCommands:getDir': {
            const { getUserSlashCommandsDir } = await import('./libs/userSlashCommands');
            return writeJSON(res, 200, { success: true, dir: getUserSlashCommandsDir() });
          }

          // ── Thinking budget (settings.json top-level key) ──
          case 'thinkingBudget:get': {
            try {
              const fs = await import('fs');
              const path = await import('path');
              const { getUserDataPath } = await import('./libs/platformAdapter');
              const file = path.join(getUserDataPath(), 'settings.json');
              let budget = 10000;
              try {
                const raw = fs.readFileSync(file, 'utf8');
                const parsed = JSON.parse(raw);
                if (typeof parsed.thinkingBudget === 'number') budget = parsed.thinkingBudget;
              } catch { /* use default */ }
              return writeJSON(res, 200, { success: true, budget });
            } catch (e: any) {
              return writeJSON(res, 200, { success: false, error: e?.message || String(e) });
            }
          }
          case 'thinkingBudget:set': {
            try {
              const fs = await import('fs');
              const path = await import('path');
              const { getUserDataPath } = await import('./libs/platformAdapter');
              const file = path.join(getUserDataPath(), 'settings.json');
              let current: Record<string, unknown> = {};
              try {
                const raw = fs.readFileSync(file, 'utf8');
                current = JSON.parse(raw);
              } catch { /* missing / malformed — start fresh */ }
              const next = Math.max(0, Math.min(100000, Number(args[0]) || 0));
              current.thinkingBudget = next;
              fs.mkdirSync(path.dirname(file), { recursive: true });
              fs.writeFileSync(file, JSON.stringify(current, null, 2), 'utf8');
              return writeJSON(res, 200, { success: true, budget: next });
            } catch (e: any) {
              return writeJSON(res, 200, { success: false, error: e?.message || String(e) });
            }
          }

          // ── Tool permission policy (settings.json toolPermissions) ──
          case 'toolPolicy:get': {
            try {
              const { getToolPermissionPolicy } = await import('./libs/toolPermissionPolicy');
              return writeJSON(res, 200, { success: true, policy: getToolPermissionPolicy() });
            } catch (e: any) {
              return writeJSON(res, 200, { success: false, error: e?.message || String(e) });
            }
          }
          case 'toolPolicy:set': {
            // Overwrite the toolPermissions block of settings.json. We
            // deliberately do a read-modify-write so the hooks / other
            // config survives untouched. Refuses if the file is malformed
            // rather than silently clobbering it.
            try {
              const fs = await import('fs');
              const path = await import('path');
              const { getUserDataPath } = await import('./libs/platformAdapter');
              const file = path.join(getUserDataPath(), 'settings.json');
              let current: Record<string, unknown> = {};
              try {
                const raw = fs.readFileSync(file, 'utf8');
                current = JSON.parse(raw);
              } catch { /* missing / malformed — start fresh */ }
              current.toolPermissions = args[0];
              fs.mkdirSync(path.dirname(file), { recursive: true });
              fs.writeFileSync(file, JSON.stringify(current, null, 2), 'utf8');
              const { invalidateToolPolicyCache } = await import('./libs/toolPermissionPolicy');
              invalidateToolPolicyCache();
              return writeJSON(res, 200, { success: true });
            } catch (e: any) {
              return writeJSON(res, 200, { success: false, error: e?.message || String(e) });
            }
          }

          // ── Crash reporter: list recent crashes + get crash dir ──
          case 'crashes:list': {
            try {
              const { recentCrashes } = await import('./libs/crashReporter');
              return writeJSON(res, 200, { success: true, crashes: recentCrashes(20) });
            } catch (e: any) {
              return writeJSON(res, 200, { success: false, error: e?.message || String(e) });
            }
          }
          case 'crashes:getDir': {
            const { getCrashDir } = await import('./libs/crashReporter');
            return writeJSON(res, 200, { success: true, dir: getCrashDir() });
          }

          // ── Session full-text search (FTS5 / LIKE fallback) ──
          case 'cowork:search:messages': {
            try {
              const q = String(args[0] || '');
              const limit = Math.min(Math.max(Number(args[1] ?? 50), 1), 200);
              const hits = runner?.store?.searchMessages?.(q, limit) ?? [];
              return writeJSON(res, 200, { success: true, hits });
            } catch (e: any) {
              return writeJSON(res, 200, { success: false, error: e?.message || String(e) });
            }
          }

          // ── Workspace file index (@mention composer autocomplete) ──
          // Takes a root dir argument, returns up to 8_000 relative
          // paths with type + size. Cached 10s server-side so rapid
          // keystrokes are cheap. Renderer does the fuzzy scoring.
          case 'workspace:listFiles': {
            try {
              const root = String(args[0] || '');
              if (!root) return writeJSON(res, 200, { success: true, entries: [] });
              const { listWorkspaceFiles } = await import('./libs/workspaceFileIndex');
              const entries = listWorkspaceFiles(root);
              return writeJSON(res, 200, { success: true, entries });
            } catch (e: any) {
              return writeJSON(res, 200, { success: false, error: e?.message || String(e) });
            }
          }

          // ── Shell hooks (settings.json-driven) ──
          case 'shellHooks:list': {
            try {
              const { listConfiguredHooks } = await import('./libs/shellHooks');
              return writeJSON(res, 200, { success: true, hooks: listConfiguredHooks() });
            } catch (e: any) {
              return writeJSON(res, 200, { success: false, error: e?.message || String(e) });
            }
          }

          // ── App info ──
          case 'app:getVersion': return writeJSON(res, 200, '5.4.0');
          case 'app:getSystemLocale': return writeJSON(res, 200, Intl.DateTimeFormat().resolvedOptions().locale || 'en-US');

          // ── Session title ──
          case 'generate-session-title': {
            try {
              const { generateSessionTitle } = await import('./libs/coworkUtil');
              const title = await generateSessionTitle?.(args[0]);
              return writeJSON(res, 200, title ?? null);
            } catch { return writeJSON(res, 200, null); }
          }
          case 'get-recent-cwds': {
            if (runner) {
              const limit = Math.min(Math.max(args[0] ?? 8, 1), 20);
              const cwds = runner.store.listRecentCwds?.(limit) ?? [];
              return writeJSON(res, 200, cwds);
            }
            return writeJSON(res, 200, []);
          }

          // ── Cowork session IPC (for channels not yet routed to dedicated endpoints) ──
          case 'cowork:session:list': {
            const sessions = runner?.store?.listSessions?.() ?? [];
            return writeJSON(res, 200, { success: true, sessions });
          }
          case 'cowork:session:get': {
            const session = runner?.store?.getSession?.(args[0]);
            return writeJSON(res, 200, { success: true, session: session ?? null });
          }
          case 'cowork:config:get': {
            const config = runner?.store?.getConfig?.() ?? {};
            return writeJSON(res, 200, { success: true, config });
          }
          case 'cowork:config:set': {
            runner?.store?.setConfig?.(args[0]);
            return writeJSON(res, 200, { success: true });
          }
          case 'cowork:memory:listEntries': {
            const entries = runner?.store?.listUserMemories?.(args[0] ?? {}) ?? [];
            return writeJSON(res, 200, { success: true, entries });
          }
          case 'cowork:memory:createEntry': {
            const entry = runner?.store?.createUserMemory?.(args[0]);
            return writeJSON(res, 200, { success: true, entry });
          }
          case 'cowork:memory:updateEntry': {
            runner?.store?.updateUserMemory?.(args[0]);
            return writeJSON(res, 200, { success: true });
          }
          case 'cowork:memory:deleteEntry': {
            runner?.store?.deleteUserMemory?.(args[0]?.id);
            return writeJSON(res, 200, { success: true });
          }
          case 'cowork:memory:getStats': {
            return writeJSON(res, 200, { success: true, stats: runner?.store?.getUserMemoryStats?.() ?? { total: 0 } });
          }

          // ── Scheduled Tasks ──
          case 'scheduledTask:list': {
            const sts = await getScheduledTaskStoreInstance();
            return writeJSON(res, 200, { success: true, tasks: sts?.listTasks?.() ?? [] });
          }
          case 'scheduledTask:get': {
            const sts = await getScheduledTaskStoreInstance();
            return writeJSON(res, 200, { success: true, task: sts?.getTask?.(args[0]) ?? null });
          }
          case 'scheduledTask:create': {
            const sts = await getScheduledTaskStoreInstance();
            try {
              const task = sts?.createTask?.(args[0]);
              const sched = await getSchedulerInstance();
              sched?.reschedule?.();
              return writeJSON(res, 200, { success: true, task });
            } catch (e: any) { return writeJSON(res, 200, { success: false, error: e.message }); }
          }
          case 'scheduledTask:update': {
            const sts = await getScheduledTaskStoreInstance();
            try {
              const task = sts?.updateTask?.(args[0], args[1]);
              const sched = await getSchedulerInstance();
              sched?.reschedule?.();
              return writeJSON(res, 200, { success: true, task });
            } catch (e: any) { return writeJSON(res, 200, { success: false, error: e.message }); }
          }
          case 'scheduledTask:delete': {
            const sched = await getSchedulerInstance();
            sched?.stopTask?.(args[0]);
            const sts = await getScheduledTaskStoreInstance();
            const result = sts?.deleteTask?.(args[0]);
            sched?.reschedule?.();
            return writeJSON(res, 200, { success: true, result });
          }
          case 'scheduledTask:toggle': {
            const sts = await getScheduledTaskStoreInstance();
            const task = sts?.toggleTask?.(args[0], args[1]);
            const sched = await getSchedulerInstance();
            sched?.reschedule?.();
            return writeJSON(res, 200, { success: true, task });
          }
          case 'scheduledTask:runManually': {
            const sched = await getSchedulerInstance();
            sched?.runManually?.(args[0])?.catch?.(() => {});
            return writeJSON(res, 200, { success: true });
          }
          case 'scheduledTask:stop': {
            const sched = await getSchedulerInstance();
            const result = sched?.stopTask?.(args[0]);
            return writeJSON(res, 200, { success: true, result });
          }
          case 'scheduledTask:listRuns': {
            const sts = await getScheduledTaskStoreInstance();
            return writeJSON(res, 200, { success: true, runs: sts?.listRuns?.(args[0], args[1], args[2]) ?? [] });
          }
          case 'scheduledTask:countRuns': {
            const sts = await getScheduledTaskStoreInstance();
            return writeJSON(res, 200, { success: true, count: sts?.countRuns?.(args[0]) ?? 0 });
          }
          case 'scheduledTask:listAllRuns': {
            const sts = await getScheduledTaskStoreInstance();
            return writeJSON(res, 200, { success: true, runs: sts?.listAllRuns?.(args[0], args[1]) ?? [] });
          }

          // ── IM Gateway ──
          case 'im:config:get': {
            const img = await getIMGatewayManagerInstance();
            if (!img) {
              // Return success:false so frontend doesn't overwrite Redux with empty config
              return writeJSON(res, 200, { success: false, error: 'IM Gateway not initialized yet' });
            }
            return writeJSON(res, 200, { success: true, config: img.getConfig() });
          }
          case 'im:config:set': {
            const img = await getIMGatewayManagerInstance();
            if (!img) {
              coworkLog('ERROR', 'sidecar', 'im:config:set failed: IMGatewayManager not initialized');
              return writeJSON(res, 200, { success: false, error: 'IM Gateway not initialized' });
            }
            img.setConfig(args[0]);
            return writeJSON(res, 200, { success: true });
          }
          case 'im:gateway:start': {
            const img = await getIMGatewayManagerInstance();
            if (!img) return writeJSON(res, 200, { success: false, error: 'IM Gateway not initialized' });
            try {
              img.setConfig({ [args[0]]: { enabled: true } });
              await img.startGateway(args[0]);
              return writeJSON(res, 200, { success: true });
            } catch (e: any) { return writeJSON(res, 200, { success: false, error: e.message }); }
          }
          case 'im:gateway:stop': {
            const img = await getIMGatewayManagerInstance();
            if (!img) return writeJSON(res, 200, { success: false, error: 'IM Gateway not initialized' });
            img.setConfig({ [args[0]]: { enabled: false } });
            await img.stopGateway(args[0]);
            return writeJSON(res, 200, { success: true });
          }
          case 'im:gateway:test': {
            const img = await getIMGatewayManagerInstance();
            coworkLog('INFO', 'sidecar', `im:gateway:test platform=${args[0]} override=${JSON.stringify(args[1])?.slice(0, 200)}`);
            if (!img) return writeJSON(res, 200, { success: false, error: 'IM Gateway not initialized' });
            try {
              const result = await img.testGateway(args[0], args[1]);
              return writeJSON(res, 200, { success: true, result });
            } catch (e: any) { return writeJSON(res, 200, { success: false, error: e.message }); }
          }
          case 'im:status:get': {
            const img = await getIMGatewayManagerInstance();
            if (!img) return writeJSON(res, 200, { success: false, error: 'IM Gateway not initialized' });
            return writeJSON(res, 200, { success: true, status: img.getStatus() });
          }

          // ── NoobClaw platform ──
          case 'noobclaw:set-auth-token': {
            const { setNoobClawAuthToken } = await import('./libs/claudeSettings');
            setNoobClawAuthToken?.(args[0]);
            // Previously this also started a dedicated SSE connection to
            // https://api.noobclaw.com/api/sse, but that endpoint does not
            // exist. Lucky bag / balance updates now come through the AI
            // chat-completion stream via coworkOpenAICompatProxy.
            return writeJSON(res, 200, { success: true });
          }
          case 'noobclaw:get-mac-address': {
            const os = require('os');
            const interfaces = os.networkInterfaces();
            for (const iface of Object.values(interfaces) as any[]) {
              for (const info of (iface || [])) {
                if (!info.internal && info.mac && info.mac !== '00:00:00:00:00:00') {
                  return writeJSON(res, 200, info.mac);
                }
              }
            }
            return writeJSON(res, 200, null);
          }
          case 'noobclaw:cache-avatar': {
            try {
              const avatarUrl = args[0];
              const avatarDir = path.join(getUserDataPath(), 'avatars');
              const fs = require('fs');
              fs.mkdirSync(avatarDir, { recursive: true });
              const ext = avatarUrl.includes('.png') ? '.png' : '.jpg';
              const localPath = path.join(avatarDir, `avatar${ext}`);
              const response = await fetch(avatarUrl);
              const buffer = Buffer.from(await response.arrayBuffer());
              fs.writeFileSync(localPath, buffer);
              return writeJSON(res, 200, { success: true, localPath });
            } catch (e: any) {
              return writeJSON(res, 200, { success: false, localPath: null });
            }
          }
          case 'noobclaw:get-cached-avatar': {
            const fs = require('fs');
            const avatarDir = path.join(getUserDataPath(), 'avatars');
            for (const ext of ['.png', '.jpg']) {
              const p = path.join(avatarDir, `avatar${ext}`);
              if (fs.existsSync(p)) return writeJSON(res, 200, `file://${p}`);
            }
            return writeJSON(res, 200, null);
          }

          // ── Browser Extension ──
          case 'extension:prompt-response': {
            const resolver = extensionPromptResolvers.get(args[0]);
            if (resolver) {
              resolver(args[1]);
              extensionPromptResolvers.delete(args[0]);
            }
            return writeJSON(res, 200, { success: true });
          }

          // ── Dialog ──
          case 'dialog:readFileAsDataUrl': {
            try {
              const fs = require('fs');
              const filePath = args[0];
              const data = fs.readFileSync(filePath);
              const ext = require('path').extname(filePath).toLowerCase();
              const mimeMap: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
              const mime = mimeMap[ext] || 'application/octet-stream';
              return writeJSON(res, 200, { success: true, dataUrl: `data:${mime};base64,${data.toString('base64')}` });
            } catch (e: any) {
              return writeJSON(res, 200, { success: false, error: e.message });
            }
          }

          // ── Scenario automation (XHS viral production etc.) ──
          case 'scenario:listScenarios': {
            try {
              const base = process.env.NOOBCLAW_API_BASE_URL || 'https://api.noobclaw.com';
              const r = await fetch(`${base}/api/viral/scenarios`);
              if (!r.ok) return writeJSON(res, 200, { scenarios: [] });
              return writeJSON(res, 200, await r.json());
            } catch { return writeJSON(res, 200, { scenarios: [] }); }
          }
          case 'scenario:listTasks':
          case 'scenario:getTask':
          case 'scenario:createTask':
          case 'scenario:getTaskDir':
          case 'scenario:updateTask':
          case 'scenario:deleteTask':
          case 'scenario:setActiveTask':
          case 'scenario:getActiveTask':
          case 'scenario:listDrafts':
          case 'scenario:deleteDraft':
          case 'scenario:markDraftPushed':
          case 'scenario:markDraftIgnored': {
            // Lazy-init the scenario task store (JSON file persistence)
            const scenarioTaskStore = require('./libs/scenario/taskStore');
            if (!scenarioTaskStore._loaded) {
              scenarioTaskStore.initTaskStore(getUserDataPath());
              scenarioTaskStore._loaded = true;
            }
            switch (channel) {
              case 'scenario:listTasks': return writeJSON(res, 200, scenarioTaskStore.listTasks());
              case 'scenario:getTask': return writeJSON(res, 200, scenarioTaskStore.getTask(args[0]));
              case 'scenario:createTask': {
                const newTask = scenarioTaskStore.createTask(args[0]);
                // Create output directory immediately
                try {
                  const { ensureTaskOutputDir } = require('./libs/scenario/artifactWriter');
                  ensureTaskOutputDir(newTask);
                } catch {}
                // ⭐ v2.4.31: pre-compute next_planned_run_at IMMEDIATELY
                // on create so the UI shows "下次运行: 今天 13:46" right
                // away instead of "即将（计算中）". Without this, the
                // value stays empty until the next scheduler tick (up to
                // 60s later) does the backfill.
                // v2.4.32: pass isFirstRun=true → first fire happens
                // INSIDE the first time bucket (e.g. 30min task → fire
                // within 0-30min, not 30-40min). For daily_random, fires
                // sometime today instead of tomorrow.
                try {
                  const sm = require('./libs/scenario/scenarioManager');
                  const interval = (newTask as any).run_interval || 'daily';
                  if (interval !== 'once') {
                    const planned = sm.computeNextPlannedRun(interval, newTask.daily_time, Date.now(), true);
                    const updated = scenarioTaskStore.updateTask(newTask.id, { next_planned_run_at: planned } as any);
                    if (updated) return writeJSON(res, 200, updated);
                  }
                } catch (e) {
                  // Non-fatal — scheduler will backfill on its next tick.
                  console.warn('[scenario:createTask] pre-compute next run failed:', e);
                }
                return writeJSON(res, 200, newTask);
              }
              case 'scenario:getTaskDir': {
                try {
                  // 先查【矩阵任务】(存在 matrix taskStore,不在老 scenario store)。矩阵各类任务输出落在
                  //   <matrixDir>/<bucket>/<平台>/:图文=drafts、视频下载=downloads、互动/回复=reports。
                  //   之前直接走老 store → 矩阵任务查不到 → 返回 dir:'' → 「打开输出文件夹」点了没反应(所有矩阵任务通病)。
                  try {
                    const mtStore = require('./libs/matrix/taskStore');
                    const mt = mtStore.getTask ? mtStore.getTask(args[0]) : null;
                    if (mt) {
                      const os = require('os'); const path = require('path'); const fs = require('fs');
                      const base = process.env.NOOBCLAW_MATRIX_DIR || path.join(os.homedir(), 'NoobClaw', 'matrix');
                      const bucket = mt.type === 'image_text' ? 'drafts' : mt.type === 'video_download' ? 'downloads' : 'reports';
                      const dir = path.join(base, bucket, mt.platform || '');
                      try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ } // 没跑过也能打开(空目录)
                      return writeJSON(res, 200, { dir });
                    }
                  } catch { /* 不是矩阵任务 → 回落老 store */ }
                  const { getTaskDirPath } = require('./libs/scenario/artifactWriter');
                  const task = scenarioTaskStore.getTask(args[0]);
                  if (!task) return writeJSON(res, 200, { dir: '' });
                  return writeJSON(res, 200, { dir: getTaskDirPath(task) });
                } catch { return writeJSON(res, 200, { dir: '' }); }
              }
              case 'scenario:updateTask': {
                const patch = args[1] || {};
                const before = scenarioTaskStore.getTask(args[0]);
                const updated = scenarioTaskStore.updateTask(args[0], patch);
                // ⭐ v2.4.31: if the user changed run_interval or
                // daily_time, recompute next_planned_run_at right away
                // so the UI reflects the new schedule instead of showing
                // the stale value picked under the old interval.
                if (updated && before) {
                  const intervalChanged = patch.run_interval !== undefined && patch.run_interval !== (before as any).run_interval;
                  const dailyTimeChanged = patch.daily_time !== undefined && patch.daily_time !== before.daily_time;
                  if (intervalChanged || dailyTimeChanged) {
                    try {
                      const sm = require('./libs/scenario/scenarioManager');
                      const interval = (updated as any).run_interval || 'daily';
                      if (interval !== 'once') {
                        // isFirstRun=true on interval change — treat as
                        // a fresh schedule under the new interval, so
                        // first fire happens inside the first new bucket.
                        const planned = sm.computeNextPlannedRun(interval, updated.daily_time, Date.now(), true);
                        const reUpdated = scenarioTaskStore.updateTask(updated.id, { next_planned_run_at: planned } as any);
                        if (reUpdated) return writeJSON(res, 200, reUpdated);
                      } else {
                        // 'once' — clear any stale next_planned_run_at so
                        // the UI doesn't show a misleading future time.
                        const reUpdated = scenarioTaskStore.updateTask(updated.id, { next_planned_run_at: undefined } as any);
                        if (reUpdated) return writeJSON(res, 200, reUpdated);
                      }
                    } catch (e) {
                      console.warn('[scenario:updateTask] reschedule failed:', e);
                    }
                  }
                }
                return writeJSON(res, 200, updated);
              }
              case 'scenario:deleteTask': return writeJSON(res, 200, scenarioTaskStore.deleteTask(args[0]));
              case 'scenario:setActiveTask': return writeJSON(res, 200, scenarioTaskStore.setActiveTask(args[0]));
              case 'scenario:getActiveTask': return writeJSON(res, 200, scenarioTaskStore.getActiveTask());
              case 'scenario:listDrafts': return writeJSON(res, 200, scenarioTaskStore.listDrafts(args[0]));
              case 'scenario:deleteDraft': return writeJSON(res, 200, scenarioTaskStore.deleteDraft(args[0]));
              case 'scenario:markDraftPushed': return writeJSON(res, 200, scenarioTaskStore.updateDraft(args[0], { status: 'pushed', pushed_at: Date.now() }));
              case 'scenario:markDraftIgnored': return writeJSON(res, 200, scenarioTaskStore.updateDraft(args[0], { status: 'ignored' }));
              default: return writeJSON(res, 200, null);
            }
          }
          case 'scenario:runTaskNow': {
            const scenarioTaskStore = require('./libs/scenario/taskStore');
            if (!scenarioTaskStore._loaded) {
              scenarioTaskStore.initTaskStore(getUserDataPath());
              scenarioTaskStore._loaded = true;
            }
            const task = scenarioTaskStore.getTask(args[0]);
            if (!task) return writeJSON(res, 200, { status: 'failed', reason: 'task_not_found' });
            try {
              const scenarioRiskGuard = require('./libs/scenario/riskGuard');
              if (!scenarioRiskGuard._loaded) {
                scenarioRiskGuard.initRiskGuard(getUserDataPath());
                scenarioRiskGuard._loaded = true;
              }
              const scenarioManager = require('./libs/scenario/scenarioManager');
              // Fire-and-forget: start the task in the background and return immediately.
              // The task runs for minutes (scroll + extract + compose). If we await here,
              // the HTTP request times out and the renderer gets ipc_error.
              // The renderer already polls getRunProgress() every 2s for live status.
              scenarioManager.runTask(task, true).then((result: any) => {
                coworkLog('INFO', 'sidecar-server', `scenario:runTaskNow completed`, {
                  taskId: args[0],
                  status: result?.status,
                  reason: result?.reason,
                  collected: result?.collected_count,
                  drafts: result?.draft_count,
                });
              }).catch((e: any) => {
                coworkLog('ERROR', 'sidecar-server', `scenario:runTaskNow threw`, { taskId: args[0], error: e.message || String(e) });
              });
              // Return immediately — UI tracks progress via getRunProgress polling
              return writeJSON(res, 200, { status: 'started' });
            } catch (e: any) {
              const reason = e.message || e.stack || String(e) || 'unknown_error';
              coworkLog('ERROR', 'sidecar-server', `scenario:runTaskNow threw`, { taskId: args[0], error: reason });
              return writeJSON(res, 200, { status: 'failed', reason });
            }
          }
          case 'scenario:uploadDraft': {
            // { taskId, draftId } — upload a single already-generated draft
            // to XHS draft box. Used by TaskDetailPage per-draft 📤 button.
            const scenarioTaskStore = require('./libs/scenario/taskStore');
            if (!scenarioTaskStore._loaded) {
              scenarioTaskStore.initTaskStore(getUserDataPath());
              scenarioTaskStore._loaded = true;
            }
            try {
              const scenarioManager = require('./libs/scenario/scenarioManager');
              const { taskId, draftId } = args[0] || {};
              if (!taskId || !draftId) {
                return writeJSON(res, 200, { status: 'failed', reason: 'missing_ids' });
              }
              // Fire-and-forget, same pattern as runTaskNow
              scenarioManager.uploadOneDraft(taskId, draftId).then((result: any) => {
                coworkLog('INFO', 'sidecar-server', `scenario:uploadDraft completed`, {
                  taskId, draftId, status: result?.status, reason: result?.reason,
                });
              }).catch((e: any) => {
                coworkLog('ERROR', 'sidecar-server', `scenario:uploadDraft threw`, {
                  taskId, draftId, error: e.message || String(e),
                });
              });
              return writeJSON(res, 200, { status: 'started' });
            } catch (e: any) {
              const reason = e.message || e.stack || String(e) || 'unknown_error';
              return writeJSON(res, 200, { status: 'failed', reason });
            }
          }
          case 'scenario:getRunningTaskId': {
            const scenarioManager = require('./libs/scenario/scenarioManager');
            return writeJSON(res, 200, { runningTaskId: scenarioManager.getRunningTaskId() });
          }
          case 'scenario:getRunningTaskIds': {
            // Twitter v1 concurrency: returns ALL running task ids
            // (can be > 1 when XHS task + Twitter task are both in flight).
            const scenarioManager = require('./libs/scenario/scenarioManager');
            return writeJSON(res, 200, { runningTaskIds: scenarioManager.getRunningTaskIds() });
          }
          case 'scenario:getConnectedExtensions': {
            // Used by the renderer to detect outdated extensions and prompt
            // the user to update. Returns [{id, version, tabCount}, ...].
            const { getConnectedExtensions } = require('./libs/browserBridge');
            return writeJSON(res, 200, { extensions: getConnectedExtensions() });
          }
          case 'scenario:getRunProgress': {
            const scenarioManager = require('./libs/scenario/scenarioManager');
            const taskId = args?.[0]?.taskId || undefined;
            return writeJSON(res, 200, scenarioManager.getRunProgress(taskId));
          }
          case 'scenario:getLatestRunRecord': {
            // v4.31.41: 给 UI 详情页用的 fallback 数据源 —— in-memory progress
            //   被 30s timer 清掉后,UI 仍能从 runRecords 持久化数据展示上次
            //   跑的步骤日志(随时进随时看,不依赖 polling 时机 / sidecar 进程
            //   生命周期)。
            const scenarioRunRecords = require('./libs/scenario/runRecords');
            const taskId = args?.[0]?.taskId;
            if (!taskId) return writeJSON(res, 200, null);
            const records = scenarioRunRecords.listRecords({ task_id: taskId });
            return writeJSON(res, 200, Array.isArray(records) && records.length > 0 ? records[0] : null);
          }
          case 'scenario:requestAbort': {
            const scenarioManager = require('./libs/scenario/scenarioManager');
            // ⚠️ HISTORICAL BUG (fixed in v2.4.19+): same as above — read
            // body?.taskId returned undefined, so requestAbort fell into
            // the back-compat "abort ALL running tasks" branch. THAT'S why
            // hitting Stop on one task killed both. The right field is
            // args[0].taskId.
            const taskId = args?.[0]?.taskId || undefined;
            scenarioManager.requestAbort(taskId);
            return writeJSON(res, 200, { ok: true });
          }
          case 'scenario:runStatus': {
            const scenarioRiskGuard = require('./libs/scenario/riskGuard');
            if (!scenarioRiskGuard._loaded) {
              scenarioRiskGuard.initRiskGuard(getUserDataPath());
              scenarioRiskGuard._loaded = true;
            }
            return writeJSON(res, 200, {
              runs: scenarioRiskGuard.getRuns(args[0]),
              cooldown_ends_at: scenarioRiskGuard.getCooldown(args[0]),
            });
          }
          case 'scenario:getAllRuns': {
            // Legacy lightweight runs from riskGuard (counts only). Kept
            // for back-compat with v2.4.20-2.4.21. New UI reads
            // `scenario:listRunRecords` instead which has full snapshots.
            const scenarioRiskGuard = require('./libs/scenario/riskGuard');
            if (!scenarioRiskGuard._loaded) {
              scenarioRiskGuard.initRiskGuard(getUserDataPath());
              scenarioRiskGuard._loaded = true;
            }
            return writeJSON(res, 200, { runs: scenarioRiskGuard.getAllRuns() });
          }
          case 'scenario:listRunRecords': {
            // Rich run records with full step logs + task snapshot.
            // Optional filter: { task_id?, platform? } to narrow down.
            const scenarioRunRecords = require('./libs/scenario/runRecords');
            scenarioRunRecords.initRunRecords(getUserDataPath());
            const filter = args?.[0] || undefined;
            return writeJSON(res, 200, { records: scenarioRunRecords.listRecords(filter) });
          }
          case 'scenario:getRunRecord': {
            const scenarioRunRecords = require('./libs/scenario/runRecords');
            scenarioRunRecords.initRunRecords(getUserDataPath());
            const recordId = args?.[0];
            return writeJSON(res, 200, { record: scenarioRunRecords.getRecord(recordId) });
          }
          case 'scenario:pushDraft': {
            const scenarioTaskStore = require('./libs/scenario/taskStore');
            if (!scenarioTaskStore._loaded) {
              scenarioTaskStore.initTaskStore(getUserDataPath());
              scenarioTaskStore._loaded = true;
            }
            const draft = scenarioTaskStore.getDraft(args[0]);
            if (!draft) return writeJSON(res, 200, { status: 'failed', error: 'draft_not_found' });
            try {
              const viralPool = require('./libs/scenario/viralPoolClient');
              const packRes = await viralPool.fetchScenarioPack(
                scenarioTaskStore.getTask(draft.task_id)?.scenario_id
              );
              if (!packRes?.manifest) return writeJSON(res, 200, { status: 'failed', error: 'scenario_pack_not_found' });
              const { uploadXhsDraft } = require('./libs/scenario/xhsDriver');
              const result = await uploadXhsDraft({
                manifest: packRes.manifest,
                variant: draft.variant,
                images: draft.source_post?.images || [],
              });
              if (result.status === 'ready_for_user') {
                scenarioTaskStore.updateDraft(args[0], { status: 'pushed', pushed_at: Date.now() });
              }
              return writeJSON(res, 200, result);
            } catch (e: any) {
              return writeJSON(res, 200, { status: 'failed', error: e.message || String(e) });
            }
          }
          case 'scenario:checkXhsLogin': {
            try {
              const { checkXhsLogin } = require('./libs/scenario/xhsDriver');
              const platform = (args && args[0]) as ('xhs' | 'x' | 'binance' | undefined);
              return writeJSON(res, 200, await checkXhsLogin(platform));
            } catch (e: any) {
              return writeJSON(res, 200, { loggedIn: false, reason: 'sidecar_error: ' + e.message });
            }
          }
          case 'scenario:openXhsLogin': {
            try {
              const { openXhsLogin } = require('./libs/scenario/xhsDriver');
              const platform = (args && args[0]) as ('xhs' | 'x' | 'binance' | undefined);
              return writeJSON(res, 200, await openXhsLogin(platform));
            } catch (e: any) {
              return writeJSON(res, 200, { ok: false, reason: e.message });
            }
          }
          case 'scenario:checkCreatorCenter': {
            try {
              const { checkCreatorCenter } = require('./libs/scenario/platformLoginDriver');
              const platform = (args && args[0]) as ('xhs' | 'douyin');
              return writeJSON(res, 200, await checkCreatorCenter(platform));
            } catch (e: any) {
              return writeJSON(res, 200, { loggedIn: false, reason: 'sidecar_error: ' + e.message });
            }
          }
          case 'scenario:openCreatorCenter': {
            try {
              const { openCreatorCenter } = require('./libs/scenario/platformLoginDriver');
              const platform = (args && args[0]) as ('xhs' | 'douyin');
              return writeJSON(res, 200, await openCreatorCenter(platform));
            } catch (e: any) {
              return writeJSON(res, 200, { ok: false, reason: e.message });
            }
          }
          // ── 视频发布前登录检查:必须在 sidecar 跑(扩展连接在这,task_open_tab 才到得了扩展)。
          //   之前只注册在没用的 Electron main.ts ipcMain,Tauri 包里调不到 → 一直失败回退多窗。
          case 'video:checkLoginByCookie': {
            try {
              const { checkVideoLoginByCookie } = require('./libs/video/videoLoginCheck');
              return writeJSON(res, 200, await checkVideoLoginByCookie(args && args[0], args && args[1]));
            } catch (e: any) { return writeJSON(res, 200, null); }
          }
          case 'video:checkLoginByCookieBatch': {
            try {
              const { checkVideoLoginByCookieBatch } = require('./libs/video/videoLoginCheck');
              return writeJSON(res, 200, await checkVideoLoginByCookieBatch((args && args[0]) || []));
            } catch (e: any) { return writeJSON(res, 200, {}); }
          }
          case 'video:openLoginInCheckWindow': {
            try {
              const { openLoginInCheckWindow } = require('./libs/video/videoLoginCheck');
              return writeJSON(res, 200, await openLoginInCheckWindow(String((args && args[0]) || '')));
            } catch (e: any) { return writeJSON(res, 200, { ok: false, diag: 'sidecar error: ' + e.message }); }
          }
          case 'video:closeLoginCheckWindow': {
            try {
              const { closeVideoCheckWindow } = require('./libs/video/videoLoginCheck');
              await closeVideoCheckWindow();
              return writeJSON(res, 200, { ok: true });
            } catch (e: any) { return writeJSON(res, 200, { ok: false }); }
          }

          default:
            coworkLog('WARN', 'sidecar-server', `Unhandled IPC channel: ${channel}`);
            return writeJSON(res, 200, null);
        }
      } catch (e) {
        coworkLog('ERROR', 'sidecar-server', `IPC error [${channel}]: ${e}`);
        return writeJSON(res, 500, { error: String(e) });
      }
    }

    if (pathname === '/api/ipc/send' && req.method === 'POST') {
      // Fire-and-forget IPC sends (no return value expected)
      return writeJSON(res, 200, { status: 'ok' });
    }

    // ── HTTP Proxy (bypass CORS for external API calls from Tauri WebView) ──
    if (pathname === '/api/proxy' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout
        const proxyRes = await fetch(body.url, {
          method: body.method || 'GET',
          headers: body.headers || {},
          body: body.body || undefined,
          signal: controller.signal,
        });
        clearTimeout(timeout);
        const responseBody = await proxyRes.text();
        return writeJSON(res, 200, { ok: proxyRes.ok, status: proxyRes.status, body: responseBody });
      } catch (e: any) {
        coworkLog('WARN', 'proxy', `Proxy failed for ${body.url}: ${e.message}`);
        return writeJSON(res, 200, { ok: false, status: 0, body: '', error: e.message });
      }
    }

    // ── Image Proxy (for <img> tags that can't load external URLs in Tauri WebView) ──
    if (pathname === '/api/img' && req.method === 'GET') {
      const imgUrl = url.searchParams.get('url');
      if (!imgUrl) { res.writeHead(400); res.end('Missing url param'); return; }
      try {
        const imgRes = await fetch(imgUrl);
        const contentType = imgRes.headers.get('content-type') || 'image/svg+xml';
        const buffer = Buffer.from(await imgRes.arrayBuffer());
        res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=86400' });
        res.end(buffer);
      } catch {
        res.writeHead(502); res.end('Failed to fetch image');
      }
      return;
    }

    // ── Diagnostic (for debugging macOS issues) ──
    if (pathname === '/api/diagnostic') {
      const runner = await getRunner();
      const diag: Record<string, unknown> = {
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        execPath: process.execPath,
        cwd: process.cwd(),
        pid: process.pid,
        uptime: process.uptime(),
        runnerReady: !!runner,
        sslRejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED,
      };
      // Test external HTTPS connectivity
      try {
        const testRes = await fetch('https://api.noobclaw.com/api/ticker');
        diag.httpsTest = { ok: testRes.ok, status: testRes.status };
      } catch (e: any) {
        diag.httpsTest = { ok: false, error: e.message };
      }
      // Check OpenAI proxy
      try {
        const { getCoworkOpenAICompatProxyStatus } = await import('./libs/coworkOpenAICompatProxy');
        diag.proxy = getCoworkOpenAICompatProxyStatus();
      } catch {}
      // Check API config
      try {
        const { getCurrentApiConfig } = await import('./libs/claudeSettings');
        const config = getCurrentApiConfig();
        diag.apiConfig = config ? { hasConfig: true, baseURL: config.baseURL, model: config.model, apiType: (config as any).apiType } : { hasConfig: false };
      } catch {}
      return writeJSON(res, 200, diag);
    }

    // ── Version ──
    if (pathname === '/api/version') {
      return writeJSON(res, 200, { version: '5.4.0', mode: 'tauri-sidecar' });
    }

    // ── 404 ──
    writeJSON(res, 404, { error: 'Not found', path: pathname });
  } catch (e) {
    coworkLog('ERROR', 'sidecar-server', `Request error: ${e}`);
    writeJSON(res, 500, { error: String(e) });
  }
});

// ── EARLY MOUNT: browser bridge + port 18801 bind ────────────────
// v5.x+: bridge handlers AND the listen() call run at module-load time,
// before any awaits. Previously these lived inside getRunner() which had
// to await 4 dynamic imports + a SQLite open first — a 200-1000ms window
// where the extension's auto-connect probe hit ECONNREFUSED, triggering
// WS cool-down and SSE fallback for the rest of the session.
//
// Symptom this fixes: "first install after a fresh Chrome boot needs me
// to click Reconnect once" — the extension's onInstalled / top-level
// connect() fired during the awaits window, all retries failed, alarm
// keepalive (30s+ on Chrome 116+) was too slow to recover before the
// service worker died, and the user had to manually wake it via popup.
//
// Safety: attachBrowserBridge is pure event-listener registration (sync,
// no I/O). The createServer 'request' callback registered above already
// handles non-bridge routes via lazy getRunner() — those still wait for
// the runner if a request lands during the boot window. Bridge traffic
// doesn't need the runner so it gets served immediately.
// ── Port reclaim (v2.8.1) ───────────────────────────────────────────────
// PORT (18801) is hard-coded and shared with the renderer's BASE_URL, so we
// cannot fall back to another port. On reinstall / crash / overlapping launch
// a stale noobclaw-server from a previous session can still hold it → bind
// fails EADDRINUSE → (previously) the process crashed (exit 91) and the Rust
// supervisor crash-looped until the old holder happened to die. The Win32
// job-object kill-on-close only covers the "main died" orphan case, not an old
// instance still alive during reinstall, and macOS has no equivalent at all.
// So on EADDRINUSE we forcibly kill whatever owns the port and retry — newest
// launch wins, fully self-healing, no user-visible banner needed.
function killPortHolders(port: number): number[] {
  const { execFileSync } = require('child_process') as typeof import('child_process');
  const selfPid = process.pid;
  const pids = new Set<number>();
  try {
    if (process.platform === 'win32') {
      // netstat lines: "  TCP  127.0.0.1:18801  ...  LISTENING  <pid>"
      const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true });
      for (const line of out.split(/\r?\n/)) {
        if (!new RegExp(`:${port}\\b`).test(line) || !/LISTENING/i.test(line)) continue;
        const m = line.trim().match(/(\d+)\s*$/);
        if (m) pids.add(parseInt(m[1], 10));
      }
    } else {
      // lsof -ti tcp:18801 -sTCP:LISTEN → newline-separated PIDs (exits 1 if none)
      const out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
      for (const tok of out.split(/\s+/)) {
        const n = parseInt(tok, 10);
        if (Number.isInteger(n)) pids.add(n);
      }
    }
  } catch {
    // netstat/lsof exit non-zero when nothing matches — treat as "no holder".
  }
  const killed: number[] = [];
  for (const pid of pids) {
    if (!pid || pid === selfPid) continue;
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true });
      } else {
        process.kill(pid, 'SIGKILL');
      }
      killed.push(pid);
    } catch {
      // already gone or no permission — ignore
    }
  }
  return killed;
}

if (!IS_NATIVE_MESSAGING_HOST) {
  try {
    attachBrowserBridge(server);
    cleanupLegacyNmResidueOnce().catch(() => {});

    let reclaimAttempts = 0;
    const MAX_RECLAIM = 3;
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err?.code === 'EADDRINUSE' && reclaimAttempts < MAX_RECLAIM) {
        reclaimAttempts++;
        const killed = killPortHolders(PORT);
        const msg = `port ${PORT} in use — reclaimed pid(s) [${killed.join(',')}], retry ${reclaimAttempts}/${MAX_RECLAIM}`;
        console.error(`[sidecar] ${msg}`);
        coworkLog('WARN', 'sidecar-server', msg);
        setTimeout(() => { try { server.listen(PORT, '127.0.0.1'); } catch { /* next error event handles it */ } }, 400);
        return;
      }
      // Unrecoverable (non-EADDRINUSE, or reclaim budget exhausted) — let the
      // supervisor see the crash and apply its own backoff/circuit-breaker.
      console.error('[sidecar] server error:', err?.stack || err);
      process.exit(91);
    });

    server.listen(PORT, '127.0.0.1', () => {
      console.log(`NoobClaw sidecar server listening on http://127.0.0.1:${PORT}`);
      coworkLog('INFO', 'sidecar-server', `Started on port ${PORT} (bridge mounted)`);
    });
  } catch (e: any) {
    coworkLog('ERROR', 'sidecar-server', `Early bridge mount failed: ${e?.message || e}`);
  }
}

// v2.6.3: the block below used to be the listen() callback; now it runs
// unconditionally at the end of the init script. Behaviour is the same —
// by the time we reach here all the modules below need are loaded.
if (!IS_NATIVE_MESSAGING_HOST) {
  // Start scenario scheduler (checks every 60s for auto-run tasks)
  // v4.31.32: 之前所有 init 步骤共用一个 try/catch,只要任何一步抛异常 →
  //   下面的 startScheduler() 永远不会执行,sidecar 还能跑(立即运行能用)
  //   但 scheduler 整个失踪,用户感知"任务到点不动"。现在每步独立 try,
  //   即便 store/riskGuard/runRecords init 失败 startScheduler 也照样调。
  {
    const { getUserDataPath } = require('./libs/platformAdapter');
    const userDataPath = getUserDataPath();
    try {
      const scenarioTaskStore = require('./libs/scenario/taskStore');
      if (!scenarioTaskStore._loaded) { scenarioTaskStore.initTaskStore(userDataPath); scenarioTaskStore._loaded = true; }
    } catch (e) {
      coworkLog('WARN', 'sidecar-server', 'scenarioTaskStore.initTaskStore failed', { err: String(e) });
    }
    try {
      const scenarioRiskGuard = require('./libs/scenario/riskGuard');
      if (!scenarioRiskGuard._loaded) { scenarioRiskGuard.initRiskGuard(userDataPath); scenarioRiskGuard._loaded = true; }
    } catch (e) {
      coworkLog('WARN', 'sidecar-server', 'scenarioRiskGuard.initRiskGuard failed', { err: String(e) });
    }
    try {
      const scenarioRunRecords = require('./libs/scenario/runRecords');
      scenarioRunRecords.initRunRecords(userDataPath);
    } catch (e) {
      coworkLog('WARN', 'sidecar-server', 'scenarioRunRecords.initRunRecords failed', { err: String(e) });
    }
    try {
      const scenarioManager = require('./libs/scenario/scenarioManager');
      // v4.31.45: 定时跑被 SKIPPED 时通过 SSE 推前端,UI 全局 toast 提示
      if (typeof scenarioManager.setOnScheduledSkipped === 'function') {
        scenarioManager.setOnScheduledSkipped((info: any) => {
          broadcastSSE('scenario:scheduledSkipped', info);
        });
      }
      // 矩阵 edition:不启动旧 scenario 定时调度,改启动矩阵自己的调度器(sidecar 侧,
      // 切到别的页面也不停;对齐老客户端「调度在主进程」而非渲染层)。
      if (MATRIX_EDITION) {
        // 启动时清理残留「运行中」:上次任务被中途中断 → 账号 status 卡 'running' 写进库,重启后一直显示运行中。
        try { const { resetRunningToIdle } = require('./libs/matrix/accountManager'); resetRunningToIdle(); } catch (e) { coworkLog('WARN', 'sidecar-server', 'resetRunningToIdle failed', { err: String(e) }); }
        try { startMatrixScheduler(); coworkLog('INFO', 'sidecar-server', 'Matrix scheduler started'); }
        catch (e) { coworkLog('ERROR', 'sidecar-server', 'startMatrixScheduler failed', { err: String(e) }); }
      } else {
        scenarioManager.startScheduler();
        coworkLog('INFO', 'sidecar-server', 'Scenario scheduler started');
      }
    } catch (e) {
      coworkLog('ERROR', 'sidecar-server', 'scenarioManager.startScheduler failed', { err: String(e) });
    }
  }

  // Install the crash reporter. Broadcasts system:crash SSE on
  // uncaughtException / unhandledRejection so the renderer can show
  // a toast; writes a ndjson record to {UserDataPath}/crashes/ so
  // the user can attach it to a bug report. See libs/crashReporter.ts
  try {
    const { installCrashReporter } = require('./libs/crashReporter');
    installCrashReporter((event: string, data: unknown) => broadcastSSE(event, data));
  } catch (e) {
    coworkLog('WARN', 'sidecar-server', `crashReporter install failed: ${e}`);
  }

  // Pre-warm Windows environment discovery caches (gitbash probe, registry
  // PATH reads, node shim creation, etc.) so the first Lark- or user-
  // triggered cowork session doesn't pay ~30s of execSync cost synchronously.
  // Fire and forget — the function schedules its work on setImmediate.
  try {
    const { warmEnhancedEnvCaches } = require('./libs/coworkUtil');
    warmEnhancedEnvCaches?.();
  } catch (e) {
    coworkLog('WARN', 'sidecar-server', `warmEnhancedEnvCaches failed to schedule: ${e}`);
  }

  // Pre-initialize runner immediately so data is ready when frontend connects
  getRunner().then(async (runner) => {
    if (runner) {
      coworkLog('INFO', 'sidecar-server', 'Runner pre-initialized successfully');

      // Reset orphan "running" sessions left over from a previous sidecar
      // that crashed or was killed mid-turn (e.g. the parent-watchdog
      // regression before commit a5b4e6e). Without this, sqlite still
      // says status='running', the frontend reads that on next app
      // launch, sets isStreaming=true, and the send button becomes
      // permanently disabled for that session — user types, hits enter,
      // and nothing happens because the UI thinks the session is still
      // in progress. Electron's main.ts:2875 does the same thing.
      try {
        const resetCount = runner.store?.resetRunningSessions?.() ?? 0;
        if (resetCount > 0) {
          coworkLog('INFO', 'sidecar-server', `Reset ${resetCount} orphan running session(s) to idle`);
        }
      } catch (e: any) {
        coworkLog('WARN', 'sidecar-server', `resetRunningSessions failed: ${e?.message || e}`);
      }
      // Pre-initialize IM, Skills, etc so they're ready when frontend loads
      try {
        const img = await getIMGatewayManagerInstance();
        coworkLog('INFO', 'sidecar-server', 'IM pre-initialized');
        // Auto-reconnect IM gateways that were enabled before restart.
        // Electron main.ts calls startAllEnabled() on startup; in Tauri mode
        // we must do the equivalent here, otherwise a user who had Lark/Feishu
        // enabled sees the toggle yellow ("enabled but not connected") forever
        // after an app restart.
        if (img?.startAllEnabled) {
          img.startAllEnabled().then(() => {
            coworkLog('INFO', 'sidecar-server', 'IM startAllEnabled complete');
          }).catch((e: any) => {
            coworkLog('WARN', 'sidecar-server', `IM startAllEnabled failed: ${e?.message || e}`);
          });
        }
      } catch {}
      try { await getSkillManagerInstance(); coworkLog('INFO', 'sidecar-server', 'Skills pre-initialized'); } catch {}
      try { await getMcpStoreInstance(); } catch {}
      try { await getScheduledTaskStoreInstance(); } catch {}
    } else {
      coworkLog('WARN', 'sidecar-server', 'Runner pre-initialization failed — will retry on first request');
    }
  }).catch(e => coworkLog('ERROR', 'sidecar-server', `Runner pre-init error: ${e}`));
}

// ── Helpers ──

function writeJSON(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Note: A dedicated NoobClaw SSE connection (https://api.noobclaw.com/api/sse)
// used to live here, but that endpoint does not exist on the backend and every
// attempt returned 404 — see cowork.log for the flood of "SSE connection failed:
// 404" warnings. Lucky bag + balance updates are injected INTO the AI chat
// completion stream by backend/src/routes/ai.ts, and forwarded to the frontend
// by coworkOpenAICompatProxy via _sseBroadcast('noobclaw:sse-payload', ...).
// That path is the only one that actually works, so the dead reconnect loop
// has been removed.

// ── Graceful shutdown ──

function shutdown() {
  coworkLog('INFO', 'sidecar-server', 'Shutting down...');
  // 退出前同步强杀所有指纹内核,别留孤儿窗口:mac 上 Tauri 杀 sidecar 不会级联杀内核子进程,
  // 不主动收就会残留(下次开同号还会撞锁报「打开个人资料出了点问题」)。kernelPool 已被矩阵流程
  // 加载过,import() 对已加载模块在下一微任务即 resolve,够快赶在 exit 前。
  import('./libs/matrix/kernelPool')
    .then((m) => { try { m.killAllKernelsSync(); } catch { /* ignore */ } })
    .catch(() => { /* ignore */ })
    .finally(() => { try { server.close(); } catch { /* ignore */ } process.exit(0); });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Monitor parent process exit via periodic check.
//
// Previously we used `process.ppid` and shut down as soon as one check
// failed. That caused real in-flight cowork sessions to be killed on
// Windows: Tauri's shell plugin can spawn the sidecar through a short-
// lived intermediate helper whose PID disappears immediately, so ppid
// points to a dead process and `process.kill(ppid, 0)` throws ESRCH
// within seconds of startup. The sidecar would then shut itself down
// mid-session, losing any Lark-triggered cowork runs (the user reported
// "从 Lark 发消息客户端不响应" — Lark dispatched fine, the cowork
// session started and even got a tool_use back, then 40s later the
// sidecar killed itself because it thought "parent" was gone).
//
// New behavior:
//   1. Prefer the --tauri-pid=<N> argument, which src-tauri/src/lib.rs
//      now passes explicitly as the real Tauri process PID.
//   2. Fall back to process.ppid only if the arg is missing (Electron
//      dev, standalone runs, etc.).
//   3. Poll every 10s, and require THREE consecutive failures before
//      shutting down, so transient Windows quirks don't terminate us.
//   4. Log which PID we're watching at startup so the next mystery
//      shutdown is immediately diagnosable.
const tauriPidArg = process.argv
  .slice(1)
  .find((a) => a.startsWith('--tauri-pid='));
const tauriPidFromArg = tauriPidArg
  ? parseInt(tauriPidArg.slice('--tauri-pid='.length), 10)
  : NaN;
const parentPid = Number.isFinite(tauriPidFromArg) && tauriPidFromArg > 1
  ? tauriPidFromArg
  : process.ppid;
coworkLog(
  'INFO',
  'sidecar-server',
  `Parent monitor: watching pid=${parentPid} (from ${Number.isFinite(tauriPidFromArg) ? '--tauri-pid' : 'process.ppid'})`
);
if (!IS_NATIVE_MESSAGING_HOST && parentPid && parentPid > 1) {
  let consecutiveMisses = 0;
  const PARENT_CHECK_INTERVAL_MS = 10_000;
  const PARENT_CHECK_MAX_MISSES = 3;
  const checkParent = setInterval(() => {
    try {
      process.kill(parentPid, 0); // signal 0 = liveness probe, no-op
      consecutiveMisses = 0;
    } catch {
      consecutiveMisses++;
      coworkLog(
        'WARN',
        'sidecar-server',
        `Parent pid ${parentPid} liveness probe failed (${consecutiveMisses}/${PARENT_CHECK_MAX_MISSES})`
      );
      if (consecutiveMisses >= PARENT_CHECK_MAX_MISSES) {
        coworkLog('INFO', 'sidecar-server', 'Parent process confirmed gone, exiting');
        clearInterval(checkParent);
        shutdown();
      }
    }
  }, PARENT_CHECK_INTERVAL_MS);
}

// sidecar 启动:清扫上次 app 残留的孤儿指纹内核(被强杀/崩溃后仍占着 profile 锁的僵尸窗)。
// 否则重开 app 那几个孤儿窗还在,点同一账号会撞锁 → 「打开您的个人资料时出了点问题」。
// best-effort,失败不影响启动;Windows 无孤儿(reapProfileHolder 内部直接跳过)。
if (!IS_NATIVE_MESSAGING_HOST) {
  void (async () => {
    try {
      const { loadAccounts } = await import('./libs/matrix/accountManager');
      const { reapOrphanKernels } = await import('./libs/matrix/kernelPool');
      const dirs = loadAccounts().map((a) => a.userDataDir).filter(Boolean);
      if (dirs.length) {
        await reapOrphanKernels(dirs);
        coworkLog('INFO', 'sidecar-server', `Startup orphan-kernel sweep done (${dirs.length} profiles)`);
      }
    } catch { /* ignore */ }
  })();
  // 主动保活续期:启动扫一遍 + 每 24h 扫一遍,对「超 5 天没活跃」的 idle 号 headless 访问续 cookie。
  void (async () => {
    try {
      const { startKeepAliveScheduler } = await import('./libs/matrix/keepAlive');
      startKeepAliveScheduler();
    } catch { /* ignore */ }
  })();
}

export { broadcastSSE, PORT };
