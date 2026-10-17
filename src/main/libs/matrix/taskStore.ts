/**
 * 矩阵任务存储 —— 本地 JSON,与 accounts.json 同目录(见 accountManager)。
 *
 * 约束(产品定义):每平台最多 5 个任务、同平台同类型只允许 1 个(重复无意义);
 * 全局同时只跑 1 个 —— 那个「运行时锁」在 sidecar 侧维护,不在这里。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { coworkLog } from '../coworkLogger';
import { nextRunAt } from './matrixSchedule';
import { REPORT_LIMITS } from './types';
import type { ReportItem, ReportItemResult } from './types';
import { validateReportItem } from './reportTaxonomy';
import type { MatrixTask, EngageQuota, ReplyFanConfig, ImageTextConfig, ViralRewriteConfig, TweetPostConfig, BinancePostConfig, FacebookPostConfig, RedditPostConfig, InstagramPostConfig, BinanceRepostConfig, LeadEngageConfig, MatrixTaskType, MatrixTaskFrequency } from './types';

/** 任务启用且非 once 才排下次运行;否则清空(手动触发)。 */
function planned(t: { enabled: boolean; frequency: MatrixTaskFrequency }, fromTs: number, isFirst: boolean): number | undefined {
  return t.enabled && t.frequency !== 'once' ? nextRunAt(t.frequency, fromTs, isFirst) : undefined;
}

function baseDir(): string { return process.env.NOOBCLAW_MATRIX_DIR || path.join(os.homedir(), 'NoobClaw', 'matrix'); }
function storeFile(): string { return path.join(baseDir(), 'tasks.json'); }

const MAX_PER_PLATFORM = 5;
let cache: MatrixTask[] | null = null;

// 老任务类型归一。交易所广场四家(gate/okx/bitget/bybit)的发帖/搬运向导曾把【任务类型】
// 拼成 `${platform}_post` / `${platform}_repost` 存进 tasks.json —— 这不是合法的 MatrixTaskType,
// 跑起来直接 unsupported_task_type(用户实测 gate 自动发帖)。新建路径已修,但【已经存盘的老任务】
// 里还是坏值,不归一就永远跑不起来,而且重复校验按 type 比,还会让用户重复建一条。
// ⚠️ 只认这 4 个交易所前缀:x_post / facebook_post / reddit_post / instagram_post 本身就是合法类型。
const LEGACY_EXCHANGE_TYPE = /^(gate|okx|bitget|bybit)_(post|repost)$/;
function normalizeTaskType(t: any): any {
  const m = LEGACY_EXCHANGE_TYPE.exec(String(t?.type || ''));
  if (!m) return t;
  return { ...t, type: m[2] === 'repost' ? 'binance_repost' : 'binance_post' };
}

export function loadTasks(): MatrixTask[] {
  if (cache) return cache;
  const f = storeFile();
  if (!fs.existsSync(f)) { cache = []; return cache; }
  try {
    const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
    cache = Array.isArray(arr) ? arr.map(normalizeTaskType) : [];
  } catch (e) {
    // 坏文件备份留证,不静默清空。
    try { fs.copyFileSync(f, `${f}.corrupt.${Date.now()}`); } catch { /* ignore */ }
    coworkLog('ERROR', 'taskStore', `tasks.json parse failed, backed up; starting empty: ${String(e)}`);
    cache = [];
  }
  return cache;
}

function persist(): void {
  fs.mkdirSync(baseDir(), { recursive: true });
  const f = storeFile();
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache || [], null, 2), 'utf8');
  fs.renameSync(tmp, f);
}

export function listTasks(): MatrixTask[] { return [...loadTasks()]; }
export function getTask(id: string): MatrixTask | undefined { return loadTasks().find((t) => t.id === id); }

