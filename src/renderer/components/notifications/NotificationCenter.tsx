// ─────────────────────────────────────────────────────────────────────────
// NotificationCenter.tsx — global notification UI (modal + banner + OS push)
//
// Mounted once in App.tsx so it shows regardless of which view the user is
// on. Polls /api/me/notifications/unread on:
//   - App launch (after auth ready)
//   - Window focus regained (user comes back to app)
//   - Every 60s while authenticated
//
// Three severity tiers (config-driven by backend, NOT recomputed here):
//   critical  → FULL-SCREEN modal queue. Per decision E (merged), if there
//               are 2+ critical unread, they're combined into ONE modal
//               showing aggregate total + "you have N payouts". User MUST
//               click "我知道了" to dismiss. Markreads all merged in bulk.
//   important → Bottom-right toast banner stack. 8s auto-fade but stays in
//               unread queue until user opens the InviteView USDT tab.
//               Also fires Tauri/Electron OS notification with sound.
//   normal    → Silent. Only contributes to a global red-dot badge state
//               (consumed elsewhere — InviteView icon decorator etc).
//
// Notification metadata.amount_usdt drives the body display; click "查看交易"
// CTA opens metadata.bscscan_url in external browser and marks cta_clicked_at.

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { noobClawAuth } from '../../services/noobclawAuth';
import { noobClawApi, type NotificationRow } from '../../services/noobclawApi';
import { i18nService } from '../../services/i18n';

const POLL_INTERVAL_MS = 60_000;

// Notification → OS-level push (Tauri/Electron). Silently no-ops if the
// runtime doesn't expose Notification API (e.g. headless tests).
function showOsNotification(title: string, body: string) {
  try {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'granted') {
      new Notification(title, { body, silent: false });
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then((p) => {
        if (p === 'granted') new Notification(title, { body, silent: false });
      });
    }
  } catch (_) {
    /* swallow — OS push is best-effort */
  }
}

