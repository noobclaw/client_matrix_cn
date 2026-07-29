/**
 * MatrixLocalImagePicker — 发帖/图文向导共用的「本地图」选择块(选图按钮 + 文件列表 + 提示)。
 * 路径存绝对路径,runner 执行时读盘转 base64。i18n 复用图文向导的 wzImgLocal* 键(9 语已配)。
 */
import React from 'react';
import { i18nService } from '../../services/i18n';

// ⚠️ Tailwind JIT 扫不到模板拼出来的类名 → 每个主色一整串字面量。
const ACCENT_BTN: Record<string, string> = {
  emerald: 'bg-emerald-500 text-white hover:bg-emerald-600',
  sky: 'bg-sky-500 text-white hover:bg-sky-600',
  amber: 'bg-amber-500 text-white hover:bg-amber-600',
  fuchsia: 'bg-fuchsia-500 text-white hover:bg-fuchsia-600',
  rose: 'bg-rose-500 text-white hover:bg-rose-600',
  blue: 'bg-blue-500 text-white hover:bg-blue-600',
};

const MatrixLocalImagePicker: React.FC<{
  value: string[];
  onChange: (paths: string[]) => void;
  disabled?: boolean;
  max?: number;
  accent?: string; // tailwind 色名(emerald/sky/amber/fuchsia…),跟宿主向导主色一致
}> = ({ value, onChange, disabled, max = 6, accent = 'emerald' }) => {
  const pick = async () => {
    const remaining = max - value.length;
    if (remaining <= 0) return;
    try {
      // Tauri shim 挂在 electron.video.pickImages;Electron preload 挂顶层 —— 两个都试(真机 bug:只调顶层在矩阵版点了没反应)。
      const api: any = (window as any).electron;
      const paths = await (api?.video?.pickImages || api?.pickImages)?.(remaining);
      if (Array.isArray(paths) && paths.length) {
        onChange([...value, ...paths.filter((p: unknown) => typeof p === 'string')].slice(0, max));
      }
    } catch { /* 取消/未挂,忽略 */ }
  };
  return (
    <div className="mt-3 space-y-1.5">
      <button type="button" onClick={pick} disabled={disabled || value.length >= max}
        className={`w-full px-3 py-2 rounded-lg text-sm font-semibold disabled:opacity-50 transition-colors ${ACCENT_BTN[accent] || ACCENT_BTN.emerald}`}>
        ➕ {i18nService.t('wzImgLocalPick').replace('{n}', String(value.length)).replace('/6', `/${max}`)}
      </button>
      {value.length > 0 && (
        <div className="space-y-1 max-h-36 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700 p-2">
          {value.map((p, i) => (
            <div key={`${p}_${i}`} className="flex items-center gap-2 text-xs">
              <span className="shrink-0">🖼️</span>
              <span className="flex-1 truncate text-gray-600 dark:text-gray-300">{p.split(/[\\/]/).pop()}</span>
              <button type="button" onClick={() => onChange(value.filter((_, k) => k !== i))} className="shrink-0 text-gray-400 hover:text-red-500">✕</button>
            </div>
          ))}
        </div>
      )}
      <div className="text-[11px] text-gray-400">{i18nService.t('wzImgLocalHint')}</div>
    </div>
  );
};

export default MatrixLocalImagePicker;
