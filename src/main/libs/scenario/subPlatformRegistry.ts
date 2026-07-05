/**
 * subPlatformRegistry.ts — single source of truth for sub_platform metadata.
 *
 * A "sub_platform" is the (platform, domain_tier) granularity at which the
 * v6.x window-routing rework treats the world. Creator center vs main site
 * are separate sub_platforms because they have independent login flows
 * and concerns (e.g. XHS: `creator.xiaohongshu.com` vs `www.xiaohongshu.com`).
 *
 * This registry is consumed by:
 *   - scenarioManager.resourceKeysForPack (Phase 1, today)
 *   - scenarioManager.humanizePlatformFromKey (Phase 1, today)
 *   - future ScopedTab routing (PR9) — passes pre-computed windowKey +
 *     groupTitle into ext via task_open_tab so ext stays sub_platform-
 *     agnostic and never needs version bumps when new platforms ship
 *
 * **Ext stays decoupled**: chrome-extension/background.js intentionally
 * does NOT mirror this file. The ext receives `windowKey` and
 * `groupTitle` as opaque strings from the client and stores them in
 * Map<windowKey, ...> without ever needing to know the enum. Adding a
 * new sub_platform is therefore a client + scenario-manifest change
 * only — no extension release required.
 *
 * Adding a new sub_platform:
 *   1. Add the entry below (this file only — do NOT touch background.js)
 *   2. Make sure label + emoji + domain are accurate
 *   3. Update scenario manifests that touch this domain to declare it
 *      in their `platforms` array
 *   4. Ship client + backend (no ext release needed)
 */

export interface SubPlatformMeta {
  /** Chinese label used in user-facing toast text and Chrome tab group titles. */
  label: string;
  /** Single glyph hint shown in group title prefix; also used as Chrome group color cue. */
  emoji: string;
  /**
   * Canonical primary domain (informational only — NOT a strict URL match).
   * Useful for engineer debugging and as a hint for the (future) ext-side
   * URL → sub_platform classifier (PR8). Real URL pattern matching lives
   * in the scenario's manifest `tab_url_pattern` / `secondary_tab_url_pattern`.
   */
  domain: string;
}

/**
 * The 8 sub_platforms in active use as of 2026-05. Adding to this map
 * is the only sanctioned way to introduce a new sub_platform — scenarios
 * declaring an unknown id in `manifest.platforms` get a runtime warning
 * (see isKnownSubPlatform).
 */
// Labels are intentionally short (English abbreviation + optional CN
// domain-tier suffix). They land in Chrome tab group titles where space
// is at a premium and reading is glance-mode. Pattern:
//   {PLATFORM_ABBREV}            for single-domain platforms
//   {PLATFORM_ABBREV}·{TIER_CN}  for split creator/main platforms
export const SUB_PLATFORM_REGISTRY: Record<string, SubPlatformMeta> = {
  xhs_creator:    { label: 'XHS·创作', emoji: '📝', domain: 'creator.xiaohongshu.com' },
  xhs_main:       { label: 'XHS',      emoji: '📕', domain: 'www.xiaohongshu.com' },
  douyin_creator: { label: 'DY·创作',  emoji: '🎬', domain: 'creator.douyin.com' },
  douyin_main:    { label: 'DY',       emoji: '📹', domain: 'www.douyin.com' },
  tiktok_main:    { label: 'TK',       emoji: '🎵', domain: 'www.tiktok.com' },
  x_main:         { label: 'X',        emoji: '🐦', domain: 'x.com' },
  binance_square: { label: 'BN·广场',  emoji: '🟡', domain: 'www.binance.com/square' },
  youtube_main:   { label: 'YT',       emoji: '🔴', domain: 'www.youtube.com' },
  kuaishou_creator: { label: 'KS·创作', emoji: '🎬', domain: 'cp.kuaishou.com' },
  kuaishou_main:    { label: 'KS',      emoji: '⚡', domain: 'www.kuaishou.com' },
  bilibili_creator: { label: 'B站·创作', emoji: '📺', domain: 'member.bilibili.com' },
  bilibili_main:    { label: 'B站',     emoji: '📺', domain: 'www.bilibili.com' },
  // 视频号 / 头条号 没有独立的"主站浏览 vs 创作者中心"双子域 —— 创作 + 回复
  // 粉丝都在同一个后台域名(channels.weixin.qq.com / mp.toutiao.com)上完成,
  // 所以只登记一个 *_main,不设 *_creator。
  shipinhao_main:   { label: '视频号',  emoji: '📱', domain: 'channels.weixin.qq.com' },
  toutiao_main:     { label: '头条号',  emoji: '📰', domain: 'mp.toutiao.com' },
  instagram_main:   { label: 'IG',      emoji: '📸', domain: 'www.instagram.com' },
  facebook_main:    { label: 'FB',      emoji: '👥', domain: 'www.facebook.com' },
  reddit_main:      { label: 'Reddit',  emoji: '🟠', domain: 'www.reddit.com' },
  // 视频自动发布【专用复用窗口】—— 跟上面那些「一平台一子域一窗口」不同:video
  // publish 流程刻意把【所有勾选平台】塞进这一个 windowKey 的【同一个 tab】里,靠
  // navigate 串行切换上传页(douyin→xhs→tiktok…),避免 9 平台开 9 窗口爆炸。domain
  // 只是占位(运行期会被 navigate 反复改写),不参与 urlToSubPlatform 推断。
  video_publish:    { label: '发布',    emoji: '🚀', domain: '(multi — navigated per platform)' },
  // 视频任务【运行检查专用窗口】—— 独立于发布窗,固定唯一一个,跑登录/插件校验用:
  //   在这个窗口的 tab 上 attach CDP → cdp_cookies_get 读各平台 cookie 判登录态,
  //   不需要导航到平台页、也不需要一直开着对应页面(cookie 在 profile 里全局可读)。
  //   domain 只是占位,不参与 urlToSubPlatform 推断。
  video_check:      { label: '运行检查', emoji: '🔎', domain: '(cookie probe — about:blank)' },
};

