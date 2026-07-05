/**
 * KuaishouWorkflowsPage — 快手平台工作流页面.
 *
 * 已挂 scenarios（3 个独立任务体系，互不影响）:
 *   kuaishou_auto_engage         — 自动浏览推荐流，按用户配置做点赞 / 关注 / 评论
 *   kuaishou_video_download      — 粘 1-20 个快手视频链接逐个无水印下载到本地
 *   kuaishou_reply_fans_comment  — 在快手创作者服务平台「评论管理」逐条回复粉丝
 *
 * 结构跟 DouyinWorkflowsPage 对齐，主色 orange。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { scenarioService, type Scenario, type Task, type Draft } from '../../services/scenario';
import { LoginRequiredModal } from './LoginRequiredModal';
import { CardActionRow } from './CardActionRow';
import { noobClawAuth } from '../../services/noobclawAuth';

interface Props {
  scenarios: Scenario[];           // already filtered to platform='kuaishou' by parent
  tasks: Task[];
  draftsByTask: Map<string, Draft[]>;
  loading: boolean;
  onOpenTask: (task_id: string, fromOverride?: 'create' | 'tasks' | 'history') => void;
  onConfigure: (scenario: Scenario) => void;
  onChanged?: () => void | Promise<void>;
  /** Jump to "My Tasks" filtered to Kuaishou — used by 已达上限 modal CTA. */
  onGoToMyTasks?: () => void;
}

