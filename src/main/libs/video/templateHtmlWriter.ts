/**
 * templateHtmlWriter — 「模板速生」HF 派的数据 + 口播稿层。
 *
 * v3 改动:在原有「AI 抽 dataText → {title,subtitle,items}」基础上,加一份「按 dataText
 * 写一段 ~6-12s 中文口播稿」的产物 —— 当用户在向导里开了「配音」时,pipeline 把口播稿
 * 喂 edge-tts 出 wav,拿到【真实音频时长 + 词级时间戳】,再用这个真实时长去渲染 HTML。
 * 这是抄 HF 的「TTS 先出,HTML 时长跟着音频走」核心 insight。
 *
 * 同时收紧 SYSTEM_PROMPT 加 HF SKILL.md 风格的硬规则(不让 AI 编数据、不让 voiceScript
 * 跨内容造谣)。
 *
 * 计费:走 NoobClaw 服务端 DeepSeek 代理(/api/ai/chat/completions),口径同 scriptWriter。
 */

import { getNoobClawAuthToken } from '../claudeSettings';
import { detectLang, type ContentLang } from './scriptWriter';
import type { TemplateItem } from './templateLibrary';

export type { ContentLang };

function apiBase(): string {
  return process.env.NOOBCLAW_API_BASE_URL || 'https://api.noobclaw.com';
}

/** 模板版式枚举(card 向导让用户选)。
 *  ai_freeform = 「AI 自由排版」:AI 写整页 HTML+CSS(+可选 GSAP),走 freeformWriter +
 *  体检迭代闭环,不走固定模板渲染。其余 5 个是固定精品模板。 */
export type TemplateStyle = 'rank_list' | 'news_cards' | 'quote' | 'countdown' | 'stat_board' | 'timeline' | 'cover_hero' | 'billboard' | 'ai_freeform';

/** 「模板速生」任务输入子对象。 */
export interface TemplateOptions {
  style: TemplateStyle;
  title?: string;
  dataText: string;          // 用户粘贴的榜单/要点/金句
  durationSec?: number;      // 目标时长(无配音时用;有配音时被真实音频时长覆盖)。clamp[3,20]
  fps?: number;              // 默认 30
  brandColor?: string;       // 主品牌色 #RRGGBB
  accentColor?: string;      // 强调色
  // ── HF 派新增 ──
  narration?: boolean;       // 是否生成 AI 口播 + 字幕(默认 false=纯画面)
  voice?: string;            // edge-tts 音色(如 zh-CN-XiaoxiaoNeural),空 = 用默认
  voiceRate?: number;        // 语速档(-50~+50,单位%),0/空 = 正常
  voiceScript?: string;      // 用户自定义口播稿;空 = AI 按 dataText 生成
  subtitleEnabled?: boolean; // 烧字幕开关(narration on 时才有意义)。默认 true
  watermark?: string;        // 右下角水印文案。空字符串 = 不显示
  /** 「AI 自由排版」专用:用户对风格/重点的自由描述,拼进 freeformWriter prompt。其它版式忽略。 */
  brief?: string;
  /** 设计主题 id(themes.ts);'auto'/空 = 按内容气质自动挑。用于 sceneComposer 主题化渲染。 */
  themeId?: string;
  /** 热榜数据源榜名(同 /api/web3/hot-search?sources=)。非空 = 出片时实时抓该榜前 N 条当内容,
   *  抓失败退回 dataText 快照。空 = 用 dataText。 */
  hotlistSource?: string;
  /** 生成语言(ContentLang 码,如 'zh'/'zh-TW'/'en'/'ja'…):画面文字 + AI 口播稿都用该语言,
   *  内容是其它语言时 AI 翻译过来。空/'auto' = 按 dataText+title 自动探测(老行为)。 */
  lang?: string;
}

