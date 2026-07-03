/**
 * 矩阵「图文创作」运行时(平台通用:抖音 / 小红书…)—— 让一批账号在各自指纹内核里各自生成+配图+发布图文。
 *
 * 复用后端 fork 的 <platform>_image_text orchestrator(单账号版的 4 个 STEP:抽灵感/身份种子 →
 * AI 改写(含维度化创意引擎)→ 配图(AI 生图 或 平台搜实景图)→ 发到各自创作者中心),
 * 这里提供它需要的整套 ctx,把浏览器命令路由到该账号的 CDP(matrixCmd),AI/配图调后端、
 * 计费走 /api/charge/action。平台由 opts.platform 决定(scenarioId、登录预检导航 URL 都按它取)。
 *
 * 与 engageRunner 的差异(本场景独有,故新建 runner 而非塞进 engage):
 *   · ctx 多 saveDrafts(改写稿+配图落盘)、apiCall(/api/image/generate 生图+轮询)。
 *   · 每号身份:source_segments=本号可选参考文案(空则按赛道/人设/关键词合成种子)、
 *     real_photo_keywords=本号关键词(网络图按各号不同词搜 → 天然不撞图)。
 *   · 进度维度是「发帖 post」而非点赞/关注/评论。
 *
 * 回调签名与 EngageTaskOptions 对齐(onLog/onItem/onTargets/signal),返回 EngageReport,
 * 这样 sidecar 的进度聚合闭包零改动即可复用(与 engage/reply_fan/video_download 同款)。
 *
 * ⚠️ orchestrator 的 DOM 选择器/上传/发布策略按真实抖音创作者中心调过;在指纹内核 CDP 上第一次
 *    跑大概率要据真机反馈微调(尤其多图上传 selector、话题 pill)。这是预期内的,不是写错。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { coworkLog } from '../coworkLogger';
import { launchKernel, kernelNavigate, closeKernel, checkKernelLogin, NO_KERNEL_ERROR } from './kernelPool';
import { installedKernelPath } from './kernelInstaller';
import { matrixCmd } from './cdpCommands';
import { getAccount, setAccountStatus, appendDerivedKeywords, effectiveKeywords, accountBadgeLabel, matrixGroupTitle, markAccountAlive, platformKey } from './accountManager';
import { promptReloginForExpiredAccount } from './reloginPrompt';
import { getNoobClawAuthToken } from '../claudeSettings';
import type { EngageItemResult, EngageReport } from './engageRunner';
import type { ImageTextConfig } from './types';

const DEFAULT_BASE_URL = 'https://api.noobclaw.com';
function baseUrl(): string { return process.env.NOOBCLAW_API_BASE_URL || DEFAULT_BASE_URL; }
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
function randInt(min: number, max: number): number {
  const lo = Math.min(min, max), hi = Math.max(min, max);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}
function matrixDir(): string { return process.env.NOOBCLAW_MATRIX_DIR || path.join(os.homedir(), 'NoobClaw', 'matrix'); }
// 登录预检导航 URL(图文发布在创作者中心,按平台取;主站登录态覆盖创作端的也走创作端页确认)。
const IMAGE_TEXT_LOGIN_HOME: Record<string, string> = {
  douyin: 'https://creator.douyin.com/',
  xhs: 'https://creator.xiaohongshu.com/',
};

export interface ImageTextTaskOptions {
  platform: string;                 // 目前 douyin
  taskId?: string;
  accountIds: string[];
  config: ImageTextConfig;          // 图文创作配置(配图方式/张数/篇数/风格/发布/各号参考文案)
  concurrency?: number;
  jitterMinMs?: number; jitterMaxMs?: number;
  kernelPath?: string;
  authToken?: string;
  signal?: AbortSignal;
  onLog?: (accountId: string, msg: string) => void;
  onItem?: (item: EngageItemResult) => void;
  onTargets?: (accountId: string, targets: { like?: number; follow?: number; comment?: number }) => void;
}

// ── scenario pack 下发(/api/matrix/scenarios/douyin_image_text)──
async function fetchPack(id: string): Promise<any | null> {
  try {
    const res = await fetch(`${baseUrl()}/api/matrix/scenarios/${id}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    coworkLog('WARN', 'imageTextRunner', 'fetch pack failed', { err: String(e) });
    return null;
  }
}

// ── 简化版 aiCall(改写文案 / 衍生关键词)——同 engageRunner 口径 ──
function makeAiCall(authToken: string | undefined, onCost?: (credits: number, usd: number) => void, signal?: AbortSignal) {
  return async (promptNameOrRaw: string, promptOrInput: any, rawInput?: string, opts?: any) => {
    // 本 runner 的 orchestrator 只用 '__raw__'(把 filledPrompt 当 system、JSON 当 user)。
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
    //   当成空 content 静默吞掉 —— 否则 orchestrator 只看到空串,误报「改写返回空 (1秒)」,
    //   用户看不出是余额不足。抛带原因的 Error → aiCallWithRetry 归类确定性失败不空转、
    //   orchestrator catch 显示「改写失败: 余额不足...」;5xx 仍会重试一次。
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
    return { ok: true, charged: Number(data?.charged) || 0, cost_usd: Number(data?.cost_usd) || 0, balance_after: data?.balance_after };
  } catch { return { ok: false, reason: 'network_error' }; }
}

// 多平台通用验证码检测(同 engageRunner)。撞码不停,提示用户在该账号窗口手动过、轮询到消失就继续。
const CAPTCHA_DETECT_EXPR = "(function(){try{"
  + "if(document.querySelector('#captcha_container,#captcha-verify-image,[id*=\"captcha\" i][class*=\"verify\" i],[class*=\"captcha_verify\" i],[class*=\"vc_captcha\" i],[class*=\"captcha-container\" i],[class*=\"captcha-slider\" i],[class*=\"secsdk-captcha\" i],[class*=\"geetest\" i],[class*=\"red-captcha\" i],[class*=\"sc-captcha\" i]'))return true;"
  + "var b=document.body?(document.body.innerText||'').slice(0,3000):'';"
  + "if(/向右滑动|拖动滑块|拖动下方滑块|完成拼图|按住滑块|滑动完成验证|Verify you are human|请完成安全验证/i.test(b))return true;"
  + "return false;}catch(e){return false;}})()";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// 把账号的参考文案切成 source_segments(按空行/换行分段,过滤空)。
function referenceToSegments(ref: string | undefined): string[] {
  if (!ref) return [];
  return String(ref).split(/\n{2,}|\r\n\r\n/).map((s) => s.trim()).filter((s) => s.length > 0);
}

async function runOne(opts: ImageTextTaskOptions, pack: any, accountId: string, downloadAccountId?: string): Promise<EngageItemResult> {
  const acc = getAccount(accountId);
  const cfg = opts.config;
  const log = (m: string) => { try { opts.onLog?.(accountId, m); } catch { /* ignore */ } };
  if (opts.signal?.aborted) return { accountId, state: 'skipped', reason: 'aborted' };
  if (!acc) { log('❌ 跳过:账号不存在'); return { accountId, state: 'skipped', reason: 'account_not_found' }; }
  if (acc.platform !== opts.platform) { log('❌ 跳过:账号平台与任务不符'); return { accountId, state: 'skipped', reason: 'platform_mismatch' }; }
  if (acc.status === 'banned' || acc.status === 'limited') { log('❌ 跳过:账号状态为 ' + acc.status); return { accountId, state: 'skipped', reason: 'account_' + acc.status }; }
  // 网络图模式靠本号关键词搜实景图 —— 没关键词且没填参考文案就没法搜,跳过(AI 生图模式不强制)。
  const accKeywords = effectiveKeywords(acc); // 原始 + AI 衍生池
  if (cfg.useRealPhotos && accKeywords.length === 0) {
    log('❌ 跳过:网络图模式需要本号关键词(到「我的矩阵账号」编辑里添加)');
    return { accountId, state: 'skipped', reason: 'no_keywords_for_real_photos' };
  }

  await sleep(randInt(opts.jitterMinMs ?? 3000, opts.jitterMaxMs ?? 15000)); // 错峰

  // 本场景不产生 like/follow/comment(留 0 对齐 EngageItemResult);完成维度是 post(发帖数)。
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
    // 图文发布在创作者中心 —— 先导航对应平台创作者中心校验登录态(对齐 feedback_matrix_task_login_precheck)。
    await kernelNavigate(accountId, IMAGE_TEXT_LOGIN_HOME[opts.platform] || IMAGE_TEXT_LOGIN_HOME.douyin);
    await sleep(2000);
    let loggedIn = true;
    try { loggedIn = await checkKernelLogin(accountId, platformKey(acc)); } catch { loggedIn = true; }
    if (!loggedIn) {
      setAccountStatus(accountId, 'login_required');
      log('⚠️ 创作者中心登录态失效/未关联,弹窗扫码重连(其它号照跑)');
      if (!opts.signal?.aborted) { try { await promptReloginForExpiredAccount(accountId); } catch { /* ignore */ } }
      return { accountId, state: 'skipped', reason: 'login_expired' };
    }
    markAccountAlive(accountId);

    // 本号 task —— source_segments=本号参考文案(可选);real_photo_keywords=本号关键词(各号不同→不撞图);
    // track/persona/keywords 沿用账号已配身份;配图方式/张数/篇数/风格/发布走全局 config。
    const ref = cfg.references?.[accountId];
    const task: any = {
      id: accountId,
      source_segments: referenceToSegments(ref),
      track: acc.track || '',
      persona: acc.persona || '',
      keywords: accKeywords,
      daily_count: Math.max(1, Math.min(50, Number(cfg.dailyCount) || 1)),
      use_real_photos: !!cfg.useRealPhotos,
      real_photo_count: Math.max(2, Math.min(6, Number(cfg.imageCount) || 2)),
      real_photo_keywords: accKeywords.join(' '),
      ai_image_style: cfg.aiImageStyle || 'ai_auto',
      // 发布方式:autoPublish=true → 上传并发布(群发);false → 仅本地(不上传,落盘供用户逐条审核后手动发)。
      auto_upload: !!cfg.autoPublish,
      auto_publish: !!cfg.autoPublish,
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
    // 网络图下图 tab(仅视频号/头条网络图模式有):routed 到【抖音下图内核】(已登录抖音的号),
    // orchestrator 的 _douyinTab 走它在抖音登录态搜图 + fetch_image,与发布号(taskTab)分开。
    // 下图内核由 runImageTextTask 统一启停(整任务串行共用一个),这里只路由命令。
    const downloadTab: any = downloadAccountId ? {
      id: 'douyin_dl',
      browser: (command: string, params?: any, timeout?: number) => matrixCmd(downloadAccountId, command, params, timeout),
      navigate: async (url: string) => { await kernelNavigate(downloadAccountId, url); },
      scroll: (amount?: number) => matrixCmd(downloadAccountId, 'scroll', { amount: amount || randInt(2, 4) }),
    } : null;

    const doCharge = async (a: string, p: string, r?: string) => {
      const res: any = await chargeAction(authToken, a, p, r);
      if (res && res.ok) {
        chargedCredits += Number(res.charged) || 0;
        chargedUsd += Number(res.cost_usd) || 0;
        try { opts.onItem?.({ accountId, state: 'success', counts: { ...counts }, chargedCredits, chargedUsd }); } catch { /* ignore */ }
      }
      return res;
    };

    // apiCall:/api/image/generate(POST 带 body)+ /api/image/status/:id(GET 不带 body)。
    const apiCall = async (endpoint: string, body?: any) => {
      const res = await fetch(`${baseUrl()}${endpoint}`, {
        method: body == null ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
        body: body == null ? undefined : JSON.stringify(body),
        signal: opts.signal,
      });
      return await res.json().catch(() => ({}));
    };

    // saveDrafts:改写稿 + 配图落盘到 <matrixDir>/drafts/douyin/<accountId>/<draftId>/,返回 { dir }。
    const draftsBase = path.join(matrixDir(), 'drafts', opts.platform || 'douyin', accountId);
    const saveDrafts = async (arr: any[]) => {
      try {
        let lastDir = '';
        for (const d of (Array.isArray(arr) ? arr : [])) {
          const rawId = String(d?.source_post?.external_post_id || `draft_${Date.now()}`);
          const safeId = rawId.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
          const dir = path.join(draftsBase, safeId);
          fs.mkdirSync(dir, { recursive: true });
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
    };

    const ctx: any = {
      task, config: pack?.config || {}, manifest: pack?.manifest || {},
      appLocale: 'zh',
      aborted: () => !!opts.signal?.aborted,
      browser: browserFn,
      navigate: (url: string) => kernelNavigate(accountId, url),
      scroll: (amount?: number) => matrixCmd(accountId, 'scroll', { amount: amount || randInt(2, 4) }),
      // platform:'douyin' 的 tab(网络图借抖音搜图)→ 路由到抖音下图内核;其它(发布 tab)→ 本发布号内核。
      openTab: async (o: any) => {
        if (o?.platform === 'douyin' && downloadTab && downloadAccountId) {
          if (o?.url) { await kernelNavigate(downloadAccountId, o.url); await sleep(1500); }
          return downloadTab;
        }
        if (o?.url) { await kernelNavigate(accountId, o.url); await sleep(1500); }
        return taskTab;
      },
      getTaskTab: async () => taskTab,
      report: (m: string) => { log(m); try { coworkLog('INFO', 'imageText', `[${accountId}] ${m}`); } catch { /* ignore */ } },
      stepStart: (s: number) => log('▶ 步骤 ' + s),
      stepLog: (_s: number, _st: string, m: string) => log(m),
      stepDone: (_s: number) => {},
      startAction: (..._a: any[]) => {},
      stepResetAll: () => {},
      setActionTargets: (t: any) => {
        if (typeof t?.post === 'number') log(`🎯 本号目标:发 ${t.post} 篇图文`);
      },
      addActionCount: (type: string, n: number) => {
        if (type === 'post') { counts.post += Number(n) || 0; log(`✅ 已完成 ${counts.post} 篇`); }
        try { opts.onItem?.({ accountId, state: 'success', counts: { ...counts }, chargedCredits, chargedUsd }); } catch { /* ignore */ }
      },
      finish: (status: string, error?: string) => { finished = { status, error }; },
      chargeAction: doCharge,
      charge: doCharge,
      aiCall,
      apiCall,
      saveDrafts,
      getPrompt: (name: string) => { const t = pack?.prompts?.[name]; if (!t) throw new Error('Missing prompt: ' + name); return t; },
      // 网络图衍生关键词:不回写账号(避免污染 engage 关键词),当次 orchestrator 的本地数组已够用。
      // AI 衍生新词 → 存进【衍生池】(原始词永留,封顶 30,满了整批换);image_text 一般不衍生,留作统一。
      appendKeywords: (arr: string[]) => { try { appendDerivedKeywords(accountId, arr); } catch { /* ignore */ } },
      sleep: (min: number, max?: number) => new Promise<void>((resolve) => {
        const ms = max ? randInt(min, max) : min;
        if (opts.signal?.aborted) return resolve();
        const t = setTimeout(resolve, ms);
        try { opts.signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true }); } catch { /* ignore */ }
      }),
      // 撞验证码不直接停:提示用户在该账号窗口手动过,轮询到消失就继续;超时/停止才放弃。
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
        log('⏱ 验证码等待超时(' + Math.round(maxMs / 60000) + ' 分钟未完成),放弃本号');
        return { ok: false, reason: 'captcha_timeout' };
      },
      randInt,
      log: (m: string) => coworkLog('INFO', 'imageText-orch', m),
    };

    const code = pack?.orchestrator;
    if (!code) { coworkLog('ERROR', 'imageText', `[${accountId}] no_orchestrator`); return { accountId, state: 'failed', reason: 'no_orchestrator' }; }
    const fn = new AsyncFunction('ctx', code);
    await fn(ctx);

    setAccountStatus(accountId, 'idle');
    const fin = finished as { status: string; error?: string } | null;
    if (fin && fin.status === 'error') {
      coworkLog('ERROR', 'imageText', `[${accountId}] finished error: ${fin.error}`);
      return { accountId, state: 'failed', counts, chargedCredits, chargedUsd, reason: fin.error };
    }
    coworkLog('INFO', 'imageText', `[${accountId}] done 发 ${counts.post} 篇 · 扣费 ${chargedCredits}积分`);
    return { accountId, state: 'success', counts, chargedCredits, chargedUsd };
  } catch (e: any) {
    setAccountStatus(accountId, 'idle');
    coworkLog('ERROR', 'imageText', `[${accountId}] threw: ${String(e?.stack || e?.message || e).slice(0, 300)}`);
    return { accountId, state: 'failed', counts, chargedCredits, chargedUsd, reason: 'imagetext_threw:' + String(e?.message || e).slice(0, 140) };
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

export async function runImageTextTask(opts: ImageTextTaskOptions): Promise<EngageReport> {
  if (!opts.kernelPath && !installedKernelPath()) {
    throw new Error(`${NO_KERNEL_ERROR}: 指纹浏览器内核未安装,请先到「我的矩阵账号」下载内核`);
  }
  const scenarioId = `${opts.platform}_image_text`;
  const pack = await fetchPack(scenarioId);
  if (!pack || !pack.orchestrator) {
    return {
      platform: opts.platform, total: opts.accountIds.length, success: 0, failed: 0, skipped: opts.accountIds.length,
      items: opts.accountIds.map((id) => ({ accountId: id, state: 'skipped' as const, reason: 'no_scenario(后端未部署?)' })),
    };
  }
  // 网络图 + 指定了抖音下图号(视频号/头条用):视频号/头条浏览器没登录抖音、游客搜图拿不到 → 统一启 1 个
  // 【抖音下图内核】,各发布号 openTab({platform:'douyin'}) 路由到它在抖音登录态搜图;一个抖音号服务 N 个
  // 发布号 → 整任务【串行】(k=1)。AI生图 / 抖音·小红书(自己浏览器搜本平台)不走这条,照常并行。
  const dlAcct = (opts.config?.useRealPhotos && opts.config?.imageDownloadAccountId) ? opts.config.imageDownloadAccountId : undefined;
  let k = Math.max(1, Math.min(opts.concurrency ?? 3, 10));
  if (dlAcct) {
    k = 1;
    const dl = getAccount(dlAcct);
    if (!dl) {
      coworkLog('WARN', 'imageTextRunner', `download account ${dlAcct} not found — web images will fall back to AI`);
    } else {
      try {
        await launchKernel({
          accountId: dlAcct, kernelPath: opts.kernelPath, kernelVersion: dl.kernelVersion,
          userDataDir: dl.userDataDir, fingerprint: dl.fingerprint, proxy: dl.proxy,
          label: accountBadgeLabel(dl), groupTitle: matrixGroupTitle('douyin', opts.taskId),
        });
        await kernelNavigate(dlAcct, 'https://www.douyin.com/');
        await sleep(2000);
        let dlLoggedIn = true;
        try { dlLoggedIn = await checkKernelLogin(dlAcct, 'douyin'); } catch { dlLoggedIn = true; }
        if (!dlLoggedIn) coworkLog('WARN', 'imageTextRunner', `download account ${dlAcct} douyin not logged in — web image search may fail (orchestrator falls back to AI images)`);
      } catch (e) { coworkLog('WARN', 'imageTextRunner', 'launch download kernel failed', { err: String(e) }); }
    }
  }
  coworkLog('INFO', 'imageTextRunner', `image_text ${opts.platform} x${opts.accountIds.length} (${scenarioId})${dlAcct ? ' +dl:' + dlAcct + ' (serial)' : ''}`);
  const items = await runPool(opts.accountIds, k, (id) => runOne(opts, pack, id, dlAcct), opts.onItem);
  if (dlAcct) { try { closeKernel(dlAcct); } catch { /* ignore */ } }
  return {
    platform: opts.platform, total: items.length,
    success: items.filter((x) => x.state === 'success').length,
    failed: items.filter((x) => x.state === 'failed').length,
    skipped: items.filter((x) => x.state === 'skipped').length,
    items,
  };
}
