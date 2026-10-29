import React, { useState, useEffect, useCallback } from 'react';
import { i18nService } from '../../services/i18n';
import { getBackendApiUrl } from '../../services/endpoints';
import WindowTitleBar from '../window/WindowTitleBar';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import ComposeIcon from '../icons/ComposeIcon';

interface GlobalHotSearchPageProps {
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
}

interface HotItem {
  id: string;
  title: string;
  summary?: string;
  url: string;
  rank?: number;
  source: string;
  publishedAt?: string;
}
interface HotSource { source: string; items: HotItem[]; }

// 榜单分成切换组,每组一行展示。第 1 组(默认)= 抖音 / B站 / 微博。
// 组内顺序 = 展示顺序;sources 里的名字必须跟后端 HOT_SOURCE_ORDER 精确一致(锚定 + 懒加载查询都靠它)。
// ⚠️ 懒加载:首屏只拉第 1 组,切到别的组才按 ?sources= 拉那组(见 loadTab)。
const TAB_GROUPS: { key: string; label: string; sources: string[] }[] = [
  { key: 'a', label: '🎵 抖音 · 📺 B站 · 🔥 微博', sources: ['抖音热搜', 'B站热搜', '微博热搜'] },
  { key: 'b', label: '💭 知乎 · 🔍 百度 · 📈 雪球', sources: ['知乎热榜', '百度热搜', '雪球热门股'] },
  { key: 'c', label: '🌍 HN · Reddit · Google · YouTube', sources: ['Hacker News', 'Reddit', 'Google Trends', 'YouTube Trending'] },
];

// 一组里最新的 publishedAt = 该榜「更新时间」。返回 "HH:MM" 短串(取不到返回 '')。
const latestUpdated = (items: HotItem[]): string => {
  let max = 0;
  for (const it of items) {
    const t = it.publishedAt ? Date.parse(it.publishedAt) : 0;
    if (Number.isFinite(t) && t > max) max = t;
  }
  if (!max) return '';
  const d = new Date(max);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
};

// 每个榜单的视觉标识(emoji + 主题渐变色)。没列到的源走默认。
const SOURCE_STYLE: Record<string, { emoji: string; from: string; to: string; ring: string }> = {
  '微博热搜':   { emoji: '🔥', from: 'from-red-500/20',    to: 'to-orange-500/5',  ring: 'group-hover:border-red-500/50' },
  '知乎热榜':   { emoji: '💭', from: 'from-blue-500/20',   to: 'to-sky-500/5',     ring: 'group-hover:border-blue-500/50' },
  '百度热搜':   { emoji: '🔍', from: 'from-blue-600/20',   to: 'to-indigo-500/5',  ring: 'group-hover:border-indigo-500/50' },
  '抖音热搜':   { emoji: '🎵', from: 'from-fuchsia-500/20', to: 'to-pink-500/5',   ring: 'group-hover:border-fuchsia-500/50' },
  'B站热搜':    { emoji: '📺', from: 'from-pink-400/20',   to: 'to-cyan-400/5',    ring: 'group-hover:border-pink-400/50' },
  '雪球热门股': { emoji: '📈', from: 'from-emerald-500/20', to: 'to-teal-500/5',   ring: 'group-hover:border-emerald-500/50' },
  // 国外热榜(英文标题,后端 lang=en)
  'Hacker News':      { emoji: '🟠', from: 'from-orange-500/20', to: 'to-amber-500/5', ring: 'group-hover:border-orange-500/50' },
  'Reddit':           { emoji: '👽', from: 'from-orange-600/20', to: 'to-red-500/5',   ring: 'group-hover:border-orange-600/50' },
  'Google Trends':    { emoji: '📊', from: 'from-blue-500/20',   to: 'to-green-500/5', ring: 'group-hover:border-blue-500/50' },
  'YouTube Trending': { emoji: '▶️', from: 'from-red-500/20',    to: 'to-rose-500/5',  ring: 'group-hover:border-red-500/50' },
};
const styleOf = (s: string) => SOURCE_STYLE[s] || { emoji: '🌐', from: 'from-gray-500/20', to: 'to-gray-500/5', ring: 'group-hover:border-claude-accent/50' };

