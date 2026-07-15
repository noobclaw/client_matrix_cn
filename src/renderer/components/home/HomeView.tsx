import React, { useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { noobClawAuth } from '../../services/noobclawAuth';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import ComposeIcon from '../icons/ComposeIcon';
import TickerMarquee from '../cowork/TickerMarquee';
import WindowTitleBar from '../window/WindowTitleBar';
import { WalletBadge } from '../common/WalletBadge';
import { HIDE_WEB3 } from '../../buildFlags';

export interface HomeViewProps {
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
  /** 步骤①「关联矩阵账号」→ 我的矩阵账号页 */
  onShowMatrix?: () => void;
  /** 步骤②「创建矩阵任务并设为定期」→ 新建矩阵涨粉任务页 */
  onShowMatrixTaskNew?: () => void;
  /** 步骤③「查看涨粉情况」→ 我的矩阵涨粉任务页 */
  onShowMatrixTasks?: () => void;
  /** 充值入口 → 我的钱包 */
  onShowWallet?: () => void;
  /** 右上角「分享给好友」→ 邀请返佣页 */
  onShowInvite?: () => void;
  /** 登录过期账号数(喂步骤①的小角标) */
  matrixExpiredCount?: number;
}

const OFFICIAL_SITE = 'https://noobclaw.com/cn/';
// 文档首页跟界面语言走:中文→/zhong-wen-ban,其余→ /english(文档仅中英两版)。必须【调用时】求值,别冻结在加载时语言。
const tutorialHome = (): string => (i18nService.currentLanguage === 'zh' || i18nService.currentLanguage === 'zh-TW') ? 'https://docs.noobclaw.com/zhong-wen-ban' : 'https://docs.noobclaw.com/english';
const GITHUB_URL = 'https://github.com/noobclaw';

const HomeView: React.FC<HomeViewProps> = ({
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  updateBadge,
  onShowMatrix,
  onShowMatrixTaskNew,
  onShowMatrixTasks,
  matrixExpiredCount = 0,
}) => {
  const isMac = window.electron.platform === 'darwin';
  const [authState, setAuthState] = useState(noobClawAuth.getState());
  useEffect(() => noobClawAuth.subscribe(setAuthState), []);

  const openExternal = (url: string) => { try { window.electron?.shell?.openExternal?.(url); } catch { /* noop */ } };

  return (
    <div className="flex-1 flex flex-col dark:bg-claude-darkBg bg-claude-bg h-full">
      {/* ── 顶栏:与 AI对话首页同款(钱包/余额/充值/登录 + 官网/Twitter/Telegram) ── */}
      <div className="draggable flex h-12 items-center justify-between px-4 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
        <div className="non-draggable h-8 flex items-center gap-2">
          {isSidebarCollapsed && (
            <div className={`flex items-center gap-1 mr-1 ${isMac ? 'pl-[68px]' : ''}`}>
              <button
                type="button"
                onClick={onToggleSidebar}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <SidebarToggleIcon className="h-4 w-4" isCollapsed={true} />
              </button>
              <button
                type="button"
                onClick={onNewChat}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <ComposeIcon className="h-4 w-4" />
              </button>
              {updateBadge}
            </div>
          )}
          {/* BSC 钱包信息 + 订阅会员/购买积分(与矩阵头部一致) */}
          <WalletBadge />
        </div>
        <div className="non-draggable flex items-center gap-1 mr-1">
          <button
            type="button"
            onClick={() => openExternal(OFFICIAL_SITE)}
            className="h-7 px-2 inline-flex items-center gap-1 rounded-md text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
            title="Official Website"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5a17.92 17.92 0 01-8.716-2.247m0 0A9 9 0 013 12c0-1.605.42-3.113 1.157-4.418" /></svg>
            {i18nService.t('coworkWebsite')}
          </button>
          <button
            type="button"
            onClick={() => openExternal('https://x.com/noobclaw_com')}
            className="h-7 px-2 inline-flex items-center gap-1 rounded-md text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
            title="Twitter / X"
          >
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
            Twitter
          </button>
          <button
            type="button"
            onClick={() => openExternal('https://t.me/noobclaw')}
            className="h-7 px-2 inline-flex items-center gap-1 rounded-md text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
            title="Telegram"
          >
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" /></svg>
            Telegram
          </button>
        </div>
        <WindowTitleBar inline />
      </div>

      {/* 行情跑马灯 */}
      <TickerMarquee />

      {/* ── 主体 ── */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="max-w-3xl mx-auto px-5 py-8 space-y-8">

          {/* Hero / 产品定位 */}
          <div className="text-center space-y-3">
            <img src="logo.png" alt="logo" className="w-14 h-14 mx-auto rounded-2xl shadow-lg" />
            {/* 标题样式照搬官网 index.html hero:NoobClaw 绿色霓虹 + 第二行粉紫蓝渐变 */}
            <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight leading-tight">
              <span style={{ color: '#00ff88', textShadow: '0 0 20px rgba(0,255,136,0.5), 0 0 40px rgba(0,255,136,0.2)' }}>NoobClaw</span>
              <span className="dark:text-white text-gray-900"> - {i18nService.t('hvHeroTitle')}</span>
            </h1>
            <div
              className="text-2xl sm:text-3xl font-extrabold tracking-tight"
              style={{
                backgroundImage: 'linear-gradient(to right, #ff006e, #8b5cf6, #00d4ff)',
                WebkitBackgroundClip: 'text',
                backgroundClip: 'text',
                color: 'transparent',
                filter: 'drop-shadow(0 0 12px rgba(139,92,246,0.35))',
              }}
            >
              {i18nService.t('hvHeroSubtitle')}
            </div>
            <p className="text-sm leading-relaxed dark:text-claude-darkTextSecondary text-claude-textSecondary max-w-xl mx-auto">
              {i18nService.t('hvHeroDesc')}
            </p>
            {/* 平台标签 */}
            <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
              {[
                ['🐦', i18nService.t('hvPlatformX')],
                ['📕', i18nService.t('hvPlatformRed')],
                ['🎬', i18nService.t('hvPlatformDouyin')],
                ['🎦', i18nService.t('hvPlatformKuaishou')],
                ['📺', i18nService.t('hvPlatformBilibili')],
                ['📹', i18nService.t('hvPlatformChannels')],
                ['📰', i18nService.t('hvPlatformToutiao')],
                ['🎵', 'TikTok'],
                ['▶️', 'YouTube'],
                // 国内版隐藏「币安广场」平台标签(HIDE_WEB3)
                ...(HIDE_WEB3 ? [] : [['🔶', i18nService.t('hvPlatformBinance')]]),
              ].map(([icon, label]) => (
                <span
                  key={label}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border dark:border-white/10 border-gray-200/80 dark:bg-white/[0.03] bg-white dark:text-gray-200 text-gray-700"
                >
                  <span>{icon}</span>{label}
                </span>
              ))}
            </div>
          </div>

          {/* 登录引导:未登录时给一个醒目的登录按钮 */}
          {!authState.isAuthenticated && (
            <div className="rounded-2xl border dark:border-claude-accent/30 border-claude-accent/20 dark:bg-claude-accent/10 bg-claude-accent/5 px-5 py-4 flex flex-col sm:flex-row items-center justify-between gap-3">
              <div className="text-center sm:text-left">
                <div className="text-sm font-semibold dark:text-claude-darkText text-claude-text">
                  {i18nService.t('hvLoginTitle')}
                </div>
                <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-0.5">
                  {i18nService.t('hvLoginDesc')}
                </div>
              </div>
              <button
                type="button"
                onClick={() => noobClawAuth.requireLoginUI()}
                className="shrink-0 px-5 py-2.5 rounded-xl text-sm font-bold bg-claude-accent text-white hover:bg-claude-accentHover transition-colors shadow-sm"
              >
                {i18nService.t('coworkConnectWallet')}
              </button>
            </div>
          )}

          {/* 使用流程 / 涨粉教程 — 三步走 */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold dark:text-claude-darkText text-claude-text">
                📖 {i18nService.t('hvStepsTitle')}
              </h2>
              <button
                type="button"
                onClick={() => openExternal(tutorialHome())}
                className="text-xs font-medium text-claude-accent hover:underline inline-flex items-center gap-1"
              >
                {i18nService.t('hvFullTutorial')}
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <StepCard
                index={1}
                icon="👥"
                title={i18nService.t('hvStep1Title')}
                desc={i18nService.t('hvStep1Desc')}
                cta={i18nService.t('hvStep1Cta')}
                onClick={onShowMatrix}
                badge={matrixExpiredCount > 0 ? matrixExpiredCount : undefined}
              />
              <StepCard
                index={2}
                icon="✨"
                title={i18nService.t('hvStep2Title')}
                desc={i18nService.t('hvStep2Desc')}
                cta={i18nService.t('hvStep2Cta')}
                onClick={onShowMatrixTaskNew}
              />
              <StepCard
                index={3}
                icon="📈"
                title={i18nService.t('hvStep3Title')}
                desc={i18nService.t('hvStep3Desc')}
                cta={i18nService.t('hvStep3Cta')}
                onClick={onShowMatrixTasks}
              />
            </div>
          </div>

          {/* 开源安全提示 */}
          <div className="flex justify-center">
            <a
              href="#"
              onClick={(e) => { e.preventDefault(); openExternal(GITHUB_URL); }}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full dark:bg-emerald-500/10 bg-emerald-50 border dark:border-emerald-500/20 border-emerald-200 hover:opacity-80 transition-opacity cursor-pointer"
            >
              <span className="text-base">{'🛡️'}</span>
              <span className="text-xs dark:text-emerald-400 text-emerald-600 font-medium">
                {i18nService.t('coworkOpenSource')}
              </span>
              <svg className="w-3 h-3 dark:text-emerald-400 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};

// ── 单个步骤卡 ──
const StepCard: React.FC<{
  index: number;
  icon: string;
  title: string;
  desc: string;
  cta: string;
  onClick?: () => void;
  badge?: number;
}> = ({ index, icon, title, desc, cta, onClick, badge }) => (
  <div className="relative flex flex-col rounded-2xl border dark:border-white/10 border-gray-200/80 dark:bg-white/[0.03] bg-white p-4 hover:shadow-md hover:-translate-y-0.5 transition-all duration-150">
    <div className="flex items-center gap-2 mb-2">
      <span className="flex items-center justify-center w-7 h-7 rounded-full bg-claude-accent/15 text-claude-accent text-sm font-bold shrink-0">{index}</span>
      <span className="text-xl">{icon}</span>
      {badge !== undefined && (
        <span className="ml-auto min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold leading-none">{badge}</span>
      )}
    </div>
    <h3 className="text-sm font-semibold dark:text-claude-darkText text-claude-text mb-1">{title}</h3>
    <p className="text-xs leading-relaxed dark:text-claude-darkTextSecondary text-claude-textSecondary flex-1">{desc}</p>
    <button
      type="button"
      onClick={onClick}
      className="mt-3 w-full py-2 rounded-xl text-xs font-semibold bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20 transition-colors"
    >
      {cta} →
    </button>
  </div>
);

export default HomeView;