export interface TemplateData {
  title?: string;
  subtitle?: string;
  items: TemplateItem[];
  /** AI 顺手产的口播稿(中文短句,适合 TTS),narration 开启时用。 */
  voiceScript?: string;
  /**
   * AI 把口播稿按【画面页数】切成 N 段,每段对应一个 page 的画面停留时间。
   * pipeline 据此把 page wrapper 的 data-start / data-duration 跟 TTS 真实时间锚定,
   * 实现「配音念到第 N 条时,画面正好显示第 N 条所在那一页」 —— 抄 HF 派的音画同步。
   * 与 voiceScript 的关系:voiceSegments.join(' ') ≈ voiceScript(用于按字符比例反算时间)。
   */
  voiceSegments?: string[];
}

export interface TemplateDataResult extends TemplateData {
  source: 'ai' | 'fallback';
  tokens: number;
  costUsd: number;
}

export interface TemplateDataInput {
  style: TemplateStyle;
  title?: string;
  dataText: string;
  track?: string;
  lang: ContentLang;
  /** 用户显式选了生成语言时传【语言名】(如 'Chinese (Traditional)'/'Japanese'):
   *  items/标题/口播稿强制用该语言书写(内容是其它语言就翻译)。undefined = 保持用户内容语言(老行为)。 */
  forceLangName?: string;
  /** 是否一并要求 AI 产口播稿(开了配音才要,省 token)。 */
  needVoiceScript?: boolean;
  /**
   * 画面分页元信息,用于告诉 AI 该把口播稿切成几段、每段对应哪几条 items。
   * 让 AI 输出的 voiceSegments[i] 严格对应画面 page[i] 的内容,音画对齐。
   */
  pageMeta?: {
    pageCount: number;
    /** 每页 items 索引范围,如 [[0,3],[4,5]] 表示 page 1 含 items[0..3], page 2 含 items[4..5]。 */
    pageRanges: Array<[number, number]>;
  };
}

const SYSTEM_PROMPT_BASE = [
  '你把用户提供的内容整理成【结构化榜单/要点数据】,用于生成动效短视频。只输出严格 JSON(json),不要任何解释。',
  '输出结构:{"title":"大标题","subtitle":"副标题(可选)","items":[{"rank":1,"name":"主名称","value":"数值","sub":"副说明(可选)"}]}',
  '硬规则(违反任何一条 = 失败):',
  '1. title 简短有力(≤14 字)。subtitle 仅当【用户内容里明确给了来源/日期/榜单名】时才填,否则【必须留空,绝不自己编造来源或品牌名(如交易所名)】。',
  '2. items **最多 12 条**,从用户内容里提取;有数值(涨跌幅/数量/价格)就放 value(保留正负号、百分号、单位),没有就省略 value。',
  '3. **name 与 value 严格不重叠**:value 是纯数值串(带单位/符号即可,如 "+18.96%" / "1.2亿" / "98.4%"),name 是【主名称/事件描述】不能末尾再带这个数值。例:用户给"美联储6月维持利率不变的概率为 98.4%" → name="美联储6月维持利率不变的概率",value="98.4%"(name 末尾不要再带"98.4%")。',
  '4. 排行榜/盘点:按用户给的顺序或数值大小排序,逐条填 rank(1,2,3…)。',
  '5. 金句/语录:items 放一条 {"name":"金句正文","sub":"作者(可选)"}。',
  '6. 保持用户内容的语言;**绝不编造用户没给的数据**(没就留空);**绝不修改用户给的数值**(原样回传)。',
  '7. 不要输出 Markdown 围栏、不要解释、不要加 emoji。',
].join('\n');

