/**
 * XhsWorkflowsPage — layer 1 inside 小红书 tab.
 *
 * Sections (top-down):
 *   1. Quick-start banner for 爆款仿写 (one-click with login gate)
 *   2. NoobClaw 5 advantages hero (moved from the old WorkflowDetailPage)
 *   3. "My tasks" list (collapsed card per task)
 *   4. Workflow-type grid (爆款仿写 active, 4 coming soon)
 *
 * The top banner is the "一键按钮" users were looking for. It:
 *   - Checks XHS login via scenarioService.checkXhsLogin
 *   - Shows LoginRequiredModal if not logged in
 *   - If no task yet, opens the config wizard for the first available
 *     xhs_viral_production scenario
 *   - If a task already exists, jumps straight to its task detail page
 */

import React, { useState } from 'react';
import { i18nService } from '../../services/i18n';
import { scenarioService, type Scenario, type Task, type Draft } from '../../services/scenario';
import { LoginRequiredModal } from './LoginRequiredModal';
import { CardActionRow } from './CardActionRow';
import { noobClawAuth } from '../../services/noobclawAuth';

// Lightweight track lookup for task card display (full presets live in ConfigWizard)
// @ts-ignore — kept inline so future card layouts can reference it without re-importing
const _TRACK_PRESETS: Array<{ id: string; icon: string; name_zh: string }> = [ // eslint-disable-line
  { id: 'career_side_hustle', icon: '💼', name_zh: '副业 · 打工人赚钱' },
  { id: 'indie_dev', icon: '👩‍💻', name_zh: '独立开发 · 程序员记录' },
  { id: 'personal_finance', icon: '💰', name_zh: '理财 · 记账攻略' },
  { id: 'travel', icon: '✈️', name_zh: '旅行 · 攻略分享' },
  { id: 'food', icon: '🍲', name_zh: '美食 · 探店做饭' },
  { id: 'outfit', icon: '👗', name_zh: '穿搭 · 风格分享' },
  { id: 'beauty', icon: '💄', name_zh: '美妆 · 产品测评' },
  { id: 'fitness', icon: '💪', name_zh: '健身 · 减脂日记' },
  { id: 'reading', icon: '📚', name_zh: '读书 · 书单笔记' },
  { id: 'parenting', icon: '🧸', name_zh: '育儿 · 亲子日常' },
  { id: 'exam_prep', icon: '🎓', name_zh: '考研 · 备考党' },
  { id: 'pets', icon: '🐱', name_zh: '宠物 · 猫狗日常' },
  { id: 'home_decor', icon: '🏠', name_zh: '家居 · 小屋布置' },
  { id: 'study_method', icon: '🏆', name_zh: '学习 · 效率工具' },
  { id: 'career_growth', icon: '🎯', name_zh: '职场 · 升级打怪' },
  { id: 'emotional_wellness', icon: '🧘', name_zh: '情感 · 心理疗愈' },
  { id: 'photography', icon: '📷', name_zh: '摄影 · 日常记录' },
  { id: 'crafts', icon: '🎨', name_zh: '手工 · DIY' },
];

type WorkflowDef = {
  id: string;
  icon: string;
  titleKey: string;
  descKey: string;
  available: boolean;
};

// @ts-ignore — Future workflow types, kept for when auto_reply / mass_comment ship.
const _WORKFLOWS: WorkflowDef[] = [ // eslint-disable-line
  { id: 'viral_production', icon: '🔥', titleKey: 'scenarioWorkflowViral', descKey: 'scenarioWorkflowViralDesc', available: true },
  { id: 'auto_reply', icon: '💬', titleKey: 'scenarioWorkflowAutoReply', descKey: 'scenarioWorkflowAutoReplyDesc', available: false },
  { id: 'mass_comment', icon: '🎯', titleKey: 'scenarioWorkflowMassComment', descKey: 'scenarioWorkflowMassCommentDesc', available: false },
  { id: 'dm_reply', icon: '📬', titleKey: 'scenarioWorkflowDmReply', descKey: 'scenarioWorkflowDmRelyDesc', available: false },
  { id: 'data_monitor', icon: '📈', titleKey: 'scenarioWorkflowDataMonitor', descKey: 'scenarioWorkflowDataMonitorDesc', available: false },
];

// Advantage pills are now inline in the banner — no separate const needed.

interface Props {
  scenarios: Scenario[];
  tasks: Task[];
  draftsByTask: Map<string, Draft[]>;
  loading: boolean;
  // onOpenWorkflow removed — no intermediate workflow detail page
  onOpenTask: (task_id: string, fromOverride?: 'create' | 'tasks' | 'history') => void;
  onConfigure: (scenario: Scenario) => void;
  /** Called after a new task is created (e.g. link-mode submit)
   *  so parent can refresh its tasks[] list before routing to detail. */
  onChanged?: () => void | Promise<void>;
  /** Open the standalone sensitive-word check page (no scenario, no task). */
  onOpenSensitiveCheck?: () => void;
  /** Jump to the "我的任务" page filtered to this same platform.
   *  Wired by ScenarioView via setView({section:'tasks', platform:'xhs'}).
   *  Used by the "已达任务上限" modal's CTA so users can audit existing
   *  tasks instead of bumping into a dead-end alert. */
  onGoToMyTasks?: () => void;
}

