/**
 * 互动任务的动作口径 —— 哪些平台真有「收藏」这个动作。
 *
 * 之所以要单独一份:这张名单原来在三个地方各抄了一遍(向导的 favoriteSupported、
 * 详情页累计完成的 FAV_SIDS、账号卡的收藏判断),加平台时漏改一处,界面上就会出现
 * 「有的地方画了 ⭐、有的地方没画」这种自相矛盾。
 *
 * ⚠️ 往这里加平台前,先确认 backend/matrix/scenarios/<平台>_auto_engage/orchestrator.js
 *    的 ctx.setActionTargets 里确实申报了 favorite —— 只实现动作不申报 target,
 *    界面会把分母画成 0(「⭐ 1/0」),比不显示还糟。
 */
export const FAVORITE_PLATFORMS = ['douyin', 'kuaishou', 'xhs', 'bilibili', 'tiktok'];

/** 按平台名判断(向导用:它手上是 platform)。 */
export function platformSupportsFavorite(platform?: string | null): boolean {
  return FAVORITE_PLATFORMS.indexOf(String(platform || '')) >= 0;
}

/** 按场景 id 判断(详情页用:它手上是 scenario.id,形如 douyin_auto_engage)。 */
export function scenarioSupportsFavorite(scenarioId?: string | null): boolean {
  const sid = String(scenarioId || '');
  const m = /^(.+)_auto_engage$/.exec(sid);
  return !!m && platformSupportsFavorite(m[1]);
}

/**
 * 互动任务在界面上【固定占位】的动作 —— 即使这次配额是 0 也要显示。
 *
 * 为什么固定占位:0 不显示的话,用户分不清「这次没配」和「这个平台不支持」。
 * 而且累计完成那一栏本来就是固定四项,账号卡的 👍/➕/💬 也一直显示,
 * 唯独「本次运行进度」按 target>0 过滤,同一页三处对不上。
 */
export function engageCoreActions(scenarioId?: string | null): string[] {
  if (!/_auto_engage$/.test(String(scenarioId || ''))) return [];
  const base = ['like', 'follow', 'comment'];
  return scenarioSupportsFavorite(scenarioId) ? ['like', 'follow', 'favorite', 'comment'] : base;
}
