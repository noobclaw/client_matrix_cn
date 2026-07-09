/**
 * MatrixSourcesPreview — 数据源多选向导里的「最新几条」预览(image_text 数据源模式 / x_post 数据源模式)。
 *
 * 对用户勾选的每个源实时拉最近几条标题,让用户选源前就知道运行时 AI 大概会拿到什么选题。
 * 三类源三个公开接口(与运行时 orchestrator 取材同源同口径):
 *   news     → GET  /api/web3/news-sources?perSource=3(各 web3 资讯源,扁平取前几条)
 *   hot      → GET  /api/web3/hot-search?sources=<名1,名2>(热搜榜标题)
 *   category → POST /api/video/hotspot/preview {perSource}(items[catKey])
 * 版式对齐 Web3NewsSourcesPreview:定高可滚(max-h-52,防把向导撑高)、各源标题栏 sticky 吸顶、点条目开原文。
 */
import React, { useEffect, useState } from 'react';
import { getBackendApiUrl } from '../../services/endpoints';
import { postSourceById } from './postSources';

interface PreviewItem { title: string; url?: string }
interface PreviewSection { id: string; label: string; emoji: string; items: PreviewItem[] }

const PER_SOURCE = 5;
const openLink = (url?: string) => { if (url) (window as any).electron?.shell?.openExternal?.(url); };

const MatrixSourcesPreview: React.FC<{ sourceIds: string[]; isZh: boolean }> = ({ sourceIds, isZh }) => {
  const [sections, setSections] = useState<PreviewSection[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const key = sourceIds.join(',');

  useEffect(() => {
    const ids = key ? key.split(',').filter(Boolean) : [];
    if (!ids.length) { setSections([]); setLoading(false); setError(false); return; }
    let alive = true;
    (async () => {
      setLoading(true); setError(false);
      const base = getBackendApiUrl();
      const opts = ids.map((id) => postSourceById(id)).filter((o): o is NonNullable<typeof o> => !!o);
      const bySection = new Map<string, PreviewItem[]>();
      const jobs: Promise<void>[] = [];
      // hot:一次请求带全所选榜名。
      const hotOpts = opts.filter((o) => o.kind === 'hot');
      if (hotOpts.length) {
        jobs.push((async () => {
          const qs = encodeURIComponent(hotOpts.map((o) => o.source || '').filter(Boolean).join(','));
          const resp = await fetch(`${base}/api/web3/hot-search?sources=${qs}`);
          if (!resp.ok) throw new Error('http ' + resp.status);
          const json = await resp.json();
          const srcs: Array<{ source: string; items: Array<{ title: string; url?: string }> }> = Array.isArray(json.sources) ? json.sources : [];
          for (const o of hotOpts) {
            const s = srcs.find((x) => x && x.source === o.source);
            const items = (s?.items || []).slice(0, PER_SOURCE).map((it) => ({ title: String(it.title || ''), url: it.url }));
            bySection.set(o.id, items);
          }
        })());
      }
      // news:各 web3 资讯源扁平混排,取前几条(预览够用,运行时按源+时间窗选材)。
      if (opts.some((o) => o.kind === 'news')) {
        jobs.push((async () => {
          const resp = await fetch(`${base}/api/web3/news-sources?perSource=3`);
          if (!resp.ok) throw new Error('http ' + resp.status);
          const json = await resp.json();
          const srcs: Array<{ source: string; items: Array<{ title: string; url?: string }> }> = Array.isArray(json.sources) ? json.sources : [];
          const flat: PreviewItem[] = [];
          for (const s of srcs) for (const it of (s.items || [])) { if (flat.length < 6) flat.push({ title: `[${s.source}] ${String(it.title || '')}`, url: it.url }); }
          bySection.set('web3', flat);
        })());
      }
      // category(科技/AI 等):hotspot preview 按分类键取。
      const catOpts = opts.filter((o) => o.kind === 'category');
      if (catOpts.length) {
        jobs.push((async () => {
          const resp = await fetch(`${base}/api/video/hotspot/preview`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ perSource: PER_SOURCE }),
          });
          if (!resp.ok) throw new Error('http ' + resp.status);
          const json = await resp.json();
          for (const o of catOpts) {
            const arr: Array<{ title: string; url?: string }> = (json?.items && Array.isArray(json.items[o.catKey || 'tech'])) ? json.items[o.catKey || 'tech'] : [];
            bySection.set(o.id, arr.slice(0, PER_SOURCE).map((it) => ({ title: String(it.title || ''), url: it.url })));
          }
        })());
      }
      // 单源失败不拖垮整块预览(比如海外源偶发超时),其余源照展示。
      const settled = await Promise.allSettled(jobs);
      if (!alive) return;
      const allFailed = jobs.length > 0 && settled.every((r) => r.status === 'rejected');
      setSections(opts.map((o) => ({ id: o.id, label: isZh ? o.zh : o.en, emoji: o.emoji, items: bySection.get(o.id) || [] })));
      setError(allFailed);
      setLoading(false);
    })().catch(() => { if (alive) { setError(true); setLoading(false); } });
    return () => { alive = false; };
  }, [key, isZh]);

  if (!key) return null;
  if (loading && !sections.length) return <div className="text-[11px] text-gray-400 px-1 py-2">{isZh ? '加载最新数据…' : 'Loading latest items…'}</div>;
  if (error) return <div className="text-[11px] text-gray-400 px-1 py-2">{isZh ? '预览加载失败(不影响创建,运行时实时取材)' : 'Preview failed to load (task still works; topics are fetched at run time)'}</div>;

  return (
    <div>
      <div className="text-[11px] text-gray-500 dark:text-gray-400 mb-1.5">
        {isZh ? '📊 所选源的最新内容(运行时从中挑选题,可滚动、点标题看原文):' : 'Latest items from selected sources (topics are picked from these at run time):'}
      </div>
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 max-h-52 overflow-y-auto">
        {sections.map((sec) => (
          <div key={sec.id}>
            <div className="sticky top-0 z-10 flex items-center gap-1.5 px-2.5 py-1.5 bg-white dark:bg-gray-800 border-b border-gray-100 dark:border-gray-700">
              <span className="text-sm shrink-0">{sec.emoji}</span>
              <span className="text-xs font-semibold dark:text-gray-200 truncate">{sec.label}</span>
              <span className="ml-auto text-[10px] text-gray-400 shrink-0">{sec.items.length}{isZh ? ' 条' : ''}</span>
            </div>
            {sec.items.length === 0 ? (
              <div className="px-2.5 py-1.5 text-[11px] text-gray-400">{isZh ? '暂无数据(运行时实时取)' : 'No data yet (fetched at run time)'}</div>
            ) : (
              <ol className="px-2 py-1.5 space-y-1">
                {sec.items.map((it, i) => (
                  <li key={i}>
                    <button type="button" onClick={() => openLink(it.url)} className="w-full text-left flex items-start gap-1.5 group">
                      <span className="shrink-0 text-[10px] text-gray-400 w-3.5 text-right leading-snug">{i + 1}</span>
                      <span className="text-[11px] leading-snug text-gray-600 dark:text-gray-300 group-hover:text-emerald-600 dark:group-hover:text-emerald-400 line-clamp-2">{it.title}</span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default MatrixSourcesPreview;
