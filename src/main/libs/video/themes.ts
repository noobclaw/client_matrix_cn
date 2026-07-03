/**
 * themes — 「模板速生」设计系统库(审美层)。
 *
 * 缘起:我们抄了 html-video / HyperFrames 的【引擎】(逐帧 seek + data-* + 不塌),但没抄它的
 * 【设计系统】——所以输出「结构对但穿均码地摊货」(深色科技渐变 + 荧光绿数字卡)。这里把它那套
 * 成品审美(浅底 + 展示字体 + 特色配色 + 装饰语言 + 编辑构图)搬成【可选主题】,让 sceneComposer /
 * 固定模板按内容气质挑一套渲染。
 *
 * 血源:HyperFrames = github.com/heygen-com/hyperframes(HeyGen,Apache-2.0);html-video =
 * nexu-io/html-video(其 fork,我们 clone 的这个)。以下主题的配色/字体/装饰 token 逐一从它
 * templates/frame-* 的真实 CSS 抽取、适配到我们 1080×1920 竖屏 + 中文内容。Apache-2.0 允许 port,
 * 保留出处见文件尾 ATTRIBUTION。
 *
 * 字体策略(避开 CJK 巨型字体):
 *   · 中文永远走系统字体,按主题切 serif/sans —— 编辑主题用【宋体】(Songti/SimSun,杂志感),
 *     粗体主题用【黑体】(PingFang/YaHei)重字重。这一步就吃掉大半「地摊感」,零内嵌。
 *   · Latin 展示字(Helvetica/Inter/Outfit…)优先用系统同类,内嵌字体(fontAsset)到位后自动升级。
 */

export type ThemeMode = 'light' | 'dark';
/** 卡片/块的视觉语言:sharp=直角+硬阴影(Swiss);rounded=圆角柔阴影(Warm);frost=磨砂玻璃(Takram);flat=无卡纯排版(Vignelli/Minimal);dark=暗色卡(midnight)。 */
export type BlockStyle = 'sharp' | 'rounded' | 'frost' | 'flat' | 'dark';

export interface Theme {
  id: string;
  name: string;
  mode: ThemeMode;
  /** 内容气质标签,供 AI/自动选主题匹配。 */
  moods: string[];

  // ── 配色 ──
  bg: string;            // 画布背景(纯色或渐变)
  ink: string;           // 主文字
  muted: string;         // 次要文字/说明
  accent: string;        // 主强调色(数字/高亮/装饰条)
  accent2?: string;      // 次强调色
  cardBg: string;        // 块/卡背景
  cardBorder: string;    // 块/卡描边

  // ── 字体 ──
  fontTitle: string;     // 标题字体栈(含中文回退)
  fontBody: string;      // 正文字体栈
  fontMono: string;      // 角标/元信息等宽字体栈
  titleWeight: number;   // 标题字重
  labelWeight: number;   // 说明/标签字重(拉开层级)
  titleUpper: boolean;   // 标题是否 uppercase(仅对 Latin 有意义)
  titleLetterSpacing: string; // 标题字距

  blockStyle: BlockStyle;
  /** 块阴影 CSS(整段 box-shadow 值)。 */
  cardShadow: string;
  /** 块圆角 px。 */
  cardRadius: number;

  /** 背景装饰层 HTML(网格/颗粒/wash 等,插到 stage 最底;可空)。用 {{ACCENT}} 占位。 */
  bgLayerHtml: string;
  /** 主题专属追加 CSS(装饰类等)。 */
  extraCss: string;
  /** 角落元信息标签文案(如 "FRAME · CHART");空=不显示。装饰性,增强"编辑设计"感。 */
  cornerLabel: string;
}

// 中文字体栈(系统级,按 serif/sans 切):
const CJK_SERIF = "'Songti SC','Noto Serif SC','Source Han Serif SC','SimSun','STSong'";
const CJK_SANS = "'PingFang SC','Microsoft YaHei','Noto Sans SC','Source Han Sans SC','Hiragino Sans GB'";
const CJK_ROUND = "'PingFang SC','Microsoft YaHei','Hiragino Sans GB'"; // 圆润无更好的系统圆体,退 PingFang

