/**
 * 简洁版「创建任务」弹窗(2026-10-28):
 *   ① 下拉选平台  ② 下拉选这个平台的任务  → 「下一步」直接打开该任务原有的设置向导(账号也在向导里选)。
 *   这个平台已经有同类任务 → 不让重复建,提示「已经有了」+「去查看」。
 * 只是入口换了样子,打开的仍是专业版同一个向导,任务功能不变。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';
import SimpleSelect from '../common/SimpleSelect';

const L = (zh: string, tw: string, en: string): string => {
  const lang = i18nService.currentLanguage;
  return lang === 'zh' ? zh : lang === 'zh-TW' ? tw : en;
};

export interface SimpleTaskType { key: string; label: string; dupType?: string }
export interface SimpleCreatePlatform { id: string; label: string; icon: string }

interface Props {
  platforms: SimpleCreatePlatform[];
  typesFor: (platform: string) => SimpleTaskType[];
  initialPlatform?: string;
  onNext: (platform: string, typeKey: string) => void;
  onViewExisting: (platform: string) => void;
  onCancel: () => void;
}

const SimpleCreateModal: React.FC<Props> = ({ platforms, typesFor, initialPlatform, onNext, onViewExisting, onCancel }) => {
  const [existing, setExisting] = useState<Array<{ platform: string; type: string }> | null>(null);
  const [platform, setPlatform] = useState<string>(() => (initialPlatform && platforms.some((p) => p.id === initialPlatform) ? initialPlatform : (platforms[0]?.id || '')));
  const types = useMemo(() => typesFor(platform), [platform, typesFor]);
  const [typeKey, setTypeKey] = useState<string>(() => typesFor(platform)[0]?.key || '');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await (window as any).electron?.matrix?.listTasks?.();
        if (alive) setExisting(r?.ok && Array.isArray(r.tasks) ? r.tasks.map((t: any) => ({ platform: String(t?.platform || ''), type: String(t?.type || '') })) : []);
      } catch { if (alive) setExisting([]); }
    })();
    return () => { alive = false; };
  }, []);
  // 平台列表异步变化(合规隐藏晚到)→ 选中的平台不在了就换第一个
  useEffect(() => { if (platform && !platforms.some((p) => p.id === platform)) setPlatform(platforms[0]?.id || ''); }, [platforms, platform]);
  // 换平台 → 任务类型若不属于新平台,换成新平台的第一个
  useEffect(() => { if (!types.some((t) => t.key === typeKey)) setTypeKey(types[0]?.key || ''); }, [types, typeKey]);

  const cur = types.find((t) => t.key === typeKey);
  const dup = !!(cur?.dupType && existing && existing.some((e) => e.platform === platform && e.type === cur.dupType));
  const plat = platforms.find((p) => p.id === platform);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={onCancel}>
      <div className="w-full max-w-md rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-800">
          <div className="text-base font-semibold dark:text-white">✨ {L('创建任务', '建立任務', 'Create a task')}</div>
          <button type="button" onClick={onCancel} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200" aria-label={L('关闭', '關閉', 'Close')}>✕</button>
        </div>
        <div className="px-5 py-5 space-y-4">
          <div>
            <label className="block text-sm font-medium dark:text-gray-200 mb-1.5">{L('平台', '平台', 'Platform')}</label>
            <SimpleSelect value={platform} onChange={setPlatform} ariaLabel={L('平台', '平台', 'Platform')}
              options={platforms.map((p) => ({ value: p.id, label: `${p.icon} ${p.label}` }))} />
          </div>
          <div>
            <label className="block text-sm font-medium dark:text-gray-200 mb-1.5">{L('任务', '任務', 'Task')}</label>
            <SimpleSelect value={typeKey} onChange={setTypeKey} ariaLabel={L('任务', '任務', 'Task')} disabled={!types.length}
              options={types.length ? types.map((t) => ({ value: t.key, label: t.label })) : [{ value: '', label: L('这个平台暂时没有可建的任务', '這個平台暫時沒有可建的任務', 'No tasks for this platform yet') }]} />
          </div>
          {dup && (
            <div className="rounded-lg border px-3 py-2.5 text-xs leading-relaxed border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300 flex items-center gap-2">
              <span className="flex-1">⚠️ {L(`${plat?.label || ''}已经有「${cur?.label || ''}」任务了,不用再建,去看看或修改它就行`, `${plat?.label || ''}已經有「${cur?.label || ''}」任務了,不用再建,去看看或修改它就行`, `${plat?.label || ''} already has a "${cur?.label || ''}" task — open it instead`)}</span>
              <button type="button" onClick={() => onViewExisting(platform)} className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-500 text-white hover:bg-amber-600">{L('去查看', '去查看', 'View')}</button>
            </div>
          )}
        </div>
        <div className="px-5 py-4 border-t border-gray-200 dark:border-gray-800 flex items-center justify-end gap-2">
          <button type="button" onClick={onCancel} className="px-4 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800">{L('取消', '取消', 'Cancel')}</button>
          <button type="button" disabled={!cur || dup || existing === null} onClick={() => cur && onNext(platform, cur.key)}
            className="px-5 py-2 rounded-lg text-sm font-semibold bg-claude-accent hover:bg-claude-accentHover text-[#04130B] disabled:opacity-40 disabled:cursor-not-allowed">
            {existing === null ? L('读取中…', '讀取中…', 'Loading…') : L('下一步:设置任务', '下一步:設置任務', 'Next: set up')} →
          </button>
        </div>
      </div>
    </div>
  );
};

export default SimpleCreateModal;
