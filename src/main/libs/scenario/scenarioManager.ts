/**
 * Scenario Manager — top-level orchestrator for a scenario task run.
 *
 * Pipeline (3 visible steps):
 *   Step 1 · Discovery  — scroll XHS, find viral posts matching keywords
 *   Step 2 · Extraction — AI breaks down each post's structure
 *   Step 3 · Composition — AI rewrites in user's persona + save to disk
 *
 * Each step emits progress logs that the renderer polls via getRunProgress().
 */

import { powerSaveBlocker } from 'electron';
import { coworkLog } from '../coworkLogger';
import * as riskGuard from './riskGuard';
import * as taskStore from './taskStore';
import * as viralPoolClient from './viralPoolClient';
import { runOrchestrator } from './phaseRunner';
import { sendBrowserCommand } from '../browserBridge';
import {
  isKnownSubPlatform,
  subPlatformLabel,
} from './subPlatformRegistry';
import type {
  Draft,
  ScenarioManifest,
  ScenarioPack,
  ScenarioTask,
} from './types';

// ── Sleep prevention (v5.x+) ─────────────────────────────────────────
// Mirrors what the chrome extension does (chrome.power.requestKeepAwake)
// so the OS doesn't suspend the Electron main process either while a
// scenario task is running. Without this, idle-driven system sleep
// freezes the orchestrator mid-flight (browser commands timeout, AI calls
// abort, etc.). 'prevent-app-suspension' = same semantics as
// chrome.power('system'): keeps system active, lets the screen turn off
// normally (battery friendly).
//
// Refcounted so multiple parallel tasks (XHS + Twitter etc.) keep one
// blocker alive across the union of their runtimes — released the
// moment the last task exits.
//
// Boundaries we CAN'T fight: explicit user "Sleep" click, laptop lid
// close, critical battery — all hardware/UX driven by the user, not
// power policy.
let _powerBlockerId: number | null = null;
let _activeTaskCount = 0;
function acquireKeepAwake(): void {
  _activeTaskCount++;
  if (_powerBlockerId === null) {
    try {
      _powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    } catch (e) {
      coworkLog('WARN', 'scenarioManager', 'powerSaveBlocker.start failed: ' + (e as any)?.message);
    }
  }
}
function releaseKeepAwake(): void {
  _activeTaskCount = Math.max(0, _activeTaskCount - 1);
  if (_activeTaskCount === 0 && _powerBlockerId !== null) {
    try {
      powerSaveBlocker.stop(_powerBlockerId);
    } catch (e) {
      coworkLog('WARN', 'scenarioManager', 'powerSaveBlocker.stop failed: ' + (e as any)?.message);
    }
    _powerBlockerId = null;
  }
}

// DOM-failure incident report (v6.x+): only fire for failures that smell
// like a DOM/selector breakage so engineers see actionable signal in
// Lark. Network, abort, balance, AI-quota, and browser-disconnect
// failures are exempt — they have nothing to do with website DOM
// changes. v5.x used the same gate to decide whether to burn LLM tokens
// auto-fixing the orchestrator; v6.x uses it to decide whether to send
// an incident report (cheap, but still avoid noise).
function shouldReportIncident(reason?: string): boolean {
  if (!reason) return false;
  if (/user_stopped|aborted|scenario_pack_not_found|no_local_images|insufficient_balance|quota|rate_limit|ECONN|fetch_failed|AI_PARSE_FAIL|AI_EMPTY|BROWSER_NOT_CONNECTED/i.test(reason)) {
    return false;
  }
  return /selector|element|not[\s_-]?found|not[\s_-]?visible|TIMEOUT|missing|click.*fail|type.*fail|fill.*fail/i.test(reason);
}

const packCache = new Map<string, ScenarioPack>();

// v5.x+: app_config 访问器(由 main.ts 初始化时注入)。orchestrator 启动时
// 把 app_config.language 送进 ctx.appLocale,让 x_post_creator / x_link_rewrite
// /  binance_from_x_repost 等用客户端 i18n 决定输出语言,不再被浏览器 locale
// 牵着走。中文客户端 + 英文 Chrome 这种很常见的组合下,之前 navigator.language
// 检出 en → 推特发出来全英文,跟用户预期反着。
let appConfigGetter: (() => any) | null = null;

export function setAppConfigGetter(fn: () => any): void {
  appConfigGetter = fn;
}

function readAppLocale(): string {
  if (!appConfigGetter) return '';
  try {
    const cfg = appConfigGetter();
    return (cfg && typeof cfg.language === 'string') ? cfg.language : '';
  } catch { return ''; }
}

async function loadPack(scenario_id: string): Promise<ScenarioPack | null> {
  // Always fetch fresh from backend — scripts, prompts, config
  // can be hot-updated on the server without client rebuild.
  viralPoolClient.clearScenarioPackCache();
  const raw = await viralPoolClient.fetchScenarioPack(scenario_id);
  if (!raw || !raw.manifest) return null;
  const pack: ScenarioPack = {
    manifest: raw.manifest as ScenarioManifest,
    scripts: raw.scripts || {},
    prompts: raw.prompts || {},
    config: raw.config || {},
    orchestrator: raw.orchestrator || '',
    upload_draft_script: raw.upload_draft_script || '',
    draft_uploader: raw.draft_uploader || null,
  };
  packCache.set(scenario_id, pack);
  return pack;
}

export function clearPackCache(): void {
  packCache.clear();
  viralPoolClient.clearScenarioPackCache();
}

export interface RunOutcome {
  status: 'ok' | 'skipped' | 'failed';
  reason?: string;
  collected_count?: number;
  draft_count?: number;
  /** Per-action successful counts for this run (like / follow / comment /
   *  reply / post / etc.) — populated from ctx.addActionCount() in the
   *  orchestrator. Surfaces on the task detail page as "累计完成" /
   *  "上次完成". Undefined for pre-rollout runs. */
  action_counts?: Record<string, number>;
  drafts?: Draft[];
  // v4.25.35: 'resource_busy' 跳过时,把人话信息一起带给 UI(平台名 + 占用任务名)。
  // 让 toast 能显示"该任务需要推特+币安广场都空闲,目前 'XXX' 任务在运行,请先关闭"
  // 而不是 "已跳过: resource_busy:tab:^https?://..." 这种不可读字符串。
  busy_platforms?: string[];   // ['推特', '币安广场']
  busy_task_name?: string;     // 占用资源的那个任务名
}

// ── Progress tracking ──

export interface ProgressLog {
  time: string;         // "10:44:56"
  status: 'done' | 'running' | 'error';
  message: string;
}

export interface StepProgress {
  name: string;
  status: 'waiting' | 'running' | 'done' | 'error';
  logs: ProgressLog[];
}

export interface RunProgress {
  taskId: string;
  status: 'idle' | 'running' | 'done' | 'error';
  currentStep: number;   // 0=not started, 1/2/3
  steps: StepProgress[];
  error?: string;
  /** Live per-action progress for the running task, keyed by free-form
   *  action type ('like' / 'follow' / 'subscribe' / 'comment' / 'reply' /
   *  'post'). Populated when the orchestrator calls ctx.setActionTargets
   *  at start + ctx.addActionCount per action. TaskDetailPage renders a
   *  glowing "本次运行进度" card with "X/Y" lines while status='running'.
   *  Stays undefined for scenarios that don't report targets. */
  action_progress?: Record<string, { done: number; target: number }>;
  /** Live running-only tally of AI tokens consumed + matching USD cost
   *  for THIS run. Mirrored from the same per-task accumulators that get
   *  persisted into the run record at task end. TaskDetailPage shows a
   *  glowing "本次消耗" card next to "本次运行进度" while status='running'
   *  so the user can watch the running cost climb in real time. */
  tokens_used?: number;
  cost_usd?: number;
}

// Per-task progress + abort flag.
//
// PRE-Twitter v1 these were single globals — fine when only one task ran at
// a time. With cross-platform concurrency (an XHS task and a Twitter task
// targeting different browser tabs running in parallel), the second
// initProgress() would clobber the first's state, the renderer's poll
// would see the wrong task's progress in BOTH detail pages, and stop on
// task A would also abort task B. Switching to per-task Maps fixes all of
// that — every task has its own RunProgress + its own abort flag.
const progressByTaskId: Map<string, RunProgress> = new Map();
const abortByTaskId: Map<string, boolean> = new Map();
// Per-task run record id (the row in scenario_run_records.json that we're
// currently appending step logs to). Set by startTaskRecord() right after
// initProgress(), read by stepLog/finishProgress to mirror updates into
// the persistent record. Cleared on task end.
const recordIdByTaskId: Map<string, string> = new Map();

// v2.4.35+: accumulated AI usage per task. phaseRunner's aiCall reports
// per-call tokens + server-precomputed USD cost after each successful
// call; we sum both and write into the run record at task end so the
// history page can show "Tokens 12,345 · ≈ $0.025".
//
// Both values come from the real backend: tokens = usage.total_tokens,
// cost = _noobclaw.costUsd (backend multiplies billable_tokens by
// system_config.token_price_per_million — authoritative, no client-side
// hardcoded rate).
const tokensByTaskId: Map<string, number> = new Map();
const costUsdByTaskId: Map<string, number> = new Map();