// ── 主题 1:Swiss Grid(数据/看板)—— 灰底 + 藏青金 + 制图网格 + 硬阴影直角 ──
const SWISS_GRID: Theme = {
  id: 'swiss_grid', name: 'Swiss Grid', mode: 'light',
  moods: ['数据', '看板', '指标', '严谨', '商务', '排行榜'],
  bg: '#f2f2f2', ink: '#0a1e3d', muted: '#5b6572', accent: '#d4a017', accent2: '#0a1e3d',
  cardBg: '#f2f2f2', cardBorder: 'rgba(10,30,61,0.12)',
  fontTitle: `'Helvetica Neue',Helvetica,Arial,${CJK_SANS},sans-serif`,
  fontBody: `'Helvetica Neue',Helvetica,Arial,${CJK_SANS},sans-serif`,
  fontMono: `'JetBrains Mono','SF Mono',Consolas,monospace`,
  titleWeight: 900, labelWeight: 400, titleUpper: false, titleLetterSpacing: '-1px',
  blockStyle: 'sharp', cardShadow: '20px 20px 0 rgba(10,30,61,0.10)', cardRadius: 0,
  bgLayerHtml: `<div class="th-swiss-grid"></div>`,
  extraCss: `
.th-swiss-grid{position:absolute;inset:0;pointer-events:none;
  background-image:linear-gradient(rgba(10,30,61,0.07) 1px,transparent 1px),linear-gradient(90deg,rgba(10,30,61,0.07) 1px,transparent 1px),linear-gradient(rgba(10,30,61,0.14) 2px,transparent 2px),linear-gradient(90deg,rgba(10,30,61,0.14) 2px,transparent 2px);
  background-size:60px 60px,60px 60px,240px 240px,240px 240px}
.blk .r-bar,.blk .st-dot{border-radius:0!important}
`,
  cornerLabel: 'FRAME · DATA',
};

// ── 主题 2:Vignelli(大字/榜单/宣言)—— 纯白 + Helvetica Black + 硬红 ──
const VIGNELLI: Theme = {
  id: 'vignelli', name: 'Vignelli', mode: 'light',
  moods: ['大字', '榜单', '宣言', '快讯', '冲击', '标题党'],
  bg: '#ffffff', ink: '#111111', muted: '#8a8a8a', accent: '#cc0000', accent2: '#111111',
  cardBg: '#ffffff', cardBorder: 'rgba(0,0,0,0.10)',
  fontTitle: `'Helvetica Neue',Helvetica,Arial,${CJK_SANS},sans-serif`,
  fontBody: `'Helvetica Neue',Helvetica,Arial,${CJK_SANS},sans-serif`,
  fontMono: `'JetBrains Mono','SF Mono',Consolas,monospace`,
  titleWeight: 900, labelWeight: 700, titleUpper: false, titleLetterSpacing: '-2px',
  blockStyle: 'flat', cardShadow: 'none', cardRadius: 0,
  bgLayerHtml: '',
  extraCss: `
.blk .r-row,.blk .s-row,.blk .st-row{background:transparent!important;border:none!important;box-shadow:none!important;border-top:3px solid rgba(0,0,0,0.12);border-radius:0!important;padding-left:0!important}
.blk .r-bar{width:16px!important;border-radius:0!important}
.blk .r-badge{border-radius:0!important;border-width:3px!important}
`,
  cornerLabel: '',
};

// ── 主题 3:Warm Grain(资讯/故事/温度)—— 米色纸 + 森绿/赭石/陶土 + 圆角柔块 ──
const WARM_GRAIN: Theme = {
  id: 'warm_grain', name: 'Warm Grain', mode: 'light',
  moods: ['资讯', '故事', '生活', '温度', '盘点', '要点'],
  bg: '#f5f0e0', ink: '#3a3226', muted: '#7a6248', accent: '#c45d3e', accent2: '#3b5e3a',
  cardBg: '#ffffff', cardBorder: 'rgba(58,50,38,0.10)',
  fontTitle: `'Outfit','Lexend','Segoe UI',${CJK_ROUND},sans-serif`,
  fontBody: `'Outfit','Lexend','Segoe UI',${CJK_ROUND},sans-serif`,
  fontMono: `'JetBrains Mono','SF Mono',Consolas,monospace`,
  titleWeight: 700, labelWeight: 400, titleUpper: false, titleLetterSpacing: '-1px',
  blockStyle: 'rounded', cardShadow: '0 15px 40px rgba(60,50,30,0.10)', cardRadius: 26,
  bgLayerHtml: `<div class="th-grain"></div>`,
  extraCss: `
.th-grain{position:absolute;inset:0;pointer-events:none;opacity:0.10;mix-blend-mode:multiply;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='180' height='180' filter='url(%23n)'/%3E%3C/svg%3E")}
`,
  cornerLabel: '',
};

