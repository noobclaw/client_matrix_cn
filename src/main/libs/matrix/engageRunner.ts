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
  instagram: 'https://www.instagram.com/', facebook: 'https://www.facebook.com/', reddit: 'https://www.reddit.com/',
};
// 视频下载直链的 Referer(各平台 CDN 防盗链要求,给错会 403)。video_download 剧本走 downloadVideoToDisk 时按平台取。
const DOWNLOAD_REFERER: Record<string, string> = {
  douyin: 'https://www.douyin.com/', kuaishou: 'https://www.kuaishou.com/',
  bilibili: 'https://www.bilibili.com/', tiktok: 'https://www.tiktok.com/',
  xhs: 'https://www.xiaohongshu.com/',
};
import { matrixCmd } from './cdpCommands';
import { getAccount, setAccountStatus, appendDerivedKeywords, effectiveKeywords, accountBadgeLabel, matrixGroupTitle, markAccountAlive, platformKey } from './accountManager';
import { promptReloginForExpiredAccount, loginUrlFor } from './reloginPrompt';
import { getNoobClawAuthToken } from '../claudeSettings';

// 多平台通用验证码检测(页面 JS,返回 boolean)。撞验证码不直接停,改成提示用户在【该账号窗口】
//   手动过、轮询到消失就继续(见 ctx.waitForCaptchaCleared)。以【验证码元素】为强信号,辅以少量
//   全屏滑块文案,尽量不误判(误判会白等)。覆盖抖音(verifycenter/secsdk)/TikTok/小红书/快手/B站/极验。
const CAPTCHA_DETECT_EXPR = "(function(){try{"
  + "if(document.querySelector('#captcha_container,#captcha-verify-image,[id*=\"captcha\" i][class*=\"verify\" i],[class*=\"captcha_verify\" i],[class*=\"vc_captcha\" i],[class*=\"captcha-container\" i],[class*=\"captcha-slider\" i],[class*=\"secsdk-captcha\" i],[class*=\"geetest\" i],[class*=\"red-captcha\" i],[class*=\"sc-captcha\" i]'))return true;"
  + "var b=document.body?(document.body.innerText||'').slice(0,3000):'';"
  + "if(/向右滑动|拖动滑块|拖动下方滑块|完成拼图|按住滑块|滑动完成验证|Verify you are human|请完成安全验证/i.test(b))return true;"
  + "return false;}catch(e){return false;}})()";

