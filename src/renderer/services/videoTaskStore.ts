/**
 * videoTaskStore — 渲染端「视频创作任务」的轻量持久化 store(模块级单例)。
 *
 * 为什么不复用 scenario 任务体系:scenario 那套(scenarioManager / taskStore /
 * runRecords + 主进程 2s 轮询)是为【浏览器自动化 + 定时调度】设计的,视频创作是
 * 纯本地 ffmpeg 流水线,塞进去得改一大堆主进程代码且没法单测。这里用一个 store
 * 单例镜像它的【交互体验】(任务 / 运行记录分离、发光卡片 / 详情页 / 流式日志),
 * 底层仍走现成的 videoCreationService.generate + onProgress(主进程零改动)。
 *
 * 数据模型(对齐 scenario 的「任务 vs 运行记录」):
 *   - VideoTask      —— 持久化的【任务】:配置(赛道/人设/关键词/文案)+ 聚合统计
 *                       (跑过几次、上次状态、累计 token)。可编辑、重跑、删除。
 *   - VideoRunRecord —— 每次「开始创作 / 重新跑」产生一条【运行记录】:该次的
 *                       step 进度、流式日志、成片路径、token 消耗、起止时间。
 *
 * 设计要点:
 *   - store 是模块级单例,生命周期 = 整个渲染进程,所以页面间切换(卸载组件)
 *     不会中断正在跑的任务,日志也不丢(订阅活在 store 里,不在组件里)。
 *   - 任务 + 运行记录都持久化到 localStorage。重启时把上次残留的 'running' 运行记录
 *     标成 'error(已中断)'(主进程那次 job 已随刷新丢失)。
 *   - 一次只允许跑一个任务(本地 ffmpeg 很吃资源,且单任务时 onProgress 事件路由
 *     无歧义)。已有任务在跑时 runTask / createAndRun 直接拒绝。
 *   - 任务 id / 运行记录 id 都用 12 位十六进制,详情页 / 卡片用 `#{id.slice(0,8)}`
 *     展示,跟 scenario 任务的短 id 格式一致。
 */

import {
  videoCreationService,
  type VideoCreationInput,
  type VideoCreationProgress,
  type VideoCreationProgressStep,
} from './videoCreation';

const TASKS_KEY = 'noobclaw_video_tasks';
const RUNS_KEY = 'noobclaw_video_runs';
const MAX_TASKS = 50;       // 任务列表上限,超了丢最旧的
const MAX_RUNS = 120;       // 运行记录上限,超了丢最旧的
const MAX_LOGS = 600;       // 每条运行记录的日志条数上限

export type VideoRunStatus = 'running' | 'done' | 'error';

/** 视频任务的定时间隔(对齐 scenario / 币安任务的 run_interval 完整能力:30min/1h/3h/6h +
 *  每天定时 + 每日随机)。'once' = 仅手动,不自动重复。
 *  ⚠️ 短间隔(30min/1h)本地出片吃资源且按条计费,向导里已加 jitter 提示,由用户自行权衡。 */
export type VideoRunInterval = 'once' | '30min' | '1h' | '3h' | '6h' | 'daily' | 'daily_random';

/** 任务级定时配置(向导「出片」步收集,存到 VideoTask 上)。 */
export interface VideoSchedule {
  runInterval: VideoRunInterval;
  /** runInterval==='daily' 时的触发时刻 "HH:MM"(本地时区)。 */
  dailyTime?: string;
}

/**
 * 计算下一次定时运行的时间戳(语义对齐 scenarioManager.computeNextPlannedRun):
 *   - 'once'         → Infinity(永不自动触发;调用方应改存 undefined)
 *   - '30min' / '1h'  → fromTs + 间隔 + [0,10min) 抖动(短间隔)
 *   - '3h' / '6h'     → fromTs + 间隔 + [0,45min) 抖动(长间隔放宽,对齐币安任务防规律识别)
 *   - 'daily'        → 下一个 HH:MM(今天已过则次日)± 15min 抖动
 *   - 'daily_random' → 次日 0 点起 [0,24h) 随机一次
 * fromTs 一般传「上次运行结束时间」(首次排程传 now)。
 */
