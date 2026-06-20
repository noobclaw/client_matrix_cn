/**
 * 矩阵任务编排(管理层②)—— 一次锁 1 个平台,把一条内容铺到 N 个账号。
 *
 * 约束(用户拍板):一次只一个平台、多号多窗、不跨平台并发。
 * 流程:限并发 K 错峰起窗 → 每号:起指纹内核 → 发前登录检查 → 跑 driver → 关窗回收
 *      → 全部完成后按【成功号数】调 /api/matrix/charge 计费 → 出报告。
 *
 * 内容差异化:getInput(accountId, index) 可为每号返回不同的成片(封面/字幕/音色/
 * 切片各异),实现"每号发不一样的"防判重;返回同一份即"同条铺号"。
 */

import { coworkLog } from '../coworkLogger';
import type { VideoPlatform, PublishInput } from '../video/publishers/types';
import { launchKernel, kernelNavigate, kernelEval, closeKernel } from './kernelPool';
import { runMatrixDriver } from './driverCtx';
import {
  getAccount, setAccountStatus, markPosted,
} from './accountManager';

const DEFAULT_BASE_URL = 'https://api.noobclaw.com';
function baseUrl(): string { return process.env.NOOBCLAW_API_BASE_URL || DEFAULT_BASE_URL; }
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
function randInt(min: number, max: number): number { return min + Math.floor(Math.random() * (max - min + 1)); }

export interface MatrixTaskOptions {
  platform: VideoPlatform;
  accountIds: string[];
  /** 每号的发布内容(支持差异化);返回同一份即同条铺号。 */
  getInput: (accountId: string, index: number) => PublishInput | Promise<PublishInput>;
  concurrency?: number;        // 同时开几窗,默认 3
  jitterMinMs?: number;        // 每号启动前错峰下限,默认 3s
  jitterMaxMs?: number;        // 上限,默认 15s
  kernelPath?: string;         // fingerprint-chromium 路径(缺省回落系统 Chrome)
  headless?: boolean;
  authToken?: string;          // 计费 Bearer token;缺省则跳过计费(只发不收)
  onLog?: (accountId: string, msg: string) => void;
  onItem?: (item: MatrixTaskItemResult) => void;  // 每号完成回调(刷新 UI)
}

export type MatrixItemState = 'success' | 'failed' | 'skipped';

export interface MatrixTaskItemResult {
  accountId: string;
  state: MatrixItemState;
  reason?: string;
  publishedUrl?: string;
}

export interface MatrixTaskReport {
  platform: VideoPlatform;
  total: number;
  success: number;
  failed: number;
  skipped: number;
  items: MatrixTaskItemResult[];
  charged?: { charged: number; balanceAfter?: number };
}

const LOGIN_URL_HINT = /(login|passport|signin|sign-in|account\/security)/i;

/** 发前登录检查:起内核 → 导航创作者中心 → 看是否被重定向到登录页。 */
async function checkLogin(accountId: string, anchor: string): Promise<boolean> {
  try {
    await kernelNavigate(accountId, anchor);
    await sleep(2000);
    const href = String(await kernelEval(accountId, 'location.href') || '');
    return !LOGIN_URL_HINT.test(href);
  } catch {
    return false;
  }
}

