/**
 * BilibiliWorkflowsPage — 哔哩哔哩平台工作流页面.
 *
 * 已挂 scenarios（3 个独立任务体系，互不影响）:
 *   bilibili_auto_engage         — 自动浏览推荐流，按用户配置做点赞 / 关注 / 评论
 *   bilibili_video_download      — 粘 1-20 个 B 站视频链接逐个原画下载到本地
 *   bilibili_reply_fans_comment  — 在 B 站创作中心「评论管理」逐条回复粉丝
 *
 * 结构跟 DouyinWorkflowsPage 对齐，主色 pink/blue（B 站品牌色）。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { scenarioService, type Scenario, type Task, type Draft } from '../../services/scenario';
import { LoginRequiredModal } from './LoginRequiredModal';
import { CardActionRow } from './CardActionRow';
import { noobClawAuth } from '../../services/noobclawAuth';

interface Props {
  scenarios: Scenario[];           // already filtered to platform='bilibili' by parent
  tasks: Task[];
  draftsByTask: Map<string, Draft[]>;
  loading: boolean;
  onOpenTask: (task_id: string, fromOverride?: 'create' | 'tasks' | 'history') => void;
  onConfigure: (scenario: Scenario) => void;
  onChanged?: () => void | Promise<void>;
  /** Jump to "My Tasks" filtered to Bilibili — used by 已达上限 modal CTA. */
  onGoToMyTasks?: () => void;
}

