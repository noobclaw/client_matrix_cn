import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { noobClawAuth } from '../services/noobclawAuth';
import { noobClawApi } from '../services/noobclawApi';
import { i18nService } from '../services/i18n';
import { readCachedProfile, writeCachedProfile } from '../services/profileCache';
import { EmailVerifyRow } from './wallet/EmailVerifyRow';
import { PayoutWalletRow } from './wallet/WalletView';
import { HIDE_WEB3 } from '../buildFlags';

// 设置弹窗「个人信息」tab(仅登录后显示)。行式排版跟「通用」tab 一样:左 = 名称,右 = 值 / 操作。
// 头像上传、邮箱、收款钱包都复用钱包页 / 邀请页的现成逻辑和组件,显示条件也跟那两页一致。
// ⚠️ 本面板渲染在 Settings 的 <form> 里:复用组件里没写 type 的按钮、输入框里按回车,都会触发
//    表单提交(=「保存」并关掉设置)。根节点上的 guard 把这两种默认行为拦掉,复用组件本身不用改。

const btnCls = 'px-2.5 py-1.5 text-xs rounded-lg dark:bg-gray-700 bg-gray-200 dark:text-gray-300 text-gray-600 hover:opacity-80 transition-opacity whitespace-nowrap disabled:opacity-50';
const labelCls = 'text-sm font-medium dark:text-claude-darkText text-claude-text shrink-0';
const valueCls = 'text-sm dark:text-claude-darkText text-claude-text';
const inputCls = 'w-full px-2.5 py-2 rounded-md text-xs dark:bg-white/5 bg-gray-50 border dark:border-white/10 border-gray-200 dark:text-white text-gray-900 focus:outline-none focus:border-green-500/50';

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-center justify-between gap-4 py-4">
    <h4 className={labelCls}>{label}</h4>
    <div className="flex items-center justify-end gap-2 min-w-0">{children}</div>
  </div>
);

const ChangePasswordModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const t = (k: string) => i18nService.t(k);
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async () => {
    if (saving) return;
    if (!oldPw) { setMsg({ ok: false, text: t('pfPwOldRequired') }); return; }
    if (newPw.length < 8 || newPw.length > 72) { setMsg({ ok: false, text: t('pfPwLength') }); return; }
    if (newPw !== confirmPw) { setMsg({ ok: false, text: t('pfPwMismatch') }); return; }
    if (newPw === oldPw) { setMsg({ ok: false, text: t('pfPwErrSame') }); return; }
    setSaving(true); setMsg(null);
    const res = await noobClawApi.changePassword(oldPw, newPw);
    if (res.success) {
      setMsg({ ok: true, text: t('pfPwChanged') });
      // 跟收款钱包弹窗一样:成功提示停一下再关,期间保持 saving 防重复提交
      setTimeout(() => { setSaving(false); onClose(); }, 900);
    } else {
      setSaving(false);
      // 后端错误码 → 本地化文案(后端 message 只有中文);认不出的码才用后端原文。
      const codeMap: Record<string, string> = { INVALID_OLD_PASSWORD: 'pfPwErrOld', SAME_PASSWORD: 'pfPwErrSame', NO_PASSWORD: 'pfPwErrNoPw', INVALID_PASSWORD: 'pfPwLength' };
      const k = res.code && codeMap[res.code];
      setMsg({ ok: false, text: k ? t(k) : (res.message || t('pwErrGeneric')) });
    }
  };
  const onEnter = (e: React.KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } };

  return createPortal(
    <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/50 p-4" onClick={() => !saving && onClose()}>
      <div className="w-full max-w-md rounded-2xl p-5 dark:bg-claude-darkSurface bg-white border dark:border-claude-darkBorder border-claude-border shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="text-sm font-semibold dark:text-claude-darkText text-claude-text mb-3">{t('pfChangePassword')}</div>
        <div className="space-y-2.5">
          <div>
            <div className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">{t('pfOldPassword')}</div>
            <input type="password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} onKeyDown={onEnter} autoFocus autoComplete="current-password" maxLength={72} className={inputCls} />
          </div>
          <div>
            <div className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">{t('pfNewPassword')}</div>
            <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} onKeyDown={onEnter} autoComplete="new-password" maxLength={72} placeholder={t('pfPwLength')} className={inputCls} />
          </div>
          <div>
            <div className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">{t('pfConfirmPassword')}</div>
            <input type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} onKeyDown={onEnter} autoComplete="new-password" maxLength={72} className={inputCls} />
          </div>
        </div>
        {msg && <p className={`text-[11px] mt-2 ${msg.ok ? 'text-green-400' : 'text-red-400'}`}>{msg.text}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={saving} className="px-3 py-1.5 rounded-md text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-60">{t('pfCancel')}</button>
          <button type="button" onClick={submit} disabled={saving} className="px-4 py-1.5 rounded-md text-xs font-semibold bg-green-500 text-black hover:bg-green-600 disabled:opacity-60">{t('pfPwSubmit')}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

interface Props {
  /** 退出登录后关掉设置弹窗 */
  onLoggedOut: () => void;
}

const ProfileSettingsPanel: React.FC<Props> = ({ onLoggedOut }) => {
  const t = (k: string) => i18nService.t(k);
  const [authState, setAuthState] = useState(noobClawAuth.getState());
  const [profile, setProfile] = useState<any>(() => readCachedProfile(noobClawAuth.getState().walletAddress));
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarError, setAvatarError] = useState('');
  const [copied, setCopied] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);

  // 跟钱包页 / 邀请页一样订阅登录态:上传头像后 setAvatarUrl → notify → 这里刷新
  useEffect(() => {
    const unsub = noobClawAuth.subscribe(setAuthState);
    return unsub;
  }, []);

  // 先用缓存秒开,后台拉最新 profile 覆盖(同 InviteView)
  useEffect(() => {
    if (!authState.isAuthenticated) return;
    let alive = true;
    noobClawApi.getUserProfile().then((fresh) => {
      if (alive && fresh) {
        setProfile(fresh);
        writeCachedProfile(authState.walletAddress, fresh);
      }
    }).catch(() => { /* 保留缓存 */ });
    return () => { alive = false; };
  }, [authState.isAuthenticated, authState.walletAddress]);

  // 同 WalletView.handleAvatarUpload
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

  const uid = authState.walletAddress || '';
  const initials = ((authState.socialProvider === 'password' && authState.socialEmail) ? authState.socialEmail : uid.replace(/^0x/, '')).slice(0, 2).toUpperCase();
  const nickname = (profile?.username as string) || authState.socialEmail || (uid ? `${uid.slice(0, 6)}…${uid.slice(-4)}` : '—');
  const uidLabel = /^0x/i.test(uid) ? t('walletMyWalletBsc') : t('pfUid');
  const isPassword = profile?.account_type === 'password';
  // 社交号自带邮箱时 EmailVerifyRow 不渲染(交给第三方),这里直接显示那个邮箱
  const socialEmailOnly = !isPassword && !!profile?.social_email;
  // has_password 是后端「有没有密码」的口径(钱包 / 社交号也能补设密码);老后端没这字段时退回 account_type
  const hasPassword = typeof profile?.has_password === 'boolean' ? profile.has_password : isPassword;

  const refreshProfile = async () => {
    const fresh = await noobClawApi.getUserProfile();
    if (fresh) { setProfile(fresh); writeCachedProfile(authState.walletAddress, fresh); }
  };

  const copyUid = () => {
    try {
      navigator.clipboard.writeText(uid).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => { /* 复制失败就不显示「已复制」 */ });
    } catch { /* ignore */ }
  };

  const doLogout = () => {
    noobClawApi.serverLogout();   // 先用旧 token 让服务端作废会话,再清本地
    noobClawAuth.logout();
    onLoggedOut();
  };

  // 拦住 Settings <form> 的提交:复用组件里没写 type 的按钮(默认 submit)和输入框回车。
  // 用捕获阶段:EmailVerifyRow 弹窗卡片 onClick 里 stopPropagation,冒泡阶段收不到。
  const guardClick = (e: React.MouseEvent) => {
    const b = (e.target as HTMLElement).closest?.('button');
    if (b && b.type === 'submit' && b.form) e.preventDefault();
  };
  const guardKeyDown = (e: React.KeyboardEvent) => {
    const el = e.target as HTMLInputElement;
    if (e.key === 'Enter' && el.tagName === 'INPUT' && el.form) e.preventDefault();
  };

  return (
    <div onClickCapture={guardClick} onKeyDownCapture={guardKeyDown}>
      <div className="divide-y dark:divide-claude-darkBorder divide-claude-border">
        {/* 1. 头像 */}
        <Row label={t('pfAvatar')}>
          {avatarError && <span className="text-xs text-red-400 truncate">{avatarError}</span>}
          <div className="shrink-0 w-12 h-12 rounded-full overflow-hidden bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center">
            {authState.avatarUrl
              ? <img src={authState.avatarUrl} alt="" className="w-full h-full object-cover" />
              : <span className="text-white text-base font-bold">{initials}</span>}
          </div>
          <button type="button" onClick={handleAvatarUpload} disabled={avatarUploading} className={btnCls}>
            {avatarUploading ? t('pfUploading') : t('pfUploadAvatar')}
          </button>
        </Row>

        {/* 2. 昵称 */}
        <Row label={t('pfNickname')}>
          <span className={`${valueCls} truncate`}>{nickname}</span>
        </Row>

        {/* 3. UID(0x 地址时沿用钱包页的「我的钱包」叫法) */}
        <Row label={uidLabel}>
          <span className={`${valueCls} font-mono truncate`} title={uid}>{uid || '—'}</span>
          {uid && (
            <button type="button" onClick={copyUid} className={btnCls}>
              {copied ? t('pfCopied') : t('pfCopy')}
            </button>
          )}
        </Row>

        {/* 4. 邮箱 */}
        <Row label={t('pfEmail')}>
          {!profile ? (
            <span className={valueCls}>—</span>
          ) : socialEmailOnly ? (
            <span className={`${valueCls} truncate`}>{profile.social_email}</span>
          ) : (
            <div className="min-w-0 [&>div]:!mt-0 [&>div]:!text-sm [&>div>svg]:hidden">
              <EmailVerifyRow profile={profile} onVerified={refreshProfile} />
            </div>
          )}
        </Row>

        {/* 5. 收款钱包地址(同邀请页 / 钱包页:仅国际版、账密账号) */}
        {!HIDE_WEB3 && profile?.account_type === 'password' && (
          <Row label={t('pfPayoutWallet')}>
            <div className="min-w-0 [&>div]:!mt-0 [&>div]:!text-sm [&>div>span:first-child]:hidden [&_code]:!text-inherit">
              <PayoutWalletRow
                current={(profile?.payout_wallet as string) || null}
                onSaved={(w) => { const next = { ...profile, payout_wallet: w }; setProfile(next); writeCachedProfile(authState.walletAddress, next); }}
              />
            </div>
          </Row>
        )}

        {/* 6. 密码(只有设过密码的账号才显示) */}
        {hasPassword && (
          <Row label={t('pfPassword')}>
            <span className={`${valueCls} tracking-widest`}>●●●●●●●●</span>
            <button type="button" onClick={() => setPwOpen(true)} className={btnCls}>{t('pfChangePassword')}</button>
          </Row>
        )}
      </div>

      {/* 7. 退出登录 */}
      <div className="pt-6 mt-2 border-t dark:border-claude-darkBorder border-claude-border flex items-center justify-end gap-3">
        {confirmLogout ? (
          <>
            <span className="text-sm dark:text-claude-darkText text-claude-text">{t('pfLogoutConfirm')}</span>
            <button type="button" onClick={() => setConfirmLogout(false)} className={btnCls}>{t('pfCancel')}</button>
            <button type="button" onClick={doLogout} className="px-3 py-1.5 text-xs font-semibold rounded-lg !bg-red-500 hover:!bg-red-600 !text-white transition-colors whitespace-nowrap">
              {t('pfLogout')}
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setConfirmLogout(true)} className="px-4 py-1.5 text-sm rounded-lg border !border-red-500/60 !text-red-500 hover:!bg-red-500/10 transition-colors whitespace-nowrap">
            {t('pfLogout')}
          </button>
        )}
      </div>

      {pwOpen && <ChangePasswordModal onClose={() => setPwOpen(false)} />}
    </div>
  );
};

export default ProfileSettingsPanel;
