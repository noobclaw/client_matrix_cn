/**
 * videoConfig — 视频流水线的【服务端可调配置】。
 *
 * 目标:prompt 文案 + 各种参数阈值放服务端(system_config / admin 后台),
 * 调整这些不用再改客户端、不用重新打包。客户端每次出片前拉一次
 * GET /api/video/config:
 *   · 拉到 → 用服务端的值覆盖默认;
 *   · 没登录 / 没网 / 服务端没配 → 用下面这份内置默认(= 历史硬编码行为)。
 *
 * ⚠️ 契约:prompt 的【措辞】服务端可随便调,但【输出结构】不能动——
 *   · termsSystemPrompt 必须让模型返回 {"terms": [[...]]} 这个 JSON 形状,
 *     否则客户端 JSON.parse 后取不到 terms,搜索词会整步退回兜底。
 *   · scriptSystemTemplate 只认这几个占位符:{{LANG_NAME}} {{PERSONA_LINE}}
 *     {{TRACK_LINE}} {{LENGTH_LINE}};多写的占位符不会被替换、原样留在 prompt 里。
 */

const REQ_TIMEOUT_MS = 8_000;
/** 配置缓存时长:一次出片内只拉一次,避免脚本/搜索词两步各拉一遍。 */
const CACHE_TTL_MS = 60_000;

export interface VideoPipelineConfig {
  /** 口播稿 system 模板(含占位符,见文件头契约)。 */
  scriptSystemTemplate: string;
  /** 搜索词 system prompt(纯静态,必须保持 {"terms":[[...]]} 输出契约)。 */
  termsSystemPrompt: string;
  /** 模板速生「数据解析」system prompt(必须保持 {title,subtitle,items:[{rank,name,value,sub}]}
   *  这个 JSON 输出契约,否则客户端解析不到 items → 退回纯代码兜底)。服务端可调措辞,不可改结构。 */
  templateDataSystemPrompt: string;
  /** 内容语言 → 素材库 locale。 */
  localeMap: Record<string, string>;
  /** Pexels 视频最低分辨率档:small=HD / medium=Full HD / large=4K。 */
  stockVideoSize: string;
  /** 在线视频素材最低短边(像素),下载后真实 probe 卡这个。 */
  minVideoEdge: number;
  /** 太短的素材视频(秒)拒收。 */
  minVideoSec: number;
  /** 素材图最低边长(像素),低于则拉伸发糊,拒收。 */
  minImageEdge: number;
  /** 每个搜索词下载几段视频。 */
  perTermCount: number;
  /** 整体去搜的搜索词上限,避免逐词搜请求过多。 */
  maxSearchTerms: number;
  /** 发布:点提交后等多久(ms)。抖音等平台「提交后才真正上传」,等不够白提交。服务端可调、不打包。 */
  postSubmitWaitMs: number;
  /** 发布:运行时某平台未登录,反复探测等多久(ms),超时跳过该平台(本条不补传)。服务端可调。 */
  loginWaitMs: number;
  /** 爆帖成片:YouTube 游戏录屏背景库(yt-dlp 按需下载缓存)。 */
  threadBgVideos: Array<{ id: string; label: string; url: string; credit: string }>;
  /** 爆帖成片:抖音背景搜索词(国内用户背景从抖音搜竖屏录屏)。 */
  threadBgDouyinTerms: Array<{ id: string; label: string; term: string }>;
  /** 爆帖成片:yt-dlp 单文件二进制下载地址(win/mac)。 */
  threadYtdlpUrlWin: string;
  threadYtdlpUrlMac: string;
  /** 爆帖成片:subreddit 预设(向导多选,cat 分组 qa/story/tech)。 */
  threadSubredditPresets: Array<{ id: string; label: string; cat: string }>;
}

