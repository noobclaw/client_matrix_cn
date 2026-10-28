/**
 * 全宽顶部横条(2026-10-28)。
 *   正中间:「简洁版 | 专业版」切换(两版都有,随时切)。
 *   简洁版右侧:只有 账号名 · 剩余积分 · 指纹浏览器 · ⚙设置(收起成一个小图标)—— 其它(会员标签、买积分、订阅、签到、分享…)一律不放。
 *   专业版右侧不放东西(专业版各页面自己的页头保持原样)。
 */
import React, { useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { noobClawAuth } from '../../services/noobclawAuth';
import { openWallet } from '../../services/walletNav';
import KernelPicker from './KernelPicker';
import type { UiEdition } from '../../uiEdition';

const L = (zh: string, tw: string, en: string): string => {
  const lang = i18nService.currentLanguage;
  return lang === 'zh' ? zh : lang === 'zh-TW' ? tw : en;
};
const shortAddr = (a: string) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

const TopBar: React.FC<{ edition: UiEdition; onSwitch: (e: UiEdition) => void; onShowSettings?: () => void }> = ({ edition, onSwitch, onShowSettings }) => {
  const [auth, setAuth] = useState(noobClawAuth.getState());
  useEffect(() => noobClawAuth.subscribe(setAuth), []);
  const simple = edition === 'simple';
  const name = auth.socialProvider === 'password' && auth.socialEmail ? auth.socialEmail : shortAddr(auth.walletAddress || '');

  return (
    <div className="relative flex h-11 items-center px-4 shrink-0 border-b dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted">
      {/* 正中间:版本切换 */}
      <div className="absolute left-1/2 -translate-x-1/2 grid grid-cols-2 gap-1 p-1 rounded-xl bg-claude-surfaceHover/70 dark:bg-claude-darkSurfaceHover/70 border dark:border-claude-darkBorder border-claude-border">
        {(['simple', 'pro'] as const).map((e) => {
          const on = e === edition;
          return (
            <button key={e} type="button" aria-pressed={on} onClick={() => { if (!on) onSwitch(e); }}
              className={`px-4 py-1 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors ${on ? 'bg-claude-accent text-white shadow-sm' : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText'}`}>
              {e === 'simple' ? '🌱 ' + L('简洁版', '簡潔版', 'Simple') : '🚀 ' + L('专业版', '專業版', 'Pro')}
            </button>
          );
        })}
      </div>
      {/* 简洁版右侧:账号 · 剩余积分 · 指纹浏览器 */}
      {simple && (
        <div className="ml-auto flex items-center gap-3 min-w-0">
          {auth.isAuthenticated ? (
            <>
              <span className="text-xs font-mono dark:text-claude-darkText text-claude-text truncate max-w-[180px]" title={name}>👤 {name}</span>
              <button type="button" onClick={() => openWallet('topup')} className="text-xs whitespace-nowrap dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-accent" title={L('去充值', '去儲值', 'Top up')}>
                {L('积分', '積分', 'Credits')} <b className="dark:text-claude-darkText text-claude-text">{Number(auth.tokenBalance || 0).toLocaleString()}</b>
              </button>
            </>
          ) : (
            <button type="button" onClick={() => noobClawAuth.requireLoginUI()} className="text-xs font-semibold px-3 py-1 rounded-lg bg-claude-accent text-white">{i18nService.t('coworkConnectWallet')}</button>
          )}
          <KernelPicker />
          {onShowSettings && (
            <button type="button" onClick={onShowSettings} title={i18nService.t('settings')} aria-label={i18nService.t('settings')}
              className="h-7 w-7 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover">⚙️</button>
          )}
        </div>
      )}
    </div>
  );
};

export default TopBar;
