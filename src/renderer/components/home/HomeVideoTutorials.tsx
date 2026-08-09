import React, { useEffect, useRef, useState } from 'react';
import { i18nService } from '../../services/i18n';

/**
 * 首页「视频教程」区 — 与官网首页横排同款交互:
 * 分类标签(全部/成片效果/各平台) + 两行横向翻页(首/末页藏对应箭头) + 点卡片当前页弹层播放。
 *
 * 数据来自 R2 清单 site/videos/manifest.json(backend/scripts/sync-bili-videos.js 生成),
 * B 站发新视频重跑脚本即对所有已装客户端生效,零打包。带 ?v=时间戳 绕 CDN 缓存。
 * 播放用 B 站官方外嵌 player(iframe,tauri csp 为 null 不拦);清单拉不到时整个区不渲染。
 */

const MANIFEST_URL = 'https://static.noobclaw.com/site/videos/manifest.json';
// 「更多教程」与官网一致直达文档站;中文界面进中文版,其余进英文版。
const moreTutorialsUrl = (): string =>
  (i18nService.currentLanguage === 'zh' || i18nService.currentLanguage === 'zh-TW')
    ? 'https://docs.noobclaw.com/' : 'https://docs.noobclaw.com/english';

interface ManifestVideo { bvid: string; cid: number; title: string; cover: string; duration: number; w: number; h: number; group: string; }
interface ManifestGroup { key: string; label: string; count: number; }

const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