// ── 主题 4:Build Minimal(金句/单点/高端留白)—— 近白 + 极细字 + 金色发丝线 ──
const BUILD_MINIMAL: Theme = {
  id: 'build_minimal', name: 'Build Minimal', mode: 'light',
  moods: ['金句', '单点', '开场', '高端', '极简', '观点'],
  bg: '#fafaf8', ink: '#1a1a18', muted: '#a8a4a0', accent: '#d4a574', accent2: '#1a1a18',
  cardBg: '#ffffff', cardBorder: 'rgba(26,26,24,0.08)',
  fontTitle: `'Inter','Segoe UI',${CJK_SERIF},serif`,
  fontBody: `'Inter','Segoe UI',${CJK_SERIF},serif`,
  fontMono: `'JetBrains Mono','SF Mono',Consolas,monospace`,
  titleWeight: 300, labelWeight: 300, titleUpper: false, titleLetterSpacing: '-3px',
  blockStyle: 'flat', cardShadow: 'none', cardRadius: 0,
  bgLayerHtml: `<div class="th-wash"></div>`,
  extraCss: `
.th-wash{position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse 900px 700px at 32% 30%,rgba(212,165,116,0.10) 0%,transparent 68%)}
.blk .r-row,.blk .s-row,.blk .st-row{background:transparent!important;border:none!important;box-shadow:none!important;border-bottom:1px solid rgba(26,26,24,0.10);border-radius:0!important}
`,
  cornerLabel: '',
};

// ── 主题 5:Midnight(暗色影院/科技)—— 保留原深色皮,作为其中一套(不再是唯一默认) ──
const MIDNIGHT: Theme = {
  id: 'midnight', name: 'Midnight', mode: 'dark',
  moods: ['科技', 'web3', '加密', '暗色', '影院', '硬核'],
  bg: 'radial-gradient(120% 60% at 50% 0%,#1c2026 0%,#0b0e11 55%)', ink: '#ffffff', muted: '#848e9c',
  accent: '#0ecb81', accent2: '#f0b90b',
  cardBg: 'linear-gradient(135deg,#181b21,#1f2329)', cardBorder: '#2b2f36',
  fontTitle: `${CJK_SANS},'Segoe UI',sans-serif`,
  fontBody: `${CJK_SANS},'Segoe UI',sans-serif`,
  fontMono: `'JetBrains Mono',Consolas,monospace`,
  titleWeight: 900, labelWeight: 600, titleUpper: false, titleLetterSpacing: '0',
  blockStyle: 'dark', cardShadow: '0 10px 30px rgba(0,0,0,0.32)', cardRadius: 26,
  bgLayerHtml: `<div class="bg-grid"></div>`,
  extraCss: ``,
  cornerLabel: '',
};

// ── 主题 6:NYT Chart(数据/趋势/图表)—— 报纸奶油底 + 黑发丝线 + NYT 红拐点 + 衬线大标题 ──
const NYT_CHART: Theme = {
  id: 'nyt_chart', name: 'NYT Chart', mode: 'light',
  moods: ['趋势', '图表', '增长', '走势', '折线', '统计', '数据'],
  bg: '#f7f5ee', ink: '#1a1a1a', muted: 'rgba(26,26,26,0.6)', accent: '#a91d1d', accent2: '#1a1a1a',
  cardBg: '#f7f5ee', cardBorder: 'rgba(26,26,26,0.12)',
  fontTitle: `'Instrument Serif','Source Serif Pro',Georgia,${CJK_SERIF},serif`,
  fontBody: `'IBM Plex Sans','Segoe UI',${CJK_SANS},sans-serif`,
  fontMono: `'IBM Plex Mono','JetBrains Mono',Consolas,monospace`,
  titleWeight: 500, labelWeight: 400, titleUpper: false, titleLetterSpacing: '-0.5px',
  blockStyle: 'flat', cardShadow: 'none', cardRadius: 0,
  bgLayerHtml: '',
  extraCss: `
.blk .r-row,.blk .s-row,.blk .st-row{background:transparent!important;border:none!important;box-shadow:none!important;border-bottom:1px solid rgba(26,26,26,0.14);border-radius:0!important}
.blk .hero-t{font-style:normal}
`,
  cornerLabel: 'FRAME · CHART',
};

