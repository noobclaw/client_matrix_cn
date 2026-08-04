/**
 * storyboardScript — 「电影级」分镜表(Storyboard IR)的解析与生成。
 *
 * ## 为什么有这个文件
 * 老链路把用户脚本当【一坨字】:`splitScript(整篇文档)` 按标点切句 → 每句既当口播念、
 * 又当画面 prompt 喂 Seedance。用户脚本里的表头(「视频时长 4-5分钟」「目标受众」)、
 * 景别运镜、B-roll 清单、拍摄准备,统统被当台词念出来;而用户真正写好的【画面内容】
 * 那一栏反被丢弃 —— 成片必然驴唇不对马嘴。
 *
 * 本文件把「一坨字」变成结构化分镜表:
 *   · narration     只有这部分进 TTS(逐字,不许改写)
 *   · visualFirst   只有这部分进图像模型(首帧)
 *   · motion        只有这部分进视频模型(运动)
 *   · onScreenText  花字 / bgmMood 配乐 / sfx 音效
 *   · type          决定这镜用哪个引擎(图表走 HTML、实景走素材、人物走生成)
 * 制作说明类文字【全部丢弃】,不进任何环节。
 *
 * ## 两个入口
 *   · parseStoryboardScript()  —— 用户已有分镜脚本(任意格式)→ 解析,写了的字段一律锁定
 *   · deriveStoryboard()       —— 用户只有口播稿(AI 写的或用户手写)→ 派生分镜
 *
 * ## 逐字保真
 * LLM 复述长文本有改写风险,而口播稿【必须逐字】(营销文案/热点事实不能被改)。所以:
 *   1. prompt 硬约束「narration 必须从原文逐字复制」
 *   2. 本地 verifyNarrationFidelity() 复核 —— 拼起来的 narration 与原文差异过大就告警,
 *      调用方可据此降级回老链路(绝不静默出一条被 AI 改写过的片子)。
 *
 * ## 长脚本分块
 * callDeepSeek 的 max_tokens 是 4000,5 分钟脚本(~1400 字口播 + 画面描述)一次输出会被截断。
 * 超过 CHUNK_CHARS 的原文按段落边界切块,逐块解析后合并 —— 分镜序号在合并时重排。
 *
 * 任何失败都返回 null(不抛),调用方降级回老链路,绝不阻塞出片。
 */

import { callDeepSeek } from './scriptWriter';
import type { ContentLang } from './scriptWriter';

/** 一镜用哪种素材/引擎。决定成本与渲染路径。 */
export type ShotType =
  | 'chart'      // 图表/数据/K线 —— 适合 HTML 渲染,AI 出图易糊
  | 'textcard'   // 文字卡/封面/标题板 —— 需要图内文字准确
  | 'scene'      // 实景空镜(街景/建筑/室内)—— 素材库或 AI 生成
  | 'person'     // 有人物出镜/表演
  | 'logo'       // 品牌标识/产品图
  | 'transition';// 转场/呼吸镜

export const SHOT_TYPES: ShotType[] = ['chart', 'textcard', 'scene', 'person', 'logo', 'transition'];

/** type → 是否允许(需要)画面里出现文字。图表/文字卡/Logo 必须允许,否则出来是空白板。 */
export function shotAllowsText(t: ShotType): boolean {
  return t === 'chart' || t === 'textcard' || t === 'logo';
}

export interface StoryShot {
  /**
   * 这一镜的标题 = 它在叙事里干什么(如「黄金3秒钩子 · 砸出悬念」「反转 · 秃鹫基金白嫖」)。
   * 用户自己写的分镜脚本通常就带这个,没有则由 AI 起一个 —— 分镜稿没有标题会退化成
   * 一堆看不出结构的段落,人读起来抓不住这一镜为什么存在。
   */
  title?: string;
  /** 这一镜的时长(秒)。有旁白时最终以真实配音时长为准,这里是脚本标注/估算值。 */
  seconds: number;
  /** 口播原文。【逐字】,拼起来 = 全片文案。空串 = 无旁白镜(纯画面)。 */
  narration: string;
  /** 首帧画面描述 —— 只写画面(主体/环境/光线/构图),不写运镜、不写视频专属否定项。 */
  visualFirst: string;
  /** 尾帧画面描述。空 = 静态镜(不走首尾帧模式)。 */
  visualLast?: string;
  /** 运动描述 —— 只写运镜 + 主体动作,不复述画面内容(首帧图已经承载了)。 */
  motion?: string;
  /** 花字(打在屏幕上的大字)。 */
  onScreenText?: string;
  /** 配乐情绪。对齐 BGM 曲库的中文分类词(轻快/紧张/悬疑/大气/舒缓/欢快/开场/动感…)。 */
  bgmMood?: string;
  /** 音效提示。 */
  sfx?: string;
  /** 素材类型 → 决定引擎与价格。 */
  type: ShotType;
  /** 是否生成视频(true=走 Seedance,false=图 + 运镜)。默认 false,由用户在分镜表勾选。 */
  animate: boolean;
  /** 用户脚本里【明确写了】的字段名。这些字段 AI 不许覆盖,重新生成时也保留。 */
  locked: string[];
}

