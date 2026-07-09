// PartnerHero — 尊贵版邀请页顶部 banner,只在 profile.partner.is_partner=true 时渲染。
//
// v2.x "炫酷" upgrade:
//   - 黑底 + tier 色渐变 + 旋转 conic gradient 光环边框
//   - 4s shimmer 光带 + 8 个 twinkle 金粉粒子
//   - emoji 上下浮动 + drop-shadow 发光
//   - 数字 background-clip:text 渐变金属字效
//   - 右上 ✦ VIP ✦ 角标
//
// Props 来源:GET /api/me/profile.partner block(step 6 后端已下发)。
// 普通用户拿到 profile.partner === null,父组件直接不渲染 PartnerHero。

import React from 'react';
import { i18nService } from '../../services/i18n';
import { useCountUp } from '../../hooks/useCountUp';
import { profitSharePct } from '../../services/profitShare';

interface PartnerInfo {
  is_partner: boolean;
  rate_pct: number;
  tier: string | null;
  l1_share_pct: number;
  default_pool_pct: number;
  granted_at: string | null;
}

interface PartnerHeroProps {
  partner: PartnerInfo;
}

interface TierTheme {
  emoji: string;
  label: string;
  color: string;
  bgGrad: string;
  shimmerColor: string;
}
// v2.x:tier 主色重新调过,Diamond / Platinum 和 Gold / Bronze 视觉差异显著拉开
//   Bronze    深暖铜(redder), 跟 Gold 区分
//   Gold      更纯的金黄,跟 Bronze 区分
//   Platinum  铂金白冷调,档位高于 Gold(v3.x 之前 key 叫 'silver')
//   Diamond   鲜艳蓝宝石青(saturated),跟 Platinum 区分(不是 pale ice)
// 档位顺序(rate range 见 partnerTier.ts): bronze < gold < platinum < diamond
const TIER_VISUAL: Record<string, TierTheme> = {
  bronze: {
    emoji: '🥉', label: 'Bronze', color: '#c46e2a',
    bgGrad: 'linear-gradient(135deg, #1f0e04 0%, #3a1d08 50%, #1f0e04 100%)',
    shimmerColor: 'rgba(196, 110, 42, 0.20)',
  },
  gold: {
    emoji: '👑', label: 'Gold', color: '#fbbf24',
    bgGrad: 'linear-gradient(135deg, #1f1306 0%, #3a2607 50%, #1f1306 100%)',
    shimmerColor: 'rgba(251, 191, 36, 0.20)',
  },
  platinum: {
    // v3.x: 旧 'silver' key 改名 'platinum',DB + 代码统一。
    //   色 = 铂金白 + 深钢蓝底 + alpha 0.30 shimmer,金属高光质感。
    emoji: '🏆', label: 'Platinum', color: '#dde4ef',
    bgGrad: 'linear-gradient(135deg, #0c1220 0%, #1e2840 50%, #0c1220 100%)',
    shimmerColor: 'rgba(221, 228, 239, 0.30)',
  },
  diamond: {
    emoji: '💎', label: 'Diamond', color: '#22d3ee',
    bgGrad: 'linear-gradient(135deg, #061a20 0%, #0b3340 50%, #061a20 100%)',
    shimmerColor: 'rgba(34, 211, 238, 0.24)',
  },
};
const DEFAULT_VISUAL: TierTheme = TIER_VISUAL.gold;

// 颜色 helper:基于主色做 lighter / darker,用于数字三色金属渐变。
function shiftColor(hex: string, delta: number): string {
  return (
    '#' +
    (hex.slice(1).match(/.{2}/g) || []).map((c) =>
      Math.max(0, Math.min(255, parseInt(c, 16) + delta)).toString(16).padStart(2, '0'),
    ).join('')
  );
}

// useCountUp 已抽到 ../../hooks/useCountUp,InviteView 4 张统计卡复用同一份。

// Sparkle particles — 8 个固定位置 + 错开 delay,各自 twinkle 节奏
const SPARK_POSITIONS = [
  { top: '18%', left: '8%',  delay: '0s'   },
  { top: '60%', left: '18%', delay: '1.1s' },
  { top: '28%', left: '34%', delay: '2.3s' },
  { top: '78%', left: '42%', delay: '0.6s' },
  { top: '22%', left: '62%', delay: '1.8s' },
  { top: '68%', left: '74%', delay: '2.7s' },
  { top: '38%', left: '88%', delay: '0.4s' },
  { top: '82%', left: '92%', delay: '1.5s' },
];

