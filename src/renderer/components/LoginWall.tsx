import React from 'react';
import { noobClawAuth } from '../services/noobclawAuth';
import { i18nService } from '../services/i18n';

interface LoginWallProps {
  onDismiss?: () => void;
  // Kept for prop-shape compatibility with App.tsx; the "Skip login + use
  // your own API key" path was removed at user request, so this is unused.
  onSwitchToCustomApi?: () => void;
}

const inputCls =
  'w-full px-3 py-2.5 rounded-lg text-sm dark:bg-white/5 bg-gray-50 border dark:border-white/10 border-gray-200 dark:text-white text-gray-900 focus:outline-none focus:border-green-500/50 mb-2';

export const LoginWall: React.FC<LoginWallProps> = ({ onDismiss }) => {
  // Password-account form state. The form posts straight to the backend
  // (noobClawAuth.passwordAuth) — no browser hop, no Web3Auth. Wallet/social
  // login keeps going through the website like before.
  const [tab, setTab] = React.useState<'login' | 'register'>('login');
  const [account, setAccount] = React.useState('');
  const [username, setUsername] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');

  const t = (k: string) => i18nService.t(k);

  const submit = async () => {
    setErr('');
    if (tab === 'login') {
      if (!account.trim() || !password) { setErr(t('pwErrRequired')); return; }
    } else {
      if (!/^[a-z0-9_]{4,32}$/.test(username.trim().toLowerCase())) { setErr(t('pwErrUsername')); return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setErr(t('pwErrEmail')); return; }
      if (password.length < 8) { setErr(t('pwErrPassword')); return; }
      if (password !== confirm) { setErr(t('pwErrMismatch')); return; }
    }
    setBusy(true);
    try {
      const result = tab === 'login'
        ? await noobClawAuth.passwordAuth('login', { account: account.trim().toLowerCase(), password })
        : await noobClawAuth.passwordAuth('register', {
            username: username.trim().toLowerCase(),
            email: email.trim().toLowerCase(),
            password,
          });
      if (!result.ok) {
        setErr(result.message || t('pwErrGeneric'));
        return;
      }
      onDismiss?.();
    } finally {
      setBusy(false);
    }
  };

  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !busy) { e.preventDefault(); submit(); }
  };

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

        {/* ── Username / password (password accounts) ── */}
        <div className="flex gap-2 mb-3">
          <button
            onClick={() => { setTab('login'); setErr(''); }}
            className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-all ${tab === 'login' ? 'bg-green-500/20 border border-green-500/40 text-green-400' : 'border dark:border-white/10 border-gray-200 dark:text-gray-400 text-gray-500 hover:text-green-400'}`}
          >
            {t('pwLoginTab')}
          </button>
          <button
            onClick={() => { setTab('register'); setErr(''); }}
            className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-all ${tab === 'register' ? 'bg-green-500/20 border border-green-500/40 text-green-400' : 'border dark:border-white/10 border-gray-200 dark:text-gray-400 text-gray-500 hover:text-green-400'}`}
          >
            {t('pwRegisterTab')}
          </button>
        </div>

        {tab === 'login' ? (
          <div className="text-left">
            <input className={inputCls} value={account} onChange={e => setAccount(e.target.value)} onKeyDown={onEnter}
              placeholder={t('pwAccountLabel')} autoComplete="username" maxLength={255} required />
            <input className={inputCls} type="password" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={onEnter}
              placeholder={t('pwPasswordLabel')} autoComplete="current-password" maxLength={72} required />
          </div>
        ) : (
          <div className="text-left">
            <input className={inputCls} value={username} onChange={e => setUsername(e.target.value)}
              placeholder={t('pwUsernameLabel')} autoComplete="username" maxLength={32} required />
            <input className={inputCls} type="email" value={email} onChange={e => setEmail(e.target.value)}
              placeholder={t('pwEmailLabel')} autoComplete="email" maxLength={255} required />
            <input className={inputCls} type="password" value={password} onChange={e => setPassword(e.target.value)}
              placeholder={t('pwPasswordNewLabel')} autoComplete="new-password" maxLength={72} required />
            <input className={inputCls} type="password" value={confirm} onChange={e => setConfirm(e.target.value)} onKeyDown={onEnter}
              placeholder={t('pwConfirmLabel')} autoComplete="new-password" maxLength={72} required />
          </div>
        )}

        {err && <p className="text-xs text-red-400 mb-2 text-left">{err}</p>}

        <button
          onClick={submit}
          disabled={busy}
          className="w-full py-3 rounded-xl bg-green-500 text-white font-semibold hover:bg-green-600 transition-all mb-1 disabled:opacity-60"
        >
          {busy ? '…' : (tab === 'login' ? t('pwLoginBtn') : t('pwRegisterBtn'))}
        </button>
        {tab === 'register' && (
          <p className="text-[11px] dark:text-gray-500 text-gray-400 mb-1">{t('pwForgotHint')}</p>
        )}

        {/* ── Divider + wallet/social login via website (unchanged path) ── */}
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
      </div>
    </div>
  );
};

export default LoginWall;
