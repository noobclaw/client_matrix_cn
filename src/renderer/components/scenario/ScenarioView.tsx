/**
 * ScenarioView — top-level replacement for QuickUseView.
 *
 * Owns the internal navigation state for the "一键使用" area:
 *   - Platform tab (xhs / x / douyin / tiktok / youtube)
 *   - Page within that platform (workflows list / workflow detail / task detail)
 *   - Modals (config wizard)
 *
 * Only xhs is functional in Phase 1. Everything else renders a placeholder.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import ComposeIcon from '../icons/ComposeIcon';
import WindowTitleBar from '../window/WindowTitleBar';
import { i18nService } from '../../services/i18n';
import { noobClawAuth } from '../../services/noobclawAuth';
import { scenarioService, type Scenario, type Task, type Draft } from '../../services/scenario';
import { DEFAULT_SCENARIOS } from '../../data/defaultScenarios';
import { XhsWorkflowsPage } from './XhsWorkflowsPage';
import { XWorkflowsPage } from './XWorkflowsPage';
import { TaskDetailPage } from './TaskDetailPage';
import { PlatformPlaceholder } from './PlatformPlaceholder';
import { ConfigWizard } from './ConfigWizard';
import { SensitiveCheckPage } from './SensitiveCheckPage';
import { MyTasksPage } from './MyTasksPage';
import { RunHistoryPage } from './RunHistoryPage';
import { RunRecordDetailPage } from './RunRecordDetailPage';
import { BinanceWorkflowsPage } from './BinanceWorkflowsPage';
import { YoutubeWorkflowsPage } from './YoutubeWorkflowsPage';
import { TikTokWorkflowsPage } from './TikTokWorkflowsPage';
import { DouyinWorkflowsPage } from './DouyinWorkflowsPage';
import { ShipinhaoWorkflowsPage } from './ShipinhaoWorkflowsPage';
import { ToutiaoWorkflowsPage } from './ToutiaoWorkflowsPage';
import { KuaishouWorkflowsPage } from './KuaishouWorkflowsPage';
import { BilibiliWorkflowsPage } from './BilibiliWorkflowsPage';
import { VideoWorkflowsPage } from './video/VideoWorkflowsPage';
import { WalletBadge } from '../common/WalletBadge';
import LuckyBag from '../cowork/LuckyBag';
import { ErrorBoundary } from '../ErrorBoundary';
import MatrixTaskWizard, { type WizardAccount } from '../matrix/MatrixTaskWizard';

type PlatformId = 'xhs' | 'x' | 'binance' | 'douyin' | 'shipinhao' | 'toutiao' | 'kuaishou' | 'bilibili' | 'tiktok' | 'youtube' | 'video';

// 矩阵号支持「互动涨粉」的平台(后端 backend/matrix/scenarios 有 <platform>_auto_engage)。
const MATRIX_ENGAGE_PLATFORMS = new Set<string>(['douyin', 'kuaishou', 'bilibili', 'xhs', 'x', 'binance', 'youtube', 'tiktok']);

// Top-level navigation:
//   create  — scenario cards (current XhsWorkflowsPage / XWorkflowsPage,
//             but with the bottom task list stripped out — those are now
//             over in `tasks`).
//   tasks   — unified "我的自动化运营任务" page across all platforms,
//             filtered by the active platform sub-tab.
//   history — unified "运行记录" page across all platforms, filtered by
//             the active platform sub-tab.
type SectionId = 'create' | 'tasks' | 'history';

type ViewState =
  | { kind: 'main'; section: SectionId; platform: PlatformId; filterTaskId?: string | null }
  | { kind: 'task_detail'; task_id: string; from?: SectionId }
  | { kind: 'record_detail'; record_id: string; from_platform: PlatformId; filterTaskId?: string | null }
  | { kind: 'sensitive_check' };

interface ScenarioViewProps {
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
  /** v4.31.44: 主页涨粉标签传入,初始选中对应 platform tab。undefined 时默认 video
   *  (多平台视频创作)—— 视频创作是当下主推入口,直接进 3 个菜单(新建/我的/运行记录)
   *  时落在它上面,比早期落在「币安广场」更贴当前产品方向。 */
  initialPlatform?: PlatformId;
  /** v1.x: 顶栏右上角"分享给好友"按钮点击 → 跳邀请返佣页 */
  onShowInvite?: () => void;
  /** v6.x: 左侧菜单拆分 —— 同一个 ScenarioView 现在被三个顶级菜单复用:
   *   'create'  = 「✨ 新建涨粉任务」新建页(只显示平台 tab + 新建内容,隐藏段标题)。
   *   'manage'  = 「📋 我的涨粉任务」(段标题 + 平台 tab + 任务列表)。
   *   'runs'    = 「📊 涨粉运行记录」(段标题 + 平台 tab + 运行记录列表)。
   *  三者是独立的顶级菜单实例(App 里 ErrorBoundary key={mainView} 切换时重挂载)。
   *  原 manage 内的「我的涨粉任务 / 运行记录」L1 段 tab 已拆成两个独立菜单,不再内切。 */
  mode?: 'create' | 'manage' | 'runs';
  /** manage 模式下任何「新建涨粉任务」入口 → 切到「一键涨粉」create 菜单(干净拆分,
   *  避免两个菜单内容重叠)。由 App 注入,内部切 mainView='scenarioCreate'。 */
  onSwitchToCreate?: (platform?: PlatformId) => void;
  /** v6.x: create 模式(「一键涨粉」新建页)右上角「查看已有的涨粉任务」按钮 →
   *  切到「我的涨粉任务」manage 菜单。由 App 注入,内部切 mainView='quickuse'。
   *  可带 platform:视频卡片「已有任务」传 'video',让管理页直接定位到视频 tab。 */
  onSwitchToManage?: (platform?: PlatformId) => void;
  /** 进入/退出【任务详情 / 运行记录详情】时上报。create / runs 菜单下钻到任务详情时,
   *  任务详情逻辑上属于「我的涨粉任务」→ App 据此把左侧菜单高亮切到「我的涨粉任务」,
   *  使侧栏高亮 + 顶栏标题不再停在「新建涨粉任务 / 涨粉运行记录」。 */
  onInDetailChange?: (inDetail: boolean) => void;
  /** 侧栏每次点同一/任一涨粉菜单时 App 递增此值 → 本组件退回列表(修:在运行记录/任务详情里点
   *  侧栏菜单,setMainView 同值是 no-op、退不出详情)。 */
  navNonce?: number;
  /** 矩阵号 edition:锁死抖音平台、隐藏平台 tab、标题改「矩阵涨粉」、新建/编辑走
   *  MatrixView(matrixTaskNew)。数据经 scenarioService 的 MATRIX 适配层接矩阵后端。 */
  matrixMode?: boolean;
}

const PLATFORM_TABS: Array<{ id: PlatformId; labelKey: string; icon: string; enabled: boolean }> = [
  // 第一行: 视频创作 + 海外/全球平台
  { id: 'video', labelKey: 'scenarioPlatformVideo', icon: '🎬', enabled: true },
  { id: 'binance', labelKey: 'scenarioPlatformBinance', icon: '🔶', enabled: true },
  { id: 'x', labelKey: 'scenarioPlatformX', icon: '🐦', enabled: true },
  { id: 'youtube', labelKey: 'scenarioPlatformYoutube', icon: '📺', enabled: true },
  { id: 'tiktok', labelKey: 'scenarioPlatformTiktok', icon: '🎵', enabled: true },
  // 国内平台:接在后面同一行排,放不下由容器(flex-wrap)自然换行,不再写死断行。
  { id: 'xhs', labelKey: 'scenarioPlatformXhs', icon: '📕', enabled: true },
  { id: 'douyin', labelKey: 'scenarioPlatformDouyin', icon: '🎶', enabled: true },
  { id: 'kuaishou', labelKey: 'scenarioPlatformKuaishou', icon: '⚡', enabled: true },
  { id: 'shipinhao', labelKey: 'scenarioPlatformShipinhao', icon: '📱', enabled: true },
  { id: 'bilibili', labelKey: 'scenarioPlatformBilibili', icon: '📺', enabled: true },
  { id: 'toutiao', labelKey: 'scenarioPlatformToutiao', icon: '📰', enabled: true },
];

// v6.x: 原 SECTION_TABS(我的涨粉任务 / 运行记录 两个 L1 段 tab)已移除 —
// 两段拆成两个独立左侧菜单(manage / runs),头部改为静态段标题,不再内切。

