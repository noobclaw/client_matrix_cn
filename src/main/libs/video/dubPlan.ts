/**
 * dubPlan —— 配音时间轴规划(估时 / 合块 / 贴轴)。
 *
 * 结构照搬 KrillinAI 的 `internal/service/dubbing`(planner/estimator/fit),它是目前
 * 开源里把「译文配音贴回原视频时间轴」做得最完整的一套。核心三条:
 *
 *   ① 【合块】相邻字幕间隙小、且其中一条很短 → 并成一个 chunk,**整块一次 TTS**。
 *      逐句合成会让每句都带独立的朗读收尾,拼起来一顿一顿;并且每句各自 atempo
 *      不同倍率,听感忽快忽慢。整块合成让块内语气连贯、共用一个速度因子。
 *   ② 【先估后合成】用统计式估时(中文 4.2 字/秒、英文 13.5 字符/秒 + 标点停顿 +
 *      数字/缩写惩罚)在**花钱之前**判断会不会超窗,超了先叫 LLM 缩写,再去 TTS。
 *      旧做法是「合成→发现超长→提速重配→还超→缩写再重配」,同一句最多 4 次 TTS,
 *      豆包按字符实扣 = 4 倍字符费,而且每次都真扣。
 *   ③ 【贴轴】块实测时长 / 块窗口 = 速度因子,夹在 [1, atempoMax];块内各句按权重
 *      分摊起止时间,得出最终字幕 cue。
 *
 * 本文件是纯计算,不碰 ffmpeg / TTS / 网络,方便单测和复用(电影级也可以接)。
 */

// ── 语速档案 ───────────────────────────────────────────────────────────────
export interface SpeechProfile {
  /** 每秒朗读的非空白字符数 */
  cps: number;
  /** 标点停顿权重 */
  pauseWeight: number;
  /** 数字惩罚权重(数字念得比字母慢) */
  numberWeight: number;
  /** 连续大写(缩写,逐字母念)惩罚权重 */
  acronymWeight: number;
  /**
   * 是否按【字】计长度。中日韩=按字符,其它=按单词。
   * ⚠️ 给 LLM 下长度预算时必须用对单位:英文一句 40 字符 ≈ 7 个词,
   *    把 40 当成「40 个词」发给模型 = 等于没约束,该精简的一句都不会精简。
   */
  cjk: boolean;
  /**
   * 平均每词多少个【可发音字符】(不含空格和标点)。只对非 CJK 有意义 ——
   * 估时按字符算、翻译预算按词下,两边换算全靠这个数。
   */
  charsPerWord: number;
}

const CJK_BASE = { pauseWeight: 0.30, numberWeight: 0.22, acronymWeight: 0.12, cjk: true, charsPerWord: 1 };
const LATIN_BASE = { pauseWeight: 0.24, numberWeight: 0.26, acronymWeight: 0.30, cjk: false, charsPerWord: 5.0 };

/**
 * ⚠️ 语言名和两字母语言码【必须分开匹配】。放在同一个正则里靠数组顺序碰运气会错:
 *    `'Bahasa Indonesia'` 里含 `es` → 命中西班牙语;`'Mandarin'` 含 `ar` → 命中阿拉伯语。
 *    所以 `names` 只放能独立成词的自然语言名,`codes` 走【整串相等或 `xx-YY` 前缀】的精确比对。
 */
