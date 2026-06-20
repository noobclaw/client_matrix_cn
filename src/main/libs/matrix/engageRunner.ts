/**
 * 矩阵互动运行时 —— 让一批账号在各自指纹内核里跑抖音自动点赞/评论/关注。
 *
 * 复用后端 fork 的 douyin_auto_engage orchestrator(实战 DOM 逻辑:按关键词搜→
 * 滚动收集视频→按配额随机点赞/关注/评论),这里提供它需要的整套 ctx,把浏览器
 * 命令路由到该账号的内核 CDP(matrixCmd)、AI 写评论走后端 /api/ai、计费走
 * /api/charge/action、去重用本地 engageHistory。
 *
 * ⚠️ orchestrator 的 DOM 选择器/点击策略是按真实抖音页调过的;在指纹内核 CDP 上
 *    第一次跑大概率要据真机反馈微调(选择器/点击/滚动)。这是预期内的,不是写错。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { coworkLog } from '../coworkLogger';
import { launchKernel, kernelNavigate, closeKernel } from './kernelPool';
import { matrixCmd } from './cdpCommands';
import { getAccount, setAccountStatus, setAccountKeywords } from './accountManager';
import { getNoobClawAuthToken } from '../claudeSettings';

const DEFAULT_BASE_URL = 'https://api.noobclaw.com';
function baseUrl(): string { return process.env.NOOBCLAW_API_BASE_URL || DEFAULT_BASE_URL; }
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
function randInt(min: number, max: number): number {
  const lo = Math.min(min, max), hi = Math.max(min, max);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

export interface EngageQuota {
  daily_like_min?: number; daily_like_max?: number;
  daily_follow_min?: number; daily_follow_max?: number;
  daily_comment_min?: number; daily_comment_max?: number;
}

export interface EngageTaskOptions {
  platform: string;                 // 目前 douyin
  accountIds: string[];
  quota?: EngageQuota;              // 每号配额区间(缺省用 scenario 默认)
  concurrency?: number;
  jitterMinMs?: number; jitterMaxMs?: number;
  kernelPath?: string;
  authToken?: string;              // aiCall / chargeAction 用
  onLog?: (accountId: string, msg: string) => void;
  onItem?: (item: EngageItemResult) => void;
}

export interface EngageItemResult {
  accountId: string;
  state: 'success' | 'failed' | 'skipped';
  counts?: { like: number; follow: number; comment: number };
  reason?: string;
}

// ── scenario pack 下发(/api/matrix/scenarios/:id)──
async function fetchEngagePack(id: string): Promise<any | null> {
  try {
    const res = await fetch(`${baseUrl()}/api/matrix/scenarios/${id}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    coworkLog('WARN', 'engageRunner', 'fetch pack failed', { err: String(e) });
    return null;
  }
}

// ── 本地 engageHistory(按号去重,避免重复互动同一视频)──
function engageHistoryFor(accountId: string) {
  const dir = path.join(process.env.NOOBCLAW_MATRIX_DIR || path.join(os.homedir(), 'NoobClaw', 'matrix'), 'engage');
  const file = path.join(dir, `${accountId}.json`);
  let mem: Record<string, true> = {};
  try { mem = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { mem = {}; }
  const save = () => { try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(mem)); } catch { /* ignore */ } };
  return {
    has: (type: string, id: string) => !!mem[`${type}:${id}`],
    remember: (type: string, id: string) => { mem[`${type}:${id}`] = true; save(); },
  };
}

