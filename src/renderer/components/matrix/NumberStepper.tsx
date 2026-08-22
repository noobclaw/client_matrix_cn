/**
 * 数量输入框(替代原来的 range 滑杆)。
 *
 * 为什么换掉滑杆:滑杆在 0-500 这种大区间里根本拖不准,而这些字段(每轮发几条、
 * 点赞上限、关注上限……)用户是有确切数字的。改成「− [输入框] +」后可以直接敲。
 *
 * 输入体验的两个坑(实现时已处理,改这里前先看懂):
 *  1. 直接 `parseInt(e.target.value)` 会让输入框【删不空】—— 删到空 → NaN → 立刻被
 *     夹回 min,光标后面还留着数字,没法重新输。所以维护一份 draft 字符串,聚焦期间
 *     照原样显示,失焦(或按回车)才夹取并回写。
 *  2. 打字中间态可能越界(比如 max=6 时先敲出 "12" 再删成 "2"),所以【只有落在
 *     [lo,hi] 区间内】才实时同步给父组件,越界的中间态留在 draft 里等失焦时夹。
 *  失焦时若为空 → 回退到当前值(不要变成 lo,那会把「0=关闭」的字段误关掉)。
 */
import React from 'react';

export function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

type Accent = 'cyan' | 'violet' | 'emerald' | 'sky' | 'rose' | 'amber' | 'orange' | 'pink' | 'blue' | 'green' | 'fuchsia';

// 各主题色的 hover 边框(Tailwind 需要完整类名才会被打进产物,不能拼接)。
const HOVER: Record<Accent, string> = {
  cyan: 'hover:border-cyan-500', violet: 'hover:border-violet-500', emerald: 'hover:border-emerald-500',
  sky: 'hover:border-sky-500', rose: 'hover:border-rose-500', amber: 'hover:border-amber-500',
  orange: 'hover:border-orange-500', pink: 'hover:border-pink-500', blue: 'hover:border-blue-500',
  green: 'hover:border-green-500', fuchsia: 'hover:border-fuchsia-500',
};

export interface NumBoxProps {
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  step?: number;               // +/- 按钮的步长,默认 1
  disabled?: boolean;
  accent?: Accent;
  className?: string;          // 输入框宽度等微调
  suffix?: string;             // 输入框右侧单位(条/篇/%…)
  // 「这个值定下来了」才触发(失焦 / 回车 / 点 +−),打字过程中不触发。
  //   跨字段联动(min<=max 那种)只能挂这里 —— 挂 onChange 会被打字中间态带偏,
  //   见 NumMinMax 上的注释。
  onCommit?: (n: number) => void;
}

/** 光秃秃的「− [输入框] +」,给栅格/成对(最少-最多)布局用。 */
export const NumBox: React.FC<NumBoxProps> = ({ value, onChange, min, max, step = 1, disabled, accent = 'cyan', className, suffix, onCommit }) => {
  const [draft, setDraft] = React.useState<string | null>(null);
  const shown = draft !== null ? draft : String(value);
  const btn = `w-7 h-7 shrink-0 rounded-lg border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 ${HOVER[accent]} disabled:opacity-40`;

  const typing = (raw: string) => {
    const cleaned = raw.replace(/[^0-9]/g, '');
    setDraft(cleaned);
    const n = parseInt(cleaned, 10);
    if (Number.isFinite(n) && n >= min && n <= max) onChange(n);
  };
  const commit = () => {
    if (draft === null) return;
    const n = parseInt(draft, 10);
    const v = Number.isFinite(n) ? clampInt(n, min, max) : value; // 空 → 保持原值
    onChange(v);
    setDraft(null);
    onCommit?.(v);
  };
  const bump = (delta: number) => {
    const v = clampInt(value + delta, min, max);
    onChange(v);
    onCommit?.(v);
  };

  return (
    <div className="flex items-center gap-2">
      <button type="button" disabled={disabled || value <= min} onClick={() => bump(-step)} className={btn}>−</button>
      <input
        type="text" inputMode="numeric" value={shown} disabled={disabled}
        onChange={(e) => typing(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); } }}
        className={`${className || 'w-16'} text-center text-sm py-1.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-transparent dark:text-white disabled:opacity-40`}
      />
      {suffix ? <span className="text-xs text-gray-400 shrink-0">{suffix}</span> : null}
      <button type="button" disabled={disabled || value >= max} onClick={() => bump(step)} className={btn}>+</button>
    </div>
  );
};

export interface NumRowProps extends NumBoxProps {
  label: React.ReactNode;
  hint?: React.ReactNode;
}

/** 一整行:左边标题 + 说明,右边数量输入框。向导里的单个数量字段都用它。 */
export const NumRow: React.FC<NumRowProps> = ({ label, hint, ...box }) => (
  <div className="flex items-center justify-between gap-3 py-2.5">
    <div className="min-w-0">
      <div className="text-sm font-medium dark:text-gray-200">{label}</div>
      {hint ? <div className="text-[11px] text-gray-400 leading-snug">{hint}</div> : null}
    </div>
    <div className="shrink-0"><NumBox {...box} /></div>
  </div>
);

export interface NumMinMaxProps {
  min: number; max: number;
  setMin: (n: number) => void; setMax: (n: number) => void;
  lo: number; hi: number;
  minLabel: string; maxLabel: string;
  disabled?: boolean;
  accent?: Accent;
  suffix?: string;
}

/**
 * 「最少 / 最多」成对输入。跨字段校验保证 min<=max(原来滑杆版本没做,能拖出 min>max 的非法区间)。
 *
 * ⚠️ 跨字段夹取只能挂 onCommit(失焦/回车/点 +−),【绝不能】挂 onChange。
 *   挂 onChange 会被打字的中间态带偏:min=50 / max=80,用户想把 max 改成 60 —— 敲下 "6"
 *   的那一刻 max 暂时是 6,`6 < 50` 成立就把 min 也改成了 6;再敲 "0" 变成 60,但 min 已经
 *   回不去了,用户毫无感知。滑杆做不出这个中间态,所以这是换成输入框后新出现的坑。
 */
export const NumMinMax: React.FC<NumMinMaxProps> = ({ min, max, setMin, setMax, lo, hi, minLabel, maxLabel, disabled, accent = 'sky', suffix }) => (
  <div className="grid grid-cols-2 gap-4">
    <div>
      <div className="text-[11px] text-gray-500 dark:text-gray-400 mb-1">{minLabel}</div>
      <NumBox value={min} onChange={setMin} onCommit={(n) => { if (n > max) setMax(n); }} min={lo} max={hi} disabled={disabled} accent={accent} suffix={suffix} />
    </div>
    <div>
      <div className="text-[11px] text-gray-500 dark:text-gray-400 mb-1">{maxLabel}</div>
      <NumBox value={max} onChange={setMax} onCommit={(n) => { if (n < min) setMin(n); }} min={lo} max={hi} disabled={disabled} accent={accent} suffix={suffix} />
    </div>
  </div>
);
