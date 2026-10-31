import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Device, L, Run, Step, accountOf, api, bd, btnGhost, btnPrimary, capsText, countKeys, deleteTask, errText, fmtCost, fmtCountsIcons,
  fmtDuration, fmtNext, fmtRelFuture, fmtTotals, fmtWhen, isManual, lastWarn, modeName, num, runStatus, scheduleText, sendCommand,
  shortTarget, stepLines, stepText, sub, surface, surface2, targetLabel, txt,
} from './cloudPhoneShared';
import { ConfirmDialog } from './cloudPhoneUi';
import PhoneTaskEditor from './PhoneTaskEditor';

/**
 * Task detail of one phone's task, opened inline in the 云手机 page (structured like the browser TaskDetailPage):
 * head (config rows + actions) → running-only progress / cost → 6 stat cards → current run steps → run history.
 * Polls every 5 s while running, 15 s otherwise.
 */

const Stat: React.FC<{ label: string; value: string; onClick?: () => void; action?: string }> = ({ label, value, onClick, action }) => {
  const cls = `text-left w-full rounded-xl border ${bd} ${surface2} px-3 py-2.5 flex flex-col gap-1 ${onClick ? 'cursor-pointer hover:border-claude-accent/50 transition-colors' : ''}`;
  const inner = (<>
    <span className={`text-[11.5px] ${sub}`}>{label}</span>
    <b className={`text-[13px] font-semibold leading-normal ${txt}`}>{value}</b>
    {action && <i className="not-italic text-[11px] text-green-600 dark:text-claude-accent">{action}</i>}
  </>);
  return onClick ? <button type="button" className={cls} onClick={onClick}>{inner}</button> : <div className={cls}>{inner}</div>;
};

const StepList: React.FC<{ steps: Step[] | undefined; empty: string; compact?: boolean }> = ({ steps, empty, compact }) => {
  const lines = stepLines(steps);
  if (!lines.length) return <div className={`text-xs ${sub}`}>{empty}</div>;
  return (
    <ol className="list-none m-0 p-0 flex flex-col gap-[5px]">
      {lines.map((l, i) => (
        <li key={i} className={`grid ${compact ? 'grid-cols-[38px_1fr] gap-1.5 text-[11.5px]' : 'grid-cols-[44px_1fr] gap-2 text-xs'} ${compact ? sub : txt}`}>
          <time className={`tabular-nums ${sub}`}>{l.time}</time><span>{l.text}</span>
        </li>
      ))}
    </ol>
  );
};

