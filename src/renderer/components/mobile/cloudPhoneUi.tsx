import React, { useEffect, useRef, useState } from 'react';
import androidPng from '../../assets/android.png';
import { getBackendApiUrl } from '../../services/endpoints';
import { noobClawAuth } from '../../services/noobclawAuth';
import { L, avatarColor, bd, btnGhost, sub, surface, txt } from './cloudPhoneShared';

/** Android robot, drawn as a CSS mask so it takes the accent colour (or `className` bg-* override). */
export const AndroidIcon: React.FC<{ className?: string }> = ({ className }) => (
  <span aria-hidden="true" className={`cp-ico ${className || ''}`} style={{ WebkitMaskImage: `url(${androidPng})`, maskImage: `url(${androidPng})` }} />
);

/** Initial-letter avatar (stable colour per handle) + nickname + @handle. */
export const AccountRow: React.FC<{ handle: string; nickname: string; className?: string }> = ({ handle, nickname, className }) => {
  const shown = nickname || handle.replace(/^@/, '');
  const initial = (Array.from(shown)[0] || '?').toUpperCase();
  return (
    <div className={`flex items-center gap-1.5 min-w-0 ${className || ''}`} title={L('TikTok 账号已连接', 'TikTok 帳號已連接', 'TikTok account connected')}>
      <span className="flex-none w-6 h-6 rounded-full text-white text-xs font-bold grid place-items-center" style={{ background: avatarColor(handle) }}>{initial}</span>
      <span className="flex-1 min-w-0 flex flex-col leading-tight">
        <b className={`text-xs font-bold truncate ${txt}`}>{shown}</b>
        <i className={`not-italic text-[10.5px] truncate ${sub}`}>{handle}</i>
      </span>
    </div>
  );
};

/** Small modal confirm (Esc / backdrop = cancel; focus starts on Cancel). */
export const ConfirmDialog: React.FC<{
  title: string; body: string; confirmText: string; onCancel: () => void; onConfirm: () => void; busy?: boolean;
}> = ({ title, body, confirmText, onCancel, onConfirm, busy }) => {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const cancelCb = useRef(onCancel);
  cancelCb.current = onCancel;
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancelCb.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label={title}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className={`w-full max-w-[380px] rounded-2xl border ${bd} ${surface} p-5 flex flex-col gap-3 shadow-modal`}>
        <h2 className={`m-0 text-base font-bold ${txt}`}>{title}</h2>
        <p className={`m-0 text-[13px] leading-relaxed ${sub}`}>{body}</p>
        <div className="flex gap-1.5 mt-1">
          <button ref={cancelRef} type="button" className={`${btnGhost} flex-1 py-2 text-[12.5px]`} onClick={onCancel}>{L('取消', '取消', 'Cancel')}</button>
          <button type="button" disabled={busy} className="flex-1 py-2 text-[12.5px] font-bold rounded-[10px] border border-[#ff5c7a] bg-[#ff5c7a] text-white disabled:opacity-50" onClick={onConfirm}>{confirmText}</button>
        </div>
      </div>
    </div>
  );
};

/**
 * Compliance-hidden platforms (server computes them per user; same source as ScenarioView / MatrixView).
 * Fetch failure → hide nothing (fail-open).
 */
export function useComplianceHidden(): string[] {
  const [hidden, setHidden] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${getBackendApiUrl()}/api/matrix/config`, { headers: noobClawAuth.getAuthHeaders() });
        if (!res.ok) return;
        const data = await res.json();
        if (alive && Array.isArray(data?.complianceHiddenPlatforms)) setHidden(data.complianceHiddenPlatforms.map(String));
      } catch { /* not reachable → hide nothing */ }
    })();
    return () => { alive = false; };
  }, []);
  return hidden;
}