export const PartnerHero: React.FC<PartnerHeroProps> = ({ partner }) => {
  const visual = (partner.tier && TIER_VISUAL[partner.tier]) || DEFAULT_VISUAL;
  // 展示「净利润分成」口径(profitSharePct 映射),实际计费费率 rate_pct 不变。
  const animatedRate = useCountUp(profitSharePct(partner.rate_pct));
  const colorLight = shiftColor(visual.color, 60);
  const colorDark = shiftColor(visual.color, -60);

  return (
    <div
      className="relative overflow-hidden rounded-2xl mb-3 px-6 py-5 border"
      style={{
        background: visual.bgGrad,
        borderColor: visual.color + '60',
        boxShadow: `0 0 24px ${visual.color}25, inset 0 0 14px ${visual.color}10`,
      }}
    >
      {/* 旋转 conic gradient 光环边框 — 比静态描边更 premium */}
      <div
        className="absolute pointer-events-none"
        style={{
          inset: -2,
          borderRadius: 18,
          padding: 2,
          background: `conic-gradient(from 0deg, transparent 0%, ${visual.color} 20%, transparent 40%, transparent 60%, ${visual.color} 80%, transparent 100%)`,
          WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
          WebkitMaskComposite: 'xor',
          maskComposite: 'exclude',
          animation: 'partner-conic 6s linear infinite',
          opacity: 0.55,
        }}
      />

      {/* shimmer 光带 — 颜色跟 tier 走 */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: `linear-gradient(90deg, transparent 0%, ${visual.shimmerColor} 50%, transparent 100%)`,
          animation: 'partner-hero-shimmer 4s ease-in-out infinite',
        }}
      />

      {/* 金粉粒子 — 8 个 */}
      {SPARK_POSITIONS.map((p, i) => (
        <span
          key={i}
          className="absolute pointer-events-none"
          style={{
            top: p.top,
            left: p.left,
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: `radial-gradient(circle, ${visual.color} 0%, transparent 70%)`,
            animation: `partner-spark-twinkle 3s ease-in-out infinite`,
            animationDelay: p.delay,
          }}
        />
      ))}

      {/* 右上 VIP 角标 */}
      <div
        className="absolute font-bold"
        style={{
          top: 8,
          right: 14,
          fontSize: 9,
          letterSpacing: 2,
          padding: '2px 8px',
          borderRadius: 10,
          background: `linear-gradient(135deg, ${visual.color}, ${colorDark})`,
          color: '#0a0a0a',
          boxShadow: `0 0 8px ${visual.color}80`,
        }}
      >
        ✦ VIP ✦
      </div>

      <style>{`
        @keyframes partner-hero-shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        @keyframes partner-conic {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes partner-spark-twinkle {
          0%, 100% { opacity: 0; transform: scale(0.4); }
          50%      { opacity: 1; transform: scale(1.2); }
        }
        @keyframes partner-emoji-float {
          0%, 100% { transform: translateY(0) rotate(-2deg); }
          50%      { transform: translateY(-3px) rotate(2deg); }
        }
      `}</style>

      <div className="relative z-10 flex items-center gap-4 flex-wrap">
        {/* 等级勋章 + 浮动 */}
        <div className="flex items-center gap-3">
          <span
            style={{
              fontSize: 42,
              lineHeight: 1,
              display: 'inline-block',
              animation: 'partner-emoji-float 3.5s ease-in-out infinite',
              filter: `drop-shadow(0 0 8px ${visual.color}60)`,
            }}
          >
            {visual.emoji}
          </span>
          <div>
            <div
              className="text-[10px] font-semibold uppercase"
              style={{ color: visual.color, letterSpacing: 3 }}
            >
              {i18nService.t('partnerBannerTitle') || 'Partner'}
            </div>
            <div className="text-base font-bold text-white tracking-wider">
              {visual.label}
            </div>
          </div>
        </div>

        <div
          className="h-12 w-px"
          style={{ background: `linear-gradient(180deg, transparent, ${visual.color}80, transparent)` }}
        />

        {/* 返佣总比例 — 金属渐变文本填充 */}
        <div className="flex-1 min-w-0">
          <div
            className="text-[10px] uppercase font-semibold"
            style={{ color: visual.color + 'cc', letterSpacing: 2 }}
          >
            {i18nService.t('partnerRebateRate') || '您的返佣比例'}
          </div>
          <div className="flex items-baseline gap-2 flex-wrap">
            <span
              className="font-bold tabular-nums"
              style={{
                fontSize: 42,
                lineHeight: 1.05,
                letterSpacing: 1,
                background: `linear-gradient(135deg, ${colorLight} 0%, ${visual.color} 50%, ${colorDark} 100%)`,
                WebkitBackgroundClip: 'text',
                backgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                filter: `drop-shadow(0 0 8px ${visual.color}30)`,
              }}
            >
              {Math.round(animatedRate)}%
            </span>
            <span className="text-xs font-medium" style={{ color: visual.color + 'cc' }}>
              ({i18nService.t('partnerByDepositAmount') || '按充值金额'})
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PartnerHero;