// 前三名奖牌色,其余暗灰。
const rankBadge = (rank: number): string => {
  if (rank === 1) return 'bg-gradient-to-br from-yellow-400 to-amber-600 text-white shadow-lg shadow-amber-500/30';
  if (rank === 2) return 'bg-gradient-to-br from-gray-300 to-gray-500 text-white shadow';
  if (rank === 3) return 'bg-gradient-to-br from-amber-600 to-orange-800 text-white shadow';
  return 'dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkTextSecondary text-claude-textSecondary';
};

const GlobalHotSearchPage: React.FC<GlobalHotSearchPageProps> = ({
  isSidebarCollapsed, onToggleSidebar, onNewChat, updateBadge,
}) => {
  const isMac = window.electron.platform === 'darwin';
  // 懒加载:bySource 累积各组拉到的榜单;loadedTabs 记已拉过的组(切回不重拉);loadingTab 当前在拉哪组。
  const [bySource, setBySource] = useState<Map<string, HotSource>>(new Map());
  const [loadedTabs, setLoadedTabs] = useState<Set<number>>(new Set());
  const [loadingTab, setLoadingTab] = useState<number | null>(null);
  const [error, setError] = useState(false);
  const [activeTab, setActiveTab] = useState(0);   // 0=抖音/B站/微博,1=知乎/百度/雪球,2=国外

  // 只拉某一组的源(懒加载)。force=true 用于「刷新」按钮重拉当前组。
  const loadTab = useCallback(async (idx: number, force = false) => {
    if (!force && loadedTabs.has(idx)) return;
    setLoadingTab(idx); setError(false);
    try {
      const names = TAB_GROUPS[idx].sources;
      const qs = encodeURIComponent(names.join(','));
      const resp = await fetch(`${getBackendApiUrl()}/api/web3/hot-search?sources=${qs}`);
      if (!resp.ok) throw new Error('http ' + resp.status);
      const json = await resp.json();
      const got: HotSource[] = Array.isArray(json.sources) ? json.sources.filter((s: HotSource) => s.items?.length) : [];
      setBySource((prev) => { const m = new Map(prev); for (const s of got) m.set(s.source, s); return m; });
      setLoadedTabs((prev) => new Set(prev).add(idx));
    } catch { setError(true); }
    finally { setLoadingTab(null); }
  }, [loadedTabs]);

  // 首屏:只拉第 1 组(其余等用户点 tab 再拉)。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void loadTab(0); }, []);

  const selectTab = (idx: number) => { setActiveTab(idx); void loadTab(idx); };
  const refresh = () => { void loadTab(activeTab, true); };

  const openLink = (url: string) => { if (url) window.electron?.shell?.openExternal?.(url); };
  const title = i18nService.t('globalHotSearch');

  const group = TAB_GROUPS[activeTab];
  const gridColsCls = group.sources.length >= 4 ? 'md:grid-cols-2 xl:grid-cols-4' : 'md:grid-cols-3';
  const tabLoading = loadingTab === activeTab && !loadedTabs.has(activeTab);
  const tabError = error && !loadedTabs.has(activeTab);

  return (
    <div className="flex flex-col h-full w-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b dark:border-claude-darkBorder border-claude-border shrink-0 dark:bg-claude-darkSurface/50 bg-claude-surface/50 draggable" style={{ paddingLeft: isMac ? 80 : undefined }}>
        <div className="non-draggable flex items-center gap-2">
          {isSidebarCollapsed && (
            <>
              <button type="button" onClick={onToggleSidebar} className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors">
                <SidebarToggleIcon className="h-4 w-4" isCollapsed={true} />
              </button>
              <button type="button" onClick={onNewChat} className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors">
                <ComposeIcon className="h-4 w-4" />
              </button>
              {updateBadge}
            </>
          )}
          <h1 className="text-sm font-semibold dark:text-claude-darkText text-claude-text flex items-center gap-2">
            <span className="text-base">🔥</span> {title}
          </h1>
          <button type="button" onClick={refresh} disabled={loadingTab !== null}
            className="ml-1 text-[11px] px-2 py-0.5 rounded-md dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors disabled:opacity-50">
            {loadingTab !== null ? '⟳' : '↻'} {i18nService.t('globalHotSearchRefresh')}
          </button>
        </div>
        <WindowTitleBar inline />
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto dark:bg-claude-darkBg bg-claude-bg">
        <div className="p-3 sm:p-4">
          {/* 切换组:点一下整组切换;未拉过的组点了才去 loading(懒加载)。tab 始终可点。 */}
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            {TAB_GROUPS.map((g, idx) => (
              <button key={g.key} type="button" onClick={() => selectTab(idx)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                  activeTab === idx
                    ? 'bg-claude-accent text-black border-transparent shadow'
                    : 'dark:text-claude-darkTextSecondary text-claude-textSecondary dark:border-claude-darkBorder border-claude-border hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'}`}>
                {g.label}
                {loadingTab === idx && <span className="ml-1 animate-pulse">⟳</span>}
              </button>
            ))}
          </div>

          {tabLoading ? (
            <div className="py-20 flex items-center justify-center text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
              <span className="animate-pulse">🔥 {i18nService.t('globalHotSearchLoading')}</span>
            </div>
          ) : tabError ? (
            <div className="py-20 flex flex-col items-center justify-center gap-3 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
              <span>😶‍🌫️ {i18nService.t('globalHotSearchError')}</span>
              <button onClick={refresh} className="px-3 py-1.5 rounded-lg bg-claude-accent text-black text-xs hover:opacity-90">{i18nService.t('globalHotSearchRetry')}</button>
            </div>
          ) : (
            /* 当前组的榜单(一行铺开),按组内顺序锚定;某榜抓取失败给占位卡保持布局 */
            <div className={`grid grid-cols-1 ${gridColsCls} gap-3 sm:gap-4 auto-rows-min`}>
              {group.sources.map((name) => {
                const src = bySource.get(name);
                const st = styleOf(name);
                const updated = src ? latestUpdated(src.items) : '';
                return (
                  <div key={name}
                    className={`group rounded-2xl border dark:border-claude-darkBorder/60 border-claude-border/60 ${st.ring} bg-gradient-to-br ${st.from} ${st.to} dark:bg-claude-darkSurface/40 bg-white/60 backdrop-blur-sm overflow-hidden transition-all hover:shadow-lg`}>
                    {/* 卡片头:左 emoji+名;右 最新更新时间 + 条数 */}
                    <div className="flex items-center gap-2 px-4 py-3 border-b dark:border-claude-darkBorder/40 border-claude-border/40">
                      <span className="text-xl">{st.emoji}</span>
                      <span className="text-sm font-bold dark:text-claude-darkText text-claude-text">{name}</span>
                      <span className="ml-auto flex items-center gap-1.5">
                        {updated && (
                          <span title={i18nService.t('globalHotSearchUpdatedAt') || '最新更新时间'}
                            className="text-[10px] px-1.5 py-0.5 rounded-full dark:bg-claude-darkBg/60 bg-white/70 dark:text-claude-darkTextSecondary text-claude-textSecondary font-medium tabular-nums">
                            🕐 {updated}
                          </span>
                        )}
                        {src && (
                          <span className="text-[10px] px-2 py-0.5 rounded-full dark:bg-claude-darkBg/60 bg-white/70 dark:text-claude-darkTextSecondary text-claude-textSecondary font-medium">
                            {src.items.length} {i18nService.t('globalHotSearchCount')}
                          </span>
                        )}
                      </span>
                    </div>
                    {/* 榜单 / 占位 */}
                    {src ? (
                      <ol className="px-2 py-2">
                        {src.items.map((it, i) => {
                          const rank = it.rank || (i + 1);
                          return (
                            <li key={it.id}>
                              <button type="button" onClick={() => openLink(it.url)}
                                className="w-full flex items-start gap-2.5 px-2 py-1.5 rounded-lg text-left hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                                <span className={`shrink-0 w-5 h-5 mt-0.5 rounded-md text-[11px] font-bold flex items-center justify-center ${rankBadge(rank)}`}>
                                  {rank}
                                </span>
                                <span className="flex-1 min-w-0">
                                  <span className="block text-[13px] leading-snug dark:text-claude-darkText text-claude-text line-clamp-2 group-hover:text-claude-text dark:group-hover:text-claude-darkText">
                                    {it.title}
                                  </span>
                                  {it.summary && (
                                    <span className="block text-[11px] mt-0.5 dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70 truncate">
                                      {it.summary}
                                    </span>
                                  )}
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ol>
                    ) : (
                      <div className="px-4 py-10 text-center text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                        {i18nService.t('globalHotSearchEmpty') || '该榜暂无数据'}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default GlobalHotSearchPage;
