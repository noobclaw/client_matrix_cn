// 「净利润分成」展示口径(2026-07-07 用户拍板,同日改为每档固定值)。
//
// ⚠️ 纯展示层换算 —— 实际计费/分佣逻辑完全不变:backend 仍按「充值金额的
// rate_pct%(10~40,非合伙人默认 10)」入池分 6 级,用户实际到手一分不多不少。
// 变的只是话术:对用户不再说「按充值金额返佣 X%」,改说「按平台净利润分成 Y%」。
//
// 映射(每档固定值,档内不随实际费率浮动 —— 实际 10 还是 15,青铜一律显示 75%):
//   非合伙人(默认池 10%)      → 50%
//   bronze   10~15  → 75%
//   gold     16~25  → 85%
//   platinum 26~35  → 90%
//   diamond  36~40  → 95%
export function profitSharePct(ratePct?: number | null): number {
  const r = Number(ratePct);
  if (!Number.isFinite(r) || r < 10) return 50;
  if (r <= 15) return 75;
  if (r <= 25) return 85;
  if (r <= 35) return 90;
  return 95;
}

/** 非合伙人的默认展示值。 */
export const DEFAULT_PROFIT_SHARE_PCT = 50;