function now(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function initProgress(taskId: string, scenarioId?: string): void {
  // Step labels are XHS-style by default (历史默认),scenarioId-specific
  // overrides 让其它场景显示更贴切的标签。新场景如有需要在 SCENARIO_STEP_NAMES
  // 里加一项即可,缺省回退到默认 4 步。
  const SCENARIO_STEP_NAMES: Record<string, string[]> = {
    douyin_image_text: [
      'AI根据参考文案创作文章。请勿切换浏览器标签页。',
      'AI 改写为抖音图文笔记，保存到本地',
      'AI 生成封面图 + 内容图',
      '上传到抖音创作者中心并发布。请勿切换浏览器标签页。',
    ],
    // 视频号图文 = 4 步,落地视频号助手(channels.weixin.qq.com)。
    shipinhao_image_text: [
      'AI 根据灵感段创作视频号图文。请勿切换浏览器标签页。',
      'AI 改写为视频号图文，保存到本地',
      'AI 生成内容图，保存到本地',
      '发表到视频号助手（存草稿 / 发布）。请勿切换浏览器标签页。',
    ],
    // 头条号「微头条」= 4 步(v1.1.0 起接 AI 生图 + 上传):创作→改写→生图→发布。
    toutiao_image_text: [
      'AI 根据灵感段创作微头条。请勿切换浏览器标签页。',
      'AI 改写为微头条正文，保存到本地',
      'AI 生成内容图，保存到本地',
      '发布到头条号（微头条，上传图 + 正文，存草稿 / 发布）。请勿切换浏览器标签页。',
    ],
  };
  const stepNames = (scenarioId && SCENARIO_STEP_NAMES[scenarioId]) || [
    '采集爆款文章。请勿切换浏览器标签页。',
    'AI 改写标题和内容，保存到本地',
    'AI 生成配图',
    '上传到小红书草稿箱。请勿切换浏览器标签页。',
  ];
  progressByTaskId.set(taskId, {
    taskId,
    status: 'running',
    currentStep: 0,
    steps: stepNames.map(name => ({ name, status: 'waiting' as const, logs: [] })),
  });
  abortByTaskId.set(taskId, false);
}

function stepStart(taskId: string, step: number): void {
  const p = progressByTaskId.get(taskId);
  if (!p) return;
  p.currentStep = step;
  p.steps[step - 1].status = 'running';
}

function stepLog(taskId: string, step: number, status: 'done' | 'running' | 'error', message: string): void {
  const p = progressByTaskId.get(taskId);
  if (!p) return;
  const logs = p.steps[step - 1].logs;
  // Always append — UI shows a live timeline of what's happening.
  // Keep max 30 entries to avoid memory bloat on long runs.
  if (logs.length >= 30) logs.shift();
  const time = now();
  logs.push({ time, status, message });
  // Mirror into the persistent run record so historical viewing has the
  // full step log timeline (the in-memory progress is capped at 30 lines
  // and gets dropped 30s after task end; runRecords keeps everything).
  const recordId = recordIdByTaskId.get(taskId);
  if (recordId) {
    try {
      const runRecords = require('./runRecords');
      runRecords.appendStepLog(recordId, { time, step, status, message });
    } catch { /* non-fatal */ }
  }
}

function stepDone(taskId: string, step: number): void {
  const p = progressByTaskId.get(taskId);
  if (!p) return;
  p.steps[step - 1].status = 'done';
}

/** v5.x+: action-boundary marker for iterative steps (e.g. X auto-engage's
 *  step 2 doing 30 follow/reply/like actions in a row). Clears the in-
 *  memory step logs and seeds them with `label` so the UI shows ONLY the
 *  current action's progress instead of a 30-action backlog (which
 *  overflowed the 30-line cap and made it impossible to see what's
 *  happening right now).
 *
 *  The persistent run record (runRecords.appendStepLog) keeps the full
 *  pre-clear log timeline — history view is unaffected. Live and history
 *  views diverge intentionally: live = "what's happening now", history =
 *  "what happened across the whole run".
 *
 *  Orchestrators opt in by calling ctx.startAction(label) at the top of
 *  each iteration; orchestrators that don't call it keep the old
 *  accumulating behavior (backwards compatible). */
function stepActionBoundary(taskId: string, step: number, label: string): void {
  const p = progressByTaskId.get(taskId);
  if (!p) return;
  const stepIdx = step - 1;
  if (!p.steps[stepIdx]) return;
  // Wipe live logs and seed with the action header.
  p.steps[stepIdx].logs = [];
  const time = now();
  p.steps[stepIdx].logs.push({ time, status: 'running', message: label });
  // Mirror the marker into the run record so the persistent timeline
  // visually separates one iteration from the next ("─── action 1 ───").
  const recordId = recordIdByTaskId.get(taskId);
  if (recordId) {
    try {
      const runRecords = require('./runRecords');
      runRecords.appendStepLog(recordId, { time, step, status: 'running', message: label });
    } catch { /* non-fatal */ }
  }
}

/** v2.7+: clear live logs across ALL steps in one shot. Top-level iterative
 *  scenarios (binance_from_x_link 5 URLs / binance_from_x_repost) call this
 *  between iterations so step 2/3/4 cards aren't crowded with the prior
 *  URL's logs. Persistent run record is unaffected — only the live in-memory
 *  buffer per step is wiped. The orchestrator follows up with a stepLog on
 *  step 1 to set the "📦 第 N/M 条 开始" header. */
function stepResetAll(taskId: string): void {
  const p = progressByTaskId.get(taskId);
  if (!p) return;
  for (const s of p.steps) {
    if (s) s.logs = [];
  }
}

/** Set the per-type planned target. Called once near the start of a run
 *  after the orchestrator picks daily caps (e.g. nLike from a random
 *  range). Multiple calls overwrite — last write wins. */
function setActionTarget(taskId: string, type: string, target: number): void {
  const p = progressByTaskId.get(taskId);
  if (!p || !type) return;
  if (!p.action_progress) p.action_progress = {};
  const cur = p.action_progress[type] || { done: 0, target: 0 };
  p.action_progress[type] = { done: cur.done, target: Math.max(0, Math.floor(Number(target) || 0)) };
  mirrorActionProgressToRecord(taskId);
}

/** Bump the per-type done counter. Called after each successful action so
 *  the UI's running-glow card ticks up live (0/60 → 1/60 → 2/60 …). */
function bumpActionProgress(taskId: string, type: string, n: number = 1): void {
  const p = progressByTaskId.get(taskId);
  if (!p || !type) return;
  if (!p.action_progress) p.action_progress = {};
  const cur = p.action_progress[type] || { done: 0, target: 0 };
  p.action_progress[type] = { done: cur.done + (Number(n) || 0), target: cur.target };
  mirrorActionProgressToRecord(taskId);
}

/** Mirror live action_progress + tokens/cost into the in-flight run record
 *  so the Run History list can render "X/Y · 💎 N" for the running row
 *  via the same listRunRecords IPC the completed rows use. Without this
 *  mirror, action_counts / action_targets only landed on the record at
 *  task end (via updateTaskRecordResult), and the running row showed
 *  nothing while the task was actively engaging.
 *
 *  Lightweight: updateRecordResult merges into rec.result and schedules a
 *  debounced persist — no per-call disk flush. With per-action bumps
 *  arriving every few seconds the batched persist coalesces multiple
 *  updates into one write. */
function mirrorActionProgressToRecord(taskId: string): void {
  const recordId = recordIdByTaskId.get(taskId);
  if (!recordId) return;
  const p = progressByTaskId.get(taskId);
  if (!p?.action_progress) return;
  const counts: Record<string, number> = {};
  const targets: Record<string, number> = {};
  for (const [k, v] of Object.entries(p.action_progress)) {
    // Keep zero-done keys so the row stays balanced (e.g. "👍 0/5 ·
    // ➕ 0/3 · 💬 0/2") even before any action lands. action_counts
    // already includes 0-done from the final backfill on stop/error
    // paths; mirroring 0s here keeps the display consistent during
    // and after the run.
    counts[k] = v.done || 0;
    if ((v.target || 0) > 0) targets[k] = v.target;
  }
  try {
    const runRecords = require('./runRecords');
    if (typeof runRecords.updateRecordResult === 'function') {
      runRecords.updateRecordResult(recordId, {
        action_counts: Object.keys(counts).length > 0 ? counts : undefined,
        action_targets: Object.keys(targets).length > 0 ? targets : undefined,
      });
    }
  } catch { /* non-fatal — run continues, list page just won't have live counts */ }
}

/** Mirror live tokens/cost into the in-flight run record. Same rationale
 *  as mirrorActionProgressToRecord — keeps the Run History row's 💎 N
 *  ≈ $Y indicator live while the task is running. Called from the
 *  addTokensUsed callbacks each time the AI server reports a billable
 *  response. */
function mirrorTokensToRecord(taskId: string, tokensUsed: number, costUsd: number): void {
  const recordId = recordIdByTaskId.get(taskId);
  if (!recordId) return;
  try {
    const runRecords = require('./runRecords');
    if (typeof runRecords.updateRecordResult === 'function') {
      runRecords.updateRecordResult(recordId, {
        tokens_used: tokensUsed,
        cost_usd: costUsd,
      });
    }
  } catch { /* non-fatal */ }
}

function stepError(taskId: string, step: number, error: string): void {
  const p = progressByTaskId.get(taskId);
  if (!p) return;
  p.steps[step - 1].status = 'error';
  stepLog(taskId, step, 'error', error);
}

/**
 * Finalize the in-memory progress + mirror to persistent run record.
 *
 * `status` from the orchestrator can be:
 *   'done'    — everything the task tried to do succeeded
 *   'partial' — task ran to completion but some sub-items failed (e.g.
 *               2/5 tweets posted, 3/5 hit AI_PARSE_FAIL). Pre-v2.4.26
 *               this case was bucketed as 'done' and the user couldn't
 *               tell a half-broken run from a fully-successful one in
 *               the history list.
 *   'error'   — task aborted before producing anything useful, or a
 *               hard infra error (no_urls / anomaly / scenario_not_found
 *               / user_stopped — the latter remaps to 'stopped').
 *
 * The in-memory RunProgress only has 'done'/'error' (UI uses a green
 * check vs red X badge for the live progress panel). 'partial' is
 * recorded as 'done' there but as 'partial' in the persistent record,
 * which is what the History page reads.
 */
function finishProgress(taskId: string, status: 'done' | 'error' | 'partial', error?: string): void {
  const p = progressByTaskId.get(taskId);
  if (!p) return;
  // Map 'partial' → 'done' for the live progress panel (it only knows
  // happy/sad). The history record below preserves the distinction.
  p.status = status === 'error' ? 'error' : 'done';
  // v5.x+: orchestrator 调 ctx.finish('done', msg) 时,msg 是成功摘要不是
  // 错误。之前无脑写到 p.error → UI "成功" 卡片下方挂着 "错误: 1/1 条搬运
  // 发布成功" 这种自相矛盾的红字。改成只在真正失败时写 error,成功路径
  // 留给 summary 字段。
  if (error) {
    if (status === 'error') p.error = error;
    // 'done' / 'partial' 的 msg 不写到 p.error;summary 走 finishRecord 持久化
  }
  // Mirror into the persistent run record. user_stopped → 'stopped' so
  // the history page can distinguish "I cancelled it" from "it errored".
  const recordId = recordIdByTaskId.get(taskId);
  if (recordId) {
    try {
      const runRecords = require('./runRecords');
      let recStatus: 'done' | 'partial' | 'error' | 'stopped';
      if (status === 'done') recStatus = 'done';
      else if (status === 'partial') recStatus = 'partial';
      else if (error === 'user_stopped') recStatus = 'stopped';
      else recStatus = 'error';
      // 路由:成功状态(done/partial) → summary;失败/中止(error/stopped) → error
      const isSuccess = recStatus === 'done' || recStatus === 'partial';
      runRecords.finishRecord(recordId, {
        status: recStatus,
        error: isSuccess ? undefined : error,
        summary: isSuccess ? error : undefined,
      });
    } catch { /* non-fatal */ }
  }
}

/** Open a new run record entry for this task and remember its id so
 *  later stepLog/finish calls can mirror into the persistent log.
 *  Called from runTask AFTER initProgress + pack load. Idempotent —
 *  safe to call when no scenario yet (just won't record). */
function startTaskRecord(task: ScenarioTask, scenario: any): void {
  try {
    const runRecords = require('./runRecords');
    const { getTaskOutputDir } = require('./artifactWriter');
    const { getUserDataPath } = require('../platformAdapter');
    // ⭐ v4.22.x defensive init. Bug from user 2026-04-22: a freshly-
    // created task's runs hit riskGuard (累计采集 visible) but never
    // appeared in runRecords history. Root cause hypothesis: the
    // sidecar bootstrap path that calls scenarioRunRecords.initRunRecords
    // hadn't run yet (e.g. another runTask started concurrently before
    // bootstrap finished, or the user's app session was a hot-reload
    // that skipped bootstrap). startRecord then no-ops because _loaded
    // is false → silent data loss.
    //
    // Defense: ALWAYS call initRunRecords() here. It's idempotent
    // (gated by _initOnce internally) — second call is a no-op except
    // for setting _loaded=true if it slipped through.
    try {
      runRecords.initRunRecords(getUserDataPath());
    } catch (initErr) {
      coworkLog('WARN', 'scenarioManager', 'startTaskRecord: init failed', { err: String(initErr) });
    }
    let outputDir: string | undefined;
    // Pass platform so Twitter tasks land in 推特/, not 小红书/.
    const platform = scenario?.platform || 'xhs';
    try { outputDir = getTaskOutputDir(task, platform); } catch { /* ignore */ }
    const recordId = runRecords.startRecord({
      task,
      scenario: scenario ? {
        id: scenario.id,
        platform: scenario.platform || '',
        name_zh: scenario.name_zh,
        name_en: scenario.name_en,
        icon: scenario.icon,
        workflow_type: scenario.workflow_type,
      } : null,
      output_dir: outputDir,
    });
    if (recordId) {
      recordIdByTaskId.set(task.id, recordId);
      coworkLog('INFO', 'scenarioManager', 'runRecord created', {
        taskId: task.id, recordId, platform, scenarioId: scenario?.id,
      });
    } else {
      // recordId === '' means runRecords._loaded was false → data loss.
      // Loud warning so this stops being silent.
      coworkLog('ERROR', 'scenarioManager', 'startTaskRecord: startRecord returned EMPTY id — runRecords not loaded? Task run will NOT appear in history.', {
        taskId: task.id, platform, scenarioId: scenario?.id,
      });
    }
  } catch (e) {
    coworkLog('WARN', 'scenarioManager', 'startTaskRecord failed', { err: String(e) });
  }
}

/** Update the run record's result counts at task end (collected/draft etc.) */
function updateTaskRecordResult(taskId: string, result: any): void {
  const recordId = recordIdByTaskId.get(taskId);
  if (!recordId) return;
  try {
    const runRecords = require('./runRecords');
    // v2.4.35+: attach accumulated token usage + USD cost. Both summed
    // from per-call values the backend reports (cost uses real
    // system_config price — no hardcoded rate on the client).
    const tokens = tokensByTaskId.get(taskId) || 0;
    const costUsd = costUsdByTaskId.get(taskId) || 0;
    // Build the result payload, but DO NOT include action_counts /
    // action_targets keys when they're undefined — the live mirror
    // (mirrorActionProgressToRecord) has been writing real values into
    // rec.result.action_counts throughout the run; passing the key with
    // value undefined here would let runRecords' merge see it and (in
    // older spread-based code) wipe the mirrored counts. Even with the
    // mergeDefined guard in runRecords, keeping undefined off the wire
    // is cleaner and one less footgun.
    const resultPayload: any = {
      collected_count: result.collected_count,
      draft_count: result.draft_count,
      posted: result.posted,
      tokens_used: tokens,
      cost_usd: costUsd,
      ...result,
    };
    // v5.x+: action_counts is forwarded straight through so the task
    // detail page can aggregate "累计完成" / "上次完成". action_targets
    // is the planned quota (set via ctx.setActionTargets). Both come
    // from `result` via the spread above when present; strip the key
    // entirely (don't leave it as undefined) when not.
    if (resultPayload.action_counts === undefined) delete resultPayload.action_counts;
    if (resultPayload.action_targets === undefined) delete resultPayload.action_targets;
    runRecords.finishRecord(recordId, {
      // Don't change status here — finishProgress already set it. We're
      // just adding the result counts.
      status: undefined as any,
      result: resultPayload,
    });
  } catch { /* non-fatal */ }
}

/**
 * Returns progress for a specific task. If `taskId` omitted (legacy callers),
 * returns the first running task's progress as a back-compat fallback —
 * but new callers should always pass taskId so the renderer's two open
 * detail pages each see their own task's state.
 */
export function getRunProgress(taskId?: string): RunProgress | null {
  if (taskId) return progressByTaskId.get(taskId) || null;
  // Back-compat: prefer a task that's still running
  for (const p of progressByTaskId.values()) {
    if (p.status === 'running') return p;
  }
  // Fall through to any (could be a recently-finished one we kept around)
  const first = progressByTaskId.values().next();
  return first.done ? null : first.value;
}

/** Per-task abort. Stop button on Task A no longer also kills Task B. */
export function requestAbort(taskId?: string): void {
  if (taskId) {
    abortByTaskId.set(taskId, true);
    coworkLog('INFO', 'scenarioManager', `requestAbort scoped to ONE task`, {
      taskId,
      otherRunningTasks: Array.from(abortByTaskId.keys()).filter(k => k !== taskId),
    });
    return;
  }
  // Back-compat path (caller didn't pass taskId — should be rare now,
  // every UI path passes task.id). We log loudly because aborting all
  // tasks is a much bigger deal than aborting one.
  coworkLog('WARN', 'scenarioManager', `requestAbort with NO taskId — aborting ALL ${abortByTaskId.size} running tasks`, {
    affectedTaskIds: Array.from(abortByTaskId.keys()),
  });
  for (const id of abortByTaskId.keys()) abortByTaskId.set(id, true);
}

/** Called by orchestrator inside loops to check if user hit stop. */
export function isAbortRequested(taskId?: string): boolean {
  if (taskId) return abortByTaskId.get(taskId) === true;
  // Back-compat: ANY task aborted? (Old callers without per-task scope)
  for (const v of abortByTaskId.values()) if (v) return true;
  return false;
}

// ── Concurrency control (Twitter v1: per-tab-resource gating) ─────────────
//
// Pre-Twitter we had a single `runningTaskId` global mutex — only one task
// at a time, period. With multi-tab routing landed in Sprint 1.2, an XHS
// task and a Twitter task can target different Chrome tabs, so they don't
// actually compete for the same browser surface and CAN run in parallel.
//
// Resource keys:
//   'tab:default'                        — scenarios with no tab_url_pattern
//                                          (legacy XHS scenarios). Stay
//                                          serial because they all target
//                                          whatever the active tab is.
//   'tab:<pack.manifest.tab_url_pattern>' — scenarios with a pattern. Two
//                                          tasks on the same pattern still
//                                          serialize (same browser tab); two
//                                          tasks on different patterns run
//                                          concurrently.
//
// MAX_CONCURRENT_TASKS bounds the total — even with N different patterns,
// we won't melt the user's machine. v4.23.x bumps this from 2 → 3 so
// users can run XHS + X + Binance Square in parallel (one task per
// platform), since each platform has a distinct tab_url_pattern and
// therefore its own resource lane.
//
// v5.x+: bumped 3 → 6 to cover the full platform set (XHS / X / Binance /
// YouTube / TikTok / Douyin). Per-resource lock already prevents two tasks
// from fighting over the same browser tab; this cap is just a machine-load
// safety. With 6 separate platforms each on their own tab, 6 parallel runs
// is the design intent — at 3 the user couldn't even have one task per
// platform running at once, which is what they reported as the bug.

const MAX_CONCURRENT_TASKS = 6;

/** resource key → { taskId, markedAt }
 *  v4.31.41: stale cleanup 已砍 —— 之前 30min 阈值是为了应对 orchestrator 卡死
 *  finally 不跑造成的资源僵尸,但 ctx.* abort 严格化(2.5.8/2.5.9)+ stop 按钮
 *  能让 orchestrator 真正退出后,死锁场景应该不存在。markedAt 字段保留作日志
 *  诊断用,不再用作 reap 阈值。 */
const runningByResource = new Map<string, { taskId: string; markedAt: number }>();

// Sub-platform mutex (v6.x+ — Phase 1 of window-routing rework):
//
//   `manifest.platforms: string[]` enumerates the (platform, domain_tier)
//   units a scenario touches at any point during its run. e.g.
//     xhs_reply_fans_comment → ['xhs_creator', 'xhs_main']
//     binance_from_xhs_viral → ['binance_square', 'xhs_main']
//     xhs_auto_reply_universal → ['xhs_main']
//   Each entry maps to one mutex key `platform:${subp}`. A scenario must
//   acquire ALL of its keys before it can start; releases all on end.
//   Same-sub_platform tasks therefore serialize correctly, while scenarios
//   touching disjoint sub_platform sets run concurrently up to
//   MAX_CONCURRENT_TASKS.
//
//   Replaces the v5.x `tab:<pattern>` keying which used the raw URL
//   regex string as the mutex key. The old keying was tab-shape-aware but
//   couldn't distinguish creator.xiaohongshu.com from www.xiaohongshu.com
//   reliably (they often shared a single broad pattern) and merged unlike
//   resources because of regex equality. Sub_platform ids are stable,
//   reviewable, and naturally encode the creator-vs-main split that XHS
//   and Douyin enforce at the login layer.
//
// Two safety rails added in PR6.5 audit pass:
//
//   1. UNION instead of PREFER: when a manifest carries both `platforms`
//      AND legacy `tab_url_pattern` / `additional_tab_patterns` /
//      `secondary_tab_url_pattern`, we claim mutex keys from BOTH paths.
//      The earlier prefer-platforms-only design silently dropped any
//      legacy fields the developer forgot to migrate — if those fields
//      covered a sub_platform missing from the new `platforms` array,
//      mutex would silently fail. Union over-claims at worst (legacy
//      tab:* keys held by today's scenarios don't interlock with any
//      other modern scenario, so they're effectively dead locks), but
//      never under-claims.
//
//   2. ENUM VALIDATION: unknown sub_platform ids in `platforms` produce
//      a coworkLog warning + still get a (now-unique) lock so the
//      scenario can run, but the lock is anchored to the raw id rather
//      than a known sub_platform. Catches typos at runtime ("xhs_creater"
//      → warn, lock = "platform:xhs_creater" that no real scenario shares).
//
// Mixed keys (`platform:xhs_creator` from new scenarios + `tab:^https?://...`
// from legacy ones) coexist in the same runningByResource Map without
// interfering — distinct prefixes, distinct keys.
function resourceKeysForPack(
  pack: {
    manifest?: {
      id?: string;
      platform?: string;
      platforms?: string[];
      tab_url_pattern?: string;
      additional_tab_patterns?: string[];
      secondary_tab_url_pattern?: string;
    };
  } | null | undefined
): string[] {
  const keys: string[] = [];
  const pushKey = (k: string): void => {
    if (k && keys.indexOf(k) < 0) keys.push(k);
  };

  // 顶层平台互斥锁:同一【顶层平台】(douyin / xhs / video / binance …)任意两个任务
  // 一次只能跑一个 —— 防同账号双开(如抖音创作中心 + 主站互动同时跑触风控),也让「视频类」
  // (platform='video' 的二创)同时只跑一个。不同平台仍可并发(推特+币安互不影响)。
  // sub_platform(douyin_main vs douyin_creator)key 不同会漏挡,这把顶层锁补上。
  const topPlatform = pack?.manifest?.platform;
  if (typeof topPlatform === 'string' && topPlatform) pushKey(`platform-top:${topPlatform}`);

  // v6.x sub_platform claims.
  const platforms = pack?.manifest?.platforms;
  if (Array.isArray(platforms) && platforms.length > 0) {
    for (const p of platforms) {
      if (typeof p !== 'string' || !p) continue;
      if (!isKnownSubPlatform(p)) {
        coworkLog('WARN', 'scenarioManager',
          `[mutex] unknown sub_platform "${p}" in manifest.platforms (scenario=${pack?.manifest?.id || '?'}) — locking standalone, no interlock with other scenarios`);
      }
      pushKey(`platform:${p}`);
    }
  }

  // Legacy tab:* claims (UNION, not fallback). If the manifest declares
  // both arrays, we claim both — never silently drop legacy fields.
  const primary = pack?.manifest?.tab_url_pattern;
  if (primary) {
    pushKey(`tab:${primary}`);
  } else if (keys.length === 0) {
    // Only when NOTHING was claimed do we anchor to 'tab:default'.
    // A scenario with valid `platforms` doesn't need this filler.
    pushKey('tab:default');
  }
  const additional = pack?.manifest?.additional_tab_patterns;
  if (Array.isArray(additional)) {
    for (const p of additional) {
      if (typeof p === 'string' && p) pushKey(`tab:${p}`);
    }
  }
  const secondary = pack?.manifest?.secondary_tab_url_pattern;
  if (typeof secondary === 'string' && secondary) {
    pushKey(`tab:${secondary}`);
  }

  return keys;
}

/** Returns the first busy key (for error message) or null if all free. */
function findBusyResource(keys: string[]): string | null {
  for (const k of keys) if (runningByResource.has(k)) return k;
  return null;
}

// v4.25.35: 把 'tab:^https?://...' 这种内部 key 翻译成用户看得懂的平台名,
// 让"resource_busy"提示能直接说"推特 + 币安广场",而不是甩一坨 regex。
// v5.x+: 补上 youtube / tiktok / douyin —— 之前漏了,导致这三个平台被资源
// 锁/并发上限拦下时 toast 显示原始 regex 字符串,用户以为没提示。
function humanizePlatformFromKey(key: string): string {
  // 顶层平台互斥 key("platform-top:douyin" / "platform-top:video" 等)。
  if (key.startsWith('platform-top:')) {
    const p = key.slice('platform-top:'.length);
    const map: Record<string, string> = {
      douyin: '抖音', kuaishou: '快手', bilibili: '哔哩哔哩', xhs: '小红书', x: '推特',
      binance: '币安广场', youtube: 'YouTube', tiktok: 'TikTok', shipinhao: '视频号',
      toutiao: '头条号', instagram: 'Instagram', facebook: 'Facebook', reddit: 'Reddit', video: '视频创作',
    };
    return map[p] || p;
  }
  // v6.x sub_platform keys ("platform:xhs_creator", etc).
  // PR6.5: delegate to subPlatformRegistry so labels stay in sync with
  // group title generation + future ScopedTab routing.
  if (key.startsWith('platform:')) {
    return subPlatformLabel(key.slice('platform:'.length));
  }
  // Legacy tab:* regex-string keys (pre-v6 manifests + the legacy union
  // claims still issued for new manifests that haven't been cleaned up).
  const lc = key.toLowerCase();
  if (lc.indexOf('binance') >= 0) return '币安广场';
  if (lc.indexOf('twitter') >= 0 || lc.indexOf('x.com') >= 0 || lc.indexOf('x\\.com') >= 0) return '推特';
  if (lc.indexOf('xiaohongshu') >= 0) return '小红书';
  if (lc.indexOf('youtube') >= 0) return 'YouTube';
  if (lc.indexOf('tiktok') >= 0) return 'TikTok';
  if (lc.indexOf('douyin') >= 0) return '抖音';
  if (lc.indexOf('kuaishou') >= 0) return '快手';
  if (lc.indexOf('bilibili') >= 0) return '哔哩哔哩';
  if (lc.indexOf('channels.weixin') >= 0 || lc.indexOf('shipinhao') >= 0) return '视频号';
  if (lc.indexOf('toutiao') >= 0) return '头条号';
  if (lc.indexOf('instagram') >= 0) return 'Instagram';
  if (lc.indexOf('facebook') >= 0) return 'Facebook';
  if (lc.indexOf('reddit') >= 0) return 'Reddit';
  if (key === 'tab:default') return '默认浏览器标签';
  return key;
}

function atConcurrencyLimit(): boolean {
  return runningByResource.size >= MAX_CONCURRENT_TASKS;
}

function markResourcesBusy(keys: string[], taskId: string): void {
  const now = Date.now();
  for (const k of keys) runningByResource.set(k, { taskId, markedAt: now });
}

function releaseResources(keys: string[]): void {
  for (const k of keys) runningByResource.delete(k);
}

/**
 * Legacy singleton accessor — returns the first running task (if any)
 * for backwards-compat with UI code that assumed at most 1 task ran at
 * a time. New callers should prefer getRunningTaskIds().
 */
export function getRunningTaskId(): string | null {
  const first = runningByResource.values().next();
  return first.done ? null : first.value.taskId;
}

/** All currently-running task ids. Lets the UI light up multiple "running"
 *  badges when XHS task + Twitter task are in flight at the same time. */
export function getRunningTaskIds(): string[] {
  return Array.from(runningByResource.values()).map(v => v.taskId);
}

// ── Main entry ──

/**
 * @param manual — true when user clicks "直接运行". Manual runs bypass
 *   daily cap and interval checks (only mutex is enforced). Scheduled
 *   auto-runs pass false/undefined and are subject to all risk guards.
 */
/**
 * Upload ONE specific already-generated draft to XHS draft box.
 * Used by TaskDetailPage "📤 上传" per-draft button when the task was
 * created with auto_upload=false (safer mode).
 * Reads the cover/content images back from disk (they were saved by
 * artifactWriter during the original run), reconstructs the draft
 * payload, and runs the pack's upload_draft.js orchestrator.
 */
export async function uploadOneDraft(taskId: string, draftId: string): Promise<RunOutcome> {
  const task = taskStore.getTask(taskId);
  if (!task) return { status: 'failed', reason: 'task_not_found' };
  const draft = taskStore.getDraft(draftId);
  if (!draft) return { status: 'failed', reason: 'draft_not_found' };

  // Load pack first so we know the resource key before claiming the mutex.
  const pack = await loadPack(task.scenario_id);
  if (!pack) {
    return { status: 'failed', reason: 'scenario_pack_not_found' };
  }

  // Per-resource concurrency: same-platform tasks still serialize, but a
  // Twitter upload won't block an XHS scheduled run (and vice versa).
  const resources = resourceKeysForPack(pack);
  const busyKey = findBusyResource(resources);
  if (busyKey) {
    const holdingTaskId = runningByResource.get(busyKey)?.taskId;
    const holdingTask = holdingTaskId ? taskStore.getTask(holdingTaskId) : null;
    return {
      status: 'skipped',
      reason: 'resource_busy:' + busyKey,
      busy_platforms: resources.map(humanizePlatformFromKey),
      busy_task_name: holdingTask
        ? `#${holdingTask.id.slice(0, 8)} (${holdingTask.track || holdingTask.scenario_id})`
        : (holdingTaskId ? `#${holdingTaskId.slice(0, 8)}` : '未知任务'),
    };
  }
  if (atConcurrencyLimit()) {
    return { status: 'skipped', reason: 'concurrency_limit_reached' };
  }
  markResourcesBusy(resources, task.id);
  initProgress(task.id, pack.manifest?.id);
  // Manual single-draft upload also creates a run record so the user can
  // review what was uploaded later from the history page.
  startTaskRecord(task, pack.manifest);

  // Acquire keep-awake INSIDE the try so the finally is guaranteed to
  // release. Pre-try throws (e.g. startTaskRecord above) would leak the
  // blocker if we acquired before try.
  acquireKeepAwake();
  try {
    const script = pack.upload_draft_script;
    if (!script) {
      finishProgress(task.id, 'error', 'no_upload_script');
      return { status: 'failed', reason: 'no_upload_script' };
    }

    // Reload images from disk (saved by artifactWriter during original run).
    // Path: <taskOutputDir>/改写/配图-<rewriteTitle>/{cover,content}_N.{jpg,png}
    const fs = await import('fs');
    const path = await import('path');
    const { getTaskOutputDir } = await import('./artifactWriter');
    const batchDir = getTaskOutputDir(task);
    // Search the most recent batch that has this draft's images
    const rewritesDir = path.join(batchDir, '改写');
    const imagesReloaded: { type: string; base64: string; mimeType: string }[] = [];
    try {
      const rewriteTitle = (draft.variant?.title || '').slice(0, 80);
      // sanitize to match artifactWriter's folder name rule
      const sanitize = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80);
      const imgDirName = '配图-' + sanitize(rewriteTitle);
      const imgDir = path.join(rewritesDir, imgDirName);
      if (fs.existsSync(imgDir)) {
        const files = fs.readdirSync(imgDir).sort();
        for (const f of files) {
          const filePath = path.join(imgDir, f);
          const ext = path.extname(f).toLowerCase();
          const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
          const type = f.startsWith('cover') ? 'cover' : 'content';
          try {
            const buf = fs.readFileSync(filePath);
            imagesReloaded.push({ type, base64: buf.toString('base64'), mimeType: mime });
          } catch { /* skip */ }
        }
      }
    } catch (e) {
      coworkLog('WARN', 'scenarioManager', 'uploadOneDraft: image reload failed', { err: String(e) });
    }

    if (imagesReloaded.length === 0) {
      finishProgress(task.id, 'error', 'no_local_images');
      return { status: 'failed', reason: 'no_local_images' };
    }

    const targetDraft = {
      id: draft.id,
      variant: draft.variant,
      images: imagesReloaded,
    };

    const seen = taskStore.getSeenPostIds(task.id);
    // Per-task callbacks: each closure captures THIS task's id so concurrent
    // runs don't bleed into each other's progress map.
    const tid = task.id;
    const result = await runOrchestrator(pack, task, seen, {
      stepStart: (step) => stepStart(tid, step),
      stepLog: (step, status, message) => stepLog(tid, step, status, message),
      stepDone: (step) => stepDone(tid, step),
      stepError: (step, error) => stepError(tid, step, error),
      stepActionBoundary: (step: number, label: string) => stepActionBoundary(tid, step, label),
      stepResetAll: () => stepResetAll(tid),
      finishProgress: (status, error) => finishProgress(tid, status, error),
      isAbortRequested: () => isAbortRequested(tid),
      addTokensUsed: (tokensDelta, costDeltaUsd) => {
        const tNew = (tokensByTaskId.get(tid) || 0) + tokensDelta;
        const cNew = (costUsdByTaskId.get(tid) || 0) + (costDeltaUsd || 0);
        tokensByTaskId.set(tid, tNew);
        costUsdByTaskId.set(tid, cNew);
        // v5.x+: mirror into live RunProgress so the renderer's poll
        // can drive the glowing "本次消耗" card on TaskDetailPage AND
        // into the in-flight run record so the Run History list shows
        // 💎 N ≈ $Y live for the running row (not just at task end).
        const p = progressByTaskId.get(tid);
        if (p) { p.tokens_used = tNew; p.cost_usd = cNew; }
        mirrorTokensToRecord(tid, tNew, cNew);
      },
      setActionTarget: (type: string, target: number) => setActionTarget(tid, type, target),
      bumpActionProgress: (type: string, n: number) => bumpActionProgress(tid, type, n),
    }, { scriptOverride: script, targetDraft, appLocale: readAppLocale() });

    // Update draft status on successful upload
    const cur = progressByTaskId.get(tid);
    if (result.status === 'ok') {
      taskStore.updateDraft(draft.id, { status: 'pushed', pushed_at: Date.now() });
      if (cur?.status === 'running') finishProgress(tid, 'done');
    } else {
      if (cur?.status === 'running') finishProgress(tid, 'error', result.reason || 'upload_failed');
    }

    updateTaskRecordResult(task.id, result);
    return result;
  } finally {
    releaseResources(resources);
    releaseKeepAwake();
    abortByTaskId.delete(task.id);
    recordIdByTaskId.delete(task.id);
    tokensByTaskId.delete(task.id);
    costUsdByTaskId.delete(task.id);
    // v4.25.4: 同 runTask 的修复 — 防误杀 30s 内重新启动的同 task progress
    setTimeout(() => {
      const cur = progressByTaskId.get(task.id);
      if (cur && cur.status !== 'running') {
        progressByTaskId.delete(task.id);
      }
    }, 30000);
  }
}

