import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Device, L, Platform, PlatformId, RawTask, ScriptId, accountOf, shortId, bd, btnGhost, btnPrimary, scriptName, sub, surface, surface2, taskName, txt,
} from './cloudPhoneShared';
import {
  BatchAct, BatchResult, batchCreate, batchDelete, batchRun, batchStop, canStop, createBlock, hasTasksOf, runPool, runSkip,
  runningPlatform, selectable, taskOfPlatform,
} from './cloudPhoneBatch';
import PhoneTaskEditor from './PhoneTaskEditor';

/** 批量运行 / 批量停止 / 批量删除任务 / 批量创建任务(3 步) — one modal flow per action. */

const TYPES: ScriptId[] = ['tiktok_lead_engage', 'tiktok_comment_like'];
const dangerBtn = 'inline-flex items-center justify-center font-bold rounded-[10px] border border-[#ff5c7a] bg-[#ff5c7a] text-white disabled:opacity-40 disabled:cursor-not-allowed';

const Opt: React.FC<{ on: boolean; glyph: string; label: string; disabled?: boolean; onClick?: () => void }> = ({ on, glyph, label, disabled, onClick }) => (
  <button type="button" disabled={disabled} onClick={onClick} aria-pressed={on}
    className={`inline-flex items-center gap-1.5 px-3 py-[7px] rounded-[10px] border text-[12.5px] ${surface2} disabled:opacity-45 disabled:cursor-not-allowed ${on ? 'border-claude-accent text-green-600 dark:text-claude-accent' : `${bd} ${txt}`}`}>
    {glyph} {label}
  </button>
);

export interface BatchDialogProps {
  act: BatchAct;
  devices: Device[];
  picked: Set<string>;
  /** Platforms left after the compliance filter. */
  platforms: Platform[];
  onClose: () => void;
  /** Called after a batch finished (refresh the list). */
  onFinished: () => void;
}