export function computeNextVideoRun(
  interval: VideoRunInterval,
  dailyTime: string | undefined,
  fromTs: number,
): number {
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const jitter = (maxMs: number) => Math.floor(Math.random() * maxMs);
  switch (interval) {
    case '30min': return fromTs + 30 * MIN + jitter(10 * MIN);
    case '1h': return fromTs + HOUR + jitter(10 * MIN);
    case '3h': return fromTs + 3 * HOUR + jitter(45 * MIN);
    case '6h': return fromTs + 6 * HOUR + jitter(45 * MIN);
    case 'daily': {
      const [hhRaw, mmRaw] = (dailyTime || '08:00').split(':');
      const hh = Math.min(23, Math.max(0, parseInt(hhRaw, 10) || 0));
      const mm = Math.min(59, Math.max(0, parseInt(mmRaw, 10) || 0));
      const d = new Date(fromTs);
      const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0, 0);
      if (target.getTime() <= fromTs) target.setDate(target.getDate() + 1);
      let planned = target.getTime() + (jitter(30 * MIN) - 15 * MIN); // ±15min
      // ±15min 抖动可能把时间往前拨到 fromTs 之前(当 now 落在目标时刻前 15min 内创建/
      // 保存任务时)→ 顺延一天,避免「设每天 08:00 却在 07:50 保存后立刻触发」。
      if (planned <= fromTs) planned += 24 * HOUR;
      return planned;
    }
    case 'daily_random': {
      const d = new Date(fromTs);
      const nextMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
      return nextMidnight + jitter(24 * HOUR);
    }
    case 'once':
    default:
      return Infinity;
  }
}

export interface VideoTaskLog {
  /** "HH:MM:SS" */
  time: string;
  message: string;
  /** 该条日志归属的步骤序号(对齐 steps 下标);未知 / 旧记录为 undefined。
   *  用于详情页「当前运行明细」按步骤内联展示日志(对齐币安 StepLogBox)。 */
  step?: number;
}

/** 持久化的【任务】= 配置 + 聚合统计。 */
export interface VideoTask {
  id: string;
  /** 列表/详情页标题(由赛道 + 关键词派生,可在编辑时改)。 */
  title: string;
  input: VideoCreationInput;
  createdAt: number;
  updatedAt: number;
  // ── 聚合统计(随每次运行结束更新) ──
  /** 累计跑过几次。 */
  runCount: number;
  /** 最近一次运行的 id(详情页据此找「本次运行」)。 */
  lastRunId?: string;
  /** 最近一次运行的状态。 */
  lastStatus?: VideoRunStatus;
  /** 最近一次运行结束 / 启动的时间。 */
  lastRunAt?: number;
  /** 最近一次成片的本地路径。 */
  lastOutputPath?: string;
  /** 该任务历次运行累计消耗的 DeepSeek token。 */
  cumulativeTokens: number;
  /** 该任务历次运行累计 USD 成本(服务端权威 costUsd 之和);老任务为 0。 */
  cumulativeCostUsd: number;
  // ── 定时运行(可选;缺省 = 'once' 仅手动,跟老任务向后兼容) ──
  /** 定时间隔;缺省 / 'once' = 不自动重复。 */
  runInterval?: VideoRunInterval;
  /** runInterval==='daily' 时的触发时刻 "HH:MM"。 */
  dailyTime?: string;
  /** 定时开关(详情页可暂停 / 恢复;缺省按 runInterval!=='once' 推定)。 */
  scheduleEnabled?: boolean;
  /** 下一次计划运行时间戳(调度器算出并持久化,卡片 / 详情页展示用)。 */
  nextPlannedRunAt?: number;
}