export interface SaveTaskInput {
  id?: string;                       // 传则更新,不传则新建
  platform: string;
  type: MatrixTaskType;
  name?: string;
  enabled?: boolean;
  accountIds: string[];
  quota?: EngageQuota;             // engage 必填;reply_fan / video_download 可省(存空对象)
  funnel?: ReplyFanConfig;         // reply_fan 用:引流尾巴配置
  // 各账号独立引流语:对象=各账号模式;null=显式清掉(切回共用);undefined=更新时保留旧值。
  funnelByAccount?: Record<string, ReplyFanConfig> | null;
  maxReplyPerComment?: number;
  maxRepliesPerRun?: number;          // reply_fan(抖音)用:每号本次运行最多回复几条
  imageText?: ImageTextConfig;     // image_text 用:图文创作配置
  viralRewrite?: ViralRewriteConfig; // viral_rewrite 用:爆款仿写配置
  tweetPost?: TweetPostConfig;     // x_post 用:自动发推配置
  binancePost?: BinancePostConfig; // binance_post 用:币安广场自动发帖配置
  facebookPost?: FacebookPostConfig; // facebook_post 用:Facebook 自动发帖配置(含数据源)
  redditPost?: RedditPostConfig;   // reddit_post 用:Reddit 自动发帖配置(含数据源 + subreddit)
  instagramPost?: InstagramPostConfig; // instagram_post 用:Instagram 自动发帖配置(含数据源,图必带)
  binanceRepost?: BinanceRepostConfig; // binance_repost 用:币安广场批量搬运配置
  leadEngage?: LeadEngageConfig;   // lead_engage 用:定向获客配置
  urls?: string[];                 // video_download 用:待下载视频链接清单
  reportItems?: ReportItem[];      // report 用:1-4 条举报条目
  concurrency?: number;
  frequency: MatrixTaskFrequency;
}
export interface SaveTaskResult { ok: boolean; error?: string; task?: MatrixTask }

// ── 举报(report)合规校验 ──────────────────────────────────────────────
// 产品拍板的硬约束,存盘时就拦死(UI 也会拦,这里是最后一道):
//   · 目前仅抖音;只能选【1 个】账号;1-4 条链接;每条必须有合法原因 + 5-200 字描述
//   · 频率恒 'once'、enabled 恒 false(永不进定时调度);同时只开 1 个窗口
//   · 只能手动触发,每次触发逐条只提交一次(不重试);可编辑、可再次手动运行
const REPORT_PLATFORMS = ['douyin'];
// 返回值用宽松对象而非判别联合:本项目 tsconfig 不开 strictNullChecks,`ok: true|false` 判别联合不会收窄(CI 报 TS2339)。
function validateReport(input: SaveTaskInput): { ok: boolean; items?: ReportItem[]; error?: string } {
  if (!REPORT_PLATFORMS.includes(input.platform)) return { ok: false, error: 'report_platform_unsupported' };
  const ids = (input.accountIds || []).filter(Boolean);
  if (ids.length !== 1) return { ok: false, error: 'report_requires_single_account' };
  const raw = Array.isArray(input.reportItems) ? input.reportItems : [];
  if (raw.length < REPORT_LIMITS.minItems || raw.length > REPORT_LIMITS.maxItems) return { ok: false, error: 'report_item_count' };
  const items: ReportItem[] = [];
  const seen = new Set<string>();
  for (const it of raw) {
    // 与渲染层向导同一套规则(reportTaxonomy.validateReportItem):抖音原文原因/具体类型、类型与链接一致、描述 5-200 字
    const err = validateReportItem(it as any);
    if (err) return { ok: false, error: err };
    const url = String(it.url).trim();
    if (seen.has(url)) return { ok: false, error: 'report_duplicate_url' };
    seen.add(url);
    items.push({
      url,
      targetType: it.targetType,
      reason: String(it.reason),
      subReason: it.subReason ? String(it.subReason) : undefined,
      description: String(it.description).trim(),
    });
  }
  return { ok: true, items };
}

