import React, { useState, useEffect, useCallback, useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { noobClawAuth } from '../../services/noobclawAuth';
import { noobClawApi } from '../../services/noobclawApi';

// 嵌入「我的充值」页「会员订阅」tab 的会员面板(无独立页面 chrome)。
// 4 档(免费版第一)+ 周期选择 + 支付方式(USDT / BNB / 人民币兑换码)。
// 配色用 .text-primary / .bg-primary 等(随 WalletView 的 partner 金 / 默认绿主题自动适配)。

type Period = 'month' | 'quarter' | 'half' | 'year';
type PayMethod = 'TRON' | 'BSC' | 'RMB';

const PERIODS: Array<{ key: Period; label: string; off?: string }> = [
  { key: 'month', label: '月付' },
  { key: 'quarter', label: '季付', off: '9折' },
  { key: 'half', label: '半年', off: '8折' },
  { key: 'year', label: '年付', off: '7折' },
];
const PERIOD_LABEL: Record<string, string> = { month: '月付', quarter: '季付', half: '半年', year: '年付' };
const RECOMMENDED = 'pro';

function fmtCredits(n: number): string {
  n = Number(n) || 0;
  if (n >= 1e8) return (Math.round(n / 1e7) / 10) + '亿';
  if (n >= 1e4) return Math.round(n / 1e4) + '万';
  return String(n);
}

const MembershipPanel: React.FC = () => {
  const [cfg, setCfg] = useState<Awaited<ReturnType<typeof noobClawApi.getPlanConfig>>>(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<Period>('year');
  const [method, setMethod] = useState<PayMethod>('TRON');
  const [step, setStep] = useState<'select' | 'pay'>('select');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // pay
  const [payPlanName, setPayPlanName] = useState('');
  const [payAmount, setPayAmount] = useState('');
  const [payAddress, setPayAddress] = useState('');
  const [paySymbol, setPaySymbol] = useState<'USDT' | 'BNB'>('USDT');
  const [copied, setCopied] = useState(false);
  // rmb redeem
  const [redeemInput, setRedeemInput] = useState('');
  const [redeemMsg, setRedeemMsg] = useState<{ text: string; color: string }>({ text: '', color: '' });
  const [redeemBusy, setRedeemBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await noobClawApi.getPlanConfig();
    if (data) setCfg(data);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const plans = cfg?.plans || [];
  const cur = cfg?.current;
  const curCode = cur?.planCode || 'free';
  const curPlan = plans.find(p => p.code === curCode) || plans.find(p => p.code === 'free');
  const monthly = curPlan?.monthly_credits || 0;
  const usedPct = cur?.subActive && monthly > 0 ? Math.min(100, Math.round((cur.subUsedRatio || 0) * 100)) : 0;

  const subscribe = async (planCode: string) => {
    if (method === 'RMB') return; // RMB 走兑换码,不在卡片下单
    setBusy(true); setError('');
    const chain = method === 'BSC' ? 'BSC' : 'TRON';
    const res = await noobClawApi.createSubscriptionOrder(planCode, period, chain);
    if (res?.order) {
      const order = res.order;
      const isTron = chain === 'TRON';
      setPayPlanName(plans.find(p => p.code === planCode)?.name_zh || '会员');
      setPayAmount(isTron ? String(parseFloat(order.usdt_amount)) : String(parseFloat(order.bnb_amount)));
      setPaySymbol(isTron ? 'USDT' : 'BNB');
      let addr = res.treasuryWallet || '';
      if (!isTron) { const info: any = await noobClawApi.getPaymentInfo(); addr = info?.chains?.BSC?.treasuryWallet || info?.treasuryWallet || ''; }
      setPayAddress(addr);
      setStep('pay');
      startPoll(order.order_no);
    } else if (res?.code === 'PENDING_LIMIT') {
      setError('有未完成的订单,请先完成支付或等待其过期');
    } else if (res?.code === 'TRON_DISABLED') {
      setError('USDT(TRON)通道未配置,请改用 BNB 或人民币兑换码');
    } else {
      setError(res?.error || '创建订单失败,请稍后重试');
    }
    setBusy(false);
  };

  const startPoll = (orderNo: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const r = await noobClawApi.pollOrderStatus(orderNo);
      const status = r?.order?.status;
      if (status === 'completed') {
        if (pollRef.current) clearInterval(pollRef.current);
        await noobClawAuth.refreshBalance(); await load();
        setStep('select'); setError(''); alert('订阅开通成功!本月算力已发放');
      } else if (status === 'failed' || status === 'cancelled' || status === 'expired') {
        if (pollRef.current) clearInterval(pollRef.current);
        setError('订单已失效或超时,请重新下单'); setStep('select');
      }
    }, 5000);
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

  const back = () => { if (pollRef.current) clearInterval(pollRef.current); setStep('select'); setError(''); };

  if (loading) return <div className="text-center text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary py-12">加载中…</div>;
  if (!cfg) return <div className="text-center text-sm text-red-400 py-12">会员套餐加载失败,请稍后重试(后端需部署)</div>;

  // ── 支付面板(USDT/BNB) ──
  if (step === 'pay') {
    return (
      <div className="max-w-md mx-auto">
        <button onClick={back} className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-primary mb-3">← 返回选择</button>
        <div className="p-5 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border border-primary/20 text-center">
          <div className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">订阅 {payPlanName} · {PERIOD_LABEL[period]}</div>
          <div className="text-2xl font-bold dark:text-claude-darkText text-claude-text">{payAmount} {paySymbol}</div>
          <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-1">请转账精确金额(含小数尾数用于自动对账)</div>
          {payAddress ? (
            <>
              <div className="flex justify-center my-4"><div className="bg-white p-2 rounded-lg"><QRCodeSVG value={payAddress} size={150} /></div></div>
              <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1 text-left">{paySymbol === 'USDT' ? 'USDT-TRC20' : 'BNB (BSC)'} 收款地址</div>
              <div className="flex items-center gap-2 rounded-lg dark:bg-claude-darkBg bg-claude-bg border dark:border-claude-darkBorder border-claude-border px-3 py-2">
                <span className="text-xs break-all flex-1 text-left dark:text-claude-darkText text-claude-text">{payAddress}</span>
                <button onClick={() => { navigator.clipboard.writeText(payAddress); setCopied(true); setTimeout(() => setCopied(false), 1500); }} className="text-xs text-primary shrink-0">{copied ? '已复制' : '复制'}</button>
              </div>
            </>
          ) : <div className="text-sm text-red-400 my-4">收款地址未配置,请联系客服</div>}
          <div className="mt-4 flex items-center justify-center gap-2 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
            <span className="inline-block w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />转账后自动到账,等待链上确认…
          </div>
        </div>
      </div>
    );
  }

  // ── 选择视图 ──
  const planName = (p: any) => p?.name_zh || p?.name_en || '';
  const sorted = [...plans].sort((a, b) => a.sort_order - b.sort_order); // free 在前

  return (
    <div>
      {/* 当前档 + 用量 */}
      <div className="p-4 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border mb-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <span className="px-3 py-1 rounded-full text-xs font-semibold bg-primary/15 text-primary">当前:{curPlan ? planName(curPlan) : '免费版'}</span>
          {cur?.subActive && cur.periodEnd && <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">到期 {new Date(cur.periodEnd).toLocaleDateString()}</span>}
        </div>
        {cur?.subActive && monthly > 0 && (
          <div className="mt-3">
            <div className="flex justify-between text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1"><span>本月用量</span><span>{usedPct}%</span></div>
            <div className="h-2 rounded-full dark:bg-claude-darkBg bg-claude-bg overflow-hidden"><div className="h-full bg-primary transition-all" style={{ width: `${usedPct}%` }} /></div>
          </div>
        )}
      </div>

      {/* 支付方式 */}
      <div className="mb-3 flex gap-2 p-1 rounded-lg dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
        {([['TRON', 'USDT'], ['BSC', 'BNB'], ['RMB', '人民币(兑换码)']] as Array<[PayMethod, string]>).map(([m, label]) => (
          <button key={m} onClick={() => { setMethod(m); setError(''); }} className={`flex-1 py-2 rounded-md text-xs font-semibold transition-all ${method === m ? 'bg-primary/15 text-primary' : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'}`}>{label}</button>
        ))}
      </div>

      {/* 周期(仅链上支付) */}
      {method !== 'RMB' && (
        <div className="mb-4 inline-flex rounded-lg overflow-hidden border dark:border-claude-darkBorder border-claude-border">
          {PERIODS.map(p => (
            <button key={p.key} onClick={() => setPeriod(p.key)} className={`px-3 py-2 text-xs ${period === p.key ? 'bg-primary text-black' : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText'}`}>{p.label}{p.off && <span className="ml-1 opacity-80">{p.off}</span>}</button>
          ))}
        </div>
      )}

      {error && <div className="mb-3 p-3 rounded-lg bg-red-500/5 border border-red-500/20 text-xs text-red-400">{error}</div>}

      {/* 套餐卡(4 档,免费版第一) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {sorted.map(plan => {
          const isFree = plan.code === 'free';
          const isCur = plan.code === curCode;
          const isRec = plan.code === RECOMMENDED;
          const price = plan.prices?.[period];
          return (
            <div key={plan.code} className={`relative rounded-xl p-4 flex flex-col border ${isRec ? 'border-primary shadow-[0_0_20px_-6px] shadow-primary/40' : isCur ? 'border-primary/50' : 'dark:border-claude-darkBorder border-claude-border'} dark:bg-claude-darkSurface bg-claude-surface`}>
              {isRec && <span className="absolute -top-2 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full text-[10px] font-bold bg-primary text-black whitespace-nowrap">最受欢迎</span>}
              <div className="text-base font-semibold dark:text-claude-darkText text-claude-text">{planName(plan)}</div>
              {isFree ? (
                <div className="mt-2 text-xl font-bold dark:text-claude-darkText text-claude-text">¥0</div>
              ) : (
                <div className="mt-2">
                  <div className="flex items-baseline gap-1"><span className="text-xl font-bold dark:text-claude-darkText text-claude-text">¥{price?.cny ?? plan.price_cny}</span><span className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">/{PERIODS.find(p => p.key === period)?.label}</span></div>
                  <div className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">≈ ${price?.usd ?? plan.price_usd}</div>
                </div>
              )}
              <ul className="mt-3 space-y-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary flex-1">
                <li>· {isFree ? '注册礼 100万 算力' : `每月 ${fmtCredits(plan.monthly_credits)} 算力`}</li>
                <li>· 单平台最多 {plan.max_accounts_per_platform} 个号</li>
                <li>· {isFree ? '仅基础能力' : '全部能力可用'}</li>
              </ul>
              {isFree ? (
                <div className="mt-3 py-2 text-center text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{isCur ? '当前方案' : '免费'}</div>
              ) : method === 'RMB' ? (
                <div className="mt-3 py-2 text-center text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">人民币请用下方兑换码</div>
              ) : (
                <button disabled={busy} onClick={() => subscribe(plan.code)} className={`mt-3 py-2 rounded-lg text-xs font-semibold disabled:opacity-50 ${isCur ? 'dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkTextSecondary text-claude-textSecondary' : 'bg-primary text-black hover:bg-primary-hover'}`}>{isCur ? '续费 / 升级' : '订阅'}</button>
              )}
            </div>
          );
        })}
      </div>

      {/* 人民币兑换码 */}
      {method === 'RMB' && (
        <div className="mt-4 p-4 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
          <div className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-1">人民币订阅(兑换码)</div>
          <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-3">在店铺购买订阅卡密后,在此输入兑换即可开通对应档位与周期。</div>
          <div className="flex gap-2">
            <input value={redeemInput} onChange={e => setRedeemInput(e.target.value)} placeholder="输入订阅兑换码" className="flex-1 px-3 py-2 rounded-lg dark:bg-claude-darkBg bg-claude-bg border dark:border-claude-darkBorder border-claude-border text-sm dark:text-claude-darkText text-claude-text focus:border-primary outline-none" />
            <button disabled={redeemBusy} onClick={submitRedeem} className="px-5 py-2 rounded-lg bg-primary text-black text-sm font-semibold disabled:opacity-50">{redeemBusy ? '兑换中…' : '兑换'}</button>
          </div>
          {redeemMsg.text && <div className="mt-2 text-xs" style={{ color: redeemMsg.color }}>{redeemMsg.text}</div>}
        </div>
      )}

      <p className="mt-5 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">订阅赠送的算力按月发放、到期清零;你充值的算力永久有效、不受影响。到期需手动续费(暂不自动扣款)。</p>
    </div>
  );
};

export default MembershipPanel;