/** 每次运行产生一条【运行记录】= 进度 + 日志 + 成片 + 消耗。 */
export interface VideoRunRecord {
  id: string;
  taskId: string;
  /** 运行时的任务标题快照。 */
  title: string;
  /** 运行时的配置快照(任务后续被编辑也不影响历史记录)。 */
  input: VideoCreationInput;
  status: VideoRunStatus;
  steps: VideoCreationProgressStep[];
  logs: VideoTaskLog[];
  /** 最近一条进度文案。 */
  message?: string;
  outputPath?: string;
  /** 成片输出目录(开跑即确定)。 */
  outputDir?: string;
  /** 本次实际产出的成片条数(批量出片时>1);缺省 / 老记录按 1 计。 */
  videoCount?: number;
  error?: string;
  /** 本次运行消耗的 DeepSeek token(TTS/ffmpeg 免费不计)。 */
  tokensUsed: number;
  /** 本次运行 USD 成本(服务端权威 _noobclaw.costUsd 之和);老记录为 0。 */
  costUsd: number;
  startedAt: number;
  finishedAt?: number;
}

type Listener = () => void;

function nowHms(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 从一帧进度的 steps 推出「当前步骤下标」用于日志归属:
 *   - 优先取正在 running 的那一步;
 *   - 没有 running(步骤间隙 / 全部跑完)时取最后一个 done/error 的步骤;
 *   - 都没有(开跑前)返回 undefined。
 */
function currentStepIndex(steps?: VideoCreationProgressStep[]): number | undefined {
  if (!Array.isArray(steps) || steps.length === 0) return undefined;
  const running = steps.findIndex((s) => s.status === 'running');
  if (running >= 0) return running;
  let last = -1;
  steps.forEach((s, i) => { if (s.status === 'done' || s.status === 'error') last = i; });
  return last >= 0 ? last : undefined;
}

/** 12 位十六进制 id,展示用 #id.slice(0,8),格式对齐 scenario 短 id。 */
function genId(): string {
  let s = '';
  for (let i = 0; i < 12; i++) s += Math.floor(Math.random() * 16).toString(16);
  // 拼一截时间戳低位降低碰撞概率(只影响后缀,不影响前 8 位展示稳定性)。
  return s;
}

class VideoTaskStore {
  private tasks: VideoTask[] = [];
  private runs: VideoRunRecord[] = [];
  private listeners = new Set<Listener>();
  private running = false;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  /** 定时到点时的派发钩子。videoQueue 注入后,定时任务改【入队】而非直接 runTask
   *  (避免和统一队列抢锁,破坏「视频类同时只 1 个」)。未注入则回落到直接 runTask。 */
  public onScheduleDue: ((taskId: string) => void) | null = null;

  constructor() {
    this.load();
    this.startScheduler();
  }

  // ── 定时调度(渲染端轻量轮询) ───────────────────────────
  /**
   * 视频创作是纯本地流水线、任务态全在本 store(renderer/localStorage),所以定时也放
   * 在渲染端跑一个每分钟的轮询,而不是接进主进程 scenarioManager(那套是为浏览器自动化
   * 设计的,塞视频任务进去要改一大堆主进程代码)。代价:只在 app 窗口开着时才会触发
   * —— 这对「本地出片」恰好合理(出片本来就要 app 在前台)。单任务串行,跟手动跑互斥。
   */
  private startScheduler() {
    // 矩阵 edition:热搜成片已迁入矩阵菜单,需要定点/手动运行 → 照常起定时调度。
    if (typeof setInterval === 'undefined' || this.schedulerTimer) return;
    // setInterval 首跳在 60s 后 —— 顺带给 app 启动留出缓冲,不在刚打开就突然开跑。
    this.schedulerTimer = setInterval(() => {
      try { this.schedulerTick(); } catch { /* 单次 tick 抛错不影响后续 */ }
    }, 60 * 1000);
  }

  private schedulerTick() {
    const now = Date.now();
    // 1) 补算:开了定时但还没算下次运行的任务(老数据 / 刚开关过)。
    let patched = false;
    for (const t of this.tasks) {
      // 暂停功能已移除:定时任务一律到点跑,不再看 scheduleEnabled(老数据若为 false 也照跑)。
      if (t.runInterval && t.runInterval !== 'once'
        && typeof t.nextPlannedRunAt !== 'number') {
        t.nextPlannedRunAt = computeNextVideoRun(t.runInterval, t.dailyTime, now);
        t.updatedAt = now;
        patched = true;
      }
    }
    if (patched) this.emit();
    // 2) 有任务在跑就让位,下一跳再说(本地出片单任务串行)。
    if (this.running) return;
    // 3) 选「到点且最早」的一个开跑。runTask 的 .finally 会重算它的 nextPlannedRunAt。
    const due = this.tasks
      .filter((t) => t.runInterval && t.runInterval !== 'once'
        && typeof t.nextPlannedRunAt === 'number' && now >= (t.nextPlannedRunAt as number))
      .sort((a, b) => (a.nextPlannedRunAt as number) - (b.nextPlannedRunAt as number));
    if (due.length === 0) return;
    // 有统一队列(videoQueue)接管则入队;否则回落到直接跑(向后兼容)。
    if (this.onScheduleDue) this.onScheduleDue(due[0].id);
    else this.runTask(due[0].id);
  }

  /** 详情页暂停 / 恢复定时(不改 interval,只切开关并重算 / 清除下次运行)。 */
  setScheduleEnabled(id: string, enabled: boolean): void {
    this.patchTask(id, (t) => {
      if (!t.runInterval || t.runInterval === 'once') return; // 没设过定时,开关无意义
      t.scheduleEnabled = enabled;
      t.nextPlannedRunAt = enabled
        ? computeNextVideoRun(t.runInterval, t.dailyTime, Date.now())
        : undefined;
    });
  }

  // ── 持久化 ──────────────────────────────────────────────
  private load() {
    try {
      const rawTasks = localStorage.getItem(TASKS_KEY);
      if (rawTasks) {
        const parsed = JSON.parse(rawTasks);
        if (Array.isArray(parsed)) {
          this.tasks = parsed.map((t: any) => this.migrateTask(t)).filter(Boolean) as VideoTask[];
        }
      }
    } catch {
      this.tasks = [];
    }
    try {
      const rawRuns = localStorage.getItem(RUNS_KEY);
      if (rawRuns) {
        const parsed = JSON.parse(rawRuns);
        if (Array.isArray(parsed)) {
          this.runs = parsed.map((r: VideoRunRecord) => {
            // 老记录字段兜底:costUsd 缺 → 0;logs 缺(早于该字段的持久化记录)→ []。
            //   logs 若为 undefined,运行记录页 run.logs.length 会整块崩(「渲染错误
            //   MainView:matrixRuns — undefined is not an object 'logs.length'」),必须在
            //   反序列化入口就补齐(消费端也各自加了 ?. 兜底,双保险)。
            const withCost: VideoRunRecord = {
              ...r,
              costUsd: typeof r.costUsd === 'number' ? r.costUsd : 0,
              logs: Array.isArray(r.logs) ? r.logs : [],
            };
            // 重启后上次跑到一半的运行记录已无主进程 job 续命,标记为中断
            if (withCost.status === 'running') {
              return { ...withCost, status: 'error' as const, error: withCost.error || '应用重启,该任务已中断', finishedAt: withCost.finishedAt || Date.now() };
            }
            return withCost;
          });
        }
      }
    } catch {
      this.runs = [];
    }
    // 修正:任务的 lastStatus 若还停在 running(老数据 / 异常),按其最近运行记录回填。
    for (const t of this.tasks) {
      if (t.lastStatus === 'running') {
        const run = t.lastRunId ? this.runs.find((r) => r.id === t.lastRunId) : undefined;
        t.lastStatus = run?.status === 'running' ? 'error' : (run?.status || 'error');
      }
    }
  }

  /**
   * 兼容旧版本(2.7.5 及以前)单体 VideoTask 结构(任务 = 配置 + 进度 + 日志混在一起)。
   * 老数据迁移成新的【任务】壳子,并把那次进度搬成一条运行记录。
   */
  private migrateTask(t: any): VideoTask | null {
    if (!t || typeof t !== 'object' || !t.id) return null;
    // 新结构已带 runCount / cumulativeTokens 字段 → 直接用(补 cumulativeCostUsd 兜底)。
    if (typeof t.runCount === 'number' && typeof t.cumulativeTokens === 'number') {
      if (typeof t.cumulativeCostUsd !== 'number') t.cumulativeCostUsd = 0;
      return t as VideoTask;
    }
    // 老结构:t.status / t.steps / t.logs / t.outputPath / t.error 都在任务上。
    const status: VideoRunStatus = t.status === 'running' ? 'error' : (t.status || 'done');
    const runId = genId();
    const run: VideoRunRecord = {
      id: runId,
      taskId: t.id,
      title: t.title || '视频创作任务',
      input: t.input,
      status,
      steps: Array.isArray(t.steps) ? t.steps : [],
      logs: Array.isArray(t.logs) ? t.logs : [],
      message: t.message,
      outputPath: t.outputPath,
      error: status === 'error' ? (t.error || '应用重启,该任务已中断') : t.error,
      tokensUsed: 0,
      costUsd: 0,
      startedAt: t.createdAt || Date.now(),
      finishedAt: t.updatedAt || Date.now(),
    };
    this.runs.push(run);
    return {
      id: t.id,
      title: t.title || '视频创作任务',
      input: t.input,
      createdAt: t.createdAt || Date.now(),
      updatedAt: t.updatedAt || Date.now(),
      runCount: 1,
      lastRunId: runId,
      lastStatus: status,
      lastRunAt: run.finishedAt,
      lastOutputPath: t.outputPath,
      cumulativeTokens: 0,
      cumulativeCostUsd: 0,
    };
  }

  private persist() {
    try {
      localStorage.setItem(TASKS_KEY, JSON.stringify(this.tasks.slice(0, MAX_TASKS)));
      localStorage.setItem(RUNS_KEY, JSON.stringify(this.runs.slice(-MAX_RUNS)));
    } catch { /* 配额满 / 隐私模式,忽略 */ }
  }

  // ── 订阅 ────────────────────────────────────────────────
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit() {
    this.persist();
    for (const l of this.listeners) {
      try { l(); } catch { /* 单个订阅者抛错不影响其它 */ }
    }
  }

  // ── 读取 ────────────────────────────────────────────────
  getTasks(): VideoTask[] {
    // 新的在前
    return [...this.tasks].sort((a, b) => (b.lastRunAt || b.createdAt) - (a.lastRunAt || a.createdAt));
  }

  getTask(id: string): VideoTask | undefined {
    return this.tasks.find((t) => t.id === id);
  }

  /** 全部运行记录,新的在前。 */
  getRuns(): VideoRunRecord[] {
    return [...this.runs].sort((a, b) => b.startedAt - a.startedAt);
  }

  /** 某任务的运行记录,新的在前。 */
  getRunsForTask(taskId: string): VideoRunRecord[] {
    return this.runs.filter((r) => r.taskId === taskId).sort((a, b) => b.startedAt - a.startedAt);
  }

  getRun(id: string): VideoRunRecord | undefined {
    return this.runs.find((r) => r.id === id);
  }

  /** 某任务最近一次运行记录(详情页「本次运行」用)。 */
  getLatestRun(taskId: string): VideoRunRecord | undefined {
    const t = this.getTask(taskId);
    if (t?.lastRunId) {
      const r = this.runs.find((x) => x.id === t.lastRunId);
      if (r) return r;
    }
    return this.getRunsForTask(taskId)[0];
  }

  isAnyRunning(): boolean {
    return this.running;
  }

  // ── 写入(私有) ──────────────────────────────────────────
  private patchTask(id: string, fn: (t: VideoTask) => void) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    fn(t);
    t.updatedAt = Date.now();
    this.emit();
  }

  private patchRun(id: string, fn: (r: VideoRunRecord) => void) {
    const r = this.runs.find((x) => x.id === id);
    if (!r) return;
    fn(r);
    this.emit();
  }

  private appendLog(r: VideoRunRecord, message: string, step?: number) {
    const last = r.logs[r.logs.length - 1];
    if (last && last.message === message) return; // 去重连续重复
    r.logs.push({ time: nowHms(), message, step });
    if (r.logs.length > MAX_LOGS) r.logs = r.logs.slice(-MAX_LOGS);
  }

  // ── 任务 CRUD ───────────────────────────────────────────
  /** 仅创建任务(不立即跑),返回 taskId。schedule 缺省 = 'once' 仅手动。 */
  createTask(input: VideoCreationInput, title: string, schedule?: VideoSchedule): string {
    const id = genId();
    const interval = schedule?.runInterval || 'once';
    const scheduled = interval !== 'once';
    const task: VideoTask = {
      id,
      title: title || '视频创作任务',
      input,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      runCount: 0,
      cumulativeTokens: 0,
      cumulativeCostUsd: 0,
      runInterval: interval,
      dailyTime: schedule?.dailyTime,
      scheduleEnabled: scheduled,
      nextPlannedRunAt: scheduled ? computeNextVideoRun(interval, schedule?.dailyTime, Date.now()) : undefined,
    };
    this.tasks.unshift(task);
    if (this.tasks.length > MAX_TASKS) this.tasks = this.tasks.slice(0, MAX_TASKS);
    this.emit();
    return id;
  }

  /** 编辑任务配置 / 标题 / 定时(运行中不允许改)。schedule 缺省则不动原定时设置。 */
  updateTask(id: string, input: VideoCreationInput, title: string, schedule?: VideoSchedule): boolean {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return false;
    if (t.lastStatus === 'running') return false;
    t.input = input;
    t.title = title || t.title;
    if (schedule) {
      const interval = schedule.runInterval || 'once';
      const scheduled = interval !== 'once';
      const changed = t.runInterval !== interval || t.dailyTime !== schedule.dailyTime;
      t.runInterval = interval;
      t.dailyTime = schedule.dailyTime;
      t.scheduleEnabled = scheduled;
      // 关掉 → 清下次;间隔/时刻变了或还没算过 → 重算。
      if (!scheduled) t.nextPlannedRunAt = undefined;
      else if (changed || typeof t.nextPlannedRunAt !== 'number') {
        t.nextPlannedRunAt = computeNextVideoRun(interval, schedule.dailyTime, Date.now());
      }
    }
    t.updatedAt = Date.now();
    this.emit();
    return true;
  }

  /** 删除任务及其全部运行记录(任务运行中不允许删)。 */
  deleteTask(id: string): boolean {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return false;
    if (t.lastStatus === 'running') return false;
    this.tasks = this.tasks.filter((x) => x.id !== id);
    this.runs = this.runs.filter((r) => r.taskId !== id);
    this.emit();
    return true;
  }

  /** 删除单条运行记录(运行中不允许删)。 */
  deleteRun(id: string): boolean {
    const r = this.runs.find((x) => x.id === id);
    if (!r) return false;
    if (r.status === 'running') return false;
    this.runs = this.runs.filter((x) => x.id !== id);
    this.emit();
    return true;
  }

  // ── 运行 ────────────────────────────────────────────────
  /**
   * 跑(或重跑)一个已存在的任务。生成一条运行记录并启动流水线。
   * 返回 runId;若任务不存在 / 已有任务在跑则返回 null(上层提示)。
   */
  runTask(taskId: string): string | null {
    if (this.running) return null;
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) return null;

    const runId = genId();
    const run: VideoRunRecord = {
      id: runId,
      taskId,
      title: task.title,
      input: task.input,
      status: 'running',
      steps: [],
      logs: [{ time: nowHms(), message: '任务已创建,开始生成…' }],
      tokensUsed: 0,
      costUsd: 0,
      startedAt: Date.now(),
    };
    this.runs.push(run);
    if (this.runs.length > MAX_RUNS) this.runs = this.runs.slice(-MAX_RUNS);

    // 任务聚合:开跑即标 running,runCount++。
    task.runCount += 1;
    task.lastRunId = runId;
    task.lastStatus = 'running';
    task.lastRunAt = Date.now();
    task.updatedAt = Date.now();

    this.running = true;
    this.emit();

    const onProgress = (p: VideoCreationProgress) => {
      this.patchRun(runId, (r) => {
        if (r.status !== 'running') return;
        if (Array.isArray(p.steps) && p.steps.length) r.steps = p.steps;
        if (typeof p.tokensUsed === 'number') r.tokensUsed = p.tokensUsed;
        if (typeof p.costUsd === 'number') r.costUsd = p.costUsd;
        if (p.outputDir) r.outputDir = p.outputDir;
        if (p.message) {
          r.message = p.message;
          // 把本条日志归属到「当前正在跑的步骤」(没有 running 的就归到最后一个
          // 已完成/出错的步骤),供详情页按步骤内联展示。
          this.appendLog(r, p.message, currentStepIndex(p.steps));
        }
      });
    };

    // fire-and-forget;store 单例持有 promise,组件卸载不影响。
    // 带上 taskId/taskTitle,让主进程把成片输出到「按任务」的总目录
    // (视频创作/<id前8位>_<任务名>),详情页顶部「输出目录」据此稳定指向本任务目录。
    void videoCreationService
      .generate({ ...task.input, taskId: task.id, taskTitle: task.title }, onProgress)
      .then((res) => {
        this.patchRun(runId, (r) => {
          if (res.ok && res.outputPath) {
            r.status = 'done';
            r.outputPath = res.outputPath;
            // 实际产出条数以主进程终态回传的 videoCount 为准(个别条失败时 < 请求数),
            // 兜底用配置里的请求数;计入「累计/上次完成」的视频条数统计。
            const n = res.videoCount && res.videoCount > 0
              ? res.videoCount
              : Math.max(1, Math.min(100, Math.round(r.input.videoCount ?? 1)));
            r.videoCount = n;
            // 批量出片(n>1):全部成片都落在同一输出目录,点「打开文件夹」可见;
            // outputPath 仍指向首条(详情页快捷打开用)。
            this.appendLog(r, n > 1 ? `✅ 生成完成(${n} 条已输出到同一文件夹)` : '✅ 生成完成');
          } else {
            r.status = 'error';
            r.error = res.error || '生成失败';
            this.appendLog(r, `❌ ${r.error}`);
          }
          r.finishedAt = Date.now();
        });
      })
      .catch((e) => {
        this.patchRun(runId, (r) => {
          r.status = 'error';
          r.error = String(e).slice(0, 200);
          this.appendLog(r, `❌ ${r.error}`);
          r.finishedAt = Date.now();
        });
      })
      .finally(() => {
        this.running = false;
        // 运行结束:把运行记录的终态回写到任务聚合统计。
        const run2 = this.runs.find((r) => r.id === runId);
        this.patchTask(taskId, (t) => {
          if (!run2) return;
          t.lastStatus = run2.status;
          t.lastOutputPath = run2.outputPath || t.lastOutputPath;
          t.lastRunAt = run2.finishedAt || Date.now();
          t.cumulativeTokens += run2.tokensUsed || 0;
          t.cumulativeCostUsd = (t.cumulativeCostUsd || 0) + (run2.costUsd || 0);
          // 定时任务:本次跑完即排下一次(从现在算起,避免出片耗时累积漂移)。暂停功能已移除。
          if (t.runInterval && t.runInterval !== 'once') {
            t.nextPlannedRunAt = computeNextVideoRun(t.runInterval, t.dailyTime, Date.now());
          }
        });
      });

    return runId;
  }

  /**
   * 停止正在跑的任务:abort 主进程 pipeline + SIGKILL ffmpeg/seedance/tts 子进程。
   * 运行记录的终态(error='已停止')由 generate() 的 SSE 终态回写;这里只触发 abort
   * 并打一条「正在停止」日志。abort 后主进程在步骤边界/子进程退出处优雅收尾。
   */
  stopTask(taskId: string): boolean {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task || task.lastStatus !== 'running') return false;
    const runId = task.lastRunId;
    if (runId) {
      this.patchRun(runId, (r) => { if (r.status === 'running') this.appendLog(r, '⏹ 正在停止…'); });
    }
    void videoCreationService.stop(taskId);
    return true;
  }

  /**
   * 便捷方法:创建任务并立即跑。返回 taskId;已有任务在跑则返回 null。
   * 给「新建视频创作任务」一步到位用。
   */
  createAndRun(input: VideoCreationInput, title: string, schedule?: VideoSchedule): string | null {
    if (this.running) return null;
    const taskId = this.createTask(input, title, schedule);
    const runId = this.runTask(taskId);
    if (!runId) {
      // 理论上不会到这(刚 createTask 完且 running=false),兜底回滚。
      this.deleteTask(taskId);
      return null;
    }
    return taskId;
  }
}

export const videoTaskStore = new VideoTaskStore();
