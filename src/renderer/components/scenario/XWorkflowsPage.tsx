/**
 * XWorkflowsPage — Twitter (X) 平台工作流页面.
 *
 * 结构镜像 XhsWorkflowsPage：
 *   - 顶部一个简短 hero 介绍
 *   - 3 张 scenario 卡片
 *   - 已有任务列表
 *
 * v1 scenario set (see backend feature/twitter-v1 branch):
 *   x_auto_engage   — 自动关注 KOL + 评论 feed + 评论已关注
 *   x_link_rewrite  — 指定推文链接仿写发推
 *   x_post_creator  — 每日自动发 1 条推（3 机制随机）
 */

import React, { useCallback, useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { scenarioService, type Scenario, type Task, type Draft } from '../../services/scenario';
import { LoginRequiredModal } from './LoginRequiredModal';
import { CardActionRow } from './CardActionRow';
import { noobClawAuth } from '../../services/noobclawAuth';

// web3 KOL track preset table — task list moved to MyTasksPage so this is
// no longer used in this file; MyTasksPage has its own copy.
// @ts-ignore — keep here in case the create-only page wants to surface
// track previews in the future.
const _WEB3_TRACK_ICONS: Record<string, { icon: string; name_zh: string }> = { // eslint-disable-line
  web3_alpha: { icon: '🎯', name_zh: 'Web3 · Alpha 猎人' },
  web3_defi: { icon: '🏛️', name_zh: 'Web3 · DeFi 用户' },
  web3_meme: { icon: '🎪', name_zh: 'Web3 · Meme 文化' },
  web3_builder: { icon: '🛠️', name_zh: 'Web3 · 建设者' },
  web3_zh_kol: { icon: '📢', name_zh: 'Web3 · 通用 KOL' },
};

interface Props {
  scenarios: Scenario[];           // already filtered to platform='x' by parent
  tasks: Task[];
  draftsByTask: Map<string, Draft[]>;
  loading: boolean;
  onOpenTask: (task_id: string, fromOverride?: 'create' | 'tasks' | 'history') => void;
  onConfigure: (scenario: Scenario) => void;
  onChanged?: () => void | Promise<void>;
  /** Jump to the "My Tasks" page filtered to Twitter — used by the
   *  "已达任务上限" modal CTA. */
  onGoToMyTasks?: () => void;
}

export const XWorkflowsPage: React.FC<Props> = ({
  scenarios,
  tasks,
  draftsByTask: _draftsByTask,   // not used yet on Twitter side — drafts-free MVP
  loading,
  onOpenTask,
  onConfigure,
  onChanged,
  onGoToMyTasks,
}) => {
  const isZh = i18nService.currentLanguage === 'zh';
  const [loginModalReason, setLoginModalReason] = useState<string | null>(null);
  const [runningTaskIds, setRunningTaskIds] = useState<Set<string>>(new Set());

  // v4.28: 跟 Binance / XHS workflow 页面对齐 —— 同平台任务上限 5 个,
  // 超出弹「已达任务上限」modal。之前 X 页缺这个守卫,可以无限新建任务,
  // 用户反馈"我再创建也没提示我"。
  const MAX_TASKS = 5;
  const [maxTasksModalOpen, setMaxTasksModalOpen] = useState(false);

  // ── x_link_rewrite quick-create modal (mirrors XHS link-mode flow) ──
  // The user's expectation: paste URLs → click run → done. No wizard, no
  // schedule (it's a one-shot job, run_interval='once'). Modal collects
  // the URL list + auto_upload toggle, creates the task, jumps to detail
  // page, fires runTaskNow asynchronously. Same shape as XHS link-mode.
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [linksText, setLinksText] = useState('');
  const [linkSubmitting, setLinkSubmitting] = useState(false);
  const [linkAutoUpload, setLinkAutoUpload] = useState(true);
  // Blue V flag for the link-rewrite quick modal — same toggle as the
  // wizard for the other two Twitter scenarios. Default false.
  const [linkIsBlueV, setLinkIsBlueV] = useState(false);

  const validateTweetLinks = (text: string): { ok: string[]; err: string | null } => {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 1) return { ok: [], err: isZh ? '至少粘贴 1 条推文链接' : 'Paste at least 1 tweet URL' };
    if (lines.length > 5) return { ok: [], err: isZh ? '最多 5 条' : 'Max 5 URLs' };
    for (const l of lines) {
      // Accept twitter.com or x.com /<handle>/status/<id>
      if (!/^https?:\/\/(www\.)?(twitter|x)\.com\/[^/]+\/status\/\d+/i.test(l)) {
        return { ok: [], err: (isZh ? '不是有效推文链接：' : 'Not a valid tweet URL: ') + l.slice(0, 80) };
      }
    }
    return { ok: lines, err: null };
  };

  // Poll which tasks are currently running (could be > 1 with multi-tab
  // concurrency when XHS task + Twitter task are both in flight)
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

  // Resolve each scenario by id, fall back to a placeholder when the
  // backend list hasn't loaded yet. Matches the pattern in XhsWorkflowsPage.
  const findById = (id: string): Scenario | null =>
    scenarios.find(s => s.id === id) || null;

  const autoEngage = findById('x_auto_engage');
  const linkRewrite = findById('x_link_rewrite');
  const postCreator = findById('x_post_creator');

  // Tasks grouped by scenario_id
  const tasksByScenario: Record<string, Task[]> = {};
  for (const t of tasks) {
    const key = t.scenario_id;
    if (!tasksByScenario[key]) tasksByScenario[key] = [];
    tasksByScenario[key].push(t);
  }

  // ── Login gate ──
  const handleConfigure = useCallback(async (scenario: Scenario | null) => {
    if (!scenario) {
      alert(isZh ? '场景元数据还在加载中，请稍后再试' : 'Scenario metadata still loading');
      return;
    }
    // v4.28: 平台任务上限 5 个 —— 超过弹 modal 不让继续。
    if (tasks.length >= MAX_TASKS) {
      setMaxTasksModalOpen(true);
      return;
    }
    if (!noobClawAuth.getState().isAuthenticated) {
      noobClawAuth.requireLoginUI();
      return;
    }
    // x_link_rewrite is intentionally a one-shot job — same UX as XHS link
    // mode: open a quick modal for URLs + auto_upload, no wizard / schedule.
    // Other Twitter scenarios still go through the full ConfigWizard.
    if (scenario.id === 'x_link_rewrite') {
      setLinkModalOpen(true);
      return;
    }
    onConfigure(scenario);
  }, [onConfigure, isZh, tasks.length]);

  const handleLinkSubmit = useCallback(async () => {
    if (linkSubmitting) return;
    // v4.28: 同样的 5 任务上限守卫 —— link rewrite 也算一个任务。
    if (tasks.length >= MAX_TASKS) {
      setMaxTasksModalOpen(true);
      return;
    }
    const { ok, err } = validateTweetLinks(linksText);
    if (err) { alert(err); return; }
    if (!noobClawAuth.getState().isAuthenticated) {
      noobClawAuth.requireLoginUI();
      return;
    }
    if (!linkRewrite) {
      alert(isZh ? '场景元数据还在加载中，请稍后再试' : 'Scenario metadata still loading');
      return;
    }
    setLinkSubmitting(true);
    try {
      const now = new Date();
      const mm = String(now.getMinutes()).padStart(2, '0');
      const hh = String(now.getHours()).padStart(2, '0');
      const newTask = await scenarioService.createTask({
        scenario_id: linkRewrite.id,
        // No track concept for link rewrite — pass an explicit sentinel so
        // detail page knows this came from URL-mode (not a real preset).
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
        is_blue_v: linkIsBlueV,
      } as any);
      setLinkModalOpen(false);
      setLinksText('');
      // Refresh parent tasks[] before jumping so detail page can find it
      if (onChanged) { await onChanged(); }
      // Land on the task detail page; back button takes user to My Tasks
      // (not back into the just-submitted quick-create modal).
      onOpenTask(newTask.id, 'tasks');
      scenarioService.runTaskNow(newTask.id).catch((e: any) => {
        console.error('[XLinkMode] runTaskNow failed:', e);
      });
    } catch (e) {
      alert((isZh ? '创建失败：' : 'Create failed: ') + String(e).slice(0, 120));
    } finally {
      setLinkSubmitting(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linksText, linkAutoUpload, linkIsBlueV, linkSubmitting, linkRewrite, isZh]);

  // (scheduleLabel helper used to live here for the bottom task list.
  //  Tasks moved to MyTasksPage which has its own implementation.)

  // ── Render ──

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Scenario cards — match XHS layout: jump straight to the cards,
          no platform hero / intro paragraph / mainland-VPN warning above.
          The three Twitter scenarios speak for themselves; the bottom
          features row covers what was previously in the hero pills. */}
      <section className="mb-6 grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* 1. Auto engage */}
        <ScenarioCard
          color="emerald"
          emoji="🐦"
          badge={isZh ? '互动涨粉' : 'Engage & Grow'}
          titleZh="推特 · 互动涨粉"
          titleEn="X Engage & Grow"
          descZh="锁定 Web3 KOL 池跟踪 alpha，AI 给已关注大佬的新推写有观点的回复，再去推荐流抓爆点跟评，全程模拟真人节奏自然冒泡，被算法标记的概率更低。"
          descEn="Locks onto your Web3 KOL pool for fresh alpha — AI drops opinionated replies under followed accounts and pounces on viral takes in the For You feed, paced like a real human to dodge algo flags."
          loading={loading}
          scenario={autoEngage}
          existingTasks={autoEngage ? tasksByScenario[autoEngage.id] || [] : []}
          runningTaskIds={runningTaskIds}
          onOpenTask={onOpenTask}
          onConfigure={() => handleConfigure(autoEngage)}
          onGoToMyTasks={onGoToMyTasks}
          isZh={isZh}
          ctaZh="开始互动"
          ctaEn="Start"
        />
        {/* 2. Post creator */}
        <ScenarioCard
          color="sky"
          emoji="📝"
          badge={isZh ? '自动发推' : 'Daily post'}
          titleZh="推特 · 自动发推"
          titleEn="X Auto Post"
          descZh="三路引擎防同质化：feed 爆款深度仿写、热点原创快评、对大 V 引用回应，AI 按你的人设随机轮换，每天稳定产出不留模板痕。"
          descEn="Three engines, zero template fatigue: deep-rewrites viral feed posts, drafts originals on live trends, quote-tweets influential voices — AI rotates through your persona for variety algorithms reward."
          loading={loading}
          scenario={postCreator}
          existingTasks={postCreator ? tasksByScenario[postCreator.id] || [] : []}
          runningTaskIds={runningTaskIds}
          onOpenTask={onOpenTask}
          onConfigure={() => handleConfigure(postCreator)}
          onGoToMyTasks={onGoToMyTasks}
          isZh={isZh}
          ctaZh="开始发推"
          ctaEn="Start"
        />
        {/* 3. Link rewrite */}
        <ScenarioCard
          color="violet"
          emoji="✍️"
          badge={isZh ? '手动一次性' : 'One-shot'}
          titleZh="推特 · 指定链接仿写"
          titleEn="Tweet Rewrite (URL)"
          descZh="粘贴 1-20 条推文链接，AI 解构每条钩子 + 结构，用你的人设仿写成新推（不抄袭），逐条间隔发布。"
          descEn="Paste 1-20 tweet URLs. AI deconstructs hook + structure, rewrites in your voice (no copying), posts one by one."
          loading={loading}
          scenario={linkRewrite}
          existingTasks={linkRewrite ? tasksByScenario[linkRewrite.id] || [] : []}
          runningTaskIds={runningTaskIds}
          onOpenTask={onOpenTask}
          onConfigure={() => handleConfigure(linkRewrite)}
          onGoToMyTasks={onGoToMyTasks}
          isZh={isZh}
          ctaZh="粘贴链接开始"
          ctaEn="Paste links to start"
        />
      </section>

      {/* Twitter features row — compact pill design so it doesn't steal
          attention from the cards above. No section title (the pills
          self-describe). User feedback: dropped the VPN warning and the
          random-image pill (signal-to-noise too low for the hero spot)
          and the "几个特点" header (redundant). */}
      <section className="mb-6">
        <div className="flex flex-wrap gap-2">
          {[
            { icon: '✨', zh: '原创质量高', en: 'High-quality original output' },
            { icon: '💰', zh: '成本超低（百篇好文<$1）', en: 'Ultra-low cost (<$1 for 100 posts)' },
            { icon: '🛡️', zh: '严风控,完全模拟人类行为(动作间隔时间 + 随机)', en: 'Strict anti-detection, fully human-like (jittered intervals + randomization)' },
            { icon: '🚀', zh: '涨粉丝快(真实互动飞速涨粉)', en: 'Fast follower growth (real engagement = rapid follow gains)' },
            { icon: '🤝', zh: '1000+ web3 KOL 池', en: '1000+ Web3 KOL pool' },
          ].map((p, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full border border-sky-500/20 bg-sky-500/5 text-gray-700 dark:text-gray-300"
            >
              {p.icon} {isZh ? p.zh : p.en}
            </span>
          ))}
        </div>
      </section>


      {/* Login modal (reuses XHS login gate component but shows "X" copy).
          TODO: if we need X-specific login detection (twitter.com not
          xiaohongshu.com), expand LoginRequiredModal to accept a platform
          prop. For MVP we assume user logs into x.com in the same Chrome.  */}
      {loginModalReason && (
        <LoginRequiredModal
          mode="create"
          platform="x"
          onCancel={() => setLoginModalReason(null)}
          onConfirmed={() => setLoginModalReason(null)}
        />
      )}

      {/* v4.28: 任务上限弹窗 —— 跟 Binance / XHS 页面同款 */}
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
                  ? `推特已经有 ${tasks.length} 个任务了，最多支持 ${MAX_TASKS} 个`
                  : `You already have ${tasks.length} Twitter tasks (max ${MAX_TASKS}).`}
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
                className="flex-1 text-sm font-medium px-4 py-2 rounded-lg bg-gradient-to-r from-sky-500 to-blue-500 text-white hover:opacity-90 transition-opacity shadow-sm">
                {isZh ? '去看看现有任务 →' : 'View My Tasks →'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* x_link_rewrite quick-create modal (mirrors XHS link-mode UX).
          Click outside DOES NOT dismiss — pasted URL lists are long, easy to
          mis-click and lose. Cancel button only. */}
      {linkModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-2xl rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-2xl p-6">
            <h3 className="text-lg font-bold dark:text-white mb-2">
              ✍️ {isZh ? '推特 · 指定链接仿写' : 'Tweet Rewrite (URL)'}
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
              {isZh
                ? '粘贴你看中的爆款推文，AI 拆解每条的钩子和结构，用你的语言风格重写成新推（不是搬运），逐条按真人节奏间隔发布。'
                : 'Paste viral tweets you like. AI deconstructs each hook + structure and rewrites in your voice (not a repost), posting one by one at human pace.'}
            </p>
            <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
              {isZh ? '推文链接（每行 1 条）' : 'Tweet URLs (one per line)'}
            </label>
            <textarea
              value={linksText}
              onChange={e => setLinksText(e.target.value)}
              placeholder={'https://x.com/handle/status/12345...\nhttps://x.com/handle/status/67890...'}
              rows={8}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-mono dark:text-white focus:outline-none focus:ring-2 focus:ring-violet-500/50 resize-y min-h-[180px] break-all"
              disabled={linkSubmitting}
            />

            {/* Blue V flag — same control as the wizard for the other 2
                Twitter scenarios. Drives the per-tweet length cap. */}
            <label className="text-sm font-medium dark:text-gray-200 mt-4 mb-2 block">
              {isZh ? '🔵 推特账号类型' : '🔵 Twitter account type'}
            </label>
            <div
              className={`flex items-start gap-3 rounded-xl border px-4 py-3 cursor-pointer transition-colors ${
                linkIsBlueV ? 'border-blue-500 bg-blue-500/10' : 'border-gray-300 dark:border-gray-700 hover:border-blue-500/50'
              }`}
              onClick={() => !linkSubmitting && setLinkIsBlueV(!linkIsBlueV)}
            >
              <input
                type="checkbox"
                checked={linkIsBlueV}
                onChange={e => setLinkIsBlueV(e.target.checked)}
                onClick={e => e.stopPropagation()}
                disabled={linkSubmitting}
                className="mt-0.5 h-4 w-4 accent-blue-500 cursor-pointer"
              />
              <div className="flex-1 text-xs leading-relaxed">
                <div className="font-semibold dark:text-white mb-0.5">
                  {isZh ? '我的推特账号是蓝V（已订阅 X Premium）' : 'My X account is verified (Blue / Premium)'}
                </div>
                <div className="text-gray-500 dark:text-gray-400">
                  {isZh
                    ? <>勾选 = 蓝V，AI 自由短/中/长。不勾（默认）= 普通账号，AI <strong>强制</strong>把每条新推 ≤ <strong>140 字符</strong>。</>
                    : <>Checked = Blue V — AI may pick short/mid/long. Unchecked (default) = AI is <strong>forced</strong> to keep every tweet ≤ <strong>140 chars</strong>.</>}
                </div>
              </div>
            </div>

            <label className="text-sm font-medium dark:text-gray-200 mt-4 mb-2 block">
              {isZh ? '生成后的处理' : 'After rewriting'}
            </label>
            <div className="space-y-2">
              <label className={`flex items-start gap-2 p-3 rounded-lg border cursor-pointer transition-colors ${linkAutoUpload ? 'border-violet-500 bg-violet-500/5' : 'border-gray-300 dark:border-gray-700'}`}>
                <input type="radio" name="x_link_auto_upload" checked={linkAutoUpload} onChange={() => setLinkAutoUpload(true)} className="mt-0.5" disabled={linkSubmitting} />
                <div className="flex-1 text-xs leading-relaxed">
                  <div className="font-semibold dark:text-white mb-0.5">
                    {isZh ? '🚀 自动发布到推特' : '🚀 Auto-post to Twitter'}
                  </div>
                  <div className="text-gray-500 dark:text-gray-400">
                    {isZh ? '逐条按真人节奏随机间隔发布。⚠️ 推文一旦发布无法撤回。' : 'Posts one by one with human-pace jitter. ⚠️ Tweets cannot be unposted.'}
                  </div>
                </div>
              </label>
              <label className={`flex items-start gap-2 p-3 rounded-lg border cursor-pointer transition-colors ${!linkAutoUpload ? 'border-violet-500 bg-violet-500/5' : 'border-gray-300 dark:border-gray-700'}`}>
                <input type="radio" name="x_link_auto_upload" checked={!linkAutoUpload} onChange={() => setLinkAutoUpload(false)} className="mt-0.5" disabled={linkSubmitting} />
                <div className="flex-1 text-xs leading-relaxed">
                  <div className="font-semibold dark:text-white mb-0.5">
                    {isZh ? '📁 仅生成保存到本地（更安全）' : '📁 Generate only (safer)'}
                  </div>
                  <div className="text-gray-500 dark:text-gray-400">
                    {isZh ? '存盘后人工审核挑选。' : 'Saved locally for manual review.'}
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
                {isZh ? '取消' : 'Cancel'}
              </button>
              <button
                type="button"
                onClick={handleLinkSubmit}
                disabled={linkSubmitting}
                className="flex-1 py-2.5 rounded-lg text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-50"
              >
                {linkSubmitting
                  ? (isZh ? '创建中...' : 'Creating...')
                  : '🚀 ' + (isZh ? '立即开始仿写' : 'Start Rewriting Now')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ── Scenario card sub-component ──

type ScenarioCardProps = {
  color: 'emerald' | 'sky' | 'violet';
  emoji: string;
  badge: string;
  titleZh: string;
  titleEn: string;
  descZh: string;
  descEn: string;
  ctaZh: string;
  ctaEn: string;
  loading: boolean;
  scenario: Scenario | null;
  existingTasks: Task[];
  runningTaskIds: Set<string>;
  onOpenTask: (id: string) => void;
  onConfigure: () => void;
  onGoToMyTasks?: () => void;
  isZh: boolean;
};

const ScenarioCard: React.FC<ScenarioCardProps> = ({
  color, emoji, badge, titleZh, titleEn, descZh, descEn, ctaZh, ctaEn,
  loading, scenario: _scenario, existingTasks, runningTaskIds: _runningTaskIds, onOpenTask: _onOpenTask, onConfigure, onGoToMyTasks,
  isZh,
}) => {
  const palette: Record<typeof color, { border: string; bg: string; text: string; btn: string; shadow: string }> = {
    emerald: {
      border: 'border-emerald-500/30',
      bg: 'from-emerald-500/10 via-green-500/5',
      text: 'text-emerald-500',
      btn: 'bg-emerald-500 hover:bg-emerald-600',
      shadow: 'shadow-emerald-500/25',
    },
    sky: {
      border: 'border-sky-500/30',
      bg: 'from-sky-500/10 via-blue-500/5',
      text: 'text-sky-500',
      btn: 'bg-sky-500 hover:bg-sky-600',
      shadow: 'shadow-sky-500/25',
    },
    violet: {
      border: 'border-violet-500/30',
      bg: 'from-violet-500/10 via-purple-500/5',
      text: 'text-violet-500',
      btn: 'bg-violet-500 hover:bg-violet-600',
      shadow: 'shadow-violet-500/25',
    },
  };
  const c = palette[color];
  // (existingTasks intentionally unused inside the card now — cards are
  //  pure templates / launchers. Per-card running indicator removed in
  //  v2.4.21; "查看已配置的任务" link removed in v2.4.25 — both lived on
  //  My Tasks page now.)
  void existingTasks;

  return (
    <div className={`relative rounded-2xl border ${c.border} bg-gradient-to-br ${c.bg} to-transparent p-5 overflow-hidden flex flex-col`}>
      <div className={`absolute -top-16 -right-16 w-40 h-40 rounded-full ${c.bg.replace('from-', 'bg-').split(' ')[0]}/10 blur-3xl pointer-events-none`} />
      <div className="relative flex flex-col flex-1">
        <div className={`inline-flex items-center gap-1.5 text-xs font-medium ${c.text} mb-2`}>
          <span className={`inline-block w-1.5 h-1.5 rounded-full ${c.text.replace('text-', 'bg-')} animate-pulse`} />
          {badge}
        </div>
        <h3 className="text-base font-bold dark:text-white mb-1.5">
          {emoji} {isZh ? titleZh : titleEn}
        </h3>
        <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed mb-3 flex-1">
          {isZh ? descZh : descEn}
        </p>

        {/* (Removed in v2.4.25 per user feedback: the "查看已配置的任务 →"
            link was redundant — users find their tasks under the "我的任务"
            section now. Card stays purely a template / launcher.) */}

        <CardActionRow
          loading={loading}
          onConfigure={onConfigure}
          onGoToMyTasks={onGoToMyTasks}
          isZh={isZh}
          label={`${emoji} ${isZh ? ctaZh : ctaEn} →`}
          btnClass={`${c.btn} shadow-lg ${c.shadow}`}
        />
      </div>
    </div>
  );
};
