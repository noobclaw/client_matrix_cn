/**
 * ReportTaskDetail — 「抖音Report」专属详情页(不复用互动任务的赞/关注/评论详情页)。
 *
 * 展示:执行账号、状态(未执行 / 运行中 / 已执行于 X)、逐条链接(类型、原因 › 具体类型、描述、
 *       试运行结果、执行结果)、运行中实时日志。
 * 操作:试运行(选原因+填描述,停在提交前;不占执行锁、不计费,可反复)、执行一次(确认后锁定)、
 *       编辑(仅未执行)、删除、历史记录。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { scenarioService } from '../../services/scenario';

const t = (k: string) => i18nService.t(k);
const whyText = (code?: string) => {
  if (!code) return '';
  const k = `rpWhy_${code}`; const v = i18nService.t(k);
  return v !== k ? v : code;
};

interface ItemResult { url: string; status: string; why?: string; confirmed?: boolean; ts?: number }

interface Props {
  task: any;
  onBack: () => void;
  onEdit: () => void;
  onChanged: () => Promise<void> | void;
  onOpenHistory: () => void;
}

const fmtTime = (ts?: number | null) => (ts ? new Date(ts).toLocaleString() : '');

const ResultBadge: React.FC<{ r?: ItemResult; dry?: boolean }> = ({ r, dry }) => {
  if (!r) return <span className="text-gray-400">—</span>;
  if (r.status === 'submitted') return <span className="text-green-600 dark:text-green-400">✅ {r.confirmed ? t('rpResSubmitted') : t('rpResSubmittedUnconfirmed')}</span>;
  if (r.status === 'dry_run_ok') return <span className="text-sky-600 dark:text-sky-400">🧪 {t('rpResDryOk')}</span>;
  return <span className={dry ? 'text-amber-600 dark:text-amber-400' : 'text-red-500'}>⚠️ {whyText(r.why) || t('rpResFailed')}</span>;
};

const ReportTaskDetail: React.FC<Props> = ({ task, onBack, onEdit, onChanged, onOpenHistory }) => {
  const items: any[] = Array.isArray(task?.report_items) ? task.report_items : [];
  const results: ItemResult[] = Array.isArray(task?.report_results) ? task.report_results : [];
  const dryResults: ItemResult[] = Array.isArray(task?.report_dry_run_results) ? task.report_dry_run_results : [];
  const executedAt: number | null = task?.report_executed_at || null;
  const resultFor = (list: ItemResult[], url: string) => list.find((r) => r.url === url);

  const [accountName, setAccountName] = useState<string>('');
  const [running, setRunning] = useState(false);
  const [runKind, setRunKind] = useState<'dry' | 'real' | null>(null);
  const [logs, setLogs] = useState<Array<{ time: string; message: string }>>([]);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null);
  const [confirmRun, setConfirmRun] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const mounted = useRef(true);
  const startedAt = useRef(0);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    (async () => {
      try {
        const r = await (window as any).electron?.matrix?.listAccounts?.();
        const acc = (r?.accounts || []).find((a: any) => a.id === (task?.account_ids || [])[0]);
        if (mounted.current) setAccountName(acc ? `${acc.nickname || acc.displayName}${acc.displayId ? ' · ' + acc.displayId : ''}` : ((task?.account_ids || [])[0] || '-'));
      } catch { /* ignore */ }
    })();
  }, [task?.account_ids]);

  const poll = useCallback(async () => {
    const p = await scenarioService.getRunProgress(task.id).catch(() => null);
    if (!mounted.current || !p) return null;
    const stepLogs = (p.steps || []).flatMap((s: any) => (s.logs || []).map((l: any) => ({ time: l.time, message: String(l.message || '').replace(/^\[[^\]]+\]\s*/, '') })));
    setLogs(stepLogs.slice(-80));
    return p;
  }, [task.id]);

  // 进页时若已在跑(从别处启动的),接上轮询
  useEffect(() => { void poll().then((p) => { if (p && p.status === 'running') setRunning(true); }); }, [poll]);

  useEffect(() => {
    if (!running) return;
    const iv = setInterval(async () => {
      const p = await poll();
      if (!p) return;
      // 刚点运行的 15s 内忽略上一次运行残留的终态
      if (p.status !== 'running' && Date.now() - startedAt.current > 15000) {
        setRunning(false); setRunKind(null);
        if (p.status === 'error') setNotice({ kind: 'err', text: (p as any).error || t('rpRunError') });
        else setNotice({ kind: 'ok', text: t('rpRunDone') });
        await onChanged();
      }
    }, 2000);
    return () => clearInterval(iv);
  }, [running, poll, onChanged]);

  const start = async (kind: 'dry' | 'real') => {
    setNotice(null); setConfirmRun(false);
    startedAt.current = Date.now();
    setRunning(true); setRunKind(kind); setLogs([]);
    const out = kind === 'dry' ? await scenarioService.runReportDryRun(task.id) : await scenarioService.runTaskNow(task.id);
    if (!mounted.current) return;
    if (out.status !== 'started' && out.status !== 'ok') {
      setRunning(false); setRunKind(null);
      const r = String(out.reason || '');
      const k = `rpErr_${r}`; const v = i18nService.t(k);
      setNotice({ kind: 'warn', text: r === 'concurrency_limit_reached' ? t('tdConcurrencyLimit') : (v !== k ? v : r || t('rpRunError')) });
    }
    if (kind === 'real') await onChanged(); // 执行锁已写入 → 刷新出「已执行」
  };

  const stop = async () => { try { await scenarioService.requestAbort(task.id); setNotice({ kind: 'warn', text: t('tdStopping') }); } catch { /* ignore */ } };

  const del = async () => {
    if (!confirmDelete) { setConfirmDelete(true); setTimeout(() => mounted.current && setConfirmDelete(false), 3000); return; }
    const ok = await scenarioService.deleteTask(task.id);
    if (ok) { await onChanged(); onBack(); }
  };

  const status = running ? (runKind === 'dry' ? t('rpStatusDryRunning') : t('rpStatusRunning')) : executedAt ? t('rpStatusExecuted').replace('{time}', fmtTime(executedAt)) : t('rpStatusPending');

  return (
    <div className="w-full max-w-5xl mx-auto px-6 py-6 space-y-5">
      <button type="button" onClick={onBack} className="text-sm text-gray-500 hover:text-gray-800 dark:hover:text-gray-200">← {t('rpBack')}</button>

      <div className="rounded-2xl border border-rose-500/30 bg-rose-500/5 dark:bg-rose-500/10 p-5 space-y-3">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-semibold text-rose-600 dark:text-rose-400"><span className="w-1.5 h-1.5 rounded-full bg-rose-500" />🚩 {t('rpBrand')}</div>
            <div className="text-xl font-bold dark:text-white mt-1 break-all">{task?.name}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">#{String(task?.id || '').slice(-10)} · {t('rpCreatedAt')} {fmtTime(task?.created_at)}</div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {running ? (
              <button type="button" onClick={stop} className="px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800">{t('tdStop')}</button>
            ) : (
              <>
                {!executedAt && (
                  <button type="button" onClick={() => start('dry')} title={t('rpDryRunTip')} className="px-3 py-2 text-sm font-medium rounded-lg border border-sky-500/50 text-sky-600 dark:text-sky-400 hover:bg-sky-500/10">🧪 {t('rpDryRun')}</button>
                )}
                {!executedAt && (
                  confirmRun ? (
                    <button type="button" onClick={() => start('real')} className="px-3 py-2 text-sm font-semibold rounded-lg bg-rose-600 text-white hover:bg-rose-700">⚠️ {t('rpRunConfirm')}</button>
                  ) : (
                    <button type="button" onClick={() => setConfirmRun(true)} className="px-3 py-2 text-sm font-semibold rounded-lg bg-rose-500 text-white hover:bg-rose-600">🚩 {t('rpRunOnce')}</button>
                  )
                )}
                {!executedAt && (
                  <button type="button" onClick={onEdit} className="px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800">{t('tdEdit')}</button>
                )}
                <button type="button" onClick={del} className={`px-3 py-2 text-sm rounded-lg border ${confirmDelete ? 'border-red-500 bg-red-500 text-white' : 'border-red-300 dark:border-red-900/50 text-red-500 hover:bg-red-500/10'}`}>{confirmDelete ? t('tdConfirmDelete') : t('tdDelete')}</button>
              </>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
          <div className="rounded-xl bg-white/60 dark:bg-gray-900/40 border border-gray-200 dark:border-gray-800 px-3 py-2">
            <div className="text-[11px] text-gray-500">{t('rpSummaryAccount')}</div>
            <div className="font-medium dark:text-white truncate">{accountName || '-'}</div>
          </div>
          <div className="rounded-xl bg-white/60 dark:bg-gray-900/40 border border-gray-200 dark:border-gray-800 px-3 py-2">
            <div className="text-[11px] text-gray-500">{t('rpStatusLabel')}</div>
            <div className={`font-medium ${executedAt ? 'text-gray-700 dark:text-gray-200' : 'text-rose-600 dark:text-rose-400'}`}>{executedAt && !running ? '🔒 ' : ''}{status}</div>
          </div>
          <div className="rounded-xl bg-white/60 dark:bg-gray-900/40 border border-gray-200 dark:border-gray-800 px-3 py-2">
            <div className="text-[11px] text-gray-500">{t('rpLinksLabel')}</div>
            <div className="font-medium dark:text-white">{items.length} · {t('rpSubmittedCount').replace('{n}', String(results.filter((r) => r.status === 'submitted').length))}</div>
          </div>
        </div>

        {!executedAt && !running && (
          <div className="text-[11px] text-gray-600 dark:text-gray-400 leading-relaxed">ℹ️ {t('rpDetailTip')}{task?.report_dry_run_at ? ' ' + t('rpLastDryRun').replace('{time}', fmtTime(task.report_dry_run_at)) : ''}</div>
        )}
        {confirmRun && !running && (
          <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
            {t('rpRunConfirmTip')} <button type="button" onClick={() => setConfirmRun(false)} className="underline ml-1">{t('rpCancel')}</button>
          </div>
        )}
        {notice && (
          <div className={`rounded-lg border px-3 py-2 text-xs ${notice.kind === 'ok' ? 'border-green-500/30 bg-green-500/5 text-green-700 dark:text-green-400' : notice.kind === 'warn' ? 'border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-400' : 'border-red-500/30 bg-red-500/5 text-red-600 dark:text-red-400'}`}>{notice.text}</div>
        )}
      </div>

      <div className="rounded-2xl border border-gray-200 dark:border-gray-800 overflow-hidden">
        <div className="px-4 py-3 text-sm font-semibold dark:text-white border-b border-gray-200 dark:border-gray-800">{t('rpItemsTitle')}</div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 dark:bg-gray-800/50 text-gray-500 dark:text-gray-400">
              <tr>
                <th className="text-left px-3 py-2 w-6">#</th>
                <th className="text-left px-3 py-2 w-14">{t('rpTypeLabel')}</th>
                <th className="text-left px-3 py-2">{t('rpColLink')}</th>
                <th className="text-left px-3 py-2">{t('rpColReason')}</th>
                <th className="text-left px-3 py-2">{t('rpColDesc')}</th>
                <th className="text-left px-3 py-2 w-32">{t('rpColDryRun')}</th>
                <th className="text-left px-3 py-2 w-32">{t('rpColResult')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i} className="border-t border-gray-100 dark:border-gray-800 align-top">
                  <td className="px-3 py-2 text-gray-400">{i + 1}</td>
                  <td className="px-3 py-2 dark:text-gray-200">{it.targetType === 'account' ? t('rpTypeAccount') : t('rpTypeContent')}</td>
                  <td className="px-3 py-2 font-mono break-all"><a href={it.url} target="_blank" rel="noreferrer" className="text-sky-600 dark:text-sky-400 hover:underline">{it.url}</a></td>
                  <td className="px-3 py-2 text-rose-600 dark:text-rose-400">{it.reason}{it.subReason ? ` › ${it.subReason}` : ''}</td>
                  <td className="px-3 py-2 text-gray-600 dark:text-gray-300 break-all">{it.description}</td>
                  <td className="px-3 py-2"><ResultBadge r={resultFor(dryResults, it.url)} dry /></td>
                  <td className="px-3 py-2">{executedAt ? <ResultBadge r={resultFor(results, it.url)} /> : <span className="text-gray-400">{t('rpNotExecuted')}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-2xl border border-gray-200 dark:border-gray-800">
        <div className="px-4 py-3 flex items-center justify-between border-b border-gray-200 dark:border-gray-800">
          <div className="text-sm font-semibold dark:text-white">{t('rpLogTitle')}{running ? ' ●' : ''}</div>
          <button type="button" onClick={onOpenHistory} className="text-xs text-green-600 dark:text-green-400 hover:underline">{t('rpHistory')} →</button>
        </div>
        <div className="max-h-80 overflow-auto px-4 py-2 font-mono text-[11px] leading-relaxed text-gray-700 dark:text-gray-300 space-y-0.5">
          {logs.length === 0 ? <div className="text-gray-400 py-2">{t('rpNoLogs')}</div> : logs.map((l, i) => (
            <div key={i} className="flex gap-3"><span className="text-gray-400 shrink-0">{l.time}</span><span className="break-all">{l.message}</span></div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default ReportTaskDetail;