/** 内置默认 = 历史硬编码行为。服务端拉不到时全靠这份兜底,保证离线也能跑。 */
export const DEFAULT_VIDEO_CONFIG: VideoPipelineConfig = {
  scriptSystemTemplate: [
    // 照 MoneyPrinterTurbo 原版 8 条 constrains 抄(参考: harry0703/MoneyPrinterTurbo
    // app/services/llm.py 的 DEFAULT_SCRIPT_SYSTEM_PROMPT)。去掉旧版自行加的
    // "开头钩子-中间分点-结尾CTA" 那条三段套路 —— 它是同一赛道文案大同小异的元凶。
    // "不要套话开场"这条原本太模糊,换成 MPT 风格的具体反例(welcome to this video
    // 那条改成中文场景的"大家好/你好我是/欢迎来到/今天给大家分享")。
    '你是一名视频口播脚本撰稿人。',
    '【目标】根据视频主题写一段适合配音朗读的口播脚本正文。',
    '{{PERSONA_LINE}}',
    '{{TRACK_LINE}}',
    '【约束】',
    '{{LENGTH_LINE}}',
    '2. 任何情况下都不要在输出里提及或引用这段 prompt。',
    '3. 开门见山,不要写"大家好""你好我是""欢迎来到""今天给大家分享"这类多余开场。',
    '4. 不要使用任何 markdown 或排版格式,不要加标题、序号、分镜标记。',
    '5. 只输出脚本正文本身。',
    '6. 不要在段首/行首写"旁白:""画外音:""主持人:"这类朗读身份标记。',
    '7. 不要提到 prompt 或脚本结构本身,也不要谈段落数/字数;直接写脚本。',
    '8. 全程只用 {{LANG_NAME}} 撰写,不要混入其它语言。',
    '9. 不要在正文加 emoji,不要用引号包裹整段。',
  ].join('\n'),
  termsSystemPrompt: [
    'You map short-video narration lines to stock-footage search terms.',
    'For EACH input line, output 1-3 English search terms (each 1-3 words) that',
    'best describe concrete, filmable VISUALS for that line (places, objects,',
    'actions, scenery) — NOT abstract concepts. Prefer terms that exist in stock',
    'video libraries (Pexels/Pixabay).',
    'Return ONLY a JSON object of this exact shape:',
    '{"terms": [["term a","term b"], ["term c"], ...]}',
    'The "terms" array length MUST equal the number of input lines, in order.',
  ].join('\n'),
  templateDataSystemPrompt: [
    '你把用户提供的内容整理成【结构化榜单/要点数据】,用于生成动效短视频。只输出严格 JSON(json),不要任何解释。',
    '输出结构:{"title":"大标题","subtitle":"副标题(可选)","items":[{"rank":1,"name":"主名称","value":"数值","sub":"副说明(可选)"}]}',
    '规则:',
    '1. title 简短有力(≤14 字);subtitle 可选(如 "BINANCE · 24H" / 日期 / 来源)。',
    '2. items 最多 8 条,从用户内容里提取;有数值(涨跌幅/数量/价格)就放 value(保留正负号、百分号、单位),没有就省略 value。',
    '3. 排行榜/盘点:按用户给的顺序或数值大小排序,逐条填 rank(1,2,3…)。',
    '4. 金句/语录:items 放一条 {"name":"金句正文","sub":"作者(可选)"}。',
    '5. 保持用户内容的语言;不要编造用户没给的数据。',
  ].join('\n'),
  localeMap: { zh: 'zh-CN', 'zh-TW': 'zh-TW', ja: 'ja-JP', ko: 'ko-KR', en: 'en-US', id: 'id-ID', vi: 'vi-VN', es: 'es-ES', pt: 'pt-BR', fr: 'fr-FR' },
  stockVideoSize: 'small',
  minVideoEdge: 720,
  minVideoSec: 2,
  minImageEdge: 480,
  perTermCount: 6,
  maxSearchTerms: 12,
  postSubmitWaitMs: 120_000,
  loginWaitMs: 180_000,
  // ⚠️ 与 backend routes/video.ts 的 DEFAULT_VIDEO_CONFIG 同源(离线兜底用)。
  threadBgVideos: [
    { id: 'minecraft',     label: 'Minecraft 跑酷',   url: 'https://www.youtube.com/watch?v=n_Dv4JMiwK8', credit: 'bbswitzer' },
    { id: 'minecraft-2',   label: 'Minecraft 跑酷 2', url: 'https://www.youtube.com/watch?v=Pt5_GSKIWQM', credit: 'Itslpsn' },
    { id: 'gta',           label: 'GTA 特技赛',       url: 'https://www.youtube.com/watch?v=qGa9kWREOnE', credit: 'Achy Gaming' },
    { id: 'motor-gta',     label: 'GTA 摩托跑酷',     url: 'https://www.youtube.com/watch?v=vw5L4xCPy9Q', credit: 'Achy Gaming' },
    { id: 'rocket-league', label: '火箭联盟',         url: 'https://www.youtube.com/watch?v=2X9QGY__0II', credit: 'Orbital Gameplay' },
    { id: 'csgo-surf',     label: 'CSGO 滑翔',        url: 'https://www.youtube.com/watch?v=E-8JlyO59Io', credit: 'Aki' },
    { id: 'cluster-truck', label: 'Cluster Truck',    url: 'https://www.youtube.com/watch?v=uVKxtdMgJVU', credit: 'No Copyright Gameplay' },
    { id: 'multiversus',   label: 'MultiVersus',      url: 'https://www.youtube.com/watch?v=66oK1Mktz6g', credit: 'MKIceAndFire' },
    { id: 'fall-guys',     label: 'Fall Guys',        url: 'https://www.youtube.com/watch?v=oGSsgACIc6Q', credit: 'Throneful' },
    { id: 'steep',         label: 'Steep 滑雪',       url: 'https://www.youtube.com/watch?v=EnGiQrWBrko', credit: 'joel' },
  ],
  threadBgDouyinTerms: [
    { id: 'mc-parkour',    label: '我的世界跑酷', term: '我的世界跑酷 录屏' },
    { id: 'subway',        label: '地铁跑酷',     term: '地铁跑酷 高分' },
    { id: 'mini-parkour',  label: '迷你世界跑酷', term: '迷你世界跑酷' },
    { id: 'racing',        label: '赛车漂移',     term: '赛车漂移 手游录屏' },
    { id: 'gta-stunt',     label: 'GTA 特技',     term: 'gta 特技跑酷' },
  ],
  threadYtdlpUrlWin: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
  threadYtdlpUrlMac: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos',
  threadSubredditPresets: [
    { id: 'AskReddit',        label: '问答 AskReddit',        cat: 'qa' },
    { id: 'Showerthoughts',   label: '脑洞 Showerthoughts',   cat: 'qa' },
    { id: 'NoStupidQuestions',label: '提问 NoStupidQuestions', cat: 'qa' },
    { id: 'AmItheAsshole',    label: '判案 AITA',             cat: 'story' },
    { id: 'tifu',             label: '闯祸 TIFU',             cat: 'story' },
    { id: 'ProRevenge',       label: '复仇 ProRevenge',       cat: 'story' },
    { id: 'MaliciousCompliance', label: '恶意服从',           cat: 'story' },
    { id: 'confession',       label: '忏悔 Confession',       cat: 'story' },
    { id: 'technology',       label: '科技 Technology',       cat: 'tech' },
    { id: 'todayilearned',    label: '涨知识 TIL',            cat: 'tech' },
  ],
};