const SYSTEM_PROMPT_WITH_VOICE = [
  SYSTEM_PROMPT_BASE,
  '',
  '【追加 1:口播稿】产一段【自然流畅的中文短视频口播稿】放在 "voiceScript" 字段。这是新闻主播/财经评论员口吻,**不是机械念清单**。要求:',
  'A. 时长 12-45 秒(约 80-260 字),覆盖**所有** items 要点(信息密度高,但要听感自然)。',
  'B. **不是逐条念**,而是用承接词("其中"/"值得注意的是"/"最引人关注的是"/"另外"/"与此同时"/"截至发稿")把数据/事件**串成一段流畅播报**。有起承转合:开场点题 → 关键数据 → 收尾补充。',
  'C. 开头允许一句【自然简短的引导句】帮听感顺(不要让 voiceScript 直接念第一条数据,听起来硬),例如"今日热点速览,以下几件事最受关注"/"本周市场盘点开始"/"快讯三连发,看完两分钟搞懂"(按内容类型自然选词,12 字内)。但禁止"大家好"/"今天给大家分享"/"欢迎来到"这种社交媒体套话开场。结尾不煽情(不要"快来关注"/"记得点赞")。',
  'D. 数据必须正确,但**表达可以重组润色** —— 把生硬的"DOGE 涨 18.96%"说成"狗狗币以 18.96% 的涨幅领涨";把"美联储6月维持利率不变的概率为 98.4%"说成"美联储 6 月按兵不动几成定局,市场押注高达 98.4%"。',
  'E. 句子长短交替,适合 TTS 自然停顿;用中文标点(逗号、句号、顿号);不要英文标点。',
  '',
  '【追加 2:画面音画同步,关键!】**同时**产一个 "voiceSegments" 字符串数组,把上面的 voiceScript 严格按【画面页数】切成 N 段(N 由用户消息里的 pageCount 给出),每段对应一页画面的内容,音画同步。要求:',
  'F. voiceSegments 数组长度 **必须等于** pageCount。',
  'G. voiceSegments[i] 是 voiceScript 的【连续子段】,内容必须只覆盖第 i 页对应的 items(用户消息里 pageRanges 给出每页 items 索引范围)。例:pageRanges=[[0,3],[4,5]] 时,segments[0] 念 items[0..3] 的内容,segments[1] 念 items[4..5] 的内容。',
  'H. voiceSegments.join(" ") 拼起来必须 == voiceScript(或仅相差空格)。**绝不在 segments 里添加 voiceScript 中没有的字**。',
  'I. 单页只有 1 条 item 时,segments[i] 也可以只有一两句话(自然就行,不强求字数均匀)。',
].join('\n');

/** 口播稿 system prompt:默认中文;用户显式选了生成语言时把「中文」相关措辞替换成目标语言
 *  (字数区间只对中文有意义,非自动时改按朗读时长把控)。 */
function systemPromptWithVoice(forceLangName?: string): string {
  if (!forceLangName) return SYSTEM_PROMPT_WITH_VOICE;
  return SYSTEM_PROMPT_WITH_VOICE
    .split('【自然流畅的中文短视频口播稿】').join(`【自然流畅的、用 ${forceLangName} 书写的短视频口播稿】`)
    .split('(约 80-260 字)').join('(以朗读时长为准,不拘字数)')
    .split('用中文标点(逗号、句号、顿号);不要英文标点').join(`标点遵循 ${forceLangName} 的标准书写规范`);
}

interface ChatResult { content: string; tokens: number; costUsd: number; }

/**
 * 随机抽一种播报语气塞进 generateTemplateData 的 user message —— needVoiceScript=true 时打破
 *   「同一份数据 → 同一种主播口吻」。模板速生 voiceScript 硬编码中文(见 SYSTEM_PROMPT_WITH_VOICE),
 *   语气池也只做中文。5 种都是【专业感框架内】的语气变体,不会破坏数据准确性。
 */
