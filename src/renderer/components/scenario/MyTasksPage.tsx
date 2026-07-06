/**
 * MyTasksPage — unified list of ALL automation tasks across platforms.
 *
 * Replaces the per-platform task lists at the bottom of XhsWorkflowsPage
 * and XWorkflowsPage. Single source of truth for "what tasks do I have".
 *
 * Sorting:
 *   1. Currently-running tasks pinned to top (with green pulse glow)
 *   2. Then by created_at descending (newest first)
 *
 * Each row shows:
 *   - Platform tag (📕 小红书 / 🐦 推特)
 *   - Task type badge (e.g. 🔥 批量爆款 / 💬 自动回复 / 🐦 互动涨粉)
 *   - Track / scenario name
 *   - #ID hash + persona snippet
 *   - Status pill (运行中 / 定时 / 手动 / 待命)
 *   - Frequency line
 */

import React, { useEffect, useMemo, useState } from 'react';
import { shortId } from '../../utils/shortId';
import { i18nService } from '../../services/i18n';
import { TRACK_META, trackDisplayName } from '../../services/trackNames';
import { scenarioService, type Scenario, type Task } from '../../services/scenario';

interface Props {
  /** Tasks already filtered to a single platform by the parent. The parent
   *  switches between XHS / Twitter via a sub-tab and re-filters tasks. */
  tasks: Task[];
  scenarios: Scenario[];
  loading: boolean;
  /** Used in the empty-state hint and the section header label. */
  platformLabel: string;
  onOpenTask: (task_id: string) => void;
  /** Optional refresh callback — called on mount so freshly-edited tasks
   *  show up with the latest config (e.g. user changed track in detail
   *  page → comes back to My Tasks → list reflects the new track without
   *  needing the user to wait for the next periodic poll). */
  onRefresh?: () => void | Promise<void>;
  /** Jump to the Create section for the same platform sub-tab. Used by
   *  the empty state — instead of telling the user "click the L1 tab
   *  above", we give them a one-click button. */
  onGoCreate?: () => void;
  /** Internal id ('xhs' | 'x') of the current platform sub-tab — used
   *  to pick the right icon + label on the empty-state CTA button. The
   *  parent already filters tasks by this; we just need to know which
   *  one for display. */
  platformId?: 'xhs' | 'x' | 'binance';
}

// Platform pill label is locale-aware: Chinese when zh, English when en.
// Returns { icon, label } for whichever locale is active right now.
function platformMeta(platformId: string): { icon: string; label: string } {
  if (platformId === 'xhs')     return { icon: '📕', label: i18nService.t('platXhs') };
  if (platformId === 'x')       return { icon: '🐦', label: i18nService.t('platX') };
  if (platformId === 'binance') return { icon: '🔶', label: i18nService.t('platBinance') };
  if (platformId === 'youtube') return { icon: '📺', label: 'YouTube' };
  if (platformId === 'tiktok')  return { icon: '🎵', label: 'TikTok' };
  if (platformId === 'douyin')  return { icon: '🎵', label: i18nService.t('platDouyin') };
  if (platformId === 'kuaishou') return { icon: '⚡', label: i18nService.t('platKuaishou') };
  if (platformId === 'bilibili') return { icon: '📺', label: i18nService.t('platBilibili') };
  if (platformId === 'shipinhao') return { icon: '📱', label: i18nService.t('platShipinhao') };
  if (platformId === 'toutiao')  return { icon: '📰', label: i18nService.t('platToutiao') };
  if (platformId === 'facebook') return { icon: '👥', label: 'Facebook' };
  if (platformId === 'reddit')   return { icon: '🟠', label: 'Reddit' };
  if (platformId === 'instagram') return { icon: '📷', label: 'Instagram' };
  if (platformId === 'video')    return { icon: '🎬', label: i18nService.t('platVideo') };
  return { icon: '🤖', label: platformId };
}

// scenario 快照常缺发帖类新平台(facebook_post/reddit_post/instagram_post 等)→ scenario.platform
// 为 undefined 时,从 scenario_id 头段推平台,别再兜底成 'xhs'(会误显「📕 小红书」平台徽章)。
const KNOWN_PLATFORM_TOKENS = ['xhs', 'x', 'binance', 'douyin', 'tiktok', 'kuaishou', 'bilibili', 'shipinhao', 'toutiao', 'youtube', 'facebook', 'reddit', 'instagram'];
function platformFromScenarioId(sid: string | undefined): string | undefined {
  const first = String(sid || '').split('_')[0];
  return KNOWN_PLATFORM_TOKENS.includes(first) ? first : undefined;
}

// Per-platform growth-tutorial doc URL. Mirrors the two language sites the
// docs team publishes — zh / zh-TW go to the Chinese namespace, everything
// else (en + every other locale we ship) goes to the English namespace.
// Update both maps if a new platform is added.
function tutorialUrl(platformId: string, isZh: boolean): string | null {
  const zh: Record<string, string> = {
    binance: 'https://docs.noobclaw.com/zhong-wen-ban/bi-an-guang-chang-zhang-fen-jiao-cheng',
    x:       'https://docs.noobclaw.com/zhong-wen-ban/tui-te-zhang-fen-jiao-cheng',
    xhs:     'https://docs.noobclaw.com/zhong-wen-ban/xiao-hong-shu-zhang-fen-jiao-cheng',
    youtube: 'https://docs.noobclaw.com/zhong-wen-ban/youtube-zhang-fen-jiao-cheng',
    douyin:  'https://docs.noobclaw.com/zhong-wen-ban/dou-yin-zhang-fen-jiao-cheng',
    tiktok:  'https://docs.noobclaw.com/zhong-wen-ban/tiktok-zhang-fen-jiao-cheng',
  };
  const en: Record<string, string> = {
    binance: 'https://docs.noobclaw.com/english/binance-square-growth',
    x:       'https://docs.noobclaw.com/english/twitter-growth',
    xhs:     'https://docs.noobclaw.com/english/xiaohongshu-growth',
    youtube: 'https://docs.noobclaw.com/english/youtube-growth',
    douyin:  'https://docs.noobclaw.com/english/douyin-growth',
    tiktok:  'https://docs.noobclaw.com/english/tiktok-growth',
  };
  const map = isZh ? zh : en;
  return map[platformId] || null;
}

// Persona snippets are seeded from Chinese templates (the reply_persona_hint
// arrays in ConfigWizard) — they always start with "身份：" / "现在做的：" /
// "真实状态：" prefixes. In EN mode we translate the prefix so the user
// doesn't see Chinese labels (the body content stays Chinese — that's
// user-editable copy and we can't auto-translate it).
function localizePersonaPrefix(text: string, isZh: boolean): string {
  if (isZh) return text;
  return text
    .replace(/^身份[：:]\s*/, 'Identity: ')
    .replace(/^现在做的[：:]\s*/, 'Currently doing: ')
    .replace(/^真实状态[：:]\s*/, 'Status: ')
    .replace(/^技术栈[：:]\s*/, 'Tech stack: ')
    .replace(/^理财习惯[：:]\s*/, 'Finance habits: ')
    .replace(/^旅行风格[：:]\s*/, 'Travel style: ')
    .replace(/^饮食习惯[：:]\s*/, 'Food habits: ')
    .replace(/^穿搭习惯[：:]\s*/, 'Style: ')
    .replace(/^护肤路线[：:]\s*/, 'Skincare: ')
    .replace(/^饮食[：:]\s*/, 'Diet: ')
    .replace(/^偏好[：:]\s*/, 'Preferences: ');
}

// 赛道名映射已抽到 services/trackNames.ts(9 语统一,4 处渲染点共用)。用 TRACK_META / trackDisplayName。