export interface StoryboardResult {
  shots: StoryShot[];
  /** 本步 AI 消耗(积分口径,累加进 tracker)。 */
  tokens: number;
  /** 本步服务端权威 USD 成本。 */
  costUsd: number;
  /** 逐字保真复核:narration 拼接与原文的相似度 0~1。派生模式恒为 1(原文即输入)。 */
  fidelity: number;
  /** 解析过程中的告警(给进度日志用,不阻塞)。 */
  warnings: string[];
}

/**
 * 单次给 LLM 的输出上限。分镜 JSON 很占字数(每镜十来个字段),原来沿用 callDeepSeek 的
 * 默认 4000 会把 JSON 截在半截 → JSON.parse 失败 → parse_failed。DeepSeek 单次可出 384k,
 * 这里给 16k 足够一块(见 CHUNK_CHARS)出满 MAX_SHOTS_PER_CHUNK 镜。
 */
const PARSE_MAX_TOKENS = 16000;
/** 超过这个字符数的原文按段落切块,分批解析。上限放开后可以切得更粗 —— 块越少
 *  LLM 越能看到上下文,分镜的连贯性也越好。 */
const CHUNK_CHARS = 7000;
/** 单块最多解析出多少镜(防 LLM 把一句话拆成几十镜)。 */
const MAX_SHOTS_PER_CHUNK = 24;
/** 整片分镜上限(与老链路 40 镜上限对齐)。 */
const MAX_SHOTS_TOTAL = 60;

// ────────────────────────────────────────────────────────────────────────────
// JSON 解析(与 storyboardAnchor / templateHtmlWriter 同款宽松解析:reasoner 不支持
// response_format=json_object,输出可能带 markdown 围栏或前后说明文字)
// ────────────────────────────────────────────────────────────────────────────

function extractJsonBlock(raw: string): string {
  let t = (raw || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) t = fence[1].trim();
  // 找第一个 { 或 [,按括号配对截出完整块(容忍尾部多余文字)
  const startObj = t.indexOf('{');
  const startArr = t.indexOf('[');
  const start = startArr >= 0 && (startObj < 0 || startArr < startObj) ? startArr : startObj;
  if (start < 0) return t;
  const open = t[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return t.slice(start, i + 1); }
  }
  return t.slice(start);
}

/**
 * 抢救被截断的分镜 JSON。
 *
 * 为什么需要:输出被 max_tokens 截断时,JSON 停在半个字符串/半个对象上,整块 parse 失败 →
 *   用户看到「AI 返回的不是可解析的分镜 JSON」,前面的十几镜全白跑。截断只影响**最后一镜**,
 *   把它丢掉、把括号补齐就能拿回其余全部。(根因已在后端修:max_tokens 上限 8192→32768;
 *   这里是防线二 —— 脚本再长一点又会撞上,不能只靠上限。)
 *
 * 做法:从尾部往前找最后一个「完整对象的结束 `}`」(即栈深回到数组层的位置),截到那里
 *   再补上 `]` / `}`。找不到就返回 null。
 */
function salvageTruncatedShots(block: string): any[] | null {
  const arrStart = block.indexOf('[');
  if (arrStart < 0) return null;
  let depth = 0, inStr = false, esc = false, lastGood = -1;
  for (let i = arrStart; i < block.length; i++) {
    const c = block[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      // depth 回到 1 = 刚闭合了数组里的一个元素对象 → 这里是安全的截断点
      if (depth === 1 && c === '}') lastGood = i;
    }
  }
  if (lastGood < 0) return null;
  try {
    const arr = JSON.parse(block.slice(arrStart, lastGood + 1) + ']');
    return Array.isArray(arr) && arr.length > 0 ? arr : null;
  } catch { return null; }
}