// ── 主题 7:Pentagram(单指标/大数字)—— 纯白 + 巨型 Archivo 数字 + Pentagram 红 ──
const PENTAGRAM: Theme = {
  id: 'pentagram', name: 'Pentagram', mode: 'light',
  moods: ['单指标', '大数字', '一个数', '核心数据', 'KPI'],
  bg: '#ffffff', ink: '#000000', muted: '#999999', accent: '#e63946', accent2: '#000000',
  cardBg: '#ffffff', cardBorder: 'rgba(0,0,0,0.10)',
  fontTitle: `'Archivo','Helvetica Neue',Arial,${CJK_SANS},sans-serif`,
  fontBody: `'Archivo','Helvetica Neue',Arial,${CJK_SANS},sans-serif`,
  fontMono: `'JetBrains Mono','SF Mono',Consolas,monospace`,
  titleWeight: 900, labelWeight: 700, titleUpper: false, titleLetterSpacing: '-4px',
  blockStyle: 'flat', cardShadow: 'none', cardRadius: 0,
  bgLayerHtml: '',
  extraCss: `
.blk .r-row,.blk .s-row,.blk .st-row{background:transparent!important;border:none!important;box-shadow:none!important;border-top:2px solid rgba(0,0,0,0.9);border-radius:0!important}
.blk .big-n,.blk .s-val{letter-spacing:-8px}
`,
  cornerLabel: '',
};

// ── 主题 8:Bold Poster(海报/宣言/态度)—— 暖纸 + 番茄红 + 展示体倾斜大字 ──
const BOLD_POSTER: Theme = {
  id: 'bold_poster', name: 'Bold Poster', mode: 'light',
  moods: ['海报', '态度', '宣言', '标语', '主张', '重磅'],
  bg: '#f5f2ef', ink: '#1c1410', muted: '#6b5d52', accent: '#d8000f', accent2: '#1c1410',
  cardBg: '#ffffff', cardBorder: 'rgba(28,20,16,0.12)',
  fontTitle: `'Shrikhand','Libre Baskerville',Georgia,${CJK_SERIF},serif`,
  fontBody: `'Space Grotesk','Segoe UI',${CJK_SANS},sans-serif`,
  fontMono: `'Space Grotesk','JetBrains Mono',Consolas,monospace`,
  titleWeight: 800, labelWeight: 700, titleUpper: false, titleLetterSpacing: '0',
  blockStyle: 'flat', cardShadow: 'none', cardRadius: 0,
  bgLayerHtml: '',
  extraCss: `
.blk .hero-t{transform:rotate(-2deg);transform-origin:left center}
.blk .r-row,.blk .s-row,.blk .st-row{background:transparent!important;border:none!important;box-shadow:none!important;border-top:2px solid rgba(28,20,16,0.85);border-radius:0!important}
`,
  cornerLabel: 'VOL · 01',
};

// ── 主题 9:Bold Signal(暗色焦点/科技发布)—— 深灰斜渐变 + 橙焦点 + Archivo Black ──
const BOLD_SIGNAL: Theme = {
  id: 'bold_signal', name: 'Bold Signal', mode: 'dark',
  moods: ['发布', '焦点', '暗色', '科技感', '公告'],
  bg: 'linear-gradient(135deg,#1a1a1a 0%,#2d2d2d 50%,#1a1a1a 100%)', ink: '#ffffff', muted: 'rgba(255,255,255,0.5)',
  accent: '#ff5722', accent2: '#ffffff',
  cardBg: '#ff5722', cardBorder: 'rgba(255,87,34,0.5)',
  fontTitle: `'Archivo Black','Archivo','Helvetica Neue',Arial,${CJK_SANS},sans-serif`,
  fontBody: `'Space Grotesk','Segoe UI',${CJK_SANS},sans-serif`,
  fontMono: `'Space Grotesk','JetBrains Mono',Consolas,monospace`,
  titleWeight: 900, labelWeight: 700, titleUpper: false, titleLetterSpacing: '-2px',
  blockStyle: 'dark', cardShadow: '-30px 24px 70px rgba(255,87,34,0.16)', cardRadius: 30,
  bgLayerHtml: '',
  extraCss: `
.bg-grid,.bg-glow{display:none}
.blk .s-row{background:#ff5722!important;border:none!important;color:#1a1a1a!important}
.blk .s-row .s-val{color:#1a1a1a!important} .blk .s-row .s-lab{color:rgba(26,26,26,0.75)!important}
`,
  cornerLabel: 'SIGNAL',
};

