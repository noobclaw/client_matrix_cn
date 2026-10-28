/**
 * 指纹浏览器内核选择器(顶部横条用,2026-10-28)。逻辑与「我的矩阵账号」页头那份一致:
 *   列服务端可用版本,已装打勾可选中(落盘成所有任务用的版本),未装给下载按钮,下载进度走 matrix:kernel 事件。
 * 选中 / 下载完成后广播 'noobclaw:kernel-changed',账号页那份据此同步,两处显示一致。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';

const M = () => (window as any).electron?.matrix;
type Avail = { version: string; label: string; recommended: boolean; installed: boolean; sizeMb: number; note: string };
type KState = { installed?: boolean; installedVersions?: string[]; configuredVersion?: string; selectedVersion?: string; available?: Avail[] };

const KernelPicker: React.FC = () => {
  const [kernel, setKernel] = useState<KState>({});
  const [selectedVersion, setSelectedVersion] = useState('');
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [msg, setMsg] = useState('');
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    M()?.kernelLocalStatus?.().then((r: any) => {
      if (r && (r.installedVersions?.length || r.installed)) { setKernel((p) => ({ ...p, ...r })); setSelectedVersion((p) => p || r.selectedVersion || ''); }
    }).catch(() => {});
    M()?.kernelStatus?.().then((r: any) => {
      setKernel((p) => ({ ...p, ...(r || {}) }));
      setSelectedVersion((p) => p || r?.selectedVersion || r?.configuredVersion || '');
    }).catch(() => {});
  }, []);
  useEffect(() => {
    load();
    const off = M()?.onKernel?.((p: any) => {
      if (typeof p?.pct === 'number') setPct(p.pct);
      setMsg(p?.msg || '');
      if (p?.done) {
        setBusy(false);
        // 下载完成 → 选中并【落盘】刚下好的版本(与账号页一致;只改界面上的显示会导致任务实际还用旧版本)
        if (p?.path && p?.version) {
          setSelectedVersion(String(p.version));
          Promise.resolve(M()?.setSelectedKernel?.({ version: String(p.version) })).catch(() => {}).finally(() => {
            try { window.dispatchEvent(new CustomEvent('noobclaw:kernel-changed', { detail: { version: String(p.version) } })); } catch { /* ignore */ }
          });
        }
        load();
      }
    });
    const onChanged = (e: Event) => { const v = (e as CustomEvent)?.detail?.version; if (v) setSelectedVersion(String(v)); load(); };
    window.addEventListener('noobclaw:kernel-changed', onChanged);
    return () => { if (typeof off === 'function') off(); window.removeEventListener('noobclaw:kernel-changed', onChanged); };
  }, [load]);

  const choose = async (v: string) => {
    setSelectedVersion(v);
    await M()?.setSelectedKernel?.({ version: v });
    setOpen(false);
    try { window.dispatchEvent(new CustomEvent('noobclaw:kernel-changed', { detail: { version: v } })); } catch { /* ignore */ }
  };
  const download = async (v: string) => {
    setBusy(true); setPct(0); setMsg(i18nService.t('mvPreparingDownload'));
    await M()?.ensureKernel?.({ version: v });
  };
  const ready = !!selectedVersion && (kernel.installedVersions || []).includes(selectedVersion);

  return (
    <div className="relative non-draggable shrink-0">
      <button type="button" onClick={() => setOpen((o) => !o)}
        className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border whitespace-nowrap ${ready ? 'bg-green-500/15 text-green-500 border-green-500/30' : 'bg-amber-500/15 text-amber-500 border-amber-500/30'}`}>
        🧬 {i18nService.t('mvFingerprintBrowser')} {selectedVersion ? `v${selectedVersion}` : ''} {ready ? '✓' : i18nService.t('mvNotReady')}
        {busy && !open && <span className="opacity-70"> · {pct}%</span>}
        <span className="opacity-60">▾</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-1 z-50 w-64 rounded-xl py-1 shadow-xl dark:bg-claude-darkBg bg-white border dark:border-white/10 border-black/10">
            <div className="px-3 py-1.5 text-[11px] opacity-50">{i18nService.t('mvSelectKernelVersion')}</div>
            {window.electron?.platform === 'win32' && (kernel.available || []).some((a) => !a.installed) && (
              <div className="mx-3 mb-1 text-[10px] leading-snug rounded-md px-2 py-1.5 border border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400">⚠️ {i18nService.t('kernelWinAvTip')}</div>
            )}
            {(kernel.available && kernel.available.length) ? kernel.available.map((a) => {
              const isSel = a.version === selectedVersion;
              return (
                <div key={a.version} className={`flex items-center justify-between gap-2 px-3 py-1.5 ${isSel ? 'bg-green-500/10' : 'hover:bg-black/5 dark:hover:bg-white/5'}`}>
                  <button type="button" disabled={!a.installed} onClick={() => a.installed && choose(a.version)}
                    className={`flex-1 min-w-0 text-left flex items-center gap-1.5 ${a.installed ? 'cursor-pointer' : 'cursor-default opacity-70'}`}>
                    <span className="text-xs font-medium truncate">{a.label || `v${a.version}`}</span>
                    {a.sizeMb ? <span className="text-[10px] opacity-40 shrink-0">{a.sizeMb}MB</span> : null}
                    {a.recommended && <span className="text-[10px] px-1 rounded bg-violet-500/20 text-violet-500 shrink-0">{i18nService.t('mvRecommended')}</span>}
                    {isSel && a.installed && <span className="text-[10px] text-green-500 shrink-0">{i18nService.t('mvInUse')}</span>}
                  </button>
                  {a.installed
                    ? <span className="text-green-500 text-sm shrink-0">✓</span>
                    : <button type="button" disabled={busy} onClick={() => download(a.version)}
                        className="shrink-0 text-[11px] px-2 py-1 rounded-lg bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-50">{busy ? i18nService.t('mvDownloading') : i18nService.t('mvDownload')}</button>}
                </div>
              );
            }) : (
              <div className="px-3 py-3 text-xs opacity-60">{kernel.installed ? i18nService.t('mvLocalVersionInstalled') : i18nService.t('mvFetchingVersions')}</div>
            )}
            {busy && (
              <div className="px-3 pt-1.5 pb-1 border-t dark:border-white/10 border-black/10">
                <div className="h-1.5 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden"><div className="h-full bg-violet-500 transition-all" style={{ width: `${Math.max(2, pct)}%` }} /></div>
                <div className="text-[10px] opacity-60 mt-1 truncate">{msg} · {pct}%</div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default KernelPicker;
