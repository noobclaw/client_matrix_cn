/**
 * platformLoginDriver.ts — multi-platform login utilities.
 *
 * Originally lived in xhsDriver.ts back when only XHS existed. As X / Binance /
 * TikTok / YouTube were added, the login check + open-login-page logic stayed
 * one shared driver branched by `platform` parameter — but the file name
 * still said xhs and so did the function names, which misled readers
 * ("why is YouTube going through xhsDriver?"). v5.x split: login lives here
 * under platform-neutral names; xhsDriver.ts keeps only the truly XHS-only
 * draft upload.
 *
 * Adding a new platform requires entries in ALL THREE Records below
 * (LoginPlatform union, TAB_PATTERNS, NOT_REACHABLE_REASON, PLATFORM_LOGIN_URL).
 * Missing any of them silently falls back to xhs (Record[undefined] → xhs)
 * — that fallback is the bug the v5.1 YouTube launch hit.
 */

import { coworkLog } from '../coworkLogger';
import { sendBrowserCommand, connectionHasCapability } from '../browserBridge';
import { groupTitle as buildGroupTitle, getStandardBounds } from './subPlatformRegistry';

// platform → sub_platform mapping for v6 windowRegistry routing.
//   Main domain is what openPlatformLogin uses; creator domain (when
//   present) is what openCreatorCenter uses. Adding a new platform here
//   means: also add an entry to SUB_PLATFORM_REGISTRY + flag it from any
//   scenario manifest's platforms array. Pre-run check then automatically
//   stamps its checker window with the right windowKey so a task starting
//   later finds it via windowRegistry.get() instead of cascading a new one.
const PLATFORM_TO_MAIN_SUBPLATFORM: Record<LoginPlatform, string> = {
  xhs:        'xhs_main',
  douyin:     'douyin_main',
  tiktok:     'tiktok_main',
  x:          'x_main',
  binance:    'binance_square',
  youtube:    'youtube_main',
  kuaishou:   'kuaishou_main',
  bilibili:   'bilibili_main',
  shipinhao:  'shipinhao_main',
  toutiao:    'toutiao_main',
  instagram:  'instagram_main',
  facebook:   'facebook_main',
  reddit:     'reddit_main',
};

const PLATFORM_TO_CREATOR_SUBPLATFORM: Partial<Record<LoginPlatform, string>> = {
  xhs:      'xhs_creator',
  douyin:   'douyin_creator',
  kuaishou: 'kuaishou_creator',
  bilibili: 'bilibili_creator',
};

// v6.x window bounds moved to subPlatformRegistry.getStandardBounds so
// BOTH pre-run check (here) and task openTab (phaseRunner) use the same
// deterministic per-sub_platform size + cascade offset. Local preRunBoundsFor
// was a dup that only pre-run used — task-fresh windows fell back to ext
// cascadeBounds and came out a different size. Now unified.
const preRunBoundsFor = getStandardBounds;

export interface PlatformLoginStatus {
  loggedIn: boolean;
  reason?: string;
}

// Backward-compat type alias — old callers imported `XhsLoginStatus` from
// xhsDriver. Re-exported here so the move is non-breaking; new code should
// use PlatformLoginStatus.
export type XhsLoginStatus = PlatformLoginStatus;

export type LoginPlatform = 'xhs' | 'x' | 'binance' | 'tiktok' | 'youtube' | 'douyin' | 'kuaishou' | 'bilibili' | 'shipinhao' | 'toutiao' | 'instagram' | 'facebook' | 'reddit';

