import React, { useCallback, useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { getBackendApiUrl } from '../../services/endpoints';
import { HIDE_WEB3 } from '../../buildFlags';
import { noobClawApi } from '../../services/noobclawApi';
import { noobClawAuth } from '../../services/noobclawAuth';

interface Partner {
  id: string;
  name: string;
  logo_url: string;
  banner_url: string;
  description: string;
  link: string;
}

interface PartnersViewProps {
  isSidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onNewChat: () => void;
  updateBadge?: React.ReactNode;
  onShowInvite?: () => void;
  onShowXhs?: () => void;
  onShowPersonality?: () => void;
}

type Tab = 'activities' | 'partners';

const PartnersView: React.FC<PartnersViewProps> = ({
  isSidebarCollapsed: _isSidebarCollapsed,
  onToggleSidebar: _onToggleSidebar,
  onNewChat: _onNewChat,
  updateBadge: _updateBadge,
  onShowInvite,
  onShowXhs,
  onShowPersonality,
}) => {
  const [tab, setTab] = useState<Tab>('activities');
  const isZh = i18nService.currentLanguage === 'zh' || i18nService.currentLanguage === 'zh-TW';

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Tab bar */}
      <div className="flex items-center gap-1 px-6 pt-4 pb-2 border-b dark:border-claude-darkBorder border-claude-border">
        <TabButton active={tab === 'activities'} onClick={() => setTab('activities')}>
          🎉 {i18nService.t('pvTabActivities')}
        </TabButton>
        <TabButton active={tab === 'partners'} onClick={() => setTab('partners')}>
          🤝 {i18nService.t('pvTabPartners')}
        </TabButton>
      </div>
      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        {tab === 'activities' ? (
          <ActivitiesTab isZh={isZh} onShowInvite={onShowInvite} onShowXhs={onShowXhs} onShowPersonality={onShowPersonality} />
        ) : (
          <PartnersTab isZh={isZh} />
        )}
      </div>
    </div>
  );
};

// ── Tab button ────────────────────────────────────────────────────────

