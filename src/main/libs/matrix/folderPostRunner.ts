/**
 * 抖音「文件夹定时发布」运行时(folder_post,2026-10-28)。
 *
 * 调度器每分钟看一次:哪个号的哪个时段到点了(folderPost.dueOccurrences)→ 叫起本任务 → 这里:
 *   每个有活的号:起指纹内核 → 创作者中心登录检查 → 逐个到点时段:按顺序取下一条(素材 + 文案 + 话题)
 *   → 视频走 matrix driver「douyin」、图文走「douyin_images」(收藏前 3 随机 BGM)→ 成功挪进「已发布」并按条计费。
 * 手动点「运行」且当前没有到点的时段 → 每个号从第一个开着、有素材的时段立即发一条(方便试发)。
 *
 * 防重复:每个「号 × 时段 × 日期」发之前先在账本登记;点了发布但没确认到成功的,素材挪进「待确认」
 *   (不留在原处,免得下个时段又把同一条发一遍),并在日志里请用户去抖音核对。
 */

import { coworkLog } from '../coworkLogger';
import { launchKernel, kernelNavigate, closeKernel, checkKernelLogin, kernelEval, NO_KERNEL_ERROR } from './kernelPool';
import { inspectHoldMs } from './inspectHold';
import { installedKernelPath } from './kernelInstaller';
import { getAccount, setAccountStatus, accountBadgeLabel, matrixGroupTitle, markAccountAlive, platformKey } from './accountManager';
import { promptReloginForExpiredAccount } from './reloginPrompt';
import { getNoobClawAuthToken } from '../claudeSettings';
import { runMatrixDriver } from './driverCtx';
import type { EngageItemResult, EngageReport } from './engageRunner';
import type { FolderPostConfig } from './types';
import { ensureAccountDirs, pickNext, archiveUsed, dueOccurrences, ledgerMark, ledgerHas, ledgerPending, ledgerStuck, normSlots, slotStatus, SLOT_DIR, type Occurrence, type MediaItem } from './folderPost';
import fs from 'fs';
import path from 'path';

const DEFAULT_BASE_URL = 'https://api.noobclaw.com';
function baseUrl(): string { return process.env.NOOBCLAW_API_BASE_URL || DEFAULT_BASE_URL; }
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { cleanup(); resolve(); };
    const cleanup = () => { clearTimeout(t); try { signal?.removeEventListener('abort', onAbort); } catch { /* ignore */ } };
    try { signal?.addEventListener('abort', onAbort, { once: true }); } catch { /* ignore */ }
  });
}
function randInt(min: number, max: number): number { const lo = Math.min(min, max), hi = Math.max(min, max); return lo + Math.floor(Math.random() * (hi - lo + 1)); }
const LOGIN_URL = 'https://creator.douyin.com/creator-micro/content/upload';

export interface FolderPostTaskOptions {
  platform: string;                 // 'douyin'
  taskId: string;
  accountIds: string[];
  /** 任务里的全部账号(含因会员号数墙暂停、不在 accountIds 里的):它们到点的时段也要记账,否则调度器会反复叫醒。 */
  allAccountIds?: string[];
  config: FolderPostConfig;
  manual?: boolean;                 // 手动点「运行」:没有到点的时段时,每号立即试发一条
  concurrency?: number;
  kernelPath?: string;
  authToken?: string;
  signal?: AbortSignal;
  onLog?: (accountId: string, msg: string) => void;
  onItem?: (item: EngageItemResult) => void;
  onTargets?: (accountId: string, targets: { post?: number }) => void;
}

