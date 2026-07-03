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
import { pickTheme, THEME_BY_ID, type Theme } from './themes';
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
  type: 'heroTitle' | 'bullets' | 'ranks' | 'stats' | 'bigStat' | 'quote' | 'tags' | 'steps' | 'paragraph' | 'chart';
  /** chart 专用:折线(line,趋势)或柱状(bar,对比)。缺省 line。 */
  chartKind?: 'line' | 'bar';
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
  /** AI 建议的设计主题 id(themes.ts);ctx.themeId(用户/pipeline 显式指定)优先级更高。 */
  themeId?: string;
  blocks: SceneBlock[];
}

export interface ComposeCtx {
  brandColor: string;
  accentColor: string;
  durationSec: number;
  narrationOn: boolean;
  captionsOn: boolean;
  /** 指定设计主题 id(themes.ts);不传则按内容气质自动挑。 */
  themeId?: string;
  /** renderScene 内部按主题回填(渲染 block/chart 用):次要色 + 明暗模式。 */
  mutedColor?: string;
  mode?: 'light' | 'dark';
}

export interface SceneResult {
  css: string;
  bodyHtml: string;
  setupScript?: string;
}

// ── 类型默认纵向权重(决定各 block 分到多少高度)──────────────────────────
const DEFAULT_WEIGHT: Record<SceneBlock['type'], number> = {
  heroTitle: 1.1, bigStat: 1.4, quote: 2.2, paragraph: 1.6,
  bullets: 2.6, ranks: 2.8, stats: 2.4, steps: 2.6, tags: 0.9, chart: 3.0,
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
        `<div class="big-n" data-fit data-fit-grow data-fit-max="${Math.round(H * 0.62)}" data-fit-maxh="${Math.round(H * 0.62)}" data-fit-min="60" data-anim="pop" data-start="${s0.toFixed(2)}" data-duration="0.8" data-ease="back" style="color:${accent}">${val}</div>`
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
      const rowGap = 14;
      // 行高封顶(防 3-4 条平分一大带 → 每张卡巨高、内容飘在中间显得很小);封顶后整组纵向居中。
      const rowCap = b.type === 'stats' ? 240 : 200;
      const rowH = Math.min(rowCap, Math.floor((H - (n - 1) * rowGap) / n));
      const usedH = n * rowH + (n - 1) * rowGap;
      const yOff = Math.max(0, Math.round((H - usedH) / 2));
      const rows = items.map((it, i) => {
        const st = (s0 + i * band.itemStagger).toFixed(2);
        const rowTop = yOff + i * (rowH + rowGap);
        const name = esc((it.name || '').slice(0, 60));
        const val = it.value ? esc(it.value.slice(0, 20)) : '';
        const sub = it.sub ? esc(it.sub.slice(0, 50)) : '';
        if (b.type === 'stats') {
          // 数值大字【自动放大填满卡】(data-fit-grow),标签只在有 name 时才渲染(AI 只给数值时不留空标签)。
          const hasLab = !!name && name !== val;
          const valMax = Math.round(rowH * (hasLab ? 0.6 : 0.72));
          return `<div class="s-row" style="top:${rowTop}px;height:${rowH}px" data-anim="rise" data-start="${st}" data-duration="0.55" data-ease="expo">`
            + `<div class="s-val" data-fit data-fit-grow data-fit-max="${valMax}" data-fit-maxh="${valMax}" data-fit-min="40" style="color:${accent}">${val || name}</div>`
            + (hasLab ? `<div class="s-lab" data-fit data-fit-maxh="${Math.round(rowH * 0.28)}" data-fit-min="20">${name}</div>` : '')
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
    case 'chart':
      return wrap(renderChart(b, H, ctx));
    default:
      return '';
  }
}

/** 从显示串抽数值(去掉 +/-/%/单位):"+18.96%"→18.96,"1.2亿"→1.2。取不到=0。 */
function numOf(raw: string | undefined): number {
  if (!raw) return 0;
  const m = String(raw).match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : 0;
}

/**
 * 真图表原语(抄 NYT Data Chart 折线 + Pentagram 柱状,配色随主题):手绘 SVG,坐标由 JS 算,
 * 确定性、可逐帧渲染。数据类内容不再堆数字卡 —— 画真图。items:[{name=x轴标签, value=y值}]。
 */
function renderChart(b: SceneBlock, H: number, ctx: ComposeCtx): string {
  const ink = ctx.brandColor, accent = ctx.accentColor, muted = ctx.mutedColor || '#888';
  const mono = 'font-family:inherit';
  const pts = (b.items || []).slice(0, 9).map((it) => ({ label: esc((it.name || '').slice(0, 8)), v: numOf(it.value), raw: esc((it.value || '').slice(0, 10)) }));
  if (pts.length < 2) return `<div class="ch-empty" style="color:${muted};text-align:center;padding-top:${Math.round(H / 2 - 30)}px">—</div>`;
  const W = INNER_W;
  const padL = 24, padR = 90, padT = 46, padB = 76;
  const cw = W - padL - padR, ch = H - padT - padB;
  const vals = pts.map((p) => p.v);
  const maxV = Math.max(...vals), minV = Math.min(0, ...vals);
  const range = (maxV - minV) || 1;
  const X = (i: number) => padL + (i / (pts.length - 1)) * cw;
  const Y = (v: number) => padT + ch - ((v - minV) / range) * ch;
  const kind = b.chartKind === 'bar' ? 'bar' : 'line';
  const s0 = 0.5;

  // Y 轴 3 条网格线 + 刻度
  const gridN = 3;
  let grid = '';
  for (let g = 0; g <= gridN; g++) {
    const gv = minV + (range * g) / gridN;
    const gy = Y(gv);
    grid += `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${(W - padR).toFixed(1)}" y2="${gy.toFixed(1)}" stroke="${muted}" stroke-width="0.5" opacity="0.28"/>`;
    grid += `<text x="${padL - 6}" y="${(gy - 6).toFixed(1)}" fill="${muted}" font-size="20" style="${mono}">${gv >= 1000 ? Math.round(gv / 1000) + 'k' : Math.round(gv)}</text>`;
  }
  // X 轴标签
  let xlab = '';
  pts.forEach((p, i) => { xlab += `<text x="${X(i).toFixed(1)}" y="${(padT + ch + 34).toFixed(1)}" fill="${muted}" font-size="20" text-anchor="middle" style="${mono}">${p.label}</text>`; });

  let body = '';
  if (kind === 'bar') {
    const bw = Math.min(cw / pts.length * 0.55, 120);
    pts.forEach((p, i) => {
      const bx = X(i) - bw / 2, by = Y(p.v), bh = padT + ch - by;
      const isMax = p.v === maxV;
      body += `<rect x="${bx.toFixed(1)}" y="${(padT + ch).toFixed(1)}" width="${bw.toFixed(1)}" height="0" rx="4" fill="${isMax ? accent : ink}" opacity="${isMax ? '0.95' : '0.85'}" data-anim="grow-bar" data-start="${(s0 + i * 0.08).toFixed(2)}" data-duration="0.6" data-bar-y="${by.toFixed(1)}" data-bar-h="${bh.toFixed(1)}"/>`;
      body += `<text x="${X(i).toFixed(1)}" y="${(by - 14).toFixed(1)}" fill="${isMax ? accent : ink}" font-size="26" font-weight="800" text-anchor="middle" data-anim="fade" data-start="${(s0 + i * 0.08 + 0.3).toFixed(2)}">${p.raw}</text>`;
    });
  } else {
    const linePts = pts.map((p, i) => `${X(i).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' ');
    const areaD = `M ${X(0).toFixed(1)} ${(padT + ch).toFixed(1)} ` + pts.map((p, i) => `L ${X(i).toFixed(1)} ${Y(p.v).toFixed(1)}`).join(' ') + ` L ${X(pts.length - 1).toFixed(1)} ${(padT + ch).toFixed(1)} Z`;
    // 末段用强调色实心加粗(拐点),前段主色
    const lastTwo = pts.slice(-2).map((p, i) => `${X(pts.length - 2 + i).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' ');
    body += `<path d="${areaD}" fill="${accent}" fill-opacity="0.08" data-anim="fade" data-start="${s0.toFixed(2)}"/>`;
    body += `<polyline points="${linePts}" fill="none" stroke="${ink}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" data-anim="fade" data-start="${s0.toFixed(2)}" data-duration="0.8"/>`;
    body += `<polyline points="${lastTwo}" fill="none" stroke="${accent}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round" data-anim="fade" data-start="${(s0 + 0.5).toFixed(2)}"/>`;
    pts.forEach((p, i) => {
      const last = i >= pts.length - 2;
      body += `<circle cx="${X(i).toFixed(1)}" cy="${Y(p.v).toFixed(1)}" r="${last ? 8 : 5}" fill="${last ? accent : ink}" data-anim="pop" data-start="${(s0 + i * 0.06 + 0.2).toFixed(2)}" data-duration="0.4"/>`;
      if (last) body += `<text x="${X(i).toFixed(1)}" y="${(Y(p.v) - 20).toFixed(1)}" fill="${accent}" font-size="26" font-weight="800" text-anchor="middle" data-anim="fade" data-start="${(s0 + i * 0.06 + 0.4).toFixed(2)}">${p.raw}</text>`;
    });
  }
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="100%" style="overflow:visible">${grid}${body}${xlab}</svg>`;
}

/** 主题优先级:ctx.themeId(用户/pipeline 显式)> scene.themeId(AI 建议)> 内容气质自动挑。 */
function resolveTheme(scene: Scene, ctx: ComposeCtx): Theme {
  if (ctx.themeId && THEME_BY_ID[ctx.themeId]) return THEME_BY_ID[ctx.themeId];
  if (scene.themeId && THEME_BY_ID[scene.themeId]) return THEME_BY_ID[scene.themeId];
  const text = [scene.mood || '', ...(scene.blocks || []).flatMap((b) => [b.text || '', ...(b.items || []).map((i) => i.name || '')])].join(' ');
  return pickTheme({ text });
}

/** 场景 → {css, bodyHtml}。确定性铺带 + data-fit 兜底 + 设计主题(审美层),永不塌。 */
export function renderScene(scene: Scene, ctx: ComposeCtx): SceneResult {
  const theme = resolveTheme(scene, ctx);
  // 把 block 渲染用的两个色映射到主题:标题用 ink(浅底=深字),数字/装饰用 accent。
  const tctx: ComposeCtx = { ...ctx, brandColor: theme.ink, accentColor: theme.accent, mutedColor: theme.muted, mode: theme.mode };
  const bottom = ctx.captionsOn ? BOTTOM_CAPTION : BOTTOM_NOCAP;
  const regionH = bottom - CONTENT_TOP;
  const blocks = (scene.blocks || []).filter((b) => b && b.type).slice(0, 6);
  const bg = themeBgHtml(theme);
  if (blocks.length === 0) {
    return { css: baseCss(theme), bodyHtml: bg + `<div class="blk" style="top:${CONTENT_TOP}px;height:200px"><div class="hero-t">·</div></div>` };
  }
  // 纵向按权重分带,预留 block 间 GAP
  const weights = blocks.map((b) => cl(b.weight ?? DEFAULT_WEIGHT[b.type] ?? 1.5, 0.6, 4));
  const totalW = weights.reduce((a, c) => a + c, 0);
  const usableH = regionH - GAP * (blocks.length - 1);
  let cursor = CONTENT_TOP;
  const parts: string[] = [];
  blocks.forEach((b, i) => {
    const h = Math.max(120, Math.round((weights[i] / totalW) * usableH));
    const blockStart = ctx.narrationOn ? cl(0.4 + (i / Math.max(1, blocks.length)) * ctx.durationSec * 0.5, 0.4, ctx.durationSec - 1) : 0.3 + i * 0.35;
    const isList = ['bullets', 'ranks', 'stats', 'steps'].includes(b.type);
    const itemCount = Math.max(1, (b.items || []).length);
    const itemStagger = ctx.narrationOn && isList
      ? cl((ctx.durationSec - blockStart - 1) / itemCount, 0.2, 1.2)
      : 0.14;
    parts.push(renderBlock(b, { top: cursor, height: h, index: i, startSec: blockStart, itemStagger }, tctx));
    cursor += h + GAP;
  });
  return { css: baseCss(theme), bodyHtml: bg + parts.join('\n') };
}

/** 主题背景层 + 角落元信息标签(装饰,增强编辑设计感)。 */
function themeBgHtml(theme: Theme): string {
  const layer = (theme.bgLayerHtml || '').replace(/\{\{ACCENT\}\}/g, theme.accent);
  const corner = theme.cornerLabel ? `<div class="th-corner">${esc(theme.cornerLabel)}</div>` : '';
  return layer + corner;
}

/** 从主题 token 生成全部 block CSS(颜色/字体/卡片风格皆随主题)。 */
function baseCss(theme: Theme): string {
  const { ink, muted, accent } = theme;
  const isDark = theme.mode === 'dark';
  const tShadow = isDark ? '0 6px 26px rgba(0,0,0,0.5)' : 'none';   // 文字阴影只在暗底给,浅底不给(显脏)
  // 卡片视觉:flat=无卡(靠 extraCss 画规则线);其余=主题卡背景+描边+阴影+圆角
  const card = theme.blockStyle === 'flat'
    ? 'background:transparent;border:none;box-shadow:none;border-radius:0'
    : `background:${theme.cardBg};border:1px solid ${theme.cardBorder};box-shadow:${theme.cardShadow};border-radius:${theme.cardRadius}px`;
  const badgeInk = isDark ? '#0b0e11' : '#ffffff';  // 序号圆点里的字色(暗底主题用深、浅底用白)
  const tagBg = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)';
  return `
html,body{background:${theme.bg};color:${ink}}
#stage{background:${theme.bg}}
.bg-grid,.bg-glow{display:${isDark ? 'block' : 'none'}}
#stage,.blk,.blk *{font-family:${theme.fontBody}}
.blk{position:absolute;left:${SAFE_L}px;width:${INNER_W}px;overflow:hidden}
.hero-t{font-family:${theme.fontTitle};font-size:96px;font-weight:${theme.titleWeight};line-height:1.12;text-align:center;letter-spacing:${theme.titleLetterSpacing};color:${ink};text-shadow:${tShadow}${theme.titleUpper ? ';text-transform:uppercase' : ''}}
.hero-s{font-size:44px;font-weight:${theme.labelWeight};color:${muted};line-height:1.3;text-align:center;letter-spacing:4px;margin-top:20px}
.big-n{font-family:${theme.fontTitle};font-size:240px;font-weight:${theme.titleWeight};line-height:1;text-align:center;letter-spacing:-4px;color:${accent}}
.big-l{font-size:44px;font-weight:${theme.labelWeight};color:${muted};text-align:center;margin-top:16px;line-height:1.3}
.q-mark{font-family:Georgia,'Times New Roman',${theme.fontTitle};font-size:200px;line-height:0.5;color:${accent};opacity:0.35;text-align:center}
.q-t{font-family:${theme.fontTitle};font-size:64px;font-weight:${Math.max(600, theme.titleWeight - 100)};line-height:1.5;text-align:center;margin-top:26px;color:${ink};text-shadow:${tShadow}}
.q-a{font-size:36px;color:${muted};text-align:center;margin-top:26px;letter-spacing:3px;font-style:italic}
.para{font-size:46px;font-weight:${theme.labelWeight};line-height:1.55;color:${ink};text-align:left}
.tagrow{display:flex;flex-wrap:wrap;gap:22px;align-content:center;justify-content:center;height:100%}
.tag{display:inline-flex;align-items:center;font-size:40px;font-weight:700;padding:14px 34px;border-radius:999px;border:2px solid;background:${tagBg};color:${ink}}
.listwrap{position:relative;width:100%;height:100%}
.r-row{position:absolute;left:0;right:0;display:flex;align-items:center;padding:0 40px;${card};overflow:hidden}
.r-badge{flex:0 0 auto;width:78px;height:78px;border-radius:50%;border:2px solid;display:flex;align-items:center;justify-content:center;font-size:42px;font-weight:900;margin-right:26px}
.r-bar{flex:0 0 auto;width:10px;height:64%;border-radius:6px;margin-right:30px}
.r-body{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center}
.r-nm{font-size:48px;font-weight:800;line-height:1.16;color:${ink};overflow:hidden}
.r-sb{font-size:28px;color:${muted};margin-top:6px;line-height:1.2;overflow:hidden}
.r-val{flex:0 0 auto;font-family:${theme.fontTitle};font-size:56px;font-weight:900;text-align:right;margin-left:22px;white-space:nowrap}
.s-row{position:absolute;left:0;right:0;display:flex;flex-direction:column;justify-content:center;align-items:center;${card}}
.s-val{font-family:${theme.fontTitle};font-size:88px;font-weight:${theme.titleWeight};line-height:1;text-align:center}
.s-lab{font-size:32px;color:${muted};margin-top:10px;text-align:center;line-height:1.2}
.st-row{position:absolute;left:0;right:0;display:flex;align-items:center;padding-left:6px}
.st-dot{flex:0 0 auto;width:66px;height:66px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:36px;font-weight:900;color:${badgeInk};margin-right:28px}
.st-body{flex:1;min-width:0}
.st-nm{font-size:46px;font-weight:800;line-height:1.18;color:${ink};overflow:hidden}
.st-sb{font-size:28px;color:${muted};margin-top:6px;line-height:1.25;overflow:hidden}
.th-corner{position:absolute;top:64px;right:${SAFE_R}px;font-family:${theme.fontMono};font-size:22px;letter-spacing:4px;color:${muted};opacity:0.7;text-transform:uppercase;z-index:5}
${theme.extraCss}
`;
}

// ── AI 场景生成 ──────────────────────────────────────────────────────────────
const SCENE_SYSTEM = [
  '你是短视频信息版式设计师。把用户内容整理成【一屏竖屏画面的场景 JSON】,只输出严格 JSON(json),不要解释、不要 markdown。',
  '结构:{"blocks":[ <2~5 个 block> ]}。每个 block 从下列【固定安全原语】里选一种(我们会把它铺进不塌的版式,你只管选类型 + 填内容):',
  '- {"type":"heroTitle","text":"大标题(≤20字)","sub":"副题(可选,≤28字)"} —— 开场/主题,一屏最多 1 个,放最上面。',
  '- {"type":"bullets","items":[{"name":"要点","value":"数值(可选)","sub":"说明(可选)"}]} —— 无序要点/清单(≤6 条)。',
  '- {"type":"ranks","items":[{"rank":1,"name":"名称","value":"数值","sub":"说明(可选)"}]} —— 排行榜/盘点(≤6 条,带名次)。',
  '- {"type":"stats","items":[{"value":"98.4%","name":"这个数值的含义"}]} —— 关键指标卡(≤4 个,突出大数字)。**每项都要给 name(该数值的标签/含义),别只给孤零零的数字。**',
  '- {"type":"bigStat","text":"1.2亿","sub":"标签说明"} —— 单个核心大数字,冲击力强。',
  '- {"type":"steps","items":[{"name":"步骤/阶段","sub":"说明(可选)"}]} —— 流程/步骤/时间线(≤5 条,带序号)。',
  '- {"type":"quote","text":"金句正文","sub":"作者(可选)"} —— 金句/观点。',
  '- {"type":"tags","tags":["标签1","标签2"]} —— 关键词标签云(≤10 个)。',
  '- {"type":"paragraph","text":"一段话(≤120字)"} —— 说明性段落。',
  '- {"type":"chart","chartKind":"line","items":[{"name":"2024","value":"310"},{"name":"2025","value":"468"}]} —— 【真图表】!有【趋势/逐年/走势】数据时用 line(折线),有【几项对比】用 bar(柱状)。items 是数据点(name=X轴标签, value=纯数值)。≥2 个点。有时间序列数据时【优先用 chart 而不是堆数字卡】。',
  '可选给每个 block 加 "weight":1~4 控制它占的高度(大数字/图表/榜单给大,标签给小)。',
  '可选在顶层给 "theme":"<主题id>" 指定设计主题(不给则按内容气质自动挑)。可选 id:swiss_grid(数据看板·灰底藏青金)/nyt_chart(趋势图表·奶油衬线)/pentagram(单指标大数字·白红)/vignelli(快讯速览·白红黑粗体)/bold_poster(海报宣言·暖纸番茄红)/build_minimal(金句极简·近白宋体)/warm_grain(资讯故事·米色暖)/takram(自然科普·米绿柔和)/glitch(故障赛博·黑青品红)/bold_signal(发布焦点·暗橙)/creative_voltage(创意电光·蓝)/midnight(web3暗色)。按内容气质选最搭的一套。',
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
  const VALID = new Set(['heroTitle', 'bullets', 'ranks', 'stats', 'bigStat', 'quote', 'tags', 'steps', 'paragraph', 'chart']);
  const blocks: SceneBlock[] = [];
  for (const raw of parsed.blocks) {
    if (!raw || typeof raw.type !== 'string' || !VALID.has(raw.type)) continue;
    const b: SceneBlock = { type: raw.type };
    if (typeof raw.text === 'string' && raw.text.trim()) b.text = raw.text.trim();
    if (typeof raw.sub === 'string' && raw.sub.trim()) b.sub = raw.sub.trim();
    if (typeof raw.weight === 'number' && Number.isFinite(raw.weight)) b.weight = raw.weight;
    if (raw.type === 'chart') b.chartKind = raw.chartKind === 'bar' ? 'bar' : 'line';
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
  const scene: Scene = { blocks: blocks.slice(0, 6) };
  // AI 可选给 theme(设计主题 id);合法就带上,由 renderScene 优先采用。
  if (typeof parsed.theme === 'string' && THEME_BY_ID[parsed.theme]) scene.themeId = parsed.theme;
  return scene;
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
  /** 用户在向导里显式选的设计主题 id;'auto'/空 = 交给 AI/内容气质自动挑。 */
  themeId?: string;
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
    // 用户显式选主题(非 auto)才透传;否则留空,由 scene.themeId(AI)/内容气质自动挑。
    themeId: input.themeId && input.themeId !== 'auto' ? input.themeId : undefined,
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
