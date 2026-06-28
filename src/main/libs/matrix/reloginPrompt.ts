/**
 * 矩阵号「登录态过期 → 自动弹窗扫码重连」。
 *
 * 发布/任务流程检到某号登录失效时调用 promptReloginForExpiredAccount:
 *   ① 把该号的指纹窗口(一号一窗)提到前台;
 *   ② 导航到该平台登录页 + 注入【红色过期角标】(不横幅,左上角小标,见 kernelShowExpiredBadge);
 *   ③ 后台轮询(~10min)扫码成功 → 翻 idle + 读身份 + 推 SSE 更新「我的矩阵账号」。
 *
 * 复用 sidecar openLogin 的恢复逻辑(同一套 launchKernel/checkKernelLogin/kernelReadIdentity)。
 * 设计要点:
 *   · 自带 launchKernel(skipLease:true)→ refCount+1,确保调用方随后 closeKernel 时窗口【不被关】(留给用户扫码),
 *     且不占「按账号使用互斥锁」(不阻塞别的任务排队)。
 *   · setup 部分(置顶 + 导航 + 角标)await 完才返回,保证在调用方 closeKernel 之前已 refCount+1;轮询循环 detached 跑,
 *     不阻塞调用方(发布该跳过就跳过、继续下一个号)。
 *   · 同号已有看护在跑则直接返回(watching 去重)。
 */

import {
  getAccount, setAccountStatus, setAccountIdentity, accountBadgeLabel, matrixGroupTitle, platformKey, findAccountByUid,
} from './accountManager';
import {
  launchKernel, kernelNavigate, kernelBringToFront, kernelShowExpiredBadge,
  checkKernelLogin, kernelReadIdentity, kernelClearCookies, getSession,
} from './kernelPool';

// 登录/读身份导航 URL(与 renderer MatrixView.LOGIN_URL 一致;快手按场景分流创作端/主站)。
const LOGIN_URL: Record<string, string> = {
  douyin: 'https://www.douyin.com/', xhs: 'https://www.xiaohongshu.com/', bilibili: 'https://passport.bilibili.com/login',
  kuaishou: 'https://www.kuaishou.com/', tiktok: 'https://www.tiktok.com/login', x: 'https://x.com/login',
  binance: 'https://www.binance.com/zh-CN/square', youtube: 'https://www.youtube.com/',
  shipinhao: 'https://channels.weixin.qq.com/', toutiao: 'https://mp.toutiao.com/',
};
export function loginUrlFor(platform: string, loginScope?: string): string {
  if (platform === 'kuaishou') return loginScope === 'creator' ? 'https://cp.kuaishou.com/profile' : 'https://www.kuaishou.com/';
  return LOGIN_URL[platform] || '';
}

// 动态 require 避免与 sidecar-server 静态循环依赖;SSE 不可用时不致命(状态已落盘,列表下次 reload 也会对)。
function emitAccount(data: Record<string, unknown>): void {
  try { const { broadcastSSE } = require('../../sidecar-server'); broadcastSSE('matrix:account', data); } catch { /* ignore */ }
}

const watching = new Set<string>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 对一个登录态过期的号:弹窗置顶 + 红色角标 + 导航登录页,后台等扫码成功并翻状态。
 * fire-and-forget:调用方不必 await(await 也只等到 setup 完、不等轮询)。重复调用同号会被去重忽略。
 */
export async function promptReloginForExpiredAccount(accountId: string): Promise<void> {
  if (watching.has(accountId)) return;
  const acc = getAccount(accountId);
  if (!acc) return;
  watching.add(accountId);

  const pk = platformKey(acc);
  const loginUrl = loginUrlFor(acc.platform, (acc as { loginScope?: string }).loginScope);

  try {
    // 自带 refCount(+1)+ skipLease:窗口在调用方 closeKernel 后仍存活、且不抢使用锁。
    await launchKernel({
      accountId: acc.id, kernelVersion: acc.kernelVersion, userDataDir: acc.userDataDir,
      fingerprint: acc.fingerprint, proxy: acc.proxy,
      label: accountBadgeLabel(acc), groupTitle: matrixGroupTitle(acc.platform), skipLease: true,
    });
  } catch {
    watching.delete(accountId);
    return;
  }

  // setup:导航登录页 + 置顶 + 红色过期角标(await 完才返回,确保 refCount 已 +1)。
  try { if (loginUrl) await kernelNavigate(acc.id, loginUrl); } catch { /* ignore */ }
  await kernelBringToFront(acc.id);
  await kernelShowExpiredBadge(acc.id, `⚠️ ${accountBadgeLabel(acc)} 登录态已过期,请重新扫码登录`);

  // 轮询循环 detached:不阻塞调用方;窗口被关或超时即止。
  void (async () => {
    try {
      for (let i = 0; i < 200; i++) { // ~10min
        await sleep(3000);
        if (!getSession(acc.id)) break; // 窗口被用户关掉
        let ok = false;
        try { ok = await checkKernelLogin(acc.id, pk); } catch { ok = false; }
        if (!ok) continue;

        // 登录刚成功页面常停在回跳页 → 先导航平台页再读身份(否则读太早拿空,同 openLogin)。
        try { if (loginUrl) await kernelNavigate(acc.id, loginUrl); } catch { /* ignore */ }
        await sleep(3000);
        let ident: { nickname?: string; displayId?: string; avatar?: string; uid?: string } = {};
        try { ident = await kernelReadIdentity(acc.id, pk); } catch { /* 身份读取失败不影响翻状态 */ }

        // 去重:该真实账号(uid)已被别的矩阵号关联 → 拒绝,清 cookie + 仍标 login_required。
        const dup = ident.uid ? findAccountByUid(pk, String(ident.uid), acc.id) : undefined;
        if (dup) {
          try { await kernelClearCookies(acc.id); } catch { /* ignore */ }
          setAccountStatus(acc.id, 'login_required');
          emitAccount({ id: acc.id, status: 'login_required', error: `该账号已被「${dup.displayName}」关联,一个真实账号只能关联一个矩阵号` });
          break;
        }

        setAccountStatus(acc.id, 'idle');
        try { setAccountIdentity(acc.id, { nickname: ident.nickname, displayId: ident.displayId, avatar: ident.avatar, boundUid: ident.uid }); } catch { /* ignore */ }
        emitAccount({ id: acc.id, status: 'idle', nickname: ident.nickname, displayId: ident.displayId, avatar: ident.avatar, boundUid: ident.uid });
        break;
      }
    } finally {
      watching.delete(accountId);
    }
  })();
}
