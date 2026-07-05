/**
 * ToutiaoWorkflowsPage — 头条号（Toutiao）平台工作流页面.
 *
 * 已挂 scenarios:
 *   toutiao_image_text          — 用户填 3 段灵感,AI 改写 + 配图,发到头条号
 *   toutiao_reply_fans_comment  — 在头条号后台逐条回复粉丝评论
 *
 * 结构照 DouyinWorkflowsPage,主色 red。头条号没有独立创作者子域,
 * mp.toutiao.com 本身就是创作后台,所以 requireCreatorCenter/creatorOnly 都为 false。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { scenarioService, type Scenario, type Task, type Draft } from '../../services/scenario';
import { LoginRequiredModal } from './LoginRequiredModal';
import { noobClawAuth } from '../../services/noobclawAuth';

interface Props {
  scenarios: Scenario[];           // already filtered to platform='toutiao' by parent
  tasks: Task[];
  draftsByTask: Map<string, Draft[]>;
  loading: boolean;
  onOpenTask: (task_id: string, fromOverride?: 'create' | 'tasks' | 'history') => void;
  onConfigure: (scenario: Scenario) => void;
  onChanged?: () => void | Promise<void>;
  /** Jump to "My Tasks" filtered to 头条号 — used by 已达上限 modal CTA. */
  onGoToMyTasks?: () => void;
}

