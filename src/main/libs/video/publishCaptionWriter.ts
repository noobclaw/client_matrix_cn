/**
 * publishCaptionWriter — 视频【平台发布文案】生成器。
 *
 * 解决的问题:发布到抖音/小红书/B站等平台时,视频下面那段文案(caption)的使命是
 * 【钩人点开视频 + 引导互动】,不是复述视频内容、更不是把口播稿原样贴上去。三个东西
 * 是三回事:
 *   · 口播稿(voiceScript / script)—— 给 TTS「念」,完整、口语
 *   · 视频标题(title)—— 画面里那行大字,短、概括
 *   · 平台发布文案(本模块产出)—— 钩子标题 + 简介 + 引导互动 + 话题标签
 *
 * 历史 bug:发布 step 直接用 input.script(用户原始参考稿),AI 模式下跟视频里念的根本
 * 不是一段。本模块专门产一组钩人的发布文案,从根上修。
 *
 * 接口:1 次 DeepSeek chat 调用,~400 token(~$0.001)。失败返 null,上层降级到
 * 「title + keywords 拼」的兜底文案,绝不阻塞发布。只在【确实有平台要发】时才调,省钱。
 */

import { getNoobClawAuthToken } from '../claudeSettings';
import type { ContentLang } from './scriptWriter';

function apiBase(): string {
  return process.env.NOOBCLAW_API_BASE_URL || 'https://api.noobclaw.com';
}

export interface PublishCaptionInput {
  /** 视频在讲什么 —— 传 AI 口播稿 / 模板速生的 voiceScript / dataText,AI 据此写钩子文案。 */
  summary: string;
  /** 视频标题(参考,AI 可改写得更钩人)。 */
  title?: string;
  /** 关键词(AI 选其中相关的做 hashtag)。 */
  keywords?: string[];
  /** 赛道(给文案定调,如「加密行情」→ 偏专业;「萌宠」→ 偏轻松)。 */
  track?: string;
  /** 内容语言。zh/ja/ko/en… —— 文案用对应语言。 */
  lang: ContentLang;
}

export interface PublishCaptionResult {
  /** 钩人标题(B站/头条号的标题字段 + 小红书标题用它;抖音 caption 开头用它)。 */
  publishTitle: string;
  /** 简介 + 引导互动正文(抖音/TikTok caption 主体、小红书正文、币安/推特正文)。 */
  publishCaption: string;
  /** 话题标签(不带 #,driver 自己按平台格式加)。 */
  hashtags: string[];
  /** AI 实扣积分。 */
  tokens: number;
  /** USD 成本。 */
  costUsd: number;
}

const SYSTEM_PROMPT = [
  '# Role: 短视频平台运营 · 发布文案专家(json)',
  '## 目标',
  '给一条已经做好的短视频,写一段【发布到社交平台时配在视频下方】的文案。这段文案的唯一使命是【让刷到的人点开视频 + 看完点赞/收藏/关注】—— 不是复述视频内容,不是口播稿,不是字幕。',
  '',
  '## 输出 JSON(严格 3 个 key):',
  '{ "publishTitle": str, "publishCaption": str, "hashtags": [str, ...] }',
  '',
  '## 硬规则(违反任一 = 失败):',
  '1. publishTitle:钩人标题,≤24 字。用悬念/反差/利益点/数字钩子抓人(例:「3 个币今天集体爆拉,第 2 个没人料到」)。不要平铺直叙复述内容。',
  '2. publishCaption:正文,2-4 句,60-140 字。开头一句钩子,中间点一下看点,结尾一句引导互动(如「关注我每天追行情」「评论区说说你看好哪个」)。可用 1-3 个 emoji 提升点击,但别堆砌。',
  '3. hashtags:3-6 个,跟内容强相关的【平台真实存在的热门话题词】。不带 # 号(后端按平台自己加)。每个 ≤12 字。',
  '4. 语言:**严格用「用户消息里指定的目标输出语言」书写全部字段**(publishTitle / publishCaption / hashtags),即使视频概要是别的语言,也要写成目标语言(例:目标语言 English 时,即便概要是中文,也输出全英文的标题/正文/hashtag)。下面示例仅示范风格与格式,语言一律以用户指定的目标语言为准。',
  '5. **绝不复述视频里的完整内容/口播稿**,文案是「预告片」不是「全文」。',
  '6. JSON only,无 markdown 围栏,无解释。',
  '',
  '## 反面例子(会 reject —— 这是把口播稿当文案):',
  '{ "publishCaption": "今日加密货币市场,DOGE 上涨 18.96%,SOL 上涨 12.47%,BNB 上涨 8.13%,以上就是今天的行情。" }',
  '',
  '## 正面例子:',
  '{',
  '  "publishTitle": "今天这 3 个币,闷声干了大事 🚀",',
  '  "publishCaption": "行情又变天了!这波谁还在场内?👀 第 1 个的涨幅我都不敢信。完整榜单在视频里,关注我每天 8 点更新行情速览,别错过下一波。",',
  '  "hashtags": ["加密货币", "币圈", "行情分析", "狗狗币", "每日行情"]',
  '}',
].join('\n');