const TAB_PATTERNS: Record<LoginPlatform, RegExp> = {
  // (?<!creator\.) 排除 creator.xiaohongshu.com 子域 —— 用户只打开
  // 创作者中心(未登录会落到 /login)时,主站 check 必须报 fail,而不是
  // 误以为"主站已登录"。creator 子域走独立的 checkCreatorCenter 检查,
  // 那里有真正的登录重定向 URL 判断。lookbehind 在 Node 20+ / Chrome 62+
  // 支持,sidecar / 扩展 / browserBridge 三端都能跑。
  xhs: /(?<!creator\.)xiaohongshu\.com/i,
  // ⚠️ The previous attempt was `(?:^|\.)(?:twitter|x)\.com` — required the
  // domain to be preceded by start-of-string or a literal dot. That broke on
  // real URLs like `https://x.com/home` (the char before `x` is `/`, neither).
  // `\b` (word boundary) handles every case: `/` before `x` is a boundary;
  // `https://www.x.com` has `.` before `x` which is also a boundary; meanwhile
  // `https://mybox.com` doesn't get a false-positive because there's no word
  // boundary between `o` and `x`.
  x: /\b(?:twitter|x)\.com\b/i,
  // Binance Square lives under binance.com/*/square (locale prefix like
  // /zh-CN/square, /en/square). Match the path segment to avoid false
  // positives from other binance.com subsites (spot trading, futures etc.).
  binance: /binance\.com\/[a-z-]+\/square/i,
  // TikTok web — match anywhere on tiktok.com (Explore, video pages, profile).
  tiktok: /tiktok\.com/i,
  // YouTube — main domain + m.youtube.com mobile + youtube-nocookie embeds.
  youtube: /(?:^|\.)(?:youtube|youtube-nocookie)\.com/i,
  // 抖音 web — jingxuan / 推荐 / 视频详情 等主站路径。
  // (?<!creator\.) 排除 creator.douyin.com 子域 —— 用户只打开创作者中心
  // (未登录会 302 到 /passport/login)时,主站 check 必须报 fail,不能
  // 因为 URL 串里有 "douyin.com" 就当成"主站已登录"。creator 子域走独立
  // 的 checkCreatorCenter 检查(那里有 /passport/login 重定向判断)。
  // 任务执行时 ctx.navigate(creator.* URL) 走 manifest 的 tab_url_pattern,
  // 跟这个 client 端 TAB_PATTERNS 是分开的,不受这条改动影响。
  douyin: /(?<!creator\.)douyin\.com/i,
  // 快手 web 主站 — 排除 cp.kuaishou.com 创作者服务平台子域(走独立
  // checkCreatorCenter)。
  kuaishou: /(?<!cp\.)kuaishou\.com/i,
  // 哔哩哔哩 web 主站 — 排除 member.bilibili.com 创作中心子域。
  bilibili: /(?<!member\.)bilibili\.com/i,
  // 视频号助手后台 —— 创作 + 回复粉丝都在 channels.weixin.qq.com,无独立主站。
  shipinhao: /channels\.weixin\.qq\.com/i,
  // 头条号后台 —— 创作 + 回复粉丝都在 mp.toutiao.com(区别于 www/so.toutiao.com)。
  toutiao: /mp\.toutiao\.com/i,
  // Instagram / Facebook web 主站(海外,须 VPN)。
  instagram: /instagram\.com/i,
  facebook: /facebook\.com/i,
  reddit: /reddit\.com/i,
};

const NOT_REACHABLE_REASON: Record<LoginPlatform, string> = {
  xhs: 'xhs_tab_not_reachable',
  x: 'x_tab_not_reachable',
  binance: 'binance_tab_not_reachable',
  tiktok: 'tiktok_tab_not_reachable',
  youtube: 'youtube_tab_not_reachable',
  douyin: 'douyin_tab_not_reachable',
  kuaishou: 'kuaishou_tab_not_reachable',
  bilibili: 'bilibili_tab_not_reachable',
  shipinhao: 'shipinhao_tab_not_reachable',
  toutiao: 'toutiao_tab_not_reachable',
  instagram: 'instagram_tab_not_reachable',
  facebook: 'facebook_tab_not_reachable',
  reddit: 'reddit_tab_not_reachable',
};

