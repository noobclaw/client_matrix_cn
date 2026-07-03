/**
 * sceneComposer — 「AI 自由排版」的【槽位化】安全引擎(P2,抄 HyperFrames「结构化输入 +
 * 固定安全版式」的精髓,但不照抄代码)。
 *
 * 老 freeform 的病根:让 AI 直接写整页 HTML/CSS —— 它算不准像素,常溢出/叠字/塌。
 * 这里换个契约:AI 只输出【场景 JSON = 一串语义 block】(heroTitle / bullets / ranks /
 * stats / bigStat / quote / tags / steps / paragraph),我们用【确定性安全原语】把 block
 * 铺进画布 —— 每个 block 一条【互不重叠的纵向带】,带内元素绝对定位 + data-fit 自适应
 * (超了自动缩字号,见 templateAnim 的 auto-fit),所以【结构由 AI 表达、版式由我们兜底,
 * 永不塌】。这就是「贴近 HyperFrames 能力」的正解:灵活度接近自由排版,稳定度接近固定模板。
 *
 * 产物契约跟 freeformWriter 完全一致({css, bodyHtml, setupScript?}),所以是 freeform 的
 * 【drop-in 主路径】:composeSceneFromAI 成功就用它,任何环节失败返回 null → freeform 回退
 * 老的整页 HTML 路径(再失败才纯代码兜底)。pipeline / wrapTemplateHtml 一行不用改。
 *
 * 动画:全走 data-* 声明式(templateAnim 协议),不碰 GSAP —— 稳、可逐帧 seek、无壁钟。
 */

import { callNoobclawChat } from './templateHtmlWriter';
import { escapeHtml as esc } from './templateAnim';
import type { ContentLang } from './scriptWriter';

// ── 画布常量(与 templateAnim/freeform 对齐)────────────────────────────────
const CANVAS_W = 1080;
const SAFE_L = 70;               // 左安全边
const SAFE_R = 70;               // 右安全边
const CONTENT_TOP = 150;         // 顶部从这里开始铺 block
const BOTTOM_CAPTION = 1680;     // 有字幕:内容下界(下方留给字幕带)
const BOTTOM_NOCAP = 1860;       // 无字幕:内容下界(仍留 60 安全边)
const GAP = 36;                  // block 之间的净空
const INNER_W = CANVAS_W - SAFE_L - SAFE_R;

// ── block 类型 ──────────────────────────────────────────────────────────────
export interface SceneBlockItem { name?: string; value?: string; sub?: string; rank?: number; }
export interface SceneBlock {
  type: 'heroTitle' | 'bullets' | 'ranks' | 'stats' | 'bigStat' | 'quote' | 'tags' | 'steps' | 'paragraph';
  /** heroTitle/quote/paragraph/bigStat 用的主文字。 */
  text?: string;
  /** heroTitle 副题 / quote 作者 / bigStat 标签。 */
  sub?: string;
  /** 列表类(bullets/ranks/stats/steps)条目;tags 用 tags 字段。 */
  items?: SceneBlockItem[];
  /** tags 专用:标签字符串数组。 */
  tags?: string[];
  /** 纵向权重(该 block 占多大高度),1~4,缺省按类型给默认值。 */
  weight?: number;
}
export interface Scene {
  /** 情绪/风格提示(仅影响强调色深浅等,可空)。 */
  mood?: string;
  blocks: SceneBlock[];
}

export interface ComposeCtx {
  brandColor: string;
  accentColor: string;
  durationSec: number;
  narrationOn: boolean;
  captionsOn: boolean;
}

export interface SceneResult {
  css: string;
  bodyHtml: string;
  setupScript?: string;
}

// ── 类型默认纵向权重(决定各 block 分到多少高度)──────────────────────────
const DEFAULT_WEIGHT: Record<SceneBlock['type'], number> = {
  heroTitle: 1.1, bigStat: 1.4, quote: 2.2, paragraph: 1.6,
  bullets: 2.6, ranks: 2.8, stats: 2.4, steps: 2.6, tags: 0.9,
};

/** clamp helper。 */
function cl(n: number, lo: number, hi: number): number { return n < lo ? lo : n > hi ? hi : n; }

