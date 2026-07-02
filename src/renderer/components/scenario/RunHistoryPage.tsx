/**
 * RunHistoryPage — unified timeline of every run across every task.
 *
 * v2.4.22+ reads from the new `runRecords` persistent store (full task
 * snapshot + step logs + output dir + result counts). Older lightweight
 * "runs" from riskGuard are no longer surfaced — only runs that started
 * with the new schema show up. (Per user request: 老的 if 没记录就算了.)
 *
 * Each row links to RunRecordDetailPage which is a READ-ONLY view of
 * what happened in that single run. Records are immutable — no
 * edit/run/delete buttons (those operations belong to the Task itself,
 * which lives separately).
 */

import React, { useEffect, useMemo, useState } from 'react';
import { shortId } from '../../utils/shortId';
import { i18nService } from '../../services/i18n';
import { HIDE_WEB3, cnyFromUsd } from '../../buildFlags';
import { friendlyRunError } from '../../services/runErrorMessage';
import { scenarioService, type Scenario, type Task } from '../../services/scenario';

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

// Same lookup as MyTasksPage so XHS records show "💼 副业" instead of
// the generic scenario name. Twitter web3 tracks + XHS niche tracks.
const TRACK_ICONS: Record<string, { icon: string; name_zh: string }> = {
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

function typeLabelForRecord(rec: RunRecord, isZh: boolean): { icon: string; label: string; color: string } {
  const sid = rec.scenario_snapshot.id;
  const wf = rec.scenario_snapshot.workflow_type;
  const taskUrls = (rec.task_snapshot && rec.task_snapshot.urls) || [];
  const isXhsLinkMode = (rec.task_snapshot && rec.task_snapshot.track === 'link_mode')
    || (Array.isArray(taskUrls) && taskUrls.length > 0 && rec.scenario_snapshot.platform === 'xhs');
  if (sid === 'x_auto_engage')               return { icon: '🐦', label: isZh ? '推特 · 互动涨粉' : 'Twitter Engage & Grow', color: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/30' };
  if (sid === 'x_post_creator')              return { icon: '📝', label: isZh ? '推特 · 自动发推' : 'Twitter Auto Post', color: 'text-sky-500 bg-sky-500/10 border-sky-500/30' };
  if (sid === 'x_link_rewrite')              return { icon: '✍️', label: isZh ? '推特 · 指定链接仿写' : 'Tweet Rewrite (URL)', color: 'text-violet-500 bg-violet-500/10 border-violet-500/30' };
  if (sid === 'binance_square_auto_engage')  return { icon: '🤝', label: isZh ? '币安广场 · 互动涨粉' : 'Binance Square Engage & Grow', color: 'text-yellow-500 bg-yellow-500/10 border-yellow-500/30' };
  if (sid === 'binance_square_post_creator') return { icon: '🔶', label: isZh ? '币安广场 · 自动发帖' : 'Binance Square Auto Post', color: 'text-amber-500 bg-amber-500/10 border-amber-500/30' };
  if (sid === 'binance_from_x_repost')       return { icon: '🔁', label: isZh ? '币安广场 · 推特批量搬运' : 'Binance · Repost from X (Batch)', color: 'text-orange-500 bg-orange-500/10 border-orange-500/30' };
  // v6.x: 3 个新搬运源 — 跟 MyTasksPage label 对齐
  if (sid === 'binance_from_xhs_viral')      return { icon: '📕', label: isZh ? '币安广场 · 小红书批量搬运' : 'Binance · Repost from Xiaohongshu', color: 'text-rose-500 bg-rose-500/10 border-rose-500/30' };
  if (sid === 'binance_from_douyin_viral')   return { icon: '🎵', label: isZh ? '币安广场 · 抖音批量搬运' : 'Binance · Repost from Douyin', color: 'text-pink-500 bg-pink-500/10 border-pink-500/30' };
  if (sid === 'binance_from_tiktok_viral')   return { icon: '🎬', label: isZh ? '币安广场 · TikTok 批量搬运' : 'Binance · Repost from TikTok', color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
  if (sid === 'binance_from_x_link')       return { icon: '🔗', label: isZh ? '币安广场 · 推特链接仿写' : 'Binance · From X Link', color: 'text-orange-500 bg-orange-500/10 border-orange-500/30' };
  // Douyin / YouTube / TikTok — explicit sid matches BEFORE the workflow_type
  // fallback below, otherwise their workflow_type='auto_reply' / 'viral_production'
  // would short-circuit into the XHS-default branches and they'd render with
  // "小红书" labels even though the records are actually for Douyin/YT/TT.
  // Colors mirror MyTasksPage (which had the same bug fixed earlier) so badges
  // look identical across the task list and the run history list.
  if (sid === 'youtube_auto_engage')         return { icon: '📺', label: isZh ? 'YouTube · 互动涨粉' : 'YouTube Engage & Grow', color: 'text-indigo-500 bg-indigo-500/10 border-indigo-500/30' };
  if (sid === 'tiktok_auto_engage')          return { icon: '🎵', label: isZh ? 'TikTok · 互动涨粉' : 'TikTok Engage & Grow', color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
  if (sid === 'douyin_auto_engage')          return { icon: '🎵', label: isZh ? '抖音 · 互动涨粉' : 'Douyin Engage & Grow', color: 'text-violet-500 bg-violet-500/10 border-violet-500/30' };
  if (sid === 'douyin_image_text')           return { icon: '📝', label: isZh ? '抖音 · 图文创作' : 'Douyin Image-Text', color: 'text-fuchsia-500 bg-fuchsia-500/10 border-fuchsia-500/30' };
  if (sid === 'douyin_reply_fans_comment')   return { icon: '💬', label: isZh ? '抖音 · 自动回复粉丝' : 'Douyin Reply Fan Comments', color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
  if (sid === 'xhs_reply_fans_comment')      return { icon: '💌', label: isZh ? '小红书 · 自动回复粉丝' : 'XHS Reply Fan Comments', color: 'text-fuchsia-500 bg-fuchsia-500/10 border-fuchsia-500/30' };
  if (sid === 'xhs_video_download')          return { icon: '⬇️', label: isZh ? '小红书 · 视频无水印下载' : 'XHS Video Download', color: 'text-blue-500 bg-blue-500/10 border-blue-500/30' };
  if (sid === 'douyin_video_download')       return { icon: '⬇️', label: isZh ? '抖音 · 视频无水印下载' : 'Douyin Video Download', color: 'text-sky-500 bg-sky-500/10 border-sky-500/30' };
  if (sid === 'tiktok_video_download')       return { icon: '⬇️', label: isZh ? 'TikTok · 视频无水印下载' : 'TikTok Video Download', color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
  if (sid === 'kuaishou_auto_engage')        return { icon: '⚡', label: isZh ? '快手 · 互动涨粉' : 'Kuaishou Engage & Grow', color: 'text-orange-500 bg-orange-500/10 border-orange-500/30' };
  if (sid === 'kuaishou_video_download')     return { icon: '⬇️', label: isZh ? '快手 · 视频无水印下载' : 'Kuaishou Video Download', color: 'text-blue-500 bg-blue-500/10 border-blue-500/30' };
  if (sid === 'kuaishou_reply_fans_comment') return { icon: '💬', label: isZh ? '快手 · 自动回复粉丝' : 'Kuaishou Reply Fan Comments', color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
  if (sid === 'bilibili_auto_engage')        return { icon: '📺', label: isZh ? '哔哩哔哩 · 互动涨粉' : 'Bilibili Engage & Grow', color: 'text-pink-500 bg-pink-500/10 border-pink-500/30' };
  if (sid === 'bilibili_video_download')     return { icon: '⬇️', label: isZh ? '哔哩哔哩 · 视频无水印下载' : 'Bilibili Video Download', color: 'text-blue-500 bg-blue-500/10 border-blue-500/30' };
  if (sid === 'bilibili_reply_fans_comment') return { icon: '💬', label: isZh ? '哔哩哔哩 · 自动回复粉丝' : 'Bilibili Reply Fan Comments', color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
  if (sid === 'shipinhao_image_text')         return { icon: '📝', label: isZh ? '视频号 · 图文创作' : 'WeChat Channels Image-Text', color: 'text-fuchsia-500 bg-fuchsia-500/10 border-fuchsia-500/30' };
  if (sid === 'shipinhao_reply_fans_comment') return { icon: '💬', label: isZh ? '视频号 · 自动回复粉丝' : 'WeChat Channels Reply Fan Comments', color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
  if (sid === 'toutiao_image_text')           return { icon: '📝', label: isZh ? '头条号 · 图文创作' : 'Toutiao Image-Text', color: 'text-red-500 bg-red-500/10 border-red-500/30' };
  if (sid === 'toutiao_reply_fans_comment')   return { icon: '💬', label: isZh ? '头条号 · 自动回复粉丝' : 'Toutiao Reply Fan Comments', color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
  if (isXhsLinkMode)             return { icon: '🔗', label: isZh ? '小红书 · 指定链接爆款仿写' : 'XHS Rewrite (URL)', color: 'text-purple-500 bg-purple-500/10 border-purple-500/30' };
  // workflow_type fallback — check platform first so Binance auto_reply
  // doesn't get mis-labeled as XHS auto_reply. (Douyin/YT/TT are now
  // covered by the explicit sid matches above and won't fall through here.)
  const plat = rec.scenario_snapshot.platform;
  if (wf === 'auto_reply') {
    if (plat === 'binance') return { icon: '💬', label: isZh ? '币安广场 · 互动涨粉' : 'Binance Square Engage & Grow', color: 'text-yellow-500 bg-yellow-500/10 border-yellow-500/30' };
    return { icon: '💬', label: isZh ? '小红书 · 互动涨粉' : 'XHS Engage & Grow', color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
  }
  if (plat === 'binance') return { icon: '🔶', label: isZh ? '币安广场发帖' : 'Binance Square Post', color: 'text-amber-500 bg-amber-500/10 border-amber-500/30' };
  if (plat === 'x')       return { icon: '🐦', label: isZh ? '推特任务' : 'Twitter Task', color: 'text-sky-500 bg-sky-500/10 border-sky-500/30' };
  // Platform-aware final fallback — old code defaulted everything unknown
  // to "小红书 · 爆款批量仿写" which mislabeled e.g. future Douyin variants.
  if (plat === 'douyin')  return { icon: '🎵', label: isZh ? '抖音任务' : 'Douyin Task', color: 'text-rose-500 bg-rose-500/10 border-rose-500/30' };
  if (plat === 'kuaishou') return { icon: '⚡', label: isZh ? '快手任务' : 'Kuaishou Task', color: 'text-orange-500 bg-orange-500/10 border-orange-500/30' };
  if (plat === 'bilibili') return { icon: '📺', label: isZh ? '哔哩哔哩任务' : 'Bilibili Task', color: 'text-pink-500 bg-pink-500/10 border-pink-500/30' };
  if ((plat as any) === 'shipinhao') return { icon: '📱', label: isZh ? '视频号任务' : 'WeChat Channels Task', color: 'text-green-500 bg-green-500/10 border-green-500/30' };
  if ((plat as any) === 'toutiao') return { icon: '📰', label: isZh ? '头条号任务' : 'Toutiao Task', color: 'text-red-500 bg-red-500/10 border-red-500/30' };
  if (plat === 'youtube') return { icon: '📺', label: isZh ? 'YouTube 任务' : 'YouTube Task', color: 'text-red-500 bg-red-500/10 border-red-500/30' };
  if (plat === 'tiktok')  return { icon: '🎬', label: isZh ? 'TikTok 任务' : 'TikTok Task', color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
  return { icon: '🔥', label: isZh ? '小红书 · 爆款批量仿写' : 'XHS Batch Viral', color: 'text-green-500 bg-green-500/10 border-green-500/30' };
}

interface Props {
  /** Pre-filtered tasks for the active platform (parent handles the
   *  platform sub-tab and re-filters). */
  tasks: Task[];
  scenarios: Scenario[];
  /** Current platform — used to filter the records list down to
   *  records whose scenario_snapshot.platform matches. */
  platformId: string;
  platformLabel: string;
  /** Click on a record row → opens RunRecordDetailPage. Optional;
   *  no-op when navigation isn't wired up. */
  onOpenRecord?: (record_id: string) => void;
  /** Optional task filter (set when entering history from a specific
   *  task's "查看历史运行记录" button). */
  filterByTaskId?: string | null;
  onClearFilter?: () => void;
}

function formatDuration(ms: number, isZh: boolean): string {
  if (ms < 1000) return ms + 'ms';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + (isZh ? '秒' : 's');
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return `${m}${isZh ? '分' : 'm'}${remS > 0 ? `${remS}${isZh ? '秒' : 's'}` : ''}`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}${isZh ? '时' : 'h'}${remM > 0 ? `${remM}${isZh ? '分' : 'm'}` : ''}`;
}

function formatTime(ts: number, isZh: boolean): string {
  if (!ts) return '-';
  return new Date(ts).toLocaleString(isZh ? 'zh-CN' : 'en-US', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
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

export const RunHistoryPage: React.FC<Props> = ({
  tasks: _tasks,
  scenarios: _scenarios,
  platformId,
  platformLabel,
  onOpenRecord,
  filterByTaskId,
  onClearFilter,
}) => {
  const isZh = i18nService.currentLanguage === 'zh';
  const [records, setRecords] = useState<RunRecord[]>([]);
  const [loading, setLoading] = useState(true);
  // ── Pagination (v2.4.27) ──
  // Run records max out at 500 server-side. With one heavy user
  // (multiple daily tasks × weeks of history) the unpaginated list
  // got long enough to scroll forever — added 20-per-page client-side
  // pagination. Reset to page 1 whenever filter / platform changes.
  const PAGE_SIZE = 20;
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [platformId, filterByTaskId]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const recs = await scenarioService.listRunRecords({
        platform: platformId,
        task_id: filterByTaskId || undefined,
        // v2.4.35: ask for the lightweight payload — list page only
        // needs summary fields; full step_logs fetched by detail page.
        // Without this, 50+ records × 500 step_logs made each 2s poll
        // transfer multi-MB, which felt like "记录很久才出现".
        light: true,
      });
      if (cancelled) return;
      // v5.x+: running records ARE included now (user reversed earlier
      // "only completed runs" preference — they want to see live
      // progress 5/32 in the list while a task is in flight). The
      // running row carries action_counts/action_targets from
      // scenarioManager's live RunProgress mirror so X/Y renders without
      // a separate getRunProgress call from the renderer. Completed rows
      // also benefit because action_targets is now persisted at finish.
      setRecords(recs as RunRecord[]);
      setLoading(false);
    };
    void tick();
    // Refresh every 2s (was 5s pre-2.4.34) — combined with backend
    // debounced-persist fix this gives near-instant "刚跑完的任务出现
    // 在历史" UX. listRunRecords IPC reads in-memory only so polling
    // faster is cheap (no extra disk I/O).
    const h = setInterval(tick, 2000);
    return () => { cancelled = true; clearInterval(h); };
  }, [platformId, filterByTaskId]);

  const totalPages = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
  // Clamp page in case the records list shrank below the current page
  // (e.g. user switched to a less-active platform).
  const safePage = Math.min(page, totalPages);
  const pagedRecords = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return records.slice(start, start + PAGE_SIZE);
  }, [records, safePage]);

  const filteredTaskName = useMemo(() => {
    if (!filterByTaskId) return null;
    // Get the snapshot from the most recent record for that task
    const rec = records.find(r => r.task_id === filterByTaskId);
    if (!rec) return null;
    const sc = rec.scenario_snapshot;
    return (isZh ? sc.name_zh : sc.name_en) || sc.id;
  }, [filterByTaskId, records, isZh]);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <section className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold dark:text-white">
              📊 {filterByTaskId
                ? i18nService.t('rhTitleTask').replace('{id}', filterByTaskId.slice(0, 8))
                : i18nService.t('rhTitlePlatform').replace('{platform}', platformLabel)}
            </h2>
            {filterByTaskId && onClearFilter && (
              <button
                type="button"
                onClick={onClearFilter}
                className="mt-1 text-xs text-blue-500 hover:underline"
              >
                ← {i18nService.t('rhShowAll').replace('{platform}', platformLabel)}
              </button>
            )}
            {filteredTaskName && (
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {i18nService.t('rhTaskColon')}{filteredTaskName}
              </div>
            )}
          </div>
        </div>

        {loading && records.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-gray-400 py-6">
            <span className="h-4 w-4 rounded-full border-2 border-green-500 border-t-transparent animate-spin" />
            {i18nService.t('rhLoading')}
          </div>
        ) : records.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-700 p-10 text-center">
            <div className="text-4xl mb-2">📜</div>
            <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">
              {i18nService.t('rhNoneForPlatform').replace('{platform}', platformLabel)}
            </div>
            <div className="text-xs text-gray-400 dark:text-gray-500">
              {i18nService.t('rhEmptyHint')}
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {pagedRecords.map(rec => {
              const sc = rec.scenario_snapshot;
              const trackId = (rec.task_snapshot && rec.task_snapshot.track) || '';
              const trackInfo = TRACK_ICONS[trackId];
              const typeBadge = typeLabelForRecord(rec, isZh);
              // Display name: prefer track (matches MyTasksPage), fall back to
              // generic scenario name, then to id.
              const displayName = trackInfo
                ? trackInfo.name_zh
                : ((isZh ? sc.name_zh : sc.name_en) || sc.id);
              const displayIcon = trackInfo?.icon || sc.icon || '🤖';
              const duration = rec.finished_at
                ? formatDuration(rec.finished_at - rec.started_at, isZh)
                : null;
              const statusPill = (() => {
                switch (rec.status) {
                  case 'done':    return { icon: '✅', label: i18nService.t('rhStatusSuccess'), color: 'text-green-500 bg-green-500/10 border-green-500/30' };
                  case 'partial': return { icon: '⚠️', label: i18nService.t('rhStatusPartial'), color: 'text-amber-500 bg-amber-500/10 border-amber-500/30' };
                  case 'error':   return { icon: '❌', label: i18nService.t('rhStatusFailed'),  color: 'text-red-500 bg-red-500/10 border-red-500/30' };
                  case 'stopped': return { icon: '⏹️', label: i18nService.t('rhStatusStopped'), color: 'text-gray-500 bg-gray-500/10 border-gray-500/30' };
                  case 'running': return { icon: '⏳', label: i18nService.t('rhStatusRunning'), color: 'text-green-500 bg-green-500/10 border-green-500/30' };
                  default:        return { icon: '❓', label: rec.status, color: 'text-gray-500 bg-gray-500/10 border-gray-500/30' };
                }
              })();

              return (
                <button
                  key={rec.id}
                  type="button"
                  onClick={() => onOpenRecord && onOpenRecord(rec.id)}
                  className={`w-full text-left rounded-lg border p-3 transition-colors ${
                    rec.status === 'running'
                      ? 'border-green-500/50 bg-white dark:bg-gray-900 noobclaw-running-glow hover:border-green-500'
                      : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 hover:border-green-500/50'
                  } cursor-pointer`}
                >
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <span className={`shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border ${statusPill.color}`}>
                        {statusPill.icon} {statusPill.label}
                      </span>
                      <span className={`shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border ${typeBadge.color}`}>
                        {typeBadge.icon} {typeBadge.label}
                      </span>
                      <span className="text-base shrink-0">{displayIcon}</span>
                      <span className="font-medium dark:text-white truncate">{displayName}</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400 shrink-0 flex-wrap">
                      <span>⏱️ {formatTime(rec.started_at, isZh)}</span>
                      {duration && <span>· {duration}</span>}
                      {/* v2.4.37: AI cost per run — ALWAYS show (was
                          gated on tokens_used > 0, which meant runs that
                          failed before calling AI had no cost column and
                          users thought the feature wasn't working).
                          Failed / no-AI runs now show "💎 —" with a
                          tooltip explaining no AI was called. */}
                      {(() => {
                        const tokens = Number(rec.result?.tokens_used) || 0;
                        const cost = Number((rec.result as any)?.cost_usd) || 0;
                        return (
                          <span title={i18nService.t('rhCostTip')}>
                            · 💎 {compactNum(tokens)} {HIDE_WEB3 ? `≈ ￥${cnyFromUsd(cost)}` : `≈ $${cost.toFixed(4)}`}
                          </span>
                        );
                      })()}
                    </div>
                  </div>
                  {/* 本次完成 — its own row below the top line so the time
                      and cost chips stay uncrowded. Mirrors TaskDetailPage's
                      累计完成 icon set (👍 like / ➕ follow / 📌 subscribe /
                      💬 comment / 📤 post).
                      v5.x+: renders "X/Y" when action_targets is present
                      (e.g. "👍 5/32 · ➕ 1/3 · 💬 2/2"). action_targets
                      is the planned per-action quota declared by the
                      orchestrator via ctx.setActionTargets at run start;
                      scenarioManager mirrors it into the run record both
                      live (running rows update every per-action bump)
                      and at finish (so completed rows keep the X/Y
                      display). Pre-rollout records have neither field
                      and stay flat via the early null return. */}
                  {(() => {
                    const ac = (rec.result as any)?.action_counts as Record<string, number> | undefined;
                    const at = (rec.result as any)?.action_targets as Record<string, number> | undefined;
                    if (!ac && !at) return null;
                    const ICONS: Record<string, string> = { like: '👍', follow: '➕', subscribe: '📌', comment: '💬', reply: '💬', post: '📤', download: '⬇️' };
                    const ORDER = ['like', 'follow', 'subscribe', 'comment', 'reply', 'post', 'download'];
                    const labels: Record<string, string> = { like: i18nService.t('rhActLike'), follow: i18nService.t('rhActFollow'), comment: i18nService.t('rhActComment'), reply: i18nService.t('rhActReply'), subscribe: i18nService.t('rhActSubscribe'), post: i18nService.t('rhActPost'), download: i18nService.t('rhActDownload') };
                    // Union of keys present in either map — running rows
                    // may briefly have only targets (orchestrator set
                    // them, no addActionCount yet); completed rows have
                    // both.
                    const allKeys = new Set<string>([
                      ...Object.keys(ac || {}),
                      ...Object.keys(at || {}),
                    ]);
                    // 内容/工具类任务(图文创作/爆款仿写/自动发推/币安广场发帖/视频下载)的运行记录
                    //   action_counts 恒以 {like:0,follow:0,comment:0} 打底(sidecar),再补 post/download。
                    //   这类记录里带 post 或 download → 把恒 0 的赞/关注/评论/订阅/回复丢掉,只留 post/download,
                    //   否则历史里会误显「👍0 · ➕0 · 💬0 · 📤N」。互动任务(无 post/download)不受影响,照常显示三档。
                    // 按【键是否存在】判别(不看值):内容/工具记录恒带 post/download 键(哪怕为 0,如发布失败的 0 帖),
                    //   互动记录从不带 → 失败的 0 帖记录也能正确归类、不误显赞/关注/评论。
                    const isContentOrTool = !!ac && ('post' in ac || 'download' in ac);
                    const ENGAGE_KEYS = new Set(['like', 'follow', 'comment', 'subscribe', 'reply']);
                    // 'note' 是回复粉丝场景的「文章进度」内部计数(当前第几篇/总),只在
                    //   「本次运行进度」实时卡里有意义;累计/历史里只展示评论数,过滤掉它,
                    //   否则中文下会出现未翻译的原始 "note" 键名。
                    const keys = Array.from(allKeys).filter(k => k !== 'note' && !(isContentOrTool && ENGAGE_KEYS.has(k))).sort((a, b) => {
                      const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
                      if (ia === -1 && ib === -1) return a.localeCompare(b);
                      if (ia === -1) return 1;
                      if (ib === -1) return -1;
                      return ia - ib;
                    });
                    if (keys.length === 0) return null;
                    const isRunning = rec.status === 'running';
                    return (
                      <div className="mt-1.5 flex items-center gap-3 text-xs text-gray-600 dark:text-gray-300 flex-wrap" title={isZh ? (isRunning ? '本次运行已完成 / 计划目标' : '本次完成的动作') : (isRunning ? 'Done / planned this run' : 'Actions completed this run')}>
                        <span className={`text-[10px] ${isRunning ? 'text-green-600 dark:text-green-400 font-semibold' : 'text-gray-500 dark:text-gray-500'}`}>
                          {isRunning ? i18nService.t('rhCurrentProgress') : i18nService.t('rhActionsDone')}:
                        </span>
                        {keys.map(k => {
                          const done = ac?.[k] ?? 0;
                          const target = at?.[k] ?? 0;
                          return (
                            <span key={k} className="font-medium font-mono">
                              {(ICONS[k] || '·')}{' '}
                              {target > 0 ? (
                                <>
                                  <span className={isRunning ? 'text-green-600 dark:text-green-400' : ''}>{done}</span>
                                  <span className="text-gray-400 dark:text-gray-500">/{target}</span>
                                </>
                              ) : (
                                <span>{done}</span>
                              )}{' '}
                              <span className="text-gray-500 dark:text-gray-400 font-normal font-sans">{(labels as any)[k] || k}</span>
                            </span>
                          );
                        })}
                      </div>
                    );
                  })()}
                  {/* IDs row — both task id and record id so users can
                      tell separate runs of the same task apart. */}
                  <div className="flex items-center gap-3 mt-1 text-[10px] text-gray-500 dark:text-gray-500 font-mono">
                    <span>{i18nService.t('rhTaskId')} #{rec.task_id.slice(0, 8)}</span>
                    <span>·</span>
                    <span>{i18nService.t('rhRecordId')} #{shortId(rec.id)}</span>
                  </div>
                  {/* Result summary + error reason */}
                  {(rec.error || (rec as any).summary || rec.result) && (
                    <div className="mt-1.5 text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                      {/* v5.x+: 成功摘要走绿色,失败/中止走橙色 — 之前都进 amber 字段
                          导致 "成功" 卡片下挂着橙色摘要,容易被误认为警告。 */}
                      {(rec as any).summary && rec.status !== 'error' && (
                        <span className="text-green-600 dark:text-green-400 mr-2">
                          {((rec as any).summary as string).length > 100
                            ? ((rec as any).summary as string).slice(0, 100) + '...'
                            : (rec as any).summary}
                        </span>
                      )}
                      {rec.error && (rec.status === 'error' || rec.status === 'stopped') && (
                        <span className="text-amber-600 dark:text-amber-400 mr-2">
                          {/* v2.6.x: route raw orchestrator codes through the
                              shared friendlyRunError() table — old behavior
                              showed cryptic strings like "type_failed" /
                              "search_input_click_failed" directly to users. */}
                          {(() => {
                            const friendly = friendlyRunError(rec.error, isZh ? 'zh' : 'en');
                            return friendly.length > 100 ? friendly.slice(0, 100) + '...' : friendly;
                          })()}
                        </span>
                      )}
                      {rec.result && typeof rec.result.collected_count === 'number' && rec.result.collected_count > 0 && (
                        <span className="mr-2">
                          {i18nService.t('rhCollected').replace('{n}', String(rec.result.collected_count))}
                        </span>
                      )}
                      {rec.result && typeof rec.result.draft_count === 'number' && rec.result.draft_count > 0 && (
                        <span className="mr-2">
                          {i18nService.t('rhProduced').replace('{n}', String(rec.result.draft_count))}
                        </span>
                      )}
                      {rec.result && typeof rec.result.posted === 'number' && rec.result.posted > 0 && (
                        <span className="mr-2">
                          {i18nService.t('rhPosted').replace('{n}', String(rec.result.posted))}
                        </span>
                      )}
                      <span className="text-[10px] text-gray-400">
                        {i18nService.t('rhLogEntries').replace('{n}', String(rec.step_logs.length))}
                      </span>
                    </div>
                  )}
                </button>
              );
            })}
            {/* Pagination controls — only show when there's > 1 page.
                Shows: « 上一页 · "第 N / 总 页 (共 M 条)" · 下一页 » */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 pt-4 text-xs">
                <button
                  type="button"
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={safePage === 1}
                  className="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-green-500/50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  « {i18nService.t('rhPrev')}
                </button>
                <span className="text-gray-500 dark:text-gray-400 min-w-[120px] text-center">
                  {i18nService.t('rhPageInfo').replace('{cur}', String(safePage)).replace('{total}', String(totalPages)).replace('{count}', String(records.length))}
                </span>
                <button
                  type="button"
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={safePage === totalPages}
                  className="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-green-500/50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {i18nService.t('rhNext')} »
                </button>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
};