// ── 简化版 aiCall(写评论/衍生关键词):POST /api/ai/chat/completions ──
function makeAiCall(pack: any, authToken: string | undefined, report: (m: string) => void) {
  return async (promptNameOrRaw: string, promptOrInput: any, rawInput?: string, opts?: any) => {
    const prompt = promptNameOrRaw === '__raw__' ? String(promptOrInput) : String(pack?.prompts?.[promptNameOrRaw] || '');
    const userMessage = promptNameOrRaw === '__raw__'
      ? String(rawInput || '')
      : (typeof promptOrInput === 'string' ? promptOrInput : JSON.stringify(promptOrInput));
    if (!authToken) throw new Error('AI_NOT_CONFIGURED');
    const body: any = {
      model: (opts && opts.model) || 'noobclawai-chat',
      messages: [{ role: 'system', content: prompt }, { role: 'user', content: userMessage }],
      stream: false, max_tokens: 8000,
    };
    const wantJson = opts?.expectJson !== false;
    if (wantJson && (/json/i.test(prompt) || /json/i.test(userMessage))) body.response_format = { type: 'json_object' };
    else if (!wantJson) body.response_format = { type: 'text' };
    const res = await fetch(`${baseUrl()}/api/ai/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify(body),
    });
    const data: any = await res.json().catch(() => ({}));
    const content = data?.choices?.[0]?.message?.content ?? '';
    if (opts?.expectJson === false) return content;
    try { return JSON.parse(content); } catch { return content; }
  };
}

async function chargeAction(authToken: string | undefined, actionType: string, platform: string, refId?: string) {
  if (!authToken) return { ok: false, reason: 'auth_missing' };
  try {
    const res = await fetch(`${baseUrl()}/api/charge/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ action_type: actionType, platform, ref_id: refId || null }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: String(data?.error || `http_${res.status}`) };
    return { ok: true, charged: data?.charged, balance_after: data?.balance_after };
  } catch (e: any) { return { ok: false, reason: 'network_error' }; }
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function runOne(opts: EngageTaskOptions, pack: any, accountId: string): Promise<EngageItemResult> {
  const acc = getAccount(accountId);
  const log = (m: string) => { try { opts.onLog?.(accountId, m); } catch { /* ignore */ } };
  if (!acc) return { accountId, state: 'skipped', reason: 'account_not_found' };
  if (acc.platform !== opts.platform) return { accountId, state: 'skipped', reason: 'platform_mismatch' };
  if (!acc.keywords || acc.keywords.length === 0) return { accountId, state: 'skipped', reason: 'no_keywords' };
  if (acc.status === 'banned' || acc.status === 'limited') return { accountId, state: 'skipped', reason: 'account_' + acc.status };

  await sleep(randInt(opts.jitterMinMs ?? 3000, opts.jitterMaxMs ?? 15000)); // 错峰

  const counts = { like: 0, follow: 0, comment: 0 };
  const history = engageHistoryFor(accountId);
  const q = opts.quota || {};
  const authToken = opts.authToken || getNoobClawAuthToken() || undefined; // aiCall/计费 token(main 侧)
  let finished: { status: string; error?: string } | null = null;

  try {
    setAccountStatus(accountId, 'running');
    log('启动指纹内核');
    await launchKernel({
      accountId, kernelPath: opts.kernelPath, kernelVersion: acc.kernelVersion,
      userDataDir: acc.userDataDir, fingerprint: acc.fingerprint, proxy: acc.proxy,
    });
    await kernelNavigate(accountId, 'https://www.douyin.com/');
    await sleep(2000);

    // orchestrator 需要的 task(配额从 opts.quota,缺省回落 scenario manifest 默认)
    const task: any = {
      id: accountId, keywords: acc.keywords, track: acc.track || 'douyin_default',
      daily_like_min: q.daily_like_min, daily_like_max: q.daily_like_max,
      daily_follow_min: q.daily_follow_min, daily_follow_max: q.daily_follow_max,
      daily_comment_min: q.daily_comment_min, daily_comment_max: q.daily_comment_max,
    };

    const aiCall = makeAiCall(pack, authToken, log);
    const browserFn: any = (command: string, params?: any, timeout?: number) => matrixCmd(accountId, command, params, timeout);

    const ctx: any = {
      task, config: pack?.config || {}, manifest: pack?.manifest || {},
      appLocale: 'zh',
      aborted: () => false,
      // 浏览器
      browser: browserFn,
      navigate: (url: string) => kernelNavigate(accountId, url),
      scroll: (amount?: number) => matrixCmd(accountId, 'scroll', { amount: amount || randInt(2, 4) }),
      // task-tab:内核单页,openTab=导航并返回伪 tab,getTaskTab 复用
      openTab: async (o: any) => { if (o?.url) { await kernelNavigate(accountId, o.url); await sleep(1500); } return { id: 'main' }; },
      getTaskTab: async () => ({ id: 'main' }),
      // 进度/日志
      report: (m: string) => log(m),
      stepStart: (s: number) => log('▶ 步骤 ' + s),
      stepLog: (_s: number, _st: string, m: string) => log(m),
      stepDone: (_s: number) => {},
      startAction: (..._a: any[]) => {},
      stepResetAll: () => {},
      setActionTargets: (t: any) => log(`🎯 配额 赞${t.like}/关${t.follow}/评${t.comment}`),
      addActionCount: (type: string, n: number) => { if (type in counts) (counts as any)[type] += n; opts.onItem?.({ accountId, state: 'success', counts: { ...counts } }); },
      finish: (status: string, error?: string) => { finished = { status, error }; },
      // 计费 / AI / 去重
      chargeAction: (a: string, p: string, r?: string) => chargeAction(authToken, a, p, r),
      charge: (a: string, p: string, r?: string) => chargeAction(authToken, a, p, r),
      aiCall,
      getPrompt: (name: string) => { const t = pack?.prompts?.[name]; if (!t) throw new Error('Missing prompt: ' + name); return t; },
      engageHistory: history,
      appendKeywords: (arr: string[]) => { try { const merged = Array.from(new Set([...(acc.keywords || []), ...arr])); setAccountKeywords(accountId, merged); } catch { /* ignore */ } },
      writeReport: async (_fname: string, _md: string) => ({ ok: true }),
      // 工具
      sleep: async (min: number, max?: number) => { await sleep(max ? randInt(min, max) : min); },
      randInt,
      log: (m: string) => coworkLog('INFO', 'engage-orch', m),
    };

    const code = pack?.orchestrator;
    if (!code) return { accountId, state: 'failed', reason: 'no_orchestrator' };
    const fn = new AsyncFunction('ctx', code);
    await fn(ctx);

    setAccountStatus(accountId, 'idle');
    const fin = finished as { status: string; error?: string } | null;
    if (fin && fin.status === 'error') return { accountId, state: 'failed', counts, reason: fin.error };
    return { accountId, state: 'success', counts };
  } catch (e: any) {
    setAccountStatus(accountId, 'idle');
    return { accountId, state: 'failed', counts, reason: 'engage_threw:' + String(e?.message || e).slice(0, 140) };
  } finally {
    try { closeKernel(accountId); } catch { /* ignore */ }
  }
}