export const KuaishouWorkflowsPage: React.FC<Props> = ({
  scenarios,
  tasks,
  draftsByTask: _draftsByTask,
  loading,
  onOpenTask,
  onConfigure,
  onChanged,
  onGoToMyTasks,
}) => {
  const isZh = i18nService.currentLanguage === 'zh';
  const [loginModalReason, setLoginModalReason] = useState<string | null>(null);
  const [, setRunningTaskIds] = useState<Set<string>>(new Set());

  // 同平台任务上限 5 个 — 跟其他平台对齐。
  const MAX_TASKS = 5;
  const [maxTasksModalOpen, setMaxTasksModalOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const pull = async () => {
      try {
        const ids = await scenarioService.getRunningTaskIds();
        if (!cancelled) setRunningTaskIds(new Set(ids));
      } catch {}
    };
    void pull();
    const h = setInterval(pull, 5000);
    return () => { cancelled = true; clearInterval(h); };
  }, []);

  const findById = (id: string): Scenario | null =>
    scenarios.find(s => s.id === id) || null;

  // Fallback 让卡片在 scenario 列表还没拉到时也能点开 wizard
  const FALLBACK_AUTO_ENGAGE: Scenario = {
    id: 'kuaishou_auto_engage',
    version: '1.0.0',
    platform: 'kuaishou' as any,
    workflow_type: 'kuaishou_auto_engage' as any,
    category: 'engagement',
    name_zh: '快手 · 互动涨粉',
    name_en: 'Kuaishou Engage & Grow',
    description_zh: '每天定时刷快手推荐流，挑出若干视频按你配置的组合做点赞 / 关注 / 评论。三项动作可独立开关，评论由 AI 按视频文案与置顶评论自动生成，行为间隔随机模拟真人。',
    description_en: 'Browses Kuaishou recommend feed on schedule, picks videos and runs your configured mix of like / follow / comment. Each action toggles independently; comments are AI-generated from caption + top comments.',
    icon: '⚡',
    default_config: {
      keywords: [],
      persona: '对短视频感兴趣的普通观众，评论自然口语，不爹味、不拍马屁',
      daily_count: 5,
      variants_per_post: 1,
      schedule_window: '09:00-23:00',
    } as any,
    risk_caps: {
      max_daily_runs: 1,
      max_scroll_per_run: 30,
      min_scroll_delay_ms: 3000,
      max_scroll_delay_ms: 10000,
      read_dwell_min_ms: 12000,
      read_dwell_max_ms: 45000,
      max_run_duration_ms: 7200000,
      min_interval_hours: 24,
      weekly_rest_days: 1,
      cooldown_captcha_hours: 24,
      cooldown_rate_limit_hours: 48,
      cooldown_account_flag_hours: 72,
    } as any,
    required_login_url: 'https://www.kuaishou.com',
    entry_urls: {},
    skills: {},
  } as any;

  const autoEngage = findById('kuaishou_auto_engage') || FALLBACK_AUTO_ENGAGE;

  // ── 视频无水印下载 fallback —— 一次性工具任务,粘 1-20 个快手视频链接逐个下到本地。
  const FALLBACK_VIDEO_DL: Scenario = {
    id: 'kuaishou_video_download',
    version: '1.0.0',
    platform: 'kuaishou' as any,
    workflow_type: 'kuaishou_video_download' as any,
    category: 'tool',
    name_zh: '快手 · 视频无水印下载',
    name_en: 'Kuaishou · Watermark-free Video Download',
    description_zh: '粘贴 1-20 个快手视频链接，依次在本地浏览器打开，借快手页面自身签名解析出无水印原视频并下载到本地。一次性任务，只需登录快手主站。',
    description_en: 'Paste 1-20 Kuaishou video links; opens each locally, resolves the watermark-free source video and downloads it. One-time task, only needs main-site login.',
    icon: '⬇️',
    default_config: {
      keywords: [],
      persona: '',
      daily_count: 1,
      variants_per_post: 1,
      schedule_window: '00:00-23:59',
    } as any,
    risk_caps: {
      max_daily_runs: 50,
      max_scroll_per_run: 0,
      min_scroll_delay_ms: 0,
      max_scroll_delay_ms: 0,
      read_dwell_min_ms: 0,
      read_dwell_max_ms: 0,
      max_run_duration_ms: 1800000,
      min_interval_hours: 0,
      weekly_rest_days: 0,
      cooldown_captcha_hours: 24,
      cooldown_rate_limit_hours: 48,
      cooldown_account_flag_hours: 72,
    } as any,
    required_login_url: 'https://www.kuaishou.com',
    entry_urls: {},
    skills: {},
  } as any;

  const videoDownload = findById('kuaishou_video_download') || FALLBACK_VIDEO_DL;

  const FALLBACK_REPLY_FANS: Scenario = {
    id: 'kuaishou_reply_fans_comment',
    version: '1.0.0',
    platform: 'kuaishou' as any,
    workflow_type: 'kuaishou_reply_fans_comment' as any,
    category: 'engagement',
    name_zh: '快手 · 自动回复粉丝',
    name_en: 'Kuaishou Reply Fan Comments',
    description_zh: '在快手创作者服务平台「评论管理」逐条回复粉丝评论。AI 按评论内容写回应，可选引流尾巴。已回复过的、自己留的评论自动跳过，只回粉丝、绝不评论作品本身。',
    description_en: 'Auto-reply to fan comments in Kuaishou Creator Platform comment management. AI-tailored, optional funnel tail. Skips already-replied / your own.',
    icon: '💬',
    default_config: {
      funnel_phrase: '',
      funnel_probability: 50,
      schedule_window: '10:00-22:00',
    } as any,
    risk_caps: {} as any,
    required_login_url: 'https://cp.kuaishou.com/',
    entry_urls: {},
    skills: {},
  } as any;

  const replyFans = findById('kuaishou_reply_fans_comment') || FALLBACK_REPLY_FANS;

  // 视频无水印下载 modal state
  const [videoDlModalOpen, setVideoDlModalOpen] = useState(false);
  const [videoDlLinksText, setVideoDlLinksText] = useState('');
  const [videoDlSubmitting, setVideoDlSubmitting] = useState(false);
  // 下载产物二选一:false = 仅原视频;true = 全套(原视频 + 无声无字幕视频 + 音轨 +
  // 字幕.srt + 字幕文本.txt),全套额外计费 3000~8000 积分。
  const [dlBundle, setDlBundle] = useState(false);

  // 快手链接校验:kuaishou.com / v.kuaishou.com / chenzhongtech.com,1-20 个。
  const validateLinks = (text: string): { ok: string[]; err: string | null } => {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 1) return { ok: [], err: isZh ? '至少粘贴 1 个链接' : 'Paste at least 1 URL' };
    if (lines.length > 20) return { ok: [], err: isZh ? '最多 20 个链接' : 'Max 20 URLs' };
    for (const l of lines) {
      if (!/^https?:\/\/([\w-]+\.)?(kuaishou|chenzhongtech)\.com\//i.test(l)) {
        return { ok: [], err: (isZh ? '不是快手链接：' : 'Not a Kuaishou link: ') + l.slice(0, 80) };
      }
    }
    return { ok: lines, err: null };
  };

  const handleVideoDownloadClick = () => {
    if (tasks.length >= MAX_TASKS) { setMaxTasksModalOpen(true); return; }
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); return; }
    setLoginModalReason('kuaishou_video_download');
  };

  const handleVideoDownloadSubmit = async () => {
    if (videoDlSubmitting) return;
    const { ok, err } = validateLinks(videoDlLinksText);
    if (err) { alert(err); return; }
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); return; }
    setVideoDlSubmitting(true);
    try {
      const now = new Date();
      const mm = String(now.getMinutes()).padStart(2, '0');
      const hh = String(now.getHours()).padStart(2, '0');
      const task = await scenarioService.createTask({
        scenario_id: videoDownload.id,
        track: 'video_download',
        keywords: [],
        urls: ok,
        derive: { bundle: dlBundle },
        persona: '',
        daily_count: ok.length,
        variants_per_post: 1,
        daily_time: `${hh}:${mm}`,
        run_interval: 'once',
        enabled: true,
        active: true,
      } as any);
      setVideoDlModalOpen(false);
      setVideoDlLinksText('');
      if (onChanged) { await onChanged(); }
      onOpenTask(task.id, 'tasks');
      scenarioService.runTaskNow(task.id).catch((e) => {
        console.error('[KuaishouVideoDownload] runTaskNow failed:', e);
      });
    } catch (e) {
      alert((isZh ? '创建失败：' : 'Create failed: ') + String(e).slice(0, 120));
    } finally {
      setVideoDlSubmitting(false);
    }
  };

  const handleConfigure = useCallback(async (scenario: Scenario | null) => {
    if (!scenario) {
      alert(isZh ? '场景元数据还在加载中，请稍后再试' : 'Scenario metadata still loading');
      return;
    }
    if (tasks.length >= MAX_TASKS) {
      setMaxTasksModalOpen(true);
      return;
    }
    if (!noobClawAuth.getState().isAuthenticated) {
      noobClawAuth.requireLoginUI();
      return;
    }
    // 先弹登录检查 modal,确认浏览器 + 快手标签 + 登录都通过再进 wizard
    setLoginModalReason(scenario.id);
  }, [isZh, tasks.length]);

  const handleLoginConfirmed = () => {
    const reason = loginModalReason;
    setLoginModalReason(null);
    if (reason === 'kuaishou_auto_engage') {
      onConfigure(autoEngage);
    } else if (reason === 'kuaishou_reply_fans_comment') {
      onConfigure(replyFans);
    } else if (reason === 'kuaishou_video_download') {
      setVideoDlModalOpen(true);
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Scenario cards — 互动涨粉 + 视频无水印下载 + 自动回复粉丝。 */}
      <section className="mb-6 grid grid-cols-1 md:grid-cols-2 gap-4">
        <KuaishouEngageCard
          loading={loading}
          scenario={autoEngage}
          onConfigure={() => handleConfigure(autoEngage)}
          onGoToMyTasks={onGoToMyTasks}
          isZh={isZh}
        />
        <KuaishouVideoDownloadCard
          loading={loading}
          scenario={videoDownload}
          onConfigure={handleVideoDownloadClick}
          onGoToMyTasks={onGoToMyTasks}
          isZh={isZh}
        />
        <KuaishouReplyFansCard
          loading={loading}
          scenario={replyFans}
          onConfigure={() => handleConfigure(replyFans)}
          onGoToMyTasks={onGoToMyTasks}
          isZh={isZh}
        />
      </section>

      {/* Feature pills */}
      <section className="mb-6">
        <div className="flex flex-wrap gap-2 justify-center">
          {[
            { icon: '🛡️', zh: '完全模拟人类行为不封号', en: 'Fully human-like behavior — no ban risk' },
            { icon: '🚀', zh: '涨粉丝快(真实互动飞速涨粉)', en: 'Fast follower growth (real engagement scales)' },
            { icon: '💰', zh: '成本超低', en: 'Ultra-low cost' },
            { icon: '🤖', zh: '全智能控制', en: 'Fully AI-driven' },
          ].map((p, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full border border-orange-500/20 bg-orange-500/5 text-gray-700 dark:text-gray-300"
            >
              {p.icon} {isZh ? p.zh : p.en}
            </span>
          ))}
        </div>
      </section>

      {/* 视频无水印下载 modal —— 粘 1-20 个快手视频链接。背景点击不关闭。 */}
      {videoDlModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-2xl rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-2xl p-6">
            <h3 className="text-lg font-bold dark:text-white mb-2">
              ⬇️ {isZh ? '快手 · 视频无水印下载' : 'Kuaishou Watermark-free Video Download'}
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
              {isZh
                ? '每行一个快手视频链接（最多 20 个，支持 v.kuaishou.com 短链）。点击开始后在本地浏览器逐个打开解析并下载，图文/合集等非视频自动跳过。'
                : 'One Kuaishou video link per line (max 20, v.kuaishou.com short links OK). Each opens locally, resolves and downloads; image posts are skipped.'}
            </p>
            <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
              {isZh ? '快手视频链接' : 'Kuaishou video links'}
            </label>
            <textarea
              value={videoDlLinksText}
              onChange={e => setVideoDlLinksText(e.target.value)}
              placeholder={'https://www.kuaishou.com/short-video/...\nhttps://v.kuaishou.com/...'}
              rows={8}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-mono dark:text-white focus:outline-none focus:ring-2 focus:ring-orange-500/50 resize-y min-h-[200px] break-all"
              disabled={videoDlSubmitting}
            />

            {/* 下载产物二选一:仅原视频 / 全套(原视频 + 无声无字幕视频 + 音轨 + 字幕 + 字幕文本)。
                全套里无声/音轨是本地 ffmpeg(免费),字幕走 ASR 语音转写(联网) → 整套额外计费。 */}
            <div className="mt-4 rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-2">
              <div className="text-sm font-medium dark:text-gray-200">
                {isZh ? '下载产物' : 'Download outputs'}
              </div>
              <label className={`flex items-start gap-2 cursor-pointer rounded-lg border p-2.5 ${!dlBundle ? 'border-orange-500 bg-orange-500/5' : 'border-gray-200 dark:border-gray-700'}`}>
                <input type="radio" name="dlBundle" checked={!dlBundle} onChange={() => setDlBundle(false)} disabled={videoDlSubmitting} className="mt-0.5 accent-orange-500" />
                <span className="text-sm dark:text-gray-200">
                  {isZh ? '仅原视频' : 'Original video only'}
                  <span className="block text-xs text-gray-500 dark:text-gray-400">{isZh ? '下载无水印原片，按常规下载计费' : 'watermark-free original, standard download fee'}</span>
                </span>
              </label>
              <label className={`flex items-start gap-2 cursor-pointer rounded-lg border p-2.5 ${dlBundle ? 'border-orange-500 bg-orange-500/5' : 'border-gray-200 dark:border-gray-700'}`}>
                <input type="radio" name="dlBundle" checked={dlBundle} onChange={() => setDlBundle(true)} disabled={videoDlSubmitting} className="mt-0.5 accent-orange-500" />
                <span className="text-sm dark:text-gray-200">
                  {isZh ? '原视频 + 无声视频 + 音轨' : 'Original + muted video + audio'}
                  <span className="block text-xs text-gray-500 dark:text-gray-400">
                    {isZh ? '🔇 无声无字幕视频 + 🎵 音轨(.m4a)，适合二创重配音' : 'muted video + audio (.m4a), for re-creation'}
                  </span>
                  <span className="block text-xs text-gray-400 mt-0.5">{isZh ? '· 本地生成 · 免费（字幕功能稍后单独上线）' : '· generated locally · free (subtitles coming later)'}</span>
                </span>
              </label>
            </div>

            <div className="flex gap-2 mt-4">
              <button
                type="button"
                onClick={() => !videoDlSubmitting && setVideoDlModalOpen(false)}
                disabled={videoDlSubmitting}
                className="flex-1 py-2.5 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
              >
                {isZh ? '取消' : 'Cancel'}
              </button>
              <button
                type="button"
                onClick={handleVideoDownloadSubmit}
                disabled={videoDlSubmitting}
                className="flex-1 py-2.5 rounded-lg text-sm font-semibold bg-orange-500 text-white hover:bg-orange-600 disabled:opacity-50"
              >
                {videoDlSubmitting
                  ? (isZh ? '创建中...' : 'Creating...')
                  : '⬇️ ' + (isZh ? '开始下载' : 'Start Download')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Login modal — 互动涨粉只需主站;自动回复粉丝走创作者服务平台。 */}
      {loginModalReason && (
        <LoginRequiredModal
          mode="create"
          platform="kuaishou"
          requireCreatorCenter={loginModalReason === 'kuaishou_reply_fans_comment'}
          creatorOnly={loginModalReason === 'kuaishou_reply_fans_comment'}
          onCancel={() => setLoginModalReason(null)}
          onConfirmed={handleLoginConfirmed}
        />
      )}

      {/* Task limit modal */}
      {maxTasksModalOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}>
            <div className="px-6 pt-6 pb-2 text-center">
              <div className="text-4xl mb-3">📋</div>
              <h3 className="text-lg font-bold dark:text-white mb-1.5">
                {isZh ? '已达任务上限' : 'Task Limit Reached'}
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
                {isZh
                  ? `快手已经有 ${tasks.length} 个任务了，最多支持 ${MAX_TASKS} 个`
                  : `You already have ${tasks.length} Kuaishou tasks (max ${MAX_TASKS}).`}
                <br />
                {isZh
                  ? '可以先去看看现有任务，停用一些不需要的，再创建新的。'
                  : 'Open My Tasks to disable any you no longer need before creating a new one.'}
              </p>
            </div>
            <div className="px-6 py-4 flex gap-2">
              <button
                type="button"
                onClick={() => setMaxTasksModalOpen(false)}
                className="flex-1 text-sm font-medium px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
                {isZh ? '知道了' : 'Got it'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMaxTasksModalOpen(false);
                  if (onGoToMyTasks) onGoToMyTasks();
                }}
                className="flex-1 text-sm font-medium px-4 py-2 rounded-lg bg-gradient-to-r from-orange-500 to-amber-500 text-white hover:opacity-90 transition-opacity shadow-sm">
                {isZh ? '去看看现有任务 →' : 'View My Tasks →'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ── Scenario card sub-components ─────────────────────────────────────

type CardProps = {
  loading: boolean;
  scenario: Scenario | null;
  onConfigure: () => void;
  onGoToMyTasks?: () => void;
  isZh: boolean;
};

const KuaishouEngageCard: React.FC<CardProps> = ({ loading, scenario: _scenario, onConfigure, onGoToMyTasks, isZh }) => {
  return (
    <div className="relative rounded-2xl border border-orange-500/30 bg-gradient-to-br from-orange-500/10 via-amber-500/5 to-transparent p-5 overflow-hidden flex flex-col">
      <div className="absolute -top-16 -right-16 w-40 h-40 rounded-full bg-orange-500/10 blur-3xl pointer-events-none" />
      <div className="relative flex flex-col flex-1">
        <div className="inline-flex items-center gap-1.5 text-xs font-medium text-orange-500 mb-2">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse" />
          {isZh ? '互动涨粉' : 'Engage & Grow'}
        </div>
        <h3 className="text-base font-bold dark:text-white mb-1.5">
          ⚡ {isZh ? '快手 · 互动涨粉' : 'Kuaishou Engage & Grow'}
        </h3>
        <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed mb-3 flex-1">
          {isZh
            ? '每次运行按你配置的"随机区间"决定本轮点赞 / 关注 / 评论各做几次,然后按你的赛道关键词搜索快手视频自动按配额完成。评论由 AI 按视频文案 + 置顶评论自动生成,行为间隔随机模拟真人。'
            : 'Each run rolls per-action counts from your random ranges, then searches Kuaishou with your track keywords and works through the quota. Comments are AI-generated from video caption + top comments.'}
        </p>
        <CardActionRow
          loading={loading}
          onConfigure={onConfigure}
          onGoToMyTasks={onGoToMyTasks}
          isZh={isZh}
          label={isZh ? '⚡ 开始互动 →' : '⚡ Start →'}
          btnClass="bg-orange-500 hover:bg-orange-600 shadow-lg shadow-orange-500/25"
        />
      </div>
    </div>
  );
};

const KuaishouReplyFansCard: React.FC<CardProps> = ({ loading, scenario: _scenario, onConfigure, onGoToMyTasks, isZh }) => {
  return (
    <div className="relative rounded-2xl border border-cyan-500/30 bg-gradient-to-br from-cyan-500/10 via-sky-500/5 to-transparent p-5 overflow-hidden flex flex-col">
      <div className="absolute -top-16 -right-16 w-40 h-40 rounded-full bg-cyan-500/10 blur-3xl pointer-events-none" />
      <div className="relative flex flex-col flex-1">
        <div className="inline-flex items-center gap-1.5 text-xs font-medium text-cyan-500 mb-2">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-cyan-500 animate-pulse" />
          {isZh ? '粉丝维护' : 'Fan Engagement'}
        </div>
        <h3 className="text-base font-bold dark:text-white mb-1.5">
          💬 {isZh ? '快手 · 自动回复粉丝' : 'Kuaishou Reply Fans'}
        </h3>
        <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed mb-3 flex-1">
          {isZh
            ? '在快手创作者服务平台「评论管理」逐条回复粉丝评论,AI 按评论内容写回应,可选按概率加引流尾巴。已回复过的、自己留的自动跳过,只回粉丝、绝不评论作品本身,真人节奏间隔。'
            : 'Replies to fan comments in Kuaishou Creator Platform comment management. AI-tailored replies with optional funnel tail. Skips already-replied / your own; only replies to fans, never the video itself.'}
        </p>
        <CardActionRow
          loading={loading}
          onConfigure={onConfigure}
          onGoToMyTasks={onGoToMyTasks}
          isZh={isZh}
          label={isZh ? '💬 开始回复 →' : '💬 Start →'}
          btnClass="bg-cyan-500 hover:bg-cyan-600 shadow-lg shadow-cyan-500/25"
        />
      </div>
    </div>
  );
};

const KuaishouVideoDownloadCard: React.FC<CardProps> = ({ loading, scenario: _scenario, onConfigure, onGoToMyTasks, isZh }) => {
  return (
    <div className="relative rounded-2xl border border-blue-500/30 bg-gradient-to-br from-blue-500/10 via-sky-500/5 to-transparent p-5 overflow-hidden flex flex-col">
      <div className="absolute -top-16 -right-16 w-40 h-40 rounded-full bg-blue-500/10 blur-3xl pointer-events-none" />
      <div className="relative flex flex-col flex-1">
        <div className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-500 mb-2">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
          {isZh ? '无水印下载' : 'Watermark-free'}
        </div>
        <h3 className="text-base font-bold dark:text-white mb-1.5">
          ⬇️ {isZh ? '快手 · 视频无水印下载' : 'Kuaishou Watermark-free Download'}
        </h3>
        <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed mb-3 flex-1">
          {isZh
            ? '粘贴 1-20 个快手视频链接（支持 v.kuaishou.com 短链），本地浏览器逐个打开，借快手页面自身签名解析出无水印原视频依次下载到本地。一次性任务，只需登录快手主站；图文/合集等非视频、非快手链接自动跳过。'
            : 'Paste 1-20 Kuaishou video links (v.kuaishou.com short links OK); opens each locally and downloads the watermark-free source video. One-time task — only needs main-site login. Image posts and non-Kuaishou links are skipped.'}
        </p>
        <CardActionRow
          loading={loading}
          onConfigure={onConfigure}
          onGoToMyTasks={onGoToMyTasks}
          isZh={isZh}
          label={isZh ? '⬇️ 开始下载 →' : '⬇️ Start Download →'}
          btnClass="bg-blue-500 hover:bg-blue-600 shadow-lg shadow-blue-500/25"
        />
      </div>
    </div>
  );
};
