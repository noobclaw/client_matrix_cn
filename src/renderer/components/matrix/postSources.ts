/**
 * postSources — 矩阵发帖/图文类向导共用的「数据源」清单与工具。
 *
 * 一份源清单服务 5 个向导(facebook/instagram/reddit 发帖、x_post 数据源模式、image_text 数据源模式),
 * 之前 FB/Reddit 各自 inline 一份、改源名要改多处 → 抽到这里单一真相源。
 * hot 模式的 source 名必须与后端 /api/web3/hot-search 的 source 名精确一致(同旧 FB 向导注释)。
 *
 * 多选语义:任务存 sources: PostSourceSel[](运行时 orchestrator 每轮随机挑 1 个源取题);
 * 同时把【第一个选中源】写回旧单选字段 sourceKind/source/catKey —— 生产 orchestrator 未更新前旧字段照跑,
 * 老任务(只有单选字段)编辑时用 sourceIdsFromConfig 映射回数组。
 */

export interface PostSourceOption {
  id: string;
  kind: 'news' | 'category' | 'hot';
  source?: string;   // hot 模式:热搜源名(与后端一致)
  catKey?: string;   // category 模式:分类键(web3 / tech)
  zh: string;
  en: string;
  emoji: string;
}

/** 存进任务配置的单个源(向导选中项的精简形态,orchestrator 直接消费)。 */
export interface PostSourceSel {
  kind: 'news' | 'category' | 'hot';
  source?: string;
  catKey?: string;
}

export const POST_SOURCE_OPTIONS: PostSourceOption[] = [
  { id: 'web3', kind: 'news', zh: 'Web3 资讯(深度)', en: 'Web3 News (deep)', emoji: '🌐' },
  { id: 'tech', kind: 'category', catKey: 'tech', zh: '科技 / AI', en: 'Tech / AI', emoji: '🤖' },
  { id: 'weibo', kind: 'hot', source: '微博热搜', zh: '微博热搜', en: 'Weibo', emoji: '🔥' },
  { id: 'douyin', kind: 'hot', source: '抖音热搜', zh: '抖音热搜', en: 'Douyin', emoji: '🎵' },
  { id: 'zhihu', kind: 'hot', source: '知乎热榜', zh: '知乎热榜', en: 'Zhihu', emoji: '💭' },
  { id: 'baidu', kind: 'hot', source: '百度热搜', zh: '百度热搜', en: 'Baidu', emoji: '🔍' },
  { id: 'bilibili', kind: 'hot', source: 'B站热搜', zh: 'B站热搜', en: 'Bilibili', emoji: '📺' },
  { id: 'xueqiu', kind: 'hot', source: '雪球热门股', zh: '雪球热门股', en: 'Xueqiu', emoji: '📈' },
  { id: 'hackernews', kind: 'hot', source: 'Hacker News', zh: 'Hacker News', en: 'Hacker News', emoji: '🟠' },
  { id: 'reddit', kind: 'hot', source: 'Reddit', zh: 'Reddit 热门', en: 'Reddit', emoji: '👽' },
  { id: 'googletrends', kind: 'hot', source: 'Google 趋势', zh: 'Google 趋势', en: 'Google Trends', emoji: '📊' },
  { id: 'youtube', kind: 'hot', source: 'YouTube 热门', zh: 'YouTube 热门', en: 'YouTube', emoji: '▶️' },
];

export function postSourceById(id: string): PostSourceOption | undefined {
  return POST_SOURCE_OPTIONS.find((s) => s.id === id);
}

/**
 * 新建任务的数据源默认勾选(2026-07-11 拍板,配合「仅账号赛道相关」默认开——赛道过滤兜底,源敢全开):
 * 国外平台任务(x/FB/Reddit/IG/TikTok/YouTube/币安)默认【全部】源;国内平台任务默认除 Web3 外全勾。
 * 编辑老任务不受影响(sourceIdsFromConfig 优先读已存配置,这里只是兜底默认)。
 */
const OVERSEAS_PLATFORMS = new Set(['x', 'tiktok', 'youtube', 'facebook', 'instagram', 'reddit', 'binance']);
export function defaultSourceIdsFor(platform: string | undefined): string[] {
  const overseas = OVERSEAS_PLATFORMS.has(String(platform || ''));
  return POST_SOURCE_OPTIONS.filter((s) => overseas || s.id !== 'web3').map((s) => s.id);
}

/** 选中 id 列表 → 存盘的 sources 数组(过滤未知 id,保持点选顺序)。 */
export function selsFromSourceIds(ids: string[]): PostSourceSel[] {
  const out: PostSourceSel[] = [];
  for (const id of ids) {
    const o = postSourceById(id);
    if (o) out.push({ kind: o.kind, source: o.source, catKey: o.catKey });
  }
  return out;
}

function idOfSel(sel: { kind?: string; source?: string; catKey?: string }): string | undefined {
  if (!sel || !sel.kind) return undefined;
  if (sel.kind === 'news') return 'web3';
  if (sel.kind === 'category') return POST_SOURCE_OPTIONS.find((s) => s.kind === 'category' && s.catKey === (sel.catKey || 'tech'))?.id;
  return POST_SOURCE_OPTIONS.find((s) => s.kind === 'hot' && s.source === sel.source)?.id;
}

/**
 * 任务配置 → 选中 id 数组(编辑回填)。优先新 sources 数组;老任务只有单选 sourceKind/source/catKey
 * 时映射成单元素数组;都没有回退 fallback(新建任务默认,单 id 或 id 数组,见 defaultSourceIdsFor)。
 */
export function sourceIdsFromConfig(
  cfg: { sources?: Array<{ kind?: string; source?: string; catKey?: string }>; sourceKind?: string; source?: string; catKey?: string } | undefined,
  fallback: string | string[],
): string[] {
  if (cfg && Array.isArray(cfg.sources) && cfg.sources.length) {
    const ids = cfg.sources.map(idOfSel).filter((x): x is string => !!x);
    if (ids.length) return Array.from(new Set(ids));
  }
  if (cfg && cfg.sourceKind) {
    const id = idOfSel({ kind: cfg.sourceKind, source: cfg.source, catKey: cfg.catKey });
    if (id) return [id];
  }
  return Array.isArray(fallback) ? [...fallback] : [fallback];
}

/** 选中源的展示名(摘要行用):「微博热搜、知乎热榜」/ "Weibo, Zhihu"。 */
export function sourceIdsLabel(ids: string[], isZh: boolean): string {
  const names = ids.map((id) => { const o = postSourceById(id); return o ? (isZh ? o.zh : o.en) : ''; }).filter(Boolean);
  return names.join(isZh ? '、' : ', ');
}
