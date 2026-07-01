import React, { useEffect, useState } from 'react';
import { noobClawApi } from '../../services/noobclawApi';
import { i18nService } from '../../services/i18n';
import { USD_CNY_RATE } from '../../buildFlags';

interface Item { wallet: string; amount: number; }

// Mask the middle of a 0x... wallet so the chip looks like a real partial
// reveal ("0xdf21****a93f"). Pattern matches what we use elsewhere in
// InviteView so users see one consistent shorthand across the page.
function maskWallet(addr: string): string {
  if (!addr || addr.length < 10) return addr || '';
  return `${addr.slice(0, 6)}****${addr.slice(-4)}`;
}

// ─── Stale-while-revalidate cache for the ticker ───
// v1.x: 用户反馈"为啥要等一会才会出现",根因是首次进页面要等 API 来才有
// items。ticker 是全局社会证明(对所有用户内容一致,后端用 day-seeded
// 假名 + 当日真实 rebate_sends 填到 50 行),所以可以走 localStorage 缓
// 存,进页面瞬间从缓存渲染,背景再 fetch 刷新。
//   - cache key 全局共享(不分钱包),50 行内容对每个用户一样
//   - TTL 1 小时:后端 ticker 每 10 分钟级别才有新东西爬上来,1h 内的缓
//     存绝对够用,过期了组件也会被 setInterval 那条 10min 路径覆盖。
const TICKER_CACHE_KEY = 'noobclaw_invite_ticker_v1';
const TICKER_CACHE_TTL_MS = 60 * 60 * 1000;
function readCachedTicker(): Item[] | null {
  try {
    const raw = localStorage.getItem(TICKER_CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!Array.isArray(obj?.items) || typeof obj?.ts !== 'number') return null;
    if (Date.now() - obj.ts > TICKER_CACHE_TTL_MS) return null;
    return obj.items as Item[];
  } catch { return null; }
}
function writeCachedTicker(items: Item[]) {
  try {
    localStorage.setItem(TICKER_CACHE_KEY, JSON.stringify({ items, ts: Date.now() }));
  } catch { /* quota / disabled — degrade silently */ }
}

/**
 * Scrolling marquee of "wallet earned X USDT today" lines for the Rebate tab.
 * Pulls from /api/user/referral/ticker, which mixes real rebate_sends (today)
 * with deterministic day-seeded fakes so we always have 50 lines to display.
 *
 * We deliberately do NOT show a real-vs-fake flag — the whole point is social
 * proof and it can't read as fake. See backend services/referral.ts header
 * comment for the consistency strategy (same fakes for all users on a day).
 *
 * Animation is the same `translateX(0) → translateX(-50%)` trick TickerMarquee
 * uses: we render the list twice in a row, then translate the wrapper -50%
 * over N seconds for a seamless loop. Pause on hover so users can read a
 * specific line that catches their eye.
 */
const InviteTicker: React.FC = () => {
  // Lazy-init from localStorage cache so the marquee renders on first paint
  // (no API round-trip wait). Background fetch in the effect below overrides
  // with fresh data + re-writes cache.
  const [items, setItems] = useState<Item[]>(() => readCachedTicker() || []);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      noobClawApi.getReferralTicker().then(data => {
        if (cancelled) return;
        const fresh = data.items || [];
        if (fresh.length > 0) {
          setItems(fresh);
          writeCachedTicker(fresh);
        }
      }).catch(() => {});
    };
    refresh();
    // Refresh every 10 minutes so a late real payout climbs in within a
    // reasonable window without hammering the API.
    const t = setInterval(refresh, 10 * 60 * 1000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (items.length === 0) return null;

  const earnedLabel = i18nService.t('inviteTickerEarned');

  const renderLine = (it: Item, key: string) => (
    <span key={key} className="inline-flex items-center mx-4 text-xs whitespace-nowrap">
      <span className="text-yellow-500 mr-1.5">💰</span>
      <span className="font-mono dark:text-claude-darkText text-claude-text">{maskWallet(it.wallet)}</span>
      <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary mx-1.5">{earnedLabel}</span>
      <span className="font-bold text-primary">¥{(it.amount * USD_CNY_RATE).toFixed(2)}</span>
    </span>
  );

  // Tune scroll speed by item count so 50 lines don't blur past at the same
  // wall-clock rate as 10 lines. 1.2s per line feels brisk-but-readable.
  const durationSec = Math.max(30, Math.round(items.length * 1.2));

  return (
    <div className="invite-ticker-wrapper w-full overflow-hidden rounded-lg dark:bg-claude-darkSurfaceInset bg-gray-50 border dark:border-claude-darkBorder border-claude-border py-1.5">
      <div
        className="invite-ticker-scroll whitespace-nowrap flex items-center"
        style={{ animation: `invite-ticker-scroll ${durationSec}s linear infinite` }}
      >
        {[0, 1].map(i => (
          <span key={i} className="inline-block">
            {items.map((it, idx) => renderLine(it, `${i}-${idx}`))}
          </span>
        ))}
      </div>
      <style>{`
        @keyframes invite-ticker-scroll {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        .invite-ticker-wrapper:hover .invite-ticker-scroll {
          animation-play-state: paused;
        }
      `}</style>
    </div>
  );
};

export default InviteTicker;