function pickTemplateVoiceTone(): string {
  const POOL = [
    '财经主播口吻(沉稳、用"我们关注到 / 数据显示 / 截至发稿"等承接词,新闻播报感)',
    '深度评论员口吻(分析感强、用"值得注意的是 / 背后逻辑是 / 这意味着"做层层递进)',
    '资讯简报口吻(短句、信息密度高、像 30 秒快讯,不展开解读)',
    '行业老炮闲聊口吻(像跟同行茶水间聊 — 仍保持数据准确,但用词更松,有"老实说 / 说白了"这种)',
    '科普讲解口吻(把数据用对比/类比解释清楚,适合非专业观众,如"涨幅 18% 是什么概念,相当于...")',
  ];
  return POOL[Math.floor(Math.random() * POOL.length)];
}

/**
 * 走 NoobClaw 服务端 DeepSeek 代理跑一次 chat completion(JSON 模式)。
 * 导出供 freeformWriter 复用同一条计费/鉴权口径(别再各写一份)。
 * maxTokens 默认 2400;freeform 产整页 HTML 需要更大,调用方可放大。
 */
export async function callNoobclawChat(
  system: string, user: string,
  opts?: { temperature?: number; maxTokens?: number; model?: 'noobclawai-chat' | 'noobclawai-reasoner'; timeoutMs?: number },
): Promise<ChatResult> {
  return callDeepSeekData(system, user, opts?.temperature, opts?.maxTokens, opts?.model, opts?.timeoutMs);
}