function scheduleLabel(task: Task): string {
  // v6.x: 列表卡片频次文案跟 TaskDetailPage intervalMap (line ~1059) 严格对齐 —
  //   核心字段同样的措辞(短间隔的 +1-10/+1-45 分钟随机延迟、daily_random 的
  //   "每日随机时间一次(<window> 间)"、once 的"不重复（手动触发）")。
  //   列表可以少展示一些字段(不带每次配额/动作明细),但展示的字段必须跟详情
  //   页一字不差,否则用户会以为 list 和 detail 在描述两件事。
  const interval = (task as any).run_interval || 'daily_random';
  const schedWin = (task as any).schedule_window || '09:00-23:00';
  const map: Record<string, string> = {
    '30min': i18nService.t('freq30min'),
    '1h': i18nService.t('freq1h'),
    '3h': i18nService.t('freq3h'),
    '6h': i18nService.t('freq6h'),
    'daily': i18nService.t('freqDaily').replace('{time}', task.daily_time || '08:00'),
    'daily_random': i18nService.t('freqDailyRandom').replace('{win}', schedWin),
    'once': i18nService.t('freqOnce'),
  };
  return map[interval] || interval;
}

/** v4.31.43: 把 next_planned_run_at 渲染成简短的"还差多久 · 绝对时间",
 *  跟 detail page 的"下次运行"显示一致。运行中 / once / link_rewrite 不
 *  调用此函数(那些有专门的 pill)。 */