const PLATFORM_LOGIN_URL: Record<LoginPlatform, string> = {
  xhs: 'https://www.xiaohongshu.com',
  x: 'https://x.com/home',
  binance: 'https://www.binance.com/square',
  tiktok: 'https://www.tiktok.com/explore',
  youtube: 'https://www.youtube.com',
  douyin: 'https://www.douyin.com/jingxuan',
  kuaishou: 'https://www.kuaishou.com',
  bilibili: 'https://www.bilibili.com',
  shipinhao: 'https://channels.weixin.qq.com/platform',
  toutiao: 'https://mp.toutiao.com/',
  instagram: 'https://www.instagram.com/',
  facebook: 'https://www.facebook.com/',
  reddit: 'https://www.reddit.com/',
};

/** v2.6+: chrome-extension tab-group label/color per platform.
 *
 *  Used to be hardcoded inside chrome-extension/background.js (function
 *  `platformLabelForPattern`), which forced an extension republish on
 *  every new platform. Moved here so adding a new platform is a pure
 *  client change. The browser bridge attaches this to every command's
 *  envelope; chrome-extension v1.2.21+ uses it for grouping. Older
 *  extensions ignore the field and fall back to their internal hardcoded
 *  mapping (which still covers xhs / x / binance / youtube / tiktok /
 *  douyin if their last release had them).
 *
 *  Colors are Chrome's tabGroup color enum:
 *    grey, blue, red, yellow, green, pink, purple, cyan, orange.
 */
export const PLATFORM_TAB_GROUPS: Record<LoginPlatform, { title: string; color: string }> = {
  xhs:     { title: '🤖 XHS · NoobClaw',     color: 'green'  },
  x:       { title: '🤖 X · NoobClaw',       color: 'blue'   },
  binance: { title: '🤖 Binance · NoobClaw', color: 'yellow' },
  youtube: { title: '🤖 YouTube · NoobClaw', color: 'purple' },
  tiktok:  { title: '🤖 TikTok · NoobClaw',  color: 'cyan'   },
  douyin:  { title: '🤖 Douyin · NoobClaw',  color: 'pink'   },
  kuaishou:{ title: '🤖 Kuaishou · NoobClaw',color: 'orange' },
  bilibili:{ title: '🤖 Bilibili · NoobClaw',color: 'blue'   },
  shipinhao:{title: '🤖 视频号 · NoobClaw',  color: 'green'  },
  toutiao: { title: '🤖 头条号 · NoobClaw',  color: 'red'    },
  instagram:{title: '🤖 Instagram · NoobClaw', color: 'pink' },
  facebook: {title: '🤖 Facebook · NoobClaw',  color: 'blue' },
  reddit:   {title: '🤖 Reddit · NoobClaw',    color: 'orange' },
};

/** Single source of truth for "which platform does this regex string target".
 *  Used by phaseRunner (to pick the right tabGroup / platform-specific
 *  cleanup target) and anywhere else that needs to map a manifest's
 *  tab_url_pattern back to a LoginPlatform key. Keeping this in one place
 *  means adding a new platform doesn't risk drifting two parallel lists. */
export function inferPlatformFromPattern(pattern: string | undefined): LoginPlatform | undefined {
  if (!pattern) return undefined;
  if (/xiaohongshu/i.test(pattern)) return 'xhs';
  if (/binance/i.test(pattern)) return 'binance';
  if (/youtube/i.test(pattern)) return 'youtube';
  if (/tiktok/i.test(pattern)) return 'tiktok';
  if (/douyin/i.test(pattern)) return 'douyin';
  if (/kuaishou/i.test(pattern)) return 'kuaishou';
  if (/bilibili/i.test(pattern)) return 'bilibili';
  if (/channels\.weixin\.qq\.com/i.test(pattern)) return 'shipinhao';
  if (/toutiao/i.test(pattern)) return 'toutiao';
  if (/instagram/i.test(pattern)) return 'instagram';
  if (/facebook/i.test(pattern)) return 'facebook';
  if (/reddit/i.test(pattern)) return 'reddit';
  if (/twitter|x\\?\.com/i.test(pattern)) return 'x';
  return undefined;
}