export const NotificationCenter: React.FC = () => {
  const isZh = i18nService.currentLanguage === 'zh';
  const [authState, setAuthState] = useState(noobClawAuth.getState());
  const [unread, setUnread] = useState<NotificationRow[]>([]);
  const [criticalModalOpen, setCriticalModalOpen] = useState(false);
  // Track which `important` IDs we've already shown a banner for in this
  // session — banner re-render on poll shouldn't double-pop the OS toast.
  const seenImportantIdsRef = useRef<Set<string>>(new Set());
  // Right-now visible banners (subset of important unread).
  const [visibleBanners, setVisibleBanners] = useState<NotificationRow[]>([]);

  useEffect(() => {
    const unsub = noobClawAuth.subscribe(setAuthState);
    return unsub;
  }, []);

  const fetchUnread = useCallback(async () => {
    if (!noobClawAuth.getState().isAuthenticated) return;
    const resp = await noobClawApi.getUnreadNotifications();
    setUnread(resp.items || []);
  }, []);

  // Initial fetch + interval + window-focus refresh
  useEffect(() => {
    if (!authState.isAuthenticated) {
      setUnread([]);
      seenImportantIdsRef.current.clear();
      return;
    }
    void fetchUnread();
    const interval = setInterval(fetchUnread, POLL_INTERVAL_MS);
    const onFocus = () => void fetchUnread();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [authState.isAuthenticated, fetchUnread]);

  // Critical: open merged modal whenever there are unread critical items
  useEffect(() => {
    const criticals = unread.filter((n) => n.severity === 'critical');
    if (criticals.length > 0 && !criticalModalOpen) {
      setCriticalModalOpen(true);
    } else if (criticals.length === 0 && criticalModalOpen) {
      setCriticalModalOpen(false);
    }
  }, [unread, criticalModalOpen]);

  // Important: show banners for any not-yet-seen-in-session unread important
  useEffect(() => {
    const news = unread.filter(
      (n) => n.severity === 'important' && !seenImportantIdsRef.current.has(n.id),
    );
    if (news.length === 0) return;
    news.forEach((n) => {
      seenImportantIdsRef.current.add(n.id);
      // OS notification (system tray pop + sound)
      showOsNotification(isZh ? n.title_zh : n.title_en, isZh ? n.body_zh : n.body_en);
    });
    setVisibleBanners((prev) => [...prev, ...news]);
    // Auto-fade banners after 8s — only removes them from visibleBanners,
    // the underlying user_notifications row stays unread until user opens
    // InviteView USDT tab and the list endpoint marks-via-CTA.
    const timer = setTimeout(() => {
      setVisibleBanners((prev) => prev.filter((b) => !news.some((n) => n.id === b.id)));
    }, 8000);
    return () => clearTimeout(timer);
  }, [unread, isZh]);

  // ── Handlers ──

  const dismissCriticalModal = async () => {
    // Bulk mark-read all critical that the user just acknowledged.
    const criticals = unread.filter((n) => n.severity === 'critical');
    await Promise.all(criticals.map((n) => noobClawApi.markNotificationRead(n.id)));
    setCriticalModalOpen(false);
    setUnread((prev) => prev.filter((n) => n.severity !== 'critical'));
  };

  const handleBannerClose = async (id: string) => {
    await noobClawApi.markNotificationDismissed(id);
    setVisibleBanners((prev) => prev.filter((b) => b.id !== id));
    setUnread((prev) => prev.filter((n) => n.id !== id));
  };

  const handleBannerCta = async (n: NotificationRow) => {
    const url = n.metadata?.bscscan_url;
    if (url && window.electron?.shell?.openExternal) {
      window.electron.shell.openExternal(url);
    } else if (url) {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
    await noobClawApi.markNotificationCtaClicked(n.id);
    setVisibleBanners((prev) => prev.filter((b) => b.id !== n.id));
    setUnread((prev) => prev.filter((nn) => nn.id !== n.id));
  };

  // ── Render ──

  // Critical modal data (merged per decision E)
  const criticalUnread = unread.filter((n) => n.severity === 'critical');
  const criticalTotal = criticalUnread.reduce(
    (sum, n) => sum + parseFloat(n.metadata?.amount_usdt || '0'),
    0,
  );

  return (
    <>
      {/* ── Critical modal (merged, blocking) ── */}
      {criticalModalOpen && criticalUnread.length > 0 && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="relative w-[480px] max-w-[90vw] rounded-2xl bg-gradient-to-b dark:from-claude-darkSurface dark:to-claude-darkBg from-white to-claude-bg border-2 border-primary shadow-2xl p-8 text-center">
            <div className="text-6xl mb-3">🎉</div>
            <h2 className="text-xl font-bold dark:text-claude-darkText text-claude-text mb-4">
              {criticalUnread.length === 1
                ? i18nService.t('nc_congrats_single')
                : i18nService.t('nc_congrats_multi').replace('{n}', String(criticalUnread.length))}
            </h2>
            <div className="my-6 p-6 rounded-xl bg-primary/10 border-2 border-primary/30">
              <div className="text-4xl font-bold text-primary tabular-nums">
                + ${criticalTotal.toFixed(2)} USDT
              </div>
              {criticalUnread.length > 1 && (
                <div className="text-xs mt-2 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('nc_merged_count').replace('{n}', String(criticalUnread.length))}
                </div>
              )}
            </div>
            <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary mb-6">
              {i18nService.t('nc_confirmed_onchain')}
            </p>
            {/* CTA: open the most recent tx in bscscan */}
            {criticalUnread[0]?.metadata?.bscscan_url && (
              <button
                onClick={() => {
                  const url = criticalUnread[0].metadata!.bscscan_url!;
                  if (window.electron?.shell?.openExternal) window.electron.shell.openExternal(url);
                  else window.open(url, '_blank', 'noopener,noreferrer');
                  void noobClawApi.markNotificationCtaClicked(criticalUnread[0].id);
                }}
                className="text-xs text-primary hover:underline mb-4 block w-full"
              >
                {i18nService.t('nc_view_bscscan')}
              </button>
            )}
            <button
              onClick={dismissCriticalModal}
              className="w-full py-3 px-6 bg-primary hover:bg-primary-hover text-black rounded-lg font-medium transition-all"
            >
              {i18nService.t('nc_i_know')}
            </button>
          </div>
        </div>
      )}

      {/* ── Important banners (bottom-right stack) ── */}
      {visibleBanners.length > 0 && (
        <div className="fixed bottom-4 right-4 z-[9990] flex flex-col gap-2 max-w-[360px]">
          {visibleBanners.map((n) => (
            <div
              key={n.id}
              className="rounded-xl bg-gradient-to-r from-primary/20 to-primary/10 border-2 border-primary/40 shadow-lg p-4 backdrop-blur-md noobclaw-running-glow"
            >
              <div className="flex items-start gap-2">
                <div className="text-2xl">🎉</div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold dark:text-claude-darkText text-claude-text">
                    + ${parseFloat(n.metadata?.amount_usdt || '0').toFixed(2)} USDT{' '}
                    <span className="text-xs font-normal dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {i18nService.t('nc_arrived')}
                    </span>
                  </div>
                  <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-0.5 truncate">
                    {i18nService.t('nc_sent_wallet')}
                  </div>
                  <div className="flex items-center gap-3 mt-2">
                    <button
                      onClick={() => handleBannerCta(n)}
                      className="text-xs text-primary hover:underline font-medium"
                    >
                      {i18nService.t('nc_view_tx')}
                    </button>
                    <button
                      onClick={() => handleBannerClose(n.id)}
                      className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text"
                    >
                      {i18nService.t('nc_close')}
                    </button>
                  </div>
                </div>
                <button
                  onClick={() => handleBannerClose(n.id)}
                  className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text"
                  aria-label="dismiss"
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
};

export default NotificationCenter;