export const XhsWorkflowsPage: React.FC<Props> = ({
  scenarios,
  tasks,
  draftsByTask: _draftsByTask,
  loading: _loading,
  // onOpenWorkflow — unused until auto_reply / mass_comment ship
  onOpenTask,
  onConfigure,
  onChanged,
  onOpenSensitiveCheck,
  onGoToMyTasks,
}) => {
  // @ts-ignore — Pre-create-only refactor used scenarioById to look up
  // each task's scenario when rendering the task list. Tasks moved out
  // (now in MyTasksPage), but the wizard helpers might still need this.
  const _scenarioById = new Map(scenarios.map(s => [s.id, s])); // eslint-disable-line
  const [loginModalReason, setLoginModalReason] = useState<string | null>(null);
  // (Task list moved to its own top-level "我的任务" page in v2.4.20+.
  //  This page is now creation-only — no task polling needed here.)

  // Find the default viral-production scenario. If the backend scenario list
  // hasn't loaded yet, use a hardcoded fallback so the "立即开始" button
  // ALWAYS opens the config wizard — never navigates to an empty sub-page.
  const FALLBACK_SCENARIO: Scenario = {
    id: 'xhs_viral_production_career',
    version: '1.0.0',
    platform: 'xhs',
    workflow_type: 'viral_production',
    category: 'knowledge',
    name_zh: '副业干货',
    name_en: 'Side Hustle Notes',
    description_zh: '自动发现小红书图文爆款，AI 改写标题和内容，保存到本地并上传草稿箱。',
    description_en: 'Discover viral side-hustle image notes on Xiaohongshu.',
    icon: '💼',
    default_config: {
      keywords: ['副业', '下班赚钱', '兼职', '月入'],
      persona: '一个想在下班后搞点副业的普通打工人，真诚不装',
      daily_count: 3,
      variants_per_post: 3,
      schedule_window: '08:00-09:00',
    },
    risk_caps: {
      max_daily_runs: 1, max_scroll_per_run: 20,
      min_scroll_delay_ms: 1800, max_scroll_delay_ms: 4200,
      read_dwell_min_ms: 2500, read_dwell_max_ms: 5500,
      max_run_duration_ms: 720000, min_interval_hours: 8,
      weekly_rest_days: 1, cooldown_captcha_hours: 24,
      cooldown_rate_limit_hours: 48, cooldown_account_flag_hours: 72,
    },
    required_login_url: 'https://www.xiaohongshu.com',
    entry_urls: {},
    skills: {},
  };

  const primaryScenario = scenarios.find(
    s => s.platform === 'xhs' && s.workflow_type === 'viral_production'
  ) || FALLBACK_SCENARIO;

  const primaryTask = tasks.find(t => t.scenario_id === primaryScenario.id);

  // Auto-reply scenario lookup (Plan B). Fallback id matches the scenario
  // folder name on the backend so the wizard can boot before the scenarios
  // list arrives over network.
  const AUTO_REPLY_FALLBACK: Scenario = {
    ...FALLBACK_SCENARIO,
    id: 'xhs_auto_reply_universal',
    workflow_type: 'auto_reply' as any,
    name_zh: '小红书 · 互动涨粉',
    name_en: 'XHS Engage & Grow',
    description_zh: '按关键词找文章，AI 生成评论+用户回复，30-80 秒间隔安全发布。每次还会按 0~30% 概率关注作者。',
    description_en: 'Find articles by keyword, AI-reply + reply to comments, post on safe jitter. Optionally follow the author (0-30% chance).',
    icon: '💬',
    default_config: {
      keywords: ['副业', '兼职', '下班赚钱'],
      persona: '一个热心、有共鸣感的同行',
      daily_count: 6,
      schedule_window: '10:00-11:30',
    } as any,
  };
  const autoReplyScenario = scenarios.find(
    s => s.platform === 'xhs' && (s.workflow_type as any) === 'auto_reply'
  ) || AUTO_REPLY_FALLBACK;

  // Image-text creation scenario lookup (跟抖音图文同款 3 段灵感入口,但加了实景图开关)。
  // Fallback id 必须 match backend scenario folder 名,这样 wizard 在 scenarios
  // 列表还没拉到时也能预热打开。
  const IMAGE_TEXT_FALLBACK: Scenario = {
    ...FALLBACK_SCENARIO,
    id: 'xhs_image_text',
    workflow_type: 'xhs_image_text_creation' as any,
    name_zh: '小红书 · 图文创作',
    name_en: 'XHS Image-Text Creation',
    description_zh: '填 3 段灵感, AI 改写成小红书笔记。配图二选一: AI 生图 或 关键词去小红书抓网络图(2-6 张可调)。整完上传到草稿箱。',
    description_en: 'Fill 3 source snippets; AI rewrites into a Xiaohongshu note. Image source: AI-generated OR scraped real photos by keyword.',
    icon: '📝',
    default_config: {
      keywords: [],
      persona: '',
      daily_count: 1,
      variants_per_post: 1,
      schedule_window: '09:00-22:00',
      use_real_photos: false,
      real_photo_count: 6,
      real_photo_keywords: '',
    } as any,
  };
  const imageTextScenario = scenarios.find(s => s.id === 'xhs_image_text') || IMAGE_TEXT_FALLBACK;

  // Reply-fans-comment scenario lookup (v6+). Fallback id must match backend
  // scenario folder so the wizard can boot before /scenarios returns.
  const REPLY_FANS_FALLBACK: Scenario = {
    ...FALLBACK_SCENARIO,
    id: 'xhs_reply_fans_comment',
    workflow_type: 'xhs_reply_fans_comment' as any,
    name_zh: '小红书 · 自动回复粉丝',
    name_en: 'XHS Reply Fan Comments',
    description_zh: '自动给你已发布笔记下的粉丝评论一一回复。AI 按评论内容写回应,可选在结尾按概率自然衔接你的引流文案。已回复过的、自己留的评论自动跳过。',
    description_en: 'Auto-reply to fan comments under your published Xiaohongshu notes. AI tailors each reply, with optional probability-based funnel weaving. Skips comments you\'ve already replied to or your own.',
    icon: '💌',
    default_config: {
      funnel_phrase: '',
      funnel_probability: 50,
      daily_count_min: 5,
      daily_count_max: 15,
      max_replies_per_note: 5,
      schedule_window: '10:00-22:00',
    } as any,
  };
  const replyFansScenario = scenarios.find(s => s.id === 'xhs_reply_fans_comment') || REPLY_FANS_FALLBACK;

  // 视频原画下载 fallback —— 一次性工具任务,粘贴 1-20 个小红书视频链接逐个
  // 下载到本地。fallback id 必须 match backend scenario folder,scenarios 列表
  // 还没拉到时也能点开。
  const VIDEO_DL_FALLBACK: Scenario = {
    ...FALLBACK_SCENARIO,
    id: 'xhs_video_download',
    workflow_type: 'xhs_video_download' as any,
    name_zh: '小红书 · 视频无水印下载',
    name_en: 'Xiaohongshu · Watermark-free Video Download',
    description_zh: '粘贴 1-20 个小红书视频链接，依次在本地浏览器打开解析出原视频并下载到本地。',
    description_en: 'Paste 1-20 Xiaohongshu video links; opens each locally, resolves the source video and downloads it. One-time task, only needs main-site login.',
    icon: '⬇️',
    required_login_url: 'https://www.xiaohongshu.com',
    default_config: {
      keywords: [],
      persona: '',
      daily_count: 1,
      variants_per_post: 1,
      schedule_window: '00:00-23:59',
    } as any,
  };
  const videoDownloadScenario = scenarios.find(s => s.id === 'xhs_video_download') || VIDEO_DL_FALLBACK;
  // (autoReplyTask lookup removed v2.4.27 — card always opens wizard for
  //  a NEW task instead of resuming an existing one. Kept the scenario
  //  lookup above since the wizard still needs the scenario reference.)

  const MAX_TASKS = 5;
  const isZh = i18nService.currentLanguage === 'zh';

  // Soft-cap modal — replaces the old window.alert() that was technically
  // working but felt like a system error to users (especially on Tauri
  // where the native dialog has a generic "NoobClaw" header). Shown when
  // the user tries to create another task past MAX_TASKS; CTA jumps to
  // "我的任务" so they can review/disable an existing one instead of
  // hitting a dead end.
  const [maxTasksModalOpen, setMaxTasksModalOpen] = useState(false);

  // Link-mode state
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [linksText, setLinksText] = useState('');
  const [linkSubmitting, setLinkSubmitting] = useState(false);
  const [linkAutoUpload, setLinkAutoUpload] = useState(true);

  // 视频原画下载 state(复用 link-mode 的链接校验,但走独立 scenario + 独立 modal)
  const [videoDlModalOpen, setVideoDlModalOpen] = useState(false);
  const [videoDlLinksText, setVideoDlLinksText] = useState('');
  const [videoDlSubmitting, setVideoDlSubmitting] = useState(false);

  const validateLinks = (text: string): { ok: string[]; err: string | null } => {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 1) return { ok: [], err: i18nService.currentLanguage === 'zh' ? '至少粘贴 1 个链接' : 'Paste at least 1 URL' };
    // v6.x: 上限 5 → 20,跟 X / Binance 链接仿写场景对齐(用户反馈 5 太紧)
    if (lines.length > 20) return { ok: [], err: i18nService.currentLanguage === 'zh' ? '最多 20 个链接' : 'Max 20 URLs' };
    for (const l of lines) {
      if (!/^https?:\/\/(www\.)?xiaohongshu\.com\//i.test(l) && !/^https?:\/\/xhslink\.com\//i.test(l)) {
        return { ok: [], err: (i18nService.currentLanguage === 'zh' ? '不是小红书链接：' : 'Not an XHS link: ') + l.slice(0, 80) };
      }
    }
    return { ok: lines, err: null };
  };

  const handleLinkModeSubmit = async () => {
    if (linkSubmitting) return;
    const { ok, err } = validateLinks(linksText);
    if (err) { alert(err); return; }
    if (!noobClawAuth.getState().isAuthenticated) {
      noobClawAuth.requireLoginUI();
      return;
    }
    setLinkSubmitting(true);
    try {
      // 默认到 1 分钟后开始（由 scheduler 或手动 runTaskNow 触发）
      const now = new Date();
      const mm = String(now.getMinutes()).padStart(2, '0');
      const hh = String(now.getHours()).padStart(2, '0');
      const task = await scenarioService.createTask({
        scenario_id: primaryScenario.id,
        track: 'link_mode',
        keywords: [],
        urls: ok,
        persona: '',
        daily_count: ok.length,
        variants_per_post: 1,
        daily_time: `${hh}:${mm}`,
        run_interval: 'once',
        enabled: true,
        active: true,
        auto_upload: linkAutoUpload,
      } as any);
      setLinkModalOpen(false);
      setLinksText('');
      // 先 refresh 父组件 tasks[]，否则跳转后 TaskDetailPage.tasks.find() 找不到新任务显示"无任务"
      if (onChanged) { await onChanged(); }
      // 然后跳转详情 + 异步触发运行。fromOverride='tasks' 让用户点返回时
      // 回到「我的自动化运营任务」列表，而不是回到刚交完的快速创建 modal。
      onOpenTask(task.id, 'tasks');
      scenarioService.runTaskNow(task.id).catch((e) => {
        console.error('[LinkMode] runTaskNow failed:', e);
      });
    } catch (e) {
      alert((i18nService.currentLanguage === 'zh' ? '创建失败：' : 'Create failed: ') + String(e).slice(0, 120));
    } finally {
      setLinkSubmitting(false);
    }
  };

  const handleLinkModeClick = () => {
    if (tasks.length >= MAX_TASKS) {
      setMaxTasksModalOpen(true);
      return;
    }
    if (!noobClawAuth.getState().isAuthenticated) {
      noobClawAuth.requireLoginUI();
      return;
    }
    // Same pre-check as batch mode: open LoginRequiredModal first, only show
    // the link-mode URL form after extension + XHS tab + login all pass.
    setLoginModalReason('linkmode');
  };

  const handleAutoReplyClick = () => {
    if (tasks.length >= MAX_TASKS) {
      setMaxTasksModalOpen(true);
      return;
    }
    if (!noobClawAuth.getState().isAuthenticated) {
      noobClawAuth.requireLoginUI();
      return;
    }
    // v2.4.27: card always opens the wizard for a NEW task — even if the
    // user already has an auto-reply task. Pre-2.4.27 we shortcut to the
    // existing task ("继续任务") which made it impossible to create a
    // second / third auto-reply task with different keywords or a
    // different track from this entry point. Multi-task support already
    // exists everywhere else; this card was the only blocker.
    setLoginModalReason('autoreply');
  };

  const handleImageTextClick = () => {
    if (tasks.length >= MAX_TASKS) {
      setMaxTasksModalOpen(true);
      return;
    }
    if (!noobClawAuth.getState().isAuthenticated) {
      noobClawAuth.requireLoginUI();
      return;
    }
    setLoginModalReason('image_text');
  };

  const handleReplyFansClick = () => {
    if (tasks.length >= MAX_TASKS) {
      setMaxTasksModalOpen(true);
      return;
    }
    if (!noobClawAuth.getState().isAuthenticated) {
      noobClawAuth.requireLoginUI();
      return;
    }
    setLoginModalReason('reply_fans');
  };

  const handleVideoDownloadClick = () => {
    if (tasks.length >= MAX_TASKS) {
      setMaxTasksModalOpen(true);
      return;
    }
    if (!noobClawAuth.getState().isAuthenticated) {
      noobClawAuth.requireLoginUI();
      return;
    }
    // 只校验主站登录(requireCreatorCenter=false,见 LoginRequiredModal 渲染处)
    setLoginModalReason('video_download');
  };

  const handleVideoDownloadSubmit = async () => {
    if (videoDlSubmitting) return;
    const { ok, err } = validateLinks(videoDlLinksText); // 复用 XHS 链接校验(1-20 + 域名)
    if (err) { alert(err); return; }
    if (!noobClawAuth.getState().isAuthenticated) {
      noobClawAuth.requireLoginUI();
      return;
    }
    setVideoDlSubmitting(true);
    try {
      const now = new Date();
      const mm = String(now.getMinutes()).padStart(2, '0');
      const hh = String(now.getHours()).padStart(2, '0');
      const task = await scenarioService.createTask({
        scenario_id: videoDownloadScenario.id,
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
        console.error('[VideoDownload] runTaskNow failed:', e);
      });
    } catch (e) {
      alert((i18nService.currentLanguage === 'zh' ? '创建失败：' : 'Create failed: ') + String(e).slice(0, 120));
    } finally {
      setVideoDlSubmitting(false);
    }
  };

  const handleQuickStart = () => {
    // Gate: max 5 tasks
    if (tasks.length >= MAX_TASKS) {
      setMaxTasksModalOpen(true);
      return;
    }
    // Gate: must be logged in with wallet
    if (!noobClawAuth.getState().isAuthenticated) {
      noobClawAuth.requireLoginUI();
      return;
    }
    // Show check modal first (extension + XHS tab + login)
    setLoginModalReason('quickstart');
  };

  const handleLoginConfirmed = () => {
    const reason = loginModalReason;
    setLoginModalReason(null);
    // After checks pass, open whichever form the user was heading to.
    if (reason === 'linkmode') {
      setLinkModalOpen(true);
    } else if (reason === 'video_download') {
      setVideoDlModalOpen(true);
    } else if (reason === 'autoreply') {
      onConfigure(autoReplyScenario);
    } else if (reason === 'image_text') {
      onConfigure(imageTextScenario);
    } else if (reason === 'reply_fans') {
      onConfigure(replyFansScenario);
    } else {
      onConfigure(primaryScenario);
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Four-card grid — v2.4.59: 用户要求互动涨粉放第一(跟币安/推特页一致)。
          顺序: 互动涨粉 · 批量仿写 · 指定链接 · 敏感词检测 */}
      <section className="mb-6 grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* 1. Auto-reply (moved from 4th to 1st per user feedback 2.4.59) */}
        <div className="relative rounded-2xl border border-cyan-500/30 bg-gradient-to-br from-cyan-500/10 via-sky-500/5 to-transparent p-6 overflow-hidden">
          <div className="absolute -top-16 -right-16 w-40 h-40 rounded-full bg-cyan-500/10 blur-3xl pointer-events-none" />
          <div className="relative flex flex-col h-full">
            <div className="inline-flex items-center gap-1.5 text-xs font-medium text-cyan-500 mb-2">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-cyan-500 animate-pulse" />
              {i18nService.currentLanguage === 'zh' ? '互动涨粉' : 'Engage & Grow'}
            </div>
            <h2 className="text-lg sm:text-xl font-bold dark:text-white mb-1.5">
              💬 {i18nService.currentLanguage === 'zh' ? '小红书 · 互动涨粉' : 'XHS Engage & Grow'}
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed mb-4 flex-1">
              {i18nService.currentLanguage === 'zh'
                ? '按你的赛道关键词智能挖近一周高互动爆文，AI 一次写出「走心评论 + 子楼层回复」组合拳，全程模拟真人节奏随机抖动安全互动。可选顺手关注高潜作者，被动涨粉不留痕。'
                : 'Mines this week\'s viral notes in your niche, AI crafts heartfelt replies plus per-comment responses, paced like a real human to stay under the radar. Optionally auto-follow promising authors — hands-free growth, no fingerprints.'}
            </p>
            <CardActionRow
              onConfigure={handleAutoReplyClick}
              onGoToMyTasks={onGoToMyTasks}
              isZh={i18nService.currentLanguage === 'zh'}
              label={i18nService.currentLanguage === 'zh' ? '💬 开始互动 →' : '💬 Start →'}
              btnClass="bg-cyan-500 hover:bg-cyan-600 shadow-lg shadow-cyan-500/25"
            />
          </div>
        </div>

        {/* 2. Batch rewrite (keyword) */}
        <div className="relative rounded-2xl border border-green-500/30 bg-gradient-to-br from-green-500/10 via-emerald-500/5 to-transparent p-6 overflow-hidden">
          <div className="absolute -top-16 -right-16 w-40 h-40 rounded-full bg-green-500/10 blur-3xl pointer-events-none" />
          <div className="relative flex flex-col h-full">
            <div className="inline-flex items-center gap-1.5 text-xs font-medium text-green-500 mb-2">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              {i18nService.t('scenarioWorkflowAvailable')}
            </div>
            <h2 className="text-lg sm:text-xl font-bold dark:text-white mb-1.5">
              🔥 {i18nService.t('scenarioQuickStartTitle')}
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed mb-4 flex-1">
              {i18nService.t('scenarioQuickStartDesc')}
            </p>
            <CardActionRow
              onConfigure={handleQuickStart}
              onGoToMyTasks={onGoToMyTasks}
              isZh={i18nService.currentLanguage === 'zh'}
              label={primaryTask
                ? '📋 ' + i18nService.t('scenarioQuickStartContinueBtn') + ' →'
                : '🚀 ' + i18nService.t('scenarioQuickStartBtn') + ' →'}
              btnClass="bg-green-500 hover:bg-green-600 shadow-lg shadow-green-500/25"
            />
          </div>
        </div>

        {/* 3. Reply fan comments (v6+) — 回自己笔记下的粉丝评论,可选引流尾巴 */}
        <div className="relative rounded-2xl border border-fuchsia-500/30 bg-gradient-to-br from-fuchsia-500/10 via-pink-500/5 to-transparent p-6 overflow-hidden">
          <div className="absolute -top-16 -right-16 w-40 h-40 rounded-full bg-fuchsia-500/10 blur-3xl pointer-events-none" />
          <div className="relative flex flex-col h-full">
            <div className="inline-flex items-center gap-1.5 text-xs font-medium text-fuchsia-500 mb-2">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-fuchsia-500 animate-pulse" />
              {i18nService.currentLanguage === 'zh' ? '粉丝维护' : 'Fan Engagement'}
            </div>
            <h2 className="text-lg sm:text-xl font-bold dark:text-white mb-1.5">
              💌 {i18nService.currentLanguage === 'zh' ? '小红书 · 自动回复粉丝' : 'XHS Reply Fan Comments'}
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed mb-4 flex-1">
              {i18nService.currentLanguage === 'zh'
                ? '自动打开创作者中心,逐篇笔记进去,AI 一条条回复粉丝评论。可填核心引流语,按你设的概率自然衔接到回复尾巴。已回复过的、自己留的评论自动跳过,真人节奏间隔,稳维护粉丝。'
                : 'Auto-walks your Creator Center, replies to each fan comment via AI. Optional funnel phrase woven into reply tail by your set probability. Skips already-replied / self comments, human-paced.'}
            </p>
            <CardActionRow
              onConfigure={handleReplyFansClick}
              onGoToMyTasks={onGoToMyTasks}
              isZh={i18nService.currentLanguage === 'zh'}
              label={i18nService.currentLanguage === 'zh' ? '💌 开始回复 →' : '💌 Start Replying →'}
              btnClass="bg-fuchsia-500 hover:bg-fuchsia-600 shadow-lg shadow-fuchsia-500/25"
            />
          </div>
        </div>

        {/* 视频原画下载 —— 放在「图文创作」前面。一次性工具:粘 1-20 个小红书
            视频链接,本地浏览器逐个解析原视频并下载到本地。 */}
        <div className="relative rounded-2xl border border-blue-500/30 bg-gradient-to-br from-blue-500/10 via-sky-500/5 to-transparent p-6 overflow-hidden">
          <div className="absolute -top-16 -right-16 w-40 h-40 rounded-full bg-blue-500/10 blur-3xl pointer-events-none" />
          <div className="relative flex flex-col h-full">
            <div className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-500 mb-2">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
              {i18nService.currentLanguage === 'zh' ? '无水印下载' : 'No watermark'}
            </div>
            <h2 className="text-lg sm:text-xl font-bold dark:text-white mb-1.5">
              ⬇️ {i18nService.currentLanguage === 'zh' ? '小红书 · 视频无水印下载' : 'XHS Watermark-free Video Download'}
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed mb-4 flex-1">
              {i18nService.currentLanguage === 'zh'
                ? '粘贴 1-20 个小红书视频链接，本地浏览器逐个打开解析出原视频，依次下载到本地。非视频笔记、非小红书链接自动跳过。'
                : 'Paste 1-20 Xiaohongshu video links; opens each in your local browser, resolves the source video and downloads it. One-time task — only needs main-site login. Non-video notes and non-XHS links are skipped.'}
            </p>
            <CardActionRow
              onConfigure={handleVideoDownloadClick}
              onGoToMyTasks={onGoToMyTasks}
              isZh={i18nService.currentLanguage === 'zh'}
              label={i18nService.currentLanguage === 'zh' ? '⬇️ 开始下载 →' : '⬇️ Start Download →'}
              btnClass="bg-blue-500 hover:bg-blue-600 shadow-lg shadow-blue-500/25"
            />
          </div>
        </div>

        {/* 4. Image-text creation (3 段灵感 → AI 改写 → 配图二选一 → 草稿箱) */}
        <div className="relative rounded-2xl border border-rose-500/30 bg-gradient-to-br from-rose-500/10 via-pink-500/5 to-transparent p-6 overflow-hidden">
          <div className="absolute -top-16 -right-16 w-40 h-40 rounded-full bg-rose-500/10 blur-3xl pointer-events-none" />
          <div className="relative flex flex-col h-full">
            <div className="inline-flex items-center gap-1.5 text-xs font-medium text-rose-500 mb-2">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse" />
              {i18nService.currentLanguage === 'zh' ? '图文创作' : 'Image-Text'}
            </div>
            <h2 className="text-lg sm:text-xl font-bold dark:text-white mb-1.5">
              📝 {i18nService.currentLanguage === 'zh' ? '小红书 · 图文创作' : 'XHS Image-Text Creation'}
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed mb-4 flex-1">
              {i18nService.currentLanguage === 'zh'
                ? '填 3 段灵感来源，AI 改写成小红书笔记。配图二选一：AI 生图 或 关键词去小红书抓网络图（2-6 张可调）。整完上传到草稿箱手动审核发布。'
                : 'Fill 3 source snippets; AI rewrites into a XHS note. Image source: AI-generated OR scrape real photos by keyword (2-6 configurable). Uploads to drafts for manual review.'}
            </p>
            <CardActionRow
              onConfigure={handleImageTextClick}
              onGoToMyTasks={onGoToMyTasks}
              isZh={i18nService.currentLanguage === 'zh'}
              label={i18nService.currentLanguage === 'zh' ? '📝 开始创作 →' : '📝 Start Creating →'}
              btnClass="bg-rose-500 hover:bg-rose-600 shadow-lg shadow-rose-500/25"
            />
          </div>
        </div>

        {/* 4. Link mode */}
        <div className="relative rounded-2xl border border-purple-500/30 bg-gradient-to-br from-purple-500/10 via-fuchsia-500/5 to-transparent p-6 overflow-hidden">
          <div className="absolute -top-16 -right-16 w-40 h-40 rounded-full bg-purple-500/10 blur-3xl pointer-events-none" />
          <div className="relative flex flex-col h-full">
            <div className="inline-flex items-center gap-1.5 text-xs font-medium text-purple-500 mb-2">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-purple-500 animate-pulse" />
              {i18nService.currentLanguage === 'zh' ? '按需定制' : 'Custom'}
            </div>
            <h2 className="text-lg sm:text-xl font-bold dark:text-white mb-1.5">
              🔗 {i18nService.t('scenarioLinkModeTitle')}
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed mb-4 flex-1">
              {i18nService.t('scenarioLinkModeDesc')}
            </p>
            <CardActionRow
              onConfigure={handleLinkModeClick}
              onGoToMyTasks={onGoToMyTasks}
              isZh={i18nService.currentLanguage === 'zh'}
              label={'🔗 ' + i18nService.t('scenarioLinkModeBtn') + ' →'}
              btnClass="bg-purple-500 hover:bg-purple-600 shadow-lg shadow-purple-500/25"
            />
          </div>
        </div>

        {/* 5. Sensitive-word checker */}
        <div className="relative rounded-2xl border border-yellow-500/30 bg-gradient-to-br from-yellow-500/10 via-amber-500/5 to-transparent p-6 overflow-hidden">
          <div className="absolute -top-16 -right-16 w-40 h-40 rounded-full bg-yellow-500/10 blur-3xl pointer-events-none" />
          <div className="relative flex flex-col h-full">
            <div className="inline-flex items-center gap-1.5 text-xs font-medium text-yellow-500 mb-2">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-500 animate-pulse" />
              {i18nService.currentLanguage === 'zh' ? '即开即用' : 'Instant'}
            </div>
            <h2 className="text-lg sm:text-xl font-bold dark:text-white mb-1.5">
              🚫 {i18nService.currentLanguage === 'zh' ? '小红书 · 敏感词检测' : 'XHS Sensitive Word Checker'}
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed mb-4 flex-1">
              {i18nService.currentLanguage === 'zh'
                ? '粘贴笔记标题/正文，1 秒比对 2026 版小红书敏感词库，标出绝对化用语、引流话术、医疗医美等限流词。'
                : 'Paste your note, instantly check against the 2026 XHS sensitive-word library. Flags ad-law violations, off-platform funnels and rate-limit triggers.'}
            </p>
            <button
              type="button"
              onClick={() => onOpenSensitiveCheck && onOpenSensitiveCheck()}
              className="w-full px-6 py-3 text-sm font-bold rounded-xl bg-yellow-500 text-white hover:bg-yellow-600 shadow-lg shadow-yellow-500/25 transition-all active:scale-95"
            >
              🚫 {i18nService.currentLanguage === 'zh' ? '开始检测' : 'Start Check'} →
            </button>
          </div>
        </div>

        {/* (Auto-reply card moved to position 1 above per user feedback v2.4.59) */}
      </section>

      {/* Advantage pills (moved out of banner, cross both cards). Note:
          "✨ 原创质量高" leads since it's the most user-meaningful claim;
          the rest are operational properties of the bot. */}
      <section className="mb-6 flex flex-wrap items-center gap-2">
        {[
          { icon: '✨', zh: '原创质量高', en: 'High-quality original output' },
          { icon: '💰', zh: '成本超低（百篇好文<$1）', en: 'Ultra-low cost (<$1 for 100 posts)' },
          { icon: '🛡️', zh: '完全模拟人类行为不封号', en: 'Fully human-like, no ban risk' },
          { icon: '🚀', zh: '涨粉丝快(真实互动飞速涨粉)', en: 'Fast follower growth (real engagement = rapid follow gains)' },
          { icon: '🤖', zh: '全智能控制', en: 'Fully intelligent control' },
          { icon: '🌊', zh: '1万+爆款文池', en: '10,000+ viral note pool' },
        ].map((p, i) => (
          <span key={i} className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full border border-green-500/20 bg-green-500/5 text-gray-700 dark:text-gray-300">
            {p.icon} {i18nService.currentLanguage === 'zh' ? p.zh : p.en}
          </span>
        ))}
      </section>

      {/* Link-mode modal. 背景点击 NOT 关闭弹窗——用户粘贴的链接很长，容易误
          点关掉；必须通过取消按钮关闭。 */}
      {linkModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
        >
          <div
            className="w-full max-w-2xl rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-2xl p-6"
          >
            <h3 className="text-lg font-bold dark:text-white mb-2">🔗 {i18nService.t('scenarioLinkModeTitle')}</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">{i18nService.t('scenarioLinkModeHint')}</p>
            <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
              {i18nService.t('scenarioLinkModeLabel')}
            </label>
            <textarea
              value={linksText}
              onChange={e => setLinksText(e.target.value)}
              placeholder={i18nService.t('scenarioLinkModePlaceholder')}
              rows={8}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-mono dark:text-white focus:outline-none focus:ring-2 focus:ring-purple-500/50 resize-y min-h-[200px] break-all"
              disabled={linkSubmitting}
            />

            {/* 自动上传 vs 仅生成 */}
            <label className="text-sm font-medium dark:text-gray-200 mt-4 mb-2 block">
              {i18nService.currentLanguage === 'zh' ? '生成后的处理' : 'After generation'}
            </label>
            <div className="space-y-2">
              <label className={`flex items-start gap-2 p-3 rounded-lg border cursor-pointer transition-colors ${linkAutoUpload ? 'border-purple-500 bg-purple-500/5' : 'border-gray-300 dark:border-gray-700'}`}>
                <input type="radio" name="link_auto_upload" checked={linkAutoUpload} onChange={() => setLinkAutoUpload(true)} className="mt-0.5" disabled={linkSubmitting} />
                <div className="flex-1 text-xs leading-relaxed">
                  <div className="font-semibold dark:text-white mb-0.5">
                    {i18nService.currentLanguage === 'zh' ? '📤 自动上传到小红书草稿箱' : '📤 Auto-upload to XHS drafts'}
                  </div>
                  <div className="text-gray-500 dark:text-gray-400">
                    {i18nService.currentLanguage === 'zh' ? '全流程无人值守。⚠️ 单日 >10 篇有封号风险。' : 'Unattended. ⚠️ >10/day risks ban.'}
                  </div>
                </div>
              </label>
              <label className={`flex items-start gap-2 p-3 rounded-lg border cursor-pointer transition-colors ${!linkAutoUpload ? 'border-purple-500 bg-purple-500/5' : 'border-gray-300 dark:border-gray-700'}`}>
                <input type="radio" name="link_auto_upload" checked={!linkAutoUpload} onChange={() => setLinkAutoUpload(false)} className="mt-0.5" disabled={linkSubmitting} />
                <div className="flex-1 text-xs leading-relaxed">
                  <div className="font-semibold dark:text-white mb-0.5">
                    {i18nService.currentLanguage === 'zh' ? '📁 仅生成保存到本地（更安全）' : '📁 Generate only (safer)'}
                  </div>
                  <div className="text-gray-500 dark:text-gray-400">
                    {i18nService.currentLanguage === 'zh' ? '存盘后手动审核上传，封号风险最低。' : 'Review and upload manually later.'}
                  </div>
                </div>
              </label>
            </div>

            <div className="flex gap-2 mt-4">
              <button
                type="button"
                onClick={() => !linkSubmitting && setLinkModalOpen(false)}
                disabled={linkSubmitting}
                className="flex-1 py-2.5 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
              >
                {i18nService.currentLanguage === 'zh' ? '取消' : 'Cancel'}
              </button>
              <button
                type="button"
                onClick={handleLinkModeSubmit}
                disabled={linkSubmitting}
                className="flex-1 py-2.5 rounded-lg text-sm font-semibold bg-purple-500 text-white hover:bg-purple-600 disabled:opacity-50"
              >
                {linkSubmitting
                  ? (i18nService.currentLanguage === 'zh' ? '创建中...' : 'Creating...')
                  : '🚀 ' + i18nService.t('scenarioLinkModeSubmit')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 视频原画下载 modal —— 粘 1-20 个小红书视频链接。背景点击不关闭(链接长易误触)。 */}
      {videoDlModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-2xl rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-2xl p-6">
            <h3 className="text-lg font-bold dark:text-white mb-2">
              ⬇️ {i18nService.currentLanguage === 'zh' ? '小红书 · 视频无水印下载' : 'XHS Watermark-free Video Download'}
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
              {i18nService.currentLanguage === 'zh'
                ? '每行一个小红书视频链接（最多 20 个）。点击开始后会在本地浏览器逐个打开解析并下载到本地，非视频笔记自动跳过。'
                : 'One Xiaohongshu video link per line (max 20). Each opens locally, resolves and downloads; non-video notes are skipped.'}
            </p>
            <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
              {i18nService.currentLanguage === 'zh' ? '小红书视频链接' : 'Xiaohongshu video links'}
            </label>
            <textarea
              value={videoDlLinksText}
              onChange={e => setVideoDlLinksText(e.target.value)}
              placeholder={'https://www.xiaohongshu.com/explore/...\nhttps://xhslink.com/...'}
              rows={8}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-mono dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 resize-y min-h-[200px] break-all"
              disabled={videoDlSubmitting}
            />
            <div className="flex gap-2 mt-4">
              <button
                type="button"
                onClick={() => !videoDlSubmitting && setVideoDlModalOpen(false)}
                disabled={videoDlSubmitting}
                className="flex-1 py-2.5 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
              >
                {i18nService.currentLanguage === 'zh' ? '取消' : 'Cancel'}
              </button>
              <button
                type="button"
                onClick={handleVideoDownloadSubmit}
                disabled={videoDlSubmitting}
                className="flex-1 py-2.5 rounded-lg text-sm font-semibold bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50"
              >
                {videoDlSubmitting
                  ? (i18nService.currentLanguage === 'zh' ? '创建中...' : 'Creating...')
                  : '⬇️ ' + (i18nService.currentLanguage === 'zh' ? '开始下载' : 'Start Download')}
              </button>
            </div>
          </div>
        </div>
      )}

      {loginModalReason && (
        <LoginRequiredModal
          mode="create"
          /* v6.x: 只有发布到 creator.xiaohongshu.com 子域的场景才需要 creator
             中心登录 — image_text(图文创作) 和 linkmode/quickstart(爆款仿写
             也是发到 creator)。autoreply(互动)只用主站,跳过 creator 检查。
             reply_fans(粉丝评论回复)从创作者中心进笔记列表,然后跳主站详情
             页发回复,两个都要登录 → requireCreatorCenter=true。
             loginModalReason 在调用点 setLoginModalReason 时传的关键字 —
             见 line 283/301/313/328。 */
          requireCreatorCenter={loginModalReason !== 'autoreply' && loginModalReason !== 'video_download'}
          onCancel={() => setLoginModalReason(null)}
          onConfirmed={handleLoginConfirmed}
        />
      )}

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
                  ? `小红书已经有 ${tasks.length} 个任务了，最多支持 ${MAX_TASKS} 个`
                  : `You already have ${tasks.length} Xiaohongshu tasks (max ${MAX_TASKS}).`}
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
                className="flex-1 text-sm font-medium px-4 py-2 rounded-lg bg-gradient-to-r from-pink-500 to-rose-500 text-white hover:opacity-90 transition-opacity shadow-sm">
                {isZh ? '去看看现有任务 →' : 'View My Tasks →'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default XhsWorkflowsPage;