export async function runTask(task: ScenarioTask, manual?: boolean): Promise<RunOutcome> {
  // v4.31.40: 之前在 runTask 头部立即 progressByTaskId.delete(),但如果接下来
  //   findBusyResource 自占自 SKIPPED return,旧那次 task 还在跑,progress
  //   已经被清,旧 orchestrator 后续 stepLog 拿不到 entry → 静默失效。UI
  //   拉到 progress=null 但 task 仍在 runningTaskIds → 显示"运行中"+
  //   "正在启动…"。用户描述:"task A 在跑能看进度,task B 到点 SKIPPED
  //   后回 task A 进度看不见了" —— 实际是 task A 自己 30min 后又被定时触
  //   发,头部 delete 误伤。reset 移到确认接管之后(SKIPPED return 不动 progress)。
  // Per-resource concurrency: load pack first to derive its tab pattern(s),
  // then check the resource. Tasks targeting the same tab serialize; tasks
  // targeting different tabs (XHS vs Twitter) can run in parallel.
  // v4.25+: cross-tab scenarios declare additional_tab_patterns and must
  // acquire ALL declared tab resources (else rejected up front).
  const pack = await loadPack(task.scenario_id);
  if (!pack) {
    return { status: 'failed', reason: 'scenario_pack_not_found' };
  }
  const resources = resourceKeysForPack(pack);
  // v4.25.34 diag: 打印申请/已占资源,方便调试"为啥 dual-tab 锁没拦住"。
  // runningByResource 是内存 Map,任务正常结束/中断/app 重启都会清。
  coworkLog('INFO', 'scenarioManager',
    `[runTask] task=${task.id} scenario=${task.scenario_id} `
    + `requesting=${JSON.stringify(resources)} `
    + `currentlyBusy=${JSON.stringify(Array.from(runningByResource.entries()))}`);
  const busyKey = findBusyResource(resources);
  if (busyKey) {
    // v4.31.41: 砍掉所有抢占 / stale cleanup 逻辑 —— 资源被占就 SKIPPED,
    //   不区分自占自还是不同 task。死锁场景靠 stop 按钮 + 严格 abort
    //   (2.5.8/2.5.9 的 ctx.* abortableCmd)解决,不再代码层面强制抢占。
    //   这避免了"自占自抢占"造成的旧那次还在跑就被新一次接管→重复发推。
    const holdingTaskId = runningByResource.get(busyKey)?.taskId;
    const holdingTask = holdingTaskId ? taskStore.getTask(holdingTaskId) : null;
    return {
      status: 'skipped',
      reason: 'resource_busy:' + busyKey,
      busy_platforms: resources.map(humanizePlatformFromKey),
      busy_task_name: holdingTask
        ? `#${holdingTask.id.slice(0, 8)} (${holdingTask.track || holdingTask.scenario_id})`
        : (holdingTaskId ? `#${holdingTaskId.slice(0, 8)}` : '未知任务'),
    };
  }
  if (atConcurrencyLimit()) {
    return { status: 'skipped', reason: 'concurrency_limit_reached' };
  }
  // v4.31.40: 真正接管时才 reset(SKIPPED 路径在上面已 return,不会到这)。
  //   保护旧那次还在跑的 task A 的 progress 不被同 id 新一次 SKIPPED 误删。
  progressByTaskId.delete(task.id);
  abortByTaskId.delete(task.id);
  tokensByTaskId.delete(task.id);
  costUsdByTaskId.delete(task.id);
  markResourcesBusy(resources, task.id);
  initProgress(task.id);
  startTaskRecord(task, pack.manifest);

  // Acquire keep-awake INSIDE the try so the finally is guaranteed to
  // release. Pre-try throws (e.g. startTaskRecord above) would leak the
  // blocker if we acquired before try.
  acquireKeepAwake();
  try {
    const outcome = await _runTaskInner(task, manual, pack);
    // v5.x+: backfill action_counts from the live RunProgress when the
    // outcome lacks them (user_stopped / mid-run abort path). The
    // orchestrator's normal return populates outcome.action_counts, but
    // when the run is killed via 'user_stopped' the inner catch builds
    // outcome = { status:'failed', reason:'user_stopped' } and the
    // partial like/follow/comment counts the orchestrator already
    // accumulated would otherwise be lost.
    //
    // Also persist 0-done keys when target > 0 (orchestrator declared
    // them via setActionTargets) so the detail page shows
    // "👍 0 · ➕ 0 · 💬 0" instead of "-" for early-stop runs —
    // users want to see the planned breakdown even when nothing
    // completed.
    // v5.x+: backfill BOTH action_counts and action_targets from the live
    // RunProgress when the outcome lacks them. action_counts is what the
    // orchestrator actually achieved; action_targets is what it planned.
    // The run history row shows "👍 5/32 赞" combining both — needs both
    // sides to make sense.
    {
      const live = progressByTaskId.get(task.id);
      const ap = live?.action_progress;
      if (ap && Object.keys(ap).length > 0) {
        if (!(outcome as any).action_counts) {
          // Persist 0-done keys when target > 0 so early-stop runs still
          // show the planned breakdown instead of "-".
          const counts: Record<string, number> = {};
          for (const [k, v] of Object.entries(ap)) {
            if ((v?.target || 0) > 0 || (v?.done || 0) > 0) {
              counts[k] = v.done || 0;
            }
          }
          if (Object.keys(counts).length > 0) {
            (outcome as any).action_counts = counts;
          }
        }
        // action_targets: declared planned quotas. Survives even after the
        // run finishes because we read from RunProgress (mirrors what the
        // orchestrator booked via ctx.setActionTargets). Stored on the run
        // record so the history list can render "X/Y" for completed runs
        // without re-fetching live progress.
        if (!(outcome as any).action_targets) {
          const targets: Record<string, number> = {};
          for (const [k, v] of Object.entries(ap)) {
            if ((v?.target || 0) > 0) targets[k] = v.target;
          }
          if (Object.keys(targets).length > 0) {
            (outcome as any).action_targets = targets;
          }
        }
      }
    }
    // Patch the run record with result counts now that we have them
    // (status was already set by finishProgress mirror).
    updateTaskRecordResult(task.id, outcome);
    // Pre-pick the NEXT scheduled run wall-clock time so the UI can
    // show it (e.g. "明天 11:23" instead of "约 24-27 小时后") AND so
    // the scheduler honors a deterministic fire time across app
    // restarts. Always set, regardless of run outcome — even a failed
    // run still wants a follow-up scheduled.
    setNextPlannedRun(task, Date.now());
    return outcome;
  } finally {
    releaseResources(resources);
    releaseKeepAwake();
    abortByTaskId.delete(task.id);
    recordIdByTaskId.delete(task.id);
    // v4.25.4: 之前 runTask 漏了清 tokens/cost,同任务跑两次成本翻倍记录。
    tokensByTaskId.delete(task.id);
    costUsdByTaskId.delete(task.id);
    // Keep progress around for 30s so UI can show final state.
    // v4.25.4: 之前 setTimeout 无脑 delete,如果 30s 内用户又跑了一次同一个 task,
    // initProgress 已经把 entry 换成新 run 的状态(status='running'),这个 setTimeout
    // 还是会把它删了 → 新 run 的 progress 凭空消失。检查 status 防误杀。
    setTimeout(() => {
      const cur = progressByTaskId.get(task.id);
      if (cur && cur.status !== 'running') {
        progressByTaskId.delete(task.id);
      }
    }, 30000);
  }
}