// 默认走 Pro(reasoner=deepseek-v4-pro):模板数据抽取/口播稿/自由排版都是创作活,质量优先。
// timeoutMs 默认 60s;freeform 产整页 HTML(reasoner 还要吐思考链)慢,调用方放大到 ~120s,
// 否则正常生成会被误判超时 → 白白降级/掉兜底。
async function callDeepSeekData(
  system: string, user: string, temperature?: number, maxTokens?: number,
  model: 'noobclawai-chat' | 'noobclawai-reasoner' = 'noobclawai-reasoner',
  timeoutMs = 60_000,
): Promise<ChatResult> {
  const token = getNoobClawAuthToken();
  if (!token) throw new Error('AI_NOT_CONFIGURED — 请先登录 NoobClaw 账号');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs > 0 ? timeoutMs : 60_000);
  try {
    const body: Record<string, unknown> = {
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      stream: false,
      max_tokens: maxTokens && maxTokens > 0 ? maxTokens : 2400,
    };
    // response_format=json_object 仅 chat(flash)支持;reasoner(Pro)不支持(强行带上会被拒/失效,
    //   正是历史上 Pro「解析不出来」的根因)。Pro 改靠 prompt 强约束 + extractJsonObject 宽松解析兜底。
    if (model === 'noobclawai-chat') body.response_format = { type: 'json_object' };
    // 创作类(voiceScript)显式拉高温度提升多样性;纯数据 items 抽取不传 = 用默认低温保稳定。
    if (typeof temperature === 'number' && Number.isFinite(temperature)) {
      body.temperature = temperature;
    }
    const resp = await fetch(`${apiBase()}/api/ai/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      if (resp.status === 401) throw new Error('AI_AUTH_FAILED — NoobClaw 登录态失效,请重新登录');
      if (resp.status === 402) throw new Error('CREDITS_INSUFFICIENT — 积分余额不足,请前往钱包充值');
      const t = await resp.text().catch(() => '');
      throw new Error(`AI API ${resp.status}: ${t.slice(0, 200)}`);
    }
    const json: any = await resp.json();
    const content = json?.choices?.[0]?.message?.content || '';
    if (!content) throw new Error('AI_EMPTY_RESPONSE');
    const costUsd = Number(json?._noobclaw?.costUsd) || 0;
    const price = Number(json?._noobclaw?.priceUsdPerMillion) || 0;
    let tokens = Number(json?._noobclaw?.billableTokens) || 0;
    if (!tokens && costUsd > 0 && price > 0) tokens = Math.round((costUsd / price) * 1_000_000);
    return { content, tokens, costUsd };
  } finally {
    clearTimeout(timer);
  }
}

/** 从夹带文字/围栏的输出里抠出第一个 JSON 对象。 */
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

/** AI 偶尔会把 value("98.4%") 同时塞在 name 末尾(name="...概率为 98.4%", value="98.4%"),
 *  渲染时画面会同时出两遍数值。这里前端兜底:value 在 name 末尾出现就切掉,顺带把
 *  常见承接介词("为/是/达/约/共/合计"等)也一起剥掉,保留干净的 name。 */
function dedupValueFromName(name: string, value: string | undefined): string {
  if (!value || !name) return name;
  const v = value.trim();
  if (!v) return name;
  // 末尾包含 value(允许 value 前有空格/介词)
  const tail = new RegExp(`\\s*[为是达约共合计]?\\s*\\(?\\s*${escapeForRegex(v)}\\s*\\)?\\s*$`);
  const cleaned = name.replace(tail, '').replace(/[,，、:：=的\s]+$/, '').trim();
  return cleaned || name; // 切完空了就还原(避免误伤)
}
function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanItems(raw: any): TemplateItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 12).map((it: any, i: number) => {
    let name = typeof it?.name === 'string' ? it.name.trim() : '';
    if (!name) return null;
    const value = typeof it?.value === 'string' && it.value.trim() ? it.value.trim().slice(0, 24) : undefined;
    name = dedupValueFromName(name, value);
    const item: TemplateItem = { name: name.slice(0, 60) };
    if (typeof it?.rank === 'number') item.rank = it.rank; else item.rank = i + 1;
    if (value) item.value = value;
    if (typeof it?.sub === 'string' && it.sub.trim()) item.sub = it.sub.trim().slice(0, 60);
    return item;
  }).filter(Boolean) as TemplateItem[];
}

/** 纯代码兜底:把 dataText 按行解析成 items(AI 不可用时)。 */
function parseDataText(input: TemplateDataInput): TemplateData {
  const items: TemplateItem[] = (input.dataText || '')
    .split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 8)
    .map((line, i) => {
      const m = line.match(/^(.*?)[\s:：,，\-—]+([+\-]?\d[\d.,%]*\S*)\s*$/);
      if (m) return { rank: i + 1, name: m[1].trim().slice(0, 60), value: m[2].trim().slice(0, 24) };
      return { rank: i + 1, name: line.slice(0, 60) };
    });
  return { title: input.title, items };
}

/** 从 items 兜底产口播稿(AI 配音稿失败时用),纯代码、不调 AI。 */
function fallbackVoiceScript(items: TemplateItem[], title?: string): string {
  const parts: string[] = [];
  if (title) parts.push(title);
  for (const it of items.slice(0, 6)) {
    const seg = [it.name, it.value].filter(Boolean).join(' ');
    if (seg) parts.push(seg);
  }
  return parts.join('。') + '。';
}

/**
 * 产模板数据:AI 解析 dataText → {title,subtitle,items,voiceScript,voiceSegments},失败用纯代码兜底。
 * 永远返回可用数据。needVoiceScript=true 时同时产口播稿 + 按 pageMeta 分段(narration 开启专用)。
 */
export async function generateTemplateData(input: TemplateDataInput, systemPrompt?: string): Promise<TemplateDataResult> {
  const sys = systemPrompt
    || (input.needVoiceScript ? systemPromptWithVoice(input.forceLangName) : SYSTEM_PROMPT_BASE);
  try {
    const userParts: string[] = [];
    if (input.title) userParts.push(`标题倾向:${input.title}`);
    if (input.track) userParts.push(`赛道:${input.track}`);
    // 用户显式选了生成语言 → 硬规则压倒 system 里的「保持用户内容的语言」;放 user message
    // 是为了对 服务端可调的纯数据 prompt(templateDataSystemPrompt)同样生效。
    if (input.forceLangName) {
      userParts.push(`输出语言(硬规则,优先于「保持用户内容的语言」):title/subtitle、items 的 name/sub、以及 voiceScript/voiceSegments,一律用【${input.forceLangName}】书写;用户内容若是其它语言,请准确翻译过来。数值/百分比/货币符号/代码与专有名词(币种代号、人名、品牌)保持原样,绝不因翻译改动数据。`);
    }
    if (input.needVoiceScript) {
      userParts.push(`需要 voiceScript:true(产${input.forceLangName ? ` ${input.forceLangName} ` : '中文'}口播稿)`);
      // 每次随机一种语气,塞到 user message,跟跨调用的「同一份数据 → 同一种口吻」对着干。
      //   不放 system prompt 是因为 system 是服务端可调的,改这事跟模板措辞无关;tone 是每次
      //   现 roll 的运行期行为,本该在 call site。
      const tone = pickTemplateVoiceTone();
      userParts.push(`本次 voiceScript 请采用「${tone}」,跟该数据类型常见的播报口吻明显错开。注意:tone 只影响表达风格,绝不能改变数据的准确性。`);
      if (input.pageMeta) {
        const ranges = input.pageMeta.pageRanges
          .map(([a, b], i) => `page ${i + 1} 含 items[${a}..${b}]`)
          .join(';');
        userParts.push(`画面分页:pageCount=${input.pageMeta.pageCount}(${ranges})`);
        userParts.push('需要 voiceSegments:长度等于 pageCount,每段对应一页画面内容(音画同步)');
      }
    }
    userParts.push('用户内容(json):');
    userParts.push(input.dataText.slice(0, 2000));
    const user = userParts.join('\n');
    // temperature=1.0 仅在 voiceScript 时拉高(让口播稿措辞多样);纯抽 items 时不传 = 用默认
    //   低温保数据稳定。system prompt 里的"绝不修改用户给的数值/绝不编造"是强约束,1.0 不会突破。
    const { content, tokens, costUsd } = await callDeepSeekData(sys, user, input.needVoiceScript ? 1.0 : undefined);
    const parsed = JSON.parse(extractJsonObject(content));
    const items = cleanItems(parsed?.items);
    if (items.length > 0) {
      const voiceScript = (typeof parsed?.voiceScript === 'string' && parsed.voiceScript.trim())
        ? parsed.voiceScript.trim().slice(0, 800)
        : undefined;
      // voiceSegments:数组,过滤非字符串/空串,clamp 元素数到 pageCount(AI 多给/少给都救场)
      let voiceSegments: string[] | undefined;
      if (Array.isArray(parsed?.voiceSegments) && input.pageMeta) {
        const raw: string[] = parsed.voiceSegments
          .filter((s: any) => typeof s === 'string' && s.trim())
          .map((s: string) => s.trim().slice(0, 600));
        if (raw.length === input.pageMeta.pageCount) {
          voiceSegments = raw;
        }
        // 长度对不上就丢弃 segments —— pipeline 会 fallback 到字符均分
      }
      return {
        title: (typeof parsed?.title === 'string' && parsed.title.trim()) ? parsed.title.trim().slice(0, 28) : input.title,
        subtitle: (typeof parsed?.subtitle === 'string' && parsed.subtitle.trim()) ? parsed.subtitle.trim().slice(0, 40) : undefined,
        items, voiceScript, voiceSegments,
        source: 'ai', tokens, costUsd,
      };
    }
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    if (/AI_AUTH_FAILED|CREDITS_INSUFFICIENT|AI_NOT_CONFIGURED/.test(msg)) throw e;
  }
  // 兜底:纯代码解析,保证永远出片(不计 AI 费)。
  const fb = parseDataText(input);
  const voiceScript = input.needVoiceScript ? fallbackVoiceScript(fb.items, fb.title) : undefined;
  return { ...fb, voiceScript, source: 'fallback', tokens: 0, costUsd: 0 };
}

/** 内容语言探测(复用 scriptWriter.detectLang)。 */
export function detectTemplateLang(text: string): ContentLang {
  return detectLang(text);
}
