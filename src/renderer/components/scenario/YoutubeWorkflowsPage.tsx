/**
 * YoutubeWorkflowsPage — YouTube 平台工作流页面.
 *
 * v1 只挂一个 scenario:
 *   youtube_auto_engage — 自动浏览首页推荐、按用户配置做点赞 / 订阅 / 评论
 *
 * 结构精简版 XWorkflowsPage:
 *   - 单张 scenario 卡片
 *   - 任务上限守卫 (5 个)
 *   - 不需要 quick-create modal,统一走 ConfigWizard
 */

import React, { useCallback, useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { scenarioService, type Scenario, type Task, type Draft } from '../../services/scenario';
import { LoginRequiredModal } from './LoginRequiredModal';
import { CardActionRow } from './CardActionRow';
import { noobClawAuth } from '../../services/noobclawAuth';

interface Props {
  scenarios: Scenario[];           // already filtered to platform='youtube' by parent
  tasks: Task[];
  draftsByTask: Map<string, Draft[]>;
  loading: boolean;
  onOpenTask: (task_id: string, fromOverride?: 'create' | 'tasks' | 'history') => void;
  onConfigure: (scenario: Scenario) => void;
  onChanged?: () => void | Promise<void>;
  /** Jump to "My Tasks" filtered to YouTube — used by 已达上限 modal CTA. */
  onGoToMyTasks?: () => void;
}

export const YoutubeWorkflowsPage: React.FC<Props> = ({
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

  // 同平台任务上限 5 个 — 跟 X / Binance / XHS 对齐。
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

  const autoEngage = findById('youtube_auto_engage');

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
    // Open pre-run check (extension + YouTube tab + login). After it
    // passes, handleLoginConfirmed will hand off to ConfigWizard.
    setLoginModalReason('configure');
  }, [isZh, tasks.length]);

  const handleLoginConfirmed = () => {
    setLoginModalReason(null);
    if (autoEngage) onConfigure(autoEngage);
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Scenario card grid — 当前只挂 youtube_auto_engage 一张卡,容器
          收窄居中,视觉上不让单卡撑满整行。以后加第 2/3 个 youtube scenario
          只需要把 max-w-md 换成 max-w-3xl/4xl + 让 grid 列数随卡片数增长,
          其它结构不动。 */}
      <section className="mb-6 grid grid-cols-1 md:grid-cols-2 gap-4 max-w-md md:max-w-md mx-auto">
        <YoutubeScenarioCard
          loading={loading}
          scenario={autoEngage}
          onConfigure={() => handleConfigure(autoEngage)}
          onGoToMyTasks={onGoToMyTasks}
          isZh={isZh}
        />
      </section>

      {/* Feature pills — same compact pill row as XWorkflowsPage. */}
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
              className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full border border-indigo-500/20 bg-indigo-500/5 text-gray-700 dark:text-gray-300"
            >
              {p.icon} {isZh ? p.zh : p.en}
            </span>
          ))}
        </div>
      </section>

      {/* Pre-run check modal — extension + YouTube tab + login state */}
      {loginModalReason && (
        <LoginRequiredModal
          mode="create"
          platform="youtube"
          onCancel={() => setLoginModalReason(null)}
          onConfirmed={handleLoginConfirmed}
        />
      )}

      {/* Task limit modal — same shape as XWorkflowsPage. */}
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
                  ? `YouTube 已经有 ${tasks.length} 个任务了，最多支持 ${MAX_TASKS} 个`
                  : `You already have ${tasks.length} YouTube tasks (max ${MAX_TASKS}).`}
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
                className="flex-1 text-sm font-medium px-4 py-2 rounded-lg bg-gradient-to-r from-indigo-500 to-blue-500 text-white hover:opacity-90 transition-opacity shadow-sm">
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

const YoutubeScenarioCard: React.FC<CardProps> = ({ loading, scenario: _scenario, onConfigure, onGoToMyTasks, isZh }) => {
  return (
    <div className="relative rounded-2xl border border-indigo-500/30 bg-gradient-to-br from-indigo-500/10 via-blue-500/5 to-transparent p-5 overflow-hidden flex flex-col md:col-span-2">
      <div className="absolute -top-16 -right-16 w-40 h-40 rounded-full bg-indigo-500/10 blur-3xl pointer-events-none" />
      <div className="relative flex flex-col flex-1">
        <div className="inline-flex items-center gap-1.5 text-xs font-medium text-indigo-500 mb-2">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" />
          {isZh ? '互动涨粉' : 'Engage & Grow'}
        </div>
        <h3 className="text-base font-bold dark:text-white mb-1.5">
          📺 {isZh ? 'YouTube · 互动涨粉' : 'YouTube Engage & Grow'}
        </h3>
        <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed mb-3 flex-1">
          {isZh
            ? '每次运行按你配置的"随机区间"决定本轮点赞 / 订阅 / 评论各做几次,然后按你的赛道关键词搜索 YouTube 视频自动按配额完成。评论由 AI 按视频上下文 + 关键词自动生成,行为间隔随机模拟真人。'
            : 'Each run rolls per-action counts from your random ranges, then searches YouTube with your track keywords and works through the quota. Comments are AI-generated from video context + keyword.'}
        </p>
        <CardActionRow
          loading={loading}
          onConfigure={onConfigure}
          onGoToMyTasks={onGoToMyTasks}
          isZh={isZh}
          label={isZh ? '📺 开始互动 →' : '📺 Start →'}
          btnClass="bg-indigo-500 hover:bg-indigo-600 shadow-lg shadow-indigo-500/25"
        />
      </div>
    </div>
  );
};