export const ScenarioView: React.FC<ScenarioViewProps> = ({
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  updateBadge,
  initialPlatform,
  onShowInvite,
  mode = 'manage',
  onSwitchToCreate,
  onSwitchToManage,
  onInDetailChange,
  navNonce,
  matrixMode,
}) => {
  const isMac = window.electron.platform === 'darwin';
  // v6.x: 菜单拆分后,本实例的「主页/落地段」由 mode 决定:
  //   create 模式落在 'create'(新建页);manage 模式落在 'tasks'(我的涨粉任务)。
  const baseSection: SectionId = mode === 'create' ? 'create' : mode === 'runs' ? 'history' : 'tasks';
  const [view, setView] = useState<ViewState>({ kind: 'main', section: baseSection, platform: initialPlatform || 'video' });

  // Seed scenarios from the bundled snapshot so the "立即开始" buttons in
  // every WorkflowsPage are clickable from first paint, not greyed out
  // while we wait on the network. listScenarios() result REPLACES this
  // once the API call comes back, so any backend-side scenario change
  // still reaches the user within the normal refresh cycle.
  const [scenarios, setScenarios] = useState<Scenario[]>(() => DEFAULT_SCENARIOS);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState<string | null>(null);
  // 视频是本地工具,任务/运行记录详情是 VideoWorkflowsPage 的内部状态(view 仍是
  // 'main'),进详情时由它上报,这里据此隐藏顶部 L1/L2 tab,对齐 scenario 详情页全屏。
  const [videoInDetail, setVideoInDetail] = useState(false);

  // 下钻到【任务详情 / 运行记录详情】时上报给 App —— 任务详情逻辑上属于「我的涨粉任务」,
  // 让 App 把左侧菜单高亮 + 顶栏标题切过去(create/runs 菜单下钻后不再停在原菜单)。
  // ⚠️ 视频本地任务(AI自动成片)的详情是 VideoWorkflowsPage 内部状态、view.kind 仍是 'main',
  //    必须把 videoInDetail 也算进来,否则点视频任务进详情时导航不切。
  const inDetailView = view.kind === 'task_detail' || view.kind === 'record_detail' || videoInDetail;
  useEffect(() => { onInDetailChange?.(inDetailView); }, [inDetailView, onInDetailChange]);
  useEffect(() => () => { onInDetailChange?.(false); }, [onInDetailChange]);
  // 侧栏点涨粉菜单(navNonce 递增)→ 退回本 mode 的列表页(不重挂、不重拉数据)。修:在运行记录详情里
  //   点「涨粉运行记录」,App setMainView 同值是 no-op,原来退不出详情、且高亮乱跳。mount 时无害(等于初值)。
  useEffect(() => {
    setView({ kind: 'main', section: baseSection, platform: initialPlatform || 'video' });
    setVideoInDetail(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navNonce]);

  // Wizard state (keyword/track tasks)
  const [wizardScenario, setWizardScenario] = useState<Scenario | null>(null);
  const [wizardEditingTask, setWizardEditingTask] = useState<Task | null>(null);
  // 矩阵号:互动涨粉向导(选账号 + 配额 + 频率;账号制,赛道/关键词/人设在账号上)。
  const [matrixWizardPlatform, setMatrixWizardPlatform] = useState<string | null>(null);
  const [matrixAccounts, setMatrixAccounts] = useState<WizardAccount[]>([]);
  const openMatrixWizard = async (platform: string) => {
    try {
      const r = await (window as any).electron?.matrix?.listAccounts?.();
      const accs: any[] = r?.ok && Array.isArray(r.accounts) ? r.accounts : [];
      setMatrixAccounts(accs.filter((a) => a.platform === platform).map((a) => ({ id: a.id, displayName: a.displayName, status: a.status, keywords: a.keywords, group: a.group })));
    } catch { setMatrixAccounts([]); }
    setMatrixWizardPlatform(platform);
  };
  const saveMatrixTask = async (input: { name: string; accountIds: string[]; concurrency: number; frequency: string; quota: any }) => {
    const m = (window as any).electron?.matrix;
    const r = await m?.saveTask?.({ platform: matrixWizardPlatform, type: 'engage', name: input.name, accountIds: input.accountIds, quota: input.quota, concurrency: input.concurrency, frequency: input.frequency, enabled: true });
    if (!r?.ok) throw new Error(({ platform_task_limit: '该平台任务已达 5 个上限', duplicate_type: '该平台已有同类型(互动)任务,直接编辑它即可' } as any)[r?.error] || r?.error || '保存失败');
    const plat = matrixWizardPlatform;
    setMatrixWizardPlatform(null);
    await refreshAll();
    onSwitchToManage?.(plat as any);
  };
  // Link-mode edit modal (separate from the keyword wizard — they capture
  // completely different inputs and users were confusing them)
  const [linkEditTask, setLinkEditTask] = useState<Task | null>(null);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    try {
      // Load tasks and drafts first (local, fast)
      const [t, d] = await Promise.all([
        scenarioService.listTasks().catch(() => []),
        scenarioService.listDrafts().catch(() => []),
      ]);
      setTasks(Array.isArray(t) ? t : []);
      setDrafts(Array.isArray(d) ? d : []);
      setLoading(false);

      // Load scenarios in background (network, slow) — don't block UI.
      // Only REPLACE the bundled DEFAULT_SCENARIOS snapshot when the API
      // returns a non-empty array. If the API call fails or returns []
      // (e.g. user is offline / backend down) we keep the bundled
      // snapshot so the UI stays usable.
      scenarioService.listScenarios().then(s => {
        if (Array.isArray(s) && s.length > 0) setScenarios(s);
      }).catch(() => {});
    } catch (err) {
      console.error('[ScenarioView] refreshAll failed:', err);
      setFatalError(String(err instanceof Error ? err.message : err));
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshAll();
    // Sidecar might not be ready on first mount — retry once after 2s
    const t1 = setTimeout(() => void refreshAll(), 2000);
    return () => { clearTimeout(t1); };
  }, [refreshAll]);

  // Live window title showing running tasks. Polls running task ids + each
  // task's current step every 3s. Shows e.g.:
  //   "推特任务-步骤2 · 小红书任务-步骤1 — NoobClaw"
  // when 2 tasks are running, or just "NoobClaw" when idle. The user can
  // glance at the OS window list / dock and see status without bringing
  // the app to foreground.
  useEffect(() => {
    let cancelled = false;
    const baseTitle = 'NoobClaw';
    const tick = async () => {
      try {
        const ids = await scenarioService.getRunningTaskIds();
        if (cancelled) return;
        if (ids.length === 0) {
          document.title = baseTitle;
          return;
        }
        const scenarioById = new Map(scenarios.map(s => [s.id, s]));
        const parts: string[] = [];
        for (const id of ids) {
          const t = tasks.find(t => t.id === id);
          if (!t) continue;
          const s = scenarioById.get(t.scenario_id);
          const platform = s?.platform === 'x' ? '推特'
            : s?.platform === 'xhs' ? '小红书'
            : s?.platform === 'binance' ? '币安广场'
            : s?.platform === 'tiktok' ? 'TikTok'
            : s?.platform === 'youtube' ? 'YouTube'
            : s?.platform === 'douyin' ? '抖音'
            : s?.platform === 'shipinhao' ? '视频号'
            : s?.platform === 'toutiao' ? '头条号'
            : (s?.platform || '');
          // Get this task's progress to know which step it's in
          const prog = await scenarioService.getRunProgress(id).catch(() => null);
          if (prog && prog.status === 'running' && prog.currentStep > 0) {
            parts.push(`${platform}任务-步骤${prog.currentStep}`);
          } else if (prog && prog.status === 'done') {
            parts.push(`${platform}任务-已结束`);
          } else if (prog && prog.status === 'error') {
            parts.push(`${platform}任务-异常`);
          } else {
            parts.push(`${platform}任务-启动中`);
          }
        }
        document.title = parts.length > 0 ? `${parts.join(' · ')} — ${baseTitle}` : baseTitle;
      } catch {
        if (!cancelled) document.title = baseTitle;
      }
    };
    void tick();
    const h = setInterval(tick, 3000);
    return () => { cancelled = true; clearInterval(h); document.title = baseTitle; };
  }, [tasks, scenarios]);

  // Derive the platform tab to highlight + return to:
  //   - workflows view  → use view.platform directly
  //   - task_detail     → look up task → its scenario → scenario.platform
  //                       (so Twitter tasks keep the 🐦 tab active)
  //   - sensitive_check → XHS-only feature, fall back to 'xhs'
  const currentPlatform: PlatformId = (() => {
    if (view.kind === 'main') return view.platform;
    if (view.kind === 'task_detail') {
      const t = tasks.find(t => t.id === view.task_id);
      const s = t ? scenarios.find(s => s.id === t.scenario_id) : null;
      const p = s?.platform;
      // v2.4.61: 漏了 'binance' — 进币安任务详情然后返回会跳回小红书 tab
      // v6.x:  漏了 'video' — 翻译二创(scenario.platform='video')详情返回也会掉小红书 tab
      if (p === 'xhs' || p === 'x' || p === 'binance' || p === 'douyin' || p === 'shipinhao' || p === 'toutiao' || p === 'kuaishou' || p === 'bilibili' || p === 'tiktok' || p === 'youtube' || p === 'video') return p;
      return 'xhs';
    }
    return 'xhs';
  })();

  // The currently-active top-level section (create / tasks / history). Used
  // to highlight the right L1 tab AND to remember which section to go back
  // to after viewing a task detail.
  const currentSection: SectionId = (() => {
    if (view.kind === 'main') return view.section;
    if (view.kind === 'task_detail') return view.from || 'tasks';
    return 'create';
  })();

  const setSection = (section: SectionId) => {
    // Clear any task filter when manually switching sections via the L1 tabs.
    setView({ kind: 'main', section, platform: currentPlatform });
  };

  const setPlatform = (platform: PlatformId) => {
    // 平台间互切一律沿用当前 section(tasks/history/create):
    //   - 创建态点别的平台 tab → 停在该平台的创建页(跟用户在"新建涨粉任务"里切 tab 的预期一致);
    //   - 任务页 / 运行记录页 切 tab → 看该平台对应的同一 section。
    // 视频创作以前被特判过(强制掉到 'tasks'),但 VideoWorkflowsPage 已经完整支持
    //   三种 section(含 history → VideoRunHistory),不需要再特判。
    setView({ kind: 'main', section: currentSection, platform });
  };

  // 进入视频创建流。跟其他平台「新建」一致先过积分门槛(余额 < 10000 弹"积分
  // 不足"提示框,点充值跳钱包页),通过才真正切到 create。两个入口(落地页占位框 /
  // 右上 CTA)都走这里,保证门槛一致。
  const goVideoCreate = () => {
    // manage 模式不自带新建页 —— 切到「一键涨粉」create 菜单(视频 tab)。
    if (mode !== 'create') { onSwitchToCreate?.('video'); return; }
    if (!noobClawAuth.hasEnoughBalanceForTask()) return;
    setView({ kind: 'main', section: 'create', platform: 'video' });
  };

  /** 进入某平台的新建流。create 模式留在本实例切 create 段;manage 模式切到
   *  「一键涨粉」create 菜单(干净拆分)。两条路都先过积分门槛。 */
  const goCreatePlatform = (platform: PlatformId) => {
    if (!noobClawAuth.hasEnoughBalanceForTask()) return;
    if (mode === 'create') { setView({ kind: 'main', section: 'create', platform }); return; }
    onSwitchToCreate?.(platform);
  };

  const openTask = (task_id: string, fromOverride?: SectionId) => {
    // `fromOverride` lets callers (e.g. link-mode quick-create flows in
    // XhsWorkflowsPage / XWorkflowsPage) say "treat this as if user came
    // from My Tasks" so the back button doesn't dump them back into the
    // creation form they just submitted. Defaults to currentSection.
    setView({ kind: 'task_detail', task_id, from: fromOverride || currentSection });
  };

  /** Jump from a task's detail page to Run History filtered by that task. */
  const openHistoryForTask = (task_id: string) => {
    // Resolve platform from the task so the right L2 sub-tab is active.
    const t = tasks.find(t => t.id === task_id);
    const s = t ? scenarios.find(s => s.id === t.scenario_id) : null;
    const p = (s?.platform === 'x' || s?.platform === 'xhs' || s?.platform === 'binance') ? s.platform : currentPlatform;
    setView({ kind: 'main', section: 'history', platform: p, filterTaskId: task_id });
  };

  const openSensitiveCheck = () => {
    setView({ kind: 'sensitive_check' });
  };

  // Go back to the section the user was on before opening a detail page.
  // task_detail remembers via `view.from`; record_detail returns to the
  // history section it came from (optionally still filtered); sensitive_check
  // just goes home.
  const goBack = () => {
    if (view.kind === 'task_detail' && view.from) {
      setView({ kind: 'main', section: view.from, platform: currentPlatform });
    } else if (view.kind === 'record_detail') {
      setView({ kind: 'main', section: 'history', platform: view.from_platform, filterTaskId: view.filterTaskId });
    } else {
      setView({ kind: 'main', section: baseSection, platform: currentPlatform });
    }
  };

  /** Open a run record's read-only detail page. Remembers where we came
   *  from so the back button takes the user back to the right filtered
   *  history view. */
  const openRecord = (record_id: string) => {
    const currentFilter = view.kind === 'main' ? view.filterTaskId || null : null;
    setView({ kind: 'record_detail', record_id, from_platform: currentPlatform, filterTaskId: currentFilter });
  };

  const openWizardFor = (scenario: Scenario) => {
    setWizardScenario(scenario);
    setWizardEditingTask(null);
  };

  const openWizardEdit = (task: Task, scenario: Scenario) => {
    // Link-mode tasks have a completely different input shape (URLs vs
    // keywords) — open the dedicated link editor instead of the keyword
    // wizard so users aren't asked to pick a track for links they already
    // supplied.
    const isLinkMode = task.track === 'link_mode'
      || (Array.isArray((task as any).urls) && (task as any).urls.length > 0);
    if (isLinkMode) {
      setLinkEditTask(task);
      return;
    }
    setWizardScenario(scenario);
    setWizardEditingTask(task);
  };

  const closeWizard = () => {
    setWizardScenario(null);
    setWizardEditingTask(null);
  };

  const closeLinkEdit = () => setLinkEditTask(null);

  const handleWizardSave = async (input: {
    scenario_id: string;
    track: string;
    keywords: string[];
    persona: string;
    daily_count: number;
    variants_per_post: number;
    daily_time: string;
    /** Twitter v1: extra optional fields. Spread through unchanged. */
    language?: 'zh' | 'en' | 'mixed';
    user_context?: string;
    urls?: string[];
    /** douyin_image_text: 3 段灵感来源,跟 keywords 互斥 */
    source_segments?: string[];
    /** douyin_image_text / xhs viral_production: 自动上传草稿 vs 仅生成 */
    auto_upload?: boolean;
    /** douyin_image_text: true=直接发布,false=存草稿(仅 auto_upload=true 时生效) */
    auto_publish?: boolean;
  }) => {
    let landingTaskId: string | null = null;
    let createdLinkRewrite = false;
    if (wizardEditingTask) {
      // Edit → always activate as scheduled task
      await scenarioService.updateTask(wizardEditingTask.id, { ...input, active: true, enabled: true });
      landingTaskId = wizardEditingTask.id;
    } else {
      // Create → land on the new task's detail page (v2.4.30+) so the
      // user immediately sees the task they just configured instead of
      // staring at the empty Create page wondering "did it work?".
      // createTask returns the persisted Task with its assigned id.
      const created = await scenarioService.createTask({ ...input, enabled: true, active: true });
      landingTaskId = created?.id || null;
      // v4.28.x: 链接仿写场景(x_link_rewrite / binance_from_x_link)创建后立刻 runTaskNow,
      // 跟 X / XHS workflows 页面里的"快速 link 模式"行为对齐 —— 用户粘了 URL 列表
      // 就是想立刻看结果,不应该等下一次 scheduler tick 或者手动点"立即运行"。
      // 普通调度型场景(post_creator / repost / auto_engage)保持原行为(等 scheduler)。
      if (created?.id && (input.scenario_id === 'x_link_rewrite' || input.scenario_id === 'binance_from_x_link')) {
        createdLinkRewrite = true;
      }
    }
    closeWizard();
    // Refresh BEFORE navigating so TaskDetailPage can find the new task
    // in the freshly-loaded tasks[] (otherwise it would render the
    // "task deleted" empty state for a split second).
    await refreshAll();
    if (landingTaskId) {
      setView({ kind: 'task_detail', task_id: landingTaskId, from: baseSection });
      if (createdLinkRewrite) {
        // 异步触发,不阻塞跳转
        scenarioService.runTaskNow(landingTaskId).catch(e => {
          console.error('[ScenarioView] link-rewrite auto-run failed:', e);
        });
      }
    }
  };

  const tasksForPlatform = useMemo(() => {
    if (!Array.isArray(tasks) || !Array.isArray(scenarios)) return [];
    const byId = new Map(scenarios.map(s => [s.id, s]));
    return tasks.filter(t => byId.get(t.scenario_id)?.platform === currentPlatform);
  }, [tasks, scenarios, currentPlatform]);

  const draftsByTask = useMemo(() => {
    const map = new Map<string, Draft[]>();
    if (!Array.isArray(drafts)) return map;
    for (const d of drafts) {
      const arr = map.get(d.task_id) || [];
      arr.push(d);
      map.set(d.task_id, arr);
    }
    return map;
  }, [drafts]);

  // ── Render ──

  const platformTabContent = (() => {
    if (view.kind === 'sensitive_check') {
      return <SensitiveCheckPage onBack={goBack} />;
    }
    if (view.kind === 'record_detail') {
      return (
        <RunRecordDetailPage
          recordId={view.record_id}
          onBack={goBack}
          onOpenTask={openTask}
        />
      );
    }
    if (view.kind === 'task_detail') {
      const task = tasks.find(t => t.id === view.task_id);
      if (!task) {
        // Empty state for "task was deleted" — common path now that the
        // History page deep-links by task id (the underlying task may
        // have been deleted since the run finished). Pre-2.4.27 we just
        // showed "暂无任务。从下面选一个场景开始。" which had no buttons,
        // so the user was stuck and had to click L1 nav manually. Now
        // we offer one-click jumps to the create page for either platform.
        const isZh = i18nService.currentLanguage === 'zh';
        // 余额门槛 + create/manage 分流统一走 goCreatePlatform。
        const goCreate = (platform: PlatformId) => goCreatePlatform(platform);
        return (
          <div className="p-10 max-w-xl mx-auto">
            <div className="rounded-2xl border border-dashed border-gray-300 dark:border-gray-700 p-10 text-center">
              <div className="text-5xl mb-3">🗑️</div>
              <div className="text-base font-medium text-gray-700 dark:text-gray-200 mb-1">
                {isZh ? '该任务已被删除' : 'This task has been deleted'}
              </div>
              <div className="text-sm text-gray-500 dark:text-gray-400 mb-6">
                {isZh
                  ? '从下面选一个场景新建任务开始'
                  : 'Pick a platform below to create a new task'}
              </div>
              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                <button
                  type="button"
                  onClick={() => goCreate('xhs')}
                  className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-green-500 text-white text-sm font-semibold hover:bg-green-600 shadow-sm shadow-green-500/25 transition-all active:scale-95"
                >
                  📕 {isZh ? '新建小红书任务' : 'New Xiaohongshu task'}
                </button>
                <button
                  type="button"
                  onClick={() => goCreate('x')}
                  className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-sky-500 text-white text-sm font-semibold hover:bg-sky-600 shadow-sm shadow-sky-500/25 transition-all active:scale-95"
                >
                  🐦 {isZh ? '新建推特任务' : 'New Twitter task'}
                </button>
              </div>
              <button
                type="button"
                onClick={goBack}
                className="mt-5 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
              >
                ← {isZh ? '返回上一页' : 'Back'}
              </button>
            </div>
          </div>
        );
      }
      const scenario = scenarios.find(s => s.id === task.scenario_id);
      return (
        <TaskDetailPage
          task={task}
          scenario={scenario || null}
          onBack={goBack}
          /* 矩阵号:编辑走 MatrixView 新建/编辑页(账号多选向导),不开原版 ConfigWizard */
          onEdit={() => { if (matrixMode) { onSwitchToCreate?.(undefined); return; } if (scenario) openWizardEdit(task, scenario); }}
          onChanged={refreshAll}
          onOpenHistory={() => openHistoryForTask(task.id)}
        />
      );
    }

    // 多平台视频创作 —— 本地合成工具,不走 scenario 任务体系,但交互跟其他 tab
    // 对齐:section='create' 走创建向导,否则(tasks)走落地页(占位框 + 卡片)。
    // 返回 / 新建由 ScenarioView 顶部头部统一处理(见下方 header 区块)。
    if (currentPlatform === 'video') {
      return (
        <VideoWorkflowsPage
          section={currentSection === 'create' ? 'create' : currentSection === 'history' ? 'history' : 'tasks'}
          onGoCreate={goVideoCreate}
          onBack={() => setView({ kind: 'main', section: 'tasks', platform: 'video' })}
          /* create 模式(「新建涨粉任务」菜单)点「已有任务」→ 跳「我的涨粉任务」管理页并定位
             视频 tab(切顶层 mainView,侧栏高亮 + 标题都对);manage/runs 模式不传 → 回退用 onBack
             内部切到 tasks。 */
          onGoTasks={mode === 'create' && onSwitchToManage ? () => onSwitchToManage('video') : undefined}
          onDetailChange={setVideoInDetail}
          onRefresh={refreshAll}
        />
      );
    }

    // Section + platform branching. Each L1 section has a per-platform
    // view; the user picked the platform via the L2 sub-tabs above.
    // Platform display label — locale-aware so the My Tasks / History
    // page headers don't show Chinese names in EN mode.
    const isZh = i18nService.currentLanguage === 'zh';
    const platformLabel = currentPlatform === 'xhs' ? (isZh ? '小红书' : 'Xiaohongshu')
      : currentPlatform === 'x' ? (isZh ? '推特' : 'Twitter')
      : currentPlatform === 'binance' ? (isZh ? '币安广场' : 'Binance Square')
      : currentPlatform === 'tiktok' ? 'TikTok'
      : currentPlatform === 'youtube' ? 'YouTube'
      : currentPlatform === 'douyin' ? (isZh ? '抖音' : 'Douyin')
      : currentPlatform === 'shipinhao' ? (isZh ? '视频号' : 'WeChat Channels')
      : currentPlatform === 'toutiao' ? (isZh ? '头条号' : 'Toutiao')
      : currentPlatform === 'kuaishou' ? (isZh ? '快手' : 'Kuaishou')
      : currentPlatform === 'bilibili' ? (isZh ? '哔哩哔哩' : 'Bilibili')
      : currentPlatform;

    if (currentSection === 'tasks') {
      return (
        <MyTasksPage
          tasks={tasksForPlatform}
          scenarios={scenarios}
          loading={loading}
          platformLabel={platformLabel}
          platformId={currentPlatform === 'x' ? 'x' : currentPlatform === 'binance' ? 'binance' : 'xhs'}
          onOpenTask={openTask}
          onRefresh={refreshAll}
          onGoCreate={() => goCreatePlatform(currentPlatform)}
        />
      );
    }

    if (currentSection === 'history') {
      const filterTaskId = view.kind === 'main' ? view.filterTaskId || null : null;
      return (
        <RunHistoryPage
          tasks={tasksForPlatform}
          scenarios={scenarios}
          platformId={currentPlatform}
          platformLabel={platformLabel}
          onOpenRecord={openRecord}
          filterByTaskId={filterTaskId}
          onClearFilter={() => setView({ kind: 'main', section: 'history', platform: currentPlatform })}
        />
      );
    }

    // currentSection === 'create' — show the platform's scenario cards
    // 矩阵号:每个平台只有「互动涨粉」一个卡片(账号制),点开 MatrixTaskWizard。
    if (matrixMode) {
      const platLabel = platformLabel;
      return (
        <div className="p-6 max-w-3xl mx-auto">
          <div className="rounded-2xl border border-violet-500/30 bg-violet-500/5 dark:bg-violet-500/10 p-6">
            <div className="flex items-center gap-2 text-xs font-semibold text-violet-600 dark:text-violet-400 mb-2">
              <span className="w-1.5 h-1.5 rounded-full bg-violet-500" /> 矩阵互动 · 多账号涨粉
            </div>
            <div className="text-xl font-bold dark:text-white mb-1">🎯 {platLabel} · 互动涨粉</div>
            <div className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed mb-4">
              勾选多个已登录账号,每个账号在各自指纹浏览器里按<strong>自己的赛道关键词</strong>搜索,自动点赞 / 关注 / 评论。
              赛道 / 关键词 / 人设在「我的矩阵号」里给每个号设;选几个号就同时开几个窗。
            </div>
            <button
              type="button"
              onClick={() => openMatrixWizard(currentPlatform)}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-violet-500 text-white text-sm font-bold hover:bg-violet-600 shadow-sm shadow-violet-500/25 transition-all active:scale-95"
            >
              🎯 开始创作 →
            </button>
            <button
              type="button"
              onClick={() => onSwitchToManage?.(currentPlatform as any)}
              className="ml-3 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
            >
              已有任务 »
            </button>
          </div>
        </div>
      );
    }
    if (currentPlatform === 'xhs') {
      return (
        <XhsWorkflowsPage
          scenarios={scenarios.filter(s => s.platform === 'xhs')}
          tasks={tasksForPlatform}
          draftsByTask={draftsByTask}
          loading={loading}
          onOpenTask={openTask}
          onConfigure={openWizardFor}
          onChanged={refreshAll}
          onOpenSensitiveCheck={openSensitiveCheck}
          onGoToMyTasks={() => setView({ kind: 'main', section: 'tasks', platform: 'xhs' })}
        />
      );
    }

    if (currentPlatform === 'x') {
      return (
        <XWorkflowsPage
          scenarios={scenarios.filter(s => s.platform === 'x')}
          tasks={tasksForPlatform}
          draftsByTask={draftsByTask}
          loading={loading}
          onOpenTask={openTask}
          onConfigure={openWizardFor}
          onChanged={refreshAll}
          onGoToMyTasks={() => setView({ kind: 'main', section: 'tasks', platform: 'x' })}
        />
      );
    }

    if (currentPlatform === 'binance') {
      return (
        <BinanceWorkflowsPage
          scenarios={scenarios.filter(s => (s.platform as any) === 'binance')}
          tasks={tasksForPlatform}
          draftsByTask={draftsByTask}
          loading={loading}
          onOpenTask={openTask}
          onConfigure={openWizardFor}
          onChanged={refreshAll}
          onGoToMyTasks={() => setView({ kind: 'main', section: 'tasks', platform: 'binance' })}
        />
      );
    }

    if (currentPlatform === 'youtube') {
      return (
        <YoutubeWorkflowsPage
          scenarios={scenarios.filter(s => (s.platform as any) === 'youtube')}
          tasks={tasksForPlatform}
          draftsByTask={draftsByTask}
          loading={loading}
          onOpenTask={openTask}
          onConfigure={openWizardFor}
          onChanged={refreshAll}
          onGoToMyTasks={() => setView({ kind: 'main', section: 'tasks', platform: 'youtube' })}
        />
      );
    }

    if (currentPlatform === 'tiktok') {
      return (
        <TikTokWorkflowsPage
          scenarios={scenarios.filter(s => (s.platform as any) === 'tiktok')}
          tasks={tasksForPlatform}
          draftsByTask={draftsByTask}
          loading={loading}
          onOpenTask={openTask}
          onConfigure={openWizardFor}
          onChanged={refreshAll}
          onGoToMyTasks={() => setView({ kind: 'main', section: 'tasks', platform: 'tiktok' })}
        />
      );
    }

    if (currentPlatform === 'douyin') {
      return (
        <DouyinWorkflowsPage
          scenarios={scenarios.filter(s => (s.platform as any) === 'douyin')}
          tasks={tasksForPlatform}
          draftsByTask={draftsByTask}
          loading={loading}
          onOpenTask={openTask}
          onConfigure={openWizardFor}
          onChanged={refreshAll}
          onGoToMyTasks={() => setView({ kind: 'main', section: 'tasks', platform: 'douyin' })}
        />
      );
    }

    if (currentPlatform === 'shipinhao') {
      return (
        <ShipinhaoWorkflowsPage
          scenarios={scenarios.filter(s => (s.platform as any) === 'shipinhao')}
          tasks={tasksForPlatform}
          draftsByTask={draftsByTask}
          loading={loading}
          onOpenTask={openTask}
          onConfigure={openWizardFor}
          onChanged={refreshAll}
          onGoToMyTasks={() => setView({ kind: 'main', section: 'tasks', platform: 'shipinhao' })}
        />
      );
    }

    if (currentPlatform === 'toutiao') {
      return (
        <ToutiaoWorkflowsPage
          scenarios={scenarios.filter(s => (s.platform as any) === 'toutiao')}
          tasks={tasksForPlatform}
          draftsByTask={draftsByTask}
          loading={loading}
          onOpenTask={openTask}
          onConfigure={openWizardFor}
          onChanged={refreshAll}
          onGoToMyTasks={() => setView({ kind: 'main', section: 'tasks', platform: 'toutiao' })}
        />
      );
    }

    if (currentPlatform === 'kuaishou') {
      return (
        <KuaishouWorkflowsPage
          scenarios={scenarios.filter(s => (s.platform as any) === 'kuaishou')}
          tasks={tasksForPlatform}
          draftsByTask={draftsByTask}
          loading={loading}
          onOpenTask={openTask}
          onConfigure={openWizardFor}
          onChanged={refreshAll}
          onGoToMyTasks={() => setView({ kind: 'main', section: 'tasks', platform: 'kuaishou' })}
        />
      );
    }

    if (currentPlatform === 'bilibili') {
      return (
        <BilibiliWorkflowsPage
          scenarios={scenarios.filter(s => (s.platform as any) === 'bilibili')}
          tasks={tasksForPlatform}
          draftsByTask={draftsByTask}
          loading={loading}
          onOpenTask={openTask}
          onConfigure={openWizardFor}
          onChanged={refreshAll}
          onGoToMyTasks={() => setView({ kind: 'main', section: 'tasks', platform: 'bilibili' })}
        />
      );
    }

    // No remaining platforms — keep placeholder for future expansion.
    return <PlatformPlaceholder platform={currentPlatform} />;
  })();

  return (
    <div className="flex flex-col h-full dark:bg-claude-darkBg bg-claude-bg">
      {/* NoobCoin 福袋红包空投 — self-positioned overlay,监听 backend SSE 触发。
          逻辑跟 chat 对话框那个一致(同 LuckyBag 组件)。 */}
      <ErrorBoundary name="LuckyBag">
        <LuckyBag />
      </ErrorBoundary>
      {/* Header */}
      <div className="draggable flex h-12 items-center justify-between px-4 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
        <div className="flex items-center space-x-3 h-8">
          {isSidebarCollapsed && (
            <div className={`non-draggable flex items-center gap-1 ${isMac ? 'pl-[68px]' : ''}`}>
              <button
                type="button"
                onClick={onToggleSidebar}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <SidebarToggleIcon className="h-4 w-4" isCollapsed={true} />
              </button>
              <button
                type="button"
                onClick={onNewChat}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <ComposeIcon className="h-4 w-4" />
              </button>
              {updateBadge}
            </div>
          )}
          <h1 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
            {/* 下钻到任务/运行记录详情时,标题归到「我的涨粉任务」(详情逻辑上属于该菜单),
                不再停在「新建涨粉任务 / 涨粉运行记录」。 */}
            {matrixMode
              ? (inDetailView
                  ? '🧬 我的矩阵涨粉任务'
                  : mode === 'runs'
                    ? '🧬 矩阵涨粉运行记录'
                    : '🧬 我的矩阵涨粉任务')
              : inDetailView
                ? i18nService.t('myFanTasks')
                : mode === 'create'
                  ? i18nService.t('quickUse')
                  : mode === 'runs'
                    ? (i18nService.currentLanguage === 'zh' ? '涨粉运行记录' : 'Run History')
                    : i18nService.t('myFanTasks')}
          </h1>
          {/* v1.x: 钱包余额 + 充值入口紧跟标题,跟 CoworkView 顶栏一致 */}
          <div className="non-draggable">
            <WalletBadge />
          </div>
        </div>
        {/* v1.x: 顶栏右上角"分享给好友"入口 — 一键使用页是用户日常驻留点之一,
            把邀请入口顶到这儿让"邀请赚 BUSDT"在用户视线里。点击跳邀请返佣页。
            包裹 div 不加 non-draggable(否则 macOS 拖窗口热区丢失),仅 button
            本身 non-draggable 让点击事件不被 -webkit-app-region:drag 吃掉。 */}
        <div className="flex items-center gap-2 h-8">
          {onShowInvite && (
            <button
              type="button"
              onClick={onShowInvite}
              className="non-draggable inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap bg-green-500/10 text-green-500 border border-green-500/40 hover:bg-green-500/20 hover:border-green-500/60 active:scale-95"
              title={i18nService.currentLanguage === 'zh' ? '分享邀请链接给好友,赚 BUSDT 返佣' : 'Share your invite link and earn BUSDT rebate'}
              aria-label={i18nService.currentLanguage === 'zh' ? '分享给好友' : 'Share to friends'}
            >
              <span aria-hidden>🎁</span>
              <span>{i18nService.currentLanguage === 'zh' ? '分享给好友' : 'Share to friends'}</span>
            </button>
          )}
          <WindowTitleBar inline />
        </div>
      </div>

      {/* L1 — section tabs (Create / My Tasks / History). Hidden when in
          a sub-page (task_detail / sensitive_check) so the user gets a
          full-bleed page without competing nav.
          Matches the L2 platform-tabs treatment: every tab is a visible
          card with a frame even when inactive, and the active one shifts
          to a green tint + green border + slight glow. Inactive tabs were
          previously borderless which made them look unclickable. */}
      {/* Two header modes:
          - "list" mode (section = tasks / history): L1 tabs on the left
            + "+ 新建涨粉任务" CTA on the right
          - "create" mode (section = create): a "← 返回" button replaces
            the L1 tabs; CTA hides because we're already inside Create.
            This makes Create feel like a pushed sub-page rather than
            another tab equal to the others — matches user expectation
            of "task vs view" actions. */}
      {view.kind === 'main' && currentSection !== 'create' && !(currentPlatform === 'video' && videoInDetail) && (() => {
        const isVideo = currentPlatform === 'video';
        const isZh = i18nService.currentLanguage === 'zh';
        const isHistory = currentSection === 'history';
        // v6.x: 原「我的涨粉任务 / 运行记录」两个 L1 段 tab 已拆成两个独立左侧菜单,
        // 这里改成只展示【当前菜单】的段标题(样式对齐「✨ 新建涨粉任务」头部)。
        //   manage 菜单 → 📋 我的涨粉任务(视频实例叫「我的视频任务」)
        //   runs   菜单 → 📊 涨粉运行记录
        // 仅当从【我的涨粉任务】里某任务详情下钻到该任务的运行记录(manage 内部
        // section 临时切到 history)时,补一个「← 返回」回到任务列表,避免没了 L1
        // tab 之后无路可退。
        const sectionTitle = isHistory
          ? (isZh ? '📊 涨粉运行记录' : '📊 Run History')
          : isVideo ? (isZh ? '🎬 我的视频任务' : '🎬 My Videos')
                    : (isZh ? '📋 我的涨粉任务' : '📋 My Tasks');
        return (
        <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-2 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {mode === 'manage' && isHistory && (
              <button
                type="button"
                onClick={() => setSection('tasks')}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold text-gray-700 dark:text-gray-200 bg-gray-100 dark:bg-gray-800/60 hover:bg-gray-200 dark:hover:bg-gray-700/80 border border-gray-400 dark:border-gray-500 transition-colors whitespace-nowrap"
                title={isZh ? '返回我的涨粉任务' : 'Back to My Tasks'}
              >
                <span>←</span>
                <span>{isZh ? '返回' : 'Back'}</span>
              </button>
            )}
            <h2 className="text-base font-bold dark:text-white text-gray-900 whitespace-nowrap">
              {sectionTitle}
            </h2>
          </div>
          {/* Right-aligned CTA — 只在「我的涨粉任务」(tasks)展示;运行记录页无需新建入口。
              Always clickable; per-platform task-cap (>= 5) check happens inside the
              create page's scenario cards. Video tab is local-only (rose tint). */}
          {currentSection === 'tasks' && (
          <button
            type="button"
            onClick={() => {
              if (isVideo) { goVideoCreate(); return; }
              goCreatePlatform(currentPlatform);
            }}
            className={`shrink-0 inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold transition-all whitespace-nowrap active:scale-95 text-white ${
              isVideo
                ? 'shadow-md shadow-rose-500/30 bg-rose-500 hover:bg-rose-600 border border-rose-500'
                : 'shadow-md shadow-green-500/30 bg-green-500 hover:bg-green-600 border border-green-500'
            }`}
          >
            <span>✨</span>
            <span>{isZh
              ? (isVideo ? '新建视频创作任务' : '新建涨粉任务')
              : (isVideo ? 'New Video Task' : 'New Task')}</span>
          </button>
          )}
        </div>
        );
      })()}

      {/* Create-mode header. v6.x: 'create' 模式是顶级菜单(「一键涨粉」),没有
          上一页可回 —— 隐藏返回按钮,只留段标题。仅 manage 模式(已不会进 create
          段)才保留返回按钮,但实际上 manage 不再渲染本块。 */}
      {view.kind === 'main' && currentSection === 'create' && (
        <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-2 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {mode !== 'create' && (
            <button
              type="button"
              onClick={() => setSection('tasks')}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold text-gray-700 dark:text-gray-200 bg-gray-100 dark:bg-gray-800/60 hover:bg-gray-200 dark:hover:bg-gray-700/80 border border-gray-400 dark:border-gray-500 transition-colors whitespace-nowrap"
              title={i18nService.currentLanguage === 'zh'
                ? (currentPlatform === 'video' ? '返回视频创作' : '返回我的涨粉任务')
                : 'Back'}
            >
              <span>←</span>
              <span>{i18nService.currentLanguage === 'zh' ? '返回' : 'Back'}</span>
            </button>
            )}
            <h2 className="text-base font-bold dark:text-white text-gray-900 ml-2 whitespace-nowrap">
              ✨ {i18nService.currentLanguage === 'zh'
                ? (currentPlatform === 'video' ? '新建视频创作任务' : '新建涨粉任务')
                : (currentPlatform === 'video' ? 'New Video Task' : 'New Task')}
            </h2>
          </div>
          {/* v6.x: 「涨粉教程」入口 → 外部浏览器打开文档站。样式与「我的涨粉任务」
              页一致(琥珀渐变胶囊按钮),靠 justify-between 顶到头部右侧。 */}
          {mode === 'create' && (() => {
            // tab=「多平台视频创作」(currentPlatform==='video')→ 文字「视频教程」+ 视频文档链接(中文/英文分开);
            //   其它 tab 保持原样:「涨粉教程」+ 文档首页(用户要求)。
            const isVideoTab = currentPlatform === 'video';
            const isZhDoc = i18nService.currentLanguage === 'zh';
            const tutorialUrl = isVideoTab
              ? (isZhDoc ? 'https://docs.noobclaw.com/zhong-wen-ban/kua-ping-tai-shi-pin-chuang-zuo' : 'https://docs.noobclaw.com/english/video-creation')
              : 'https://docs.noobclaw.com';
            const tutorialLabel = isVideoTab
              ? (isZhDoc ? '视频教程' : 'Video Tutorial')
              : (isZhDoc ? '涨粉教程' : 'Growth Tutorial');
            return (
            <button
              type="button"
              onClick={() => { try { window.electron?.shell?.openExternal(tutorialUrl); } catch { /* sandbox/无 xdg-open 时静默 */ } }}
              className="group relative shrink-0 inline-flex items-center gap-1.5 text-xs font-medium
                         px-3.5 py-1.5 rounded-full
                         bg-gradient-to-r from-amber-500/15 via-orange-500/15 to-rose-500/15
                         hover:from-amber-500/25 hover:via-orange-500/25 hover:to-rose-500/25
                         text-amber-700 dark:text-amber-300
                         border border-amber-500/30 hover:border-amber-500/60
                         shadow-sm hover:shadow-md hover:shadow-amber-500/20
                         transition-all duration-200 hover:-translate-y-0.5"
              title={tutorialLabel}
            >
              <span className="text-sm leading-none">📖</span>
              <span>{tutorialLabel}</span>
              <span className="opacity-60 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all duration-200">→</span>
            </button>
            );
          })()}
        </div>
      )}

      {/* L2 — platform sub-tabs (XHS / Twitter / YouTube / TikTok / Douyin /
          Binance). Inactive border was bumped from gray-300/gray-600 to
          gray-400/gray-500 because the prior tone was nearly invisible
          against the page background — user couldn't tell at a glance which
          buttons were tappable vs decorative. Now every tab carries a
          visible frame; the active one differentiates only by green tint
          + green border + slight glow shadow, matching the L1 section tabs'
          active treatment. */}
      {view.kind === 'main' && !(currentPlatform === 'video' && videoInDetail) && (
        <div className="flex flex-wrap items-center gap-2 px-4 pt-3 pb-2 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
          {/* 矩阵号:只显示支持「互动涨粉」的平台(其余无 engage 剧本)。 */}
          {(matrixMode ? PLATFORM_TABS.filter(t => MATRIX_ENGAGE_PLATFORMS.has(t.id)) : PLATFORM_TABS).map((tab) => {
            const active = currentPlatform === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setPlatform(tab.id)}
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-green-500/15 text-green-500 border border-green-500/50 shadow-sm shadow-green-500/20'
                    : 'text-gray-700 dark:text-gray-200 bg-gray-100 dark:bg-gray-800/60 hover:bg-gray-200 dark:hover:bg-gray-700/80 border border-gray-400 dark:border-gray-500'
                }`}
              >
                <span className="text-base">{tab.icon}</span>
                <span>{i18nService.t(tab.labelKey)}</span>
                {!tab.enabled && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-500">
                    {i18nService.t('scenarioPlatformSoon')}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Main content */}
      {/* Main content — guarded with a fallback so a render crash doesn't black-screen the app */}
      <div className="flex-1 overflow-y-auto">
        {fatalError ? (
          <div className="p-8 text-center">
            <div className="text-4xl mb-4">⚠️</div>
            <div className="text-sm text-red-500 mb-4">{fatalError}</div>
            <button
              type="button"
              onClick={() => { setFatalError(null); void refreshAll(); }}
              className="px-4 py-2 text-sm rounded-lg bg-gray-900 dark:bg-white text-white dark:text-gray-900"
            >
              重试
            </button>
          </div>
        ) : (
          platformTabContent
        )}
      </div>

      {/* Config wizard modal */}
      {wizardScenario && (
        <ConfigWizard
          scenario={wizardScenario}
          initialTask={wizardEditingTask}
          onCancel={closeWizard}
          onSave={handleWizardSave}
        />
      )}

      {/* 矩阵号互动涨粉向导(选账号 + 配额 + 频率) */}
      {matrixWizardPlatform && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setMatrixWizardPlatform(null)}>
          <div className="w-full max-w-2xl" onClick={(e) => e.stopPropagation()}>
            <MatrixTaskWizard
              platformLabel={(() => {
                const p = matrixWizardPlatform;
                return p === 'douyin' ? '抖音' : p === 'kuaishou' ? '快手' : p === 'bilibili' ? '哔哩哔哩'
                  : p === 'xhs' ? '小红书' : p === 'x' ? '推特' : p === 'binance' ? '币安广场'
                  : p === 'youtube' ? 'YouTube' : p === 'tiktok' ? 'TikTok' : String(p);
              })()}
              accounts={matrixAccounts}
              onCancel={() => setMatrixWizardPlatform(null)}
              onSave={saveMatrixTask}
            />
          </div>
        </div>
      )}


      {/* Link-mode edit modal */}
      {linkEditTask && (
        <LinkModeEditModal
          task={linkEditTask}
          scenario={scenarios.find(s => s.id === linkEditTask.scenario_id) || null}
          onCancel={closeLinkEdit}
          onSaved={async () => {
            closeLinkEdit();
            await refreshAll();
          }}
        />
      )}
    </div>
  );
};

// ─── Link-mode edit modal ────────────────────────────────────────────────
// Dedicated editor for tasks created via 🔗 指定链接 flow. Takes URL list
// + auto_upload toggle — deliberately does NOT ask for track / keywords /
// persona, which would be meaningless for link-mode tasks.

const LinkModeEditModal: React.FC<{
  task: Task;
  scenario: Scenario | null;
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
}> = ({ task, scenario, onCancel, onSaved }) => {
  const isZh = i18nService.currentLanguage === 'zh' || i18nService.currentLanguage === 'zh-TW';
  const initialUrls: string[] = (task as any).urls || [];
  const [linksText, setLinksText] = useState(initialUrls.join('\n'));
  const [autoUpload, setAutoUpload] = useState<boolean>((task as any).auto_upload !== false);
  const [isBlueV, setIsBlueV] = useState<boolean>(!!(task as any).is_blue_v);
  const [submitting, setSubmitting] = useState(false);

  // v4.25.5: 平台感知。之前硬编码"小红书",x_link_rewrite / binance_from_x_link
  // 任务点编辑也走这个 modal,但显示文案 / URL 校验 / 上传去向都按 XHS 来 →
  // x.com URL 保存被 reject;且 Twitter 任务缺 is_blue_v 选项,AI 字数走默认。
  const platform: 'xhs' | 'x' | 'binance' = scenario?.platform === 'x' ? 'x'
    : scenario?.platform === 'binance' ? 'binance'
    : 'xhs';
  const isX = platform === 'x';
  const isBinance = platform === 'binance';
  // 部分 binance 链接搬运任务粘的也是 x.com 链接(从推特搬到币安),所以
  // binance + x 都接受 x.com / twitter.com。
  const acceptsTwitterUrl = isX || isBinance;
  const platformLabel = isX ? (isZh ? '推特' : 'X (Twitter)')
    : isBinance ? (isZh ? '币安广场' : 'Binance Square')
    : (isZh ? '小红书' : 'XHS');
  // v6.x: XHS/抖音/TikTok 视频无水印下载任务都带 urls[] → openWizardEdit 把它们路
  //   由到这个 link 编辑 modal,但它们不是"指定链接 AI 仿写":文案/去向都不同(纯下
  //   载,无 AI、无上传)。三个平台共用同一个分支,只在 label + 域名校验上分流。
  const isVideoDownload = scenario?.id === 'xhs_video_download'
    || scenario?.id === 'douyin_video_download'
    || scenario?.id === 'tiktok_video_download'
    || scenario?.id === 'kuaishou_video_download'
    || scenario?.id === 'bilibili_video_download';
  const vdPlatform: 'xhs' | 'douyin' | 'tiktok' | 'kuaishou' | 'bilibili' = scenario?.id === 'douyin_video_download'
    ? 'douyin'
    : scenario?.id === 'tiktok_video_download'
    ? 'tiktok'
    : scenario?.id === 'kuaishou_video_download'
    ? 'kuaishou'
    : scenario?.id === 'bilibili_video_download'
    ? 'bilibili'
    : 'xhs';
  const vdLabel = vdPlatform === 'douyin'
    ? (isZh ? '抖音' : 'Douyin')
    : vdPlatform === 'tiktok'
    ? 'TikTok'
    : vdPlatform === 'kuaishou'
    ? (isZh ? '快手' : 'Kuaishou')
    : vdPlatform === 'bilibili'
    ? (isZh ? '哔哩哔哩' : 'Bilibili')
    : (isZh ? '小红书' : 'XHS');
  // v4.28.x: sourceLabel 之前用在描述文案里("粘贴 1-3 个 ${sourceLabel} 原文链接"),
  // 现在描述按 acceptsTwitterUrl 直接走两个固定文案,不再需要 sourceLabel 占位 ——
  // TS strict 模式抛 unused 编译错(打包失败),直接移除。

  const validate = (text: string): { ok: string[]; err: string | null } => {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 1) return { ok: [], err: isZh ? '至少粘贴 1 个链接' : 'Paste at least 1 URL' };
    // v4.28.x: 跟 ConfigWizard 创建流程对齐 —— 创建那边一直是 1-5,这里编辑 modal
    // 之前卡在 1-3,导致用户在编辑里加第 4 个 URL 直接被拒。统一为 1-5。
    // v6.x: 上限从 5 提到 20。用户反馈"一次想批 10-20 条爆款链路",5 个太紧。
    if (lines.length > 20) return { ok: [], err: isZh ? '最多 20 个链接' : 'Max 20 URLs' };
    for (const l of lines) {
      if (isVideoDownload) {
        // 按视频下载场景分平台校验:抖音(含短链 v.douyin.com / iesdouyin)、
        // TikTok(含 vt/vm.tiktok.com 短链)、小红书(含 xhslink 短链)。
        if (vdPlatform === 'douyin') {
          if (!/^https?:\/\/([\w-]+\.)?(douyin|iesdouyin)\.com\//i.test(l)) {
            return { ok: [], err: (isZh ? '不是抖音链接：' : 'Not a Douyin link: ') + l.slice(0, 80) };
          }
        } else if (vdPlatform === 'tiktok') {
          if (!/^https?:\/\/([\w-]+\.)?tiktok\.com\//i.test(l)) {
            return { ok: [], err: (isZh ? '不是 TikTok 链接：' : 'Not a TikTok link: ') + l.slice(0, 80) };
          }
        } else if (vdPlatform === 'kuaishou') {
          if (!/^https?:\/\/([\w-]+\.)?(kuaishou|chenzhongtech)\.com\//i.test(l)) {
            return { ok: [], err: (isZh ? '不是快手链接：' : 'Not a Kuaishou link: ') + l.slice(0, 80) };
          }
        } else if (vdPlatform === 'bilibili') {
          if (!/^https?:\/\/([\w-]+\.)?(bilibili\.com|b23\.tv)\//i.test(l)) {
            return { ok: [], err: (isZh ? '不是哔哩哔哩链接：' : 'Not a Bilibili link: ') + l.slice(0, 80) };
          }
        } else {
          if (!/^https?:\/\/(www\.)?xiaohongshu\.com\//i.test(l) && !/^https?:\/\/xhslink\.com\//i.test(l)) {
            return { ok: [], err: (isZh ? '不是小红书链接：' : 'Not an XHS link: ') + l.slice(0, 80) };
          }
        }
      } else if (acceptsTwitterUrl) {
        if (!/^https?:\/\/(www\.)?(twitter|x)\.com\/.+\/status\/\d+/i.test(l)) {
          return { ok: [], err: (isZh ? '不是有效的推特推文链接：' : 'Not a valid X/Twitter status URL: ') + l.slice(0, 80) };
        }
      } else {
        if (!/^https?:\/\/(www\.)?xiaohongshu\.com\//i.test(l) && !/^https?:\/\/xhslink\.com\//i.test(l)) {
          return { ok: [], err: (isZh ? '不是小红书链接：' : 'Not an XHS link: ') + l.slice(0, 80) };
        }
      }
    }
    return { ok: lines, err: null };
  };

  const handleSubmit = async () => {
    if (submitting) return;
    const { ok, err } = validate(linksText);
    if (err) { alert(err); return; }
    setSubmitting(true);
    try {
      const patch: any = {
        urls: ok,
        daily_count: ok.length,
        auto_upload: autoUpload,
        active: true,
        enabled: true,
      };
      if (isX) patch.is_blue_v = isBlueV;
      await scenarioService.updateTask(task.id, patch);
      await onSaved();
    } catch (e) {
      alert((isZh ? '保存失败：' : 'Save failed: ') + String(e).slice(0, 120));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
    >
      <div
        className="w-full max-w-2xl rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-2xl p-6"
      >
        <h3 className="text-lg font-bold dark:text-white mb-2">
          {isVideoDownload
            ? '⬇️ ' + (isZh ? `${vdLabel}视频链接` : `${vdLabel} video links`)
            : '🔗 ' + (isZh ? '编辑指定链接任务' : 'Edit link-mode task')}
        </h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
          {isVideoDownload
            ? (isZh
                ? `粘贴 1~20 个${vdLabel}视频链接，每行一个，逐个解析并无水印下载到本地。`
                : `Paste 1-20 ${vdLabel} video links, one per line. Each is resolved and downloaded watermark-free.`)
            : isZh
            ? (acceptsTwitterUrl
                ? '粘贴 1~20 个推特原文链接，图文视频均可，每行一个，AI 进行深度改写后发布。'
                : '粘贴 1~20 个小红书原文链接，每行一个，AI 进行深度改写后发布。')
            : (acceptsTwitterUrl
                ? 'Paste 1-20 tweet URLs (images & videos both supported), one per line. AI will deep-rewrite and publish.'
                : 'Paste 1-20 XHS URLs, one per line. AI will deep-rewrite and publish.')}
        </p>
        <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
          {isVideoDownload ? (isZh ? '视频链接' : 'Video links') : (isZh ? '原文链接' : 'Source URLs')}
        </label>
        <textarea
          value={linksText}
          onChange={e => setLinksText(e.target.value)}
          rows={8}
          className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-mono dark:text-white focus:outline-none focus:ring-2 focus:ring-purple-500/50 resize-y min-h-[200px] break-all"
          disabled={submitting}
        />

        {/* v4.25.5: 推特账号类型(蓝V) — 仅 X link rewrite 显示。决定 AI 生成
            上限(普通号 ≤140 字硬限,蓝V 自由短/中/长)。 */}
        {isX && (
          <div className="mt-4">
            <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
              {isZh ? '🔵 推特账号类型' : '🔵 Twitter account type'}
            </label>
            <div
              className={`flex items-start gap-3 rounded-xl border px-4 py-3 cursor-pointer transition-colors ${
                isBlueV ? 'border-blue-500 bg-blue-500/10' : 'border-gray-300 dark:border-gray-700 hover:border-blue-500/50'
              }`}
              onClick={() => setIsBlueV(!isBlueV)}
            >
              <input
                type="checkbox"
                checked={isBlueV}
                onChange={e => setIsBlueV(e.target.checked)}
                onClick={e => e.stopPropagation()}
                className="mt-0.5 h-4 w-4 accent-blue-500 cursor-pointer"
                disabled={submitting}
              />
              <div className="flex-1 text-sm">
                <div className="font-medium dark:text-white">
                  {isZh ? '我的推特账号是蓝V（已订阅 X Premium）' : 'My X account is verified (Blue / Premium)'}
                </div>
                <div className="mt-1 text-[11px] text-gray-500 dark:text-gray-400 leading-relaxed">
                  {isZh
                    ? <>
                        <strong className="text-blue-500">勾选</strong> = 蓝V 账号,AI 可短/中/长自由发挥(不受 140 字硬限)<br/>
                        <strong className="text-gray-500">不勾</strong>(默认)= 普通账号,AI 强制 ≤ <strong>140 字符</strong>
                      </>
                    : <>
                        <strong className="text-blue-500">Checked</strong>: Blue/Premium — AI may pick short/mid/long freely.<br/>
                        <strong className="text-gray-500">Unchecked</strong>: non-Blue — AI forced ≤ <strong>140 chars</strong>.
                      </>}
                </div>
              </div>
            </div>
          </div>
        )}

        {!isVideoDownload && (<>
        <label className="text-sm font-medium dark:text-gray-200 mt-4 mb-2 block">
          {isZh ? '生成后的处理' : 'After generation'}
        </label>
        <div className="space-y-2">
          <label className={`flex items-start gap-2 p-3 rounded-lg border cursor-pointer transition-colors ${autoUpload ? 'border-purple-500 bg-purple-500/5' : 'border-gray-300 dark:border-gray-700'}`}>
            <input type="radio" name="link_edit_auto_upload" checked={autoUpload} onChange={() => setAutoUpload(true)} className="mt-0.5" disabled={submitting} />
            <div className="flex-1 text-xs leading-relaxed">
              <div className="font-semibold dark:text-white mb-0.5">
                {isZh ? `📤 自动发布到${platformLabel}` : `📤 Auto-publish to ${platformLabel}`}
              </div>
              <div className="text-gray-500 dark:text-gray-400">
                {isZh ? '全流程无人值守。⚠️ 单日 >10 篇有封号风险。' : 'Unattended. ⚠️ >10/day risks ban.'}
              </div>
            </div>
          </label>
          <label className={`flex items-start gap-2 p-3 rounded-lg border cursor-pointer transition-colors ${!autoUpload ? 'border-purple-500 bg-purple-500/5' : 'border-gray-300 dark:border-gray-700'}`}>
            <input type="radio" name="link_edit_auto_upload" checked={!autoUpload} onChange={() => setAutoUpload(false)} className="mt-0.5" disabled={submitting} />
            <div className="flex-1 text-xs leading-relaxed">
              <div className="font-semibold dark:text-white mb-0.5">
                {isZh ? '📁 仅生成保存到本地（更安全）' : '📁 Generate only (safer)'}
              </div>
              <div className="text-gray-500 dark:text-gray-400">
                {isZh ? '存盘后手动审核发布,封号风险最低。' : 'Review and post manually later.'}
              </div>
            </div>
          </label>
        </div>
        </>)}

        <div className="flex gap-2 mt-4">
          <button
            type="button"
            onClick={() => !submitting && onCancel()}
            disabled={submitting}
            className="flex-1 py-2.5 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
          >
            {isZh ? '取消' : 'Cancel'}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="flex-1 py-2.5 rounded-lg text-sm font-semibold bg-purple-500 text-white hover:bg-purple-600 disabled:opacity-50"
          >
            {submitting
              ? (isZh ? '保存中...' : 'Saving...')
              : (isZh ? '💾 保存' : '💾 Save')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ScenarioView;