const PROFILES: Array<{ names: RegExp; codes: string[]; p: SpeechProfile }> = [
  { names: /繁體|繁体|Traditional\s*Chinese/i, codes: ['zh-tw', 'zh-hk', 'zh-hant'], p: { cps: 4.1, ...CJK_BASE } },
  { names: /简体|中文|汉语|漢語|Chinese/i, codes: ['zh', 'zh-cn', 'zh-hans'], p: { cps: 4.2, ...CJK_BASE } },
  { names: /日本語|日本语|日语|Japanese/i, codes: ['ja', 'jp'], p: { cps: 4.0, ...CJK_BASE } },
  { names: /한국어|韓語|韩语|韩国语|Korean/i, codes: ['ko', 'kr'], p: { cps: 4.3, ...CJK_BASE } },
  { names: /Deutsch|德语|德語|German/i, codes: ['de'], p: { cps: 11.8, ...LATIN_BASE, numberWeight: 0.25, acronymWeight: 0.28 } },
  { names: /Русск|俄语|俄語|Russian/i, codes: ['ru'], p: { cps: 10.8, ...LATIN_BASE, numberWeight: 0.24, acronymWeight: 0.24 } },
  { names: /Türk|土耳其|Turkish/i, codes: ['tr'], p: { cps: 12.0, ...LATIN_BASE, numberWeight: 0.24, acronymWeight: 0.26 } },
  { names: /Español|Espanol|西班牙|Spanish/i, codes: ['es'], p: { cps: 13.2, ...LATIN_BASE } },
  { names: /Português|Portugues|葡萄牙|Portuguese/i, codes: ['pt', 'pt-br'], p: { cps: 13.0, ...LATIN_BASE } },
  { names: /Français|Francais|法语|法語|French/i, codes: ['fr'], p: { cps: 12.8, ...LATIN_BASE } },
  { names: /Italiano|意大利|Italian/i, codes: ['it'], p: { cps: 13.0, ...LATIN_BASE } },
  { names: /Indonesia|印尼|印度尼西亚/i, codes: ['id'], p: { cps: 12.5, ...LATIN_BASE, acronymWeight: 0.28 } },
  { names: /Tiếng\s*Việt|越南|Vietnamese/i, codes: ['vi'], p: { cps: 12.0, ...LATIN_BASE, pauseWeight: 0.26, numberWeight: 0.24, acronymWeight: 0.26 } },
  { names: /ไทย|泰语|泰語|Thai/i, codes: ['th'], p: { cps: 11.0, ...LATIN_BASE, pauseWeight: 0.26, numberWeight: 0.24, acronymWeight: 0.26 } },
  { names: /العربية|阿拉伯|Arabic/i, codes: ['ar'], p: { cps: 12.0, ...LATIN_BASE, pauseWeight: 0.26, numberWeight: 0.24, acronymWeight: 0.26 } },
];

const EN_PROFILE: SpeechProfile = { cps: 13.5, ...LATIN_BASE, acronymWeight: 0.32 };
const ZH_PROFILE: SpeechProfile = { cps: 4.2, ...CJK_BASE };

/**
 * 按目标语言标签(如 '简体中文' / 'English' / 'Bahasa Indonesia' / 'zh-TW')取语速档案。
 * 先按语言名匹配,再按语言码精确匹配;都不中 → 按文本本身是否含 CJK 兜底,再不行按英文。
 */
export function speechProfileFor(langLabel: string, sampleText = ''): SpeechProfile {
  const label = String(langLabel || '').trim();
  for (const { names, p } of PROFILES) if (names.test(label)) return p;
  const code = label.toLowerCase();
  for (const { codes, p } of PROFILES) {
    if (codes.some((c) => code === c || code.startsWith(`${c}-`) || code.startsWith(`${c}_`))) return p;
  }
  if (/[぀-ヿ一-鿿가-힯]/.test(sampleText)) return ZH_PROFILE;
  return EN_PROFILE;
}

/**
 * 文本的「长度单位」数:中日韩按非空白字符,其它按单词。
 * 给 LLM 下长度预算、判断是否短到不值得精简,都必须用这个,不能直接用 String.length。
 */
export function textUnits(text: string, p: SpeechProfile): number {
  const t = String(text || '').trim();
  if (!t) return 0;
  // CJK 按可发音字符(和估时器同口径,标点不算);其它按词。
  return p.cjk ? pronounceableCount(t) : (t.split(/\s+/).filter(Boolean).length || 1);
}

