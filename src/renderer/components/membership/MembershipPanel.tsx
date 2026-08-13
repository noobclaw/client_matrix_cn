import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { i18nService } from '../../services/i18n';

import { HIDE_WEB3 } from '../../buildFlags';
import { noobClawAuth } from '../../services/noobclawAuth';
import { noobClawApi } from '../../services/noobclawApi';
import { getWebsiteUrl } from '../../services/endpoints';
import { readCachedPlanConfig, writeCachedPlanConfig } from '../../services/paymentInfoCache';

// 嵌入「我的充值」页「会员订阅」tab 的会员面板(无独立页面 chrome)。
// 对齐官网(website/index.html subChoosePlan/subPayWith):
//   周期行 = 连续包月 / 连续包季 / 连续包年 / 单月购买(默认连续包季),
//   支付方式【不再是常驻 tab】—— 点套餐卡片后弹窗选(银行卡 / USDT / BNB / 官方店铺卡密)。
// 配色用 .text-primary / .bg-primary 等(随 WalletView 的 partner 金 / 默认绿主题自动适配)。

// 'half'(半年)只保留在类型与月数表里 —— 周期行已下线该档(Dodo 没有对应 product),
//   但历史订单 / 会员兑换码回传的 plan_period 仍可能是 'half',periodLabel 要认得。
type Period = 'month' | 'quarter' | 'half' | 'year' | 'once';
// 弹窗里的四个支付方式。SHOP = 官方店铺(卡密),不下单、只开兑换弹窗。
type PayMethod = 'DODO' | 'TRON' | 'BSC' | 'SHOP';

// 币种图标(对齐购买积分那排支付方式 tab)。本地复制自 WalletView 的 ChainLogo:
// WalletView 已 import 本组件,反向 import 会形成循环依赖,故按矩阵惯例就地复制两枚 SVG。
const ChainLogo: React.FC<{ chain: 'BSC' | 'TRON' | 'WXPAY' | 'DODO'; size?: number }> = ({ chain, size = 16 }) => {
  if (chain === 'DODO') {
    // 银行卡(Dodo)。通用卡片图标,不打三方品牌。
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" style={{ verticalAlign: 'middle' }}>
        <rect x="1.5" y="4" width="21" height="16" rx="2.5" fill="#635BFF" />
        <rect x="1.5" y="7.5" width="21" height="3" fill="#1a1a2e" />
        <rect x="4" y="14" width="6" height="2" rx="1" fill="white" opacity=".9" />
      </svg>
    );
  }
  if (chain === 'WXPAY') {
    // 微信支付绿气泡(简化标,与 WalletView 同款)
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ verticalAlign: 'middle' }}>
        <circle cx={12} cy={12} r={12} fill="#07C160" />
        <ellipse cx="9.6" cy="10.4" rx="5.4" ry="4.4" fill="white" />
        <path fill="white" d="M6.2 16.6l1.2-2.6 2.6 1z" />
        <ellipse cx="15.4" cy="13.4" rx="4.3" ry="3.5" fill="white" />
        <path fill="white" d="M18.6 18.2l-1-2.1-2.1.8z" />
        <circle cx="7.8" cy="9.6" r="0.75" fill="#07C160" />
        <circle cx="11.4" cy="9.6" r="0.75" fill="#07C160" />
        <circle cx="14" cy="12.8" r="0.65" fill="#07C160" />
        <circle cx="16.9" cy="12.8" r="0.65" fill="#07C160" />
      </svg>
    );
  }
  if (chain === 'TRON') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ verticalAlign: 'middle' }}>
        <rect width={24} height={24} rx={12} fill="#EF0027" />
        <path fill="white" d="M17.5 5.5L7.5 4 12 17.5l1.5-4.2L17.5 5.5zm-1.7.8L12.7 11l-2-4.8 4.6-.4-.4.3zm-7.6-1l3.5 1.4-.8 4.4-3.4-5.5L8.2 5.3zm5.1 6.4l-1.3 3.6L7.5 7l5 4.5z" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" style={{ verticalAlign: 'middle' }}>
      <circle cx={16} cy={16} r={16} fill="#F3BA2F" />
      <path fill="white" d="M12.116 14.404L16 10.52l3.886 3.886 2.26-2.258L16 6l-6.146 6.146 2.262 2.258zM6 16l2.26-2.26L10.52 16l-2.26 2.26L6 16zm6.116 1.596L16 21.48l3.886-3.886 2.26 2.259L16 26l-6.146-6.146-.003-.003 2.265-2.255zM21.48 16l2.26-2.26L26 16l-2.26 2.26L21.48 16zm-3.188-.002h.002V16L16 18.294 13.706 16.002l-.004-.004.004-.004.402-.402.195-.195L16 13.706l2.293 2.293z" />
    </svg>
  );
};

