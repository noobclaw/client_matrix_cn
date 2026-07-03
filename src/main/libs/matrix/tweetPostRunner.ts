/**
 * 矩阵「自动发推」运行时(目前仅推特 X)—— 让一批账号在各自指纹内核里各自 AI 原创一条推文并发布。
 *
 * 复用后端 fork 的 x_post orchestrator(单账号单条:取材[web3 资讯/自由] → Pro 原创 → 可选 AI 配图
 * → 发到各自时间线),这里提供它需要的整套 ctx,把浏览器命令路由到该账号的 CDP(matrixCmd),
 * AI/配图调后端、计费走 AI token(发推本身不收平台费,同旧 x_post_creator)。
 *
 * 结构与 imageTextRunner 对齐(onLog/onItem/onTargets/signal → EngageReport),sidecar 进度聚合零改动复用。
 * 与 image_text 的差异:登录预检导航推特首页(发推在主站,非创作者中心);每号身份=人设/赛道/关键词,
 * 加 mode(web3/free)/withImage/language/isBlueV/autoPublish 全局配置 + 可选各号参考文案(free 模式)。
 *
 * ⚠️ 推特必走 VPN/代理,首屏慢;orchestrator 的 compose selector/上传/发布在指纹内核 CDP 上第一次跑
 *    大概率要据真机反馈微调。这是预期内的。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { coworkLog } from '../coworkLogger';
import { launchKernel, kernelNavigate, closeKernel, checkKernelLogin, NO_KERNEL_ERROR } from './kernelPool';
import { installedKernelPath } from './kernelInstaller';
import { matrixCmd } from './cdpCommands';
import { getAccount, setAccountStatus, accountBadgeLabel, matrixGroupTitle, markAccountAlive, platformKey } from './accountManager';
import { promptReloginForExpiredAccount } from './reloginPrompt';
import { getNoobClawAuthToken } from '../claudeSettings';
import type { EngageItemResult, EngageReport } from './engageRunner';
import type { TweetPostConfig } from './types';

const DEFAULT_BASE_URL = 'https://api.noobclaw.com';
function baseUrl(): string { return process.env.NOOBCLAW_API_BASE_URL || DEFAULT_BASE_URL; }
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
function randInt(min: number, max: number): number {
  const lo = Math.min(min, max), hi = Math.max(min, max);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}
// 发推在推特主站操作(非创作者中心)。
const TWEET_LOGIN_HOME: Record<string, string> = {
  x: 'https://x.com/home',
};

export interface TweetPostTaskOptions {
  platform: string;                 // 目前 x
  taskId?: string;
  accountIds: string[];
  config: TweetPostConfig;          // 发推配置(模式/配图/语言/蓝V/发布/各号参考文案)
  concurrency?: number;
  jitterMinMs?: number; jitterMaxMs?: number;
  kernelPath?: string;
  authToken?: string;
  signal?: AbortSignal;
  onLog?: (accountId: string, msg: string) => void;
  onItem?: (item: EngageItemResult) => void;
  onTargets?: (accountId: string, targets: { like?: number; follow?: number; comment?: number }) => void;
}

// ── scenario pack 下发(/api/matrix/scenarios/x_post)──
async function fetchPack(id: string): Promise<any | null> {
  try {
    const res = await fetch(`${baseUrl()}/api/matrix/scenarios/${id}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    coworkLog('WARN', 'tweetPostRunner', 'fetch pack failed', { err: String(e) });
    return null;
  }
}

// ── aiCall(同 imageTextRunner 口径:'__raw__' → system=prompt / user=JSON)──
function makeAiCall(authToken: string | undefined, onCost?: (credits: number, usd: number) => void, signal?: AbortSignal) {
  return async (promptNameOrRaw: string, promptOrInput: any, rawInput?: string, opts?: any) => {
    const prompt = promptNameOrRaw === '__raw__' ? String(promptOrInput) : String(promptOrInput || '');
    const userMessage = promptNameOrRaw === '__raw__'
      ? String(rawInput || '')
      : (typeof promptOrInput === 'string' ? promptOrInput : JSON.stringify(promptOrInput));
    if (!authToken) throw new Error('AI_NOT_CONFIGURED');
    const body: any = {
      model: (opts && opts.model) || 'noobclawai-chat',
      messages: [{ role: 'system', content: prompt }, { role: 'user', content: userMessage }],
      stream: false, max_tokens: (opts && opts.max_tokens) || 3072,
    };
    const wantJson = opts?.expectJson !== false;
    if (wantJson && (/json/i.test(prompt) || /json/i.test(userMessage))) body.response_format = { type: 'json_object' };
    else if (!wantJson) body.response_format = { type: 'text' };
    const res = await fetch(`${baseUrl()}/api/ai/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify(body),
      signal,
    });
    const data: any = await res.json().catch(() => ({}));
    // 后端非 2xx(余额不足 402 / 内容审核 / 限流 / 5xx)必须抛错,不能把 {error,message}
    //   当成空 content 静默吞掉 —— 否则上层只看到空串误报「返回空」,看不出是余额不足。
    if (!res.ok) {
      const beMsg = String((data && (data.message || data.error)) || ('http_' + res.status));
      if (res.status === 402 || /INSUFFICIENT_TOKENS|insufficient|余额/i.test(beMsg)) throw new Error('余额不足,请充值后重试 (' + beMsg + ')');
      throw new Error('AI 请求失败 ' + res.status + ': ' + beMsg);
    }
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

// 多平台通用验证码检测(同 imageTextRunner)。
const CAPTCHA_DETECT_EXPR = "(function(){try{"
  + "if(document.querySelector('#captcha_container,#captcha-verify-image,[id*=\"captcha\" i][class*=\"verify\" i],[class*=\"captcha_verify\" i],[class*=\"geetest\" i]'))return true;"
  + "var b=document.body?(document.body.innerText||'').slice(0,3000):'';"
  + "if(/Verify you are human|请完成安全验证|向右滑动|拖动滑块/i.test(b))return true;"
  + "return false;}catch(e){return false;}})()";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function runOne(opts: TweetPostTaskOptions, pack: any, accountId: string): Promise<EngageItemResult> {
  const acc = getAccount(accountId);
  const cfg = opts.config;
  const log = (m: string) => { try { opts.onLog?.(accountId, m); } catch { /* ignore */ } };
  if (opts.signal?.aborted) { log('⏹ 已停止,跳过本号'); return { accountId, state: 'skipped', reason: 'aborted' }; }
  if (!acc) { log('❌ 跳过:账号不存在'); return { accountId, state: 'skipped', reason: 'account_not_found' }; }
  if (acc.platform !== opts.platform) { log('❌ 跳过:账号平台与任务不符'); return { accountId, state: 'skipped', reason: 'platform_mismatch' }; }
  if (acc.status === 'banned' || acc.status === 'limited') { log('❌ 跳过:账号状态为 ' + acc.status); return { accountId, state: 'skipped', reason: 'account_' + acc.status }; }

  await sleep(randInt(opts.jitterMinMs ?? 3000, opts.jitterMaxMs ?? 15000)); // 错峰

  const counts = { like: 0, follow: 0, comment: 0, post: 0 };
  let chargedCredits = 0, chargedUsd = 0;
  const authToken = opts.authToken || getNoobClawAuthToken() || undefined;
  let finished: { status: string; error?: string } | null = null;

  try {
    setAccountStatus(accountId, 'running');
    log('启动指纹内核');
    await launchKernel({
      accountId, kernelPath: opts.kernelPath, kernelVersion: acc.kernelVersion,
      userDataDir: acc.userDataDir, fingerprint: acc.fingerprint, proxy: acc.proxy,
      label: accountBadgeLabel(acc),
      groupTitle: matrixGroupTitle(opts.platform, opts.taskId),
    });
    // 发推在主站 —— 先导航推特首页校验登录态(对齐 feedback_matrix_task_login_precheck)。
    await kernelNavigate(accountId, TWEET_LOGIN_HOME[opts.platform] || TWEET_LOGIN_HOME.x);
    await sleep(2500);
    let loggedIn = true;
    try { loggedIn = await checkKernelLogin(accountId, platformKey(acc)); } catch { loggedIn = true; }
    if (!loggedIn) {
      setAccountStatus(accountId, 'login_required');
      log('⚠️ 推特登录态失效/未关联,弹窗扫码重连(其它号照跑)');
      if (!opts.signal?.aborted) { try { await promptReloginForExpiredAccount(accountId); } catch { /* ignore */ } }
      return { accountId, state: 'skipped', reason: 'login_expired' };
    }
    markAccountAlive(accountId);

    // 本号 task —— mode/withImage/language/isBlueV/autoPublish 走全局 config;persona/track/keywords 用账号已配身份;
    // reference 取本号参考文案(仅 free 模式有意义,可空)。
    const ref = cfg.references?.[accountId];
    const accKeywords = Array.isArray(acc.keywords) ? acc.keywords.filter((k) => String(k || '').trim()) : [];
    const task: any = {
      id: accountId,
      mode: cfg.mode === 'free' ? 'free' : 'web3',
      with_image: !!cfg.withImage,
      language: cfg.language || 'mixed',
      is_blue_v: !!cfg.isBlueV,
      auto_upload: !!cfg.autoPublish,
      persona: acc.persona || '',
      track: acc.track || '',
      keywords: accKeywords,
      reference: ref || '',
    };

    const onAiCost = (credits: number, usd: number) => {
      chargedCredits += credits; chargedUsd += usd;
      try { opts.onItem?.({ accountId, state: 'success', counts: { ...counts }, chargedCredits, chargedUsd }); } catch { /* ignore */ }
    };
    const aiCall = makeAiCall(authToken, onAiCost, opts.signal);
    const browserFn: any = (command: string, params?: any, timeout?: number) => matrixCmd(accountId, command, params, timeout);
    const taskTab: any = {
      id: 'main', browser: browserFn,
      navigate: async (url: string) => { await kernelNavigate(accountId, url); },
      scroll: (amount?: number) => matrixCmd(accountId, 'scroll', { amount: amount || randInt(2, 4) }),
    };

    // apiCall:/api/scenario/fresh-news(GET 带 query)+ /api/image/generate(POST)+ /api/image/status/:id(GET)。
    const apiCall = async (endpoint: string, body?: any) => {
      const res = await fetch(`${baseUrl()}${endpoint}`, {
        method: body == null ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
        body: body == null ? undefined : JSON.stringify(body),
        signal: opts.signal,
      });
      return await res.json().catch(() => ({}));
    };

    const ctx: any = {
      task, config: pack?.config || {}, manifest: pack?.manifest || {},
      appLocale: cfg.language === 'en' ? 'en' : 'zh',
      aborted: () => !!opts.signal?.aborted,
      browser: browserFn,
      navigate: (url: string) => kernelNavigate(accountId, url),
      scroll: (amount?: number) => matrixCmd(accountId, 'scroll', { amount: amount || randInt(2, 4) }),
      openTab: async (o: any) => { if (o?.url) { await kernelNavigate(accountId, o.url); await sleep(1500); } return taskTab; },
      getTaskTab: async () => taskTab,
      report: (m: string) => { log(m); try { coworkLog('INFO', 'tweetPost', `[${accountId}] ${m}`); } catch { /* ignore */ } },
      stepStart: (s: number) => log('▶ 步骤 ' + s),
      stepLog: (_s: number, _st: string, m: string) => log(m),
      stepDone: (_s: number) => {},
      startAction: (..._a: any[]) => {},
      stepResetAll: () => {},
      setActionTargets: (t: any) => { if (typeof t?.post === 'number') log(`🎯 本号目标:发 ${t.post} 条推`); },
      addActionCount: (type: string, n: number) => {
        if (type === 'post') { counts.post += Number(n) || 0; log(`✅ 已发布 ${counts.post} 条`); }
        try { opts.onItem?.({ accountId, state: 'success', counts: { ...counts }, chargedCredits, chargedUsd }); } catch { /* ignore */ }
      },
      finish: (status: string, error?: string) => { finished = { status, error }; },
      aiCall,
      apiCall,
      // 落盘:文案 + 配图(源原图/AI 图)存一份到本地,返回 { dir } 供 orchestrator 打到日志尾巴。
      // 对齐 imageTextRunner 的 saveDrafts(inline 不抽公用件);发布与仅本地两种模式 orchestrator 都会调。
      saveDrafts: async (arr: any[]) => {
        try {
          const base = process.env.NOOBCLAW_MATRIX_DIR || path.join(os.homedir(), 'NoobClaw', 'matrix');
          const draftsBase = path.join(base, 'drafts', opts.platform || acc.platform || 'x', accountId);
          let lastDir = '';
          for (const d of (Array.isArray(arr) ? arr : [])) {
            const rawId = String(d?.source_post?.external_post_id || `draft_${Date.now()}`);
            const safeId = rawId.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
            const dir = path.join(draftsBase, safeId);
            fs.mkdirSync(dir, { recursive: true });
            if (d?.text) { try { fs.writeFileSync(path.join(dir, 'text.txt'), String(d.text), 'utf8'); } catch { /* ignore */ } }
            fs.writeFileSync(path.join(dir, 'draft.json'), JSON.stringify(d, null, 2), 'utf8');
            const imgs = Array.isArray(d?.images) ? d.images : [];
            for (let i = 0; i < imgs.length; i++) {
              const img = imgs[i];
              if (img && img.base64) {
                const ext = String(img.mimeType || '').indexOf('png') >= 0 ? 'png' : 'jpg';
                try { fs.writeFileSync(path.join(dir, `img_${i}.${ext}`), Buffer.from(img.base64, 'base64')); } catch { /* ignore */ }
              }
            }
            lastDir = dir;
          }
          return { ok: true, dir: lastDir };
        } catch (err: any) {
          return { ok: false, reason: String(err?.message || err) };
        }
      },
      getPrompt: (name: string) => { const t = pack?.prompts?.[name]; if (!t) throw new Error('Missing prompt: ' + name); return t; },
      appendKeywords: (_arr: string[]) => { /* matrix: no-op */ },
      sleep: (min: number, max?: number) => new Promise<void>((resolve) => {
        const ms = max ? randInt(min, max) : min;
        if (opts.signal?.aborted) return resolve();
        const t = setTimeout(resolve, ms);
        try { opts.signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true }); } catch { /* ignore */ }
      }),
      waitForCaptchaCleared: async (o?: { maxMs?: number }) => {
        const maxMs = (o && o.maxMs) || 180000;
        const startedWait = Date.now();
        let notified = false;
        while (Date.now() - startedWait < maxMs) {
          if (opts.signal?.aborted) return { ok: false, reason: 'aborted' };
          let showing = false;
          try { const r: any = await matrixCmd(accountId, 'cdp_eval', { expression: CAPTCHA_DETECT_EXPR }); showing = !!(r && (r.value === true || r.value === 'true')); } catch { showing = false; }
          if (!showing) { if (notified) log('✅ 验证码已通过,继续任务'); return { ok: true }; }
          if (!notified) { notified = true; log('🧩 检测到验证码,请在该账号浏览器窗口【手动完成验证】(最多等 ' + Math.round(maxMs / 60000) + ' 分钟,过了自动继续)…'); }
          await sleep(4000);
        }
        log('⏱ 验证码等待超时,放弃本号');
        return { ok: false, reason: 'captcha_timeout' };
      },
      randInt,
      log: (m: string) => coworkLog('INFO', 'tweetPost-orch', m),
    };

    const code = pack?.orchestrator;
    if (!code) { coworkLog('ERROR', 'tweetPost', `[${accountId}] no_orchestrator`); return { accountId, state: 'failed', reason: 'no_orchestrator' }; }
    const fn = new AsyncFunction('ctx', code);
    await fn(ctx);

    setAccountStatus(accountId, 'idle');
    const fin = finished as { status: string; error?: string } | null;
    if (fin && fin.status === 'error') {
      coworkLog('ERROR', 'tweetPost', `[${accountId}] finished error: ${fin.error}`);
      return { accountId, state: 'failed', counts, chargedCredits, chargedUsd, reason: fin.error };
    }
    coworkLog('INFO', 'tweetPost', `[${accountId}] done 发 ${counts.post} 条 · 扣费 ${chargedCredits}积分`);
    return { accountId, state: 'success', counts, chargedCredits, chargedUsd };
  } catch (e: any) {
    setAccountStatus(accountId, 'idle');
    coworkLog('ERROR', 'tweetPost', `[${accountId}] threw: ${String(e?.stack || e?.message || e).slice(0, 300)}`);
    return { accountId, state: 'failed', counts, chargedCredits, chargedUsd, reason: 'tweetpost_threw:' + String(e?.message || e).slice(0, 140) };
  } finally {
    // 完成后留 20s 让用户检查浏览器里的结果再关窗(点「停止」立即关、不等)。
    if (!opts.signal?.aborted) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 20000);
        try { opts.signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true }); } catch { /* ignore */ }
      });
    }
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

