/**
 * runMatrixPublish —— 矩阵号 edition 的 publish step。
 *
 * 与旧 runPublish 的关系:
 *   · 旧 runPublish 走【浏览器扩展】(browserBridge.sendBrowserCommand),9 平台共用一个发布窗口 tab。
 *   · 本文件走【指纹浏览器内核 CDP】:每个平台用用户在向导里选定的那个矩阵账号
 *     (publishAccounts[platform] → accountId),起该号的 fingerprint-chromium、用其持久登录态上传。
 *
 * 复用现成基建:
 *   · launchKernel(accountManager 里的指纹/代理/profile)起内核;
 *   · runMatrixDriver(accountId, platform, input, onLog) 跑发布 driver(读 /api/matrix/drivers,
 *     与旧 driver 同一份 fork,零改动跑在 CDP 上,见 driverCtx.ts)。
 *
 * 用户硬约束(沿用旧 runPublish 契约):
 *   · 某平台没选号 / 该号未登录 → 跳过,日志记原因,继续下一个;
 *   · 某平台上传失败 → 跳过,继续下一个;
 *   · 全部跳过/失败 → 任务仍 done(本地 mp4 还在),绝不抛。
 *
 * 账号是平台维度的(MatrixAccount.platform),所以每个平台对应各自独立的一个号、各自独立内核。
 */

import type { VideoPlatform, PublishInput } from './types';
import { VIDEO_PLATFORMS } from './types';
import type { RunPublishResult } from './runPublish';
import { getAccount, platformKey } from '../../matrix/accountManager';
import { launchKernel, kernelNavigate, checkKernelLogin, closeKernel } from '../../matrix/kernelPool';
import { runMatrixDriver } from '../../matrix/driverCtx';
import { PUBLISHER_ANCHOR_URL } from './publisherUtils';
import { getVideoConfig } from '../videoConfig';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let POST_SUBMIT_WAIT_MS = 120_000;

export interface RunMatrixPublishOptions {
  /** 用户勾选的发布平台 id 列表(来自 input.publishPlatforms)。 */
  platforms: string[];
  /** 平台 → 选定矩阵账号 id(来自 input.publishAccounts)。 */
  accounts: Record<string, string>;
  /** 视频 mp4 本地路径。 */
  videoPath: string;
  title?: string;
  description?: string;
  tags?: string[];
  onLog?: (msg: string) => void;
  signal?: AbortSignal;
  /** 起内核可选:手动内核路径(没传则按账号绑定版本/任意已装内核启动)。 */
  kernelPath?: string;
}

function platformLabel(id: string): string {
  const m = VIDEO_PLATFORMS.find((p) => p.id === id);
  return m ? `${m.emoji} ${m.zh}` : id;
}

/**
 * 矩阵 publish step:iterate 勾选平台 → 各用其选定账号起指纹内核、检登录、跑发布 driver。
 * 单平台任何异常都吞掉、记日志、继续下一个。绝不抛。
 */
