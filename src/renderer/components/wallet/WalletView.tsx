import React, { useState, useEffect, useCallback } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { noobClawAuth } from '../../services/noobclawAuth';
import { noobClawApi, PaymentInfo, RedeemPackagesResponse } from '../../services/noobclawApi';
import { CnyWithdrawModal } from './CnyWithdrawModal';
import MembershipPanel from '../membership/MembershipPanel';
import { getPendingWalletTab } from '../../services/walletNav';
import { readCachedProfile, writeCachedProfile } from '../../services/profileCache';
import { readCachedPaymentInfo, writeCachedPaymentInfo, readCachedRedeemInfo, writeCachedRedeemInfo } from '../../services/paymentInfoCache';
import { HIDE_WEB3 } from '../../buildFlags';
import { i18nService } from '../../services/i18n';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import ComposeIcon from '../icons/ComposeIcon';
import WindowTitleBar from '../window/WindowTitleBar';
// v6.x: PartnerApplyCard 已从 WalletView 移除(改成 balance row 第 3 列跳邀请页),import 不再需要
// import PartnerApplyCard from '../invite/PartnerApplyCard';

interface WalletViewProps {
  onOpenSettings?: () => void;
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
  /** 合伙人在 wallet header 看到 tier 徽章后,点击跳到邀请返佣页 */
  onShowInvite?: () => void;
}

const ORDER_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

function formatCountdown(ms: number): string {
  if (ms <= 0) return '0:00:00';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function getStatusLabel(status: string): string {
  const map: Record<string, string> = {
    pending: i18nService.t('walletStatusPending'),
    completed: i18nService.t('walletStatusCompleted'),
    cancelled: i18nService.t('walletStatusCancelled'),
    expired: i18nService.t('walletStatusExpired'),
    failed: i18nService.t('walletStatusFailed'),
    confirming: i18nService.t('walletStatusConfirming'),
  };
  return map[status] || status;
}

function getStatusColor(status: string): string {
  const map: Record<string, string> = {
    pending: 'bg-yellow-500/10 text-yellow-500',
    completed: 'bg-primary/10 text-primary',
    cancelled: 'bg-gray-500/10 text-gray-400',
    expired: 'bg-red-500/10 text-red-400',
    failed: 'bg-red-500/10 text-red-400',
    confirming: 'bg-blue-500/10 text-blue-400',
  };
  return map[status] || 'bg-gray-500/10 text-gray-400';
}

// Network logo for the deposit-chain selector + order rows. Inline SVG so we
// have a single source of truth and no extra asset fetch. Sizes are square px.
const ChainLogo: React.FC<{ chain: 'BSC' | 'TRON'; size?: number }> = ({ chain, size = 18 }) => {
  if (chain === 'TRON') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ verticalAlign: 'middle' }}>
        <rect width={24} height={24} rx={12} fill="#EF0027" />
        <path fill="white" d="M17.5 5.5L7.5 4 12 17.5l1.5-4.2L17.5 5.5zm-1.7.8L12.7 11l-2-4.8 4.6-.4-.4.3zm-7.6-1l3.5 1.4-.8 4.4-3.4-5.5L8.2 5.3zm5.1 6.4l-1.3 3.6L7.5 7l5 4.5z" />
      </svg>
    );
  }
  // BSC
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" style={{ verticalAlign: 'middle' }}>
      <circle cx={16} cy={16} r={16} fill="#F3BA2F" />
      <path fill="white" d="M12.116 14.404L16 10.52l3.886 3.886 2.26-2.258L16 6l-6.146 6.146 2.262 2.258zM6 16l2.26-2.26L10.52 16l-2.26 2.26L6 16zm6.116 1.596L16 21.48l3.886-3.886 2.26 2.259L16 26l-6.146-6.146-.003-.003 2.265-2.255zM21.48 16l2.26-2.26L26 16l-2.26 2.26L21.48 16zm-3.188-.002h.002V16L16 18.294 13.706 16.002l-.004-.004.004-.004.402-.402.195-.195L16 13.706l2.293 2.293z" />
    </svg>
  );
};

// Get the active chain block + a list of packages for it from PaymentInfo,
// falling back to legacy top-level fields when the backend predates the
// multi-chain block.
function chainBlockFor(info: PaymentInfo | null, chain: 'BSC' | 'TRON') {
  if (!info) return null;
  const fromChains = info.chains && info.chains[chain];
  if (fromChains) return fromChains;
  // legacy fallback: only BSC was supported, top-level packages == BSC
  if (chain === 'BSC') {
    return {
      treasuryWallet: info.treasuryWallet,
      bnbPriceUsd: info.bnbPriceUsd,
      packages: info.packages,
      enabled: true,
    };
  }
  return null;
}