async function chargeAction(authToken: string | undefined, actionType: string, platform: string, refId?: string) {
  if (!authToken) return { ok: false, reason: 'auth_missing' };
  try {
    const res = await fetch(`${baseUrl()}/api/charge/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ action_type: actionType, platform, ref_id: refId || null }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: String(data?.error || `http_${res.status}`) };
    return { ok: true, charged: Number(data?.charged) || 0, cost_usd: Number(data?.cost_usd) || 0 };
  } catch { return { ok: false, reason: 'network_error' }; }
}

/** 发之前先看余额:先发后扣,余额为 0 时扣费会失败,但帖子已经发出去了 —— 不先拦就等于免费发。
 *  只在【确知】余额不够时拦;查不到(断网等)放行,发完扣费失败照常熔断。
 *  有效会员(基础版及以上)本功能免费(服务端 folder_post 对会员 0 扣)→ 不看余额。 */
const POST_PRICE_MAX = 2000;
async function balanceTooLow(authToken: string | undefined): Promise<boolean> {
  if (!authToken) return true;
  try {
    const res = await fetch(`${baseUrl()}/api/ai/balance`, { headers: { Authorization: `Bearer ${authToken}` } });
    if (res.status === 401) return true;
    if (!res.ok) return false;
    const d: any = await res.json().catch(() => ({}));
    const member = typeof d?.planCode === 'string' && d.planCode !== 'free' && d?.subStatus === 'active'
      && !!d?.subPeriodEnd && new Date(d.subPeriodEnd).getTime() > Date.now();
    if (member) return false;
    const b = Number(d?.tokenBalance);
    return Number.isFinite(b) && b < POST_PRICE_MAX;
  } catch { return false; }
}

/** 视频 driver(douyin.js,现网脚本不动)点完发布等 4 秒就报成功,不确认结果。这里补一次确认:
 *  跳到「作品管理」(/content/manage)才算发出去;还停在发布页 / 跳去别处 → 当「没确认到」处理。 */
async function confirmVideoPublished(accountId: string, signal?: AbortSignal): Promise<boolean> {
  for (let i = 0; i < 12; i++) {
    let u = '';
    try { u = String(await kernelEval(accountId, 'location.href', 5000) || ''); } catch { /* ignore */ }
    if (u.indexOf('/content/manage') >= 0) return true;
    if (signal?.aborted) return false;
    await sleep(2500);
  }
  return false;
}

interface Work { slot: number; occ?: Occurrence }

async function runOne(opts: FolderPostTaskOptions, accountId: string, work: Work[], chargeFatal: { reason: string }): Promise<EngageItemResult> {
  const acc = getAccount(accountId);
  const log = (m: string) => { try { opts.onLog?.(accountId, m); } catch { /* ignore */ } };
  const counts = { like: 0, follow: 0, comment: 0, post: 0 };
  let chargedCredits = 0, chargedUsd = 0;
  const emit = (state: EngageItemResult['state'] = 'success', reason?: string) => { try { opts.onItem?.({ accountId, state, counts: { ...counts }, chargedCredits, chargedUsd, reason }); } catch { /* ignore */ } };
  if (!acc) { log('❌ 跳过:账号不存在'); return { accountId, state: 'skipped', reason: 'account_not_found' }; }
  if (acc.platform !== opts.platform) { log('❌ 跳过:账号平台与任务不符'); return { accountId, state: 'skipped', reason: 'platform_mismatch' }; }
  if (acc.status === 'banned' || acc.status === 'limited') { log('❌ 跳过:账号状态为 ' + acc.status); return { accountId, state: 'skipped', reason: 'account_' + acc.status }; }
  const accDir = ensureAccountDirs(acc);

  // ① 上次崩溃恢复:还停在「发布中」的 → 可能已经发出去了,把那次用的文件挪进「待确认」(绝不再发一遍)。
  for (const e of ledgerPending(opts.taskId, accountId)) {
    const media: MediaItem | null = e.media ? { kind: 'images', name: e.mediaName || path.basename(e.media), path: e.media, files: e.mediaFiles || [] } : null;
    const res = media && fs.existsSync(media.path) ? archiveUsed(accDir, e.slot || 1, { media, captionPath: e.caption, topicPath: e.topic }, 'unsure') : { dest: '', ok: true };
    log(res.dest ? `⚠️ 上次 ${SLOT_DIR(e.slot || 1)} 点了发布后程序被关了,不知道发没发成功 —— 那条挪到 ${res.dest},请到抖音「作品管理」核对` : `⚠️ 上次 ${SLOT_DIR(e.slot || 1)} 点了发布后程序被关了,请到抖音「作品管理」核对是否发出`);
    ledgerMark(opts.taskId, e.key, { ts: Date.now(), ok: false, note: 'crash_unsure', stuck: !res.ok, stuckTo: 'unsure' });
  }
  // ② 发出去了但素材没挪走的:先挪,挪不走这个号这次一条都不发(否则会重复发)。
  for (const e of ledgerStuck(opts.taskId, accountId)) {
    if (!e.media || !fs.existsSync(e.media)) { ledgerMark(opts.taskId, e.key, { ts: e.ts, ok: e.ok, stuck: false }); continue; }
    const media: MediaItem = { kind: 'images', name: e.mediaName || path.basename(e.media), path: e.media, files: e.mediaFiles || [] };
    const res = archiveUsed(accDir, e.slot || 1, { media }, e.stuckTo || 'done');
    if (res.ok) { ledgerMark(opts.taskId, e.key, { ts: e.ts, ok: e.ok, stuck: false }); log(`📦 上次没挪走的「${media.name}」已挪到 ${res.dest}`); continue; }
    log(`⛔ 「${e.media}」已经发过,但文件挪不走(可能被别的程序占用 / 只读)。为免重复发,这个号先不发 —— 请手动把它移出「素材」文件夹`);
    for (const w of work) if (w.occ && !ledgerHas(opts.taskId, w.occ.key)) ledgerMark(opts.taskId, w.occ.key, { ts: Date.now(), ok: false, note: 'blocked_stuck' });
    return { accountId, state: 'failed', reason: 'archive_stuck' };
  }

  // 没素材的时段先在这里说清楚、登记掉,不为它们启动浏览器。
  const ready: Work[] = [];
  for (const w of work) {
    if (pickNext(accDir, w.slot)) { ready.push(w); continue; }
    log(`📭 ${SLOT_DIR(w.slot)} 的素材用完了(或还没放),这次不发 —— 文件夹:${path.join(accDir, SLOT_DIR(w.slot), '素材')}`);
    if (w.occ) ledgerMark(opts.taskId, w.occ.key, { ts: Date.now(), ok: false, note: 'empty' });
  }
  if (!ready.length) return { accountId, state: 'skipped', reason: 'no_material' };
  try { opts.onTargets?.(accountId, { post: ready.length }); } catch { /* ignore */ }

  const authToken = opts.authToken || getNoobClawAuthToken() || undefined;
  let kernelLaunched = false, lastReason = '';
  try {
    setAccountStatus(accountId, 'running');
    log('启动指纹内核');
    await launchKernel({
      accountId, kernelPath: opts.kernelPath, kernelVersion: acc.kernelVersion,
      userDataDir: acc.userDataDir, fingerprint: acc.fingerprint, proxy: acc.proxy,
      label: accountBadgeLabel(acc), groupTitle: matrixGroupTitle(opts.platform, opts.taskId),
    });
    kernelLaunched = true;
    await kernelNavigate(accountId, LOGIN_URL);
    await sleep(2500);
    let loggedIn = true;
    try { loggedIn = await checkKernelLogin(accountId, platformKey(acc)); } catch { loggedIn = true; }
    if (!loggedIn) {
      setAccountStatus(accountId, 'login_required');
      log('⚠️ 抖音创作者中心登录失效,弹窗扫码重连(这次的时段先不发,素材留着)');
      for (const w of ready) if (w.occ) ledgerMark(opts.taskId, w.occ.key, { ts: Date.now(), ok: false, note: 'login_required' });
      if (!opts.signal?.aborted) { try { await promptReloginForExpiredAccount(accountId); } catch { /* ignore */ } }
      return { accountId, state: 'skipped', reason: 'login_expired' };
    }
    markAccountAlive(accountId);

    for (let i = 0; i < ready.length; i++) {
      if (opts.signal?.aborted || chargeFatal.reason) break;
      const w = ready[i];
      const pick = pickNext(accDir, w.slot);
      if (!pick) continue;
      // 余额确知不够 → 不发(先发后扣,不拦就成了免费发)
      if (await balanceTooLow(authToken)) {
        chargeFatal.reason = chargeFatal.reason || 'insufficient_balance';
        log('⛔ 积分余额不足,这次先不发(素材留着),请充值后继续');
        if (w.occ) ledgerMark(opts.taskId, w.occ.key, { ts: Date.now(), ok: false, note: 'insufficient_balance' });
        break;
      }
      // 先登记再发(连同这次用的文件):万一中途崩了 / 被关,重启后不会把这个时段再发一遍,
      //   用过的文件也会被挪进「待确认」。账本写不进去 → 不发(否则每分钟都会被叫起来再发一条)。
      // 手动试发没有时段 occurrence → 用一次性的 key 记,同样受崩溃恢复保护。
      const ledgerKey = w.occ ? w.occ.key : `${accountId}|${w.slot}|manual-${Date.now()}`;
      try {
        ledgerMark(opts.taskId, ledgerKey, { ts: Date.now(), ok: null, note: 'publishing', slot: w.slot, media: pick.media.path, mediaName: pick.media.name, mediaFiles: pick.media.files, caption: pick.captionPath, topic: pick.topicPath }, true);
      } catch {
        log('⛔ 发布记录写不进本机(磁盘满 / 没权限?),为免重复发,这个号先不发');
        lastReason = 'ledger_write_failed';
        break;
      }
      const isVideo = pick.media.kind === 'video';
      log(`📤 ${SLOT_DIR(w.slot)}:${isVideo ? '视频' : `图文(${pick.media.files.length} 张)`}「${pick.media.name}」`
        + (pick.title ? ` · 标题「${pick.title.slice(0, 20)}」` : ' · ⚠️ 没有文案')
        + (pick.tags.length ? ` · ${pick.tags.length} 个话题` : ''));
      if (!isVideo && pick.title.length > 20) log('   ℹ️ 图文标题最多 20 字,超出部分放不进标题');
      if (isVideo && pick.title.length > 30) log('   ℹ️ 视频标题最多 30 字,超出部分放不进标题');
      const input: any = isVideo
        ? { videoPath: pick.media.files[0], title: pick.title, description: pick.body, tags: pick.tags }
        : { videoPath: '', imagePaths: pick.media.files, title: pick.title, description: pick.body, tags: pick.tags, bgm: true };
      let r = await runMatrixDriver(accountId, (isVideo ? 'douyin' : 'douyin_images') as any, input, (m) => log('   ' + m));
      if (r.ok && isVideo && !(await confirmVideoPublished(accountId, opts.signal))) r = { ok: false, reason: 'publish_not_confirmed' };
      if (r.ok) {
        const ar = archiveUsed(accDir, w.slot, pick, 'done');
        counts.post++;
        ledgerMark(opts.taskId, ledgerKey, { ts: Date.now(), ok: true, note: undefined, stuck: !ar.ok, stuckTo: 'done' });
        log(ar.ok ? `✅ 已发布,文件挪到 ${ar.dest}` : `✅ 已发布,但素材「${pick.media.name}」挪不走(被占用 / 只读?)—— 这个号先停发,请手动把它移出「素材」文件夹`);
        // 按条计费(失败退避重试;仍失败 → 熔断整个任务,和其它矩阵任务一致)
        const refId = `folder_post:${opts.taskId}:${ledgerKey}`;
        let cr: any = await chargeAction(authToken, 'folder_post', 'douyin', refId);
        for (let ci = 1; ci < 4 && !(cr && cr.ok) && !/insufficient|余额/i.test(String(cr?.reason || '')); ci++) { await sleep(3000 * ci); cr = await chargeAction(authToken, 'folder_post', 'douyin', refId); }
        if (cr && cr.ok) { chargedCredits += cr.charged || 0; chargedUsd += cr.cost_usd || 0; }
        else {
          if (!chargeFatal.reason) chargeFatal.reason = String(cr?.reason || 'unknown');
          log(/insufficient|余额/i.test(String(cr?.reason || '')) ? '⛔ 积分余额不足,后面的先不发了,请充值后继续' : '⛔ 计费失败,后面的先不发了,请稍后重试');
        }
        emit('success');
        if (!ar.ok) break;
      } else {
        lastReason = r.reason || 'unknown';
        // 只有「点了发布但没确认到」才可能已经发出去 → 挪进待确认;
        //   publish_rejected(抖音提示不能为空/请填写/频繁,还停在编辑页)等 = 明确没发 → 素材留着下次再发。
        const unsure = /not_confirmed/.test(lastReason);
        let stuck = false;
        if (unsure) {
          const ar = archiveUsed(accDir, w.slot, pick, 'unsure');
          stuck = !ar.ok;
          log(ar.ok ? `⚠️ 点了发布,但没确认到发成功(${lastReason})—— 为免重复发,这条挪到 ${ar.dest},请到抖音「作品管理」核对`
            : `⚠️ 点了发布,但没确认到发成功,且素材「${pick.media.name}」挪不走 —— 这个号先停发,请到抖音核对并手动移走这条`);
        } else {
          log(`❌ 这条没发出去(${lastReason}),素材留在原处,下个时段再试`);
        }
        ledgerMark(opts.taskId, ledgerKey, { ts: Date.now(), ok: false, note: lastReason.slice(0, 80), stuck, stuckTo: 'unsure' });
        emit('failed', lastReason);
        if (stuck) break;
      }
      if (i < ready.length - 1) await abortableSleep(randInt(60_000, 120_000), opts.signal);   // 同号连发两条,隔 1-2 分钟
    }
    setAccountStatus(accountId, 'idle');
    if (chargeFatal.reason) return { accountId, state: 'failed', counts, chargedCredits, chargedUsd, reason: 'charge_failed:' + chargeFatal.reason };
    if (counts.post === 0) return { accountId, state: 'failed', counts, chargedCredits, chargedUsd, reason: lastReason || 'not_posted' };
    return { accountId, state: 'success', counts, chargedCredits, chargedUsd };
  } catch (e: any) {
    setAccountStatus(accountId, 'idle');
    const msg = String(e?.message || e);
    coworkLog('ERROR', 'folderPost', `[${accountId}] threw: ${String(e?.stack || msg).slice(0, 300)}`);
    log('🛑 运行出错,该号跳过(其它号照跑):' + (msg.indexOf(NO_KERNEL_ERROR) >= 0 ? '指纹内核未就绪/未下载 — 请在「我的矩阵账号」下载内核' : msg.slice(0, 160)));
    return { accountId, state: 'failed', counts, chargedCredits, chargedUsd, reason: 'folder_post_threw:' + msg.slice(0, 140) };
  } finally {
    if (kernelLaunched) {
      const holdMs = inspectHoldMs(lastReason);
      if (!opts.signal?.aborted) await abortableSleep(holdMs, opts.signal);
      try { closeKernel(accountId); } catch { /* ignore */ }
    }
  }
}

/** 这次每个号要发哪些时段:到点的;手动且没有到点的 → 每号第一个开着、有素材的时段。 */
export function planFolderPostWork(opts: Pick<FolderPostTaskOptions, 'taskId' | 'accountIds' | 'config' | 'manual'>, now = Date.now()): Record<string, Work[]> {
  const due = dueOccurrences(opts.taskId, opts.accountIds, opts.config, now);
  const plan: Record<string, Work[]> = {};
  for (const o of due) (plan[o.accountId] = plan[o.accountId] || []).push({ slot: o.slot, occ: o });
  if (!due.length && opts.manual) {
    for (const id of opts.accountIds) {
      const acc = getAccount(id);
      if (!acc) continue;
      const dir = ensureAccountDirs(acc);
      const slots = normSlots(opts.config?.slotsByAccount?.[id]);
      let n = slots.findIndex((s, i) => s.on && slotStatus(dir, i + 1).media > 0) + 1;
      if (!n) n = slots.findIndex((_s, i) => slotStatus(dir, i + 1).media > 0) + 1;
      plan[id] = [{ slot: n || 1 }];
    }
  }
  return plan;
}

/** 这次叫起来时到点的时段,不管中途因为什么没走到登记那步(号被封 / 内核没装 / 抛错 / 计费熔断 / 被停),
 *  都要在账本里记一笔「没发」—— 否则 folderPostNextRunAt 会一直返回「现在」,调度器每分钟把任务叫起来一次,
 *  连续空跑 3 小时。素材不动,下个时段照常用。 */
function markLeftovers(taskId: string, plan: Record<string, Work[]>, note: string): void {
  for (const id of Object.keys(plan)) for (const w of plan[id] || []) {
    if (w.occ && !ledgerHas(taskId, w.occ.key)) { try { ledgerMark(taskId, w.occ.key, { ts: Date.now(), ok: false, note }); } catch { /* ignore */ } }
  }
}

export async function runFolderPostTask(opts: FolderPostTaskOptions): Promise<EngageReport> {
  const plan = planFolderPostWork(opts);
  const runSet = new Set(opts.accountIds);
  const others = (opts.allAccountIds || []).filter((id) => !runSet.has(id));
  const otherDue = others.length ? dueOccurrences(opts.taskId, others, opts.config, Date.now()) : [];
  try {
    return await runPlanned(opts, plan);
  } finally {
    markLeftovers(opts.taskId, plan, opts.signal?.aborted ? 'stopped' : 'skipped');
    for (const o of otherDue) if (!ledgerHas(opts.taskId, o.key)) ledgerMark(opts.taskId, o.key, { ts: Date.now(), ok: false, note: 'suspended' });
  }
}

async function runPlanned(opts: FolderPostTaskOptions, plan: Record<string, Work[]>): Promise<EngageReport> {
  if (!opts.kernelPath && !installedKernelPath()) throw new Error(`${NO_KERNEL_ERROR}: 指纹浏览器内核未安装,请先到「我的矩阵账号」下载内核`);
  const ids = opts.accountIds.filter((id) => (plan[id] || []).length > 0);
  for (const id of opts.accountIds) {
    if (!ids.includes(id)) { try { opts.onLog?.(id, '⏭️ 这个号现在没有到点的时段'); } catch { /* ignore */ } }
  }
  coworkLog('INFO', 'folderPostRunner', `folder_post ${opts.taskId} x${ids.length} (manual=${!!opts.manual})`);
  const chargeFatal = { reason: '' };
  const k = Math.max(1, Math.min(opts.concurrency ?? ids.length, 10));
  const results: EngageItemResult[] = [];
  let cursor = 0;
  const lane = async () => {
    while (true) {
      const i = cursor++;
      if (i >= ids.length) return;
      if (i > 0) await abortableSleep(randInt(3000, 15000), opts.signal);   // 错峰起浏览器
      if (opts.signal?.aborted) return;   // 已点停止:后面的号别再起浏览器
      const r = await runOne(opts, ids[i], plan[ids[i]], chargeFatal);
      results.push(r);
      try { opts.onItem?.(r); } catch { /* ignore */ }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(k, ids.length)) }, () => lane()));
  for (const id of opts.accountIds) if (!ids.includes(id)) results.push({ accountId: id, state: 'skipped', reason: 'not_due' });
  return {
    platform: opts.platform, total: results.length,
    success: results.filter((x) => x.state === 'success').length,
    failed: results.filter((x) => x.state === 'failed').length,
    skipped: results.filter((x) => x.state === 'skipped').length,
    items: results,
  };
}
