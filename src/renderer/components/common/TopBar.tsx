/**
 * 全宽顶部横条(2026-10-28)。
 *   正中间:「简洁版 | 专业版」切换(两版都有,随时切)。简洁版左侧显示当前页面名(简洁版不显示左侧菜单)。
 *   简洁版右侧:只有 账号名 · 剩余积分 · 指纹浏览器 · ☰ 收纳菜单(原左侧菜单 + 设置)—— 其它(会员标签、买积分、订阅、签到、分享…)一律不放。
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

export interface TopBarMenuItem { key: string; icon: string; label: string; onClick: () => void; badge?: number }

const TopBar: React.FC<{ edition: UiEdition; onSwitch: (e: UiEdition) => void; onShowSettings?: () => void; menu?: TopBarMenuItem[]; activeKey?: string; updateBadge?: React.ReactNode }> = ({ edition, onSwitch, onShowSettings, menu, activeKey, updateBadge }) => {
  const [auth, setAuth] = useState(noobClawAuth.getState());
  const [menuOpen, setMenuOpen] = useState(false);
  const active = (menu || []).find((m) => m.key === activeKey);
  const badgeTotal = (menu || []).reduce((n, m) => n + (m.badge || 0), 0);
  useEffect(() => noobClawAuth.subscribe(setAuth), []);
  const simple = edition === 'simple';
  // 账号名:用户名 / 邮箱优先(密码、Google、Twitter… 登录都放在 socialEmail),没有再用钱包地址缩写
  const name = auth.socialEmail || shortAddr(auth.walletAddress || '') || '—';

  return (
    // 三栏:左 / 中 / 右,左右等宽 → 中间的切换永远居中,窗口再窄也不会被右侧盖住(右侧自己截断)
    <div className="grid grid-cols-[1fr_auto_1fr] h-11 items-center gap-3 px-4 shrink-0 border-b dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted">
      {/* 简洁版左侧:当前在哪一页(左侧菜单已收进右上角 ☰)+ 有新版本时的更新提示 */}
      <div className="min-w-0 flex items-center gap-2">
        {simple && active && <span className="text-sm font-semibold dark:text-claude-darkText text-claude-text truncate">{active.icon} {active.label}</span>}
        {simple && updateBadge}
      </div>
      {/* 正中间:版本切换 */}
      <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-claude-surfaceHover/70 dark:bg-claude-darkSurfaceHover/70 border dark:border-claude-darkBorder border-claude-border">
        {(['simple', 'pro'] as const).map((e) => {
          const on = e === edition;
          return (
            <button key={e} type="button" aria-pressed={on} onClick={() => { if (!on) onSwitch(e); }}
              className={`px-4 py-1 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors ${on ? 'bg-claude-accent text-[#04130B] shadow-sm' : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText'}`}>
              {e === 'simple' ? '🌱 ' + L('简洁版', '簡潔版', 'Simple') : '🚀 ' + L('专业版', '專業版', 'Pro')}
            </button>
          );
        })}
      </div>
      {/* 简洁版右侧:账号 · 剩余积分 · 指纹浏览器 */}
      <div className="min-w-0 flex items-center justify-end gap-3 overflow-hidden">
      {simple && (
        <>
          {auth.isAuthenticated ? (
            <>
              <span className="hidden lg:inline-block min-w-0 text-xs font-mono dark:text-claude-darkText text-claude-text truncate max-w-[180px]" title={name}>👤 {name}</span>
              <button type="button" onClick={() => openWallet('topup')} className="shrink-0 text-xs whitespace-nowrap dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-accent" title={L('去充值', '去儲值', 'Top up')}>
                {L('积分', '積分', 'Credits')} <b className="dark:text-claude-darkText text-claude-text">{Number(auth.tokenBalance || 0).toLocaleString()}</b>
              </button>
            </>
          ) : (
            <button type="button" onClick={() => noobClawAuth.requireLoginUI()} className="text-xs font-semibold px-3 py-1 rounded-lg bg-claude-accent text-[#04130B]">{i18nService.t('coworkConnectWallet')}</button>
          )}
          <KernelPicker />
          {/* 收纳菜单:原左侧菜单 + 设置 */}
          {menu && menu.length > 0 && (
            <div className="relative shrink-0">
              <button type="button" onClick={() => setMenuOpen((o) => !o)} aria-label={L('菜单', '選單', 'Menu')} aria-expanded={menuOpen}
                className="relative h-8 w-8 inline-flex items-center justify-center rounded-lg text-lg dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover">
                ☰
                {badgeTotal > 0 && <span className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-red-500" />}
              </button>
              {menuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                  <div className="absolute right-0 mt-1.5 z-50 w-52 rounded-xl py-1.5 shadow-xl dark:bg-claude-darkSurface bg-white border dark:border-white/10 border-black/10">
                    {menu.map((m) => (
                      <button key={m.key} type="button" onClick={() => { setMenuOpen(false); m.onClick(); }}
                        className={`w-full flex items-center gap-2.5 px-3.5 py-2 text-sm text-left ${m.key === activeKey ? 'text-claude-accent font-semibold bg-claude-accent/10' : 'dark:text-claude-darkText text-claude-text hover:bg-black/5 dark:hover:bg-white/5'}`}>
                        <span className="w-5 text-center">{m.icon}</span>
                        <span className="flex-1 truncate">{m.label}</span>
                        {!!m.badge && <span className="min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold">{m.badge}</span>}
                      </button>
                    ))}
                    {onShowSettings && (
                      <>
                        <div className="my-1 border-t dark:border-white/10 border-black/10" />
                        <button type="button" onClick={() => { setMenuOpen(false); onShowSettings(); }}
                          className="w-full flex items-center gap-2.5 px-3.5 py-2 text-sm text-left dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-black/5 dark:hover:bg-white/5">
                          <span className="w-5 text-center">⚙️</span><span className="flex-1">{i18nService.t('settings')}</span>
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
      </div>
    </div>
  );
};

export default TopBar;