export async function checkPlatformLogin(platform: LoginPlatform = 'xhs'): Promise<PlatformLoginStatus> {
  // Always do a live check — don't trust cached connection status
  let tabs: any[] = [];
  try {
    // Short timeout: if browser is closed, this will fail fast
    const res = await sendBrowserCommand('tab_list', {}, 3000);
    tabs = Array.isArray(res?.tabs) ? res.tabs : [];
    if (!res || (!res.tabs && !Array.isArray(res))) {
      return { loggedIn: false, reason: 'browser_not_connected' };
    }
  } catch (err) {
    coworkLog('WARN', 'platformLoginDriver', 'tab_list failed — browser likely closed', { err: String(err) });
    return { loggedIn: false, reason: 'browser_not_connected' };
  }

  const pattern = TAB_PATTERNS[platform] || TAB_PATTERNS.xhs;
  const matchTab = tabs.find(
    (t: any) => typeof t.url === 'string' && pattern.test(t.url)
  );
  if (!matchTab || typeof matchTab.id !== 'number') {
    return { loggedIn: false, reason: NOT_REACHABLE_REASON[platform] || 'tab_not_reachable' };
  }

  return { loggedIn: true };
}

export async function openPlatformLogin(platform: LoginPlatform = 'xhs'): Promise<{ ok: boolean; reason?: string }> {
  const url = PLATFORM_LOGIN_URL[platform] || PLATFORM_LOGIN_URL.xhs;

  // v1.6.2+ (PR11 / Phase 2-D follow-up): route the pre-run-check window
  // through the v6 windowRegistry so a task starting later can reuse it.
  //   - windowKey: ${PLATFORM_TO_MAIN_SUBPLATFORM[platform]}::default
  //   - groupTitle: idle form (no taskId — no task is running yet)
  //   - taskId: empty (windowRegistry stamps currentTaskId null; ext does
  //     NOT also write to legacy taskTabRegistry, so this window stays
  //     unowned by any task until ctx.openTab adopts it)
  // When the user later runs xhs_reply_fans_comment, phaseRunner's
  // ctx.openTab({ sub_platform: 'xhs_creator', ... }) sees the existing
  // entry, focuses + reuses + restamps title with task short-id. Two
  // sub_platforms (creator + main) → two windowKeys → two physical
  // windows, exactly satisfying "如果检查框要检查两个,那要求是两个窗口
  // 而不是一个窗口两个 tab".
  const subPlatform = PLATFORM_TO_MAIN_SUBPLATFORM[platform];
  if (subPlatform && connectionHasCapability(undefined, 'window_registry_v6')) {
    const windowKey = `${subPlatform}::default`;
    const idleTitle = buildGroupTitle(subPlatform, 'default', null);
    // v1.6.5+ (PR13): client owns positioning. Ext accepts bounds param;
    // pre-v1.6.5 ext silently ignores extra fields and falls back to its
    // cascadeBounds default — same visual result, just no client control.
    const bounds = preRunBoundsFor(subPlatform, 'default');
    try {
      await sendBrowserCommand(
        'task_open_tab',
        {
          windowKey,
          groupTitle: idleTitle,
          role: 'main',
          url,
          bounds,
          // taskId omitted — pre-run check is not a task.
        },
        12000, // v6 create-window does chrome.windows.create + bounds +
               // group + title — a chain that easily exceeds 3s on a busy
               // machine. Old 3s timeout fired falsely, the catch fell to
               // legacy tab_create, and ext added a SECOND tab to the
               // window v6 had already opened. 12s removes the false timeout.
      );
      return { ok: true };
    } catch (err) {
      // v6 is windowKey-idempotent. Do NOT fall through to legacy
      // tab_create — that opens a duplicate tab whenever v6 actually
      // succeeded server-side but the response was slow. Return ok:false;
      // the caller (handleOpenXhs/Secondary) re-probes checkPlatformLogin
      // and only window.open's if the tab genuinely isn't there, so a
      // slow-but-successful v6 open never double-tabs.
      coworkLog('WARN', 'platformLoginDriver',
        `v6 task_open_tab failed for ${platform} (no legacy fallback — avoids dup tab)`, { err: String(err) });
      return { ok: false, reason: 'v6_open_failed' };
    }
  }

  // Legacy (pre-PR7 ext): platform-level NoobClaw group via tab_create envelope.
  // v2.8+: 极简 — 只发 tab_create 带路由 envelope,extension 1.4.22+ 自治
  // (mutex 内 enforce + reuse-or-open),不需要 client 主动 tab_list 兜底。
  const tabPattern = TAB_PATTERNS[platform]?.source;
  const tabGroup = PLATFORM_TAB_GROUPS[platform];
  const routeOpts: any = {};
  if (tabPattern) routeOpts.tabPattern = tabPattern;
  if (tabGroup) routeOpts.tabGroup = tabGroup;
  if (tabPattern && connectionHasCapability(tabPattern, 'isolated_windows')) {
    routeOpts.isolate = true;
  }
  if (url) routeOpts.anchor_url = url;
  try {
    await sendBrowserCommand('tab_create', { url }, 3000, routeOpts);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
}

// ── Creator-center secondary check ──────────────────────────────────
// 抖音 / 小红书 的图文创作任务要发到 creator.*.com 子域,主站登录态不等于
// 创作者中心登录态(虽然 SSO 跨子域共享 cookie,但用户得真打开过 creator
// tab 浏览器才认这个 origin)。LoginRequiredModal 跑预检时除了首页 tab 还要
// 额外确认 creator.* tab 存在 + URL 不是登录重定向页 → 才能保证任务跑起
// 来能直接进发布流程,不会卡在"请先登录"。
//
// 只有抖音 / 小红书有这层 secondary check;其他平台没有独立 creator 子域
// (X/Binance 在主站发,TikTok/YouTube 的 creator URL 跟主站 SSO 共享更紧),
// 不需要这个 gate。

const CREATOR_TAB_PATTERNS: Partial<Record<LoginPlatform, RegExp>> = {
  xhs: /creator\.xiaohongshu\.com/i,
  douyin: /creator\.douyin\.com/i,
  kuaishou: /cp\.kuaishou\.com/i,
  bilibili: /member\.bilibili\.com/i,
};

const CREATOR_URLS: Partial<Record<LoginPlatform, string>> = {
  xhs: 'https://creator.xiaohongshu.com/',
  douyin: 'https://creator.douyin.com/',
  kuaishou: 'https://cp.kuaishou.com/article/comment',
  bilibili: 'https://member.bilibili.com/platform/comment/article',
};

// 抖音 creator 未登录会 302 到 /passport/login;小红书会 hash 路由到 #/login。
// URL 命中这些 → 视为未登录(tab 在,但还没认证)。
const CREATOR_LOGIN_REDIRECT = /\/passport\/login|\/login(\?|#|\/|$)|#\/login/i;

export function platformHasCreatorCenter(platform: LoginPlatform): boolean {
  return !!CREATOR_TAB_PATTERNS[platform];
}

export async function checkCreatorCenter(platform: LoginPlatform): Promise<PlatformLoginStatus> {
  const pattern = CREATOR_TAB_PATTERNS[platform];
  // 没 creator 子域的平台 → 视为 no-op pass,避免 LoginRequiredModal 这边
  // 调用方还得自己 if (platform === 'xhs' || ...)。
  if (!pattern) return { loggedIn: true };

  let tabs: any[] = [];
  try {
    const res = await sendBrowserCommand('tab_list', {}, 3000);
    tabs = Array.isArray(res?.tabs) ? res.tabs : [];
    if (!res || (!res.tabs && !Array.isArray(res))) {
      return { loggedIn: false, reason: 'browser_not_connected' };
    }
  } catch (err) {
    coworkLog('WARN', 'platformLoginDriver', 'creator tab_list failed — browser likely closed', { err: String(err) });
    return { loggedIn: false, reason: 'browser_not_connected' };
  }

  const matchTab = tabs.find(
    (t: any) => typeof t.url === 'string' && pattern.test(t.url)
  );
  if (!matchTab || typeof matchTab.id !== 'number') {
    return { loggedIn: false, reason: 'creator_tab_not_reachable' };
  }
  if (typeof matchTab.url === 'string' && CREATOR_LOGIN_REDIRECT.test(matchTab.url)) {
    return { loggedIn: false, reason: 'creator_not_logged_in' };
  }
  return { loggedIn: true };
}

export async function openCreatorCenter(platform: LoginPlatform): Promise<{ ok: boolean; reason?: string }> {
  const url = CREATOR_URLS[platform];
  if (!url) return { ok: false, reason: 'no_creator_center' };

  // v1.6.2+ (PR11): route through v6 windowRegistry so the creator window
  // ends up in its own windowKey-keyed slot, distinct from main domain's
  // slot. Tasks running later (e.g. xhs_reply_fans_comment) call
  // ctx.openTab({ sub_platform: 'xhs_creator' }) which finds + reuses
  // THIS exact window — same machinery as openPlatformLogin above.
  //
  // The earlier renderer workaround (LoginRequiredModal.handleOpenCreator
  // calling window.open directly to dodge the legacy "ext scoops user's
  // creator tab into MCP group" problem) is no longer necessary on v6:
  // task_open_tab v6 path only touches the windowRegistry entry for
  // exactly this windowKey, never adopts pre-existing user tabs into a
  // platform-level group. handleOpenCreator can switch back to calling
  // this function.
  const subPlatform = PLATFORM_TO_CREATOR_SUBPLATFORM[platform];
  if (subPlatform && connectionHasCapability(undefined, 'window_registry_v6')) {
    const windowKey = `${subPlatform}::default`;
    const idleTitle = buildGroupTitle(subPlatform, 'default', null);
    const bounds = preRunBoundsFor(subPlatform, 'default');
    try {
      await sendBrowserCommand(
        'task_open_tab',
        {
          windowKey,
          groupTitle: idleTitle,
          role: 'creator',
          url,
          bounds,
        },
        12000, // see openPlatformLogin: 3s falsely timed out → legacy
               // fallback double-tabbed. 12s + no legacy fallback below.
      );
      return { ok: true };
    } catch (err) {
      // No legacy fallback — v6 idempotent, slow≠failed. Avoids dup tab.
      coworkLog('WARN', 'platformLoginDriver',
        `v6 creator task_open_tab failed for ${platform} (no legacy fallback — avoids dup tab)`, { err: String(err) });
      return { ok: false, reason: 'v6_open_failed' };
    }
  }

  // Legacy fallback (pre-PR7 ext)
  const tabPattern = CREATOR_TAB_PATTERNS[platform]?.source;
  const tabGroup = PLATFORM_TAB_GROUPS[platform];
  const routeOpts: any = {};
  if (tabPattern) routeOpts.tabPattern = tabPattern;
  if (tabGroup) routeOpts.tabGroup = tabGroup;
  if (tabPattern && connectionHasCapability(tabPattern, 'isolated_windows')) {
    routeOpts.isolate = true;
  }
  if (url) routeOpts.anchor_url = url;
  try {
    await sendBrowserCommand('tab_create', { url }, 3000, routeOpts);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
}

// ── Backward-compat aliases ─────────────────────────────────────────
// Old callers imported `checkXhsLogin` / `openXhsLogin` from `./xhsDriver`.
// They now route here; the misleading-named exports are kept so any caller
// we didn't migrate still works. Delete after a release where main +
// preload + sidecar + renderer all use the new names.
export const checkXhsLogin = checkPlatformLogin;
export const openXhsLogin = openPlatformLogin;
