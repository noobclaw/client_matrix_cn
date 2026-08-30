/**
 * taskRunReporter.ts — 异步 fire-and-forget 上报用户任务运行。
 *
 * 覆盖两类任务:
 *   1. 「一键涨粉」(scenario/orchestrator)—— scheduleRunReport(rec),触发点在
 *      runRecords.finishRecord() 进入终态后。
 *   2. 视频创作 —— scheduleVideoRunReport(args),触发点在 video/pipeline.ts
 *      generateVideo() 出片(成功/失败)后。
 *
 * 两类都落到后端同一张 user_task_runs 表(POST /api/me/task-run),供 admin 巡检,
 * 用 platform / workflow_type 区分(视频 workflow_type='video')。
 *
 * ⚠️ 硬约束(用户原话:「异步,不要影响用户任务执行 千万千千万不要」):
 *   - 绝不 throw、绝不 await、绝不阻塞任务主流程。
 *   - 所有错误(无 token、网络挂、后端 5xx)一律静默吞,只写 console。
 *
 * 幂等 / 去重:
 *   按 run_id(UUID)debounce + _sent 去重,绝不重发(后端 run_id 还有 UNIQUE +
 *   ON CONFLICT 兜底,双保险)。scenario 的 finishRecord 一次运行可能被调两次
 *   (先 status 后 result),debounce 确保只发最后一次最全快照。
 */

import { getNoobClawAuthToken } from '../claudeSettings';
import type { RunRecord } from './runRecords';

const REPORT_DELAY_MS = 4000;
const API_URL = 'https://api.noobclaw.com/api/me/task-run';

// run_id → 待发定时器
const _pending = new Map<string, ReturnType<typeof setTimeout>>();
// 已成功上报的 run_id —— 不重发。一个 app 会话内 run 数有限,Set 自然有界。
const _sent = new Set<string>();

interface ReportBody {
  run_id: string;
  task_id: string;
  scenario_id?: string;
  platform?: string;
  workflow_type?: string;
  task_name?: string;
  status?: string;
  summary?: string;
  error?: string;
  collected_count?: number;
  draft_count?: number;
  posted?: number;
  action_counts?: Record<string, number>;
  tokens_used?: number;
  cost_usd?: number;
  started_at?: number;
  finished_at?: number;
}

/** 通用 debounce 调度:同一 run_id 重复调用只发最后一次。buildBody 在定时器触发时
 *  才求值,确保拿到最新快照(scenario 的 live rec 会被后续 finishRecord 改)。 */
function enqueue(runId: string, buildBody: () => ReportBody | null, delayMs: number): void {
  try {
    if (!runId || _sent.has(runId)) return;
    const existing = _pending.get(runId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      _pending.delete(runId);
      void send(runId, buildBody);
    }, delayMs);
    // 不因上报定时器吊住进程 / 事件循环(任务跑完该退就退)。
    if (typeof (timer as any).unref === 'function') (timer as any).unref();
    _pending.set(runId, timer);
  } catch {
    /* 绝不反噬主流程 */
  }
}

async function send(runId: string, buildBody: () => ReportBody | null): Promise<void> {
  try {
    if (_sent.has(runId)) return;
    const token = getNoobClawAuthToken();
    if (!token) return; // 未登录 / 无 token —— fail-open,什么都不做
    const body = buildBody();
    if (!body) return;

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    if (res.ok) _sent.add(runId);
    // 非 2xx 不重试:避免后端故障时风暴。漏一条巡检数据无伤大雅,远好过反噬任务。
  } catch {
    /* 网络异常等一律静默吞 */
  }
}

/** 「一键涨粉」scenario 任务终态上报。由 runRecords.finishRecord 调用,传 live rec 引用。 */
export function scheduleRunReport(rec: RunRecord): void {
  try {
    if (!rec || !rec.id || rec.status === 'running' || _sent.has(rec.id)) return;
    enqueue(rec.id, () => {
      if (rec.status === 'running') return null;
      const snap = rec.scenario_snapshot || ({} as RunRecord['scenario_snapshot']);
      const result = rec.result || {};
      return {
        run_id: rec.id,
        task_id: rec.task_id,
        scenario_id: snap.id,
        platform: snap.platform,
        workflow_type: snap.workflow_type,
        task_name: snap.name_zh || snap.name_en || snap.id,
        status: rec.status,
        summary: rec.summary,
        error: rec.error,
        collected_count: result.collected_count,
        draft_count: result.draft_count,
        posted: result.posted,
        action_counts: result.action_counts,
        tokens_used: result.tokens_used,
        cost_usd: result.cost_usd,
        started_at: rec.started_at,
        finished_at: rec.finished_at,
      };
    }, REPORT_DELAY_MS);
  } catch {
    /* 绝不反噬主流程 */
  }
}

