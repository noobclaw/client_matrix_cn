/**
 * trackPresets — 矩阵账号赛道 id ↔ 显示名映射(main 侧)。
 *
 * 账号赛道存在 account.group(显示名,如 "🍲 美食 · 探店做饭");但 backend 取材接口按赛道 id 过滤
 * (food/crypto/…,与 backend/matrix/track-presets.json 一致)。runner 需把 group→id 才能透传给
 * 「仅账号赛道相关」取材。
 *
 * 内置一份 35 条(与 backend track-presets.json 同步);admin 若改 preset 名,精确匹配可能落空 →
 * 用宽松兜底(核心词包含)再兜一层;都不中返回 ''(= 不按赛道过滤,退回通用)。
 */

interface TrackPreset { id: string; name: string }

const TRACK_PRESETS: TrackPreset[] = [
  { id: 'overseas_life', name: '🌏 海外生活 · 日常' },
  { id: 'pets', name: '🐾 萌宠 · 日常' },
  { id: 'food', name: '🍲 美食 · 探店做饭' },
  { id: 'tech', name: '💻 数码科技 · 测评' },
  { id: 'ai_tools', name: '🤖 AI 工具 · 效率' },
  { id: 'finance', name: '💰 财经 · 理财科普' },
  { id: 'crypto', name: '₿ 加密货币 · Web3' },
  { id: 'fitness', name: '💪 健身 · 减脂日记' },
  { id: 'travel', name: '✈️ 旅行 · 攻略分享' },
  { id: 'outfit', name: '👗 穿搭 · 风格分享' },
  { id: 'beauty', name: '💄 美妆 · 护肤测评' },
  { id: 'career', name: '📈 职场 · 成长干货' },
  { id: 'side_hustle', name: '💼 副业 · 打工人赚钱' },
  { id: 'study_abroad', name: '🎓 留学 · 申请经验' },
  { id: 'parenting', name: '🧸 育儿 · 亲子日常' },
  { id: 'reading', name: '📚 读书 · 书单笔记' },
  { id: 'funny', name: '😂 搞笑 · 段子娱乐' },
  { id: 'emotion', name: '💗 情感 · 共鸣治愈' },
  { id: 'rural', name: '🌾 三农 · 乡村生活' },
  { id: 'games', name: '🎮 游戏 · 实况攻略' },
  { id: 'movie', name: '🎬 影视 · 解说剪辑' },
  { id: 'car', name: '🚗 汽车 · 评测用车' },
  { id: 'anime', name: '🍥 二次元 · 动漫' },
  { id: 'home', name: '🏠 家居 · 收纳装修' },
  { id: 'photography', name: '📷 摄影 · 修图' },
  { id: 'exam', name: '✍️ 考研考公 · 上岸' },
  { id: 'law', name: '⚖️ 法律 · 普法' },
  { id: 'health', name: '🩺 健康 · 养生科普' },
  { id: 'music', name: '🎵 音乐 · 翻唱乐器' },
  { id: 'realestate', name: '🏡 房产 · 买房租房' },
  { id: 'handcraft', name: '✋ 手工 · DIY' },
  { id: 'outdoor', name: '🎣 钓鱼 · 户外' },
  { id: 'gardening', name: '🪴 园艺 · 植物' },
  { id: 'astrology', name: '🔮 星座 · 玄学' },
  { id: 'kids', name: '🧒 萌娃 · 亲子' },
];

// name → 核心词(去掉开头 emoji/符号,取 " · "/空格 前的第一段),供宽松兜底匹配。
function coreOf(name: string): string {
  const stripped = String(name || '').replace(/^[^一-龥A-Za-z]+/, '').trim();
  return stripped.split(/[ ·]/)[0] || '';
}

const _byName = new Map<string, string>();
const _core: { core: string; id: string }[] = [];
for (const p of TRACK_PRESETS) {
  _byName.set(p.name, p.id);
  const c = coreOf(p.name);
  if (c) _core.push({ core: c, id: p.id });
}

/**
 * 账号 group(显示名)→ 赛道 id。匹配不到返回 ''(调用方据此不带 track = 退回通用取材)。
 * account.group 一般就是 preset name(精确必中);name 变更时用核心词包含兜底。
 */
export function trackIdFromGroup(group?: string): string {
  const g = String(group || '').trim();
  if (!g) return '';
  const exact = _byName.get(g);
  if (exact) return exact;
  // 宽松:group 含某赛道核心词(如含"美食"→food)。命中最长核心词,避免"游戏">"戏"这类误配。
  let best = '';
  let bestLen = 0;
  for (const { core, id } of _core) {
    if (core && g.includes(core) && core.length > bestLen) { best = id; bestLen = core.length; }
  }
  return best;
}
