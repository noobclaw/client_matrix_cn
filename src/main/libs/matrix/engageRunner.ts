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
import { launchKernel, kernelNavigate, closeKernel, checkKernelLogin, NO_KERNEL_ERROR } from './kernelPool';
import { installedKernelPath } from './kernelInstaller';

// 各平台主页(跑前导航 + 登录态检查用;不再写死抖音)。
const PLATFORM_HOME: Record<string, string> = {
  douyin: 'https://www.douyin.com/', xhs: 'https://www.xiaohongshu.com/', bilibili: 'https://www.bilibili.com/',
  kuaishou: 'https://www.kuaishou.com/', tiktok: 'https://www.tiktok.com/', x: 'https://x.com/home',
  binance: 'https://www.binance.com/zh-CN/square', youtube: 'https://www.youtube.com/',
  shipinhao: 'https://channels.weixin.qq.com/', toutiao: 'https://mp.toutiao.com/',
};
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
  signal?: AbortSignal;            // 停止任务:已开始的号靠 ctx.aborted() 中途退,未开始的号跳过
  onLog?: (accountId: string, msg: string) => void;
  onItem?: (item: EngageItemResult) => void;
  // 该账号本次随机选定的动作目标(orchestrator ctx.setActionTargets 抛出)。
  // 进度面板靠它聚合 action_progress 的 target(N 账号求和),没有则回落配额上限。
  onTargets?: (accountId: string, targets: { like?: number; follow?: number; comment?: number }) => void;
}