export interface VideoRunReportArgs {
  /** 本次出片的 UUID(run_id,幂等键)。 */
  runId: string;
  /** 视频创作输入(取 track / keywords / publishPlatforms 等做任务名/平台)。 */
  input: {
    track?: string;
    keywords?: string[];
    publishPlatforms?: string[];
  };
  /** generateVideo 的返回(决定成功/失败 + 输出路径 / 错误)。 */
  result: { ok: boolean; outputPath?: string; error?: string };
  startedAt: number;
  finishedAt: number;
  tokensUsed?: number;
  costUsd?: number;
}

/** 视频创作任务出片后上报。由 video/pipeline.ts generateVideo 包一层调用。
 *  视频是一次性出片(非周期任务),run_id 即可唯一;不需要 debounce,但仍走同一
 *  fire-and-forget + _sent 去重通道。*/
export function scheduleVideoRunReport(args: VideoRunReportArgs): void {
  try {
    if (!args || !args.runId || _sent.has(args.runId)) return;
    const { input, result } = args;
    const topic = (input.keywords || []).filter(Boolean).join('、') || input.track || '自定义';
    enqueue(args.runId, () => ({
      run_id: args.runId,
      task_id: 'video:' + (input.track || 'custom'),
      platform: (Array.isArray(input.publishPlatforms) && input.publishPlatforms.length > 0)
        ? input.publishPlatforms.join(',')
        : 'local',
      workflow_type: 'video',
      task_name: '视频创作 · ' + topic,
      status: result.ok ? 'done' : 'error',
      summary: result.ok ? (result.outputPath || '出片成功') : undefined,
      error: result.ok ? undefined : result.error,
      posted: result.ok ? 1 : 0,
      tokens_used: args.tokensUsed,
      cost_usd: args.costUsd,
      started_at: args.startedAt,
      finished_at: args.finishedAt,
    }), 0);
  } catch {
    /* 绝不反噬主流程 */
  }
}

/** 矩阵任务(互动/发帖/搬运/图文/仿写/回复/获客/下载)整任务汇总上报。
 *  由 sidecar-server 在 addRun() 之后调用,传 addRun 返回的整任务记录(含全局 success/failed/cost)。
 *  与 scenario/video 走同一 fire-and-forget + _sent 去重通道;run_id 用 addRun 生成的唯一 id,
 *  后端 UNIQUE + ON CONFLICT 再兜一层,绝不重复。绝不 throw / 不 await / 不反噬任务。 */
export function scheduleMatrixRunReport(rec: {
  id: string; taskId: string; taskName?: string; platform?: string; type?: string;
  startedAt: number; finishedAt: number; success: number; failed: number; skipped: number;
  totals?: Record<string, number>; cost?: { credits: number; usd: number };
}): void {
  try {
    if (!rec || !rec.id || _sent.has(rec.id)) return;
    const ok = Number(rec.success) || 0, bad = Number(rec.failed) || 0;
    const status = (ok > 0 && bad > 0) ? 'partial' : ok > 0 ? 'done' : bad > 0 ? 'error' : 'stopped';
    const totals = rec.totals || {};
    const posted = Number(totals.post) || 0;
    const acted = ['like', 'follow', 'comment', 'favorite'].reduce((s, k) => s + (Number(totals[k]) || 0), 0);
    const summary = rec.type && /_repost|repost|_post|post/.test(String(rec.type))
      ? `发布 ${posted} · 成功 ${ok}/${ok + bad}`
      : `动作 ${acted} · 成功 ${ok}/${ok + bad}`;
    enqueue(rec.id, () => ({
      run_id: rec.id,
      task_id: rec.taskId,
      platform: rec.platform,
      workflow_type: rec.type,
      task_name: rec.taskName || rec.taskId,
      status,
      summary,
      posted,
      action_counts: totals,
      tokens_used: rec.cost ? Number(rec.cost.credits) || 0 : 0,
      cost_usd: rec.cost ? Number(rec.cost.usd) || 0 : 0,
      started_at: rec.startedAt,
      finished_at: rec.finishedAt,
    }), 0);
  } catch {
    /* 绝不反噬主流程 */
  }
}