export const BilibiliWorkflowsPage: React.FC<Props> = ({
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
    id: 'bilibili_auto_engage',
    version: '1.0.0',
    platform: 'bilibili' as any,
    workflow_type: 'bilibili_auto_engage' as any,
    category: 'engagement',
    name_zh: '哔哩哔哩 · 互动涨粉',
    name_en: 'Bilibili Engage & Grow',
    description_zh: '每天定时刷 B 站推荐流，挑出若干视频按你配置的组合做点赞 / 关注 / 评论。三项动作可独立开关，评论由 AI 按视频标题与置顶评论自动生成，行为间隔随机模拟真人。',
    description_en: 'Browses Bilibili recommend feed on schedule, picks videos and runs your configured mix of like / follow / comment. Each action toggles independently; comments are AI-generated from title + top comments.',
    icon: '📺',
    default_config: {
      keywords: [],
      persona: '对视频内容感兴趣的普通 B 站用户，评论自然口语，不爹味、不拍马屁',
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
    required_login_url: 'https://www.bilibili.com',
    entry_urls: {},
    skills: {},
  } as any;

  const autoEngage = findById('bilibili_auto_engage') || FALLBACK_AUTO_ENGAGE;

  // ── 视频原画下载 fallback —— 一次性工具任务,粘 1-20 个 B 站视频链接逐个下到本地。
  const FALLBACK_VIDEO_DL: Scenario = {
    id: 'bilibili_video_download',
    version: '1.0.0',
    platform: 'bilibili' as any,
    workflow_type: 'bilibili_video_download' as any,
    category: 'tool',
    name_zh: '哔哩哔哩 · 视频无水印下载',
    name_en: 'Bilibili · Watermark-free Video Download',
    description_zh: '粘贴 1-20 个 B 站视频链接，依次在本地浏览器打开，借 B 站页面自身签名解析出原视频并下载到本地。一次性任务，只需登录 B 站主站。',
    description_en: 'Paste 1-20 Bilibili video links; opens each locally, resolves the source video and downloads it. One-time task, only needs main-site login.',
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
    required_login_url: 'https://www.bilibili.com',
    entry_urls: {},
    skills: {},
  } as any;

  const videoDownload = findById('bilibili_video_download') || FALLBACK_VIDEO_DL;

  const FALLBACK_REPLY_FANS: Scenario = {
    id: 'bilibili_reply_fans_comment',
    version: '1.0.0',
    platform: 'bilibili' as any,
    workflow_type: 'bilibili_reply_fans_comment' as any,
    category: 'engagement',
    name_zh: '哔哩哔哩 · 自动回复粉丝',
    name_en: 'Bilibili Reply Fan Comments',
    description_zh: '在 B 站创作中心「评论管理」逐条回复粉丝评论。AI 按评论内容写回应，可选引流尾巴。已回复过的、自己留的评论自动跳过，只回粉丝、绝不评论作品本身。',
    description_en: 'Auto-reply to fan comments in Bilibili Creator Center comment management. AI-tailored, optional funnel tail. Skips already-replied / your own.',
    icon: '💬',
    default_config: {
      funnel_phrase: '',
      funnel_probability: 50,
      schedule_window: '10:00-22:00',
    } as any,
    risk_caps: {} as any,
    required_login_url: 'https://member.bilibili.com/',
    entry_urls: {},
    skills: {},
  } as any;

  const replyFans = findById('bilibili_reply_fans_comment') || FALLBACK_REPLY_FANS;

  // 视频原画下载 modal state
  const [videoDlModalOpen, setVideoDlModalOpen] = useState(false);
  const [videoDlLinksText, setVideoDlLinksText] = useState('');
  const [videoDlSubmitting, setVideoDlSubmitting] = useState(false);

  // B 站链接校验:bilibili.com / b23.tv,1-20 个。
  const validateLinks = (text: string): { ok: string[]; err: string | null } => {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 1) return { ok: [], err: isZh ? '至少粘贴 1 个链接' : 'Paste at least 1 URL' };
    if (lines.length > 20) return { ok: [], err: isZh ? '最多 20 个链接' : 'Max 20 URLs' };
    for (const l of lines) {
      if (!/^https?:\/\/([\w-]+\.)?(bilibili\.com|b23\.tv)\//i.test(l)) {
        return { ok: [], err: (isZh ? '不是 B 站链接：' : 'Not a Bilibili link: ') + l.slice(0, 80) };
      }
    }
    return { ok: lines, err: null };
  };

  const handleVideoDownloadClick = () => {
    if (tasks.length >= MAX_TASKS) { setMaxTasksModalOpen(true); return; }
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); return; }
    setLoginModalReason('bilibili_video_download');
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
        console.error('[BilibiliVideoDownload] runTaskNow failed:', e);
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
    // 先弹登录检查 modal,确认浏览器 + B 站标签 + 登录都通过再进 wizard
    setLoginModalReason(scenario.id);
  }, [isZh, tasks.length]);

  const handleLoginConfirmed = () => {
    const reason = loginModalReason;
    setLoginModalReason(null);
    if (reason === 'bilibili_auto_engage') {
      onConfigure(autoEngage);
    } else if (reason === 'bilibili_reply_fans_comment') {
      onConfigure(replyFans);
    } else if (reason === 'bilibili_video_download') {
      setVideoDlModalOpen(true);
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Scenario cards — 互动涨粉 + 视频原画下载 + 自动回复粉丝。 */}
      <section className="mb-6 grid grid-cols-1 md:grid-cols-2 gap-4">
        <BilibiliEngageCard
          loading={loading}
          scenario={autoEngage}
          onConfigure={() => handleConfigure(autoEngage)}
          onGoToMyTasks={onGoToMyTasks}
          isZh={isZh}
        />
        <BilibiliVideoDownloadCard
          loading={loading}
          scenario={videoDownload}
          onConfigure={handleVideoDownloadClick}
          onGoToMyTasks={onGoToMyTasks}
          isZh={isZh}
        />
        <BilibiliReplyFansCard
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
              className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full border border-pink-500/20 bg-pink-500/5 text-gray-700 dark:text-gray-300"
            >
              {p.icon} {isZh ? p.zh : p.en}
            </span>
          ))}
        </div>
      </section>

      {/* 视频原画下载 modal —— 粘 1-20 个 B 站视频链接。背景点击不关闭。 */}
      {videoDlModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-2xl rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-2xl p-6">
            <h3 className="text-lg font-bold dark:text-white mb-2">
              ⬇️ {isZh ? '哔哩哔哩 · 视频无水印下载' : 'Bilibili Watermark-free Video Download'}
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
              {isZh
                ? '每行一个 B 站视频链接（最多 20 个，支持 b23.tv 短链）。点击开始后在本地浏览器逐个打开解析并下载，番剧/合集等非普通视频自动跳过。'
                : 'One Bilibili video link per line (max 20, b23.tv short links OK). Each opens locally, resolves and downloads; non-standard videos are skipped.'}
            </p>
            <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
              {isZh ? 'B 站视频链接' : 'Bilibili video links'}
            </label>
            <textarea
              value={videoDlLinksText}
              onChange={e => setVideoDlLinksText(e.target.value)}
              placeholder={'https://www.bilibili.com/video/BV...\nhttps://b23.tv/...'}
              rows={8}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-mono dark:text-white focus:outline-none focus:ring-2 focus:ring-pink-500/50 resize-y min-h-[200px] break-all"
              disabled={videoDlSubmitting}
            />
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
                className="flex-1 py-2.5 rounded-lg text-sm font-semibold bg-pink-500 text-white hover:bg-pink-600 disabled:opacity-50"
              >
                {videoDlSubmitting
                  ? (isZh ? '创建中...' : 'Creating...')
                  : '⬇️ ' + (isZh ? '开始下载' : 'Start Download')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Login modal — 互动涨粉只需主站;自动回复粉丝走创作中心。 */}
      {loginModalReason && (
        <LoginRequiredModal
          mode="create"
          platform="bilibili"
          requireCreatorCenter={loginModalReason === 'bilibili_reply_fans_comment'}
          creatorOnly={loginModalReason === 'bilibili_reply_fans_comment'}
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
                  ? `哔哩哔哩已经有 ${tasks.length} 个任务了，最多支持 ${MAX_TASKS} 个`
                  : `You already have ${tasks.length} Bilibili tasks (max ${MAX_TASKS}).`}
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
                className="flex-1 text-sm font-medium px-4 py-2 rounded-lg bg-gradient-to-r from-pink-500 to-blue-500 text-white hover:opacity-90 transition-opacity shadow-sm">
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

const BilibiliEngageCard: React.FC<CardProps> = ({ loading, scenario: _scenario, onConfigure, onGoToMyTasks, isZh }) => {
  return (
    <div className="relative rounded-2xl border border-pink-500/30 bg-gradient-to-br from-pink-500/10 via-blue-500/5 to-transparent p-5 overflow-hidden flex flex-col">
      <div className="absolute -top-16 -right-16 w-40 h-40 rounded-full bg-pink-500/10 blur-3xl pointer-events-none" />
      <div className="relative flex flex-col flex-1">
        <div className="inline-flex items-center gap-1.5 text-xs font-medium text-pink-500 mb-2">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-pink-500 animate-pulse" />
          {isZh ? '互动涨粉' : 'Engage & Grow'}
        </div>
        <h3 className="text-base font-bold dark:text-white mb-1.5">
          📺 {isZh ? '哔哩哔哩 · 互动涨粉' : 'Bilibili Engage & Grow'}
        </h3>
        <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed mb-3 flex-1">
          {isZh
            ? '每次运行按你配置的"随机区间"决定本轮点赞 / 关注 / 评论各做几次,然后按你的赛道关键词搜索 B 站视频自动按配额完成。评论由 AI 按视频标题 + 置顶评论自动生成,行为间隔随机模拟真人。'
            : 'Each run rolls per-action counts from your random ranges, then searches Bilibili with your track keywords and works through the quota. Comments are AI-generated from video title + top comments.'}
        </p>
        <CardActionRow
          loading={loading}
          onConfigure={onConfigure}
          onGoToMyTasks={onGoToMyTasks}
          isZh={isZh}
          label={isZh ? '📺 开始互动 →' : '📺 Start →'}
          btnClass="bg-pink-500 hover:bg-pink-600 shadow-lg shadow-pink-500/25"
        />
      </div>
    </div>
  );
};

const BilibiliReplyFansCard: React.FC<CardProps> = ({ loading, scenario: _scenario, onConfigure, onGoToMyTasks, isZh }) => {
  return (
    <div className="relative rounded-2xl border border-cyan-500/30 bg-gradient-to-br from-cyan-500/10 via-sky-500/5 to-transparent p-5 overflow-hidden flex flex-col">
      <div className="absolute -top-16 -right-16 w-40 h-40 rounded-full bg-cyan-500/10 blur-3xl pointer-events-none" />
      <div className="relative flex flex-col flex-1">
        <div className="inline-flex items-center gap-1.5 text-xs font-medium text-cyan-500 mb-2">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-cyan-500 animate-pulse" />
          {isZh ? '粉丝维护' : 'Fan Engagement'}
        </div>
        <h3 className="text-base font-bold dark:text-white mb-1.5">
          💬 {isZh ? '哔哩哔哩 · 自动回复粉丝' : 'Bilibili Reply Fans'}
        </h3>
        <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed mb-3 flex-1">
          {isZh
            ? '在 B 站创作中心「评论管理」逐条回复粉丝评论,AI 按评论内容写回应,可选按概率加引流尾巴。已回复过的、自己留的自动跳过,只回粉丝、绝不评论作品本身,真人节奏间隔。'
            : 'Replies to fan comments in Bilibili Creator Center comment management. AI-tailored replies with optional funnel tail. Skips already-replied / your own; only replies to fans, never the video itself.'}
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

const BilibiliVideoDownloadCard: React.FC<CardProps> = ({ loading, scenario: _scenario, onConfigure, onGoToMyTasks, isZh }) => {
  return (
    <div className="relative rounded-2xl border border-blue-500/30 bg-gradient-to-br from-blue-500/10 via-sky-500/5 to-transparent p-5 overflow-hidden flex flex-col">
      <div className="absolute -top-16 -right-16 w-40 h-40 rounded-full bg-blue-500/10 blur-3xl pointer-events-none" />
      <div className="relative flex flex-col flex-1">
        <div className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-500 mb-2">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
          {isZh ? '视频下载' : 'Video Download'}
        </div>
        <h3 className="text-base font-bold dark:text-white mb-1.5">
          ⬇️ {isZh ? '哔哩哔哩 · 视频下载' : 'Bilibili Video Download'}
        </h3>
        <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed mb-3 flex-1">
          {isZh
            ? '粘贴 1-20 个 B 站视频链接（支持 b23.tv 短链），本地浏览器逐个打开，借 B 站页面自身签名解析出原视频依次下载到本地。一次性任务，只需登录 B 站主站；番剧/合集等非普通视频、非 B 站链接自动跳过。'
            : 'Paste 1-20 Bilibili video links (b23.tv short links OK); opens each locally and downloads the source video. One-time task — only needs main-site login. Non-standard videos and non-Bilibili links are skipped.'}
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