export const WalletView: React.FC<WalletViewProps> = ({ isSidebarCollapsed, onToggleSidebar, onNewChat, updateBadge, onShowInvite }) => {
  const isMac = window.electron.platform === 'darwin';
  const [authState, setAuthState] = useState(noobClawAuth.getState());
  // v1.x: lazy-init paymentInfo from cache. 用户反馈"客户端加载套餐还是很慢" —
  // 即使后端 /api/payment/info 自带 5 分钟内存缓存命中只要几毫秒,客户端到 API
  // 之间还是有一次 HTTPS 往返(200~800ms 网络延迟),套餐卡得等到那一刻才显示。
  // 跟 profile 一样做 localStorage 缓存(同 5 分钟 TTL),第二次进我的充值套餐
  // 秒出,后台 fetch 静默覆盖。bnbPriceUsd 5 分钟漂移 0.x% 完全可接受。
  const [paymentInfo, setPaymentInfo] = useState<PaymentInfo | null>(() => readCachedPaymentInfo());
  const [orderHistory, setOrderHistory] = useState<any[]>([]);
  const [pendingOrderNo, setPendingOrderNo] = useState('');
  // pendingAmount is the on-chain amount string the user must transfer
  // (e.g. "0.025154" for BNB or "10.003472" for USDT). pendingChain records
  // which chain the pending order is on so the payment panel can show the
  // right unit + treasury address. Kept as a single string + chain rather
  // than two separate states to avoid drift between the two on chain switch.
  const [pendingAmount, setPendingAmount] = useState('');
  const [pendingChain, setPendingChain] = useState<'BSC' | 'TRON'>('BSC');
  const [pendingCreatedAt, setPendingCreatedAt] = useState('');
  // Currently selected deposit chain on the package picker. Defaulted to
  // TRON in loadData() when the backend reports TRON is available, since
  // USDT is the more common new-user path. lazy-init reads the cached
  // paymentInfo so on second-and-later visits the picker doesn't flash
  // BSC for one frame before flipping to TRON.
  const [currentChain, setCurrentChain] = useState<'BSC' | 'TRON'>(() => {
    const cached = readCachedPaymentInfo();
    return cached?.chains?.TRON ? 'TRON' : 'BSC';
  });
  const [step, setStep] = useState<'select' | 'pay' | 'success'>('select');
  // 顶部卡片下的两个 tab:会员订阅 / 购买积分。初始值来自 openWallet() 指定的目标 tab。
  const [topTab, setTopTab] = useState<'subscription' | 'topup'>(getPendingWalletTab());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // ─── CNY 卡密充值 ───
  // 后端 /api/redeem/packages 返回档位 + 咸鱼地址。只有 packages 非空(运营在
  // admin 配了汇率+套餐)才在链选择器里露出「CNY 卡密」tab — 没配就完全隐藏,
  // 不打扰海外/未启用场景。cnySelected 为 true 时 select 步骤渲染卡密面板而非
  // 链上充值 grid。
  // lazy-init 卡密档位:先用 localStorage 缓存秒出(对齐 USDT/BNB),后台 fetch 静默覆盖。
  const [redeemInfo, setRedeemInfo] = useState<RedeemPackagesResponse | null>(() => readCachedRedeemInfo());
  // 国内版(HIDE_WEB3):默认直接进 CNY 卡密面板,链上充值(USDT/BNB)tab 整行隐藏。
  const [cnySelected, setCnySelected] = useState(HIDE_WEB3);
  const [redeemCodeInput, setRedeemCodeInput] = useState('');
  const [redeemMsg, setRedeemMsg] = useState<{ text: string; color: string }>({ text: '', color: '' });
  const [redeemBusy, setRedeemBusy] = useState(false);
  // v1.x: lazy-init profile from cache — without this, every nav into 我的充值
  // page would show no partner theming + no partner badge until /api/user/profile
  // round-trips finish, which user reported as "有时候连我是不是合伙人都加载
  // 不出来"。InviteView/CoworkView already do this; WalletView was the laggard.
  const [profile, setProfile] = useState<any>(() => readCachedProfile(authState.walletAddress));
  const [subPage, setSubPage] = useState<'main' | 'orderHistory' | 'noobCoinDetail' | 'creditDetail'>('main');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [searchOrderNo, setSearchOrderNo] = useState('');
  const [searchFrom, setSearchFrom] = useState('');
  const [searchTo, setSearchTo] = useState('');
  const [countdown, setCountdown] = useState('');
  const [isExpired, setIsExpired] = useState(false);
  const [copyToast, setCopyToast] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{ visible: boolean; title: string; message: string; onConfirm: () => void }>({ visible: false, title: '', message: '', onConfirm: () => {} });

  // NoobCoin detail state
  const [noobTab, setNoobTab] = useState<'earnings' | 'sends'>('earnings');
  const [noobStats, setNoobStats] = useState<any>({});
  const [noobEarnings, setNoobEarnings] = useState<any[]>([]);
  const [noobEarningsTotal, setNoobEarningsTotal] = useState(0);
  const [noobEarningsPage, setNoobEarningsPage] = useState(1);
  const [noobEarningsReason, setNoobEarningsReason] = useState('');
  const [noobEarningsFrom, setNoobEarningsFrom] = useState('');
  const [noobEarningsTo, setNoobEarningsTo] = useState('');
  const [noobSends, setNoobSends] = useState<any[]>([]);
  const [noobSendsTotal, setNoobSendsTotal] = useState(0);
  const [noobSendsPage, setNoobSendsPage] = useState(1);
  const [noobSendsFrom, setNoobSendsFrom] = useState('');
  const [noobSendsTo, setNoobSendsTo] = useState('');
  const [noobConfig, setNoobConfig] = useState<{ tokenSymbol: string; totalSupply: string; contractAddress: string; taxRate: string }>({ tokenSymbol: 'Noob', totalSupply: '1000000000', contractAddress: '', taxRate: '2' });
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarError, setAvatarError] = useState('');
  // v6.x: 我的充值页 balance row 加第 3 列 "收到返佣(USDT)" — 数字来自
  //   /api/me/rebate/summary。跟 InviteView 同一份 endpoint(那边也 prefetch
  //   同 endpoint 给顶部 USDT 总返佣 stat card 用),WalletView 自己单独 fetch
  //   保持组件解耦,不依赖 InviteView 是否已经挂载过。失败 fallback 显示 0。
  // v6.x: 同一 /api/me/rebate/summary 同时返 cny_* 字段,用来渲染「收到返佣 (CNY)」stat。
  const [usdtRebateSummary, setUsdtRebateSummary] = useState<{ total_earned: string; total_sent: string; total_inflight: string; total_pending: string; cny_total_earned?: string; cny_total_sent?: string; cny_total_inflight?: string; cny_total_pending?: string } | null>(null);
  // CNY 提现弹窗开关(stat 旁「提现」按钮触发;共享 CnyWithdrawModal)。
  const [showCnyWithdraw, setShowCnyWithdraw] = useState(false);
  const isZh = i18nService.currentLanguage === 'zh';

  // Credit detail state
  const [creditRecords, setCreditRecords] = useState<any[]>([]);
  const [creditTotal, setCreditTotal] = useState(0);
  const [creditStats, setCreditStats] = useState<any>({});
  const [creditPage, setCreditPage] = useState(1);
  const [creditFrom, setCreditFrom] = useState('');
  const [creditTo, setCreditTo] = useState('');
  const [creditLoading, setCreditLoading] = useState(false);
  // 明细 tab:all=全部 / spend=消耗 / earn=获得(参考即梦积分详情)
  const [creditKind, setCreditKind] = useState<'all' | 'spend' | 'earn'>('all');
  const creditLoadedRef = React.useRef(false);

  useEffect(() => {
    const unsub = noobClawAuth.subscribe(setAuthState);
    return unsub;
  }, []);

  // 顶部条/各处「订阅会员 / 购买积分」按钮:已在钱包页时也切到对应 tab。
  useEffect(() => {
    const onShow = () => setTopTab(getPendingWalletTab());
    window.addEventListener('noobclaw:show-wallet', onShow);
    return () => window.removeEventListener('noobclaw:show-wallet', onShow);
  }, []);

  useEffect(() => {
    if (authState.isAuthenticated) {
      loadData();
      noobClawAuth.refreshBalance();
    }
  }, [authState.isAuthenticated]);

  // v1.x: 之前这里挂了一个 15s setInterval 调 refreshBalance — 但只在 WalletView
  // 内有效。用户停在 InviteView/CoworkView/etc. 时不轮询,导致新到账的 BUSDT
  // 返佣 pendingRebates 永远没人拉,RebateDrawer 永远不弹(用户反馈"有佣金
  // 但抽屉没弹")。轮询已经提到 noobclawAuth 全局服务里,这里就不重复了 ——
  // 全局 15s 心跳 + WalletView mount 时再额外触发一次(上面的 effect)就够了。

  const loadData = async () => {
    // v1.x:之前用 Promise.all([...]) 一把等齐 4 个请求才 set 任何 state,
    // 导致只要 getOrderHistory 或 getNoobConfig 慢,套餐卡就要等到最慢的那个
    // 回来才能渲染(用户反馈"我的充值页加载很慢,官网很快")。
    // 官网那边各请求独立 set,快的先 paint,体感快得多。
    //
    // 现在四个请求并发发出(不再 await Promise.all),各自 .then 独立 set,
    // 谁先回谁先渲染。一个失败也不会拖垮其他三个。每个独立 catch 防止
    // unhandled promise rejection 污染 devtools。
    noobClawApi.getPaymentInfo().then((info) => {
      if (!info) return;  // network 失败时 fetch 通常返 null,保持 cache 渲染
      setPaymentInfo(info);
      writeCachedPaymentInfo(info);  // 下次进我的充值 lazy-init 直接拿,无需网络
      // Default the picker to TRON (USDT) when the backend reports it as
      // available — matches the website's product decision that stablecoin
      // deposit is the more discoverable first option for new users.
      if (info?.chains?.TRON) setCurrentChain('TRON');
    }).catch(() => { /* network/auth failure — keep showing cached info or "套餐加载中..." */ });

    // 充值记录是二级页(subPage='orderHistory'),用户点 "充值记录 →" 才进去,
    // 进去时会自己调 loadOrders('') 拉数据(见 main 页"充值记录"入口的 onClick)。
    // 之前在 loadData 里 eager fetch getOrderHistory 是死代码 + 拖慢首屏:
    //   1) 大多数用户不会进二级页,这条请求是纯浪费
    //   2) order history 比 payment info 大,慢的话拖累整页 paint
    //   3) orderTotal 这个 state 根本没人读(已随本次清掉)
    // 删除后:首次进我的充值少一个网络请求,二级页体验不变(进去时自己加载)。

    noobClawApi.getUserProfile().then((profileData) => {
      if (profileData) {
        setProfile(profileData);
        writeCachedProfile(authState.walletAddress, profileData);  // 下次进页面 lazy-init 直接拿,partner 主题秒应用
      }
    }).catch(() => { /* partner theming will degrade to default neon-green; everything else still works */ });

    noobClawApi.getNoobConfig().then((noobCfg) => {
      setNoobConfig(noobCfg);
    }).catch(() => { /* noob-related copy falls back to defaults */ });

    // v6.x: USDT 真金返佣 summary — 给 balance row 第 3 列 "收到返佣(USDT)" 用
    noobClawApi.getUsdtRebateSummary().then(s => { if (s) setUsdtRebateSummary(s); }).catch(() => {});

    // CNY 卡密档位 + 咸鱼地址。独立 fetch,packages 非空才在 UI 露出 CNY tab。
    noobClawApi.getRedeemPackages().then((info) => {
      if (info && info.packages && info.packages.length > 0) { setRedeemInfo(info); writeCachedRedeemInfo(info); }
    }).catch(() => { /* 没配卡密通道则 CNY tab 不显示,加密充值不受影响 */ });
  };

  const loadNoobEarnings = useCallback(async (page = 1, reason = '', from = '', to = '') => {
    const data = await noobClawApi.getNoobEarnings(page, 20, reason, from, to);
    setNoobEarnings(data.list);
    setNoobEarningsTotal(data.total);
    if (data.stats) setNoobStats(data.stats);
  }, []);

  const loadNoobSends = useCallback(async (page = 1, from = '', to = '') => {
    const data = await noobClawApi.getNoobSends(page, 20, from, to);
    setNoobSends(data.list);
    setNoobSendsTotal(data.total);
  }, []);

  const loadOrders = useCallback(async (status?: string, orderNo?: string, from?: string, to?: string) => {
    const data = await noobClawApi.getOrderHistory(status || undefined, orderNo || undefined, from || undefined, to || undefined);
    setOrderHistory(data.orders);
  }, []);

  // ─── CNY 卡密充值 handlers ───
  // 「去咸鱼购买」— 走 OS 默认浏览器打开咸鱼店铺;未配地址则在卡密提示区给 toast。
  const handleBuyOnXianyu = () => {
    const url = (redeemInfo?.xianyu_shop_url || '').trim();
    if (!url) {
      setRedeemMsg({ text: i18nService.t('walletRedeemXianyuMissing'), color: '#ef4444' });
      return;
    }
    window.electron?.shell?.openExternal(url);
  };

  // 卡密兑换 — 先 /preview 拉面额 → confirm 弹窗 → /redeem 真正核销 → 刷新余额。
  const handleSubmitRedeem = async () => {
    const code = redeemCodeInput.trim();
    if (!code) {
      setRedeemMsg({ text: i18nService.t('walletRedeemEmpty'), color: '#ef4444' });
      return;
    }
    setRedeemBusy(true);
    setRedeemMsg({ text: '', color: '' });
    try {
      const preview = await noobClawApi.previewRedeemCode(code);
      if (!preview || !preview.ok) {
        setRedeemMsg({ text: (preview && preview.message) || i18nService.t('walletRedeemPreviewFailed'), color: '#ef4444' });
        return;
      }
      const faceValue = preview.face_value_rmb ?? 0;
      const credits = preview.credits ?? 0;
      // 订阅码:确认弹窗显示「开通 进阶版·年付」而非积分数。其它(充值码)走原文案。
      const isSubCode = preview.product_type === 'subscription';
      const periodLabel: Record<string, string> = { month: '月付', quarter: '季付', half: '半年', year: '年付' };
      const confirmMessage = isSubCode
        ? `确认开通会员【${preview.plan_name || '会员'} · ${periodLabel[preview.plan_period || ''] || ''}】?(卡面价值 ¥${faceValue})`
        : i18nService.t('walletRedeemConfirmMsg', {
            rmb: String(faceValue),
            credits: Number(credits).toLocaleString(),
          });
      setConfirmDialog({
        visible: true,
        title: i18nService.t('walletRedeemConfirmTitle'),
        message: confirmMessage,
        onConfirm: async () => {
          setConfirmDialog(d => ({ ...d, visible: false }));
          setRedeemBusy(true);
          setRedeemMsg({ text: '', color: '' });
          try {
            const d = await noobClawApi.redeemCode(code);
            if (!d || !d.ok) {
              setRedeemMsg({ text: (d && d.message) || i18nService.t('walletRedeemFailed'), color: '#ef4444' });
              return;
            }
            setRedeemCodeInput('');
            setRedeemMsg({
              text: d.product_type === 'subscription'
                ? `✅ 会员已开通（${periodLabel[d.plan_period || ''] || ''}），本月算力已发放`
                : i18nService.t('walletRedeemSuccess', {
                    credits: Number(d.credits ?? 0).toLocaleString(),
                    rmb: String(d.face_value_rmb ?? 0),
                    balance: Number(d.balance_after ?? 0).toLocaleString(),
                  }),
              color: '#4ade80',
            });
            await noobClawAuth.refreshBalance();
          } finally {
            setRedeemBusy(false);
          }
        },
      });
    } finally {
      setRedeemBusy(false);
    }
  };

  // Countdown timer
  useEffect(() => {
    if (step !== 'pay' || !pendingCreatedAt) return;

    const tick = () => {
      const created = new Date(pendingCreatedAt).getTime();
      const remaining = created + ORDER_TIMEOUT_MS - Date.now();
      if (remaining <= 0) {
        setCountdown('0:00:00');
        setIsExpired(true);
        return;
      }
      setCountdown(formatCountdown(remaining));
      setIsExpired(false);
    };

    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [step, pendingCreatedAt]);

  // Poll order status
  useEffect(() => {
    if (step !== 'pay' || !pendingOrderNo || isExpired) return;
    const interval = setInterval(async () => {
      const result = await noobClawApi.pollOrderStatus(pendingOrderNo);
      if (result?.order?.status === 'completed') {
        await noobClawAuth.refreshBalance();
        setStep('success');
      } else if (result?.order?.status === 'expired' || result?.order?.status === 'cancelled') {
        setIsExpired(true);
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [step, pendingOrderNo, isExpired]);

  // v1.x: 合伙人在"我的充值"页也享受跟"邀请返佣"页一样的金/银/铜/钻石主题色
  // cascade。partnerColor 算法跟 InviteView 同一份(同一组 tier 颜色),通过
  // useEffect 设到 <body> 上,让 Sidebar(active 高亮)、scrollbar 都跟着换色。
  // 页面内部的卡片/按钮/数字用 .wallet-view--partner 局部 class 走全局
  // noobclaw-theme.css 里的 cascade 规则(跟 InviteView 一对兄弟,共享同一
  // 套 body.invite-partner-active CSS 变量)。
  const TIER_BODY_COLORS: Record<string, string> = {
    bronze: '#c46e2a', gold: '#fbbf24', platinum: '#dde4ef', diamond: '#22d3ee',
  };
  // tier emoji + 标签 — 跟 PartnerHero 的 TIER_VISUAL 同 source 同款,这样
  // wallet 顶部小徽章("👑 Gold ↗")的 emoji 跟 InviteView PartnerHero 视觉
  // 一致,用户在两页看到的是同一个等级标记。
  // v3.x: 'silver' enum 已 rename 成 'platinum'(DB + 代码统一)
  const TIER_BADGE: Record<string, { emoji: string; label: string }> = {
    bronze:   { emoji: '🥉', label: 'Bronze' },
    gold:     { emoji: '👑', label: 'Gold' },
    platinum: { emoji: '🏆', label: 'Platinum' },
    diamond:  { emoji: '💎', label: 'Diamond' },
  };
  const partnerColor: string | null = profile?.partner?.is_partner
    ? (TIER_BODY_COLORS[profile.partner.tier as string] || '#facc15')
    : null;
  const partnerBadge = profile?.partner?.is_partner
    ? (TIER_BADGE[profile.partner.tier as string] || TIER_BADGE.gold)
    : null;

  useEffect(() => {
    if (!partnerColor) return;
    const body = document.body;
    // 同 InviteView 用同一个 body class —— 这样 Sidebar/scrollbar 的 partner
    // 主题在两个页面之间无缝切换不闪烁。两个页面 mount/unmount 时各自加/删,
    // 同一时刻只会有一个页面挂载所以不冲突。
    body.classList.add('invite-partner-active');
    body.style.setProperty('--invite-partner-color', partnerColor);
    body.style.setProperty('--invite-partner-glow', partnerColor + '40');
    return () => {
      body.classList.remove('invite-partner-active');
      body.style.removeProperty('--invite-partner-color');
      body.style.removeProperty('--invite-partner-glow');
    };
  }, [partnerColor]);

  const handleSelectPackage = async (amount: number, chain: 'BSC' | 'TRON' = currentChain) => {
    setLoading(true);
    setError('');
    const result = await noobClawApi.createOrder(amount, chain);
    if (result?.order) {
      // TRON orders carry usdt_amount; BSC orders carry bnb_amount. Either
      // way, what we display on the pay screen is the unique-tail value
      // (already includes the matching tail).
      const order = result.order;
      const amountStr = chain === 'TRON'
        ? String(parseFloat(order.usdt_amount))
        : String(parseFloat(order.bnb_amount));
      setPendingOrderNo(order.order_no);
      setPendingAmount(amountStr);
      setPendingChain(chain);
      setPendingCreatedAt(order.created_at);
      setIsExpired(false);
      setStep('pay');
    } else if (result?.code === 'PENDING_LIMIT') {
      setError(i18nService.t('walletPendingLimitError'));
    } else if (result?.code === 'TRON_DISABLED') {
      setError('TRON deposit channel is not configured');
    } else {
      setError(result?.error || i18nService.t('walletCreateOrderFailed'));
    }
    setLoading(false);
  };

  // 订阅下单 → 复用下方同一套支付步骤(QR/倒计时/轮询)。返回错误串给 MembershipPanel 展示,null=已进支付。
  const startSubscriptionPay = async (
    planCode: string,
    period: 'month' | 'quarter' | 'half' | 'year',
    chain: 'BSC' | 'TRON',
  ): Promise<string | null> => {
    setError('');
    const result = await noobClawApi.createSubscriptionOrder(planCode, period, chain);
    if (result?.order) {
      const order = result.order;
      const amountStr = chain === 'TRON' ? String(parseFloat(order.usdt_amount)) : String(parseFloat(order.bnb_amount));
      setPendingOrderNo(order.order_no);
      setPendingAmount(amountStr);
      setPendingChain(chain);
      setPendingCreatedAt(order.created_at);
      setIsExpired(false);
      setStep('pay');
      return null;
    }
    if (result?.code === 'PENDING_LIMIT') return i18nService.t('walletPendingLimitError');
    if (result?.code === 'TRON_DISABLED') return 'USDT(TRON)通道未配置，请改用 BNB 或 CNY 兑换码';
    return result?.error || i18nService.t('walletCreateOrderFailed');
  };

  const doCancelOrder = async (orderNo: string) => {
    const result = await noobClawApi.cancelOrder(orderNo);
    if (result.success) {
      if (orderNo === pendingOrderNo && step === 'pay') {
        resetPayState();
      }
      loadOrders(statusFilter);
    }
  };

  const handleCancelOrder = (orderNo: string) => {
    setConfirmDialog({
      visible: true,
      title: i18nService.t('walletConfirmCancelTitle'),
      message: i18nService.t('walletConfirmCancelMessage'),
      onConfirm: () => { setConfirmDialog(d => ({ ...d, visible: false })); doCancelOrder(orderNo); },
    });
  };

  const handleBack = () => {
    setConfirmDialog({
      visible: true,
      title: i18nService.t('walletConfirmBackTitle'),
      message: i18nService.t('walletConfirmBackMessage'),
      onConfirm: () => { setConfirmDialog(d => ({ ...d, visible: false })); resetPayState(); },
    });
  };

  const handleViewPendingOrder = (order: any) => {
    const chain: 'BSC' | 'TRON' = (order.chain || 'BSC').toUpperCase() === 'TRON' ? 'TRON' : 'BSC';
    const amountStr = chain === 'TRON'
      ? String(parseFloat(order.usdt_amount))
      : String(parseFloat(order.bnb_amount));
    setPendingOrderNo(order.order_no);
    setPendingAmount(amountStr);
    setPendingChain(chain);
    setPendingCreatedAt(order.created_at);
    setIsExpired(false);
    setStep('pay');
    setSubPage('main');
    // Flip the active tab on the picker too so coming back to "Buy Credits"
    // lands on the matching chain.
    setCurrentChain(chain);
  };

  const resetPayState = () => {
    setStep('select');
    setError('');
    setPendingOrderNo('');
    setPendingAmount('');
    setPendingChain('BSC');
    setPendingCreatedAt('');
    setIsExpired(false);
    setCountdown('');
  };

  const handleAvatarUpload = async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/gif';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > 1 * 1024 * 1024) {
        setAvatarError(i18nService.t('walletFileSizeLimit'));
        return;
      }
      if (!['image/png', 'image/jpeg', 'image/gif'].includes(file.type)) {
        setAvatarError(i18nService.t('walletFileTypeLimit'));
        return;
      }
      setAvatarUploading(true);
      setAvatarError('');
      const result = await noobClawApi.uploadAvatar(file);
      if (result.avatarUrl) {
        noobClawAuth.setAvatarUrl(result.avatarUrl);
      } else {
        setAvatarError(result.error || 'Upload failed');
      }
      setAvatarUploading(false);
    };
    input.click();
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopyToast(true);
    setTimeout(() => setCopyToast(false), 2000);
  };

  const statusTabs = [
    { key: '', label: i18nService.t('walletStatusAll') },
    { key: 'pending', label: i18nService.t('walletStatusPending') },
    { key: 'completed', label: i18nService.t('walletStatusCompleted') },
    { key: 'cancelled', label: i18nService.t('walletStatusCancelled') },
    { key: 'expired', label: i18nService.t('walletStatusExpired') },
  ];

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
        {(subPage === 'orderHistory' || subPage === 'noobCoinDetail' || subPage === 'creditDetail') && (
          <button type="button" onClick={() => setSubPage('main')} className="non-draggable h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </button>
        )}
        <h1 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
          {subPage === 'orderHistory' ? i18nService.t('walletHistory') : subPage === 'noobCoinDetail' ? 'NoobCoin' : subPage === 'creditDetail' ? i18nService.t('walletCreditDetail') : i18nService.t('myWallet')}
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

  const walletAddr = authState.walletAddress || '';
  const balance = authState.tokenBalance;

  // ─── Confirm Dialog (shared) ───
  const confirmDialogEl = confirmDialog.visible ? (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="mx-6 w-full max-w-sm p-5 rounded-xl dark:bg-claude-darkSurface bg-white shadow-xl border dark:border-claude-darkBorder border-claude-border">
        <h3 className="text-sm font-bold dark:text-claude-darkText text-claude-text mb-2">{confirmDialog.title}</h3>
        <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-4 leading-relaxed">{confirmDialog.message}</p>
        <div className="flex gap-2">
          <button
            onClick={() => setConfirmDialog(d => ({ ...d, visible: false }))}
            className="flex-1 py-2 rounded-lg border dark:border-claude-darkBorder border-claude-border text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text transition-colors"
          >
            {i18nService.t('walletDialogCancel')}
          </button>
          <button
            onClick={confirmDialog.onConfirm}
            className="flex-1 py-2 rounded-lg bg-red-500 hover:bg-red-600 text-white text-sm font-medium transition-colors"
          >
            {i18nService.t('walletDialogConfirm')}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  // ─── Order History sub-page ───
  if (subPage === 'orderHistory') {
    return (
      <div
        className={`flex flex-col h-full dark:bg-claude-darkBg bg-claude-bg relative ${partnerColor ? 'wallet-view--partner' : ''}`}
        style={partnerColor ? ({
          '--invite-partner-color': partnerColor,
          '--invite-partner-glow': partnerColor + '40',
        } as React.CSSProperties) : undefined}
      >
        {header}
        {confirmDialogEl}

        {/* Status filter tabs */}
        <div className="flex gap-1 px-4 py-2 border-b dark:border-claude-darkBorder border-claude-border overflow-x-auto">
          {statusTabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => { setStatusFilter(tab.key); setSearchOrderNo(''); setSearchFrom(''); setSearchTo(''); loadOrders(tab.key); }}
              className={`px-3 py-1.5 text-xs rounded-lg whitespace-nowrap transition-colors ${
                statusFilter === tab.key
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Search filters */}
        <div className="px-4 py-2 border-b dark:border-claude-darkBorder border-claude-border space-y-2">
          <div className="flex gap-2 items-center">
            <input
              type="text"
              value={searchOrderNo}
              onChange={(e) => setSearchOrderNo(e.target.value)}
              placeholder={i18nService.t('walletOrderNo')}
              className="flex-1 px-2.5 py-1.5 text-xs rounded-lg dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border outline-none focus:ring-1 focus:ring-primary/50"
            />
          </div>
          <div className="flex gap-2 items-center">
            <input
              type="date"
              value={searchFrom}
              onChange={(e) => setSearchFrom(e.target.value)}
              className="flex-1 px-2.5 py-1.5 text-xs rounded-lg dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border outline-none focus:ring-1 focus:ring-primary/50 dark:[color-scheme:dark]"
            />
            <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">—</span>
            <input
              type="date"
              value={searchTo}
              onChange={(e) => setSearchTo(e.target.value)}
              className="flex-1 px-2.5 py-1.5 text-xs rounded-lg dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border outline-none focus:ring-1 focus:ring-primary/50 dark:[color-scheme:dark]"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => loadOrders(statusFilter, searchOrderNo, searchFrom ? `${searchFrom}T00:00:00` : '', searchTo ? `${searchTo}T23:59:59` : '')}
              className="px-3 py-1.5 text-xs rounded-lg bg-primary text-white hover:bg-primary/90 transition-colors"
            >
              {i18nService.t('walletSearch')}
            </button>
            <button
              onClick={() => { setSearchOrderNo(''); setSearchFrom(''); setSearchTo(''); loadOrders(statusFilter); }}
              className="px-3 py-1.5 text-xs rounded-lg dark:bg-claude-darkSurfaceHover bg-gray-100 dark:text-claude-darkTextSecondary text-claude-textSecondary hover:opacity-80 transition-colors"
            >
              {i18nService.t('walletClear')}
            </button>
          </div>
        </div>

        {/* Order List */}
        <div className="flex-1 overflow-y-auto p-4">
          {orderHistory.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 dark:text-claude-darkTextSecondary text-claude-textSecondary">
              <svg className="w-12 h-12 mb-3 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
              <p className="text-sm">{i18nService.t('inviteNoRecords')}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {orderHistory.map((order) => {
                const isPending = order.status === 'pending';
                const createdTime = new Date(order.created_at);
                const timeStr = createdTime.toLocaleDateString(i18nService.getDateLocale()) + ' ' +createdTime.toLocaleTimeString(i18nService.getDateLocale(), { hour: '2-digit', minute: '2-digit' });
                // CNY 卡密(redeem code)订单识别:跟 BNB/USDT 链上订单完全不同的支付方式,
                // 不能拿 chain 来推单位(老逻辑把卡密订单全显示成 "— BNB",已被用户截图实锤误导)。
                // 4 重兜底(任一命中就判作 CNY 卡密),应对后端字段命名不固定:
                //   1) order.payment_method === 'redeem'(后端最可能加的字段)
                //   2) order.kind === 'redeem'(备选命名)
                //   3) order_no 以 RD 开头(redeem code 兑换订单实测前缀,如 RD1781083633513EEK8B)
                //   4) bnb_amount 和 usdt_amount 都为 null(卡密没链上资产,这两字段都 NULL)
                const orderNo = String(order.order_no || '');
                const isRedeem = order.payment_method === 'redeem'
                  || order.kind === 'redeem'
                  || /^RD/i.test(orderNo)
                  || (order.bnb_amount == null && order.usdt_amount == null);
                // Chain-aware amount + unit. BSC orders carry bnb_amount,
                // TRON orders carry usdt_amount (the other is NULL). Legacy
                // BSC rows without a chain field default to 'BSC'.
                const orderChain: 'BSC' | 'TRON' = (order.chain || 'BSC').toUpperCase() === 'TRON' ? 'TRON' : 'BSC';
                const orderAmount = orderChain === 'TRON'
                  ? (order.usdt_amount != null ? parseFloat(order.usdt_amount).toFixed(6) : '—')
                  : (order.bnb_amount != null ? parseFloat(order.bnb_amount).toFixed(6) : '—');
                const orderUnit = orderChain === 'TRON' ? 'USDT' : 'BNB';
                // 卡密订单优先显示「¥金额」(后端常用字段:rmb_amount / face_value_rmb / amount_cny),
                // 都没有就只显示「CNY 卡密」标签(避免出现误导性的 BNB / USDT 单位)。
                const rmbAmount = isRedeem
                  ? (order.rmb_amount ?? order.face_value_rmb ?? order.amount_cny ?? null)
                  : null;
                // 订阅订单:展示「档位 · 时长」(plan_name 后端 join 下发、plan_period 本地映射标签),
                // 并隐藏无意义的积分数(订阅订单 tokens_purchased 恒为 0)。总价仍走上面的金额显示(BNB/USDT/¥)。
                const isSub = order.product_type === 'subscription';
                const subPeriodLabel: Record<string, string> = { month: '月付', quarter: '季付', half: '半年', year: '年付' };
                const subLabel = isSub
                  ? `${order.plan_name || order.plan_code || '会员'}${order.plan_period ? ' · ' + (subPeriodLabel[order.plan_period] || order.plan_period) : ''}`
                  : '';

                return (
                  <div key={order.id} className="p-3.5 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
                    <div className="flex items-start justify-between mb-2">
                      <div>
                        <code className="text-xs font-mono dark:text-claude-darkTextSecondary text-claude-textSecondary">{order.order_no}</code>
                        <div className="flex items-center gap-1.5 text-sm font-medium dark:text-claude-darkText text-claude-text mt-1">
                          {isRedeem ? (
                            // CNY 卡密:🎟️ 图标 + 「CNY 卡密」标签 + 可选金额(¥xx)
                            <>
                              <span className="text-base leading-none">🎟️</span>
                              <span>{i18nService.t('walletRedeemTab')}</span>
                              {rmbAmount != null && <span>· ¥{Number(rmbAmount).toFixed(0)}</span>}
                            </>
                          ) : (
                            // 链上充值:ChainLogo + 金额 + 单位(BNB / USDT)
                            <>
                              <ChainLogo chain={orderChain} size={14} />
                              {orderAmount} {orderUnit}
                            </>
                          )}
                          {isSub ? (
                            <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary font-normal"> · {subLabel}</span>
                          ) : (
                            <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary font-normal"> · {(order.tokens_purchased / 1_000_000).toFixed(1)}{i18nService.t('walletMTokenUnit')}</span>
                          )}
                        </div>
                      </div>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${getStatusColor(order.status)}`}>
                        {getStatusLabel(order.status)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{timeStr}</span>
                      {isPending && (
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handleViewPendingOrder(order)}
                            className="text-xs px-2.5 py-1 rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                          >
                            {i18nService.t('walletPayNow')}
                          </button>
                          <button
                            onClick={() => handleCancelOrder(order.order_no)}
                            className="text-xs px-2.5 py-1 rounded-lg dark:bg-claude-darkSurfaceHover bg-gray-100 dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-red-400 transition-colors"
                          >
                            {i18nService.t('walletCancelOrder')}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ─── Credit Usage Detail sub-page ───
  if (subPage === 'creditDetail') {
    const PAGE_SIZE = 20;
    const creditTotalPages = Math.ceil(creditTotal / PAGE_SIZE) || 1;

    const loadCreditHistory = async (pg: number, from: string, to: string, kind: 'all' | 'spend' | 'earn' = creditKind) => {
      setCreditLoading(true);
      try {
        const data = await noobClawApi.getCreditHistory(pg, PAGE_SIZE, from, to, kind);
        setCreditRecords(data.list);
        setCreditTotal(data.total);
        setCreditStats(data.stats || {});
        setCreditPage(pg);
      } catch {}
      setCreditLoading(false);
    };

    // Auto-load (once only — ref prevents infinite loop on empty results)
    if (!creditLoadedRef.current && !creditLoading) {
      creditLoadedRef.current = true;
      loadCreditHistory(1, '', '', 'all');
    }

    // 切 tab:重置到第 1 页,按 kind 重新拉(保留日期筛选)。
    const switchKind = (k: 'all' | 'spend' | 'earn') => {
      if (k === creditKind) return;
      setCreditKind(k);
      loadCreditHistory(1, creditFrom, creditTo, k);
    };

    const formatTokens = (n: number) => {
      if (!n) return '0';
      if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
      if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
      return String(n);
    };

    return (
      <div
        className={`flex flex-col h-full dark:bg-claude-darkBg bg-claude-bg relative ${partnerColor ? 'wallet-view--partner' : ''}`}
        style={partnerColor ? ({
          '--invite-partner-color': partnerColor,
          '--invite-partner-glow': partnerColor + '40',
        } as React.CSSProperties) : undefined}
      >
        {header}
        <div className="flex-1 overflow-y-auto p-5 max-w-3xl mx-auto w-full space-y-4">

          {/* Back + Title */}
          <div className="flex items-center gap-2 mb-2">
            <button onClick={() => setSubPage('main')} className="p-1 rounded-lg hover:dark:bg-claude-darkSurface hover:bg-claude-surface transition-colors">
              <svg className="w-5 h-5 dark:text-claude-darkTextSecondary text-claude-textSecondary" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
            </button>
            <h2 className="text-base font-bold dark:text-claude-darkText text-claude-text">{i18nService.t('walletCreditDetail')}</h2>
          </div>

          {/* 分桶头:剩余积分 = 订阅积分 + 充值积分(参考即梦积分详情) */}
          <div className="rounded-2xl p-4 dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
            <div className="flex items-center flex-wrap gap-x-3 gap-y-2">
              <div>
                <p className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary mb-0.5">剩余积分</p>
                <p className="text-2xl font-extrabold text-primary leading-none">{formatTokens(authState.tokenBalance)}</p>
              </div>
              <span className="text-lg dark:text-claude-darkTextSecondary text-claude-textSecondary">=</span>
              <div>
                <p className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary mb-0.5">订阅积分</p>
                <p className="text-lg font-bold dark:text-claude-darkText text-claude-text leading-none">{formatTokens(authState.subCredits)}</p>
              </div>
              <span className="text-lg dark:text-claude-darkTextSecondary text-claude-textSecondary">+</span>
              <div>
                <p className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary mb-0.5">充值积分</p>
                <p className="text-lg font-bold dark:text-claude-darkText text-claude-text leading-none">{formatTokens(authState.paidBalance)}</p>
              </div>
            </div>
            <p className="mt-2 text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">订阅积分按月发放、到期清零;充值积分永久有效。</p>
          </div>

          {/* Stats Grid */}
          <div className="grid grid-cols-4 gap-2">
            {[
              { label: i18nService.t('walletCreditTotalUsed'), value: formatTokens(creditStats.totalUsed) },
              { label: i18nService.t('walletCreditTodayUsed'), value: formatTokens(creditStats.todayUsed) },
              { label: i18nService.t('walletCreditLast7d'), value: formatTokens(creditStats.last7dUsed) },
              { label: i18nService.t('walletCreditLast30d'), value: formatTokens(creditStats.last30dUsed) },
            ].map((s, i) => (
              <div key={i} className="rounded-xl p-3 dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border text-center">
                <p className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">{s.label}</p>
                <p className="text-sm font-bold text-primary">{s.value}</p>
              </div>
            ))}
          </div>

          {/* Date Filters */}
          <div className="flex gap-2 items-center">
            <input type="date" value={creditFrom} onChange={e => setCreditFrom(e.target.value)}
              className="flex-1 px-2 py-1.5 text-xs rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text" />
            <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">–</span>
            <input type="date" value={creditTo} onChange={e => setCreditTo(e.target.value)}
              className="flex-1 px-2 py-1.5 text-xs rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text" />
            <button onClick={() => loadCreditHistory(1, creditFrom, creditTo)}
              className="px-3 py-1.5 text-xs rounded-lg bg-primary text-black font-medium hover:bg-primary/80 transition-colors">
              {i18nService.t('walletView')}
            </button>
          </div>

          {/* Tabs:全部 / 消耗 / 获得 */}
          <div className="flex gap-1 p-1 rounded-lg dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
            {([['all', '全部'], ['spend', '消耗'], ['earn', '获得']] as Array<['all' | 'spend' | 'earn', string]>).map(([k, label]) => (
              <button key={k} onClick={() => switchKind(k)}
                className={`flex-1 py-1.5 rounded-md text-xs font-semibold transition-all ${creditKind === k ? 'bg-primary/15 text-primary' : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'}`}>
                {label}
              </button>
            ))}
          </div>

          {/* Records List */}
          <div className="space-y-1.5">
            {creditRecords.length === 0 && !creditLoading && (
              <p className="text-center text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary py-8">{i18nService.t('walletCreditNoRecords')}</p>
            )}
            {creditRecords.map((r: any, idx: number) => {
              // amount 带符号:消耗为负(橙)、获得为正(绿)。兼容老客户端缺 amount 的行(按消耗处理)。
              const amt = typeof r.amount === 'number' ? r.amount : -(r.billable_tokens ?? r.total_tokens ?? 0);
              const isEarn = amt > 0;
              const isUsage = r.type === 'usage' || (r.type == null && amt < 0);
              return (
                <div key={idx} className="flex items-center justify-between p-3 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className="text-xs font-medium dark:text-claude-darkText text-claude-text truncate">{r.model || '积分变动'}</p>
                      {r.bucketLabel && <span className="px-1 py-0.5 rounded text-[9px] font-semibold shrink-0" style={{ background: '#a78bfa22', color: '#a78bfa' }}>{r.bucketLabel}</span>}
                    </div>
                    {/* 消耗行才显示输入/输出 breakdown;获得/清零行无 token 拆分 */}
                    {isUsage && (r.prompt_tokens || r.completion_tokens) ? (
                      <p className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary mt-0.5">
                        {i18nService.t('walletCreditPrompt')}: {formatTokens(r.prompt_tokens)} · {i18nService.t('walletCreditCompletion')}: {formatTokens(r.completion_tokens)}
                      </p>
                    ) : null}
                  </div>
                  <div className="text-right ml-3 flex-shrink-0">
                    <p className={`text-sm font-bold ${isEarn ? 'text-green-500' : 'text-orange-400'}`}>
                      {isEarn ? '+' : '-'}{formatTokens(Math.abs(amt))}
                    </p>
                    <p className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary mt-0.5">
                      {new Date(r.created_at).toLocaleString()}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Pagination */}
          {creditTotalPages > 1 && (
            <div className="flex items-center justify-center gap-2 pt-2">
              <button disabled={creditPage <= 1} onClick={() => loadCreditHistory(creditPage - 1, creditFrom, creditTo)}
                className="px-3 py-1 text-xs rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary disabled:opacity-30 hover:text-primary hover:border-primary/40 transition-colors">
                ←
              </button>
              <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{creditPage} / {creditTotalPages}</span>
              <button disabled={creditPage >= creditTotalPages} onClick={() => loadCreditHistory(creditPage + 1, creditFrom, creditTo)}
                className="px-3 py-1 text-xs rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary disabled:opacity-30 hover:text-primary hover:border-primary/40 transition-colors">
                →
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ─── NoobCoin Detail sub-page ───
  if (subPage === 'noobCoinDetail') {
    const PAGE_SIZE = 20;
    const earningsTotalPages = Math.ceil(noobEarningsTotal / PAGE_SIZE) || 1;
    const sendsTotalPages = Math.ceil(noobSendsTotal / PAGE_SIZE) || 1;

    const reasonLabels: Record<string, string> = {
      referral_bonus: i18nService.t('walletReasonReferralBonus'),
      purchase_bonus: i18nService.t('walletReasonPurchaseBonus'),
      lucky_bag: i18nService.t('walletReasonLuckyBag'),
    };

    // Auto-load on mount
    if (noobEarnings.length === 0 && noobEarningsTotal === 0 && !noobStats.totalEarned && noobStats.totalEarned !== 0) {
      loadNoobEarnings(1, '', '', '');
    }

    return (
      <div
        className={`flex flex-col h-full dark:bg-claude-darkBg bg-claude-bg relative ${partnerColor ? 'wallet-view--partner' : ''}`}
        style={partnerColor ? ({
          '--invite-partner-color': partnerColor,
          '--invite-partner-glow': partnerColor + '40',
        } as React.CSSProperties) : undefined}
      >
        {header}
        {copyToast && (
          <div className="absolute top-16 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-primary text-black text-xs font-medium shadow-lg animate-fade-in">
            {i18nService.t('walletCopiedToClipboard')}
          </div>
        )}
        <div className="flex-1 overflow-y-auto p-5 max-w-3xl mx-auto w-full space-y-4">

          {/* Intro card */}
          <div className="rounded-2xl overflow-hidden border dark:border-primary/20 border-primary/15 shadow-lg" style={{ background: 'linear-gradient(145deg, rgba(74,222,128,0.12) 0%, rgba(74,222,128,0.03) 50%, rgba(74,222,128,0.08) 100%)' }}>
            {/* Header: Logo + Name + Symbol */}
            <div className="p-5 pb-4">
              <div className="flex items-center gap-3.5 mb-4">
                <div className="relative">
                  <img src="logo.png" alt="NoobCoin" className="w-14 h-14 rounded-2xl shadow-lg ring-2 ring-primary/30" />
                  <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-primary flex items-center justify-center shadow-md">
                    <svg className="w-3 h-3 text-black" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>
                  </div>
                </div>
                <div>
                  <h2 className="text-xl font-bold dark:text-claude-darkText text-claude-text tracking-tight">NoobCoin</h2>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xs font-mono font-semibold text-primary bg-primary/10 px-1.5 py-0.5 rounded">${noobConfig.tokenSymbol}</span>
                    <span className="text-[10px] dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60">BSC (BEP-20)</span>
                  </div>
                </div>
              </div>

              {/* Description */}
              <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary leading-relaxed">
                {i18nService.t('walletNoobCoinDesc')}
              </p>
            </div>

            {/* Divider */}
            <div className="mx-5 border-t dark:border-primary/10 border-primary/10" />

            {/* Token Info Grid */}
            <div className="p-5 pt-4 grid grid-cols-2 gap-3">
              <div className="p-3 rounded-xl dark:bg-black/25 bg-white/70 backdrop-blur-sm border dark:border-white/5 border-black/5">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <svg className="w-3 h-3 text-primary/60" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z" /></svg>
                  <p className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('walletTokenSymbol')}</p>
                </div>
                <p className="text-sm font-bold dark:text-claude-darkText text-claude-text">{noobConfig.tokenSymbol}</p>
              </div>
              <div className="p-3 rounded-xl dark:bg-black/25 bg-white/70 backdrop-blur-sm border dark:border-white/5 border-black/5">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <svg className="w-3 h-3 text-primary/60" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg>
                  <p className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('walletTotalSupply')}</p>
                </div>
                <p className="text-sm font-bold dark:text-claude-darkText text-claude-text">{Number(noobConfig.totalSupply).toLocaleString()}</p>
              </div>
              <div className="p-3 rounded-xl dark:bg-black/25 bg-white/70 backdrop-blur-sm border dark:border-white/5 border-black/5 col-span-2">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <svg className="w-3 h-3 text-primary/60" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
                  <p className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('walletContractAddress')}</p>
                </div>
                <div className="flex items-center gap-2">
                  <code className="text-[11px] font-mono dark:text-claude-darkText text-claude-text truncate flex-1">
                    {noobConfig.contractAddress || i18nService.t('walletTBD')}
                  </code>
                  {noobConfig.contractAddress && (
                    <button
                      onClick={() => copyToClipboard(noobConfig.contractAddress)}
                      className="shrink-0 p-1.5 rounded-lg hover:bg-primary/15 active:bg-primary/25 transition-colors group"
                      title={i18nService.t('walletCopy')}
                    >
                      <svg className="w-3.5 h-3.5 dark:text-claude-darkTextSecondary text-claude-textSecondary group-hover:text-primary transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" strokeWidth={2}/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" strokeWidth={2}/></svg>
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Feature highlight */}
            <div className="mx-5 mb-4 p-3 rounded-xl bg-primary/8 border border-primary/15">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-xs font-bold text-primary">{noobConfig.taxRate}% {i18nService.t('walletTaxToken')}</span>
              </div>
              <p className="text-[11px] dark:text-claude-darkTextSecondary/80 text-claude-textSecondary/80 leading-relaxed">
                {i18nService.t('walletTaxDesc', { taxRate: noobConfig.taxRate })}
              </p>
            </div>

            {/* Footer link */}
            <div className="px-5 pb-4">
              <button
                onClick={() => window.electron?.shell?.openExternal('https://noobclaw.com')}
                className="text-xs text-primary hover:text-primary/80 hover:underline transition-colors flex items-center gap-1"
              >
                {i18nService.t('walletSeeWebsite')}
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
              </button>
            </div>
          </div>

          {/* Stats cards */}
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: i18nService.t('walletStatTotalEarned'), value: noobStats.totalEarned || 0, color: 'text-white' },
              { label: i18nService.t('walletStatReferral'), value: noobStats.referralEarned || 0, color: 'text-purple-400' },
              { label: i18nService.t('walletStatLuckyBag'), value: noobStats.luckyBagEarned || 0, color: 'text-orange-400' },
              { label: i18nService.t('walletStatPurchase'), value: noobStats.purchaseEarned || 0, color: 'text-sky-400' },
              { label: i18nService.t('walletStatOnChainSent'), value: noobStats.totalSent || 0, color: 'text-green-400' },
              { label: i18nService.t('walletStatOnChainPending'), value: noobStats.pending || 0, color: 'text-yellow-400' },
            ].map((s, i) => (
              <div key={i} className="p-3 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
                <p className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1 truncate">{s.label}</p>
                <p className={`text-sm font-bold ${s.color}`}>{Number(s.value).toLocaleString()}</p>
              </div>
            ))}
          </div>

          {/* Tabs */}
          <div className="flex gap-1 border-b dark:border-claude-darkBorder border-claude-border">
            {([
              { key: 'earnings' as const, label: i18nService.t('walletTabEarnings') },
              { key: 'sends' as const, label: i18nService.t('walletTabSends') },
            ]).map(tab => (
              <button
                key={tab.key}
                onClick={() => {
                  setNoobTab(tab.key);
                  if (tab.key === 'earnings') { setNoobEarningsPage(1); loadNoobEarnings(1, noobEarningsReason, noobEarningsFrom, noobEarningsTo); }
                  else { setNoobSendsPage(1); loadNoobSends(1, noobSendsFrom, noobSendsTo); }
                }}
                className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${
                  noobTab === tab.key
                    ? 'border-primary text-primary'
                    : 'border-transparent dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-primary'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Earnings tab */}
          {noobTab === 'earnings' && (
            <div className="space-y-3">
              {/* Filters */}
              <div className="flex flex-wrap gap-2 items-center">
                <select
                  value={noobEarningsReason}
                  onChange={e => setNoobEarningsReason(e.target.value)}
                  className="text-xs px-2.5 py-1.5 rounded-lg dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text"
                >
                  <option value="">{i18nService.t('walletFilterAllTypes')}</option>
                  <option value="referral_bonus">{i18nService.t('walletFilterReferral')}</option>
                  <option value="purchase_bonus">{i18nService.t('walletFilterPurchase')}</option>
                  <option value="lucky_bag">{i18nService.t('walletFilterLuckyBag')}</option>
                </select>
                <input type="date" value={noobEarningsFrom} onChange={e => setNoobEarningsFrom(e.target.value)}
                  className="text-xs px-2 py-1.5 rounded-lg dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text" />
                <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">~</span>
                <input type="date" value={noobEarningsTo} onChange={e => setNoobEarningsTo(e.target.value)}
                  className="text-xs px-2 py-1.5 rounded-lg dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text" />
                <button
                  onClick={() => { setNoobEarningsPage(1); loadNoobEarnings(1, noobEarningsReason, noobEarningsFrom, noobEarningsTo); }}
                  className="text-xs px-3 py-1.5 rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                >
                  {i18nService.t('walletSearch')}
                </button>
                <button
                  onClick={() => { setNoobEarningsReason(''); setNoobEarningsFrom(''); setNoobEarningsTo(''); setNoobEarningsPage(1); loadNoobEarnings(1, '', '', ''); }}
                  className="text-xs px-3 py-1.5 rounded-lg dark:bg-claude-darkSurfaceHover bg-gray-100 dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText transition-colors"
                >
                  {i18nService.t('walletClear')}
                </button>
              </div>

              {/* List */}
              {noobEarnings.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  <svg className="w-10 h-10 mb-2 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
                  <p className="text-sm">{i18nService.t('walletNoRecords')}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {noobEarnings.map((record: any, idx: number) => {
                    const time = new Date(record.created_at);
                    const timeStr = time.toLocaleDateString(i18nService.getDateLocale()) + ' ' +time.toLocaleTimeString(i18nService.getDateLocale(), { hour: '2-digit', minute: '2-digit' });
                    return (
                      <div key={idx} className="p-3 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-medium text-primary">+{Number(record.noob_amount).toLocaleString()} $NOOB</span>
                          <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{timeStr}</span>
                        </div>
                        <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{reasonLabels[record.reason] || record.reason}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Pagination */}
              {earningsTotalPages > 1 && (
                <div className="flex items-center justify-center gap-3 pt-2">
                  <button
                    disabled={noobEarningsPage <= 1}
                    onClick={() => { const p = noobEarningsPage - 1; setNoobEarningsPage(p); loadNoobEarnings(p, noobEarningsReason, noobEarningsFrom, noobEarningsTo); }}
                    className="text-xs px-3 py-1.5 rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary disabled:opacity-30 hover:text-primary transition-colors"
                  >
                    ‹ {i18nService.t('walletPrev')}
                  </button>
                  <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{noobEarningsPage} / {earningsTotalPages}</span>
                  <button
                    disabled={noobEarningsPage >= earningsTotalPages}
                    onClick={() => { const p = noobEarningsPage + 1; setNoobEarningsPage(p); loadNoobEarnings(p, noobEarningsReason, noobEarningsFrom, noobEarningsTo); }}
                    className="text-xs px-3 py-1.5 rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary disabled:opacity-30 hover:text-primary transition-colors"
                  >
                    {i18nService.t('walletNext')} ›
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Sends tab */}
          {noobTab === 'sends' && (
            <div className="space-y-3">
              {/* Filters */}
              <div className="flex flex-wrap gap-2 items-center">
                <input type="date" value={noobSendsFrom} onChange={e => setNoobSendsFrom(e.target.value)}
                  className="text-xs px-2 py-1.5 rounded-lg dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text" />
                <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">~</span>
                <input type="date" value={noobSendsTo} onChange={e => setNoobSendsTo(e.target.value)}
                  className="text-xs px-2 py-1.5 rounded-lg dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text" />
                <button
                  onClick={() => { setNoobSendsPage(1); loadNoobSends(1, noobSendsFrom, noobSendsTo); }}
                  className="text-xs px-3 py-1.5 rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                >
                  {i18nService.t('walletSearch')}
                </button>
                <button
                  onClick={() => { setNoobSendsFrom(''); setNoobSendsTo(''); setNoobSendsPage(1); loadNoobSends(1, '', ''); }}
                  className="text-xs px-3 py-1.5 rounded-lg dark:bg-claude-darkSurfaceHover bg-gray-100 dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText transition-colors"
                >
                  {i18nService.t('walletClear')}
                </button>
              </div>

              {/* List */}
              {noobSends.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  <svg className="w-10 h-10 mb-2 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
                  <p className="text-sm">{i18nService.t('walletNoRecords')}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {noobSends.map((record: any, idx: number) => {
                    const time = new Date(record.created_at);
                    const timeStr = time.toLocaleDateString(i18nService.getDateLocale()) + ' ' +time.toLocaleTimeString(i18nService.getDateLocale(), { hour: '2-digit', minute: '2-digit' });
                    return (
                      <div key={idx} className="p-3 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-medium text-green-400">+{Number(record.noob_amount).toLocaleString()} $NOOB</span>
                          <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{timeStr}</span>
                        </div>
                        {record.tx_hash && (
                          <button
                            type="button"
                            className="text-xs text-primary hover:underline font-mono truncate max-w-full text-left"
                            onClick={() => window.electron?.shell?.openExternal(`https://bscscan.com/tx/${record.tx_hash}`)}
                          >
                            TX: {record.tx_hash.slice(0, 10)}...{record.tx_hash.slice(-8)}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Pagination */}
              {sendsTotalPages > 1 && (
                <div className="flex items-center justify-center gap-3 pt-2">
                  <button
                    disabled={noobSendsPage <= 1}
                    onClick={() => { const p = noobSendsPage - 1; setNoobSendsPage(p); loadNoobSends(p, noobSendsFrom, noobSendsTo); }}
                    className="text-xs px-3 py-1.5 rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary disabled:opacity-30 hover:text-primary transition-colors"
                  >
                    ‹ {i18nService.t('walletPrev')}
                  </button>
                  <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{noobSendsPage} / {sendsTotalPages}</span>
                  <button
                    disabled={noobSendsPage >= sendsTotalPages}
                    onClick={() => { const p = noobSendsPage + 1; setNoobSendsPage(p); loadNoobSends(p, noobSendsFrom, noobSendsTo); }}
                    className="text-xs px-3 py-1.5 rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary disabled:opacity-30 hover:text-primary transition-colors"
                  >
                    {i18nService.t('walletNext')} ›
                  </button>
                </div>
              )}
            </div>
          )}

        </div>
      </div>
    );
  }

  // ─── Main page ───
  return (
    <div
      className={`flex flex-col h-full dark:bg-claude-darkBg bg-claude-bg relative ${partnerColor ? 'wallet-view--partner' : ''}`}
      style={partnerColor ? ({
        '--invite-partner-color': partnerColor,
        '--invite-partner-glow': partnerColor + '40',
      } as React.CSSProperties) : undefined}
    >
      {/* Inline scoped <style> 三重保险 — 即使外部 noobclaw-theme.css 没加载
          或被覆盖,这块 inline CSS 也能保证按钮 / tab / 边框 / 文字跟 tier 走 */}
      {partnerColor && (
        <style>{`
          .wallet-view--partner .text-primary { color: var(--invite-partner-color) !important; }
          .wallet-view--partner .bg-primary { background-color: var(--invite-partner-color) !important; color:#0a0a0a !important; }
          .wallet-view--partner .bg-primary:hover { background-color: var(--invite-partner-color) !important; filter:brightness(0.92); }
          .wallet-view--partner .bg-primary\\/5  { background-color: color-mix(in srgb, var(--invite-partner-color) 6%, transparent) !important; }
          .wallet-view--partner .bg-primary\\/10 { background-color: color-mix(in srgb, var(--invite-partner-color) 10%, transparent) !important; }
          .wallet-view--partner .bg-primary\\/15 { background-color: color-mix(in srgb, var(--invite-partner-color) 15%, transparent) !important; }
          .wallet-view--partner .bg-primary\\/20 { background-color: color-mix(in srgb, var(--invite-partner-color) 20%, transparent) !important; }
          .wallet-view--partner .border-primary { border-color: var(--invite-partner-color) !important; }
          .wallet-view--partner .border-primary\\/20 { border-color: color-mix(in srgb, var(--invite-partner-color) 28%, transparent) !important; }
          .wallet-view--partner .focus\\:border-primary:focus { border-color: var(--invite-partner-color) !important; }
          .wallet-view--partner .hover\\:bg-primary-hover:hover { background-color: var(--invite-partner-color) !important; filter:brightness(1.08); }
        `}</style>
      )}
      {header}
      {copyToast && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-primary text-black text-xs font-medium shadow-lg animate-fade-in">
          {i18nService.t('walletCopiedToClipboard')}
        </div>
      )}
      {confirmDialogEl}
      <div className="flex-1 overflow-y-auto p-5 max-w-3xl mx-auto w-full space-y-4">

        {/* v6.x: 我的充值页顶部不再放 PartnerApplyCard — 用户反馈"充值中心顶部
            应该先看到充值,返佣比例是次要信息"。改成 balance row 第 3 列
            "收到返佣(USDT)" 展示数字 + 查看链接跳邀请页(包括引导申请合伙人)。 */}

        {/* Wallet Header */}
        {/* v1.x: 合伙人 VIP 视觉框 — 跟 InviteView 顶部 PartnerHero 同一套:
            conic 旋转金边 + 4s shimmer 光带 + 6 个 sparkle 粒子 + ✦ VIP ✦
            角标。普通用户 partnerColor=null,整段 effects 不渲染,体验跟从
            前一样;合伙人多了一圈 VIP 氛围。 */}
        <div className="relative overflow-hidden p-4 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
          {partnerColor && (
            <>
              {/* Conic gradient rotating border ring */}
              <div className="absolute pointer-events-none" style={{
                inset: -2,
                borderRadius: 14,
                padding: 2,
                background: `conic-gradient(from 0deg, transparent 0%, var(--invite-partner-color) 20%, transparent 40%, transparent 60%, var(--invite-partner-color) 80%, transparent 100%)`,
                WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
                WebkitMaskComposite: 'xor',
                maskComposite: 'exclude' as React.CSSProperties['maskComposite'],
                animation: 'partner-frame-conic 6s linear infinite',
                opacity: 0.55,
                zIndex: 0,
              }} />
              {/* Shimmer light beam — 横向 4s 周期 */}
              <div className="absolute inset-0 pointer-events-none" style={{
                background: `linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--invite-partner-color) 18%, transparent) 50%, transparent 100%)`,
                animation: 'partner-frame-shimmer 4s ease-in-out infinite',
                zIndex: 0,
              }} />
              {/* 6 个 sparkle 粒子 — 错开 delay,各自 twinkle */}
              {[
                { top: '12%', left: '6%',  delay: '0s'   },
                { top: '74%', left: '14%', delay: '1.4s' },
                { top: '28%', left: '46%', delay: '2.5s' },
                { top: '60%', left: '68%', delay: '0.7s' },
                { top: '18%', left: '88%', delay: '1.9s' },
                { top: '82%', left: '94%', delay: '2.7s' },
              ].map((p, i) => (
                <span key={i} className="absolute pointer-events-none" style={{
                  top: p.top, left: p.left,
                  width: 5, height: 5, borderRadius: '50%',
                  background: `radial-gradient(circle, var(--invite-partner-color) 0%, transparent 70%)`,
                  animation: 'partner-frame-spark 3s ease-in-out infinite',
                  animationDelay: p.delay,
                  zIndex: 0,
                }} />
              ))}
              {/* ✦ VIP ✦ 角标 — 右上角金色胶囊 */}
              <div className="absolute font-bold pointer-events-none" style={{
                top: 6, right: 10, fontSize: 9, letterSpacing: 2,
                padding: '2px 8px', borderRadius: 10,
                background: `linear-gradient(135deg, var(--invite-partner-color), color-mix(in srgb, var(--invite-partner-color) 100%, black 40%))`,
                color: '#0a0a0a',
                boxShadow: `0 0 8px var(--invite-partner-glow)`,
                zIndex: 5,
              }}>✦ VIP ✦</div>
            </>
          )}

          {/* Avatar + Wallet Info — 所有原内容包一层 relative z-10 让它压在
              effects 之上 */}
          <div className="relative z-10">
          <div className="flex items-center gap-4 mb-4">
            <div className="relative group shrink-0">
              <button
                type="button"
                onClick={handleAvatarUpload}
                disabled={avatarUploading}
                className="relative w-16 h-16 rounded-full overflow-hidden border-2 dark:border-claude-darkBorder border-claude-border hover:border-primary/50 transition-colors cursor-pointer"
                title={i18nService.t('walletChangeAvatar')}
              >
                {authState.avatarUrl ? (
                  <img src={authState.avatarUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center">
                    <span className="text-white text-lg font-bold">{walletAddr.slice(2, 4).toUpperCase()}</span>
                  </div>
                )}
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                  {avatarUploading ? (
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                  )}
                </div>
              </button>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-1 gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary shrink-0">{i18nService.t('walletMyWalletBsc')}</span>
                  {/* 会员等级徽章 — 跟在钱包名旁(对标即梦,等级跟着 UID);显示档名 + 到期日/已过期;
                      到期后仍显示原档名(subPlanName)+「已过期」。点击切到会员订阅 tab。 */}
                  {(() => {
                    const pe = authState.subPeriodEnd ? new Date(authState.subPeriodEnd).getTime() : 0;
                    const active = pe > Date.now();
                    const exp = !!authState.subStatus && !active;
                    const nm = authState.subPlanName || authState.planName || '免费版';
                    const d = pe ? new Date(pe) : null;
                    const lbl = d ? `${d.getMonth() + 1}/${d.getDate()}` : '';
                    const days = active ? Math.ceil((pe - Date.now()) / 86_400_000) : 0;
                    const soon = active && days >= 0 && days <= 3;
                    return (
                      <button
                        type="button"
                        onClick={() => setTopTab('subscription')}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold transition-transform hover:scale-105 cursor-pointer shrink-0 whitespace-nowrap"
                        style={active
                          ? { background: 'linear-gradient(135deg,#fde68a,#f59e0b)', color: '#3a2400', boxShadow: '0 0 8px rgba(245,158,11,0.4)' }
                          : { background: 'rgba(255,255,255,0.06)', color: '#9aa0aa', border: '1px solid rgba(255,255,255,0.14)' }}
                        title={exp ? '会员已过期,点此续费' : active ? `会员有效至 ${lbl}` : '我的会员'}
                      >
                        {(active || exp) ? '👑 ' : ''}{nm}
                        {active ? <span className={soon ? 'text-red-600' : ''}>· {soon ? `${days}天后到期` : `${lbl}到期`}</span> : exp ? <span className="text-red-600">· 已过期</span> : null}
                      </button>
                    );
                  })()}
                  {/* v1.x: 合伙人小徽章 — 显示 tier emoji + 等级名,点击跳到邀请
                      返佣页详细看返佣比例 + 邀请明细。普通用户不渲染。 */}
                  {partnerBadge && (
                    <button
                      type="button"
                      onClick={onShowInvite}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold transition-transform hover:scale-105 cursor-pointer shrink-0"
                      style={{
                        background: `linear-gradient(135deg, color-mix(in srgb, var(--invite-partner-color) 28%, transparent), color-mix(in srgb, var(--invite-partner-color) 45%, transparent))`,
                        color: 'var(--invite-partner-color)',
                        border: `1px solid color-mix(in srgb, var(--invite-partner-color) 60%, transparent)`,
                        boxShadow: `0 0 10px var(--invite-partner-glow)`,
                      }}
                      title={i18nService.t('inviteRebateMenu')}
                    >
                      <span className="text-[12px] leading-none">{partnerBadge.emoji}</span>
                      <span>{i18nService.t('partnerBannerTitle')}</span>
                      <span className="opacity-70">→</span>
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                  <span className="text-xs text-primary">{i18nService.t('walletConnected')}</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <code className="text-sm font-mono dark:text-claude-darkText text-claude-text flex-1 truncate">{walletAddr}</code>
                <button onClick={() => copyToClipboard(walletAddr)} className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-primary px-2 py-1 rounded-lg border dark:border-claude-darkBorder border-claude-border hover:border-primary/40 transition-all">
                  {i18nService.t('walletCopy')}
                </button>
              </div>
              {/* Web3Auth social login provenance — shown only when user signed in via Google/X/Discord */}
              {authState.socialEmail && (
                <div className="flex items-center gap-1.5 mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {authState.socialProvider === 'google' && <span style={{ color: '#ea4335' }}>●</span>}
                  {authState.socialProvider === 'twitter' && <span style={{ color: '#000', filter: 'invert(1)' }}>●</span>}
                  {authState.socialProvider === 'discord' && <span style={{ color: '#5865f2' }}>●</span>}
                  <span className="truncate">{authState.socialEmail}</span>
                </div>
              )}
              {avatarError && <p className="text-xs text-red-400 mt-1">{avatarError}</p>}
            </div>
          </div>
          {/* v6.x: 2 列扩 3 列 — 加 "收到返佣 (USDT)" 跳邀请页。三列等宽,
              视觉上 Credits / NoobCoin / 返佣 各 1/3。点查看跳邀请返佣页
              (onShowInvite,WalletView 自己不 navigate)。 */}
          <div className="flex items-stretch gap-4">
            {/* Token Balance - Left */}
            <div className="flex-1">
              <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">{i18nService.t('walletTokenBalance')}</p>
              <div className="flex items-center gap-2">
                <p className="text-2xl font-bold text-primary">
                  {(balance / 1_000_000).toFixed(2)}M
                </p>
                <button
                  onClick={() => setSubPage('creditDetail')}
                  className="text-xs text-primary hover:underline flex items-center gap-0.5"
                >
                  {i18nService.t('walletView')}
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                </button>
              </div>
            </div>
            {/* NoobCoin - Middle */}
            <div className="flex-1 flex flex-col items-center justify-center border-l dark:border-claude-darkBorder border-claude-border pl-4">
              <div className="flex items-center gap-2 mb-1">
                <img src="logo.png" alt="NoobCoin" className="w-6 h-6 rounded-full" />
                <span className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">NoobCoin{i18nService.t('walletNoobCoinTotal')}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xl font-bold text-primary">{Number(profile?.totalNoob || 0).toLocaleString()}</span>
                <button
                  onClick={() => setSubPage('noobCoinDetail')}
                  className="text-xs text-primary hover:underline flex items-center gap-0.5"
                >
                  {i18nService.t('walletView')}
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                </button>
              </div>
            </div>
            {/* USDT Rebate - Right (v6.x) */}
            <div className="flex-1 flex flex-col items-center justify-center border-l dark:border-claude-darkBorder border-claude-border pl-4">
              <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">{i18nService.t('walletUsdtRebateReceived')}</p>
              <div className="flex items-center gap-2">
                <span className="text-xl font-bold text-primary">
                  ${parseFloat(usdtRebateSummary?.total_earned || '0').toFixed(2)}
                </span>
                <button
                  type="button"
                  onClick={() => { if (onShowInvite) onShowInvite(); }}
                  className="text-xs text-primary hover:underline flex items-center gap-0.5"
                >
                  {i18nService.t('walletView')}
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                </button>
              </div>
            </div>
            {/* CNY Rebate - 收到返佣(¥),带提现入口(v6.x CNY 返佣) */}
            <div className="flex-1 flex flex-col items-center justify-center border-l dark:border-claude-darkBorder border-claude-border pl-4">
              <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">{isZh ? '收到返佣 (CNY)' : 'Rebate (CNY)'}</p>
              <div className="flex items-center gap-2">
                <span className="text-xl font-bold text-primary">
                  ¥{parseFloat(usdtRebateSummary?.cny_total_earned || '0').toFixed(2)}
                </span>
                <button
                  type="button"
                  onClick={() => setShowCnyWithdraw(true)}
                  className="text-xs text-primary hover:underline flex items-center gap-0.5"
                >
                  {isZh ? '提现' : 'Withdraw'}
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                </button>
              </div>
            </div>
          </div>
          {showCnyWithdraw && (
            <CnyWithdrawModal
              isZh={isZh}
              onClose={() => setShowCnyWithdraw(false)}
              onSuccess={() => { noobClawApi.getUsdtRebateSummary().then(s => { if (s) setUsdtRebateSummary(s); }).catch(() => {}); }}
            />
          )}
          {balance < 100000 && (
            <div className="mt-3 p-2.5 rounded-lg bg-yellow-500/5 border border-yellow-500/20 text-xs text-yellow-500">
              {i18nService.t('walletLowBalance')}
            </div>
          )}
          </div>{/* /relative z-10 wrapper */}
        </div>

        {/* 顶部 tab:会员订阅 / 购买积分。仅 select 步骤显示;支付/成功时隐藏让支付屏干净。 */}
        {step === 'select' && (
        <div className="flex gap-2 p-1 rounded-lg dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
          <button onClick={() => setTopTab('subscription')} className={`flex-1 py-2 rounded-md text-sm font-semibold transition-all ${topTab === 'subscription' ? 'bg-primary/15 text-primary' : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'}`}>👑 会员订阅</button>
          <button onClick={() => setTopTab('topup')} className={`flex-1 py-2 rounded-md text-sm font-semibold transition-all ${topTab === 'topup' ? 'bg-primary/15 text-primary' : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'}`}>💎 购买积分</button>
        </div>
        )}

        {/* 会员订阅 tab:选档/周期/支付方式 → onPay 复用下方同一套支付步骤 */}
        {step === 'select' && topTab === 'subscription' && (
        <div>
          {/* 标题行:对齐「购买积分」那行(左标题 + 右「购买记录」入口,走同一套订单历史子页) */}
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium dark:text-claude-darkText text-claude-text">订阅会员</h3>
            <button
              onClick={() => { setSubPage('orderHistory'); setStatusFilter(''); setSearchOrderNo(''); setSearchFrom(''); setSearchTo(''); loadOrders(''); }}
              className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-primary transition-colors flex items-center gap-1"
            >
              {i18nService.t('walletHistory')}
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
            </button>
          </div>
          <MembershipPanel onPay={startSubscriptionPay} />
        </div>
        )}

        {step === 'select' && topTab === 'topup' && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium dark:text-claude-darkText text-claude-text">购买积分</h3>
            <button
              onClick={() => { setSubPage('orderHistory'); setStatusFilter(''); setSearchOrderNo(''); setSearchFrom(''); setSearchTo(''); loadOrders(''); }}
              className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-primary transition-colors flex items-center gap-1"
            >
              {i18nService.t('walletHistory')}
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
            </button>
          </div>

          {/* Error message */}
          {error && (
            <div className="mb-3 p-3 rounded-lg bg-red-500/5 border border-red-500/20 text-xs text-red-400">
              {error}
            </div>
          )}

          {step === 'select' && (
            <>
              {/* 支付方式 tabs。原本只在后端报 TRON 通道时渲染(BSC-only 部署看
                  老单 grid)。现在 CNY 卡密通道(redeemInfo 非空)也会让这行露出,
                  即使只有 BSC + CNY 两个选项。USDT/TRON 按产品决策排第一。
                  cnySelected 标记当前是否在卡密面板,与 currentChain 正交。
                  国内版(HIDE_WEB3):只走 CNY 卡密,链上充值 tab 整行隐藏。 */}
              {!HIDE_WEB3 && (paymentInfo?.chains?.TRON || redeemInfo) && (
                <div className="mb-3 flex gap-2 p-1 rounded-lg dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
                  {paymentInfo?.chains?.TRON && (
                    <button
                      onClick={() => { setCnySelected(false); setCurrentChain('TRON'); }}
                      className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-md text-xs font-semibold transition-all ${!cnySelected && currentChain === 'TRON' ? 'bg-primary/15 text-primary' : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'}`}
                    >
                      <ChainLogo chain="TRON" size={16} />
                      USDT · TRC20
                    </button>
                  )}
                  <button
                    onClick={() => { setCnySelected(false); setCurrentChain('BSC'); }}
                    className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-md text-xs font-semibold transition-all ${!cnySelected && currentChain === 'BSC' ? 'bg-primary/15 text-primary' : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'}`}
                  >
                    <ChainLogo chain="BSC" size={16} />
                    BNB · BSC
                  </button>
                  {redeemInfo && (
                    <button
                      onClick={() => { setCnySelected(true); setRedeemMsg({ text: '', color: '' }); }}
                      className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-md text-xs font-semibold transition-all ${cnySelected ? 'bg-primary/15 text-primary' : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'}`}
                    >
                      {i18nService.t('walletRedeemTab')}
                    </button>
                  )}
                </div>
              )}
              {cnySelected ? (
                /* ─── CNY 卡密充值面板 ───
                   照搬主站 cn 站交互:档位卡片(去咸鱼买)→ 收到卡密填入下方框
                   → preview 确认面额 → redeem 核销,积分秒到账。 */
                <>
                  {/* 卡密兑换置顶 */}
                  <div className="mb-4">
                    <p className="text-xs font-semibold dark:text-claude-darkText text-claude-text mb-2">{i18nService.t('walletRedeemHaveCode')}</p>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={redeemCodeInput}
                        onChange={(e) => setRedeemCodeInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !redeemBusy) handleSubmitRedeem(); }}
                        placeholder="NOOB-XXXX-XXXX-XXXX-XXXX"
                        maxLength={32}
                        autoComplete="off"
                        spellCheck={false}
                        className="flex-1 px-3 py-2 rounded-lg dark:bg-claude-darkBg bg-white border dark:border-claude-darkBorder border-claude-border text-sm font-mono dark:text-claude-darkText text-claude-text uppercase placeholder:normal-case placeholder:text-claude-textSecondary/50 focus:outline-none focus:border-primary"
                      />
                      <button
                        onClick={handleSubmitRedeem}
                        disabled={redeemBusy}
                        className="px-4 py-2 rounded-lg bg-primary hover:bg-primary-hover text-black text-sm font-semibold disabled:opacity-40 transition-all shrink-0"
                      >
                        {redeemBusy ? i18nService.t('walletRedeemBusy') : i18nService.t('walletRedeemBtn')}
                      </button>
                    </div>
                    {redeemMsg.text && (
                      <p className="text-xs mt-2 leading-relaxed" style={{ color: redeemMsg.color }}>{redeemMsg.text}</p>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    {(redeemInfo?.packages || []).map((pkg) => {
                      const tokensM = (pkg.tokens / 1e6).toFixed(1);
                      return (
                        <div key={`CNY-${pkg.usdt}`} className="p-4 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border text-center flex flex-col">
                          <p className="font-bold dark:text-claude-darkText text-claude-text mb-1">¥{pkg.rmb}</p>
                          <p className="text-xs text-primary font-medium mb-3">{tokensM}M {i18nService.t('walletRedeemCreditsUnit')}</p>
                          <button
                            onClick={handleBuyOnXianyu}
                            className="mt-auto w-full py-2 rounded-lg bg-primary hover:bg-primary-hover text-black text-xs font-semibold transition-all"
                          >
                            {i18nService.t('walletRedeemBuy')}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  {/* 充值步骤置底 */}
                  <div className="mt-4 p-3 rounded-lg bg-primary/5 border border-primary/20 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary leading-relaxed">
                    <div className="font-semibold text-primary mb-1.5">{i18nService.t('walletRedeemStepsTitle')}</div>
                    <div>{i18nService.t('walletRedeemStep1')}</div>
                    <div>{i18nService.t('walletRedeemStep2')}</div>
                    <div>{i18nService.t('walletRedeemStep3')}</div>
                  </div>
                </>
              ) : (
              <div className="grid grid-cols-3 gap-3">
                {(() => {
                  const block = chainBlockFor(paymentInfo, currentChain);
                  const packages = block?.packages || [];
                  if (!packages.length) {
                    return (
                      <div className="col-span-3 text-center dark:text-claude-darkTextSecondary text-claude-textSecondary text-sm py-4">
                        {paymentInfo ? `${currentChain} channel unavailable` : i18nService.t('walletLoadingPackages')}
                      </div>
                    );
                  }
                  return packages.map((pkg: any) => {
                    const isTron = currentChain === 'TRON';
                    const amount = isTron ? (pkg.usdt as number) : (pkg.bnb as number);
                    const key = `${currentChain}-${amount}`;
                    return (
                      <div key={key} className="p-4 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border text-center flex flex-col">
                        <p className="font-bold dark:text-claude-darkText text-claude-text mb-1">{pkg.label}</p>
                        <p className="text-xs text-primary font-medium mb-3">{pkg.tokensDisplay}</p>
                        <button
                          onClick={() => handleSelectPackage(amount, currentChain)}
                          disabled={loading}
                          className="mt-auto w-full py-2 rounded-lg bg-primary hover:bg-primary-hover text-black text-xs font-semibold disabled:opacity-40 transition-all"
                        >
                          {i18nService.t('walletTopUp')}
                        </button>
                      </div>
                    );
                  });
                })()}
              </div>
              )}
            </>
          )}
          <p className="mt-5 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">单独购买的积分永久有效、不受影响。</p>
        </div>
        )}

        {/* 支付步骤 —— 订阅 / 购买积分 共用同一套(QR/倒计时/轮询/取消) */}
        {step === 'pay' && (
            <div className="p-4 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
              {isExpired ? (
                /* Expired state */
                <div className="text-center py-4">
                  <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-3">
                    <svg className="w-6 h-6 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  </div>
                  <p className="text-sm font-medium text-red-400 mb-2">{i18nService.t('walletOrderExpired')}</p>
                  <p className="text-xs text-red-400/70 mb-4">{i18nService.t('walletTimeoutWarning')}</p>
                  <button
                    onClick={resetPayState}
                    className="w-full py-2 rounded-lg bg-primary hover:bg-primary-hover text-black text-sm font-medium transition-all"
                  >
                    {i18nService.t('walletBack')}
                  </button>
                </div>
              ) : (() => {
                // Chain-aware payment instructions. The visual structure stays
                // the same as the legacy BNB-only flow; just the unit, the
                // treasury address, and the title swap based on pendingChain.
                const isTron = pendingChain === 'TRON';
                const block = chainBlockFor(paymentInfo, pendingChain);
                const treasury = block?.treasuryWallet || '';
                const unit = isTron ? 'USDT' : 'BNB';
                return (
                /* Payment info */
                <>
                  {/* Title + chain logo */}
                  <div className="flex items-center justify-center gap-2 mb-4">
                    <ChainLogo chain={pendingChain} size={20} />
                    <h4 className="text-sm font-bold dark:text-claude-darkText text-claude-text text-center">
                      {isTron ? i18nService.t('walletSendUsdt') : i18nService.t('walletSendBnb')}
                    </h4>
                  </div>

                  {/* Amount */}
                  {/* v1.x: send-label 内嵌 countdown(同 tip2 那个 state),把"剩余
                      时间"和"应付金额"放一起,用户一眼看到紧迫感+金额。i18n 字
                      符串模板:'请在 {countdown} 内准确发送如下金额',用 split
                      切出 {countdown} 占位符再渲染 red span 保留样式。 */}
                  <div className="text-center mb-1">
                    {(() => {
                      const tpl = i18nService.t('walletSendExactly');
                      const parts = tpl.split('{countdown}');
                      return (
                        <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                          {parts[0]}
                          <span className="font-mono font-bold text-red-500">{countdown || '0:30:00'}</span>
                          {parts[1] ?? ''}
                        </p>
                      );
                    })()}
                    <div className="flex items-center justify-center gap-2">
                      <code className="font-bold text-primary text-lg">{pendingAmount} {unit}</code>
                      <button onClick={() => copyToClipboard(pendingAmount)} className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-primary px-2 py-1 rounded-lg border dark:border-claude-darkBorder border-claude-border transition-colors">{i18nService.t('walletCopy')}</button>
                    </div>
                  </div>

                  {/* QR Code */}
                  {treasury && (
                    <div className="flex flex-col items-center mb-3">
                      <div className="bg-white p-2.5 rounded-lg">
                        <QRCodeSVG value={treasury} size={160} />
                      </div>
                      <p className="text-xs text-primary mt-2">{i18nService.t('walletScanQr')}</p>
                    </div>
                  )}

                  {/* Address — 标签 + 地址 + 复制按钮 紧凑居中,不再 flex-1 撑开 */}
                  <div className="flex items-center justify-center gap-2 mb-4 flex-wrap">
                    <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('walletPaymentAddress')}:</span>
                    <code className="text-xs font-mono dark:text-claude-darkText text-claude-text break-all">{treasury || 'Loading...'}</code>
                    <button onClick={() => copyToClipboard(treasury)} className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-primary px-2 py-1 rounded-lg border dark:border-claude-darkBorder border-claude-border transition-colors shrink-0">{i18nService.t('walletCopy')}</button>
                  </div>

                  {/* Tips */}
                  <div className="mb-4 space-y-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    <p>1. <span className="text-yellow-500">{isTron ? i18nService.t('walletExactAmountWarningTron') : i18nService.t('walletExactAmountWarning')}</span></p>
                    <p className="text-red-400 ml-3">{i18nService.t('walletFeeWarning')}</p>
                    <p>2. {i18nService.t('walletCountdownPrefix')} <span className="font-mono font-bold text-red-500">{countdown || '0:30:00'}</span> {i18nService.t('walletCountdownSuffix')}{i18nService.t('walletPaymentDeadlineNote')}</p>
                    <p className="text-red-400/80">3. {i18nService.t('walletLossWarning')}</p>
                  </div>

                  {/* Waiting indicator */}
                  <div className="mb-3 p-2.5 rounded-lg bg-primary/5 border border-primary/20 flex items-center gap-3">
                    <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin shrink-0" />
                    <p className="text-xs text-primary">
                      {i18nService.t('walletWaitingConfirmation')}
                    </p>
                  </div>

                  {/* Actions */}
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleCancelOrder(pendingOrderNo)}
                      className="flex-1 py-2 rounded-lg border dark:border-claude-darkBorder border-claude-border text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-red-400 hover:border-red-400/40 transition-colors"
                    >
                      {i18nService.t('walletCancelOrder')}
                    </button>
                    <button
                      onClick={handleBack}
                      className="flex-1 py-2 rounded-lg border dark:border-claude-darkBorder border-claude-border text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text transition-colors"
                    >
                      {i18nService.t('walletBack')}
                    </button>
                  </div>
                </>
                );
              })()}
            </div>
          )}

          {step === 'success' && (
            <div className="p-5 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border border-primary/20 text-center">
              <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-3">
                <svg className="w-7 h-7 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
              </div>
              <p className="font-bold text-primary mb-1">{i18nService.t('walletPaymentConfirmed')}</p>
              <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary mb-4">{i18nService.t('walletTokensAdded')}</p>
              <p className="text-xl font-bold dark:text-claude-darkText text-claude-text">{(authState.tokenBalance / 1_000_000).toFixed(2)}{i18nService.t('walletMTokenUnit')}</p>
              <button onClick={() => { resetPayState(); loadData(); }} className="mt-4 text-sm text-primary hover:underline">
                {i18nService.t('walletBackToWallet')}
              </button>
            </div>
          )}


      </div>
    </div>
  );
};

export default WalletView;