/** Lookup set for fast enum validation. Derived from the registry. */
export const SUB_PLATFORM_IDS: ReadonlySet<string> = new Set(Object.keys(SUB_PLATFORM_REGISTRY));

/**
 * Returns true iff `id` is a known sub_platform. Use this to validate
 * manifest.platforms entries on pack load. Unknown ids are not fatal —
 * they still produce a unique mutex key, just with no human label and
 * no interlock with any other scenario.
 */
export function isKnownSubPlatform(id: string): boolean {
  return SUB_PLATFORM_IDS.has(id);
}

/**
 * Derive sub_platform from a concrete URL by matching its hostname.
 * Window uniqueness in v6.x routing is simply (sub_platform, account_id)
 * — and sub_platform IS the domain-tier identity of the URL being
 * opened. So given the URL the scenario wants to navigate to, we don't
 * need ANY other hint (no role inference, no manifest lookup). The URL
 * is the source of truth.
 *
 * Ordering matters: more specific subdomains (creator.*) come before
 * the catch-all main-domain pattern so creator URLs don't accidentally
 * map to *_main.
 *
 * Returns null for URLs that don't match any known platform (about:blank,
 * data: URLs, third-party domains). Caller's responsibility to handle
 * the null — typically by falling back to the legacy openTab schema.
 */
const HOST_TO_SUB_PLATFORM: Array<[RegExp, string]> = [
  [/^creator\.xiaohongshu\.com$/i, 'xhs_creator'],
  [/(\.|^)xiaohongshu\.com$/i,     'xhs_main'],
  [/^creator\.douyin\.com$/i,      'douyin_creator'],
  [/(\.|^)douyin\.com$/i,          'douyin_main'],
  [/(\.|^)tiktok\.com$/i,          'tiktok_main'],
  [/^(www\.)?(x|twitter)\.com$/i,  'x_main'],
  [/(\.|^)binance\.com$/i,         'binance_square'],
  [/(\.|^)youtube\.com$/i,         'youtube_main'],
  [/^youtu\.be$/i,                 'youtube_main'],
  [/^cp\.kuaishou\.com$/i,         'kuaishou_creator'],
  [/(\.|^)kuaishou\.com$/i,        'kuaishou_main'],
  [/^member\.bilibili\.com$/i,     'bilibili_creator'],
  [/(\.|^)bilibili\.com$/i,        'bilibili_main'],
  [/^channels\.weixin\.qq\.com$/i, 'shipinhao_main'],
  [/(\.|^)toutiao\.com$/i,         'toutiao_main'],
  [/(\.|^)instagram\.com$/i,       'instagram_main'],
  [/(\.|^)facebook\.com$/i,        'facebook_main'],
  [/(\.|^)reddit\.com$/i,          'reddit_main'],
];

