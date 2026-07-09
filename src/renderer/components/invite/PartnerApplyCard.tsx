// PartnerApplyCard — 邀请返佣页"非合伙人"普通邀请人的入口卡片。
//
// 跟 PartnerHero 是互斥关系:
//   profile.partner.is_partner === true  → 渲染 PartnerHero(尊贵金色 banner)
//   profile.partner.is_partner !== true  → 渲染本组件
//
// 内容刻意简单 — 一行展示当前返佣比例(系统默认 10%),一行 CTA 引导申请合伙人。
// 点击 CTA → 走 Electron/Tauri opener 打开外部浏览器到官网申请页(不在客户端内
// iframe / webview 跑表单,跟现有 InviteView 的"打开外部"链接行为一致)。
//
// i18n:走 i18nService 自动 fallback,只要在 zh/en 加 partnerApplyTitle /
// partnerApplyHint / partnerApplyCta 三个 key 即可。

import React from 'react';
import { i18nService } from '../../services/i18n';
import { getWebsiteUrl } from '../../services/endpoints';
import { DEFAULT_PROFIT_SHARE_PCT } from '../../services/profitShare';

interface PartnerApplyCardProps {
  /** v6.x: compact 模式 — InviteView 在 social-login 用户那边把这卡片缩成
   *  半宽放在右半边,字号/内边距/按钮长文案 全部缩。普通(full width)用法
   *  传 false 或不传 — 行为不变。 */
  compact?: boolean;
}

const PartnerApplyCard: React.FC<PartnerApplyCardProps> = ({ compact = false }) => {
  // 默认展示「净利润分成 50%」(profitShare.ts 的展示口径)。Backend 那边
  // system_config.rebate_pool_pct(充值额的 10%)才是真值,这里只是展示卡片
  // 不参与实际计算。
  const defaultRate = DEFAULT_PROFIT_SHARE_PCT;

  const handleApply = () => {
    // 走外部浏览器。URL 用 ?page=partner-apply 查询串而不是 #page-partner-apply
    // hash,也不是独立的 /partner-apply.html 文件,出于两个坑:
    //   ① Windows ShellExecute 把 URL 里的 # 片段 drop 掉(老的 #page-... 路径
    //      在桌面端打开会拿到首页)
    //   ② 任何独立 .html 文件一旦被浏览器 disk-cache 住,内容里如果有 bug
    //      没法热修(用户得手动强刷,而且每次客户端打开还白屏 — 走过这条坑了)
    // ?page=... 直接打在 index.html 主文件 URL 上,SPA bootstrap 里
    // handleHashRoute 读 location.search 派发到 navigateTo,没独立缓存路径。
    const url = `${getWebsiteUrl()}/?page=partner-apply`;
    try {
      window.electron?.shell?.openExternal?.(url);
    } catch {
      // ignore — shell.openExternal 失败基本是 macOS sandbox / Linux 缺 xdg-open,
      // 此时用户最多没动作,不会 crash。
    }
  };

  // v6.x: compact 模式参数化所有 size/padding/font 字段 — full 模式行为不变,
  //   compact 模式整体收缩 + 用短文案按钮("申请合伙人 →" vs "更高比例?申请合伙人 →")
  const padClass = compact ? 'p-3' : 'p-4';
  const titleClass = compact ? 'text-xs mb-0.5' : 'text-sm mb-1';
  const rateClass = compact ? 'text-xl' : 'text-2xl';
  const rateHintClass = compact ? 'text-[10px] ml-1' : 'text-xs ml-2';
  const btnClass = compact ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm';
  const ctaKey = compact ? 'partnerApplyCtaShort' : 'partnerApplyCta';
  return (
    <div
      className={`mb-3 ${padClass} rounded-xl border`}
      style={{
        background: 'linear-gradient(135deg, rgba(34,197,94,0.08) 0%, rgba(20,184,166,0.08) 100%)',
        borderColor: 'rgba(34,197,94,0.3)',
      }}
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="min-w-0">
          <div className={`${titleClass} font-medium dark:text-claude-darkText text-claude-text`}>
            {i18nService.t('partnerApplyTitle')}
          </div>
          <div className={`${rateClass} font-bold`} style={{ color: '#22c55e' }}>
            {defaultRate}%
            <span className={`${rateHintClass} font-normal dark:text-claude-darkTextSecondary text-claude-textSecondary`}>
              {i18nService.t('partnerApplyRateHint')}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={handleApply}
          className={`${btnClass} rounded-lg font-semibold whitespace-nowrap transition-opacity hover:opacity-90`}
          style={{
            background: 'linear-gradient(135deg, #22c55e 0%, #14b8a6 100%)',
            color: '#fff',
            boxShadow: '0 2px 8px rgba(34,197,94,0.25)',
          }}
        >
          {i18nService.t(ctaKey)}
        </button>
      </div>
    </div>
  );
};

export default PartnerApplyCard;