async function _runTaskInner(task: ScenarioTask, manual?: boolean, prefetchedPack?: ScenarioPack): Promise<RunOutcome> {
  // Avoid double-loading: caller (runTask) already loads the pack to derive
  // the resource key for concurrency gating. If supplied, reuse it.
  const pack = prefetchedPack || await loadPack(task.scenario_id);
  if (!pack) {
    finishProgress(task.id, 'error', 'scenario_pack_not_found');
    return { status: 'failed', reason: 'scenario_pack_not_found' };
  }

  // Manual runs ("直接运行") bypass daily cap / interval / weekly rest.
  // Only scheduled auto-runs are subject to all risk guards.
  if (!manual) {
    const gate = riskGuard.canRunNow(task, pack.manifest.risk_caps);
    if (!gate.allowed) {
      riskGuard.markRunSkipped(task.id, gate.reason || 'gate');
      finishProgress(task.id, 'error', gate.reason);
      return { status: 'skipped', reason: gate.reason };
    }
  }

  riskGuard.markRunStart(task.id);

  // Release batch dir cache so this run gets a fresh numbered folder
  // (1, 2, 3, ...). Without this, multiple manual runs on the same day
  // all pile into the first batch dir and overwrite each other.
  try {
    const { startNewBatch } = await import('./artifactWriter');
    startNewBatch(task.id);
  } catch (e) {
    coworkLog('WARN', 'scenarioManager', 'startNewBatch failed', { err: String(e) });
  }

  try {
    // All orchestration logic now lives on the server (orchestrator.js).
    // We just provide the ctx tools and let it run.
    const seen = taskStore.getSeenPostIds(task.id);
    // Per-task callbacks: each closure captures THIS task's id so concurrent
    // runs don't bleed into each other's progress map.
    const tid = task.id;

    // Hoist callbacks so the rescue retry can reuse the SAME closures
    // (single tid, single tokens accumulator, no double-counting).
    const callbacks = {
      stepStart: (step: number) => stepStart(tid, step),
      stepLog: (step: number, status: 'done' | 'running' | 'error', message: string) =>
        stepLog(tid, step, status, message),
      stepDone: (step: number) => stepDone(tid, step),
      stepError: (step: number, error: string) => stepError(tid, step, error),
      stepActionBoundary: (step: number, label: string) =>
        stepActionBoundary(tid, step, label),
      stepResetAll: () => stepResetAll(tid),
      finishProgress: (status: 'done' | 'error', error?: string) =>
        finishProgress(tid, status, error),
      isAbortRequested: () => isAbortRequested(tid),
      addTokensUsed: (tokensDelta: number, costDeltaUsd?: number) => {
        const tNew = (tokensByTaskId.get(tid) || 0) + tokensDelta;
        const cNew = (costUsdByTaskId.get(tid) || 0) + (costDeltaUsd || 0);
        tokensByTaskId.set(tid, tNew);
        costUsdByTaskId.set(tid, cNew);
        // v5.x+: mirror into live RunProgress so the renderer's poll
        // can drive the glowing "本次消耗" card on TaskDetailPage AND
        // into the in-flight run record so the Run History list shows
        // 💎 N ≈ $Y live for the running row (not just at task end).
        const p = progressByTaskId.get(tid);
        if (p) { p.tokens_used = tNew; p.cost_usd = cNew; }
        mirrorTokensToRecord(tid, tNew, cNew);
      },
      setActionTarget: (type: string, target: number) => setActionTarget(tid, type, target),
      bumpActionProgress: (type: string, n: number) => bumpActionProgress(tid, type, n),
    };

    let result = await runOrchestrator(pack, task, seen, callbacks, {
      appLocale: readAppLocale(),
    });

    // ── DOM-failure incident report (v6.x+) ────────────────────────────
    // If the failure looks like a DOM/selector breakage, fire off a
    // single fire-and-forget POST to /rescue/report with the current DOM
    // snapshot. NO retry, NO script override, NO token charge — the
    // engineer fixes selectors manually after a Lark threshold alert
    // (3 events / 3 days for same scenario + selector).
    //
    // v5.x used to ship a LLM-generated candidate orchestrator and
    // retry once. That was removed because:
    //   (a) it burned user tokens on fixes that often didn't work,
    //   (b) auto-retrying with a bad candidate masked the original
    //       error and confused users.
    if (result.status === 'failed' && shouldReportIncident(result.reason)) {
      try {
        const tabPattern = pack.manifest?.tab_url_pattern;
        const dom = await sendBrowserCommand(
          'read_page',
          { filter: 'interactive' },
          15_000,
          tabPattern ? { tabPattern } : {},
        ).catch(() => null);
        const urlInfo = await sendBrowserCommand(
          'get_url',
          {},
          5_000,
          tabPattern ? { tabPattern } : {},
        ).catch(() => null);

        // Serialize DOM elements to a single JSON string for the
        // dom_snapshot TEXT column. Backend caps at 100 KB anyway, but
        // pre-truncate so we don't waste bandwidth.
        let domSnapshot: string | undefined;
        if (dom && Array.isArray((dom as any).elements)) {
          try {
            domSnapshot = JSON.stringify((dom as any).elements).slice(0, 100 * 1024);
          } catch {
            // pathological circular structure — skip snapshot, still
            // log the incident
          }
        }

        coworkLog('INFO', 'scenarioManager',
          `[rescue] reporting DOM incident for ${task.scenario_id} (reason: ${result.reason})`);
        // Fire-and-forget — don't await, don't retry, never let failure
        // bubble up. console.warn on failure already happens inside
        // reportIncident().
        void viralPoolClient.reportIncident({
          scenarioId: task.scenario_id,
          taskId: task.id,
          failedStep: result.reason,
          // Same value as failedStep until orchestrators learn to surface
          // a separate concrete selector. Server uses normalizeSelector()
          // to strip dynamic substrings before bucketing for thresholds.
          failedSelector: result.reason,
          domSnapshot,
          url: urlInfo ? (urlInfo as any).url : undefined,
          errorMsg: result.reason,
        });
      } catch (err) {
        // Incident report is best-effort telemetry; never let it
        // escalate. Original result stands as final outcome.
        coworkLog('WARN', 'scenarioManager', '[rescue] report threw, ignoring', { err: String(err) });
      }
    }

    const cur = progressByTaskId.get(tid);
    if (result.status === 'ok') {
      // Pass through action_counts + the accumulated tokens/cost so the
      // run snapshot riskGuard exposes via scenario:runStatus carries the
      // full telemetry the task detail page needs for "累计完成" /
      // "累计消耗" aggregation. (tokens_used / cost_usd are summed across
      // every ai/charge/image call in this run via the per-task maps.)
      riskGuard.markRunSuccess(task.id, result.collected_count || 0, result.draft_count || 0, {
        action_counts: (result as any).action_counts,
        tokens_used: tokensByTaskId.get(task.id) || 0,
        cost_usd: costUsdByTaskId.get(task.id) || 0,
      });
      // 保证 UI 最终收到 done 状态（orchestrator 里大多数路径已经调过，
      // 但 orchestrator 抛异常经 phaseRunner catch 返回时没调，这里兜底）
      if (cur?.status === 'running') finishProgress(tid, 'done');
    } else {
      // v5.x+: pass through whatever the orchestrator already accumulated
      // before failure / user-stop. Without this, manual stops at "已发
      // 20/30" silently dropped +20 from the all-time aggregate. The
      // backfill block ~200 lines up populates result.action_counts from
      // live RunProgress for early-stop paths so this is non-empty for
      // partial runs.
      riskGuard.markRunFailure(task.id, result.reason || 'unknown', {
        action_counts: (result as any).action_counts,
        tokens_used: tokensByTaskId.get(task.id) || 0,
        cost_usd: costUsdByTaskId.get(task.id) || 0,
      });
      // 关键修复：orchestrator 抛 user_stopped → phaseRunner catch → 这里。
      // 之前没调 finishProgress，UI 永远看不到 error 状态，一直显示"停止中"。
      if (cur?.status === 'running') finishProgress(tid, 'error', result.reason || 'unknown');
    }

    return result;
  } catch (err) {
    let msg = String(err instanceof Error ? err.message : err);
    if (msg.includes('user_stopped')) msg = 'user_stopped';
    // v4.31.33: 保证 finishProgress 一定被调 —— 之前 markRunFailure 自己也可能
    //   ensureLoaded() 抛(若 riskGuard 没 init),整条 error 路径挂掉,
    //   finishProgress 永远不调,progress 永久卡 'running' + 空 logs,UI 永远
    //   显示"正在启动…"。各步骤独立 try。
    // v5.x+: 即使 orchestrator 硬崩,从 live progress 里把 action_progress 捞
    //   出来传给 markRunFailure,partial 的 like / follow / comment 计数才不会
    //   从累计里丢。
    let _crashCounts: Record<string, number> | undefined;
    try {
      const live = progressByTaskId.get(task.id);
      const ap = live?.action_progress;
      if (ap) {
        const counts: Record<string, number> = {};
        for (const [k, v] of Object.entries(ap)) {
          if ((v?.done || 0) > 0) counts[k] = v.done;
        }
        if (Object.keys(counts).length > 0) _crashCounts = counts;
      }
    } catch { /* non-fatal */ }
    try {
      riskGuard.markRunFailure(task.id, msg, {
        action_counts: _crashCounts,
        tokens_used: tokensByTaskId.get(task.id) || 0,
        cost_usd: costUsdByTaskId.get(task.id) || 0,
      });
    } catch (e) {
      coworkLog('WARN', 'scenarioManager', `markRunFailure threw (riskGuard not initialized?)`, { err: String(e) });
    }
    try { finishProgress(task.id, 'error', msg); } catch (e) {
      coworkLog('WARN', 'scenarioManager', `finishProgress threw`, { err: String(e) });
    }
    return { status: 'failed', reason: msg };
  }
}