const PhoneTaskDetail: React.FC<{ deviceId: string; taskId: string; onBack: () => void }> = ({ deviceId, taskId, onBack }) => {
  const [data, setData] = useState<{ device: Device; runs: Run[] } | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [msg, setMsg] = useState('');
  const [steps, setSteps] = useState<Record<string, Step[]>>({});
  const [editing, setEditing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [busy, setBusy] = useState(false);
  const historyRef = useRef<HTMLDivElement>(null);
  const msgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((t: string) => {
    setMsg(t);
    if (msgTimer.current) clearTimeout(msgTimer.current);
    msgTimer.current = setTimeout(() => setMsg(''), 5000);
  }, []);
  useEffect(() => () => { if (msgTimer.current) clearTimeout(msgTimer.current); }, []);

  const load = useCallback(async () => {
    try {
      const r = await api<{ device: Device; runs: Run[] }>(`/devices/${encodeURIComponent(deviceId)}`);
      setData({ device: r.device, runs: r.runs || [] });
      setLoadErr('');
    } catch (e) { setLoadErr(errText(e)); }
  }, [deviceId]);

  const fetchSteps = useCallback(async (runId: string) => {
    try {
      const r = await api<{ steps: Step[] }>(`/devices/${encodeURIComponent(deviceId)}/steps?run_id=${encodeURIComponent(runId)}`);
      setSteps((s) => ({ ...s, [runId]: r.steps || [] }));
    } catch { /* keep what we have */ }
  }, [deviceId]);

  const device = data?.device;
  const task = device?.tasks.find((t) => t.id === taskId) || null;
  const pr = device?.progress || null;
  const deviceRunning = !!device && device.online && device.running;
  const running = deviceRunning && (!pr || !pr.task_id || pr.task_id === taskId);
  const runs = (data?.runs || []).filter((r) => r.task_id === taskId);
  const liveRunId = running && pr ? pr.run_id : '';
  const lastRunId = runs[0]?.run_id || '';

  // Poll: 5 s while running, 15 s otherwise.
  useEffect(() => {
    void load();
    const t = setInterval(() => { void load(); }, running ? 5000 : 15000);
    return () => clearInterval(t);
  }, [load, running]);

  // Current run: full step list refreshed with every poll; otherwise the latest run's steps (fetched once).
  useEffect(() => { if (liveRunId) void fetchSteps(liveRunId); }, [liveRunId, data, fetchSteps]);
  useEffect(() => { if (!liveRunId && lastRunId && !steps[lastRunId]) void fetchSteps(lastRunId); }, [liveRunId, lastRunId, steps, fetchSteps]);

  // Task removed elsewhere (phone / other window) → back to the list.
  useEffect(() => { if (data && !task) onBack(); }, [data, task, onBack]);

  if (!data || !device || !task) {
    return <div className={`p-6 text-sm ${sub}`}>{loadErr || L('加载中…', '載入中…', 'Loading…')}</div>;
  }

  const command = async (action: 'run' | 'stop') => {
    setBusy(true);
    try {
      await sendCommand(device.id, action, task.id);
      flash(L('已发送，手机约 15 秒内执行', '已發送，手機約 15 秒內執行', 'Sent — the phone acts within ~15 s'));
      void load();
    } catch (e) { flash(L('发送失败：', '發送失敗：', 'Failed: ') + errText(e)); }
    finally { setBusy(false); }
  };
  const doDelete = async () => {
    setBusy(true);
    try { await deleteTask(device, task.id); setConfirmDel(false); onBack(); }
    catch (e) { setConfirmDel(false); flash(L('删除失败：', '刪除失敗：', 'Delete failed: ') + errText(e)); }
    finally { setBusy(false); }
  };

  const acct = accountOf(device);
  const where = (task.mode === 'precise' ? task.targets : task.keywords) || [];
  const canRun = device.online && device.a11y && !device.over_limit && !deviceRunning;
  const last = runs[0];
  const warn = lastWarn(task.last_status);
  const items = countKeys(task.script_id).filter(({ k }) => (pr?.targets?.[k] || 0) > 0 || (pr?.counts?.[k] || 0) > 0);
  const currentSteps = liveRunId ? (steps[liveRunId] || pr?.steps) : (lastRunId ? steps[lastRunId] : undefined);
  const glow = 'rounded-xl border-2 border-claude-accent/45 bg-claude-accent/[.06] shadow-[0_0_16px_rgba(0,255,136,.15)] px-3 py-2.5';
  const row = (k: string, v: string) => (
    <div className="grid grid-cols-[72px_1fr] gap-2"><span className={sub}>{k}</span><em className={`not-italic break-words ${txt}`}>{v}</em></div>
  );

  return (
    <div className={`rounded-[14px] border ${bd} ${surface} overflow-hidden`}>
      <div className="flex flex-col gap-3.5 px-[18px] pt-4 pb-5">
        {/* head */}
        <div className="flex flex-col gap-2.5">
          <button type="button" onClick={onBack} className={`self-start text-[12.5px] ${sub} hover:text-claude-text dark:hover:text-claude-darkText pb-1`}>
            ← {L('返回我的云手机', '返回我的雲手機', 'Back to my cloud phones')}
          </button>
          <div className="flex gap-4 items-start justify-between flex-wrap">
            <div className="min-w-0 flex-1 flex flex-col gap-2.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[11px] font-bold px-2 py-0.5 rounded-md bg-black text-white border border-[#25f4ee]">TikTok</span>
                <b className={`text-[17px] ${txt}`}>{task.name}</b>
                <span className={`font-mono text-[11px] ${sub}`}>{L('设备ID', '設備ID', 'Device ID')} {device.id}</span>
              </div>
              <div className="grid grid-cols-1 gap-1.5 text-[12.5px]">
                {row(L('账号', '帳號', 'Account'), [acct ? `${acct.nickname} ${acct.handle}`.trim() : '—', device.vendor].filter(Boolean).join(' · '))}
                {row(L('模式', '模式', 'Mode'), `${task.mode === 'precise' ? '🎯' : '🔎'} ${modeName(task.mode)}`)}
                {row(targetLabel(task.script_id, task.mode), where.map(shortTarget).join('、') || '—')}
                {row(L('每次上限', '每次上限', 'Per run'), capsText(task.script_id, task.caps))}
                {row(L('人设', '人設', 'Persona'), task.persona || '—')}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {running ? (<>
                <span className="text-[12.5px] font-bold text-green-600 dark:text-claude-accent">● {L('运行中', '運行中', 'Running')}</span>
                <button type="button" disabled={busy} onClick={() => command('stop')}
                  className="px-3.5 py-[7px] text-[12.5px] font-bold rounded-[10px] border border-[#ff5c7a]/50 text-[#ff5c7a] bg-transparent hover:bg-[#ff5c7a]/10 disabled:opacity-50">{L('停止', '停止', 'Stop')}</button>
              </>) : (<>
                <span className={`text-[11.5px] ${sub}`}>{isManual(task.schedule) ? L('手动运行', '手動運行', 'Manual run') : `${scheduleText(task.schedule)} · ${L('自动运行', '自動運行', 'auto')}`}</span>
                <button type="button" className={`${btnPrimary} px-3.5 py-[7px] text-[12.5px]`} disabled={!canRun || busy} onClick={() => command('run')}>{L('立即运行', '立即運行', 'Run now')}</button>
                <button type="button" className={`${btnGhost} px-3.5 py-[7px] text-[12.5px]`} onClick={() => setEditing(true)}>{L('编辑', '編輯', 'Edit')}</button>
                <button type="button" className={`${btnGhost} px-3.5 py-[7px] text-[12.5px] !text-[#ff5c7a]`} onClick={() => setConfirmDel(true)}>{L('删除', '刪除', 'Delete')}</button>
              </>)}
            </div>
          </div>
          {msg && <div className="text-[12.5px] text-green-600 dark:text-claude-accent">{msg}</div>}
          {!device.online && <div className="text-[12px] text-amber-500 dark:text-amber-400">{L('手机离线，上线后才能运行', '手機離線，上線後才能運行', 'The phone is offline — it can run once it is back online')}</div>}
          {device.online && !device.a11y && <div className="text-[12px] text-amber-500 dark:text-amber-400">{L('需要您回到手机，为 NoobClaw App 打开无障碍服务权限', '需要您回到手機，為 NoobClaw App 打開無障礙服務權限', 'Turn on the Accessibility service for the NoobClaw app on the phone')}</div>}
        </div>

        {/* running only: this run's progress + cost */}
        {running && pr && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div className={glow}>
              <div className="text-[11.5px] font-bold text-green-600 dark:text-claude-accent mb-1.5">● {L('本次运行进度', '本次運行進度', 'This run')}</div>
              <div className={`flex gap-3.5 flex-wrap text-[13px] font-mono ${txt}`}>
                {items.length ? items.map(({ k, icon }) => (
                  <span key={k}>{icon} <b className="text-green-600 dark:text-claude-accent">{num(pr.counts?.[k] || 0)}</b>{pr.targets?.[k] ? `/${pr.targets[k]}` : ''}</span>
                )) : '—'}
              </div>
            </div>
            <div className={glow}>
              <div className="text-[11.5px] font-bold text-green-600 dark:text-claude-accent mb-1.5">● {L('本次消耗', '本次消耗', 'Cost so far')}</div>
              <div className={`text-[13px] font-mono ${txt}`}>💎 <b className="text-green-600 dark:text-claude-accent">{num(pr.credits || 0)}</b> ≈ <b className="text-green-600 dark:text-claude-accent">${Number(pr.usd || 0).toFixed(4)}</b></div>
            </div>
          </div>
        )}

        {/* 6 stat cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
          <Stat label={L('累计完成', '累計完成', 'Total done')} value={fmtTotals(task.script_id, task.totals)} />
          <Stat label={L('累计消耗', '累計消耗', 'Total cost')} value={fmtCost(task.credits_total || 0, task.usd_total || 0)} />
          <Stat label={L('上次完成', '上次完成', 'Last run done')} value={last || task.last_run_at ? fmtTotals(task.script_id, task.last_counts || last?.counts) : '—'} />
          <Stat label={L('上次消耗', '上次消耗', 'Last run cost')} value={last || task.last_run_at ? fmtCost(task.last_credits ?? last?.credits ?? 0, task.last_usd ?? last?.usd ?? 0) : '—'} />
          <Stat label={L('上次运行', '上次運行', 'Last run')} value={`${fmtWhen(task.last_run_at)}${warn ? ` · ${warn}` : ''}`}
            onClick={() => historyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            action={`${L('查看历史运行记录', '查看歷史運行記錄', 'See run history')} ›`} />
          <Stat label={L('下次运行', '下次運行', 'Next run')}
            value={isManual(task.schedule) ? L('手动运行', '手動運行', 'Manual') : task.next_run_at ? `${fmtRelFuture(task.next_run_at)} · ${fmtNext(task.next_run_at)}` : '—'} />
        </div>

        {/* current run steps */}
        <div>
          <h3 className={`m-0 mb-2 text-sm font-bold ${txt}`}>{L('当前运行明细', '目前運行明細', 'Current run')}</h3>
          <div className={`px-3 py-2.5 rounded-xl border ${bd} ${surface2}`}>
            <StepList steps={currentSteps} empty={running ? L('等待手机响应…', '等待手機回應…', 'Waiting for the phone…') : L('还没有运行记录', '還沒有運行記錄', 'No runs yet')} />
          </div>
          {!running && lastRunId && <div className={`mt-1.5 text-[11px] ${sub}`}>{L('没有运行中的任务，上面是最近一次的明细', '沒有運行中的任務，上面是最近一次的明細', 'Nothing is running — this is the latest run')}</div>}
        </div>

        {/* run history */}
        <div ref={historyRef}>
          <h3 className={`m-0 mb-2 text-sm font-bold ${txt}`}>{L('运行记录', '運行記錄', 'Run history')}</h3>
          {runs.length === 0 && <div className={`text-xs ${sub}`}>{L('暂无运行记录', '暫無運行記錄', 'No runs yet')}</div>}
          <div className="flex flex-col gap-1.5">
            {runs.map((r) => {
              const st = runStatus(r);
              const reason = r.status !== 'done' && r.reason ? stepText({ ts: 0, c: r.reason }) : '';
              return (
                <details key={r.run_id} className={`cp-details rounded-[10px] border ${bd} ${surface2}`}
                  onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open && !steps[r.run_id]) void fetchSteps(r.run_id); }}>
                  <summary className="cursor-pointer px-[11px] py-[9px] grid grid-cols-[1fr_auto] gap-x-2.5 gap-y-[3px] items-center">
                    <span className={`text-[12.5px] font-medium tabular-nums ${txt}`}>{fmtWhen(r.at)}{r.dry_run ? L('（试跑）', '（試跑）', ' (dry run)') : ''}</span>
                    <span className={`justify-self-end text-[11px] font-bold px-[7px] py-0.5 rounded-full ${st.tone === 'done' ? 'text-green-600 dark:text-claude-accent bg-claude-accent/[.12]' : 'text-amber-500 dark:text-amber-400 bg-amber-500/[.14]'}`}>{st.text}</span>
                    <span className={`col-span-2 text-[11.5px] tabular-nums ${sub}`}>
                      {[fmtCountsIcons(task.script_id, r.counts), fmtCost(r.credits || 0, r.usd || 0), fmtDuration(r.duration_ms), reason].filter(Boolean).join(' · ')}
                    </span>
                  </summary>
                  <div className={`px-[11px] pb-2.5 pt-2 border-t ${bd}`}>
                    {steps[r.run_id] ? <StepList compact steps={steps[r.run_id]} empty={L('这次运行没有明细', '這次運行沒有明細', 'No steps for this run')} />
                      : <div className={`text-[11.5px] ${sub}`}>{L('加载中…', '載入中…', 'Loading…')}</div>}
                  </div>
                </details>
              );
            })}
          </div>
        </div>
      </div>

      {editing && (
        <PhoneTaskEditor device={device} initial={task} onCancel={() => setEditing(false)}
          onSaved={(m) => { setEditing(false); flash(m); void load(); }} />
      )}
      {confirmDel && (
        <ConfirmDialog busy={busy} title={L('删除这个任务？', '刪除這個任務？', 'Delete this task?')}
          body={L(`「${task.name}」会从这台手机上删除，运行记录保留。`, `「${task.name}」會從這台手機上刪除，運行記錄保留。`, `“${task.name}” will be removed from this phone. Run history is kept.`)}
          confirmText={L('删除', '刪除', 'Delete')} onCancel={() => setConfirmDel(false)} onConfirm={doDelete} />
      )}
    </div>
  );
};

export default PhoneTaskDetail;