const BatchDialog: React.FC<BatchDialogProps> = ({ act, devices, picked, platforms, onClose, onFinished }) => {
  const live = platforms.filter((p) => p.live);
  const [pfSel, setPf] = useState<PlatformId | ''>(live[0]?.id || '');
  // The chosen platform may get hidden by the compliance config later: fall back to the first live one.
  const pf: PlatformId | '' = live.some((x) => x.id === pfSel) ? pfSel : (live[0]?.id || '');
  const [pfs, setPfs] = useState<Set<PlatformId>>(() => new Set(live[0] ? [live[0].id] : []));
  const [type, setType] = useState<ScriptId>(TYPES[0]);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [seed, setSeed] = useState<RawTask | null>(null);
  const [devs, setDevs] = useState<Set<string>>(() => new Set(picked));
  const [phase, setPhase] = useState<'form' | 'running' | 'done'>('form');
  const [prog, setProg] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<BatchResult | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const pickedPhones = useMemo(() => devices.filter((d) => picked.has(d.id) && selectable(d)), [devices, picked]);
  const pfObj = platforms.find((p) => p.id === pf);
  const pfName = pfObj ? pfObj.name() : '';

  // Escape closes (not while running, and step 2 is the editor's own modal).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (act === 'new' && step === 2) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, act, step]);

  const exec = async (targets: Device[], fn: (d: Device) => Promise<void>) => {
    setPhase('running');
    setProg({ done: 0, total: targets.length });
    const r = await runPool(targets, fn, (done, total) => { if (alive.current) setProg({ done, total }); });
    onFinished(); // refresh the list even when the dialog was closed meanwhile
    if (!alive.current) return;
    setResult(r);
    setPhase('done');
  };

  // Step 2 of 批量创建任务: the task editor in batch mode (its own modal).
  if (act === 'new' && step === 2) {
    return (
      <PhoneTaskEditor initial={null} onCancel={onClose}
        batch={{ scriptId: type, seed, onBack: () => setStep(1), onNext: (t) => { setSeed(t); setStep(3); } }} />
    );
  }

  const cancelBtn = <button type="button" className={`${btnGhost} flex-1 py-2 text-[12.5px]`} onClick={onClose}>{L('取消', '取消', 'Cancel')}</button>;
  const p = (children: React.ReactNode) => <p className={`m-0 text-[13px] leading-relaxed ${sub}`}>{children}</p>;
  const lbl = (t: string) => <div className={`text-xs ${sub} -mb-1`}>{t}</div>;
  const stepn = (t: string) => <div className={`text-[11.5px] ${sub}`}>{t}</div>;
  const B = ({ n }: { n: number }) => <b className={txt}>{n}</b>;

  let title = '';
  let body: React.ReactNode = null;
  let actions: React.ReactNode = null;

  if (act === 'run') {
    const ok = pf ? pickedPhones.filter((d) => !runSkip(d, pf)) : [];
    const skip = pickedPhones.length - ok.length;
    title = L('批量运行', '批量運行', 'Batch run');
    body = (<>
      {lbl(L('运行哪个平台的任务', '運行哪個平台的任務', 'Run the task of which platform'))}
      <div className="flex gap-1.5 flex-wrap">{live.map((x) => <Opt key={x.id} on={x.id === pf} glyph={x.id === pf ? '◉' : '○'} label={x.name()} onClick={() => setPf(x.id)} />)}</div>
      {p(<>{L('将在 ', '將在 ', `Runs the ${pfName} task now on `)}<B n={ok.length} />{L(` 台手机上立即运行 ${pfName} 任务`, ` 台手機上立即運行 ${pfName} 任務`, ' phone(s)')}
        {skip ? L(`；另外 ${skip} 台会跳过（离线 / 缺权限 / 运行中 / 没有该平台任务）`, `；另外 ${skip} 台會跳過（離線 / 缺權限 / 運行中 / 沒有該平台任務）`, `; ${skip} other(s) are skipped (offline / permission needed / running / no task for this platform)`) : ''}{L('。', '。', '.')}</>)}
    </>);
    actions = (<>{cancelBtn}<button type="button" className={`${btnPrimary} flex-1 py-2 text-[12.5px]`} disabled={!ok.length || !pf}
      onClick={() => { if (!pf) return; const id = pf; void exec(ok, (d) => batchRun(d, id)); }}>{L(`运行 ${ok.length} 台`, `運行 ${ok.length} 台`, `Run ${ok.length}`)}</button></>);
  } else if (act === 'stop') {
    const ok = pickedPhones.filter(canStop);
    const rest = pickedPhones.length - ok.length;
    title = L('批量停止', '批量停止', 'Batch stop');
    body = p(<>{L('将停止 ', '將停止 ', 'Stops ')}<B n={ok.length} />{L(' 台正在运行的手机', ' 台正在運行的手機', ' running phone(s)')}
      {rest ? L(`；另外 ${rest} 台没在运行，不受影响`, `；另外 ${rest} 台沒在運行，不受影響`, `; ${rest} other(s) aren't running and are left alone`) : ''}
      {L('。已完成的点赞、回复会保留。', '。已完成的點讚、回覆會保留。', '. Likes and replies already done are kept.')}</>);
    actions = (<>{cancelBtn}<button type="button" className={`${dangerBtn} flex-1 py-2 text-[12.5px]`} disabled={!ok.length}
      onClick={() => void exec(ok, batchStop)}>{L(`停止 ${ok.length} 台`, `停止 ${ok.length} 台`, `Stop ${ok.length}`)}</button></>);
  } else if (act === 'del') {
    const sel = [...pfs].filter((x) => platforms.some((y) => y.id === x));
    const ok = pickedPhones.filter((d) => hasTasksOf(d, sel));
    title = L('批量删除任务', '批量刪除任務', 'Batch delete tasks');
    body = (<>
      {lbl(L('删除哪些平台的任务（可多选）', '刪除哪些平台的任務（可多選）', 'Delete the tasks of which platforms (multiple)'))}
      <div className="flex gap-1.5 flex-wrap">{platforms.map((x) => {
        const on = pfs.has(x.id);
        return <Opt key={x.id} on={on} glyph={on ? '☑' : '☐'} label={x.name()}
          onClick={() => setPfs((s) => { const n = new Set(s); if (n.has(x.id)) n.delete(x.id); else n.add(x.id); return n; })} />;
      })}</div>
      {p(<>{L('将删除所选 ', '將刪除所選 ', 'Deletes these platforms’ tasks on ')}<B n={ok.length} />
        {L(' 台手机上这些平台的任务；正在运行的会先停止。运行记录保留，删除后不能恢复。', ' 台手機上這些平台的任務；正在運行的會先停止。運行記錄保留，刪除後不能恢復。', ' selected phone(s); running ones are stopped first. Run history is kept. This can’t be undone.')}</>)}
    </>);
    actions = (<>{cancelBtn}<button type="button" className={`${dangerBtn} flex-1 py-2 text-[12.5px]`} disabled={!ok.length || !sel.length}
      onClick={() => void exec(ok, (d) => batchDelete(d, sel))}>{L(`删除 ${ok.length} 台的任务`, `刪除 ${ok.length} 台的任務`, `Delete on ${ok.length}`)}</button></>);
  } else if (step === 1) {
    title = L('批量创建任务', '批量建立任務', 'Batch create task');
    body = (<>
      {stepn(L('第 1 步 / 共 3 步 · 一次只能选一个平台、一种任务', '第 1 步 / 共 3 步 · 一次只能選一個平台、一種任務', 'Step 1 of 3 · One platform and one task type at a time'))}
      {lbl(L('平台', '平台', 'Platform'))}
      <div className="flex gap-1.5 flex-wrap">{platforms.map((x) => x.live
        ? <Opt key={x.id} on={x.id === pf} glyph={x.id === pf ? '◉' : '○'} label={x.name()} onClick={() => setPf(x.id)} />
        : <Opt key={x.id} on={false} disabled glyph="○" label={`${x.name()} · ${L('即将推出', '即將推出', 'coming soon')}`} />)}</div>
      {lbl(L('任务类型', '任務類型', 'Task type'))}
      <div className="flex gap-1.5 flex-wrap">{TYPES.map((t) => <Opt key={t} on={t === type} glyph={t === type ? '◉' : '○'} label={scriptName(t)} onClick={() => setType(t)} />)}</div>
    </>);
    actions = (<>{cancelBtn}<button type="button" className={`${btnPrimary} flex-1 py-2 text-[12.5px]`} disabled={!pf}
      onClick={() => setStep(2)}>{L('下一步：配置任务', '下一步：設定任務', 'Next: set up the task')}</button></>);
  } else {
    const all = devices.filter(selectable);
    const chosen = all.filter((d) => devs.has(d.id) && !createBlock(d, pfName));
    const rep = chosen.filter((d) => taskOfPlatform(d, pf)).length;
    title = L('批量创建任务 · 选择手机', '批量建立任務 · 選擇手機', 'Batch create task · Pick phones');
    body = (<>
      {stepn(`${L('第 3 步 / 共 3 步', '第 3 步 / 共 3 步', 'Step 3 of 3')} · ${pfName} · ${scriptName(type)}`)}
      <ul className="list-none m-0 p-0 flex flex-col gap-1 max-h-[300px] overflow-auto">
        {all.map((d) => {
          const bad = createBlock(d, pfName);
          const old = taskOfPlatform(d, pf);
          const on = !bad && devs.has(d.id);
          const acct = accountOf(d);
          const tag = bad ? <span className={`text-[11px] whitespace-nowrap ${sub}`}>{bad}</span>
            : old ? <span className="text-[11px] whitespace-nowrap text-amber-500 dark:text-amber-400">
              {L(`已有「${taskName(old)}」→ 替换`, `已有「${taskName(old)}」→ 替換`, `Has “${taskName(old)}” → replace`)}
              {runningPlatform(d) === pf || (d.online && d.running && runningPlatform(d) === null) ? L('（先停止）', '（先停止）', ' (stops first)') : ''}</span>
              : <span className="text-[11px] whitespace-nowrap text-green-600 dark:text-claude-accent">{L('新建', '新建', 'New')}</span>;
          return (
            <li key={d.id} className={`grid grid-cols-[18px_1fr_auto] gap-2 items-center px-[9px] py-[7px] border ${bd} rounded-[10px] text-xs ${bad ? 'opacity-45' : ''}`}>
              <input type="checkbox" className="w-[15px] h-[15px] accent-[#00ff88] cursor-pointer m-0" checked={on} disabled={!!bad}
                aria-label={d.id} onChange={(e) => { const c = e.target.checked; setDevs((s) => { const n = new Set(s); if (c) n.add(d.id); else n.delete(d.id); return n; }); }} />
              <span className="min-w-0 truncate"><span className={`font-mono text-[11px] ${txt}`} title={d.id}>{shortId(d.id)}</span> <span className={`text-[11px] ${sub}`}>{acct ? `${acct.nickname} ${acct.handle}`.trim() : (d.vendor || '')}</span></span>
              {tag}
            </li>
          );
        })}
      </ul>
      {rep > 0 && (
        <div className="text-xs leading-[1.7] text-amber-500 dark:text-amber-400 bg-amber-500/[.08] border border-amber-500/30 rounded-[10px] px-2.5 py-2">
          {L(`选中的手机里有 ${rep} 台已经有 ${pfName} 任务（每个平台只能有 1 个）：会先停止正在运行的，再删除原任务，替换为这个新任务。原任务的运行记录保留。`,
            `選中的手機裡有 ${rep} 台已經有 ${pfName} 任務（每個平台只能有 1 個）：會先停止正在運行的，再刪除原任務，替換為這個新任務。原任務的運行記錄保留。`,
            `${rep} of the chosen phones already have a ${pfName} task (one per platform): running ones are stopped first, then the old task is replaced by this new one. Its run history is kept.`)}
        </div>
      )}
    </>);
    actions = (<>
      <button type="button" className={`${btnGhost} flex-1 py-2 text-[12.5px]`} onClick={() => setStep(2)}>{L('上一步', '上一步', 'Back')}</button>
      <button type="button" className={`${btnPrimary} flex-1 py-2 text-[12.5px]`} disabled={!chosen.length || !seed || !pf}
        onClick={() => { if (!pf || !seed) return; const t = seed; const id = pf; void exec(chosen, (d) => batchCreate(d, id, t)); }}>
        {L(`创建到 ${chosen.length} 台`, `建立到 ${chosen.length} 台`, `Create on ${chosen.length}`)}
      </button>
    </>);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label={title}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`w-full max-w-[520px] max-h-[calc(100vh-32px)] overflow-auto rounded-2xl border ${bd} ${surface} p-5 flex flex-col gap-3 shadow-modal`}>
        <h2 className={`m-0 text-base font-bold ${txt}`}>{title}</h2>
        <fieldset disabled={phase !== 'form'} className="contents">{body}</fieldset>
        {phase === 'form' && <div className="flex gap-1.5 mt-1">{actions}</div>}
        {phase === 'running' && (
          <div className="flex items-center gap-2">
            <div className={`flex-1 text-[12.5px] ${txt}`}>{L(`处理中 ${prog.done}/${prog.total}`, `處理中 ${prog.done}/${prog.total}`, `Working ${prog.done}/${prog.total}`)}</div>
            <button type="button" className={`${btnGhost} px-3 py-1.5 text-[12px]`} onClick={onClose}
              title={L('关闭后会在后台继续处理完', '關閉後會在背景繼續處理完', 'Keeps going in the background')}>{L('关闭', '關閉', 'Close')}</button>
          </div>
        )}
        {phase === 'done' && result && (<>
          <div className="text-[12.5px]">
            <span className="text-green-600 dark:text-claude-accent font-semibold">{L(`成功 ${result.ok} 台`, `成功 ${result.ok} 台`, `${result.ok} succeeded`)}</span>
            {result.fails.length > 0 && <span className="text-[#ff5c7a] font-semibold">{L(`；失败 ${result.fails.length} 台`, `；失敗 ${result.fails.length} 台`, ` · ${result.fails.length} failed`)}</span>}
          </div>
          {result.fails.length > 0 && (
            <ul className="list-none m-0 p-0 flex flex-col gap-1 max-h-[160px] overflow-auto">
              {result.fails.map((f) => (
                <li key={f.device.id} className={`text-[11.5px] ${sub}`}><span className={`font-mono ${txt}`}>{f.device.vendor || f.device.id}</span> · {f.reason}</li>
              ))}
            </ul>
          )}
          <div className="flex gap-1.5 mt-1"><button type="button" className={`${btnGhost} flex-1 py-2 text-[12.5px]`} onClick={onClose}>{L('关闭', '關閉', 'Close')}</button></div>
        </>)}
      </div>
    </div>
  );
};

export default BatchDialog;