// ── Scheduler: check every 60s if any task should auto-run ──
// (INTERVAL_MS lookup table removed in v2.4.25 — replaced by
//  computeNextPlannedRun which encodes the per-interval base + jitter
//  and stores the resulting wall-clock fire time on the task itself.)

/**
 * Pre-pick the next-run wall-clock timestamp for a task, applying the
 * appropriate per-interval random jitter UPFRONT (instead of rolling
 * dice every scheduler tick after the threshold). Two reasons we want
 * pre-picking:
 *
 *   1. The user can SEE exactly when the next run will fire — the
 *      task detail page shows "下次运行: 明天 11:23" instead of "约
 *      24-27h 后".
 *   2. The fire time is stable across app restarts. With per-tick dice,
 *      restarting the app reset the random state and the actual fire
 *      time drifted unpredictably.
 *
 * v2.4.32 — `isFirstRun` flag distinguishes:
 *   - true:  task just created OR interval just edited → first fire
 *            should happen INSIDE the FIRST time bucket (else "我刚
 *            建好的 30min 任务为啥要等 30 分钟才跑第一次？")
 *   - false: regular post-run reschedule → fromTs + base + jitter
 *
 * Jitter rules per interval:
 *   30min/1h:
 *     isFirstRun=true   → fromTs + rand(0..base)             (first bucket)
 *     isFirstRun=false  → fromTs + base + rand(0..10 min)    (steady-state)
 *   3h/6h:
 *     isFirstRun=true   → fromTs + rand(0..base)             (first bucket)
 *     isFirstRun=false  → fromTs + base + rand(0..45 min)    (wider jitter — v6.x)
 *   daily (HH:MM fixed):
 *     today HH:MM if not yet passed, else tomorrow ± 15 min  (no special case)
 *   daily_random:
 *     isFirstRun=true   → random in (now, today 23:59:59)    (today's slot)
 *     isFirstRun=false  → random in (next-day 00:00, next-day 23:59:59)
 *                         (full natural-day window, 凌晨 2 点也可能跑 — 用户确认 OK)
 *   once:
 *     never (Number.MAX_SAFE_INTEGER)
 */
