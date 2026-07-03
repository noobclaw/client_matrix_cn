/**
 * templateLibrary — 「模板速生」HF 派精品模板库(5 套,改造自 v2)。
 *
 * 关键转变:v2 用 `window.renderFrame(t)` 命令式逐帧手算 opacity(壁钟无关但难扩展);
 * v3 改成【声明式 data-* 属性 + 共享 paused seek 协议】(`window.__nbc.seek(t)`),
 * 抄 HyperFrames 的 GSAP timeline 派思维 —— 每个元素自带 `data-start` / `data-duration` /
 * `data-anim`,渲染时 seek 一次性把整张画面推到时间 t,确定性、可任意倒带、可任意倒推。
 *
 * 跟 v2 的区别:
 *   · 模板 body 里【不再有任何 JS】—— 动画完全靠 data-* 声明
 *   · seek 协议在 templateAnim.NBC_RUNTIME_JS 里统一注入,本文件不重复
 *   · 字幕节点也是声明式 `[data-caption-start/end]`,跟动画同一引擎,无对齐误差
 *
 * 仍是 5 套(rank_list/news_cards/quote/countdown/stat_board)的产品差异化:
 *   · 用户向导选「版式」依然是按内容类型挑(HF 不按内容类型分,是我们的产品优势)
 *   · AI 只填结构化数据,保证质量稳定(LLM 不写 HTML,不会画风跑偏)
 */

import type { TemplateStyle } from './templateHtmlWriter';
import {
  wrapTemplateHtml, escapeHtml as esc, type CaptionCue,
  liquidBlobsHtml, splitKinetic, pageFlashesHtml,
} from './templateAnim';

export interface TemplateItem {
  rank?: number;     // 名次(榜单/盘点)
  name: string;      // 主文字
  value?: string;    // 数值(如 "+18.96%" / "1.2亿")
  sub?: string;      // 副文字(英文名/说明)
}

export interface TemplateSpec {
  style: TemplateStyle;
  title?: string;
  subtitle?: string;
  items: TemplateItem[];
  brandColor: string;       // 主品牌色 #RRGGBB
  accentColor?: string;     // 强调色(默认绿 #0ecb81)
  durationSec: number;
  fps: number;
  captions?: CaptionCue[];  // TTS 出的句级时间戳;空 = 纯视觉,字幕轨隐藏
  /**
   * 外部传入的【每页时间窗】(秒),由 pipeline 根据 voiceSegments 在 TTS 真实时长上反算。
   * 长度必须 == 分页后 page 数;为空时各模板按 durationSec 均分。
   * 实现「音画同步」:配音念到第 N 段时,画面正好在第 N 页。
   */
  pageTimings?: Array<{ startSec: number; durSec: number }>;
}

/** 计算分页的 pageCount(给 pipeline 算 pageMeta 用)。 */
export function calcPageCount(itemsLen: number, pageSize: number): number {
  return Math.max(1, Math.ceil(itemsLen / pageSize));
}

/** 计算每页的 items 索引范围(给 pipeline 喂给 AI 的 pageRanges 用)。 */
export function calcPageRanges(itemsLen: number, pageSize: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (let p = 0; p * pageSize < itemsLen; p++) {
    const a = p * pageSize;
    const b = Math.min(itemsLen - 1, a + pageSize - 1);
    ranges.push([a, b]);
  }
  return ranges.length ? ranges : [[0, Math.max(0, itemsLen - 1)]];
}

/** 把 items 分页 + 计算每页时间窗。最后一页不退场(留到片尾)。 */
interface PageSlot {
  items: TemplateItem[];
  /** 本页元素的【建议 data-start 起点秒】 —— 子元素在此基础上 +0.1, +0.25... 错开。 */
  pageStartSec: number;
  /** 本页持续多久(秒)。 */
  pageDurationSec: number;
  /** 本页是不是最后一页(最后一页不退场,留到 video 结束)。 */
  isLast: boolean;
  pageIndex: number;
  pageCount: number;
}
function paginate(items: TemplateItem[], pageSize: number, totalSec: number, pageTimings?: Array<{ startSec: number; durSec: number }>): PageSlot[] {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  // 优先用外部传入的 pageTimings(配音同步模式):pipeline 已经根据 voiceSegments
  // 在 TTS 真实时长上算好每段时间窗,跟配音 100% 对齐。
  if (pageTimings && pageTimings.length === pageCount) {
    const slots: PageSlot[] = [];
    for (let p = 0; p < pageCount; p++) {
      slots.push({
        items: items.slice(p * pageSize, (p + 1) * pageSize),
        pageStartSec: pageTimings[p].startSec,
        pageDurationSec: pageTimings[p].durSec,
        isLast: p === pageCount - 1,
        pageIndex: p,
        pageCount,
      });
    }
    return slots;
  }
  // 兜底:按 totalSec 均分(纯视觉模式 / TTS 失败时走这条)。
  // 留 0.5s 入场缓冲 + 0.5s 尾留白
  const usable = Math.max(2.0, totalSec - 1.0);
  const perPage = usable / pageCount;
  const slots: PageSlot[] = [];
  for (let p = 0; p < pageCount; p++) {
    slots.push({
      items: items.slice(p * pageSize, (p + 1) * pageSize),
      pageStartSec: 0.5 + p * perPage,
      pageDurationSec: perPage,
      isLast: p === pageCount - 1,
      pageIndex: p,
      pageCount,
    });
  }
  return slots;
}