function parseShotsJson(raw: string): any[] | null {
  const block = extractJsonBlock(raw);
  try {
    const parsed = JSON.parse(block);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.shots)) return parsed.shots;
    return null;
  } catch {
    return salvageTruncatedShots(block);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 字段清洗
// ────────────────────────────────────────────────────────────────────────────

function str(v: unknown, max = 400): string {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, max);
}

function normalizeType(v: unknown): ShotType {
  const t = String(v || '').trim().toLowerCase();
  if ((SHOT_TYPES as string[]).includes(t)) return t as ShotType;
  // 容错:LLM 可能回中文或近义词
  if (/chart|图表|数据|k线|折线|柱状/.test(t)) return 'chart';
  if (/text|文字|字卡|封面|标题/.test(t)) return 'textcard';
  if (/logo|标识|品牌|产品/.test(t)) return 'logo';
  if (/person|人物|主讲|出镜|角色/.test(t)) return 'person';
  if (/transition|转场|过渡/.test(t)) return 'transition';
  return 'scene';
}

/** 把 LLM 回的一条原始记录规整成 StoryShot;缺 visualFirst 或全空 → 返回 null(丢弃该镜)。 */
function cleanShot(raw: any, fallbackSeconds: number): StoryShot | null {
  if (!raw || typeof raw !== 'object') return null;
  const narration = str(raw.narration, 1000);
  const visualFirst = str(raw.visual_first ?? raw.visualFirst ?? raw.visual, 400);
  // 口播和画面都没有 → 空镜,丢弃
  if (!narration && !visualFirst) return null;

  const type = normalizeType(raw.type);
  const secondsRaw = Number(raw.seconds);
  const seconds = Number.isFinite(secondsRaw) && secondsRaw > 0
    ? Math.min(120, Math.max(1, secondsRaw))
    : fallbackSeconds;

  const lockedRaw = Array.isArray(raw.locked) ? raw.locked : [];
  const locked = lockedRaw
    .map((s: unknown) => String(s || '').trim())
    .filter(Boolean)
    .slice(0, 12);

  return {
    title: str(raw.title, 40) || undefined,
    seconds,
    narration,
    visualFirst,
    visualLast: str(raw.visual_last ?? raw.visualLast, 400) || undefined,
    motion: str(raw.motion, 300) || undefined,
    onScreenText: str(raw.on_screen_text ?? raw.onScreenText, 120) || undefined,
    bgmMood: str(raw.bgm_mood ?? raw.bgmMood, 40) || undefined,
    sfx: str(raw.sfx, 120) || undefined,
    type,
    // 默认【每一镜都生成视频】—— 这张卡就叫「电影级 · 纯 AI 生成」,出 AI 视频是它的
    //   全部意义,默认成静图等于把功能废掉。
    //   之前的问题不是「不该生成视频」,是「AI 替用户勾、他没点头就花钱」——
    //   那个由分镜表这道确认关口解决(费用摆在按钮旁边,不想花的镜自己取消勾选),
    //   不该靠把默认值改成 false 来回避。
    //   LLM 显式标了 false(静态展示的镜)才尊重它。
    animate: raw.animate !== false,
    locked,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 逐字保真复核
// ────────────────────────────────────────────────────────────────────────────

/** 去掉标点/空白,只留可比对的字符流(中英数字)。 */
function charStream(s: string): string {
  return (s || '').replace(/[\s\p{P}\p{S}]/gu, '');
}

/**
 * 复核解析出的 narration 是否忠于原文。
 * 口径:把所有 narration 拼成字符流,看它有多少比例能在原文字符流里【按序】找到。
 * 1.0 = 完全逐字(允许只取原文的一部分,因为制作说明被丢弃了);
 * 明显低于 1 = LLM 改写了 → 调用方应告警或降级。
 */
export function verifyNarrationFidelity(shots: StoryShot[], sourceText: string): number {
  const got = charStream(shots.map((s) => s.narration).join(''));
  if (!got) return 1; // 无旁白镜(纯画面片)不参与判定
  const src = charStream(sourceText);
  if (!src) return 0;
  let si = 0, matched = 0;
  for (let i = 0; i < got.length; i++) {
    const idx = src.indexOf(got[i], si);
    if (idx >= 0) { matched++; si = idx + 1; }
  }
  return matched / got.length;
}

// ────────────────────────────────────────────────────────────────────────────
// Prompt
// ────────────────────────────────────────────────────────────────────────────

const SHOT_SCHEMA_BLOCK = [
  '每个分镜对象的字段(json):',
  '{',
  '  "title": string,            // 这镜的标题:它在叙事里干什么。如「黄金3秒钩子 · 砸出悬念」「反转 · 秃鹫基金白嫖」。原脚本有场景标题就用原文,没有你起一个(≤14 字)',
  '  "seconds": number,          // 这镜时长(秒)。脚本标了就用标的;没标按口播字数估(中文 4.5 字/秒,英文 2.2)',
  '  "narration": string,        // 要念出来的口播。⚠️必须从原文【逐字复制】,一个字都不许改写/润色/补充。这镜没有旁白就填 ""',
  '  "visual_first": string,     // 首帧画面描述:主体 + 环境 + 光线 + 构图。只写【看得见的东西】',
  '  "visual_last": string,      // 尾帧画面(镜头结束时的样子)。画面基本不变就填 ""',
  '  "motion": string,           // 运动:运镜(推/拉/摇/移/跟/固定)+ 主体动作。不要复述 visual_first 里已有的内容',
  '  "on_screen_text": string,   // 打在屏幕上的花字/大字。没有填 ""',
  '  "bgm_mood": string,         // 配乐情绪,只从这些里选:轻快/节拍/大气/舒缓/轻柔/悠闲/紧张/悬疑/欢快/开场/动感/新闻',
  '  "sfx": string,              // 音效提示。没有填 ""',
  '  "type": string,             // 只能是:chart(图表数据) | textcard(文字卡封面) | scene(实景空镜) | person(人物出镜) | logo(品牌标识) | transition(转场)',
  '  "animate": boolean,         // 默认 true。只有【纯静态展示、动起来反而奇怪】的镜(如纯文字卡)才填 false',
  '  "locked": string[]          // 原脚本里【明确写了】的字段名,如 ["narration","visual_first","on_screen_text"]。你自己推断补充的字段不要列进来',
  '}',
].join('\n');

const VISUAL_RULES = [
  '## visual_first / visual_last 的写法(这是画面质量的关键)',
  '- 只写【画面里看得见的东西】:主体是什么、在画面什么位置、朝向、环境细节、光源方向与色温、景别。',
  '- 禁止出现:运镜词(推近/拉远/摇/跟)、视频专属否定(避免抖动/时间闪烁)、"电影感/高级感"这类空洞形容词。',
  '- 具体优先:不要写"一个办公室",要写"深色木质办公桌前,百叶窗漏进冷白光,桌上一杯凉透的咖啡"。',
  '- 如果原脚本已经写了画面内容(B-roll/画面/景别栏),【原样采用并补足细节】,不要另起炉灶换个画面。',
  '- 抽象口播(比喻/道理/金句)要转成【可拍的具体画面】。例:"研报是给客户的情书" → "米色信纸特写,钢笔正在书写,旁边散落几张打印的财报"。',
].join('\n');

const PARSE_SYSTEM = [
  '# Role',
  '你是分镜脚本解析器。把用户提供的【任意格式】视频脚本,拆解成结构化分镜数组(json)。',
  '',
  '# 最重要的一条:分拣',
  '用户脚本里通常混着三类文字,你必须分开:',
  '  A. 要念出来的口播/旁白 → 进 narration(逐字复制)',
  '  B. 描述画面的(景别、运镜、画面内容、B-roll)→ 进 visual_first / visual_last / motion',
  '  C. 制作说明(视频时长、目标受众、发布平台、总场景数、口播字数、拍摄准备清单、服装妆面、',
  '     布光机位、后期制作要点、话题标签、整体风格定位、素材清单汇总)→ 【全部丢弃】,一个字都不要进任何字段',
  '',
  '⚠️ C 类被当成口播念出来是最严重的错误。宁可漏,也绝不把制作说明写进 narration。',
  '',
  '# 输出',
  '只输出一个 json 对象:{"shots": [ ...分镜对象... ]}。不要 markdown 围栏,不要解释文字。',
  '',
  SHOT_SCHEMA_BLOCK,
  '',
  VISUAL_RULES,
  '',
  '# 其它规则',
  '- 分镜顺序严格按脚本原顺序,不许重排、不许合并跨场景的内容。',
  '- 脚本里一个"场景"如果口播很长(>15秒),按语义切成多个分镜,每镜 4~12 秒 —— 但 narration 仍是原文逐字切分,不是重写。',
  '- 所有输出值使用与脚本相同的语言。',
  '- locked 只列脚本里真的写了的字段,这决定后续 AI 不会覆盖用户的原始意图。',
].join('\n');

const DERIVE_SYSTEM = [
  '# Role',
  '你是分镜师。用户给你一段【口播稿】,你为它设计分镜(json 数组)。',
  '',
  '# 硬约束',
  '- narration 必须是口播稿的【逐字切分】:把原文按语义切成若干段,拼起来必须还原成原文。',
  '  绝对不许改写、润色、增删任何字。',
  '- 每镜 4~12 秒(按中文 4.5 字/秒、英文 2.2 字/秒估算 narration 字数来定 seconds)。',
  '- 画面要跟着这一段口播的【内容】走,不是泛泛的空镜。',
  '',
  '# 输出',
  '只输出一个 json 对象:{"shots": [ ...分镜对象... ]}。不要 markdown 围栏,不要解释文字。',
  '',
  SHOT_SCHEMA_BLOCK,
  '',
  VISUAL_RULES,
  '',
  '# 叙事节奏',
  '- 第 1 镜是钩子:画面要有冲击力(特写/强对比/关键数字花字),时长控制在 8 秒内。',
  '- 关键数字、金句、反转处 → 填 on_screen_text 做花字。',
  '- bgm_mood 随叙事推进变化,不要全片一个情绪。',
  '- locked 一律填 ["narration"](口播来自原稿),其余字段是你设计的,不要列进 locked。',
].join('\n');

// ────────────────────────────────────────────────────────────────────────────
// 分块
// ────────────────────────────────────────────────────────────────────────────

/** 按段落边界把长文本切成 ≤CHUNK_CHARS 的块(尽量不切断段落)。 */
function chunkText(text: string): string[] {
  const t = (text || '').trim();
  if (t.length <= CHUNK_CHARS) return t ? [t] : [];
  const paras = t.split(/\n{2,}|\r\n\r\n/).filter((p) => p.trim());
  const chunks: string[] = [];
  let buf = '';
  for (const p of paras) {
    if (buf && (buf.length + p.length + 2) > CHUNK_CHARS) { chunks.push(buf); buf = p; }
    else buf = buf ? `${buf}\n\n${p}` : p;
    // 单段就超长 → 按行硬切
    while (buf.length > CHUNK_CHARS) {
      const lines = buf.split('\n');
      let head = '';
      while (lines.length && (head.length + lines[0].length + 1) <= CHUNK_CHARS) {
        head += (head ? '\n' : '') + lines.shift();
      }
      if (!head) { head = buf.slice(0, CHUNK_CHARS); buf = buf.slice(CHUNK_CHARS); }
      else buf = lines.join('\n');
      chunks.push(head);
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

// ────────────────────────────────────────────────────────────────────────────
// 对外接口
// ────────────────────────────────────────────────────────────────────────────

export interface StoryboardInput {
  /** 内容语言(影响 fallback 的字/秒估算)。 */
  lang: ContentLang;
  /** 全片目标时长(秒),仅作 LLM 的节奏参考;脚本自带时长时以脚本为准。 */
  targetSeconds?: number;
  /** 可选:赛道/人设,只作画面风格参考,不决定题材。 */
  styleHint?: string;
  /** 中断信号(用户点停止)。 */
  signal?: AbortSignal;
}

function charsPerSecond(lang: ContentLang): number {
  return /^(zh|ja|ko)/.test(String(lang)) ? 4.5 : 2.2;
}

/** 跑一次 LLM 解析,返回清洗后的分镜 + 消耗。失败返回 null。 */
async function runOne(
  system: string,
  user: string,
  fallbackSeconds: number,
  signal?: AbortSignal,
): Promise<{ shots: StoryShot[]; tokens: number; costUsd: number; error?: string } | null> {
  if (signal?.aborted) return null;
  let res;
  try {
    // ⚠️ 这里【不能用 reasoner】:它是思考模型,callDeepSeek 的 max_tokens 写死 4000,
    //    思考过程先把额度吃掉,真正的 JSON 输出被截断 → JSON.parse 失败 → parse_failed。
    //    而且解析是【结构化抽取】不是创作,chat(flash)完全够用、更快更便宜,还能开
    //    response_format=json_object 强制合法 JSON(仅 chat 支持,reasoner 带上会被拒)。
    res = await callDeepSeek(system, user, true, 180_000, 'noobclawai-chat', undefined, PARSE_MAX_TOKENS);
  } catch (e) {
    return { shots: [], tokens: 0, costUsd: 0, error: `AI 调用失败:${String((e as Error)?.message || e).slice(0, 160)}` };
  }
  const arr = parseShotsJson(res.content);
  if (!arr || arr.length === 0) {
    const head = (res.content || '').trim().slice(0, 120).replace(/\s+/g, ' ');
    return {
      shots: [], tokens: res.tokens, costUsd: res.costUsd,
      error: head ? `AI 返回的不是可解析的分镜 JSON(开头:${head})` : 'AI 返回为空',
    };
  }
  const shots = arr
    .slice(0, MAX_SHOTS_PER_CHUNK)
    .map((r) => cleanShot(r, fallbackSeconds))
    .filter((s): s is StoryShot => s !== null);
  if (shots.length === 0) {
    return { shots: [], tokens: res.tokens, costUsd: res.costUsd, error: `解析出 ${arr.length} 条但没有一条含口播或画面` };
  }
  return { shots, tokens: res.tokens, costUsd: res.costUsd };
}

/**
 * 解析用户已有的分镜脚本(任意格式)。
 * 制作说明类文字全部丢弃;脚本里写了的字段进 locked,后续不被 AI 覆盖。
 * 失败返回 null → 调用方降级回老链路。
 */
export async function parseStoryboardScript(
  rawScript: string,
  input: StoryboardInput,
): Promise<StoryboardResult | null> {
  const src = (rawScript || '').trim();
  if (!src) return null;

  const cps = charsPerSecond(input.lang);
  const chunks = chunkText(src);
  if (chunks.length === 0) return null;

  const all: StoryShot[] = [];
  let tokens = 0, costUsd = 0;
  const warnings: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    if (input.signal?.aborted) return null;
    const userParts = [
      chunks.length > 1 ? `(这是脚本的第 ${i + 1}/${chunks.length} 部分,只解析本部分,不要臆测其它部分的内容)` : '',
      input.styleHint ? `画面风格参考(只影响视觉调性,不决定题材):${input.styleHint}` : '',
      '',
      '=== 脚本原文开始 ===',
      chunks[i],
      '=== 脚本原文结束 ===',
      '',
      '输出 {"shots":[...]} 这个 json 对象。记住:制作说明类文字一律丢弃,narration 必须逐字复制原文。',
    ].filter(Boolean).join('\n');

    // fallbackSeconds:LLM 没给 seconds 时的兜底。下面还会按 narration 字数复算,这里给个
    //   中庸值即可(Seedance 单镜合理区间 4~12s)。
    const r = await runOne(PARSE_SYSTEM, userParts, 6, input.signal);
    if (!r || r.shots.length === 0) {
      if (r) { tokens += r.tokens; costUsd += r.costUsd; }
      warnings.push(`第 ${i + 1}/${chunks.length} 段解析失败${r?.error ? `:${r.error}` : ''}`);
      continue;
    }
    tokens += r.tokens;
    costUsd += r.costUsd;
    all.push(...r.shots);
    if (all.length >= MAX_SHOTS_TOTAL) {
      warnings.push(`分镜数达上限 ${MAX_SHOTS_TOTAL},后续内容已截断`);
      break;
    }
  }

  if (all.length === 0) {
    // 一条都没解析出来:把【为什么】带回去,别让 UI 只剩一句 parse_failed。
    return { shots: [], tokens, costUsd, fidelity: 0, warnings };
  }

  // seconds 兜底:LLM 没给或给得离谱时,按 narration 字数重算。
  for (const s of all) {
    if (!s.narration) continue;
    const est = Math.max(1, Math.round(s.narration.length / cps));
    // 差 3 倍以上认为 LLM 标错了,以字数为准(配音时长最终还会覆盖它)
    if (s.seconds > est * 3 || s.seconds * 3 < est) s.seconds = est;
  }

  const shots = all.slice(0, MAX_SHOTS_TOTAL);
  const fidelity = verifyNarrationFidelity(shots, src);
  if (fidelity < 0.9) {
    warnings.push(`口播逐字复核 ${(fidelity * 100).toFixed(0)}%(AI 可能改写了原文)`);
  }
  return { shots, tokens, costUsd, fidelity, warnings };
}

/**
 * 从口播稿派生分镜(用户没给分镜脚本时走这条)。
 * narration 是原稿的逐字切分,画面由 AI 设计。
 */
export async function deriveStoryboard(
  narrationScript: string,
  input: StoryboardInput,
): Promise<StoryboardResult | null> {
  const src = (narrationScript || '').trim();
  if (!src) return null;

  const cps = charsPerSecond(input.lang);
  const chunks = chunkText(src);
  if (chunks.length === 0) return null;

  const all: StoryShot[] = [];
  let tokens = 0, costUsd = 0;
  const warnings: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    if (input.signal?.aborted) return null;
    const userParts = [
      chunks.length > 1 ? `(这是口播稿的第 ${i + 1}/${chunks.length} 部分。${i > 0 ? '第 1 镜的钩子规则只适用于第 1 部分,本部分照常设计即可。' : ''})` : '',
      input.styleHint ? `画面风格参考(只影响视觉调性,不决定题材):${input.styleHint}` : '',
      input.targetSeconds ? `全片目标时长约 ${input.targetSeconds} 秒。` : '',
      '',
      '=== 口播稿开始 ===',
      chunks[i],
      '=== 口播稿结束 ===',
      '',
      '输出 {"shots":[...]} 这个 json 对象。narration 必须是上面原文的逐字切分,拼起来能还原原文。',
    ].filter(Boolean).join('\n');

    const r = await runOne(DERIVE_SYSTEM, userParts, 6, input.signal);
    if (!r || r.shots.length === 0) {
      if (r) { tokens += r.tokens; costUsd += r.costUsd; }
      warnings.push(`第 ${i + 1}/${chunks.length} 段分镜失败${r?.error ? `:${r.error}` : ''}`);
      continue;
    }
    tokens += r.tokens;
    costUsd += r.costUsd;
    all.push(...r.shots);
    if (all.length >= MAX_SHOTS_TOTAL) {
      warnings.push(`分镜数达上限 ${MAX_SHOTS_TOTAL},后续内容已截断`);
      break;
    }
  }

  if (all.length === 0) {
    return { shots: [], tokens, costUsd, fidelity: 0, warnings };
  }

  for (const s of all) {
    if (!s.narration) continue;
    const est = Math.max(1, Math.round(s.narration.length / cps));
    if (s.seconds > est * 3 || s.seconds * 3 < est) s.seconds = est;
  }

  const shots = all.slice(0, MAX_SHOTS_TOTAL);
  const fidelity = verifyNarrationFidelity(shots, src);
  if (fidelity < 0.9) {
    warnings.push(`口播逐字复核 ${(fidelity * 100).toFixed(0)}%(AI 可能改写了原稿)`);
  }
  return { shots, tokens, costUsd, fidelity, warnings };
}

/**
 * 分镜表 → 留档文本(写进成片目录的「分镜表.txt」,供用户核对/二改)。
 */
export function storyboardToText(shots: StoryShot[], title?: string): string {
  const lines: string[] = [];
  if (title) lines.push(`# ${title}`);
  lines.push(`分镜 ${shots.length} 镜 · 预计 ${Math.round(shots.reduce((a, s) => a + s.seconds, 0))} 秒`);
  lines.push('');
  shots.forEach((s, i) => {
    lines.push(`── 镜 ${i + 1}${s.title ? ` · ${s.title}` : ''} · ${s.seconds}s · ${s.type} ──`);
    if (s.narration) lines.push(`口播: ${s.narration}`);
    lines.push(`首帧: ${s.visualFirst}`);
    if (s.visualLast) lines.push(`尾帧: ${s.visualLast}`);
    if (s.motion) lines.push(`运动: ${s.motion}`);
    if (s.onScreenText) lines.push(`花字: ${s.onScreenText}`);
    if (s.bgmMood) lines.push(`配乐: ${s.bgmMood}`);
    if (s.sfx) lines.push(`音效: ${s.sfx}`);
    lines.push('');
  });
  return lines.join('\n');
}
