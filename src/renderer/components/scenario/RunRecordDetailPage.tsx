/**
 * RunRecordDetailPage — read-only view of a single historical run.
 *
 * What it shows:
 *   - Header badges (platform + scenario type) — same style as MyTasks
 *   - Status pill + duration
 *   - Result counts (collected / produced / posted)
 *   - Output dir link (click → opens in OS file manager)
 *   - Full step-by-step log timeline (every step + every message)
 *   - Snapshotted task config at run time
 *
 * Per user request: NO edit / re-run / delete operations. Records are
 * immutable history — those operations live on the Task itself, not
 * on the record. Only "view" and "open output dir" are surfaced.
 */

import React, { useEffect, useState } from 'react';
import { shortId } from '../../utils/shortId';
import { i18nService } from '../../services/i18n';
import { HIDE_WEB3, cnyFromUsd } from '../../buildFlags';
import { scenarioService } from '../../services/scenario';

interface Props {
  recordId: string;
  onBack: () => void;
  /** Click "查看任务" to jump back to the live task detail (only if
   *  the task still exists — if the user deleted it, this is hidden). */
  onOpenTask?: (task_id: string) => void;
}

interface RunRecord {
  id: string;
  task_id: string;
  task_snapshot: any;
  scenario_snapshot: { id: string; platform: string; name_zh?: string; name_en?: string; icon?: string; workflow_type?: string };
  started_at: number;
  finished_at?: number;
  status: 'running' | 'done' | 'partial' | 'error' | 'stopped';
  error?: string;
  step_logs: Array<{ time: string; step: number; status: 'done' | 'running' | 'error'; message: string }>;
  result?: { collected_count?: number; draft_count?: number; posted?: number; [k: string]: any };
  output_dir?: string;
}