const DEFAULT_BASE_URL = 'https://api.noobclaw.com';
function baseUrl(): string { return process.env.NOOBCLAW_API_BASE_URL || DEFAULT_BASE_URL; }
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
/** 可中断等待:点停止后立即返回,不再干等整段(错峰 3-15s / 导航等待等停不下来的主因)。 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { cleanup(); resolve(); };
    const cleanup = () => { clearTimeout(t); try { signal?.removeEventListener('abort', onAbort); } catch { /* ignore */ } };
    try { signal?.addEventListener('abort', onAbort, { once: true }); } catch { /* ignore */ }
  });
}
function randInt(min: number, max: number): number {
  const lo = Math.min(min, max), hi = Math.max(min, max);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

export interface EngageQuota {
  daily_like_min?: number; daily_like_max?: number;
  daily_follow_min?: number; daily_follow_max?: number;
  daily_comment_min?: number; daily_comment_max?: number;
  comment_lang?: string;            // 评论语言:'auto'|'zh'|'zh-TW'|'en'|'ja'|'ko'|'ru'|'fr'|'de'|'vi'(空/auto=跟帖子语言)
}

// 评论语言 code → AI 语言名(强制模式)。auto/空 → 不下发,剧本回落「跟帖子语言」。
const COMMENT_LANG_NAME: Record<string, string> = {
  zh: '简体中文 (Simplified Chinese)', 'zh-TW': '繁体中文 (Traditional Chinese)', en: '英文 (English)',
  ja: '日语 (Japanese)', ko: '韩语 (Korean)', ru: '俄语 (Russian)', fr: '法语 (French)', de: '德语 (German)', vi: '越南语 (Vietnamese)',
};
function commentLangHint(code?: string): string | undefined {
  if (!code || code === 'auto') return undefined;
  const name = COMMENT_LANG_NAME[code];
  if (!name) return undefined;
  return `⚠️ 硬性规则(压倒一切):整条评论必须用【${name}】书写,只用这一种语言,第一个字符就是该语言,绝不混入其它语言。不管帖子/视频是什么语言,你都用 ${name} 回复。`;
}

export interface EngageTaskOptions {
  platform: string;                 // 目前 douyin
  taskId?: string;                  // 任务 id(标签分组 pill 显示 🤖 平台 #缩写;手动/无任务上下文可缺省)
  accountIds: string[];
  quota?: EngageQuota;              // 每号配额区间(缺省用 scenario 默认)
  // 任务类型:'engage'=互动涨粉(点赞/评论/关注,按关键词搜);'reply_fan'=自动回复粉丝评论
  // (抖音创作者中心评论管理,不需关键词、无配额、有引流尾巴);'video_download'=视频无水印下载
  // (单账号,粘贴多个链接逐个下载,不需关键词、无配额)。缺省 'engage' 兼容旧调用。
  taskType?: 'engage' | 'reply_fan' | 'video_download';
  scenarioId?: string;             // 显式指定后端剧本 id(reply_fan→*_reply_fans_comment / video_download→*_video_download);缺省按平台推
  funnel?: { funnel_phrase?: string; funnel_probability?: number }; // 引流尾巴配置:reply_fan 走后端剧本;engage 由 makeAiCall 对 comment_composer 融入
  urls?: string[];                 // 仅 video_download:待下载视频链接清单(注入 ctx.task.urls)
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
  // like/follow/comment 是互动涨粉的维度;post(图文创作发帖数)/download(视频下载条数)是
  // 别的任务类型各自的完成维度,可选。各任务只填自己有的那个。
  counts?: { like: number; follow: number; comment: number; post?: number; download?: number };
  // 该号本次累计实际扣费(积分 + 美元)。每条互动动作扣费后累加,用于「本次/累计消耗」。
  chargedCredits?: number;
  chargedUsd?: number;
  reason?: string;
}

// ── scenario pack 下发(/api/matrix/scenarios/:id)──
async function fetchEngagePack(id: string): Promise<any | null> {
  // 两次尝试:用户常为 TikTok 等开关 VPN,对 api 的请求会瞬断/超时 —— 一次失败别直接判「后端未部署」,
  // 等 3s 再试一次,大多数抖动都能扛过去。
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`${baseUrl()}/api/matrix/scenarios/${id}`, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) return await res.json();
      coworkLog('WARN', 'engageRunner', 'fetch pack non-ok', { id, status: res.status, attempt });
      if (res.status === 404) return null; // 真没这个剧本,重试无意义
    } catch (e) {
      coworkLog('WARN', 'engageRunner', 'fetch pack failed', { id, attempt, err: String(e) });
    }
    if (attempt === 1) await sleep(3000);
  }
  return null;
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
// 引流融入 prompt —— 把 AI 写好的评论正文和用户填的引流文案二次融合成一句人话。
// 与后端 *_reply_fans_comment/prompts/funnel_polish.txt 同思路,但这里是「互动评论」
// 语境(不是回复粉丝),所以措辞按评论调。放客户端是因为互动剧本(comment_composer)
// 走客户端 makeAiCall,这样 5 个平台(抖音/快手/B站/TikTok/YouTube)零后端改动统一生效。
const FUNNEL_WEAVE_PROMPT = [
  '你的任务:把一段「评论正文」和一句「引流文案」揉成一条自然的评论。',
  '',
  '# 输入',
  '- 评论正文(要保留它对内容的回应):{{reply_body}}',
  '- 引流文案(这是你要传达的「意思」,不是让你照抄的模板):{{funnel_phrase}}',
  '',
  '# 核心要求(最重要)',
  '1. 【严禁照抄引流文案】必须用你自己的话把它的意思重新说一遍——换措辞、换句式、换角度,',
  '   每次都要不一样,读起来像博主看完视频随口一提,绝不能像复制粘贴的固定广告尾巴。',
  '2. 【但硬信息一字不改】链接、微信号、手机号、邮箱、口令/暗号、账号名/昵称/品牌名 —— 这些原样保留,',
  '   引流文案里没有这些就不要编造、不要添加。',
  '3. 保留引流的真实意图和关键动作(如「去主页看」「私信领」「关注我」),但表达方式自由改写、口语化带出来。',
  '4. 评论正文的回应核心不能丢;用自然过渡把两部分连成一句人话,不要「评论 + 广告」两段生硬拼接。',
  '',
  '# 约束',
  '- 总长 10~80 字,引流部分不超过总长 60%',
  '- 跟评论正文同样的语气;不要 @ 用户名;不要「以下是改写」之类的元话术',
  '- 不出现敏感词(最 / 第一 / 100% / 秒杀 / 独家)',
  '',
  '# 输出',
  '只输出最终融合后的整句评论,不要任何前缀 / 后缀 / 引号 / 解释。',
  '',
  '# 差异签名: {{nonce}}(仅用来让每次结果不同,不要把它写进评论)',
].join('\n');