const HomeVideoTutorials: React.FC = () => {
  const [videos, setVideos] = useState<ManifestVideo[]>([]);
  const [groups, setGroups] = useState<ManifestGroup[]>([]);
  const [active, setActive] = useState('all');
  const [playing, setPlaying] = useState<ManifestVideo | null>(null);
  const [showLoading, setShowLoading] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const [canPrev, setCanPrev] = useState(false);
  const [canNext, setCanNext] = useState(false);
  const loadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`${MANIFEST_URL}?v=${Date.now()}`)
      .then((r) => r.json())
      .then((m) => { if (!alive) return; setVideos(m.videos || []); setGroups(m.groups || []); })
      .catch(() => { /* 拉不到就不渲染本区 */ });
    return () => { alive = false; };
  }, []);

  const shown = active === 'all' ? videos : videos.filter((v) => v.group === active);

  const updateArrows = () => {
    const r = rowRef.current;
    if (!r) return;
    setCanPrev(r.scrollLeft > 5);
    setCanNext(r.scrollLeft + r.clientWidth < r.scrollWidth - 5);
  };
  useEffect(() => {
    rowRef.current?.scrollTo({ left: 0 });
    // 等布局落定再算一次(切分类后 scrollWidth 变化)
    const t = setTimeout(updateArrows, 50);
    return () => clearTimeout(t);
  }, [shown.length, active, videos.length]);

  const pageBy = (d: number) => {
    const r = rowRef.current;
    if (r) r.scrollBy({ left: d * r.clientWidth * 0.9, behavior: 'smooth' });
  };

  const openVideo = (v: ManifestVideo) => {
    setPlaying(v);
    setShowLoading(true);
    if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
    // B 站 iframe 起播前有一段黑/灰,提示压 6 秒(与官网一致)
    loadTimerRef.current = setTimeout(() => setShowLoading(false), 6000);
  };
  const closeVideo = () => {
    setPlaying(null);
    if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeVideo(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openExternal = (url: string) => { try { window.electron?.shell?.openExternal?.(url); } catch { /* noop */ } };

  if (!videos.length) return null;

  const portrait = playing ? playing.h > playing.w : false;

  return (
    <div className="space-y-4">
      {/* 标题行:📺 视频教程 + 更多教程 → 文档站 */}
      <div className="flex items-center justify-between">
        <h2 className="text-base font-bold dark:text-claude-darkText text-claude-text">
          📺 {i18nService.t('hvVideosTitle')}
        </h2>
        <button
          type="button"
          onClick={() => openExternal(moreTutorialsUrl())}
          className="text-xs font-medium text-claude-accent hover:underline inline-flex items-center gap-1"
        >
          {i18nService.t('hvVideosMore')}
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
        </button>
      </div>

      {/* 分类标签(标签文案来自清单,B 站内容为中文) */}
      <div className="flex flex-wrap gap-1.5">
        {groups.map((g) => (
          <button
            key={g.key}
            type="button"
            onClick={() => setActive(g.key)}
            className={`px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors ${
              active === g.key
                ? 'bg-claude-accent text-white border-transparent'
                : 'dark:bg-white/[0.03] bg-white dark:border-white/10 border-gray-200/80 dark:text-gray-300 text-gray-600 hover:border-claude-accent/50'
            }`}
          >
            {g.label} ({g.count})
          </button>
        ))}
      </div>

      {/* 两行横向翻页 */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => pageBy(-1)}
          style={{ visibility: canPrev ? 'visible' : 'hidden' }}
          className="shrink-0 w-8 h-8 rounded-full dark:bg-white/10 bg-gray-100 dark:hover:bg-white/20 hover:bg-gray-200 dark:text-white text-gray-700 flex items-center justify-center transition-colors"
          aria-label="上一页"
        >←</button>
        <div
          ref={rowRef}
          onScroll={updateArrows}
          className="flex-1 overflow-x-auto"
          style={{ display: 'grid', gridAutoFlow: 'column', gridTemplateRows: 'repeat(2, auto)', gridAutoColumns: '176px', gap: 10, scrollBehavior: 'smooth', scrollbarWidth: 'none' }}
        >
          {shown.map((v) => (
            <div
              key={v.bvid}
              role="button"
              tabIndex={0}
              onClick={() => openVideo(v)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openVideo(v); } }}
              className="group cursor-pointer rounded-xl overflow-hidden border dark:border-white/10 border-gray-200/80 dark:bg-white/[0.03] bg-white hover:-translate-y-0.5 hover:shadow-md transition-all"
              aria-label={`播放:${v.title}`}
            >
              <div className="relative bg-black" style={{ aspectRatio: '16/10' }}>
                <img src={v.cover} alt={v.title} loading="lazy" className="w-full h-full object-cover" />
                <span className="absolute right-1.5 bottom-1.5 px-1.5 py-0.5 rounded bg-black/75 text-white text-[10px]">{fmtDur(v.duration)}</span>
                <span className="absolute inset-0 m-auto w-9 h-9 rounded-full bg-black/55 text-white group-hover:bg-emerald-400 group-hover:text-black flex items-center justify-center transition-colors">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                </span>
              </div>
              <div className="px-2 py-1.5 text-[11px] leading-snug dark:text-gray-200 text-gray-700 h-[42px] overflow-hidden" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                {v.title}
              </div>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() => pageBy(1)}
          style={{ visibility: canNext ? 'visible' : 'hidden' }}
          className="shrink-0 w-8 h-8 rounded-full dark:bg-white/10 bg-gray-100 dark:hover:bg-white/20 hover:bg-gray-200 dark:text-white text-gray-700 flex items-center justify-center transition-colors"
          aria-label="下一页"
        >→</button>
      </div>

      {/* 弹层播放:标题在播放框上方,起播前压 6 秒加载提示 */}
      {playing && (
        <div
          className="fixed inset-0 z-[100] bg-black/85 flex items-center justify-center p-5"
          role="dialog"
          aria-modal="true"
          onClick={(e) => { if (e.target === e.currentTarget) closeVideo(); }}
        >
          <button
            type="button"
            onClick={closeVideo}
            className="fixed top-14 right-5 w-9 h-9 rounded-full bg-white/15 hover:bg-white/30 text-white text-lg z-[101]"
            aria-label="关闭"
          >✕</button>
          <div className="w-full" style={{ maxWidth: portrait ? 'min(90vw, 380px)' : 'min(92vw, 860px)' }}>
            <div className="text-white text-sm font-semibold mb-2 pr-10 leading-snug">{playing.title}</div>
            <div className="relative w-full rounded-xl overflow-hidden border border-emerald-400/25 bg-[#0d0d15]" style={{ maxHeight: '80vh' }}>
              <div style={{ paddingTop: `${(playing.h / playing.w) * 100}%` }} />
              <iframe
                title={playing.title}
                src={`https://player.bilibili.com/player.html?isOutside=true&bvid=${playing.bvid}&cid=${playing.cid}&p=1&autoplay=1&high_quality=1`}
                allowFullScreen
                allow="autoplay; fullscreen"
                className="absolute inset-0 w-full h-full border-0 z-[1]"
              />
              {showLoading && (
                <div className="absolute inset-0 z-[2] pointer-events-none flex items-center justify-center bg-black/55 text-gray-300 text-sm">▶ {i18nService.t('hvVideosLoading')}</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default HomeVideoTutorials;