function nonSpaceCount(text: string): number {
  let n = 0;
  for (const ch of text) if (!/\s/.test(ch)) n++;
  return n;
}

/**
 * 【可发音字符】数:不含空白,**也不含标点**。
 *
 * ⚠️ 这是估时准不准的关键。原来 base 用 nonSpaceCount(把标点也当成要念的字),
 *   下面又额外加一次 punctuationPause —— **标点被算了两遍**。实测:15 字 + 逗号 + 句号
 *   被算成 17 个字 = 4.05s,再加 0.15s 停顿 = 4.20s;而实际只有 15 个字要发音,
 *   真值 3.72s。虚高 13%,直接把「翻译刚好用满预算」的句子全判成超窗 ——
 *   真机上一条片 11 句被误判、白烧一次 LLM 精简,译文还被砍。
 *   (KrillinAI 的 nonSpaceRuneCount 同样把标点算进 base,它这块也是错的。)
 *
 * 标点用 \p{P} 判(不含 \p{S}:$ % # 这类符号是要念出来的,占时间)。
 */
function pronounceableCount(text: string): number {
  let n = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    if (/\p{P}/u.test(ch)) continue;
    n++;
  }
  return n;
}

function punctuationPause(text: string, p: SpeechProfile): number {
  let s = 0;
  for (const ch of text) {
    if (',，、;；:：'.includes(ch)) s += 0.22 * p.pauseWeight;
    else if ('.。!！?？'.includes(ch)) s += 0.28 * p.pauseWeight;
    else if ('…—～'.includes(ch)) s += 0.34 * p.pauseWeight;
  }
  return s;
}

function numberPenalty(text: string, p: SpeechProfile): number {
  const n = (text.match(/\d/g) || []).length;
  return n * 0.12 * p.numberWeight;
}

function acronymPenalty(text: string, p: SpeechProfile): number {
  let penalty = 0;
  let run = 0;
  const flush = () => { if (run >= 2) penalty += run * 0.18 * p.acronymWeight; run = 0; };
  for (const ch of text) {
    if (/[A-ZА-Я]/.test(ch)) { run++; continue; }
    flush();
  }
  flush();
  return penalty;
}

/**
 * 估算一段文本的自然朗读秒数。**在花 TTS 的钱之前**判断会不会超窗就靠它。
 * 误差 ±15% 属正常 —— 后面还有 atempo 压缩 + 顺延兜底,不需要精确。
 */
export function estimateSpeechSeconds(text: string, p: SpeechProfile): number {
  // base 只数【可发音字符】—— 标点不发音,它的耗时由 punctuationPause 单独计。
  const runes = pronounceableCount(text);
  if (runes === 0) return 0;
  const base = runes / Math.max(0.5, p.cps);
  return base + punctuationPause(text, p) + numberPenalty(text, p) + acronymPenalty(text, p);
}

/**
 * 翻译时给每句的【长度预算】(CJK=字/秒,其它=词/秒)。
 *
 * ⚠️ 必须从估时器推导,不能另设一个数。原来翻译按 5 字/秒 产出、估时器按 4.2 字/秒 判断,
 *   两套数各调各的、没人保证一致 —— 结果就是「译文老老实实用满预算 = 必被判超窗」。
 *   现在:预算 = cps × atempo 上限 × 安全系数。atempo 那 25% 就是留给译文的余量,
 *   安全系数再留一点给标点停顿。
 */
export function budgetPerSecond(p: SpeechProfile, atempoMax: number, safety = 0.95): number {
  const perSecChars = Math.max(0.5, p.cps) * Math.max(1, atempoMax) * safety;
  return p.cjk ? perSecChars : perSecChars / Math.max(1, p.charsPerWord);
}

/** 语速百分比(-50..50)对时长的缩放:+25% 语速 → 时长 ×0.8。 */
export function rateScale(ratePercent: number): number {
  const r = Math.max(-50, Math.min(50, ratePercent || 0));
  return 100 / (100 + r);
}

