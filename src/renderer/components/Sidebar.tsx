import React, { useEffect, useState, useCallback } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../store';
import { coworkService } from '../services/cowork';
import { i18nService } from '../services/i18n';
import CoworkSessionList from './cowork/CoworkSessionList';
import CoworkSearchModal from './cowork/CoworkSearchModal';
import ComposeIcon from './icons/ComposeIcon';
import SidebarToggleIcon from './icons/SidebarToggleIcon';
import TrashIcon from './icons/TrashIcon';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { MATRIX_EDITION } from '../matrixEdition';
import { HIDE_WEB3 } from '../buildFlags';

interface SidebarProps {
  onShowSettings: () => void;
  onShowLogin?: () => void;
  activeView: 'home' | 'cowork' | 'coworkHistory' | 'skills' | 'scheduledTasks' | 'mcp' | 'wallet' | 'invite' | 'quickuse' | 'scenarioCreate' | 'scenarioRuns' | 'web3news' | 'hotsearch' | 'partners' | 'personality' | 'matrix' | 'matrixTaskNew' | 'matrixTasks' | 'matrixRuns';
  onShowHome: () => void;
  onShowSkills: () => void;
  onShowCowork: () => void;
  onShowCoworkHistory?: () => void;
  onShowScheduledTasks: () => void;
  onShowMcp: () => void;
  onShowWallet: () => void;
  onShowInvite: () => void;
  onShowQuickUse: () => void;
  onShowScenarioRuns: () => void;
  onShowScenarioCreate: () => void;
  onShowWeb3News: () => void;
  onShowHotSearch: () => void;
  onShowPersonality: () => void;
  onShowPartners: () => void;
  onShowMatrix: () => void;
  matrixExpiredCount?: number;
  onShowMatrixTaskNew?: () => void;
  onShowMatrixTasks?: () => void;
  onShowMatrixRuns?: () => void;
  onNewChat: () => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  updateBadge?: React.ReactNode;
}

