import React, { useState, useEffect, useCallback, useRef } from 'react';
import { i18nService } from '../../services/i18n';
import { getBackendApiUrl } from '../../services/endpoints';

interface NewsItem {
  id: string;
  title: string;
  summary: string;
  source: string;
  url: string;
  thumbnail: string | null;
  category: string;
  rank?: number;
  publishedAt: string;
}

interface CategoryMeta {
  key: string;
  label: string;
  labelZh: string;
  icon: string;
  count: number;
  total: number;
  hasMore: boolean;
  refreshSec?: number;
}

interface Web3NewsData {
  categories: CategoryMeta[];
  articles: Record<string, NewsItem[]>;
  updatedAt: string;
}

// Module-level cache
let _cached: Web3NewsData | null = null;
let _lastFetch = 0;

const Web3News: React.FC = () => {
  const [data, setData] = useState<Web3NewsData | null>(_cached);
  const [loading, setLoading] = useState(!_cached);
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const [loadingMore, setLoadingMore] = useState<Record<string, boolean>>({});
  const [pageMap, setPageMap] = useState<Record<string, number>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const currentLang = i18nService.getLanguage();
  const useZhLabel = currentLang === 'zh' || currentLang === 'zh-TW';

  const getBaseUrl = useCallback(() => getBackendApiUrl(), []);

  const fetchOverview = useCallback(async () => {
    try {
      const resp = await fetch(`${getBaseUrl()}/api/web3/news?lang=${currentLang}`);
      if (resp.ok) {
        const json = await resp.json();
        if (json.categories && json.articles) {
          _cached = json;
          setData(json);
          _lastFetch = Date.now();
          setPageMap({});
        }
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [getBaseUrl, currentLang]);

  useEffect(() => {
    if (Date.now() - _lastFetch > 2 * 60 * 1000 || !_cached) {
      fetchOverview();
    } else {
      setLoading(false);
    }

    // Auto-refresh every 3 minutes (overview)
    const timer = setInterval(fetchOverview, 3 * 60 * 1000);
    return () => clearInterval(timer);
  }, [fetchOverview]);

  const loadMore = useCallback(async (catKey: string) => {
    if (!data || loadingMore[catKey]) return;
    const currentPage = pageMap[catKey] || 1;
    const nextPage = currentPage + 1;

    setLoadingMore(prev => ({ ...prev, [catKey]: true }));
    try {
      const resp = await fetch(`${getBaseUrl()}/api/web3/news?category=${catKey}&page=${nextPage}&pageSize=10&lang=${currentLang}`);
      if (resp.ok) {
        const json = await resp.json();
        if (json.items?.length > 0) {
          setData(prev => {
            if (!prev) return prev;
            const existing = prev.articles[catKey] || [];
            const existingIds = new Set(existing.map(i => i.id));
            const newItems = json.items.filter((i: NewsItem) => !existingIds.has(i.id));
            const updatedArticles = { ...prev.articles, [catKey]: [...existing, ...newItems] };
            const updatedCategories = prev.categories.map(c =>
              c.key === catKey
                ? { ...c, count: updatedArticles[catKey].length, total: json.pagination.total, hasMore: json.pagination.hasMore }
                : c
            );
            const updated = { ...prev, articles: updatedArticles, categories: updatedCategories };
            _cached = updated;
            return updated;
          });
          setPageMap(prev => ({ ...prev, [catKey]: nextPage }));
        }
      }
    } catch { /* ignore */ }
    setLoadingMore(prev => ({ ...prev, [catKey]: false }));
  }, [data, loadingMore, pageMap, getBaseUrl]);

  const openLink = (url: string) => {
    window.electron?.shell?.openExternal?.(url);
  };

  const timeAgo = (dateStr: string) => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return i18nService.t('web3NewsJustNow');
    if (mins < 60) return i18nService.t('web3NewsMinsAgo', { n: String(mins) });
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return i18nService.t('web3NewsHoursAgo', { n: String(hrs) });
    const days = Math.floor(hrs / 24);
    return i18nService.t('web3NewsDaysAgo', { n: String(days) });
  };

  const refreshLabel = (sec: number) => {
    if (sec < 60) return i18nService.t('web3NewsSec', { n: String(sec) });
    const m = Math.floor(sec / 60);
    return i18nService.t('web3NewsMin', { n: String(m) });
  };

  const toggleSection = (key: string) => {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  if (loading) {
    const cryptoIcons = [
      { symbol: 'BTC', logo: 'https://assets.coingecko.com/coins/images/1/small/bitcoin.png', color: '#F7931A' },
      { symbol: 'ETH', logo: 'https://assets.coingecko.com/coins/images/279/small/ethereum.png', color: '#627EEA' },
      { symbol: 'SOL', logo: 'https://assets.coingecko.com/coins/images/4128/small/solana.png', color: '#9945FF' },
      { symbol: 'BNB', logo: 'https://assets.coingecko.com/coins/images/825/small/bnb-icon2_2x.png', color: '#F0B90B' },
      { symbol: 'AVAX', logo: 'https://assets.coingecko.com/coins/images/12559/small/Avalanche_Circle_RedWhite_Trans.png', color: '#E84142' },
      { symbol: 'DOT', logo: 'https://assets.coingecko.com/coins/images/12171/small/polkadot.png', color: '#E6007A' },
      { symbol: 'ADA', logo: 'https://assets.coingecko.com/coins/images/975/small/cardano.png', color: '#0033AD' },
      { symbol: 'DOGE', logo: 'https://assets.coingecko.com/coins/images/5/small/dogecoin.png', color: '#C2A633' },
      { symbol: 'XRP', logo: 'https://assets.coingecko.com/coins/images/44/small/xrp-symbol-white-128.png', color: '#23292F' },
    ];
    return (
      <div className="flex flex-col h-full items-center justify-center gap-8">
        {/* Floating crypto icons */}
        <div className="relative w-64 h-40">
          {cryptoIcons.map((coin, i) => {
            const angle = (i / cryptoIcons.length) * Math.PI * 2;
            const rx = 100, ry = 50;
            const cx = rx * Math.cos(angle);
            const cy = ry * Math.sin(angle);
            return (
              <div
                key={coin.symbol}
                className="absolute w-10 h-10 rounded-full flex items-center justify-center shadow-lg"
                style={{
                  left: `calc(50% + ${cx}px - 20px)`,
                  top: `calc(50% + ${cy}px - 20px)`,
                  background: `linear-gradient(135deg, ${coin.color}22, ${coin.color}44)`,
                  border: `1.5px solid ${coin.color}66`,
                  animation: `web3-float ${2 + i * 0.3}s ease-in-out infinite alternate`,
                  animationDelay: `${i * 0.15}s`,
                }}
              >
                <img src={coin.logo} alt={coin.symbol} className="w-6 h-6" />
              </div>
            );
          })}
          {/* Center glow */}
          <div
            className="absolute rounded-full"
            style={{
              left: 'calc(50% - 30px)', top: 'calc(50% - 30px)',
              width: 60, height: 60,
              background: 'radial-gradient(circle, rgba(139,92,246,0.3) 0%, transparent 70%)',
              animation: 'web3-pulse 2s ease-in-out infinite',
            }}
          />
        </div>
        {/* Loading text */}
        <div className="flex flex-col items-center gap-2">
          <div className="text-sm font-medium dark:text-claude-darkText text-claude-text"
               style={{ animation: 'web3-text-shimmer 2s ease-in-out infinite' }}>
            {i18nService.t('web3NewsLoading')}
          </div>
          <div className="flex gap-1">
            {[0, 1, 2].map(i => (
              <div key={i} className="w-1.5 h-1.5 rounded-full bg-purple-500"
                   style={{ animation: `web3-dot 1.4s ease-in-out ${i * 0.2}s infinite` }} />
            ))}
          </div>
        </div>
        <style>{`
          @keyframes web3-float {
            0% { transform: translateY(0px) scale(1); opacity: 0.7; }
            100% { transform: translateY(-12px) scale(1.1); opacity: 1; }
          }
          @keyframes web3-pulse {
            0%, 100% { transform: scale(1); opacity: 0.3; }
            50% { transform: scale(1.5); opacity: 0.6; }
          }
          @keyframes web3-text-shimmer {
            0%, 100% { opacity: 0.7; }
            50% { opacity: 1; }
          }
          @keyframes web3-dot {
            0%, 80%, 100% { transform: scale(0.6); opacity: 0.3; }
            40% { transform: scale(1.2); opacity: 1; }
          }
        `}</style>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col h-full items-center justify-center">
        <div className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('web3NewsNoData')}
        </div>
      </div>
    );
  }

  const visibleCategories = activeCategory === 'all'
    ? data.categories.filter(c => c.count > 0 || c.total > 0)
    : data.categories.filter(c => c.key === activeCategory && (c.count > 0 || c.total > 0));

  return (
    <div className="flex flex-col h-full">
      {/* Category tabs */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
        <button
          onClick={() => setActiveCategory('all')}
          className={`px-4 py-2 rounded-full text-sm font-medium transition-colors whitespace-nowrap ${
            activeCategory === 'all'
              ? 'bg-claude-accent text-black'
              : 'dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkTextSecondary text-claude-textSecondary hover:opacity-80'
          }`}
        >
          {i18nService.t('web3NewsAll')}
        </button>
        {data.categories.filter(c => c.count > 0 || c.total > 0).map(cat => (
          <button
            key={cat.key}
            onClick={() => setActiveCategory(cat.key)}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-colors whitespace-nowrap ${
              activeCategory === cat.key
                ? 'bg-claude-accent text-black'
                : 'dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkTextSecondary text-claude-textSecondary hover:opacity-80'
            }`}
          >
            {cat.icon} {useZhLabel ? cat.labelZh : cat.label}
            <span className="ml-1 opacity-60">{cat.total ?? cat.count}</span>
          </button>
        ))}
        {/* Update time */}
        <div className="ml-auto text-[10px] dark:text-claude-darkTextSecondary/50 text-claude-textSecondary/50 whitespace-nowrap">
          {timeAgo(data.updatedAt)}
        </div>
      </div>

      {/* Content - sections by category */}
      <div className="flex-1 overflow-y-auto" ref={scrollRef}>
        {visibleCategories.map(cat => {
          const items = data.articles[cat.key] || [];
          if (items.length === 0) return null;
          const collapsed = collapsedSections.has(cat.key);
          const isLoadingMore = loadingMore[cat.key] || false;

          return (
            <div key={cat.key} className="border-b dark:border-claude-darkBorder/30 border-claude-border/30 last:border-b-0">
              {/* Section header */}
              <button
                onClick={() => toggleSection(cat.key)}
                className="w-full flex items-center gap-2 px-4 py-2.5 sticky top-0 z-10 dark:bg-claude-darkBg/95 bg-claude-bg/95 backdrop-blur-sm hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <span className="text-base">{cat.icon}</span>
                <span className="text-sm font-semibold dark:text-claude-darkText text-claude-text">
                  {useZhLabel ? cat.labelZh : cat.label}
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {items.length}{cat.total > items.length ? `/${cat.total}` : ''}
                </span>
                {cat.refreshSec && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded dark:bg-claude-darkSurface/60 bg-claude-surface/60 dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60">
                    {i18nService.t('web3NewsRefresh', { n: refreshLabel(cat.refreshSec) })}
                  </span>
                )}
                <svg
                  className={`w-3.5 h-3.5 ml-auto dark:text-claude-darkTextSecondary text-claude-textSecondary transition-transform ${collapsed ? '' : 'rotate-180'}`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {/* Section content */}
              {!collapsed && (
                <div className="px-4 pb-3 space-y-1.5">
                  {cat.key === 'trending' ? (
                    // Trending: compact horizontal cards
                    <div className="grid grid-cols-2 gap-2">
                      {items.map(item => (
                        <div
                          key={item.id}
                          onClick={() => openLink(item.url)}
                          className="group flex items-center gap-2.5 p-2.5 rounded-lg dark:bg-claude-darkSurface/50 bg-claude-surface/50 border dark:border-claude-darkBorder/40 border-claude-border/40 hover:border-claude-accent/40 cursor-pointer transition-all"
                        >
                          {item.thumbnail ? (
                            <img src={item.thumbnail} alt="" className="w-7 h-7 rounded-full object-cover shrink-0" />
                          ) : (
                            <div className="w-7 h-7 rounded-full dark:bg-claude-darkSurface bg-claude-surface flex items-center justify-center shrink-0 text-xs font-bold dark:text-claude-darkTextSecondary text-claude-textSecondary">
                              {item.rank || '#'}
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="text-xs font-medium dark:text-claude-darkText text-claude-text truncate group-hover:text-claude-accent transition-colors">
                              {item.title}
                            </div>
                            <div className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary truncate">
                              {item.summary}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : cat.key === 'market' ? (
                    // Market: highlighted summary card
                    items.map(item => (
                      <div
                        key={item.id}
                        onClick={() => openLink(item.url)}
                        className="group p-3.5 rounded-xl bg-gradient-to-r dark:from-claude-darkSurface/80 dark:to-claude-darkSurface/40 from-claude-surface/80 to-claude-surface/40 border dark:border-claude-darkBorder/40 border-claude-border/40 hover:border-claude-accent/40 cursor-pointer transition-all"
                      >
                        <div className="text-sm font-medium dark:text-claude-darkText text-claude-text group-hover:text-claude-accent transition-colors">
                          {item.title}
                        </div>
                        <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-1.5 leading-relaxed">
                          {item.summary}
                        </div>
                        <div className="text-[10px] dark:text-claude-darkTextSecondary/50 text-claude-textSecondary/50 mt-2">
                          {item.source} · {timeAgo(item.publishedAt)}
                        </div>
                      </div>
                    ))
                  ) : cat.key === 'flash' ? (
                    // Flash: compact timeline style
                    <div className="space-y-0">
                      {items.map((item, i) => (
                        <div
                          key={item.id}
                          onClick={() => openLink(item.url)}
                          className="group flex gap-3 py-2 cursor-pointer hover:bg-claude-surfaceHover/50 dark:hover:bg-claude-darkSurfaceHover/50 rounded-lg px-2 -mx-2 transition-colors"
                        >
                          <div className="flex flex-col items-center shrink-0 pt-0.5">
                            <div className="w-2 h-2 rounded-full bg-claude-accent/60 shrink-0" />
                            {i < items.length - 1 && <div className="w-px flex-1 dark:bg-claude-darkBorder/30 bg-claude-border/30 mt-1" />}
                          </div>
                          <div className="min-w-0 flex-1 pb-1">
                            <div className="text-xs font-medium dark:text-claude-darkText text-claude-text leading-relaxed group-hover:text-claude-accent transition-colors">
                              {item.title || item.summary?.substring(0, 100)}
                            </div>
                            {item.summary && item.title && (
                              <div className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary mt-0.5 line-clamp-2">
                                {item.summary}
                              </div>
                            )}
                            <div className="text-[10px] dark:text-claude-darkTextSecondary/50 text-claude-textSecondary/50 mt-0.5">
                              {item.source} · {timeAgo(item.publishedAt)}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    // news / analysis / ai_news: standard card list
                    items.map(item => (
                      <div
                        key={item.id}
                        onClick={() => openLink(item.url)}
                        className="group flex gap-3 p-3 rounded-xl dark:bg-claude-darkSurface/50 bg-claude-surface/50 border dark:border-claude-darkBorder/50 border-claude-border/50 hover:border-claude-accent/40 dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover cursor-pointer transition-all"
                      >
                        <div className="shrink-0 w-10 h-10 rounded-lg dark:bg-claude-darkSurface bg-claude-surface flex items-center justify-center overflow-hidden">
                          {item.thumbnail ? (
                            <img src={item.thumbnail} alt="" className="w-full h-full object-cover rounded-lg" />
                          ) : (
                            <span className="text-lg">{cat.icon}</span>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <h3 className="text-sm font-medium dark:text-claude-darkText text-claude-text line-clamp-2 group-hover:text-claude-accent transition-colors">
                            {item.title}
                          </h3>
                          {item.summary && (
                            <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-0.5 line-clamp-1">
                              {item.summary}
                            </p>
                          )}
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-[10px] px-1.5 py-0.5 rounded dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkTextSecondary text-claude-textSecondary">
                              {item.source}
                            </span>
                            <span className="text-[10px] dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60">
                              {timeAgo(item.publishedAt)}
                            </span>
                          </div>
                        </div>
                        <div className="shrink-0 self-center opacity-0 group-hover:opacity-100 transition-opacity">
                          <svg className="w-4 h-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                          </svg>
                        </div>
                      </div>
                    ))
                  )}

                  {/* Load More button */}
                  {cat.hasMore && (
                    <button
                      onClick={(e) => { e.stopPropagation(); loadMore(cat.key); }}
                      disabled={isLoadingMore}
                      className="w-full py-2 mt-1 rounded-lg text-[11px] font-medium dark:bg-claude-darkSurface/60 bg-claude-surface/60 dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors disabled:opacity-50"
                    >
                      {isLoadingMore
                        ? i18nService.t('web3NewsLoadingMore')
                        : i18nService.t('web3NewsLoadMore', { n: String(cat.total - items.length) })}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default Web3News;