// 目标输出语言标签(注入 AI prompt + 兜底文案按语言出)。覆盖 ContentLang 全 10 语。
// 「创作语言」既决定口播稿/字幕,也必须决定发布标题/介绍/hashtag —— 这份表让发布文案真正跟着走。
const PUB_LANG_LABEL: Record<string, string> = {
  zh: '简体中文 (Simplified Chinese)',
  'zh-TW': '繁體中文 (Traditional Chinese)',
  ja: '日本語 (Japanese)',
  ko: '한국어 (Korean)',
  en: 'English',
  id: 'Bahasa Indonesia (Indonesian)',
  vi: 'Tiếng Việt (Vietnamese)',
  es: 'Español (Spanish)',
  pt: 'Português (Portuguese)',
  fr: 'Français (French)',
};

/** 从夹带文字/围栏的输出里抠第一个 JSON 对象。 */
function extractJsonObject(raw: string): string {
  let t = (raw || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) t = fence[1].trim();
  const start = t.indexOf('{');
  if (start >= 0) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < t.length; i++) {
      const c = t[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else {
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return t.slice(start, i + 1); }
      }
    }
  }
  return t;
}

/** 清洗 hashtags:数组、去 #、去空白、限长、去重、最多 6 个。 */
function cleanHashtags(raw: any): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const h of raw) {
    if (typeof h !== 'string') continue;
    const clean = h.replace(/[#\s,，]+/g, '').slice(0, 12);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * 生成平台发布文案。失败(未登录/网络/JSON 解析错/字段缺)返 null,上层降级。绝不抛。
 */
export async function generatePublishCaption(input: PublishCaptionInput): Promise<PublishCaptionResult | null> {
  const token = getNoobClawAuthToken();
  if (!token) return null;
  const summary = (input.summary || '').trim();
  if (!summary) return null;

  const userParts: string[] = [];
  const targetLangLabel = PUB_LANG_LABEL[String(input.lang)] || PUB_LANG_LABEL.zh;
  userParts.push(`# 目标输出语言:${targetLangLabel} —— publishTitle / publishCaption / hashtags 三个字段全部必须用这个语言书写,无论下面视频概要是什么语言。`);
  userParts.push('# 视频内容概要(据此写钩人文案,不要照抄):');
  userParts.push(summary.slice(0, 600));
  if (input.title) userParts.push(`\n# 视频标题参考:${input.title}`);
  if (input.track) userParts.push(`# 赛道:${input.track}`);
  if (input.keywords && input.keywords.length) {
    userParts.push(`# 关键词(可选做 hashtag):${input.keywords.slice(0, 8).join('、')}`);
  }
  userParts.push('\n输出 3 字段 JSON。');
  const user = userParts.join('\n');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const resp = await fetch(`${apiBase()}/api/ai/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        model: 'noobclawai-reasoner',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: user },
        ],
        stream: false,
        max_tokens: 600,
        temperature: 0.9, // 文案要多样,适度提温
        // 不带 response_format=json_object:reasoner(Pro)不支持该开关(带上会被拒/失效),
        //   JSON 契约靠 prompt(「输出 3 字段 JSON」)+ 下面 extractJsonObject 宽松解析兜底。
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    const json: any = await resp.json();
    const content = json?.choices?.[0]?.message?.content || '';
    if (!content) return null;
    let parsed: any;
    try { parsed = JSON.parse(extractJsonObject(content)); }
    catch { return null; }

    const publishTitle = typeof parsed?.publishTitle === 'string' ? parsed.publishTitle.trim().slice(0, 40) : '';
    const publishCaption = typeof parsed?.publishCaption === 'string' ? parsed.publishCaption.trim().slice(0, 300) : '';
    const hashtags = cleanHashtags(parsed?.hashtags);
    // 标题 + 正文 至少要有一个,否则判失败降级
    if (!publishTitle && !publishCaption) return null;

    const costUsd = Number(json?._noobclaw?.costUsd) || 0;
    const price = Number(json?._noobclaw?.priceUsdPerMillion) || 0;
    let tokens = Number(json?._noobclaw?.billableTokens) || 0;
    if (!tokens && costUsd > 0 && price > 0) tokens = Math.round((costUsd / price) * 1_000_000);

    return {
      publishTitle: publishTitle || input.title || '',
      publishCaption: publishCaption || publishTitle,
      hashtags,
      tokens,
      costUsd,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── 高层封装:给 pipeline 直接用,内含「用户覆盖 > AI 生成 > 兜底」三级决策 ──

export interface ResolveCaptionInput {
  /** 是否真有平台要发。false 时不调 AI(省钱),直接返兜底(反正不发)。 */
  wantPublish: boolean;
  /** 视频内容概要(AI 重写后的口播稿 / dataText),给 AI 写钩子文案。 */
  summary: string;
  /** 视频标题参考。 */
  title?: string;
  keywords?: string[];
  track?: string;
  lang: ContentLang;
  /** 用户向导填的(覆盖 AI);任一非空就尊重用户。 */
  userTitle?: string;
  userCaption?: string;
  userTags?: string[];
  /** 计费/日志回调:AI 真调时回传 token + 进度。 */
  onLog?: (m: string) => void;
  onCost?: (tokens: number, costUsd: number) => void;
}

/** runPublishStep 要的最终文案三元组。 */
export interface ResolvedCaption {
  title?: string;
  description: string;
  tags: string[];
}

/**
 * 决策最终发布文案:用户填的 > AI 生成的 > 兜底(首句 + keywords)。
 * 绝不抛。不发布时不调 AI。
 */
export async function resolvePublishCaption(input: ResolveCaptionInput): Promise<ResolvedCaption> {
  const kwTags = (input.keywords || []).filter(Boolean).slice(0, 6);
  // 兜底文案【绝不用口播稿原文 / 视频标题首句】(用户要求:发布文案不能跟口播稿一样)——
  // 改用关键词 + 通用引导钩子。AI 正常生成时不走这里;只有 AI 失败 / 不发布才用到。
  const kwHead = kwTags[0] || '';
  // 兜底文案也按创作语言出(不再只有中/英两档)——AI 失败时选了日语/越南语也不会掉回英文。
  const FB: Record<string, { sfx: string; gen: string; desc: string }> = {
    zh:      { sfx: '｜完整版在视频里 👀', gen: '完整内容,都在视频里 👀', desc: '完整内容都在视频里,觉得有用就关注我,每天持续更新~' },
    'zh-TW': { sfx: '｜完整版在影片裡 👀', gen: '完整內容,都在影片裡 👀', desc: '完整內容都在影片裡,覺得有用就追蹤我,每天持續更新~' },
    ja:      { sfx: '｜続きは動画で 👀', gen: '続きは動画でチェック 👀', desc: '詳しくは動画で。役に立ったらフォローしてね、毎日更新中~' },
    ko:      { sfx: ' | 전체는 영상에서 👀', gen: '전체 내용은 영상에서 👀', desc: '자세한 내용은 영상에서. 도움이 됐다면 팔로우, 매일 업데이트~' },
    en:      { sfx: ' — full clip inside 👀', gen: 'Full clip inside 👀', desc: 'Full story is in the clip — follow for daily updates.' },
    id:      { sfx: ' — selengkapnya di video 👀', gen: 'Selengkapnya di video 👀', desc: 'Cerita lengkapnya ada di video — follow untuk update harian.' },
    vi:      { sfx: ' — xem đầy đủ trong video 👀', gen: 'Xem đầy đủ trong video 👀', desc: 'Nội dung đầy đủ có trong video — theo dõi để cập nhật mỗi ngày.' },
    es:      { sfx: ' — todo en el video 👀', gen: 'Todo está en el video 👀', desc: 'La historia completa está en el video — sígueme para novedades cada día.' },
    pt:      { sfx: ' — tudo no vídeo 👀', gen: 'Tudo está no vídeo 👀', desc: 'A história completa está no vídeo — siga para novidades diárias.' },
    fr:      { sfx: ' — tout est dans la vidéo 👀', gen: 'Tout est dans la vidéo 👀', desc: "Toute l'histoire est dans la vidéo — abonne-toi pour du contenu quotidien." },
  };
  const fb = FB[String(input.lang)] || FB.zh;
  const fbTitle = input.userTitle?.trim() || (kwHead ? `${kwHead}${fb.sfx}` : fb.gen);
  const fbDesc = input.userCaption?.trim() || fb.desc;

  // 不发布 → 不浪费 AI,返兜底(下游也不会真用)。
  if (!input.wantPublish) {
    return { title: fbTitle, description: fbDesc, tags: input.userTags?.length ? input.userTags : kwTags };
  }

  // 用户填了正文 → 完全尊重用户,不调 AI。
  if (input.userCaption && input.userCaption.trim()) {
    return {
      title: input.userTitle?.trim() || fbTitle,
      description: input.userCaption.trim(),
      tags: input.userTags?.length ? input.userTags : kwTags,
    };
  }

  // 否则 AI 生成。
  input.onLog?.('✍️ 生成平台发布文案(钩人标题 + 引导互动)…');
  const ai = await generatePublishCaption({
    summary: input.summary,
    title: input.title,
    keywords: input.keywords,
    track: input.track,
    lang: input.lang,
  });
  if (ai) {
    input.onCost?.(ai.tokens, ai.costUsd);
    input.onLog?.(`✅ 发布文案就绪:「${ai.publishTitle.slice(0, 20)}…」`);
    return {
      title: input.userTitle?.trim() || ai.publishTitle,
      description: ai.publishCaption,
      tags: input.userTags?.length ? input.userTags : (ai.hashtags.length ? ai.hashtags : kwTags),
    };
  }

  // AI 失败 → 兜底(标题首句 + keywords)。
  input.onLog?.('⚠️ 发布文案 AI 生成失败,用标题 + 关键词兜底');
  return { title: fbTitle, description: fbDesc, tags: input.userTags?.length ? input.userTags : kwTags };
}