function makeAiCall(pack: any, authToken: string | undefined, report: (m: string) => void, onCost?: (credits: number, usd: number) => void, signal?: AbortSignal, funnel?: { phrase?: string; prob?: number; langHint?: string }) {
  // 单次 chat 调用(系统提示 + 用户消息 → content 文本)。主评论与引流融入复用它。
  const doChat = async (systemPrompt: string, userMessage: string, wantJson: boolean, model?: string): Promise<string> => {
    if (!authToken) throw new Error('AI_NOT_CONFIGURED');
    const body: any = {
      model: model || 'noobclawai-chat',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }],
      stream: false, max_tokens: 8000,
    };
    if (wantJson && (/json/i.test(systemPrompt) || /json/i.test(userMessage))) body.response_format = { type: 'json_object' };
    else if (!wantJson) body.response_format = { type: 'text' };
    // 网络抖动重试:用户常开着 VPN,对 api 的请求会瞬断(undici「fetch failed」)或 5xx/429 →
    //   评论生成只调一次就报「AI 生成评论失败: fetch failed」白丢一条。退避重试 3 次;
    //   402 余额不足 / 4xx 确定性错误 / 用户已停止(abort)不重试。
    const MAX_ATTEMPTS = 3;
    let lastErr: any = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (signal?.aborted) throw new Error('user_stopped');
      let res: Response;
      try {
        res = await fetch(`${baseUrl()}/api/ai/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify(body),
          signal,
        });
      } catch (e: any) {
        if (signal?.aborted || /aborted/i.test(String(e?.message || e))) throw new Error('user_stopped');
        lastErr = e;
        if (attempt < MAX_ATTEMPTS) { await new Promise((r) => setTimeout(r, attempt * 2000)); continue; }
        throw new Error('AI 请求网络失败(已重试 ' + MAX_ATTEMPTS + ' 次):' + String(e?.message || e).slice(0, 80));
      }
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        const beMsg = String((data && (data.message || data.error)) || ('http_' + res.status));
        if (res.status === 402 || /INSUFFICIENT_TOKENS|insufficient|余额/i.test(beMsg)) throw new Error('余额不足,请充值后重试 (' + beMsg + ')');
        if ((res.status >= 500 || res.status === 429) && attempt < MAX_ATTEMPTS) { lastErr = new Error('http_' + res.status); await new Promise((r) => setTimeout(r, attempt * 2000)); continue; }
        throw new Error('AI 请求失败 ' + res.status + ': ' + beMsg);
      }
      try {
        const aiCredits = Number(data?._noobclaw?.billableTokens) || 0;
        const aiUsd = Number(data?._noobclaw?.costUsd) || 0;
        if ((aiCredits > 0 || aiUsd > 0) && onCost) onCost(aiCredits, aiUsd);
      } catch { /* ignore */ }
      return data?.choices?.[0]?.message?.content ?? '';
    }
    throw lastErr || new Error('AI 请求失败');
  };

  // 引流融入:仅对「互动评论」(comment_composer,返回纯文本串)且任务填了引流语时,
  // 按概率再调一次 AI 把引流文案融进评论。未填引流语 / 未命中概率 / 融入失败 → 原样返回。
  // 兼容:老任务没有 funnel 字段 → funnel?.phrase 为空 → 整条逻辑跳过,行为完全不变。
  const maybeWeaveFunnel = async (baseComment: string): Promise<string> => {
    const base = String(baseComment || '').trim();
    const phrase = String(funnel?.phrase || '').trim();
    if (!base || !phrase) return baseComment;
    const prob = typeof funnel?.prob === 'number' ? funnel.prob : 0;
    if (prob <= 0) return baseComment;
    const dice = Math.floor(Math.random() * 100) + 1; // 1-100
    if (dice > prob) return baseComment; // 未命中概率 → 纯评论
    const nonce = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    // 语言约束跟主评论一致:任务选了具体评论语言时,融合输出也必须用该语言 ——
    // 不带的话二次 AI 调用可能把已是目标语言的评论改写回中/英混语(强制语言+引流同开时跑偏)。
    const sys = FUNNEL_WEAVE_PROMPT
      .split('{{reply_body}}').join(base)
      .split('{{funnel_phrase}}').join(phrase)
      .split('{{nonce}}').join(nonce)
      + (funnel?.langHint ? '

' + funnel.langHint : '');
    try {
      const raw = await doChat(sys, JSON.stringify({ task: 'weave_funnel', comment: base, funnel: phrase }), false);
      let polished = String(raw || '').trim()
        .replace(/^```[a-z]*\n?/i, '').replace(/```\s*$/i, '')
        .replace(/^["'“”]+|["'“”]+$/g, '')
        .trim();
      // 达标校验:非空、够长、不比原评论短太多(防 AI 只吐引流语丢了评论正文)。不达标 → 保留原评论。
      if (polished && polished.length >= 8 && polished.length >= base.length * 0.4) {
        try { report('   🎯 已按 ' + prob + '% 概率把引流语融入评论'); } catch { /* ignore */ }
        return polished;
      }
    } catch { /* 融入失败 → 纯评论 */ }
    return baseComment;
  };

  return async (promptNameOrRaw: string, promptOrInput: any, rawInput?: string, opts?: any) => {
    const prompt = promptNameOrRaw === '__raw__' ? String(promptOrInput) : String(pack?.prompts?.[promptNameOrRaw] || '');
    const userMessage = promptNameOrRaw === '__raw__'
      ? String(rawInput || '')
      : (typeof promptOrInput === 'string' ? promptOrInput : JSON.stringify(promptOrInput));
    const wantJson = opts?.expectJson !== false;
    const content = await doChat(prompt, userMessage, wantJson, opts && opts.model);
    if (opts?.expectJson === false) {
      // 互动评论(comment_composer)是纯文本评论出口 → 在这里按概率融入引流语。
      // 其它 expectJson:false 的调用(关键词衍生等)不叫 comment_composer,不受影响。
      if (promptNameOrRaw === 'comment_composer') return await maybeWeaveFunnel(content);
      return content;
    }
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
  // 早期守卫一律补日志:以前直接 return 不打日志 → 账号被跳过却「啥日志都没有」,无法排查。
  if (!acc) { log('❌ 跳过:账号不存在'); return { accountId, state: 'skipped', reason: 'account_not_found' }; }
  if (acc.platform !== opts.platform) { log('❌ 跳过:账号平台与任务不符'); return { accountId, state: 'skipped', reason: 'platform_mismatch' }; }
  // 币安广场是 feed 互动(刷广场帖、按内置 CRYPTO 规则筛,不按关键词搜),不需要用户配关键词;
  //   reply_fan(回复粉丝评论)对象是自己作品下的粉丝评论,也不按关键词搜 → 同样豁免。
  //   其它平台(抖音/小红书等按关键词搜的互动)才要。漏掉豁免 → 账号没关键词被静默拦掉、无日志。
  const needsKeywords = opts.taskType !== 'reply_fan' && opts.taskType !== 'video_download' && opts.platform !== 'binance';
  if (needsKeywords && (!acc.keywords || acc.keywords.length === 0)) { log('❌ 跳过:未配置关键词(到「我的矩阵账号」编辑里添加)'); return { accountId, state: 'skipped', reason: 'no_keywords' }; }
  if (acc.status === 'banned' || acc.status === 'limited') { log('❌ 跳过:账号状态为 ' + acc.status); return { accountId, state: 'skipped', reason: 'account_' + acc.status }; }

  await abortableSleep(randInt(opts.jitterMinMs ?? 3000, opts.jitterMaxMs ?? 15000), opts.signal); // 错峰(可中断:停止立即结束)
  if (opts.signal?.aborted) { log('🛑 已停止'); return { accountId, state: 'skipped', reason: 'aborted' }; }

  const counts = { like: 0, follow: 0, comment: 0 };
  let chargedCredits = 0; // 该号本次累计扣费(积分),每笔互动动作扣费后累加
  let chargedUsd = 0;     // 同上,美元(后端按 token_price_per_million 算好)
  const history = engageHistoryFor(accountId);
  const q = opts.quota || {};
  const authToken = opts.authToken || getNoobClawAuthToken() || undefined; // aiCall/计费 token(main 侧)
  let finished: { status: string; error?: string } | null = null;

  try {
    if (opts.signal?.aborted) { return { accountId, state: 'skipped', reason: 'aborted' }; }
    setAccountStatus(accountId, 'running');
    log('启动指纹内核');
    await launchKernel({
      accountId, kernelPath: opts.kernelPath, kernelVersion: acc.kernelVersion,
      userDataDir: acc.userDataDir, fingerprint: acc.fingerprint, proxy: acc.proxy,
      // 窗口左上角常驻角标(账号名 + 代理/本机 IP):所有任务执行都显示,便于核对在哪个号、走哪个 IP(撞 IP 会红)。
      // groupTitle 同名,免得标签页显示 raw accountId。
      label: accountBadgeLabel(acc),                       // 绿色角标:账号信息(平台·昵称·备注)
      groupTitle: matrixGroupTitle(opts.platform, opts.taskId), // 蓝色 pill:🤖 平台 #任务缩写(不重复账号信息)
    });
    // 导航 URL + 登录态 key:回复粉丝(reply_fan)在【创作者中心】评论管理操作,快手须导航
    //   cp.kuaishou.com 并按创作端登录态校验(platformKey 把快手创作号映成 'kuaishou_creator',
    //   主站/创作端登录互不覆盖);互动涨粉走主站。非快手账号无 loginScope → 行为不变(主站 + 平台名)。
    const loginKey = platformKey(acc);
    const navUrl = (opts.taskType === 'reply_fan' && acc.loginScope)
      ? loginUrlFor(opts.platform, acc.loginScope)
      : (PLATFORM_HOME[opts.platform] || 'https://www.douyin.com/');
    if (opts.signal?.aborted) { try { closeKernel(accountId, { force: true }); } catch { /* ignore */ } return { accountId, state: 'skipped', reason: 'aborted' }; }
    await kernelNavigate(accountId, navUrl);
    await abortableSleep(2000, opts.signal);
    if (opts.signal?.aborted) { try { closeKernel(accountId, { force: true }); } catch { /* ignore */ } return { accountId, state: 'skipped', reason: 'aborted' }; }

    // 跑前登录态检查:cookie 过期 / 没关联 → 跳过该号 + 标「需关联」(其它号照跑),不空转。
    let loggedIn = true;
    try { loggedIn = await checkKernelLogin(accountId, loginKey); } catch { loggedIn = true; } // 读失败不误杀
    if (!loggedIn) {
      setAccountStatus(accountId, 'login_required');
      log('⚠️ 登录态失效/未关联,弹窗扫码重连(其它号照跑)');
      // 命中失效 → 弹该号扫码窗(置顶 + 红角标 + 后台轮询扫码成功翻 idle),跟「刷新信息」口径对齐。
      // skipLease 自带 refCount+1 → 下面 finally 的 closeKernel 只 -1、不会关掉扫码窗;用户已点停止则不打扰。
      if (!opts.signal?.aborted) { try { await promptReloginForExpiredAccount(accountId); } catch { /* 弹窗失败不影响跳过 */ } }
      return { accountId, state: 'skipped', reason: 'login_expired' };
    }
    markAccountAlive(accountId); // 确认登录有效 → 更新活跃时间,常跑的号不进主动保活名单。

    // orchestrator 需要的 task(配额从 opts.quota,缺省回落 scenario manifest 默认)。
    // reply_fan 剧本读 task.persona / funnel_phrase / funnel_probability;engage 剧本读 keywords/配额/comment_prompt。
    // 两套字段都带上(互不干扰),由各自剧本按需取。
    const task: any = {
      id: accountId, keywords: effectiveKeywords(acc), track: acc.track || 'douyin_default',
      // 人设 → 复用老剧本现成的 comment_prompt 槽(comment_composer 的 user_prompt 口味提示),
      // 不另造 persona 路径(老抖音剧本本就支持,backend 零改动)。
      comment_prompt: acc.persona || '',
      // reply_fan 剧本用:persona(回复口吻)+ 引流尾巴(文案/概率)。
      persona: acc.persona || '',
      // 作者本人身份 —— 任务已指定账号,添加时就抓到并存了 nickname/displayId/boundUid(绿标即用 nickname)。
      // reply_fan 剧本据此排除"作者自己的回复",不必再去爬页面 DOM(抖音本人昵称根本不在评论管理页、
      // 小红书也不稳)。剧本优先用这些,爬页面只作兜底。
      selfNickname: acc.nickname || '',
      selfUid: acc.boundUid || acc.displayId || '',
      selfDisplayId: acc.displayId || '',
      funnel_phrase: opts.funnel?.funnel_phrase || '',
      funnel_probability: typeof opts.funnel?.funnel_probability === 'number' ? opts.funnel.funnel_probability : 0,
      // video_download 剧本读 task.urls(用户粘贴的待下载链接清单)。
      urls: Array.isArray(opts.urls) ? opts.urls : [],
      daily_like_min: q.daily_like_min, daily_like_max: q.daily_like_max,
      daily_follow_min: q.daily_follow_min, daily_follow_max: q.daily_follow_max,
      daily_comment_min: q.daily_comment_min, daily_comment_max: q.daily_comment_max,
      // 评论语言(强制模式;auto/空时不下发,剧本回落「跟帖子语言」)。各 *_auto_engage 剧本优先用它。
      comment_language_hint: commentLangHint(q.comment_lang),
      comment_lang: q.comment_lang || 'auto',
    };

    // 写评论等 AI 调用的扣费也累进「本次消耗」(与动作按次扣费相加,二者是不同的账,不重复)。
    const aiCall = makeAiCall(pack, authToken, log, (credits: number, usd: number) => {
      chargedCredits += credits; chargedUsd += usd;
      try { opts.onItem?.({ accountId, state: 'success', counts: { ...counts }, chargedCredits, chargedUsd }); } catch { /* ignore */ }
    }, opts.signal, {
      // 引流融入:互动评论(comment_composer)按此概率把引流文案融进评论。
      // task.funnel_phrase/probability 已由上面从 opts.funnel 填好;engage 与 reply_fan 都带,
      // 但只有 comment_composer 出口(互动评论)会用到,reply_fan 走后端 fan_reply_body,互不影响。
      phrase: task.funnel_phrase || '',
      prob: typeof task.funnel_probability === 'number' ? task.funnel_probability : 0,
      langHint: task.comment_language_hint || '', // 强制评论语言时,引流融合输出也锁同一语言
    }); // 传 abort signal:点停止时这次 AI 调用立即中断
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
      setActionTargets: (t: any) => {
        // reply_fan(回复粉丝)没有点赞/关注/评论配额 —— 它就是逐条回全部粉丝评论;只有 engage 才有配额。
        // 老日志写死 `赞${t.like}/关${t.follow}/评${t.comment}`,回复任务没传这三个 → 显示「赞undefined/关undefined/评undefined」误导用户。
        // 改成只打有值的字段,且 reply_fan 用「目标」(作品数)而非「配额」。
        const parts: string[] = [];
        if (typeof t.like === 'number') parts.push(`赞${t.like}`);
        if (typeof t.follow === 'number') parts.push(`关${t.follow}`);
        if (typeof t.comment === 'number') parts.push(`评${t.comment}`);
        if (typeof t.note === 'number') parts.push(`作品${t.note}`);
        if (parts.length) log(`🎯 ${opts.taskType === 'reply_fan' ? '目标' : '配额'} ${parts.join('/')}`);
        try { opts.onTargets?.(accountId, { like: t.like, follow: t.follow, comment: t.comment }); } catch { /* ignore */ }
      },
      addActionCount: (type: string, n: number) => { if (type in counts) (counts as any)[type] += n; opts.onItem?.({ accountId, state: 'success', counts: { ...counts }, chargedCredits, chargedUsd }); },
      finish: (status: string, error?: string) => { finished = { status, error }; },
      // 计费 / AI / 去重 —— 扣费成功就把 charged(积分)+ cost_usd 累加,并推一次 onItem 让「本次消耗」实时跳。
      chargeAction: doCharge,
      charge: doCharge,
      aiCall,
      getPrompt: (name: string) => { const t = pack?.prompts?.[name]; if (!t) throw new Error('Missing prompt: ' + name); return t; },
      engageHistory: history,
      // AI 衍生新词 → 存进【衍生池】(不污染原始关键词,封顶 30,满了整批换)。
      appendKeywords: (arr: string[]) => { try { appendDerivedKeywords(accountId, arr); } catch { /* ignore */ } },
      // 互动报告落盘:写到 <matrixDir>/reports/<平台>/<accountId>/ 下,返回绝对路径给编排器记日志。
      // 老空桩只返 {ok:true} 没 path → 编排器日志「报告已保存 → undefined」且文件根本没存。
      writeReport: async (fname: string, md: string) => {
        try {
          const base = process.env.NOOBCLAW_MATRIX_DIR || path.join(os.homedir(), 'NoobClaw', 'matrix');
          const dir = path.join(base, 'reports', opts.platform || acc.platform || 'unknown', accountId);
          fs.mkdirSync(dir, { recursive: true });
          // 文件名去掉路径分隔符等非法字符,保留中文/字母数字,限长。
          const safeName = String(fname || 'report.md').replace(/[\\/:*?"<>|]/g, '_').slice(0, 200);
          const filePath = path.join(dir, safeName);
          fs.writeFileSync(filePath, String(md), 'utf8');
          coworkLog('INFO', 'engage', `[${accountId}] writeReport ok → ${filePath}`);
          return { ok: true, path: filePath, dir };
        } catch (err: any) {
          coworkLog('WARN', 'engage', `[${accountId}] writeReport failed: ${String(err?.message || err)}`);
          return { ok: false, reason: String(err?.message || err) };
        }
      },
      // 视频下载落盘(video_download 剧本用:douyin/kuaishou/bilibili 直链下载):把无水印 mp4
      // 直链下到 <matrixDir>/downloads/<平台>/<accountId>/<fileName>,返回绝对路径 + 字节数。
      // ⚠️ Referer 必须按平台给(bilibili/kuaishou CDN 防盗链,给错 Referer 会 403),不能写死抖音。
      // 浏览器 UA + 5 分钟超时;点停止(signal abort)立即中断本次下载。
      downloadVideoToDisk: async (videoUrl: string, o?: { fileName?: string; outputDir?: string }) => {
        try {
          if (!videoUrl || !/^https?:\/\//i.test(videoUrl)) return { ok: false, reason: 'invalid_url' };
          const base = process.env.NOOBCLAW_MATRIX_DIR || path.join(os.homedir(), 'NoobClaw', 'matrix');
          const dir = o?.outputDir || path.join(base, 'downloads', opts.platform || acc.platform || 'unknown', accountId);
          fs.mkdirSync(dir, { recursive: true });
          const safeName = String(o?.fileName || `video_${Date.now()}.mp4`).replace(/[\\/:*?"<>|]/g, '_').slice(0, 200);
          const filePath = path.join(dir, safeName);
          const referer = DOWNLOAD_REFERER[opts.platform || ''] || PLATFORM_HOME[opts.platform || ''] || 'https://www.douyin.com/';
          const ctrl = new AbortController();
          const to = setTimeout(() => ctrl.abort(), 5 * 60 * 1000);
          try { opts.signal?.addEventListener('abort', () => ctrl.abort(), { once: true }); } catch { /* ignore */ }
          let buf: Buffer;
          try {
            const resp = await fetch(videoUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', Referer: referer }, signal: ctrl.signal });
            if (!resp.ok) return { ok: false, reason: `http_${resp.status}` };
            buf = Buffer.from(await resp.arrayBuffer());
          } finally { clearTimeout(to); }
          if (!buf.length) return { ok: false, reason: 'empty_body' };
          fs.writeFileSync(filePath, buf);
          coworkLog('INFO', 'engage', `[${accountId}] downloadVideoToDisk ok → ${filePath} (${buf.length}B)`);
          return { ok: true, filePath, size: buf.length, dir };
        } catch (err: any) {
          coworkLog('WARN', 'engage', `[${accountId}] downloadVideoToDisk failed: ${String(err?.message || err)}`);
          return { ok: false, reason: String(err?.message || err).slice(0, 120) };
        }
      },
      // 二进制资产落盘(tiktok 视频下载剧本用):把 base64 数据(剧本先用浏览器/Node fetch 拿到字节)
      // 写到 <matrixDir>/downloads/<平台>/<accountId>/<subdir>/<fileName>,返回绝对路径。
      // tiktok 不走 downloadVideoToDisk(它要浏览器 main_world_fetch_api base64 + 多级 fallback 自己拿字节)。
      writeAsset: async (fileName: string, base64Data: string, o?: { subdir?: string }) => {
        try {
          const base = process.env.NOOBCLAW_MATRIX_DIR || path.join(os.homedir(), 'NoobClaw', 'matrix');
          const dir = path.join(base, 'downloads', opts.platform || acc.platform || 'unknown', accountId, String(o?.subdir || '').replace(/[\\/:*?"<>|]/g, '_'));
          fs.mkdirSync(dir, { recursive: true });
          const safeName = String(fileName || `asset_${Date.now()}`).replace(/[\\/:*?"<>|]/g, '_').slice(0, 200);
          const filePath = path.join(dir, safeName);
          const buf = Buffer.from(String(base64Data || ''), 'base64');
          if (!buf.length) return { ok: false, reason: 'empty_data' };
          fs.writeFileSync(filePath, buf);
          coworkLog('INFO', 'engage', `[${accountId}] writeAsset ok → ${filePath} (${buf.length}B)`);
          return { ok: true, path: filePath, size: buf.length, dir };
        } catch (err: any) {
          coworkLog('WARN', 'engage', `[${accountId}] writeAsset failed: ${String(err?.message || err)}`);
          return { ok: false, reason: String(err?.message || err).slice(0, 120) };
        }
      },
      // 工具。sleep 可被停止打断:点停止后 abort 立即唤醒,不再傻等动作间延时跑完(否则停了要等当前 sleep 结束才退)。
      sleep: (min: number, max?: number) => new Promise<void>((resolve) => {
        const ms = max ? randInt(min, max) : min;
        if (opts.signal?.aborted) return resolve();
        const t = setTimeout(resolve, ms);
        try { opts.signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true }); } catch { /* ignore */ }
      }),
      // 撞验证码不直接停:提示用户在【该账号窗口】手动过,轮询到消失就继续;超时/停止才放弃。
      //   返回 { ok:true } 过了 / { ok:false, reason } 超时或中止。窗口对用户可见(带角标),手动滑最自然。
      waitForCaptchaCleared: async (o?: { maxMs?: number }) => {
        const maxMs = (o && o.maxMs) || 180000; // 默认最多等 3 分钟
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

export interface EngageReport { platform: string; total: number; success: number; failed: number; skipped: number; items: EngageItemResult[]; }

export async function runEngageTask(opts: EngageTaskOptions): Promise<EngageReport> {
  // 内核校验(手动 + 定时统一兜底):没装指纹浏览器且没显式路径 → 整个任务【不跑】,
  // 抛 NO_KERNEL 让上层弹「去下载」。否则定时任务会空转、每个号都失败。
  if (!opts.kernelPath && !installedKernelPath()) {
    throw new Error(`${NO_KERNEL_ERROR}: 指纹浏览器内核未安装,请先到「我的矩阵账号」下载内核`);
  }
  const k = Math.max(1, Math.min(opts.concurrency ?? 3, 10));
  // 平台 → 后端 backend/matrix/scenarios 的剧本 id。币安是 binance_SQUARE_auto_engage(非 binance_auto_engage),
  // 别的都是 `<平台>_auto_engage`。漏了币安这个特例会取不到剧本 → 指纹浏览器都不唤起、无日志。
  const ENGAGE_SCENARIO_ID: Record<string, string> = { binance: 'binance_square_auto_engage' };
  // reply_fan 等非互动任务显式传 scenarioId(如 douyin_reply_fans_comment);engage 按平台推。
  const scenarioId = opts.scenarioId || ENGAGE_SCENARIO_ID[opts.platform] || `${opts.platform}_auto_engage`;
  const pack = await fetchEngagePack(scenarioId);
  if (!pack || !pack.orchestrator) {
    // ⚠️ 必须发日志+item 再返回:这条路以前【静默】返回 → UI 永远停在「已加入运行队列…」装死
    //   (任务实际已完成),用户以为卡住(真机实测,常见诱因是开关 VPN 时对 api 的请求瞬断)。
    const items = opts.accountIds.map((id) => ({ accountId: id, state: 'skipped' as const, reason: 'no_scenario(后端未部署/网络瞬断)' }));
    for (const it of items) {
      try { opts.onLog?.(it.accountId, `❌ 取不到互动剧本「${scenarioId}」(后端未部署或网络瞬断,已重试)——本次跳过,请稍后再点「直接运行」`); } catch { /* ignore */ }
      try { opts.onItem?.(it); } catch { /* ignore */ }
    }
    return { platform: opts.platform, total: opts.accountIds.length, success: 0, failed: 0, skipped: opts.accountIds.length, items };
  }
  coworkLog('INFO', 'engageRunner', `${opts.taskType || 'engage'} ${opts.platform} x${opts.accountIds.length} (${scenarioId})`);
  const items = await runPool(opts.accountIds, k, (id) => runOne(opts, pack, id), opts.onItem);
  return {
    platform: opts.platform, total: items.length,
    success: items.filter((x) => x.state === 'success').length,
    failed: items.filter((x) => x.state === 'failed').length,
    skipped: items.filter((x) => x.state === 'skipped').length,
    items,
  };
}