export interface EngageItemResult {
  accountId: string;
  state: 'success' | 'failed' | 'skipped';
  counts?: { like: number; follow: number; comment: number };
  // 该号本次累计实际扣费(积分 + 美元)。每条互动动作扣费后累加,用于「本次/累计消耗」。
  chargedCredits?: number;
  chargedUsd?: number;
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
// onCost:写评论等 AI 调用也是真扣积分(_noobclaw.billableTokens/costUsd),回传给上层累进「本次消耗」,
//        否则评论的 token 费看不见 → 消耗算少了。
function makeAiCall(pack: any, authToken: string | undefined, report: (m: string) => void, onCost?: (credits: number, usd: number) => void) {
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
    // AI 调用的权威扣费(同视频管线口径):billableTokens=实扣积分,costUsd=权威美元。累进「本次消耗」。
    try {
      const aiCredits = Number(data?._noobclaw?.billableTokens) || 0;
      const aiUsd = Number(data?._noobclaw?.costUsd) || 0;
      if ((aiCredits > 0 || aiUsd > 0) && onCost) onCost(aiCredits, aiUsd);
    } catch { /* ignore */ }
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
    // 后端 /api/charge/action 返回 charged(积分)+ cost_usd(按 token_price_per_million 算好的权威美元)。
    // 两个都带回去 → 任务的「本次/累计消耗」💎 + $ 才算得对(之前丢了 → 一直显示 0)。
    return { ok: true, charged: Number(data?.charged) || 0, cost_usd: Number(data?.cost_usd) || 0, balance_after: data?.balance_after };
  } catch (e: any) { return { ok: false, reason: 'network_error' }; }
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function runOne(opts: EngageTaskOptions, pack: any, accountId: string): Promise<EngageItemResult> {
  const acc = getAccount(accountId);
  const log = (m: string) => { try { opts.onLog?.(accountId, m); } catch { /* ignore */ } };
  if (opts.signal?.aborted) return { accountId, state: 'skipped', reason: 'aborted' }; // 已停止:还没轮到的号直接跳过
  if (!acc) return { accountId, state: 'skipped', reason: 'account_not_found' };
  if (acc.platform !== opts.platform) return { accountId, state: 'skipped', reason: 'platform_mismatch' };
  if (!acc.keywords || acc.keywords.length === 0) return { accountId, state: 'skipped', reason: 'no_keywords' };
  if (acc.status === 'banned' || acc.status === 'limited') return { accountId, state: 'skipped', reason: 'account_' + acc.status };

  await sleep(randInt(opts.jitterMinMs ?? 3000, opts.jitterMaxMs ?? 15000)); // 错峰

  const counts = { like: 0, follow: 0, comment: 0 };
  let chargedCredits = 0; // 该号本次累计扣费(积分),每笔互动动作扣费后累加
  let chargedUsd = 0;     // 同上,美元(后端按 token_price_per_million 算好)
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
      // 跑任务时不注入角标:降低页面足迹(风控最敏感时段),账号在进度面板里看即可。
    });
    await kernelNavigate(accountId, PLATFORM_HOME[opts.platform] || 'https://www.douyin.com/');
    await sleep(2000);

    // 跑前登录态检查:cookie 过期 / 没关联 → 跳过该号 + 标「需关联」(其它号照跑),不空转。
    let loggedIn = true;
    try { loggedIn = await checkKernelLogin(accountId, opts.platform); } catch { loggedIn = true; } // 读失败不误杀
    if (!loggedIn) {
      setAccountStatus(accountId, 'login_required');
      log('⚠️ 登录态失效/未关联,跳过(请到「我的矩阵账号」重新扫码关联)');
      return { accountId, state: 'skipped', reason: 'login_expired' };
    }

    // orchestrator 需要的 task(配额从 opts.quota,缺省回落 scenario manifest 默认)
    const task: any = {
      id: accountId, keywords: acc.keywords, track: acc.track || 'douyin_default',
      // 人设 → 复用老剧本现成的 comment_prompt 槽(comment_composer 的 user_prompt 口味提示),
      // 不另造 persona 路径(老抖音剧本本就支持,backend 零改动)。
      comment_prompt: acc.persona || '',
      daily_like_min: q.daily_like_min, daily_like_max: q.daily_like_max,
      daily_follow_min: q.daily_follow_min, daily_follow_max: q.daily_follow_max,
      daily_comment_min: q.daily_comment_min, daily_comment_max: q.daily_comment_max,
    };

    // 写评论等 AI 调用的扣费也累进「本次消耗」(与动作按次扣费相加,二者是不同的账,不重复)。
    const aiCall = makeAiCall(pack, authToken, log, (credits: number, usd: number) => {
      chargedCredits += credits; chargedUsd += usd;
      try { opts.onItem?.({ accountId, state: 'success', counts: { ...counts }, chargedCredits, chargedUsd }); } catch { /* ignore */ }
    });
    const browserFn: any = (command: string, params?: any, timeout?: number) => matrixCmd(accountId, command, params, timeout);
    // task-tab 对象:orchestrator 在 _activeTab 上调 browser/navigate/scroll/id。
    // 内核单页,全部路由到本账号的 CDP(之前只返回 {id} 导致 _activeTab.navigate is not a function)。
    const taskTab: any = {
      id: 'main',
      browser: browserFn,
      navigate: async (url: string) => { await kernelNavigate(accountId, url); },
      scroll: (amount?: number) => matrixCmd(accountId, 'scroll', { amount: amount || randInt(2, 4) }),
    };

    // 扣费包装:调后端扣费 → 成功就累加 charged(积分)+ cost_usd,并推一次 onItem 让「本次消耗」实时更新。
    const doCharge = async (a: string, p: string, r?: string) => {
      const res: any = await chargeAction(authToken, a, p, r);
      if (res && res.ok) {
        chargedCredits += Number(res.charged) || 0;
        chargedUsd += Number(res.cost_usd) || 0;
        try { opts.onItem?.({ accountId, state: 'success', counts: { ...counts }, chargedCredits, chargedUsd }); } catch { /* ignore */ }
      }
      return res;
    };

    const ctx: any = {
      task, config: pack?.config || {}, manifest: pack?.manifest || {},
      appLocale: 'zh',
      aborted: () => !!opts.signal?.aborted, // 剧本每个动作前查这个 → 停止后中途退出
      // 浏览器
      browser: browserFn,
      navigate: (url: string) => kernelNavigate(accountId, url),
      scroll: (amount?: number) => matrixCmd(accountId, 'scroll', { amount: amount || randInt(2, 4) }),
      // task-tab:内核单页,openTab=导航并返回伪 tab,getTaskTab 复用
      openTab: async (o: any) => { if (o?.url) { await kernelNavigate(accountId, o.url); await sleep(1500); } return taskTab; },
      getTaskTab: async () => taskTab,
      // 进度/日志(同时写 cowork.log,方便真机排查互动卡在哪一步)
      report: (m: string) => { log(m); try { coworkLog('INFO', 'engage', `[${accountId}] ${m}`); } catch { /* ignore */ } },
      stepStart: (s: number) => log('▶ 步骤 ' + s),
      stepLog: (_s: number, _st: string, m: string) => log(m),
      stepDone: (_s: number) => {},
      startAction: (..._a: any[]) => {},
      stepResetAll: () => {},
      setActionTargets: (t: any) => { log(`🎯 配额 赞${t.like}/关${t.follow}/评${t.comment}`); try { opts.onTargets?.(accountId, { like: t.like, follow: t.follow, comment: t.comment }); } catch { /* ignore */ } },
      addActionCount: (type: string, n: number) => { if (type in counts) (counts as any)[type] += n; opts.onItem?.({ accountId, state: 'success', counts: { ...counts }, chargedCredits, chargedUsd }); },
      finish: (status: string, error?: string) => { finished = { status, error }; },
      // 计费 / AI / 去重 —— 扣费成功就把 charged(积分)+ cost_usd 累加,并推一次 onItem 让「本次消耗」实时跳。
      chargeAction: doCharge,
      charge: doCharge,
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
    if (!code) { coworkLog('ERROR', 'engage', `[${accountId}] no_orchestrator`); return { accountId, state: 'failed', reason: 'no_orchestrator' }; }
    const fn = new AsyncFunction('ctx', code);
    await fn(ctx);

    setAccountStatus(accountId, 'idle');
    const fin = finished as { status: string; error?: string } | null;
    if (fin && fin.status === 'error') { coworkLog('ERROR', 'engage', `[${accountId}] finished error: ${fin.error}`); return { accountId, state: 'failed', counts, chargedCredits, chargedUsd, reason: fin.error }; }
    coworkLog('INFO', 'engage', `[${accountId}] done 赞${counts.like}/关${counts.follow}/评${counts.comment} · 扣费 ${chargedCredits}积分`);
    return { accountId, state: 'success', counts, chargedCredits, chargedUsd };
  } catch (e: any) {
    setAccountStatus(accountId, 'idle');
    coworkLog('ERROR', 'engage', `[${accountId}] threw: ${String(e?.stack || e?.message || e).slice(0, 300)}`);
    // 抛错前可能已经扣过几笔 —— 钱已花,照样回传,别让「已扣的费」从消耗统计里消失。
    return { accountId, state: 'failed', counts, chargedCredits, chargedUsd, reason: 'engage_threw:' + String(e?.message || e).slice(0, 140) };
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
  // 内核校验(手动 + 定时统一兜底):没装指纹浏览器且没显式路径 → 整个任务【不跑】,
  // 抛 NO_KERNEL 让上层弹「去下载」。否则定时任务会空转、每个号都失败。
  if (!opts.kernelPath && !installedKernelPath()) {
    throw new Error(`${NO_KERNEL_ERROR}: 指纹浏览器内核未安装,请先到「我的矩阵账号」下载内核`);
  }
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