export const ToutiaoWorkflowsPage: React.FC<Props> = ({
  scenarios,
  tasks,
  draftsByTask: _draftsByTask,
  loading,
  onOpenTask: _onOpenTask,
  onConfigure,
  onChanged: _onChanged,
  onGoToMyTasks,
}) => {
  const isZh = i18nService.currentLanguage === 'zh';
  const [loginModalReason, setLoginModalReason] = useState<string | null>(null);
  const [, setRunningTaskIds] = useState<Set<string>>(new Set());

  // 同平台任务上限 5 个 — 跟其它平台对齐。
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

  // ── 图文创作 fallback —— backend scenarios 列表还没拉到时也能点开 wizard。
  const FALLBACK_IMAGE_TEXT: Scenario = {
    id: 'toutiao_image_text',
    version: '1.0.0',
    platform: 'toutiao' as any,
    workflow_type: 'toutiao_image_text_creation' as any,
    category: 'knowledge',
    name_zh: '头条号 · 图文创作',
    name_en: 'Toutiao Image-Text Creation',
    description_zh: '你填 3 段灵感来源，AI 改写成头条号图文文章。配图二选一：AI 生图 或 关键词抓网络图（2-6 张可调）。',
    description_en: 'Fill 3 source snippets; AI rewrites into a Toutiao image-text article. Image source: AI-generated OR scrape real photos by keyword (2-6 configurable).',
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
    risk_caps: {
      max_daily_runs: 3,
      max_scroll_per_run: 0,
      min_scroll_delay_ms: 0,
      max_scroll_delay_ms: 0,
      read_dwell_min_ms: 0,
      read_dwell_max_ms: 0,
      max_run_duration_ms: 1800000,
      min_interval_hours: 4,
      weekly_rest_days: 1,
      cooldown_captcha_hours: 24,
      cooldown_rate_limit_hours: 48,
      cooldown_account_flag_hours: 72,
    } as any,
    required_login_url: 'https://mp.toutiao.com/',
    entry_urls: {},
    skills: {},
  } as any;

  const imageText = findById('toutiao_image_text') || FALLBACK_IMAGE_TEXT;

  const FALLBACK_REPLY_FANS: Scenario = {
    id: 'toutiao_reply_fans_comment',
    version: '1.0.0',
    platform: 'toutiao' as any,
    workflow_type: 'toutiao_reply_fans_comment' as any,
    category: 'engagement',
    name_zh: '头条号 · 自动回复粉丝',
    name_en: 'Toutiao Reply Fan Comments',
    description_zh: '在头条号后台「评论管理」逐条回复粉丝评论。AI 按评论内容写回应，可选引流尾巴。已回复过的、自己留的评论自动跳过，只回粉丝、绝不评论作品本身。',
    description_en: 'Auto-reply to fan comments in Toutiao Backend comment management. AI-tailored, optional funnel tail. Skips already-replied / your own.',
    icon: '💬',
    default_config: {
      funnel_phrase: '',
      funnel_probability: 50,
      schedule_window: '10:00-22:00',
    } as any,
    risk_caps: {} as any,
    required_login_url: 'https://mp.toutiao.com/',
    entry_urls: {},
    skills: {},
  } as any;

  const replyFans = findById('toutiao_reply_fans_comment') || FALLBACK_REPLY_FANS;

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
    // 先弹登录检查 modal,确认浏览器 + 头条号后台标签 + 登录都通过再进 wizard
    setLoginModalReason(scenario.id);
  }, [isZh, tasks.length]);

  const handleLoginConfirmed = () => {
    const reason = loginModalReason;
    setLoginModalReason(null);
    if (reason === 'toutiao_image_text') {
      onConfigure(imageText);
    } else if (reason === 'toutiao_reply_fans_comment') {
      onConfigure(replyFans);
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Scenario cards — 图文创作 + 自动回复粉丝。 */}
      <section className="mb-6 grid grid-cols-1 md:grid-cols-2 gap-4">
        <ToutiaoImageTextCard
          loading={loading}
          scenario={imageText}
          onConfigure={() => handleConfigure(imageText)}
          onGoToMyTasks={onGoToMyTasks}
          isZh={isZh}
        />
        <ToutiaoReplyFansCard
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
              className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full border border-red-500/20 bg-red-500/5 text-gray-700 dark:text-gray-300"
            >
              {p.icon} {isZh ? p.zh : p.en}
            </span>
          ))}
        </div>
      </section>

      {/* Login modal — 头条号没有独立创作者子域,mp.toutiao.com 本身就是创作后台,
          所以只校验主域登录,requireCreatorCenter / creatorOnly 都为 false。 */}
      {loginModalReason && (
        <LoginRequiredModal
          mode="create"
          platform="toutiao"
          requireCreatorCenter={false}
          creatorOnly={false}
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
                  ? `头条号已经有 ${tasks.length} 个任务了，最多支持 ${MAX_TASKS} 个`
                  : `You already have ${tasks.length} Toutiao tasks (max ${MAX_TASKS}).`}
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
                className="flex-1 text-sm font-medium px-4 py-2 rounded-lg bg-gradient-to-r from-red-500 to-rose-500 text-white hover:opacity-90 transition-opacity shadow-sm">
                {isZh ? '去看看现有任务 →' : 'View My Tasks →'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ── Scenario card sub-component ─────────────────────────────────────

type CardProps = {
  loading: boolean;
  scenario: Scenario | null;
  onConfigure: () => void;
  onGoToMyTasks?: () => void;
  isZh: boolean;
};

// 卡片底部操作行:左「开始」按钮(~70%)+ 右「查看已有任务 »」文字入口(~30%)。
const CardActionRow: React.FC<{
  loading: boolean; onConfigure: () => void; onGoToMyTasks?: () => void;
  isZh: boolean; label: string; btnClass: string;
}> = ({ loading, onConfigure, onGoToMyTasks, isZh, label, btnClass }) => (
  <div className="flex items-stretch gap-2">
    <button
      type="button"
      onClick={onConfigure}
      disabled={loading}
      className={`flex-[7] px-4 py-2.5 text-sm font-bold rounded-xl disabled:opacity-40 disabled:cursor-not-allowed text-white transition-all active:scale-95 ${btnClass}`}
    >
      {label}
    </button>
    <button
      type="button"
      onClick={() => onGoToMyTasks?.()}
      className="flex-[3] px-2 py-2.5 text-xs font-medium rounded-xl text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-800/60 hover:bg-gray-200 dark:hover:bg-gray-700/80 border border-gray-300 dark:border-gray-600 transition-colors whitespace-nowrap"
    >
      {isZh ? '已有任务' : 'My tasks'} »
    </button>
  </div>
);

// ── 头条号图文创作 card —— fuchsia 主色,跟抖音图文卡同源。
const ToutiaoImageTextCard: React.FC<CardProps> = ({ loading, scenario: _scenario, onConfigure, onGoToMyTasks, isZh }) => {
  return (
    <div className="relative rounded-2xl border border-fuchsia-500/30 bg-gradient-to-br from-fuchsia-500/10 via-pink-500/5 to-transparent p-5 overflow-hidden flex flex-col">
      <div className="absolute -top-16 -right-16 w-40 h-40 rounded-full bg-fuchsia-500/10 blur-3xl pointer-events-none" />
      <div className="relative flex flex-col flex-1">
        <div className="inline-flex items-center gap-1.5 text-xs font-medium text-fuchsia-500 mb-2">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-fuchsia-500 animate-pulse" />
          {isZh ? '图文创作' : 'Image-Text Post'}
        </div>
        <h3 className="text-base font-bold dark:text-white mb-1.5">
          📝 {isZh ? '头条号 · 图文创作' : 'Toutiao Image-Text'}
        </h3>
        <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed mb-3 flex-1">
          {isZh
            ? '你填 3 段灵感来源(经历 / 想法 / 笔记都行),每次运行 AI 随机抽一段,按你的人设改写成头条号图文文章,配一张封面图 + 一张内容图,自动发布到头条号(也可选存草稿/仅本地)。'
            : 'Fill 3 source snippets (notes / experiences). Each run picks one at random, rewrites in your persona, generates 1 cover + 1 content image, then auto-publishes (or draft / local).'}
        </p>
        <CardActionRow
          loading={loading}
          onConfigure={onConfigure}
          onGoToMyTasks={onGoToMyTasks}
          isZh={isZh}
          label={isZh ? '📝 开始创作 →' : '📝 Start →'}
          btnClass="bg-fuchsia-500 hover:bg-fuchsia-600 shadow-lg shadow-fuchsia-500/25"
        />
      </div>
    </div>
  );
};

// ── 头条号自动回复粉丝 card —— cyan 主色区分于图文(fuchsia)。
const ToutiaoReplyFansCard: React.FC<CardProps> = ({ loading, scenario: _scenario, onConfigure, onGoToMyTasks, isZh }) => {
  return (
    <div className="relative rounded-2xl border border-cyan-500/30 bg-gradient-to-br from-cyan-500/10 via-sky-500/5 to-transparent p-5 overflow-hidden flex flex-col">
      <div className="absolute -top-16 -right-16 w-40 h-40 rounded-full bg-cyan-500/10 blur-3xl pointer-events-none" />
      <div className="relative flex flex-col flex-1">
        <div className="inline-flex items-center gap-1.5 text-xs font-medium text-cyan-500 mb-2">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-cyan-500 animate-pulse" />
          {isZh ? '粉丝维护' : 'Fan Engagement'}
        </div>
        <h3 className="text-base font-bold dark:text-white mb-1.5">
          💬 {isZh ? '头条号 · 自动回复粉丝' : 'Toutiao Reply Fans'}
        </h3>
        <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed mb-3 flex-1">
          {isZh
            ? '在头条号后台「评论管理」逐条回复粉丝评论,AI 按评论内容写回应,可选按概率加引流尾巴。已回复过的、自己留的自动跳过,只回粉丝、绝不评论作品本身,真人节奏间隔。'
            : 'Replies to fan comments in Toutiao Backend comment management. AI-tailored replies with optional funnel tail. Skips already-replied / your own; only replies to fans, never the article itself.'}
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