export function computeNextPlannedRun(
  interval: string,
  daily_time: string,
  fromTs: number,
  isFirstRun: boolean = false,
): number {
  const day = 24 * 60 * 60 * 1000;
  if (interval === 'once') return Number.MAX_SAFE_INTEGER;

  if (interval === 'daily_random') {
    if (isFirstRun) {
      // First fire: random in (fromTs, today 23:59:59).
      const todayEnd = new Date(fromTs);
      todayEnd.setHours(23, 59, 59, 999);
      const remainingMs = todayEnd.getTime() - fromTs;
      if (remainingMs <= 0) {
        // Edge: created right at midnight — fall through to "next day"
        // computation so we don't pick a time in the past.
      } else {
        return fromTs + Math.floor(Math.random() * remainingMs);
      }
    }
    // Subsequent fire (or first-fire when created at 23:59:59+): pick
    // a random time anywhere in the NEXT calendar day's full 00:00~23:59.
    const tomorrow = new Date(fromTs);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    return tomorrow.getTime() + Math.floor(Math.random() * day);
  }

  if (interval === 'daily') {
    const [hh, mm] = (daily_time || '08:00').split(':').map(Number);
    const next = new Date(fromTs);
    next.setHours(hh, mm, 0, 0);
    if (next.getTime() <= fromTs) next.setTime(next.getTime() + day);
    // ±15 min jitter
    const jitter = Math.floor((Math.random() - 0.5) * 30 * 60 * 1000);
    return next.getTime() + jitter;
  }

  const intervals: Record<string, number> = {
    '30min': 30 * 60 * 1000,
    '1h':    60 * 60 * 1000,
    '3h': 3 * 60 * 60 * 1000,
    '6h': 6 * 60 * 60 * 1000,
  };
  const base = intervals[interval] || day;
  if (isFirstRun) {
    // First fire: random anywhere within the first bucket — could be
    // seconds from now, could be near the end of the bucket.
    return fromTs + Math.floor(Math.random() * base);
  }
  // v6.x: per-user request,长间隔(3h/6h)用更宽 1-45 分钟 jitter,
  //   短间隔(30min/1h)留 1-10 分钟(过宽会破坏间隔密度)。
  const isLongInterval = interval === '3h' || interval === '6h';
  const jitterMaxMs = (isLongInterval ? 45 : 10) * 60 * 1000;
  return fromTs + base + Math.floor(Math.random() * jitterMaxMs);
}