// ── 单个 block 渲染:传入它被分配到的纵向带(top/height),返回带内 HTML ──────
// 所有文字元素都带 data-fit + data-fit-maxh(=带高),超了自动缩字号,永不溢出本带。
function renderBlock(b: SceneBlock, band: { top: number; height: number; index: number; startSec: number; itemStagger: number }, ctx: ComposeCtx): string {
  const { brandColor: brand, accentColor: accent } = ctx;
  const top = Math.round(band.top);
  const H = Math.round(band.height);
  const s0 = band.startSec;
  // 通用绝对定位带:left/right 安全边 + 顶 + 固定高 + overflow hidden(data-fit 会再收字号)
  const wrap = (inner: string, extraCss = '') =>
    `<div class="blk" style="top:${top}px;height:${H}px;${extraCss}">${inner}</div>`;

  switch (b.type) {
    case 'heroTitle': {
      const title = esc((b.text || '').slice(0, 40));
      const sub = b.sub ? esc(b.sub.slice(0, 60)) : '';
      const subH = sub ? 64 : 0;
      const titH = Math.max(80, H - subH - (sub ? 20 : 0));
      return wrap(
        `<div class="hero-t" data-fit data-fit-maxh="${titH}" data-fit-min="46" data-anim="fade-up" data-start="${s0.toFixed(2)}" data-duration="0.6" data-ease="expo" style="color:${brand}">${title}</div>`
        + (sub ? `<div class="hero-s" data-fit data-fit-maxh="${subH}" data-fit-min="24" data-anim="fade-up" data-start="${(s0 + 0.25).toFixed(2)}" data-duration="0.6">${sub}</div>` : ''),
      );
    }
    case 'bigStat': {
      const val = esc((b.text || '').slice(0, 16));
      const lab = b.sub ? esc(b.sub.slice(0, 40)) : '';
      return wrap(
        `<div class="big-n" data-fit data-fit-maxh="${Math.round(H * 0.62)}" data-fit-min="60" data-anim="pop" data-start="${s0.toFixed(2)}" data-duration="0.8" data-ease="back" style="color:${accent}">${val}</div>`
        + (lab ? `<div class="big-l" data-fit data-fit-maxh="${Math.round(H * 0.3)}" data-fit-min="24" data-anim="fade-up" data-start="${(s0 + 0.3).toFixed(2)}" data-duration="0.6">${lab}</div>` : ''),
      );
    }
    case 'quote': {
      const q = esc((b.text || '').slice(0, 160));
      const a = b.sub ? esc(b.sub.slice(0, 40)) : '';
      return wrap(
        `<div class="q-mark" style="color:${brand}" data-anim="pop" data-start="${s0.toFixed(2)}" data-duration="0.7" data-ease="back">"</div>`
        + `<div class="q-t" data-fit data-fit-maxh="${Math.round(H * 0.62)}" data-fit-min="34" data-anim="fade-up" data-start="${(s0 + 0.25).toFixed(2)}" data-duration="0.7">${q}</div>`
        + (a ? `<div class="q-a" data-fit data-fit-maxh="52" data-fit-min="24" data-anim="fade" data-start="${(s0 + 0.6).toFixed(2)}" data-duration="0.6">— ${a}</div>` : ''),
      );
    }
    case 'paragraph': {
      const p = esc((b.text || '').slice(0, 320));
      return wrap(
        `<div class="para" data-fit data-fit-maxh="${H}" data-fit-min="28" data-anim="fade-up" data-start="${s0.toFixed(2)}" data-duration="0.6">${p}</div>`,
      );
    }
    case 'tags': {
      const tags = (b.tags || []).slice(0, 12).map((t, i) =>
        `<span class="tag" style="border-color:${accent}66" data-anim="pop" data-start="${(s0 + i * 0.08).toFixed(2)}" data-duration="0.45" data-ease="back">${esc(String(t).slice(0, 20))}</span>`,
      ).join('');
      return wrap(`<div class="tagrow" data-fit data-fit-maxh="${H}" data-fit-min="22">${tags}</div>`);
    }
    case 'ranks':
    case 'bullets':
    case 'stats':
    case 'steps': {
      const items = (b.items || []).slice(0, 8);
      const n = Math.max(1, items.length);
      const rowH = Math.floor((H - (n - 1) * 14) / n);
      const rows = items.map((it, i) => {
        const st = (s0 + i * band.itemStagger).toFixed(2);
        const rowTop = i * (rowH + 14);
        const name = esc((it.name || '').slice(0, 60));
        const val = it.value ? esc(it.value.slice(0, 20)) : '';
        const sub = it.sub ? esc(it.sub.slice(0, 50)) : '';
        if (b.type === 'stats') {
          // 半屏卡:两列;这里按行渲染(单列)保证 data-fit 简单稳,数值大字 + 标签
          return `<div class="s-row" style="top:${rowTop}px;height:${rowH}px" data-anim="rise" data-start="${st}" data-duration="0.55" data-ease="expo">`
            + `<div class="s-val" data-fit data-fit-maxh="${Math.round(rowH * 0.6)}" data-fit-min="34" style="color:${accent}">${val || name}</div>`
            + (val ? `<div class="s-lab" data-fit data-fit-maxh="${Math.round(rowH * 0.34)}" data-fit-min="20">${name}</div>` : '')
            + `</div>`;
        }
        if (b.type === 'steps') {
          return `<div class="st-row" style="top:${rowTop}px;height:${rowH}px" data-anim="fade-left" data-start="${st}" data-duration="0.5" data-ease="expo">`
            + `<div class="st-dot" style="background:${accent}">${i + 1}</div>`
            + `<div class="st-body"><div class="st-nm" data-fit data-fit-maxh="${Math.round(rowH * (sub ? 0.6 : 0.9))}" data-fit-min="26">${name}</div>`
            + (sub ? `<div class="st-sb" data-fit data-fit-maxh="${Math.round(rowH * 0.34)}" data-fit-min="20">${sub}</div>` : '')
            + `</div></div>`;
        }
        // ranks / bullets
        const badge = b.type === 'ranks'
          ? `<div class="r-badge" style="border-color:${brand};color:${brand}">${it.rank ?? i + 1}</div>`
          : `<div class="r-bar" style="background:${accent}"></div>`;
        return `<div class="r-row" style="top:${rowTop}px;height:${rowH}px" data-anim="slide-in-right" data-start="${st}" data-duration="0.55" data-ease="expo">`
          + badge
          + `<div class="r-body"><div class="r-nm" data-fit data-fit-maxh="${Math.round(rowH * (sub ? 0.62 : 0.92))}" data-fit-min="26">${name}</div>`
          + (sub ? `<div class="r-sb" data-fit data-fit-maxh="${Math.round(rowH * 0.32)}" data-fit-min="20">${sub}</div>` : '')
          + `</div>`
          + (val ? `<div class="r-val" data-fit data-fit-maxw="260" data-fit-min="28" style="color:${accent}">${val}</div>` : '')
          + `</div>`;
      }).join('');
      return wrap(`<div class="listwrap">${rows}</div>`);
    }
    default:
      return '';
  }
}

