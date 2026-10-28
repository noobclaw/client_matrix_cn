/**
 * 规范下拉框(简洁版统一用这一个,2026-10-28)。样式照搬各向导里已有的下拉框:
 *   原生 <select> + appearance-none 去掉系统箭头 + 右侧自绘向下箭头(chevron),圆角描边、聚焦高亮。
 */
import React from 'react';

export interface SimpleSelectOption { value: string; label: string; disabled?: boolean }

const SimpleSelect: React.FC<{
  value: string;
  onChange: (v: string) => void;
  options: SimpleSelectOption[];
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;   // 外层宽度等(默认 w-full)
  size?: 'sm' | 'md';
}> = ({ value, onChange, options, ariaLabel, disabled, className = 'w-full', size = 'md' }) => (
  <div className={`relative ${className}`}>
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel}
      disabled={disabled}
      className={`simple-select w-full appearance-none rounded-lg border border-gray-300 dark:border-white/25 hover:border-green-500/60 dark:hover:border-green-400/60 bg-white dark:bg-gray-800 pl-3 pr-9 ${size === 'sm' ? 'py-1.5 text-xs' : 'py-2.5 text-sm'} dark:text-white focus:outline-none focus:ring-2 focus:ring-green-500/50 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed`}
    >
      {options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
    </select>
    <svg className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 dark:text-gray-300 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  </div>
);

export default SimpleSelect;