function formatDuration(ms: number, _isZh: boolean): string {
  if (ms < 1000) return ms + 'ms';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + i18nService.t('rrUnitSec');
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return `${m}${i18nService.t('rrUnitMin')}${remS > 0 ? `${remS}${i18nService.t('rrUnitSec')}` : ''}`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}${i18nService.t('rrUnitHour')}${remM > 0 ? `${remM}${i18nService.t('rrUnitMin')}` : ''}`;
}

function fullTime(ts: number, isZh: boolean): string {
  if (!ts) return '-';
  return new Date(ts).toLocaleString(isZh ? 'zh-CN' : 'en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}

// Compact: 123 → '123', 9939 → '9.94K', 1234567 → '1.23M', 1.5e9 → '1.5B'
function compactNum(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) return String(n);
  if (abs < 1_000_000)     return (n / 1_000).toFixed(abs < 10_000 ? 2 : 1) + 'K';
  if (abs < 1_000_000_000) return (n / 1_000_000).toFixed(abs < 10_000_000 ? 2 : 1) + 'M';
  return (n / 1_000_000_000).toFixed(abs < 10_000_000_000 ? 2 : 1) + 'B';
}

export const RunRecordDetailPage: React.FC<Props> = ({ recordId, onBack, onOpenTask }) => {
  const isZh = i18nService.currentLanguage === 'zh';
  const [rec, setRec] = useState<RunRecord | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const r = await scenarioService.getRunRecord(recordId);
      if (!cancelled) {
        setRec(r as RunRecord);
        setLoading(false);
      }
    };
    void tick();
    // Refresh while record is still running so the user sees live step logs
    const h = setInterval(() => {
      if (rec?.status === 'running') void tick();
    }, 2000);
    return () => { cancelled = true; clearInterval(h); };
  }, [recordId, rec?.status]);

  const openOutputDir = async () => {
    if (!rec?.output_dir) return;
    try {
      // Reuse the same IPC the task detail page uses — via the platform shell open.
      const w = window as any;
      if (w.electron?.shell?.openPath) {
        await w.electron.shell.openPath(rec.output_dir);
      } else if (w.__TAURI__?.shell?.open) {
        await w.__TAURI__.shell.open(rec.output_dir);
      } else {
        // Fallback: copy path to clipboard so user can navigate manually
        await navigator.clipboard.writeText(rec.output_dir);
        alert(i18nService.t('rrPathCopied') + rec.output_dir);
      }
    } catch (e) {
      console.error('[RunRecordDetail] openOutputDir failed:', e);
    }
  };

  if (loading) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <button type="button" onClick={onBack} className="mb-4 text-sm text-gray-500 hover:text-gray-900 dark:hover:text-white">
          ← {i18nService.t('rrBack')}
        </button>
        <div className="text-sm text-gray-400 py-6">{i18nService.t('rrLoading')}</div>
      </div>
    );
  }

  if (!rec) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <button type="button" onClick={onBack} className="mb-4 text-sm text-gray-500 hover:text-gray-900 dark:hover:text-white">
          ← {i18nService.t('rrBack')}
        </button>
        <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-700 p-10 text-center text-sm text-gray-500">
          {i18nService.t('rrNotFound')}
        </div>
      </div>
    );
  }

  const sc = rec.scenario_snapshot;
  const platform = sc.platform === 'x' ? i18nService.t('rrPlatTwitter')
    : sc.platform === 'xhs' ? i18nService.t('rrPlatXhs')
    : sc.platform === 'binance' ? i18nService.t('rrPlatBinance')
    : (sc.platform as any) === 'youtube' ? 'YouTube'
    : (sc.platform as any) === 'tiktok' ? 'TikTok'
    : (sc.platform as any) === 'douyin' ? i18nService.t('rrPlatDouyin')
    : (sc.platform as any) === 'kuaishou' ? i18nService.t('rrPlatKuaishou')
    : (sc.platform as any) === 'bilibili' ? i18nService.t('rrPlatBilibili')
    : (sc.platform as any) === 'shipinhao' ? i18nService.t('rrPlatShipinhao')
    : (sc.platform as any) === 'toutiao' ? i18nService.t('rrPlatToutiao')
    : (sc.platform as any) === 'video' ? i18nService.t('rrPlatVideo')
    : (sc.platform || '');
  // Same TRACK_ICONS + type-badge logic as MyTasksPage / RunHistoryPage so
  // the detail page header matches the row the user clicked on. Inlined
  // (not imported) to keep this component self-contained — they're tiny.
  const TRACK_ICONS_INLINE: Record<string, { icon: string; name_zh: string }> = {
    web3_alpha: { icon: '🎯', name_zh: 'Web3 · Alpha 猎人' },
    web3_defi: { icon: '🏛️', name_zh: 'Web3 · DeFi 用户' },
    web3_meme: { icon: '🎪', name_zh: 'Web3 · Meme 文化' },
    web3_builder: { icon: '🛠️', name_zh: 'Web3 · 建设者' },
    web3_zh_kol: { icon: '📢', name_zh: 'Web3 · 通用 KOL' },
    career_side_hustle: { icon: '💼', name_zh: '副业 · 打工人赚钱' },
    indie_dev: { icon: '👩‍💻', name_zh: '独立开发 · 程序员记录' },
    personal_finance: { icon: '💰', name_zh: '理财 · 记账攻略' },
    travel: { icon: '✈️', name_zh: '旅行 · 攻略分享' },
    food: { icon: '🍲', name_zh: '美食 · 探店做饭' },
    outfit: { icon: '👗', name_zh: '穿搭 · 风格分享' },
    beauty: { icon: '💄', name_zh: '美妆 · 产品测评' },
    fitness: { icon: '💪', name_zh: '健身 · 减脂日记' },
    reading: { icon: '📚', name_zh: '读书 · 书单笔记' },
    parenting: { icon: '🧸', name_zh: '育儿 · 亲子日常' },
    exam_prep: { icon: '🎓', name_zh: '考研 · 备考党' },
    pets: { icon: '🐱', name_zh: '宠物 · 猫狗日常' },
    home_decor: { icon: '🏠', name_zh: '家居 · 小屋布置' },
    study_method: { icon: '🏆', name_zh: '学习 · 效率工具' },
  };
  const trackId = (rec.task_snapshot && rec.task_snapshot.track) || '';
  const trackInfo = TRACK_ICONS_INLINE[trackId];
  const taskName = trackInfo ? trackInfo.name_zh : ((isZh ? sc.name_zh : sc.name_en) || sc.id);
  const taskIcon = trackInfo?.icon || sc.icon || '🤖';
  // Type label
  const typeBadge = (() => {
    const sid = sc.id;
    const wf = sc.workflow_type;
    const taskUrls = (rec.task_snapshot && rec.task_snapshot.urls) || [];
    const isXhsLinkMode = (rec.task_snapshot && rec.task_snapshot.track === 'link_mode')
      || (Array.isArray(taskUrls) && taskUrls.length > 0 && sc.platform === 'xhs');
    if (sid === 'x_auto_engage')                  return { icon: '🐦', label: i18nService.t('rrBadgeXEngage'), color: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/30' };
    if (sid === 'x_post_creator')                 return { icon: '📝', label: i18nService.t('rrBadgeXPost'), color: 'text-sky-500 bg-sky-500/10 border-sky-500/30' };
    if (sid === 'x_link_rewrite')                 return { icon: '✍️', label: i18nService.t('rrBadgeXLinkRewrite'), color: 'text-violet-500 bg-violet-500/10 border-violet-500/30' };
    if (sid === 'binance_square_auto_engage')     return { icon: '🤝', label: i18nService.t('rrBadgeBinanceEngage'), color: 'text-yellow-500 bg-yellow-500/10 border-yellow-500/30' };
    if (sid === 'binance_square_post_creator')    return { icon: '🔶', label: i18nService.t('rrBadgeBinancePost'), color: 'text-amber-500 bg-amber-500/10 border-amber-500/30' };
    if (sid === 'binance_from_x_repost')          return { icon: '🔁', label: i18nService.t('rrBadgeBinanceRepost'), color: 'text-orange-500 bg-orange-500/10 border-orange-500/30' };
    if (sid === 'binance_from_x_link')          return { icon: '🔗', label: i18nService.t('rrBadgeBinanceFromXLink'), color: 'text-orange-500 bg-orange-500/10 border-orange-500/30' };
    if (sid === 'youtube_auto_engage')          return { icon: '📺', label: i18nService.t('rrBadgeYoutubeEngage'), color: 'text-indigo-500 bg-indigo-500/10 border-indigo-500/30' };
    if (sid === 'tiktok_auto_engage')           return { icon: '🎵', label: i18nService.t('rrBadgeTiktokEngage'), color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
    if (sid === 'douyin_auto_engage')           return { icon: '🎵', label: i18nService.t('rrBadgeDouyinEngage'), color: 'text-violet-500 bg-violet-500/10 border-violet-500/30' };
    if (sid === 'douyin_reply_fans_comment')    return { icon: '💬', label: i18nService.t('rrBadgeDouyinReplyFans'), color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
    if (sid === 'xhs_reply_fans_comment')       return { icon: '💌', label: i18nService.t('rrBadgeXhsReplyFans'), color: 'text-fuchsia-500 bg-fuchsia-500/10 border-fuchsia-500/30' };
    if (sid === 'xhs_video_download')           return { icon: '⬇️', label: i18nService.t('rrBadgeXhsVideoDownload'), color: 'text-blue-500 bg-blue-500/10 border-blue-500/30' };
    if (sid === 'douyin_video_download')        return { icon: '⬇️', label: i18nService.t('rrBadgeDouyinVideoDownload'), color: 'text-sky-500 bg-sky-500/10 border-sky-500/30' };
    if (sid === 'tiktok_video_download')        return { icon: '⬇️', label: i18nService.t('rrBadgeTiktokVideoDownload'), color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
    if (sid === 'kuaishou_auto_engage')         return { icon: '⚡', label: i18nService.t('rrBadgeKuaishouEngage'), color: 'text-orange-500 bg-orange-500/10 border-orange-500/30' };
    if (sid === 'kuaishou_video_download')      return { icon: '⬇️', label: i18nService.t('rrBadgeKuaishouVideoDownload'), color: 'text-blue-500 bg-blue-500/10 border-blue-500/30' };
    if (sid === 'kuaishou_reply_fans_comment') return { icon: '💬', label: i18nService.t('rrBadgeKuaishouReplyFans'), color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
    if (sid === 'bilibili_auto_engage')         return { icon: '📺', label: i18nService.t('rrBadgeBilibiliEngage'), color: 'text-pink-500 bg-pink-500/10 border-pink-500/30' };
    if (sid === 'bilibili_video_download')      return { icon: '⬇️', label: i18nService.t('rrBadgeBilibiliVideoDownload'), color: 'text-blue-500 bg-blue-500/10 border-blue-500/30' };
    if (sid === 'bilibili_reply_fans_comment') return { icon: '💬', label: i18nService.t('rrBadgeBilibiliReplyFans'), color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
    if (sid === 'shipinhao_image_text')         return { icon: '📝', label: i18nService.t('rrBadgeShipinhaoImageText'), color: 'text-fuchsia-500 bg-fuchsia-500/10 border-fuchsia-500/30' };
    if (sid === 'shipinhao_reply_fans_comment') return { icon: '💬', label: i18nService.t('rrBadgeShipinhaoReplyFans'), color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
    if (sid === 'toutiao_image_text')           return { icon: '📝', label: i18nService.t('rrBadgeToutiaoImageText'), color: 'text-red-500 bg-red-500/10 border-red-500/30' };
    if (sid === 'toutiao_reply_fans_comment')   return { icon: '💬', label: i18nService.t('rrBadgeToutiaoReplyFans'), color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
    if (isXhsLinkMode)             return { icon: '🔗', label: i18nService.t('rrBadgeXhsLinkRewrite'), color: 'text-purple-500 bg-purple-500/10 border-purple-500/30' };
    // Platform-guarded fallback so Binance / YouTube / TikTok / Douyin auto_reply
    // don't get mis-labeled as 小红书.
    if (wf === 'auto_reply') {
      if (sc.platform === 'binance') return { icon: '💬', label: i18nService.t('rrBadgeBinanceEngage'), color: 'text-yellow-500 bg-yellow-500/10 border-yellow-500/30' };
      if ((sc.platform as any) === 'youtube') return { icon: '💬', label: i18nService.t('rrBadgeYoutubeEngage'), color: 'text-red-500 bg-red-500/10 border-red-500/30' };
      if ((sc.platform as any) === 'tiktok')  return { icon: '💬', label: i18nService.t('rrBadgeTiktokEngage'), color: 'text-pink-500 bg-pink-500/10 border-pink-500/30' };
      if ((sc.platform as any) === 'douyin')  return { icon: '💬', label: i18nService.t('rrBadgeDouyinEngage'), color: 'text-pink-500 bg-pink-500/10 border-pink-500/30' };
      if ((sc.platform as any) === 'kuaishou') return { icon: '💬', label: i18nService.t('rrBadgeKuaishouEngage'), color: 'text-orange-500 bg-orange-500/10 border-orange-500/30' };
      if ((sc.platform as any) === 'bilibili') return { icon: '💬', label: i18nService.t('rrBadgeBilibiliEngage'), color: 'text-pink-500 bg-pink-500/10 border-pink-500/30' };
      return { icon: '💬', label: i18nService.t('rrBadgeXhsEngage'), color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
    }
    if (sc.platform === 'binance') return { icon: '🔶', label: i18nService.t('rrBadgeBinanceSquarePost'), color: 'text-amber-500 bg-amber-500/10 border-amber-500/30' };
    if (sc.platform === 'x')       return { icon: '🐦', label: i18nService.t('rrBadgeXTask'), color: 'text-sky-500 bg-sky-500/10 border-sky-500/30' };
    if ((sc.platform as any) === 'youtube') return { icon: '📺', label: i18nService.t('rrBadgeYoutubeTask'), color: 'text-red-500 bg-red-500/10 border-red-500/30' };
    if ((sc.platform as any) === 'tiktok')  return { icon: '🎵', label: i18nService.t('rrBadgeTiktokTask'), color: 'text-pink-500 bg-pink-500/10 border-pink-500/30' };
    if ((sc.platform as any) === 'douyin')  return { icon: '🎵', label: i18nService.t('rrBadgeDouyinTask'), color: 'text-pink-500 bg-pink-500/10 border-pink-500/30' };
    if ((sc.platform as any) === 'kuaishou') return { icon: '⚡', label: i18nService.t('rrBadgeKuaishouTask'), color: 'text-orange-500 bg-orange-500/10 border-orange-500/30' };
    if ((sc.platform as any) === 'bilibili') return { icon: '📺', label: i18nService.t('rrBadgeBilibiliTask'), color: 'text-pink-500 bg-pink-500/10 border-pink-500/30' };
    if ((sc.platform as any) === 'shipinhao') return { icon: '📱', label: i18nService.t('rrBadgeShipinhaoTask'), color: 'text-green-500 bg-green-500/10 border-green-500/30' };
    if ((sc.platform as any) === 'toutiao') return { icon: '📰', label: i18nService.t('rrBadgeToutiaoTask'), color: 'text-red-500 bg-red-500/10 border-red-500/30' };
    return { icon: '🔥', label: i18nService.t('rrBadgeXhsBatchViral'), color: 'text-green-500 bg-green-500/10 border-green-500/30' };
  })();

  const statusPill = (() => {
    switch (rec.status) {
      case 'done':    return { icon: '✅', label: i18nService.t('rrStatusSuccess'), color: 'text-green-500 bg-green-500/10 border-green-500/30' };
      case 'partial': return { icon: '⚠️', label: i18nService.t('rrStatusPartial'), color: 'text-amber-500 bg-amber-500/10 border-amber-500/30' };
      case 'error':   return { icon: '❌', label: i18nService.t('rrStatusFailed'),  color: 'text-red-500 bg-red-500/10 border-red-500/30' };
      case 'stopped': return { icon: '⏹️', label: i18nService.t('rrStatusStopped'), color: 'text-gray-500 bg-gray-500/10 border-gray-500/30' };
      case 'running': return { icon: '⏳', label: i18nService.t('rrStatusRunning'), color: 'text-green-500 bg-green-500/10 border-green-500/30' };
      default:        return { icon: '❓', label: rec.status, color: 'text-gray-500 bg-gray-500/10 border-gray-500/30' };
    }
  })();

  // Group step logs by step number for cleaner rendering.
  // 防御:step_logs 可能缺失(老记录/适配层),或单条 log 缺 step 字段。缺 step 时归到第 1 步,
  // 否则 key 会变成 'undefined' → Number(NaN) → 重新索引取到 undefined → `logs.length` 整块崩。
  const stepGroups: Record<number, RunRecord['step_logs']> = {};
  for (const log of (Array.isArray(rec.step_logs) ? rec.step_logs : [])) {
    const k = Number.isFinite(log.step as any) ? (log.step as number) : 1;
    if (!stepGroups[k]) stepGroups[k] = [];
    stepGroups[k].push(log);
  }
  const stepNumbers = Object.keys(stepGroups).map(Number).sort((a, b) => a - b);

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <button type="button" onClick={onBack} className="mb-4 text-sm text-gray-500 hover:text-gray-900 dark:hover:text-white inline-flex items-center gap-1">
        ← {i18nService.t('rrBackToHistory')}
      </button>

      {/* Read-only banner */}
      <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-2 text-xs text-amber-700 dark:text-amber-300 leading-relaxed">
        🔒 {i18nService.t('rrReadOnlyBanner')}
      </div>

      {/* Header badges */}
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <span className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200">
          {sc.platform === 'x' ? '🐦' : sc.platform === 'binance' ? '🔶' : '📕'} {platform}
        </span>
        <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full border ${typeBadge.color}`}>
          {typeBadge.icon} {typeBadge.label}
        </span>
        <span className="text-base">{taskIcon}</span>
        <span className="font-bold text-base dark:text-white">{taskName}</span>
        <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full border ${statusPill.color}`}>
          {statusPill.icon} {statusPill.label}
        </span>
      </div>
      {/* IDs row — both task id and this record's id, in mono font, so
          users can copy/paste them to disambiguate runs in support chat. */}
      <div className="flex items-center gap-3 mb-3 text-[11px] text-gray-500 dark:text-gray-500 font-mono">
        <span>{i18nService.t('rrTaskIdLabel')} #{rec.task_id.slice(0, 8)}</span>
        <span>·</span>
        <span>{i18nService.t('rrRecordIdLabel')} #{shortId(rec.id)}</span>
      </div>

      {/* Stats — 5 columns on wide screens to accommodate the cost card.
          耗时 → 运行成本 → 日志条目 order per user spec: 运行成本 sits
          immediately after 耗时 as a first-class stat. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
        <Stat label={i18nService.t('rrStatStarted')} value={fullTime(rec.started_at, isZh)} />
        <Stat label={i18nService.t('rrStatFinished')} value={rec.finished_at ? fullTime(rec.finished_at, isZh) : i18nService.t('rrStatusRunning')} />
        <Stat
          label={i18nService.t('rrStatDuration')}
          value={rec.finished_at ? formatDuration(rec.finished_at - rec.started_at, isZh) : '-'}
        />
        {/* 本次完成 — per-action breakdown for this specific run. Mirrors
            TaskDetailPage's 上次完成 card style (👍 N 赞 · ➕ N 关注 · 💬 N 评论
            or 📤 N 发帖). Pre-rollout runs lack action_counts → '-'. */}
        {(() => {
          const ac = (rec.result as any)?.action_counts as Record<string, number> | undefined;
          const ICONS: Record<string, string> = { like: '👍', follow: '➕', subscribe: '📌', comment: '💬', reply: '💬', post: '📤', download: '⬇️' };
          const ORDER = ['like', 'follow', 'subscribe', 'comment', 'reply', 'post', 'download'];
          const labels = isZh
            ? { like: i18nService.t('rrActLike'), follow: i18nService.t('rrActFollow'), comment: i18nService.t('rrActComment'), reply: i18nService.t('rrActReply'), subscribe: i18nService.t('rrActSubscribe'), post: i18nService.t('rrActPost'), download: i18nService.t('rrActDownload') }
            : { like: i18nService.t('rrActLike'), follow: i18nService.t('rrActFollow'), comment: i18nService.t('rrActComment'), reply: i18nService.t('rrActReply'), subscribe: i18nService.t('rrActSubscribe'), post: i18nService.t('rrActPost'), download: i18nService.t('rrActDownload') };
          let display: React.ReactNode = '-';
          if (ac && Object.keys(ac).length > 0) {
            // 'note'(回复粉丝场景的文章进度内部计数)只在「本次运行进度」实时卡里展示;
            //   累计/历史里只看评论数,过滤掉,避免中文下出现未翻译的原始 "note"。
            const keys = Object.keys(ac).filter(k => (ac[k] || 0) > 0 && k !== 'note').sort((a, b) => {
              const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
              if (ia === -1 && ib === -1) return a.localeCompare(b);
              if (ia === -1) return 1;
              if (ib === -1) return -1;
              return ia - ib;
            });
            if (keys.length > 0) {
              // Stack lines vertically so the card stays narrow even with
              // 3 action types — single-line "👍 5 赞 · ➕ 3 关注 · 💬 4 评论"
              // wraps awkwardly inside a stat card width.
              display = (
                <span className="text-[12px] leading-tight">
                  {keys.map((k, i) => (
                    <React.Fragment key={k}>
                      {i > 0 && <br />}
                      {(ICONS[k] || '·')} {ac[k]} {(labels as any)[k] || k}
                    </React.Fragment>
                  ))}
                </span>
              );
            }
          }
          return <Stat label={i18nService.t('rrStatActions')} value={display} />;
        })()}
        {/* v2.4.37: 运行成本 卡 — always visible. 0-token runs just show
            "💎 0 / ≈ $0.0000" (user preference: prefer literal 0 over
            "—" placeholder). */}
        {(() => {
          const tokens = Number((rec.result as any)?.tokens_used) || 0;
          const cost = Number((rec.result as any)?.cost_usd) || 0;
          return (
            <Stat
              label={i18nService.t('rrStatAiCost')}
              value={<span>💎 {compactNum(tokens)}<br/><span className="text-[11px]">{HIDE_WEB3 ? `≈ ￥${cnyFromUsd(cost)}` : `≈ $${cost.toFixed(4)}`}</span></span>}
            />
          );
        })()}
        <Stat label={i18nService.t('rrStatLogEntries')} value={Array.isArray(rec.step_logs) ? rec.step_logs.length : 0} />
      </div>

      {/* Result + output dir */}
      {(rec.result || rec.output_dir || rec.error || (rec as any).summary) && (
        <div className="mb-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 space-y-2 text-sm">
          {/* v5.x+: 成功摘要走绿色,跟顶部 status badge 视觉一致;之前所有终态
              消息都进 error 字段挂红"错误:"前缀,跟 status='done' 自相矛盾。 */}
          {(rec as any).summary && rec.status !== 'error' && (
            <div className="text-green-500">
              <strong>{i18nService.t('rrLabelSummary')}</strong>{(rec as any).summary}
            </div>
          )}
          {rec.error && rec.status === 'error' && (
            <div className="text-red-500">
              <strong>{i18nService.t('rrLabelError')}</strong>{rec.error}
            </div>
          )}
          {rec.error && rec.status === 'stopped' && (
            <div className="text-amber-500">
              <strong>{i18nService.t('rrLabelStopped')}</strong>{rec.error}
            </div>
          )}
          {rec.result && (
            <div className="flex flex-wrap gap-3 text-xs">
              {typeof rec.result.collected_count === 'number' && (
                <span className="text-gray-600 dark:text-gray-300">
                  {i18nService.t('rrResultCollected')}: <strong>{rec.result.collected_count}</strong>
                </span>
              )}
              {typeof rec.result.draft_count === 'number' && (
                <span className="text-gray-600 dark:text-gray-300">
                  {i18nService.t('rrResultDrafts')}: <strong>{rec.result.draft_count}</strong>
                </span>
              )}
              {typeof rec.result.posted === 'number' && (
                <span className="text-gray-600 dark:text-gray-300">
                  {i18nService.t('rrResultPosted')}: <strong>{rec.result.posted}</strong>
                </span>
              )}
              {typeof (rec.result as any).tokens_used === 'number' && (rec.result as any).tokens_used > 0 && (
                <span className="text-gray-600 dark:text-gray-300" title={i18nService.t('rrTokensTooltip')}>
                  💎 Tokens: <strong>{compactNum((rec.result as any).tokens_used)}</strong>
                  {' '}· <strong>{HIDE_WEB3 ? `≈ ￥${cnyFromUsd((rec.result as any).cost_usd || 0)}` : `≈ $${((rec.result as any).cost_usd || 0).toFixed(4)}`}</strong></span>
              )}
            </div>
          )}
          {rec.output_dir && (
            <div className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300 pt-1 flex-wrap">
              <span>{i18nService.t('rrOutputLabel')}</span>
              {/* 点路径文字也能打开(保留旧交互) */}
              <button
                type="button"
                onClick={openOutputDir}
                className="text-blue-500 hover:underline truncate max-w-md text-left min-w-0"
                title={rec.output_dir}
              >
                📂 {rec.output_dir}
              </button>
              {/* 醒目按钮:跟视频/任务详情一致 */}
              <button
                type="button"
                onClick={openOutputDir}
                className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-semibold bg-blue-500 text-white hover:bg-blue-600 transition-colors"
              >
                📂 {i18nService.t('rrOpen')}
              </button>
            </div>
          )}
          {onOpenTask && (
            <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
              <button
                type="button"
                onClick={() => onOpenTask(rec.task_id)}
                className="text-xs text-blue-500 hover:underline"
              >
                → {i18nService.t('rrOpenTaskDetail')}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Step-by-step log timeline */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4">
        <h3 className="text-sm font-bold dark:text-white mb-3">
          {i18nService.t('rrFullRunLog')}
        </h3>
        {stepNumbers.length === 0 ? (
          <div className="text-xs text-gray-400 py-4 text-center">
            {i18nService.t('rrNoLogs')}
          </div>
        ) : (
          <div className="space-y-4">
            {stepNumbers.map(stepNum => {
              const logs = stepGroups[stepNum];
              const lastStatus = logs[logs.length - 1]?.status || 'running';
              const stepIcon = lastStatus === 'done' ? '✅' : lastStatus === 'error' ? '❌' : '⏳';
              return (
                <div key={stepNum}>
                  <div className="text-xs font-semibold text-gray-700 dark:text-gray-200 mb-1.5">
                    {stepIcon} {i18nService.t('rrStep')} {stepNum}
                  </div>
                  <div className="space-y-1 pl-4 border-l-2 border-gray-200 dark:border-gray-700">
                    {logs.map((log, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs">
                        <span className="text-gray-400 font-mono shrink-0">{log.time}</span>
                        <span className={`shrink-0 ${
                          log.status === 'done' ? 'text-green-500'
                            : log.status === 'error' ? 'text-red-500'
                            : 'text-gray-500'
                        }`}>
                          {log.status === 'done' ? '✓' : log.status === 'error' ? '✗' : '·'}
                        </span>
                        <span className="text-gray-700 dark:text-gray-300 break-all">{log.message}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

const Stat: React.FC<{ label: string; value: string | number | React.ReactNode }> = ({ label, value }) => (
  <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2">
    <div className="text-[11px] text-gray-500 dark:text-gray-400 mb-0.5">{label}</div>
    <div className="text-sm font-semibold dark:text-white truncate">{value}</div>
  </div>
);
