import React, { useCallback, useEffect, useRef, useState } from 'react';
import { openWallet } from '../../services/walletNav';
import {
  ConsoleConfig, Device, L, PlatformId, taskName, TaskView, api, bd, deleteTask, errText, sendCommand, sub, surface, txt, visiblePlatforms,
  normDevice, shortId,
} from './cloudPhoneShared';
import { AndroidIcon, ConfirmDialog, useComplianceHidden } from './cloudPhoneUi';
import { AddCard, GuideCard, PhoneCard } from './PhoneCard';
import PhoneTaskDetail from './PhoneTaskDetail';
import PhoneTaskEditor from './PhoneTaskEditor';
import BatchDialog from './BatchDialog';
import { BatchAct, selectable } from './cloudPhoneBatch';
import './cloudPhone.css';

/**
 * 云手机 — phones running NoobClaw Mobile on this account, drawn as vertical phone cards. Slot count = plan's
 * phone_limit; every empty slot shows the setup guide; an "add slots" card follows unless the plan is ultra.
 * Commands reach the phone with its next heartbeat (~15 s). The task detail opens inline in this page.
 */

const PAGE = 9;
/** Highest tier's phone limit (旗舰版 / 至尊版): no "add slots" card once the plan already has it. */
const TOP_LIMIT = 50;

type Confirm = { kind: 'remove'; device: Device } | { kind: 'task'; device: Device; task: TaskView };

