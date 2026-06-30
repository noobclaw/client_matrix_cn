import React, { useState, useEffect, useCallback } from 'react';
import { noobClawAuth } from '../../services/noobclawAuth';
import { noobClawApi } from '../../services/noobclawApi';
import { readCachedPlanConfig, writeCachedPlanConfig } from '../../services/paymentInfoCache';

// 嵌入「我的充值」页「会员订阅」tab 的会员面板(无独立页面 chrome)。
// 4 档(免费版第一)+ 周期选择 + 支付方式(USDT / BNB / 人民币兑换码)。
// 配色用 .text-primary / .bg-primary 等(随 WalletView 的 partner 金 / 默认绿主题自动适配)。

type Period = 'month' | 'quarter' | 'half' | 'year';
type PayMethod = 'TRON' | 'BSC' | 'RMB';

// 币种图标(对齐购买积分那排支付方式 tab)。本地复制自 WalletView 的 ChainLogo:
// WalletView 已 import 本组件,反向 import 会形成循环依赖,故按矩阵惯例就地复制两枚 SVG。
const ChainLogo: React.FC<{ chain: 'BSC' | 'TRON'; size?: number }> = ({ chain, size = 16 }) => {
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

const PERIODS: Array<{ key: Period; label: string }> = [
  { key: 'month', label: '月付' },
  { key: 'quarter', label: '季付' },
  { key: 'half', label: '半年' },
  { key: 'year', label: '年付' },
];
const PERIOD_LABEL: Record<string, string> = { month: '月', quarter: '季', half: '半年', year: '年' };
const PERIOD_MONTHS: Record<Period, number> = { month: 1, quarter: 3, half: 6, year: 12 };
const RECOMMENDED = 'pro';
// 档位主题色:免费灰 / 基础蓝银 / 进阶金 / 旗舰紫。
const TIER_COLOR: Record<string, string> = { free: '#9aa0aa', basic: '#60a5fa', pro: '#fbbf24', max: '#a78bfa' };

function fmtCredits(n: number): string {
  n = Number(n) || 0;
  if (n >= 1e8) return (Math.round(n / 1e7) / 10) + '亿';
  if (n >= 1e4) return Math.round(n / 1e4) + '万';
  return String(n);
}

const MembershipPanel: React.FC<{ onPay?: (planCode: string, period: Period, chain: 'TRON' | 'BSC') => Promise<string | null> }> = ({ onPay }) => {
  // 套餐配置:先读 localStorage 缓存秒出(对齐购买积分),后台 fetch 静默覆盖。
  // 有缓存就不显示「加载中…」,只在首次无缓存时才阻塞。
  const [cfg, setCfg] = useState<Awaited<ReturnType<typeof noobClawApi.getPlanConfig>>>(() => readCachedPlanConfig());
  const [loading, setLoading] = useState<boolean>(() => !readCachedPlanConfig());
  const [period, setPeriod] = useState<Period>('month');
  const [method, setMethod] = useState<PayMethod>('TRON');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // rmb redeem
  const [redeemInput, setRedeemInput] = useState('');
  const [redeemMsg, setRedeemMsg] = useState<{ text: string; color: string }>({ text: '', color: '' });
  const [redeemBusy, setRedeemBusy] = useState(false);
  // CNY 店铺地址:复用「购买积分」同一个后端下发地址(system_config.xianyu_shop_url,admin 可改)。
  const [shopUrl, setShopUrl] = useState('https://pay.ldxp.cn/shop/noobclaw');

  const load = useCallback(async () => {
    const data = await noobClawApi.getPlanConfig();
    if (data) { setCfg(data); writeCachedPlanConfig(data); }
    setLoading(false);
    // 拉 CNY 店铺地址(失败保留默认);与购买积分共用 /cny/packages 的 xianyu_shop_url。
    try { const rp = await noobClawApi.getRedeemPackages(); if (rp?.xianyu_shop_url) setShopUrl(rp.xianyu_shop_url); } catch { /* 用默认 */ }
  }, []);

  // CNY「订阅」按钮:新开系统浏览器到店铺(店铺买卡密 → 回来在下方兑换码框输入开通)。
  const openShop = () => { try { (window as any).electron?.shell?.openExternal?.(shopUrl); } catch { /* noop */ } };

  useEffect(() => { load(); }, [load]);

  const plans = cfg?.plans || [];
  const cur = cfg?.current;
  const curCode = cur?.planCode || 'free';
  // 只升级不降级:订阅有效时,低于当前档的卡片置灰不可买;当前档=续费、更高档=升级。
  //   未订阅/已过期 → 视同免费档(order 0),所有付费档都可选(「到期回免费版又都能选」)。
  const subActive = !!cur?.subActive;
  const curOrder = subActive ? (plans.find(p => p.code === curCode)?.sort_order ?? 0) : 0;

  // 订阅下单交给 WalletView,复用「购买积分」那套支付步骤(QR/倒计时/轮询/取消)。失败回错误串在此显示。
  const subscribe = async (planCode: string) => {
    if (method === 'RMB' || !onPay) return;
    setBusy(true); setError('');
    const chain: 'TRON' | 'BSC' = method === 'BSC' ? 'BSC' : 'TRON';
    const err = await onPay(planCode, period, chain);
    if (err) setError(err);
    setBusy(false);
  };

  const submitRedeem = async () => {
    const code = redeemInput.trim();
    if (!code) { setRedeemMsg({ text: '请输入兑换码', color: '#ef4444' }); return; }
    setRedeemBusy(true); setRedeemMsg({ text: '', color: '' });
    try {
      const d = await noobClawApi.redeemCode(code);
      if (!d || !d.ok) { setRedeemMsg({ text: (d && d.message) || '兑换失败', color: '#ef4444' }); return; }
      setRedeemInput('');
      setRedeemMsg({
        text: d.product_type === 'subscription'
          ? `✅ 会员已开通(${PERIOD_LABEL[d.plan_period || ''] || ''}),本月算力已发放`
          : `✅ 已到账 ${Number(d.credits ?? 0).toLocaleString()} 算力`,
        color: '#22c55e',
      });
      await noobClawAuth.refreshBalance(); await load();
    } finally { setRedeemBusy(false); }
  };

  if (loading) return <div className="text-center text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary py-12">加载中…</div>;
  if (!cfg) return <div className="text-center text-sm text-red-400 py-12">会员套餐加载失败,请稍后重试(后端需部署)</div>;

  // ── 选择视图 ──
  const planName = (p: any) => p?.name_zh || p?.name_en || '';
  const sorted = [...plans].sort((a, b) => a.sort_order - b.sort_order); // free 在前

  return (
    <div>
      {/* 支付方式 + 周期:同一行两组菜单(左=支付方式 / 右=周期),折扣在卡片里显示 */}
      <div className="mb-4 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex gap-2 p-1 rounded-lg dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
          {([['TRON', 'USDT · TRC20'], ['BSC', 'BNB · BSC'], ['RMB', 'CNY(兑换码)']] as Array<[PayMethod, string]>).map(([m, label]) => (
            <button key={m} onClick={() => { setMethod(m); setError(''); }} className={`flex items-center justify-center gap-2 px-4 py-2 rounded-md text-xs font-semibold transition-all ${method === m ? 'bg-primary/15 text-primary' : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'}`}>
              {(m === 'TRON' || m === 'BSC') && <ChainLogo chain={m} size={16} />}
              {label}
            </button>
          ))}
        </div>
        <div className="inline-flex rounded-lg overflow-hidden border dark:border-claude-darkBorder border-claude-border">
          {PERIODS.map(p => (
            <button key={p.key} onClick={() => setPeriod(p.key)} className={`px-4 py-2 text-xs ${period === p.key ? 'bg-primary text-black font-semibold' : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText'}`}>{p.label}</button>
          ))}
        </div>
      </div>

      {error && <div className="mb-3 p-3 rounded-lg bg-red-500/5 border border-red-500/20 text-xs text-red-400">{error}</div>}

      {/* 套餐卡(4 档,免费版第一) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {sorted.map(plan => {
          const isFree = plan.code === 'free';
          const isCur = plan.code === curCode;
          const isCurActive = subActive && isCur;          // 当前档(订阅有效)→ 续费
          const isLower = subActive && plan.sort_order < curOrder; // 低于当前档 → 不可降级(置灰)
          const cta = isCurActive ? '续费' : (subActive ? '升级' : '订阅');
          const isRec = plan.code === RECOMMENDED;
          const price = plan.prices?.[period];
          const tier = TIER_COLOR[plan.code] || '#9aa0aa';
          // 币种跟支付方式:USDT/BNB → 美元 $;CNY → 人民币 ¥。
          const useCny = method === 'RMB';
          const sym = useCny ? '¥' : '$';
          const months = PERIOD_MONTHS[period];
          const discount = price?.discount ?? 1;
          const finalP = isFree ? 0 : (useCny ? (price?.cny ?? plan.price_cny) : (price?.usd ?? plan.price_usd));
          const origP = useCny ? (plan.price_cny * months) : (plan.price_usd * months);
          const hasDiscount = !isFree && discount < 0.999;
          const off = Math.round(discount * 100) / 10; // 0.7→7、0.9→9
          return (
            <div key={plan.code} className={`relative rounded-2xl p-4 flex flex-col dark:bg-claude-darkSurface bg-claude-surface ${isLower ? 'opacity-50' : ''}`}
              style={{ border: `${isRec ? 2 : 1}px solid`, borderColor: isRec ? tier : (isCur ? tier + '88' : 'rgba(255,255,255,0.08)'), boxShadow: isRec ? `0 0 26px -10px ${tier}` : undefined }}>
              {isRec && <span className="absolute -top-2.5 right-3 px-2 py-0.5 rounded-full text-[10px] font-bold text-black whitespace-nowrap" style={{ background: tier }}>最受欢迎</span>}
              {/* 档位名 + 档位色点 + 限时折扣 */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: tier }} />
                <span className="text-base font-semibold dark:text-claude-darkText text-claude-text">{planName(plan)}</span>
                {hasDiscount && <span className="px-1.5 py-0.5 rounded text-[10px] font-bold" style={{ background: '#ef444422', color: '#f87171' }}>限时{off}折</span>}
              </div>
              {/* 价格:最终价大字 + 原价划掉 + /周期 */}
              <div className="mt-3 flex items-end gap-1.5 flex-wrap">
                <span className="text-2xl font-extrabold dark:text-claude-darkText text-claude-text">{sym}{finalP}</span>
                {hasDiscount && <span className="text-xs line-through dark:text-claude-darkTextSecondary text-claude-textSecondary">{sym}{Math.round(origP)}</span>}
                {!isFree && <span className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">/{PERIOD_LABEL[period]}</span>}
              </div>
              <ul className="mt-3 space-y-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary flex-1">
                <li>· {isFree ? '注册礼 100万 积分' : `每月 ${fmtCredits(plan.monthly_credits)} 积分`}</li>
                <li>· 最大 {plan.max_accounts_per_platform} 矩阵号/平台</li>
                <li>· {isFree ? '仅基础能力' : '全部能力可用'}</li>
              </ul>
              {isLower ? (
                <button disabled className="mt-3 py-2 rounded-lg text-xs font-bold text-center cursor-not-allowed dark:text-claude-darkTextSecondary text-claude-textSecondary" style={{ background: 'rgba(255,255,255,0.06)' }} title="会员只能升级,不能降级;到期回免费版后可重新选择">低于当前会员</button>
              ) : isFree ? (
                <button disabled className="mt-3 py-2 rounded-lg text-xs font-bold text-center cursor-not-allowed dark:text-claude-darkTextSecondary text-claude-textSecondary" style={{ background: 'rgba(255,255,255,0.06)' }}>{!subActive ? '当前方案' : '免费'}</button>
              ) : method === 'RMB' ? (
                // CNY:同样显示「订阅」按钮,点击新开浏览器到店铺购买卡密(回来在下方输入兑换码开通)。
                <button onClick={openShop} className="mt-3 py-2 rounded-lg text-xs font-bold text-black hover:brightness-95" style={{ background: tier }}>{cta}</button>
              ) : (
                <button disabled={busy} onClick={() => subscribe(plan.code)} className="mt-3 py-2 rounded-lg text-xs font-bold text-black disabled:opacity-50 hover:brightness-95" style={{ background: tier }}>{cta}</button>
              )}
            </div>
          );
        })}
      </div>

      {/* 人民币兑换码 */}
      {method === 'RMB' && (
        <div className="mt-4 p-4 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
          <div className="flex items-center justify-between gap-2 mb-1">
            <div className="text-sm font-medium dark:text-claude-darkText text-claude-text">CNY 订阅(兑换码)</div>
            <button onClick={openShop} className="px-3 py-1 rounded-lg text-xs font-semibold bg-primary/15 text-primary hover:bg-primary/25 transition-colors">去店铺购买 →</button>
          </div>
          <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-3">点上方档位「订阅」或「去店铺购买」进店买卡密,回来在此输入兑换即可开通对应档位与周期。</div>
          <div className="flex gap-2">
            <input value={redeemInput} onChange={e => setRedeemInput(e.target.value)} placeholder="输入订阅兑换码" className="flex-1 px-3 py-2 rounded-lg dark:bg-claude-darkBg bg-claude-bg border dark:border-claude-darkBorder border-claude-border text-sm dark:text-claude-darkText text-claude-text focus:border-primary outline-none" />
            <button disabled={redeemBusy} onClick={submitRedeem} className="px-5 py-2 rounded-lg bg-primary text-black text-sm font-semibold disabled:opacity-50">{redeemBusy ? '兑换中…' : '兑换'}</button>
          </div>
          {redeemMsg.text && <div className="mt-2 text-xs" style={{ color: redeemMsg.color }}>{redeemMsg.text}</div>}
        </div>
      )}

      <p className="mt-5 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">订阅赠送的算力按月发放、到期清零。</p>
    </div>
  );
};

export default MembershipPanel;