/** 各模板的【每页容量】导出,供 pipeline 算 pageMeta 用(不重复硬编码)。 */
export function pageSizeFor(style: TemplateStyle): number {
  switch (style) {
    case 'rank_list': return 6;
    case 'news_cards': return 4;
    case 'countdown': return 6;
    case 'stat_board': return 4;
    case 'timeline': return 5;
    case 'cover_hero': return 3; // 只用前 3 条当亮点条,单页不分页
    case 'billboard': return 1;  // 每屏一条大字,N 条轮播
    case 'quote': return 1; // 金句只展示 items[0],分页无意义
    default: return 4;
  }
}

/** 给 page wrapper 拼 data-* 属性 —— fade 进场 + 末尾退场(最后一页不退)。 */
function pageDataAttrs(slot: PageSlot): string {
  const enterDur = 0.35;
  const exitDur = 0.4;
  const attrs = [
    `data-anim="fade"`,
    `data-start="${slot.pageStartSec.toFixed(2)}"`,
    `data-duration="${enterDur}"`,
  ];
  if (!slot.isLast) {
    const exitStart = slot.pageStartSec + slot.pageDurationSec - exitDur;
    attrs.push(`data-exit-start="${exitStart.toFixed(2)}"`);
    attrs.push(`data-exit-duration="${exitDur.toFixed(2)}"`);
  }
  return attrs.join(' ');
}

/** 解析「+18.96%」「-2.3%」「1.2亿」「12345」这类显示串,拆出数值/符号/前后缀。
 *  用于 count-up 动画:从 0 滚到目标数,完整保留前后缀。返回 null 表示无法解析。 */
function parseNumeric(raw: string | undefined): null | {
  num: number; decimals: number; prefix: string; suffix: string; positive: boolean;
} {
  if (!raw) return null;
  const m = raw.match(/(-?\+?)(\d+(?:\.\d+)?)(.*)/);
  if (!m) return null;
  const signRaw = m[1];
  const numStr = m[2];
  const num = parseFloat(numStr);
  if (!Number.isFinite(num)) return null;
  const positive = signRaw === '+' || (signRaw === '' && num >= 0);
  const prefix = signRaw === '+' ? '+' : signRaw === '-' ? '-' : '';
  const suffix = (m[3] || '').trim();
  const decimals = numStr.includes('.') ? (numStr.split('.')[1].length) : 0;
  return { num: Math.abs(num), decimals, prefix, suffix, positive };
}