// ── 主题 10:Glitch(故障/赛博/信号)—— 近黑 + 青×品红色差 + 扫描线点阵 + 等宽 HUD ──
const GLITCH: Theme = {
  id: 'glitch', name: 'Glitch', mode: 'dark',
  moods: ['故障', '赛博', '信号', '黑客', '未来', '断电'],
  bg: '#0d0e10', ink: '#f5f5f7', muted: 'rgba(245,245,247,0.55)', accent: '#00f0ff', accent2: '#ff2bd6',
  cardBg: 'rgba(255,255,255,0.03)', cardBorder: 'rgba(0,240,255,0.25)',
  fontTitle: `'Space Grotesk','Segoe UI',${CJK_SANS},sans-serif`,
  fontBody: `'Space Grotesk','Segoe UI',${CJK_SANS},sans-serif`,
  fontMono: `'JetBrains Mono','SF Mono',Consolas,monospace`,
  titleWeight: 900, labelWeight: 500, titleUpper: false, titleLetterSpacing: '-2px',
  blockStyle: 'dark', cardShadow: 'none', cardRadius: 4,
  bgLayerHtml: `<div class="th-scan"></div><div class="th-dots"></div><div class="fx-vignette"></div>`,
  extraCss: `
.bg-grid,.bg-glow{display:none}
.th-scan{position:absolute;inset:0;pointer-events:none;z-index:3;mix-blend-mode:multiply;opacity:0.55;background-image:repeating-linear-gradient(0deg,rgba(0,0,0,0.18) 0px,rgba(0,0,0,0.18) 1px,transparent 1px,transparent 3px)}
.th-dots{position:absolute;inset:0;pointer-events:none;z-index:2;background-image:linear-gradient(rgba(0,255,180,0.05) 1px,transparent 1px),linear-gradient(90deg,rgba(0,255,180,0.05) 1px,transparent 1px);background-size:56px 56px}
.blk .hero-t{text-shadow:3px 0 0 rgba(255,43,214,0.6),-3px 0 0 rgba(0,240,255,0.6)}
.blk .r-row,.blk .s-row,.blk .st-row{background:rgba(255,255,255,0.03)!important;border:1px solid rgba(0,240,255,0.22)!important;box-shadow:none!important;border-radius:4px!important}
`,
  cornerLabel: 'REC ●',
};

// ── 主题 11:Creative Voltage(电光/创意/发布会)—— 深底 + 电蓝描边字 + 等宽机核 ──
const CREATIVE_VOLTAGE: Theme = {
  id: 'creative_voltage', name: 'Creative Voltage', mode: 'dark',
  moods: ['创意', '电光', '发布会', '潮流', '设计', '酷'],
  bg: 'linear-gradient(120deg,#2f4bff 0%,#2f4bff 44%,#0d0d14 44%,#0d0d14 100%)', ink: '#ffffff', muted: 'rgba(255,255,255,0.55)',
  accent: '#6f86ff', accent2: '#2f4bff',
  cardBg: 'rgba(255,255,255,0.05)', cardBorder: 'rgba(255,255,255,0.14)',
  fontTitle: `'Syne','Segoe UI',${CJK_SANS},sans-serif`,
  fontBody: `'Space Mono','Space Grotesk',${CJK_SANS},monospace`,
  fontMono: `'Space Mono','JetBrains Mono',Consolas,monospace`,
  titleWeight: 800, labelWeight: 700, titleUpper: false, titleLetterSpacing: '-3px',
  blockStyle: 'dark', cardShadow: 'none', cardRadius: 12,
  bgLayerHtml: `<div class="th-glow"></div>`,
  extraCss: `
.bg-grid,.bg-glow{display:none}
.th-glow{position:absolute;left:0;top:0;width:44%;height:100%;pointer-events:none;background:radial-gradient(circle at 30% 40%,rgba(255,255,255,0.16) 0%,transparent 55%)}
.blk .big-n,.blk .s-val{-webkit-text-stroke:2px #6f86ff;color:transparent}
`,
  cornerLabel: '// MODE · ON',
};

