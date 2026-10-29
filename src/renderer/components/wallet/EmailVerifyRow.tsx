import React from 'react';
import { noobClawAuth } from '../../services/noobclawAuth';
import { i18nService } from '../../services/i18n';

// 账户卡邮箱行 + 绑定/认证弹窗(2026-09-21)。
// profile 由 /api/user/profile 带回:account_type / email / social_email / emailVerified。
// - 已验证 → 「已绑定」锁定(暂不支持解绑换绑)。
// - 账密账号未验证(有 email 但未验证)→ 「未认证」+ 认证按钮 + 送 token 徽章。
// - 社交号【有邮箱】→ 不管(不渲染)。社交号【无邮箱】→ 「暂无邮箱」+ 绑定按钮 + 徽章。
interface Props {
  profile: any;
  onVerified?: () => void;  // 验证成功后让父组件刷新 profile
}

export const EmailVerifyRow: React.FC<Props> = ({ profile, onVerified }) => {
  const t = (k: string) => i18nService.t(k);
  const [open, setOpen] = React.useState(false);
  const [email, setEmail] = React.useState('');
  const [code, setCode] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  const [toast, setToast] = React.useState('');
  const [cd, setCd] = React.useState(0);
  const [successBonus, setSuccessBonus] = React.useState<number | null>(null);  // 非 null = 显示绑定成功领奖弹窗

  const accountType = profile?.account_type;
  const isPassword = accountType === 'password';
  const verified = !!profile?.emailVerified;
  const existing = (profile?.email || profile?.social_email || '') as string;
  const hasSocialEmail = !isPassword && !!profile?.social_email;

  // 社交号已带邮箱 → 交给第三方,不显示本行。
  if (hasSocialEmail && !isPassword) return null;

  const emailOk = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(''), 4200); };
  const tick = (secs: number) => { setCd(secs); const iv = setInterval(() => setCd(v => { if (v <= 1) { clearInterval(iv); return 0; } return v - 1; }), 1000); };

  const openModal = () => { setOpen(true); setErr(''); setCode(''); setEmail(isPassword && profile?.email ? profile.email : ''); };

  const sendCode = async () => {
    setErr('');
    if (!emailOk(email)) { setErr(t('pwErrEmail')); return; }
    const r = await noobClawAuth.sendEmailCode('verify', { email: email.trim().toLowerCase() });
    if (!r.ok) { if (r.retryAfter) tick(r.retryAfter); setErr(r.message || t('pwErrGeneric')); return; }
    showToast(t('pwCodeSent'));
    tick(60);
  };

  const submit = async () => {
    setErr('');
    if (!emailOk(email)) { setErr(t('pwErrEmail')); return; }
    if (!code.trim()) { setErr(t('pwErrCode')); return; }
    setBusy(true);
    try {
      const r = await noobClawAuth.verifyEmail(email.trim().toLowerCase(), code.trim());
      if (!r.ok) { setErr(r.message || t('pwErrGeneric')); return; }
      setOpen(false);
      setSuccessBonus(r.bonus || 0);   // 弹「绑定成功」领奖弹窗(0 则只显示已绑定)
      onVerified?.();
    } finally { setBusy(false); }
  };

  const inputCls = 'w-full px-3 py-2.5 rounded-lg text-sm dark:bg-white/5 bg-gray-50 border dark:border-white/10 border-gray-200 dark:text-white text-gray-900 focus:outline-none focus:border-green-500/50 mb-2';

  return (
    <div className="flex items-center gap-2 mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="4" width="20" height="16" rx="2" /><path d="M22 7l-10 6L2 7" /></svg>
      {verified ? (
        <span className="truncate">{existing} · <span className="text-primary">{t('acctEmailBound')}</span></span>
      ) : (
        <>
          <span className="truncate">{existing ? <>{existing} · <span className="text-yellow-500">{t('acctEmailUnverified')}</span></> : <span className="text-gray-500">{t('acctEmailNone')}</span>}</span>
          <button
            onClick={openModal}
            className="relative shrink-0 px-2 py-0.5 rounded-md text-[11px] font-semibold border border-green-500/40 text-green-400 hover:bg-green-500/10 transition-colors"
          >
            {existing ? t('acctVerifyBtn') : t('acctBindBtn')}
            <span className="absolute -top-2 -right-1.5 px-1.5 py-0.5 rounded-full text-[9px] font-bold leading-none text-white whitespace-nowrap" style={{ background: 'linear-gradient(135deg,#ff006e,#ff9500)', boxShadow: '0 2px 8px rgba(255,0,110,0.5)' }}>+3万</span>
          </button>
        </>
      )}

      {open && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setOpen(false)}>
          <div className="w-full max-w-sm mx-4 p-6 rounded-2xl border border-green-500/30 dark:bg-[#12121a] bg-white shadow-2xl relative" onClick={e => e.stopPropagation()}>
            <button onClick={() => setOpen(false)} aria-label="Close" className="absolute top-3 right-3 w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:text-white">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
            </button>
            <h3 className="text-lg font-bold dark:text-white text-gray-900 mb-1">{t('bindEmailTitle')}</h3>
            <p className="text-[11px] text-green-500 mb-4">{t('beTip')}</p>
            <div className="flex gap-2">
              <input className={`${inputCls} flex-1 min-w-0`} type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" maxLength={255} />
              <button type="button" onClick={sendCode} disabled={cd > 0} className="shrink-0 mb-2 px-3 rounded-lg border border-green-500/40 text-green-400 text-xs font-semibold hover:bg-green-500/10 transition-colors disabled:opacity-50 whitespace-nowrap">
                {cd > 0 ? `${cd}s` : t('pwSendCode')}
              </button>
            </div>
            <p className="text-[11px] dark:text-gray-500 text-gray-400 mb-2">{t('beEditable')}</p>
            <input className={inputCls} value={code} onChange={e => setCode(e.target.value)} inputMode="numeric" maxLength={6} placeholder={t('pwEmailCodePh').replace('（选填）', '').replace(' (optional)', '')} />
            {err && <p className="text-xs text-red-400 mb-2">{err}</p>}
            <button onClick={submit} disabled={busy} className="w-full py-3 rounded-xl bg-green-500 text-black font-semibold hover:bg-green-600 transition-all disabled:opacity-60">
              {busy ? '…' : t('beVerify')}
            </button>
          </div>
        </div>
      )}

      {successBonus !== null && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center backdrop-blur-sm" style={{ background: 'rgba(0,0,0,0.82)' }} onClick={() => setSuccessBonus(null)}>
          <div className="text-center rounded-2xl w-full max-w-xs mx-4 p-8 relative" style={{ background: 'linear-gradient(160deg,#0f1c15,#0a0e14)', border: '1px solid rgba(34,197,94,0.4)', boxShadow: '0 0 60px rgba(34,197,94,0.28)' }} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 56, lineHeight: 1 }} className="mb-2">🎉</div>
            <h3 className="text-white text-xl font-bold mb-1">{t('bsTitle')}</h3>
            <p className="text-xs text-gray-400 mb-5">{successBonus > 0 ? t('bsSub') : t('bsSubNoBonus')}</p>
            {successBonus > 0 && (
              <div className="mb-6">
                <div className="text-[11px] text-gray-400 mb-1">{t('bsReward')}</div>
                <div className="text-4xl font-extrabold" style={{ color: '#22c55e', textShadow: '0 0 22px rgba(34,197,94,0.55)' }}>+{successBonus.toLocaleString()}</div>
                <div className="text-xs text-green-400 mt-1">{t('bsCredits')}</div>
              </div>
            )}
            <button onClick={() => setSuccessBonus(null)} className="w-full py-3 rounded-xl bg-green-500 text-black font-semibold hover:bg-green-600 transition-all">{t('bsBtn')}</button>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed left-1/2 bottom-10 -translate-x-1/2 z-[100] max-w-[88vw] px-4 py-3 rounded-xl bg-[#111]/95 border border-green-500/40 text-green-50 text-xs leading-relaxed shadow-2xl text-center">
          {toast}
        </div>
      )}
    </div>
  );
};

export default EmailVerifyRow;