/** 场景 → {css, bodyHtml}。确定性铺带 + data-fit 兜底,永不塌。 */
export function renderScene(scene: Scene, ctx: ComposeCtx): SceneResult {
  const bottom = ctx.captionsOn ? BOTTOM_CAPTION : BOTTOM_NOCAP;
  const regionH = bottom - CONTENT_TOP;
  // 过滤空 block,封顶 6 个(再多铺不下)
  const blocks = (scene.blocks || []).filter((b) => b && b.type).slice(0, 6);
  if (blocks.length === 0) {
    return { css: baseCss(ctx), bodyHtml: `<div class="blk" style="top:${CONTENT_TOP}px;height:200px"><div class="hero-t" style="color:${ctx.brandColor}">·</div></div>` };
  }
  // 纵向按权重分带,预留 block 间 GAP
  const weights = blocks.map((b) => cl(b.weight ?? DEFAULT_WEIGHT[b.type] ?? 1.5, 0.6, 4));
  const totalW = weights.reduce((a, c) => a + c, 0);
  const usableH = regionH - GAP * (blocks.length - 1);
  // 每个 list 类 block 的条目在整段时长内的揭示节奏:有配音 → 沿时长铺开;无 → 快速错峰
  const listCount = blocks.filter((b) => ['bullets', 'ranks', 'stats', 'steps'].includes(b.type)).length;
  let cursor = CONTENT_TOP;
  const parts: string[] = [];
  blocks.forEach((b, i) => {
    const h = Math.max(120, Math.round((weights[i] / totalW) * usableH));
    // 该 block 的进场时刻:块间错峰 0.35s;有配音时把 list 的条目揭示拉到整段时长
    const blockStart = ctx.narrationOn ? cl(0.4 + (i / Math.max(1, blocks.length)) * ctx.durationSec * 0.5, 0.4, ctx.durationSec - 1) : 0.3 + i * 0.35;
    const isList = ['bullets', 'ranks', 'stats', 'steps'].includes(b.type);
    const itemCount = Math.max(1, (b.items || []).length);
    const itemStagger = ctx.narrationOn && isList
      ? cl((ctx.durationSec - blockStart - 1) / itemCount, 0.2, 1.2)
      : 0.14;
    parts.push(renderBlock(b, { top: cursor, height: h, index: i, startSec: blockStart, itemStagger }, ctx));
    cursor += h + GAP;
  });
  void listCount;
  // 背景氛围:液态 blob 慢漂 + 颗粒 + 暗角(克制,不糊)
  const ambient = `<div class="fx-blob" data-loop="float" data-loop-period="13" data-loop-amp="70" style="width:620px;height:620px;background:${ctx.brandColor};opacity:0.32;top:-160px;left:-140px"></div>`
    + `<div class="fx-blob" data-loop="float" data-loop-period="17" data-loop-amp="86" data-loop-phase="2.3" style="width:520px;height:520px;background:${ctx.accentColor};opacity:0.24;bottom:-140px;right:-150px"></div>`
    + `<div class="fx-vignette"></div><div class="fx-grain"></div>`;
  return { css: baseCss(ctx), bodyHtml: ambient + parts.join('\n') };
}

