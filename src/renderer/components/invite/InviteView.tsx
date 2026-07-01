import React, { useState, useEffect } from 'react';
import { CnyWithdrawModal } from '../wallet/CnyWithdrawModal';
import { HIDE_WEB3 } from '../../buildFlags';
import { noobClawAuth } from '../../services/noobclawAuth';
import { noobClawApi } from '../../services/noobclawApi';
import { i18nService } from '../../services/i18n';
import { useCountUp } from '../../hooks/useCountUp';
import { readCachedProfile, writeCachedProfile } from '../../services/profileCache';
import { buildInviteShareMessage } from '../../utils/shareMessage';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import ComposeIcon from '../icons/ComposeIcon';
import WindowTitleBar from '../window/WindowTitleBar';
import InviteTicker from './InviteTicker';
import PartnerHero from './PartnerHero';
import PartnerApplyCard from './PartnerApplyCard';

interface InviteViewProps {
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
}

function maskWallet(addr: string): string {
  if (!addr || addr.length < 10) return addr || '';
  return `${addr.slice(0, 6)}****${addr.slice(-4)}`;
}

// 区块链交易 hash 通常 66 字符(0x + 64 hex)。前 8 + **** + 后 6 = 18 字符可读,
// 用户在 bscscan 上对账时前缀和后缀都能 match 上,中间 **** 占位避免一长串
// 撑爆 cell 宽度。跟 maskWallet 同款"前后真实 + 中间 ****"风格。
function maskTxHash(hash: string | null | undefined): string {
  if (!hash || hash.length < 20) return hash || '';
  return `${hash.slice(0, 8)}****${hash.slice(-6)}`;
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    const loc = i18nService.getDateLocale();
    return d.toLocaleDateString(loc) + ' ' + d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return dateStr;
  }
}

// ─── Stale-while-revalidate cache for user profile ───
// Stored in localStorage so the "我的上级" / "我的邀请链接" / referral stats
// show INSTANTLY on InviteView mount, before the background /profile fetch
// returns. Without this cache the section flickered in 100-300ms after page
// open — visually annoying enough that users called it out.
//
// profile 缓存逻辑已抽到 ../../services/profileCache;CoworkView/WalletView 同源复用。

