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
import { HIDE_WEB3 } from '../../buildFlags';

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

  const compact = size === 'compact';
  const txt = compact ? 'text-[10px]' : 'text-xs';

  if (!authState.isAuthenticated || !authState.walletAddress) {
    return (
      <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg dark:bg-claude-darkSurface bg-claude-surface`}>
        {/* BSC 链标识 — 国内版隐藏(HIDE_WEB3) */}
        {!HIDE_WEB3 && <img src="bsc.svg" alt="BSC" className={compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} />}
        {!HIDE_WEB3 && <span className={`${txt} font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary`}>BSC</span>}
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
  // 会员状态以【整周期到期日 subPeriodEnd】为准(用户认知的会员到期),不是每月桶 subExpireAt。
  const periodEndMs = authState.subPeriodEnd ? new Date(authState.subPeriodEnd).getTime() : 0;
  const memberActive = periodEndMs > Date.now();           // 会员有效中
  const hadSub = !!authState.subStatus;                    // 买过会员(active/expired 都算)
  const expired = hadSub && !memberActive;                 // 买过但已过期
  const isPaid = memberActive;                             // 金色 pill / 升级按钮判定
  // 展示档名:有订阅记录 → 用订阅档名(到期后仍显示原档「进阶版」);否则免费版。
  const planName = (() => { const K: Record<string,string> = { free:'planTierFree', basic:'planTierBasic', pro:'planTierPro', max:'planTierMax', '免费版':'planTierFree', '基础版':'planTierBasic', '进阶版':'planTierPro', '旗舰版':'planTierMax' }; const raw = authState.subPlanName || authState.planName || ''; return K[raw] ? i18nService.t(K[raw]) : (raw || i18nService.t('wbPlanFree')); })();
  // 免费→「订阅会员」、付费未满级→「升级会员」、最高档(max)→灰色禁用。
  const isMaxTier = memberActive && authState.planCode === 'max';
  const subLabel = !memberActive ? i18nService.t('wbSubscribe') : i18nService.t('wbUpgrade');
  // 到期日文案:有效中显示「M/D 到期」(≤3 天红字+红点);已过期显示「已过期」(红)。
  const daysLeft = memberActive ? Math.ceil((periodEndMs - Date.now()) / 86_400_000) : null;
  const expiringSoon = daysLeft != null && daysLeft >= 0 && daysLeft <= 3;
  const endD = periodEndMs ? new Date(periodEndMs) : null;
  const endLabel = endD ? `${endD.getMonth() + 1}/${endD.getDate()}` : '';
  const pillStyle: React.CSSProperties = isPaid
    ? { padding: compact ? '2px 8px' : '3px 10px', fontSize: compact ? 10 : 11, background: 'linear-gradient(135deg,#fde68a,#f59e0b)', color: '#3a2400', boxShadow: '0 0 10px rgba(245,158,11,0.45)' }
    : { padding: compact ? '2px 8px' : '3px 10px', fontSize: compact ? 10 : 11, background: 'rgba(255,255,255,0.06)', color: '#9aa0aa', border: '1px solid rgba(255,255,255,0.12)' };
  const btnPad = compact ? '3px 9px' : '4px 12px';
  const btnFs = compact ? 11 : 13;
  return (
    <div className="flex items-center gap-2 px-2.5 py-1 rounded-lg dark:bg-claude-darkSurface bg-claude-surface">
      {/* BSC 链图标 — 国内版隐藏(HIDE_WEB3),地址作为 UID 保留显示 */}
      {!HIDE_WEB3 && <img src="bsc.svg" alt="BSC" className={compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} />}
      {!compact && (
        <span className={`${txt} font-mono dark:text-claude-darkText text-claude-text`}>
          {formatAddr(authState.walletAddress)}
        </span>
      )}

      {/* 会员等级 — 醒目(有效档金色渐变+光晕,过期/免费低调);右侧跟「到期日 / 已过期」状态 */}
      <button
        type="button"
        onClick={() => openWallet('subscription')}
        className="non-draggable relative inline-flex items-center gap-1 rounded-full font-bold leading-none whitespace-nowrap"
        style={pillStyle}
        title={expired ? i18nService.t('wbExpiredTitle') : memberActive ? i18nService.t('wbActiveTitle').replace('{end}', endLabel).replace('{soon}', expiringSoon ? i18nService.t('wbActiveTitleSoon').replace('{n}', String(daysLeft)) : '') : i18nService.t('wbMembership')}
      >
        {(expiringSoon || expired) && <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500 ring-1 ring-white" />}
        {(memberActive || expired) ? '👑' : '🪙'} {planName}
      </button>
      {/* 到期状态:有效→「M/D到期」(≤3天红);已过期→「已过期」红;从没买过→不显示 */}
      {(memberActive || expired) && (
        <button
          type="button"
          onClick={() => openWallet('subscription')}
          className={`non-draggable ${txt} whitespace-nowrap font-medium ${expired || expiringSoon ? 'text-red-500' : 'dark:text-claude-darkTextSecondary text-claude-textSecondary'}`}
          title={i18nService.t('wbRenew')}
        >
          {expired ? i18nService.t('wbExpired') : expiringSoon ? i18nService.t('wbSoon').replace('{n}', String(daysLeft)) : i18nService.t('wbUntil').replace('{end}', endLabel)}
        </button>
      )}

      {/* 积分余额(可消费总额) */}
      <span className={`${txt} dark:text-claude-darkTextSecondary text-claude-textSecondary whitespace-nowrap`}>
        {i18nService.t('wbCredits')}{' '}
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
        title={isMaxTier ? i18nService.t('wbTopTier') : ''}
      >
        {subLabel}
      </button>
      {/* 购买积分 —— 恒为绿色(订阅会员金 + 购买积分绿,始终一金一绿;
          不再因低余额/未拉到余额时染黄,避免与金色「订阅会员」撞成两个黄按钮闪变)。
          低余额提醒改由上面「积分余额」数字标红承担,不动按钮配色。 */}
      <button
        type="button"
        onClick={() => openWallet('topup')}
        className="non-draggable rounded font-bold whitespace-nowrap text-white transition-colors bg-green-500 hover:bg-green-600"
        style={{ padding: btnPad, fontSize: btnFs }}
      >
        {i18nService.t('wbBuyCredits')}
      </button>
    </div>
  );
};