export async function runTweetPostTask(opts: TweetPostTaskOptions): Promise<EngageReport> {
  if (!opts.kernelPath && !installedKernelPath()) {
    throw new Error(`${NO_KERNEL_ERROR}: 指纹浏览器内核未安装,请先到「我的矩阵账号」下载内核`);
  }
  const k = Math.max(1, Math.min(opts.concurrency ?? 3, 10));
  // 没选账号 → 直接空转完成会「瞬间结束、零日志」,先广播一条说明,别让用户摸不着头脑。
  if (!opts.accountIds.length) {
    opts.onLog?.('', '⚠️ 本任务未选择任何账号,无可执行对象(请编辑任务勾选已登录的推特账号)');
    coworkLog('WARN', 'tweetPostRunner', 'no accounts on task', { taskId: opts.taskId });
    return { platform: opts.platform, total: 0, success: 0, failed: 0, skipped: 0, items: [] };
  }
  const scenarioId = `${opts.platform}_post`;
  const pack = await fetchPack(scenarioId);
  if (!pack || !pack.orchestrator) {
    // 后端剧本拉取失败(未部署 / 网络 / 超时)→ 以前是静默全员 skipped、一行日志都不打,
    // 用户只看到「运行一下就结束、没有日志」。现在每个号都广播原因,便于定位。
    const reason = `❌ 后端发推剧本(${scenarioId})拉取失败:可能后端未部署该剧本,或网络/VPN 不通 ${baseUrl()}。本次跳过`;
    coworkLog('ERROR', 'tweetPostRunner', 'fetch pack returned null', { scenarioId, base: baseUrl() });
    for (const id of opts.accountIds) {
      opts.onLog?.(id, reason);
      try { opts.onItem?.({ accountId: id, state: 'skipped', reason: 'no_scenario(后端未部署?)' }); } catch { /* ignore */ }
    }
    return {
      platform: opts.platform, total: opts.accountIds.length, success: 0, failed: 0, skipped: opts.accountIds.length,
      items: opts.accountIds.map((id) => ({ accountId: id, state: 'skipped' as const, reason: 'no_scenario(后端未部署?)' })),
    };
  }
  coworkLog('INFO', 'tweetPostRunner', `x_post ${opts.platform} x${opts.accountIds.length} (${scenarioId})`);
  const items = await runPool(opts.accountIds, k, (id) => runOne(opts, pack, id), opts.onItem);
  return {
    platform: opts.platform, total: items.length,
    success: items.filter((x) => x.state === 'success').length,
    failed: items.filter((x) => x.state === 'failed').length,
    skipped: items.filter((x) => x.state === 'skipped').length,
    items,
  };
}