function nextRunLabel(task: Task): string {
  const planned = (task as any).next_planned_run_at as number | undefined;
  if (planned && planned > Date.now()) {
    const diff = planned - Date.now();
    const mins = Math.round(diff / 60000);
    let rel: string;
    if (mins < 60) rel = i18nService.t('relMin').replace('{n}', String(mins));
    else if (mins < 24 * 60) rel = i18nService.t('relHour').replace('{n}', String(Math.round(mins / 60)));
    else rel = i18nService.t('relDay').replace('{n}', String(Math.round(mins / (60 * 24))));
    const d = new Date(planned);
    const sameDay = (a: Date, b: Date) =>
      a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    const now = new Date();
    const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const datePart = sameDay(d, now) ? i18nService.t('relToday')
                  : sameDay(d, tomorrow) ? i18nService.t('relTomorrow')
                  : `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
    return `${rel} · ${datePart} ${hh}:${mm}`;
  }
  return i18nService.t('relSoon');
}

// 任务卡片「配置摘要」小标签:按任务类型从透传的 config 里抠关键参数(来源/形态/关键词/语言/配图/发布等),
// 让列表卡片一眼看清这条任务在干嘛(不止「N 条/次」)。无对应配置则返回空数组、不渲染。
function langShort(l: string | undefined): string {
  if (l === 'en') return 'EN';
  if (l === 'zh') return i18nService.t('langZh');
  return i18nService.t('langAuto');
}
function taskConfigChips(task: Task): string[] {
  const sid = String(task.scenario_id || '');
  const t = task as any;
  const pubChip = (auto: boolean) => (auto ? i18nService.t('chipPublish') : i18nService.t('chipLocal'));
  const chips: string[] = [];
  if (sid === 'binance_repost' && t.binanceRepost) {
    const c = t.binanceRepost;
    const srcMap: Record<string, string> = { xhs: i18nService.t('platXhs'), douyin: i18nService.t('platDouyin'), tiktok: 'TikTok', x: 'X' };
    chips.push(c.material === 'video' ? i18nService.t('chipVideo') : i18nService.t('chipImageText'));
    chips.push(i18nService.t('chipRepostSrc').replace('{src}', srcMap[c.sourcePlatform] || c.sourcePlatform));
    if (c.keyword) chips.push(`🔍 ${String(c.keyword).slice(0, 12)}`);
    chips.push(`🌐 ${langShort(c.language)}`);
    chips.push(pubChip(c.autoPublish !== false));
  } else if (sid === 'binance_post' && t.binancePost) {
    const c = t.binancePost;
    chips.push(i18nService.t('chipWeb3News'));
    chips.push(`🌐 ${langShort(c.language)}`);
    chips.push(c.withImage !== false ? (i18nService.t('chipImage')) : (i18nService.t('chipTextOnly')));
    chips.push(pubChip(c.autoPublish !== false));
  } else if (sid === 'facebook_post' && t.facebookPost) {
    const c = t.facebookPost;
    chips.push(`📰 ${c.source || (c.sourceKind === 'news' ? 'Web3' : c.sourceKind === 'category' ? (c.catKey || 'tech') : '热榜')}`);
    chips.push(`🌐 ${langShort(c.language)}`);
    chips.push(c.withImage !== false ? (i18nService.t('chipImage')) : (i18nService.t('chipTextOnly')));
    chips.push(pubChip(c.autoPublish !== false));
  } else if (sid === 'reddit_post' && t.redditPost) {
    const c = t.redditPost;
    chips.push(`r/${c.subreddit || '?'}`);
    chips.push(`📰 ${c.source || (c.sourceKind === 'news' ? 'Web3' : c.sourceKind === 'category' ? (c.catKey || 'tech') : '热榜')}`);
    chips.push(`🌐 ${langShort(c.language)}`);
    chips.push(pubChip(c.autoPublish !== false));
  } else if (sid === 'instagram_post' && t.instagramPost) {
    const c = t.instagramPost;
    chips.push(`📰 ${c.source || (c.sourceKind === 'news' ? 'Web3' : c.sourceKind === 'category' ? (c.catKey || 'tech') : '热榜')}`);
    chips.push(`🌐 ${langShort(c.language)}`);
    chips.push(i18nService.t('chipImage'));
    chips.push(pubChip(c.autoPublish !== false));
  } else if (sid === 'x_post' && t.tweetPost) {
    const c = t.tweetPost;
    chips.push(c.mode === 'web3' ? (i18nService.t('chipWeb3News')) : (i18nService.t('chipFreeform')));
    chips.push(`🌐 ${langShort(c.language)}`);
    chips.push(c.withImage ? (i18nService.t('chipImage')) : (i18nService.t('chipTextOnly')));
    if (c.isBlueV) chips.push(i18nService.t('chipBlueV'));
  } else if (/_image_text$/.test(sid) && t.imageText) {
    const c = t.imageText;
    chips.push(c.useRealPhotos ? (i18nService.t('chipWebImg')) : (i18nService.t('chipAiImg')));
    if (c.imageCount) chips.push(i18nService.t('chipImgsPer').replace('{n}', String(c.imageCount)));
    if (c.dailyCount) chips.push(i18nService.t('chipPerAcct').replace('{n}', String(c.dailyCount)));
    chips.push(pubChip(c.autoPublish !== false));
  } else if (/_viral_production_career$/.test(sid) && t.viralRewrite) {
    const c = t.viralRewrite;
    chips.push(i18nService.t('chipViral'));
    if (c.dailyCount) chips.push(i18nService.t('chipPerAcct').replace('{n}', String(c.dailyCount)));
    chips.push(pubChip(c.autoPublish !== false));
  }
  return chips;
}

export const MyTasksPage: React.FC<Props> = ({ tasks, scenarios, loading, platformLabel, onOpenTask, onRefresh, onGoCreate, platformId }) => {
  const isZh = i18nService.currentLanguage === 'zh';
  const [runningTaskIds, setRunningTaskIds] = useState<Set<string>>(new Set());
  // Per-task derived data for the "actions strip" on each card:
  //  - running tasks → action_progress map (live X/Y, polled every 3s)
  //  - idle tasks    → cumulative_action_counts map (refreshed when a
  //                    task transitions running→idle, otherwise cached)
  // Keyed by task id; entries are { mode, data } where mode picks which
  // map shape `data` carries.
  const [taskActionInfo, setTaskActionInfo] = useState<Record<string, {
    mode: 'running' | 'cumulative';
    data: Record<string, { done: number; target: number }> | Record<string, number>;
  }>>({});

  // Poll which tasks are actively running every 3s + fetch live progress
  // for running tasks. Idle tasks get their cumulative counts fetched on
  // first sight (and refreshed whenever a running task finishes so the
  // strip flips from 本次目标 X/Y → 累计完成 X 赞 right away).
  useEffect(() => {
    let cancelled = false;
    let prevRunningSet = new Set<string>();
    const tick = async () => {
      const ids = await scenarioService.getRunningTaskIds().catch(() => []);
      if (cancelled) return;
      const runningNow = new Set(ids);
      setRunningTaskIds(runningNow);

      // For running tasks, pull live progress. For tasks that JUST
      // stopped running since last tick, refetch their cumulative so
      // the strip swaps from running → cumulative with up-to-date data.
      const justFinished: string[] = [];
      prevRunningSet.forEach(id => { if (!runningNow.has(id)) justFinished.push(id); });
      prevRunningSet = runningNow;

      const updates: typeof taskActionInfo = {};
      // Running: action_progress
      await Promise.all(Array.from(runningNow).map(async (id) => {
        const prog = await scenarioService.getRunProgress(id).catch(() => null);
        const ap = (prog as any)?.action_progress;
        if (ap && typeof ap === 'object') {
          updates[id] = { mode: 'running', data: ap };
        }
      }));
      // Just-finished + tasks we haven't fetched cumulative for yet:
      const idleNeedingFetch = tasks
        .filter(t => !runningNow.has(t.id))
        .filter(t => justFinished.includes(t.id) || !taskActionInfo[t.id] || taskActionInfo[t.id].mode === 'running')
        .slice(0, 30); // hard cap so a 100-task list doesn't pile up IPC
      await Promise.all(idleNeedingFetch.map(async (t) => {
        const stats = await scenarioService.getTaskStats(t.id).catch(() => null);
        const cac = stats?.cumulative_action_counts;
        if (cac && typeof cac === 'object') {
          updates[t.id] = { mode: 'cumulative', data: cac };
        }
      }));
      if (!cancelled && Object.keys(updates).length > 0) {
        setTaskActionInfo(prev => ({ ...prev, ...updates }));
      }
    };
    void tick();
    const h = setInterval(tick, 3000);
    return () => { cancelled = true; clearInterval(h); };
    // 依赖必须是【任务 id 集合】而非 tasks.length:切平台 tab 时 MyTasksPage 不卸载、
    //   只换 tasks prop,而各平台常各只有 1 个任务 → length 不变 → 旧 effect 闭包仍抓着
    //   上个平台的 tasks、永不重拉新平台 → 新平台卡片累计一直显 0(抖音=默认 tab 故正常)。
    //   按 id 集合做 key,切平台/增删任务都会重建 effect 重新拉取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks.map((t) => t.id).join(',')]);

  // Refresh tasks on mount so edits made in TaskDetailPage (e.g. user
  // changed track) propagate immediately when the user comes back to
  // the list — without this, the displayed task.track was stale until
  // the next refresh cycle.
  useEffect(() => {
    if (onRefresh) void onRefresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scenarioById = useMemo(() => {
    return new Map(scenarios.map(s => [s.id, s]));
  }, [scenarios]);

  // Sort: running first, then by created_at desc. Stable inside each group.
  const sortedTasks = useMemo(() => {
    return [...tasks]
      .map((t, i) => ({ task: t, originalIdx: i, running: runningTaskIds.has(t.id) }))
      .sort((a, b) => {
        if (a.running !== b.running) return a.running ? -1 : 1;
        const ca = a.task.created_at || 0;
        const cb = b.task.created_at || 0;
        if (ca !== cb) return cb - ca;
        return a.originalIdx - b.originalIdx;
      })
      .map(({ task }) => task);
  }, [tasks, runningTaskIds]);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <section className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold dark:text-white">
            📋 {i18nService.t('mtpMyTasks').replace('{platform}', platformLabel)}
          </h2>
          {/* Tutorial entry — opens the docs page for this platform's growth
              workflow in the system browser. zh / zh-TW go to the Chinese
              docs namespace, everything else to English. Returns null when
              platformId isn't in the tutorialUrl map so the button silently
              hides on unknown platforms instead of opening a 404. */}
          {(() => {
            const url = tutorialUrl(platformId || '', isZh);
            if (!url) return null;
            return (
              <button
                onClick={() => {
                  try {
                    (window as any).electron?.shell?.openExternal?.(url) ?? window.open(url, '_blank', 'noopener,noreferrer');
                  } catch {
                    window.open(url, '_blank', 'noopener,noreferrer');
                  }
                }}
                className="group relative inline-flex items-center gap-1.5 text-xs font-medium
                           px-3.5 py-1.5 rounded-full
                           bg-gradient-to-r from-amber-500/15 via-orange-500/15 to-rose-500/15
                           hover:from-amber-500/25 hover:via-orange-500/25 hover:to-rose-500/25
                           text-amber-700 dark:text-amber-300
                           border border-amber-500/30 hover:border-amber-500/60
                           shadow-sm hover:shadow-md hover:shadow-amber-500/20
                           transition-all duration-200 hover:-translate-y-0.5"
                title={i18nService.t('mtpTutorialTitle')}
              >
                <span className="text-sm leading-none">📖</span>
                <span>{i18nService.t('mtpGrowthTutorial')}</span>
                <span className="opacity-60 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all duration-200">→</span>
              </button>
            );
          })()}
        </div>

        {loading && tasks.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-gray-400 py-6">
            <span className="h-4 w-4 rounded-full border-2 border-green-500 border-t-transparent animate-spin" />
            {i18nService.t('rhLoading')}
          </div>
        ) : tasks.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-700 p-10 text-center">
            <div className="text-4xl mb-2">📭</div>
            <div className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              {i18nService.t('mtpNoTasks').replace('{platform}', platformLabel)}
            </div>
            {/* v2.4.30: skip the "click the L1 tab above" hint — give the
                user a direct CTA button that jumps straight to Create
                section for the same platform sub-tab they're on. The
                button color matches the platform brand (green for XHS,
                sky for Twitter) so the visual cue ties back to the L2
                tab they came from. */}
            {onGoCreate && (
              <button
                type="button"
                onClick={onGoCreate}
                className={`inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl text-white text-sm font-semibold transition-all active:scale-95 shadow-sm ${
                  platformId === 'x'
                    ? 'bg-sky-500 hover:bg-sky-600 shadow-sky-500/25'
                    : platformId === 'binance'
                      ? 'bg-yellow-500 hover:bg-yellow-600 shadow-yellow-500/25'
                      : 'bg-green-500 hover:bg-green-600 shadow-green-500/25'
                }`}
              >
                {platformId === 'x' ? '🐦' : platformId === 'binance' ? '🔶' : '📕'} {i18nService.t('mtpNewTask').replace('{platform}', platformLabel)}
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {sortedTasks.map(task => {
              const scenario = scenarioById.get(task.scenario_id);
              // scenario.platform 缺失(发帖类新平台快照常缺)→ 从 scenario_id 推,最后才兜底 'xhs'。
              const platformId = scenario?.platform || platformFromScenarioId(task.scenario_id) || 'xhs';
              const platMeta = platformMeta(platformId);
              const isRunning = runningTaskIds.has(task.id);
              // Type badge per scenario id (Twitter has 3 distinct ones,
              // XHS has 2 distinct ones via workflow_type)
              const sid = task.scenario_id;
              const isLinkRewriteTwitter = sid === 'x_link_rewrite';
              const isXhsLinkMode = task.track === 'link_mode' || (Array.isArray((task as any).urls) && (task as any).urls.length > 0 && platformId === 'xhs');
              const isBinanceLinkRewrite = sid === 'binance_from_x_link';
              // 视频无水印下载(xhs/douyin/tiktok)也是"粘 URL 列表"任务 —— 跟 link 仿写
              // 一样隐藏 track/persona、改显 URL 列表,但它有自己的徽章/副标题/图标,
              // 必须跟「指定链接爆款仿写」区分开(两者都带 urls[],别混了)。
              const isVideoDownload = sid === 'xhs_video_download' || sid === 'douyin_video_download' || sid === 'tiktok_video_download' || sid === 'kuaishou_video_download' || sid === 'bilibili_video_download';
              // v4.28.x: 任何"用户粘 URL 列表仿写"任务统一处理 —— 之前 binance_from_x_link
              // 没被算进去,导致它在列表里还显示 track 名 + persona 摘要(其实用户没填,
              // 是 wizard fallback 的默认人设),完全跟 X / XHS link 模式不一致。
              // 引入 isAnyLinkRewrite 后:隐藏 track 行 / 隐藏 persona snippet / 改显 URL 列表。
              const isAnyLinkRewrite = isLinkRewriteTwitter || isXhsLinkMode || isBinanceLinkRewrite || isVideoDownload;
              // v5.x+: 抖音图文创作场景没有 track / persona / keywords 概念,
              // 只看 source_segments[3]。MyTasksPage 跟 TaskDetailPage 对齐,
              // 隐藏 persona snippet 和 track 行(老任务 task.persona 字段还在
              // 但 wizard 不再让用户填,展示只会误导)。
              const isDouyinImageText = sid === 'douyin_image_text';
              // v6.x: 跟 TaskDetailPage(line ~870/885)对齐 —
              //   xhs_image_text 跟 douyin_image_text 同 family,详情页用 isImageTextTask 一并跳 persona;
              //   3 个 binance source-viral 详情页用 isBinanceSourceViral 跳 persona(人设是固定模板,展示也只会误导)。
              //   列表卡片这里跟着关掉 persona snippet,字段口径才跟详情一致。
              const isXhsImageText = sid === 'xhs_image_text';
              // 视频号 / 头条号 图文创作复用 douyin 同款 wizard + source_segments 结构,
              // 列表口径(隐藏 persona/track)跟着同一 family 走。
              const isShipinhaoImageText = sid === 'shipinhao_image_text';
              const isToutiaoImageText = sid === 'toutiao_image_text';
              const isImageTextTask = isDouyinImageText || isXhsImageText || isShipinhaoImageText || isToutiaoImageText;
              const isBinanceSourceViral =
                sid === 'binance_from_xhs_viral'
                || sid === 'binance_from_douyin_viral'
                || sid === 'binance_from_tiktok_viral';
              const taskUrls: string[] = (task as any).urls || [];
              // Type labels per user spec (v2.4.26):
              // Twitter: 推特 · 互动涨粉 / 推特 · 自动发推 / 指定链接仿写
              // XHS:     小红书 · 爆款批量仿写 / 小红书 · 指定链接爆款仿写 / 小红书 · 互动涨粉
              const typeLabel = (() => {
                if (sid === 'x_auto_engage')                  return { icon: '🐦', k: 'scnXEngage', color: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/30' };
                if (sid === 'x_post')                         return { icon: '🐦', k: 'scnXPost', color: 'text-sky-500 bg-sky-500/10 border-sky-500/30' };
                if (sid === 'binance_post')                   return { icon: '📊', k: 'scnBnPost', color: 'text-amber-500 bg-amber-500/10 border-amber-500/30' };
                if (sid === 'facebook_post')                  return { icon: '👥', k: 'scnFbPost', color: 'text-blue-500 bg-blue-500/10 border-blue-500/30' };
                if (sid === 'reddit_post')                    return { icon: '🟠', k: 'scnRdPost', color: 'text-orange-500 bg-orange-500/10 border-orange-500/30' };
                if (sid === 'instagram_post')                 return { icon: '📷', k: 'scnIgPost', color: 'text-pink-500 bg-pink-500/10 border-pink-500/30' };
                if (sid === 'binance_repost')                 return { icon: '♻️', k: 'scnBnRepost', color: 'text-amber-500 bg-amber-500/10 border-amber-500/30' };
                if (sid === 'x_post_creator')                 return { icon: '📝', k: 'scnXPost', color: 'text-sky-500 bg-sky-500/10 border-sky-500/30' };
                if (sid === 'x_link_rewrite')                 return { icon: '✍️', k: 'scnXRewrite', color: 'text-violet-500 bg-violet-500/10 border-violet-500/30' };
                if (sid === 'binance_square_auto_engage')     return { icon: '🤝', k: 'scnBnEngage', color: 'text-yellow-500 bg-yellow-500/10 border-yellow-500/30' };
                if (sid === 'binance_square_post_creator')    return { icon: '🔶', k: 'scnBnPost', color: 'text-amber-500 bg-amber-500/10 border-amber-500/30' };
                if (sid === 'binance_from_x_repost')          return { icon: '🔁', k: 'scnBnRepostX', color: 'text-orange-500 bg-orange-500/10 border-orange-500/30' };
                // v6.x: 3 个新搬运源 — 跟 binance_from_x_repost 同 family,各自独立 label
                if (sid === 'binance_from_xhs_viral')         return { icon: '📕', k: 'scnBnRepostXhs', color: 'text-rose-500 bg-rose-500/10 border-rose-500/30' };
                if (sid === 'binance_from_douyin_viral')      return { icon: '🎵', k: 'scnBnRepostDy', color: 'text-pink-500 bg-pink-500/10 border-pink-500/30' };
                if (sid === 'binance_from_tiktok_viral')      return { icon: '🎬', k: 'scnBnRepostTt', color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
                if (sid === 'binance_from_x_link')          return { icon: '🔗', k: 'scnBnFromXLink', color: 'text-orange-500 bg-orange-500/10 border-orange-500/30' };
                if (sid === 'youtube_auto_engage')          return { icon: '📺', k: 'scnYtEngage', color: 'text-indigo-500 bg-indigo-500/10 border-indigo-500/30' };
                if (sid === 'tiktok_auto_engage')           return { icon: '🎵', k: 'scnTtEngage', color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
                if (sid === 'facebook_auto_engage')         return { icon: '👥', k: 'scnFbEngage', color: 'text-blue-500 bg-blue-500/10 border-blue-500/30' };
                if (sid === 'reddit_auto_engage')           return { icon: '🟠', k: 'scnRdEngage', color: 'text-orange-500 bg-orange-500/10 border-orange-500/30' };
                if (sid === 'instagram_auto_engage')        return { icon: '📷', k: 'scnIgEngage', color: 'text-pink-500 bg-pink-500/10 border-pink-500/30' };
                if (sid === 'douyin_auto_engage')           return { icon: '🎵', k: 'scnDyEngage', color: 'text-violet-500 bg-violet-500/10 border-violet-500/30' };
                if (sid === 'douyin_image_text')            return { icon: '📝', k: 'scnDyImageText', color: 'text-fuchsia-500 bg-fuchsia-500/10 border-fuchsia-500/30' };
                if (sid === 'douyin_reply_fans_comment')    return { icon: '💬', k: 'scnDyReplyFans', color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
                if (sid === 'xhs_image_text')               return { icon: '📝', k: 'scnXhsImageText', color: 'text-rose-500 bg-rose-500/10 border-rose-500/30' };
                if (sid === 'xhs_reply_fans_comment')       return { icon: '💌', k: 'scnXhsReplyFans', color: 'text-fuchsia-500 bg-fuchsia-500/10 border-fuchsia-500/30' };
                if (sid === 'xhs_video_download')           return { icon: '⬇️', k: 'scnXhsDownload', color: 'text-blue-500 bg-blue-500/10 border-blue-500/30' };
                if (sid === 'douyin_video_download')        return { icon: '⬇️', k: 'scnDyDownload', color: 'text-sky-500 bg-sky-500/10 border-sky-500/30' };
                if (sid === 'tiktok_video_download')        return { icon: '⬇️', k: 'scnTtDownload', color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
                if (sid === 'kuaishou_auto_engage')         return { icon: '⚡', k: 'scnKsEngage', color: 'text-orange-500 bg-orange-500/10 border-orange-500/30' };
                if (sid === 'kuaishou_video_download')      return { icon: '⬇️', k: 'scnKsDownload', color: 'text-blue-500 bg-blue-500/10 border-blue-500/30' };
                if (sid === 'kuaishou_reply_fans_comment') return { icon: '💬', k: 'scnKsReplyFans', color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
                if (sid === 'bilibili_auto_engage')         return { icon: '📺', k: 'scnBiliEngage', color: 'text-pink-500 bg-pink-500/10 border-pink-500/30' };
                if (sid === 'bilibili_video_download')      return { icon: '⬇️', k: 'scnBiliDownload', color: 'text-blue-500 bg-blue-500/10 border-blue-500/30' };
                if (sid === 'bilibili_reply_fans_comment') return { icon: '💬', k: 'scnBiliReplyFans', color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
                if (sid === 'shipinhao_image_text')          return { icon: '📝', k: 'scnShipinhaoImageText', color: 'text-green-500 bg-green-500/10 border-green-500/30' };
                if (sid === 'shipinhao_reply_fans_comment') return { icon: '💬', k: 'scnShipinhaoReplyFans', color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
                if (sid === 'toutiao_image_text')            return { icon: '📝', k: 'scnToutiaoImageText', color: 'text-red-500 bg-red-500/10 border-red-500/30' };
                if (sid === 'toutiao_reply_fans_comment')   return { icon: '💬', k: 'scnToutiaoReplyFans', color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
                if (isXhsLinkMode)                            return { icon: '🔗', k: 'scnXhsLinkRewrite', color: 'text-purple-500 bg-purple-500/10 border-purple-500/30' };
                // workflow_type fallbacks — MUST check platform BEFORE labeling,
                // otherwise Binance / YouTube / TikTok / Douyin scenarios with
                // workflow_type='auto_reply' fall into the XHS branch and get
                // tagged 小红书 · 互动涨粉 (bug observed in 2.4.56). Platform-
                // first guard fixes it.
                const plat = scenario?.platform || platformFromScenarioId(sid);
                if ((scenario?.workflow_type as any) === 'auto_reply') {
                  if (plat === 'binance') return { icon: '💬', k: 'scnBnEngage', color: 'text-yellow-500 bg-yellow-500/10 border-yellow-500/30' };
                  if ((plat as any) === 'youtube') return { icon: '💬', k: 'scnYtEngage', color: 'text-red-500 bg-red-500/10 border-red-500/30' };
                  if ((plat as any) === 'tiktok')  return { icon: '💬', k: 'scnTtEngage', color: 'text-pink-500 bg-pink-500/10 border-pink-500/30' };
                  if ((plat as any) === 'douyin')  return { icon: '💬', k: 'scnDyEngage', color: 'text-pink-500 bg-pink-500/10 border-pink-500/30' };
                  if ((plat as any) === 'kuaishou') return { icon: '💬', k: 'scnKsEngage', color: 'text-orange-500 bg-orange-500/10 border-orange-500/30' };
                  if ((plat as any) === 'bilibili') return { icon: '💬', k: 'scnBiliEngage', color: 'text-pink-500 bg-pink-500/10 border-pink-500/30' };
                  if ((plat as any) === 'facebook') return { icon: '💬', k: 'scnFbEngage', color: 'text-blue-500 bg-blue-500/10 border-blue-500/30' };
                  if ((plat as any) === 'reddit')   return { icon: '💬', k: 'scnRdEngage', color: 'text-orange-500 bg-orange-500/10 border-orange-500/30' };
                  if ((plat as any) === 'instagram') return { icon: '💬', k: 'scnIgEngage', color: 'text-pink-500 bg-pink-500/10 border-pink-500/30' };
                  return { icon: '💬', k: 'scnXhsEngage', color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
                }
                if (plat === 'binance') return { icon: '🔶', k: 'scnBnPostShort', color: 'text-amber-500 bg-amber-500/10 border-amber-500/30' };
                if (plat === 'x')       return { icon: '🐦', k: 'scnXTask', color: 'text-sky-500 bg-sky-500/10 border-sky-500/30' };
                if ((plat as any) === 'youtube') return { icon: '📺', k: 'scnYtTask', color: 'text-red-500 bg-red-500/10 border-red-500/30' };
                if ((plat as any) === 'tiktok')  return { icon: '🎵', k: 'scnTtTask', color: 'text-pink-500 bg-pink-500/10 border-pink-500/30' };
                if ((plat as any) === 'douyin')  return { icon: '🎵', k: 'scnDyTask', color: 'text-pink-500 bg-pink-500/10 border-pink-500/30' };
                if ((plat as any) === 'kuaishou') return { icon: '⚡', k: 'scnKsTask', color: 'text-orange-500 bg-orange-500/10 border-orange-500/30' };
                if ((plat as any) === 'bilibili') return { icon: '📺', k: 'scnBiliTask', color: 'text-pink-500 bg-pink-500/10 border-pink-500/30' };
                if ((plat as any) === 'shipinhao') return { icon: '📱', k: 'scnShipinhaoTask', color: 'text-green-500 bg-green-500/10 border-green-500/30' };
                if ((plat as any) === 'toutiao')  return { icon: '📰', k: 'scnToutiaoTask', color: 'text-red-500 bg-red-500/10 border-red-500/30' };
                return { icon: '🔥', k: 'scnXhsViral', color: 'text-green-500 bg-green-500/10 border-green-500/30' };
              })();
              // Track / display name
              const track = TRACK_META[task.track];
              const subTitle = (() => {
                if (isVideoDownload) return i18nService.t('subVideoLinks');
                if (isLinkRewriteTwitter) return i18nService.t('subManualTweet');
                if (isXhsLinkMode) return i18nService.t('subManualXhs');
                if (track) return trackDisplayName(task.track, i18nService.currentLanguage);
                // scenario 快照常缺发帖类新平台(facebook_post/reddit_post/instagram_post 等)→ 落 scenario_id
                // 会显示原始英文 id(用户实拍「facebook_post」)。改用已翻译的类型徽章名兜底,任何 UI 语言都可读。
                return scenario?.name_zh || i18nService.t(typeLabel.k);
              })();
              const subIcon = track?.icon || (isVideoDownload ? '⬇️' : (isXhsLinkMode || isLinkRewriteTwitter ? '🔗' : scenario?.icon || '🔥'));
              const personaSnippet = (task.persona || '').trim().split('\n')[0].slice(0, 80);
              const interval = (task as any).run_interval || 'daily_random';

              return (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => onOpenTask(task.id)}
                  className={`w-full text-left rounded-xl border p-4 transition-colors relative ${
                    isRunning
                      ? 'border-green-500 ring-2 ring-green-500/30 bg-white dark:bg-gray-900 noobclaw-running-glow'
                      : 'border-gray-200 dark:border-gray-700 hover:border-green-500/50 dark:hover:border-green-500/50 bg-white dark:bg-gray-900'
                  }`}
                >
                  {/* Top row */}
                  <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300">
                        {platMeta.icon} {platMeta.label}
                      </span>
                      <span className={`shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border ${typeLabel.color}`}>
                        {typeLabel.icon} {i18nService.t(typeLabel.k)}
                      </span>
                      {!isAnyLinkRewrite && !isImageTextTask && (
                        <>
                          <span className="text-lg">{subIcon}</span>
                          <span className="font-medium dark:text-white truncate">{subTitle}</span>
                        </>
                      )}
                      <span className="text-[10px] text-gray-500 dark:text-gray-500 font-mono shrink-0">
                        #{shortId(task.id)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {isRunning ? (
                        <span className="text-xs px-2 py-1 rounded bg-green-500/10 text-green-500 border border-green-500/30 flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                          {i18nService.t('mtxRunning')}
                        </span>
                      ) : interval === 'once' || isAnyLinkRewrite ? (
                        <span className="text-xs px-2 py-1 rounded bg-purple-500/10 text-purple-500 border border-purple-500/30">
                          ✋ {i18nService.t('mtxManual')}
                        </span>
                      ) : (
                        // v4.31.43: 取代"定时运行"/"待命"二态显示 —— scheduler
                        // 实际不区分 active,所有 enabled 任务都到点跑,显示具体的
                        // 下次运行时间更直观。
                        <span className="text-xs px-2 py-1 rounded bg-blue-500/10 text-blue-500 border border-blue-500/30">
                          ⏰ {nextRunLabel(task)}
                        </span>
                      )}
                    </div>
                  </div>
                  {/* Persona snippet — strip Chinese prefix in EN mode.
                      v4.28.x: 链接仿写场景(x_link_rewrite / binance_from_x_link / XHS link mode)
                      用户根本没填 persona,只有 wizard fallback 默认值,展示出来反而误导
                      ("我没填怎么有身份"用户原话),所以这里跳过。
                      v5.x+: 抖音图文创作也不展示 — 老任务可能有 persona 字段(在
                      wizard 删 persona 之前创建的),展示出来跟详情页不一致。 */}
                  {!isAnyLinkRewrite && !isImageTextTask && !isBinanceSourceViral && personaSnippet && (
                    <div className="text-xs text-gray-600 dark:text-gray-300 mb-1 truncate">
                      👤 {localizePersonaPrefix(personaSnippet, isZh)}
                    </div>
                  )}
                  {/* 关键词 / 搜索词 —— 列表卡片以前不展示,用户一眼看不出这个任务在搞什么主题
                      (尤其互动涨粉:靠这些词搜视频/笔记)。镜像 TaskDetailPage 的口径:
                      推特(KOL 池,不按词搜)/ 图文创作 / 链接仿写·下载 不展示;binance 发帖词是
                      Token tag,源平台搬运是搜索词,其余为普通关键词。空则不显示。 */}
                  {platformId !== 'x' && !isImageTextTask && !isAnyLinkRewrite
                    && Array.isArray(task.keywords) && task.keywords.length > 0 && (() => {
                    const kwLabel = isBinanceSourceViral ? i18nService.t('mtxKwSearch')
                      : /^binance/.test(sid) ? 'Token'
                      : i18nService.t('mtxKwKeywords');
                    return (
                      <div className="text-xs text-gray-600 dark:text-gray-300 mb-1 truncate">
                        🏷️ {kwLabel}: {task.keywords.slice(0, 6).join(' · ')}
                        {task.keywords.length > 6 ? ' …' : ''}
                      </div>
                    );
                  })()}
                  {/* 搬运类型 / 本次搬运媒体类型 + Token 标签 —— 镜像 TaskDetailPage:
                      binance_from_x_repost 显示「搬运类型」;3 个源平台 viral 搬运显示
                      「本次搬运」媒体类型 + Token 标签(cashtags 空则走内置主流币)。 */}
                  {(() => {
                    const mf = (task as any).media_filter;
                    const mfLabel = mf === 'image_only' ? i18nService.t('mtxMfImageOnly')
                      : mf === 'video_only' ? i18nService.t('mtxMfVideoOnly')
                      : i18nService.t('mtxMfAll');
                    if (sid === 'binance_from_x_repost') {
                      return <div className="text-xs text-gray-600 dark:text-gray-300 mb-1 truncate">🎞 {i18nService.t('mtxMediaType')}: {mfLabel}</div>;
                    }
                    if (isBinanceSourceViral) {
                      const cashtags = (task as any).cashtags as string[] | undefined;
                      const tokenStr = cashtags && cashtags.length > 0
                        ? cashtags.map((c) => '$' + c).join(' · ')
                        : i18nService.t('mtxBuiltinMajors');
                      return (
                        <div className="text-xs text-gray-600 dark:text-gray-300 mb-1 space-y-0.5">
                          <div className="truncate">🎞 {i18nService.t('mtxRepostThis')}: {mfLabel}</div>
                          <div className="truncate">🪙 Token: {tokenStr}</div>
                        </div>
                      );
                    }
                    return null;
                  })()}
                  {/* 图文创作(抖音/小红书/视频号/头条):在 frequency 之上展示 3 段参考文案的
                      前 1-2 段预览 —— 跟 TaskDetailPage 一致(详情页对【所有】图文场景都展示,
                      列表以前只对抖音展示,小红书/视频号/头条漏了)。这是该场景的核心输入。 */}
                  {isImageTextTask && (() => {
                    const segs: string[] = Array.isArray((task as any).source_segments) ? (task as any).source_segments : [];
                    const visible = segs.filter(s => typeof s === 'string' && s.trim().length > 0).slice(0, 2);
                    if (visible.length === 0) return null;
                    return (
                      <div className="text-[11px] text-gray-500 dark:text-gray-400 mb-1 space-y-0.5">
                        {visible.map((s, i) => (
                          <div key={i} className="truncate">
                            <span className="text-gray-400">{i18nService.t('mtxRefCopy')}{['①','②','③'][i] || (i + 1)}:</span>{' '}
                            <span>{s.trim().slice(0, 70)}{s.trim().length > 70 ? '...' : ''}</span>
                          </div>
                        ))}
                        {segs.filter(s => typeof s === 'string' && s.trim().length > 0).length > 2 && (
                          <div className="text-gray-400">...</div>
                        )}
                      </div>
                    );
                  })()}
                  {/* Frequency / URL details */}
                  <div className="text-xs text-gray-500 dark:text-gray-400 space-y-1">
                    {isAnyLinkRewrite ? (
                      <>
                        <div>
                          {i18nService.t('mtxUrls')}: {taskUrls.length}
                          {i18nService.t('mtxUrlsUnit')}
                        </div>
                        {taskUrls.slice(0, 2).map((u, i) => (
                          <div key={i} className="truncate text-[11px] text-gray-400">{i + 1}. {u}</div>
                        ))}
                      </>
                    ) : (
                      <div>
                        {i18nService.t('mtxFrequency')}
                        {(() => {
                          // v2.4.60: 频次显示按场景类型展示真实用户配置,不再写死 "1 条/次"
                          const sid = task.scenario_id;
                          const t = task as any;
                          const fMin = t.daily_follow_min, fMax = t.daily_follow_max;
                          const rMin = t.daily_reply_min, rMax = t.daily_reply_max;
                          const cMin = t.daily_count_min, cMax = t.daily_count_max;
                          const pMin = t.daily_post_min, pMax = t.daily_post_max;
                          // auto_engage(X 或 Binance):follow + reply 双范围
                          if (sid === 'x_auto_engage' || sid === 'binance_square_auto_engage') {
                            const fStr = (typeof fMin === 'number' && typeof fMax === 'number')
                              ? `${fMin}-${fMax}` : `0-${task.daily_count || 3}`;
                            const rStr = (typeof rMin === 'number' && typeof rMax === 'number')
                              ? `${rMin}-${rMax}` : `${task.daily_count || 1}`;
                            return `⏰ ${scheduleLabel(task)} · ${i18nService.t('mtxFollow')} ${fStr} · ${i18nService.t('mtxReply')} ${rStr}`;
                          }
                          // post_creator(Binance/X)+ binance_from_x_repost + v6.x 3 个新源:daily_post_min/max
                          // v6.x: 跟 TaskDetailPage(line ~1130/1135/1140)同步用"每次 N 条"前缀
                          //   而非旧的"N 条/次"——这些场景详情页统一用"每次 N 条 · <场景描述>",
                          //   列表 card 砍掉场景描述但保留"每次 N 条"前缀,保证字段格式一致。
                          if (sid === 'binance_square_post_creator' || sid === 'x_post_creator'
                              || sid === 'binance_from_x_repost'
                              || sid === 'binance_from_xhs_viral'
                              || sid === 'binance_from_douyin_viral'
                              || sid === 'binance_from_tiktok_viral') {
                            const pStr = (typeof pMin === 'number' && typeof pMax === 'number' && pMin !== pMax)
                              ? `${pMin}-${pMax}` : String(pMin || pMax || task.daily_count || 1);
                            return `⏰ ${scheduleLabel(task)} · ${i18nService.t('mtxPerRunCount').replace('{n}', pStr)}`;
                          }
                          // 回复粉丝评论:每次处理"最近 N 篇笔记/作品"的全部未回复评论(N =
                          //   max_notes/works_per_run,默认 30),不是"N 条/次"。
                          if (sid === 'xhs_reply_fans_comment') {
                            return `⏰ ${scheduleLabel(task)} · ${i18nService.t('mtxLatest30Notes')}`;
                          }
                          if (sid === 'douyin_reply_fans_comment' || sid === 'kuaishou_reply_fans_comment' || sid === 'bilibili_reply_fans_comment' || sid === 'shipinhao_reply_fans_comment' || sid === 'toutiao_reply_fans_comment') {
                            return `⏰ ${scheduleLabel(task)} · ${i18nService.t('mtxLatest30Videos')}`;
                          }
                          if (sid === 'toutiao_reply_fans_comment') {
                            return `⏰ ${scheduleLabel(task)} · ${i18nService.t('mtxLatest30Posts')}`;
                          }
                          // XHS auto_reply:用 daily_count_min/max
                          if ((task as any).scenario_id?.includes('auto_reply') ||
                              (typeof cMin === 'number' && typeof cMax === 'number')) {
                            const cStr = (typeof cMin === 'number' && typeof cMax === 'number')
                              ? `${cMin}-${cMax}` : String(task.daily_count || 1);
                            return `⏰ ${scheduleLabel(task)} · ${cStr} ${i18nService.t('mtxArticlesRun')}`;
                          }
                          // 币安广场自动发帖 / 批量搬运:每号每轮 1 条,共 N 条/轮(N=账号数)。
                          if (sid === 'binance_post' || sid === 'facebook_post' || sid === 'reddit_post' || sid === 'instagram_post' || sid === 'binance_repost') {
                            const accN = Array.isArray(t.account_ids) ? t.account_ids.length : 1;
                            return `⏰ ${scheduleLabel(task)} · ${i18nService.t('mtxPerAccountRound').replace('{n}', String(accN))}`;
                          }
                          // 兜底:旧 daily_count 单值
                          return `⏰ ${scheduleLabel(task)} · ${task.daily_count || 1} ${i18nService.t('mtxCountRun')}`;
                        })()}
                      </div>
                    )}
                    {/* 矩阵任务:展示这条任务跑几个账号(各账号自带赛道/人设/关键词) */}
                    {Array.isArray((task as any).account_ids) && (task as any).account_ids.length > 0 && (
                      <div>
                        {i18nService.t('mtxAccounts').replace('{n}', String((task as any).account_ids.length))}
                      </div>
                    )}
                    {/* 配置摘要小标签(来源/形态/关键词/语言/配图/发布等),让卡片信息更丰富 */}
                    {(() => {
                      const chips = taskConfigChips(task);
                      return chips.length > 0 ? (
                        <div className="flex flex-wrap gap-1 pt-0.5">
                          {chips.map((c, i) => (
                            <span key={i} className="text-[10px] px-1.5 py-0.5 rounded border border-gray-200/70 dark:border-gray-700 text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/40">{c}</span>
                          ))}
                        </div>
                      ) : null;
                    })()}
                    <div className="text-[11px] text-gray-400">
                      {i18nService.t('mtxCreatedAt')}
                      {new Date(task.created_at || 0).toLocaleString(isZh ? 'zh-CN' : 'en-US')}
                    </div>
                  </div>
                  {/* Actions strip — bottom-right corner.
                       running task → 本次目标 with X/Y (live ticking from
                                       polling action_progress every 3s)
                       idle task    → 累计完成 with summed history counts
                                       (shown even at 0 so the user can
                                       tell the task is wired correctly
                                       before it has run once). */}
                  {(() => {
                    const info = taskActionInfo[task.id];
                    const ICONS: Record<string, string> = { like: '👍', follow: '➕', subscribe: '📌', comment: '💬', reply: '💬', post: '📤', download: '⬇️' };
                    const ORDER = ['like', 'follow', 'subscribe', 'comment', 'reply', 'post', 'download'];
                    const labels = { like: i18nService.t('mtxActLike'), follow: i18nService.t('mtxActFollow'), comment: i18nService.t('mtxActComment'), reply: i18nService.t('mtxActReply'), subscribe: i18nService.t('mtxActSubscribe'), post: i18nService.t('mtxActPost'), download: i18nService.t('mtxActDownload') };
                    // For idle tasks that have never produced action counts
                    // (brand-new tasks, or post-creator scenarios where the
                    // backend hasn't backfilled `cumulative_action_counts`
                    // yet), fall back to a scenario-derived primary action
                    // key so the "累计完成: 0 帖/赞" strip still renders
                    // instead of leaving an empty gap on the card. The
                    // running-mode branch keeps its >0 filter so the live
                    // strip only lights up for actions the orchestrator
                    // has actually announced a target for.
                    const isPostScenario = (
                      sid === 'binance_square_post_creator' ||
                      sid === 'x_post_creator' ||
                      sid === 'binance_from_x_repost' ||
                      sid === 'binance_from_x_link' ||
                      // v6.x: 3 个新源 wizard 共用同字段
                      sid === 'binance_from_xhs_viral' ||
                      sid === 'binance_from_douyin_viral' ||
                      sid === 'binance_from_tiktok_viral' ||
                      sid === 'x_link_rewrite' ||
                      sid === 'douyin_image_text' ||
                      sid === 'xhs_image_text' ||  // ← v6.x: 之前漏,跟 douyin_image_text 同 post 系
                      sid === 'xhs_viral_production_career' ||
                      sid === 'x_post' ||  // 矩阵自动发推:主动作 = post(发推),新任务无历史时兜底 ['post'] 不闪「赞」
                      sid === 'binance_post' ||  // 矩阵币安广场自动发帖:同 x_post,主动作 = post(发帖),不显示赞/关注/评论
                      sid === 'facebook_post' ||  // 矩阵 Facebook 自动发帖:同上,主动作 = post(发帖)
                      sid === 'reddit_post' ||  // 矩阵 Reddit 自动发帖:同上,主动作 = post(发帖)
                      sid === 'instagram_post' ||  // 矩阵 Instagram 自动发帖:同上,主动作 = post(发帖)
                      sid === 'binance_repost'  // 矩阵币安广场批量搬运:同上,主动作 = post(发帖)
                    );
                    // v5.x+: engage scenarios are 3-pronged (like / comment /
                    // follow) so a brand-new task with no history should show
                    // "累计完成: 👍 0 · 💬 0 · ➕ 0" — the full breakdown —
                    // not just "👍 0". Detected by scenario_id ending in
                    // _auto_engage (X / Binance Square / YouTube / TikTok /
                    // Douyin all follow this pattern). Post-creator scenarios
                    // stay single-key on 'post'.
                    const isEngageScenario = !isPostScenario && (
                      sid.endsWith('_auto_engage')
                      || sid === 'xhs_auto_reply_universal'
                    );
                    // 无水印下载场景(tiktok/douyin/xhs_video_download)主动作是
                    //   download — 新任务没历史时 fallback 用 ['download'],否则会先闪
                    //   一下默认的 ['like']「赞」再被真数据覆盖成 download。
                    const isDownloadScenario = sid.endsWith('_video_download');
                    const fallbackKeys: string[] = isPostScenario
                      ? ['post']
                      : isEngageScenario
                        ? ['like', 'comment', 'follow']
                        : isDownloadScenario
                          ? ['download']
                          : ['like'];
                    const fallbackData: Record<string, number> = {};
                    for (const k of fallbackKeys) fallbackData[k] = 0;
                    const effectiveInfo = info ?? {
                      mode: 'cumulative' as const,
                      data: fallbackData,
                    };
                    // v6.x: 回复粉丝评论(xhs/douyin)的进度是两段 ——「已回复评论数」+
                    //   「文章进度 当前/总」,不是「N/target 评论」。评论没法预知总数(每篇
                    //   点开才知道有几条未回复)所以是纯累计;文章扫描后才知道总数,扫描前显
                    //   示 "-"。专属渲染,精确 id 门控,不碰其他场景的通用逻辑。
                    if (sid === 'xhs_reply_fans_comment' || sid === 'douyin_reply_fans_comment' || sid === 'kuaishou_reply_fans_comment' || sid === 'bilibili_reply_fans_comment' || sid === 'shipinhao_reply_fans_comment' || sid === 'toutiao_reply_fans_comment') {
                      const d = effectiveInfo.data as any;
                      const running = effectiveInfo.mode === 'running';
                      const commentDone = running ? (d.comment?.done ?? 0) : (d.comment ?? 0);
                      const articleWord = sid === 'xhs_reply_fans_comment'
                        ? i18nService.t('mtxWordNotes')
                        : i18nService.t('mtxWordVideos');
                      const rfLabel = running
                        ? i18nService.t('mtxProgressCurrent')
                        : i18nService.t('mtxProgressTotal');
                      return (
                        <div className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-800 flex items-center gap-3 flex-wrap text-xs">
                          <span className={`text-[10px] ${running ? 'text-green-600 dark:text-green-400 font-semibold' : 'text-gray-500 dark:text-gray-500'}`}>
                            {rfLabel}:
                          </span>
                          <span className="font-mono">
                            💬 <strong className={running ? 'text-green-600 dark:text-green-400' : ''}>{commentDone > 0 ? commentDone : '-'}</strong>{' '}
                            <span className="text-[10px] text-gray-500 dark:text-gray-400 font-sans">{i18nService.t('mtxCommentsWord')}</span>
                          </span>
                          {running && (() => {
                            const noteDone = d.note?.done ?? 0;
                            const noteTarget = d.note?.target ?? 0;
                            const articleStr = noteTarget > 0 ? `${noteDone}/${noteTarget}` : '-';
                            return (
                              <span className="font-mono">
                                📄 <strong className="text-green-600 dark:text-green-400">{articleStr}</strong>{' '}
                                <span className="text-[10px] text-gray-500 dark:text-gray-400 font-sans">{articleWord}</span>
                              </span>
                            );
                          })()}
                        </div>
                      );
                    }
                    const keys = Object.keys(effectiveInfo.data).filter(k => {
                      // post 系(图文创作/爆款仿写/发帖)不做互动 → 丢掉恒 0 的赞/关/评/订阅,只留 post;
                      // 下载系只留 download。否则 action_counts 恒含 {like:0,follow:0,comment:0} 会误显「赞/关/评」。
                      if (isPostScenario && k !== 'post') return false;
                      if (isDownloadScenario && k !== 'download') return false;
                      if (effectiveInfo.mode === 'running') {
                        const v = (effectiveInfo.data as any)[k];
                        return (v?.target || 0) > 0 || (v?.done || 0) > 0;
                      }
                      // cumulative: keep zeros so newly-created tasks still
                      // show "累计完成: 0 帖" instead of nothing.
                      return true;
                    }).sort((a, b) => {
                      const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
                      if (ia === -1 && ib === -1) return a.localeCompare(b);
                      if (ia === -1) return 1;
                      if (ib === -1) return -1;
                      return ia - ib;
                    });
                    if (keys.length === 0) {
                      // Only happens for running tasks with no announced
                      // targets yet — keep card clean until the
                      // orchestrator calls setActionTargets.
                      return null;
                    }
                    // v5.x+: label aligned with TaskDetailPage's running
                    // glow card ("本次运行进度" / "Current Run Progress")
                    // so the list view and detail view use the same word
                    // for the same data. Was "本次目标" / "Run target"
                    // pre-rename.
                    const labelPrefix = effectiveInfo.mode === 'running'
                      ? i18nService.t('mtxProgressCurrent')
                      : i18nService.t('mtxProgressTotal');
                    return (
                      <div className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-800 flex items-center gap-3 flex-wrap text-xs">
                        <span className={`text-[10px] ${effectiveInfo.mode === 'running' ? 'text-green-600 dark:text-green-400 font-semibold' : 'text-gray-500 dark:text-gray-500'}`}>
                          {labelPrefix}:
                        </span>
                        {keys.map(k => {
                          if (effectiveInfo.mode === 'running') {
                            const { done, target } = (effectiveInfo.data as any)[k];
                            return (
                              <span key={k} className="font-mono">
                                {(ICONS[k] || '·')} <strong className="text-green-600 dark:text-green-400">{done}</strong>
                                <span className="text-gray-400 dark:text-gray-500">/{target}</span>{' '}
                                <span className="text-[10px] text-gray-500 dark:text-gray-400 font-sans">{(labels as any)[k] || k}</span>
                              </span>
                            );
                          }
                          return (
                            <span key={k} className="text-gray-700 dark:text-gray-200">
                              {(ICONS[k] || '·')} <strong>{(effectiveInfo.data as any)[k]}</strong>{' '}
                              <span className="text-[10px] text-gray-500 dark:text-gray-400">{(labels as any)[k] || k}</span>
                            </span>
                          );
                        })}
                      </div>
                    );
                  })()}
                </button>
              );
            })}
            {/* Inline bottom-of-list "新建涨粉任务" card removed at user
                request — the persistent top-right CTA covers this entry
                point well enough on its own. */}
          </div>
        )}
      </section>
    </div>
  );
};