// ── 精品模板 1:排行榜 / 榜单(rank_list)── 币安暗金风 ────────────────────
// 每页 6 行;数据超过 6 条自动分页轮播。2026-06 酷炫化(抄 html-video 技法):
// 标题逐字打出、前三名金银铜、行内光泽周期扫过(data-loop=sweep)、页切白闪、胶片颗粒。
function renderRankList(spec: TemplateSpec): string {
  const accent = spec.accentColor || '#0ecb81';
  const PAGE = 6;
  // 前三名奖牌色(金/银/铜),其余用品牌色 —— 信息层级一眼立住
  const MEDAL = ['#f0b90b', '#c0c8d8', '#cd7f32'];
  const css = `
#title{position:absolute;top:170px;left:80px;right:80px;text-align:center}
#title .t1{font-size:78px;font-weight:900;color:${spec.brandColor};letter-spacing:1px;text-shadow:0 6px 24px ${spec.brandColor}40}
#title .t2{font-size:34px;color:#848e9c;margin-top:18px;letter-spacing:8px;font-weight:600}
#title .rule{height:4px;width:180px;margin:24px auto 0;background:linear-gradient(90deg,transparent,${spec.brandColor},transparent)}
#list-area{position:absolute;top:440px;left:70px;right:70px;bottom:140px}
.page{position:absolute;inset:0}
.row{height:178px;margin-bottom:26px;border-radius:28px;background:linear-gradient(135deg,#181b21,#1f2329);border:1px solid #2b2f36;box-shadow:0 10px 30px rgba(0,0,0,0.35);display:flex;align-items:center;padding:0 46px;position:relative;overflow:hidden}
.row .bar{position:absolute;left:0;top:0;bottom:0;width:8px;background:${spec.brandColor};opacity:0.9}
.row.m0 .bar{background:${MEDAL[0]}} .row.m1 .bar{background:${MEDAL[1]}} .row.m2 .bar{background:${MEDAL[2]}}
.rank{width:104px;display:flex;align-items:center;justify-content:center}
.rank b{display:inline-flex;align-items:center;justify-content:center;width:74px;height:74px;border-radius:50%;background:${spec.brandColor}1a;border:2px solid ${spec.brandColor};color:${spec.brandColor};font-size:42px;font-weight:900}
.row.m0 .rank b{background:${MEDAL[0]}22;border-color:${MEDAL[0]};color:${MEDAL[0]};box-shadow:0 0 26px ${MEDAL[0]}55}
.row.m1 .rank b{background:${MEDAL[1]}1c;border-color:${MEDAL[1]};color:${MEDAL[1]}}
.row.m2 .rank b{background:${MEDAL[2]}22;border-color:${MEDAL[2]};color:${MEDAL[2]}}
.coin{flex:1;min-width:0;padding-left:8px}
.coin .nm{font-size:54px;font-weight:800;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.15;word-break:break-word}
.coin .sb{font-size:28px;color:#848e9c;margin-top:6px}
.val{font-size:62px;font-weight:900;text-align:right;white-space:nowrap}
.val.up{color:${accent}} .val.down{color:#f6465d} .val.flat{color:#eaecef}
`;

  const titleBlock = `<div id="title">
    <div class="t1" data-fit data-fit-maxh="190" data-fit-min="46">${splitKinetic(spec.title || '榜单速览', 0.1, { stagger: 0.05, anim: 'fade-up', ease: 'expo' })}</div>
    ${spec.subtitle ? `<div class="t2" data-anim="fade-up" data-start="0.5" data-duration="0.6">${esc(spec.subtitle)}</div>` : ''}
    <div class="rule" data-anim="wipe-right" data-start="0.4" data-duration="0.5"></div>
  </div>`;

  const slots = paginate(spec.items, PAGE, spec.durationSec, spec.pageTimings);
  const pages = slots.map((slot) => {
    const rows = slot.items.map((it, i) => {
      const r = it.rank ?? (slot.pageIndex * PAGE + i + 1);
      const medalCls = r >= 1 && r <= 3 ? ` m${r - 1}` : '';
      const start = slot.pageStartSec + 0.2 + i * 0.12;
      const dur = 0.6;
      const valParsed = parseNumeric(it.value);
      let valNode: string;
      if (valParsed) {
        const colorCls = valParsed.positive ? 'up' : (it.value && it.value.startsWith('-') ? 'down' : 'flat');
        const signedPrefix = it.value && it.value.startsWith('-') ? '-' : valParsed.prefix;
        valNode = `<div class="val ${colorCls}" data-anim="fade" data-start="${start.toFixed(2)}" data-duration="${dur}" data-count-from="0" data-count-to="${valParsed.num}" data-count-decimals="${valParsed.decimals}" data-count-prefix="${signedPrefix}" data-count-suffix="${esc(valParsed.suffix)}">${esc(valParsed.prefix + valParsed.num.toFixed(valParsed.decimals) + valParsed.suffix)}</div>`;
      } else {
        valNode = `<div class="val flat" data-anim="fade" data-start="${start.toFixed(2)}" data-duration="${dur}">${esc(it.value || '')}</div>`;
      }
      // 行内光泽:错相位让各行不同时亮(i*1.1s),7s 一轮 —— 画面持续有微动,不死板
      return `<div class="row${medalCls}" data-anim="slide-in-right" data-start="${start.toFixed(2)}" data-duration="${dur}">
        <div class="bar"></div>
        <div class="fx-sheen" data-loop="sweep" data-loop-period="7" data-loop-phase="${(i * 1.1).toFixed(1)}" data-loop-travel="1100"></div>
        <div class="rank"><b>${r}</b></div>
        <div class="coin"><div class="nm">${esc(it.name)}</div>${it.sub ? `<div class="sb">${esc(it.sub)}</div>` : ''}</div>
        ${valNode}
      </div>`;
    }).join('');
    return `<div class="page" ${pageDataAttrs(slot)}>${rows}</div>`;
  }).join('');

  const body = `${titleBlock}<div id="list-area">${pages}</div>
    ${pageFlashesHtml(slots.map((s) => s.pageStartSec))}
    <div class="fx-grain"></div>`;
  return wrapTemplateHtml({
    bodyHtml: body, css, brandColor: spec.brandColor,
    durationSec: spec.durationSec, fps: spec.fps, captionCues: spec.captions,
  });
}

// ── 精品模板 2:金句 / 语录(quote)── 杂志社论风 ──────────────────────────
// 2026-06 酷炫化:液态极光背景(blur 大圆 data-loop=float 缓慢漂移)、正文逐字浮现
// (kinetic typography 精髓)、衬线巨型引号、分隔线自画、胶片颗粒收尾。
function renderQuote(spec: TemplateSpec): string {
  const quote = spec.items[0]?.name || spec.title || '';
  const author = spec.items[0]?.sub || spec.subtitle || '';
  // 逐字 stagger 总时长跟句长走,但 clamp 住:短句逐字慢慢出,长句加速(2.2s 内出完)。
  const stagger = Math.min(0.06, Math.max(0.022, 2.2 / Math.max(1, quote.length)));
  const css = `
#quote{position:absolute;left:100px;right:100px;top:50%;transform:translate(0,-50%);text-align:center;z-index:5}
#quote .mark{font-size:220px;line-height:0.6;color:${spec.brandColor};opacity:0.4;font-family:Georgia,'Times New Roman',serif;text-shadow:0 0 60px ${spec.brandColor}66}
#quote .q{font-size:74px;font-weight:800;line-height:1.55;margin-top:34px;text-shadow:0 4px 30px rgba(0,0,0,0.55)}
#quote .rule{height:3px;width:220px;margin:54px auto 0;background:linear-gradient(90deg,transparent,${spec.brandColor},transparent)}
#quote .a{font-size:36px;color:#aeb4bf;margin-top:30px;letter-spacing:3px;font-family:Georgia,'Times New Roman',serif;font-style:italic}
`;
  // 引号 pop → 正文逐字浮现 → 分隔线自画 → 作者淡入;背景极光全程缓慢漂移
  const charsDoneAt = 0.45 + quote.length * stagger;
  const body = `${liquidBlobsHtml(spec.brandColor, spec.accentColor)}
  <div id="quote">
    <div class="mark" data-anim="pop" data-start="0.05" data-duration="0.8" data-ease="back">"</div>
    <div class="q">${splitKinetic(quote, 0.45, { stagger, anim: 'fade-up', duration: 0.45, ease: 'expo' })}</div>
    <div class="rule" data-anim="wipe-right" data-start="${(charsDoneAt + 0.15).toFixed(2)}" data-duration="0.6"></div>
    ${author ? `<div class="a" data-anim="fade-up" data-start="${(charsDoneAt + 0.4).toFixed(2)}" data-duration="0.7">— ${esc(author)}</div>` : ''}
  </div>
  <div class="fx-grain"></div><div class="fx-vignette"></div>`;
  return wrapTemplateHtml({
    bodyHtml: body, css, brandColor: spec.brandColor,
    durationSec: spec.durationSec, fps: spec.fps, captionCues: spec.captions,
  });
}