async function runPool(ids: string[], k: number, worker: (id: string) => Promise<EngageItemResult>, onItem?: (i: EngageItemResult) => void): Promise<EngageItemResult[]> {
  const results: EngageItemResult[] = new Array(ids.length);
  let cursor = 0;
  async function lane() {
    while (true) {
      const i = cursor++;
      if (i >= ids.length) return;
      const r = await worker(ids[i]);
      results[i] = r;
      try { onItem?.(r); } catch { /* ignore */ }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(k, ids.length)) }, () => lane()));
  return results;
}

export interface EngageReport { platform: string; total: number; success: number; failed: number; skipped: number; items: EngageItemResult[]; }

export async function runEngageTask(opts: EngageTaskOptions): Promise<EngageReport> {
  const k = Math.max(1, Math.min(opts.concurrency ?? 3, 10));
  const scenarioId = opts.platform === 'douyin' ? 'douyin_auto_engage' : `${opts.platform}_auto_engage`;
  const pack = await fetchEngagePack(scenarioId);
  if (!pack || !pack.orchestrator) {
    return { platform: opts.platform, total: opts.accountIds.length, success: 0, failed: 0, skipped: opts.accountIds.length,
      items: opts.accountIds.map((id) => ({ accountId: id, state: 'skipped' as const, reason: 'no_engage_scenario(后端未部署?)' })) };
  }
  coworkLog('INFO', 'engageRunner', `engage ${opts.platform} x${opts.accountIds.length}`);
  const items = await runPool(opts.accountIds, k, (id) => runOne(opts, pack, id), opts.onItem);
  return {
    platform: opts.platform, total: items.length,
    success: items.filter((x) => x.state === 'success').length,
    failed: items.filter((x) => x.state === 'failed').length,
    skipped: items.filter((x) => x.state === 'skipped').length,
    items,
  };
}