// 弹窗里的一行支付方式(图标 + 标题 + 副标题 + 可选角标)。禁用时置灰不可点。

// 美元标价旁的人民币参考价。
//   ⚠️ 只能写「≈」—— 实际走银行卡按美元结算,落地人民币由发卡行按当日汇率定;
//     usdCnyRate 只是后端 admin 里那个参考汇率(和卡密面值同一个旋钮)。
//   拿不到汇率就整个不显示 —— 宁可不写,也不能写个错数字。
function cnyRef(usd?: number | null, rate?: number | null): string {
  const u = Number(usd), r = Number(rate);
  if (!(r > 0) || !Number.isFinite(u) || u <= 0) return '';
  return '≈ ¥' + Math.round(u * r);
}

const MethodRow: React.FC<{
  icon: React.ReactNode; title: string; desc: string; badge?: string;
  disabled?: boolean; onClick: () => void;
}> = ({ icon, title, desc, badge, disabled, onClick }) => (
  <button
    type="button"
    disabled={disabled}
    onClick={disabled ? undefined : onClick}
    className={`w-full flex items-center gap-3 p-3.5 rounded-xl border text-left transition-all ${disabled
      ? 'opacity-40 cursor-not-allowed dark:border-claude-darkBorder border-claude-border'
      : 'dark:border-claude-darkBorder border-claude-border hover:border-primary/60 hover:bg-primary/5 cursor-pointer'}`}
  >
    <span className="shrink-0">{icon}</span>
    <span className="flex-1 min-w-0">
      <span className="flex items-center gap-2">
        <span className="text-sm font-semibold dark:text-claude-darkText text-claude-text">{title}</span>
        {badge && <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-primary text-black">{badge}</span>}
      </span>
      <span className="block text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-0.5">{desc}</span>
    </span>
    <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">›</span>
  </button>
);

// ⚠️ 用函数【每次调用求值】i18n —— 模块级 const 会在加载时(语言默认中文)冻结,切英文/小语种后周期文案仍中文。
// 4 种购买模式:前 3 个是连续订阅(银行卡走 Dodo 自动续费;USDT/BNB 无法自动续费,等同一次买断该时长);
//   'once' 是单月购买(明确不续费,后端单独定价 price_usd_once,比连续包月贵)。
const periods = (): Array<{ key: Period; label: string }> => [
  { key: 'month', label: i18nService.t('mpPeriodMonthAuto') },
  { key: 'quarter', label: i18nService.t('mpPeriodQuarterAuto') },
  { key: 'year', label: i18nService.t('mpPeriodYearAuto') },
  { key: 'once', label: i18nService.t('mpPeriodOnce') },
];
const periodLabel = (k: string): string => (({ month: i18nService.t('mpUnitMonth'), quarter: i18nService.t('mpUnitQuarter'), half: i18nService.t('mpUnitHalf'), year: i18nService.t('mpUnitYear'), once: i18nService.t('mpUnitMonth') } as Record<string, string>)[k] || '');
const PERIOD_MONTHS: Record<Period, number> = { month: 1, quarter: 3, half: 6, year: 12, once: 1 }; // once=单月购买
const RECOMMENDED = 'pro';
// 档位主题色:免费灰 / 基础蓝银 / 进阶金 / 旗舰紫。
const TIER_COLOR: Record<string, string> = { free: '#9aa0aa', basic: '#60a5fa', pro: '#fbbf24', max: '#a78bfa' };

function fmtCredits(n: number): string {
  n = Number(n) || 0;
  if (n >= 1e8) return (Math.round(n / 1e7) / 10) + i18nService.t('mpUnitYi');
  if (n >= 1e4) return Math.round(n / 1e4) + i18nService.t('mpUnitWan');
  return String(n);
}

const MembershipPanel: React.FC<{
  onPay?: (planCode: string, period: Period, chain: 'TRON' | 'BSC' | 'WXPAY' | 'DODO') => Promise<string | null>;
  /** 后端报了 DODO 通道 → 支付方式弹窗里露出「银行卡」(推荐渠道,支持自动续费) */
  dodoEnabled?: boolean;
  /** DODO 渠道真有 product 的订阅档,如 ['basic:month','basic:once'] —— 没有的档位银行卡那行置灰 */
  dodoPlans?: string[];
  /** 美元→人民币参考汇率(后端 /payment/info 下发)。 */
  usdCnyRate?: number;
}> = ({ onPay, dodoEnabled, dodoPlans, usdCnyRate }) => {
  // 套餐配置:先读 localStorage 缓存秒出(对齐购买积分),后台 fetch 静默覆盖。
  // 有缓存就不显示「加载中…」,只在首次无缓存时才阻塞。
  const [cfg, setCfg] = useState<Awaited<ReturnType<typeof noobClawApi.getPlanConfig>>>(() => readCachedPlanConfig());
  const [loading, setLoading] = useState<boolean>(() => !readCachedPlanConfig());
  // 默认连续包季(对齐官网 _subPeriod = 'quarter')。
  const [period, setPeriod] = useState<Period>('quarter');
  // 支付方式弹窗:非 null = 正在为这个档位选支付方式。
  const [methodPlan, setMethodPlan] = useState<string | null>(null);
  // 官方店铺(卡密)弹窗:去店铺按钮 + 兑换框同窗 —— 直接跳走的话用户买完回来不知道在哪填码。
  const [shopOpen, setShopOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // 中性提示(非报错):目前只用于「取消自动续费请去官网」。
  const [notice, setNotice] = useState('');
  // 会员码兑换
  const [redeemInput, setRedeemInput] = useState('');
  const [redeemMsg, setRedeemMsg] = useState<{ text: string; color: string }>({ text: '', color: '' });
  const [redeemBusy, setRedeemBusy] = useState(false);
  // CNY 店铺地址:【必须后端下发】(/cny/packages 的 xianyu_shop_url,admin 可改),客户端不兜底。
  //   没拿到前 = 空 → 去店铺按钮禁用,绝不跳写死/猜的地址。
  const [shopUrl, setShopUrl] = useState('');

  const load = useCallback(async () => {
    const data = await noobClawApi.getPlanConfig();
    if (data) { setCfg(data); writeCachedPlanConfig(data); }
    setLoading(false);
    // 拉 CNY 店铺地址(失败保留默认);与购买积分共用 /cny/packages 的 xianyu_shop_url。
    try { const rp = await noobClawApi.getRedeemPackages(); if (rp?.xianyu_shop_url) setShopUrl(rp.xianyu_shop_url); } catch { /* 用默认 */ }
  }, []);

  // 「前往店铺购买」:新开系统浏览器到店铺(店铺买卡密 → 回来在兑换框输入开通)。
  const openShop = () => { if (!shopUrl) return; try { (window as any).electron?.shell?.openExternal?.(shopUrl); } catch { /* noop */ } };

  useEffect(() => { load(); }, [load]);

  const plans = cfg?.plans || [];
  const cur = cfg?.current;
  const curCode = cur?.planCode || 'free';
  // 只升级不降级:订阅有效时,低于当前档的卡片置灰不可买;当前档=续费、更高档=升级。
  //   未订阅/已过期 → 视同免费档(order 0),所有付费档都可选(「到期回免费版又都能选」)。
  const subActive = !!cur?.subActive;
  const curOrder = subActive ? (plans.find(p => p.code === curCode)?.sort_order ?? 0) : 0;

  // 点套餐卡片 → 先确认「升级会从今天重算周期」,再开支付方式弹窗。
  const choosePlan = (planCode: string) => {
    setError('');
    const isUpgradeNow = subActive && !!cur?.planCode && cur.planCode !== planCode;
    if (isUpgradeNow) {
      const endTxt = cur?.periodEnd ? new Date(cur.periodEnd).toLocaleDateString() : '';
      if (!window.confirm(i18nService.t('mpUpgradeRestartWarn').replace('{date}', endTxt))) return;
    }
    setMethodPlan(planCode);
  };

  // 订阅下单交给 WalletView,复用「购买积分」那套支付步骤(QR/倒计时/轮询/取消)。失败回错误串在此显示。
  // ⚠️ period 原样传后端 —— 'once'(单月购买)后端有独立定价 + 一次性 product,绝不能折算成 'month'。
  const subscribe = async (planCode: string, chain: 'TRON' | 'BSC' | 'DODO') => {
    if (!onPay) return;
    setBusy(true); setError('');
    const err = await onPay(planCode, period, chain);
    if (err) setError(err);
    setBusy(false);
  };

  const payWith = (m: PayMethod, planCode: string) => {
    setMethodPlan(null);
    if (m === 'SHOP') { setRedeemMsg({ text: '', color: '' }); setShopOpen(true); return; }
    subscribe(planCode, m);
  };

  const submitRedeem = async () => {
    const code = redeemInput.trim();
    if (!code) { setRedeemMsg({ text: i18nService.t('mpRedeemEmpty'), color: '#ef4444' }); return; }
    setRedeemBusy(true); setRedeemMsg({ text: '', color: '' });
    try {
      const d = await noobClawApi.redeemCode(code);
      if (!d || !d.ok) { setRedeemMsg({ text: (d && d.message) || i18nService.t('mpRedeemFail'), color: '#ef4444' }); return; }
      setRedeemInput('');
      setRedeemMsg({
        text: d.product_type === 'subscription'
          ? i18nService.t('mpRedeemSubOk').replace('{period}', periodLabel(d.plan_period || ''))
          : i18nService.t('mpRedeemCreditsOk').replace('{n}', Number(d.credits ?? 0).toLocaleString()),
        color: '#22c55e',
      });
      await noobClawAuth.refreshBalance(); await load();
    } finally { setRedeemBusy(false); }
  };

  if (loading) return <div className="text-center text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary py-12">{i18nService.t('mpLoading')}</div>;
  if (!cfg) return <div className="text-center text-sm text-red-400 py-12">{i18nService.t('mpLoadFail')}</div>;

  // ── 选择视图 ──
  const planName = (p: any) => ((i18nService.currentLanguage === 'zh' || i18nService.currentLanguage === 'zh-TW') ? (p?.name_zh || p?.name_en) : (p?.name_en || p?.name_zh)) || '';
  // 取消自动续费:客户端【不调接口】,改为打开官网用户中心让用户在网页上完成。
  //   ① 客户端直调 /subscription/cancel 实测会报错,把人卡住;② 多一层摩擦也是产品要的。
  //   URL 走 getWebsiteUrl()(cn 版内部按 HIDE_WEB3 自动带 /cn),绝不硬编码域名。
  const handleCancelAutoRenew = () => {
    setError('');
    setNotice(i18nService.t('subCancelOnWeb'));
    try { (window as any).electron?.shell?.openExternal?.(getWebsiteUrl() + '/#page-user-center'); } catch { /* noop */ }
  };

  const sorted = [...plans].sort((a, b) => a.sort_order - b.sort_order); // free 在前
  const isOnce = period === 'once';
  // 连续包月只留银行卡:USDT/BNB/卡密都是一次性到账,给不了「连续」。用它们买连续包月
  //   = $9.9 拿一个月还不续费,比单月购买 $12.9 更便宜 —— 白让 $3 又丢掉续费。
  //   后端 /payment/create 有同名兜底(MONTH_CARD_ONLY),这里只是不给入口。
  const isMonthAuto = period === 'month';
  // 银行卡可用性以后端下发的 subscriptionPlans 为准(它只列真有 product id 的档位,如 'pro:once')。
  //   列表为空(老后端)时不拦,交给后端拒。
  const dodoHasPlan = (planCode: string) => !dodoPlans?.length || dodoPlans.some(x => String(x) === `${planCode}:${period}`);

  return (
    <div>
      {/* 周期行:连续包月 / 连续包季 / 连续包年 / 单月购买。支付方式不在这里选 —— 点套餐卡片后弹窗。 */}
      <div className="mb-4 flex items-center justify-center">
        <div className="inline-flex rounded-lg overflow-hidden border dark:border-claude-darkBorder border-claude-border">
          {periods().map(p => (
            <button key={p.key} onClick={() => { setPeriod(p.key); setError(''); }} className={`px-4 py-2 text-xs ${period === p.key ? 'bg-primary text-black font-semibold' : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText'}`}>{p.label}</button>
          ))}
        </div>
      </div>

      {/* 自动续费状态条:说明下次扣款时间 + 给一条退出路径。
          语义是「到期取消」—— 当前周期已付费,剩余天数照用,只是不再自动续。 */}
      {subActive && cur?.autoRenew && (
        <div className="mb-3 flex items-center justify-between gap-3 flex-wrap p-3 rounded-lg dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
          <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('subNextCharge')} {cur.periodEnd ? new Date(cur.periodEnd).toLocaleDateString() : ''}
          </span>
          <button
            onClick={handleCancelAutoRenew}
            className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-primary underline underline-offset-2 transition-colors"
          >
            {i18nService.t('subCancelAutoRenew')}
          </button>
        </div>
      )}

      {error && <div className="mb-3 p-3 rounded-lg bg-red-500/5 border border-red-500/20 text-xs text-red-400">{error}</div>}
      {/* 中性提示条(不是报错)—— 例如「取消自动续费请在官网完成」 */}
      {notice && <div className="mb-3 p-3 rounded-lg bg-primary/5 border border-primary/20 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{notice}</div>}

      {/* 套餐卡(4 档,免费版第一) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {sorted.map(plan => {
          const isFree = plan.code === 'free';
          const isCur = plan.code === curCode;
          const isCurActive = subActive && isCur;          // 当前档(订阅有效)→ 续费
          const isLower = subActive && plan.sort_order < curOrder; // 低于当前档 → 不可降级(置灰)
          // 自动续费(银行卡)的当前档不能再给「续费」—— 它自己会扣款,再点会开出
          //   第二笔订阅并行扣钱。改为展示「自动续费中」并禁用。
          const autoOn = !!cur?.autoRenew;
          const cta = isCurActive
            ? (autoOn ? i18nService.t('subAutoRenewing') : i18nService.t('mpCtaRenew'))
            : (subActive ? i18nService.t('mpCtaUpgrade') : i18nService.t('mpCtaSubscribe'));
          const isRec = plan.code === RECOMMENDED;
          const price = plan.prices?.[period];
          const tier = TIER_COLOR[plan.code] || '#9aa0aa';
          // 一律美元展示(支付方式在点卡片后的弹窗里选;Dodo 收银台会按用户本币结算,但标价统一 $)。
          //   'once' 取后端下发的单月购买价(prices.once,比连续包月贵)。
          const sym = '$';
          const months = PERIOD_MONTHS[period];
          const discount = price?.discount ?? 1;
          const finalP = isFree ? 0 : (price?.usd ?? plan.price_usd);
          const origP = plan.price_usd * months;
          const hasDiscount = !isFree && discount < 0.999;
          const off = Math.round(discount * 100) / 10; // 0.7→7、0.9→9
          // 连续订阅 vs 单月购买的省钱对比:用后端下发的 once 价减去本周期折合的每月价。
          //   省了才显示 —— 让「连续更划算」一眼可见。
          const oncePrice = plan.prices?.once?.usd ?? 0;
          const perMonth = (!isFree && months > 0) ? finalP / months : 0;
          const savePerMo = (!isOnce && oncePrice > 0 && perMonth > 0) ? (oncePrice - perMonth) : 0;
          return (
            <div key={plan.code} className={`relative rounded-2xl p-4 flex flex-col dark:bg-claude-darkSurface bg-claude-surface ${isLower ? 'opacity-50' : ''}`}
              style={{ border: '1px solid', borderColor: isCur ? tier + '88' : 'rgba(255,255,255,0.08)' }}>
              {isRec && <span className="absolute -top-2.5 right-3 px-2 py-0.5 rounded-full text-[10px] font-bold text-black whitespace-nowrap" style={{ background: tier }}>{i18nService.t('mpMostPopular')}</span>}
              {/* 档位名 + 档位色点 + 限时折扣 */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: tier }} />
                <span className="text-base font-semibold dark:text-claude-darkText text-claude-text">{planName(plan)}</span>
                {hasDiscount && <span className="px-1.5 py-0.5 rounded text-[10px] font-bold" style={{ background: '#ef444422', color: '#f87171' }}>{i18nService.t('mpDiscountBadge').replace('{off}', String(off))}</span>}
              </div>
              {/* 价格:最终价大字 + 原价划掉 + /周期 */}
              <div className="mt-3 flex items-end gap-1.5 flex-wrap">
                <span className="text-2xl font-extrabold dark:text-claude-darkText text-claude-text">{sym}{finalP}</span>
                {hasDiscount && <span className="text-xs line-through dark:text-claude-darkTextSecondary text-claude-textSecondary">{sym}{Math.round(origP)}</span>}
                {!isFree && <span className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">/{periodLabel(period)}</span>}
              </div>
              {!isFree && cnyRef(finalP, usdCnyRate) && (
                <div className="mt-0.5 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">{cnyRef(finalP, usdCnyRate)}</div>
              )}
              {savePerMo > 0.01 && (
                <div className="mt-1 text-[11px] font-semibold text-primary">{i18nService.t('mpSaveVsOnce').replace('{n}', savePerMo.toFixed(1))}</div>
              )}
              <ul className="mt-3 space-y-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary flex-1">
                <li>· {isFree ? i18nService.t('mpFeatSignupGift') : i18nService.t('mpFeatMonthlyCredits').replace('{n}', fmtCredits(plan.monthly_credits))}</li>
                <li>· {i18nService.t('mpFeatMaxAccounts').replace('{n}', String(plan.max_accounts_per_platform))}</li>
                <li>· {isFree ? i18nService.t('mpFeatBasicOnly') : i18nService.t('mpFeatAllAbilities')}</li>
              </ul>
              {isLower ? (
                <button disabled className="mt-3 py-2 rounded-lg text-xs font-bold text-center cursor-not-allowed dark:text-claude-darkTextSecondary text-claude-textSecondary" style={{ background: 'rgba(255,255,255,0.06)' }} title={i18nService.t('mpNoDowngradeTip')}>{i18nService.t('mpBelowCurrent')}</button>
              ) : isFree ? (
                <button disabled className="mt-3 py-2 rounded-lg text-xs font-bold text-center cursor-not-allowed dark:text-claude-darkTextSecondary text-claude-textSecondary" style={{ background: 'rgba(255,255,255,0.06)' }}>{!subActive ? i18nService.t('mpCurrentPlan') : i18nService.t('mpFree')}</button>
              ) : isCurActive && autoOn ? (
                <button disabled title={i18nService.t('subAutoRenewHint')} className="mt-3 py-2 rounded-lg text-xs font-bold text-center cursor-not-allowed dark:text-claude-darkTextSecondary text-claude-textSecondary" style={{ background: 'rgba(255,255,255,0.06)' }}>{cta}</button>
              ) : (
                <button disabled={busy} onClick={() => choosePlan(plan.code)} className="mt-3 py-2 rounded-lg text-xs font-bold text-black disabled:opacity-50 hover:brightness-95" style={{ background: tier }}>{cta}</button>
              )}
            </div>
          );
        })}
      </div>

      <p className="mt-5 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('mpFooterNote')} {i18nService.t('cnyRefNote')}</p>

      {/* ── 支付方式弹窗:点套餐卡片后选怎么付 ──
          顺序即推荐序:银行卡(推荐,走 Dodo,连续订阅)→(国内版隐藏 USDT / BNB)→ 官方店铺(卡密)。
          ⚠️ portal 到 body —— 合伙人金色卡片的 filter/glow 会成为 position:fixed 的包含块,
             不 portal 会把全屏遮罩裁进卡片里。 */}
      {methodPlan && createPortal(
        <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setMethodPlan(null)}>
          <div className="w-full max-w-md rounded-2xl p-5 dark:bg-claude-darkSurface bg-white border dark:border-claude-darkBorder border-claude-border shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <div className="text-base font-bold dark:text-claude-darkText text-claude-text">{i18nService.t('payChooseMethod')}</div>
              <button onClick={() => setMethodPlan(null)} className="text-lg leading-none dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-red-400">✕</button>
            </div>
            <div className="space-y-2.5">
              <MethodRow
                icon={<ChainLogo chain="DODO" size={22} />}
                // ⚠️ Dodo 的微信支付【不支持订阅】(只支持一次性付款)—— 连续包月/季/年的收银台
                //   只会出现 Card,所以标题里不能写 WeChat,否则用户选了发现没有微信会以为出错。
                //   单月购买是一次性,微信可用,标题照旧带上。
                title={isOnce ? i18nService.t('dodoCardTabWx') : i18nService.t('dodoCardTab')}
                desc={!dodoEnabled ? i18nService.t('payUnavailable')
                  : !dodoHasPlan(methodPlan) ? i18nService.t('payCardPeriodOff')
                  : isOnce ? i18nService.t('payCardDescOnce') : i18nService.t('payCardDescAuto')}
                badge={i18nService.t('payBadgeBest')}
                disabled={!dodoEnabled || !dodoHasPlan(methodPlan)}
                onClick={() => payWith('DODO', methodPlan)}
              />
              {/* 国内版(HIDE_WEB3)隐藏 USDT / BNB —— 代码保留不删,和 cn 官网一致只留银行卡 + 卡密。 */}
              {!HIDE_WEB3 && (
                <>
                  {!isMonthAuto && (
                    <MethodRow
                      icon={<ChainLogo chain="TRON" size={22} />}
                      title="USDT · TRC20"
                      desc={i18nService.t('payChainAuto')}
                      onClick={() => payWith('TRON', methodPlan)}
                    />
                  )}
                  {!isMonthAuto && (
                    <MethodRow
                      icon={<ChainLogo chain="BSC" size={22} />}
                      title="BNB · BSC"
                      desc={i18nService.t('payChainAuto')}
                      onClick={() => payWith('BSC', methodPlan)}
                    />
                  )}
                </>
              )}
              {!isMonthAuto && (
                <MethodRow
                  icon={<span style={{ fontSize: 20, lineHeight: 1, color: '#facc15', fontWeight: 'bold' }}>¥</span>}
                  title={i18nService.t('payShopTitle')}
                  desc={i18nService.t('payShopDescSub')}
                  onClick={() => payWith('SHOP', methodPlan)}
                />
              )}
              {/* 隐藏了三行就得说清楚为什么,否则拿了卡密/想用链上的用户会以为坏了。 */}
              {isMonthAuto && (
                <p className="pt-1 text-[11px] leading-relaxed dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('payMonthCardOnly')}
                </p>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* ── 官方店铺(卡密)弹窗:去店铺按钮 + 兑换框同窗 ── */}
      {shopOpen && createPortal(
        <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setShopOpen(false)}>
          <div className="w-full max-w-sm rounded-2xl p-5 dark:bg-claude-darkSurface bg-white border dark:border-claude-darkBorder border-claude-border shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <div className="text-base font-bold dark:text-claude-darkText text-claude-text">{i18nService.t('mpShopModalTitle')}</div>
              <button onClick={() => setShopOpen(false)} className="text-lg leading-none dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-red-400">✕</button>
            </div>
            <div className="rounded-lg p-3 mb-4 text-xs leading-relaxed bg-primary/5 border border-primary/20 dark:text-claude-darkTextSecondary text-claude-textSecondary">
              <div>{i18nService.t('mpShopStep1')}</div>
              <div>{i18nService.t('mpShopStep2')}</div>
              <div>{i18nService.t('mpShopStep3')}</div>
            </div>
            <button disabled={!shopUrl} onClick={openShop} className="w-full mb-4 py-2.5 rounded-lg text-sm font-bold text-black bg-primary hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-all">
              {shopUrl ? i18nService.t('mpShopOpen') : i18nService.t('mpShopMissing')}
            </button>
            <div className="text-xs font-semibold dark:text-claude-darkText text-claude-text mb-2">{i18nService.t('mpHaveCode')}</div>
            <div className="flex gap-2">
              <input value={redeemInput} onChange={e => setRedeemInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !redeemBusy) submitRedeem(); }} placeholder={i18nService.t('mpRedeemPlaceholder')} maxLength={32} autoComplete="off" spellCheck={false} className="flex-1 px-3 py-2 rounded-lg dark:bg-claude-darkBg bg-claude-bg border dark:border-claude-darkBorder border-claude-border text-sm font-mono dark:text-claude-darkText text-claude-text uppercase placeholder:normal-case focus:border-primary outline-none" />
              <button disabled={redeemBusy} onClick={submitRedeem} className="px-5 py-2 rounded-lg bg-primary text-black text-sm font-semibold disabled:opacity-50">{redeemBusy ? i18nService.t('mpRedeeming') : i18nService.t('mpRedeem')}</button>
            </div>
            {redeemMsg.text && <div className="mt-2 text-xs" style={{ color: redeemMsg.color }}>{redeemMsg.text}</div>}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
};

export default MembershipPanel;
