/**
 * Reusable wallet info chip — BSC icon + truncated address + token balance +
 * always-visible top-up button. Used in:
 *   - CoworkView toolbar
 *   - CoworkSessionDetail toolbar
 *   - ScenarioView toolbar
 *
 * Click on top-up dispatches the global 'noobclaw:show-wallet' event which
 * the App-level listener wires to switching to the My Wallet page.
 *
 * If user is not authenticated, renders a single "connect wallet" button.
 */

import React from 'react';
import { i18nService } from '../../services/i18n';
import { noobClawAuth } from '../../services/noobclawAuth';
import { openWallet } from '../../services/walletNav';

function formatAddr(addr: string) {
  if (!addr || addr.length <= 10) return addr || '';
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

interface Props {
  /** 'normal' (default, used in main toolbars) | 'compact' (smaller for tighter bars) */
  size?: 'normal' | 'compact';
}

export const WalletBadge: React.FC<Props> = ({ size = 'normal' }) => {
  const [authState, setAuthState] = React.useState(noobClawAuth.getState());
  React.useEffect(() => {
    const unsubscribe = noobClawAuth.subscribe(s => setAuthState(s));
    return unsubscribe;
  }, []);

  const isZh = i18nService.currentLanguage === 'zh';
  const compact = size === 'compact';
  const txt = compact ? 'text-[10px]' : 'text-xs';

  if (!authState.isAuthenticated || !authState.walletAddress) {
    return (
      <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg dark:bg-claude-darkSurface bg-claude-surface`}>
        <img src="bsc.svg" alt="BSC" className={compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} />
        <span className={`${txt} font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary`}>BSC</span>
        <button
          type="button"
          onClick={() => noobClawAuth.requireLoginUI()}
          className={`non-draggable px-2 py-0.5 rounded ${txt} font-semibold bg-claude-accent text-white hover:bg-claude-accentHover transition-colors`}
        >
          {i18nService.t('coworkConnectWallet')}
        </button>
      </div>
    );
  }

  const low = authState.tokenBalance < 1000;
  const isPaid = !!authState.subActive;
  const planName = authState.planName || (isZh ? '免费版' : 'Free');
  // 免费→「订阅会员」、付费未满级→「升级会员」、最高档(max)→灰色禁用。
  const isMaxTier = isPaid && authState.planCode === 'max';
  const subLabel = (!isPaid || authState.planCode === 'free') ? (isZh ? '订阅会员' : 'Subscribe') : (isZh ? '升级会员' : 'Upgrade');
  // 到期前 3 天:pill 上挂红点 + 「N天后到期」轻提醒(强提醒走到期弹窗)。
  const expMs = authState.subExpireAt ? new Date(authState.subExpireAt).getTime() : 0;
  const daysLeft = isPaid && expMs ? Math.ceil((expMs - Date.now()) / 86_400_000) : null;
  const expiringSoon = daysLeft != null && daysLeft >= 0 && daysLeft <= 3;
  const pillStyle: React.CSSProperties = isPaid
    ? { padding: compact ? '2px 8px' : '3px 10px', fontSize: compact ? 10 : 11, background: 'linear-gradient(135deg,#fde68a,#f59e0b)', color: '#3a2400', boxShadow: '0 0 10px rgba(245,158,11,0.45)' }
    : { padding: compact ? '2px 8px' : '3px 10px', fontSize: compact ? 10 : 11, background: 'rgba(255,255,255,0.06)', color: '#9aa0aa', border: '1px solid rgba(255,255,255,0.12)' };
  const btnPad = compact ? '3px 9px' : '4px 12px';
  const btnFs = compact ? 11 : 13;
  return (
    <div className="flex items-center gap-2 px-2.5 py-1 rounded-lg dark:bg-claude-darkSurface bg-claude-surface">
      <img src="bsc.svg" alt="BSC" className={compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} />
      {!compact && (
        <span className={`${txt} font-mono dark:text-claude-darkText text-claude-text`}>
          {formatAddr(authState.walletAddress)}
        </span>
      )}

      {/* 会员等级 — 醒目(付费档金色渐变+光晕,免费档低调) */}
      <button
        type="button"
        onClick={() => openWallet('subscription')}
        className="non-draggable relative inline-flex items-center gap-1 rounded-full font-bold leading-none whitespace-nowrap"
        style={pillStyle}
        title={expiringSoon ? (isZh ? `会员将于 ${daysLeft} 天后到期,点此续费` : `Expires in ${daysLeft}d — renew`) : (isZh ? '我的会员' : 'Membership')}
      >
        {expiringSoon && <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500 ring-1 ring-white" />}
        {isPaid ? '👑' : '🪙'} {planName}{expiringSoon ? (isZh ? ` · ${daysLeft}天后到期` : ` · ${daysLeft}d left`) : ''}
      </button>

      {/* 积分余额(可消费总额) */}
      <span className={`${txt} dark:text-claude-darkTextSecondary text-claude-textSecondary whitespace-nowrap`}>
        {isZh ? '积分余额' : 'Credits'}{' '}
        <span className={`font-semibold ${low ? 'text-red-500' : 'dark:text-claude-darkText text-claude-text'}`}>
          {authState.tokenBalance.toLocaleString()}
        </span>
      </span>

      {/* 订阅/升级会员(金色,主 CTA;最高档灰色禁用) */}
      <button
        type="button"
        disabled={isMaxTier}
        onClick={isMaxTier ? undefined : () => openWallet('subscription')}
        className={`non-draggable rounded font-bold whitespace-nowrap ${isMaxTier ? 'cursor-not-allowed' : 'transition-transform hover:scale-[1.03]'}`}
        style={isMaxTier
          ? { padding: btnPad, fontSize: btnFs, background: 'rgba(255,255,255,0.08)', color: '#777' }
          : { padding: btnPad, fontSize: btnFs, background: 'linear-gradient(135deg,#fbbf24,#f59e0b)', color: '#3a2400', boxShadow: '0 2px 8px rgba(245,158,11,0.35)' }}
        title={isMaxTier ? (isZh ? '已是最高等级' : 'Top tier') : ''}
      >
        {subLabel}
      </button>
      {/* 购买积分 */}
      <button
        type="button"
        onClick={() => openWallet('topup')}
        className={`non-draggable rounded font-bold whitespace-nowrap text-white transition-colors ${low ? 'bg-yellow-500 hover:bg-yellow-600' : 'bg-green-500 hover:bg-green-600'}`}
        style={{ padding: btnPad, fontSize: btnFs }}
      >
        {isZh ? '购买积分' : 'Buy Credits'}
      </button>
    </div>
  );
};