/** 抖音Report:记录最近一次正式执行时间(展示用;不锁定,任务可编辑、可再次手动运行)。 */
export function markReportExecuted(id: string): void {
  const t = getTask(id);
  if (!t || t.type !== 'report') return;
  t.reportExecutedAt = Date.now();
  t.enabled = false;
  t.nextPlannedRunAt = undefined;
  persist();
}

/** 保存 Report 逐条结果(剧本回传)。dryRun=试运行结果(不影响执行锁)。 */
export function setReportResults(id: string, results: ReportItemResult[], dryRun: boolean): void {
  const t = getTask(id);
  if (!t || t.type !== 'report') return;
  const clean = (Array.isArray(results) ? results : []).slice(0, REPORT_LIMITS.maxItems).map((r) => ({
    url: String(r?.url || ''), status: r?.status, why: r?.why ? String(r.why) : undefined,
    confirmed: typeof r?.confirmed === 'boolean' ? r.confirmed : undefined, ts: typeof r?.ts === 'number' ? r.ts : Date.now(),
  })) as ReportItemResult[];
  if (dryRun) { t.reportDryRunAt = Date.now(); t.reportDryRunResults = clean; }
  else { t.reportResults = clean; }
  persist();
}

/** 新建/更新任务,带约束校验。 */
export function saveTask(input: SaveTaskInput): SaveTaskResult {
  const tasks = loadTasks();

  // 举报:先过合规校验,并把调度相关字段强制成「仅手动、仅一次、单窗口」。
  let reportItems: ReportItem[] | undefined;
  if (input.type === 'report') {
    const v = validateReport(input);
    if (!v.ok || !v.items) return { ok: false, error: v.error || 'report_invalid' };
    reportItems = v.items;
    input = { ...input, reportItems, frequency: 'once', enabled: false, concurrency: 1, quota: {} };
  }

  if (input.id) {
    const i = tasks.findIndex((t) => t.id === input.id);
    if (i < 0) return { ok: false, error: 'task_not_found' };
    // 别的类型不能改成/改出抖音Report(白名单 + 单账号等约束只对 report 生效,类型切换会绕过)。
    if ((tasks[i].type === 'report') !== (input.type === 'report')) return { ok: false, error: 'report_type_change_forbidden' };
    // 改 type 不能撞到同平台已有的别的同类型任务(举报除外:每次举报是独立的一次性单据,可并存多张)
    const dup = input.type === 'report' ? undefined : tasks.find((t) => t.id !== input.id && t.platform === input.platform && t.type === input.type);
    if (dup) return { ok: false, error: 'duplicate_type' };
    const updated: MatrixTask = {
      ...tasks[i],
      platform: input.platform, type: input.type,
      name: input.name || tasks[i].name,
      enabled: input.enabled ?? tasks[i].enabled,
      accountIds: input.accountIds || [],
      quota: input.quota || {},
      funnel: input.funnel ?? tasks[i].funnel,
      // null=显式清掉(向导切回共用模式);undefined=没动这块(如 updateTask 兜底),保留旧值。
      funnelByAccount: input.funnelByAccount === undefined ? tasks[i].funnelByAccount : (input.funnelByAccount || undefined),
      // undefined = 本次没传(保留原值);传了就覆盖 —— 与 funnelByAccount 同一口径,
      //   否则编辑任务时只改频率也会把它抹掉。
      maxReplyPerComment: input.maxReplyPerComment === undefined ? tasks[i].maxReplyPerComment : input.maxReplyPerComment,
      maxRepliesPerRun: input.maxRepliesPerRun === undefined ? tasks[i].maxRepliesPerRun : input.maxRepliesPerRun,
      imageText: input.imageText ?? tasks[i].imageText,
      viralRewrite: input.viralRewrite ?? tasks[i].viralRewrite,
      tweetPost: input.tweetPost ?? tasks[i].tweetPost,
      binancePost: input.binancePost ?? tasks[i].binancePost,
      facebookPost: input.facebookPost ?? tasks[i].facebookPost,
      redditPost: input.redditPost ?? tasks[i].redditPost,
      instagramPost: input.instagramPost ?? tasks[i].instagramPost,
      binanceRepost: input.binanceRepost ?? tasks[i].binanceRepost,
      leadEngage: input.leadEngage ?? tasks[i].leadEngage,
      urls: input.urls ?? tasks[i].urls,
      reportItems: input.type === 'report' ? reportItems : tasks[i].reportItems,
      concurrency: input.concurrency,
      frequency: input.frequency,
    };
    updated.nextPlannedRunAt = planned(updated, Date.now(), true); // 配置变更视为从现在重排
    tasks[i] = updated; cache = tasks; persist();
    return { ok: true, task: updated };
  }

  // 举报单据不占「每平台 5 个任务」名额、也不受同类型唯一限制(一次性单据,执行完即归档)。
  const platformTasks = tasks.filter((t) => t.platform === input.platform && t.type !== 'report');
  if (input.type !== 'report') {
    if (platformTasks.length >= MAX_PER_PLATFORM) return { ok: false, error: 'platform_task_limit' };
    if (platformTasks.some((t) => t.type === input.type)) return { ok: false, error: 'duplicate_type' };
  }

  const task: MatrixTask = {
    id: `${input.platform}_${input.type}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4).toString(36)}`,
    platform: input.platform,
    type: input.type,
    name: input.name || `${input.platform} 互动`,
    enabled: input.enabled ?? true,
    accountIds: input.accountIds || [],
    quota: input.quota || {},
    funnel: input.funnel,
    funnelByAccount: input.funnelByAccount || undefined,
    maxReplyPerComment: input.maxReplyPerComment,
    maxRepliesPerRun: input.maxRepliesPerRun,
    imageText: input.imageText,
    viralRewrite: input.viralRewrite,
    tweetPost: input.tweetPost,
    binancePost: input.binancePost,
    facebookPost: input.facebookPost,
    redditPost: input.redditPost,
    instagramPost: input.instagramPost,
    binanceRepost: input.binanceRepost,
    leadEngage: input.leadEngage,
    urls: input.urls,
    reportItems,
    concurrency: input.concurrency,
    frequency: input.frequency || 'once',
    createdAt: Date.now(),
  };
  task.nextPlannedRunAt = planned(task, Date.now(), true);
  tasks.push(task); cache = tasks; persist();
  return { ok: true, task };
}