export function urlToSubPlatform(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    for (const [re, subp] of HOST_TO_SUB_PLATFORM) {
      if (re.test(host)) return subp;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Human label for a sub_platform id, used in:
 *   - toast strings ("正在运行: 小红书创作者中心")
 *   - tab group titles (via groupTitle below)
 *   - error messages ("资源被 占用: 抖音")
 *
 * Falls back to the raw id for forward-compat with scenarios on a newer
 * client that introduced an id we don't know about yet.
 */
export function subPlatformLabel(id: string): string {
  return SUB_PLATFORM_REGISTRY[id]?.label ?? id;
}

/**
 * Chrome tab-group title for an owned-window in v6.x+ routing.
 *
 * Format:
 *   idle  (no taskId):
 *     `🤖 {label}`                      e.g. `🤖 XHS·创作`
 *   active (taskId given):
 *     `🤖 {task4} {label}`              e.g. `🤖 abc1 XHS·创作`
 *   multi-account suffix appended for either (future):
 *     `... · @{account_id}`             e.g. `🤖 abc1 XHS·创作 · @主号`
 *
 * The `🤖` prefix is the visual marker "this is a NoobClaw-managed window";
 * the ext only adopts / repurposes groups whose title starts with this glyph.
 *
 * The task short-id (first 4 chars) lets the user glance at the Chrome
 * tab strip and see which task is currently running on which window.
 * It's COSMETIC ONLY — window lookup inside the ext goes through
 * Map<windowKey, windowId>, never through title parsing. Changing the
 * title (on task start / task end) is a `chrome.tabGroups.update` call
 * driven by the client; it does NOT affect routing, mutex, or anything
 * downstream of the windowKey.
 *
 * On task end the client is expected to call this again with taskId=null
 * so the title reverts to the idle form. If the client forgets, the
 * title stays stale showing the last task's short-id — acceptable
 * trade-off (still informative as "this window was used by abc1 most
 * recently").
 */
export function groupTitle(
  sub_platform: string,
  account_id: string = 'default',
  taskId?: string | null,
): string {
  const taskShort = (typeof taskId === 'string' && taskId.length >= 4)
    ? taskId.slice(0, 4)
    : null;
  const head = taskShort ? `🤖 ${taskShort} ` : `🤖 `;
  const base = head + subPlatformLabel(sub_platform);
  return account_id === 'default' ? base : `${base} · @${account_id}`;
}

/**
 * Deterministic window bounds for a (sub_platform, account_id). The SINGLE
 * source of truth for window positioning — both the pre-run-check helpers
 * (platformLoginDriver) and the task openTab path (phaseRunner) call this
 * so every NoobClaw window is the SAME size (1100×750) at a per-sub_platform
 * cascade offset. Previously pre-run used a local copy and task openTab
 * passed no bounds at all, so task-created windows fell back to ext-side
 * cascadeBounds() and came out a different size — that's the "some windows
 * big, some small" the user saw.
 *
 * Slot index = position in SUB_PLATFORM_REGISTRY insertion order, so each
 * sub_platform always lands at the same screen offset (idempotent). Unknown
 * ids get slot 0. account_id !== 'default' adds a 30px offset so multi-
 * account windows for the same sub_platform don't stack exactly.
 *
 * 1100×750 fits a 1080p screen with 8 cascade slots; clips ~slightly on a
 * 1366 laptop (user can drag). Pure client math — no chrome.system.display
 * dependency, so it stays out of the ext.
 */
const _SUB_PLATFORM_ORDER: string[] = Object.keys(SUB_PLATFORM_REGISTRY);

export function getStandardBounds(
  sub_platform: string,
  account_id: string = 'default',
): { left: number; top: number; width: number; height: number } {
  // v6.x: 平台数已超过 8 个,靠后的 sub_platform(kuaishou/bilibili/shipinhao/
  // toutiao …)如果按原始下标级联,窗口会被推出屏幕 → 触发扩展端
  // "Bounds must be at least 50% within visible screen space" 开窗失败。
  // 对 8 取模回绕(作者注释:8 个 cascade slot 适配 1080p),保证始终在屏内。
  const slot = Math.max(0, _SUB_PLATFORM_ORDER.indexOf(sub_platform)) % 8;
  const accountOffset = account_id === 'default' ? 0 : 30;
  return {
    left: 20 + slot * 60 + accountOffset,
    top: 20 + slot * 50 + accountOffset,
    width: 1100,
    height: 750,
  };
}