/** Persist the next planned run for a task, computed off the given
 *  reference timestamp. Called in runTask's finally and from the
 *  scheduler when a task hasn't been planned yet. Failure to persist
 *  is non-fatal (scheduler will recompute next tick). */
function setNextPlannedRun(task: ScenarioTask, fromTs: number, isFirstRun: boolean = false): void {
  try {
    const interval = (task as any).run_interval || 'daily';
    const planned = computeNextPlannedRun(interval, task.daily_time, fromTs, isFirstRun);
    taskStore.updateTask(task.id, { next_planned_run_at: planned } as any);
  } catch (e) {
    coworkLog('WARN', 'scenarioManager', 'setNextPlannedRun failed', { err: String(e) });
  }
}

let schedulerStarted = false;
let schedulerTimer: NodeJS.Timeout | null = null;

/** v4.31.45: 定时触发被 SKIPPED 时调,sidecar-server 启动时注入 broadcastSSE
 *  包装让前端 UI 能 toast 提示。注入前调用是 no-op(早期 tick 静默)。 */
let onScheduledSkipped: ((info: {
  taskId: string;
  scenarioId: string;
  reason?: string;
  busyPlatforms?: string[];
  busyTaskName?: string;
}) => void) | null = null;
export function setOnScheduledSkipped(fn: typeof onScheduledSkipped): void {
  onScheduledSkipped = fn;
}

