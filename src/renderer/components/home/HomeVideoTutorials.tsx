import React, { useEffect, useRef, useState } from 'react';
import { i18nService } from '../../services/i18n';

/**
 * 首页「视频教程」区 — 分类标签(全部/成片效果/各平台) + 两行横向翻页(首/末页藏对应箭头)。
 *
 * 数据来自 R2 清单 site/videos/manifest.json(backend/scripts/sync-bili-videos.js 生成),
 * B 站发新视频重跑脚本即对所有已装客户端生效,零打包。带 ?v=时间戳 绕 CDN 缓存;
 * 清单经 tauriShim 的 fetch 代理走 sidecar 拉取,拉不到时整个区不渲染。
 *
 * 点卡片【新开系统浏览器】到 B 站视频页播放 —— 不在应用内嵌播:B 站外嵌播放器对
 * 未登录观众限 480p 不清晰(用户拍板 2026-08-09,弃应用内弹层方案)。
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
  const rowRef = useRef<HTMLDivElement>(null);
  const [canPrev, setCanPrev] = useState(false);
  const [canNext, setCanNext] = useState(false);

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

  const openExternal = (url: string) => { try { window.electron?.shell?.openExternal?.(url); } catch { /* noop */ } };
  const openVideo = (v: ManifestVideo) => openExternal(`https://www.bilibili.com/video/${v.bvid}/`);

  if (!videos.length) return null;

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
              title={v.title}
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
    </div>
  );
};

export default HomeVideoTutorials;