// ── 主题 12:Takram(自然/柔和/解释)—— 米绿 + 森绿陶土 + 磨砂圆卡 ──
const TAKRAM: Theme = {
  id: 'takram', name: 'Takram', mode: 'light',
  moods: ['自然', '柔和', '科普', '解释', '健康', '慢'],
  bg: '#efeae0', ink: '#2e2e28', muted: '#8a867c', accent: '#c98a5e', accent2: '#7a9e7f',
  cardBg: 'rgba(255,253,248,0.72)', cardBorder: 'rgba(255,255,255,0.8)',
  fontTitle: `'Manrope','Segoe UI',${CJK_ROUND},sans-serif`,
  fontBody: `'Manrope','Segoe UI',${CJK_ROUND},sans-serif`,
  fontMono: `'JetBrains Mono','SF Mono',Consolas,monospace`,
  titleWeight: 700, labelWeight: 400, titleUpper: false, titleLetterSpacing: '-2px',
  blockStyle: 'frost', cardShadow: '0 30px 80px rgba(120,110,90,0.12)', cardRadius: 34,
  bgLayerHtml: `<div class="th-wash"></div>`,
  extraCss: `
.th-wash{position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse 1000px 900px at 70% 45%,rgba(122,158,127,0.12) 0%,transparent 65%)}
`,
  cornerLabel: '',
};

export const THEMES: Theme[] = [
  SWISS_GRID, VIGNELLI, WARM_GRAIN, BUILD_MINIMAL, MIDNIGHT,
  NYT_CHART, PENTAGRAM, BOLD_POSTER, BOLD_SIGNAL, GLITCH, CREATIVE_VOLTAGE, TAKRAM,
];
export const THEME_BY_ID: Record<string, Theme> = Object.fromEntries(THEMES.map((t) => [t.id, t]));
export const DEFAULT_THEME = MIDNIGHT;

/** 按内容气质/语言挑一套主题。给了 preferId 就用它;否则按 mood 关键词粗匹配,兜底 Warm Grain(浅底最百搭)。 */
export function pickTheme(opts: { preferId?: string; text?: string }): Theme {
  if (opts.preferId && THEME_BY_ID[opts.preferId]) return THEME_BY_ID[opts.preferId];
  const t = (opts.text || '');
  // 关键词粗匹配(后续可换 AI 选主题)。顺序=优先级,越具体越靠前。
  if (/趋势|走势|逐年|增长曲线|同比|环比|折线|变化图/i.test(t)) return NYT_CHART;
  if (/故障|赛博|黑客|断电|信号|glitch|cyber/i.test(t)) return GLITCH;
  if (/币|web3|crypto|链上|BTC|ETH|代币|空投|钱包/i.test(t)) return MIDNIGHT;
  if (/名言|金句|观点|语录|感悟|道理|哲理/i.test(t)) return BUILD_MINIMAL;
  if (/宣言|态度|海报|主张|口号|标语/i.test(t)) return BOLD_POSTER;
  if (/发布|上线|重磅|首发|新品|亮相/i.test(t)) return BOLD_SIGNAL;
  if (/自然|健康|养生|科普|环保|慢生活|冥想/i.test(t)) return TAKRAM;
  if (/涨幅|排行|榜|top|指标|概率|百分|GDP|营收|季度|数据|统计/i.test(t)) return SWISS_GRID;
  if (/快讯|突发|速览|通报|事故|灾/i.test(t)) return VIGNELLI;
  if (/创意|设计|潮|酷|发布会/i.test(t)) return CREATIVE_VOLTAGE;
  return WARM_GRAIN;
}

/*
 * ATTRIBUTION — 以下主题的配色/字体/装饰 token 改编自 nexu-io/html-video(Apache-2.0),
 * 其本身 fork 自 heygen-com/hyperframes(Apache-2.0):
 *   Swiss Grid ← frame-swiss-grid   Vignelli ← frame-vignelli
 *   Warm Grain ← frame-warm-grain   Build Minimal ← frame-build-minimal(distilled from huashu-design, MIT)
 * 见 https://github.com/nexu-io/html-video 与 https://github.com/heygen-com/hyperframes
 */
