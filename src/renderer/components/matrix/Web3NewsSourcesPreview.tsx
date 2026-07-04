/**
 * Web3NewsSourcesPreview — 矩阵「自动发推 / 币安广场发帖」web3 资讯模式向导里的资讯源预览。
 *
 * 拉后端 GET /api/web3/news-sources(分源 + 每源最近 5 条),点条目开原文。
 * 之前把所有源平铺成卡片网格,太长把账号勾选挤出可视区 → 改成定高可滚动的盒子,
 * 各源标题栏 sticky 吸顶,滚动查看不占版面。
 * 选材池口径与运行时 AI 取材(newsPicker)一致 → 用户能预览 AI 会从哪些源、近期有哪些热点取材。
 */
import React, { useEffect, useState } from 'react';
import { getBackendApiUrl } from '../../services/endpoints';

interface NewsItem { id: string; title: string; summary?: string; url: string; source: string; publishedAt?: string }
interface NewsSource { source: string; items: NewsItem[] }

// 各资讯源的小图标(没列到的走默认)。
const SRC_EMOJI: Record<string, string> = {
  PANews: '📰', ChainCatcher: '🐱', 'BlockBeats 律动': '🎵', Foresight: '🔮',
  BWENews: '⚡', CoinDesk: '🪙', Cointelegraph: '📡', Decrypt: '🔓',
};
const emojiOf = (s: string) => SRC_EMOJI[s] || '🌐';
const openLink = (url: string) => { if (url) (window as any).electron?.shell?.openExternal?.(url); };

const Web3NewsSourcesPreview: React.FC<{ isZh: boolean }> = ({ isZh }) => {
  const [sources, setSources] = useState<NewsSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true); setError(false);
      try {
        const resp = await fetch(`${getBackendApiUrl()}/api/web3/news-sources?perSource=5`);
        if (!resp.ok) throw new Error('http ' + resp.status);
        const json = await resp.json();
        const got: NewsSource[] = Array.isArray(json.sources) ? json.sources.filter((s: NewsSource) => s.items?.length) : [];
        if (alive) setSources(got);
      } catch { if (alive) setError(true); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, []);

  if (loading) return <div className="text-[11px] text-gray-400 px-1 py-3">{isZh ? '加载资讯源…' : 'Loading sources…'}</div>;
  if (error) return <div className="text-[11px] text-gray-400 px-1 py-3">{isZh ? '资讯源加载失败(不影响创建,运行时实时取材)' : 'Failed to load (does not affect the task; news is fetched at run time)'}</div>;
  if (!sources.length) return <div className="text-[11px] text-gray-400 px-1 py-3">{isZh ? '暂无近期资讯' : 'No recent news'}</div>;

  return (
    <div>
      <div className="text-[11px] text-gray-500 dark:text-gray-400 mb-2">
        {isZh
          ? `📰 AI 会从这 ${sources.length} 个 web3 资讯源近 3 周的热点里取材(各源最近 5 条,标题栏吸顶、可滚动查看,点标题看原文):`
          : `AI picks from these ${sources.length} web3 sources, last 3 weeks (latest 5 each, scroll to browse, click to open):`}
      </div>
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 max-h-60 overflow-y-auto">
        {sources.map((src) => (
          <div key={src.source}>
            <div className="sticky top-0 z-10 flex items-center gap-1.5 px-2.5 py-1.5 bg-white dark:bg-gray-800 border-b border-gray-100 dark:border-gray-700">
              <span className="text-sm shrink-0">{emojiOf(src.source)}</span>
              <span className="text-xs font-semibold dark:text-gray-200 truncate">{src.source}</span>
              <span className="ml-auto text-[10px] text-gray-400 shrink-0">{src.items.length}{isZh ? ' 条' : ''}</span>
            </div>
            <ol className="px-2 py-1.5 space-y-1">
              {src.items.slice(0, 5).map((it, i) => (
                <li key={it.id}>
                  <button type="button" onClick={() => openLink(it.url)} className="w-full text-left flex items-start gap-1.5 group">
                    <span className="shrink-0 text-[10px] text-gray-400 w-3.5 text-right leading-snug">{i + 1}</span>
                    <span className="text-[11px] leading-snug text-gray-600 dark:text-gray-300 group-hover:text-sky-600 dark:group-hover:text-sky-400 line-clamp-2">{it.title}</span>
                  </button>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </div>
  );
};

export default Web3NewsSourcesPreview;
