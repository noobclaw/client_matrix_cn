// 「净利润分成」展示口径(2026-07-07 用户拍板)。
//
// ⚠️ 纯展示层换算 —— 实际计费/分佣逻辑完全不变:backend 仍按「充值金额的
// rate_pct%(10~40,非合伙人默认 10)」入池分 6 级,用户实际到手一分不多不少。
// 变的只是话术:对用户不再说「按充值金额返佣 X%」,改说「按平台净利润分成 Y%」。
//
// 映射(档内按实际费率线性插值,费率涨 → 展示也涨,封顶对封顶):
//   非合伙人(默认池 10%)      → 50%
//   bronze   10~15  → 60~70
//   gold     16~25  → 70~80
//   platinum 26~35  → 80~90
//   diamond  36~40  → 90~95
export function profitSharePct(ratePct?: number | null): number {
  const r = Number(ratePct);
  if (!Number.isFinite(r) || r < 10) return 50;
  if (r <= 15) return Math.round(60 + ((r - 10) / 5) * 10);
  if (r <= 25) return Math.round(70 + ((r - 16) / 9) * 10);
  if (r <= 35) return Math.round(80 + ((r - 26) / 9) * 10);
  return Math.round(90 + ((Math.min(r, 40) - 36) / 4) * 5);
}

/** 非合伙人的默认展示值(=profitSharePct(10) 之下的兜底档)。 */
export const DEFAULT_PROFIT_SHARE_PCT = 50;
