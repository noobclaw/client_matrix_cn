import React from 'react';
import { noobClawAuth } from '../services/noobclawAuth';
import { i18nService } from '../services/i18n';
import { getBackendApiUrl, getWebsiteUrl } from '../services/endpoints';

interface LoginWallProps {
  onDismiss?: () => void;
  // Kept for prop-shape compatibility with App.tsx; the "Skip login + use
  // your own API key" path was removed at user request, so this is unused.
  onSwitchToCustomApi?: () => void;
}

const inputCls =
  'w-full px-3 py-2.5 rounded-lg text-sm dark:bg-white/5 bg-gray-50 border dark:border-white/10 border-gray-200 dark:text-white text-gray-900 focus:outline-none focus:border-green-500/50 mb-2';

// Terms / Disclaimer live on the website (root paths exist in both editions).
const openExternal = (url: string) => {
  try { (window as any).electron?.shell?.openExternal?.(url); } catch { /* ignore */ }
};

export const LoginWall: React.FC<LoginWallProps> = ({ onDismiss }) => {
  // Password-account form state. The form posts straight to the backend
  // (noobClawAuth.passwordAuth) — no browser hop, no Web3Auth. Wallet/social
  // login keeps going through the website like before.
  const [mode, setMode] = React.useState<'login' | 'register' | 'forgot'>('login');
  const [account, setAccount] = React.useState('');
  const [username, setUsername] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [emailCode, setEmailCode] = React.useState('');
  const [contactType, setContactType] = React.useState('wechat');
  const [contactValue, setContactValue] = React.useState('');
  const [agree, setAgree] = React.useState(true);
  const [password, setPassword] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  const [toast, setToast] = React.useState('');

  // Forgot-password state
  const [fgAccount, setFgAccount] = React.useState('');
  const [fgCode, setFgCode] = React.useState('');
  const [fgNew, setFgNew] = React.useState('');
  const [fgConfirm, setFgConfirm] = React.useState('');
  const [showContact, setShowContact] = React.useState(false);
  const [contactImgs, setContactImgs] = React.useState<Array<{ label: string; image: string }>>([]);

  // Send-code cooldown (per button), seconds remaining
  const [regCd, setRegCd] = React.useState(0);
  const [fgCd, setFgCd] = React.useState(0);
  const tick = (setter: React.Dispatch<React.SetStateAction<number>>, secs: number) => {
    setter(secs);
    const iv = setInterval(() => setter(v => { if (v <= 1) { clearInterval(iv); return 0; } return v - 1; }), 1000);
  };

  const t = (k: string) => i18nService.t(k);
  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(''), 4200); };

  // 注册礼角标数字后端下发(/api/auth/signup-gift,读 admin initial_free_tokens + 人数分档);拿不到就不显示数字。
  const [giftLabel, setGiftLabel] = React.useState('');
  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`${getBackendApiUrl()}/api/auth/signup-gift`);
        const d = await r.json();
        const tok = d && d.ok ? Number(d.tokens) : 0;
        if (!alive || !(tok > 0)) return;
        const lang = i18nService.currentLanguage || 'en';
        let n: string;
        if (/^zh/.test(lang) || lang.startsWith('ja')) n = (tok / 10000) + '万';
        else if (lang.startsWith('ko')) n = (tok / 10000) + '만';
        else n = tok >= 1000000 ? (tok / 1000000) + 'M' : tok >= 1000 ? (tok / 1000) + 'K' : String(tok);
        setGiftLabel(t('pwRegGift').replace('{n}', n));
      } catch { /* 拿不到就不显示,不误报数字 */ }
    })();
    return () => { alive = false; };
  }, []);

  const emailOk = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());

  const sendRegCode = async () => {
    setErr('');
    if (!emailOk(email)) { setErr(t('pwErrEmail')); return; }
    const r = await noobClawAuth.sendEmailCode('verify', { email: email.trim().toLowerCase() });
    if (!r.ok) { if (r.retryAfter) tick(setRegCd, r.retryAfter); setErr(r.message || t('pwErrGeneric')); return; }
    showToast(t('pwCodeSent'));
    tick(setRegCd, 60);
  };

  const submit = async () => {
    setErr('');
    if (mode === 'login') {
      if (!account.trim() || !password) { setErr(t('pwErrRequired')); return; }
    } else {
      if (!/^[a-z0-9_]{4,32}$/.test(username.trim().toLowerCase())) { setErr(t('pwErrUsername')); return; }
      if (!emailOk(email)) { setErr(t('pwErrEmail')); return; }
      if (password.length < 8) { setErr(t('pwErrPassword')); return; }
      if (password !== confirm) { setErr(t('pwErrMismatch')); return; }
      if (contactValue.trim() && contactType === 'qq' && !/^\d{5,12}$/.test(contactValue.trim())) { setErr(t('pwErrQQ')); return; }
      if (!agree) { setErr(t('pwErrAgree')); return; }
    }
    setBusy(true);
    try {
      let result;
      if (mode === 'login') {
        result = await noobClawAuth.passwordAuth('login', { account: account.trim().toLowerCase(), password });
      } else {
        const body: Record<string, string> = {
          username: username.trim().toLowerCase(),
          email: email.trim().toLowerCase(),
          password,
        };
        if (emailCode.trim()) body.emailCode = emailCode.trim();
        if (contactValue.trim()) { body.contactType = contactType; body.contactValue = contactValue.trim(); }
        result = await noobClawAuth.passwordAuth('register', body);
      }
      if (!result.ok) {
        let m = result.message || t('pwErrGeneric');
        if (mode === 'login' && result.suggestReset) m += t('pwSuggestReset');
        setErr(m);
        return;
      }
      if (result.bonus && result.bonus > 0) showToast(t('pwBonusToast').replace('{n}', result.bonus.toLocaleString()));
      onDismiss?.();
    } finally {
      setBusy(false);
    }
  };

  const sendResetCode = async () => {
    setErr(''); setShowContact(false);
    if (!fgAccount.trim()) { setErr(t('pwErrRequired')); return; }
    const r = await noobClawAuth.sendEmailCode('reset', { account: fgAccount.trim() });
    if (!r.ok) {
      if (r.error === 'EMAIL_NOT_VERIFIED') { await loadContact(); return; }
      if (r.retryAfter) tick(setFgCd, r.retryAfter);
      setErr(r.message || t('pwErrGeneric'));
      return;
    }
    showToast(t('pwCodeSent'));
    tick(setFgCd, 60);
  };

  const submitReset = async () => {
    setErr('');
    if (!fgAccount.trim() || !fgCode.trim()) { setErr(t('pwErrRequired')); return; }
    if (fgNew.length < 8) { setErr(t('pwErrPassword')); return; }
    if (fgNew !== fgConfirm) { setErr(t('pwErrMismatch')); return; }
    setBusy(true);
    try {
      const r = await noobClawAuth.resetPassword(fgAccount.trim(), fgCode.trim(), fgNew);
      if (!r.ok) {
        if (r.error === 'EMAIL_NOT_VERIFIED') { await loadContact(); return; }
        setErr(r.message || t('pwErrGeneric'));
        return;
      }
      showToast(t('pwResetOk'));
      setAccount(fgAccount.trim());
      setMode('login');
    } finally {
      setBusy(false);
    }
  };

  const loadContact = async () => {
    setShowContact(true);
    if (contactImgs.length) return;
    const c = await noobClawAuth.fetchContact();
    const out: Array<{ label: string; image: string }> = [];
    if (c.wechat?.image) out.push({ label: 'WeChat', image: c.wechat.image });
    if (c.qq_service?.image) out.push({ label: 'QQ', image: c.qq_service.image });
    setContactImgs(out);
  };

  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !busy) { e.preventDefault(); mode === 'forgot' ? submitReset() : submit(); }
  };

  const goMode = (m: 'login' | 'register' | 'forgot') => { setMode(m); setErr(''); setShowContact(false); if (m === 'forgot' && account.trim()) setFgAccount(account.trim()); };

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-sm mx-4 p-8 rounded-2xl border border-green-500/30 dark:bg-[#12121a] bg-white shadow-2xl text-center relative max-h-[90vh] overflow-y-auto">
        {/* Close (X) — top-right */}
        <button
          onClick={onDismiss}
          aria-label="Close"
          className="absolute top-3 right-3 w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-white dark:hover:bg-white/5 hover:bg-gray-100 transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>

        {/* Logo */}
        <div className="w-16 h-16 mx-auto mb-4 rounded-2xl overflow-hidden">
          <img src="logo.png" alt="NoobClaw" className="w-full h-full object-cover" />
        </div>

        <h2 className="text-xl font-bold dark:text-white text-gray-900 mb-2">
          {i18nService.t('loginWallTitle')}
        </h2>
        <p className="dark:text-gray-400 text-gray-500 text-sm mb-4 leading-relaxed">
          {i18nService.t('loginWallDescOpenSource')}
          <span
            className="text-blue-400 hover:text-blue-300 cursor-pointer font-medium"
            onClick={() => window.electron?.shell?.openExternal?.('https://github.com/noobclaw')}
          >
            {i18nService.t('loginWallViewSource')}
          </span>
        </p>

        {mode !== 'forgot' && (
          <div className="flex gap-2 mb-3">
            <button
              onClick={() => goMode('login')}
              className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-all ${mode === 'login' ? 'bg-green-500/20 border border-green-500/40 text-green-400' : 'border dark:border-white/10 border-gray-200 dark:text-gray-400 text-gray-500 hover:text-green-400'}`}
            >
              {t('pwLoginTab')}
            </button>
            <button
              onClick={() => goMode('register')}
              className={`relative flex-1 py-2 rounded-lg text-sm font-semibold transition-all ${mode === 'register' ? 'bg-green-500/20 border border-green-500/40 text-green-400' : 'border dark:border-white/10 border-gray-200 dark:text-gray-400 text-gray-500 hover:text-green-400'}`}
            >
              {t('pwRegisterTab')}
              {giftLabel ? <span className="absolute -top-2.5 -right-1 px-2 py-1 rounded-full text-[10px] font-bold leading-none text-white whitespace-nowrap" style={{ background: 'linear-gradient(135deg, #ff006e, #ff9500)', boxShadow: '0 2px 12px rgba(255,0,110,0.5)' }}>
                {giftLabel}
              </span> : null}
            </button>
          </div>
        )}

        {mode === 'login' && (
          <div className="text-left">
            <input className={inputCls} value={account} onChange={e => setAccount(e.target.value)} onKeyDown={onEnter}
              placeholder={t('pwAccountLabel')} autoComplete="username" maxLength={255} required />
            <input className={inputCls} type="password" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={onEnter}
              placeholder={t('pwPasswordLabel')} autoComplete="current-password" maxLength={72} required />
            <div className="text-right">
              <span className="text-[11px] dark:text-gray-500 text-gray-400 hover:text-green-400 cursor-pointer" onClick={() => goMode('forgot')}>{t('pwForgot')}</span>
            </div>
          </div>
        )}

        {mode === 'register' && (
          <div className="text-left">
            <input className={inputCls} value={username} onChange={e => setUsername(e.target.value)}
              placeholder={t('pwUsernameLabel')} autoComplete="username" maxLength={32} required />
            <div className="flex gap-2">
              <input className={`${inputCls} flex-1 min-w-0`} type="email" value={email} onChange={e => setEmail(e.target.value)}
                placeholder={t('pwEmailLabel')} autoComplete="email" maxLength={255} required />
              <button type="button" onClick={sendRegCode} disabled={regCd > 0}
                className="shrink-0 mb-2 px-3 rounded-lg border border-green-500/40 text-green-400 text-xs font-semibold hover:bg-green-500/10 transition-colors disabled:opacity-50 whitespace-nowrap">
                {regCd > 0 ? `${regCd}s` : t('pwSendCode')}
              </button>
            </div>
            <p className="text-[11px] text-green-500 mb-2">{t('pwEmailBonus')}</p>
            <input className={inputCls} value={emailCode} onChange={e => setEmailCode(e.target.value)} inputMode="numeric" maxLength={6}
              placeholder={t('pwEmailCodePh')} />
            <div className="flex gap-2">
              <select className="shrink-0 mb-2 px-2 rounded-lg text-sm dark:bg-white/5 bg-gray-50 border dark:border-white/10 border-gray-200 dark:text-white text-gray-900 focus:outline-none focus:border-green-500/50"
                value={contactType} onChange={e => setContactType(e.target.value)}>
                <option value="wechat">WeChat</option>
                <option value="qq">QQ</option>
                <option value="telegram">Telegram</option>
              </select>
              <input className={`${inputCls} flex-1 min-w-0`} value={contactValue} onChange={e => setContactValue(e.target.value)}
                placeholder={t('pwContactPh')} maxLength={128} />
            </div>
            <p className="text-[11px] text-green-500 mb-2">{t('pwContactBonus')}</p>
            <input className={inputCls} type="password" value={password} onChange={e => setPassword(e.target.value)}
              placeholder={t('pwPasswordNewLabel')} autoComplete="new-password" maxLength={72} required />
            <input className={inputCls} type="password" value={confirm} onChange={e => setConfirm(e.target.value)} onKeyDown={onEnter}
              placeholder={t('pwConfirmLabel')} autoComplete="new-password" maxLength={72} required />
            <label className="flex items-start gap-2 mt-1 mb-1 text-[11px] dark:text-gray-400 text-gray-500 cursor-pointer leading-relaxed">
              <input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} className="mt-0.5 accent-green-500" />
              <span>
                {t('pwAgreePre')}
                <span className="text-green-400 hover:underline cursor-pointer" onClick={(ev) => { ev.preventDefault(); openExternal(getWebsiteUrl() + '/terms.html'); }}>{t('pwAgreeTerms')}</span>
                {t('pwAgreeAnd')}
                <span className="text-green-400 hover:underline cursor-pointer" onClick={(ev) => { ev.preventDefault(); openExternal(getWebsiteUrl() + '/disclaimer.html'); }}>{t('pwAgreeDisclaimer')}</span>
              </span>
            </label>
          </div>
        )}

        {mode === 'forgot' && (
          <div className="text-left">
            <button type="button" onClick={() => goMode('login')} className="text-xs dark:text-gray-500 text-gray-400 hover:text-green-400 mb-3">{t('pwBackLogin')}</button>
            <p className="text-sm font-semibold dark:text-white text-gray-900 mb-3">{t('pwResetTitle')}</p>
            <div className="flex gap-2">
              <input className={`${inputCls} flex-1 min-w-0`} value={fgAccount} onChange={e => setFgAccount(e.target.value)}
                placeholder={t('pwAccountLabel')} autoComplete="username" maxLength={255} />
              <button type="button" onClick={sendResetCode} disabled={fgCd > 0}
                className="shrink-0 mb-2 px-3 rounded-lg border border-green-500/40 text-green-400 text-xs font-semibold hover:bg-green-500/10 transition-colors disabled:opacity-50 whitespace-nowrap">
                {fgCd > 0 ? `${fgCd}s` : t('pwSendCode')}
              </button>
            </div>
            <p className="text-[11px] dark:text-gray-500 text-gray-400 mb-2">{t('pwResetHint')}</p>
            <input className={inputCls} value={fgCode} onChange={e => setFgCode(e.target.value)} inputMode="numeric" maxLength={6}
              placeholder={t('pwEmailCodePh').replace('（选填）', '').replace(' (optional)', '')} />
            <input className={inputCls} type="password" value={fgNew} onChange={e => setFgNew(e.target.value)}
              placeholder={t('pwPasswordNewLabel')} autoComplete="new-password" maxLength={72} />
            <input className={inputCls} type="password" value={fgConfirm} onChange={e => setFgConfirm(e.target.value)} onKeyDown={onEnter}
              placeholder={t('pwConfirmLabel')} autoComplete="new-password" maxLength={72} />
            {showContact && (
              <div className="mt-2 mb-2 p-3 rounded-lg dark:bg-white/5 bg-gray-50 border dark:border-white/10 border-gray-200 text-center">
                <p className="text-xs dark:text-gray-300 text-gray-600 mb-2">{t('pwNotVerified')}</p>
                <div className="flex justify-center gap-4">
                  {contactImgs.map((c, i) => (
                    <div key={i} className="text-center">
                      <img src={c.image} alt={c.label} style={{ width: 120, height: 120, objectFit: 'contain', borderRadius: 8, background: '#fff' }} />
                      <p className="text-[11px] dark:text-gray-400 text-gray-500 mt-1">{c.label}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {err && <p className="text-xs text-red-400 mb-2 text-left">{err}</p>}

        {mode !== 'forgot' ? (
          <button
            onClick={submit}
            disabled={busy}
            className="relative w-full py-3 rounded-xl bg-green-500 text-black font-semibold hover:bg-green-600 transition-all mb-1 disabled:opacity-60"
          >
            {busy ? '…' : (mode === 'login' ? t('pwLoginBtn') : <>🎁 {t('pwRegisterBtn')}</>)}
          </button>
        ) : (
          <button
            onClick={submitReset}
            disabled={busy}
            className="relative w-full py-3 rounded-xl bg-green-500 text-black font-semibold hover:bg-green-600 transition-all mb-1 disabled:opacity-60"
          >
            {busy ? '…' : t('pwResetBtn')}
          </button>
        )}

        {/* ── Divider + wallet/social login via website — 仅登录 tab 显示 ── */}
        {mode === 'login' && (
          <>
            <div className="flex items-center gap-3 my-3">
              <div className="flex-1 border-t dark:border-white/10 border-gray-200" />
              <span className="text-xs dark:text-gray-500 text-gray-400">{t('pwOr')}</span>
              <div className="flex-1 border-t dark:border-white/10 border-gray-200" />
            </div>

            <button
              onClick={() => noobClawAuth.openWebsiteLogin()}
              className="w-full py-3 rounded-xl bg-green-500/20 border border-green-500/40 text-green-400 font-semibold hover:bg-green-500/30 transition-all mb-3"
            >
              {i18nService.t('loginWallConnectBtn')}
            </button>

            <p className="text-xs dark:text-gray-500 text-gray-400 leading-relaxed">
              {i18nService.t('loginWallSupports')}<br />
              {i18nService.t('loginWallNoGas')}
            </p>
          </>
        )}

        {toast && (
          <div className="fixed left-1/2 bottom-10 -translate-x-1/2 z-[100] max-w-[88vw] px-4 py-3 rounded-xl bg-[#111]/95 border border-green-500/40 text-green-50 text-xs leading-relaxed shadow-2xl text-center">
            {toast}
          </div>
        )}
      </div>
    </div>
  );
};

export default LoginWall;