const MyPhonesView: React.FC<{ onUpgrade?: () => void }> = ({ onUpgrade }) => {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [limit, setLimit] = useState(0);
  const [plan, setPlan] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [config, setConfig] = useState<ConsoleConfig | null>(null);
  const [page, setPage] = useState(1);
  const [sel, setSel] = useState<Record<string, PlatformId>>({});
  const [detail, setDetail] = useState<{ deviceId: string; taskId: string } | null>(null);
  const [editor, setEditor] = useState<{ device: Device; task: TaskView | null } | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [batch, setBatch] = useState<BatchAct | null>(null);
  const msgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hidden = useComplianceHidden();
  const platforms = visiblePlatforms(hidden);
  const tiktokVisible = platforms.some((p) => p.id === 'tiktok');
  // Batch: run / create need a live visible platform; with no visible platform at all there is nothing to do.
  const liveVisible = platforms.some((p) => p.live);
  const batchOn = platforms.length > 0;
  const upgrade = useCallback(() => { if (onUpgrade) onUpgrade(); else openWallet('subscription'); }, [onUpgrade]);

  const flash = useCallback((t: string) => {
    setMsg(t);
    if (msgTimer.current) clearTimeout(msgTimer.current);
    msgTimer.current = setTimeout(() => setMsg(''), 5000);
  }, []);
  useEffect(() => () => { if (msgTimer.current) clearTimeout(msgTimer.current); }, []);

  // Polling guards: newest request wins, timer ticks skip while one is in flight, nothing is set after unmount.
  const seq = useRef(0);
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  /** `force` = after a user action: run even if a poll is in flight (its stale answer is then ignored). */
  const load = useCallback(async (force = false) => {
    if (inFlight.current && !force) return;
    inFlight.current = true;
    const my = ++seq.current;
    try {
      const r = await api<{ devices: Device[]; phone_limit: number; plan: string }>('/devices');
      if (!alive.current || my !== seq.current) return;
      setDevices((Array.isArray(r.devices) ? r.devices : []).map(normDevice).filter((x) => x.id));
      setLimit(Number(r.phone_limit) || 0);
      setPlan(String(r.plan || ''));
      setErr('');
    } catch (e) {
      if (alive.current && my === seq.current) setErr(errText(e));
    } finally {
      if (my === seq.current) inFlight.current = false;
    }
  }, []);
  // List polls every 10 s (paused while the task detail is open — it polls on its own).
  useEffect(() => {
    if (detail) return;
    void load();
    const t = setInterval(() => { void load(); }, 10_000);
    return () => clearInterval(t);
  }, [load, detail]);
  useEffect(() => { api<ConsoleConfig>('/config').then((c) => { if (alive.current) setConfig(c); }).catch(() => { /* guide buttons stay disabled */ }); }, []);
  // The detail page is a TikTok task: close it if the compliance config hides TikTok.
  useEffect(() => { if (detail && !tiktokVisible) setDetail(null); }, [detail, tiktokVisible]);

  const closeDetail = useCallback(() => setDetail(null), []);
  // Selection survives polling; phones that disappear (or go over the limit) drop out.
  useEffect(() => {
    if (!devices) return;
    setPicked((s) => {
      const keep = new Set(devices.filter((d) => selectable(d) && s.has(d.id)).map((d) => d.id));
      return keep.size === s.size ? s : keep;
    });
  }, [devices]);

  const platformOf = (d: Device): PlatformId => {
    const s = sel[d.id];
    if (s && platforms.some((p) => p.id === s)) return s;
    return platforms[0]?.id || 'tiktok';
  };
  const command = async (d: Device, action: 'run' | 'stop', taskId?: string) => {
    try {
      await sendCommand(d.id, action, taskId);
      flash(L('已发送，手机约 15 秒内执行', '已發送，手機約 15 秒內執行', 'Sent — the phone acts within ~15 s'));
      void load(true);
    } catch (e) { flash(L('发送失败：', '發送失敗：', 'Failed: ') + errText(e)); }
  };
  const doConfirm = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm.kind === 'remove') await api(`/devices/${encodeURIComponent(confirm.device.id)}`, { method: 'DELETE' });
      else await deleteTask(confirm.device, confirm.task.id);
      setConfirm(null);
      void load(true);
    } catch (e) {
      setConfirm(null);
      flash((confirm.kind === 'remove' ? L('移除失败：', '移除失敗：', 'Remove failed: ') : L('删除失败：', '刪除失敗：', 'Delete failed: ')) + errText(e));
    } finally { setBusy(false); }
  };

  // Slots: phones, then one guide card per empty slot, then "add slots" (not on the top plan).
  const list = devices || [];
  const cards: React.ReactNode[] = list.map((d) => (
    <PhoneCard key={d.id} device={d} platforms={platforms} platform={platformOf(d)}
      onPlatform={(p) => setSel((s) => ({ ...s, [d.id]: p }))}
      onCreate={() => setEditor({ device: d, task: null })}
      onView={(t) => setDetail({ deviceId: d.id, taskId: t.id })}
      onRun={(t) => command(d, 'run', t.id)}
      onStop={(taskId) => command(d, 'stop', taskId)}
      onDeleteTask={(t) => setConfirm({ kind: 'task', device: d, task: t })}
      onRemove={() => setConfirm({ kind: 'remove', device: d })}
      onUpgrade={upgrade}
      picked={batchOn && picked.has(d.id)}
      onPick={!batchOn ? undefined : (on) => setPicked((s) => { const n = new Set(s); if (on) n.add(d.id); else n.delete(d.id); return n; })} />
  ));
  const selectableIds = list.filter(selectable).map((d) => d.id);
  const allPicked = selectableIds.length > 0 && selectableIds.every((id) => picked.has(id));
  const nPicked = picked.size;
  const barBtn = 'inline-flex items-center justify-center font-bold rounded-[10px] border px-3 py-1.5 text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
  if (devices) {
    for (let i = list.length; i < limit; i++) cards.push(<GuideCard key={`slot-${i}`} n={i + 1} config={config} />);
    if (plan !== 'ultra' && plan !== 'max' && limit < TOP_LIMIT) cards.push(<AddCard key="add" onUpgrade={upgrade} />);
  }
  const pages = Math.max(1, Math.ceil(cards.length / PAGE));
  const cur = Math.min(page, pages);
  const pagerBtn = `min-w-[30px] h-[30px] px-2 rounded-lg border ${bd} ${surface} ${txt} text-[12.5px] tabular-nums disabled:opacity-35 disabled:cursor-default`;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[1180px] mx-auto px-5 pt-[18px] pb-6 flex flex-col gap-4">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className={`m-0 text-xl font-bold flex items-center gap-1.5 ${txt}`}><AndroidIcon />{L('我的云手机', '我的雲手機', 'My Cloud Phones')}</h1>
          {!detail && (
            <nav className="ml-auto flex items-center gap-1 flex-wrap" aria-label={L('手机分页', '手機分頁', 'Phone pages')}>
              <span className={`text-xs mr-2 tabular-nums ${sub}`}>{L('已用', '已用', 'Used')} {list.length} / {limit}</span>
              <button type="button" className={pagerBtn} disabled={cur <= 1} onClick={() => setPage(cur - 1)} aria-label={L('上一页', '上一頁', 'Previous page')}>‹</button>
              {Array.from({ length: pages }, (_, i) => i + 1).map((n) => (
                <button key={n} type="button" aria-current={n === cur ? 'page' : undefined} onClick={() => setPage(n)}
                  className={n === cur ? `${pagerBtn} !bg-claude-accent !border-claude-accent !text-[#04140c] font-bold` : pagerBtn}>{n}</button>
              ))}
              <button type="button" className={pagerBtn} disabled={cur >= pages} onClick={() => setPage(cur + 1)} aria-label={L('下一页', '下一頁', 'Next page')}>›</button>
            </nav>
          )}
        </div>
        {!detail && devices && batchOn && (
          <div className={`flex items-center gap-1.5 flex-wrap -mt-1 px-2.5 py-2 rounded-xl border ${bd} ${surface} text-[12.5px]`}>
            <label className={`inline-flex items-center gap-1.5 mr-1.5 cursor-pointer ${sub}`}>
              <input type="checkbox" className="w-[15px] h-[15px] m-0 cursor-pointer accent-[#00ff88]" checked={allPicked} disabled={!selectableIds.length}
                onChange={(e) => setPicked(e.target.checked ? new Set(selectableIds) : new Set())} />
              {L('全选', '全選', 'Select all')}
            </label>
            <span className={sub}>{L('已选', '已選', 'Selected')} <b className="text-green-600 dark:text-claude-accent">{nPicked}</b> {L('台', '台', '')}</span>
            <span className="ml-auto" />
            {liveVisible && <button type="button" disabled={!nPicked} onClick={() => setBatch('run')} className={`${barBtn} ${bd} dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover ${txt}`}>▶ {L('批量运行', '批量運行', 'Run')}</button>}
            <button type="button" disabled={!nPicked} onClick={() => setBatch('stop')} className={`${barBtn} border-[#ff5c7a]/45 dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover text-[#ff5c7a]`}>■ {L('批量停止', '批量停止', 'Stop')}</button>
            <button type="button" disabled={!nPicked} onClick={() => setBatch('del')} className={`${barBtn} ${bd} dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover text-[#ff5c7a]`}>{L('批量删除任务', '批量刪除任務', 'Delete tasks')}</button>
            {liveVisible && <button type="button" onClick={() => setBatch('new')} className={`${barBtn} border-claude-accent bg-claude-accent text-[#04140c]`}>＋ {L('批量创建任务', '批量建立任務', 'Create tasks')}</button>}
          </div>
        )}
        {err && <div className="text-sm text-[#ff5c7a]">{err}</div>}
        {msg && <div className="text-[12.5px] text-green-600 dark:text-claude-accent">{msg}</div>}

        {detail ? (
          <PhoneTaskDetail deviceId={detail.deviceId} taskId={detail.taskId} onBack={closeDetail} />
        ) : !devices ? (
          <div className={`text-sm ${sub}`}>{err ? '' : L('加载中…', '載入中…', 'Loading…')}</div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(208px,1fr))] gap-4">{cards.slice((cur - 1) * PAGE, cur * PAGE)}</div>
        )}
      </div>

      {batch && devices && batchOn && (
        <BatchDialog act={batch} devices={devices} picked={picked} platforms={platforms}
          onClose={() => setBatch(null)} onFinished={() => { void load(true); }} />
      )}
      {editor && (
        <PhoneTaskEditor device={editor.device} initial={editor.task} onCancel={() => setEditor(null)}
          onSaved={(m) => { setEditor(null); flash(m); void load(true); }} />
      )}
      {confirm && (confirm.kind === 'remove' ? (
        <ConfirmDialog busy={busy} title={L('移除这台手机？', '移除這台手機？', 'Remove this phone?')}
          body={tiktokVisible
            ? L(`${confirm.device.vendor || shortId(confirm.device.id)} 已离线。移除后会清空它的任务和绑定的 TikTok 账号，运行记录保留；空出 1 个手机槽位。这台手机以后重新上线，会自动回到列表。`,
              `${confirm.device.vendor || shortId(confirm.device.id)} 已離線。移除後會清空它的任務和綁定的 TikTok 帳號，運行記錄保留；空出 1 個手機槽位。這台手機以後重新上線，會自動回到列表。`,
              `${confirm.device.vendor || shortId(confirm.device.id)} is offline. Removing it clears its tasks and linked TikTok account (run history is kept) and frees 1 phone slot. If the phone comes back online it returns to the list.`)
            : L(`${confirm.device.vendor || shortId(confirm.device.id)} 已离线。移除后会清空它的任务和绑定的账号，运行记录保留；空出 1 个手机槽位。这台手机以后重新上线，会自动回到列表。`,
              `${confirm.device.vendor || shortId(confirm.device.id)} 已離線。移除後會清空它的任務和綁定的帳號，運行記錄保留；空出 1 個手機槽位。這台手機以後重新上線，會自動回到列表。`,
              `${confirm.device.vendor || shortId(confirm.device.id)} is offline. Removing it clears its tasks and linked account (run history is kept) and frees 1 phone slot. If the phone comes back online it returns to the list.`)}
          confirmText={L('移除', '移除', 'Remove')} onCancel={() => setConfirm(null)} onConfirm={doConfirm} />
      ) : (
        <ConfirmDialog busy={busy} title={L('删除这个任务？', '刪除這個任務？', 'Delete this task?')}
          body={L(`「${taskName(confirm.task)}」会从这台手机上删除，运行记录保留。`, `「${taskName(confirm.task)}」會從這台手機上刪除，運行記錄保留。`, `“${taskName(confirm.task)}” will be removed from this phone. Run history is kept.`)}
          confirmText={L('删除', '刪除', 'Delete')} onCancel={() => setConfirm(null)} onConfirm={doConfirm} />
      ))}
    </div>
  );
};

export default MyPhonesView;