const Sidebar: React.FC<SidebarProps> = ({
  onShowSettings,
  activeView,
  onShowHome,
  onShowSkills,
  onShowCowork,
  onShowCoworkHistory,
  onShowScheduledTasks,
  onShowMcp,
  onShowWallet,
  onShowInvite,
  onShowQuickUse,
  onShowScenarioRuns,
  onShowScenarioCreate,
  onShowWeb3News,
  onShowHotSearch,
  onShowPersonality,
  onShowPartners,
  onShowMatrix,
  matrixExpiredCount = 0,
  onShowMatrixTaskNew,
  onShowMatrixTasks,
  onShowMatrixRuns,
  onNewChat,
  isCollapsed,
  onToggleCollapse,
  updateBadge,
}) => {
  const sessions = useSelector((state: RootState) => state.cowork.sessions);
  const currentSessionId = useSelector((state: RootState) => state.cowork.currentSessionId);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  // v6.x:「AI对话」二级折叠组(新建对话 / web3连接 / 行业热点)。默认收起;
  //   当组内某子项激活时强制展开,避免高亮项被折叠藏起来。
  const [aiChatOpen, setAiChatOpen] = useState(false);
  const aiChildActive = activeView === 'cowork' || activeView === 'coworkHistory' || activeView === 'mcp' || activeView === 'web3news' || activeView === 'scheduledTasks' || activeView === 'skills';
  useEffect(() => { if (aiChildActive) setAiChatOpen(true); }, [aiChildActive]);
  const [isBatchMode, setIsBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBatchDeleteConfirm, setShowBatchDeleteConfirm] = useState(false);
  const isMac = window.electron.platform === 'darwin';

  useEffect(() => {
    const handleSearch = () => {
      onShowCowork();
      setIsSearchOpen(true);
    };
    window.addEventListener('cowork:shortcut:search', handleSearch);
    return () => {
      window.removeEventListener('cowork:shortcut:search', handleSearch);
    };
  }, [onShowCowork]);

  useEffect(() => {
    if (!isCollapsed) return;
    setIsSearchOpen(false);
    setIsBatchMode(false);
    setSelectedIds(new Set());
    setShowBatchDeleteConfirm(false);
  }, [isCollapsed]);

  const handleSelectSession = async (sessionId: string) => {
    onShowCowork();
    await coworkService.loadSession(sessionId);
  };

  const handleDeleteSession = async (sessionId: string) => {
    await coworkService.deleteSession(sessionId);
  };

  const handleTogglePin = async (sessionId: string, pinned: boolean) => {
    await coworkService.setSessionPinned(sessionId, pinned);
  };

  const handleRenameSession = async (sessionId: string, title: string) => {
    await coworkService.renameSession(sessionId, title);
  };

  const handleEnterBatchMode = useCallback((sessionId: string) => {
    setIsBatchMode(true);
    setSelectedIds(new Set([sessionId]));
  }, []);

  const handleExitBatchMode = useCallback(() => {
    setIsBatchMode(false);
    setSelectedIds(new Set());
    setShowBatchDeleteConfirm(false);
  }, []);

  const handleToggleSelection = useCallback((sessionId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelectedIds(prev => {
      if (prev.size === sessions.length) {
        return new Set();
      }
      return new Set(sessions.map(s => s.id));
    });
  }, [sessions]);

  const handleBatchDeleteClick = useCallback(() => {
    if (selectedIds.size === 0) return;
    setShowBatchDeleteConfirm(true);
  }, [selectedIds.size]);

  const handleBatchDelete = useCallback(async () => {
    if (selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    await coworkService.deleteSessions(ids);
    handleExitBatchMode();
  }, [selectedIds, handleExitBatchMode]);

  return (
    <aside
      className={`shrink-0 dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted flex flex-col sidebar-transition overflow-hidden ${
        isCollapsed ? 'w-0' : 'w-60'
      }`}
    >
      <div className="pt-3 pb-3">
        {/* Logo + App Name + Collapse Button */}
        {/* macOS:顶部留一条拖拽区给红绿灯窗控,logo 行下移 → 与下方菜单一样左对齐(不再 pl-68 居中) */}
        {isMac && <div className="draggable h-5" />}
        <div className="draggable sidebar-header-drag h-10 flex items-center justify-between px-3">
          <div className="non-draggable flex items-center gap-2">
            <img src="logo.png" alt="logo" className="w-6 h-6 rounded-lg" />
            <div className="flex flex-col justify-center leading-none gap-0.5">
              <span className="font-bold text-sm dark:text-claude-darkText text-claude-text tracking-wide whitespace-nowrap">{i18nService.t('appBrand')}</span>
              {null}
            </div>
            {updateBadge}
          </div>
          <button
            type="button"
            onClick={onToggleCollapse}
            className="non-draggable h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
            aria-label={isCollapsed ? i18nService.t('expand') : i18nService.t('collapse')}
          >
            <SidebarToggleIcon className="h-4 w-4" isCollapsed={isCollapsed} />
          </button>
        </div>
        <div className="mt-3 space-y-1 px-3">
          {/* 首页 — 置顶,默认进入。产品定位 + 三步使用流程 + 涨粉教程 + 开源提示 */}
          <button
            type="button"
            onClick={() => { setIsSearchOpen(false); onShowHome(); }}
            className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
              activeView === 'home'
                ? 'bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20'
                : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
            }`}
          >
            <span className="text-sm">{'🏠'}</span>
            {i18nService.t('home')}
          </button>

          {!MATRIX_EDITION && (<>
          {/* 1. 新建涨粉任务 — 新建页提升为一级菜单 (create 模式) */}
          <button
            type="button"
            onClick={() => { setIsSearchOpen(false); onShowScenarioCreate(); }}
            className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
              activeView === 'scenarioCreate'
                ? 'bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20'
                : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
            }`}
          >
            <span className="text-sm">{'✨'}</span>
            {i18nService.t('quickUse')}
          </button>

          {/* 2. 我的涨粉任务 — 原"一键涨粉" (manage 模式) */}
          <button
            type="button"
            onClick={() => { setIsSearchOpen(false); onShowQuickUse(); }}
            className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
              activeView === 'quickuse'
                ? 'bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20'
                : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
            }`}
          >
            <span className="text-sm">{'📋'}</span>
            {i18nService.t('myFanTasks')}
          </button>

          {/* 3. 涨粉运行记录 — 原 manage 内「运行记录」L1 段拆成独立菜单 (runs 模式) */}
          <button
            type="button"
            onClick={() => { setIsSearchOpen(false); onShowScenarioRuns(); }}
            className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
              activeView === 'scenarioRuns'
                ? 'bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20'
                : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
            }`}
          >
            <span className="text-sm">{'📊'}</span>
            {i18nService.t('fanRunHistory')}
          </button>
          </>)}

          {/* 矩阵号导航:我的矩阵号 / 新建涨粉任务 / 我的涨粉任务 / 运行记录(矩阵 edition 整个 app 就这一组,不再加组头) */}
          <div className="space-y-1">
            {([
              ['matrix', '👥 ' + i18nService.t('matrixMyAccounts'), onShowMatrix],
              ['matrixTaskNew', '✨ ' + i18nService.t('matrixNewFanTask'), onShowMatrixTaskNew],
              ['matrixTasks', '📋 ' + i18nService.t('matrixMyFanTasks'), onShowMatrixTasks],
              ['matrixRuns', '📊 ' + i18nService.t('matrixRunHistory'), onShowMatrixRuns],
            ] as const).map(([key, label, handler]) => (
              <button
                key={key}
                type="button"
                onClick={() => { setIsSearchOpen(false); (handler || onShowMatrix)(); }}
                className={`relative w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
                  activeView === key
                    ? 'bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20'
                    : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                }`}
              >
                {label}
                {/* 「我的矩阵账号」菜单:全平台登录过期账号总数红圈角标(与账号页各平台 tab 角标一致),提醒去重连 */}
                {key === 'matrix' && matrixExpiredCount > 0 && (
                  <span className="absolute top-1 right-1.5 min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold leading-none">{matrixExpiredCount}</span>
                )}
              </button>
            ))}
          </div>

          {/* 全网热搜 — 仅简体/繁体中文显示(知乎/微博/百度/雪球/抖音/B站热榜) */}
          {(i18nService.currentLanguage === 'zh' || i18nService.currentLanguage === 'zh-TW') && (
            <button
              type="button"
              onClick={() => { setIsSearchOpen(false); onShowHotSearch(); }}
              className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
                activeView === 'hotsearch'
                  ? 'bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20'
                  : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
              }`}
            >
              <span className="text-sm">{'🔥'}</span>
              {i18nService.t('globalHotSearch')}
            </button>
          )}

          {/* 4. AI对话 — 折叠二级菜单：新建对话 / web3连接 / 行业热点 */}
          <button
            type="button"
            onClick={() => setAiChatOpen(o => !o)}
            className={`w-full inline-flex items-center justify-between rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
              aiChildActive && !aiChatOpen
                ? 'bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20'
                : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
            }`}
          >
            <span className="inline-flex items-center gap-2">
              <span className="text-sm">{'💬'}</span>
              {i18nService.t('aiChat')}
            </span>
            <span className={`text-xs transition-transform ${aiChatOpen ? 'rotate-90' : ''}`}>{'▸'}</span>
          </button>

          {aiChatOpen && (
            <div className="space-y-1 pl-3">
              {/* 新建对话 */}
              <button
                type="button"
                onClick={() => { setIsSearchOpen(false); onNewChat(); }}
                className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
                  activeView === 'cowork'
                    ? 'bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20'
                    : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                }`}
              >
                <ComposeIcon className="h-4 w-4" />
                {i18nService.t('newChat')}
              </button>

              {/* 所有AI对话 — 矩阵版没有常驻对话历史列表,点开在主区域展示对话列表页(空状态/删除/点击进对话) */}
              <button
                type="button"
                onClick={() => { setIsSearchOpen(false); onShowCoworkHistory?.(); }}
                className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
                  activeView === 'coworkHistory'
                    ? 'bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20'
                    : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                }`}
              >
                <span className="text-sm">{'📚'}</span>
                {i18nService.t('coworkHistory')}
              </button>

              {/* AI定时任务 — 原顶级"自建定时任务",收进 AI对话组,排在新建对话下面 */}
              <button
                type="button"
                onClick={() => { setIsSearchOpen(false); onShowScheduledTasks(); }}
                className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
                  activeView === 'scheduledTasks'
                    ? 'bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20'
                    : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                }`}
              >
                <span className="text-sm">{'⏰'}</span>
                {i18nService.t('scheduledTasks')}
              </button>

              {/* web3连接 — 国内版隐藏(HIDE_WEB3) */}
              {!HIDE_WEB3 && (
              <button
                type="button"
                onClick={() => { setIsSearchOpen(false); onShowMcp(); }}
                className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
                  activeView === 'mcp'
                    ? 'bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20'
                    : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                }`}
              >
                <span className="text-sm">{'🌐'}</span>
                {i18nService.t('mcpServers')}
              </button>
              )}

              {/* 行业热点 — 国内版隐藏(HIDE_WEB3) */}
              {!HIDE_WEB3 && (
              <button
                type="button"
                onClick={() => { setIsSearchOpen(false); onShowWeb3News(); }}
                className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
                  activeView === 'web3news'
                    ? 'bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20'
                    : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                }`}
              >
                <span className="text-sm">{'🔥'}</span>
                {i18nService.t('hotTopics')}
              </button>
              )}

              {/* AI技能商店 — 原顶级「技能商店」收进 AI对话组并改名 */}
              <button
                type="button"
                onClick={() => { setIsSearchOpen(false); onShowSkills(); }}
                className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
                  activeView === 'skills'
                    ? 'bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20'
                    : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                }`}
              >
                <span className="text-sm">🧩</span>
                {i18nService.t('aiSkillStore')}
              </button>
            </div>
          )}

          {/* My Wallet */}
          <button
            type="button"
            onClick={() => { setIsSearchOpen(false); onShowWallet(); }}
            className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
              activeView === 'wallet'
                ? 'bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20'
                : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
            }`}
          >
            <span className="text-sm">💰</span>
            {i18nService.t('myWallet')}
          </button>

          {/* Invite Rebate (v1.x: 文案统一为"邀请返佣",跟官网 nav 对齐) */}
          <button
            type="button"
            onClick={() => { setIsSearchOpen(false); onShowInvite(); }}
            className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
              activeView === 'invite'
                ? 'bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20'
                : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
            }`}
          >
            <span className="text-sm">🎁</span>
            {i18nService.t('inviteRebateMenu')}
          </button>

          {!MATRIX_EDITION && !HIDE_WEB3 && (<>
          {/* Personality Tests — 国内版隐藏(HIDE_WEB3) */}
          <button
            type="button"
            onClick={() => { setIsSearchOpen(false); onShowPersonality(); }}
            className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
              activeView === 'personality'
                ? 'bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20'
                : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
            }`}
          >
            <span className="text-sm">🧠</span>
            {i18nService.t('personalityTests')}
          </button>
          </>)}

          {/* Events & Partners */}
          <button
            type="button"
            onClick={() => { setIsSearchOpen(false); onShowPartners(); }}
            className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
              activeView === 'partners'
                ? 'bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20'
                : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
            }`}
          >
            <span className="text-sm">🤝</span>
            {i18nService.t('eventsPartners')}
          </button>
        </div>
      </div>
      {!MATRIX_EDITION && (
      <div className="flex-1 overflow-y-auto px-2.5 pb-4">
        <div className="px-3 pb-2 text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('coworkHistory')}
        </div>
        <CoworkSessionList
          sessions={sessions}
          currentSessionId={currentSessionId}
          isBatchMode={isBatchMode}
          selectedIds={selectedIds}
          onSelectSession={handleSelectSession}
          onDeleteSession={handleDeleteSession}
          onTogglePin={handleTogglePin}
          onRenameSession={handleRenameSession}
          onToggleSelection={handleToggleSelection}
          onEnterBatchMode={handleEnterBatchMode}
        />
      </div>
      )}
      <CoworkSearchModal
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        sessions={sessions}
        currentSessionId={currentSessionId}
        onSelectSession={handleSelectSession}
        onDeleteSession={handleDeleteSession}
        onTogglePin={handleTogglePin}
        onRenameSession={handleRenameSession}
      />
      {isBatchMode ? (
        <div className="px-3 pb-3 pt-1 flex items-center justify-between">
          <label className="flex items-center gap-2 cursor-pointer text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
            <input
              type="checkbox"
              checked={selectedIds.size === sessions.length && sessions.length > 0}
              onChange={handleSelectAll}
              className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 accent-claude-accent cursor-pointer"
            />
            {i18nService.t('batchSelectAll')}
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleBatchDeleteClick}
              disabled={selectedIds.size === 0}
              className={`inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                selectedIds.size > 0
                  ? 'bg-red-500 hover:bg-red-600 text-white'
                  : 'bg-gray-200 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed'
              }`}
            >
              <TrashIcon className="h-3.5 w-3.5" />
              {selectedIds.size > 0 ? `${selectedIds.size}` : ''}
            </button>
            <button
              type="button"
              onClick={handleExitBatchMode}
              className="px-3 py-1.5 text-sm font-medium rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
            >
              {i18nService.t('batchCancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="px-3 pb-3 pt-1">
          <button
            type="button"
            onClick={() => onShowSettings()}
            className="w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
            aria-label={i18nService.t('settings')}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M14 17H5" /><path d="M19 7h-9" /><circle cx="17" cy="17" r="3" /><circle cx="7" cy="7" r="3" /></svg>
            {i18nService.t('settings')}
          </button>
        </div>
      )}
      {/* Batch Delete Confirmation Modal */}
      {showBatchDeleteConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          
        >
          <div
            className="w-full max-w-sm mx-4 dark:bg-claude-darkSurface bg-claude-surface rounded-2xl shadow-xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 px-5 py-4">
              <div className="p-2 rounded-full bg-red-100 dark:bg-red-900/30">
                <ExclamationTriangleIcon className="h-5 w-5 text-red-600 dark:text-red-500" />
              </div>
              <h2 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
                {i18nService.t('batchDeleteConfirmTitle')}
              </h2>
            </div>
            <div className="px-5 pb-4">
              <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('batchDeleteConfirmMessage').replace('{count}', String(selectedIds.size))}
              </p>
            </div>
            <div className="flex items-center justify-end gap-3 px-5 py-4 border-t dark:border-claude-darkBorder border-claude-border">
              <button
                onClick={() => setShowBatchDeleteConfirm(false)}
                className="px-4 py-2 text-sm font-medium rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                onClick={handleBatchDelete}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-red-500 hover:bg-red-600 text-white transition-colors"
              >
                {i18nService.t('batchDelete')} ({selectedIds.size})
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
};

export default Sidebar;