function baseCss(ctx: ComposeCtx): string {
  const { accentColor: accent } = ctx;
  return `
.blk{position:absolute;left:${SAFE_L}px;width:${INNER_W}px;overflow:hidden}
.hero-t{font-size:96px;font-weight:900;line-height:1.12;text-align:center;letter-spacing:1px;text-shadow:0 6px 26px rgba(0,0,0,0.5)}
.hero-s{font-size:44px;font-weight:600;color:#9aa2b1;line-height:1.3;text-align:center;letter-spacing:4px;margin-top:20px}
.big-n{font-size:240px;font-weight:900;line-height:1;text-align:center;letter-spacing:-4px;text-shadow:0 8px 34px ${accent}44}
.big-l{font-size:44px;font-weight:700;color:#c7ccd4;text-align:center;margin-top:16px;line-height:1.3}
.q-mark{font-size:200px;line-height:0.5;font-family:Georgia,serif;opacity:0.4;text-align:center}
.q-t{font-size:64px;font-weight:800;line-height:1.5;text-align:center;margin-top:26px;text-shadow:0 4px 24px rgba(0,0,0,0.5)}
.q-a{font-size:36px;color:#aeb4bf;text-align:center;margin-top:26px;letter-spacing:3px;font-style:italic}
.para{font-size:46px;font-weight:600;line-height:1.55;color:#e6e9ef;text-align:left}
.tagrow{display:flex;flex-wrap:wrap;gap:22px;align-content:center;justify-content:center;height:100%}
.tag{display:inline-flex;align-items:center;font-size:40px;font-weight:700;padding:14px 34px;border-radius:999px;border:2px solid;background:rgba(255,255,255,0.04);color:#fff}
.listwrap{position:relative;width:100%;height:100%}
.r-row{position:absolute;left:0;right:0;display:flex;align-items:center;padding:0 40px;border-radius:26px;background:linear-gradient(135deg,#181b21,#1f2329);border:1px solid #2b2f36;box-shadow:0 10px 30px rgba(0,0,0,0.32);overflow:hidden}
.r-badge{flex:0 0 auto;width:78px;height:78px;border-radius:50%;border:2px solid;display:flex;align-items:center;justify-content:center;font-size:42px;font-weight:900;margin-right:26px}
.r-bar{flex:0 0 auto;width:10px;height:64%;border-radius:6px;margin-right:30px}
.r-body{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center}
.r-nm{font-size:48px;font-weight:800;line-height:1.16;overflow:hidden}
.r-sb{font-size:28px;color:#848e9c;margin-top:6px;line-height:1.2;overflow:hidden}
.r-val{flex:0 0 auto;font-size:56px;font-weight:900;text-align:right;margin-left:22px;white-space:nowrap}
.s-row{position:absolute;left:0;right:0;display:flex;flex-direction:column;justify-content:center;align-items:center;border-radius:22px;background:linear-gradient(135deg,#15181d,#1d2126);border:1px solid #2b2f36;box-shadow:0 10px 30px rgba(0,0,0,0.35)}
.s-val{font-size:88px;font-weight:900;line-height:1;text-align:center}
.s-lab{font-size:32px;color:#c7ccd4;margin-top:10px;text-align:center;line-height:1.2}
.st-row{position:absolute;left:0;right:0;display:flex;align-items:center;padding-left:6px}
.st-dot{flex:0 0 auto;width:66px;height:66px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:36px;font-weight:900;color:#0b0e11;margin-right:28px;box-shadow:0 0 22px ${accent}66}
.st-body{flex:1;min-width:0}
.st-nm{font-size:46px;font-weight:800;line-height:1.18;overflow:hidden}
.st-sb{font-size:28px;color:#848e9c;margin-top:6px;line-height:1.25;overflow:hidden}
`;
}