// ── 精品模板 3:资讯快讯(news_cards)── Breaking News 风 ──────────────────
// 每页 4 张卡;数据多自动分页轮播。2026-06 酷炫化:扫描线 + 暗角营造新闻直播质感、
// 顶部红色 BREAKING 条自画、标题间歇故障抖动(data-loop=glitch)、卡片左右交替滑入、页切白闪。
function renderNewsCards(spec: TemplateSpec): string {
  const accent = spec.accentColor || spec.brandColor;
  const RED = '#e5273e';
  const PAGE = 4;
  const css = `
#breaking{position:absolute;top:128px;left:80px;right:80px;display:flex;align-items:center;gap:22px}
#breaking .tag{background:${RED};color:#fff;font-size:30px;font-weight:900;letter-spacing:4px;padding:10px 26px;border-radius:8px;box-shadow:0 0 30px ${RED}66}
#breaking .line{flex:1;height:3px;background:linear-gradient(90deg,${RED},transparent)}
#title{position:absolute;top:218px;left:80px;right:80px;text-align:left;font-size:74px;font-weight:900;color:#fff;line-height:1.18;text-shadow:0 4px 24px rgba(0,0,0,0.6)}
#subtitle{position:absolute;top:336px;left:84px;right:80px;text-align:left;font-size:30px;color:#8d95a3;letter-spacing:5px;font-family:'JetBrains Mono',Consolas,monospace}
#cards-area{position:absolute;top:440px;left:80px;right:80px;bottom:140px}
.page{position:absolute;inset:0}
.card{margin-bottom:34px;border-radius:24px;background:linear-gradient(135deg,#15181d,#1d2126);border:1px solid #2b2f36;box-shadow:0 10px 30px rgba(0,0,0,0.4);padding:42px 48px;position:relative;overflow:hidden}
.card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:8px;background:${RED}}
.card .h{font-size:48px;font-weight:800;color:#fff;line-height:1.3}
.card .b{font-size:32px;color:#c7ccd4;margin-top:14px;line-height:1.45}
.card .v{font-size:54px;font-weight:900;color:${accent};margin-top:10px}
.pager{position:absolute;bottom:96px;left:0;right:0;text-align:center;font-size:24px;color:#5e6673;letter-spacing:6px}
`;
  const slots = paginate(spec.items, PAGE, spec.durationSec, spec.pageTimings);
  const pages = slots.map((slot) => {
    const cards = slot.items.map((it, i) => {
      const start = slot.pageStartSec + 0.2 + i * 0.18;
      // 左右交替滑入,比千篇一律 fade-up 更有「新闻条目插播」感
      const anim = i % 2 === 0 ? 'slide-in-left' : 'slide-in-right';
      return `<div class="card" data-anim="${anim}" data-start="${start.toFixed(2)}" data-duration="0.55" data-ease="expo">
        <div class="h">${esc(it.name)}</div>
        ${it.value ? `<div class="v">${esc(it.value)}</div>` : ''}
        ${it.sub ? `<div class="b">${esc(it.sub)}</div>` : ''}
      </div>`;
    }).join('');
    return `<div class="page" ${pageDataAttrs(slot)}>${cards}</div>`;
  }).join('');
  // 多页时底部显示「1 / 2」「2 / 2」 翻页提示(单页不显)
  const pager = slots.length > 1
    ? slots.map((slot) =>
      `<div class="pager" ${pageDataAttrs(slot)}>${slot.pageIndex + 1} / ${slot.pageCount}</div>`
    ).join('')
    : '';
  // BREAKING 条 wipe 自画 → 标题滑入后持续轻微故障抖动 → 副标题等宽字体像 ticker
  const body = `<div id="breaking" data-anim="wipe-right" data-start="0" data-duration="0.45">
      <span class="tag">BREAKING</span><span class="line"></span>
    </div>
    <div id="title" data-fit data-fit-maxh="116" data-fit-min="40" data-anim="slide-in-left" data-start="0.25" data-duration="0.6" data-ease="expo"><span data-loop="glitch" data-loop-phase="1.7" style="display:inline-block">${esc(spec.title || '今日要点')}</span></div>
    ${spec.subtitle ? `<div id="subtitle" data-anim="fade" data-start="0.55" data-duration="0.6">${esc(spec.subtitle)}</div>` : ''}
    <div id="cards-area">${pages}</div>
    ${pager}
    ${pageFlashesHtml(slots.map((s) => s.pageStartSec))}
    <div class="fx-scanlines"></div><div class="fx-vignette"></div><div class="fx-grain"></div>`;
  return wrapTemplateHtml({
    bodyHtml: body, css, brandColor: spec.brandColor,
    durationSec: spec.durationSec, fps: spec.fps, captionCues: spec.captions,
  });
}