export const InviteView: React.FC<InviteViewProps> = ({ isSidebarCollapsed, onToggleSidebar, onNewChat, updateBadge }) => {
  const isMac = window.electron.platform === 'darwin';
  const [authState, setAuthState] = useState(noobClawAuth.getState());
  // Lazy-initialize profile from localStorage so the first render already
  // has data — referrer wallet shows immediately, no half-second flicker.
  // Background fetch in the effect below replaces it with fresh data.
  const [profile, setProfile] = useState<any>(() => readCachedProfile(noobClawAuth.getState().walletAddress));
  const [copied, setCopied] = useState(false);
  const [inviteCode, setInviteCode] = useState('');
  const [bindResult, setBindResult] = useState<{ success: boolean; message: string } | null>(null);
  const [binding, setBinding] = useState(false);
  // v5.x+: tabs are 2-level now. Top: Records vs Rebate. Inside Rebate, two
  // sub-tabs split USDT-BEP20 real-cash payouts (independent BSC stream) from
  // the NoobCoin reward stream. Older states used a flat 3-tab list — this
  // pair of states preserves the same content via composition.
  const [detailTab, setDetailTab] = useState<'records' | 'rebate'>('records');
  // 国内版(HIDE_WEB3):返佣默认进 CNY 子 tab(USDT/NoobCoin 子 tab 隐藏)。
  const [rebateSubTab, setRebateSubTab] = useState<'usdt' | 'noob' | 'cny'>(HIDE_WEB3 ? 'cny' : 'usdt');
  // v5.x+: list now spans 6 levels (was only L1). Each row carries the level
  // (1..6) so we can render an L1/L2.../L6 chip identical to the rewards tab.
  const [inviteList, setInviteList] = useState<Array<{ wallet: string; createdAt: string; level?: number }>>([]);
  const [inviteListTotal, setInviteListTotal] = useState(0);
  const [inviteListPage, setInviteListPage] = useState(1);
  const [rewardList, setRewardList] = useState<Array<{ noobAmount: number; reason: string; status: string; createdAt: string; contributorWallet?: string; level?: number }>>([]);
  const [rewardListTotal, setRewardListTotal] = useState(0);
  const [rewardListPage, setRewardListPage] = useState(1);
  const [totalEarned, setTotalEarned] = useState(0);
  const [purchaseMin, setPurchaseMin] = useState(50);
  const [purchaseMax, setPurchaseMax] = useState(150);
  // v5.x+ USDT rebate state — populated when usdt_rebate tab is opened.
  const [usdtSummary, setUsdtSummary] = useState<{
    total_earned: string; total_sent: string; total_inflight: string; total_pending: string;
    cny_total_earned?: string; cny_total_sent?: string; cny_total_inflight?: string; cny_total_pending?: string;
  } | null>(null);
  // v6.x: usdtBreakdown 状态保留 — dashboard endpoint 仍然返回 levels 字段,
  //   data.breakdown.levels 拿到后存进来供未来 reuse;UI 上"来源拆解"strip 已
  //   下线(用户反馈表头列已涵盖 level 信息),但 setter 保留避免 dashboard 调用
  //   方 break。前缀 _ 提示 React-hooks rule:setter 用,getter 暂未用。
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_usdtBreakdown, setUsdtBreakdown] = useState<Array<{ level: number; amount: string; contributor_count: number }>>([]);
  // v5.x+: replaces the old "到账历史" panel. Each row is a rebate_earnings
  // entry annotated with its payout status via FIFO matching against
  // rebate_sends. 'sent' rows carry tx_hash + paid_at; 'pending' rows
  // show "待发" badge with no TX yet.
  const [usdtEarnings, setUsdtEarnings] = useState<Array<{
    id: string; level: number | null; contributor_wallet: string | null;
    amount_usdt: string; reason: string; source_asset: string; order_id: string | null;
    earned_at: string; status: 'sent' | 'pending';
    tx_hash: string | null; bscscan_url: string | null; paid_at: string | null;
  }>>([]);
  // Pagination for the earnings ledger. Server caps pageSize at 100; we use
  // 20 here to match the records/rewards tabs' PAGE_SIZE constant.
  const [usdtEarningsPage, setUsdtEarningsPage] = useState(1);
  const [usdtEarningsTotal, setUsdtEarningsTotal] = useState(0);
  const [usdtLoading, setUsdtLoading] = useState(false);
  // v6.x: CNY 返佣明细(卡密充值的人民币 6 级 cascade)。镜像 usdtEarnings,
  //   但金额是 amount_cny、无链上 tx(CNY 是手动提现)。
  const [cnyEarnings, setCnyEarnings] = useState<Array<{
    id: string; level: number | null; contributor_wallet: string | null;
    amount_cny: string; reason: string; source_asset: string; order_id: string | null;
    earned_at: string; status: 'sent' | 'pending';
  }>>([]);
  const [cnyEarningsPage, setCnyEarningsPage] = useState(1);
  const [cnyEarningsTotal, setCnyEarningsTotal] = useState(0);
  const [cnyLoading, setCnyLoading] = useState(false);
  // CNY 提现弹窗开关 — v6.x 改为客户端内嵌 modal(原来是跳 cn 网页)。
  const [showCnyWithdraw, setShowCnyWithdraw] = useState(false);
  const PAGE_SIZE = 10;

  useEffect(() => {
    const unsub = noobClawAuth.subscribe(setAuthState);
    return unsub;
  }, []);

  useEffect(() => {
    if (authState.isAuthenticated) {
      // Show cached profile immediately (instant render), then fetch fresh
      // in background. If wallet changed since last cache, the freshly fetched
      // data overwrites the wrong one — but during the milliseconds before
      // fetch returns, user sees the previous wallet's data, which is
      // harmless for an authed session that just resumed.
      const cached = readCachedProfile(authState.walletAddress);
      if (cached && (!profile || profile.walletAddress !== cached.walletAddress)) {
        setProfile(cached);
      }
      noobClawApi.getUserProfile().then((fresh) => {
        if (fresh) {
          setProfile(fresh);
          writeCachedProfile(authState.walletAddress, fresh);
        }
      });
      // v5.x+: prefetch USDT summary so the "USDT 总返佣" stat card up top
      // shows a real number from the moment the page mounts — without forcing
      // the user to switch into the Rebate→USDT sub-tab first.
      noobClawApi.getUsdtRebateSummary().then(s => { if (s) setUsdtSummary(s); }).catch(() => {});
      // v6.x: prefetch invite-only NOOB total so the "$Noob 邀请奖励" stat card
      // shows the invite-reward number (not user's global totalNoob balance).
      // 走 loadRewards(1) 顺手把 noob tab 第一页也预热好,切 tab 不再卡。
      loadRewards(1).catch(() => {});
    }
    noobClawApi.getPaymentInfo().then(info => {
      if (info?.purchaseNoobPerDollarMin) setPurchaseMin(info.purchaseNoobPerDollarMin);
      if (info?.purchaseNoobPerDollarMax) setPurchaseMax(info.purchaseNoobPerDollarMax);
    });
  }, [authState.isAuthenticated]);

  // v1.x: cascade partner tier color out to <body> so the Sidebar(active 邀请返佣)
  // + 全局 webkit-scrollbar 都能跟着金/银/铜/钻石走。InviteView 的 partnerColor
  // 之前只 scoped 在自己的 div(.invite-view--partner)上,外层 Sidebar/scrollbar
  // 都拿不到。这个 effect 在 partner 用户进入 InviteView 时给 body 加 class +
  // 设两个 CSS var,unmount 时清掉,只影响"我在这一页"。
  useEffect(() => {
    // v3.x: 'silver' enum 已 rename 成 'platinum'(DB + 代码统一)
    const TIER_BODY_COLORS: Record<string, string> = {
      bronze: '#c46e2a', gold: '#fbbf24', platinum: '#dde4ef', diamond: '#22d3ee',
    };
    const color = profile?.partner?.is_partner
      ? (TIER_BODY_COLORS[profile.partner.tier as string] || '#facc15')
      : null;
    if (!color) return;
    const body = document.body;
    body.classList.add('invite-partner-active');
    body.style.setProperty('--invite-partner-color', color);
    body.style.setProperty('--invite-partner-glow', color + '40');
    return () => {
      body.classList.remove('invite-partner-active');
      body.style.removeProperty('--invite-partner-color');
      body.style.removeProperty('--invite-partner-glow');
    };
  }, [profile?.partner?.is_partner, profile?.partner?.tier]);

  // Affiliate rules doc URL — only the zh family points to the Chinese page;
  // every other locale (ko/ja/ru/fr/de/...) falls back to English, which is
  // what we ship until those translations exist on docs.noobclaw.com.
  const rulesDocUrl = () => {
    const lang = i18nService.currentLanguage;
    if (lang === 'zh' || lang === 'zh-TW') {
      return 'https://docs.noobclaw.com/zhong-wen-ban/yao-qing-fan-yong-ji-zhi';
    }
    return 'https://docs.noobclaw.com/english/affiliate-program';
  };

  const openRules = () => {
    try { window.electron?.shell?.openExternal(rulesDocUrl()); } catch {}
  };

  const hasReferrer = !!profile?.referrerWallet;
  // 国内版:强制用 cn 站邀请格式(官网按 ?ref= 读取;/r/ 路径正则只认根域不认 /cn/)。
  const referralLink = HIDE_WEB3
    ? `https://noobclaw.com/cn/?ref=${authState.walletAddress}`
    : (profile?.referralLink || `https://noobclaw.com/r/${authState.walletAddress}`);

  const copyLink = () => {
    // v1.x:复制的不是裸链接,而是营销介绍 + 教程 + 邀请链接的完整分享文,
    // 用户粘到微信 / X / Telegram 直接是一段可读的招新文。中文/小语种由
    // i18nService.currentLanguage 决定;文案与官网 index.html 同步,改这里
    // 时也要去 website 那边同步改。
    const message = buildInviteShareMessage(referralLink, i18nService.currentLanguage);
    navigator.clipboard.writeText(message);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const bindInvite = async () => {
    if (!inviteCode.trim()) return;
    setBinding(true);
    setBindResult(null);
    try {
      let referrerWallet = inviteCode.trim();
      const linkMatch = referrerWallet.match(/\/r\/([^/\s?]+)/);
      if (linkMatch) referrerWallet = linkMatch[1];
      const resp = await fetch(`${noobClawApi.getBaseUrl().replace('/api/ai', '')}/api/user/referral/register`, {
        method: 'POST',
        headers: { ...noobClawApi.getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ referrerWallet }),
      });
      const data = await resp.json();
      setBindResult({
        success: data.success,
        message: data.success ? i18nService.t('inviteBindSuccess') : (data.message || i18nService.t('inviteBindFail')),
      });
      if (data.success) {
        setInviteCode('');
        // Re-fetch fresh profile (referrer now bound) AND write to the
        // SWR cache so next mount renders "我的上级" instantly without
        // waiting on the network.
        noobClawApi.getUserProfile().then((fresh) => {
          if (fresh) {
            setProfile(fresh);
            writeCachedProfile(authState.walletAddress, fresh);
          }
        });
      }
    } catch {
      setBindResult({ success: false, message: i18nService.t('inviteNetworkError') });
    }
    setBinding(false);
  };

  const loadRecords = async (page: number) => {
    const data = await noobClawApi.getInviteList(page, PAGE_SIZE);
    setInviteList(data.list);
    setInviteListTotal(data.total);
    setInviteListPage(page);
  };

  const loadRewards = async (page: number) => {
    const data = await noobClawApi.getReferralRewards(page, PAGE_SIZE);
    setRewardList(data.list);
    setRewardListTotal(data.total);
    setTotalEarned(data.totalEarned);
    setRewardListPage(page);
  };

  useEffect(() => {
    if (authState.isAuthenticated) {
      loadRecords(1);
    }
  }, [authState.isAuthenticated]);

  const loadUsdtRebate = async (page = 1) => {
    // One-shot call to /dashboard returns summary + breakdown + paginated
    // earnings in a single HTTPS roundtrip. Was 3 parallel fetches before;
    // collapsing to 1 cuts auth-middleware DB hits and TCP overhead, which
    // matters more than the underlying queries on this page.
    setUsdtLoading(true);
    try {
      const data = await noobClawApi.getUsdtRebateDashboard(page, PAGE_SIZE);
      if (data) {
        setUsdtSummary(data.summary);
        setUsdtBreakdown(data.breakdown.levels);
        setUsdtEarnings(data.earnings.items);
        setUsdtEarningsTotal(data.earnings.total);
        setUsdtEarningsPage(page);
      }
    } finally {
      setUsdtLoading(false);
    }
  };

  const switchDetailTab = (tab: 'records' | 'rebate') => {
    setDetailTab(tab);
    if (tab === 'records') {
      loadRecords(1);
    } else {
      // Default sub-tab on entering Rebate is USDT (real cash, more interesting
      // than the NoobCoin ledger). Caller can flip to noob via switchRebateSub.
      switchRebateSub(rebateSubTab);
    }
  };

  const loadCnyRebate = async (page = 1) => {
    setCnyLoading(true);
    try {
      const data = await noobClawApi.getCnyRebateEarnings(page, PAGE_SIZE);
      setCnyEarnings(data.items || []);
      setCnyEarningsTotal(data.total || 0);
      setCnyEarningsPage(page);
    } finally {
      setCnyLoading(false);
    }
  };

  const switchRebateSub = (sub: 'usdt' | 'noob' | 'cny') => {
    setRebateSubTab(sub);
    if (sub === 'usdt') {
      loadUsdtRebate(1);
    } else if (sub === 'cny') {
      loadCnyRebate(1);
    } else {
      loadRewards(1);
    }
  };

  // ─── Header ───
  const header = (
    <div className="draggable flex h-12 items-center justify-between px-4 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
      <div className="flex items-center space-x-3 h-8">
        {isSidebarCollapsed && (
          <div className={`non-draggable flex items-center gap-1 ${isMac ? 'pl-[68px]' : ''}`}>
            <button type="button" onClick={onToggleSidebar} className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors">
              <SidebarToggleIcon className="h-4 w-4" isCollapsed={true} />
            </button>
            <button type="button" onClick={onNewChat} className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors">
              <ComposeIcon className="h-4 w-4" />
            </button>
            {updateBadge}
          </div>
        )}
        <h1 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
          {i18nService.t('invitePageTitle')}
        </h1>
      </div>
      <WindowTitleBar inline />
    </div>
  );

  // ─── Not authenticated ───
  if (!authState.isAuthenticated) {
    return (
      <div className="flex flex-col h-full dark:bg-claude-darkBg bg-claude-bg">
        {header}
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
            <svg className="w-8 h-8 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
          </div>
          <h2 className="text-lg font-bold dark:text-claude-darkText text-claude-text mb-2">{i18nService.t('walletConnectTitle')}</h2>
          <p className="dark:text-claude-darkTextSecondary text-claude-textSecondary text-sm mb-6">{i18nService.t('walletConnectDesc')}</p>
          <button
            onClick={() => noobClawAuth.requireLoginUI()}
            className="px-6 py-2.5 bg-primary hover:bg-primary-hover text-black rounded-lg font-medium transition-all"
          >
            {i18nService.t('walletConnectBtn')}
          </button>
        </div>
      </div>
    );
  }

  const recordsTotalPages = Math.ceil(inviteListTotal / PAGE_SIZE);
  const rewardsTotalPages = Math.ceil(rewardListTotal / PAGE_SIZE);

  // ─── Partner tier theme — sets CSS variables on the page root + injects
  //   one-time scoped <style> that overrides .text-primary / .bg-primary /
  //   .border-primary across the entire page when invite-view--partner is
  //   on the root. This makes the WHOLE page feel gold/silver/bronze/diamond
  //   for partners, not just the hero banner. ───
  // v2.x 区分配色:每档色相差异显著,避免 Diamond/Platinum 互撞 + Gold/Bronze 互撞。
  // v3.x: 'silver' enum 已 rename 成 'platinum'
  const TIER_PAGE_COLORS: Record<string, string> = {
    bronze: '#c46e2a', gold: '#fbbf24', platinum: '#dde4ef', diamond: '#22d3ee',
  };
  const partnerColor = profile?.partner?.is_partner
    ? (TIER_PAGE_COLORS[profile.partner.tier] || '#facc15')
    : null;
  // shiftColor variant for the metallic-gradient digit fill
  const shift = (hex: string, d: number) => '#' + (hex.slice(1).match(/.{2}/g) || []).map((c) =>
    Math.max(0, Math.min(255, parseInt(c, 16) + d)).toString(16).padStart(2, '0')).join('');
  const partnerColorLight = partnerColor ? shift(partnerColor, 60) : null;
  const partnerColorDark = partnerColor ? shift(partnerColor, -60) : null;

  // v1.x: 右上 4 张统计卡的数字滚动效果 — 跟 PartnerHero 顶部"返佣比例"同款。
  // useCountUp 在 target=0 时立刻 setVal(0) 不跑动画(避免新用户 0 抖动);
  // target 变化时从 0 ease-out 滚到 target。展示侧再做 toFixed / toLocaleString。
  const animDirect  = useCountUp(profile?.directReferrals || 0);
  const animNetwork = useCountUp(profile?.totalNetwork || profile?.totalReferrals || 0);
  const animUsdt    = useCountUp(parseFloat(usdtSummary?.total_earned || '0'));
  // v6.x: 同 endpoint 返回的 CNY 累计返佣(cn 站卡密充值的 6 级 cascade 落到这里)。
  //   显示在 USDT card 右边,点击跳官网 cn 站提现 modal(client 不内嵌提现 UI,
  //   把上传二维码 / 历史等都甩给 web 浏览器,electron 主进程零文件层逻辑)。
  const animCny     = useCountUp(parseFloat(usdtSummary?.cny_total_earned || '0'));
  // v6.x: 顶部 $Noob 卡只统计 邀请奖励 (rewardList.totalEarned),不再混入用户
  //   总 NOOB 余额(profile.totalNoob)。totalEarned 在 mount 时通过
  //   loadRewards(1) 顺手预热,user 进 noob tab 时该值已经在,切 tab 不再卡;
  //   user 切到别的 tab 也不会因为缺数据让卡里数字回退到 0。
  const animNoob    = useCountUp(totalEarned);

  // ─── Main page ───
  return (
    <div
      className={`flex flex-col h-full dark:bg-claude-darkBg bg-claude-bg ${partnerColor ? 'invite-view--partner' : ''}`}
      style={partnerColor ? ({
        '--partner-color': partnerColor,
        '--partner-glow': partnerColor + '40',
        '--partner-color-light': partnerColorLight,
        '--partner-color-dark': partnerColorDark,
      } as React.CSSProperties) : undefined}
    >
      {partnerColor && (
        <style>{`
          .invite-view--partner .text-primary { color: var(--partner-color) !important; }
          .invite-view--partner .bg-primary { background-color: var(--partner-color) !important; color:#0a0a0a !important; }
          .invite-view--partner .bg-primary:hover { background-color: var(--partner-color) !important; filter:brightness(0.9); }
          /* color-mix:把 tier 色按比例混到 transparent,得到半透明背景,不影响子元素文字 */
          .invite-view--partner .bg-primary\\/10 {
            background-color: color-mix(in srgb, var(--partner-color) 10%, transparent) !important;
          }
          .invite-view--partner .bg-primary\\/20 {
            background-color: color-mix(in srgb, var(--partner-color) 20%, transparent) !important;
          }
          .invite-view--partner .bg-primary\\/5 {
            background-color: color-mix(in srgb, var(--partner-color) 6%, transparent) !important;
          }
          .invite-view--partner .border-primary { border-color: var(--partner-color) !important; }
          .invite-view--partner .border-primary\\/20 {
            border-color: color-mix(in srgb, var(--partner-color) 28%, transparent) !important;
          }
          .invite-view--partner .focus\\:border-primary:focus { border-color: var(--partner-color) !important; }
          .invite-view--partner .hover\\:bg-primary-hover:hover { background-color: var(--partner-color) !important; filter:brightness(1.1); }

          /* ── 大卡片:只发光,不再旋转(用户反馈旋转太丑) ── */
          /* 上下两条 box-shadow(0 -Y 和 0 +Y)突出顶/底光带,脉冲呼吸更明显 */
          .invite-view--partner .rounded-xl.dark\\:bg-claude-darkSurface,
          .invite-view--partner .rounded-xl.bg-claude-surface {
            position: relative;
            border-color: var(--partner-color) !important;
            animation: invite-card-pulse 3.2s ease-in-out infinite;
            transition: transform 0.25s ease, box-shadow 0.25s ease;
          }
          @keyframes invite-card-pulse {
            0%, 100% {
              box-shadow:
                0 -6px 22px -4px var(--partner-glow),
                0  6px 22px -4px var(--partner-glow),
                0 0 16px var(--partner-glow);
            }
            50% {
              box-shadow:
                0 -10px 40px -2px var(--partner-color),
                0  10px 40px -2px var(--partner-color),
                0 0 30px var(--partner-glow);
            }
          }

          /* ── 4 张统计卡 (text-xl.font-bold.text-primary 是数字大字标识) ── */
          /* 顶部水平 tier 色光条 + hover 上浮 + 投影 */
          .invite-view--partner .p-3.rounded-xl.dark\\:bg-claude-darkSurface.text-center::after {
            content: '';
            position: absolute;
            top: 0; left: 12%; right: 12%;
            height: 2px;
            background: linear-gradient(90deg, transparent, var(--partner-color), transparent);
            filter: drop-shadow(0 0 4px var(--partner-color));
            border-radius: 2px;
            pointer-events: none;
          }
          .invite-view--partner .p-3.rounded-xl.dark\\:bg-claude-darkSurface.text-center:hover {
            transform: translateY(-3px);
            box-shadow: 0 6px 22px var(--partner-glow);
          }

          /* ── 数字大字:金属三色渐变文字填充 ── */
          /* 精确选中:.text-xl.font-bold.text-primary = 4 张统计卡中央数字 */
          .invite-view--partner .text-xl.font-bold.text-primary {
            background: linear-gradient(135deg, var(--partner-color-light) 0%, var(--partner-color) 50%, var(--partner-color-dark) 100%) !important;
            -webkit-background-clip: text !important;
            background-clip: text !important;
            -webkit-text-fill-color: transparent !important;
            color: transparent !important;
            filter: drop-shadow(0 0 6px var(--partner-glow));
            font-size: 24px !important;
            letter-spacing: 0.5px;
          }
          /* 中等数字 (USDT 已到账 / 待发放 等):同效果但稍小 */
          .invite-view--partner .text-base.font-bold.text-primary,
          .invite-view--partner .text-base.font-bold.text-yellow-500 {
            background: linear-gradient(135deg, var(--partner-color-light) 0%, var(--partner-color) 50%, var(--partner-color-dark) 100%) !important;
            -webkit-background-clip: text !important;
            background-clip: text !important;
            -webkit-text-fill-color: transparent !important;
            color: transparent !important;
            filter: drop-shadow(0 0 5px var(--partner-glow));
          }

          /* ── 复制 / 绑定按钮:跑光泽 + tier 色 ── */
          .invite-view--partner button.bg-primary {
            background: linear-gradient(135deg, var(--partner-color-light), var(--partner-color), var(--partner-color-dark)) !important;
            background-size: 200% 200% !important;
            box-shadow: 0 0 16px var(--partner-glow);
            animation: invite-btn-shine 3s ease-in-out infinite;
            font-weight: 700;
          }
          @keyframes invite-btn-shine {
            0%, 100% { background-position: 0% 50%; }
            50%      { background-position: 100% 50%; }
          }

          /* ── 邀请链接 / 邀请人 — 整行 mono code 也用 tier 色 ── */
          .invite-view--partner code.text-primary,
          .invite-view--partner span.font-mono.text-primary {
            background: linear-gradient(135deg, var(--partner-color-light) 0%, var(--partner-color) 50%, var(--partner-color-dark) 100%) !important;
            -webkit-background-clip: text !important;
            background-clip: text !important;
            -webkit-text-fill-color: transparent !important;
            color: transparent !important;
          }

          /* ── 页面背景 ambient 粒子(全局浮粉) ── */
          /* 8 颗淡淡的金粉,让整个邀请页有"VIP 区域"的氛围感 */
          .invite-view--partner > div.flex-1 {
            position: relative;
          }
          .invite-view--partner > div.flex-1::before {
            content: '';
            position: fixed;
            inset: 0;
            pointer-events: none;
            background-image:
              radial-gradient(circle at 12% 22%, var(--partner-color)22 0px, transparent 2px),
              radial-gradient(circle at 78% 18%, var(--partner-color)22 0px, transparent 2px),
              radial-gradient(circle at 32% 70%, var(--partner-color)22 0px, transparent 2px),
              radial-gradient(circle at 88% 78%, var(--partner-color)22 0px, transparent 2px),
              radial-gradient(circle at 52% 38%, var(--partner-color)18 0px, transparent 2px),
              radial-gradient(circle at 18% 88%, var(--partner-color)18 0px, transparent 2px);
            animation: invite-ambient-drift 12s ease-in-out infinite;
            opacity: 0.5;
            z-index: 0;
          }
          @keyframes invite-ambient-drift {
            0%, 100% { transform: translate(0, 0); }
            33%      { transform: translate(20px, -10px); }
            66%      { transform: translate(-10px, 15px); }
          }

          /* ── 全局级 cascade:Sidebar(claude-accent)+ 全局 scrollbar 跟 tier 色 ──
             InviteView 内部的 .invite-view--partner 只能管自己 DOM 子树。Sidebar
             在外层兄弟,scrollbar 是 browser 级,都拿不到。所以 useEffect 把
             --invite-partner-color 设到 <body>,这里写 body.invite-partner-active
             开头的全局选择器,在 body class 存在期间能渗到 Sidebar 和 scrollbar。
             specificity 比 .dark .bg-claude-accent\\/10 高一级(body 多一个 class)
             + !important,稳压 noobclaw-theme.css 里那套 neon 绿默认色。 */
          body.invite-partner-active .bg-claude-accent\\/10,
          body.invite-partner-active [class*="bg-claude-accent/10"] {
            background-color: color-mix(in srgb, var(--invite-partner-color) 12%, transparent) !important;
          }
          body.invite-partner-active .bg-claude-accent\\/20,
          body.invite-partner-active [class*="bg-claude-accent/20"] {
            background-color: color-mix(in srgb, var(--invite-partner-color) 22%, transparent) !important;
          }
          body.invite-partner-active .hover\\:bg-claude-accent\\/20:hover,
          body.invite-partner-active [class*="hover:bg-claude-accent/20"]:hover {
            background-color: color-mix(in srgb, var(--invite-partner-color) 30%, transparent) !important;
          }
          body.invite-partner-active .text-claude-accent {
            color: var(--invite-partner-color) !important;
          }
          body.invite-partner-active .border-claude-accent {
            border-color: color-mix(in srgb, var(--invite-partner-color) 50%, transparent) !important;
          }

          /* 全局 webkit-scrollbar — 默认是 rgba(0,255,136,...) 霓虹绿,partner
             生效时换成 tier 色半透明 thumb。覆盖 noobclaw-theme.css 和
             index.css 里两套定义,所以选择器写 body 限定。 */
          body.invite-partner-active ::-webkit-scrollbar-thumb {
            background: color-mix(in srgb, var(--invite-partner-color) 30%, transparent) !important;
          }
          body.invite-partner-active ::-webkit-scrollbar-thumb:hover {
            background: color-mix(in srgb, var(--invite-partner-color) 55%, transparent) !important;
          }
        `}</style>
      )}
      {header}
      <div className="flex-1 overflow-y-auto p-4">
        {/* v1.x: 走马灯放最顶 — 用户反馈"上面"应该是真的最上面,之前在
            PartnerHero 之下,合伙人进页面要先看金色 banner 再看 ticker。换到
            PartnerHero 之前,任何用户(包括合伙人)进页面第一眼就看到滚动的
            "谁谁刚到账 N USDT"社会证明。 */}
        <div className="mb-3">
          <InviteTicker />
        </div>
        {/* v2.x partner program: 尊贵版 banner — 只在合伙人(profile.partner.is_partner=true)
            时渲染。普通用户看不到这块,页面其它部分完全不变,合伙人多一块顶部金色显示
            自己的 L1 返佣比例 + 倍数对比。后端 /api/me/profile 已下发 partner block。
            v3.x: 非合伙人显示申请卡片 — 展示当前 10% 默认返佣,引导申请合伙人提升费率。
            点击走外部浏览器打开 noobclaw.com/partner-apply.html。*/}
        {/* v3.x bugfix: 三元的 else 分支会在 profile===undefined(未登录 / 还没拉到
            profile 的初始 render)时也渲染,把 apply card 错误地展示给非登录用户 +
            首屏闪一下。外层加 profile 守卫 — 只在已加载 profile 后才走二选一,
            登录前一直 hide(跟原版 `profile?.partner?.is_partner && PartnerHero`
            的行为对齐)。 */}
        {/* 顶部左右双栏 —— 合伙人 / 非合伙人【结构相同】,只是右卡样式不同:
            左 = 我的钱包卡片(头像 / 我的钱包(BSC) / 地址 / 社媒账号),【卡框右侧】= 收到返佣(CNY)+ 提现;
            右 = 合伙人 → PartnerHero(等级标志卡);非合伙人 → PartnerApplyCard(您当前的返佣比例 / 申请合伙人)。
            ⚠️ 别再把 CNY 拆成顶部独立全宽卡,也别用 socialEmail / is_partner 把整张卡 gate 掉 ——
            任何已登录用户都要看到这张钱包卡 + CNY 提现(已被用户骂过几次)。 */}
        {profile && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3 items-stretch">
            {/* 左:我的钱包卡片,卡框右侧带 收到返佣(CNY)+ 提现 */}
            <div className="p-4 rounded-xl border dark:bg-claude-darkSurface bg-claude-surface dark:border-claude-darkBorder border-claude-border flex items-center gap-3 min-w-0">
              {/* avatar */}
              <div className="shrink-0 w-12 h-12 rounded-full overflow-hidden border dark:border-claude-darkBorder border-claude-border bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center">
                {authState.avatarUrl
                  ? <img src={authState.avatarUrl} alt="" className="w-full h-full object-cover" />
                  : <span className="text-white text-sm font-bold">
                      {(authState.walletAddress || '').slice(2, 4).toUpperCase()}
                    </span>}
              </div>
              {/* main col */}
              <div className="flex-1 min-w-0">
                <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-0.5">
                  {i18nService.t('walletMyWalletBsc')}
                </div>
                <div className="text-sm font-mono dark:text-claude-darkText text-claude-text truncate">
                  {authState.walletAddress
                    ? `${authState.walletAddress.slice(0, 8)}…${authState.walletAddress.slice(-6)}`
                    : '—'}
                </div>
                {/* social account row — 仅社交登录用户有 socialEmail 时显示 */}
                {authState.socialEmail && (
                  <div className="flex items-center gap-1.5 mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary truncate">
                    {authState.socialProvider === 'google' && <span style={{ color: '#ea4335' }}>●</span>}
                    {authState.socialProvider === 'twitter' && <span style={{ color: '#fff' }}>𝕏</span>}
                    {authState.socialProvider === 'discord' && <span style={{ color: '#5865f2' }}>●</span>}
                    <span className="truncate">{authState.socialEmail}</span>
                  </div>
                )}
              </div>
              {/* 卡框内右侧:收到返佣(CNY)+ 提现(用户要求放在钱包框的右边) */}
              <div className="shrink-0 self-stretch flex flex-col justify-center text-right border-l dark:border-claude-darkBorder border-claude-border pl-3">
                <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-0.5">{i18nService.currentLanguage === 'zh' ? '收到返佣 (CNY)' : 'Rebate (CNY)'}</div>
                <div className="text-lg font-bold text-primary tabular-nums leading-tight">¥{animCny.toFixed(2)}</div>
                <button type="button" onClick={() => setShowCnyWithdraw(true)} className="text-xs text-primary hover:underline flex items-center gap-0.5 justify-end mt-0.5">
                  {i18nService.currentLanguage === 'zh' ? '提现' : 'Withdraw'}
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                </button>
              </div>
            </div>
            {/* 右:合伙人 → 等级标志卡 PartnerHero;非合伙人 → 返佣比例 / 申请合伙人卡 */}
            {profile?.partner?.is_partner
              ? <PartnerHero partner={profile.partner} />
              : <PartnerApplyCard compact />}
          </div>
        )}
        {/* v1.x: 改 grid 是因为 flex + space-y 在右栏 flex-1 上下拉不齐(左栏内容
            高,右栏 details 容器靠 flex-1 应该撑满,实际不撑满)。grid 行内 cells
            默认 align: stretch,左右两栏一定等高,右栏 details 的 flex-1 在
            grid cell 内能正确 expand 填满剩余高度。 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-stretch">

          {/* ── Left Column: Referrer + Link + How it works ── */}
          <div className="min-w-0 flex flex-col gap-3">
            {/* My Referrer (upper level) */}
            {hasReferrer && (
              <div className="p-3 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
                <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">{i18nService.t('inviteMyUpper')}</div>
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <svg className="w-3 h-3 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
                  </div>
                  <span className="text-sm font-mono dark:text-claude-darkText text-claude-text">{maskWallet(profile.referrerWallet)}</span>
                </div>
              </div>
            )}

            {/* Bind Upper - only show when no referrer */}
            {!hasReferrer && (
              <div className="p-3 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
                <div className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-2">{i18nService.t('inviteBindUpper')}</div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && bindInvite()}
                    placeholder={i18nService.t('inviteBindUpperPlaceholder')}
                    className="flex-1 text-xs px-3 py-1.5 rounded-lg border dark:border-claude-darkBorder border-claude-border bg-transparent dark:text-claude-darkText text-claude-text focus:border-primary outline-none transition-colors"
                  />
                  <button
                    onClick={bindInvite}
                    disabled={binding || !inviteCode.trim()}
                    className="text-xs px-3 py-1.5 rounded-lg bg-primary hover:bg-primary-hover text-black font-medium transition-all disabled:opacity-40"
                  >
                    {binding ? '...' : i18nService.t('inviteBind')}
                  </button>
                </div>
                {bindResult && (
                  <p className={`text-xs mt-1.5 ${bindResult.success ? 'text-primary' : 'text-red-400'}`}>{bindResult.message}</p>
                )}
              </div>
            )}

            {/* My Referral Link */}
            <div className="p-3 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
              <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1.5">{i18nService.t('inviteYourLink')}</div>
              <div className="flex items-center gap-2 p-2 rounded-lg dark:bg-claude-darkSurfaceInset bg-gray-50 border dark:border-claude-darkBorder border-claude-border">
                <code className="flex-1 text-xs font-mono text-primary truncate select-all">{referralLink}</code>
              </div>
              <button
                onClick={copyLink}
                className={`mt-2 w-full text-sm py-1.5 rounded-lg font-medium transition-all ${
                  copied
                    ? 'bg-primary/20 text-primary'
                    : 'bg-primary hover:bg-primary-hover text-black'
                }`}
              >
                {copied ? i18nService.t('inviteCopied') : i18nService.t('inviteCopy')}
              </button>
            </div>

            {/* How it works + Reward rules */}
            <div className="p-3 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium dark:text-claude-darkText text-claude-text">{i18nService.t('inviteHowItWorks')}</h3>
                {/* v5.x+: link to the full affiliate-program doc. zh/zh-TW
                    → Chinese page, everything else → English fallback until
                    other locales exist on docs.noobclaw.com. */}
                <button
                  type="button"
                  onClick={openRules}
                  className="text-xs text-primary hover:underline inline-flex items-center gap-0.5"
                >
                  📖 {i18nService.t('inviteViewRules')} ↗
                </button>
              </div>
              {/* Steps 1-2 are the narrative; step 3 (rewards trigger) is
                  replaced below by the unified dual-rewards callout, which
                  is too rich to fit a single-line step description. */}
              <div className="space-y-2.5">
                {[
                  { title: i18nService.t('inviteStep1Title'), desc: i18nService.t('inviteStep1Desc') },
                  { title: i18nService.t('inviteStep2Title'), desc: i18nService.t('inviteStep2Desc') },
                ].map((step, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <div className="w-5 h-5 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5">{i + 1}</div>
                    <div>
                      <div className="text-sm dark:text-claude-darkText text-claude-text">{step.title}</div>
                      <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-0.5">{step.desc}</div>
                    </div>
                  </div>
                ))}
                {/* Step 3（国内版 CNY 返佣）：好友充值即得邀请奖励 */}
                {HIDE_WEB3 && (
                <div className="flex items-start gap-2">
                  <div className="w-5 h-5 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5">3</div>
                  <div>
                    <div className="text-sm dark:text-claude-darkText text-claude-text">{i18nService.currentLanguage === 'zh' ? '好友充值时，您将获得邀请奖励' : 'When your friend tops up, you earn a referral reward'}</div>
                    <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-0.5">{i18nService.currentLanguage === 'zh' ? '邀请关系生效后，按好友充值金额给您返佣' : "Rebate based on your friend's top-up once the referral is bound"}</div>
                  </div>
                </div>
                )}
                {/* Step 3: dual-reward composite — 国内版隐藏(HIDE_WEB3,改走 CNY 返佣)。
                    Replaces the old separate USDT explainer card too — both
                    rewards are surfaced inline with parallel structure so the
                    user sees them as siblings, not as competing systems. */}
                {!HIDE_WEB3 && (
                <div className="flex items-start gap-2">
                  <div className="w-5 h-5 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5">3</div>
                  <div className="flex-1">
                    <div className="text-sm dark:text-claude-darkText text-claude-text">
                      {i18nService.currentLanguage === 'zh' ? '好友每次充值，触发双重奖励：' : 'Each friend top-up triggers dual rewards:'}
                    </div>
                    {/* v1.x: USDT 真金返佣放上面 — 现金返佣比代币空投更直接,作为主
                        奖励先展示;website uc/ir 卡片同序。 */}
                    <div className="mt-2 p-2.5 rounded-lg bg-primary/5 border border-primary/20">
                      <div className="text-xs font-medium text-primary mb-1">
                        💰 USDT {i18nService.currentLanguage === 'zh' ? '真金返佣' : 'real-cash rebate'}
                      </div>
                      <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary leading-relaxed">
                        {/* Partner-aware rate: if the logged-in wallet is a partner,
                            substitute their personal rate_pct for the default 10%. */}
                        {(() => {
                          const rate = profile?.partner?.is_partner ? profile.partner.rate_pct : 10;
                          return i18nService.currentLanguage === 'zh'
                            ? `好友每充值 $1，充值金额的 ${rate}% 作为返佣奖励，按 6 层邀请链路进行返佣。佣金 5 分钟内以 BNB Chain 上的 USDT 形式实时自动发放到您钱包。`
                            : `For every $1 your friend tops up, ${rate}% becomes rebate reward, distributed across your 6-level invite chain. Auto-paid in real-time (within 5 min) as USDT on BNB Chain, straight to your wallet.`;
                        })()}
                      </div>
                    </div>
                    {/* NoobCoin airdrop */}
                    <div className="mt-2 p-2.5 rounded-lg bg-primary/5 border border-primary/20">
                      <div className="text-xs font-medium text-primary mb-1">
                        🪂 $NoobCoin {i18nService.currentLanguage === 'zh' ? '空投' : 'airdrop'}
                      </div>
                      <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary leading-relaxed">
                        {i18nService.currentLanguage === 'zh'
                          ? `好友每充值 $1，获得 ${purchaseMin}~${purchaseMax} 随机数量的 $NoobCoin。按 6 层邀请链路进行空投，您额外获得 50%+ 同等数量代币。`
                          : `Friend gets ${purchaseMin}-${purchaseMax} random $NoobCoin per $1 topped up. Airdropped across your 6-level invite chain — you earn 50%+ of the same amount.`}
                      </div>
                    </div>
                  </div>
                </div>
                )}
              </div>

              {/* 6-level reward percentage chart — applies to BOTH rewards above.
                  L1 gets ≥50%, L2-L6 each get 10%. Same splits for NoobCoin
                  airdrop and USDT rebate, hence one chart documents both. */}
              <div className="mt-3 p-2.5 rounded-lg dark:bg-claude-darkSurfaceInset bg-gray-50 border dark:border-claude-darkBorder border-claude-border">
                <div className="text-xs font-medium dark:text-claude-darkText text-claude-text mb-1.5">{i18nService.t('inviteRewardTitle')}</div>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('inviteRewardLevel1')}</span>
                    <span className="text-primary font-medium">&ge;50%</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('inviteRewardLevel2_6')}</span>
                    <span className="dark:text-claude-darkText text-claude-text">10% each</span>
                  </div>
                </div>
              </div>
            </div>


          </div>

          {/* ── Right Column: Stats + Invite Details / Rewards ── */}
          <div className="min-w-0 flex flex-col gap-3">
            {/* Stats: Direct Referrals + Total Network + USDT total earned + NOOB earned.
                v5.x+: grid is 4 cols on md+ for the full row, falls back to
                2 cols on narrow widths so the labels don't squash on phones.
                USDT total comes from /api/me/rebate/summary (prefetched on
                mount), NOOB total comes from profile.totalNoob (already
                served by /api/user/referral). */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <div className="p-3 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border text-center">
                <div className="text-xl font-bold text-primary tabular-nums">{Math.floor(animDirect)}</div>
                <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('inviteDirectReferrals')}</div>
              </div>
              <div className="p-3 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border text-center">
                <div className="text-xl font-bold text-primary tabular-nums">{Math.floor(animNetwork)}</div>
                <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('inviteTotalNetwork')}</div>
              </div>
              {/* USDT 总返佣 + NoobCoin 奖励统计 — 国内版隐藏(HIDE_WEB3) */}
              {!HIDE_WEB3 && (
              <div className="p-3 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border text-center">
                <div className="text-xl font-bold text-primary tabular-nums">${animUsdt.toFixed(2)}</div>
                <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('inviteUsdtTotal')}</div>
              </div>
              )}
              {/* v6.x→: CNY 总返佣已从这排统计移走 —— 改成「收到返佣 (CNY) + 提现」放到顶部我的钱包卡框的右侧(用户要求)。 */}
              {!HIDE_WEB3 && (
              <div className="p-3 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border text-center">
                <div className="text-xl font-bold text-primary tabular-nums">{Math.floor(animNoob).toLocaleString()}</div>
                <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('inviteNoobReward')}</div>
              </div>
              )}
            </div>

            {/* ── Invite Details / Rewards ── */}
            <div className="flex-1 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border flex flex-col min-h-0">
          {/* Top-level tabs: Records vs Rebate. Rebate has its own sub-menu
              (USDT real-cash + NoobCoin) rendered below this row when active. */}
          <div className="flex border-b dark:border-claude-darkBorder border-claude-border shrink-0">
            <button
              onClick={() => switchDetailTab('records')}
              className={`flex-1 py-2 text-xs font-medium text-center transition-colors relative ${
                detailTab === 'records'
                  ? 'text-primary'
                  : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'
              }`}
            >
              {i18nService.t('inviteDetailMenu')}
              {detailTab === 'records' && <div className="absolute bottom-0 left-1/4 right-1/4 h-0.5 bg-primary rounded-full" />}
            </button>
            <button
              onClick={() => switchDetailTab('rebate')}
              className={`flex-1 py-2 text-xs font-medium text-center transition-colors relative ${
                detailTab === 'rebate'
                  ? 'text-primary'
                  : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'
              }`}
            >
              💰 {i18nService.t('inviteRebateMenu')}
              {detailTab === 'rebate' && <div className="absolute bottom-0 left-1/4 right-1/4 h-0.5 bg-primary rounded-full" />}
            </button>
          </div>

          {/* Sub-menu only shown when Rebate is active — two pills for USDT
              (real cash, BSC chain) vs NoobCoin (in-app reward ledger). */}
          {detailTab === 'rebate' && (
            <div className="flex gap-1 px-2 py-1.5 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
              {/* USDT(链上真金返佣)子 tab — 国内版隐藏(HIDE_WEB3) */}
              {!HIDE_WEB3 && (
              <button
                onClick={() => switchRebateSub('usdt')}
                className={`flex-1 py-1 text-xs font-medium rounded-md transition-colors ${
                  rebateSubTab === 'usdt'
                    ? 'bg-primary/10 text-primary'
                    : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                }`}
              >
                {i18nService.t('inviteRebateUsdtSub')}
              </button>
              )}
              <button
                onClick={() => switchRebateSub('cny')}
                className={`flex-1 py-1 text-xs font-medium rounded-md transition-colors ${
                  rebateSubTab === 'cny'
                    ? 'bg-primary/10 text-primary'
                    : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                }`}
              >
                {i18nService.currentLanguage === 'zh' ? 'CNY 返佣' : 'CNY Rebate'}
              </button>
              {/* NoobCoin(链上代币奖励)子 tab — 国内版隐藏(HIDE_WEB3) */}
              {!HIDE_WEB3 && (
              <button
                onClick={() => switchRebateSub('noob')}
                className={`flex-1 py-1 text-xs font-medium rounded-md transition-colors ${
                  rebateSubTab === 'noob'
                    ? 'bg-primary/10 text-primary'
                    : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                }`}
              >
                {i18nService.t('inviteRebateNoobSub')}
              </button>
              )}
            </div>
          )}

          {/* Content. v5.x+ branch order matches the new 2-level tab tree:
              top-level Records first, then Rebate splits via rebateSubTab.
              Marquee moved to top of the page (above this column flex)
              per UX request — visible across all tabs. */}
          <div className="flex-1 overflow-y-auto p-3">
            {detailTab === 'rebate' && rebateSubTab === 'usdt' ? (
              // v6.x USDT real-cash rebate panel — slimmed down to mirror the
              // website's flat list:
              //   - dropped 待发放/已到账 summary cards (totals live in the top
              //     stats row's "USDT 总返佣" card already)
              //   - dropped 来源拆解 L1~L6 strip (the per-row level chip + the
              //     site-style summary cover the same ground)
              //   - 4-col grid table mirroring noob list (金额/来源.层级/状态/时间)
              usdtLoading ? (
                <div className="flex items-center justify-center py-12 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  Loading...
                </div>
              ) : usdtEarnings.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-6 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  <p className="text-xs">{i18nService.currentLanguage === 'zh' ? '还没有返佣记录' : 'No rebate records yet'}</p>
                </div>
              ) : (
                <div>
                  {/* Table header — mirrors noob list header style for consistency */}
                  <div className="grid grid-cols-4 gap-1 px-2 py-1.5 text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary border-b dark:border-claude-darkBorder border-claude-border mb-1">
                    <span>{i18nService.t('inviteUsdtColAmount')}</span>
                    <span>{i18nService.t('inviteUsdtColFrom')}</span>
                    <span>{i18nService.t('inviteUsdtColStatus')}</span>
                    <span>{i18nService.t('inviteUsdtColTime')}</span>
                  </div>
                  <div className="space-y-1">
                    {usdtEarnings.map((row) => {
                      const sent = row.status === 'sent';
                      // Status cell: 已发 = chip + masked tx_hash 双行,点击整 cell
                      // 打开 bscscan;待发 = plain chip。
                      // v1.x bugfix: 原 <a target="_blank"> 走 plugin:shell|open
                      // 被 ACL 拒,改成 button + openExternal helper(走 opener
                      // 插件,已 grant)。
                      // v2.x: 用户要求 list 露 tx_id — 在 chip 下面加一行 mono
                      // masked tx_hash(0xabcd1234****56789a),整 cell 还是点击
                      // 打开 bscscan,跟原来的"已发 ↗"行为一致。
                      const statusCell = sent && row.tx_hash ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            const url = row.bscscan_url;
                            if (!url) return;
                            try { window.electron?.shell?.openExternal(url); } catch {}
                          }}
                          className="flex flex-col items-start gap-0.5 cursor-pointer"
                          title={row.tx_hash}
                        >
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-green-500/10 text-green-500 hover:underline">
                            ✓ {i18nService.currentLanguage === 'zh' ? '已发' : 'Sent'} ↗
                          </span>
                          <span className="font-mono text-[9px] dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-primary transition-colors">
                            {maskTxHash(row.tx_hash)}
                          </span>
                        </button>
                      ) : sent ? (
                        <span className="inline-flex items-center w-fit px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-green-500/10 text-green-500">
                          ✓ {i18nService.currentLanguage === 'zh' ? '已发' : 'Sent'}
                        </span>
                      ) : (
                        <span className="inline-flex items-center w-fit px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-yellow-500/10 text-yellow-500">
                          ⏳ {i18nService.currentLanguage === 'zh' ? '待发' : 'Pending'}
                        </span>
                      );
                      return (
                        <div key={row.id} className="grid grid-cols-4 gap-1 items-center px-2 py-1.5 rounded-lg dark:bg-claude-darkSurfaceInset bg-gray-50 text-xs">
                          {/* 金额 */}
                          <span className="font-semibold text-primary">+${parseFloat(row.amount_usdt).toFixed(4)}</span>
                          {/* 来源 / 层级 — 钱包 + L1-L6 chip 同 cell,跟官网格式一致。
                              v2.x: 去掉 truncate,完整 0xabcd****1234 14 字符直接显示;
                              column 比 truncate 后多占一点宽度但用户能看清前后两端。 */}
                          <span className="flex items-center gap-1 min-w-0">
                            <span className="font-mono dark:text-claude-darkText text-claude-text text-[10px]">
                              {row.contributor_wallet ? maskWallet(row.contributor_wallet) : '-'}
                            </span>
                            {row.level && (
                              <span className={`inline-flex items-center justify-center px-1 py-0.5 rounded text-[9px] font-medium flex-shrink-0 ${
                                row.level === 1 ? 'bg-primary/10 text-primary' : 'bg-gray-500/10 dark:text-claude-darkTextSecondary text-claude-textSecondary'
                              }`}>
                                L{row.level}
                              </span>
                            )}
                          </span>
                          {/* 状态 */}
                          {statusCell}
                          {/* 时间 */}
                          <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary truncate text-[10px]">
                            {formatDate(row.earned_at)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )
            ) : detailTab === 'rebate' && rebateSubTab === 'cny' ? (
              // v6.x CNY 返佣明细 — 卡密充值的人民币 6 级 cascade。CNY 是手动提现,
              // 无链上 tx;顶部放「去提现」按钮(内嵌 modal)。
              <div>
                <button
                  type="button"
                  onClick={() => setShowCnyWithdraw(true)}
                  className="w-full mb-2 py-1.5 rounded-lg text-xs font-semibold bg-green-500/10 text-green-600 dark:text-green-400 hover:bg-green-500/20 transition-colors"
                >
                  💴 {i18nService.currentLanguage === 'zh' ? '去提现 CNY →' : 'Withdraw CNY →'}
                </button>
                {cnyLoading ? (
                  <div className="flex items-center justify-center py-12 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">Loading...</div>
                ) : cnyEarnings.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-6 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    <p className="text-xs">{i18nService.currentLanguage === 'zh' ? '还没有 CNY 返佣记录' : 'No CNY rebate records yet'}</p>
                  </div>
                ) : (
                  <div>
                    <div className="grid grid-cols-4 gap-1 px-2 py-1.5 text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary border-b dark:border-claude-darkBorder border-claude-border mb-1">
                      <span>{i18nService.currentLanguage === 'zh' ? '金额' : 'Amount'}</span>
                      <span>{i18nService.currentLanguage === 'zh' ? '来源' : 'From'}</span>
                      <span>{i18nService.currentLanguage === 'zh' ? '状态' : 'Status'}</span>
                      <span>{i18nService.currentLanguage === 'zh' ? '时间' : 'Time'}</span>
                    </div>
                    <div className="space-y-1">
                      {cnyEarnings.map((row) => {
                        const sent = row.status === 'sent';
                        return (
                          <div key={row.id} className="grid grid-cols-4 gap-1 items-center px-2 py-1.5 rounded-lg dark:bg-claude-darkSurfaceInset bg-gray-50 text-xs">
                            <span className="font-semibold text-green-500">+¥{parseFloat(row.amount_cny).toFixed(2)}</span>
                            <span className="flex items-center gap-1 min-w-0">
                              <span className="font-mono dark:text-claude-darkText text-claude-text text-[10px]">
                                {row.contributor_wallet ? maskWallet(row.contributor_wallet) : '-'}
                              </span>
                              {row.level && (
                                <span className={`inline-flex items-center justify-center px-1 py-0.5 rounded text-[9px] font-medium flex-shrink-0 ${
                                  row.level === 1 ? 'bg-primary/10 text-primary' : 'bg-gray-500/10 dark:text-claude-darkTextSecondary text-claude-textSecondary'
                                }`}>
                                  L{row.level}
                                </span>
                              )}
                            </span>
                            <span className={`inline-flex items-center w-fit px-1.5 py-0.5 rounded-full text-[10px] font-medium ${sent ? 'bg-green-500/10 text-green-500' : 'bg-yellow-500/10 text-yellow-500'}`}>
                              {sent ? (i18nService.currentLanguage === 'zh' ? '✓ 已入账' : '✓ Credited') : (i18nService.currentLanguage === 'zh' ? '⏳ 待提现' : '⏳ Pending')}
                            </span>
                            <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary truncate text-[10px]">
                              {formatDate(row.earned_at)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            ) : detailTab === 'records' ? (
              inviteList.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-6 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  <svg className="w-8 h-8 mb-2 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                  <p className="text-xs">{i18nService.t('inviteNoRecords')}</p>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {inviteList.map((item, idx) => (
                    <div key={idx} className="flex items-center justify-between px-2 py-1.5 rounded-lg dark:bg-claude-darkSurfaceInset bg-gray-50">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                          <svg className="w-3 h-3 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
                        </div>
                        <span className="text-xs font-mono dark:text-claude-darkText text-claude-text truncate">{maskWallet(item.wallet)}</span>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {/* L1 highlighted (direct), L2-L6 muted — same chip
                            language as rewards/USDT-breakdown tabs. */}
                        <span className={`inline-flex items-center justify-center w-fit px-1.5 py-0.5 rounded-full text-xs font-medium ${
                          item.level === 1
                            ? 'bg-primary/10 text-primary'
                            : 'bg-gray-500/10 dark:text-claude-darkTextSecondary text-claude-textSecondary'
                        }`}>
                          {item.level ? `L${item.level}` : '-'}
                        </span>
                        <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{formatDate(item.createdAt)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )
            ) : (
              <>
                {/* v6.x: dropped inline "累计邀请奖励 X NOOB" card — the same value
                    now lives in the top stats row's "$Noob 邀请奖励" card, so
                    repeating it just above the list was redundant. */}
                {rewardList.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-6 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    <svg className="w-8 h-8 mb-2 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    <p className="text-xs">{i18nService.t('inviteNoRecords')}</p>
                  </div>
                ) : (
                  <div>
                    {/* Table header — v2.x: 来源列替换原 contributor 列。每行用 reason +
                        contributorWallet 推断出"邀请奖励 L1 / 充值奖励 / 福袋"标签,
                        鼠标悬停看具体钱包。 */}
                    <div className="grid grid-cols-4 gap-1 px-2 py-1.5 text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary border-b dark:border-claude-darkBorder border-claude-border mb-1">
                      <span>{i18nService.t('inviteRewardColAmount')}</span>
                      <span>{i18nService.currentLanguage === 'zh' ? '来源' : 'Source'}</span>
                      <span>{i18nService.t('inviteRewardColContributor')}</span>
                      <span>{i18nService.t('inviteRewardColTime')}</span>
                    </div>
                    <div className="space-y-1">
                      {rewardList.map((item, idx) => {
                        // v2.x: 来源徽章 — 按 reason 区分
                        //   referral_bonus  → 🔗 邀请奖励 L{level}(下级贡献的)
                        //   purchase_bonus  → 💵 充值奖励 (自己充值触发的)
                        //   lucky_bag       → 🎁 福袋 (聊天随机)
                        const isZh = i18nService.currentLanguage === 'zh';
                        let badgeIcon = '🪂', badgeText = isZh ? '空投' : 'Airdrop', badgeColor = 'bg-gray-500/10 text-gray-400';
                        if (item.reason === 'referral_bonus') {
                          badgeIcon = '🔗';
                          badgeText = isZh ? `邀请奖励${item.level ? ' L'+item.level : ''}` : `Invite${item.level ? ' L'+item.level : ''}`;
                          badgeColor = item.level === 1 ? 'bg-primary/10 text-primary' : 'bg-blue-500/10 text-blue-400';
                        } else if (item.reason === 'purchase_bonus') {
                          badgeIcon = '💵';
                          badgeText = isZh ? '充值奖励' : 'Top-up';
                          badgeColor = 'bg-green-500/10 text-green-400';
                        } else if (item.reason === 'lucky_bag') {
                          badgeIcon = '🎁';
                          badgeText = isZh ? '福袋' : 'Lucky Bag';
                          badgeColor = 'bg-yellow-500/10 text-yellow-400';
                        }
                        return (
                          <div key={idx} className="grid grid-cols-4 gap-1 items-center px-2 py-1.5 rounded-lg dark:bg-claude-darkSurfaceInset bg-gray-50 text-xs">
                            <span className="font-semibold text-primary">+{item.noobAmount.toLocaleString()}</span>
                            <span className={`inline-flex items-center justify-center w-fit px-1.5 py-0.5 rounded-full text-[10px] font-medium ${badgeColor}`}>
                              <span className="mr-0.5">{badgeIcon}</span>{badgeText}
                            </span>
                            {/* v2.x: 去掉 truncate,完整露 0xabcd****1234 */}
                            <span className="font-mono dark:text-claude-darkText text-claude-text"
                              title={item.contributorWallet || ''}>
                              {item.contributorWallet ? maskWallet(item.contributorWallet) : '-'}
                            </span>
                            <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary truncate">{formatDate(item.createdAt)}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Pagination — works for records, NoobCoin rewards sub-tab,
              and USDT rebate sub-tab. Each tab has its own page state and
              total-page calc; the buttons dispatch to the correct loader. */}
          {(() => {
            // Compute current page + totalPages + loader for the active tab.
            // Hoisting these into a single ternary keeps the JSX tidy and the
            // disabled/onClick logic uniform across all three pagination cases.
            let curPage = 1;
            let totalPages = 1;
            let loader: ((p: number) => void) | null = null;
            if (detailTab === 'records') {
              curPage = inviteListPage; totalPages = recordsTotalPages || 1; loader = loadRecords;
            } else if (detailTab === 'rebate' && rebateSubTab === 'noob') {
              curPage = rewardListPage; totalPages = rewardsTotalPages || 1; loader = loadRewards;
            } else if (detailTab === 'rebate' && rebateSubTab === 'usdt') {
              curPage = usdtEarningsPage;
              totalPages = Math.max(1, Math.ceil(usdtEarningsTotal / PAGE_SIZE));
              loader = loadUsdtRebate;
            } else if (detailTab === 'rebate' && rebateSubTab === 'cny') {
              curPage = cnyEarningsPage;
              totalPages = Math.max(1, Math.ceil(cnyEarningsTotal / PAGE_SIZE));
              loader = loadCnyRebate;
            }
            if (!loader) return null;
            return (
              <div className="flex items-center justify-center gap-2 py-2 border-t dark:border-claude-darkBorder border-claude-border shrink-0">
                <button
                  onClick={() => loader!(curPage - 1)}
                  disabled={curPage <= 1}
                  className="text-xs px-2 py-1 rounded dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover disabled:opacity-30 transition-colors"
                >
                  &laquo;
                </button>
                <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {curPage} / {totalPages}
                </span>
                <button
                  onClick={() => loader!(curPage + 1)}
                  disabled={curPage >= totalPages}
                  className="text-xs px-2 py-1 rounded dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover disabled:opacity-30 transition-colors"
                >
                  &raquo;
                </button>
              </div>
            );
          })()}
          {showCnyWithdraw && (
            <CnyWithdrawModal
              isZh={i18nService.currentLanguage === 'zh'}
              onClose={() => setShowCnyWithdraw(false)}
              onSuccess={() => { if (rebateSubTab === 'cny') loadCnyRebate(cnyEarningsPage); }}
            />
          )}
        </div>
          </div>

        </div>
      </div>
    </div>
  );
};

export default InviteView;