// ── AI 场景生成 ──────────────────────────────────────────────────────────────
const SCENE_SYSTEM = [
  '你是短视频信息版式设计师。把用户内容整理成【一屏竖屏画面的场景 JSON】,只输出严格 JSON(json),不要解释、不要 markdown。',
  '结构:{"blocks":[ <2~5 个 block> ]}。每个 block 从下列【固定安全原语】里选一种(我们会把它铺进不塌的版式,你只管选类型 + 填内容):',
  '- {"type":"heroTitle","text":"大标题(≤20字)","sub":"副题(可选,≤28字)"} —— 开场/主题,一屏最多 1 个,放最上面。',
  '- {"type":"bullets","items":[{"name":"要点","value":"数值(可选)","sub":"说明(可选)"}]} —— 无序要点/清单(≤6 条)。',
  '- {"type":"ranks","items":[{"rank":1,"name":"名称","value":"数值","sub":"说明(可选)"}]} —— 排行榜/盘点(≤6 条,带名次)。',
  '- {"type":"stats","items":[{"value":"98.4%","name":"这个数值的含义"}]} —— 关键指标卡(≤4 个,突出大数字)。',
  '- {"type":"bigStat","text":"1.2亿","sub":"标签说明"} —— 单个核心大数字,冲击力强。',
  '- {"type":"steps","items":[{"name":"步骤/阶段","sub":"说明(可选)"}]} —— 流程/步骤/时间线(≤5 条,带序号)。',
  '- {"type":"quote","text":"金句正文","sub":"作者(可选)"} —— 金句/观点。',
  '- {"type":"tags","tags":["标签1","标签2"]} —— 关键词标签云(≤10 个)。',
  '- {"type":"paragraph","text":"一段话(≤120字)"} —— 说明性段落。',
  '可选给每个 block 加 "weight":1~4 控制它占的高度(大数字/榜单给大,标签给小)。',
  '',
  '硬规则(违反=废片):',
  '1. blocks 数量 2~5 个。第一个通常是 heroTitle 点题。整屏内容【必须一屏放得下】—— 宁可精简,不要硬塞十几条。',
  '2. 忠实呈现用户内容,**绝不编造数据/来源/品牌名**;数值原样保留(带 +/-/% /单位)。',
  '3. name 与 value 不重叠(value 是纯数值串,name 不要末尾再带这个数值)。',
  '4. 画面【只放用户内容本身】。口播句 / slogan / CTA / 引导语(如"快来关注""别错过")绝不进画面。',
  '5. 保持用户内容的语言。文字精炼(标题短、要点短)—— 版式会自适应字号,但内容越精炼越好看。',
  '6. 按内容类型选最合适的原语组合:榜单→heroTitle+ranks;盘点要点→heroTitle+bullets;单一大数据→heroTitle+bigStat(+bullets);金句→quote;流程→heroTitle+steps。',
].join('\n');

function buildSceneUser(dataText: string, title: string | undefined, brief: string | undefined, narrationOn: boolean, durationSec: number): string {
  const parts: string[] = [];
  if (title) parts.push(`标题倾向:${title}`);
  parts.push(`时长约 ${durationSec.toFixed(0)}s${narrationOn ? '(有配音,画面条目会随口播逐条揭示,条目别太多)' : '(纯视觉)'}`);
  if (brief && brief.trim()) parts.push(`【用户风格/重点要求(认真照做)】${brief.trim().slice(0, 300)}`);
  parts.push('用户内容(json):');
  parts.push(dataText.slice(0, 2200));
  return parts.join('\n');
}

/** 从夹带围栏/文字的输出抠第一个 JSON 对象。 */
function extractJsonObject(raw: string): string {
  let t = (raw || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) t = fence[1].trim();
  const start = t.indexOf('{');
  if (start >= 0) {
    let depth = 0, inStr = false, escNext = false;
    for (let i = start; i < t.length; i++) {
      const c = t[i];
      if (inStr) {
        if (escNext) escNext = false;
        else if (c === '\\') escNext = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return t.slice(start, i + 1); }
    }
  }
  return t;
}