// ── 精品模板 4:盘点倒数(countdown)── 聚光揭晓风 ─────────────────────────
// 每页 6 行;倒数语义保留(每页内最低名次先,最高名次最后揭晓)。2026-06 酷炫化:
// 中心聚光 + 重暗角(揭晓舞台感)、标题逐字、第 1 名金色脉冲光环(全片唯一持续发光体)、页切白闪。
function renderCountdown(spec: TemplateSpec): string {
  const accent = spec.accentColor || '#f0b90b';
  const PAGE = 6;
  const css = `
#spotlight{position:absolute;inset:0;background:radial-gradient(80% 46% at 50% 40%,${accent}14 0%,transparent 60%);pointer-events:none}
#title{position:absolute;top:170px;left:80px;right:80px;text-align:center}
#title .t1{font-size:74px;font-weight:900;color:${spec.brandColor};letter-spacing:1px;text-shadow:0 6px 24px ${spec.brandColor}40}
#title .t2{font-size:32px;color:#848e9c;margin-top:18px;letter-spacing:8px;font-weight:600}
#list-area{position:absolute;top:430px;left:70px;right:70px;bottom:140px}
.page{position:absolute;inset:0}
.row{height:178px;margin-bottom:26px;border-radius:28px;background:linear-gradient(135deg,#181b21,#1f2329);border:1px solid #2b2f36;box-shadow:0 10px 30px rgba(0,0,0,0.35);display:flex;align-items:center;padding:0 46px;position:relative;overflow:hidden}
.row .big{font-size:120px;font-weight:900;color:${accent};line-height:1;width:160px;text-shadow:0 4px 18px ${accent}40}
.row .body{flex:1;padding-left:30px;min-width:0}
.row .nm{font-size:50px;font-weight:800;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.15;word-break:break-word}
.row .sb{font-size:28px;color:#848e9c;margin-top:6px}
.row .val{font-size:42px;font-weight:800;color:${accent};white-space:nowrap;margin-left:18px}
/* 冠军行:金边 + 微放大;.crown-glow 是行内叠的脉冲光层(data-loop=pulse 驱动) */
.row.champ{border-color:${accent}aa;transform-origin:center;box-shadow:0 10px 40px ${accent}33}
.row.champ .big{text-shadow:0 0 36px ${accent}aa}
.crown-glow{position:absolute;inset:0;border-radius:28px;background:linear-gradient(135deg,${accent}1f,transparent 55%);pointer-events:none}
`;
  const slots = paginate(spec.items, PAGE, spec.durationSec, spec.pageTimings);
  const totalN = spec.items.length;
  const pages = slots.map((slot) => {
    const N = slot.items.length;
    const rows = slot.items.map((it, i) => {
      const r = it.rank ?? (slot.pageIndex * PAGE + i + 1);
      // 倒序:本页内最高 i 先出,i=0 最后出。每条间隔 = (页时长-1) / N。
      const reverseIdx = N - 1 - i;
      const stagger = Math.min(0.6, Math.max(0.2, (slot.pageDurationSec - 1.0) / Math.max(1, N)));
      const start = slot.pageStartSec + 0.2 + reverseIdx * stagger;
      // 第 1 名 = 全片压轴揭晓:金边 + 行内脉冲光层(全片唯一持续发光的东西,视线必然聚焦)
      const isChamp = r === 1;
      const champGlow = isChamp ? `<div class="crown-glow" data-loop="pulse" data-loop-period="2.4" data-loop-base="0.35"></div>` : '';
      return `<div class="row${isChamp ? ' champ' : ''}" data-anim="pop" data-start="${start.toFixed(2)}" data-duration="${isChamp ? '0.7' : '0.55'}" data-ease="back">
        ${champGlow}
        <div class="big">${r}</div>
        <div class="body"><div class="nm">${esc(it.name)}</div>${it.sub ? `<div class="sb">${esc(it.sub)}</div>` : ''}</div>
        ${it.value ? `<div class="val">${esc(it.value)}</div>` : ''}
      </div>`;
    }).join('');
    return `<div class="page" ${pageDataAttrs(slot)}>${rows}</div>`;
  }).join('');
  const body = `<div id="spotlight"></div>
  <div id="title">
    <div class="t1" data-fit data-fit-maxh="190" data-fit-min="44">${splitKinetic(spec.title || 'Top ' + totalN, 0.1, { stagger: 0.05, anim: 'pop', ease: 'back' })}</div>
    ${spec.subtitle ? `<div class="t2" data-anim="fade-up" data-start="0.5" data-duration="0.6">${esc(spec.subtitle)}</div>` : ''}
  </div>
  <div id="list-area">${pages}</div>
  ${pageFlashesHtml(slots.map((s) => s.pageStartSec))}
  <div class="fx-vignette"></div><div class="fx-grain"></div>`;
  return wrapTemplateHtml({
    bodyHtml: body, css, brandColor: spec.brandColor,
    durationSec: spec.durationSec, fps: spec.fps, captionCues: spec.captions,
  });
}

