import React, { useEffect, useMemo, useRef, useState } from 'react';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import ComposeIcon from '../icons/ComposeIcon';
import WindowTitleBar from '../window/WindowTitleBar';
import { i18nService } from '../../services/i18n';

interface PersonalityViewProps {
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
}

type TabKey = 'home' | 'sbti' | 'web3bti' | 'brawl';

const BASE_URL = 'https://noobclaw.com/cn';

const PersonalityView: React.FC<PersonalityViewProps> = ({
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  updateBadge,
}) => {
  const isMac = window.electron.platform === 'darwin';
  const [tab, setTab] = useState<TabKey>('home');

  // OG BRAWL uses Phaser 3 (WebGL + ES modules) which doesn't work
  // reliably inside Tauri's WebView iframe. Intercept the tab switch
  // and open in the system browser instead.
  const handleTabChange = (t: TabKey) => {
    if (t === 'brawl') {
      try {
        window.electron?.shell?.openExternal?.(`${BASE_URL}/brawl/`);
      } catch {
        window.open(`${BASE_URL}/brawl/`, '_blank', 'noopener');
      }
      return; // don't switch tab — stays on current view
    }
    setTab(t);
  };
  const [reloadKey, setReloadKey] = useState(0);
  // iframe load state — tracks whether the cross-origin embed loaded.
  // On macOS Tauri builds some users reported the iframe rendering blank;
  // this lets us show a "still loading / open in browser" fallback instead
  // of a silent black rectangle.
  const [iframeState, setIframeState] = useState<'loading' | 'loaded' | 'stuck'>('loading');
  // Bumped whenever the i18nService broadcasts a language change. We use
  // this to push a postMessage into the iframe instead of rebuilding its
  // src — see the lang-driven useEffect below.
  const [langBump, setLangBump] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Subscribe to client language changes so the embedded page follows
  // the user toggling the global language dropdown at runtime.
  useEffect(() => {
    const unsub = (i18nService as any).subscribe?.(() => setLangBump(n => n + 1));
    return () => {
      if (typeof unsub === 'function') unsub();
    };
  }, []);

  // Listen for postMessage from the embedded website — on load each
  // page sends { type: 'noobclaw-embed-page', page: 'home'|'sbti'|'web3bti' }.
  // This keeps the React tab header in sync when the user navigates
  // INSIDE the iframe (e.g. clicking a card on the personality index
  // to jump into SBTI) instead of using the React tabs.
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const data = e.data;
      if (!data || typeof data !== 'object') return;
      if (data.type !== 'noobclaw-embed-page') return;
      const page = data.page;
      if (page === 'home' || page === 'sbti' || page === 'web3bti' || page === 'brawl') {
        setTab(page);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // Narrow the client's 8-language i18n to just 'zh' | 'en' for the
  // embedded website. The website only maintains two translations of the
  // personality pages — Chinese and English — so we map:
  //   zh, zh-TW  → zh
  //   everything else (en, ko, ja, ru, fr, de) → en
  // This way the website side can treat the lang param as a two-value
  // enum instead of guessing across the full BCP-47 space.
  // Recomputes whenever `langBump` changes (see subscribe effect above).
  const lang = useMemo<'zh' | 'en'>(() => {
    const raw: string = (i18nService as any).currentLanguage
      || (i18nService as any).getLanguage?.()
      || 'zh';
    return raw === 'zh' || raw === 'zh-TW' ? 'zh' : 'en';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [langBump]);

  // iframe src intentionally does NOT include `lang` in the dependency
  // list — language switching is handled via postMessage (see effect
  // below) so we avoid tearing down the iframe on every lang toggle.
  // The initial `?lang=` query is still what the page boots with on
  // first mount / tab switch / reload, so the website bootstrap script
  // gets a sane default before the postMessage arrives.
  const src = useMemo(() => {
    const path =
      tab === 'sbti' ? '/sbti/' : tab === 'web3bti' ? '/web3bti/' : '/personality/';
    return `${BASE_URL}${path}?embed=1&lang=${lang}&v=${reloadKey}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, reloadKey]);

  // Push language changes into the currently-loaded iframe via
  // postMessage. The website pages listen for
  // { type: 'noobclaw-embed-setlang', lang } and re-run applyLang()
  // without reloading, so the switch is instant and immune to
  // bfcache / CDN cache behaviour.
  useEffect(() => {
    const w = iframeRef.current?.contentWindow;
    if (!w) return;
    try {
      w.postMessage({ type: 'noobclaw-embed-setlang', lang }, '*');
    } catch {
      /* cross-origin postMessage never throws for same-origin check, but guard */
    }
  }, [lang]);

  const tabButtonClass = (active: boolean) =>
    `px-3 py-1.5 text-sm rounded-lg transition-colors ${
      active
        ? 'bg-claude-accent/15 text-claude-accent'
        : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
    }`;

  const handleReload = () => setReloadKey(k => k + 1);
  const handleOpenExternal = () => {
    const url = src.split('?')[0]; // 去掉 embed=1
    window.electron?.shell?.openExternal?.(url);
  };

  // Reset load state whenever the iframe source changes (tab switch,
  // reload click, or language change triggers a new src).
  useEffect(() => {
    setIframeState('loading');
    const timer = window.setTimeout(() => {
      // If onLoad never fires within 8s the cross-origin iframe is likely
      // wedged — on macOS WKWebView this has been observed when ATS or a
      // sandboxing plugin blocks the third-party HTTPS load. Surface the
      // fallback so the user isn't left staring at a black box.
      setIframeState(prev => (prev === 'loading' ? 'stuck' : prev));
    }, 8000);
    return () => window.clearTimeout(timer);
  }, [src]);

  const handleIframeLoad = (e: React.SyntheticEvent<HTMLIFrameElement>) => {
    setIframeState('loaded');
    // Belt-and-suspenders: as soon as the embed finishes loading, push
    // the current lang in via postMessage. The website's bootstrap
    // already reads ?lang= from the URL, but if an intermediate cache
    // / bfcache layer ever serves a stale HTML whose sessionStorage
    // still has the previous value, this forces an immediate re-apply
    // on the correct language without waiting for another reload.
    try {
      const w = (e.currentTarget as HTMLIFrameElement).contentWindow;
      w?.postMessage({ type: 'noobclaw-embed-setlang', lang }, '*');
    } catch { /* ignore cross-origin edge cases */ }
  };

  return (
    <div className="flex flex-col h-full dark:bg-claude-darkBg bg-claude-bg">
      {/* Header */}
      <div className="draggable flex h-12 items-center justify-between px-4 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
        <div className="flex items-center space-x-3 h-8 min-w-0">
          {isSidebarCollapsed && (
            <div className={`non-draggable flex items-center gap-1 ${isMac ? 'pl-[68px]' : ''}`}>
              <button
                type="button"
                onClick={onToggleSidebar}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
                aria-label="toggle sidebar"
              >
                <SidebarToggleIcon className="h-4 w-4" isCollapsed={true} />
              </button>
              <button
                type="button"
                onClick={onNewChat}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
                aria-label="new chat"
              >
                <ComposeIcon className="h-4 w-4" />
              </button>
              {updateBadge}
            </div>
          )}
          <h1 className="text-lg font-semibold dark:text-claude-darkText text-claude-text truncate">
            🧠 {i18nService.t('personalityTests')}
          </h1>
          <div className="non-draggable hidden sm:flex items-center gap-1 ml-2">
            <button type="button" onClick={() => setTab('home')} className={tabButtonClass(tab === 'home')}>
              {i18nService.t('personalityTabHome')}
            </button>
            <button type="button" onClick={() => setTab('sbti')} className={tabButtonClass(tab === 'sbti')}>
              SBTI
            </button>
            <button type="button" onClick={() => setTab('web3bti')} className={tabButtonClass(tab === 'web3bti')}>
              WEB3BTI
            </button>
            <button type="button" onClick={() => handleTabChange('brawl')} className={tabButtonClass(tab === 'brawl')}>
              OG BRAWL
            </button>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleReload}
            className="non-draggable h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
            title={i18nService.t('personalityReload')}
            aria-label="reload"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /></svg>
          </button>
          <button
            type="button"
            onClick={handleOpenExternal}
            className="non-draggable h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
            title={i18nService.t('personalityOpenExternal')}
            aria-label="open in browser"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></svg>
          </button>
          <WindowTitleBar inline />
        </div>
      </div>

      {/* Mobile-sized tabs row (visible on very narrow windows) */}
      <div className="non-draggable sm:hidden flex items-center gap-1 px-3 py-2 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
        <button type="button" onClick={() => setTab('home')} className={tabButtonClass(tab === 'home')}>
          {i18nService.t('personalityTabHome')}
        </button>
        <button type="button" onClick={() => setTab('sbti')} className={tabButtonClass(tab === 'sbti')}>
          SBTI
        </button>
        <button type="button" onClick={() => setTab('web3bti')} className={tabButtonClass(tab === 'web3bti')}>
          WEB3BTI
        </button>
        <button type="button" onClick={() => handleTabChange('brawl')} className={tabButtonClass(tab === 'brawl')}>
          OG BRAWL
        </button>
      </div>

      {/* Content: iframe loads the online page in embed mode */}
      <div className="flex-1 min-h-0 relative dark:bg-claude-darkBg bg-claude-bg">
        <iframe
          ref={iframeRef}
          key={src}
          src={src}
          title={i18nService.t('personalityTests')}
          className="w-full h-full border-0"
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-downloads"
          referrerPolicy="no-referrer"
          onLoad={handleIframeLoad}
        />
        {iframeState !== 'loaded' && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="pointer-events-auto flex flex-col items-center gap-3 dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {iframeState === 'loading' ? (
                <>
                  <div className="h-6 w-6 rounded-full border-2 border-claude-accent border-t-transparent animate-spin" />
                  <div className="text-xs">{i18nService.t('personalityLoading') || 'Loading…'}</div>
                </>
              ) : (
                <>
                  <div className="text-sm">
                    {i18nService.t('personalityLoadFailed') || 'Failed to load. Try reload or open in browser.'}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleReload}
                      className="px-3 py-1.5 text-xs rounded-lg bg-claude-accent/15 text-claude-accent hover:bg-claude-accent/25 transition-colors"
                    >
                      {i18nService.t('personalityReload') || 'Reload'}
                    </button>
                    <button
                      type="button"
                      onClick={handleOpenExternal}
                      className="px-3 py-1.5 text-xs rounded-lg bg-claude-surfaceHover dark:bg-claude-darkSurfaceHover hover:bg-claude-border dark:hover:bg-claude-darkBorder transition-colors"
                    >
                      {i18nService.t('personalityOpenExternal') || 'Open in browser'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default PersonalityView;