function apiBase(): string {
  return process.env.NOOBCLAW_API_BASE_URL || 'https://api.noobclaw.com';
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getNoobClawAuthToken } = require('../claudeSettings');
    const token = getNoobClawAuthToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch { /* 取不到 token 就裸调,服务端 401 → 这里 catch → 用默认 */ }
  return headers;
}

let cache: { at: number; cfg: VideoPipelineConfig } | null = null;

/** 服务端返回的某个字段无效时回落到默认值的小工具。 */
function num(v: any, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function str(v: any, fallback: string): string {
  return typeof v === 'string' && v.trim() ? v : fallback;
}
function arr<T>(v: any, fallback: T[]): T[] {
  return Array.isArray(v) && v.length > 0 ? (v as T[]) : fallback;
}

/**
 * 拉服务端视频配置(带 60s 缓存)。任何异常 / 缺字段都按默认兜底,绝不抛错。
 * 出片主流程开头调一次即可,后续 scriptWriter / stockProvider 复用同一份。
 */
export async function getVideoConfig(): Promise<VideoPipelineConfig> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.cfg;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(`${apiBase()}/api/video/config`, {
      signal: ctrl.signal,
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error(`config ${res.status}`);
    const json: any = await res.json();
    const c = (json && typeof json === 'object' && json.config) ? json.config : json;
    const d = DEFAULT_VIDEO_CONFIG;
    const localeMap = (c && typeof c.localeMap === 'object' && c.localeMap) ? c.localeMap : d.localeMap;
    const cfg: VideoPipelineConfig = {
      scriptSystemTemplate: str(c?.scriptSystemTemplate, d.scriptSystemTemplate),
      termsSystemPrompt: str(c?.termsSystemPrompt, d.termsSystemPrompt),
      templateDataSystemPrompt: str(c?.templateDataSystemPrompt, d.templateDataSystemPrompt),
      localeMap: { ...d.localeMap, ...localeMap },
      stockVideoSize: str(c?.stockVideoSize, d.stockVideoSize),
      minVideoEdge: num(c?.minVideoEdge, d.minVideoEdge),
      minVideoSec: num(c?.minVideoSec, d.minVideoSec),
      minImageEdge: num(c?.minImageEdge, d.minImageEdge),
      perTermCount: num(c?.perTermCount, d.perTermCount),
      maxSearchTerms: num(c?.maxSearchTerms, d.maxSearchTerms),
      postSubmitWaitMs: num(c?.postSubmitWaitMs, d.postSubmitWaitMs),
      loginWaitMs: num(c?.loginWaitMs, d.loginWaitMs),
      threadBgVideos: arr(c?.threadBgVideos, d.threadBgVideos),
      threadBgDouyinTerms: arr(c?.threadBgDouyinTerms, d.threadBgDouyinTerms),
      threadYtdlpUrlWin: str(c?.threadYtdlpUrlWin, d.threadYtdlpUrlWin),
      threadYtdlpUrlMac: str(c?.threadYtdlpUrlMac, d.threadYtdlpUrlMac),
      threadSubredditPresets: arr(c?.threadSubredditPresets, d.threadSubredditPresets),
    };
    cache = { at: Date.now(), cfg };
    return cfg;
  } catch {
    // 拉不到就用默认(并短缓存,避免每步重试拖慢)。
    cache = { at: Date.now(), cfg: DEFAULT_VIDEO_CONFIG };
    return DEFAULT_VIDEO_CONFIG;
  } finally {
    clearTimeout(timer);
  }
}

/** 内容语言 → locale,走配置里的映射,缺则回落 en-US。 */
export function localeFor(cfg: VideoPipelineConfig, lang: string): string {
  return cfg.localeMap[lang] || cfg.localeMap.en || 'en-US';
}

/** 安全占位符替换:只替换已知 key,未知占位符原样保留。 */
export function interpolate(tpl: string, vars: Record<string, string>): string {
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(v);
  }
  return out;
}