// ── 合块 ───────────────────────────────────────────────────────────────────
export interface DubCue {
  /** 在原 segs 里的下标,用来回写译文 */
  index: number;
  start: number;
  end: number;
  text: string;
}

export interface DubChunk {
  id: number;
  /** cues 数组的下标(不是 cue.index) */
  items: number[];
  start: number;
  end: number;
}

export interface ChunkConfig {
  /** 短于这个秒数的句子才允许被并块(长句本来就撑得住,单独合成更好锚) */
  minDur: number;
  /** 相邻句间隙超过这个秒数就不并(那是真停顿,并了会把停顿吃掉) */
  gapTolerance: number;
  /** 一块最多几句 */
  maxSize: number;
}

export const DEFAULT_CHUNK_CONFIG: ChunkConfig = { minDur: 2.5, gapTolerance: 1.2, maxSize: 4 };

/**
 * 把相邻的短句并成块。判据(同 KrillinAI):
 *   间隙 ≤ gapTolerance **且**(前一句 < minDur **或** 本句 < minDur)→ 并入当前块;
 *   块内条数达 maxSize 强制断开。
 *
 * 并块的代价是块内各句失去独立硬锚点(改成按权重分摊)。所以只并「挨得近的短句」——
 * 它们本来就在同一口气里,分摊误差远小于逐句合成带来的顿挫。
 */
export function makeChunks(cues: DubCue[], cfg: ChunkConfig = DEFAULT_CHUNK_CONFIG): DubChunk[] {
  if (cues.length === 0) return [];
  const chunks: DubChunk[] = [];
  let cur: DubChunk = { id: 1, items: [0], start: cues[0].start, end: cues[0].end };

  for (let i = 1; i < cues.length; i++) {
    const prev = cues[i - 1];
    const cue = cues[i];
    const gap = cue.start - prev.end;
    const prevDur = prev.end - prev.start;
    const curDur = cue.end - cue.start;
    const mergeable = gap <= cfg.gapTolerance && (prevDur < cfg.minDur || curDur < cfg.minDur);
    if (!mergeable || cur.items.length >= cfg.maxSize) {
      chunks.push(cur);
      cur = { id: chunks.length + 1, items: [i], start: cue.start, end: cue.end };
      continue;
    }
    cur.items.push(i);
    cur.end = cue.end;
  }
  chunks.push(cur);
  return chunks;
}

/** 块内文本拼成一次 TTS 的输入(拉丁系要空格;句末已有标点时 TTS 自带停顿)。 */
export function chunkText(cues: DubCue[], chunk: DubChunk): string {
  return chunk.items.map((i) => cues[i].text.trim()).filter(Boolean).join(' ');
}

// ── 贴轴 ───────────────────────────────────────────────────────────────────
export interface FittedCue {
  index: number;
  start: number;
  end: number;
  text: string;
}

/**
 * 把一块的实测音频时长摊回块内各句,得出最终字幕时间。
 * 权重优先用各句估时,退回字数,再退回均分。
 */
export function distributeChunk(
  cues: DubCue[], chunk: DubChunk, placeStart: number, effectiveDur: number, p: SpeechProfile,
): FittedCue[] {
  const idxs = chunk.items;
  if (idxs.length === 0) return [];
  const weights = idxs.map((i) => {
    const est = estimateSpeechSeconds(cues[i].text, p);
    return est > 0 ? est : Math.max(1, nonSpaceCount(cues[i].text));
  });
  const sum = weights.reduce((a, b) => a + b, 0);
  const out: FittedCue[] = [];
  let cursor = placeStart;
  for (let k = 0; k < idxs.length; k++) {
    const dur = sum > 0 ? (effectiveDur * weights[k]) / sum : effectiveDur / idxs.length;
    const c = cues[idxs[k]];
    out.push({ index: c.index, text: c.text, start: cursor, end: cursor + dur });
    cursor += dur;
  }
  return out;
}