const SCHEDULER_TICK_MS = 60 * 1000;

/** v4.31.32: 单次 tick 抽出来,启动时立即跑一次 + 之后每 60s 跑一次。
 *  之前是裸 `setInterval(60s)` —— 第一次触发要等 60 秒,而且如果 sidecar
 *  启动到这步链路中任何一步抛异常,scheduler 永远不启动(用户感知"立即
 *  运行能跑,但定时永远不动")。重写成 setTimeout 自递归 + 启动立即跑,
 *  对齐 cowork Scheduler 的可靠模式。tick 入口打 INFO log 让用户能在
 *  cowork.log 里直接看到 scheduler 有没有在心跳。 */
async function schedulerTick(): Promise<void> {
  try {
    // v4.31.33: lazy-init 所有 stores —— 跟 sidecar-server.ts 'scenario:runTaskNow'
    //   handler 对齐。之前差异:手动入口在 handler 里 lazy init,scheduler tick
    //   直接调 runTask 绕过这一步。如果 sidecar 启动链上某个 init 失败,scheduler
    //   触发的 runTask 走到 ensureLoaded() 就抛,且 catch 里的 markRunFailure 也
    //   抛同一个错 → finishProgress 永不被调 → progress 卡 status='running' +
    //   空 logs → UI 永远显示"正在启动…(后端流式日志稍候)"。
    //   表现上就是"立即运行能展示进度,定时不能"。这里 idempotent 兜底。
    try {
      const { getUserDataPath } = require('../platformAdapter');
      const userDataPath = getUserDataPath();
      const tStore = require('./taskStore');
      if (!tStore._loaded) { tStore.initTaskStore(userDataPath); tStore._loaded = true; }
      const rg = require('./riskGuard');
      if (!rg._loaded) { rg.initRiskGuard(userDataPath); rg._loaded = true; }
      const rr = require('./runRecords');
      try { rr.initRunRecords(userDataPath); } catch { /* idempotent */ }
    } catch (e) {
      coworkLog('WARN', 'scheduler', `pre-tick lazy init failed: ${e}`);
    }

    if (atConcurrencyLimit()) {
      coworkLog('INFO', 'scheduler', 'tick skipped — at concurrency limit');
      return;
    }
    const allTasks = taskStore.listTasks();
    if (!Array.isArray(allTasks) || allTasks.length === 0) {
      coworkLog('INFO', 'scheduler', 'tick — no tasks in store');
      return;
    }

    // tick 入口打一行总览,便于在 cowork.log 里直接看 scheduler 有没有心跳
    let nDisabled = 0, nOnce = 0, nNotDue = 0, nFired = 0;
    const now = Date.now();

    for (const task of allTasks) {
      if (!task.enabled) { nDisabled++; continue; }
      if (atConcurrencyLimit()) break;

      const interval = (task as any).run_interval || 'daily';
      if (interval === 'once') { nOnce++; continue; }

      let planned = (task as any).next_planned_run_at as number | undefined;
      if (!planned) {
        const runs = riskGuard.getRuns(task.id);
        const hasRealRuns = runs.length > 0;
        const fromTs = hasRealRuns
          ? Math.max(...runs.map((r: any) => r.started_at || 0))
          : now;
        setNextPlannedRun(task, fromTs, !hasRealRuns);
        const refreshed = taskStore.getTask(task.id);
        planned = (refreshed as any)?.next_planned_run_at;
        if (!planned) { nNotDue++; continue; }
      }
      if (now < planned) { nNotDue++; continue; }

      nFired++;
      coworkLog('INFO', 'scheduler', `Auto-running task ${task.id} (interval: ${interval}, planned: ${new Date(planned).toISOString()})`);
      const taskRefForLog = task; // closure 捕获,SKIPPED 时给前端推送用
      runTask(task, false)
        .then(out => {
          if (!out) return;
          if (out.status === 'skipped') {
            coworkLog('WARN', 'scheduler', `Auto-run SKIPPED ${task.id}: ${out.reason || 'unknown'} — 下次 tick(60s)再试`);
            // v4.31.45: 定时触发被资源占用 SKIPPED 时给前端推一个事件,UI
            //   全局 toast 提示用户"X 任务到点没启动:被 XXX 占用"。之前
            //   只在 cowork.log 里打 WARN,用户根本看不到。手动触发已有
            //   类似提示,定时跑也对齐。
            if (onScheduledSkipped) {
              try {
                onScheduledSkipped({
                  taskId: taskRefForLog.id,
                  scenarioId: taskRefForLog.scenario_id,
                  reason: out.reason,
                  busyPlatforms: (out as any).busy_platforms,
                  busyTaskName: (out as any).busy_task_name,
                });
              } catch (_) { /* non-fatal */ }
            }
          } else if (out.status === 'failed') {
            coworkLog('WARN', 'scheduler', `Auto-run FAILED ${task.id}: ${out.reason || 'unknown'}`);
          } else {
            coworkLog('INFO', 'scheduler', `Auto-run finished ${task.id}: ${out.status}`);
          }
        })
        .catch(err => coworkLog('ERROR', 'scheduler', `Auto-run threw ${task.id}: ${err}`));
    }

    coworkLog('INFO', 'scheduler',
      `tick: ${allTasks.length} tasks (disabled:${nDisabled} once:${nOnce} notDue:${nNotDue} fired:${nFired})`);
  } catch (err) {
    coworkLog('ERROR', 'scheduler', `tick threw: ${err}`);
  }
}

export function startScheduler(): void {
  if (schedulerStarted) {
    coworkLog('INFO', 'scheduler', 'startScheduler called twice — ignoring');
    return;
  }
  schedulerStarted = true;
  coworkLog('INFO', 'scheduler', `startScheduler: kicking off (tick every ${SCHEDULER_TICK_MS / 1000}s, immediate first run)`);

  // 立即跑一次,不等 60s
  schedulerTick().catch(err => coworkLog('ERROR', 'scheduler', `initial tick threw: ${err}`));

  // 之后每 60s 自递归一次(setTimeout 而不是 setInterval —— 上一 tick 还
  //   在跑时不会堆积新 tick,行为更可预期)
  const loop = (): void => {
    schedulerTimer = setTimeout(async () => {
      await schedulerTick();
      if (schedulerStarted) loop();
    }, SCHEDULER_TICK_MS);
  };
  loop();
}

/** Force a tick right now — exposed so a debug endpoint or the UI's
 *  "刷新调度" 按钮能立即触发一轮检查。 */
export async function tickSchedulerNow(): Promise<void> {
  await schedulerTick();
}