// ── 精品模板 5:数据看板(stat_board)── Swiss 网格风 ──────────────────────
// 每页 4 格(2×2);数据多自动分页。1 条时占满宽。2026-06 酷炫化(抄 html-video 的
// frame-swiss-grid):结构网格线开场自画、几何形状点缀(圆环 pop / 方块匀速慢旋)、
// Swiss 经典红点、左对齐排版、巨型数字滚动保留。
function renderStatBoard(spec: TemplateSpec): string {
  const accent = spec.accentColor || '#0ecb81';
  const SWISS_RED = '#e5273e';
  const PAGE = 4;
  const css = `
.swiss-line{position:absolute;background:rgba(255,255,255,0.10);pointer-events:none}
.swiss-line.h{left:60px;right:60px;height:2px}
.swiss-line.v{top:140px;bottom:140px;width:2px}
#swiss-circle{position:absolute;width:120px;height:120px;border-radius:50%;border:3px solid ${accent};right:96px;top:150px;pointer-events:none}
#swiss-square{position:absolute;width:64px;height:64px;background:${SWISS_RED};left:96px;bottom:170px;pointer-events:none}
#title{position:absolute;top:158px;left:100px;right:240px;text-align:left;font-size:64px;font-weight:900;color:#fff;line-height:1.15}
#title .dot{color:${SWISS_RED}}
#subtitle{position:absolute;top:282px;left:102px;right:80px;text-align:left;font-size:28px;color:#848e9c;letter-spacing:6px;font-family:'JetBrains Mono',Consolas,monospace}
#grid-area{position:absolute;top:400px;left:60px;right:60px;bottom:140px}
.page{position:absolute;inset:0;display:grid;grid-template-columns:1fr 1fr;gap:34px;align-content:start}
.cell{border-radius:8px;background:linear-gradient(135deg,#15181d,#1c2025);border:1px solid #2b2f36;box-shadow:0 10px 30px rgba(0,0,0,0.35);padding:56px 40px;text-align:left;min-height:340px;display:flex;flex-direction:column;justify-content:center;position:relative;overflow:hidden}
.cell::after{content:"";position:absolute;left:40px;bottom:34px;width:56px;height:4px;background:${SWISS_RED}}
.cell .lbl{font-size:30px;color:#848e9c;font-weight:700;letter-spacing:2px;text-transform:uppercase}
.cell .num{font-size:124px;font-weight:900;color:${accent};line-height:1.02;margin-top:18px;letter-spacing:-2px;text-shadow:0 4px 20px ${accent}30}
.cell .sub{font-size:26px;color:#c7ccd4;margin-top:14px;line-height:1.4}
.cell.full{grid-column:span 2;min-height:200px}
.cell.full .num{font-size:100px}
`;
  const slots = paginate(spec.items, PAGE, spec.durationSec, spec.pageTimings);
  const pages = slots.map((slot) => {
    const cells = slot.items.map((it, i) => {
      const start = slot.pageStartSec + 0.2 + i * 0.15;
      const parsed = parseNumeric(it.value);
      const fullCls = slot.items.length === 1 ? ' full' : '';
      let numNode: string;
      if (parsed) {
        const signedPrefix = it.value && it.value.startsWith('-') ? '-' : parsed.prefix;
        numNode = `<div class="num" data-anim="fade" data-start="${start.toFixed(2)}" data-duration="0.8" data-count-from="0" data-count-to="${parsed.num}" data-count-decimals="${parsed.decimals}" data-count-prefix="${signedPrefix}" data-count-suffix="${esc(parsed.suffix)}">${esc(parsed.prefix + parsed.num.toFixed(parsed.decimals) + parsed.suffix)}</div>`;
      } else {
        numNode = `<div class="num" data-anim="fade-up" data-start="${start.toFixed(2)}" data-duration="0.6">${esc(it.value || it.name)}</div>`;
      }
      return `<div class="cell${fullCls}" data-anim="rise" data-start="${start.toFixed(2)}" data-duration="0.6" data-ease="expo">
        <div class="lbl">${esc(it.name)}</div>
        ${numNode}
        ${it.sub ? `<div class="sub">${esc(it.sub)}</div>` : ''}
      </div>`;
    }).join('');
    return `<div class="page" ${pageDataAttrs(slot)}>${cells}</div>`;
  }).join('');
  // Swiss 结构线开场自己画出来(横线左→右,竖线 fade),几何形状随后 pop,排版骨架先于内容立住
  const body = `
    <div class="swiss-line h" style="top:382px" data-anim="wipe-right" data-start="0.05" data-duration="0.6"></div>
    <div class="swiss-line h" style="bottom:128px" data-anim="wipe-left" data-start="0.15" data-duration="0.6"></div>
    <div class="swiss-line v" style="left:50%" data-anim="fade" data-start="0.35" data-duration="0.5"></div>
    <div id="swiss-circle" data-anim="pop" data-start="0.5" data-duration="0.7" data-ease="back"></div>
    <div id="swiss-square" data-anim="fade" data-start="0.6" data-duration="0.5"><div style="width:100%;height:100%;background:inherit" data-loop="spin" data-loop-period="24"></div></div>
    <div id="title" data-fit data-fit-maxh="122" data-fit-min="40" data-anim="slide-in-left" data-start="0.2" data-duration="0.6" data-ease="expo">${esc(spec.title || '数据看板')}<span class="dot">.</span></div>
    ${spec.subtitle ? `<div id="subtitle" data-anim="fade" data-start="0.5" data-duration="0.6">${esc(spec.subtitle)}</div>` : ''}
    <div id="grid-area">${pages}</div>
    ${pageFlashesHtml(slots.map((s) => s.pageStartSec))}
    <div class="fx-grain"></div>`;
  return wrapTemplateHtml({
    bodyHtml: body, css, brandColor: spec.brandColor,
    durationSec: spec.durationSec, fps: spec.fps, captionCues: spec.captions,
  });
}