/** 校验/清洗 AI 场景 JSON。任何一步不合规就返回 null(触发 freeform 回退老路径)。 */
function sanitizeScene(parsed: any): Scene | null {
  if (!parsed || !Array.isArray(parsed.blocks)) return null;
  const VALID = new Set(['heroTitle', 'bullets', 'ranks', 'stats', 'bigStat', 'quote', 'tags', 'steps', 'paragraph']);
  const blocks: SceneBlock[] = [];
  for (const raw of parsed.blocks) {
    if (!raw || typeof raw.type !== 'string' || !VALID.has(raw.type)) continue;
    const b: SceneBlock = { type: raw.type };
    if (typeof raw.text === 'string' && raw.text.trim()) b.text = raw.text.trim();
    if (typeof raw.sub === 'string' && raw.sub.trim()) b.sub = raw.sub.trim();
    if (typeof raw.weight === 'number' && Number.isFinite(raw.weight)) b.weight = raw.weight;
    if (Array.isArray(raw.items)) {
      b.items = raw.items.slice(0, 8).map((it: any) => {
        const o: SceneBlockItem = {};
        if (typeof it?.name === 'string') o.name = it.name.trim();
        if (typeof it?.value === 'string') o.value = it.value.trim();
        if (typeof it?.sub === 'string') o.sub = it.sub.trim();
        if (typeof it?.rank === 'number') o.rank = it.rank;
        return o;
      }).filter((o: SceneBlockItem) => o.name || o.value);
    }
    if (Array.isArray(raw.tags)) b.tags = raw.tags.filter((t: any) => typeof t === 'string' && t.trim()).slice(0, 12);
    // 内容为空的 block 丢弃
    const hasContent = b.text || (b.items && b.items.length) || (b.tags && b.tags.length);
    if (hasContent) blocks.push(b);
  }
  if (blocks.length === 0) return null;
  return { blocks: blocks.slice(0, 6) };
}

export interface ComposeSceneInput {
  dataText: string;
  title?: string;
  brief?: string;
  lang: ContentLang;
  brandColor: string;
  accentColor: string;
  durationSec: number;
  narrationOn: boolean;
  captionsOn: boolean;
}

export interface ComposeSceneOutput {
  css: string;
  bodyHtml: string;
  tokens: number;
  costUsd: number;
  blockCount: number;
}

/**
 * 让 AI 出场景 JSON → 渲染成安全画面。成功返回 {css,bodyHtml,...};
 * 任何失败(鉴权/余额除外,那个上抛)返回 null,让 freeform 回退老整页 HTML 路径。
 */
export async function composeSceneFromAI(
  input: ComposeSceneInput,
  onProgress?: (msg: string) => void,
): Promise<ComposeSceneOutput | null> {
  const ctx: ComposeCtx = {
    brandColor: input.brandColor,
    accentColor: input.accentColor || '#0ecb81',
    durationSec: input.durationSec,
    narrationOn: input.narrationOn,
    captionsOn: input.captionsOn,
  };
  try {
    onProgress?.('🧩 正在规划画面结构(结构化安全排版)…');
    // 场景 JSON 体量小,直接用 flash(chat)最稳(支持 json_object,不吐思考链)。
    const { content, tokens, costUsd } = await callNoobclawChat(
      SCENE_SYSTEM,
      buildSceneUser(input.dataText, input.title, input.brief, input.narrationOn, input.durationSec),
      { temperature: 0.7, maxTokens: 2600, model: 'noobclawai-chat', timeoutMs: 60_000 },
    );
    const scene = sanitizeScene(JSON.parse(extractJsonObject(content)));
    if (!scene) { onProgress?.('⚠️ 结构化排版未产出有效场景,回退整页排版'); return null; }
    const { css, bodyHtml } = renderScene(scene, ctx);
    onProgress?.(`✅ 结构化排版已规划 ${scene.blocks.length} 个区块`);
    return { css, bodyHtml, tokens, costUsd, blockCount: scene.blocks.length };
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    if (/AI_AUTH_FAILED|CREDITS_INSUFFICIENT|AI_NOT_CONFIGURED/.test(msg)) throw e;
    onProgress?.('⚠️ 结构化排版失败,回退整页排版');
    return null;
  }
}
