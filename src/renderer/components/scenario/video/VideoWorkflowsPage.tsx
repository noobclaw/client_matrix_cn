/**
 * VideoWorkflowsPage — 「多平台视频创作」工作流页面.
 *
 * 本地合成工具,不走 backend scenario 任务体系,但交互对齐 scenario:
 *   - 顶部两个 L1 tab(我的视频任务 / 运行记录)由 ScenarioView 渲染,这里收 section。
 *   - section='tasks'   → 任务列表(发光卡片,展示赛道/人设/关键词/文案)
 *   - section='history' → 运行记录列表(每次「开始创作 / 重新跑」一条)
 *   - section='create'  → 创建流:选创作方式 → 弹出配置弹窗
 *   - 内部 detail 导航:点任务卡进【任务详情】(配置 + 本次运行 + 历史运行 + 重跑/编辑/删除),
 *     点运行记录进【运行记录详情】(只读快照 + 该次进度/日志/成片/消耗)。
 *
 * 任务状态由模块级 videoTaskStore 单例托管(页面切换不中断、日志不丢)。
 * 一期只做到「存本地不上传」,自动上传到抖音/小红书/币安先占位。
 */

import React, { useEffect, useRef, useState } from 'react';
import { shortId } from '../../../utils/shortId';
import { HIDE_WEB3, cnyFromUsd } from '../../../buildFlags';
import { i18nService } from '../../../services/i18n';
import { CardActionRow } from '../CardActionRow';
import { VideoLoginCheckModal } from './VideoLoginCheckModal';
import { MATRIX_EDITION } from '../../../matrixEdition';
import { noobClawAuth } from '../../../services/noobclawAuth';
import { noobClawApi } from '../../../services/noobclawApi';
import { getBackendApiUrl } from '../../../services/endpoints';
import {
  videoCreationService,
  type VideoCreationInput,
  type VideoCreationProgressStep,
  type VideoAspect,
  type SubtitlePosition,
  type VideoTemplateStyle,
} from '../../../services/videoCreation';
import {
  videoTaskStore,
  type VideoTask,
  type VideoRunRecord,
  type VideoRunStatus,
  type VideoTaskLog,
  type VideoRunInterval,
  type VideoSchedule,
} from '../../../services/videoTaskStore';
import { videoQueue, VIDEO_TASK_LIMIT } from '../../../services/videoQueue';

// 订阅 store 的 React hook:任意视图都能拿到最新任务列表 + 运行记录并自动重渲染。
function useVideoStore(): { tasks: VideoTask[]; runs: VideoRunRecord[] } {
  const [snap, setSnap] = useState(() => ({
    tasks: videoTaskStore.getTasks(),
    runs: videoTaskStore.getRuns(),
  }));
  useEffect(() => videoTaskStore.subscribe(() => setSnap({
    tasks: videoTaskStore.getTasks(),
    runs: videoTaskStore.getRuns(),
  })), []);
  return snap;
}

type VideoSection = 'tasks' | 'history' | 'create';
type DetailView =
  | { kind: 'list' }
  | { kind: 'task'; taskId: string }
  | { kind: 'record'; recordId: string };

interface VideoWorkflowsPageProps {
  /** 矩阵号 edition:新建页只露「热搜成片」一张卡(暂不迁电影级/在线素材/模板速生),
   *  发布走指纹内核 CDP 按账号上传。 */
  matrixMode?: boolean;
  /** 由 ScenarioView 的 section 决定:tasks=任务列表,history=运行记录,create=创建向导。 */
  section: VideoSection;
  /** 从落地页进入创建流(ScenarioView 把 section 切到 'create')。 */
  onGoCreate: () => void;
  /** 从创建流返回落地页(ScenarioView 把 section 切回 'tasks')。 */
  onBack: () => void;
  /** 进入/退出任务·运行记录详情时上报,供 ScenarioView 隐藏顶部 L1/L2 tab
   *  (对齐 scenario 详情页:详情态全屏,顶上不挂那么多 tab)。 */
  onDetailChange?: (inDetail: boolean) => void;
  onRefresh?: () => void | Promise<void>;
  /** 「已有任务」点击行为:create 模式下应【跳到「我的涨粉任务」管理页的视频 tab】(切顶层
   *  mainView,让侧栏高亮 + 标题都对),而不是只在当前 ScenarioView 内把 section 切到 tasks。
   *  未传则回退用 onBack(内部切换,manage/runs 模式就该这样)。 */
  onGoTasks?: () => void;
}

export const VideoWorkflowsPage: React.FC<VideoWorkflowsPageProps> = ({ matrixMode, section, onGoCreate, onBack, onDetailChange, onRefresh, onGoTasks }) => {
  const isZh = i18nService.currentLanguage === 'zh';
  const { tasks, runs } = useVideoStore();
  const [detail, setDetail] = useState<DetailView>({ kind: 'list' });
  const [editTaskId, setEditTaskId] = useState<string | null>(null);
  // 创建完跳详情时,section 会从 create 变 tasks;别让下面的 effect 把 detail 清掉。
  const justCreatedRef = useRef(false);

  // 用户点 L1 tab / CTA 切 section 时,退出当前 detail 回到列表。
  useEffect(() => {
    if (justCreatedRef.current) { justCreatedRef.current = false; return; }
    setDetail({ kind: 'list' });
  }, [section]);

  // 详情态变化时上报给 ScenarioView(进详情=隐藏顶部 tab;离开本页时复位)。
  useEffect(() => {
    onDetailChange?.(detail.kind !== 'list');
  }, [detail.kind, onDetailChange]);
  useEffect(() => () => { onDetailChange?.(false); }, [onDetailChange]);

  const editingTask = editTaskId ? tasks.find((t) => t.id === editTaskId) : null;

  // ── detail 优先 ──
  if (detail.kind === 'task') {
    const task = tasks.find((t) => t.id === detail.taskId);
    if (!task) { setDetail({ kind: 'list' }); return null; }
    return (
      <>
        <VideoTaskDetail
          isZh={isZh}
          task={task}
          latestRun={videoTaskStore.getLatestRun(task.id)}
          onBack={() => setDetail({ kind: 'list' })}
          onOpenRecord={(rid) => setDetail({ kind: 'record', recordId: rid })}
          onEdit={() => setEditTaskId(task.id)}
        />
        {/* 编辑要用【和新建同一个】向导回填:模板速生(engine==='template')走 TemplateSpeedModal,
            其余(电影级纯AI / 在线素材)走 VideoConfigModal —— 否则模板任务会落到没有 template 模式的
            VideoConfigModal,框对不上。 */}
        {editingTask && editingTask.input?.engine === 'template' && (
          <TemplateSpeedModal
            isZh={isZh}
            matrixMode={matrixMode}
            editTask={editingTask}
            onClose={() => setEditTaskId(null)}
            onSaved={() => setEditTaskId(null)}
          />
        )}
        {editingTask && editingTask.input?.engine === 'hotspot' && (
          <HotspotVideoModal
            isZh={isZh}
            matrixMode={matrixMode}
            editTask={editingTask}
            onClose={() => setEditTaskId(null)}
            onSaved={() => setEditTaskId(null)}
          />
        )}
        {editingTask && editingTask.input?.engine !== 'template' && editingTask.input?.engine !== 'hotspot' && (
          <VideoConfigModal
            isZh={isZh}
            matrixMode={matrixMode}
            editTask={editingTask}
            /* 锁定为任务自身的模式并跳过 step1,跟新建那两张卡(电影级/在线素材)入口一致;
               同时避免编辑时误切 stock↔pure_ai 引擎(历史上切错跑了 Seedance 烧穿积分)。 */
            forcedMode={editingTask.input?.engine === 'ai' ? 'pure_ai' : 'stock'}
            onClose={() => setEditTaskId(null)}
            onCreated={() => {}}
            onSaved={() => setEditTaskId(null)}
          />
        )}
      </>
    );
  }

  if (detail.kind === 'record') {
    const run = runs.find((r) => r.id === detail.recordId);
    if (!run) { setDetail({ kind: 'list' }); return null; }
    return <VideoRunRecordDetail isZh={isZh} run={run} onBack={() => setDetail({ kind: 'list' })} />;
  }

  if (section === 'create') {
    return (
      <VideoCreateFlow
        isZh={isZh}
        matrixMode={matrixMode}
        onCreated={(taskId) => {
          justCreatedRef.current = true;
          onBack();                              // section → tasks(L1 高亮回任务)
          setDetail({ kind: 'task', taskId });   // 直接进新任务详情(本地一键成片)
        }}
        onGoTasks={onGoTasks || onBack}          // 「已有任务」→ create 模式跳管理页视频 tab;否则内部切换
      />
    );
  }

  if (section === 'history') {
    return <VideoRunHistory isZh={isZh} runs={runs} tasks={tasks} onOpenRecord={(rid) => setDetail({ kind: 'record', recordId: rid })} />;
  }

  return (
    <VideoLanding
      isZh={isZh}
      tasks={tasks}
      onGoCreate={onGoCreate}
      onOpenTask={(id) => setDetail({ kind: 'task', taskId: id })}
      onRefresh={onRefresh}
    />
  );
};

// ── 小工具 ──────────────────────────────────────────────────────────

/** 紧凑数字:123→'123',9939→'9.94K',1.23M。对齐 scenario 详情页的 token 展示。 */
function compactNumber(n: number): string {
  const abs = Math.abs(n || 0);
  if (abs < 1000) return String(n || 0);
  if (abs < 1_000_000) return (n / 1_000).toFixed(abs < 10_000 ? 2 : 1) + 'K';
  if (abs < 1_000_000_000) return (n / 1_000_000).toFixed(abs < 10_000_000 ? 2 : 1) + 'M';
  return (n / 1_000_000_000).toFixed(2) + 'B';
}

/**
 * 消耗 = 积分(credits)+ 美元,对齐币安详情页 `💎 N ≈ $X`。
 * credits = 服务端回传的「实扣积分」(_noobclaw.billableTokens,含 cache 折扣 +
 * Pro 倍率),绝不是上游真实 token —— 真实 token 只给后端 / admin 看。
 * costUsd 是服务端按 token_price_per_million 算好的权威美元。老后端拿不到时只显 💎(不显 $)。
 */
function formatCreditsCost(credits: number, costUsd: number): string {
  if (!credits || credits <= 0) return '-';
  const c = Math.round(credits);
  const usd = Number(costUsd) || 0;
  if (usd <= 0) return `💎 ${compactNumber(c)}`;
  return HIDE_WEB3 ? `💎 ${compactNumber(c)} ≈ ￥${cnyFromUsd(usd)}` : `💎 ${compactNumber(c)} ≈ $${usd.toFixed(4)}`;
}

/** 相对时间:刚刚 / N 分钟前 / N 小时前 / N 天前,对齐 scenario「上次运行」。 */
function fmtRelative(ts: number | null | undefined, isZh: boolean): string {
  if (!ts) return isZh ? '尚未运行' : 'Not run yet';
  const mins = Math.round(Math.abs(Date.now() - ts) / 60_000);
  if (mins < 1) return isZh ? '刚刚' : 'Just now';
  if (mins < 60) return isZh ? `${mins} 分钟前` : `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return isZh ? `${hrs} 小时前` : `${hrs} hr ago`;
  return isZh ? `${Math.round(hrs / 24)} 天前` : `${Math.round(hrs / 24)} d ago`;
}

/** 定时间隔的中/英文短标签(卡片 / 详情页胶囊用);未设定时返回 null。 */
function intervalLabel(task: VideoTask, isZh: boolean): string | null {
  const iv = task.runInterval;
  if (!iv || iv === 'once') return null;
  switch (iv) {
    case '30min': return isZh ? '每 30 分钟' : 'Every 30min';
    case '1h': return isZh ? '每小时' : 'Hourly';
    case '3h': return isZh ? '每 3 小时' : 'Every 3h';
    case '6h': return isZh ? '每 6 小时' : 'Every 6h';
    case 'daily': return isZh ? `每天 ${task.dailyTime || '08:00'}` : `Daily ${task.dailyTime || '08:00'}`;
    case 'daily_random': return isZh ? '每日随机' : 'Daily random';
    default: return null;
  }
}

/** 详情页频率行用:在短标签上补真实随机延迟范围,让用户一眼看清是否随机(对齐币安
 *  TaskDetailPage 的频率展示)。数字严格对齐 videoTaskStore.computeNextVideoRun:
 *  3h/6h = +[0,10min) 抖动;daily = ±15min;daily_random = 全天随机一次。 */
function intervalLabelDetailed(task: VideoTask, isZh: boolean): string | null {
  const iv = task.runInterval;
  if (!iv || iv === 'once') return null;
  switch (iv) {
    case '30min': return isZh ? '每 30 分钟(+1-10 分钟随机延迟)' : 'Every 30min (+1-10min jitter)';
    case '1h': return isZh ? '每小时(+1-10 分钟随机延迟)' : 'Hourly (+1-10min jitter)';
    case '3h': return isZh ? '每 3 小时(+1-45 分钟随机延迟)' : 'Every 3h (+1-45min jitter)';
    case '6h': return isZh ? '每 6 小时(+1-45 分钟随机延迟)' : 'Every 6h (+1-45min jitter)';
    case 'daily': return isZh ? `每天 ${task.dailyTime || '08:00'}(±15 分钟随机)` : `Daily ${task.dailyTime || '08:00'} (±15min)`;
    case 'daily_random': return isZh ? '每日随机时间一次' : 'Once daily (random time)';
    default: return null;
  }
}

/** 下一次计划运行的绝对时刻短文案:今天/明天 HH:MM,更远给 MM-DD HH:MM。 */
function fmtNextRun(ts: number | null | undefined, isZh: boolean): string {
  if (!ts || !isFinite(ts)) return '—';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(d) - startOfDay(now)) / 86400000);
  if (dayDiff <= 0) return isZh ? `今天 ${hm}` : `Today ${hm}`;
  if (dayDiff === 1) return isZh ? `明天 ${hm}` : `Tomorrow ${hm}`;
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}

/** 统计卡(对齐 scenario 详情页 StatCard:小标题 + 大值,可选点击跳转)。 */
const VStatCard: React.FC<{
  label: string;
  value: string | number;
  onClick?: () => void;
  actionLabel?: string;
}> = ({ label, value, onClick, actionLabel }) => {
  const Tag: any = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={`text-left w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-3 ${
        onClick ? 'hover:border-rose-500/50 transition-colors cursor-pointer' : ''
      }`}
    >
      <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">{label}</div>
      <div className="font-bold dark:text-white text-sm">{value}</div>
      {onClick && actionLabel && (
        <div className="text-[10px] text-rose-500 dark:text-rose-400 mt-1 truncate">{actionLabel}</div>
      )}
    </Tag>
  );
};

/** id 徽章:任务 / 运行记录用不同前缀,避免两种 id 混淆(都是 12 位 hex,展示前 8 位)。 */
const IdTag: React.FC<{ kind: 'task' | 'record'; id: string; isZh: boolean }> = ({ kind, id, isZh }) => (
  <span className="text-[10px] text-gray-500 dark:text-gray-500 font-mono shrink-0">
    {kind === 'task' ? (isZh ? '任务' : 'Task') : (isZh ? '记录' : 'Run')} #{id.slice(0, 8)}
  </span>
);

/** 视频创作教程入口(对齐币安 MyTasksPage 的「涨粉教程」胶囊:系统浏览器打开 docs)。 */
const VideoTutorialButton: React.FC<{ isZh: boolean }> = ({ isZh }) => {
  const url = isZh
    ? 'https://docs.noobclaw.com/zhong-wen-ban/shi-pin-chuang-zuo-jiao-cheng'
    : 'https://docs.noobclaw.com/english/video-creation';
  return (
    <button
      type="button"
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
      title={isZh ? '查看视频创作教程' : 'Open video creation tutorial'}
    >
      <span className="text-sm leading-none">📖</span>
      <span>{isZh ? '视频创作教程' : 'Tutorial'}</span>
      <span className="opacity-60 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all duration-200">→</span>
    </button>
  );
};

function statusOf(task: VideoTask): VideoRunStatus | 'idle' {
  return task.lastStatus || (task.runCount > 0 ? 'done' : 'idle');
}

/** 某任务已成功生成的视频条数(= 各 done 运行记录实际产出条数之和;一次批量出片可>1)。 */
function runVideoCount(r: { videoCount?: number }): number {
  return r.videoCount && r.videoCount > 0 ? r.videoCount : 1;
}
function doneVideoCount(taskId: string): number {
  return videoTaskStore.getRunsForTask(taskId)
    .filter((r) => r.status === 'done')
    .reduce((sum, r) => sum + runVideoCount(r), 0);
}

const StatusPill: React.FC<{ isZh: boolean; status: VideoRunStatus | 'idle' }> = ({ isZh, status }) => {
  if (status === 'running') {
    return (
      <span className="text-xs px-2 py-1 rounded bg-green-500/10 text-green-500 border border-green-500/30 inline-flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
        {isZh ? '生成中' : 'Running'}
      </span>
    );
  }
  if (status === 'done') {
    return (
      <span className="text-xs px-2 py-1 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
        ✅ {isZh ? '已完成' : 'Done'}
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="text-xs px-2 py-1 rounded bg-red-500/10 text-red-500 border border-red-500/30">
        ❌ {isZh ? '失败' : 'Failed'}
      </span>
    );
  }
  return (
    <span className="text-xs px-2 py-1 rounded bg-gray-500/10 text-gray-500 border border-gray-400/30">
      {isZh ? '未运行' : 'Idle'}
    </span>
  );
};

/** 平台 pill + 类型 badge(对齐 scenario 卡片头部)。
 *  传 input(任务 input)时,额外渲染【生成模式】徽章(纯AI/模板速生/在线素材/本地素材),
 *  跟列表卡片一致 —— 详情页头部一眼区分这条是哪种成片方式。 */
const HeadBadges: React.FC<{ isZh: boolean; size?: 'sm' | 'md'; input?: { engine?: string; localVideos?: unknown[] } }> = ({ isZh, size = 'sm', input }) => {
  const cls = size === 'md' ? 'text-xs px-2.5 py-1' : 'text-[11px] px-2 py-0.5';
  const isAi = input?.engine === 'ai';
  const isTemplate = input?.engine === 'template';
  const isHotspot = input?.engine === 'hotspot';
  const isLocal = !!input && !isAi && !isTemplate && !isHotspot && Array.isArray(input.localVideos) && input.localVideos.length > 0;
  const modeLabel = isHotspot ? (isZh ? '🔥 热搜成片' : '🔥 Hotspot')
    : isTemplate ? (isZh ? '⚡ 模板速生' : '⚡ Template')
    : isAi ? (isZh ? '✨ 纯AI生成' : '✨ Pure AI')
    : isLocal ? (isZh ? '📁 本地素材' : '📁 Local')
    : (isZh ? '🎞️ 在线素材' : '🎞️ Stock');
  const modeColor = isHotspot ? 'text-rose-500 bg-rose-500/10 border-rose-500/30'
    : isTemplate ? 'text-fuchsia-500 bg-fuchsia-500/10 border-fuchsia-500/30'
    : isAi ? 'text-violet-500 bg-violet-500/10 border-violet-500/30'
    : 'text-sky-500 bg-sky-500/10 border-sky-500/30';
  return (
    <>
      <span className={`shrink-0 inline-flex items-center gap-1 ${cls} font-semibold rounded-full border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300`}>
        🎬 {isZh ? '视频创作' : 'Video'}
      </span>
      <span className={`shrink-0 inline-flex items-center gap-1 ${cls} font-semibold rounded-full border text-rose-500 bg-rose-500/10 border-rose-500/30`}>
        🎬 {isZh ? 'AI自动成片' : 'AI Auto-Video'}
      </span>
      {input && (
        <span className={`shrink-0 inline-flex items-center gap-1 ${cls} font-semibold rounded-full border ${modeColor}`}>
          {modeLabel}
        </span>
      )}
    </>
  );
};

/** 关键词 chips(最多 n 个,超出显示 +N)。 */
const KeywordChips: React.FC<{ keywords: string[]; max?: number }> = ({ keywords, max = 6 }) => {
  let kws = (keywords || []).filter(Boolean);
  // 兼容把整串关键词存成【单元素数组】的任务(如二创):按空白拆成独立 chip,
  // 跟本地 AI 成片卡的多元素 keywords 视觉一致(否则二创卡关键词糊成一个灰框)。
  if (kws.length === 1 && /\s/.test(kws[0])) kws = kws[0].split(/\s+/).filter(Boolean);
  if (kws.length === 0) return <span className="text-gray-400">-</span>;
  const shown = kws.slice(0, max);
  const rest = kws.length - shown.length;
  return (
    <span className="inline-flex flex-wrap gap-1 align-middle">
      {shown.map((k, i) => (
        <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700">
          {k}
        </span>
      ))}
      {rest > 0 && <span className="text-[10px] text-gray-400">+{rest}</span>}
    </span>
  );
};

function scriptSummary(input: VideoCreationInput, isZh: boolean): string {
  if (input.engine === 'template') {
    // 模板速生没有「文案」概念 —— 这一行改成展示「版式 + 数据摘要」。
    const t = input.template;
    const st = TEMPLATE_STYLES.find((x) => x.id === t?.style);
    const styleLabel = st ? (isZh ? st.zh : st.en) : (t?.style || '');
    const data = (t?.dataText || '').replace(/\s+/g, ' ').trim();
    return `${isZh ? '模板速生' : 'Template'} · ${styleLabel}${data ? '｜' + (data.length > 30 ? data.slice(0, 30) + '…' : data) : ''}`;
  }
  const s = (input.script || '').trim();
  const mode = input.scriptMode || (s ? 'strict' : 'ai');
  if (mode === 'ai') {
    const prefix = isZh ? `AI 写稿 · ${input.targetSeconds ?? 45}s` : `AI script · ${input.targetSeconds ?? 45}s`;
    if (!s) return prefix;
    return `${prefix}｜${isZh ? '参考' : 'ref'}: ${s.length > 40 ? s.slice(0, 40) + '…' : s}`;
  }
  // strict:逐字朗读
  return s.length > 60 ? s.slice(0, 60) + '…' : s;
}

// 视频创作卖点标签(空状态 + 新建页都用,改一处即可)。突出:批量日更 100 条、百条成本 < $4、全自动、一键全平台。
const VIDEO_FEATURE_PILLS: Array<{ icon: string; zh: string; en: string }> = [
  { icon: '🔥', zh: '批量日更,一次最多 100 条', en: 'Batch up to 100 shorts per run' },
  { icon: '💰', zh: HIDE_WEB3 ? '100 条高质量视频成本低于 ￥29 · 单条低至 ￥0.3' : '100 条高质量视频成本低于 $4 · 单条低至 $0.04', en: 'Under $4 for 100 HD clips · from $0.04 each' },
  { icon: '🎙️', zh: 'AI 写稿 + AI 配音 + 自动字幕,全程零剪辑', en: 'AI script + voiceover + subtitles, zero editing' },
  { icon: '🚀', zh: '一键发抖音 / 小红书 / 快手 / 视频号 等全平台', en: 'One-click to Douyin / XHS / Kuaishou / Channels & more' },
];
const VideoFeaturePills: React.FC<{ isZh: boolean }> = ({ isZh }) => (
  <div className="flex flex-wrap gap-2 justify-center">
    {VIDEO_FEATURE_PILLS.map((p, i) => (
      <span
        key={i}
        className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full border border-rose-500/20 bg-rose-500/5 text-gray-700 dark:text-gray-300"
      >
        {p.icon} {isZh ? p.zh : p.en}
      </span>
    ))}
  </div>
);

// ── 落地页:有任务显示发光卡片列表,无任务显示占位框 ────────────────────

const VideoLanding: React.FC<{
  isZh: boolean;
  tasks: VideoTask[];
  onGoCreate: () => void;
  onOpenTask: (id: string) => void;
  onRefresh?: () => void | Promise<void>;
}> = ({ isZh, tasks, onGoCreate, onOpenTask }) => {
  // 翻译二创删除后,video 平台只剩本地一键成片任务。原先这个 Landing 还合并展示
  //   scenarioTasks(后端 scenario 任务),现在拆掉。
  const hasAny = tasks.length > 0;
  // 订阅协调器 → 「生成中」徽章实时刷新(抢占式:同时只 1 个在跑,无排队位次)。
  const [, setQv] = useState(0);
  useEffect(() => videoQueue.subscribe(() => setQv((v) => v + 1)), []);
  const total = tasks.length;
  // 「生成中」(绿):videoQueue 在跑(本地一键成片任务)。
  const queueBadge = (refId: string): React.ReactNode => {
    if (videoQueue.isRunning(refId)) {
      return <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-green-500/15 text-green-500 font-medium shrink-0">⏳ {isZh ? '生成中' : 'Running'}</span>;
    }
    return null;
  };

  if (!hasAny) {
    return (
      <div className="p-6 max-w-6xl mx-auto">
        <button
          type="button"
          onClick={onGoCreate}
          className="w-full rounded-2xl border border-dashed border-gray-300 dark:border-gray-700 p-10 text-center hover:border-rose-400 dark:hover:border-rose-500 transition-colors group"
        >
          <div className="text-5xl mb-3">🎬</div>
          <div className="text-base font-medium text-gray-700 dark:text-gray-200 mb-1">
            {isZh ? '还没有视频创作任务' : 'No video tasks yet'}
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400 mb-5 max-w-md mx-auto">
            {isZh
              ? '把选题变成配好音、带字幕、有视频画面的竖屏短视频,先存本地,满意后再发各平台。'
              : 'Turn a topic into a narrated, subtitled portrait short — saved locally first, publish later.'}
          </div>
          <span className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-rose-500 group-hover:bg-rose-600 text-white text-sm font-bold shadow-lg shadow-rose-500/25 transition-colors">
            ✨ {isZh ? '新建视频创作任务' : 'Create a video task'} →
          </span>
        </button>

        <section className="mt-6">
          <VideoFeaturePills isZh={isZh} />
        </section>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold dark:text-white flex items-center gap-2">
          📋 {isZh ? '我的视频任务' : 'My Videos'}
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${total >= VIDEO_TASK_LIMIT ? 'bg-red-500/15 text-red-500' : 'bg-gray-500/10 text-gray-500'}`}>
            {total}/{VIDEO_TASK_LIMIT}
          </span>
        </h2>
        <div className="flex items-center gap-3">
          <VideoTutorialButton isZh={isZh} />
        </div>
      </div>
      <div className="space-y-3">
        {/* 本地一键成片任务(翻译二创删除后,video 平台只剩本地任务,scenarioTasks 永远为空) */}
        {tasks.map((t) => (
          <VideoTaskCard key={t.id} isZh={isZh} task={t} onClick={() => onOpenTask(t.id)} queueBadge={queueBadge(t.id)} />
        ))}
      </div>
    </div>
  );
};

// ── 任务卡片(运行中发光,展示赛道/人设/关键词/文案) ─────────────────────

const VideoTaskCard: React.FC<{ isZh: boolean; task: VideoTask; onClick: () => void; queueBadge?: React.ReactNode }> = ({ isZh, task, onClick, queueBadge }) => {
  const isRunning = statusOf(task) === 'running';
  const made = doneVideoCount(task.id);

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left rounded-xl border p-4 transition-colors relative ${
        isRunning
          ? 'border-green-500 ring-2 ring-green-500/30 bg-white dark:bg-gray-900 noobclaw-running-glow'
          : 'border-gray-200 dark:border-gray-700 hover:border-rose-500/50 dark:hover:border-rose-500/50 bg-white dark:bg-gray-900'
      }`}
    >
      {/* Top row — 平台 pill + 类型 badge + 生成模式 + title + 任务#id */}
      <div className="flex items-center gap-2 mb-2 flex-wrap min-w-0">
        <HeadBadges isZh={isZh} />
        {(() => {
          // 生成模式徽章:纯AI生成(Seedance)/ 模板速生 / 在线素材 / 本地素材 —— 一眼区分。
          const isAi = task.input.engine === 'ai';
          const isTemplate = task.input.engine === 'template';
          const isHotspot = task.input.engine === 'hotspot';
          const isLocal = !isAi && !isTemplate && !isHotspot && Array.isArray(task.input.localVideos) && task.input.localVideos.length > 0;
          const label = isHotspot ? (isZh ? '🔥 热搜成片' : '🔥 Hotspot')
            : isTemplate ? (isZh ? '⚡ 模板速生' : '⚡ Template')
            : isAi ? (isZh ? '✨ 纯AI生成' : '✨ Pure AI')
            : isLocal ? (isZh ? '📁 本地素材' : '📁 Local')
            : (isZh ? '🎞️ 在线素材' : '🎞️ Stock');
          const color = isHotspot ? 'text-rose-500 bg-rose-500/10 border-rose-500/30'
            : isTemplate ? 'text-fuchsia-500 bg-fuchsia-500/10 border-fuchsia-500/30'
            : isAi ? 'text-violet-500 bg-violet-500/10 border-violet-500/30'
            : 'text-sky-500 bg-sky-500/10 border-sky-500/30';
          return <span className={`shrink-0 inline-flex items-center gap-1 text-[11px] px-2 py-0.5 font-semibold rounded-full border ${color}`}>{label}</span>;
        })()}
        <span className="font-medium dark:text-white truncate">{task.title}</span>
        <IdTag kind="task" id={task.id} isZh={isZh} />
        {queueBadge}
      </div>

      {/* 配置摘要:engine 分流 —— stock/pure_ai 展示 赛道/人设/关键词/文案;
          模板速生展示 赛道/版式/标题/数据/配音/BGM(用户真正填的)。 */}
      <div className="text-xs text-gray-600 dark:text-gray-300 space-y-1">
        {task.input.engine === 'hotspot' ? (() => {
          const srcMap: Record<string, string> = { weibo: isZh ? '微博' : 'Weibo', douyin: isZh ? '抖音' : 'Douyin', zhihu: isZh ? '知乎' : 'Zhihu', baidu: isZh ? '百度' : 'Baidu', bilibili: 'B站', xueqiu: isZh ? '雪球' : 'Xueqiu', hackernews: 'Hacker News', reddit: 'Reddit', googletrends: isZh ? 'Google 趋势' : 'Google Trends', youtube: 'YouTube', web3: 'Web3', tech: isZh ? '科技' : 'Tech' };
          const srcs = (((task.input as any).hotspotSources as string[]) || []).map((s) => srcMap[s] || s).join(' · ') || '-';
          const pubN = Array.isArray(task.input.publishPlatforms) ? task.input.publishPlatforms.length : 0;
          return (
            <>
              <div className="flex items-start gap-1.5">
                <span className="text-gray-400 shrink-0">🔥 {isZh ? '热点源' : 'Sources'}</span>
                <span className="truncate">{srcs}</span>
              </div>
              <div className="flex items-start gap-1.5">
                <span className="text-gray-400 shrink-0">⏱️ {isZh ? '时长' : 'Length'}</span>
                <span className="truncate">{task.input.targetSeconds || 60}s</span>
              </div>
              <div className="flex items-start gap-1.5">
                <span className="text-gray-400 shrink-0">🚀 {isZh ? '发布' : 'Publish'}</span>
                <span className="truncate">{pubN > 0 ? (isZh ? `${pubN} 个平台` : `${pubN} platforms`) : (isZh ? '仅存本地' : 'Local only')}</span>
              </div>
            </>
          );
        })() : task.input.engine === 'template' ? (() => {
          const t = task.input.template;
          const { count, preview } = templateDataPreview(t?.dataText, isZh);
          return (
            <>
              <div className="flex items-start gap-1.5">
                <span className="text-gray-400 shrink-0">⚡ {isZh ? '版式' : 'Style'}</span>
                <span className="truncate">{templateStyleLabel(t?.style, isZh)}</span>
              </div>
              {t?.title && (
                <div className="flex items-start gap-1.5">
                  <span className="text-gray-400 shrink-0">📋 {isZh ? '标题' : 'Title'}</span>
                  <span className="truncate">{t.title}</span>
                </div>
              )}
              <div className="flex items-start gap-1.5">
                <span className="text-gray-400 shrink-0">📊 {isZh ? '内容' : 'Content'}</span>
                <span className="truncate text-gray-500 dark:text-gray-400">
                  <span className="text-gray-400">[{isZh ? `${count} 条` : `${count} items`}]</span> {preview}
                </span>
              </div>
              <div className="flex items-start gap-1.5">
                <span className="text-gray-400 shrink-0">🎤 {isZh ? '配音' : 'Voice'}</span>
                <span className="truncate">{templateNarrationSummary(task.input, isZh)}</span>
              </div>
              {task.input.bgmPath && (
                <div className="flex items-start gap-1.5">
                  <span className="text-gray-400 shrink-0">🎵 BGM</span>
                  <span className="truncate">{templateBgmSummary(task.input, isZh)}</span>
                </div>
              )}
            </>
          );
        })() : (
          <>
            <div className="flex items-start gap-1.5">
              <span className="text-gray-400 shrink-0">🎯 {isZh ? '赛道' : 'Track'}</span>
              <span className="truncate">{task.input.track || '-'}</span>
            </div>
            {task.input.persona && (
              <div className="flex items-start gap-1.5">
                <span className="text-gray-400 shrink-0">🧑 {isZh ? '人设' : 'Persona'}</span>
                <span className="truncate">{task.input.persona}</span>
              </div>
            )}
            <div className="flex items-start gap-1.5">
              <span className="text-gray-400 shrink-0">🏷️ {isZh ? '关键词' : 'Keywords'}</span>
              <KeywordChips keywords={task.input.keywords} max={99} />
            </div>
            <div className="flex items-start gap-1.5">
              <span className="text-gray-400 shrink-0">📝 {isZh ? '文案' : 'Script'}</span>
              <span className="truncate text-gray-500 dark:text-gray-400">{scriptSummary(task.input, isZh)}</span>
            </div>
          </>
        )}
      </div>

      {/* footer — 「已生成 N 个视频」+ 定时胶囊(设了定时才显) */}
      <div className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-800 text-xs flex items-center justify-between gap-2">
        <span className="text-gray-500 dark:text-gray-400">
          {isZh ? '已生成' : 'Made'}：🎬 <strong className="dark:text-white">{made}</strong> {isZh ? '个视频' : made === 1 ? 'video' : 'videos'}
        </span>
        {intervalLabel(task, isZh) && (
          <span className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20">
            ⏰ {intervalLabel(task, isZh)}
            {task.nextPlannedRunAt ? ` · ${fmtNextRun(task.nextPlannedRunAt, isZh)}` : ''}
          </span>
        )}
      </div>
    </button>
  );
};

// ── 运行记录列表 ──────────────────────────────────────────────────────

const VideoRunHistory: React.FC<{
  isZh: boolean;
  runs: VideoRunRecord[];
  tasks: VideoTask[];
  onOpenRecord: (id: string) => void;
}> = ({ isZh, runs, onOpenRecord }) => {
  if (runs.length === 0) {
    return (
      <div className="p-6 max-w-6xl mx-auto">
        <div className="rounded-2xl border border-dashed border-gray-300 dark:border-gray-700 p-10 text-center">
          <div className="text-4xl mb-3">📊</div>
          <div className="text-base font-medium text-gray-700 dark:text-gray-200 mb-1">
            {isZh ? '还没有运行记录' : 'No run records yet'}
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400">
            {isZh ? '每次「开始创作 / 重新跑」都会在这里留一条记录。' : 'Each generation run shows up here.'}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="p-6 max-w-6xl mx-auto">
      <h2 className="text-base font-bold dark:text-white mb-4">
        {isZh ? '运行记录' : 'Run records'}
        <span className="ml-2 text-xs font-normal text-gray-400">{runs.length}</span>
      </h2>
      <div className="space-y-3">
        {runs.map((r) => (
          <VideoRunCard key={r.id} isZh={isZh} run={r} onClick={() => onOpenRecord(r.id)} />
        ))}
      </div>
    </div>
  );
};

/** 运行记录列表里单条时间戳:MM-DD HH:MM:SS,对齐币安 RunHistoryPage。 */
function fmtRecordTime(ts: number, isZh: boolean): string {
  if (!ts) return '-';
  return new Date(ts).toLocaleString(isZh ? 'zh-CN' : 'en-US', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

/**
 * 运行记录卡。布局对齐币安 RunHistoryPage 的行格式:
 *   顶行  状态pill + 类型badge + 标题  |  ⏱️时间 · 耗时 · 🎟️消耗
 *   次行  本次进度/本次完成(运行中给 step 进度,完成给"1 个视频")
 *   id行  任务id #xxx · 记录id #xxx
 *   尾行  最新进度/错误摘要 · N 条日志
 */
const VideoRunCard: React.FC<{ isZh: boolean; run: VideoRunRecord; onClick: () => void }> = ({ isZh, run, onClick }) => {
  const isRunning = run.status === 'running';
  const doneCount = run.steps.filter((s) => s.status === 'done').length;
  const totalSteps = run.steps.length;
  const durationSec = run.finishedAt ? Math.max(1, Math.round((run.finishedAt - run.startedAt) / 1000)) : null;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left rounded-lg border p-3 transition-colors cursor-pointer ${
        isRunning
          ? 'border-green-500/50 bg-white dark:bg-gray-900 noobclaw-running-glow hover:border-green-500'
          : run.status === 'error'
            ? 'border-red-400/60 dark:border-red-500/40 bg-white dark:bg-gray-900 hover:border-rose-500/50'
            : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 hover:border-rose-500/50'
      }`}
    >
      {/* 顶行:状态 + 类型 + 标题(左) | 时间 · 耗时 · 消耗(右) */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <StatusPill isZh={isZh} status={run.status} />
          <HeadBadges isZh={isZh} input={run.input} />
          <span className="font-medium dark:text-white truncate">{run.title}</span>
        </div>
        <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400 shrink-0 flex-wrap">
          <span>⏱️ {fmtRecordTime(run.startedAt, isZh)}</span>
          {durationSec && <span>· {durationSec}{isZh ? '秒' : 's'}</span>}
          <span title={isZh ? '本次消耗的 AI 积分(≈ 美元;TTS/合成免费)' : 'AI credits this run (≈ USD; TTS/compose free)'}>
            · {run.tokensUsed > 0 ? formatCreditsCost(run.tokensUsed, run.costUsd || 0) : '—'}
          </span>
        </div>
      </div>

      {/* 次行:本次进度(运行中)/ 本次完成(完成) */}
      <div className="mt-1.5 flex items-center gap-3 text-xs flex-wrap">
        <span className={`text-[10px] ${isRunning ? 'text-green-600 dark:text-green-400 font-semibold' : 'text-gray-500 dark:text-gray-500'}`}>
          {isZh ? (isRunning ? '本次进度' : '本次完成') : (isRunning ? 'Progress' : 'Result')}:
        </span>
        {isRunning && totalSteps > 0 ? (
          <span className="font-mono font-medium">
            🎬 <span className="text-green-600 dark:text-green-400">{doneCount}</span>
            <span className="text-gray-400 dark:text-gray-500">/{totalSteps}</span>{' '}
            <span className="text-gray-500 dark:text-gray-400 font-sans font-normal">{isZh ? '步' : 'steps'}</span>
          </span>
        ) : run.status === 'done' ? (
          <span className="font-mono font-medium">🎬 {runVideoCount(run)} {isZh ? '个视频' : runVideoCount(run) === 1 ? 'video' : 'videos'}</span>
        ) : (
          <span className="text-gray-400">{isZh ? '未生成' : 'none'}</span>
        )}
      </div>

      {/* id 行:任务id + 记录id(区分同一任务的不同运行) */}
      <div className="flex items-center gap-3 mt-1 text-[10px] text-gray-500 dark:text-gray-500 font-mono">
        <span>{isZh ? '任务id:' : 'task:'} #{run.taskId.slice(0, 8)}</span>
        <span>·</span>
        <span>{isZh ? '记录id:' : 'record:'} #{shortId(run.id)}</span>
      </div>

      {/* 尾行:最新进度 / 错误摘要 · 日志条数 */}
      {(run.error || run.message) && (
        <div className="mt-1.5 text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
          {run.status === 'error' && run.error ? (
            <span className="text-amber-600 dark:text-amber-400 mr-2">
              {run.error.length > 100 ? run.error.slice(0, 100) + '…' : run.error}
            </span>
          ) : run.message ? (
            <span className="mr-2">
              {run.message.length > 100 ? run.message.slice(0, 100) + '…' : run.message}
            </span>
          ) : null}
          <span className="text-[10px] text-gray-400">
            {isZh ? `· ${run.logs?.length ?? 0} 条日志` : `· ${run.logs?.length ?? 0} log entries`}
          </span>
        </div>
      )}
    </button>
  );
};

// ── 配置卡片(详情页 / 运行记录详情共用) ──────────────────────────────────
//
// 模板速生(engine='template')的字段跟 stock/pure_ai 完全不同 ——
//   · 没有「人设/关键词/文案」概念(用户填的是【版式 + 数据 + 配音 + BGM】)
//   · 共用同一份卡片只会让无效字段显示「-」误导用户(数据看板填 50 个币种,
//     这里居然显示「关键词: -」「视频文案: 留空 · AI 按 45s 写稿」)
// 所以两个 ConfigCard / ConfigRows 都按 engine 分流,模板速生走专属布局。

/** 把模板速生的 BGM 配置压成一行描述。空 = 无;builtin/remote/上传分类。 */
function templateBgmSummary(input: VideoCreationInput, isZh: boolean): string {
  const p = input.bgmPath;
  if (!p) return isZh ? '无' : 'none';
  const volLabel = BGM_VOLUME_OPTIONS.find((b) => b.v === input.bgmVolume);
  const vol = volLabel ? (isZh ? volLabel.zh : volLabel.en) : (input.bgmVolume?.toFixed(2) ?? '');
  if (p.startsWith(BUILTIN_BGM_PREFIX)) {
    const id = p.slice(BUILTIN_BGM_PREFIX.length);
    const item = BUILTIN_BGM.find((b) => b.id === id);
    const name = item ? (isZh ? item.zh : item.en) : id;
    return `${isZh ? '曲库' : 'Library'} · ${name}${vol ? ` · ${vol}` : ''}`;
  }
  if (p.startsWith(REMOTE_BGM_PREFIX)) {
    const url = p.slice(REMOTE_BGM_PREFIX.length);
    const name = (url.split('/').pop() || 'cloud').replace(/\.[^.]+$/, '');
    return `☁️ ${isZh ? '云端' : 'Cloud'} · ${name}${vol ? ` · ${vol}` : ''}`;
  }
  const file = p.split(/[\\/]/).pop() || p;
  return `${isZh ? '上传' : 'Upload'} · ${file}${vol ? ` · ${vol}` : ''}`;
}

/** 模板速生:配音字段压成一句话。关 = 「关(纯视觉)」;开 = 「<音色> · <语速>[ · 烧字幕]」。 */
function templateNarrationSummary(input: VideoCreationInput, isZh: boolean): string {
  const t = input.template;
  if (!t?.narration) return isZh ? '关(纯视觉)' : 'Off (silent)';
  const voice = VOICE_GROUPS.flatMap((g) => g.voices).find((v) => v.id === (t.voice || input.voice));
  const voiceName = voice ? (isZh ? voice.zh : voice.en) : (t.voice || input.voice || (isZh ? '默认音色' : 'Default'));
  const rate = RATE_OPTIONS.find((r) => r.v === (t.voiceRate ?? input.voiceRate ?? 0));
  const rateName = rate ? (isZh ? rate.zh : rate.en) : (isZh ? '正常' : 'Normal');
  const subPart = t.subtitleEnabled !== false ? (isZh ? ' · 烧字幕' : ' · subs') : (isZh ? ' · 不烧字幕' : ' · no subs');
  return `${voiceName} · ${rateName}${subPart}`;
}

/** 模板速生:dataText 压成「[N 条] line1 · line2 · line3 ...」。 */
function templateDataPreview(dataText: string | undefined, isZh: boolean): { count: number; preview: string } {
  const lines = (dataText || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lines.length === 0) return { count: 0, preview: isZh ? '(空)' : '(empty)' };
  const head = lines.slice(0, 3).join(' · ');
  const tail = lines.length > 3 ? (isZh ? ` · 等 ${lines.length} 条` : ` · +${lines.length - 3} more`) : '';
  return { count: lines.length, preview: head + tail };
}

/** 模板速生:版式 id → emoji + 中英名。 */
function templateStyleLabel(style: string | undefined, isZh: boolean): string {
  const s = TEMPLATE_STYLES.find((x) => x.id === style);
  if (!s) return style || '-';
  return `${s.emoji} ${isZh ? s.zh : s.en}`;
}

const ConfigCard: React.FC<{ isZh: boolean; input: VideoCreationInput }> = ({ isZh, input }) => {
  // 模板速生专属布局:展示用户真正填的字段(版式/标题/数据/配音/BGM/品牌色/时长)
  if (input.engine === 'template') {
    const t = input.template;
    const { count: dataCount, preview: dataPreview } = templateDataPreview(t?.dataText, isZh);
    // 时长不再由用户调:配音 ON 由真实音频决定;OFF 由 pipeline.autoDuration 按数据行数估算。
    const durationDesc = t?.narration
      ? (isZh ? '由 AI 口播稿决定' : 'driven by voice script')
      : (isZh ? '按数据行数自动估算' : 'auto from row count');
    return (
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-3 space-y-2 text-xs">
        <Row label={`⚡ ${isZh ? '版式' : 'Style'}`}>{templateStyleLabel(t?.style, isZh)}</Row>
        <Row label={`📋 ${isZh ? '标题' : 'Title'}`}>{t?.title || <span className="text-gray-400">{isZh ? '(未填,AI 自定)' : '(empty, AI fills)'}</span>}</Row>
        <Row label={`📊 ${isZh ? '内容' : 'Content'}`}>
          <div className="space-y-1">
            <span className="inline-block rounded bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 text-[11px] text-gray-500 dark:text-gray-400">
              {isZh ? `${dataCount} 条` : `${dataCount} items`}
            </span>
            <div className="whitespace-pre-wrap break-words text-gray-600 dark:text-gray-300">{dataPreview}</div>
          </div>
        </Row>
        {scriptLangDisplay(t?.lang, isZh) && <Row label={`🌐 ${isZh ? '生成语言' : 'Language'}`}>{scriptLangDisplay(t?.lang, isZh)}</Row>}
        <Row label={`🎤 ${isZh ? '配音' : 'Voice-over'}`}>{templateNarrationSummary(input, isZh)}</Row>
        <Row label={`🎵 ${isZh ? '背景音乐' : 'BGM'}`}>{templateBgmSummary(input, isZh)}</Row>
        <Row label={`🎨 ${isZh ? '品牌色' : 'Brand'}`}>
          <span className="inline-flex items-center gap-2">
            <span className="inline-block w-3 h-3 rounded-sm border border-gray-300 dark:border-gray-700" style={{ background: t?.brandColor || '#f0b90b' }} />
            <span className="font-mono">{t?.brandColor || '#f0b90b'}</span>
          </span>
        </Row>
        <Row label={`⏱️ ${isZh ? '时长' : 'Duration'}`}>{durationDesc}</Row>
        <Row label={`🎞️ ${isZh ? '画面' : 'Visuals'}`}>{isZh ? '本地动效渲染(HF 派)' : 'Local animated render (HF-style)'}</Row>
        <Row label={`🚀 ${isZh ? '发布' : 'Publish'}`}>{publishSummary(input, isZh)}</Row>
      </div>
    );
  }
  // 热搜成片:展示热点源/时长/配音/画面/发布,不展示赛道/人设/关键词(对它无意义)。
  if (input.engine === 'hotspot') {
    const srcMap: Record<string, string> = { weibo: isZh ? '微博热搜' : 'Weibo', douyin: isZh ? '抖音热搜' : 'Douyin', zhihu: isZh ? '知乎热榜' : 'Zhihu', baidu: isZh ? '百度热搜' : 'Baidu', bilibili: 'B站热搜', xueqiu: isZh ? '雪球热门股' : 'Xueqiu', hackernews: 'Hacker News', reddit: 'Reddit', googletrends: isZh ? 'Google 趋势' : 'Google Trends', youtube: isZh ? 'YouTube 热门' : 'YouTube', web3: 'Web3 资讯', tech: isZh ? '科技/AI' : 'Tech/AI' };
    const srcs = (((input as any).hotspotSources as string[]) || []).map((s) => srcMap[s] || s).join('、') || '-';
    const voiceLabel = (() => {
      const v = VOICE_GROUPS.flatMap((g) => g.voices).find((x) => x.id === input.voice);
      return v ? (isZh ? v.zh : v.en) : (input.voice || (isZh ? '默认音色' : 'Default'));
    })();
    return (
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-3 space-y-2 text-xs">
        <Row label={`🔥 ${isZh ? '热点源' : 'Sources'}`}>{srcs}</Row>
        <Row label={`⏱️ ${isZh ? '目标时长' : 'Length'}`}>{`${input.targetSeconds ?? 60}s`}</Row>
        <Row label={`🔢 ${isZh ? '每次条数' : 'Per run'}`}>{hotspotCountLabel(input, isZh)}</Row>
        {scriptLangDisplay(input.scriptLang, isZh) && <Row label={`🌐 ${isZh ? '创作语言' : 'Language'}`}>{scriptLangDisplay(input.scriptLang, isZh)}</Row>}
        <Row label={`🎤 ${isZh ? '配音' : 'Voice'}`}>{`${voiceLabel}${input.subtitleEnabled !== false ? (isZh ? ' · 烧字幕' : ' · subtitles') : (isZh ? ' · 无字幕' : '')}`}</Row>
        <Row label={`🎞️ ${isZh ? '画面' : 'Visuals'}`}>{(input as any).hotspotMaterialSource === 'douyin' ? (isZh ? '智能混剪 · 配音' : 'Smart remix') : (isZh ? '智能配图(抖音图文/TikTok · Ken Burns)' : 'Smart images (Douyin/TikTok · Ken Burns)')}</Row>
        <Row label={`🚀 ${isZh ? '发布' : 'Publish'}`}>{publishSummary(input, isZh)}</Row>
      </div>
    );
  }
  // 其它 engine(stock / pure_ai / 本地素材)走老的赛道/人设/关键词/文案布局。
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-3 space-y-2 text-xs">
      <Row label={`🎯 ${isZh ? '赛道' : 'Track'}`}>{input.track || '-'}</Row>
      <Row label={`🧑 ${isZh ? '人设' : 'Persona'}`}>{input.persona || '-'}</Row>
      <Row label={`🏷️ ${isZh ? '关键词' : 'Keywords'}`}><KeywordChips keywords={input.keywords} max={20} /></Row>
      <Row label={`📝 ${isZh ? '视频文案' : 'Script'}`}>
        {(() => {
          const s = (input.script || '').trim();
          const mode = input.scriptMode || (s ? 'strict' : 'ai');
          const tag = mode === 'strict'
            ? (isZh ? '严格逐字' : 'verbatim')
            : (isZh ? 'AI 写稿' : 'AI script');
          return (
            <div className="space-y-1">
              <span className="inline-block rounded bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 text-[11px] text-gray-500 dark:text-gray-400">{tag}</span>
              {s
                ? <div className="whitespace-pre-wrap break-words text-gray-600 dark:text-gray-300">{input.script}</div>
                : <div className="text-gray-400">{isZh ? `留空 · AI 按 ${input.targetSeconds ?? 45}s 写稿` : `empty · AI writes for ${input.targetSeconds ?? 45}s`}</div>}
            </div>
          );
        })()}
      </Row>
      {scriptLangDisplay(input.scriptLang, isZh) && <Row label={`🌐 ${isZh ? '创作语言' : 'Language'}`}>{scriptLangDisplay(input.scriptLang, isZh)}</Row>}
      <Row label={`🎞️ ${isZh ? '画面' : 'Visuals'}`}>
        {input.engine === 'ai'
          ? (isZh ? '纯 AI 生成（Seedance）' : 'Pure AI (Seedance)')
          : (input.localVideos && input.localVideos.length > 0)
            ? (isZh ? `本地素材 ${input.localVideos.length} 个` : `${input.localVideos.length} local clips`)
            : input.useStockVideo !== false
              ? (isZh ? '在线视频素材 + 图片' : 'stock video + images')
              : (isZh ? '仅图片' : 'images only')}
      </Row>
      <Row label={`🚀 ${isZh ? '发布' : 'Publish'}`}>{publishSummary(input, isZh)}</Row>
    </div>
  );
};

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-start gap-2">
    <span className="text-gray-400 shrink-0 w-20">{label}</span>
    <span className="flex-1 min-w-0 dark:text-gray-200">{children}</span>
  </div>
);

// 发布去向摘要(详情页/记录详情常驻显示):空 publishPlatforms = 仅存本地;否则列出平台中文名。
// 让用户在详情页一眼看到「存本地」还是「上传到 抖音、小红书…」(之前只在 hotspot 显示个数,
// stock/ai/template 完全不显示 → 选了上传也看不到发到哪)。
function publishSummary(input: VideoCreationInput, isZh: boolean): string {
  const ids = Array.isArray(input.publishPlatforms) ? input.publishPlatforms.filter(Boolean) : [];
  if (ids.length === 0) return isZh ? '存本地(不上传)' : 'Local only';
  // 矩阵号:每个平台带上要上传的账号名(保存时存的 publishAccountNames)。
  const acctNames = (input as any).publishAccountNames as Record<string, string> | undefined;
  const names = ids.map((id) => {
    const m = PUBLISH_PLATFORMS.find((p) => p.id === id);
    const base = m ? `${m.emoji} ${isZh ? m.zh : m.en}` : String(id);
    const acct = acctNames?.[id];
    return acct ? `${base}(${acct})` : base;
  });
  return (isZh ? '上传到 ' : 'Upload to ') + names.join(isZh ? '、' : ', ');
}

/** 把配音音色 id 映射成可读名(查不到就回退原 id / 默认)。详情/记录共用。 */
function voiceDisplayLabel(voiceId: string | undefined, isZh: boolean): string {
  const v = VOICE_GROUPS.flatMap((g) => g.voices).find((x) => x.id === voiceId);
  return v ? (isZh ? v.zh : v.en) : (voiceId || (isZh ? '默认音色' : 'Default'));
}

/** 热搜成片「每次运行条数」标签:min===max → "N 条/次";否则 "min-max 条/次(随机)"。 */
function hotspotCountLabel(input: VideoCreationInput, isZh: boolean): string {
  const lo = Math.max(1, Math.round((input as any).videoCountMin ?? input.videoCount ?? 1));
  const hi = Math.max(lo, Math.round((input as any).videoCountMax ?? input.videoCount ?? 1));
  return lo === hi
    ? (isZh ? `${hi} 条/次` : `${hi}/run`)
    : (isZh ? `${lo}-${hi} 条/次(随机)` : `${lo}-${hi}/run (random)`);
}

/**
 * 扁平配置文本行(任务详情页用)。对齐币安详情卡:左列就是一串纯文本字段,
 * 没有内嵌灰框、没有「任务配置」小标题 —— 跟 TaskDetailPage 的 persona/频次/
 * 创建时间块同一种排版。运行记录详情仍用上面带框的 ConfigCard。
 *
 * 模板速生(engine='template')的字段跟 stock/pure_ai 完全不同 —— 没有「人设/
 * 关键词/文案」概念,有的是【版式 + 数据 + 配音 + BGM + 品牌色】,所以按 engine
 * 分流,模板速生走专属布局(避免展示一堆 `-`)。
 */
const ConfigRows: React.FC<{ isZh: boolean; input: VideoCreationInput }> = ({ isZh, input }) => {
  if (input.engine === 'template') {
    const t = input.template;
    const { count: dataCount, preview: dataPreview } = templateDataPreview(t?.dataText, isZh);
    const durationDesc = t?.narration
      ? (isZh ? '由 AI 口播稿决定' : 'driven by voice script')
      : (isZh ? '按数据行数自动估算' : 'auto from row count');
    return (
      <>
        <div>⚡ {isZh ? '版式' : 'Style'}：{templateStyleLabel(t?.style, isZh)}</div>
        <div>📋 {isZh ? '标题' : 'Title'}：{t?.title || <span className="text-gray-400">{isZh ? '(未填,AI 自定)' : '(empty, AI fills)'}</span>}</div>
        <div className="break-words whitespace-pre-wrap">
          📊 {isZh ? '内容' : 'Content'}：<span className="text-gray-400">[{isZh ? `${dataCount} 条` : `${dataCount} items`}]</span> {dataPreview}
        </div>
        {scriptLangDisplay(t?.lang, isZh) && <div>🌐 {isZh ? '生成语言' : 'Language'}：{scriptLangDisplay(t?.lang, isZh)}</div>}
        <div>🎤 {isZh ? '配音' : 'Voice-over'}：{templateNarrationSummary(input, isZh)}</div>
        <div>🎵 {isZh ? '背景音乐' : 'BGM'}：{templateBgmSummary(input, isZh)}</div>
        <div className="inline-flex items-center gap-2">
          🎨 {isZh ? '品牌色' : 'Brand color'}：
          <span className="inline-block w-3 h-3 rounded-sm border border-gray-300 dark:border-gray-700 align-middle" style={{ background: t?.brandColor || '#f0b90b' }} />
          <span className="font-mono">{t?.brandColor || '#f0b90b'}</span>
        </div>
        <div>⏱️ {isZh ? '时长' : 'Duration'}：{durationDesc}</div>
        <div>🎞️ {isZh ? '画面' : 'Visuals'}：{isZh ? '本地动效渲染(HF 派)' : 'Local animated render (HF-style)'}</div>
        <div>🚀 {isZh ? '发布' : 'Publish'}：{publishSummary(input, isZh)}</div>
      </>
    );
  }
  // 热搜成片:展示热点源/时长/配音/字幕/画面/发布 —— 没有「赛道/人设/关键词/文案」概念
  // (题材每次运行从热榜随机选,资料联网取,所以那几项对它无意义,不展示一堆 `-`)。
  if (input.engine === 'hotspot') {
    const srcMap: Record<string, string> = {
      weibo: isZh ? '微博热搜' : 'Weibo', douyin: isZh ? '抖音热搜' : 'Douyin', zhihu: isZh ? '知乎热榜' : 'Zhihu',
      baidu: isZh ? '百度热搜' : 'Baidu', bilibili: 'B站热搜', xueqiu: isZh ? '雪球热门股' : 'Xueqiu',
      hackernews: 'Hacker News', reddit: 'Reddit', googletrends: isZh ? 'Google 趋势' : 'Google Trends',
      youtube: isZh ? 'YouTube 热门' : 'YouTube',
      web3: 'Web3 资讯', tech: isZh ? '科技/AI' : 'Tech/AI',
    };
    const srcs = ((input.hotspotSources as string[] | undefined) || []).map((s) => srcMap[s] || s).join('、') || '-';
    const voiceLabel = voiceDisplayLabel(input.voice, isZh);
    const subTag = input.subtitleEnabled !== false ? (isZh ? ' · 烧字幕' : ' · subtitles') : (isZh ? ' · 无字幕' : ' · no subs');
    return (
      <>
        <div className="break-words">🔥 {isZh ? '热点源' : 'Sources'}：{srcs}</div>
        <div>⏱️ {isZh ? '目标时长' : 'Length'}：{`${input.targetSeconds ?? 60}s`}</div>
        <div>🔢 {isZh ? '每次条数' : 'Per run'}：{hotspotCountLabel(input, isZh)}</div>
        {scriptLangDisplay(input.scriptLang, isZh) && <div>🌐 {isZh ? '创作语言' : 'Language'}：{scriptLangDisplay(input.scriptLang, isZh)}</div>}
        <div>🎤 {isZh ? '配音' : 'Voice'}：{voiceLabel}{subTag}</div>
        <div>🎞️ {isZh ? '画面' : 'Visuals'}：{(input as any).hotspotMaterialSource === 'douyin' ? (isZh ? '智能混剪' : 'Smart remix') : (isZh ? '智能配图(抖音图文/TikTok)' : 'Smart images (Douyin/TikTok)')}</div>
        <div>🚀 {isZh ? '发布' : 'Publish'}：{publishSummary(input, isZh)}</div>
      </>
    );
  }
  const kw = (input.keywords || []).filter(Boolean).join(' · ');
  const s = (input.script || '').trim();
  const mode = input.scriptMode || (s ? 'strict' : 'ai');
  const scriptTag = mode === 'strict' ? (isZh ? '严格逐字' : 'verbatim') : (isZh ? 'AI 写稿' : 'AI script');
  const scriptBody = s || (isZh ? `留空 · AI 按 ${input.targetSeconds ?? 45}s 写稿` : `empty · AI writes for ${input.targetSeconds ?? 45}s`);
  const visuals = input.engine === 'ai'
    ? (isZh ? '纯 AI 生成（Seedance）' : 'Pure AI (Seedance)')
    : (input.localVideos && input.localVideos.length > 0)
      ? (isZh ? `本地素材 ${input.localVideos.length} 个` : `${input.localVideos.length} local clips`)
      : input.useStockVideo !== false
        ? (isZh ? '在线视频素材 + 图片' : 'stock video + images')
        : (isZh ? '仅图片' : 'images only');
  return (
    <>
      <div>🎯 {isZh ? '赛道' : 'Track'}：{input.track || '-'}</div>
      <div>🧑 {isZh ? '人设' : 'Persona'}：{input.persona || '-'}</div>
      <div>🏷️ {isZh ? '关键词' : 'Keywords'}：{kw || '-'}</div>
      <div className="break-words whitespace-pre-wrap">
        📝 {isZh ? '视频文案' : 'Script'}：<span className="text-gray-400">[{scriptTag}]</span> {scriptBody}
      </div>
      {scriptLangDisplay(input.scriptLang, isZh) && <div>🌐 {isZh ? '创作语言' : 'Language'}：{scriptLangDisplay(input.scriptLang, isZh)}</div>}
      <div>🎞️ {isZh ? '画面' : 'Visuals'}：{visuals}</div>
      <div>🚀 {isZh ? '发布' : 'Publish'}：{publishSummary(input, isZh)}</div>
    </>
  );
};

// ── 运行体(进度 step + 本次消耗 + 流式日志 + 成片操作) 详情/记录共用 ─────────

/** step 明细列表(详情/记录共用)。 */
const StepList: React.FC<{ steps: VideoCreationProgressStep[] }> = ({ steps }) => {
  if (!steps.length) return null;
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-3 space-y-1.5">
      {steps.map((s) => (
        <div key={s.key} className="flex items-center gap-2 text-xs">
          <span>{s.status === 'done' ? '✅' : s.status === 'running' ? '⏳' : s.status === 'error' ? '❌' : '○'}</span>
          <span className={s.status === 'running' ? 'text-green-600 dark:text-green-400 font-medium' : 'text-gray-600 dark:text-gray-300'}>
            {s.label}
          </span>
        </div>
      ))}
    </div>
  );
};

/** 把日志里的 NoobClaw 路径(输出目录 / 成片文件)变成可点按钮 —— 点一下用
 *  Finder/资源管理器打开。用户反馈:日志只给一段文字路径,没法直接打开。 */
function renderVideoLog(message: string): React.ReactNode {
  const m = message.match(/([/\\][^\s:：]*NoobClaw[/\\][^\s]*|[A-Za-z]:[\\/][^\s]*NoobClaw[\\/][^\s]*)/);
  if (!m) return message;
  const p = m[1];
  const idx = message.indexOf(p);
  return (
    <>
      {message.slice(0, idx)}
      <button
        type="button"
        className="text-blue-400 hover:underline cursor-pointer break-all"
        title={p}
        onClick={() => { try { (window as any).electron?.shell?.openPath?.(p); } catch { /* ignore */ } }}
      >
        {p}
      </button>
      {message.slice(idx + p.length)}
    </>
  );
}

/** 一段流式日志行(终端风格,自动滚到底)。供每步内联日志框 / 合并日志框共用。 */
const LogLines: React.FC<{ logs: VideoTaskLog[]; active?: boolean }> = ({ logs, active }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.length]);
  return (
    <div
      ref={ref}
      className="max-h-48 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed text-gray-700 dark:text-gray-200"
    >
      {logs.map((l, i) => (
        <div key={i} className="flex gap-2">
          <span className="text-gray-400 shrink-0">{l.time}</span>
          <span className="break-words whitespace-pre-wrap">{renderVideoLog(l.message)}</span>
        </div>
      ))}
      {active && <span className="text-green-500 noobclaw-blink text-sm font-bold">▋</span>}
    </div>
  );
};

/**
 * 「当前运行明细」—— 每个步骤一个标题 + 内联流式日志框(对齐币安 StepLogBox:
 * 日志就贴在它所属的步骤里,而不是底部一整段)。日志按 log.step 归到对应步骤。
 * 没有任何 step 标记的旧记录 → 退化成「步骤列表 + 一个合并日志框」。
 */
const StepLogList: React.FC<{ isZh: boolean; steps: VideoCreationProgressStep[]; logs: VideoTaskLog[] }> = ({ isZh, steps, logs }) => {
  const hasStepTag = logs.some((l) => typeof l.step === 'number');
  if (steps.length === 0) {
    // 还没拿到步骤(刚开跑)→ 只显已有日志
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
        <LogLines logs={logs} active />
      </div>
    );
  }
  if (!hasStepTag) {
    // 旧记录:日志没打 step 标记 → 步骤列表 + 合并日志框(不丢日志)
    return (
      <>
        <div className="mb-3"><StepList steps={steps} /></div>
        {logs.length > 0 && (
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
            <LogLines logs={logs} />
          </div>
        )}
      </>
    );
  }
  return (
    <div className="space-y-4">
      {steps.map((s, idx) => {
        const stepLogs = logs.filter((l) => (typeof l.step === 'number' ? l.step : 0) === idx);
        const active = s.status === 'running';
        const done = s.status === 'done';
        const error = s.status === 'error';
        return (
          <div key={s.key}>
            <div className={`text-sm font-medium mb-2 flex items-center gap-1.5 ${
              active ? 'text-green-500' : done ? 'text-green-600 dark:text-green-400' : error ? 'text-red-500' : 'dark:text-gray-300'
            }`}>
              <span>{done ? '✅' : active ? '⏳' : error ? '❌' : '○'}</span>
              <span>{idx + 1}. {s.label}</span>
            </div>
            <div className={`rounded-xl border min-h-[44px] ${
              active ? 'border-green-500/30 bg-green-500/5'
                : done ? 'border-green-500/20 bg-green-500/5'
                : error ? 'border-red-500/20 bg-red-500/5'
                : 'border-gray-200 dark:border-gray-700'
            }`}>
              {stepLogs.length > 0 ? (
                <LogLines logs={stepLogs} active={active} />
              ) : (
                <div className="text-xs text-gray-400 dark:text-gray-500 text-center py-3">
                  {active ? (isZh ? '运行中…' : 'Running…') : (isZh ? '暂无日志' : 'No logs')}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

/** 把毫秒格式化成 mm:ss(超过 1 小时则 h:mm:ss)。 */
function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** 运行中每秒重渲染一次,驱动实时计时;停跑后不再 tick(省渲染)。 */
function useTicker(active: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
}

/**
 * 运行体:step 明细 + 流式日志 + 成片操作。
 * showProgressPill=true(运行记录详情)时额外渲染顶部「步骤 N/M + 本次消耗 + 状态」一行;
 * 任务详情页传 false —— 那边上方已有独立的「本次运行进度 / 本次消耗」绿卡对,避免重复。
 */
const RunBody: React.FC<{ isZh: boolean; run: VideoRunRecord | undefined; showProgressPill?: boolean }> = ({ isZh, run, showProgressPill = true }) => {
  const logRef = useRef<HTMLDivElement>(null);
  const logLen = run?.logs?.length ?? 0;
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logLen]);
  // 运行中每秒 tick,让下方 ⏱️ 计时实时走字;hook 必须在 early return 前无条件调用。
  useTicker(run?.status === 'running');

  if (!run) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 text-sm text-gray-500 dark:text-gray-400">
        {isZh ? '尚未运行。点上方「开始创作 / 重新跑」启动一次。' : 'Not run yet. Start a run above.'}
      </div>
    );
  }

  const isRunning = run.status === 'running';
  const doneCount = run.steps.filter((s) => s.status === 'done').length;
  const totalSteps = run.steps.length;
  // 计时:运行中 = now - startedAt(每秒 tick 走字);已结束 = finishedAt - startedAt 定格。
  const elapsedLabel = fmtDuration((run.finishedAt ?? Date.now()) - run.startedAt);

  return (
    <>
      {showProgressPill ? (
        <div className={`rounded-xl border p-4 mb-4 ${
          isRunning ? 'border-green-500 ring-2 ring-green-500/30 noobclaw-running-glow bg-white dark:bg-gray-900' : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900'
        }`}>
          <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
            <div className="flex items-center gap-3 flex-wrap text-xs">
              {totalSteps > 0 && (
                <span className={`rounded-lg px-3 py-1.5 inline-flex items-center gap-2 ${
                  isRunning ? 'border-2 border-green-500/50 bg-green-500/5 dark:bg-green-500/10' : 'border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50'
                }`}>
                  <span className={`text-[10px] ${isRunning ? 'text-green-600 dark:text-green-400 font-semibold' : 'text-gray-500'}`}>
                    {isRunning ? (isZh ? '本次运行进度' : 'Current Run') : (isZh ? '步骤' : 'Steps')}
                  </span>
                  <span className="font-mono">
                    🎬 <strong className={isRunning ? 'text-green-600 dark:text-green-400' : ''}>{doneCount}</strong>
                    <span className="text-gray-400">/{totalSteps}</span>
                  </span>
                </span>
              )}
              <span className="rounded-lg px-3 py-1.5 border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 inline-flex items-center gap-2">
                <span className="text-[10px] text-gray-500">{isZh ? '本次消耗' : 'Cost'}</span>
                <span className="font-mono">{formatCreditsCost(run.tokensUsed, run.costUsd || 0)}</span>
              </span>
            </div>
            <StatusPill isZh={isZh} status={run.status} />
          </div>
          <StepList steps={run.steps} />
        </div>
      ) : (
        totalSteps > 0 && <div className="mb-4"><StepList steps={run.steps} /></div>
      )}

      {/* 流式日志 */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 mb-4">
        <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5 flex items-center gap-2">
          <span>{isZh ? '运行日志' : 'Logs'}</span>
          <span className={`font-mono text-[11px] inline-flex items-center gap-1 ${isRunning ? 'text-green-500' : 'text-gray-400'}`}>
            {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-green-500 noobclaw-blink" />}
            ⏱️ {elapsedLabel}
          </span>
        </div>
        <div
          ref={logRef}
          className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-900 text-gray-200 p-3 h-64 overflow-y-auto font-mono text-[11px] leading-relaxed"
        >
          {(run.logs ?? []).map((l, i) => (
            <div key={i} className="flex gap-2">
              <span className="text-gray-500 shrink-0">{l.time}</span>
              <span className="break-words whitespace-pre-wrap">{renderVideoLog(l.message)}</span>
            </div>
          ))}
          {isRunning && (
            <div className="mt-1 text-[11px] text-gray-400 leading-relaxed">
              <span className="text-green-400 noobclaw-blink text-sm font-bold">▋</span>{' '}
              {isZh
                ? `⏳ 运行中 · 已用时 ${elapsedLabel}。合成/导出大视频这段可能几十秒没有新日志(正在编码),属正常,完成后会显示可点击的输出目录。`
                : `⏳ Running · ${elapsedLabel} elapsed. Encoding the final video may show no new logs for a while — this is normal; the clickable output folder appears when done.`}
            </div>
          )}
        </div>
      </div>

      {/* 成片操作 / 错误 */}
      {run.status === 'done' && run.outputPath && (
        <div className="rounded-xl border border-green-500/40 bg-green-500/5 p-4 mb-4">
          <div className="text-sm font-semibold text-green-600 dark:text-green-400 mb-1">
            ✅ {isZh ? '合成完成 · 成片已保存' : 'Done · video saved'}
          </div>
          <div className="text-[11px] text-gray-500 dark:text-gray-400 break-all mb-3">{run.outputPath}</div>
          {/* 「预览成片」直开文件在 Tauri sidecar 下不稳(openFile 经常没反应),
             改为只给「打开目录」,用户进文件夹自己双击成片播放 —— 稳。 */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => openFolder(dirOf(run.outputPath))}
              className="px-4 py-2.5 rounded-lg text-sm font-semibold bg-blue-500 text-white hover:bg-blue-600 transition-colors"
            >
              📂 {isZh ? '打开输出目录' : 'Open folder'}
            </button>
            <span className="text-[11px] text-gray-500 dark:text-gray-400">
              {isZh ? '在文件夹里双击成片即可播放' : 'Double-click the file in the folder to play'}
            </span>
          </div>
        </div>
      )}
      {run.status === 'error' && run.error && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/5 p-4 mb-4 text-xs text-red-500 break-words whitespace-pre-wrap">
          {run.error}
        </div>
      )}
    </>
  );
};

/** 输出目录条(详情页顶部)。优先用本次运行的目录,否则从成片路径推。 */
const OutputDirBar: React.FC<{ isZh: boolean; dir?: string }> = ({ isZh, dir }) => {
  if (!dir) return null;
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-3 py-2 mb-4 flex items-center gap-2 text-xs">
      <span className="text-gray-400 shrink-0">📁 {isZh ? '输出目录' : 'Output dir'}</span>
      <span className="flex-1 min-w-0 truncate font-mono text-gray-600 dark:text-gray-300" title={dir}>{dir}</span>
      <button
        type="button"
        onClick={() => openFolder(dir)}
        className="shrink-0 px-2 py-1 rounded text-[11px] border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
      >
        {isZh ? '打开' : 'Open'}
      </button>
    </div>
  );
};

function dirOf(p?: string): string | undefined {
  if (!p) return undefined;
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx > 0 ? p.slice(0, idx) : undefined;
}

/**
 * 打开文件夹 —— 走币安详情页同款 shell.openPath(直接在资源管理器/访达里打开目录)。
 * 旧的 videoCreationService.revealInFolder 走主进程 explorer /select,<dir>,对“目录”
 * 参数在 Tauri sidecar 下经常没反应(/select 是给文件高亮用的);openPath 是币安那边
 * 验证可用的同一条路,这里统一改用它,保证“打开输出目录”按钮真的能打开。
 */
function openFolder(dir?: string): void {
  if (!dir) return;
  try { (window as any).electron?.shell?.openPath?.(dir); } catch { /* ignore */ }
}

// ── 任务详情页:配置 + 本次运行 + 历史运行 + 重跑/编辑/删除 ─────────────────

const VideoTaskDetail: React.FC<{
  isZh: boolean;
  task: VideoTask;
  latestRun: VideoRunRecord | undefined;
  onBack: () => void;
  onOpenRecord: (id: string) => void;
  onEdit: () => void;
}> = ({ isZh, task, latestRun, onBack, onOpenRecord, onEdit }) => {
  const status = statusOf(task);
  const isRunning = status === 'running';
  const [actionError, setActionError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [stopping, setStopping] = useState(false);
  // 删除二次确认(对齐 scenario TaskDetailPage.handleDelete):首次点亮,3 秒内再点才真删。
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // 防止 3s setTimeout 在组件卸载后触发 setState 警告。
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // 输出目录:优先本次运行的目录,否则从成片路径推(配置卡「输出目录」链接用)。
  const outDir = latestRun?.outputDir || dirOf(latestRun?.outputPath) || dirOf(task.lastOutputPath);

  // 任务配置的发布平台(空 = 仅存本地,运行前无需登录校验)。
  const publishPlatforms: string[] = Array.isArray((task.input as any).publishPlatforms)
    ? ((task.input as any).publishPlatforms as string[]) : [];
  // 热搜成片【取材】也要登录(平台主站,非创作者中心)。新流程下视频混剪 + 智能配图【都】从
  //   抖音/TikTok 取材(不再 Serper),所以两种 materialSource 都要校验,不再只校验 'douyin'。
  //   平台按【选中的热点源语言】切:国内榜→中文话题→抖音;海外榜(HN/Reddit/Google/YouTube)→
  //   英文话题→TikTok。两类源都选了就两个都校验(运行时按每条话题语言 detectLang 实际路由)。
  const OVERSEAS_HOT_SOURCES = ['hackernews', 'reddit', 'googletrends', 'youtube'];
  const materialLoginPlatforms: string[] = (() => {
    if (task.input.engine !== 'hotspot') return [];
    const srcs = Array.isArray((task.input as any).hotspotSources) ? (task.input as any).hotspotSources as string[] : [];
    const mats: string[] = [];
    if (srcs.some((s) => !OVERSEAS_HOT_SOURCES.includes(s))) mats.push('douyin'); // 国内源 → 抖音取材
    if (srcs.some((s) => OVERSEAS_HOT_SOURCES.includes(s))) mats.push('tiktok');  // 海外源 → TikTok 取材
    return mats;
  })();
  // 手动运行前的登录校验:发布平台(创作者中心口径)∪ 取材平台(主站口径)。任一非空就先弹,
  // 全绿(插件已连 + 各平台登录)才开跑。定时调度不走这里(无人值守靠运行期超时兜底)。
  // 矩阵 edition:发布走指纹内核 CDP 按号上传、取材也用账号的内核,不依赖浏览器插件,
  // 且选的都是已连接(登录)账号 → 运行前【不需要】插件/平台登录校验,直接跑。
  const loginCheckList = MATRIX_EDITION ? [] : Array.from(new Set([...publishPlatforms, ...materialLoginPlatforms]));
  // 主站 override = 取材要、但不在发布列表里的(同时发布时按发布的创作者中心口径,更严)。
  const loginMainSiteOverride = materialLoginPlatforms.filter((p) => !publishPlatforms.includes(p));
  const [showLoginCheck, setShowLoginCheck] = useState(false);

  // 真正开跑(余额 + 登录校验都过了之后)。
  const startRun = () => {
    // 抢占式:空闲立即开跑;已有视频在生成则不排队,提示稍后再试。
    if (!videoQueue.tryRun('local', task.id, task.title)) {
      setActionError(isZh ? '已有视频正在生成,请等它完成后再开始。' : 'A video is generating. Please wait until it finishes.');
    }
  };

  const handleRerun = async () => {
    setActionError(null);
    // 「重新跑」对齐向导首跑的资金安全预检:模式一(在线素材,无本地上传)成片后会扣
    // 平台基础费 + AI token,这里先刷新余额并用 VIDEO_MODE1_MIN_BALANCE 高门槛校验,
    // 避免重跑也「生成完才发现没钱」(此前重跑只用默认弱阈值 + 旧缓存余额,已补齐)。
    const isStock = !(task.input.localVideos && task.input.localVideos.length > 0);
    if (isStock) {
      setChecking(true);
      let minBalance = VIDEO_MODE1_MIN_BALANCE;
      try {
        await noobClawAuth.refreshBalance();
        minBalance = await fetchVideoMinBalance();
      } catch { /* 网络失败退回用本地缓存余额 + 兜底门槛判断,不阻塞 */ }
      setChecking(false);
      if (!noobClawAuth.hasEnoughBalanceForTask(minBalance)) return;
    } else if (!noobClawAuth.hasEnoughBalanceForTask()) {
      // 本地上传任务不收平台费,但 AI 写稿仍可能实时扣 token → 保留一次轻量余额校验。
      return;
    }
    // 需登录的平台(发布平台 ∪ 热搜取材平台)非空 → 先过登录校验(插件已连 + 全平台登录才开跑);
    // 都不需要(仅存本地 + 非抖音取材)→ 直接跑。
    if (loginCheckList.length > 0) { setShowLoginCheck(true); return; }
    startRun();
  };

  // 删除流程:对齐 scenario TaskDetailPage —— 运行中拒绝(先停);首次点击亮红 3 秒,
  // 再点才真删。无 Modal,inline 状态切换,跟币安/抖音的删除一致。
  const handleDelete = () => {
    if (isRunning) {
      setActionError(isZh ? '该任务正在运行中,请先停止再删除' : 'Task is running — stop it before deleting');
      return;
    }
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      // 3s 内不再点 → 自动复位,避免误删(币安同款超时)
      setTimeout(() => { if (mountedRef.current) setConfirmingDelete(false); }, 3000);
      return;
    }
    setConfirmingDelete(false);
    if (videoTaskStore.deleteTask(task.id)) onBack();
  };

  // 停止运行中的任务:abort 主进程 pipeline + kill ffmpeg/seedance/tts。终态由 store 刷新。
  const handleStop = () => {
    setStopping(true);
    try { videoTaskStore.stopTask(task.id); } catch {}
    // 给主进程几秒走到步骤边界 / 子进程被 kill;按钮态兜底复位(真正终态由 store 回写)。
    setTimeout(() => setStopping(false), 4000);
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <button
        type="button"
        onClick={onBack}
        className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
      >
        ← {isZh ? '返回' : 'Back'}
      </button>

      {/* Header — 平台/类型 badge + 任务#id(对齐币安详情页头部:只有徽章 + #id,
          不挂大标题。任务名已在配置行 / 列表里有,顶上再来个大标题就跟币安不一致)。 */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <HeadBadges isZh={isZh} size="md" input={task.input} />
        <IdTag kind="task" id={task.id} isZh={isZh} />
      </div>

      {/* 配置 + 操作卡(运行中绿框发亮)。对齐币安任务详情:左=扁平配置文字行(无嵌套
          边框、无「任务配置」标题),右=横排操作按钮;运行中状态做成右侧绿色「生成中」胶囊。 */}
      <div className={`rounded-xl border bg-white dark:bg-gray-900 p-4 mb-4 ${
        isRunning ? 'border-green-500 ring-2 ring-green-500/30 noobclaw-running-glow' : 'border-gray-200 dark:border-gray-700'
      }`}>
        <div className="flex items-start justify-between gap-4">
          {/* 左:扁平配置文字行 + 创建时间 + 输出目录(与币安详情同款,无嵌套框) */}
          <div className="flex-1 min-w-0 text-xs text-gray-500 dark:text-gray-400 space-y-1">
            <ConfigRows isZh={isZh} input={task.input} />
            <div>⏰ {isZh ? '运行频率' : 'Frequency'}：{intervalLabelDetailed(task, isZh) || (isZh ? '不重复（手动触发）' : 'Once (manual)')}</div>
            <div>{isZh ? '创建时间' : 'Created'}：{new Date(task.createdAt).toLocaleString(isZh ? 'zh-CN' : 'en-US')}</div>
            {outDir && (
              <div className="flex items-center gap-2 flex-wrap">
                <span>{isZh ? '输出目录' : 'Output'}：</span>
                {/* 点文字也能打开(保留旧交互) */}
                <button
                  type="button"
                  onClick={() => openFolder(outDir)}
                  className="text-blue-500 hover:underline text-[11px] min-w-0 truncate font-mono"
                  title={outDir}
                >
                  📂 {isZh ? '打开输出文件夹' : 'Open folder'}
                </button>
                {/* 醒目按钮:让用户一眼看到「去看自己的视频」 */}
                <button
                  type="button"
                  onClick={() => openFolder(outDir)}
                  className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-semibold bg-blue-500 text-white hover:bg-blue-600 transition-colors"
                >
                  📂 {isZh ? '打开' : 'Open'}
                </button>
              </div>
            )}
          </div>

          {/* 右:横排操作(逐字对齐币安任务详情的操作行)。
              运行中 → 绿色「生成中」胶囊 + 红色「停止」(abort pipeline + kill 子进程);
              空闲   → 手动触发提示 + 直接运行(绿) + 编辑 + 删除。 */}
          <div className="shrink-0 flex items-center gap-2">
            {isRunning ? (
              <>
                <span className="flex items-center gap-1.5 text-sm font-semibold text-green-500">
                  <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                  {stopping ? (isZh ? '停止中…' : 'Stopping…') : (isZh ? '生成中' : 'Running')}
                </span>
                <button
                  type="button"
                  onClick={handleStop}
                  disabled={stopping}
                  className="px-3 py-2 text-sm rounded-lg border border-red-300 dark:border-red-900/50 text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                >
                  {isZh ? '⏹ 停止' : '⏹ Stop'}
                </button>
              </>
            ) : (
              <>
                <span className="text-xs text-gray-400">{isZh ? '✋ 手动触发' : '✋ Manual'}</span>
                <button
                  type="button"
                  onClick={handleRerun}
                  disabled={checking}
                  className="px-3 py-2 text-sm font-semibold rounded-lg bg-green-500 text-white hover:bg-green-600 transition-colors disabled:opacity-50"
                >
                  {checking
                    ? (isZh ? '校验余额…' : 'Checking…')
                    : task.runCount > 0 ? (isZh ? '🔁 重新跑' : '🔁 Rerun') : (isZh ? '🎬 开始创作' : '🎬 Start')}
                </button>
                <button
                  type="button"
                  onClick={onEdit}
                  className="px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                >
                  {isZh ? '编辑' : 'Edit'}
                </button>
                <button
                  type="button"
                  onClick={handleDelete}
                  className={`px-3 py-2 text-sm rounded-lg border transition-colors ${
                    confirmingDelete
                      ? 'border-red-500 bg-red-500 text-white hover:bg-red-600'
                      : 'border-red-300 dark:border-red-900/50 text-red-500 hover:bg-red-500/10'
                  }`}
                >
                  {confirmingDelete ? (isZh ? '确定删除?' : 'Confirm?') : (isZh ? '删除' : 'Delete')}
                </button>
              </>
            )}
          </div>
        </div>
        {actionError && <div className="mt-2 text-xs text-red-500">{actionError}</div>}
      </div>

      {/* 运行中专属:本次运行进度 + 本次消耗(绿卡对,对齐币安 running-only pair) */}
      {isRunning && latestRun && (latestRun.steps.length > 0 || latestRun.tokensUsed > 0) && (
        <div className="mb-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="rounded-xl border-2 border-green-500/50 bg-green-500/5 dark:bg-green-500/10 noobclaw-running-glow px-4 py-3">
            <div className="text-xs font-semibold text-green-600 dark:text-green-400 mb-2 flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              {isZh ? '本次运行进度' : 'Current Run Progress'}
            </div>
            <div className="font-mono text-sm text-gray-700 dark:text-gray-200">
              🎬 <strong className="text-green-600 dark:text-green-400 text-base">{latestRun.steps.filter((s) => s.status === 'done').length}</strong>
              <span className="text-gray-400 dark:text-gray-500">/{latestRun.steps.length}</span>{' '}
              <span className="text-xs text-gray-500 dark:text-gray-400 font-sans">{isZh ? '步骤' : 'steps'}</span>
            </div>
          </div>
          <div className="rounded-xl border-2 border-green-500/50 bg-green-500/5 dark:bg-green-500/10 noobclaw-running-glow px-4 py-3">
            <div className="text-xs font-semibold text-green-600 dark:text-green-400 mb-2 flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              {isZh ? '本次消耗' : 'Current Run Cost'}
            </div>
            <div className="flex items-baseline gap-2 font-mono text-base text-green-600 dark:text-green-400 font-bold">
              {formatCreditsCost(latestRun.tokensUsed || 0, latestRun.costUsd || 0)}
            </div>
          </div>
        </div>
      )}

      {/* 统计网格(对齐币安:累计完成/累计消耗/上次完成/上次消耗/上次运行)。
          消耗换算成积分 + 美元(💎 N ≈ $X),跟币安同口径:credits=实扣积分(billable,
          非上游真实 token),$ = 服务端按 token_price_per_million 算好的权威成本。 */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
        <VStatCard
          label={isZh ? '累计完成' : 'Total Done'}
          value={`🎬 ${doneVideoCount(task.id)} ${isZh ? '个视频' : 'videos'}`}
        />
        <VStatCard
          label={isZh ? '累计消耗' : 'Total Cost'}
          value={formatCreditsCost(task.cumulativeTokens, task.cumulativeCostUsd || 0)}
        />
        <VStatCard
          label={isZh ? '上次完成' : 'Last Done'}
          value={latestRun ? (latestRun.status === 'done' ? `🎬 ${runVideoCount(latestRun)} ${isZh ? '个视频' : runVideoCount(latestRun) === 1 ? 'video' : 'videos'}` : (latestRun.status === 'running' ? (isZh ? '生成中…' : 'Running…') : (isZh ? '失败' : 'Failed'))) : '-'}
        />
        <VStatCard
          label={isZh ? '上次消耗' : 'Last Cost'}
          value={latestRun ? formatCreditsCost(latestRun.tokensUsed, latestRun.costUsd || 0) : '-'}
        />
        <VStatCard
          label={isZh ? '上次运行' : 'Last Run'}
          value={fmtRelative(task.lastRunAt, isZh)}
          onClick={latestRun ? () => onOpenRecord(latestRun.id) : undefined}
          actionLabel={latestRun ? (isZh ? '查看本次运行记录 →' : 'View run record →') : undefined}
        />
        {/* 定时任务才显「下次运行」(纯展示,暂停功能已移除 —— 定时任务到点必跑)。
            频率(每日随机 / 每3小时…)在上面「运行频率」配置行已显示,这里只放下次时刻。 */}
        {task.runInterval && task.runInterval !== 'once' && (
          <VStatCard
            label={isZh ? '下次运行' : 'Next Run'}
            value={`⏰ ${fmtNextRun(task.nextPlannedRunAt, isZh)} · ${intervalLabel(task, isZh) || ''}`}
          />
        )}
      </div>

      {/* 当前运行明细 —— 每步一个标题 + 内联流式日志框(对齐币安任务详情的
          StepLogBox:日志贴在所属步骤里)。完整成片预览 / 报错明细仍在
          「运行记录详情」看,通过下面的「查看本次运行明细 →」点进去。 */}
      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
        <h2 className="text-base font-bold dark:text-white">{isZh ? '当前运行明细' : 'Current Run Details'}</h2>
        {/* 出片去向徽章:看 publishPlatforms 是否非空(以前看 publishTarget,恒为 'local'
            → 徽章永远显示「存本地」是个 bug,勾了平台也不亮「自动发布」。已改成看真实平台列表)。 */}
        {(() => {
          const platforms = (task.input as any).publishPlatforms as string[] | undefined;
          const toLocal = !(Array.isArray(platforms) && platforms.length > 0);
          return (
            <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border font-medium ${toLocal ? 'text-sky-500 bg-sky-500/10 border-sky-500/30' : 'text-green-500 bg-green-500/10 border-green-500/30'}`}>
              {toLocal
                ? (isZh ? '📂 自动保存到本地' : '📂 Saved locally')
                : (isZh ? `🚀 自动发布 · ${platforms!.length} 平台` : `🚀 Auto-publish · ${platforms!.length}`)}
            </span>
          );
        })()}
      </div>
      {latestRun ? (
        <StepLogList isZh={isZh} steps={latestRun.steps} logs={latestRun.logs} />
      ) : (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 text-sm text-gray-500 dark:text-gray-400">
          {isZh ? '尚未运行。点上方「开始创作 / 重新跑」启动一次。' : 'Not run yet. Start a run above.'}
        </div>
      )}
      {/* 发布时有账号登录过期 → 给个跳转「我的矩阵账号」的按钮,方便用户点去重扫(对齐用户要求)。 */}
      {latestRun && latestRun.logs.some((l: any) => String(l?.message || '').includes('登录过期')) && (
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: {} }))}
          className="mt-2 w-full text-left text-sm px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/40 text-red-600 dark:text-red-400 hover:bg-red-500/20 transition-colors font-medium"
        >
          🔑 {isZh ? '有账号登录过期 · 点这里去「我的矩阵账号」重新扫码连接 →' : 'Some accounts expired · go to My Matrix Accounts to re-login →'}
        </button>
      )}

      {/* 历史运行不再内嵌在任务详情里(对齐币安:详情页只看「当前运行明细」,
          往期记录走侧栏「运行记录」tab)。「上次运行」卡片可点进最近一条记录。 */}

      {showLoginCheck && (
        <VideoLoginCheckModal
          platforms={loginCheckList}
          mainSiteOverride={loginMainSiteOverride}
          title={isZh ? '运行前登录校验' : 'Pre-run login check'}
          subtitle={materialLoginPlatforms.length > 0
            ? (isZh ? '热搜成片需:浏览器插件已连接 + 取材/发布平台已登录' : 'Hotspot run needs the extension connected and source/publish platforms logged in')
            : (isZh ? '运行前需确认浏览器插件已连接 + 各发布平台已登录' : 'Extension must be connected and all publish platforms logged in')}
          onCancel={() => setShowLoginCheck(false)}
          onConfirmed={() => { setShowLoginCheck(false); startRun(); }}
        />
      )}
    </div>
  );
};

// ── 运行记录详情(只读快照) ──────────────────────────────────────────

const VideoRunRecordDetail: React.FC<{
  isZh: boolean;
  run: VideoRunRecord;
  onBack: () => void;
}> = ({ isZh, run, onBack }) => {
  const outDir = run.outputDir || dirOf(run.outputPath);
  const handleDelete = () => {
    if (videoTaskStore.deleteRun(run.id)) onBack();
  };
  return (
    <div className="p-6 max-w-5xl mx-auto">
      <button
        type="button"
        onClick={onBack}
        className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
      >
        ← {isZh ? '返回运行记录' : 'Back to records'}
      </button>

      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <HeadBadges isZh={isZh} size="md" input={run.input} />
        <span className="text-[10px] text-gray-500 dark:text-gray-500 font-mono">#{shortId(run.id)}</span>
      </div>
      <h2 className="text-lg font-bold dark:text-white mb-1">🎬 {run.title}</h2>
      <div className="text-xs text-gray-400 mb-3">
        {isZh ? '运行于 ' : 'Ran at '}{new Date(run.startedAt).toLocaleString(isZh ? 'zh-CN' : 'en-US')}
        {run.finishedAt && <> · {isZh ? '耗时' : 'took'} {Math.max(1, Math.round((run.finishedAt - run.startedAt) / 1000))}s</>}
      </div>

      <OutputDirBar isZh={isZh} dir={outDir} />

      {/* 配置快照 */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 mb-4">
        <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">{isZh ? '本次配置' : 'Config snapshot'}</div>
        <ConfigCard isZh={isZh} input={run.input} />
      </div>

      <RunBody isZh={isZh} run={run} />

      {run.status !== 'running' && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleDelete}
            className="px-3 py-1.5 rounded-lg text-xs font-medium text-gray-500 hover:text-red-500 hover:bg-red-500/5"
          >
            🗑 {isZh ? '删除此记录' : 'Delete record'}
          </button>
        </div>
      )}
    </div>
  );
};

// ── 创建流:先选创作方式,选「AI自动成片」弹出配置弹窗 ─────────────────────

const VideoCreateFlow: React.FC<{
  isZh: boolean;
  matrixMode?: boolean;
  onCreated: (taskId: string) => void;
  onGoTasks?: () => void;
}> = ({ isZh, matrixMode, onCreated, onGoTasks }) => {
  // 4 张独立 card,各自独立向导:热搜成片 / 在线素材(AI口播)/ 电影级(纯AI)/ 模板速生。
  // (翻译二创 2026-06-11 删除:whisper 在日本网络下不通,且功能在测试期只有一个用户。)
  const [cinemaOpen, setCinemaOpen] = useState(false);     // 电影级 → VideoConfigModal forcedMode=pure_ai
  const [stockOpen, setStockOpen] = useState(false);       // 在线素材 → VideoConfigModal forcedMode=stock
  const [templateOpen, setTemplateOpen] = useState(false); // 模板速生 → TemplateSpeedModal
  const [hotspotOpen, setHotspotOpen] = useState(false);   // 热搜成片 → HotspotVideoModal
  // 热搜成片仅简体/繁体中文显示(数据源是中文热榜;韩/日/英先不支持)。繁体也走中文文案。
  const isZhHot = i18nService.currentLanguage === 'zh' || i18nService.currentLanguage === 'zh-TW';

  // v2.8: 四个视频创作任务跟币安等其它任务一样,必须先登录 NoobClaw 账号才能用。
  //   未登录点「开始创作」→ 弹账号登录框(requireLoginUI),不打开配置弹窗。
  // 满额拦截提前到【点卡片时】(与矩阵任务「入口查重」同口径):总数已到上限直接弹提示,
  //   不再让用户填完整个向导才在提交时报「已满」。查询慢(1.5s 超时)/失败放行 —— 提交时仍有兜底。
  const [limitFull, setLimitFull] = useState(false);
  const openWithLogin = (open: () => void) => async () => {
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); return; }
    try {
      const ok = await Promise.race([
        videoQueue.canCreate(),
        new Promise<boolean>((res) => setTimeout(() => res(true), 1500)),
      ]);
      if (!ok) { setLimitFull(true); return; }
    } catch { /* 查不出来放行 */ }
    open();
  };

  // 价格【服务端下发】动态显示:按条区间(stock/hotspot/模板共用)+ 纯 AI 每秒价。调价改后端即生效。
  const [fee, setFee] = useState<{ min: number; max: number }>({ min: 0.02, max: 0.1 });
  const [aiUsdPerSec, setAiUsdPerSec] = useState<number>(0.04);
  useEffect(() => {
    fetchVideoFeeRange().then(setFee).catch(() => { /* 兜底 */ });
    noobClawApi.seedanceRate('720p').then((r) => { if (r && r.usdPerSec > 0) setAiUsdPerSec(r.usdPerSec); }).catch(() => {});
  }, []);
  const feeZh = HIDE_WEB3 ? `￥${cnyFromUsd(fee.min)}~￥${cnyFromUsd(fee.max)}` : `$${fee.min}~$${fee.max}`;
  const feeEn = `$${fee.min}–${fee.max}`;
  const aiSec = aiUsdPerSec.toFixed(2);

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* 2026-06-22 用户要求:在线素材(素材)放第一、热搜成片放第二。 */}
        <VideoScenarioEntryCard isZh={isZh} accent="sky" icon="🎞️" onOpen={openWithLogin(() => setStockOpen(true))} onGoTasks={onGoTasks}
          tagZh="AI自动成片 · 在线素材" tagEn="AI Auto · Stock"
          titleZh="在线素材 · AI 口播日更" titleEn="Stock · AI Voice-over"
          descZh="低成本批量日更利器:给个主题,AI 写口播稿+配音+字幕,海量正版素材库凑齐画面,一次最多 100 条(每条独立写稿+配音,失败自动跳过)。成片自动发布 TikTok / YouTube / 抖音 / 小红书 / 视频号 等全平台。"
          descEn="Batch-publish on a budget: AI writes the script, narrates and subtitles, and pulls visuals from a huge stock library — up to 100 clips per run (each a fresh AI script + voice; failures auto-skipped). Auto-publishes to TikTok / YouTube / Douyin / Xiaohongshu / Channels and more."
          costZh={`单条约 ${feeZh}(写稿/素材/合成)`} costEn={`~${feeEn} per clip (script / stock / compose)`}
          btnZh="🎞️ 开始创作 →" btnEn="🎞️ Start →" />
        {isZhHot && (
        <VideoScenarioEntryCard isZh={isZhHot} accent="rose" icon="🔥" onOpen={openWithLogin(() => setHotspotOpen(true))} onGoTasks={onGoTasks}
          tagZh="AI自动成片 · 热搜成片" tagEn="AI Auto · Hotspot"
          titleZh="热搜成片 · 热点全自动" titleEn="Hotspot · Auto Trend Video"
          descZh="勾选热搜榜 / Web3 / 科技源,每天自动从最新热点挑一条,联网取材、AI 紧贴事实写口播、自动配图成片。一次设置、每天蹭热点出片,成片自动发布 TikTok / YouTube / 抖音 / 小红书 / 视频号 等全平台。"
          descEn="Pick Hot-Search / Web3 / Tech sources. Each day it grabs a fresh trending topic, fetches the latest info, writes a fact-tight script and auto-composes with images. Set once — auto-publishes daily to TikTok / YouTube / Douyin / Xiaohongshu / Channels and more."
          costZh={`单条约 ${feeZh}(写稿/联网/配图/合成)`} costEn={`~${feeEn} per clip (script / web / footage / compose)`}
          btnZh="🔥 开始创作 →" btnEn="🔥 Start →" />
        )}
        <VideoScenarioEntryCard isZh={isZh} accent="violet" icon="🎬" onOpen={openWithLogin(() => setCinemaOpen(true))} onGoTasks={onGoTasks}
          tagZh="AI自动成片 · 电影级" tagEn="AI Auto · Cinematic"
          titleZh="电影级 · 纯 AI 生成" titleEn="Cinematic · Pure AI"
          descZh="一句话,AI 直接造出电影感写实画面 —— 不用拍摄、不用露脸。Seedance 逐镜生成、自动配音+字幕,拍不到的镜头也能生,还能传参考图锁画风。成片自动发布 TikTok / YouTube / 抖音 / 小红书 / 视频号 等全平台。"
          descEn="One line → cinematic, photoreal footage. No filming, no face. Seedance generates brand-new shots with auto voice-over + subtitles — even shots you could never film; add reference images to lock the style. Auto-publishes to TikTok / YouTube / Douyin / Xiaohongshu / Channels and more."
          costZh={HIDE_WEB3 ? `按秒计费 · 约 ￥${cnyFromUsd(aiUsdPerSec)}/秒(720p)` : `按秒计费 · 约 $${aiSec}/秒(720p)`} costEn={`Per-second · ~$${aiSec}/s (720p)`}
          btnZh="🎬 开始创作 →" btnEn="🎬 Start →" />
        <VideoScenarioEntryCard isZh={isZh} accent="fuchsia" icon="⚡" onOpen={openWithLogin(() => setTemplateOpen(true))} onGoTasks={onGoTasks}
          tagZh="AI自动成片 · 模板速生" tagEn="AI Auto · Template Speed"
          titleZh="模板速生 · 榜单/资讯/数据" titleEn="Template Speed · Lists & Data"
          descZh="把榜单、资讯、数据、金句一键变成带动效竖屏短视频 —— AI 现编动画、本地逐帧渲染、可选配音+字幕。秒级出片、稳定可控,成片自动发布 TikTok / YouTube / 抖音 / 小红书 / 视频号 等全平台。"
          descEn="Turn lists / news / data / quotes into animated vertical shorts — AI writes the animation, rendered locally, optional voice-over + subtitles. Seconds to render, stable and controllable. Auto-publishes to TikTok / YouTube / Douyin / Xiaohongshu / Channels and more."
          costZh={`单条约 ${feeZh}(数据/写稿/合成)`} costEn={`~${feeEn} per clip (data / script / compose)`}
          btnZh="⚡ 开始生成 →" btnEn="⚡ Start →" />
      </section>

      <section className="mt-6">
        <VideoFeaturePills isZh={isZh} />
      </section>

      {/* 视频任务已满提示(点卡片即拦,与矩阵任务查重弹窗同口径) */}
      {limitFull && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-2xl p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-3">
              <span className="text-xl leading-none">⚠️</span>
              <div className="text-sm text-gray-700 dark:text-gray-200 leading-relaxed">
                {isZh
                  ? `视频任务已满(${VIDEO_TASK_LIMIT}/${VIDEO_TASK_LIMIT}),请先到「我的视频任务」删掉已完成的再新建。`
                  : `Video tasks are full (${VIDEO_TASK_LIMIT}/${VIDEO_TASK_LIMIT}). Delete a finished one in "My Videos" first.`}
              </div>
            </div>
            <div className="mt-5 flex gap-2 justify-end">
              <button type="button" onClick={() => setLimitFull(false)} className="px-4 py-2 rounded-lg text-sm border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800">{isZh ? '关闭' : 'Close'}</button>
              {onGoTasks && (
                <button type="button" onClick={() => { setLimitFull(false); onGoTasks(); }} className="px-4 py-2 rounded-lg text-sm font-semibold bg-rose-500 text-white hover:bg-rose-600">{isZh ? '去我的视频任务' : 'Go to My Videos'}</button>
              )}
            </div>
          </div>
        </div>
      )}

      {cinemaOpen && (
        <VideoConfigModal isZh={isZh} matrixMode={matrixMode} forcedMode="pure_ai" onClose={() => setCinemaOpen(false)} onCreated={onCreated} />
      )}
      {stockOpen && (
        <VideoConfigModal isZh={isZh} matrixMode={matrixMode} forcedMode="stock" onClose={() => setStockOpen(false)} onCreated={onCreated} />
      )}
      {templateOpen && (
        <TemplateSpeedModal isZh={isZh} matrixMode={matrixMode} onClose={() => setTemplateOpen(false)} onCreated={onCreated} />
      )}
      {hotspotOpen && (
        <HotspotVideoModal isZh={isZhHot} matrixMode={matrixMode} onClose={() => setHotspotOpen(false)} onCreated={onCreated} />
      )}
    </div>
  );
};

// ── 卡片 2(每日热点 · 自动成片)已移除:新建页改为「原创 + 视频搬运·二创」两张。 ──

// ── 赛道预设库:选赛道自动带出人设 + 关键词(用户可改) ─────────────────

interface TrackPreset {
  id: string;
  zh: string;
  en: string;
  persona: { zh: string; en: string };
  keywords: { zh: string; en: string };
}

const TRACK_PRESETS: TrackPreset[] = [
  {
    id: 'overseas_life', zh: '🌏 海外生活 · 日常', en: 'Overseas Life',
    persona: { zh: '在国外生活的普通人，记录真实的海外日常。租房、通勤、超市采购、节日见闻都自己拍，接地气、不滤镜、不贩卖焦虑', en: 'An ordinary person living abroad — real overseas daily life, down-to-earth, no filter, no anxiety-selling' },
    keywords: { zh: '海外生活 国外日常 租房 超市采购 异国文化 海外Vlog 留学生活 省钱攻略', en: 'overseas-life abroad daily rent supermarket culture vlog student-life save-money' },
  },
  {
    id: 'pets', zh: '🐾 萌宠 · 日常', en: 'Pets',
    persona: { zh: '养猫养狗的铲屎官,记录萌宠日常。轻松治愈、会讲细节,分享养宠经验和踩坑,真实不卖惨', en: 'A cat/dog owner sharing daily pet life — light, healing, real tips, no sob stories' },
    keywords: { zh: '萌宠日常 猫咪 狗狗 养宠攻略 宠物好物 治愈系 铲屎官 宠物搞笑', en: 'pets cat dog pet-care pet-gear healing funny-pets daily' },
  },
  {
    id: 'food', zh: '🍲 美食 · 探店做饭', en: 'Food',
    persona: { zh: '爱折腾吃喝的上班族，每天给自己做饭，也爱探店。说话热情、会种草，重点讲性价比和踩雷避坑，不浮夸', en: 'A food-loving office worker who cooks daily and explores restaurants — enthusiastic, focused on value and avoiding tourist traps' },
    keywords: { zh: '美食探店 一人食 家常菜 减脂餐 必吃榜 本地美食 空气炸锅 探店打卡', en: 'food restaurant home-cooking healthy-meal must-eat local airfryer foodie' },
  },
  {
    id: 'tech', zh: '💻 数码科技 · 测评', en: 'Tech',
    persona: { zh: '懂行的数码测评博主，自费买机、理性测评。技术名词直接说，优缺点都讲，绝不收钱吹，帮人避坑做选择', en: 'A knowledgeable gadget reviewer who buys his own gear — rational, names the pros and cons, no paid hype' },
    keywords: { zh: '数码测评 手机评测 笔记本 智能硬件 新品上手 科技 数码好物 选购指南', en: 'gadget review smartphone laptop smart-hardware hands-on tech buying-guide' },
  },
  {
    id: 'ai_tools', zh: '🤖 AI 工具 · 效率', en: 'AI Tools',
    persona: { zh: '天天用 AI 干活的效率党，把 ChatGPT / 各种 AI 工具用到飞起。讲人话、给可复制的实操，不空谈概念', en: 'A productivity nerd who uses AI daily — plain talk, copy-paste workflows, no empty hype' },
    keywords: { zh: 'AI工具 ChatGPT 效率提升 AI办公 提示词 自动化 AI神器 副业AI', en: 'ai-tools chatgpt productivity ai-office prompts automation ai-gems' },
  },
  {
    id: 'finance', zh: '💰 财经 · 理财科普', en: 'Finance',
    persona: { zh: '通俗讲钱的财经科普博主，冷静中立。只做知识科普,不荐股、不喊单、不给个性化投资建议,帮人建立常识', en: 'A finance explainer — calm and neutral, knowledge only, no stock tips, no personalized advice' },
    keywords: { zh: '财经科普 理财入门 攒钱方法 基金定投 经济趋势 记账 工资理财 钱生钱', en: 'finance personal-finance saving fund-investing economy budgeting salary money' },
  },
  {
    id: 'crypto', zh: '₿ 加密货币 · Web3', en: 'Crypto · Web3',
    persona: { zh: '把区块链讲清楚的 Web3 科普博主，客观中立。只讲原理和行业动态,不喊单、不带单、不预测价格,提示风险', en: 'A Web3 explainer who makes blockchain clear — objective, no shilling, no price calls, always flags risk' },
    keywords: { zh: '加密货币 区块链 web3 比特币 以太坊 行情解读 链上数据 钱包安全', en: 'crypto blockchain web3 bitcoin ethereum market-analysis on-chain wallet-security' },
  },
  {
    id: 'fitness', zh: '💪 健身 · 减脂日记', en: 'Fitness',
    persona: { zh: '边上班边坚持健身一年的过来人，167cm 从 130 减到 108 斤。正能量但不打鸡血，讲可执行的方法,反对极端节食', en: 'A 9-to-5 worker who lost weight over a year — positive, actionable, anti crash-dieting' },
    keywords: { zh: '居家健身 减脂打卡 增肌 体态矫正 减脂餐 HIIT 健身小白 拉伸', en: 'home-workout fat-loss muscle posture healthy-meal hiit beginner stretching' },
  },
  {
    id: 'travel', zh: '✈️ 旅行 · 攻略分享', en: 'Travel',
    persona: { zh: '爱说走就走的旅行爱好者，一年出去 6-8 次。分享性价比攻略和小众目的地，治愈、令人向往，重实操路线', en: 'A spontaneous traveler — value-focused guides and hidden gems, soothing and aspirational' },
    keywords: { zh: '旅行攻略 周末去哪 小众目的地 citywalk 自驾游 机票便宜 民宿推荐 旅行vlog', en: 'travel-guide weekend-trip hidden-gems citywalk road-trip cheap-flights homestay vlog' },
  },
  {
    id: 'outfit', zh: '👗 穿搭 · 风格分享', en: 'Outfit',
    persona: { zh: '小个子职场穿搭爱好者，155cm。分享通勤、约会、微胖显瘦的实穿搭配，精致但不端着，重点给平价替代', en: 'A petite office-wear blogger (155cm) — wearable commute/date looks, polished, affordable picks' },
    keywords: { zh: '小个子穿搭 通勤穿搭 OOTD 微胖穿搭 法式穿搭 显瘦 气质穿搭 平价单品', en: 'petite-outfit commute-wear ootd plus-size french-style slimming chic affordable' },
  },
  {
    id: 'beauty', zh: '💄 美妆 · 护肤测评', en: 'Beauty',
    persona: { zh: '敏感肌护肤爱好者，研究护肤 8 年、被坑过很多钱。成分党、只推真用过的，讲实测感受不夸大,帮新手避雷', en: 'A sensitive-skin skincare nerd of 8 years — ingredient-driven, only recommends what she has tested' },
    keywords: { zh: '平价护肤 敏感肌 成分党 粉底测评 口红试色 早C晚A 防晒 空瓶记', en: 'affordable-skincare sensitive-skin ingredients foundation lipstick vitamin-c sunscreen empties' },
  },
  {
    id: 'career', zh: '📈 职场 · 成长干货', en: 'Career',
    persona: { zh: '过来人式的职场博主，互联网公司中层。分享沟通、汇报、升职、跳槽的实操干货，实在不灌鸡汤,讲方法和案例', en: 'A been-there career blogger (mid-level in tech) — concrete tips on comms, promotion, job-hopping; no fluff' },
    keywords: { zh: '职场成长 沟通技巧 升职加薪 跳槽 简历 汇报 副业 效率工具', en: 'career-growth communication promotion job-hopping resume reporting side-hustle productivity' },
  },
  {
    id: 'side_hustle', zh: '💼 副业 · 打工人赚钱', en: 'Side Hustle',
    persona: { zh: '下班搞副业一年的普通打工人，杭州互联网运营。真诚不装,只分享自己真做过的副业、真实收入和踩过的坑,不卖课', en: 'A regular worker doing a side hustle after hours — honest, only shares what he actually tried, no course-selling' },
    keywords: { zh: '副业推荐 下班变现 0基础副业 AI副业 在家赚钱 自媒体 兼职 副业项目', en: 'side-hustle monetize beginner-friendly ai-side-hustle work-from-home creator part-time projects' },
  },
  {
    id: 'study_abroad', zh: '🎓 留学 · 申请经验', en: 'Study Abroad',
    persona: { zh: '过来人留学博主，自己申过、踩过坑。耐心细致地讲选校、文书、签证、落地生活，给可照做的清单,不贩卖焦虑', en: 'A study-abroad veteran — patient, detailed guidance on school choice, essays, visas, settling in' },
    keywords: { zh: '留学申请 选校 文书 签证 语言考试 留学生活 落地攻略 奖学金', en: 'study-abroad school-choice essays visa language-test student-life settling scholarship' },
  },
  {
    id: 'parenting', zh: '🧸 育儿 · 亲子日常', en: 'Parenting',
    persona: { zh: '理性育儿不焦虑的妈妈，娃 3 岁。分享科学育儿、绘本、辅食、亲子游戏，温和实在,讲方法不制造焦虑', en: 'A calm, science-minded mom of a 3-year-old — gentle, practical tips on early-ed, books, feeding' },
    keywords: { zh: '科学育儿 早教 绘本推荐 辅食 亲子游戏 母婴好物 新手妈妈 亲子阅读', en: 'parenting early-education picture-books baby-food games baby-gear new-mom reading' },
  },
  {
    id: 'reading', zh: '📚 读书 · 书单笔记', en: 'Reading',
    persona: { zh: '一年读 40-50 本书的普通读者，从事文化行业。分享书单、读后感、读书方法，安静走心,推荐真读过的书', en: 'A reader of ~45 books a year in the culture industry — book lists, reflections, reading methods' },
    keywords: { zh: '读书笔记 年度书单 好书推荐 读书打卡 小说推荐 非虚构 读书方法 书评', en: 'reading-notes annual-booklist recommendations reading-log fiction nonfiction methods reviews' },
  },
  {
    id: 'funny', zh: '😂 搞笑 · 段子娱乐', en: 'Funny',
    persona: { zh: '专做搞笑短视频的博主，节奏快、有梗、会反转。贴近生活、不低俗，让人刷到忍不住笑出来', en: 'A short-form comedy creator — fast-paced, punchy, with twists; relatable and clean, makes you laugh out loud' },
    keywords: { zh: '搞笑视频 沙雕日常 神反转 搞笑段子 整活 名场面 爆笑 解压', en: 'funny comedy skit twist meme hilarious relatable stress-relief' },
  },
  {
    id: 'emotion', zh: '💗 情感 · 共鸣治愈', en: 'Emotion',
    persona: { zh: '讲情感、聊人生的博主，真诚走心。说大白话、给共鸣和温暖,不灌鸡汤、不制造对立', en: 'An emotion / life blogger — sincere and warm, plain talk that resonates, no toxic positivity' },
    keywords: { zh: '情感共鸣 治愈文案 人生感悟 走心 emo 自我成长 温暖 深夜', en: 'emotion healing life-insight heartfelt growth warmth late-night' },
  },
  {
    id: 'rural', zh: '🌾 三农 · 乡村生活', en: 'Rural Life',
    persona: { zh: '记录乡村生活的博主，种地、赶集、家常饭都自己拍。真实质朴、烟火气足，让城里人向往慢生活', en: 'A countryside-life creator — farming, markets, home cooking; authentic, full of life, makes city folks long for the slow life' },
    keywords: { zh: '乡村生活 三农 农村日常 田园 种地 赶大集 农家饭 慢生活', en: 'rural countryside farming village field market farm-food slow-life' },
  },
];

// ── 配置弹窗(两步向导,模态;支持新建 + 编辑) ────────────────────────

type GenMode = 'stock' | 'pure_ai';
type OutputMode = 'local' | 'upload';
// 9 个发布平台,跟 src/main/libs/video/publishers/types.VideoPlatform 严格对齐 ——
// 改这一行必须同步改 publishers/types.ts,否则 pipeline 运行期收不到对应 platform id。
// TikTok / YouTube 暂不支持视频发布,从可选平台里去掉(driver/枚举保留,以后支持再加回 UI)。
type Platform = 'douyin' | 'xhs' | 'binance' | 'x' | 'tiktok' | 'bilibili' | 'kuaishou' | 'shipinhao' | 'toutiao';
// 顺序 = 展示顺序 = 发布顺序(改一处即可)。用户要求:抖音/小红书/快手【最前】;币安/推特/TikTok【最后】。
const PUBLISH_PLATFORMS: Array<{ id: Platform; zh: string; en: string; emoji: string }> = [
  { id: 'douyin',    zh: '抖音',     en: 'Douyin',      emoji: '🎵' },
  { id: 'xhs',       zh: '小红书',   en: 'Xiaohongshu', emoji: '📕' },
  { id: 'kuaishou',  zh: '快手',     en: 'Kuaishou',    emoji: '⚡' },
  { id: 'shipinhao', zh: '视频号',   en: 'Channels',    emoji: '🟢' },
  { id: 'toutiao',   zh: '头条号',   en: 'Toutiao',     emoji: '🟠' },
  { id: 'bilibili',  zh: 'B 站',     en: 'Bilibili',    emoji: '📺' },
  { id: 'binance',   zh: '币安广场', en: 'Binance',     emoji: '🟡' },
  { id: 'x',         zh: '推特',     en: 'X / Twitter', emoji: '🐦' },
  { id: 'tiktok',    zh: 'TikTok',   en: 'TikTok',      emoji: '🎬' },
];
// 新建任务默认勾选的平台(用户要求):抖音/小红书/快手/视频号/头条号/B站;币安/推特/TikTok 默认不勾。
// 四个视频任务(ai/stock/hotspot/template)新建时都默认「发布到平台」+ 勾这 6 个;编辑老任务仍恢复保存值。
const DEFAULT_PUBLISH_PLATFORMS: Platform[] = ['douyin', 'xhs', 'kuaishou', 'shipinhao', 'toutiao', 'bilibili'];

const SCRIPT_MAX = 800;
// 严格模式:视频文案逐字朗读,直接决定时长 → 必填且不少于此字数。
const SCRIPT_MIN_STRICT = 200;
// 中文配音约 4.5 字/秒;严格模式据此把字数实时换算成预估时长展示给用户。
const CHARS_PER_SEC = 4.5;
const DURATION_OPTIONS = [30, 45, 60, 90, 120, 180, 240];
// 纯 AI(Seedance)成片成本随秒数线性涨 → 时长上限 90s(UI 给到 30/45/60/90;>90 不给)。
const AI_MAX_SECONDS = 90;

// ── MPT 风格出片参数选项 ──
const ASPECT_OPTIONS: { id: VideoAspect; zh: string; en: string; icon: string }[] = [
  { id: '9:16', zh: '竖屏 9:16', en: 'Portrait 9:16', icon: '📱' },
  { id: '16:9', zh: '横屏 16:9', en: 'Landscape 16:9', icon: '🖥️' },
  { id: '1:1', zh: '方形 1:1', en: 'Square 1:1', icon: '🔲' },
];

// edge-tts voice 候选(name 直传 sidecar)。按语种 / 地区分组,UI 用 <optgroup> 渲染避免下拉框塌成一长条。
// ⚠️ 改这里的 id 时,同步检查 src/main/libs/video/tts.ts 的 getVoiceFallbacks 表
//   (后台失败救场链);否则改名后失败 voice 没救场直接退费。
type VoiceOpt = { id: string; zh: string; en: string };
const VOICE_GROUPS: { groupZh: string; groupEn: string; voices: VoiceOpt[] }[] = [
  {
    groupZh: '中文 · 普通话', groupEn: 'Chinese · Mandarin',
    voices: [
      { id: 'zh-CN-XiaoxiaoNeural', zh: '晓晓 · 女声(温柔)',  en: 'Xiaoxiao · female (gentle)' },
      { id: 'zh-CN-XiaoyiNeural',   zh: '晓伊 · 女声(活泼)',  en: 'Xiaoyi · female (lively)' },
      { id: 'zh-CN-YunxiNeural',    zh: '云希 · 男声(阳光)',  en: 'Yunxi · male (sunny)' },
      { id: 'zh-CN-YunjianNeural',  zh: '云健 · 男声(浑厚)',  en: 'Yunjian · male (deep)' },
      { id: 'zh-CN-YunyangNeural',  zh: '云扬 · 男声(播音)',  en: 'Yunyang · male (anchor)' },
    ],
  },
  {
    groupZh: '中文 · 方言 / 港台', groupEn: 'Chinese · Dialects / HK & TW',
    voices: [
      { id: 'zh-CN-liaoning-XiaobeiNeural', zh: '晓北 · 东北女声',       en: 'Xiaobei · NE female' },
      { id: 'zh-HK-HiuGaaiNeural',          zh: '晓佳 · 粤语女声',       en: 'HiuGaai · Cantonese female' },
      { id: 'zh-HK-HiuMaanNeural',          zh: '晓敏 · 粤语女声',       en: 'HiuMaan · Cantonese female' },
      { id: 'zh-HK-WanLungNeural',          zh: '云龙 · 粤语男声',       en: 'WanLung · Cantonese male' },
      { id: 'zh-TW-HsiaoChenNeural',        zh: '曉臻 · 台湾国语女声',   en: 'HsiaoChen · TW Mandarin female' },
      { id: 'zh-TW-YunJheNeural',           zh: '雲哲 · 台湾国语男声',   en: 'YunJhe · TW Mandarin male' },
    ],
  },
  {
    groupZh: '英文 · 美式', groupEn: 'English · US',
    voices: [
      { id: 'en-US-JennyNeural',   zh: 'Jenny · 英文女声',         en: 'Jenny · EN female' },
      { id: 'en-US-AriaNeural',    zh: 'Aria · 英文女声(沉稳)',   en: 'Aria · EN female (poised)' },
      { id: 'en-US-EmmaNeural',    zh: 'Emma · 英文女声(亲切)',   en: 'Emma · EN female (warm)' },
      { id: 'en-US-GuyNeural',     zh: 'Guy · 英文男声',           en: 'Guy · EN male' },
      { id: 'en-US-AndrewNeural',  zh: 'Andrew · 英文男声(浑厚)', en: 'Andrew · EN male (deep)' },
      { id: 'en-US-BrianNeural',   zh: 'Brian · 英文男声(轻快)',  en: 'Brian · EN male (bright)' },
    ],
  },
  // —— 其他语种按【亚洲(日/韩) → 东南亚(印尼/越) → 拉美(西/葡) → 欧洲(法) → 中东(阿)】排,
  //   按华人圈出海短视频 + Binance 重点市场用户密度递减。
  {
    groupZh: '日语', groupEn: 'Japanese',
    voices: [
      { id: 'ja-JP-NanamiNeural',  zh: '七海 · 日语女声', en: 'Nanami · JA female' },
      { id: 'ja-JP-KeitaNeural',   zh: '圭太 · 日语男声', en: 'Keita · JA male' },
    ],
  },
  {
    groupZh: '韩语', groupEn: 'Korean',
    voices: [
      { id: 'ko-KR-SunHiNeural',   zh: '鲜熹 · 韩语女声', en: 'SunHi · KO female' },
      { id: 'ko-KR-InJoonNeural',  zh: '仁俊 · 韩语男声', en: 'InJoon · KO male' },
    ],
  },
  {
    groupZh: '印尼语', groupEn: 'Indonesian',
    voices: [
      { id: 'id-ID-GadisNeural',   zh: 'Gadis · 印尼语女声', en: 'Gadis · ID female' },
      { id: 'id-ID-ArdiNeural',    zh: 'Ardi · 印尼语男声',  en: 'Ardi · ID male' },
    ],
  },
  {
    groupZh: '越南语', groupEn: 'Vietnamese',
    voices: [
      { id: 'vi-VN-HoaiMyNeural',   zh: 'HoaiMy · 越南语女声',  en: 'HoaiMy · VI female' },
      { id: 'vi-VN-NamMinhNeural',  zh: 'NamMinh · 越南语男声', en: 'NamMinh · VI male' },
    ],
  },
  {
    groupZh: '西语 · 拉美', groupEn: 'Spanish · LatAm',
    voices: [
      { id: 'es-MX-DaliaNeural',   zh: 'Dalia · 西语女声(拉美)', en: 'Dalia · ES-MX female' },
      { id: 'es-MX-JorgeNeural',   zh: 'Jorge · 西语男声(拉美)', en: 'Jorge · ES-MX male' },
    ],
  },
  {
    groupZh: '葡语 · 巴西', groupEn: 'Portuguese · Brazil',
    voices: [
      { id: 'pt-BR-FranciscaNeural', zh: 'Francisca · 葡语女声(巴西)', en: 'Francisca · PT-BR female' },
      { id: 'pt-BR-AntonioNeural',   zh: 'Antonio · 葡语男声(巴西)',   en: 'Antonio · PT-BR male' },
    ],
  },
  {
    groupZh: '法语', groupEn: 'French',
    voices: [
      { id: 'fr-FR-DeniseNeural',  zh: 'Denise · 法语女声', en: 'Denise · FR female' },
      { id: 'fr-FR-HenriNeural',   zh: 'Henri · 法语男声',  en: 'Henri · FR male' },
    ],
  },
  {
    groupZh: '阿拉伯语', groupEn: 'Arabic',
    voices: [
      { id: 'ar-SA-ZariyahNeural', zh: 'Zariyah · 阿拉伯语女声', en: 'Zariyah · AR-SA female' },
      { id: 'ar-SA-HamedNeural',   zh: 'Hamed · 阿拉伯语男声',   en: 'Hamed · AR-SA male' },
    ],
  },
];

// 在线素材「创作语言」:决定 AI 口播稿(及字幕)语言;auto = 按文案/关键词自动探测(原行为)。
// 码值 = 主进程 scriptWriter.ContentLang;选项只列有配音音色的语种(阿拉伯语 RTL 字幕未验,先不放)。
// voicePrefixes 用于「选了语言后音色不匹配 → 自动切到该语种默认音色」的联动。
const SCRIPT_LANGS: { code: string; zh: string; en: string; voicePrefixes: string[]; defaultVoice: string }[] = [
  { code: 'auto',  zh: '自动(按文案/关键词)', en: 'Auto (detect)', voicePrefixes: [], defaultVoice: '' },
  { code: 'zh',    zh: '简体中文', en: 'Chinese (Simplified)',  voicePrefixes: ['zh-'], defaultVoice: 'zh-CN-YunjianNeural' },
  { code: 'zh-TW', zh: '繁體中文', en: 'Chinese (Traditional)', voicePrefixes: ['zh-TW', 'zh-HK'], defaultVoice: 'zh-TW-HsiaoChenNeural' },
  { code: 'en',    zh: 'English',  en: 'English',    voicePrefixes: ['en-'], defaultVoice: 'en-US-JennyNeural' },
  { code: 'ja',    zh: '日本語',   en: 'Japanese',   voicePrefixes: ['ja-'], defaultVoice: 'ja-JP-NanamiNeural' },
  { code: 'ko',    zh: '한국어',   en: 'Korean',     voicePrefixes: ['ko-'], defaultVoice: 'ko-KR-SunHiNeural' },
  { code: 'id',    zh: 'Bahasa Indonesia', en: 'Indonesian', voicePrefixes: ['id-'], defaultVoice: 'id-ID-GadisNeural' },
  { code: 'vi',    zh: 'Tiếng Việt', en: 'Vietnamese', voicePrefixes: ['vi-'], defaultVoice: 'vi-VN-HoaiMyNeural' },
  { code: 'es',    zh: 'Español',  en: 'Spanish',    voicePrefixes: ['es-'], defaultVoice: 'es-MX-DaliaNeural' },
  { code: 'pt',    zh: 'Português', en: 'Portuguese', voicePrefixes: ['pt-'], defaultVoice: 'pt-BR-FranciscaNeural' },
  { code: 'fr',    zh: 'Français', en: 'French',     voicePrefixes: ['fr-'], defaultVoice: 'fr-FR-DeniseNeural' },
];

/** 创作/生成语言展示标签:'auto'/空 = 返回 null(跟内容走,详情页不占一行)。 */
function scriptLangDisplay(code: string | undefined, isZh: boolean): string | null {
  const c = (code || '').trim();
  if (!c || c === 'auto') return null;
  const o = SCRIPT_LANGS.find((l) => l.code === c);
  return o ? (isZh ? o.zh : o.en) : c;
}

// 本地内置背景音乐(随包 bundle 在 resources/bgm/,来源 MoneyPrinterTurbo 免版税曲库)。
// value 用 builtin:<id> token 传给主进程,bgm.ts 还原成 resources/bgm/<id>.mp3。
// id 必须与 client/resources/bgm/<id>.mp3 文件名(去扩展名)一致。
const BUILTIN_BGM_PREFIX = 'builtin:';
const BUILTIN_BGM: { id: string; zh: string; en: string }[] = [
  { id: 'bgm-01', zh: '内置曲目 1', en: 'Track 1' },
  { id: 'bgm-02', zh: '内置曲目 2', en: 'Track 2' },
  { id: 'bgm-03', zh: '内置曲目 3', en: 'Track 3' },
  { id: 'bgm-04', zh: '内置曲目 4', en: 'Track 4' },
  { id: 'bgm-05', zh: '内置曲目 5', en: 'Track 5' },
  { id: 'bgm-06', zh: '内置曲目 6', en: 'Track 6' },
  { id: 'bgm-07', zh: '内置曲目 7', en: 'Track 7' },
  { id: 'bgm-08', zh: '内置曲目 8', en: 'Track 8' },
];

// 云端曲库:本地只存 8 首,其余放服务端清单(我们手动传 R2 后把中英标题+下载链接配进
// manifest.json)。用户选中后,合成时主进程才按需下载并缓存(见 bgm.ts)。
// value 用 remote:<url> token 传给主进程。清单 URL 走 CDN(static.noobclaw.com),
// 加 ?t= 绕缓存;清单还没上线时 fetch 失败 → 云端列表为空,只展示本地 8 首。
const REMOTE_BGM_PREFIX = 'remote:';
const REMOTE_BGM_MANIFEST_URL = 'https://static.noobclaw.com/bgm/manifest.json';
interface RemoteBgm { id: string; zh: string; en: string; url: string }

/** 把 bgmPath(''/builtin:/remote:/绝对路径)显示成人类可读的名字。 */
function bgmDisplayName(bgmPath: string, isZh: boolean, remote: RemoteBgm[] = []): string {
  if (!bgmPath) return isZh ? '无' : 'none';
  if (bgmPath.startsWith(BUILTIN_BGM_PREFIX)) {
    const id = bgmPath.slice(BUILTIN_BGM_PREFIX.length);
    const item = BUILTIN_BGM.find((b) => b.id === id);
    return item ? (isZh ? item.zh : item.en) : (isZh ? '内置音乐' : 'built-in');
  }
  if (bgmPath.startsWith(REMOTE_BGM_PREFIX)) {
    const url = bgmPath.slice(REMOTE_BGM_PREFIX.length);
    const item = remote.find((b) => b.url === url);
    if (item) return `${isZh ? item.zh : item.en}${isZh ? '（云端）' : ' (cloud)'}`;
    return (url.split('/').pop() || (isZh ? '云端音乐' : 'cloud')) + (isZh ? '（云端）' : ' (cloud)');
  }
  return bgmPath.split(/[\\/]/).pop() || (isZh ? '已选' : 'set');
}

const RATE_OPTIONS: { v: number; zh: string; en: string }[] = [
  { v: -25, zh: '慢', en: 'Slow' },
  { v: -10, zh: '稍慢', en: 'Slower' },
  { v: 0, zh: '正常', en: 'Normal' },
  { v: 15, zh: '稍快', en: 'Faster' },
  { v: 30, zh: '快', en: 'Fast' },
];

const SUB_POSITION_OPTIONS: { id: SubtitlePosition; zh: string; en: string }[] = [
  { id: 'top', zh: '顶部', en: 'Top' },
  { id: 'center', zh: '居中', en: 'Center' },
  { id: 'lower', zh: '中下', en: 'Lower' },
  { id: 'bottom', zh: '底部', en: 'Bottom' },
];

const SUB_FONTSIZE_OPTIONS: { v: number; zh: string; en: string }[] = [
  { v: 42, zh: '小', en: 'S' },
  { v: 52, zh: '中', en: 'M' },
  { v: 64, zh: '大', en: 'L' },
  { v: 80, zh: '超大', en: 'XL' },
  { v: 100, zh: '特大', en: 'XXL' },
];

// 字幕文字颜色调色板(抄 MoneyPrinterTurbo:几个高对比常用色)。
const SUB_COLOR_OPTIONS: { v: string; zh: string; en: string }[] = [
  { v: '#FFFFFF', zh: '白', en: 'White' },
  { v: '#FFE600', zh: '黄', en: 'Yellow' },
  { v: '#00E5FF', zh: '青', en: 'Cyan' },
  { v: '#FF4D4F', zh: '红', en: 'Red' },
  { v: '#000000', zh: '黑', en: 'Black' },
];

// 字幕描边颜色(空串 = 不描边,沿用半透明黑底盒)。
const SUB_STROKE_OPTIONS: { v: string; zh: string; en: string }[] = [
  { v: '', zh: '无', en: 'None' },
  { v: '#000000', zh: '黑', en: 'Black' },
  { v: '#FFFFFF', zh: '白', en: 'White' },
  { v: '#3A0CA3', zh: '紫', en: 'Purple' },
];

// 字幕字体:value = resources/fonts/ 下的字体文件名(空 = 默认思源黑体)。
// 全部 SIL OFL / 可商用 + CJK 全覆盖,随包 bundle;新增字体在此加一行 + 把文件丢进 fonts/。
const SUB_FONT_OPTIONS: { v: string; zh: string; en: string }[] = [
  { v: '', zh: '思源黑体（默认）', en: 'Source Han Sans' },
  { v: 'SmileySans-Oblique.ttf', zh: '得意黑', en: 'Smiley Sans' },
];

// 一次出片条数:stock 在 main.ts 外层循环 1~100 条(每条 AI 独立写稿+配音,失败跳过,按条计费);
//   AI(Seedance)/模板/热搜维持单条。pipeline 内部的 composeOne 批量(复用脚本换画面)已不再走。

// 换镜节奏:每段素材最长秒数,越小切得越快。
const PACE_OPTIONS: { v: number; zh: string; en: string }[] = [
  { v: 2.5, zh: '快切', en: 'Fast cuts' },
  { v: 4, zh: '适中', en: 'Medium' },
  { v: 6, zh: '舒缓', en: 'Slow' },
];

// BGM 音量档(0~1),混在旁白之下,默认中等。
const BGM_VOLUME_OPTIONS: { v: number; zh: string; en: string }[] = [
  { v: 0.1, zh: '轻', en: 'Soft' },
  { v: 0.18, zh: '中', en: 'Medium' },
  { v: 0.3, zh: '强', en: 'Loud' },
];

// 画面来源:在线素材库自动搜 vs 用户上传本地视频素材拼接。
type MaterialSource = 'stock' | 'local' | 'ai';
const MAX_LOCAL_VIDEOS = 20;

// 模式一(AI 分镜 + 在线素材)生成前的余额门槛:积分 > 此值才放行。门槛权威值由服务端
// 下发(system_config.video_min_balance,admin 后台可调),这里的常量只是【拉不到时的兜底】。
// 一条成片平台基础费约 $0.09~$0.18(≈9~18 万积分,token_price=1.0 口径),加上 DeepSeek
// 写稿(Pro reasoner ×3)的 token,200000 ≈ 1~2 条 buffer,确保不会"生成到一半余额扣穿"。
// 注:一次任务即使批量出多条也只收【一份】平台费,所以门槛不随条数翻倍。
const VIDEO_MODE1_MIN_BALANCE = 200000;

// 服务端下发的余额门槛缓存(60s)。/api/video/config 需登录态;拉不到 → 用上面的兜底常量。
let _minBalanceCache: { value: number; at: number } | null = null;
async function fetchVideoMinBalance(): Promise<number> {
  if (_minBalanceCache && Date.now() - _minBalanceCache.at < 60_000) return _minBalanceCache.value;
  try {
    const res = await fetch(`${getBackendApiUrl()}/api/video/config`, {
      headers: noobClawAuth.getAuthHeaders(),
    });
    if (res.ok) {
      const data = await res.json();
      const mb = Number(data?.config?.minBalance);
      if (Number.isFinite(mb) && mb > 0) {
        _minBalanceCache = { value: mb, at: Date.now() };
        return mb;
      }
    }
  } catch { /* 网络/未登录 → 兜底 */ }
  return VIDEO_MODE1_MIN_BALANCE;
}

// 平台基础费区间(USD)由服务端下发(/api/video/config 的 feeUsdMin/feeUsdMax,admin 可调),
// 卡片/向导价格文案据此动态显示 —— 调价改后端即生效,不打包客户端。拉不到 → $0.02~$0.1 兜底。
let _feeCache: { min: number; max: number; at: number } | null = null;
async function fetchVideoFeeRange(): Promise<{ min: number; max: number }> {
  if (_feeCache && Date.now() - _feeCache.at < 60_000) return { min: _feeCache.min, max: _feeCache.max };
  try {
    const res = await fetch(`${getBackendApiUrl()}/api/video/config`, { headers: noobClawAuth.getAuthHeaders() });
    if (res.ok) {
      const data = await res.json();
      const min = Number(data?.config?.feeUsdMin);
      const max = Number(data?.config?.feeUsdMax);
      if (Number.isFinite(min) && Number.isFinite(max) && min >= 0 && max >= min) {
        _feeCache = { min, max, at: Date.now() };
        return { min, max };
      }
    }
  } catch { /* 网络/未登录 → 兜底 */ }
  return { min: 0.02, max: 0.1 };
}

const VideoConfigModal: React.FC<{
  isZh: boolean;
  onClose: () => void;
  onCreated: (taskId: string) => void;
  /** 传入则为【编辑】模式:预填该任务配置,保存走 updateTask(不立即跑)。 */
  editTask?: VideoTask;
  /** 编辑保存成功回调。 */
  onSaved?: () => void;
  /** 新建时锁定生成模式(电影级=pure_ai / 在线素材=stock):隐藏模式选择步,直接从赛道开始。 */
  forcedMode?: GenMode;
  /** 矩阵号 edition:发布平台下多一步「选账号」,发布走指纹内核 CDP。 */
  matrixMode?: boolean;
}> = ({ isZh, onClose, onCreated, editTask, onSaved, forcedMode, matrixMode }) => {
  const isEdit = !!editTask;
  // forcedMode(从「电影级 / 在线素材」card 进来)锁定模式 → 跳过 step1 模式选择,从 step2(赛道)起。
  // 矩阵号在「出片(7)」后多插一步「账号(8)」。
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5 | 6 | 7 | 8>(forcedMode ? 2 : 1);
  // 出片(7)= 本地/上传去向 + 频率 + 条数;发布(8)= 发布平台 + 每平台选号(matrix)。
  // 对齐热搜成片:平台与账号【同一步】,且与「出片去向」分开成独立的「发布」步。
  const PUBLISH_STEP = 8 as const;
  const MAX_STEP = 8;

  // 新建默认选中「美食」赛道,并带出其人设/关键词;编辑模式按已有任务反推。
  const defaultPreset = TRACK_PRESETS.find((p) => p.id === 'food')
    || TRACK_PRESETS.find((p) => p.id !== 'custom') || TRACK_PRESETS[0];
  const initialTrackId = (() => {
    if (!editTask) return defaultPreset.id;
    const t = editTask.input.track;
    const found = TRACK_PRESETS.find((p) => (isZh ? p.zh : p.en) === t);
    return found ? found.id : '';   // 匹配不到预设 → 不选(自定义档已下线)
  })();

  // 步骤 1:文案(新建时人设/关键词从默认赛道带出,可改)
  const [trackId, setTrackId] = useState(initialTrackId);
  const [persona, setPersona] = useState(
    editTask ? (editTask.input.persona || '') : (isZh ? defaultPreset.persona.zh : defaultPreset.persona.en),
  );
  const [keywords, setKeywords] = useState(
    editTask ? (editTask.input.keywords || []).join(' ') : (isZh ? defaultPreset.keywords.zh : defaultPreset.keywords.en),
  );
  // 矩阵号第2步「选号」:选中账号后用该号的 group(赛道)/persona/keywords 生成,不再手填。
  // identityPlatform/identityAccountId 用于第2步选号 UI,并随 input 持久化 —— 编辑时回填平台高亮
  // 和已选账号(老任务没存这俩字段则回落空,仅靠下方身份摘要块展示)。matrixTrack 存该号赛道。
  const [identityPlatform, setIdentityPlatform] = useState<string>(editTask?.input.identityPlatform || '');
  const [identityAccountId, setIdentityAccountId] = useState<string>(editTask?.input.identityAccountId || '');
  const [matrixTrack, setMatrixTrack] = useState<string>(editTask?.input.track || '');
  const [script, setScript] = useState(editTask?.input.script || '');
  // 文案模式:strict 严格逐字 / ai 参考再创作。编辑老任务时按 input 推断(无字段则有文案=strict)。
  const [scriptMode, setScriptMode] = useState<'strict' | 'ai'>(
    editTask?.input.scriptMode || ((editTask?.input.script || '').trim() ? 'strict' : 'ai'),
  );
  // forcedMode='pure_ai'(电影级 card 跳过了 step1 的模式选择)→ 补回 step1 会做的纯AI默认:
  //   时长拉到纯AI上限内(否则停在 90 超 AI_MAX_SECONDS)。
  const [targetSeconds, setTargetSeconds] = useState(forcedMode === 'pure_ai' ? 30 : (editTask?.input.targetSeconds ?? 90));

  // 步骤 2:画面(素材来源 / 在线模式 / 本地素材 / 画幅 / 换镜)
  const [materialSource, setMaterialSource] = useState<MaterialSource>(
    forcedMode === 'pure_ai' ? 'ai'
      : forcedMode === 'stock' ? 'stock'
      : editTask?.input.engine === 'ai' ? 'ai'
      : (editTask?.input.localVideos && editTask.input.localVideos.length > 0) ? 'local'
      : 'stock',
  );
  const [localVideos, setLocalVideos] = useState<string[]>(editTask?.input.localVideos || []);
  // AI 自动成片(Seedance):参考图(≤2,风格/人设统一)+ 清晰度(480/720,用户可选)。
  const [referenceImages, setReferenceImages] = useState<string[]>(editTask?.input.referenceImages || []);
  // 清晰度:480p / 720p 二选一(传后端;单价/千token 不变,只是 720p token 数更多)。默认 720p。
  const [seedanceResolution, setSeedanceResolution] = useState<'480p' | '720p'>(
    editTask?.input.seedanceResolution === '480p' ? '480p' : '720p');
  // 纯AI 每秒卖价($/秒)+ 每秒积分,由服务端按清晰度算,动态展示(不写死)。
  const [aiUsdPerSec, setAiUsdPerSec] = useState<number | null>(null);
  const [aiCreditsPerSec, setAiCreditsPerSec] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    noobClawApi.seedanceRate(seedanceResolution).then((r) => {
      if (alive && r) { setAiUsdPerSec(r.usdPerSec); setAiCreditsPerSec(r.creditsPerSec); }
    });
    return () => { alive = false; };
  }, [seedanceResolution]);
  // Seedance 档位 / 分辨率客户端不再决定:不传,后端按 system_config 定(admin 可切 1.0/1.5 测试)。
  const [mode, setMode] = useState<GenMode>(forcedMode ?? (editTask?.input.engine === 'ai' ? 'pure_ai' : 'stock'));
  const [aspect, setAspect] = useState<VideoAspect>(editTask?.input.aspect || '9:16');
  const [maxClipSeconds, setMaxClipSeconds] = useState<number>(editTask?.input.maxClipSeconds ?? 4);

  // 步骤 3:音频(创作语言 / 音色 / 语速 / 背景音乐 / BGM 音量)
  // 创作语言(仅在线素材/本地素材模式):决定 AI 口播稿语言;'auto' = 按文案/关键词探测(老行为,老任务无此字段也走它)。
  const [scriptLang, setScriptLang] = useState<string>(editTask?.input.scriptLang || 'auto');
  const [voice, setVoice] = useState<string>(editTask?.input.voice || 'zh-CN-YunjianNeural');
  // 选定语言后,若当前音色语种不匹配 → 自动切到该语言默认音色(仍可手动改回)。
  const pickScriptLang = (code: string) => {
    setScriptLang(code);
    const opt = SCRIPT_LANGS.find((l) => l.code === code);
    if (opt && opt.code !== 'auto' && opt.voicePrefixes.length && !opt.voicePrefixes.some((p) => voice.startsWith(p))) {
      setVoice(opt.defaultVoice);
    }
  };
  const [voiceRate, setVoiceRate] = useState<number>(editTask?.input.voiceRate ?? 0);
  // BGM 默认选中第 1 首内置曲目(新建任务);编辑老任务时沿用其已存值(空也保留空)。
  const [bgmPath, setBgmPath] = useState<string>(
    editTask ? (editTask.input.bgmPath || '') : `${BUILTIN_BGM_PREFIX}${BUILTIN_BGM[0].id}`,
  );
  const [bgmVolume, setBgmVolume] = useState<number>(editTask?.input.bgmVolume ?? 0.18);
  // 云端曲库清单(从 CDN 拉;失败/未上线时为空,只显示本地 8 首)。
  const [remoteBgm, setRemoteBgm] = useState<RemoteBgm[]>([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const resp = await fetch(`${REMOTE_BGM_MANIFEST_URL}?t=${Date.now()}`);
        if (!resp.ok) return;
        const json: any = await resp.json();
        const arr: any[] = Array.isArray(json) ? json : json?.tracks;
        if (!alive || !Array.isArray(arr)) return;
        setRemoteBgm(
          arr
            .filter((x) => x && typeof x.url === 'string' && x.url)
            .map((x) => ({
              id: String(x.id || x.url),
              zh: String(x.zh || x.title || x.name || '云端音乐'),
              en: String(x.en || x.title || x.name || 'Cloud track'),
              url: String(x.url),
            })),
        );
      } catch { /* 清单未上线 / 网络失败:静默,仅用本地曲库 */ }
    })();
    return () => { alive = false; };
  }, []);

  // 步骤 4:字幕 + 出片
  // 字幕开关回填规则:
  //   · 新建:默认开(在线/本地素材无内嵌字幕,必须烧录才有字幕;纯 AI 没配音时这步会被
  //     上面的「纯画面模式」分支挡掉,值无所谓)。
  //   · 编辑【纯 AI(engine==='ai')】:按任务【实际保存值】回填 —— 建时开了字幕(配音+字幕)
  //     就回填开,不能因为是 AI 引擎就一律强制关(否则用户每次编辑都丢掉字幕设置)。
  //   · 编辑【在线/本地素材】:始终默认开,忽略早期以 pure_ai 建过残留的 subtitleEnabled=false。
  const [subtitleEnabled, setSubtitleEnabled] = useState<boolean>(
    editTask
      ? (editTask.input.engine === 'ai' ? editTask.input.subtitleEnabled === true : true)
      : true,
  );
  // 纯 AI(Seedance)是否额外加「AI 配音 + 字幕」。电影级 card(forcedMode='pure_ai')默认【开】
  //   —— 补回 step1 纯AI onClick 的 setAiNarration(true)(用户要求纯AI字幕默认打开);用户仍可在
  //   「音频」步关掉走纯画面。编辑态按任务实际保存值回填。
  const [aiNarration, setAiNarration] = useState<boolean>(
    // 编辑态:永远按任务实际保存值回填(即便也传了 forcedMode 来跳过 step1,也不能用
    // forcedMode 的「默认开」覆盖用户原设置)。新建态:电影级(forcedMode='pure_ai')默认开。
    isEdit
      ? (editTask?.input.engine === 'ai' && editTask?.input.narrationEnabled === true)
      : (forcedMode === 'pure_ai' ? true : false));
  const [subtitleFontSize, setSubtitleFontSize] = useState<number>(editTask?.input.subtitleFontSize ?? 64);
  const [subtitlePosition, setSubtitlePosition] = useState<SubtitlePosition>(editTask?.input.subtitlePosition || 'bottom');
  const [subtitleColor, setSubtitleColor] = useState<string>(editTask?.input.subtitleColor || '#FFFFFF');
  const [subtitleStrokeColor, setSubtitleStrokeColor] = useState<string>(editTask?.input.subtitleStrokeColor ?? '');
  // 字幕字体:空 = 默认思源黑体;其余为 resources/fonts/ 下的字体文件名。
  const [subtitleFont, setSubtitleFont] = useState<string>(editTask?.input.subtitleFont ?? '');

  // 字幕样式默认值(仅新建任务,编辑老任务保留其已存设置):
  //   烧字幕统一默认 = 大号 64 + 黄字 + 黑描边(短视频画面上最醒目)。
  //   用户进字幕步手动改的会保留(mode 不变就不重置)。
  useEffect(() => {
    if (editTask) return;
    setSubtitleColor('#FFE600');
    setSubtitleStrokeColor('#000000');
    setSubtitleFontSize(64);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, editTask]);
  // 一次出片条数(1~5)。复用脚本/配音、每条不同画面组合。默认 1(只跑一次),
  // 用户想批量再手动往上调。
  const [videoCount, setVideoCount] = useState<number>(editTask?.input.videoCount ?? 1);
  // 定时运行(参照抖音):'once' 仅手动;其余自动重复。daily 才用 dailyTime。
  const [runInterval, setRunInterval] = useState<VideoRunInterval>(editTask?.runInterval || 'once');
  // 视频任务已去掉「每日定时」选项,dailyTime 仅作占位默认值(不再可编辑)。
  const [dailyTime] = useState<string>(editTask?.dailyTime || '08:00');
  // 编辑态必须从 input.publishPlatforms 反推 outputMode:否则编辑一个「上传」任务时
  // outputMode 恒为 'local' → 平台勾选区被隐藏、buildInput 又把 publishPlatforms 写成 []
  // → 保存后任务被悄悄改回「仅存本地」(详情页看不见发布信息、运行也只存本地)。
  const [outputMode, setOutputMode] = useState<OutputMode>(() => {
    if (!editTask) return 'upload'; // 新建默认「发布到平台」(用户要求)
    const pub = (editTask?.input as any)?.publishPlatforms;
    return Array.isArray(pub) && pub.length > 0 ? 'upload' : 'local';
  });
  // 新建默认勾抖音 + 小红书(国内最大两个);编辑老任务从 input.publishPlatforms 反推。
  const [platforms, setPlatforms] = useState<Record<Platform, boolean>>(() => {
    const init: Record<Platform, boolean> = {
      douyin: false, xhs: false, binance: false, x: false, tiktok: false,
      bilibili: false, kuaishou: false, shipinhao: false, toutiao: false,
    };
    const editList = Array.isArray((editTask?.input as any)?.publishPlatforms)
      ? ((editTask!.input as any).publishPlatforms as string[]) : null;
    if (editList && editList.length > 0) {
      editList.forEach((p) => { if (p in init) init[p as Platform] = true; });
    } else if (!editTask) {
      // 新建默认勾选(用户要求):抖音/小红书/快手/视频号/头条号/B站
      DEFAULT_PUBLISH_PLATFORMS.forEach((p) => { init[p] = true; });
    }
    return init;
  });
  // 纯 AI / 在线素材 都不再给自定义发布文案输入框(用户要求,统一 AI 自动写)→ 只保留值(编辑老任务回填用),
  // 不需要 setter;新建时为空 → buildInput 传 undefined → 出片时 AI 自动生成标题/正文/话题。
  const [publishTitle] = useState<string>((editTask?.input as any)?.publishTitle || '');
  const [publishCaption] = useState<string>((editTask?.input as any)?.publishCaption || '');

  const [submitError, setSubmitError] = useState<string | null>(null);

  const onPickTrack = (id: string) => {
    setTrackId(id);
    const preset = TRACK_PRESETS.find((t) => t.id === id);
    if (preset && id !== 'custom') {
      setPersona(isZh ? preset.persona.zh : preset.persona.en);
      setKeywords(isZh ? preset.keywords.zh : preset.keywords.en);
    }
  };

  // 本地视频素材:可多选追加,封顶 MAX_LOCAL_VIDEOS。
  const pickLocalVideos = async () => {
    const remaining = MAX_LOCAL_VIDEOS - localVideos.length;
    if (remaining <= 0) return;
    const paths = await videoCreationService.pickVideos(remaining);
    if (paths.length) setLocalVideos((prev) => [...prev, ...paths].slice(0, MAX_LOCAL_VIDEOS));
  };
  const removeLocalVideo = (idx: number) => setLocalVideos((prev) => prev.filter((_, i) => i !== idx));

  // AI 自动成片:参考图(≤2),做风格/人设统一。可选,不传也能纯文生视频。
  const pickReferenceImages = async () => {
    const remaining = 2 - referenceImages.length;
    if (remaining <= 0) return;
    const paths = await videoCreationService.pickReferenceImages(remaining);
    if (paths.length) setReferenceImages((prev) => [...prev, ...paths].slice(0, 2));
  };
  const removeReferenceImage = (idx: number) => setReferenceImages((prev) => prev.filter((_, i) => i !== idx));

  // 背景音乐:选一首本地音频;再点一次「移除」清空。
  const pickBgm = async () => {
    const p = await videoCreationService.pickBgm();
    if (p) setBgmPath(p);
  };

  // BGM「打开文件夹」:原内嵌试听在部分环境播放不稳,改为直接打开该 BGM 所在【目录】,
  // 用户自己进去双击试听。后端返回的是目录(不下载、不要求文件已存在),比定位单文件健壮:
  // 内置 → 打开随包 bgm 目录(8 首都在);云端 → 打开缓存目录(已下载的在);上传 → 文件目录。
  const [bgmOpening, setBgmOpening] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const openBgmFolder = async (token: string) => {
    if (!token || bgmOpening) return;
    setBgmOpening(true);
    try {
      const dir = await videoCreationService.resolveBgmPath(token); // 现在返回目录
      if (dir) {
        try { (window as any).electron?.shell?.openPath?.(dir); } catch { /* ignore */ }
        setPreviewError('');
      } else {
        setPreviewError(isZh ? '打开失败：找不到 BGM 目录' : 'Failed: BGM folder not found');
      }
    } catch {
      setPreviewError(isZh ? '打开失败：无法打开 BGM 目录' : 'Failed to open the BGM folder');
    } finally {
      setBgmOpening(false);
    }
  };
  // 切换曲目时清掉上一首的「打开失败」红字,避免残留误导(选 A 失败 → 切 B 仍显红字)。
  useEffect(() => { setPreviewError(''); }, [bgmPath]);

  const togglePlatform = (p: Platform) => setPlatforms((prev) => ({ ...prev, [p]: !prev[p] }));

  // BGM 三态:'' = 无;builtin:/remote: = 曲库(本地内置+云端);其它绝对路径 = 用户上传。
  const bgmIsBuiltin = bgmPath.startsWith(BUILTIN_BGM_PREFIX);
  const bgmIsRemote = bgmPath.startsWith(REMOTE_BGM_PREFIX);
  const bgmIsLibrary = bgmIsBuiltin || bgmIsRemote;
  const bgmIsUpload = !!bgmPath && !bgmIsLibrary;
  // 编辑老任务时,选的云端曲目可能还没在已拉到的清单里 → 补一个占位 option,避免下拉空白。
  const bgmInLibraryList = bgmIsBuiltin
    ? BUILTIN_BGM.some((b) => `${BUILTIN_BGM_PREFIX}${b.id}` === bgmPath)
    : bgmIsRemote
      ? remoteBgm.some((b) => `${REMOTE_BGM_PREFIX}${b.url}` === bgmPath)
      : true;

  const scriptLen = script.trim().length;
  // 严格模式据字数预估时长(向上取整,中文约 4.5 字/秒)。
  const strictEstSec = Math.max(1, Math.round(scriptLen / CHARS_PER_SEC));
  // 文案校验:
  //   strict 严格逐字:必填、≥SCRIPT_MIN_STRICT 字、≤SCRIPT_MAX 字(直接决定时长)。
  //   ai 参考:选填,填了则不超上限。
  const scriptValid = scriptMode === 'strict'
    ? (scriptLen >= SCRIPT_MIN_STRICT && scriptLen <= SCRIPT_MAX)
    : (scriptLen === 0 || scriptLen <= SCRIPT_MAX);
  // 赛道步:非矩阵只校验赛道必选;矩阵号必须选好账号(编辑老任务可沿用已存身份不强制重选)。
  const trackStepValid = matrixMode ? (!!identityAccountId || isEdit) : (trackId !== '');
  // 文案步:只校验文案本身。
  const scriptStepValid = scriptValid;
  // 画面:选了本地上传却没传素材时挡一下
  // AI 自动成片:参考图可选,无硬性必填;在线:无必填;本地:至少 1 个上传。
  // 「画面」步通过条件 — pure_ai 模式下 mode 就够了(参考图选填);stock 模式下需要选定来源。
  const visualStepValid = mode === 'pure_ai' || materialSource === 'stock' || localVideos.length > 0;

  // 矩阵号:赛道来自所选账号(matrixTrack);非矩阵:来自预设赛道。
  const trackLabel = matrixMode
    ? (matrixTrack || editTask?.input.track || '')
    : (TRACK_PRESETS.find((t) => t.id === trackId)?.[isZh ? 'zh' : 'en'] || editTask?.input.track || '');

  const buildTitle = (): string => {
    const kw = keywords.split(/[,，\s]+/).map((k) => k.trim()).filter(Boolean);
    const head = kw.slice(0, 2).join(' / ');
    const base = head || trackLabel || (isZh ? '视频创作' : 'Video');
    if (scriptMode === 'strict') return `${base}（${isZh ? '严格文案' : 'strict'} · ${scriptLen}${isZh ? '字' : 'ch'}）`;
    return `${base}（AI ${isZh ? '写稿' : 'script'} · ${targetSeconds}s）`;
  };

  const buildInput = (): VideoCreationInput => ({
    persona: persona.trim(),
    track: trackLabel,
    keywords: keywords.split(/[,，\s]+/).map((k) => k.trim()).filter(Boolean),
    script: script.trim(),
    scriptMode,
    // engine / seedance / target 等以 mode 为唯一真相源 — 之前以 materialSource 派生,
    // 但 React state 异步 + closure 边界 case 下,用户切「纯 AI→AI 口播稿」时 mode
    // 已切回 'stock',materialSource 可能还停在 'ai',结果 engine 错派 'ai' 跑了 Seedance
    // (用户反馈:选了「AI 口播稿+素材库」结果扣了 200w+ 积分跑了 4 镜 Seedance)。
    // 现在 mode 决定 engine,materialSource 只在 stock 模式下区分「在线 vs 本地」,
    // pure_ai 模式 materialSource 视而不见,无串台可能。
    engine: mode === 'pure_ai' ? 'ai' : 'stock',
    // 档位/分辨率不再由客户端传 → 后端按 system_config 决定(可在 admin 切 1.0/1.5/分辨率测试)。
    // 清晰度用户可选(480/720)传后端;档位仍服务端定(seedanceModel 不传)。
    seedanceResolution: mode === 'pure_ai' ? seedanceResolution : undefined,
    seedanceModel: undefined,
    referenceImages: mode === 'pure_ai' ? referenceImages.slice(0, 2) : [],
    // 素材来源二选一,不混拼:仅 stock 模式下的 local 来源才带 localVideos;
    //   pure_ai 永远不传 localVideos(Seedance 自动生成,不读本地素材)。
    localVideos: mode === 'stock' && materialSource === 'local' && localVideos.length > 0 ? localVideos : undefined,
    aspect,
    // publishTarget 已废弃,不再写(实际发布看 publishPlatforms)。
    // 出片完成后,pipeline 会 iterator forEach 这个数组调对应 driver。
    // 「存本地不上传」→ 空数组(pipeline 推「📂 未选发布平台 · 仅存本地」);
    // 「上传到各大平台」→ 用户勾选的几个 id(未登录的运行期跳过)。
    publishPlatforms: outputMode === 'upload' ? selectedPlatformIds : [],
    // 矩阵号:身份选号(第2步)持久化 —— 编辑时回填平台高亮 + 已选账号。
    identityPlatform: matrixMode && identityPlatform ? identityPlatform : undefined,
    identityAccountId: matrixMode && identityAccountId ? identityAccountId : undefined,
    // 矩阵号:每个发布平台选定的账号(平台→accountId),发布时按号走 CDP。仅取已勾平台的映射。
    publishAccounts: matrixMode && outputMode === 'upload'
      ? Object.fromEntries(selectedPlatformIds.filter((p) => accountByPlatform[p]).map((p) => [p, accountByPlatform[p]]))
      : undefined,
    // 账号【名字】也存一份(平台→名),详情/记录页直接展示「上传到 抖音(账号1-涛涛)」。
    publishAccountNames: matrixMode && outputMode === 'upload'
      ? Object.fromEntries(selectedPlatformIds.filter((p) => accountByPlatform[p]).map((p) => { const a = matrixAccounts.find((x) => x.id === accountByPlatform[p]); return [p, a ? (a.nickname || a.displayName) : accountByPlatform[p]]; }))
      : undefined,
    // 自定义发布文案(选填);空 = AI 自动生成。仅在要上传时带上。
    publishTitle: outputMode === 'upload' && publishTitle.trim() ? publishTitle.trim() : undefined,
    publishCaption: outputMode === 'upload' && publishCaption.trim() ? publishCaption.trim() : undefined,
    // 纯 AI(Seedance)每秒都真烧钱 → 写稿时长封顶 45s(UI 也不给 >45s 选项);
    // 其它模式(在线素材/本地)免费拼接,不限。
    targetSeconds: mode === 'pure_ai' ? Math.min(targetSeconds, AI_MAX_SECONDS) : targetSeconds,
    // 在线来源 = 搜在线素材库(收平台费);本地/AI = 不搜在线。AI 的钱在服务端逐片段扣。
    useStockVideo: mode === 'stock' && materialSource === 'stock',
    // 创作语言:仅 stock 模式生效;'auto' 不传 = 主进程按文案/关键词探测(老行为)。
    scriptLang: mode === 'stock' && scriptLang !== 'auto' ? scriptLang : undefined,
    voice,
    voiceRate,
    // Seedance(pure_ai):默认纯画面(关旁白 + 不烧字幕);用户在「音频」步开了「AI 配音」
    //   → narrationEnabled=true,跟普通模式一样配音 + 按字幕开关烧录。
    narrationEnabled: mode === 'pure_ai' ? (aiNarration ? true : false) : undefined,
    bgmPath: bgmPath || undefined,
    bgmVolume,
    subtitleEnabled: mode === 'pure_ai' ? (aiNarration && subtitleEnabled) : subtitleEnabled,
    subtitleFontSize,
    subtitlePosition,
    subtitleColor: subtitleColor || undefined,
    subtitleStrokeColor: subtitleStrokeColor || undefined,
    subtitleFont: subtitleFont || undefined,
    maxClipSeconds,
    videoCount,
  });

  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    const input = buildInput();
    // daily 才带 dailyTime,其余间隔不需要(避免存无意义的时刻)。
    const schedule: VideoSchedule = {
      runInterval,
      dailyTime: runInterval === 'daily' ? dailyTime : undefined,
    };
    if (isEdit && editTask) {
      // 编辑:保存配置 + 定时,不立即跑(用户回详情页再点重跑)。
      const ok = videoTaskStore.updateTask(editTask.id, input, buildTitle(), schedule);
      if (!ok) {
        setSubmitError(isZh ? '任务正在运行,无法编辑。' : 'Task is running, cannot edit.');
        return;
      }
      onSaved?.();
      return;
    }
    // 新建:对齐币安等 scenario 任务——【只校验「视频」大类列表总数 ≤5(含已完成)】,
    // 不校验余额、不立即运行。余额由【运行时】(详情页「开始创作」)把关;创建只落任务。
    if (submitting) return;            // 防连点:创建中再点直接忽略,避免建出多个
    setSubmitting(true);
    try {
      if (!(await videoQueue.canCreate())) {
        setSubmitError(isZh
          ? `视频任务已满(${VIDEO_TASK_LIMIT}/${VIDEO_TASK_LIMIT}),请先到「我的视频任务」删掉已完成的再新建。`
          : `Video tasks full (${VIDEO_TASK_LIMIT}/${VIDEO_TASK_LIMIT}). Delete a finished one in "My Videos" first.`);
        return;
      }
      const id = videoTaskStore.createTask(input, buildTitle(), schedule);
      onCreated(id);
    } finally {
      setSubmitting(false);
    }
  };

  // 用户勾选的发布平台 id 数组 —— 写到 input.publishPlatforms,pipeline 据此 forEach 调 driver。
  // 按 PUBLISH_PLATFORMS 顺序取(不用 Object.keys)→ 发布顺序 = 列表顺序(B 站在最后),改一处列表即可
  const selectedPlatformIds = PUBLISH_PLATFORMS.map((m) => m.id).filter((p) => platforms[p]);

  // ── 矩阵号:每个发布平台选一个账号(平台→accountId),发布走指纹内核 CDP(同 HotspotVideoModal)。──
  const [matrixAccounts, setMatrixAccounts] = useState<MatrixAcctLite[]>([]);
  const [accountByPlatform, setAccountByPlatform] = useState<Record<string, string>>(
    () => (matrixMode && (editTask?.input as any)?.publishAccounts && typeof (editTask!.input as any).publishAccounts === 'object' ? { ...(editTask!.input as any).publishAccounts } : {}),
  );
  useEffect(() => {
    if (!matrixMode) return;
    let alive = true;
    (async () => {
      try {
        const r = await (window as any).electron?.matrix?.listAccounts?.();
        const accs: any[] = r?.ok && Array.isArray(r.accounts) ? r.accounts : [];
        if (alive) setMatrixAccounts(accs.map((a) => ({ id: a.id, platform: a.platform, displayName: a.displayName, status: a.status, nickname: a.nickname, displayId: a.displayId, avatar: a.avatar, loginScope: a.loginScope, group: a.group, persona: a.persona, keywords: a.keywords })));
      } catch { if (alive) setMatrixAccounts([]); }
    })();
    return () => { alive = false; };
  }, [matrixMode]);
  // 发布上传:快手只列「创作者中心」账号(主站号没有 cp 发布登录态)。
  const accountsFor = (platform: string) => matrixAccounts.filter((a) => a.platform === platform && (platform !== 'kuaishou' || a.loginScope === 'creator'));
  // 第2步「选号」:平台→账号。身份选号不限快手主站/创作端(只取该号的赛道/人设/关键词,与发布登录态无关)。
  const identityPlatforms = Array.from(new Set(matrixAccounts.map((a) => a.platform)));
  const identityAccounts = matrixAccounts.filter((a) => a.platform === identityPlatform);
  // 选中账号 → 用该号的 group(赛道)/persona/keywords 覆盖生成参数(不再让用户手填)。
  const onPickIdentityAccount = (id: string) => {
    setIdentityAccountId(id);
    const a = matrixAccounts.find((x) => x.id === id);
    if (a) {
      setMatrixTrack(a.group || '');
      setPersona(a.persona || '');
      setKeywords((a.keywords || []).join(' '));
    }
  };
  // 新建:账号加载完只默认高亮第一个账号所在【平台】(方便直接在该平台选号),不自动选中账号
  // —— 账号必须用户手动挑,挑中后才带出该号赛道/人设/关键词(编辑保留已存身份不覆盖)。
  // ⚠️ 只初始化一次(ref):否则切平台时会 setIdentityAccountId('') 触发本 effect,又把平台/账号
  //    重置回第一个 → 表现为「点其他平台 tab 一直闪、切不动」。
  const didInitIdentityRef = useRef(false);
  useEffect(() => {
    if (!matrixMode || isEdit || didInitIdentityRef.current) return;
    const first = matrixAccounts[0];
    if (!first) return;
    didInitIdentityRef.current = true;
    setIdentityPlatform((prev) => prev || first.platform);
  }, [matrixMode, isEdit, matrixAccounts]);
  // 编辑态回填选号高亮:identityPlatform/identityAccountId 是后加字段,老任务没存 → 平台/账号不高亮
  //   (但身份卡有数据,因为它读的是一直存的 track/persona/keywords)。这里在账号加载好后,
  //   若这俩为空就【用已存身份反推账号】:优先精确 id 命中,否则按 group+persona+keywords 匹配,
  //   匹配到就回填平台高亮 + 选中账号。只做一次(ref),不覆盖用户在弹窗里的手动改动。
  const didBackfillIdentityRef = useRef(false);
  useEffect(() => {
    if (!matrixMode || !isEdit || didBackfillIdentityRef.current) return;
    if (!matrixAccounts.length) return;
    if (identityPlatform && identityAccountId) { didBackfillIdentityRef.current = true; return; }
    const storedId = editTask?.input.identityAccountId || '';
    const track = (editTask?.input.track || '').trim();
    const persona = (editTask?.input.persona || '').trim();
    const kw = (editTask?.input.keywords || []).join(' ').trim();
    const match = matrixAccounts.find((a) => a.id === storedId)
      || matrixAccounts.find((a) => (a.group || '').trim() === track && (a.persona || '').trim() === persona && (a.keywords || []).join(' ').trim() === kw && (track || persona || kw))
      || matrixAccounts.find((a) => (a.group || '').trim() === track && (a.persona || '').trim() === persona && (track || persona));
    if (match) {
      didBackfillIdentityRef.current = true;
      setIdentityPlatform((prev) => prev || match.platform);
      setIdentityAccountId((prev) => prev || match.id);
    }
  }, [matrixMode, isEdit, matrixAccounts, identityPlatform, identityAccountId, editTask]);
  const matrixAccountsReady = !matrixMode || outputMode !== 'upload'
    || selectedPlatformIds.every((p) => !!accountByPlatform[p] && accountsFor(p).some((a) => a.id === accountByPlatform[p] && a.status !== 'login_required'));

  // 决策①:要发布(upload 模式 + 勾了平台)时,保存前必须先过【全平台登录校验】(全登录才放行)。
  const [showLoginCheck, setShowLoginCheck] = useState(false);
  const needPublishLoginCheck = outputMode === 'upload' && selectedPlatformIds.length > 0;
  const handleFinalClick = () => {
    // 矩阵号:发布按账号走 CDP,不弹扩展登录校验;但每个发布平台都要选好号(平台+账号都在发布步 8)。
    if (matrixMode) {
      if (outputMode === 'upload' && selectedPlatformIds.length === 0) {
        setStep(PUBLISH_STEP);
        setSubmitError(isZh ? '已选「发布到平台」,请至少勾选一个平台(或改回「仅存本地」)' : 'Pick at least one platform, or switch to "Local only"');
        return;
      }
      if (outputMode === 'upload' && !matrixAccountsReady) {
        setStep(PUBLISH_STEP);
        setSubmitError(isZh ? '请为每个发布平台选择一个账号(没有账号的平台请先去「我的矩阵账号」添加)' : 'Pick an account for each platform first');
        return;
      }
      void handleSubmit();
      return;
    }
    if (needPublishLoginCheck) { setSubmitError(null); setShowLoginCheck(true); }
    else { void handleSubmit(); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* 遮罩 */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      {/* 弹窗主体:flex 列布局 → 头/底固定,中间内容区内部滚动(内容多时「下一步」按钮不会被挤出屏外) */}
      <div className="relative w-full max-w-2xl h-[85vh] flex flex-col rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-2xl">
        <div className="shrink-0 px-6 pt-6 pb-3 border-b border-gray-100 dark:border-gray-800 flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold dark:text-white flex items-center gap-2">
              🎬 {isEdit
                ? (isZh ? '编辑视频任务' : 'Edit video task')
                : mode === 'stock' ? (isZh ? '在线素材 · AI 口播日更' : 'Stock · AI Voice-over')
                : mode === 'pure_ai' ? (isZh ? '电影级 · 纯 AI 生成' : 'Cinematic · Pure AI')
                : (isZh ? '原创短视频 · AI自动成片' : 'Original Short · AI Auto-Video')}
            </h3>
            <div className="flex items-center gap-2 mt-3">
              {!forcedMode && (
                <>
                  <StepDot n={1} active={step === 1} done={step > 1} label={isZh ? '模式' : 'Mode'} />
                  <div className={`h-px w-6 ${step > 1 ? 'bg-rose-500' : 'bg-gray-200 dark:bg-gray-700'}`} />
                </>
              )}
              {/* forcedMode(从卡片进来跳过 step1「模式」)时显示编号 -1 → 选号=1…发布=7,不从 2 起 */}
              <StepDot n={forcedMode ? 1 : 2} active={step === 2} done={step > 2} label={isZh ? (matrixMode ? '选号' : '赛道') : (matrixMode ? 'Account' : 'Track')} />
              <div className={`h-px w-6 ${step > 2 ? 'bg-rose-500' : 'bg-gray-200 dark:bg-gray-700'}`} />
              <StepDot n={forcedMode ? 2 : 3} active={step === 3} done={step > 3} label={isZh ? '文案' : 'Script'} />
              <div className={`h-px w-6 ${step > 3 ? 'bg-rose-500' : 'bg-gray-200 dark:bg-gray-700'}`} />
              <StepDot n={forcedMode ? 3 : 4} active={step === 4} done={step > 4} label={isZh ? '画面' : 'Visuals'} />
              <div className={`h-px w-6 ${step > 4 ? 'bg-rose-500' : 'bg-gray-200 dark:bg-gray-700'}`} />
              <StepDot n={forcedMode ? 4 : 5} active={step === 5} done={step > 5} label={(mode === 'pure_ai' && !aiNarration) ? (isZh ? '音乐' : 'Music') : (isZh ? '音频' : 'Audio')} />
              {/* Seedance 纯画面(未开 AI 配音)无字幕步 → 隐藏「字幕」圆点 + 一段连接线 */}
              {!(mode === 'pure_ai' && !aiNarration) && (
                <>
                  <div className={`h-px w-6 ${step > 5 ? 'bg-rose-500' : 'bg-gray-200 dark:bg-gray-700'}`} />
                  <StepDot n={forcedMode ? 5 : 6} active={step === 6} done={step > 6} label={isZh ? '字幕' : 'Subtitles'} />
                </>
              )}
              <div className={`h-px w-6 ${step > 6 ? 'bg-rose-500' : 'bg-gray-200 dark:bg-gray-700'}`} />
              <StepDot n={forcedMode ? 6 : 7} active={step === 7} done={step > 7} label={isZh ? '出片' : 'Output'} />
              <div className={`h-px w-6 ${step > 7 ? 'bg-rose-500' : 'bg-gray-200 dark:bg-gray-700'}`} />
              <StepDot n={forcedMode ? 7 : 8} active={step === 8} done={false} label={isZh ? '发布' : 'Publish'} />
            </div>
          </div>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {/* ── 步骤 1:生成模式(先定这条视频怎么做)── */}
          {step === 1 && (
            <>
              <Field label={isZh ? '生成模式' : 'Generation mode'} hint={isZh ? '先选这条视频怎么做' : 'how this video is made'}>
                <div className="grid grid-cols-1 gap-2">
                  <ModeOption
                    active={mode === 'stock'}
                    onClick={() => {
                      setMode('stock'); if (materialSource === 'ai') setMaterialSource('stock');
                      // 在线素材/本地素材没有内嵌字幕,必须烧录才有字幕 → 切到该模式默认开字幕。
                      setSubtitleEnabled(true);
                      // 字幕默认(中号/白字/无描边)由上面的 useEffect 随 mode 联动设置。
                    }}
                    title={isZh ? 'AI 口播稿 + 素材库/本地' : 'AI voice-over script + stock'}
                    desc={isZh ? '给个主题，AI 自动写稿 + 配音 + 剪辑，一键出成片，无需真人出镜、不用露脸。最适合知识科普 / 资讯解说 / 好物种草；下一步「画面」二选一：在线素材库自动配图，或全部用你上传的本地视频' : 'Give it a topic — AI writes, narrates and edits a finished video. No camera, no face needed. Perfect for explainers / news recaps / product picks; in the Visuals step pick ONE: auto online stock, or all your own uploaded clips'}
                    cost={isZh ? (HIDE_WEB3 ? '单条约 ￥0.14~￥0.72' : '单条约 $0.02~$0.1') : '~$0.02–0.1 per clip'}
                    costTag={isZh ? '性价比高 · 推荐' : 'Best value'}
                  />
                  <ModeOption
                    active={mode === 'pure_ai'}
                    onClick={() => {
                      setMode('pure_ai'); setMaterialSource('ai');
                      // 纯 AI 默认【开 AI 配音 + 烧字幕】(字幕需配音文本)。用户想要纯画面可在「音频」步关掉。
                      setAiNarration(true);
                      setSubtitleEnabled(true);
                      // 纯 AI 成片时长上限 45s:目标时长超了就拉回(否则选择器无高亮 + 会被截)。
                      if (targetSeconds > AI_MAX_SECONDS) setTargetSeconds(30);
                      // 字幕默认(大号 64/黄字/黑描边)由上面的 useEffect 随 mode 联动设置。
                    }}
                    title={isZh ? '✨ 纯 AI 生成（Seedance）' : '✨ Pure AI (Seedance)'}
                    desc={isZh ? '想要的画面,AI 直接造 —— 不用拍摄、不用找素材、不用露脸。给个主题,Seedance 逐镜生成全新画面,自动配 AI 配音 + 字幕,一条成片直接出炉。脑洞 / 概念 / 想象类内容的最强搭子,现实里拍不到的画面也能生出来;还能传参考图锁定画风与人设。' : 'Whatever you picture, AI makes it — no filming, no stock, no face on camera. Give a topic and Seedance generates brand-new footage shot by shot, auto-adds AI voice-over + subtitles, and outputs a finished video. The best fit for creative / concept / imaginative content — even shots you could never film; add reference images to lock the style & character.'}
                    cost={isZh
                      ? (HIDE_WEB3 ? `按秒计费 · 约 ￥${cnyFromUsd(aiUsdPerSec ?? 0.04)}/秒(${seedanceResolution})` : `按秒计费 · 约 $${(aiUsdPerSec ?? 0.04).toFixed(2)}/秒(${seedanceResolution})`)
                      : `Per-second · ~$${(aiUsdPerSec ?? 0.04).toFixed(2)}/s (${seedanceResolution})`}
                    costTag={isZh ? '最贴近文案 / 画质最佳' : 'Closest to script / Best quality'}
                  />
                </div>
              </Field>
            </>
          )}

          {/* ── 步骤 2(矩阵号):选号 —— 选中账号后用该号的赛道 / 人设 / 关键词生成,不再手填 ── */}
          {step === 2 && matrixMode && (
            <>
              <Field label={isZh ? '选择账号（必选）' : 'Account (required)'} hint={isZh ? '用该账号的赛道 / 人设 / 关键词生成，无需手填' : "uses the account's track / persona / keywords"}>
                {matrixAccounts.length === 0 ? (
                  <button
                    type="button"
                    onClick={() => { window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', {})); onClose(); }}
                    className="w-full text-left px-3 py-2 rounded-lg border border-dashed border-rose-400 text-rose-500 text-xs hover:bg-rose-500/5"
                  >
                    {isZh ? '⚠️ 暂无矩阵账号 · 点此去「我的矩阵账号」连接 →' : '⚠️ No matrix account · link one in "My Matrix Accounts" →'}
                  </button>
                ) : (
                  <div className="space-y-2">
                    {/* 先选平台 */}
                    <div className="flex flex-wrap gap-1.5">
                      {identityPlatforms.map((p) => (
                        <button
                          key={p}
                          type="button"
                          onClick={() => { setIdentityPlatform(p); setIdentityAccountId(''); }}
                          className={`text-xs px-2.5 py-1 rounded-full border ${identityPlatform === p ? 'border-rose-500 bg-rose-500/10 text-rose-500' : 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-rose-300'}`}
                        >
                          {MATRIX_PLAT_ZH[p] || p}
                        </button>
                      ))}
                    </div>
                    {/* 再选账号(富信息下拉) */}
                    {identityPlatform && (
                      <div className="flex">
                        <MatrixAccountSelect
                          isZh={isZh}
                          accounts={identityAccounts}
                          value={identityAccountId}
                          onChange={onPickIdentityAccount}
                          onAddAccount={() => { window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform: identityPlatform } })); onClose(); }}
                        />
                      </div>
                    )}
                  </div>
                )}
              </Field>

              {/* 选中后只读展示该账号的赛道 / 人设 / 关键词(自动带入生成,不可在此改) */}
              {(identityAccountId || (isEdit && (matrixTrack || persona || keywords))) && (
                <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-3 space-y-2.5">
                  <div className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">
                    {isZh ? '该账号身份 · 自动用于生成' : 'Account identity · used for generation'}
                  </div>
                  {[
                    { label: isZh ? '赛道' : 'Track', value: matrixTrack },
                    { label: isZh ? '人设' : 'Persona', value: persona },
                    { label: isZh ? '关键词' : 'Keywords', value: keywords },
                  ].map((row) => (
                    <div key={row.label}>
                      <div className="text-[11px] text-gray-400 mb-0.5">{row.label}</div>
                      <div className="text-sm dark:text-gray-200 whitespace-pre-wrap break-words">
                        {row.value || (isZh ? '—（该账号未设置）' : '— (not set)')}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* ── 步骤 2(非矩阵):赛道（选完自动带出人设 / 关键词） ── */}
          {step === 2 && !matrixMode && (
            <>
              <Field label={isZh ? '赛道（必选）' : 'Track (required)'} hint={isZh ? '选完自动带出人设和关键词，可再改' : 'auto-fills persona & keywords, editable'}>
                <select
                  value={trackId}
                  onChange={(e) => onPickTrack(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-rose-500/50"
                >
                  <option value="">{isZh ? '— 请选择赛道 —' : '— Select a track —'}</option>
                  {/* 国内版隐藏「加密货币 · Web3」赛道(HIDE_WEB3) */}
                  {TRACK_PRESETS.filter((t) => !(HIDE_WEB3 && t.id === 'crypto')).map((t) => (
                    <option key={t.id} value={t.id}>{isZh ? t.zh : t.en}</option>
                  ))}
                </select>
              </Field>

              <Field label={isZh ? '人设' : 'Persona'} hint={isZh ? '你是谁、对谁说话、什么口吻' : 'who you are and your tone'}>
                <textarea
                  value={persona}
                  onChange={(e) => setPersona(e.target.value)}
                  rows={3}
                  placeholder={isZh ? '选赛道后自动带出，可修改' : 'auto-filled after picking a track'}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-rose-500/50 resize-y leading-relaxed"
                />
              </Field>

              <Field label={isZh ? '关键词' : 'Keywords'} hint={isZh ? '空格分隔，用于搜画面素材' : 'space-separated, used to search stock'}>
                <textarea
                  value={keywords}
                  onChange={(e) => setKeywords(e.target.value)}
                  rows={3}
                  placeholder={isZh ? '选赛道后自动带出，可修改' : 'auto-filled after picking a track'}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-rose-500/50 resize-y leading-relaxed"
                />
              </Field>
            </>
          )}

          {/* ── 步骤 3:文案（文案模式 + 视频文案 + 时长） ── */}
          {step === 3 && (
            <>
              {/* 文案模式:严格逐字 vs AI 参考再创作 */}
              <Field label={isZh ? '文案模式' : 'Script mode'} hint={isZh ? '决定视频文案怎么用' : 'how your script is used'}>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <ModeOption
                    active={scriptMode === 'strict'}
                    onClick={() => setScriptMode('strict')}
                    title={isZh ? '严格按我的视频文案' : 'Use my script verbatim'}
                    desc={isZh ? '逐字朗读，文案长度直接决定视频长度' : 'read verbatim; length sets video length'}
                  />
                  <ModeOption
                    active={scriptMode === 'ai'}
                    onClick={() => setScriptMode('ai')}
                    title={isZh ? 'AI 参考我的文案' : 'AI writes (reference mine)'}
                    desc={isZh ? 'AI 写稿，你的文案仅作参考（可不填）' : 'AI writes; your text is just a reference'}
                  />
                </div>
              </Field>

              <Field
                label={isZh ? '视频文案' : 'Script'}
                hint={scriptMode === 'strict'
                  ? (isZh ? `逐字朗读，不少于 ${SCRIPT_MIN_STRICT} 字；字数越多视频越长` : `read verbatim; at least ${SCRIPT_MIN_STRICT} chars`)
                  : (isZh ? '选填，留空则由 AI 按目标时长写稿；填了 AI 会参考' : 'optional; AI writes for target length, uses yours as reference')}
              >
                <textarea
                  value={script}
                  onChange={(e) => setScript(e.target.value)}
                  rows={5}
                  placeholder={scriptMode === 'strict'
                    ? (isZh ? `把要逐字朗读的视频文案粘进来…（${SCRIPT_MIN_STRICT}~${SCRIPT_MAX} 字）` : `Paste the exact narration… (${SCRIPT_MIN_STRICT}~${SCRIPT_MAX} chars)`)
                    : (isZh ? `给 AI 的参考方向，可留空…（≤${SCRIPT_MAX} 字）` : `Reference for AI, can be empty… (≤${SCRIPT_MAX} chars)`)}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-rose-500/50 resize-y min-h-[100px]"
                />
                <div className={`mt-1 text-[11px] text-right ${!scriptValid ? 'text-red-500' : 'text-gray-400'}`}>
                  {scriptLen}/{SCRIPT_MAX}
                  {scriptMode === 'strict' && scriptLen > 0 && scriptLen < SCRIPT_MIN_STRICT
                    && (isZh ? `（还需 ${SCRIPT_MIN_STRICT - scriptLen} 字）` : ` (need ${SCRIPT_MIN_STRICT - scriptLen} more)`)}
                  {scriptLen > SCRIPT_MAX && (isZh ? '（超出上限）' : ' (over limit)')}
                </div>
              </Field>

              {scriptMode === 'strict' ? (
                /* 严格模式:不选目标时长,实时按字数预估时长展示 */
                <div className="rounded-lg border border-rose-200 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-950/20 px-3 py-2 text-[12px] text-rose-700 dark:text-rose-300">
                  {scriptLen >= SCRIPT_MIN_STRICT
                    ? (isZh
                        ? `⏱️ 预估视频时长约 ${strictEstSec}s（按中文 ${CHARS_PER_SEC} 字/秒朗读估算，实际以配音为准）`
                        : `⏱️ Estimated ~${strictEstSec}s (at ${CHARS_PER_SEC} chars/sec; actual depends on TTS)`)
                    : (isZh
                        ? `⏱️ 填够 ${SCRIPT_MIN_STRICT} 字后这里显示预估时长（按 ${CHARS_PER_SEC} 字/秒）`
                        : `⏱️ Estimate shows after ${SCRIPT_MIN_STRICT} chars`)}
                </div>
              ) : (
                /* AI 模式:目标时长选择(AI 据此控制字数) */
                <Field
                  label={isZh ? '目标时长' : 'Target length'}
                  hint={isZh ? 'AI 写稿时按此控制长度' : 'used when AI writes the script'}
                >
                  <div className="flex flex-wrap gap-2">
                    {/* 纯 AI 模式只给 ≤45s 选项(成本敏感),其它模式全开。 */}
                    {DURATION_OPTIONS.filter((s) => mode !== 'pure_ai' || s <= AI_MAX_SECONDS).map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setTargetSeconds(s)}
                        className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                          targetSeconds === s
                            ? 'border-rose-500 bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium'
                            : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-rose-300'
                        }`}
                      >
                        {s >= 120 ? (isZh ? `${s / 60}分钟` : `${s / 60}min`) : `${s}s`}
                      </button>
                    ))}
                  </div>
                </Field>
              )}

              {/* 纯AI:按【时长 × 清晰度】预估实收费用(积分 + $,按卖价),让用户开跑前心里有数。 */}
              {mode === 'pure_ai' && aiCreditsPerSec != null && aiUsdPerSec != null && (() => {
                const estSec = Math.min(AI_MAX_SECONDS, scriptMode === 'strict' ? Math.max(1, strictEstSec) : targetSeconds);
                const estCredits = Math.round(aiCreditsPerSec * estSec);
                const estUsd = aiUsdPerSec * estSec;
                return (
                  <div className="mt-3 rounded-lg border border-fuchsia-500/30 bg-fuchsia-500/5 px-3 py-2.5 text-sm">
                    <span className="text-fuchsia-600 dark:text-fuchsia-400 font-semibold">💎 {isZh ? '预估费用' : 'Est. cost'}</span>
                    <span className="ml-2 dark:text-gray-200">{isZh ? (HIDE_WEB3 ? `约 ${estCredits.toLocaleString()} 积分(≈￥${cnyFromUsd(estUsd)})` : `约 ${estCredits.toLocaleString()} 积分(≈$${estUsd.toFixed(2)})`) : `~${estCredits.toLocaleString()} credits (≈$${estUsd.toFixed(2)})`}</span>
                    <div className="text-[11px] text-gray-400 mt-1">{isZh ? `${seedanceResolution} · 约 ${estSec}s · 实际按真实时长逐镜扣` : `${seedanceResolution} · ~${estSec}s · charged per real shot length`}</div>
                  </div>
                );
              })()}
            </>
          )}

          {/* ── 步骤 4:画面 ── */}
          {step === 4 && (
            <>
              {/* 素材来源:二选一,不混拼(对齐 MoneyPrinterTurbo)。
                  stock=全部在线素材库;local=全部用上传的本地视频拼接。 */}
              {/* 画面来源:仅「AI 口播稿」模式给二选一(在线/本地);纯 AI(Seedance)模式
                  在第 1 步已定,这里直接进 AI 面板,不再重复给来源选择。 */}
              {mode !== 'pure_ai' && (
              <Field label={isZh ? '画面来源（二选一）' : 'Footage source'} hint={isZh ? '要么全部在线，要么全部本地，不混拼' : 'all online OR all local, no mixing'}>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <ModeOption
                    active={materialSource === 'stock'}
                    onClick={() => setMaterialSource('stock')}
                    title={isZh ? '在线素材库' : 'Online stock'}
                    desc={isZh ? 'AI 按文案自动搜在线空镜拼接' : 'AI auto-searches stock B-roll by your script'}
                  />
                  <ModeOption
                    active={materialSource === 'local'}
                    onClick={() => setMaterialSource('local')}
                    title={isZh ? '本地上传' : 'My own clips'}
                    desc={isZh ? '全部用你上传的视频，按换镜节奏循环拼接' : 'all your uploaded clips, looped by pacing'}
                  />
                </div>
              </Field>
              )}

              {/* 纯 AI(Seedance):锁定省钱档(1.0 Lite + 480p,不让用户选,避免烧钱)+ 参考图(≤2)。 */}
              {mode === 'pure_ai' && (
              <>
                <Field
                  label={isZh ? '参考图（可选，最多 2 张）' : 'Reference images (optional, max 2)'}
                  hint={isZh ? '统一画风/人设；不传则纯按文案生成画面' : 'unify style/persona; omit for pure text-to-video'}
                >
                  <div className="space-y-1.5">
                    {referenceImages.map((p, i) => (
                      <div key={i} className="flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-2.5 py-1.5">
                        <span className="text-sm">🖼️</span>
                        <span className="flex-1 text-xs text-gray-600 dark:text-gray-300 truncate">{p.split(/[\\/]/).pop()}</span>
                        <button
                          type="button"
                          onClick={() => removeReferenceImage(i)}
                          className="w-5 h-5 rounded-full bg-gray-300 dark:bg-gray-600 text-white text-xs flex items-center justify-center hover:bg-red-500 shrink-0"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    {referenceImages.length < 2 && (
                      <button
                        type="button"
                        onClick={pickReferenceImages}
                        className="w-full py-2 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-700 text-sm text-gray-500 hover:border-rose-400 hover:text-rose-400 transition-colors"
                      >
                        ＋ {isZh ? '添加参考图' : 'Add reference image'}
                      </button>
                    )}
                  </div>
                </Field>
                <Field
                  label={isZh ? '清晰度' : 'Resolution'}
                  hint={isZh ? '720p 更清晰、按秒计费更高;480p 更省。单价不变,只是 720p 每秒消耗更多' : '720p sharper (pricier per sec), 480p cheaper; same unit price, 720p uses more tokens/sec'}
                >
                  <div className="grid grid-cols-2 gap-2">
                    {(['480p', '720p'] as const).map((r) => (
                      <button key={r} type="button" onClick={() => setSeedanceResolution(r)}
                        className={`px-3 py-2 rounded-lg text-sm border transition-colors ${seedanceResolution === r ? 'border-rose-500 bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-rose-300'}`}>
                        {r === '480p' ? (isZh ? '480p · 省' : '480p · Cheaper') : (isZh ? '720p · 清晰' : '720p · Sharper')}
                      </button>
                    ))}
                  </div>
                </Field>
              </>
              )}

              {/* 本地视频素材:仅本地来源显示,且必填(至少 1 个)。 */}
              {materialSource === 'local' && (
              <Field
                label={isZh ? `本地视频素材（必填，最多 ${MAX_LOCAL_VIDEOS} 个）` : `Local videos (required, max ${MAX_LOCAL_VIDEOS})`}
                hint={isZh ? '可多选，按换镜节奏循环切；仅 mp4/mov/webm 等，单个 ≤200MB' : 'multi-select, looped by pacing; mp4/mov/webm, ≤200MB each'}
              >
                <div className="space-y-1.5">
                    {localVideos.map((p, i) => (
                      <div key={i} className="flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-2.5 py-1.5">
                        <span className="text-sm">🎞️</span>
                        <span className="flex-1 text-xs text-gray-600 dark:text-gray-300 truncate">{p.split(/[\\/]/).pop()}</span>
                        <button
                          type="button"
                          onClick={() => removeLocalVideo(i)}
                          className="w-5 h-5 rounded-full bg-gray-300 dark:bg-gray-600 text-white text-xs flex items-center justify-center hover:bg-red-500 shrink-0"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    {localVideos.length < MAX_LOCAL_VIDEOS && (
                      <button
                        type="button"
                        onClick={pickLocalVideos}
                        className="w-full py-2 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-700 text-sm text-gray-500 hover:border-rose-400 hover:text-rose-400 transition-colors"
                      >
                        ＋ {isZh ? '添加本地视频' : 'Add videos'}
                      </button>
                    )}
                  </div>
              </Field>
              )}

              {/* 画幅比例 */}
              <Field label={isZh ? '视频比例' : 'Aspect ratio'} hint={isZh ? '决定成片尺寸与素材搜索方向' : 'sets output size & stock orientation'}>
                <div className="flex gap-2">
                  {ASPECT_OPTIONS.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => setAspect(a.id)}
                      className={`flex-1 px-3 py-2 rounded-lg text-sm border transition-colors ${
                        aspect === a.id
                          ? 'border-rose-500 bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium'
                          : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-rose-300'
                      }`}
                    >
                      <span className="mr-1">{a.icon}</span>{isZh ? a.zh : a.en}
                    </button>
                  ))}
                </div>
              </Field>

              {/* 换镜节奏 */}
              <Field label={isZh ? '换镜节奏' : 'Clip pacing'} hint={isZh ? '每段素材最长时长，越快画面越动感' : 'shorter = more dynamic cuts'}>
                <div className="flex gap-2">
                  {PACE_OPTIONS.map((p) => (
                    <button
                      key={p.v}
                      type="button"
                      onClick={() => setMaxClipSeconds(p.v)}
                      className={`flex-1 px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                        maxClipSeconds === p.v
                          ? 'border-rose-500 bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium'
                          : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-rose-300'
                      }`}
                    >
                      {isZh ? p.zh : p.en}<span className="ml-1 text-[10px] opacity-60">{p.v}s</span>
                    </button>
                  ))}
                </div>
              </Field>
            </>
          )}

          {/* ── 步骤 5:音频 ── */}
          {step === 5 && (
            <>
              {/* Seedance 模式:让用户选「纯画面」还是「加 AI 配音 + 字幕」 */}
              {mode === 'pure_ai' && (
                <Field label={isZh ? 'AI 配音' : 'AI voice-over'} hint={isZh ? '开启后对分镜稿配音并可烧字幕;关闭则纯画面' : 'narrate the script & allow subtitles; off = visual-only'}>
                  <div className="flex items-center justify-between rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-2.5">
                    <span className="text-sm text-gray-700 dark:text-gray-200">
                      {aiNarration
                        ? (isZh ? '🔊 加 AI 配音 + 字幕' : '🔊 Add AI voice-over + subtitles')
                        : (isZh ? '🎬 纯画面片(不配音、不烧字幕)' : '🎬 Visual-only (no narration/subtitles)')}
                    </span>
                    <button
                      type="button"
                      onClick={() => setAiNarration((v) => {
                        const next = !v;
                        // 开配音 → 字幕默认跟开(用户可在字幕步关);关配音 → 字幕一并失效。
                        if (next) setSubtitleEnabled(true);
                        return next;
                      })}
                      className={`relative w-11 h-6 rounded-full transition-colors ${aiNarration ? 'bg-rose-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                    >
                      <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${aiNarration ? 'translate-x-5' : ''}`} />
                    </button>
                  </div>
                  {!aiNarration && (
                    <p className="mt-1.5 text-xs text-gray-400">{isZh ? '纯画面只需(选填)挑首背景音乐,下一步直接出片。' : 'Visual-only: optionally pick BGM, then output.'}</p>
                  )}
                </Field>
              )}

              {/* 创作语言 —— 仅在线/本地素材模式(决定 AI 口播稿语言;纯 AI 暂不放,Seedance 线另议)。
                  逐字朗读(strict)模式稿子就是用户原文,选语言不生效 → 禁用并说明。 */}
              {mode === 'stock' && (
              <Field
                label={isZh ? '创作语言' : 'Script language'}
                hint={scriptMode === 'strict'
                  ? (isZh ? '逐字朗读模式:按你文案的原文语言,此项不生效' : 'Verbatim mode follows your script text; this has no effect')
                  : (isZh ? '决定 AI 口播稿和字幕的语言' : 'Language of the AI narration & subtitles')}
              >
                <select
                  value={scriptLang}
                  onChange={(e) => pickScriptLang(e.target.value)}
                  disabled={scriptMode === 'strict'}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-rose-500/50 disabled:opacity-50"
                >
                  {SCRIPT_LANGS.map((l) => (
                    <option key={l.code} value={l.code}>{isZh ? l.zh : l.en}</option>
                  ))}
                </select>
              </Field>
              )}

              {/* 配音音色 + 语速 —— 普通模式恒显示;Seedance 仅在开了「AI 配音」时显示 */}
              {(mode !== 'pure_ai' || aiNarration) && (
              <Field label={isZh ? '配音音色' : 'Voice'} hint={isZh ? 'edge-tts 在线合成，免费' : 'edge-tts, free'}>
                <select
                  value={voice}
                  onChange={(e) => setVoice(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-rose-500/50"
                >
                  {VOICE_GROUPS.map((g) => (
                    <optgroup key={g.groupZh} label={isZh ? g.groupZh : g.groupEn}>
                      {g.voices.map((v) => (
                        <option key={v.id} value={v.id}>{isZh ? v.zh : v.en}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <div className="flex gap-2 mt-2">
                  {RATE_OPTIONS.map((r) => (
                    <button
                      key={r.v}
                      type="button"
                      onClick={() => setVoiceRate(r.v)}
                      className={`flex-1 px-2 py-1.5 rounded-lg text-xs border transition-colors ${
                        voiceRate === r.v
                          ? 'border-rose-500 bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium'
                          : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-rose-300'
                      }`}
                    >
                      {isZh ? r.zh : r.en}
                    </button>
                  ))}
                </div>
              </Field>
              )}

              {/* 背景音乐(选填):无 / 内置曲库 / 自定义上传 */}
              <Field label={isZh ? '背景音乐（选填）' : 'Background music (optional)'} hint={isZh ? '混在旁白下方，出片末尾自动淡出' : 'mixed under narration, fades out'}>
                {/* 三选一来源 */}
                <div className="grid grid-cols-3 gap-2 mb-2">
                  <button
                    type="button"
                    onClick={() => setBgmPath('')}
                    className={`px-2 py-1.5 rounded-lg text-xs border transition-colors ${
                      !bgmPath
                        ? 'border-rose-500 bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium'
                        : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-rose-300'
                    }`}
                  >
                    {isZh ? '无' : 'None'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { if (!bgmIsLibrary) setBgmPath(BUILTIN_BGM_PREFIX + BUILTIN_BGM[0].id); }}
                    className={`px-2 py-1.5 rounded-lg text-xs border transition-colors ${
                      bgmIsLibrary
                        ? 'border-rose-500 bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium'
                        : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-rose-300'
                    }`}
                  >
                    {isZh ? '曲库' : 'Library'}
                  </button>
                  <button
                    type="button"
                    onClick={pickBgm}
                    className={`px-2 py-1.5 rounded-lg text-xs border transition-colors ${
                      bgmIsUpload
                        ? 'border-rose-500 bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium'
                        : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-rose-300'
                    }`}
                  >
                    {isZh ? '上传' : 'Upload'}
                  </button>
                </div>

                {/* 曲库:一个下拉(内置 + 云端合并,分两组)+ 一个「打开文件夹」按钮(定位当前选中那首)。
                    value = builtin:/remote: token;云端首次打开由主进程下载并缓存,再在文件管理器里高亮。 */}
                {bgmIsLibrary && (
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <select
                        value={bgmPath}
                        onChange={(e) => { if (e.target.value) setBgmPath(e.target.value); }}
                        className="flex-1 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-rose-500/50"
                      >
                        <optgroup label={isZh ? '内置曲库' : 'Built-in'}>
                          {BUILTIN_BGM.map((b) => (
                            <option key={b.id} value={`${BUILTIN_BGM_PREFIX}${b.id}`}>🎵 {isZh ? b.zh : b.en}</option>
                          ))}
                        </optgroup>
                        {remoteBgm.length > 0 && (
                          <optgroup label={isZh ? '云端曲库（首次需下载）' : 'Cloud (downloads on first use)'}>
                            {/* 编辑老任务时选中的云端曲目可能不在已拉清单里 → 补占位,避免下拉空白 */}
                            {!bgmInLibraryList && bgmIsRemote && (
                              <option value={bgmPath}>☁️ {bgmDisplayName(bgmPath, isZh, remoteBgm)}</option>
                            )}
                            {remoteBgm.map((b) => (
                              <option key={b.url} value={`${REMOTE_BGM_PREFIX}${b.url}`}>☁️ {isZh ? b.zh : b.en}</option>
                            ))}
                          </optgroup>
                        )}
                      </select>
                      <button
                        type="button"
                        onClick={() => openBgmFolder(bgmPath)}
                        disabled={bgmOpening}
                        className="shrink-0 px-4 py-2 rounded-lg text-xs font-medium text-white transition-colors disabled:opacity-60 bg-rose-500 hover:bg-rose-600"
                      >
                        {bgmOpening ? (isZh ? '⏳ 打开中…' : '⏳') : (isZh ? '📂 打开文件夹' : '📂 Open folder')}
                      </button>
                    </div>
                    {previewError && (
                      <div className="text-[11px] text-red-500">{previewError}</div>
                    )}
                    {bgmIsRemote && (
                      <div className="text-[11px] text-gray-400">
                        {isZh ? '☁️ 云端曲目首次打开文件夹/合成时自动下载并缓存，之后复用不再下载。' : '☁️ Cloud track downloads on first open/compose, then cached.'}
                      </div>
                    )}
                  </div>
                )}

                {/* 用户上传:显示文件名 + 更换/移除 */}
                {bgmIsUpload && (
                  <div className="flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-2.5 py-2">
                    <span className="text-sm">🎵</span>
                    <span className="flex-1 text-xs text-gray-600 dark:text-gray-300 truncate">{bgmPath.split(/[\\/]/).pop()}</span>
                    <button type="button" onClick={pickBgm} className="text-xs text-rose-500 hover:underline shrink-0">{isZh ? '更换' : 'Change'}</button>
                    <button type="button" onClick={() => setBgmPath('')} className="text-xs text-gray-400 hover:text-red-500 shrink-0">{isZh ? '移除' : 'Remove'}</button>
                  </div>
                )}
                {/* 上传曲目的「打开文件夹」(内置/云端在上方列表已有同款按钮)。 */}
                {bgmIsUpload && (
                  <button
                    type="button"
                    onClick={() => openBgmFolder(bgmPath)}
                    disabled={bgmOpening}
                    className="mt-2 w-full px-3 py-1.5 rounded-lg text-xs font-medium text-white transition-colors disabled:opacity-60 bg-rose-500 hover:bg-rose-600"
                  >
                    {bgmOpening ? (isZh ? '⏳ 打开中…' : 'Opening…') : (isZh ? '📂 打开文件夹' : '📂 Open folder')}
                  </button>
                )}
                {bgmPath && (
                  <div className="flex gap-2 mt-2">
                    <span className="text-xs text-gray-500 self-center">{isZh ? 'BGM 音量' : 'BGM volume'}</span>
                    {BGM_VOLUME_OPTIONS.map((b) => (
                      <button
                        key={b.v}
                        type="button"
                        onClick={() => setBgmVolume(b.v)}
                        className={`flex-1 px-2 py-1.5 rounded-lg text-xs border transition-colors ${
                          bgmVolume === b.v
                            ? 'border-rose-500 bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium'
                            : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-rose-300'
                        }`}
                      >
                        {isZh ? b.zh : b.en}
                      </button>
                    ))}
                  </div>
                )}
              </Field>
            </>
          )}

          {/* ── 步骤 6:字幕 + 出片 ── */}
          {step === 6 && (
            <>
              {(mode === 'pure_ai' && !aiNarration) ? (
                <Field label={isZh ? '字幕' : 'Subtitles'} hint={isZh ? '纯画面模式' : 'pure visual mode'}>
                  <div className="text-sm text-gray-500 dark:text-gray-400 rounded-lg border border-dashed border-gray-300 dark:border-gray-700 px-3 py-4 text-center">
                    {isZh ? '纯画面 AI 片不烧字幕（未开「AI 配音」）。直接点「下一步」出片即可。' : 'Pure visual AI clip — no subtitles (voice-over off). Just continue to output.'}
                  </div>
                </Field>
              ) : (
              <>
              {/* 字幕样式 + 开关 */}
              <Field label={isZh ? '字幕' : 'Subtitles'} hint={isZh ? '开启时用 edge-tts 词边界对齐时间轴' : 'edge-tts word-boundary timing when on'}>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-gray-600 dark:text-gray-300">{isZh ? '烧录字幕' : 'Burn subtitles'}</span>
                  <button
                    type="button"
                    onClick={() => setSubtitleEnabled((v) => !v)}
                    className={`relative w-11 h-6 rounded-full transition-colors ${subtitleEnabled ? 'bg-rose-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                  >
                    <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${subtitleEnabled ? 'translate-x-5' : ''}`} />
                  </button>
                </div>
                {subtitleEnabled && (
                  <div className="space-y-2">
                    <div className="flex gap-2">
                      <div className="flex gap-1">
                        {SUB_FONTSIZE_OPTIONS.map((f) => (
                          <button
                            key={f.v}
                            type="button"
                            onClick={() => setSubtitleFontSize(f.v)}
                            className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                              subtitleFontSize === f.v
                                ? 'border-rose-500 bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium'
                                : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-rose-300'
                            }`}
                          >
                            {isZh ? f.zh : f.en}
                          </button>
                        ))}
                      </div>
                      <div className="flex gap-1">
                        {SUB_POSITION_OPTIONS.map((s) => (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => setSubtitlePosition(s.id)}
                            className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                              subtitlePosition === s.id
                                ? 'border-rose-500 bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium'
                                : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-rose-300'
                            }`}
                          >
                            {isZh ? s.zh : s.en}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* 字体选择 */}
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-500 w-12 shrink-0">{isZh ? '字体' : 'Font'}</span>
                      <select
                        value={subtitleFont}
                        onChange={(e) => setSubtitleFont(e.target.value)}
                        className="flex-1 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-xs dark:text-white focus:outline-none focus:ring-2 focus:ring-rose-500/50"
                      >
                        {SUB_FONT_OPTIONS.map((f) => (
                          <option key={f.v || 'default'} value={f.v}>{isZh ? f.zh : f.en}</option>
                        ))}
                      </select>
                    </div>

                    {/* 文字颜色调色板 */}
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-500 w-12 shrink-0">{isZh ? '颜色' : 'Color'}</span>
                      <div className="flex gap-1.5">
                        {SUB_COLOR_OPTIONS.map((c) => (
                          <button
                            key={c.v}
                            type="button"
                            title={isZh ? c.zh : c.en}
                            onClick={() => setSubtitleColor(c.v)}
                            className={`w-6 h-6 rounded-full border-2 transition-transform ${
                              subtitleColor === c.v ? 'border-rose-500 scale-110' : 'border-gray-300 dark:border-gray-600'
                            }`}
                            style={{ backgroundColor: c.v }}
                          />
                        ))}
                      </div>
                    </div>

                    {/* 描边颜色调色板("无" = 用半透明黑底盒) */}
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-500 w-12 shrink-0">{isZh ? '描边' : 'Stroke'}</span>
                      <div className="flex gap-1.5">
                        {SUB_STROKE_OPTIONS.map((c) => {
                          const active = subtitleStrokeColor === c.v;
                          if (c.v === '') {
                            return (
                              <button
                                key="none"
                                type="button"
                                onClick={() => setSubtitleStrokeColor('')}
                                className={`px-2 h-6 rounded-full text-[11px] border-2 transition-colors ${
                                  active
                                    ? 'border-rose-500 bg-rose-500/10 text-rose-600 dark:text-rose-400'
                                    : 'border-gray-300 dark:border-gray-600 text-gray-500'
                                }`}
                              >
                                {isZh ? '无' : 'None'}
                              </button>
                            );
                          }
                          return (
                            <button
                              key={c.v}
                              type="button"
                              title={isZh ? c.zh : c.en}
                              onClick={() => setSubtitleStrokeColor(c.v)}
                              className={`w-6 h-6 rounded-full border-2 transition-transform ${
                                active ? 'border-rose-500 scale-110' : 'border-gray-300 dark:border-gray-600'
                              }`}
                              style={{ backgroundColor: c.v }}
                            />
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </Field>
            </>
            )}
            </>
          )}

          {/* ── 步骤 7:出片(生成数量 + 定时运行 + 出片后处理)── */}
          {step === 7 && (
            <>
              {/* 生成数量:stock 1-100(每条 AI 独立写稿+配音,失败跳过,按条计费);其它模式 1-10。 */}
              <Field label={isZh ? '生成数量' : 'Number of videos'} hint={isZh
                ? (mode === 'stock' ? '每条 AI 独立写稿 + 配音,各不相同(失败自动跳过)' : '复用同一脚本与配音，每条画面组合不同')
                : (mode === 'stock' ? 'each clip: fresh AI script + voice (failures skipped)' : 'reuse script & voice, vary clips')}>
                <div className="flex items-center gap-3">
                  <input
                    type="range" min={1} max={mode === 'stock' ? 100 : 10} step={1}
                    value={videoCount}
                    onChange={(e) => setVideoCount(Number(e.target.value) || 1)}
                    className="flex-1 accent-rose-500"
                  />
                  <span className="w-16 text-center text-sm font-semibold text-rose-600 dark:text-rose-400">
                    {videoCount} {isZh ? '条' : ''}
                  </span>
                </div>
                <div className="text-[11px] text-gray-400 mt-1">{
                  mode === 'pure_ai'
                    ? (isZh ? (HIDE_WEB3 ? '1-10 条 / 次 · 纯 AI 按秒计费,约 ￥0.3/秒(720p)' : '1-10 条 / 次 · 纯 AI 按秒计费,约 $0.04/秒(720p)') : '1-10 per run · pure-AI billed per second (~$0.04/s @720p)')
                    : mode === 'stock'
                      ? (isZh ? (HIDE_WEB3 ? '1-100 条 / 次 · 单条约 ￥0.14~￥0.72(配音/字幕/合成免费,AI 写稿另计)' : '1-100 条 / 次 · 单条约 $0.02~$0.1(配音/字幕/合成免费,AI 写稿另计)') : '1-100 per run · ~$0.02–0.1 each (TTS/subs/compose free; AI script extra)')
                      : (isZh ? (HIDE_WEB3 ? '1-10 条 / 次 · 单条约 ￥0.14~￥0.72(配音/字幕/合成免费,AI 写稿另计)' : '1-10 条 / 次 · 单条约 $0.02~$0.1(配音/字幕/合成免费,AI 写稿另计)') : '1-10 per run · ~$0.02–0.1 each (TTS/subs/compose free; AI script extra)')
                }</div>
              </Field>

              {/* 定时运行(参照抖音):选「不重复」就是手动单次;选周期则到点自动重跑,
                  每次跑都按条计费。app 需保持开启才会触发(本地出片本就要 app 在前台)。 */}
              <Field
                label={isZh ? '定时运行' : 'Scheduled runs'}
                hint={isZh ? '到点自动按上面的配置重跑（每次按条计费）' : 'auto-rerun on schedule (billed per clip each time)'}
              >
                <div className="grid grid-cols-3 gap-2">
                  {([
                    { v: 'once', zh: '不重复', en: 'Once' },
                    { v: '3h', zh: '每 3 小时', en: 'Every 3h' },
                    { v: '6h', zh: '每 6 小时', en: 'Every 6h' },
                    { v: 'daily_random', zh: '每日随机', en: 'Daily random' },
                  ] as { v: VideoRunInterval; zh: string; en: string }[]).map((o) => (
                    <button
                      key={o.v}
                      type="button"
                      onClick={() => setRunInterval(o.v)}
                      className={`px-2 py-1.5 rounded-lg text-xs border transition-colors ${
                        runInterval === o.v
                          ? 'border-rose-500 bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium'
                          : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-rose-300'
                      }`}
                    >
                      {isZh ? o.zh : o.en}
                    </button>
                  ))}
                </div>
                {(runInterval === '3h' || runInterval === '6h') && (
                  <p className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">
                    {isZh ? '⚠️ 到点后再加 0-10 分钟随机延迟,避免精准卡点（出片很重,不提供更短间隔）' : '⚠️ +0-10min jitter after threshold (video gen is heavy, no shorter cadence).'}
                  </p>
                )}
                {runInterval === 'daily_random' && (
                  <p className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">
                    {isZh ? '✨ 推荐 — 每天随机时间出片一次,最像真人' : '✨ Recommended — once daily at a random time, most human-like'}
                  </p>
                )}
                {runInterval !== 'once' && (
                  <div className="mt-2 text-[11px] text-amber-500">
                    {isZh
                      ? '⚠️ 定时任务会在到点时自动出片并按条扣费，请确保账户余额充足；应用需保持开启。'
                      : '⚠️ Scheduled runs auto-generate and bill per clip — keep enough balance and keep the app running.'}
                  </div>
                )}
              </Field>

              {/* 出片去向(本地/上传)单选 —— 平台与账号挪到下一步「发布」(对齐热搜成片) */}
              <OutputModeToggle isZh={isZh} outputMode={outputMode} setOutputMode={setOutputMode} />
            </>
          )}

          {/* ── Step 8:发布平台 + 发布账号(独立一步,平台与账号同一步,对齐热搜成片)── */}
          {step === PUBLISH_STEP && (
            <PublishPlatformPicker
              isZh={isZh}
              outputMode={outputMode}
              platforms={platforms}
              togglePlatform={togglePlatform}
            >
              {/* 发布文案统一由 AI 自动生成,不给自定义输入框(跟热搜成片一致)。 */}
              {outputMode === 'upload' && (
                <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800 text-[11px] text-gray-400">
                  {isZh
                    ? (mode === 'stock' ? '📝 发布文案:每条由 AI 独立生成钩人标题 + 引导互动文案 + 话题标签(批量成片不支持统一自定义文案)' : '📝 发布文案:由 AI 自动生成钩人标题 + 引导互动文案 + 话题标签(无需填写)')
                    : (mode === 'stock' ? '📝 Caption: AI writes a unique hook title + CTA + hashtags per clip' : '📝 Caption: AI auto-writes a hook title + CTA + hashtags (nothing to fill in)')}
                </div>
              )}
              {matrixMode && outputMode === 'upload' && selectedPlatformIds.length > 0 && (
                <div className="mt-4">
                  <Field
                    label={isZh ? '发布账号' : 'Publish accounts'}
                    hint={isZh ? '每个平台选一个矩阵账号,出片后用该号的指纹浏览器上传' : 'one matrix account per platform'}
                  >
                    <div className="space-y-2.5">
                      {selectedPlatformIds.map((pid) => {
                        const meta = PUBLISH_PLATFORMS.find((m) => m.id === pid);
                        const label = meta ? `${meta.emoji} ${isZh ? meta.zh : meta.en}` : pid;
                        const accs = accountsFor(pid);
                        return (
                          <div key={pid} className="flex items-center gap-3">
                            <div className="w-28 shrink-0 text-sm font-medium dark:text-gray-200">{label}</div>
                            <MatrixAccountSelect
                              isZh={isZh}
                              accounts={accs}
                              value={accountByPlatform[pid] || ''}
                              onChange={(id) => setAccountByPlatform((m) => ({ ...m, [pid]: id }))}
                              onAddAccount={() => { window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform: pid } })); onClose(); }}
                            />
                          </div>
                        );
                      })}
                      <p className="text-[11px] text-gray-500 dark:text-gray-400 pt-1">
                        {isZh ? '每个平台必须选一个【已连接】账号;未连接的已置灰不可选,选好才能开始。发布时用该号的指纹浏览器上传。' : 'Each platform needs a LINKED account (unlinked ones are greyed out). Published via that account\'s fingerprint browser.'}
                      </p>
                    </div>
                  </Field>
                </div>
              )}
              {submitError && (
                <div className="mt-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3 text-xs text-red-500">{submitError}</div>
              )}
            </PublishPlatformPicker>
          )}
        </div>

        <div className="shrink-0 px-6 py-4 border-t border-gray-100 dark:border-gray-800 flex gap-2">
          <button
            type="button"
            onClick={() => {
              // forcedMode 锁定模式 → 最低步是 step2(赛道),从 step2 点「上一步」= 取消(没有 step1)。
              if (step === 1 || (forcedMode && step === 2)) { onClose(); return; }
              // Seedance 纯画面(未开 AI 配音)无字幕步:7 ← 5(跳过 6)。账号步(8)正常 8→7。
              setStep((s) => ((mode === 'pure_ai' && !aiNarration && s === 7 ? 5 : s - 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8));
            }}
            className="flex-1 py-2.5 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            {(step === 1 || (forcedMode && step === 2)) ? (isZh ? '取消' : 'Cancel') : `← ${isZh ? '上一步' : 'Back'}`}
          </button>
          {step < MAX_STEP ? (
            <button
              type="button"
              onClick={() => {
                if (step === 2 && !trackStepValid) { setSubmitError(isZh ? (matrixMode ? '请先选择账号' : '请先选择赛道') : (matrixMode ? 'Please pick an account' : 'Please pick a track')); return; }
                if (step === 3 && !scriptValid) {
                  if (scriptMode === 'strict' && scriptLen < SCRIPT_MIN_STRICT) {
                    setSubmitError(isZh ? `严格模式下视频文案不少于 ${SCRIPT_MIN_STRICT} 字（当前 ${scriptLen} 字）` : `Verbatim mode needs ≥ ${SCRIPT_MIN_STRICT} chars (now ${scriptLen})`);
                  } else {
                    setSubmitError(isZh ? `文案不能超过 ${SCRIPT_MAX} 字` : `Script must be ≤ ${SCRIPT_MAX} chars`);
                  }
                  return;
                }
                if (step === 4 && !visualStepValid) {
                  setSubmitError(isZh ? '选了本地上传,请至少添加一个视频素材' : 'Please add at least one local video');
                  return;
                }
                setSubmitError(null);
                // Seedance 纯画面(未开 AI 配音)无字幕步:5 → 7(跳过 6)。出片(7)是最后一步(平台+账号合并),平台/账号校验在提交时做。
                setStep((s) => ((mode === 'pure_ai' && !aiNarration && s === 5 ? 7 : s + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8));
              }}
              disabled={(step === 2 && !trackStepValid) || (step === 3 && !scriptStepValid) || (step === 4 && !visualStepValid)}
              className="flex-1 py-2.5 rounded-lg text-sm font-semibold bg-rose-500 text-white hover:bg-rose-600 disabled:opacity-50"
            >
              {isZh ? '下一步' : 'Next'} →
            </button>
          ) : (
            <button
              type="button"
              onClick={handleFinalClick}
              disabled={submitting}
              className="flex-1 py-2.5 rounded-lg text-sm font-semibold bg-rose-500 text-white hover:bg-rose-600 disabled:opacity-50"
            >
              {submitting
                ? (isZh ? '校验余额…' : 'Checking balance…')
                : isEdit ? `💾 ${isZh ? '保存' : 'Save'}` : `🎬 ${isZh ? '开始创作' : 'Start'}`}
            </button>
          )}
        </div>
        {showLoginCheck && (
          <VideoLoginCheckModal
            platforms={selectedPlatformIds}
            onCancel={() => setShowLoginCheck(false)}
            onConfirmed={() => { setShowLoginCheck(false); void handleSubmit(); }}
          />
        )}
      </div>
    </div>
  );
};

// ── 小组件 ──────────────────────────────────────────────────────────

const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div>
    <label className="text-sm font-medium dark:text-gray-200 mb-1.5 flex items-center gap-2">
      {label}
      {hint && <span className="text-[11px] font-normal text-gray-400">{hint}</span>}
    </label>
    {children}
  </div>
);

const StepDot: React.FC<{ n: number; active: boolean; done: boolean; label: string }> = ({ n, active, done, label }) => (
  <div className="flex items-center gap-1.5">
    <span
      className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
        active ? 'bg-rose-500 text-white' : done ? 'bg-rose-500/20 text-rose-500' : 'bg-gray-200 dark:bg-gray-700 text-gray-500'
      }`}
    >
      {done ? '✓' : n}
    </span>
    <span className={`text-xs font-medium ${active ? 'text-rose-500' : 'text-gray-500'}`}>{label}</span>
  </div>
);

const ModeOption: React.FC<{
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  desc: string;
  soon?: string;
  /** 成本提示行(如「≈$0.1/分钟起」),带高亮底色显示。 */
  cost?: string;
  /** 成本行右侧小标签(如「推荐」)。 */
  costTag?: string;
}> = ({ active, disabled, onClick, title, desc, soon, cost, costTag }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={`text-left rounded-lg border p-3 transition-colors ${
      active ? 'border-rose-500 bg-rose-500/10' : 'border-gray-300 dark:border-gray-700 hover:border-rose-300'
    } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
  >
    <div className="text-sm font-semibold dark:text-white flex items-center gap-1.5">
      {title}
      {soon && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-500">{soon}</span>}
    </div>
    <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">{desc}</div>
    {cost && (
      <div className="mt-1.5 flex items-center gap-1.5">
        <span className="text-[11px] font-semibold text-amber-600 dark:text-amber-400">{cost}</span>
        {costTag && <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400 font-medium">{costTag}</span>}
      </div>
    )}
  </button>
);

const RadioCard: React.FC<{
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  desc: string;
  soon?: string;
}> = ({ active, disabled, onClick, title, desc, soon }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={`w-full text-left rounded-lg border p-3 flex items-start gap-3 transition-colors ${
      active ? 'border-rose-500 bg-rose-500/10' : 'border-gray-300 dark:border-gray-700 hover:border-rose-300'
    } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
  >
    <span className={`mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${active ? 'border-rose-500' : 'border-gray-400'}`}>
      {active && <span className="w-2 h-2 rounded-full bg-rose-500" />}
    </span>
    <span>
      <span className="text-sm font-semibold dark:text-white flex items-center gap-1.5">
        {title}
        {soon && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-500">{soon}</span>}
      </span>
      <span className="block text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">{desc}</span>
    </span>
  </button>
);

const PlatformCheck: React.FC<{
  checked: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
}> = ({ checked, disabled, onClick, label }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={`inline-flex items-center gap-2 text-xs px-3 py-2 rounded-lg border transition-colors ${
      checked
        ? 'border-rose-500 bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium'
        : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300'
    } ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:border-rose-300'}`}
  >
    <span className={`w-4 h-4 rounded border flex items-center justify-center text-[10px] ${checked ? 'bg-rose-500 border-rose-500 text-white' : 'border-gray-400'}`}>
      {checked ? '✓' : ''}
    </span>
    {label}
  </button>
);

// 出片后(本地/上传)单选 —— 可单独放在「去向+频率」步(平台/账号在独立的「发布」步,见 PublishPlatformPicker)。
const OutputModeToggle: React.FC<{
  isZh: boolean; outputMode: OutputMode; setOutputMode: (m: OutputMode) => void;
}> = ({ isZh, outputMode, setOutputMode }) => (
  <Field label={isZh ? '出片后' : 'After generation'}>
    <div className="grid grid-cols-2 gap-2">
      <RadioCard active={outputMode === 'local'} onClick={() => setOutputMode('local')}
        title={isZh ? '存本地不上传' : 'Save locally, no upload'}
        desc={isZh ? '只在本机生成 mp4，自己看 / 手动发都行' : 'just produce an mp4 on this machine'} />
      <RadioCard active={outputMode === 'upload'} onClick={() => setOutputMode('upload')}
        title={isZh ? '上传到各大平台' : 'Upload to platforms'}
        desc={isZh ? '出片后自动发到选中的平台' : 'auto-publish to selected platforms after'} />
    </div>
  </Field>
);

// 发布平台多选 + 登录提示 + children(矩阵号在此放每平台选号)。仅 upload 时显示平台;local 给提示。
const PublishPlatformPicker: React.FC<{
  isZh: boolean; outputMode: OutputMode; platforms: Record<Platform, boolean>;
  togglePlatform: (p: Platform) => void; children?: React.ReactNode;
}> = ({ isZh, outputMode, platforms, togglePlatform, children }) => {
  if (outputMode !== 'upload') {
    return <div className="text-sm text-gray-500 dark:text-gray-400 py-3">{isZh ? '已选「仅存本地」,无需选择发布平台 / 账号。' : 'Local only — no platform/account needed.'}</div>;
  }
  return (
    <Field label={isZh ? '发布平台（可多选）' : 'Target platforms (multi-select)'}>
      <div className="flex flex-wrap gap-2">
        {/* 国内版隐藏「币安广场」发布平台(HIDE_WEB3) */}
        {PUBLISH_PLATFORMS.filter((m) => !(HIDE_WEB3 && m.id === 'binance')).map((m) => (
          <PlatformCheck key={m.id} checked={!!platforms[m.id]} onClick={() => togglePlatform(m.id)} label={`${m.emoji} ${isZh ? m.zh : m.en}`} />
        ))}
      </div>
      <div className="mt-2 text-[11px] text-amber-500 leading-relaxed">
        {isZh
          ? '💡 出片后会自动登录态检查 → 已登录就发,未登录的【自动跳过】(下次登录后再跑会补传)。不强制全部登录,可以一次勾完慢慢补。'
          : '💡 After rendering, each platform is auto-checked for login. Logged-in ones publish; others are SKIPPED (not failed). Log in later and re-run to back-fill.'}
      </div>
      {children}
    </Field>
  );
};

// 发布账号(矩阵)精简结构:富信息下拉用。
type MatrixAcctLite = { id: string; platform: string; displayName: string; status: string; nickname?: string; displayId?: string; avatar?: string; loginScope?: string; group?: string; persona?: string; keywords?: string[] };
const MATRIX_PLAT_ZH: Record<string, string> = { douyin: '抖音', xhs: '小红书', bilibili: 'B站', kuaishou: '快手', tiktok: 'TikTok', x: 'X', binance: '币安广场', youtube: 'YouTube', shipinhao: '视频号', toutiao: '头条' };
// 单个账号行(头像 + 昵称 + 平台号 + 备注 + 登录状态);未登录连接(login_required)置灰。
const MatrixAcctRow: React.FC<{ isZh: boolean; a: MatrixAcctLite }> = ({ isZh, a }) => {
  const linked = a.status !== 'login_required';
  const title = a.nickname || a.displayName;
  return (
    <div className="flex items-center gap-2 min-w-0">
      {a.avatar
        ? <img src={a.avatar.replace(/^http:/, 'https:')} referrerPolicy="no-referrer" alt="" className="w-7 h-7 rounded-full object-cover bg-gray-200 dark:bg-gray-700 shrink-0" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
        : <div className="w-7 h-7 rounded-full bg-violet-500/20 text-violet-500 flex items-center justify-center text-xs font-bold shrink-0">{(title || '?').slice(0, 1)}</div>}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-500">{MATRIX_PLAT_ZH[a.platform] || a.platform}</span>
          <span className="text-sm font-medium dark:text-gray-200 truncate">{title}</span>
          <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full ${linked ? 'text-green-600 dark:text-green-400 bg-green-500/15' : 'text-amber-600 dark:text-amber-400 bg-amber-500/15'}`}>{linked ? (isZh ? '已连接' : 'Linked') : (isZh ? '未连接' : 'Not linked')}</span>
        </div>
        <div className="text-[11px] text-gray-500 dark:text-gray-400 truncate">
          {a.displayId ? `${MATRIX_PLAT_ZH[a.platform] || ''}号:${a.displayId} · ` : ''}{isZh ? '备注' : 'note'}:{a.displayName}
        </div>
      </div>
    </div>
  );
};
// 富信息账号下拉(原生 select 放不了头像,自建):未连接账号置灰不可选。
const MatrixAccountSelect: React.FC<{
  isZh: boolean; accounts: MatrixAcctLite[]; value: string; onChange: (id: string) => void; onAddAccount: () => void;
}> = ({ isZh, accounts, value, onChange, onAddAccount }) => {
  const [open, setOpen] = useState(false); // 默认收起,点击「选择已连接账号」条才展开列表
  const boxRef = useRef<HTMLDivElement>(null);
  // 展开后点击别处 / 按 Esc 就收起(否则列表会一直挂着,看着像「一开始就展开了」)。
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  if (accounts.length === 0) {
    return (
      <button type="button" onClick={onAddAccount}
        className="flex-1 text-left px-3 py-2 rounded-lg border border-dashed border-rose-400 text-rose-500 text-xs hover:bg-rose-500/5">
        {isZh ? '⚠️ 暂无该平台账号 · 点此去「我的矩阵账号」连接 →' : '⚠️ No account · link one in "My Matrix Accounts" →'}
      </button>
    );
  }
  const sel = accounts.find((a) => a.id === value);
  return (
    <div ref={boxRef} className="relative flex-1">
      <button type="button" onClick={() => setOpen((o) => !o)}
        className="w-full px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-left flex items-center justify-between gap-2">
        {sel ? <MatrixAcctRow isZh={isZh} a={sel} /> : <span className="text-sm text-gray-400">{isZh ? '— 选择已连接账号 —' : '— pick a linked account —'}</span>}
        <span className="text-gray-400 shrink-0">▾</span>
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-xl max-h-96 overflow-auto p-1">
          {accounts.map((a) => {
            // 未连接的号不再置灰死掉,而是给一个「去连接」入口(点了跳「我的矩阵账号」扫码,口径同各列表向导)。
            const needConnect = a.status === 'login_required';
            return (
              <button key={a.id} type="button"
                onClick={() => { setOpen(false); if (needConnect) { onAddAccount(); return; } onChange(a.id); }}
                title={needConnect ? (isZh ? '该账号尚未连接,点此去「我的矩阵账号」扫码连接' : 'Not linked — click to connect') : undefined}
                className={`w-full text-left px-2 py-1.5 rounded-md flex items-center gap-2 hover:bg-gray-100 dark:hover:bg-gray-700 ${a.id === value ? 'bg-amber-500/10' : ''}`}>
                <span className="min-w-0 flex-1"><MatrixAcctRow isZh={isZh} a={a} /></span>
                {needConnect && <span className="shrink-0 text-[11px] text-amber-500 underline decoration-dotted whitespace-nowrap">{isZh ? '去连接 →' : 'Connect →'}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

// 通用入口卡(3 张视频创作卡复用:电影级 / 在线素材 / 模板速生)。
// accent 决定主色;cost 在描述下方展示「价格」(用户要求 card 表面带价格特点)。
// accent 类名写成完整字面量映射,避免 Tailwind 动态拼接被 purge。
const ENTRY_ACCENTS: Record<string, { tag: string; dot: string; border: string; glow: string; btn: string }> = {
  rose:    { tag: 'text-rose-500',    dot: 'bg-rose-500',    border: 'border-rose-500/30',    glow: 'bg-rose-500/10',    btn: 'bg-rose-500 hover:bg-rose-600 shadow-rose-500/25' },
  sky:     { tag: 'text-sky-500',     dot: 'bg-sky-500',     border: 'border-sky-500/30',     glow: 'bg-sky-500/10',     btn: 'bg-sky-500 hover:bg-sky-600 shadow-sky-500/25' },
  fuchsia: { tag: 'text-fuchsia-500', dot: 'bg-fuchsia-500', border: 'border-fuchsia-500/30', glow: 'bg-fuchsia-500/10', btn: 'bg-fuchsia-500 hover:bg-fuchsia-600 shadow-fuchsia-500/25' },
  violet:  { tag: 'text-violet-500',  dot: 'bg-violet-500',  border: 'border-violet-500/30',  glow: 'bg-violet-500/10',  btn: 'bg-violet-500 hover:bg-violet-600 shadow-violet-500/25' },
};
const VideoScenarioEntryCard: React.FC<{
  isZh: boolean; onOpen: () => void; onGoTasks?: () => void; icon: string;
  tagZh: string; tagEn: string; titleZh: string; titleEn: string; descZh: string; descEn: string;
  btnZh: string; btnEn: string; costZh?: string; costEn?: string; accent?: 'rose' | 'sky' | 'fuchsia' | 'violet';
}> = ({ isZh, onOpen, onGoTasks, icon, tagZh, tagEn, titleZh, titleEn, descZh, descEn, btnZh, btnEn, costZh, costEn, accent = 'rose' }) => {
  const A = ENTRY_ACCENTS[accent];
  return (
    <div className={`relative rounded-2xl border ${A.border} bg-white dark:bg-gray-900 p-5 overflow-hidden flex flex-col`}>
      <div className={`absolute -top-16 -right-16 w-40 h-40 rounded-full ${A.glow} blur-3xl pointer-events-none`} />
      <div className="relative flex flex-col flex-1">
        <div className={`inline-flex items-center gap-1.5 text-xs font-medium ${A.tag} mb-2`}>
          <span className={`inline-block w-1.5 h-1.5 rounded-full ${A.dot} animate-pulse`} />
          {isZh ? tagZh : tagEn}
        </div>
        <h3 className="text-base font-bold dark:text-white mb-1.5">{icon} {isZh ? titleZh : titleEn}</h3>
        <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed mb-2 flex-1">{isZh ? descZh : descEn}</p>
        {(costZh || costEn) && (
          <div className={`text-xs font-semibold ${A.tag} mb-3`}>💰 {isZh ? costZh : costEn}</div>
        )}
        <CardActionRow
          isZh={isZh}
          onConfigure={onOpen}
          onGoToMyTasks={onGoTasks}
          label={isZh ? btnZh : btnEn}
          btnClass={`${A.btn} shadow-lg`}
        />
      </div>
    </div>
  );
};

// ════════════════════════════════════════════════════════════════════
//  卡:模板速生(本地任务 engine='template')— AI 现编动效 HTML → 逐帧渲染出片
//  2 步向导:内容(版式 + 标题 + 数据)→ 出片(赛道 + 品牌色 + 时长 + 定时)
// ════════════════════════════════════════════════════════════════════
const TEMPLATE_STYLES: Array<{ id: VideoTemplateStyle; zh: string; en: string; emoji: string; hint: string }> = [
  { id: 'ai_freeform', zh: 'AI 自由排版', en: 'AI freeform', emoji: '🪄', hint: 'AI 按内容自动设计画面,不限版式(最灵活)' },
  { id: 'rank_list', zh: '排行榜 / 榜单', en: 'Rank list', emoji: '🏆', hint: '涨幅榜、热门榜、Top N' },
  { id: 'news_cards', zh: '资讯快讯', en: 'News cards', emoji: '📰', hint: '今日要点、公告、日报' },
  { id: 'quote', zh: '金句 / 语录', en: 'Quote', emoji: '✍️', hint: '观点、知识点、避坑' },
  { id: 'countdown', zh: '盘点倒数', en: 'Countdown', emoji: '🔟', hint: '倒数揭晓 Top 榜' },
  { id: 'stat_board', zh: '数据看板', en: 'Stat board', emoji: '📊', hint: '几个关键指标大数字' },
  { id: 'timeline', zh: '时间轴 / 历程', en: 'Timeline', emoji: '🧭', hint: '发展历程、路线图、步骤流程' },
  { id: 'cover_hero', zh: '大字封面', en: 'Cover', emoji: '💥', hint: '单主题重磅开场,巨型标题 + 亮点' },
  { id: 'billboard', zh: '逐条大字', en: 'Billboard', emoji: '🎬', hint: '每条一整屏大字,金句连发、逐条揭晓' },
];

// 「AI 自由排版」设计主题(themes.ts 里的成套审美)。auto = 按内容气质自动挑。
const THEME_OPTIONS: Array<{ id: string; zh: string; en: string }> = [
  { id: 'auto', zh: '🎲 自动(按内容挑)', en: '🎲 Auto (by content)' },
  { id: 'swiss_grid', zh: '📐 瑞士网格 · 数据看板', en: '📐 Swiss Grid · data' },
  { id: 'nyt_chart', zh: '📈 纽时图表 · 趋势', en: '📈 NYT Chart · trend' },
  { id: 'pentagram', zh: '🔺 五角星 · 单指标大字', en: '🔺 Pentagram · big stat' },
  { id: 'vignelli', zh: '🅰️ 维格纳利 · 快讯黑红', en: '🅰️ Vignelli · bold red' },
  { id: 'bold_poster', zh: '🍅 大字海报 · 宣言', en: '🍅 Bold Poster' },
  { id: 'build_minimal', zh: '🕊️ 极简留白 · 金句', en: '🕊️ Build Minimal' },
  { id: 'warm_grain', zh: '📜 暖纸颗粒 · 资讯', en: '📜 Warm Grain' },
  { id: 'takram', zh: '🌿 自然柔和 · 科普', en: '🌿 Takram' },
  { id: 'glitch', zh: '📺 故障信号 · 赛博', en: '📺 Glitch' },
  { id: 'bold_signal', zh: '🔶 暗色焦点 · 发布', en: '🔶 Bold Signal' },
  { id: 'creative_voltage', zh: '⚡ 电光创意', en: '⚡ Creative Voltage' },
  { id: 'midnight', zh: '🌌 暗色科技 · web3', en: '🌌 Midnight · web3' },
];

// 模板速生「热榜做数据源」可选榜单 —— 无 catKey 的 name 同时是 /api/web3/hot-search?sources= 的参数,
// 必须跟后端 HOT_SOURCE_ORDER / GlobalHotSearchPage TAB_GROUPS 的名字【精确一致】
// (注意:不是 HOTSPOT_SOURCES 的 zh,后者把 Google/YouTube 写成「Google 趋势/YouTube 热门」对不上)。
// Web3 资讯 / 科技 —— 不是 hot_topics 榜单,而是按 category 聚合(同热搜成片),catKey 标记走
// /api/video/hotspot/preview 取(items[catKey]),name 仅作展示。
const TEMPLATE_HOTLISTS: Array<{ name: string; emoji: string; catKey?: 'web3' | 'tech' }> = [
  { name: '抖音热搜', emoji: '🎵' },
  { name: 'B站热搜', emoji: '📺' },
  { name: '微博热搜', emoji: '🔥' },
  { name: '知乎热榜', emoji: '💭' },
  { name: '百度热搜', emoji: '🔍' },
  { name: '雪球热门股', emoji: '📈' },
  { name: 'Hacker News', emoji: '🟠' },
  { name: 'Reddit', emoji: '👽' },
  { name: 'Google Trends', emoji: '📊' },
  { name: 'YouTube Trending', emoji: '▶️' },
  { name: 'Web3 资讯', emoji: '🌐', catKey: 'web3' },
  { name: '科技 / AI', emoji: '🤖', catKey: 'tech' },
];
/** 「热榜做数据源」取前 N 条标题拼成 dataText。 */
const TEMPLATE_HOTLIST_TOPN = 12;

// 模板速生:4 步向导(2026-06-14 砍掉「版式」步 —— 新建一律 AI 自由排版,它最灵活、涵盖固定版式)。
//   Step 1 内容(来源二选一:粘贴 / 热榜 + 标题 + 风格要求)
//   Step 2 配音(开关 + 音色 + 语速 + 字幕开关 + 自定义口播稿)
//   Step 3 背景音乐(三选一 + 音量)
//   Step 4 出片(品牌色 + 成片去向 + 运行频率)
//   注:固定版式(排行榜/资讯/金句/倒数/数据看板)仍在 templateLibrary,仅老任务编辑时保留,新建不再选。
type TplStep = 1 | 2 | 3 | 4 | 5;

// ── 热搜成片配置向导(engine='hotspot')──────────────────────────────────
//   跟其它视频卡不同:不填赛道/关键词/稿子,只勾「热点源」。每次运行从勾选源最新 20 条
//   随机 1 条选题 → 服务端联网取材 → AI 紧贴资料写口播 → Serper 配图 → 合成 → 发布。
//   出片/发布/定时/登录校验全复用既有 video task 基础设施(差别只在 engine='hotspot')。
// 热点源:热搜榜按【具体榜】分开选(对齐 backend HOTSPOT_SOURCE_MAP 的 key),web3/科技按分类。
// def=true 的新建时默认勾选。
const HOTSPOT_SOURCES: Array<{ id: string; zh: string; en: string; emoji: string; def: boolean }> = [
  // 抖音 / B站 / 微博 放最前(默认勾选的常用榜),其余跟后。
  { id: 'douyin',   zh: '抖音热搜',   en: 'Douyin',   emoji: '🎵', def: true },
  { id: 'bilibili', zh: 'B站热搜',    en: 'Bilibili', emoji: '📺', def: true },
  { id: 'weibo',    zh: '微博热搜',   en: 'Weibo',    emoji: '🔥', def: true },
  { id: 'zhihu',    zh: '知乎热榜',   en: 'Zhihu',    emoji: '💭', def: true },
  { id: 'baidu',    zh: '百度热搜',   en: 'Baidu',    emoji: '🔍', def: true },
  { id: 'xueqiu',   zh: '雪球热门股', en: 'Xueqiu',   emoji: '📈', def: false },
  // 国外热榜(英文标题,后端 lang=en;英文话题写稿仍强制中文口播)。默认不勾,国内用户按需开。
  { id: 'hackernews',   zh: 'Hacker News',  en: 'Hacker News',   emoji: '🟠', def: false },
  { id: 'reddit',       zh: 'Reddit',       en: 'Reddit',        emoji: '👽', def: false },
  { id: 'googletrends', zh: 'Google 趋势',  en: 'Google Trends', emoji: '📊', def: false },
  { id: 'youtube',      zh: 'YouTube 热门', en: 'YouTube',       emoji: '▶️', def: false },
  { id: 'web3',     zh: 'Web3 资讯',  en: 'Web3',     emoji: '🌐', def: false },
  { id: 'tech',     zh: '科技 / AI',  en: 'Tech/AI',  emoji: '🤖', def: false },
];

// 热搜成片每次运行出片条数封顶(本地渲染 + 按条计费,不开到币安发帖的 200)。
const HOTSPOT_COUNT_CAP = 100;

export const HotspotVideoModal: React.FC<{
  isZh: boolean;
  /** 矩阵号 edition:发布平台下多一步「选账号」,发布走指纹内核 CDP。 */
  matrixMode?: boolean;
  onClose: () => void;
  onCreated?: (id: string) => void;
  editTask?: any;
  onSaved?: () => void;
}> = ({ isZh, matrixMode, onClose, onCreated, editTask, onSaved }) => {
  const isEdit = !!editTask;
  const ei = editTask?.input || {};
  // 任务名不再让用户填:沿用编辑态旧名,新建固定「热搜成片」(见 buildTitle)。
  const [title] = useState<string>(editTask?.title || '');
  const [sources, setSources] = useState<Record<string, boolean>>(() => {
    const saved: string[] = Array.isArray(ei.hotspotSources) && ei.hotspotSources.length
      ? ei.hotspotSources
      : HOTSPOT_SOURCES.filter((s) => s.def).map((s) => s.id);  // 新建默认勾选常用榜
    const init: Record<string, boolean> = {};
    HOTSPOT_SOURCES.forEach((s) => { init[s.id] = saved.includes(s.id); });
    return init;
  });
  const [targetSeconds, setTargetSeconds] = useState<number>(ei.targetSeconds ?? 60);
  // 素材来源:'image'=Serper 配图 Ken Burns;'douyin'=搜抖音视频混剪 + 底部黑条盖原字幕。
  // 新建默认【按界面语言分流】:中文界面(国内/华人,有抖音)默认抖音混剪;海外(非中文,
  // 多半没抖音)默认图片配图。用户仍可在向导手动改;编辑态沿用已存值。
  const [materialSource, setMaterialSource] = useState<'image' | 'douyin'>(
    ei.hotspotMaterialSource === 'douyin' ? 'douyin'
      : ei.hotspotMaterialSource === 'image' ? 'image'
        : (isZh ? 'douyin' : 'image'),
  );
  // 画面素材来源平台(抖音/TikTok)+ 用于全网取材的账号(必须该平台已连接账号)。
  const [materialPlatform, setMaterialPlatform] = useState<'douyin' | 'tiktok'>(
    (ei as any).hotspotMaterialPlatform === 'tiktok' ? 'tiktok' : (ei as any).hotspotMaterialPlatform === 'douyin' ? 'douyin' : (isZh ? 'douyin' : 'tiktok'),
  );
  const [materialAccountId, setMaterialAccountId] = useState<string>((ei as any).hotspotMaterialAccountId || '');
  const [subtitleEnabled, setSubtitleEnabled] = useState<boolean>(ei.subtitleEnabled ?? true);
  const [voice, setVoice] = useState<string>(ei.voice || 'zh-CN-YunjianNeural');
  const [voiceRate, setVoiceRate] = useState<number>(ei.voiceRate ?? 0);
  // 创作语言:决定 AI 口播稿语言('auto' = 按热点标题语言,老行为)。中文热搜 + 英文口播 = 热点出海玩法。
  // 选定语言与音色语种不匹配 → 自动切该语种默认音色(与在线素材/模板速生同一套联动)。
  const [scriptLang, setScriptLang] = useState<string>((ei as any).scriptLang || 'auto');
  const pickScriptLang = (code: string) => {
    setScriptLang(code);
    const opt = SCRIPT_LANGS.find((l) => l.code === code);
    if (opt && opt.code !== 'auto' && opt.voicePrefixes.length && !opt.voicePrefixes.some((p) => voice.startsWith(p))) {
      setVoice(opt.defaultVoice);
    }
  };
  // 字幕样式 + BGM(用户要可调)。字幕位置默认按界面语言:中文→中下(配合抖音混剪盖原字幕),海外→底部。
  const [subtitlePosition, setSubtitlePosition] = useState<SubtitlePosition>(ei.subtitlePosition || (isZh ? 'lower' : 'bottom'));
  const [subtitleColor, setSubtitleColor] = useState<string>(ei.subtitleColor || '#FFE600');
  const [subtitleFont, setSubtitleFont] = useState<string>(ei.subtitleFont || '');
  // 字号 + 描边(以前 hotspot 没给,字幕只能默认大小/白字)。新建默认大号 64 + 黑描边(短视频最醒目);
  // 编辑保留任务已存值(空串描边 = 用户特意选「无」,?? 不会覆盖)。
  const [subtitleFontSize, setSubtitleFontSize] = useState<number>(ei.subtitleFontSize ?? 64);
  const [subtitleStrokeColor, setSubtitleStrokeColor] = useState<string>(ei.subtitleStrokeColor ?? '#000000');
  // BGM 默认选中第 1 首内置曲目(新建任务,跟在线素材/模板速生一致);编辑老任务沿用其已存值(空也保留)。
  const [bgmPath, setBgmPath] = useState<string>(isEdit ? (ei.bgmPath || '') : `${BUILTIN_BGM_PREFIX}${BUILTIN_BGM[0].id}`);
  // 云端曲库(跟模板速生 / 在线素材同源 static.noobclaw.com/bgm/manifest.json)。
  // 没这个时 hotspot 只能选 8 首内置;拉到后追加「云端曲库」optgroup。失败静默。
  const [remoteBgm, setRemoteBgm] = useState<RemoteBgm[]>([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const resp = await fetch(`${REMOTE_BGM_MANIFEST_URL}?t=${Date.now()}`);
        if (!resp.ok) return;
        const json: any = await resp.json();
        const arr: any[] = Array.isArray(json) ? json : json?.tracks;
        if (!alive || !Array.isArray(arr)) return;
        setRemoteBgm(arr.filter((x) => x && typeof x.url === 'string' && x.url)
          .map((x) => ({ id: String(x.id || x.url), zh: String(x.zh || x.title || x.name || '云端音乐'), en: String(x.en || x.title || x.name || 'Cloud track'), url: String(x.url) })));
      } catch { /* 清单未上线 / 网络失败:静默,仅用本地曲库 */ }
    })();
    return () => { alive = false; };
  }, []);
  const [outputMode, setOutputMode] = useState<OutputMode>(
    !editTask ? 'upload' // 新建默认「发布到平台」(用户要求)
      : (Array.isArray(ei.publishPlatforms) && ei.publishPlatforms.length > 0 ? 'upload' : 'local'));
  const [platforms, setPlatforms] = useState<Record<Platform, boolean>>(() => {
    const saved: string[] = Array.isArray(ei.publishPlatforms) ? ei.publishPlatforms : [];
    const init = {} as Record<Platform, boolean>;
    // 新建默认勾选(用户要求):抖音/小红书/快手/视频号/头条号/B站;编辑老任务恢复保存值。
    const base: string[] = !editTask ? DEFAULT_PUBLISH_PLATFORMS : saved;
    PUBLISH_PLATFORMS.forEach((p) => { init[p.id] = base.includes(p.id); });
    return init;
  });
  // 对齐币安:不提供「每天定时」(固定钟点易被风控判机器人),默认/兜底走「每日随机时间」。
  // 编辑老任务若存的是 'daily',统一归到 'daily_random'(币安同款迁移)。
  const [runInterval, setRunInterval] = useState<VideoRunInterval>(
    editTask?.runInterval && editTask.runInterval !== 'daily' ? editTask.runInterval : 'daily_random');
  // 每次运行出片条数随机区间 [min,max](对齐币安「每次运行发帖条数」)。封顶 10。
  // 每次定时/手动运行,主进程在区间内随机取 N,跑 N 条各自独立选题+写稿+按条计费。
  // 每次运行【固定】出片条数(单滑块)。老任务用 videoCount / 老的 min/max 取个初值兜底。
  const [count, setCount] = useState<number>(Math.max(1, Math.min(HOTSPOT_COUNT_CAP, Math.round(ei.videoCount ?? (ei as any).videoCountMax ?? (ei as any).videoCountMin ?? 1))));
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');
  // 校验提示 5s 后自动消失,不一直挂在那。
  useEffect(() => { if (!err) return; const t = setTimeout(() => setErr(''), 5000); return () => clearTimeout(t); }, [err]);
  const [showLoginCheck, setShowLoginCheck] = useState(false);
  // 分步向导:① 热点源 → ② 内容 → ③ 配音 → ④ 成片去向 → ⑤ 运行频率。
  // 矩阵号在「去向」后多插一步「账号」(step 5),频率顺延到 step 6。
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5 | 6>(1);
  // 账号步只在矩阵 edition 存在;频率步在矩阵下是 6、非矩阵是 5。
  // 步骤:1热点源 2内容 3字幕 4配音 5去向(出片后+频率) 6发布(发布平台+账号)。
  const PUBLISH_STEP = 6 as const;     // 「发布」步:发布平台多选 + 每平台选号(matrix)
  const MAX_STEP = 6;

  // 热点源预览:每个榜当前 top-3 实时条目,挂在卡片下方,让用户选前就知道会选中什么内容。
  // 拉失败不影响选择(静默)。打开向导时拉一次。
  const [previews, setPreviews] = useState<Record<string, { title: string }[]>>({});
  const [previewLoading, setPreviewLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${getBackendApiUrl()}/api/video/hotspot/preview`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ perSource: 3 }),
        });
        const json = await res.json();
        if (alive && json?.items && typeof json.items === 'object') setPreviews(json.items);
      } catch { /* 预览失败不影响选择 */ }
      finally { if (alive) setPreviewLoading(false); }
    })();
    return () => { alive = false; };
  }, []);

  // 按条平台费区间(USD)由服务端下发(/api/video/config,admin 可调),计费文案用动态值不写死。
  const [fee, setFee] = useState<{ min: number; max: number }>({ min: 0.02, max: 0.1 });
  useEffect(() => { fetchVideoFeeRange().then(setFee).catch(() => { /* 兜底 */ }); }, []);

  const selectedSources = HOTSPOT_SOURCES.filter((s) => sources[s.id]).map((s) => s.id);
  // 按 PUBLISH_PLATFORMS 顺序取(不用 Object.keys)→ 发布顺序 = 列表顺序(B 站在最后),改一处列表即可
  const selectedPlatformIds = PUBLISH_PLATFORMS.map((m) => m.id).filter((p) => platforms[p]);

  // ── 矩阵号:每个发布平台选一个账号(平台→accountId)。账号走指纹内核 CDP 发布。 ──
  // 拉一次本地矩阵账号池;按平台分组,在「账号」步给每个已勾平台一个下拉(可用号才列)。
  const [matrixAccounts, setMatrixAccounts] = useState<MatrixAcctLite[]>([]);
  const [accountByPlatform, setAccountByPlatform] = useState<Record<string, string>>(
    () => (matrixMode && editTask?.input?.publishAccounts && typeof editTask.input.publishAccounts === 'object' ? { ...editTask.input.publishAccounts } : {}),
  );
  useEffect(() => {
    if (!matrixMode) return;
    let alive = true;
    (async () => {
      try {
        const r = await (window as any).electron?.matrix?.listAccounts?.();
        const accs: any[] = r?.ok && Array.isArray(r.accounts) ? r.accounts : [];
        if (alive) setMatrixAccounts(accs.map((a) => ({ id: a.id, platform: a.platform, displayName: a.displayName, status: a.status, nickname: a.nickname, displayId: a.displayId, avatar: a.avatar, loginScope: a.loginScope })));
      } catch { if (alive) setMatrixAccounts([]); }
    })();
    return () => { alive = false; };
  }, [matrixMode]);
  // 某平台下「可用」账号(idle / running 视为可登录可用;banned/login_required 仍列出但标注,选号交给用户)。
  // 发布上传:快手只列「创作者中心」账号(主站号没有 cp 发布登录态)。
  const accountsFor = (platform: string) => matrixAccounts.filter((a) => a.platform === platform && (platform !== 'kuaishou' || (a as any).loginScope === 'creator'));
  // 矩阵 + 发布模式下:每个勾选平台是否都已选号(没号的平台算未满足 → 引导建号)。
  const matrixAccountsReady = !matrixMode || outputMode !== 'upload'
    || selectedPlatformIds.every((p) => !!accountByPlatform[p] && accountsFor(p).some((a) => a.id === accountByPlatform[p] && a.status !== 'login_required'));
  // 取材账号:必须选且【已连接】(matrix 下取材靠该号指纹内核做全网搜索/下载)。
  const materialAccountReady = !matrixMode
    || accountsFor(materialPlatform).some((a) => a.id === materialAccountId && a.status !== 'login_required');

  // 任务名不再让用户填(每次随机选题,固定名没意义)→ 新建固定「热搜成片」,编辑保留旧名。
  const buildTitle = () => (title.trim() || (isZh ? '热搜成片' : 'Hotspot Video'));
  const buildInput = (): VideoCreationInput => ({
    persona: '', track: '', keywords: [], script: '', scriptMode: 'ai',
    engine: 'hotspot',
    hotspotSources: selectedSources,
    hotspotMaterialSource: materialSource,
    // 画面素材来源平台 + 取材账号(运行时用该账号指纹内核全网搜+下素材)。
    hotspotMaterialPlatform: materialPlatform,
    hotspotMaterialAccountId: materialAccountId || undefined,
    // 创作语言:'auto' 不传 = 按热点标题语言(老行为);选定 = 口播稿/字幕强制该语言(热点出海)。
    scriptLang: scriptLang !== 'auto' ? scriptLang : undefined,
    referenceImages: [],
    aspect: '9:16',
    publishPlatforms: outputMode === 'upload' ? selectedPlatformIds : [],
    // 矩阵号:每个发布平台选定的账号(平台→accountId),发布时按号走 CDP。仅取已勾平台的映射。
    publishAccounts: matrixMode && outputMode === 'upload'
      ? Object.fromEntries(selectedPlatformIds.filter((p) => accountByPlatform[p]).map((p) => [p, accountByPlatform[p]]))
      : undefined,
    // 账号【名字】也存一份(平台→名),详情/记录页直接展示「上传到 抖音(账号1-涛涛)」,不必再查账号库。
    publishAccountNames: matrixMode && outputMode === 'upload'
      ? Object.fromEntries(selectedPlatformIds.filter((p) => accountByPlatform[p]).map((p) => { const a = matrixAccounts.find((x) => x.id === accountByPlatform[p]); return [p, a ? (a.nickname || a.displayName) : accountByPlatform[p]]; }))
      : undefined,
    targetSeconds,
    useStockVideo: false,            // 纯图 Ken Burns(Serper 给的是图,不是视频)
    subtitleEnabled,
    subtitlePosition,
    subtitleColor,
    subtitleFont,
    subtitleFontSize,
    subtitleStrokeColor: subtitleStrokeColor || undefined,
    bgmPath,
    voice,
    voiceRate,
    maxClipSeconds: 4,
    // 出片条数随机区间(归一化 min≤max)。videoCount 存 max 作向后兼容/旧展示兜底。
    videoCountMin: count,
    videoCountMax: count,
    videoCount: count,
  });

  const doCreate = async () => {
    if (submitting) return;
    setSubmitting(true);
    setErr('');
    try {
      const input = buildInput();
      // 热搜成片不提供「每天定时」→ 无 dailyTime(daily_random/间隔类都不需要固定时刻)。
      const schedule: VideoSchedule = { runInterval };
      if (isEdit && editTask) {
        const ok = videoTaskStore.updateTask(editTask.id, input, buildTitle(), schedule);
        if (!ok) { setErr(isZh ? '任务正在运行,无法编辑。' : 'Task running, cannot edit.'); return; }
        onSaved?.();
        return;
      }
      if (!(await videoQueue.canCreate())) {
        setErr(isZh
          ? `视频任务已满(${VIDEO_TASK_LIMIT}/${VIDEO_TASK_LIMIT}),请先到「我的视频任务」删掉已完成的再新建。`
          : `Video tasks full (${VIDEO_TASK_LIMIT}/${VIDEO_TASK_LIMIT}). Delete a finished one first.`);
        return;
      }
      const id = videoTaskStore.createTask(input, buildTitle(), schedule);
      onCreated?.(id);
    } finally {
      setSubmitting(false);
    }
  };

  // 最后一步「创建/保存」:校验源 → 发布前置。
  const onSubmitClick = () => {
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); return; } // 未登录 → 弹登录窗
    if (selectedSources.length === 0) { setStep(1); setErr(isZh ? '请至少勾选一个热点源' : 'Pick at least one source'); return; }
    // 矩阵号:发布按账号走指纹内核 CDP,登录态在跑任务时按号校验 → 不弹扩展登录校验框;
    //   但必须每个勾选平台都选好账号(没号的让用户先去「我的矩阵账号」建)。
    if (matrixMode) {
      if (!materialAccountReady) {
        setStep(2);
        setErr(isZh ? '请先选择一个取材账号,用全网查询取材' : 'Pick a footage-source account first');
        return;
      }
      if (outputMode === 'upload' && !matrixAccountsReady) {
        setStep(PUBLISH_STEP);
        setErr(isZh ? '请为每个发布平台选择一个账号(没有账号的平台请先去「我的矩阵账号」添加)' : 'Pick an account for each platform first');
        return;
      }
      void doCreate();
      return;
    }
    // 非矩阵(插件路线):要发布 + 勾了平台 → 先过登录校验(全登录才放行)。
    if (outputMode === 'upload' && selectedPlatformIds.length > 0) { setErr(''); setShowLoginCheck(true); return; }
    void doCreate();
  };

  // 「下一步」按 step 校验后推进;step 1 必须至少勾一个源;step 5(发布)选「上传」必须至少勾一个平台,
  // 矩阵下还要每个勾选平台都选好号。
  const goNext = () => {
    if (step === 1 && selectedSources.length === 0) { setErr(isZh ? '请至少勾选一个热点源' : 'Pick at least one source'); return; }
    if (step === 2 && !materialAccountReady) {
      setErr(isZh ? '请先选择一个取材账号,用全网查询取材' : 'Pick a footage-source account first');
      return;
    }
    if (step === PUBLISH_STEP && outputMode === 'upload' && selectedPlatformIds.length === 0) {
      setErr(isZh ? '已选「上传到各大平台」,请至少勾选一个平台(或回上一步改「仅存本地」)' : 'Pick at least one platform, or switch to "Local only"');
      return;
    }
    if (matrixMode && step === PUBLISH_STEP && outputMode === 'upload' && !matrixAccountsReady) {
      setErr(isZh ? '请为每个发布平台选择一个账号' : 'Pick an account for each platform');
      return;
    }
    setErr('');
    setStep((s) => (s < MAX_STEP ? ((s + 1) as 1 | 2 | 3 | 4 | 5 | 6) : s));
  };
  const goBack = () => {
    setErr('');
    if (step === 1) { onClose(); return; }
    setStep((s) => ((s - 1) as 1 | 2 | 3 | 4 | 5 | 6));
  };

  const DUR = [30, 45, 60, 90, 120];
  // 运行频率档位:逐字对齐币安发帖场景 —— 故意不给「每天定时」(固定钟点易被风控判机器人),
  // 用「每日随机时间」代替并设为推荐。30min/1h/3h/6h + 每日随机时间 + 不重复。
  const FREQ_OPTS: { v: VideoRunInterval; zh: string; en: string }[] = [
    { v: 'once', zh: '不重复', en: 'Once' },
    { v: '30min', zh: '每 30 分钟', en: 'Every 30min' },
    { v: '1h', zh: '每小时', en: 'Hourly' },
    { v: '3h', zh: '每 3 小时', en: 'Every 3h' },
    { v: '6h', zh: '每 6 小时', en: 'Every 6h' },
    { v: 'daily_random', zh: '每日随机时间', en: 'Daily (random time)' },
  ];
  const isShortJitter = runInterval === '30min' || runInterval === '1h';
  const isLongJitter = runInterval === '3h' || runInterval === '6h';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" />
      <div className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 px-6 pt-5 pb-3 border-b border-gray-100 dark:border-gray-800 bg-white/95 dark:bg-gray-900/95 backdrop-blur flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold dark:text-white flex items-center gap-2">
              <span>🔥</span>{isZh ? (isEdit ? '编辑 · 热搜成片' : '热搜成片') : (isEdit ? 'Edit · Hotspot Video' : 'Hotspot Video')}
            </h3>
            <div className="flex items-center gap-2 mt-3 flex-wrap">
              <StepDot n={1} active={step === 1} done={step > 1} label={isZh ? '热点源' : 'Sources'} />
              <div className={`h-px w-3 ${step > 1 ? 'bg-rose-500' : 'bg-gray-200 dark:bg-gray-700'}`} />
              <StepDot n={2} active={step === 2} done={step > 2} label={isZh ? '内容' : 'Content'} />
              <div className={`h-px w-3 ${step > 2 ? 'bg-rose-500' : 'bg-gray-200 dark:bg-gray-700'}`} />
              <StepDot n={3} active={step === 3} done={step > 3} label={isZh ? '字幕' : 'Subtitle'} />
              <div className={`h-px w-3 ${step > 3 ? 'bg-rose-500' : 'bg-gray-200 dark:bg-gray-700'}`} />
              <StepDot n={4} active={step === 4} done={step > 4} label={isZh ? '配音' : 'Audio'} />
              <div className={`h-px w-3 ${step > 4 ? 'bg-rose-500' : 'bg-gray-200 dark:bg-gray-700'}`} />
              <StepDot n={5} active={step === 5} done={step > 5} label={isZh ? '去向' : 'Output'} />
              <div className={`h-px w-3 ${step > 5 ? 'bg-rose-500' : 'bg-gray-200 dark:bg-gray-700'}`} />
              <StepDot n={6} active={step === 6} done={false} label={isZh ? '发布' : 'Publish'} />
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <div className="px-6 py-5 space-y-5">
          {/* ── Step 1:热点源 ── */}
          {step === 1 && (
            <>
              <p className="text-[12px] leading-relaxed text-gray-500 dark:text-gray-400 bg-amber-50 dark:bg-amber-500/10 rounded-lg px-3 py-2">
                {isZh
                  ? '每次运行从你勾选的热点源最新 20 条里随机挑 1 条,联网查这条热点的最新资料、AI 紧贴资料写口播稿、自动配图片成片。配合「每日随机时间」= 全自动日更。'
                  : 'Each run randomly picks 1 of the latest 20 from your chosen sources, fetches the latest web info, writes a script tight to it, and auto-composes with relevant images. Pair with daily schedule for full auto.'}
              </p>
              <Field label={isZh ? '热点源(可多选,榜单实时更新)' : 'Sources (multi)'} hint={isZh ? '定时从勾选的榜 top20 随机选题' : 'random topic from selected boards'}>
                <div className="grid grid-cols-2 gap-2">
                  {/* Web3 资讯是【信息源】不是 web3 平台功能:海外平台(TikTok/YouTube/X…)发片用得上,国内版不砍(2026-07-05 拍板)。 */}
                  {HOTSPOT_SOURCES.map((s) => {
                    const on = !!sources[s.id];
                    const items = previews[s.id];
                    return (
                      <button key={s.id} type="button"
                        onClick={() => setSources((p) => ({ ...p, [s.id]: !p[s.id] }))}
                        className={`flex flex-col gap-1.5 px-3 py-2 rounded-lg border text-sm text-left transition-all ${
                          on ? 'border-amber-500 bg-amber-50 dark:bg-amber-500/10' : 'border-gray-200 dark:border-gray-700 hover:border-amber-300'}`}>
                        <span className="flex items-center gap-2 w-full">
                          <span>{s.emoji}</span>
                          <span className="flex-1 min-w-0 truncate dark:text-gray-100">{isZh ? s.zh : s.en}</span>
                          {on && <span className="text-amber-500">✓</span>}
                        </span>
                        {/* 卡片下方挂当前 top-3(实时);整张卡片仍是勾选目标,预览只是静态文字,不冲突。 */}
                        <span className="block w-full text-[11px] leading-snug text-gray-400 dark:text-gray-500">
                          {items && items.length > 0
                            ? items.slice(0, 3).map((it, i) => (
                                <span key={i} className="block truncate">{i + 1}. {it.title}</span>
                              ))
                            : <span className="block truncate">{previewLoading ? (isZh ? '加载中…' : 'Loading…') : (isZh ? '暂无内容' : 'No items')}</span>}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </Field>
            </>
          )}

          {/* ── Step 2:内容(目标时长 + 画面素材 + 来源平台 + 取材账号) ── */}
          {step === 2 && (
            <>
              <Field label={isZh ? '目标时长' : 'Target length'}>
                <div className="flex flex-wrap gap-2">
                  {DUR.map((d) => (
                    <button key={d} type="button" onClick={() => setTargetSeconds(d)}
                      className={`px-3 py-1.5 rounded-lg text-sm border ${targetSeconds === d ? 'border-amber-500 bg-amber-500 text-white' : 'border-gray-200 dark:border-gray-700 dark:text-gray-300'}`}>{d}s</button>
                  ))}
                </div>
              </Field>
              <Field label={isZh ? '画面素材' : 'Footage'}>
                <div className="flex gap-2">
                  {([
                    { v: 'image', zh: '🖼️ 智能配图', en: '🖼️ Images', deszh: '通过关键词在抖音/TikTok找最匹配图文素材进行制作' },
                    { v: 'douyin', zh: '🎬 智能混剪', en: '🎬 Smart remix', deszh: '通过关键词在抖音/TikTok找最匹配视频素材进行混剪' },
                  ] as const).map((m) => (
                    <button key={m.v} type="button" onClick={() => setMaterialSource(m.v)}
                      className={`flex-1 px-3 py-2 rounded-lg text-sm border text-left ${materialSource === m.v ? 'border-amber-500 bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400 font-semibold' : 'border-gray-200 dark:border-gray-700 dark:text-gray-300'}`}>
                      <div>{isZh ? m.zh : m.en}</div>
                      {isZh && <div className="text-[11px] font-normal text-gray-500 dark:text-gray-400 mt-0.5">{m.deszh}</div>}
                    </button>
                  ))}
                </div>
              </Field>
              {/* 画面素材来源平台 + 取材账号:运行时用该账号的指纹浏览器做【全网搜索 + 下载素材】,绝不发帖/改动账号。 */}
              <Field label={isZh ? '画面素材来源' : 'Footage source'} hint={isZh ? `仅用一个已连接${materialPlatform === 'tiktok' ? 'TikTok' : '抖音'}账号做全网搜索 + 下载素材` : `search & download via a linked ${materialPlatform === 'tiktok' ? 'TikTok' : 'Douyin'} account`}>
                <div className="flex gap-2 mb-2">
                  {([{ v: 'douyin', zh: '🎵 抖音', en: '🎵 Douyin' }, { v: 'tiktok', zh: '🎬 TikTok', en: '🎬 TikTok' }] as const).map((p) => (
                    <button key={p.v} type="button" onClick={() => { setMaterialPlatform(p.v); setMaterialAccountId(''); }}
                      className={`flex-1 px-3 py-2 rounded-lg text-sm border ${materialPlatform === p.v ? 'border-amber-500 bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400 font-semibold' : 'border-gray-200 dark:border-gray-700 dark:text-gray-300'}`}>
                      {isZh ? p.zh : p.en}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-3">
                  <div className="w-20 shrink-0 text-sm font-medium dark:text-gray-200">{isZh ? '取材账号' : 'Account'}</div>
                  <MatrixAccountSelect
                    isZh={isZh}
                    accounts={accountsFor(materialPlatform)}
                    value={materialAccountId}
                    onChange={setMaterialAccountId}
                    onAddAccount={() => { window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform: materialPlatform } })); onClose(); }}
                  />
                </div>
              </Field>
            </>
          )}

          {/* ── Step 3:字幕(烧录开关 + 样式)—— 单独成步,不挤在「内容」步 ── */}
          {step === 3 && (
            <>
              <label className="flex items-center gap-2 text-sm dark:text-gray-200 cursor-pointer">
                <input type="checkbox" checked={subtitleEnabled} onChange={(e) => setSubtitleEnabled(e.target.checked)} className="w-4 h-4 accent-amber-500" />
                {isZh ? '烧录字幕' : 'Burn subtitles'}
              </label>
              {subtitleEnabled && (
                <Field label={isZh ? '字幕样式' : 'Subtitle'}>
                  {/* 字号 */}
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs text-gray-500 w-10 shrink-0">{isZh ? '字号' : 'Size'}</span>
                    <div className="flex flex-wrap gap-1">
                      {SUB_FONTSIZE_OPTIONS.map((f) => (
                        <button key={f.v} type="button" onClick={() => setSubtitleFontSize(f.v)}
                          className={`px-2.5 py-1 rounded-lg text-xs border ${subtitleFontSize === f.v ? 'border-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300'}`}>
                          {isZh ? f.zh : f.en}
                        </button>
                      ))}
                    </div>
                  </div>
                  {/* 位置 */}
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs text-gray-500 w-10 shrink-0">{isZh ? '位置' : 'Pos'}</span>
                    <div className="flex flex-wrap gap-1">
                      {SUB_POSITION_OPTIONS.map((s) => (
                        <button key={s.id} type="button" onClick={() => setSubtitlePosition(s.id)}
                          className={`px-2.5 py-1 rounded-lg text-xs border ${subtitlePosition === s.id ? 'border-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300'}`}>
                          {isZh ? s.zh : s.en}
                        </button>
                      ))}
                    </div>
                  </div>
                  {/* 字体 + 文字颜色 */}
                  <div className="flex items-center gap-2 mb-2">
                    <select value={subtitleFont} onChange={(e) => setSubtitleFont(e.target.value)}
                      className="flex-1 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-xs dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500/50">
                      {SUB_FONT_OPTIONS.map((f) => (<option key={f.v || 'default'} value={f.v}>{isZh ? f.zh : f.en}</option>))}
                    </select>
                    <div className="flex gap-1.5">
                      {SUB_COLOR_OPTIONS.map((c) => (
                        <button key={c.v} type="button" title={isZh ? c.zh : c.en} onClick={() => setSubtitleColor(c.v)}
                          className={`w-6 h-6 rounded-full border-2 ${subtitleColor === c.v ? 'border-amber-500 scale-110' : 'border-gray-300 dark:border-gray-600'}`}
                          style={{ backgroundColor: c.v }} />
                      ))}
                    </div>
                  </div>
                  {/* 描边颜色("无" = 半透明黑底盒) */}
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500 w-10 shrink-0">{isZh ? '描边' : 'Stroke'}</span>
                    <div className="flex gap-1.5">
                      {SUB_STROKE_OPTIONS.map((c) => {
                        const active = subtitleStrokeColor === c.v;
                        if (c.v === '') {
                          return (
                            <button key="none" type="button" onClick={() => setSubtitleStrokeColor('')}
                              className={`px-2 h-6 rounded-full text-[11px] border-2 ${active ? 'border-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-400' : 'border-gray-300 dark:border-gray-600 text-gray-500'}`}>
                              {isZh ? '无' : 'None'}
                            </button>
                          );
                        }
                        return (
                          <button key={c.v} type="button" title={isZh ? c.zh : c.en} onClick={() => setSubtitleStrokeColor(c.v)}
                            className={`w-6 h-6 rounded-full border-2 ${active ? 'border-amber-500 scale-110' : 'border-gray-300 dark:border-gray-600'}`}
                            style={{ backgroundColor: c.v }} />
                        );
                      })}
                    </div>
                  </div>
                </Field>
              )}
            </>
          )}

          {/* ── Step 4:配音 + 背景音乐 ── */}
          {step === 4 && (
            <>
              <Field label={isZh ? '创作语言' : 'Script language'} hint={isZh ? '决定 AI 口播稿和字幕的语言;自动 = 跟热点标题。选外语可做「中文热点讲给海外看」' : 'AI narration & subtitle language; Auto follows the topic. Pick another to retell local trends abroad'}>
                <select value={scriptLang} onChange={(e) => pickScriptLang(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500/50">
                  {SCRIPT_LANGS.map((l) => (
                    <option key={l.code} value={l.code}>{isZh ? l.zh : l.en}</option>
                  ))}
                </select>
              </Field>
              <Field label={isZh ? '配音音色' : 'Voice'}>
                <select value={voice} onChange={(e) => setVoice(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500/50">
                  {VOICE_GROUPS.map((g) => (
                    <optgroup key={g.groupZh} label={isZh ? g.groupZh : g.groupEn}>
                      {g.voices.map((v) => (<option key={v.id} value={v.id}>{isZh ? v.zh : v.en}</option>))}
                    </optgroup>
                  ))}
                </select>
                <div className="flex gap-2 mt-2">
                  {RATE_OPTIONS.map((r) => (
                    <button key={r.v} type="button" onClick={() => setVoiceRate(r.v)}
                      className={`flex-1 px-2 py-1.5 rounded-lg text-xs border ${voiceRate === r.v ? 'border-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300'}`}>
                      {isZh ? r.zh : r.en}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label={isZh ? '背景音乐(选填)' : 'BGM (optional)'}>
                <select value={bgmPath} onChange={(e) => setBgmPath(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500/50">
                  <option value="">{isZh ? '无背景音乐' : 'None'}</option>
                  {/* 编辑老任务时选中的云端曲目可能不在已拉清单里(清单变了/拉不到)→ 补占位,避免下拉空白。 */}
                  {bgmPath.startsWith(REMOTE_BGM_PREFIX) && !remoteBgm.some((b) => `${REMOTE_BGM_PREFIX}${b.url}` === bgmPath) && (
                    <option value={bgmPath}>☁️ {bgmDisplayName(bgmPath, isZh, remoteBgm)}</option>
                  )}
                  <optgroup label={isZh ? '内置曲库' : 'Built-in'}>
                    {BUILTIN_BGM.map((b) => (<option key={b.id} value={`${BUILTIN_BGM_PREFIX}${b.id}`}>🎵 {isZh ? b.zh : b.en}</option>))}
                  </optgroup>
                  {remoteBgm.length > 0 && (
                    <optgroup label={isZh ? '云端曲库（首次需下载）' : 'Cloud (downloads first time)'}>
                      {remoteBgm.map((b) => (<option key={b.url} value={`${REMOTE_BGM_PREFIX}${b.url}`}>☁️ {isZh ? b.zh : b.en}</option>))}
                    </optgroup>
                  )}
                </select>
              </Field>
            </>
          )}

          {/* ── Step 5:出片后(本地/上传)+ 运行频率 + 每次条数(出片后与频率合并到一步)── */}
          {step === 5 && (
            <>
              <OutputModeToggle isZh={isZh} outputMode={outputMode} setOutputMode={setOutputMode} />
              <Field label={isZh ? '运行频率' : 'Frequency'} hint={isZh ? '到点自动按上面配置重跑' : 'auto-rerun on schedule'}>
                <div className="grid grid-cols-3 gap-2">
                  {FREQ_OPTS.map((o) => (
                    <button key={o.v} type="button" onClick={() => setRunInterval(o.v)}
                      className={`px-2 py-1.5 rounded-lg text-xs border transition-colors ${runInterval === o.v ? 'border-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-amber-300'}`}>
                      {isZh ? o.zh : o.en}
                    </button>
                  ))}
                </div>
                {runInterval === 'daily_random' && (
                  <p className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">{isZh ? '✨ 推荐 — 每天随机时间触发,比固定钟点更像真人' : '✨ Recommended — daily at a randomized time, more human-like'}</p>
                )}
                {isShortJitter && (
                  <p className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">{isZh ? '⚠️ 到点后再加 1-10 分钟随机延迟,避免精准卡点' : '⚠️ +1-10min jitter after threshold (anti-detection).'}</p>
                )}
                {isLongJitter && (
                  <p className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">{isZh ? '⚠️ 到点后再加 1-45 分钟随机延迟,避免精准卡点' : '⚠️ +1-45min jitter after threshold (anti-detection).'}</p>
                )}
                {runInterval !== 'once' && (
                  <p className="mt-2 text-[11px] text-amber-500">{isZh ? '⚠️ 定时到点自动出片并扣费,请保证余额充足 + 应用保持开启。' : '⚠️ Scheduled runs auto-bill — keep balance and app running.'}</p>
                )}
              </Field>

              {/* 每次运行【固定】出片条数 —— 单滑块,简单明确(双 min-max 滑块易出现"最少>最多"反转,弃用)。 */}
              <Field label={isZh ? `每次运行条数(1-${HOTSPOT_COUNT_CAP})` : `Videos per run (1-${HOTSPOT_COUNT_CAP})`}>
                <div className="text-[11px] text-gray-500 dark:text-gray-400 mb-1">
                  {isZh ? '固定生成' : 'Generate'} <span className="font-semibold text-amber-500">{count}</span> {isZh ? '条' : 'videos'}
                </div>
                <input type="range" min={1} max={HOTSPOT_COUNT_CAP} value={count}
                  onChange={(e) => setCount(parseInt(e.target.value, 10))}
                  className="w-full accent-amber-500 cursor-pointer" />
                <p className="mt-1.5 text-[11px] text-gray-500 dark:text-gray-400">
                  {isZh
                    ? (HIDE_WEB3 ? `每次运行固定出 ${count} 条 · 每条独立选题+写稿 · 按条计费(每条约 ￥${cnyFromUsd(fee.min)}~￥${cnyFromUsd(fee.max)})` : `每次运行固定出 ${count} 条 · 每条独立选题+写稿 · 按条计费(每条约 $${fee.min}~$${fee.max})`)
                    : `${count} per run · each its own topic+script · billed per video (~$${fee.min}-${fee.max} each)`}
                </p>
              </Field>
            </>
          )}

          {/* ── Step 6:发布平台 + 发布账号(平台与账号合并到一步)── */}
          {step === PUBLISH_STEP && (
            <PublishPlatformPicker
              isZh={isZh}
              outputMode={outputMode}
              platforms={platforms}
              togglePlatform={(p) => setPlatforms((pp) => ({ ...pp, [p]: !pp[p] }))}
            >
              {matrixMode && selectedPlatformIds.length > 0 && (
                <div className="mt-4">
                  <Field
                    label={isZh ? '发布账号' : 'Publish accounts'}
                    hint={isZh ? '每个平台选一个矩阵账号,出片后用该号的指纹浏览器上传' : 'one matrix account per platform'}
                  >
                    <div className="space-y-2.5">
                      {selectedPlatformIds.map((pid) => {
                        const meta = PUBLISH_PLATFORMS.find((m) => m.id === pid);
                        const label = meta ? `${meta.emoji} ${isZh ? meta.zh : meta.en}` : pid;
                        const accs = accountsFor(pid);
                        return (
                          <div key={pid} className="flex items-center gap-3">
                            <div className="w-24 shrink-0 text-sm font-medium dark:text-gray-200">{label}</div>
                            <MatrixAccountSelect
                              isZh={isZh}
                              accounts={accs}
                              value={accountByPlatform[pid] || ''}
                              onChange={(id) => setAccountByPlatform((m) => ({ ...m, [pid]: id }))}
                              onAddAccount={() => { window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform: pid } })); onClose(); }}
                            />
                          </div>
                        );
                      })}
                      <p className="text-[11px] text-gray-500 dark:text-gray-400 pt-1">
                        {isZh ? '每个平台必须选一个【已连接】账号;未连接的已置灰不可选,选好才能下一步。发布时用该号的指纹浏览器上传。' : 'Each platform needs a LINKED account (unlinked ones are greyed out). Published via that account\'s fingerprint browser.'}
                      </p>
                    </div>
                  </Field>
                </div>
              )}
            </PublishPlatformPicker>
          )}

        </div>

        {/* 底部固定区:校验提示钉在按钮正上方(sticky),不再埋在可滚动内容最底部被字幕样式顶出视野。 */}
        <div className="sticky bottom-0 px-6 py-3.5 border-t dark:border-gray-700 bg-white/95 dark:bg-gray-900/95 backdrop-blur">
          {err && (
            <p className="mb-2.5 rounded-lg border border-rose-300 dark:border-rose-500/40 bg-rose-50 dark:bg-rose-500/10 px-3 py-2 text-sm font-medium text-rose-600 dark:text-rose-400">
              {err}
            </p>
          )}
          <div className="flex gap-3">
            <button onClick={goBack} className="px-4 py-2.5 rounded-lg text-sm border dark:border-gray-700 dark:text-gray-300">
              {step === 1 ? (isZh ? '取消' : 'Cancel') : (isZh ? '上一步' : 'Back')}
            </button>
            {step < MAX_STEP ? (
              <button onClick={goNext}
                className="flex-1 py-2.5 rounded-lg text-sm font-semibold bg-amber-500 text-white hover:bg-amber-600">
                {isZh ? '下一步' : 'Next'}
              </button>
            ) : (
              <button onClick={onSubmitClick} disabled={submitting}
                className="flex-1 py-2.5 rounded-lg text-sm font-semibold bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50">
                {submitting ? (isZh ? '创建中…' : 'Creating…') : isEdit ? `💾 ${isZh ? '保存' : 'Save'}` : `🔥 ${isZh ? '创建任务' : 'Create'}`}
              </button>
            )}
          </div>
        </div>

        {showLoginCheck && (
          <VideoLoginCheckModal
            platforms={selectedPlatformIds}
            onCancel={() => setShowLoginCheck(false)}
            onConfirmed={() => { setShowLoginCheck(false); void doCreate(); }}
          />
        )}
      </div>
    </div>
  );
};

export const TemplateSpeedModal: React.FC<{ isZh: boolean; matrixMode?: boolean; onClose: () => void; onCreated?: (id: string) => void; editTask?: any; onSaved?: () => void }> = ({ isZh, matrixMode, onClose, onCreated, editTask, onSaved }) => {
  // 编辑态:用任务现有模板配置回填(新建/编辑共用同一向导,只是数据预填)。
  const isEdit = !!editTask;
  const et = editTask?.input?.template;
  const [step, setStep] = useState<TplStep>(1);
  // 出片(4)= 本地/上传去向 + 频率;发布(5)= 发布平台 + 每平台选号(matrix)。
  // 对齐热搜成片:平台与账号【同一步】,且与「出片去向」分开成独立的「发布」步。
  const PUBLISH_STEP = 5 as const;
  const MAX_STEP = 5;
  // ── Step 1:内容 ──
  // 版式步已砍掉 —— 新建一律 AI 自由排版(它最灵活、能涵盖固定版式);编辑老任务保留它原版式。
  const [style] = useState<VideoTemplateStyle>(et?.style || 'ai_freeform');
  const [title, setTitle] = useState<string>(et?.title || '');
  const [dataText, setDataText] = useState<string>(et?.dataText || '');
  // 数据源二选一:'paste' 粘贴任意内容(老路) / 'hotlist' 选一个热榜取前 N 条当内容。
  const [dataSourceMode, setDataSourceMode] = useState<'paste' | 'hotlist'>('paste');
  const [hotlistName, setHotlistName] = useState<string>('');
  const [hotlistItems, setHotlistItems] = useState<string[]>([]);
  const [hotlistLoading, setHotlistLoading] = useState(false);
  const [hotlistError, setHotlistError] = useState<string>('');
  // 「AI 自由排版」专用:用户对风格/重点的自由描述(像 HyperFrames 那样用自然语言表达意图)。
  const [brief, setBrief] = useState<string>(et?.brief || '');
  // 设计主题('auto' = 按内容气质自动挑;其余 = 指定 themes.ts 里的某套)。
  const [themeId, setThemeId] = useState<string>(et?.themeId || 'auto');
  // 选某个热榜 → 拉前 TOPN 条标题。失败给提示,用户可改回粘贴。
  const loadHotlist = async (name: string) => {
    setHotlistName(name); setHotlistItems([]); setHotlistError(''); setHotlistLoading(true);
    try {
      const catKey = TEMPLATE_HOTLISTS.find((h) => h.name === name)?.catKey;
      let items: string[];
      if (catKey) {
        // Web3 资讯 / 科技:按 category 聚合(非 hot_topics 榜单),复用热搜成片的 /hotspot/preview。
        const resp = await fetch(`${getBackendApiUrl()}/api/video/hotspot/preview`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ perSource: TEMPLATE_HOTLIST_TOPN }),
        });
        if (!resp.ok) throw new Error('http ' + resp.status);
        const json: any = await resp.json();
        const arr = Array.isArray(json?.items?.[catKey]) ? json.items[catKey] : [];
        items = arr.map((it: any) => String(it?.title || '').trim()).filter(Boolean).slice(0, TEMPLATE_HOTLIST_TOPN);
      } else {
        const resp = await fetch(`${getBackendApiUrl()}/api/web3/hot-search?sources=${encodeURIComponent(name)}`);
        if (!resp.ok) throw new Error('http ' + resp.status);
        const json: any = await resp.json();
        const src = Array.isArray(json?.sources)
          ? (json.sources.find((s: any) => s?.source === name) || json.sources[0]) : null;
        items = Array.isArray(src?.items)
          ? src.items.map((it: any) => String(it?.title || '').trim()).filter(Boolean).slice(0, TEMPLATE_HOTLIST_TOPN) : [];
      }
      if (!items.length) throw new Error('empty');
      setHotlistItems(items);
    } catch {
      setHotlistError(isZh ? '拉取热榜失败,稍后重试或改用「粘贴内容」' : 'Failed to load hot list — try again or paste content');
    } finally { setHotlistLoading(false); }
  };
  // 实际喂给 AI 的内容:热榜模式 = 取到的标题逐行;粘贴模式 = 文本框内容。
  const effectiveDataText = dataSourceMode === 'hotlist' ? hotlistItems.join('\n') : dataText;
  // ── Step 2:配音/字幕 ──
  // 新建:默认开配音 + 字幕(模板速生定位短视频,有配音 + 烧字幕完播率更高)。
  // 编辑:保留任务现有设置(et?.narration === true 才认为开过)。
  const [narration, setNarration] = useState<boolean>(isEdit ? et?.narration === true : true);
  const [voice, setVoice] = useState<string>(et?.voice || editTask?.input?.voice || 'zh-CN-YunjianNeural');
  // 生成语言:画面文字 + AI 口播稿都用它('auto' = 按内容探测,老行为)。选定后音色语种不匹配 → 自动切默认音色。
  const [tplLang, setTplLang] = useState<string>(et?.lang || 'auto');
  const pickTplLang = (code: string) => {
    setTplLang(code);
    const opt = SCRIPT_LANGS.find((l) => l.code === code);
    if (opt && opt.code !== 'auto' && opt.voicePrefixes.length && !opt.voicePrefixes.some((p) => voice.startsWith(p))) {
      setVoice(opt.defaultVoice);
    }
  };
  const [voiceRate, setVoiceRate] = useState<number>(typeof et?.voiceRate === 'number' ? et.voiceRate : 0);
  const [voiceScript, setVoiceScript] = useState<string>(et?.voiceScript || '');
  const [subtitleEnabled, setSubtitleEnabled] = useState<boolean>(isEdit ? et?.subtitleEnabled !== false : true);
  // ── Step 3:BGM ──
  // 新建:默认带上内置 BGM 第 1 首(中音量),让用户开箱即用就有完整氛围。编辑保留原值。
  const [bgmPath, setBgmPath] = useState<string>(
    isEdit ? (editTask.input.bgmPath || '') : `${BUILTIN_BGM_PREFIX}${BUILTIN_BGM[0].id}`,
  );
  const [bgmVolume, setBgmVolume] = useState<number>(typeof editTask?.input?.bgmVolume === 'number' ? editTask.input.bgmVolume : 0.18);
  const [remoteBgm, setRemoteBgm] = useState<RemoteBgm[]>([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const resp = await fetch(`${REMOTE_BGM_MANIFEST_URL}?t=${Date.now()}`);
        if (!resp.ok) return;
        const json: any = await resp.json();
        const arr: any[] = Array.isArray(json) ? json : json?.tracks;
        if (!alive || !Array.isArray(arr)) return;
        setRemoteBgm(arr.filter((x) => x && typeof x.url === 'string' && x.url)
          .map((x) => ({ id: String(x.id || x.url), zh: String(x.zh || x.title || x.name || '云端音乐'), en: String(x.en || x.title || x.name || 'Cloud track'), url: String(x.url) })));
      } catch { /* 清单未上线 / 网络失败:静默,仅用本地曲库 */ }
    })();
    return () => { alive = false; };
  }, []);
  const pickBgm = async () => {
    const p = await videoCreationService.pickBgm();
    if (p) setBgmPath(p);
  };
  const [bgmOpening, setBgmOpening] = useState(false);
  const openBgmFolder = async (token: string) => {
    if (!token || bgmOpening) return;
    setBgmOpening(true);
    try {
      const dir = await videoCreationService.resolveBgmPath(token);
      if (dir) { try { (window as any).electron?.shell?.openPath?.(dir); } catch { /* ignore */ } }
    } finally { setBgmOpening(false); }
  };
  const bgmIsBuiltin = bgmPath.startsWith(BUILTIN_BGM_PREFIX);
  const bgmIsRemote = bgmPath.startsWith(REMOTE_BGM_PREFIX);
  const bgmIsLibrary = bgmIsBuiltin || bgmIsRemote;
  const bgmIsUpload = !!bgmPath && !bgmIsLibrary;
  // ── Step 4:出片 ──
  // 赛道字段对模板速生没实际用处 —— 2026-06-12 删除入口。
  // 时长滑块也删了:配音 ON 时被音频时长覆盖、配音 OFF 时 pipeline 用 autoDuration
  // 按数据行数估算,用户手动调没意义 —— 2026-06-12 删除入口。
  const [brandColor, setBrandColor] = useState<string>(et?.brandColor || '#f0b90b');
  const [runInterval, setRunInterval] = useState<VideoRunInterval>(editTask?.runInterval || 'once');
  // ── Step 5:出片 —— 成片去向(仅本地/发布到平台)二选一,对齐热搜成片 ──
  // 编辑态从 publishPlatforms 反推:有平台 = 'upload',否则 'local'。
  const [outputMode, setOutputMode] = useState<OutputMode>(() => {
    if (!editTask) return 'upload'; // 新建默认「发布到平台」(用户要求)
    const editList = Array.isArray((editTask?.input as any)?.publishPlatforms)
      ? ((editTask!.input as any).publishPlatforms as string[]) : [];
    return editList.length > 0 ? 'upload' : 'local';
  });
  const [platforms, setPlatforms] = useState<Record<Platform, boolean>>(() => {
    const init: Record<Platform, boolean> = {
      douyin: false, xhs: false, binance: false, x: false, tiktok: false,
      bilibili: false, kuaishou: false, shipinhao: false, toutiao: false,
    };
    const editList = Array.isArray((editTask?.input as any)?.publishPlatforms)
      ? ((editTask!.input as any).publishPlatforms as string[]) : null;
    if (editList && editList.length > 0) editList.forEach((p) => { if (p in init) init[p as Platform] = true; });
    else if (!editTask) DEFAULT_PUBLISH_PLATFORMS.forEach((p) => { init[p] = true; }); // 新建默认勾 6 个(用户要求)
    return init;
  });
  const togglePlatform = (p: Platform) => setPlatforms((prev) => ({ ...prev, [p]: !prev[p] }));
  // 按 PUBLISH_PLATFORMS 顺序取(不用 Object.keys)→ 发布顺序 = 列表顺序(B 站在最后),改一处列表即可
  const selectedPlatformIds = PUBLISH_PLATFORMS.map((m) => m.id).filter((p) => platforms[p]);

  // ── 矩阵号:每个发布平台选一个账号(平台→accountId),发布走指纹内核 CDP(同 HotspotVideoModal)。──
  const [matrixAccounts, setMatrixAccounts] = useState<MatrixAcctLite[]>([]);
  const [accountByPlatform, setAccountByPlatform] = useState<Record<string, string>>(
    () => (matrixMode && (editTask?.input as any)?.publishAccounts && typeof (editTask!.input as any).publishAccounts === 'object' ? { ...(editTask!.input as any).publishAccounts } : {}),
  );
  useEffect(() => {
    if (!matrixMode) return;
    let alive = true;
    (async () => {
      try {
        const r = await (window as any).electron?.matrix?.listAccounts?.();
        const accs: any[] = r?.ok && Array.isArray(r.accounts) ? r.accounts : [];
        if (alive) setMatrixAccounts(accs.map((a) => ({ id: a.id, platform: a.platform, displayName: a.displayName, status: a.status, nickname: a.nickname, displayId: a.displayId, avatar: a.avatar, loginScope: a.loginScope })));
      } catch { if (alive) setMatrixAccounts([]); }
    })();
    return () => { alive = false; };
  }, [matrixMode]);
  // 发布上传:快手只列「创作者中心」账号(主站号没有 cp 发布登录态)。
  const accountsFor = (platform: string) => matrixAccounts.filter((a) => a.platform === platform && (platform !== 'kuaishou' || (a as any).loginScope === 'creator'));
  const matrixAccountsReady = !matrixMode || outputMode !== 'upload'
    || selectedPlatformIds.every((p) => !!accountByPlatform[p] && accountsFor(p).some((a) => a.id === accountByPlatform[p] && a.status !== 'login_required'));
  // 发布文案不再给输入框(用户要求,AI 自动写)→ 只保留值(编辑老任务回填),不需要 setter。
  const [publishTitle] = useState<string>((editTask?.input as any)?.publishTitle || '');
  const [publishCaption] = useState<string>((editTask?.input as any)?.publishCaption || '');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!effectiveDataText.trim()) {
      setStep(1);
      setErr(dataSourceMode === 'hotlist'
        ? (isZh ? '请先选一个热榜并等它加载出条目' : 'Pick a hot list and wait for it to load')
        : (isZh ? '请填写榜单/要点内容' : 'Enter the list / points'));
      return;
    }
    if (submitting) return;
    setSubmitting(true); setErr(null);
    try {
      // 新建才校验任务数上限;编辑是改已有任务,不占新名额。
      if (!isEdit && !(await videoQueue.canCreate())) {
        setErr(isZh
          ? `视频任务已满(${VIDEO_TASK_LIMIT}/${VIDEO_TASK_LIMIT}),请先到「我的视频任务」删掉已完成的再新建。`
          : `Video tasks full (${VIDEO_TASK_LIMIT}/${VIDEO_TASK_LIMIT}). Delete a finished one first.`);
        return;
      }
      const name = title.trim() || (isZh ? '模板速生' : 'Template');
      const input: VideoCreationInput = {
        // 模板速生不用 persona/track/keywords/script(那些是 stock/pure_ai 的字段);
        // 编辑老任务时若 input 里残留 track 不动它,新建一律置空。
        persona: '', track: editTask?.input?.track || '', keywords: [], script: '', scriptMode: 'ai',
        engine: 'template', referenceImages: [], aspect: '9:16',
        // 配音/语速也写到 input 顶层一份(向后兼容,且 pipeline.ts 读 input.voice / voiceRate 作为兜底)。
        voice: narration ? voice : undefined,
        voiceRate: narration && voiceRate !== 0 ? voiceRate : undefined,
        // BGM 是 input 顶层字段(pipeline 通用)。空 = 无 BGM。
        bgmPath: bgmPath || undefined,
        bgmVolume: bgmPath ? bgmVolume : undefined,
        // 成片去向:'local' → 空数组(仅存本地);'upload' → 勾选的平台。对齐热搜成片口径。
        publishPlatforms: outputMode === 'upload' ? selectedPlatformIds : [],
        // 矩阵号:每个发布平台选定的账号(平台→accountId),发布时按号走 CDP。仅取已勾平台的映射。
        publishAccounts: matrixMode && outputMode === 'upload'
          ? Object.fromEntries(selectedPlatformIds.filter((p) => accountByPlatform[p]).map((p) => [p, accountByPlatform[p]]))
          : undefined,
        // 账号【名字】也存一份(平台→名),详情/记录页直接展示。
        publishAccountNames: matrixMode && outputMode === 'upload'
          ? Object.fromEntries(selectedPlatformIds.filter((p) => accountByPlatform[p]).map((p) => { const a = matrixAccounts.find((x) => x.id === accountByPlatform[p]); return [p, a ? (a.nickname || a.displayName) : accountByPlatform[p]]; }))
          : undefined,
        publishTitle: outputMode === 'upload' && selectedPlatformIds.length && publishTitle.trim() ? publishTitle.trim() : undefined,
        publishCaption: outputMode === 'upload' && selectedPlatformIds.length && publishCaption.trim() ? publishCaption.trim() : undefined,
        template: {
          // durationSec 不传:配音 ON 由真实音频决定,配音 OFF 由 pipeline.autoDuration 估算。
          // dataText 用 effectiveDataText(热榜模式 = 取到的标题逐行;粘贴模式 = 文本框)。
          style,
          title: title.trim() || (dataSourceMode === 'hotlist' && hotlistName ? hotlistName : undefined),
          dataText: effectiveDataText.trim(), brandColor,
          narration,
          voice: narration ? voice : undefined,
          voiceRate: narration && voiceRate !== 0 ? voiceRate : undefined,
          voiceScript: narration && voiceScript.trim() ? voiceScript.trim() : undefined,
          subtitleEnabled: narration ? subtitleEnabled : undefined,
          // 「AI 自由排版」风格意图(其它版式忽略)。
          brief: style === 'ai_freeform' && brief.trim() ? brief.trim() : undefined,
          // 设计主题('auto' 不传,交给内容气质/AI 自动挑)。
          themeId: style === 'ai_freeform' && themeId && themeId !== 'auto' ? themeId : undefined,
          // 热榜数据源:存榜名 → 出片时主进程实时抓最新榜单(定时任务天天更新);
          // dataText 同时存了选榜时的快照,实时抓失败时兜底。
          hotlistSource: dataSourceMode === 'hotlist' && hotlistName ? hotlistName : undefined,
          // 生成语言:'auto' 不传 = 主进程按内容探测(老行为)。
          lang: tplLang !== 'auto' ? tplLang : undefined,
        },
      };
      const schedule: VideoSchedule = { runInterval };
      if (isEdit) {
        videoTaskStore.updateTask(editTask.id, input, name, schedule);
        if (onSaved) onSaved(); else onClose();
      } else {
        const id = videoTaskStore.createTask(input, name, schedule);
        onCreated?.(id);
      }
    } finally {
      setSubmitting(false);
    }
  };

  // 决策①:勾了发布平台时,保存前必须先过【全平台登录校验】(全登录才放行)。
  const [showLoginCheck, setShowLoginCheck] = useState(false);
  const handleFinalClick = () => {
    // 矩阵号:发布按账号走 CDP,不弹扩展登录校验;但每个发布平台都要选好号(平台+账号都在发布步 5)。
    if (matrixMode) {
      if (outputMode === 'upload' && selectedPlatformIds.length === 0) {
        setStep(PUBLISH_STEP);
        setErr(isZh ? '已选「发布到平台」,请至少勾选一个平台(或改回「仅存本地」)' : 'Pick at least one platform, or switch to "Local only"');
        return;
      }
      if (outputMode === 'upload' && !matrixAccountsReady) {
        setStep(PUBLISH_STEP);
        setErr(isZh ? '请为每个发布平台选择一个账号(没有账号的平台请先去「我的矩阵账号」添加)' : 'Pick an account for each platform first');
        return;
      }
      void handleCreate();
      return;
    }
    if (outputMode === 'upload' && selectedPlatformIds.length > 0) { setErr(null); setShowLoginCheck(true); }
    else { void handleCreate(); }
  };

  // 「下一步」按 step 路由 + 必填校验。
  const goNext = () => {
    // Step 1 = 内容/数据,必填校验放这里。
    if (step === 1) {
      if (!effectiveDataText.trim()) {
        setErr(dataSourceMode === 'hotlist'
          ? (isZh ? '请先选一个热榜并等它加载出条目' : 'Pick a hot list and wait for it to load')
          : (isZh ? '请填写内容' : 'Enter content'));
        return;
      }
    }
    setErr(null);
    setStep((s) => (s < MAX_STEP ? ((s + 1) as TplStep) : s));
  };
  const goBack = () => {
    setErr(null);
    if (step === 1) { onClose(); return; }
    setStep((s) => ((s - 1) as TplStep));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-2xl h-[85vh] flex flex-col rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-2xl">
        <div className="shrink-0 px-6 pt-6 pb-3 border-b border-gray-100 dark:border-gray-800 flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold dark:text-white">⚡ {isZh ? (isEdit ? '编辑模板速生' : '模板速生') : (isEdit ? 'Edit Template' : 'Template Speed')}</h3>
            <div className="flex items-center gap-2 mt-3 flex-wrap">
              <StepDot n={1} active={step === 1} done={step > 1} label={isZh ? '内容' : 'Content'} />
              <div className={`h-px w-3 ${step > 1 ? 'bg-fuchsia-500' : 'bg-gray-200 dark:bg-gray-700'}`} />
              <StepDot n={2} active={step === 2} done={step > 2} label={isZh ? '配音' : 'Voice'} />
              <div className={`h-px w-3 ${step > 2 ? 'bg-fuchsia-500' : 'bg-gray-200 dark:bg-gray-700'}`} />
              <StepDot n={3} active={step === 3} done={step > 3} label={isZh ? '音乐' : 'Music'} />
              <div className={`h-px w-3 ${step > 3 ? 'bg-fuchsia-500' : 'bg-gray-200 dark:bg-gray-700'}`} />
              <StepDot n={4} active={step === 4} done={step > 4} label={isZh ? '出片' : 'Output'} />
              <div className={`h-px w-3 ${step > 4 ? 'bg-fuchsia-500' : 'bg-gray-200 dark:bg-gray-700'}`} />
              <StepDot n={5} active={step === 5} done={false} label={isZh ? '发布' : 'Publish'} />
            </div>
          </div>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {step === 1 && (
            <>
              {/* 数据源二选一:粘贴任意内容 / 选一个热榜(取前 N 条) */}
              <Field label={isZh ? '内容来源' : 'Content source'} hint={isZh ? '自己粘贴,或选一个热榜自动取前几条当内容' : 'paste your own, or pull top items from a hot list'}>
                <div className="flex gap-2">
                  {(['paste', 'hotlist'] as const).map((m) => (
                    <button key={m} type="button" onClick={() => { setDataSourceMode(m); setErr(null); }}
                      className={`flex-1 py-2 rounded-lg text-sm border transition-colors ${dataSourceMode === m ? 'border-fuchsia-500 bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400 font-semibold' : 'border-gray-200 dark:border-gray-700 dark:text-gray-300 hover:border-fuchsia-500/50'}`}>
                      {m === 'paste' ? (isZh ? '✍️ 粘贴内容' : '✍️ Paste content') : (isZh ? '🔥 选热榜' : '🔥 Hot list')}
                    </button>
                  ))}
                </div>
              </Field>

              <Field label={isZh ? '标题(可选)' : 'Title (optional)'}>
                <input value={title} onChange={(e) => setTitle(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-transparent text-sm dark:text-white" />
              </Field>

              {dataSourceMode === 'paste' ? (
                <Field label={isZh ? '内容 / 数据' : 'Content / data'} hint={isZh ? '粘贴任意内容——榜单、一段话、文章、要点都行,AI 自动理解并排版' : 'paste anything — a list, a paragraph, an article, or key points; AI understands and lays it out'}>
                  <textarea value={dataText} onChange={(e) => setDataText(e.target.value)} rows={8}
                    className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-transparent text-sm font-mono dark:text-white" />
                </Field>
              ) : (
                <Field label={isZh ? '选一个热榜' : 'Pick a hot list'} hint={isZh ? `选哪个榜,出片时就用它的实时榜单(前 ${TEMPLATE_HOTLIST_TOPN} 条)做成视频` : `the video is built from this list's live top ${TEMPLATE_HOTLIST_TOPN}`}>
                  <div className="mb-2 rounded-lg bg-fuchsia-500/10 border border-fuchsia-500/30 px-3 py-2 text-[11px] text-fuchsia-600 dark:text-fuchsia-300 leading-relaxed">
                    {isZh
                      ? '📋 选了热榜 = 直接拿这个榜单做视频,不用自己填内容。每次出片都抓该榜【实时】前几条,所以定时任务能天天自动更新。'
                      : '📋 Picking a hot list means the video is built straight from that ranking — no manual content. Each render pulls the list live, so scheduled tasks refresh daily.'}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {/* Web3 热榜是【信息源】:同热搜成片口径,国内版不砍(海外平台发片用得上,2026-07-05 拍板)。 */}
                    {TEMPLATE_HOTLISTS.map((h) => (
                      <button key={h.name} type="button" onClick={() => void loadHotlist(h.name)}
                        className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors ${hotlistName === h.name ? 'border-fuchsia-500 bg-fuchsia-500/10' : 'border-gray-200 dark:border-gray-700 hover:border-fuchsia-500/50'}`}>
                        <span>{h.emoji}</span><span className="dark:text-gray-200 truncate">{h.name}</span>
                        {hotlistName === h.name && <span className="ml-auto text-fuchsia-500">✓</span>}
                      </button>
                    ))}
                  </div>
                  {hotlistLoading && <div className="text-[11px] text-gray-400 mt-2">{isZh ? '⏳ 加载中…' : '⏳ Loading…'}</div>}
                  {hotlistError && <div className="text-[11px] text-red-500 mt-2">{hotlistError}</div>}
                  {hotlistItems.length > 0 && (
                    <div className="mt-2 rounded-lg border border-gray-200 dark:border-gray-700 p-2 max-h-40 overflow-y-auto">
                      <div className="text-[11px] text-gray-400 mb-1">{isZh ? `已取 ${hotlistItems.length} 条(出片时按热榜实时刷新):` : `${hotlistItems.length} items:`}</div>
                      <ol className="text-xs text-gray-600 dark:text-gray-300 space-y-0.5 list-decimal list-inside">
                        {hotlistItems.map((t, i) => <li key={i} className="truncate">{t}</li>)}
                      </ol>
                    </div>
                  )}
                </Field>
              )}

              {style === 'ai_freeform' && (
                <Field label={isZh ? '设计主题' : 'Design theme'} hint={isZh ? '成套审美(配色/字体/装饰)。自动 = 按内容气质挑最搭的一套' : 'curated look; Auto picks by content'}>
                  <select value={themeId} onChange={(e) => setThemeId(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-transparent text-sm dark:text-white dark:bg-[#1a1a2e]">
                    {THEME_OPTIONS.map((t) => <option key={t.id} value={t.id}>{isZh ? t.zh : t.en}</option>)}
                  </select>
                </Field>
              )}

              {style === 'ai_freeform' && (
                <Field label={isZh ? '风格 / 要求(选填)' : 'Style / brief (optional)'} hint={isZh ? '像跟设计师说话,描述想要的画面风格/重点' : 'talk to the AI like a designer: vibe, emphasis, layout'}>
                  <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={2}
                    placeholder={isZh ? '如:深色科技风,大号数字,突出涨幅最高的那条' : 'e.g. dark tech vibe, big numbers, emphasize the top mover'}
                    className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-transparent text-sm dark:text-white" />
                </Field>
              )}

              {(() => {
                const s = TEMPLATE_STYLES.find((x) => x.id === style);
                if (!s) return null;
                return (
                  <div className="text-[11px] text-gray-400">{isZh ? `已选版式:${s.emoji} ${s.zh}` : `Selected style: ${s.emoji} ${s.en}`}</div>
                );
              })()}
            </>
          )}
          {step === 2 && (
            <>
              {/* 生成语言:画面文字 + AI 口播稿都用它(纯视觉也影响画面文字),所以放在配音开关外面。 */}
              <Field label={isZh ? '生成语言' : 'Output language'} hint={isZh ? '画面文字和 AI 口播稿都用该语言;内容是其它语言时 AI 自动翻译。自动 = 跟你给的内容' : 'Page text & AI narration language; AI translates if the content differs. Auto = follow your content'}>
                <select
                  value={tplLang}
                  onChange={(e) => pickTplLang(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white"
                >
                  {SCRIPT_LANGS.map((l) => (
                    <option key={l.code} value={l.code}>{isZh ? l.zh : l.en}</option>
                  ))}
                </select>
              </Field>
              <Field label={isZh ? 'AI 配音 + 字幕' : 'AI voice-over + subs'} hint={isZh ? '开了会按你的数据 AI 写口播稿、念出来、烧字幕。关 = 纯视觉。' : 'On: AI writes a script, narrates, and burns subs.'}>
                <div className="flex items-center justify-between rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-2.5">
                  <span className="text-sm dark:text-gray-200">{isZh ? '生成配音 + 字幕' : 'Generate voice-over + subs'}</span>
                  <button type="button" onClick={() => setNarration((v) => !v)}
                    className={`w-11 h-6 rounded-full relative transition-colors ${narration ? 'bg-fuchsia-500' : 'bg-gray-300 dark:bg-gray-700'}`}>
                    <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${narration ? 'translate-x-5' : ''}`} />
                  </button>
                </div>
              </Field>
              {narration && (
                <>
                  <Field label={isZh ? '配音音色' : 'Voice'}>
                    <select value={voice} onChange={(e) => setVoice(e.target.value)}
                      className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white">
                      {VOICE_GROUPS.map((g) => (
                        <optgroup key={g.groupZh} label={isZh ? g.groupZh : g.groupEn}>
                          {g.voices.map((v) => (
                            <option key={v.id} value={v.id}>{isZh ? v.zh : v.en}</option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </Field>
                  <Field label={isZh ? '语速' : 'Rate'}>
                    <div className="flex gap-2">
                      {RATE_OPTIONS.map((r) => (
                        <button key={r.v} type="button" onClick={() => setVoiceRate(r.v)}
                          className={`flex-1 px-2 py-1.5 rounded-lg text-xs border transition-colors ${voiceRate === r.v ? 'border-fuchsia-500 bg-fuchsia-500/10 text-fuchsia-500 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-fuchsia-500/50'}`}>
                          {isZh ? r.zh : r.en}
                        </button>
                      ))}
                    </div>
                  </Field>
                  <Field label={isZh ? '烧字幕' : 'Burn subtitles'} hint={isZh ? '字幕跟配音逐句对齐(edge-tts 词级时间戳,无误差)' : 'Word-level aligned (edge-tts)'}>
                    <div className="flex items-center justify-between rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-2">
                      <span className="text-sm dark:text-gray-200">{isZh ? '画面叠加字幕条' : 'Overlay subtitles'}</span>
                      <button type="button" onClick={() => setSubtitleEnabled((v) => !v)}
                        className={`w-11 h-6 rounded-full relative transition-colors ${subtitleEnabled ? 'bg-fuchsia-500' : 'bg-gray-300 dark:bg-gray-700'}`}>
                        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${subtitleEnabled ? 'translate-x-5' : ''}`} />
                      </button>
                    </div>
                  </Field>
                  <Field label={isZh ? '自定义口播稿(可选)' : 'Custom voice script (optional)'} hint={isZh ? '空 = AI 按你的数据自动写;填了用这个稿子直接配音' : 'Empty: AI writes; Filled: use this'}>
                    <textarea value={voiceScript} onChange={(e) => setVoiceScript(e.target.value)} rows={3}
                      className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-transparent text-sm dark:text-white" />
                  </Field>
                  <div className="text-[11px] text-gray-400">{isZh ? '⚠️ 开了配音 → 视频时长由真实音频决定' : '⚠️ With voice on, duration = real audio length'}</div>
                </>
              )}
            </>
          )}
          {step === 3 && (
            <>
              <Field label={isZh ? '背景音乐(选填)' : 'BGM (optional)'} hint={isZh ? '配音模式下作为氛围音垫底;纯视觉模式下是主音轨' : 'Bed for narration; main audio in silent mode'}>
                <div className="grid grid-cols-3 gap-2 mb-2">
                  <button type="button" onClick={() => setBgmPath('')}
                    className={`px-2 py-1.5 rounded-lg text-xs border transition-colors ${!bgmPath ? 'border-fuchsia-500 bg-fuchsia-500/10 text-fuchsia-500 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-fuchsia-500/50'}`}>
                    {isZh ? '无' : 'None'}
                  </button>
                  <button type="button" onClick={() => { if (!bgmIsLibrary) setBgmPath(BUILTIN_BGM_PREFIX + BUILTIN_BGM[0].id); }}
                    className={`px-2 py-1.5 rounded-lg text-xs border transition-colors ${bgmIsLibrary ? 'border-fuchsia-500 bg-fuchsia-500/10 text-fuchsia-500 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-fuchsia-500/50'}`}>
                    {isZh ? '曲库' : 'Library'}
                  </button>
                  <button type="button" onClick={pickBgm}
                    className={`px-2 py-1.5 rounded-lg text-xs border transition-colors ${bgmIsUpload ? 'border-fuchsia-500 bg-fuchsia-500/10 text-fuchsia-500 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-fuchsia-500/50'}`}>
                    {isZh ? '上传' : 'Upload'}
                  </button>
                </div>
                {bgmIsLibrary && (
                  <div className="flex items-center gap-2">
                    <select value={bgmPath} onChange={(e) => { if (e.target.value) setBgmPath(e.target.value); }}
                      className="flex-1 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white">
                      <optgroup label={isZh ? '内置曲库' : 'Built-in'}>
                        {BUILTIN_BGM.map((b) => (
                          <option key={b.id} value={`${BUILTIN_BGM_PREFIX}${b.id}`}>🎵 {isZh ? b.zh : b.en}</option>
                        ))}
                      </optgroup>
                      {remoteBgm.length > 0 && (
                        <optgroup label={isZh ? '云端曲库（首次需下载）' : 'Cloud (downloads first time)'}>
                          {remoteBgm.map((b) => (
                            <option key={b.url} value={`${REMOTE_BGM_PREFIX}${b.url}`}>☁️ {isZh ? b.zh : b.en}</option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                    <button type="button" onClick={() => openBgmFolder(bgmPath)} disabled={bgmOpening}
                      className="shrink-0 px-3 py-2 rounded-lg text-xs font-medium text-white bg-fuchsia-500 hover:bg-fuchsia-600 disabled:opacity-60">
                      {bgmOpening ? '⏳' : (isZh ? '📂 文件夹' : '📂 Folder')}
                    </button>
                  </div>
                )}
                {bgmIsUpload && (
                  <div className="flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-2.5 py-2">
                    <span className="text-sm">🎵</span>
                    <span className="flex-1 text-xs text-gray-600 dark:text-gray-300 truncate">{bgmPath.split(/[\\/]/).pop()}</span>
                    <button type="button" onClick={pickBgm} className="text-xs text-fuchsia-500 hover:underline shrink-0">{isZh ? '更换' : 'Change'}</button>
                    <button type="button" onClick={() => setBgmPath('')} className="text-xs text-gray-400 hover:text-red-500 shrink-0">{isZh ? '移除' : 'Remove'}</button>
                  </div>
                )}
                {bgmPath && (
                  <div className="flex gap-2 mt-2">
                    <span className="text-xs text-gray-500 self-center">{isZh ? 'BGM 音量' : 'BGM volume'}</span>
                    {BGM_VOLUME_OPTIONS.map((b) => (
                      <button key={b.v} type="button" onClick={() => setBgmVolume(b.v)}
                        className={`flex-1 px-2 py-1.5 rounded-lg text-xs border transition-colors ${bgmVolume === b.v ? 'border-fuchsia-500 bg-fuchsia-500/10 text-fuchsia-500 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-fuchsia-500/50'}`}>
                        {isZh ? b.zh : b.en}
                      </button>
                    ))}
                  </div>
                )}
              </Field>
            </>
          )}
          {step === 4 && (
            <>
              <Field label={isZh ? '主品牌色' : 'Brand color'} hint={isZh ? '画面整体主色调:标题字色、装饰元素、数字高亮都用它' : 'Drives the title color, accent bars, and number highlights'}>
                <div className="flex items-center gap-2">
                  <input type="color" value={brandColor} onChange={(e) => setBrandColor(e.target.value)}
                    className="h-9 w-14 rounded border border-gray-300 dark:border-gray-700 bg-transparent" />
                  <span className="text-xs text-gray-500">{brandColor}</span>
                </div>
              </Field>
              {/* 出片去向(本地/上传)单选 —— 平台与账号挪到下一步「发布」(对齐热搜成片) */}
              <OutputModeToggle isZh={isZh} outputMode={outputMode} setOutputMode={setOutputMode} />
              <Field label={isZh ? '运行频率' : 'Run frequency'}>
                <RemixFreqPicker isZh={isZh} value={runInterval} onChange={(v) => setRunInterval(v as VideoRunInterval)} />
              </Field>
              <div className="text-[11px] text-gray-400 space-y-0.5">
                <div>{isZh
                  ? (HIDE_WEB3 ? `单条约 ￥0.14~￥0.72(数据/${narration ? '写稿/' : ''}合成)· 跟「在线素材」同口径` : `单条约 $0.02~$0.1(数据/${narration ? '写稿/' : ''}合成)· 跟「在线素材」同口径`)
                  : `~$0.02–0.1 per clip (data / ${narration ? 'script / ' : ''}compose) · same as Stock`}</div>
                <div>{isZh
                  ? `时长 ${narration ? '由 AI 口播稿决定' : '按数据行数自动估算(每行约 0.9s,clamp 4–14s)'}`
                  : `Duration ${narration ? 'driven by AI voice script' : 'auto-estimated from row count'}`}</div>
              </div>
            </>
          )}

          {/* ── Step 5:发布平台 + 发布账号(独立一步,平台与账号同一步,对齐热搜成片)── */}
          {step === PUBLISH_STEP && (
            <PublishPlatformPicker
              isZh={isZh}
              outputMode={outputMode}
              platforms={platforms}
              togglePlatform={togglePlatform}
            >
              {outputMode === 'upload' && (
                <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800 text-[11px] text-gray-400">
                  {isZh ? '📝 发布文案:由 AI 自动生成钩人标题 + 引导互动文案 + 话题标签(无需填写)' : '📝 Caption: AI auto-writes a hook title + CTA + hashtags (nothing to fill in)'}
                </div>
              )}
              {matrixMode && outputMode === 'upload' && selectedPlatformIds.length > 0 && (
                <div className="mt-4">
                  <Field
                    label={isZh ? '发布账号' : 'Publish accounts'}
                    hint={isZh ? '每个平台选一个矩阵账号,出片后用该号的指纹浏览器上传' : 'one matrix account per platform'}
                  >
                    <div className="space-y-2.5">
                      {selectedPlatformIds.map((pid) => {
                        const meta = PUBLISH_PLATFORMS.find((m) => m.id === pid);
                        const label = meta ? `${meta.emoji} ${isZh ? meta.zh : meta.en}` : pid;
                        const accs = accountsFor(pid);
                        return (
                          <div key={pid} className="flex items-center gap-3">
                            <div className="w-28 shrink-0 text-sm font-medium dark:text-gray-200">{label}</div>
                            <MatrixAccountSelect
                              isZh={isZh}
                              accounts={accs}
                              value={accountByPlatform[pid] || ''}
                              onChange={(id) => setAccountByPlatform((m) => ({ ...m, [pid]: id }))}
                              onAddAccount={() => { window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform: pid } })); onClose(); }}
                            />
                          </div>
                        );
                      })}
                      <p className="text-[11px] text-gray-500 dark:text-gray-400 pt-1">
                        {isZh ? '每个平台必须选一个【已连接】账号;未连接的已置灰不可选,选好才能开始。发布时用该号的指纹浏览器上传。' : 'Each platform needs a LINKED account (unlinked ones are greyed out). Published via that account\'s fingerprint browser.'}
                      </p>
                    </div>
                  </Field>
                </div>
              )}
            </PublishPlatformPicker>
          )}

          {err && <div className="text-xs text-red-500">{err}</div>}
        </div>

        <div className="shrink-0 px-6 py-4 border-t border-gray-100 dark:border-gray-800 flex gap-2">
          <button type="button" onClick={goBack}
            className="flex-1 py-2.5 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800">
            {step === 1 ? (isZh ? '取消' : 'Cancel') : `← ${isZh ? '上一步' : 'Back'}`}
          </button>
          {step < MAX_STEP ? (
            <button type="button" onClick={goNext}
              className="flex-1 py-2.5 rounded-lg text-sm font-semibold bg-fuchsia-500 text-white hover:bg-fuchsia-600">
              {isZh ? '下一步 →' : 'Next →'}
            </button>
          ) : (
            <button type="button" onClick={handleFinalClick} disabled={submitting}
              className="flex-1 py-2.5 rounded-lg text-sm font-semibold bg-fuchsia-500 text-white hover:bg-fuchsia-600 disabled:opacity-50">
              {submitting
                ? (isEdit ? (isZh ? '保存中...' : 'Saving...') : (isZh ? '创建中...' : 'Creating...'))
                : (isEdit ? '💾 ' + (isZh ? '保存修改' : 'Save') : '⚡ ' + (isZh ? '创建并开始' : 'Create & Start'))}
            </button>
          )}
        </div>
        {showLoginCheck && (
          <VideoLoginCheckModal
            platforms={selectedPlatformIds}
            onCancel={() => setShowLoginCheck(false)}
            onConfirmed={() => { setShowLoginCheck(false); void handleCreate(); }}
          />
        )}
      </div>
    </div>
  );
};

const REMIX_INTERVALS: Array<{ id: string; zh: string; en: string }> = [
  { id: 'once', zh: '不重复', en: 'Once' },
  { id: '30min', zh: '每 30 分钟', en: 'Every 30min' },
  { id: '1h', zh: '每小时', en: 'Hourly' },
  { id: '3h', zh: '每 3 小时', en: 'Every 3h' },
  { id: '6h', zh: '每 6 小时', en: 'Every 6h' },
  { id: 'daily_random', zh: '每日随机时间', en: 'Daily (random time)' },
];

// 运行频率选择器(对齐币安:pill 按钮 + 推荐/jitter 提示,替代下拉)。
const RemixFreqPicker: React.FC<{ isZh: boolean; value: string; onChange: (v: string) => void }> = ({ isZh, value, onChange }) => (
  <>
    <div className="flex gap-2 flex-wrap">
      {REMIX_INTERVALS.map((it) => (
        <button key={it.id} type="button" onClick={() => onChange(it.id)}
          className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${
            value === it.id
              ? 'border-fuchsia-500 bg-fuchsia-500/10 text-fuchsia-500 font-medium'
              : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-fuchsia-500/50'
          }`}>
          {isZh ? it.zh : it.en}
        </button>
      ))}
    </div>
    {value === 'daily_random' && (
      <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1.5">{isZh ? '✨ 推荐 — 每天随机时间触发,比固定钟点更像真人' : '✨ Recommended — daily at a randomized time, more human-like'}</p>
    )}
    {(value === '30min' || value === '1h' || value === '3h' || value === '6h') && (
      <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1.5">
        {(() => { const isLong = value === '3h' || value === '6h'; const range = isLong ? '1-45' : '1-10'; return isZh ? `⚠️ 到点后再加 ${range} 分钟随机延迟,避免精准卡点` : `⚠️ +${range}min jitter after threshold (anti-detection).`; })()}
      </p>
    )}
  </>
);