// ── 精品模板 6:竖向时间轴 / 里程碑(timeline)── 左侧轴线 + 节点,逐条揭示 ────────
// 适合:发展历程 / 路线图 / 步骤流程 / 大事记。每页 5 个节点,超了分页。
function renderTimeline(spec: TemplateSpec): string {
  const accent = spec.accentColor || '#0ecb81';
  const PAGE = 5;
  const css = `
#title{position:absolute;top:150px;left:96px;right:80px;text-align:left;font-size:70px;font-weight:900;color:#fff;line-height:1.16}
#title .dot{color:${accent}}
#tl-area{position:absolute;top:330px;left:96px;right:70px;bottom:140px}
#tl-rail{position:absolute;left:44px;top:10px;bottom:10px;width:4px;background:linear-gradient(${spec.brandColor},${accent});border-radius:4px}
.page{position:absolute;inset:0}
.node{position:absolute;left:0;right:0;display:flex;align-items:flex-start}
.node .dot{flex:0 0 auto;width:92px;display:flex;justify-content:center;position:relative;z-index:2}
.node .dot b{width:56px;height:56px;border-radius:50%;background:${spec.brandColor};border:4px solid #0b0e11;box-shadow:0 0 0 4px ${accent}55;display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:900;color:#0b0e11}
.node .card{flex:1;min-width:0;margin-left:14px;background:linear-gradient(135deg,#181b21,#1f2329);border:1px solid #2b2f36;border-radius:22px;box-shadow:0 10px 30px rgba(0,0,0,0.32);padding:26px 34px}
.node .nm{font-size:44px;font-weight:800;line-height:1.2;overflow:hidden}
.node .sb{font-size:28px;color:#9aa2b1;margin-top:10px;line-height:1.4;overflow:hidden}
`;
  const slots = paginate(spec.items, PAGE, spec.durationSec, spec.pageTimings);
  const pages = slots.map((slot) => {
    const n = Math.max(1, slot.items.length);
    const nodes = slot.items.map((it, i) => {
      const start = slot.pageStartSec + 0.25 + i * 0.2;
      const topPct = (i / n) * 100;
      const hPct = 100 / n;
      const sub = it.sub || it.value || '';
      return `<div class="node" style="top:${topPct.toFixed(2)}%;height:${hPct.toFixed(2)}%" data-anim="fade-left" data-start="${start.toFixed(2)}" data-duration="0.55" data-ease="expo">
        <div class="dot"><b>${(it.rank ?? (slot.pageIndex * PAGE + i + 1))}</b></div>
        <div class="card"><div class="nm" data-fit data-fit-maxh="120" data-fit-min="28">${esc(it.name)}</div>${sub ? `<div class="sb" data-fit data-fit-maxh="90" data-fit-min="22">${esc(sub)}</div>` : ''}</div>
      </div>`;
    }).join('');
    return `<div class="page" ${pageDataAttrs(slot)}><div id="tl-rail"></div>${nodes}</div>`;
  }).join('');
  const body = `<div id="title" data-fit data-fit-maxh="150" data-fit-min="40" data-anim="slide-in-left" data-start="0.1" data-duration="0.6" data-ease="expo">${esc(spec.title || '发展历程')}<span class="dot">.</span></div>
  <div id="tl-area">${pages}</div>
  ${pageFlashesHtml(slots.map((s) => s.pageStartSec))}
  <div class="fx-grain"></div>`;
  return wrapTemplateHtml({
    bodyHtml: body, css, brandColor: spec.brandColor,
    durationSec: spec.durationSec, fps: spec.fps, captionCues: spec.captions,
  });
}

// ── 精品模板 7:大字封面 / 开场(cover_hero)── 巨型逐字标题 + 副题 + 最多 3 个亮点条 ──
// 适合:单主题重磅开场 / 标题党 / 主题海报。单页,不分页(只用前 3 条 items 当亮点)。
function renderCoverHero(spec: TemplateSpec): string {
  const accent = spec.accentColor || '#0ecb81';
  const chips = spec.items.slice(0, 3);
  const css = `
#ch-glow{position:absolute;inset:0;background:radial-gradient(70% 42% at 50% 38%,${spec.brandColor}22 0%,transparent 62%);pointer-events:none}
#ch-kicker{position:absolute;top:360px;left:80px;right:80px;text-align:center;font-size:38px;font-weight:800;letter-spacing:10px;color:${accent}}
#ch-title{position:absolute;top:470px;left:70px;right:70px;text-align:center;font-size:150px;font-weight:900;line-height:1.06;color:#fff;text-shadow:0 10px 40px rgba(0,0,0,0.6)}
#ch-sub{position:absolute;top:900px;left:120px;right:120px;text-align:center;font-size:46px;font-weight:600;color:#c7ccd4;line-height:1.4}
#ch-chips{position:absolute;left:100px;right:100px;bottom:300px;display:flex;flex-direction:column;gap:26px}
.ch-chip{display:flex;align-items:center;gap:24px;background:linear-gradient(135deg,#181b21,#1f2329);border:1px solid #2b2f36;border-radius:20px;padding:26px 36px;box-shadow:0 10px 30px rgba(0,0,0,0.3)}
.ch-chip .k{flex:0 0 auto;width:16px;height:56px;border-radius:6px;background:${accent}}
.ch-chip .tx{flex:1;min-width:0;font-size:42px;font-weight:800;line-height:1.2;overflow:hidden}
.ch-chip .v{flex:0 0 auto;font-size:48px;font-weight:900;color:${accent};white-space:nowrap}
`;
  const chipHtml = chips.map((it, i) => {
    const start = 1.0 + i * 0.28;
    return `<div class="ch-chip" data-anim="slide-in-right" data-start="${start.toFixed(2)}" data-duration="0.55" data-ease="expo">
      <div class="k"></div><div class="tx" data-fit data-fit-maxh="110" data-fit-min="26">${esc(it.name)}</div>${it.value ? `<div class="v" data-fit data-fit-maxw="240" data-fit-min="26">${esc(it.value)}</div>` : ''}
    </div>`;
  }).join('');
  const kicker = spec.subtitle ? esc(spec.subtitle) : '';
  const body = `<div id="ch-glow"></div>
  ${liquidBlobsHtml(spec.brandColor, accent)}
  ${kicker ? `<div id="ch-kicker" data-anim="fade-down" data-start="0.2" data-duration="0.6">${kicker}</div>` : ''}
  <div id="ch-title" data-fit data-fit-maxh="380" data-fit-min="72">${splitKinetic(spec.title || '重磅', 0.4, { stagger: 0.06, anim: 'pop', ease: 'back', duration: 0.6 })}</div>
  ${chipHtml ? `<div id="ch-chips">${chipHtml}</div>` : ''}
  <div class="fx-vignette"></div><div class="fx-grain"></div>`;
  return wrapTemplateHtml({
    bodyHtml: body, css, brandColor: spec.brandColor,
    durationSec: spec.durationSec, fps: spec.fps, captionCues: spec.captions,
  });
}