export function removeTask(id: string): void {
  cache = loadTasks().filter((t) => t.id !== id);
  persist();
}

/**
 * 删号联动:把某个账号 id 从所有任务的 accountIds 里摘掉,避免 tasks.json 残留已删账号的
 * 幽灵 id(运行时会被误判「超额暂停」并在 UI 冒出一个不存在的号)。只在有实际变更时落盘。
 */
export function pruneAccountFromTasks(accountId: string): void {
  const tasks = loadTasks();
  let changed = false;
  for (const t of tasks) {
    if (Array.isArray(t.accountIds) && t.accountIds.includes(accountId)) {
      t.accountIds = t.accountIds.filter((id) => id !== accountId);
      changed = true;
    }
  }
  if (changed) { cache = tasks; persist(); }
}

export function setTaskEnabled(id: string, enabled: boolean): void {
  const t = getTask(id); if (!t) return;
  if (t.type === 'report') return; // 举报永不进定时调度
  t.enabled = enabled;
  t.nextPlannedRunAt = planned(t, Date.now(), true);
  persist();
}

export function setTaskLastRun(id: string, ts: number): void {
  const t = getTask(id); if (!t) return;
  t.lastRunAt = ts;
  t.nextPlannedRunAt = planned(t, ts, false); // 跑完排下一次
  persist();
}

/** 调度器用:到点该自动跑的任务(启用、非 once、已到 nextPlannedRunAt)。 */
export function dueTasks(now: number): MatrixTask[] {
  return loadTasks().filter((t) => t.type !== 'report' && t.enabled && t.frequency !== 'once' && t.nextPlannedRunAt != null && t.nextPlannedRunAt <= now);
}