export async function runMatrixPublishStep(opts: RunMatrixPublishOptions): Promise<RunPublishResult> {
  const list = Array.isArray(opts.platforms) ? opts.platforms.filter(Boolean) : [];
  const result: RunPublishResult = { publishedCount: 0, skippedCount: 0, failedCount: 0, details: [] };

  if (list.length === 0) {
    opts.onLog?.('📂 未选发布平台 · 仅存本地');
    return result;
  }

  // 提交后等待时长走服务端配置(后端可调、不打包)。拉不到用默认。
  try {
    const vc = await getVideoConfig();
    if (vc.postSubmitWaitMs > 0) POST_SUBMIT_WAIT_MS = vc.postSubmitWaitMs;
  } catch { /* 用默认 */ }

  opts.onLog?.(`🚀 准备用指纹浏览器发布到 ${list.length} 个平台:${list.map(platformLabel).join(' / ')}`);

  for (const id of list) {
    if (opts.signal?.aborted) { opts.onLog?.('⏹ 已停止 · 后续平台跳过'); break; }
    const label = platformLabel(id);
    const accountId = opts.accounts?.[id];

    // ① 没选号 → 跳过(向导本应拦住,这里兜底)。
    if (!accountId) {
      opts.onLog?.(`⚠️ ${label} 未选账号 · 跳过`);
      result.skippedCount++;
      result.details.push({ platform: id, status: 'skipped', reason: 'no_account' });
      continue;
    }
    const acc = getAccount(accountId);
    if (!acc) {
      opts.onLog?.(`⚠️ ${label} 账号不存在(已删?)· 跳过`);
      result.skippedCount++;
      result.details.push({ platform: id, status: 'skipped', reason: 'account_not_found' });
      continue;
    }
    if (acc.platform !== id) {
      opts.onLog?.(`⚠️ ${label} 选定账号平台不符 · 跳过`);
      result.skippedCount++;
      result.details.push({ platform: id, status: 'skipped', reason: 'platform_mismatch' });
      continue;
    }
    if (acc.status === 'banned' || acc.status === 'limited') {
      opts.onLog?.(`⚠️ ${label} 账号「${acc.displayName}」${acc.status} · 跳过`);
      result.skippedCount++;
      result.details.push({ platform: id, status: 'skipped', reason: 'account_' + acc.status });
      continue;
    }

    // ② 起该号的指纹内核(持久 profile + 固定指纹 + 固定代理)。
    opts.onLog?.(`🧬 ${label} · 启动账号「${acc.displayName}」的指纹浏览器…`);
    try {
      await launchKernel({
        accountId, kernelPath: opts.kernelPath, kernelVersion: acc.kernelVersion,
        userDataDir: acc.userDataDir, fingerprint: acc.fingerprint, proxy: acc.proxy,
      });
    } catch (e: any) {
      opts.onLog?.(`⚠️ ${label} 内核启动失败:${String(e?.message || e).slice(0, 100)} · 跳过`);
      result.skippedCount++;
      result.details.push({ platform: id, status: 'skipped', reason: 'kernel_launch_failed' });
      continue;
    }

    try {
      // ③ 导航到该平台创作中心/上传页,检登录态(该号持久 profile 的 cookie)。
      const anchor = PUBLISHER_ANCHOR_URL[id as VideoPlatform];
      if (anchor) { try { await kernelNavigate(accountId, anchor); await sleep(2500); } catch { /* driver 内部还会等 */ } }
      // 快手创作端账号用 'kuaishou_creator' 查 cp 登录态(主站 cookie 不算 cp 登录)。
      const loggedIn = await checkKernelLogin(accountId, acc ? platformKey(acc) : id).catch(() => false);
      if (!loggedIn) {
        // 矩阵号登录态在「我的矩阵账号」里扫码维护;这里不在出片流程里硬等登录(会卡死定时任务)。
        opts.onLog?.(`⚠️ ${label} 账号「${acc.displayName}」未登录 · 跳过本条(请到「我的矩阵账号」重新登录)`);
        result.skippedCount++;
        result.details.push({ platform: id, status: 'skipped', reason: 'not_logged_in' });
        continue;
      }

      // ④ 跑发布 driver(走该号的 CDP)。
      opts.onLog?.(`📤 ${label} · 账号「${acc.displayName}」开始上传…`);
      const input: PublishInput = {
        videoPath: opts.videoPath, title: opts.title, description: opts.description, tags: opts.tags,
      };
      const pr = await runMatrixDriver(accountId, id as VideoPlatform, input, (m) => opts.onLog?.(`   ${m}`));
      if (pr.ok) {
        opts.onLog?.(`✅ ${label} 提交完成`);
        result.publishedCount++;
        result.details.push({ platform: id, status: 'published' });
        // 提交后等平台把视频传完再关内核(过早关内核会把正在上传的作品弄丢)。
        // 例外:小红书/币安/推特点发布前视频已传完 → 封顶 20s。
        const postWaitMs = (id === 'xhs' || id === 'binance' || id === 'x') ? Math.min(20_000, POST_SUBMIT_WAIT_MS) : POST_SUBMIT_WAIT_MS;
        opts.onLog?.(`   ⏳ 等 ${Math.round(postWaitMs / 1000)}s 让平台把视频上传完…`);
        await sleep(postWaitMs);
      } else {
        opts.onLog?.(`❌ ${label} 发布失败:${pr.reason || 'unknown'}`);
        result.failedCount++;
        result.details.push({ platform: id, status: 'failed', reason: pr.reason });
      }
    } catch (e: any) {
      opts.onLog?.(`❌ ${label} 发布异常:${String(e?.message || e).slice(0, 100)}`);
      result.failedCount++;
      result.details.push({ platform: id, status: 'failed', reason: 'driver_threw' });
    } finally {
      // 关掉该号内核,释放资源(账号是平台维度,下个平台是另一个号、另一个内核)。
      try { closeKernel(accountId); } catch { /* ignore */ }
    }
  }

  // 汇总日志(沿用旧 runPublish 的口径)。
  const reasonZh = (r?: string): string => {
    if (!r) return '';
    if (r.startsWith('no_account')) return '未选账号';
    if (r.startsWith('account_not_found')) return '账号不存在';
    if (r.startsWith('platform_mismatch')) return '账号平台不符';
    if (r.startsWith('account_banned')) return '账号已封';
    if (r.startsWith('account_limited')) return '账号限流';
    if (r.startsWith('kernel_launch_failed')) return '内核启动失败';
    if (r.startsWith('not_logged_in')) return '未登录';
    if (r.startsWith('no_matrix_driver')) return '无发布脚本';
    if (r.startsWith('matrix_compile_failed')) return '脚本编译失败';
    if (r.startsWith('driver_threw') || r.startsWith('matrix_driver_threw')) return 'driver 异常';
    return r.slice(0, 40);
  };
  const named = (l: typeof result.details, withReason: boolean) =>
    l.map((d) => platformLabel(d.platform) + (withReason && d.reason ? `(${reasonZh(d.reason)})` : '')).join('、');
  const pub = result.details.filter((d) => d.status === 'published');
  const skip = result.details.filter((d) => d.status === 'skipped');
  const fail = result.details.filter((d) => d.status === 'failed');
  opts.onLog?.('📊 发布汇总:');
  if (pub.length) opts.onLog?.(`   ✅ 已发(${pub.length}):${named(pub, false)}`);
  if (skip.length) opts.onLog?.(`   ⏭️ 跳过(${skip.length}):${named(skip, true)}`);
  if (fail.length) opts.onLog?.(`   ❌ 失败(${fail.length}):${named(fail, true)}`);
  if (!pub.length && !skip.length && !fail.length) opts.onLog?.('   (无平台结果)');

  return result;
}