// ── 精品模板 8:逐条全屏大字(billboard)── 每条 item 一整屏居中大字,逐条切换 ──────
// 适合:金句连发 / 要点逐条强调 / 数字逐个揭晓。每页 1 条(N 条 = N 页轮播)。
function renderBillboard(spec: TemplateSpec): string {
  const accent = spec.accentColor || '#0ecb81';
  const css = `
#bb-idx{position:absolute;top:150px;left:0;right:0;text-align:center;font-size:40px;font-weight:900;letter-spacing:8px;color:${accent}}
#bb-area{position:absolute;top:0;left:0;right:0;bottom:0}
.page{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:0 110px}
.bb-n{font-size:96px;font-weight:900;line-height:1.14;text-align:center;color:#fff;text-shadow:0 8px 34px rgba(0,0,0,0.55)}
.bb-v{font-size:120px;font-weight:900;color:${accent};margin-top:34px;line-height:1;text-shadow:0 6px 30px ${accent}44}
.bb-s{font-size:40px;font-weight:600;color:#9aa2b1;margin-top:30px;text-align:center;line-height:1.4}
.bb-rule{width:120px;height:6px;border-radius:6px;background:${spec.brandColor};margin:40px auto 0}
`;
  const slots = paginate(spec.items, 1, spec.durationSec, spec.pageTimings);
  const total = spec.items.length;
  const pages = slots.map((slot) => {
    const it = slot.items[0];
    if (!it) return '';
    const s0 = slot.pageStartSec + 0.15;
    const idx = slot.pageIndex + 1;
    return `<div class="page" ${pageDataAttrs(slot)}>
      <div class="bb-n" data-fit data-fit-maxh="520" data-fit-min="46" data-anim="fade-up" data-start="${s0.toFixed(2)}" data-duration="0.6" data-ease="expo">${esc(it.name)}</div>
      ${it.value ? `<div class="bb-v" data-fit data-fit-maxh="200" data-fit-min="54" data-anim="pop" data-start="${(s0 + 0.25).toFixed(2)}" data-duration="0.7" data-ease="back">${esc(it.value)}</div>` : ''}
      <div class="bb-rule" data-anim="wipe-right" data-start="${(s0 + 0.4).toFixed(2)}" data-duration="0.5"></div>
      ${it.sub ? `<div class="bb-s" data-fit data-fit-maxh="120" data-fit-min="24" data-anim="fade" data-start="${(s0 + 0.55).toFixed(2)}" data-duration="0.6">${esc(it.sub)}</div>` : ''}
      <div style="position:absolute;bottom:180px;left:0;right:0;text-align:center;font-size:34px;color:#5e6673;letter-spacing:6px">${idx} / ${total}</div>
    </div>`;
  }).join('');
  const body = `${liquidBlobsHtml(spec.brandColor, accent)}
  <div id="bb-idx" data-anim="fade" data-start="0.1" data-duration="0.5">${esc(spec.title || '')}</div>
  <div id="bb-area">${pages}</div>
  ${pageFlashesHtml(slots.map((s) => s.pageStartSec))}
  <div class="fx-vignette"></div><div class="fx-grain"></div>`;
  return wrapTemplateHtml({
    bodyHtml: body, css, brandColor: spec.brandColor,
    durationSec: spec.durationSec, fps: spec.fps, captionCues: spec.captions,
  });
}

/** 按 style 渲染精品模板 → 完整 HTML(含 paused seek 协议)。 */
export function renderTemplate(spec: TemplateSpec): string {
  switch (spec.style) {
    case 'rank_list':
      return renderRankList(spec);
    case 'quote':
      return renderQuote(spec);
    case 'news_cards':
      return renderNewsCards(spec);
    case 'countdown':
      return renderCountdown(spec);
    case 'stat_board':
      return renderStatBoard(spec);
    case 'timeline':
      return renderTimeline(spec);
    case 'cover_hero':
      return renderCoverHero(spec);
    case 'billboard':
      return renderBillboard(spec);
    default:
      return renderNewsCards(spec);
  }
}