const TabButton: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({
  active,
  onClick,
  children,
}) => (
  <button
    type="button"
    onClick={onClick}
    className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
      active
        ? 'bg-claude-accent/10 text-claude-accent'
        : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
    }`}
  >
    {children}
  </button>
);

// ── Activities tab ────────────────────────────────────────────────────

const ActivitiesTab: React.FC<{
  isZh: boolean;
  onShowInvite?: () => void;
  onShowXhs?: () => void;
  onShowPersonality?: () => void;
}> = ({ isZh, onShowInvite, onShowXhs, onShowPersonality }) => {
  const [authState, setAuthState] = useState(noobClawAuth.getState());
  useEffect(() => noobClawAuth.subscribe(setAuthState), []);

  const [status, setStatus] = useState<{
    activities: Array<{ type: string; claimed: boolean; enabled?: boolean; last_reward: { noob: number; points: number } | null }>;
    pool: { noob_remaining: number; noob_cap: number; points_remaining: number; points_cap: number; exhausted: boolean };
  } | null>(null);
  const [popup, setPopup] = useState<{
    activity: string;
    reward: { noob: number; points: number };
    onAfter?: () => void;
  } | null>(null);

  const reload = useCallback(async () => {
    if (!authState.isAuthenticated) return;
    const s = await noobClawApi.getActivityStatus();
    setStatus(s);
  }, [authState.isAuthenticated]);

  useEffect(() => { reload(); }, [reload]);

  const isClaimed = (type: string) => status?.activities.find(a => a.type === type)?.claimed || false;
  const isEnabled = (type: string) => status?.activities.find(a => a.type === type)?.enabled !== false;
  const exhausted = status?.pool.exhausted || false;

  // 活动流程：点击 → 先领奖（后端 claim）→ 弹窗显示随机奖励 + "太棒了"按钮
  //   → 点"太棒了" 关闭弹窗并跳转到对应内容（仅对需要引导的活动）
  const claim = async (type: string, onAfter?: () => void) => {
    if (!authState.isAuthenticated) { noobClawAuth.requireLoginUI(); return; }
    const r = await noobClawApi.claimActivity(type);
    if (r.success) {
      setPopup({
        activity: type,
        reward: { noob: r.noob_reward || 0, points: r.points_reward || 0 },
        onAfter,
      });
      reload();
    } else if (r.already_claimed) {
      reload();
      // 已领过仍允许跳转（比如用户已经领过奖但想再去玩一次）
      onAfter?.();
    } else if (r.pool_exhausted) {
      reload();
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-4">
      {/* Card A: Daily Check-in */}
      <ActivityCard
        isZh={isZh}
        icon="📅"
        titleZh={i18nService.t('pvCheckinTitle')}
        titleEn={i18nService.t('pvCheckinTitle')}
        descZh={i18nService.t('pvCheckinDesc')}
        descEn={i18nService.t('pvCheckinDesc')}
        ctaZh={i18nService.t('pvCheckinCta')}
        ctaEn={i18nService.t('pvCheckinCta')}
        claimed={isClaimed('checkin')}
        enabled={isEnabled('checkin')}
        exhausted={exhausted}
        isAuthenticated={authState.isAuthenticated}
        onClaim={() => claim('checkin')}
      />

      {/* Card B: Run any automation task once. v2.4.31 — was previously
          locked to "小红书自动仿写爆款" but we now support 5 scenarios
          (XHS batch / XHS link rewrite / XHS auto engage / Twitter post
          creator / Twitter auto engage / Twitter link rewrite). The
          reward is unlocked by running ANY of them, not just XHS rewrite. */}
      <ActivityCard
        isZh={isZh}
        icon="✨"
        titleZh={i18nService.t('pvXhsTitle')}
        titleEn={i18nService.t('pvXhsTitle')}
        descZh={i18nService.t('pvXhsDesc')}
        descEn={i18nService.t('pvXhsDesc')}
        ctaZh={i18nService.t('pvXhsCta')}
        ctaEn={i18nService.t('pvXhsCta')}
        claimed={isClaimed('xhs_rewrite')}
        enabled={isEnabled('xhs_rewrite')}
        exhausted={exhausted}
        isAuthenticated={authState.isAuthenticated}
        onClaim={() => claim('xhs_rewrite', () => onShowXhs?.())}
      />

      {/* Card C: OG Brawl Game — 国内版隐藏(HIDE_WEB3) */}
      {!HIDE_WEB3 && (
      <ActivityCard
        isZh={isZh}
        icon="⚔️"
        titleZh={i18nService.t('pvBrawlTitle')}
        titleEn={i18nService.t('pvBrawlTitle')}
        descZh={i18nService.t('pvBrawlDesc')}
        descEn={i18nService.t('pvBrawlDesc')}
        ctaZh={i18nService.t('pvBrawlCta')}
        ctaEn={i18nService.t('pvBrawlCta')}
        claimed={isClaimed('og_brawl')}
        enabled={isEnabled('og_brawl')}
        exhausted={exhausted}
        isAuthenticated={authState.isAuthenticated}
        onClaim={() => claim('og_brawl', () => {
          // 用 window.electron.shell.openExternal（和 Partners 卡点击跳转的
          // API 一致）。之前这里写的 (window as any).api.openExternal 根本
          // 不存在，点完"太棒了"就啥也不发生。
          try { window.electron?.shell?.openExternal?.('https://noobclaw.com/cn/brawl'); } catch {}
        })}
      />
      )}

      {/* Card D: Personality Test — 国内版隐藏(HIDE_WEB3) */}
      {!HIDE_WEB3 && (
      <ActivityCard
        isZh={isZh}
        icon="🧠"
        titleZh={i18nService.t('pvPersonaTitle')}
        titleEn={i18nService.t('pvPersonaTitle')}
        descZh={i18nService.t('pvPersonaDesc')}
        descEn={i18nService.t('pvPersonaDesc')}
        ctaZh={i18nService.t('pvPersonaCta')}
        ctaEn={i18nService.t('pvPersonaCta')}
        claimed={isClaimed('personality_test')}
        enabled={isEnabled('personality_test')}
        exhausted={exhausted}
        isAuthenticated={authState.isAuthenticated}
        onClaim={() => claim('personality_test', () => onShowPersonality?.())}
      />
      )}

      {/* Card E: Invite Friends */}
      <div className="rounded-2xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface p-6">
        <div className="flex items-center gap-3 mb-3">
          <span className="text-3xl">🎁</span>
          <div>
            <h3 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
              {i18nService.t('pvInviteTitle')}
            </h3>
            <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {isZh
                ? i18nService.t('pvInviteDesc')
                : i18nService.t('pvInviteDesc')}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onShowInvite?.()}
          className="w-full py-3 rounded-xl text-sm font-semibold bg-amber-500 text-white hover:bg-amber-600 transition-colors"
        >
          {i18nService.t('pvInviteCta')}
        </button>
      </div>

      {popup && (
        <RewardPopup
          activity={popup.activity}
          reward={popup.reward}
          onClose={() => {
            // "太棒了"点击：先关弹窗，再触发跳转（如果有）
            const after = popup.onAfter;
            setPopup(null);
            after?.();
          }}
        />
      )}
    </div>
  );
};

// ── Generic Activity Card ─────────────────────────────────────────────

interface ActivityCardProps {
  isZh: boolean;
  icon: string;
  titleZh: string;
  titleEn: string;
  descZh: string;
  descEn: string;
  ctaZh: string;
  ctaEn: string;
  claimed: boolean;
  enabled?: boolean;
  exhausted: boolean;
  isAuthenticated: boolean;
  onClaim: () => void | Promise<void>;
}

const formatNum = (n: number) => n >= 10000 ? `${(n / 10000).toFixed(1)}万` : n.toLocaleString();

const ActivityCard: React.FC<ActivityCardProps> = ({
  isZh, icon, titleZh, titleEn, descZh, descEn, ctaZh, ctaEn,
  claimed, enabled = true, exhausted, isAuthenticated, onClaim,
}) => {
  const [submitting, setSubmitting] = useState(false);
  const handleClick = async () => {
    if (submitting) return;
    setSubmitting(true);
    try { await onClaim(); } finally { setSubmitting(false); }
  };

  return (
    <div className={`rounded-2xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface p-6 ${!enabled ? 'opacity-60' : ''}`}>
      <div className="flex items-center gap-3 mb-4">
        <span className="text-3xl">{icon}</span>
        <div>
          <h3 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
            {isZh ? titleZh : titleEn}
          </h3>
          <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {isZh ? descZh : descEn}
          </p>
        </div>
      </div>

      {!enabled ? (
        <div className="text-center py-3">
          <button disabled className="w-full py-3 rounded-xl text-sm font-semibold bg-gray-300 dark:bg-gray-700 text-gray-500 dark:text-gray-400 cursor-not-allowed">
            🚧 {i18nService.t('pvActivityPaused')}
          </button>
        </div>
      ) : claimed ? (
        <div className="text-center py-3">
          <button disabled className="w-full py-3 rounded-xl text-sm font-semibold bg-gray-300 dark:bg-gray-700 text-gray-500 dark:text-gray-400 cursor-not-allowed">
            ✓ {i18nService.t('pvCompletedToday')}
          </button>
        </div>
      ) : exhausted ? (
        <div className="text-center py-3">
          <div className="text-2xl mb-1">😢</div>
          <div className="text-sm font-medium dark:text-amber-400 text-amber-600">
            {i18nService.t('pvPoolEmpty')}
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={handleClick}
          disabled={submitting || !isAuthenticated}
          className="w-full py-3 rounded-xl text-sm font-semibold bg-green-500 text-white hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {submitting ? (
            <span className="flex items-center justify-center gap-2">
              <span className="h-4 w-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
              {i18nService.t('pvProcessing')}
            </span>
          ) : !isAuthenticated ? (
            i18nService.t('pvPleaseLogin')
          ) : (
            isZh ? ctaZh : ctaEn
          )}
        </button>
      )}
    </div>
  );
};

// ── Cool Reward Popup ─────────────────────────────────────────────────

// ⚠️ 函数【每次调用求值】i18n:原来写成模块级 const(且 _ZH/_EN 两份内容还完全一样),加载时按默认中文冻结,
//   切英文/小语种后弹层标题(签到成功 / 小红书任务完成 等)仍是中文(用户实测)。i18n.t 已按当前语言返回,无需再分 ZH/EN。
const activityLabels = (): Record<string, { title: string; emoji: string }> => ({
  checkin: { title: i18nService.t('pvPopupCheckin'), emoji: '📅' },
  xhs_rewrite: { title: i18nService.t('pvPopupXhs'), emoji: '📝' },
  og_brawl: { title: i18nService.t('pvPopupBrawl'), emoji: '⚔️' },
  personality_test: { title: i18nService.t('pvPopupPersona'), emoji: '🧠' },
});

const RewardPopup: React.FC<{
  activity: string;
  reward: { noob: number; points: number };
  onClose: () => void;
}> = ({ activity, reward, onClose }) => {
  const labels = activityLabels();
  const info = labels[activity] || { title: activity, emoji: '🎉' };
  // 只允许通过"太棒了"按钮关闭，遮罩点击和 × 按钮都去掉，
  // 这样才能保证"点关闭就跳转到对应内容"的流程始终触发。
  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="relative max-w-sm w-[92vw] rounded-3xl p-8 text-center shadow-2xl animate-[popIn_0.35s_cubic-bezier(.2,1.4,.4,1)] bg-gradient-to-br from-amber-400 via-pink-500 to-purple-600">
        <div className="text-7xl mb-2 drop-shadow-[0_4px_12px_rgba(0,0,0,0.3)]">{info.emoji}</div>
        <div className="text-2xl font-bold text-white mb-1 drop-shadow">{info.title}</div>
        <div className="text-sm text-white/80 mb-5">{i18nService.t('pvPopupSubtitle')}</div>
        <div className="space-y-2 mb-6">
          {/* $NoobCoin 奖励 — 国内版隐藏(HIDE_WEB3) */}
          {!HIDE_WEB3 && reward.noob > 0 && (
            <div className="rounded-xl bg-white/20 backdrop-blur px-4 py-3 text-white text-left flex items-center justify-between">
              <span className="text-sm">💰 $NoobCoin</span>
              <span className="text-xl font-bold">+{reward.noob}</span>
            </div>
          )}
          {reward.points > 0 && (
            <div className="rounded-xl bg-white/20 backdrop-blur px-4 py-3 text-white text-left flex items-center justify-between">
              <span className="text-sm">⭐ {i18nService.t('pvCredits')}</span>
              <span className="text-xl font-bold">+{formatNum(reward.points)}</span>
            </div>
          )}
          {reward.noob === 0 && reward.points === 0 && (
            <div className="rounded-xl bg-white/20 backdrop-blur px-4 py-3 text-white text-sm">
              {i18nService.t('pvPopupPoolEmpty')}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="w-full py-3 rounded-xl text-sm font-semibold bg-white text-gray-900 hover:bg-white/90 transition-colors"
        >
          {i18nService.t('pvAwesome')}
        </button>
      </div>
      <style>{`
        @keyframes popIn {
          0% { transform: scale(0.6); opacity: 0; }
          60% { transform: scale(1.08); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }
      `}</style>
    </div>
  );
};


// ── Partners tab ──────────────────────────────────────────────────────

const PartnersTab: React.FC<{ isZh: boolean }> = () => {
  const [partners, setPartners] = useState<Partner[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const baseUrl = getBackendApiUrl();
    fetch(`${baseUrl}/api/partners`)
      .then(r => r.json())
      .then(data => { setPartners(data.partners || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center py-12">
        <span className="h-5 w-5 rounded-full border-2 border-claude-accent border-t-transparent animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-6">
      <h2 className="text-xl font-bold dark:text-claude-darkText text-claude-text mb-6">
        {i18nService.t('pvPartnersHeading')}
      </h2>
      {partners.length === 0 ? (
        <div className="text-sm dark:text-claude-darkTextSecondary text-center py-12">
          {i18nService.t('pvNoPartners')}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {partners.map(p => (
            <div
              key={p.id}
              className="group relative rounded-xl overflow-hidden shadow-sm hover:shadow-lg transition-all cursor-pointer"
              onClick={() => p.link && window.electron?.shell?.openExternal(p.link)}
            >
              <div className="relative w-full" style={{ paddingBottom: '56.25%' }}>
                {p.banner_url ? (
                  <img src={p.banner_url} alt={p.name} className="absolute inset-0 w-full h-full object-cover" />
                ) : (
                  <div className="absolute inset-0 bg-gradient-to-br from-gray-700 to-gray-900" />
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
                <div className="absolute bottom-0 left-0 right-0 p-4">
                  <div className="flex items-center gap-2.5 mb-1.5">
                    {p.logo_url && (
                      <img src={p.logo_url} alt={p.name} className="w-8 h-8 rounded-full object-cover border border-white/20" />
                    )}
                    <h3 className="font-semibold text-white text-sm">{p.name}</h3>
                  </div>
                  {p.description && (
                    <p className="text-xs text-white/70 line-clamp-2">{p.description}</p>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default PartnersView;
