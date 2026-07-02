/**
 * 会员到期续费提醒弹窗(强提醒)。
 *
 * 触发:订阅已过期(subExpireAt 已过)且名下确有【因超出当前档位上限而被暂停】的矩阵号
 *   (任一平台号数 > 生效上限)。只有真出现「号被暂停」的实质影响才弹,避免给从没买过会员、
 *   只是注册赠送积分到期的免费用户误打扰。
 *
 * 频率:每小时复查一次 + authState 变化时复查;同一到期时间戳【只弹一次】(localStorage 去重)。
 * 轻提醒(到期前 3 天的角标)在 WalletBadge 里;这里是到期当下的强提醒。
 */

import React, { useEffect, useState } from 'react';
import { noobClawAuth } from '../../services/noobclawAuth';
import { openWallet } from '../../services/walletNav';
import { i18nService } from '../../services/i18n';
import { MATRIX_EDITION } from '../../matrixEdition';

export const MembershipExpiryModal: React.FC = () => {
  const [info, setInfo] = useState<{ suspendedCount: number } | null>(null);

  useEffect(() => {
    if (!MATRIX_EDITION) return;
    let cancelled = false;
    const check = async () => {
      const s = noobClawAuth.getState();
      if (!s.isAuthenticated || !s.walletAddress) return;
      // 以【整周期到期日】判过期(subStatus 有值=买过会员;subPeriodEnd 已过=会员到期)。
      //   比旧的 subExpireAt(每月桶,到期 cron 会清成 null)更可靠,cron 跑没跑都能判。
      const pe = s.subPeriodEnd ? new Date(s.subPeriodEnd).getTime() : 0;
      if (!s.subStatus || !pe || pe > Date.now()) return;     // 没买过 / 还没到期 → 不弹
      const limit = s.maxAccountsPerPlatform;
      if (!(limit > 0) || limit === 9999) return;             // 上限未知(老后端)→ 不弹
      const key = `subExpiredModal:${s.walletAddress}:${pe}`;
      if (localStorage.getItem(key)) return;                  // 同一到期只弹一次
      try {
        const r = await (window as any).electron?.matrix?.listAccounts();
        if (!r?.ok || cancelled) return;
        const byPlat: Record<string, number> = {};
        for (const a of (r.accounts || [])) byPlat[a.platform] = (byPlat[a.platform] || 0) + 1;
        let suspended = 0;
        for (const c of Object.values(byPlat)) if (c > limit) suspended += c - limit;
        if (suspended <= 0 || cancelled) return;              // 没有号真被暂停 → 不打扰
        localStorage.setItem(key, '1');
        setInfo({ suspendedCount: suspended });
      } catch { /* 拉不到账号不弹 */ }
    };
    check();
    const unsub = noobClawAuth.subscribe(() => { check(); });
    const iv = setInterval(check, 3_600_000);                 // 每小时复查
    return () => { cancelled = true; unsub(); clearInterval(iv); };
  }, []);

  if (!info) return null;

  const close = () => setInfo(null);
  const renew = () => { close(); openWallet('subscription'); };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={close}>
      <div
        className="w-[min(92vw,420px)] rounded-2xl p-6 dark:bg-claude-darkSurface bg-white border dark:border-claude-darkBorder border-claude-border shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        style={{ boxShadow: '0 0 40px -8px rgba(245,158,11,0.5)' }}
      >
        <div className="text-3xl mb-3">👑</div>
        <h2 className="text-lg font-bold dark:text-claude-darkText text-claude-text mb-2">
          {i18nService.t('meTitle')}
        </h2>
        <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary leading-relaxed mb-5">
          <>{i18nService.t('meBodyBefore')}<span className="font-bold text-amber-500">{info.suspendedCount}</span>{i18nService.t('meBodyMid')}<span className="font-semibold dark:text-claude-darkText text-claude-text">{i18nService.t('meBodyEmph')}</span>{i18nService.t('meBodyAfter')}</>
        </p>
        <div className="flex gap-2">
          <button
            onClick={renew}
            className="flex-1 py-2.5 rounded-xl text-sm font-bold text-black"
            style={{ background: 'linear-gradient(135deg,#fbbf24,#f59e0b)', boxShadow: '0 2px 8px rgba(245,158,11,0.35)' }}
          >
            {i18nService.t('meRenew')}
          </button>
          <button
            onClick={close}
            className="px-5 py-2.5 rounded-xl text-sm font-semibold dark:bg-claude-darkBg bg-claude-surface dark:text-claude-darkTextSecondary text-claude-textSecondary border dark:border-claude-darkBorder border-claude-border"
          >
            {i18nService.t('meLater')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default MembershipExpiryModal;