async function runOne(
  opts: MatrixTaskOptions,
  accountId: string,
  index: number,
): Promise<MatrixTaskItemResult> {
  const log = (m: string) => { try { opts.onLog?.(accountId, m); } catch { /* ignore */ } };
  const acc = getAccount(accountId);
  if (!acc) return { accountId, state: 'skipped', reason: 'account_not_found' };
  if (acc.platform !== opts.platform) return { accountId, state: 'skipped', reason: 'platform_mismatch' };
  if (acc.status === 'banned' || acc.status === 'limited') {
    return { accountId, state: 'skipped', reason: 'account_' + acc.status };
  }

  // 错峰:每号启动前随机停一下,避免齐刷刷一起开窗(行为关联信号)。
  await sleep(randInt(opts.jitterMinMs ?? 3000, opts.jitterMaxMs ?? 15000));

  try {
    setAccountStatus(accountId, 'running');
    log('启动指纹内核');
    await launchKernel({
      accountId,
      kernelPath: opts.kernelPath,
      kernelVersion: acc.kernelVersion,
      userDataDir: acc.userDataDir,
      fingerprint: acc.fingerprint,
      proxy: acc.proxy,
      headless: opts.headless,
    });

    // 发前登录检查(用 PUBLISHER_ANCHOR_URL,driver 内部也会再导航一次)。
    const anchorMod = await import('../video/publishers/publisherUtils');
    const anchor = anchorMod.PUBLISHER_ANCHOR_URL[opts.platform];
    if (anchor) {
      const ok = await checkLogin(accountId, anchor);
      if (!ok) {
        setAccountStatus(accountId, 'login_required');
        return { accountId, state: 'skipped', reason: 'login_required' };
      }
    }

    const input = await opts.getInput(accountId, index);
    // 无内容(差异化产片失败 / inputs 映射缺该号)→ 跳过,不计失败、不计费。
    if (!input || !input.videoPath) {
      setAccountStatus(accountId, 'idle');
      return { accountId, state: 'skipped', reason: 'no_content' };
    }
    const r = await runMatrixDriver(accountId, opts.platform, input, log);

    if (r.ok) {
      markPosted(accountId);
      setAccountStatus(accountId, 'idle');
      return { accountId, state: 'success', publishedUrl: r.publishedUrl };
    }
    // 限流类失败可在此识别 reason 关键字升级为 limited(MVP 先一律 idle)。
    setAccountStatus(accountId, 'idle');
    return { accountId, state: 'failed', reason: r.reason };
  } catch (e: any) {
    setAccountStatus(accountId, 'idle');
    return { accountId, state: 'failed', reason: 'runner_threw:' + String(e?.message || e).slice(0, 120) };
  } finally {
    try { closeKernel(accountId); } catch { /* ignore */ }
  }
}

/** 限并发执行池(barrier:等全部完成)。 */
async function runPool(
  ids: string[],
  k: number,
  worker: (id: string, i: number) => Promise<MatrixTaskItemResult>,
  onItem?: (item: MatrixTaskItemResult) => void,
): Promise<MatrixTaskItemResult[]> {
  const results: MatrixTaskItemResult[] = new Array(ids.length);
  let cursor = 0;
  async function lane() {
    while (true) {
      const i = cursor++;
      if (i >= ids.length) return;
      const res = await worker(ids[i], i);
      results[i] = res;
      try { onItem?.(res); } catch { /* ignore */ }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(k, ids.length)) }, () => lane()));
  return results;
}

/** 成功号数 → /api/matrix/charge(写公用钱包账本)。失败不阻塞主流程。 */
async function chargeSuccess(
  platform: VideoPlatform, count: number, authToken?: string,
): Promise<{ charged: number; balanceAfter?: number } | undefined> {
  if (count <= 0 || !authToken) return undefined;
  try {
    const res = await fetch(`${baseUrl()}/api/matrix/charge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ platform, count }),
    });
    const j: any = await res.json();
    if (res.ok && j?.ok) return { charged: j.charged, balanceAfter: j.balance_after };
    coworkLog('WARN', 'matrixTask', 'charge non-ok', { status: res.status, body: j });
  } catch (e) {
    coworkLog('WARN', 'matrixTask', 'charge failed', { err: String(e) });
  }
  return undefined;
}

export async function runMatrixTask(opts: MatrixTaskOptions): Promise<MatrixTaskReport> {
  const k = Math.max(1, Math.min(opts.concurrency ?? 3, 10)); // 夹紧上限,防一次开几十个内核打爆内存
  coworkLog('INFO', 'matrixTask', `start ${opts.platform} x${opts.accountIds.length} (concurrency ${k})`);

  const items = await runPool(opts.accountIds, k, (id, i) => runOne(opts, id, i), opts.onItem);

  const success = items.filter((x) => x.state === 'success').length;
  const failed = items.filter((x) => x.state === 'failed').length;
  const skipped = items.filter((x) => x.state === 'skipped').length;

  const charged = await chargeSuccess(opts.platform, success, opts.authToken);

  return { platform: opts.platform, total: items.length, success, failed, skipped, items, charged };
}
