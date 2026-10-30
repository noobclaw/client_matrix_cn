import React, { useCallback, useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { getBackendApiUrl } from '../../services/endpoints';
import { noobClawAuth } from '../../services/noobclawAuth';

/**
 * 雲手機 — phones running NoobClaw Mobile on this account: status, their tasks (same list as on the phone),
 * run / stop from the desktop, run history and logs. Commands reach the phone with its next heartbeat (≤ 1 min).
 */

type Counts = Record<string, number>;
interface Device {
  id: string; vendor: string; app_ver: string; online: boolean; last_seen: number; a11y: boolean; running: boolean;
  cooldown_until: number; account: string; task_count: number; today: Counts;
  last_run: { status: string; reason: string; dry_run: boolean; counts: Counts; at: number } | null;
}
interface Task {
  id: string; name: string; script_id: string; enabled: boolean; slots: string[]; tz: string;
  max_likes: number; max_comments: number; max_follows: number; persona: string; config: any;
}
interface Run { run_id: string; status: string; reason: string; dry_run: boolean; task_id: string; counts: Counts; duration_ms: number; at: number }
interface LogLine { ts: number; level: string; msg: string; run_id: string | null }

const isZh = () => i18nService.currentLanguage === 'zh' || i18nService.currentLanguage === 'zh-TW';
// 文案按繁體寫;簡體(zh)界面在運行時逐字轉成簡體(只覆蓋本文件用到的字)。
const T2S: Record<string, string> = Object.fromEntries(
  ('覆复帳账個个內内刪删劇剧動动務务區区執执帳帐戶户後后敗败數数時时暫暂會会東东機机權权沒没無无獲获現现發发線线編编號号裝装裡里記记設设評评詞词試试誌志請请論论讚赞載载輯辑這这運运選选還还錄录鍵键鏈链鐘钟關关離离點点卻却雲云')
    .match(/../g)!.map((p) => [p[0], p[1]]),
);
const toSimp = (s: string) => s.replace(/[\u4e00-\u9fff]/g, (c) => T2S[c] || c);
const T = (zh: string, en: string) => (i18nService.currentLanguage === 'zh' ? toSimp(zh) : isZh() ? zh : en);

const SCRIPTS: Record<string, { zh: string; en: string; icon: string }> = {
  tiktok_comment_like: { zh: '評論區點讚', en: 'Comment likes', icon: '💬' },
  tiktok_lead_engage: { zh: '定向獲客', en: 'Lead engage', icon: '🎯' },
};
const LEVELS: Record<string, Record<string, { likes: number; comments: number; follows: number; leads: number }>> = {
  tiktok_comment_like: { low: { likes: 30, comments: 5, follows: 0, leads: 0 }, mid: { likes: 100, comments: 15, follows: 0, leads: 0 }, high: { likes: 300, comments: 30, follows: 0, leads: 0 } },
  tiktok_lead_engage: { low: { likes: 10, comments: 5, follows: 10, leads: 10 }, mid: { likes: 30, comments: 15, follows: 30, leads: 30 }, high: { likes: 100, comments: 30, follows: 50, leads: 100 } },
};
const COUNT_LABELS: Record<string, [string, string]> = {
  like: ['點讚', 'likes'], comment: ['評論', 'comments'], follow: ['關注', 'follows'], lead_new: ['新客戶', 'leads'],
};

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${getBackendApiUrl()}/api/mobile-console${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...noobClawAuth.getAuthHeaders(), ...(init?.headers || {}) },
  });
  if (res.status === 401) noobClawAuth.handleAuthExpired();
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
  return j;
}

const fmtCounts = (c: Counts) => Object.keys(COUNT_LABELS).filter((k) => (c?.[k] || 0) > 0)
  .map((k) => `${T(COUNT_LABELS[k][0], COUNT_LABELS[k][1])} ${c[k]}`).join(' · ') || '—';
const fmtTime = (ms: number) => (ms ? new Date(ms).toLocaleString(isZh() ? 'zh-CN' : 'en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const levelOf = (t: Task) => t.config?.level || (t.max_likes <= 30 ? 'low' : t.max_likes >= 200 ? 'high' : 'mid');
const whereOf = (t: Task): string[] => [...(t.config?.urls || []), ...(t.config?.seed_accounts || []), ...(t.config?.keywords || [])];

const Pill: React.FC<{ color: 'green' | 'gray' | 'amber' | 'purple' | 'red'; children: React.ReactNode }> = ({ color, children }) => {
  const c = {
    green: 'bg-green-500/10 text-green-600 dark:text-green-400',
    gray: 'bg-gray-500/10 text-gray-500',
    amber: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    purple: 'bg-purple-500/10 text-purple-600 dark:text-purple-400',
    red: 'bg-red-500/10 text-red-600 dark:text-red-400',
  }[color];
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${c}`}>{children}</span>;
};

function deviceStatus(d: Device): React.ReactNode {
  if (!d.online) return <Pill color="gray">{T('離線', 'Offline')}</Pill>;
  if (d.running) return <Pill color="green">{T('運行中', 'Running')}</Pill>;
  if (!d.a11y) return <Pill color="amber">{T('缺權限', 'Permission needed')}</Pill>;
  if (d.cooldown_until > Date.now()) return <Pill color="red">{T('冷卻中', 'Cooling down')}</Pill>;
  return <Pill color="purple">{T('待命', 'Standby')}</Pill>;
}

const btn = 'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors';
const btnPrimary = `${btn} bg-claude-accent text-black hover:opacity-90`;
const btnGhost = `${btn} border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover`;
const card = 'rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface p-4';

// ───────────────────────── task editor ─────────────────────────
const TaskEditor: React.FC<{ initial: Task | null; onCancel: () => void; onSave: (t: Task) => void }> = ({ initial, onCancel, onSave }) => {
  const [script, setScript] = useState(LEVELS[initial?.script_id || ''] ? initial!.script_id : 'tiktok_comment_like');
  const [where, setWhere] = useState(initial ? whereOf(initial).join('\n') : '');
  const [level, setLevel] = useState<string>(initial && ['low', 'mid', 'high'].includes(levelOf(initial)) ? levelOf(initial) : 'mid');
  const [persona, setPersona] = useState(initial?.persona || '');
  const [auto, setAuto] = useState(initial ? initial.enabled : true);
  const [slots, setSlots] = useState<string[]>(initial?.slots?.length ? initial.slots : ['09:30', '20:00']);
  const [err, setErr] = useState('');
  const lv = (LEVELS[script] || LEVELS.tiktok_comment_like)[level] || LEVELS.tiktok_comment_like.mid;

  const save = () => {
    const items = Array.from(new Set(where.split(/[\n,，]/).map((x) => x.trim()).filter(Boolean)));
    if (!items.length) { setErr(T('請填關鍵詞', 'Enter keywords')); return; }
    const links = items.filter((x) => /^https?:/i.test(x) || x.startsWith('@'));
    const words = items.filter((x) => !links.includes(x));
    // Editing keeps every setting the editor does not show (replies off, run minutes, …).
    const prev = initial?.config || {};
    const config: any = { ...prev, level };
    if (script === 'tiktok_comment_like') {
      const urls = links.map((x) => (x.startsWith('@') ? `https://www.tiktok.com/${x}` : x));
      Object.assign(config, { comment_mode: urls.length ? 'precise' : 'keywords', urls, keywords: words,
        cl_do_like: prev.cl_do_like !== false, cl_do_reply: prev.cl_do_reply !== false });
    } else {
      Object.assign(config, { mode: links.length ? 'accounts' : 'keywords', seed_accounts: links, keywords: words, leads_per_run: lv.leads,
        lead_do_like: prev.lead_do_like !== false, lead_do_follow: prev.lead_do_follow !== false, lead_do_comment: prev.lead_do_comment !== false });
    }
    onSave({
      ...(initial || {}),
      id: initial?.id || 't' + Date.now().toString(36),
      name: initial?.name || `${T(SCRIPTS[script].zh, SCRIPTS[script].en)} · ${items[0].replace('https://www.tiktok.com/', '').slice(0, 20)}`,
      script_id: script, enabled: auto, slots: [...slots].sort(), tz: initial?.tz || Intl.DateTimeFormat().resolvedOptions().timeZone,
      max_likes: lv.likes, max_comments: lv.comments, max_follows: lv.follows, persona: persona.slice(0, 400), config,
    });
  };

  const chip = (on: boolean) => `${btn} ${on ? 'bg-claude-accent text-black' : 'border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text'}`;
  const label = 'text-xs font-semibold dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1.5 block';
  const input = 'w-full rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurfaceInset bg-claude-surfaceInset px-3 py-2 text-sm dark:text-claude-darkText text-claude-text outline-none focus:border-claude-accent';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onCancel}>
      <div className={`${card} w-[460px] max-h-[90vh] overflow-y-auto`} onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold dark:text-claude-darkText text-claude-text mb-4">{initial ? T('編輯任務', 'Edit task') : T('新建任務', 'New task')}</h3>
        <span className={label}>{T('劇本', 'Script')}</span>
        <div className="flex gap-2 mb-4">
          {Object.entries(SCRIPTS).map(([id, s]) => (
            <button key={id} type="button" disabled={!!initial} className={chip(script === id)} onClick={() => setScript(id)}>{s.icon} {T(s.zh, s.en)}</button>
          ))}
        </div>
        <span className={label}>{script === 'tiktok_comment_like' ? T('關鍵詞 / 鏈接', 'Keywords / links') : T('關鍵詞 / 同行帳號', 'Keywords / @accounts')}</span>
        <textarea className={`${input} mb-4`} rows={3} value={where} onChange={(e) => setWhere(e.target.value)}
          placeholder={script === 'tiktok_comment_like' ? T('每行一個，例如 latte art', 'One per line, e.g. latte art') : T('每行一個，例如 latte art 或 @rival', 'One per line, e.g. latte art or @rival')} />
        <span className={label}>{T('數量', 'Amount')}</span>
        <div className="flex gap-2 mb-1.5">
          {(['low', 'mid', 'high'] as const).map((k) => (
            <button key={k} type="button" className={`${chip(level === k)} flex-1`} onClick={() => setLevel(k)}>{T({ low: '少', mid: '中', high: '多' }[k], { low: 'Few', mid: 'Normal', high: 'Many' }[k])}</button>
          ))}
        </div>
        <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-4">
          {script === 'tiktok_comment_like' ? `${T('點讚', 'Likes')} ${lv.likes} · ${T('回覆', 'Replies')} ${lv.comments}`
            : `${T('客戶', 'Leads')} ${lv.leads} · ${T('關注', 'Follows')} ${lv.follows} · ${T('點讚', 'Likes')} ${lv.likes} · ${T('評論', 'Comments')} ${lv.comments}`}
        </p>
        <span className={label}>{T('人設（選填）', 'Persona (optional)')}</span>
        <input className={`${input} mb-4`} value={persona} onChange={(e) => setPersona(e.target.value)} placeholder={T('例如：東京咖啡店', 'e.g. a coffee shop in Tokyo')} />
        <span className={label}>{T('定時', 'Schedule')}</span>
        <div className="flex gap-2 mb-2">
          <button type="button" className={`${chip(auto)} flex-1`} onClick={() => setAuto(true)}>{T('每天', 'Daily')}</button>
          <button type="button" className={`${chip(!auto)} flex-1`} onClick={() => setAuto(false)}>{T('手動', 'Manual')}</button>
        </div>
        {auto && (
          <div className="flex gap-2 mb-4">
            {slots.map((s, i) => (
              <input key={i} type="time" className={input} value={s} onChange={(e) => setSlots(slots.map((x, j) => (j === i ? e.target.value : x)))} />
            ))}
          </div>
        )}
        {err && <p className="text-sm text-red-500 mb-3">{err}</p>}
        <div className="flex justify-end gap-2 mt-2">
          <button type="button" className={btnGhost} onClick={onCancel}>{T('取消', 'Cancel')}</button>
          <button type="button" className={btnPrimary} onClick={save}>{T('保存', 'Save')}</button>
        </div>
      </div>
    </div>
  );
};

// ───────────────────────── phone detail ─────────────────────────
const PhoneDetail: React.FC<{ id: string; onBack: () => void }> = ({ id, onBack }) => {
  const [data, setData] = useState<{ device: Device; tasks: Task[]; runs: Run[] } | null>(null);
  const [editing, setEditing] = useState<Task | null | 'new'>(null);
  const [logs, setLogs] = useState<{ run: Run; lines: LogLine[] } | null>(null);
  const [msg, setMsg] = useState('');

  const load = useCallback(() => { api(`/devices/${id}`).then(setData).catch((e) => setMsg(e.message)); }, [id]);
  useEffect(() => { load(); const t = setInterval(load, 10_000); return () => clearInterval(t); }, [load]);

  const flash = (t: string) => { setMsg(t); setTimeout(() => setMsg(''), 4000); };
  const saveTasks = async (tasks: Task[]) => {
    try { await api(`/devices/${id}/tasks`, { method: 'PUT', body: JSON.stringify({ tasks }) }); flash(T('已保存，手機 1 分鐘內同步', 'Saved — the phone syncs within a minute')); load(); }
    catch (e: any) { flash(T('保存失敗：', 'Save failed: ') + e.message); }
  };
  const command = async (action: string, taskId?: string) => {
    try {
      await api(`/devices/${id}/command`, { method: 'POST', body: JSON.stringify({ action, task_id: taskId }) });
      flash(T('已發送，手機 1 分鐘內執行', 'Sent — the phone acts within a minute'));
    } catch (e: any) {
      const m = e.message === 'phone_offline' ? T('手機離線', 'Phone is offline')
        : e.message === 'app_update_required' ? T('請先把手機 App 更新到 0.4.0 以上', 'Update the phone app to 0.4.0+ first')
        : e.message;
      flash(T('發送失敗：', 'Failed: ') + m);
    }
  };
  const openLogs = async (run: Run) => {
    try { const r = await api(`/devices/${id}/logs?run_id=${encodeURIComponent(run.run_id)}`); setLogs({ run, lines: r.logs || [] }); }
    catch (e: any) { flash(e.message); }
  };

  if (!data) return <div className="p-6 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">{msg || T('加載中…', 'Loading…')}</div>;
  const d = data.device;
  const taskName = (tid: string) => data.tasks.find((t) => t.id === tid)?.name || '';

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center gap-3">
        <button type="button" className={btnGhost} onClick={onBack}>← {T('返回', 'Back')}</button>
        <h2 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">📱 {d.vendor || d.id.slice(0, 8)}</h2>
        {deviceStatus(d)}
        <span className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">{d.account || 'TikTok'} · v{d.app_ver}</span>
        <div className="flex-1" />
        {d.running && <button type="button" className={`${btn} bg-red-500 text-white`} onClick={() => command('stop')}>■ {T('停止', 'Stop')}</button>}
      </div>
      {msg && <div className="text-sm text-claude-accent">{msg}</div>}

      <div>
        <div className="flex items-center mb-2">
          <h3 className="text-sm font-semibold dark:text-claude-darkText text-claude-text flex-1">{T('任務', 'Tasks')}</h3>
          <button type="button" className={btnPrimary} onClick={() => setEditing('new')}>＋ {T('新建任務', 'New task')}</button>
        </div>
        {data.tasks.length === 0 && <div className={`${card} text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary`}>{T('還沒有任務', 'No tasks yet')}</div>}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {data.tasks.map((t) => (
            <div key={t.id} className={card}>
              <div className="flex items-center gap-2 mb-1">
                <span>{SCRIPTS[t.script_id]?.icon || '📋'}</span>
                <span className="font-medium dark:text-claude-darkText text-claude-text flex-1 truncate">{t.name || (SCRIPTS[t.script_id] ? T(SCRIPTS[t.script_id].zh, SCRIPTS[t.script_id].en) : t.script_id)}</span>
                {t.enabled ? <Pill color="purple">{T('定時', 'Daily')}</Pill> : <Pill color="gray">{T('手動', 'Manual')}</Pill>}
              </div>
              <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-3">
                {[whereOf(t)[0]?.replace('https://www.tiktok.com/', ''), T({ low: '少', mid: '中', high: '多' }[levelOf(t) as 'low'] || '中', ({ low: 'Few', mid: 'Normal', high: 'Many' } as Record<string, string>)[levelOf(t)] || 'Normal'), t.enabled ? t.slots.join(' / ') : ''].filter(Boolean).join('  ·  ')}
              </p>
              <div className="flex gap-2">
                <button type="button" className={btnPrimary} onClick={() => command('run', t.id)}>▶ {T('運行', 'Run')}</button>
                <button type="button" className={btnGhost} onClick={() => command('dry_run', t.id)}>{T('試跑', 'Dry run')}</button>
                <button type="button" className={btnGhost} onClick={() => setEditing(t)}>{T('編輯', 'Edit')}</button>
                <button type="button" className={`${btnGhost} text-red-500`} onClick={() => { if (window.confirm(T('刪除這個任務？', 'Delete this task?'))) saveTasks(data.tasks.filter((x) => x.id !== t.id)); }}>{T('刪除', 'Delete')}</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold dark:text-claude-darkText text-claude-text mb-2">{T('運行記錄', 'Runs')}</h3>
        <div className={`${card} p-0 overflow-hidden`}>
          {data.runs.length === 0 && <div className="p-4 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">{T('暫無記錄', 'No runs yet')}</div>}
          {data.runs.map((r) => (
            <button key={r.run_id} type="button" onClick={() => openLogs(r)}
              className="w-full flex items-center gap-3 px-4 py-2.5 text-left text-sm border-b last:border-b-0 dark:border-claude-darkBorder border-claude-border hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover">
              <span className="w-28 shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary">{fmtTime(r.at)}</span>
              <span className="w-40 shrink-0 truncate dark:text-claude-darkText text-claude-text">{taskName(r.task_id) || '—'}{r.dry_run ? T('（試跑）', ' (dry)') : ''}</span>
              <span className="flex-1 dark:text-claude-darkText text-claude-text">{fmtCounts(r.counts)}</span>
              {r.status === 'done' ? <Pill color="green">{T('完成', 'Done')}</Pill>
                : r.status === 'stopped' ? <Pill color="gray">{T('已停止', 'Stopped')}</Pill>
                : <Pill color="red">{r.reason || r.status}</Pill>}
            </button>
          ))}
        </div>
      </div>

      {editing && (
        <TaskEditor initial={editing === 'new' ? null : editing} onCancel={() => setEditing(null)}
          onSave={(t) => { const list = data.tasks.some((x) => x.id === t.id) ? data.tasks.map((x) => (x.id === t.id ? t : x)) : [...data.tasks, t]; setEditing(null); saveTasks(list); }} />
      )}
      {logs && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setLogs(null)}>
          <div className={`${card} w-[640px] max-h-[80vh] overflow-y-auto`} onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold dark:text-claude-darkText text-claude-text mb-3">{fmtTime(logs.run.at)} · {fmtCounts(logs.run.counts)}</h3>
            {logs.lines.length === 0 && <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">{T('暫無日誌', 'No log lines')}</p>}
            {logs.lines.map((l, i) => (
              <div key={i} className={`text-xs font-mono py-0.5 ${l.level === 'error' ? 'text-red-500' : l.level === 'warn' ? 'text-amber-500' : 'dark:text-claude-darkText text-claude-text'}`}>
                <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary mr-2">{new Date(l.ts).toLocaleTimeString()}</span>{l.msg}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// ───────────────────────── phone list ─────────────────────────
const MyPhonesView: React.FC = () => {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [err, setErr] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(() => { api('/devices').then((r) => { setDevices(r.devices || []); setErr(''); }).catch((e) => setErr(e.message)); }, []);
  useEffect(() => { if (openId) return; load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, [load, openId]);

  if (openId) return <div className="h-full overflow-y-auto"><PhoneDetail id={openId} onBack={() => setOpenId(null)} /></div>;

  return (
    <div className="h-full overflow-y-auto p-6">
      <h2 className="text-lg font-semibold dark:text-claude-darkText text-claude-text mb-4">📱 {T('雲手機', 'Cloud Phones')}</h2>
      {err && <div className="text-sm text-red-500 mb-3">{err}</div>}
      {devices && devices.length === 0 && (
        <div className={`${card} text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary`}>
          {T('還沒有手機。在安卓手機上安裝 NoobClaw Mobile，用這個帳號登錄後會出現在這裡。', 'No phones yet. Install NoobClaw Mobile on an Android phone and log in with this account.')}
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {(devices || []).map((d) => (
          <button key={d.id} type="button" onClick={() => setOpenId(d.id)} className={`${card} text-left hover:border-claude-accent transition-colors`}>
            <div className="flex items-center gap-2 mb-2">
              <span className="font-medium dark:text-claude-darkText text-claude-text flex-1 truncate">📱 {d.vendor || d.id.slice(0, 8)}</span>
              {deviceStatus(d)}
            </div>
            <div className="text-sm dark:text-claude-darkText text-claude-text mb-1">{d.account || 'TikTok'}</div>
            <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary space-y-0.5">
              <div>{T('今天：', 'Today: ')}{fmtCounts(d.today)}</div>
              <div>{T('最近：', 'Last run: ')}{d.last_run ? `${fmtTime(d.last_run.at)} · ${d.last_run.status === 'done' ? T('完成', 'done') : d.last_run.reason || d.last_run.status}` : '—'}</div>
              <div>{T('任務：', 'Tasks: ')}{d.task_count}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
};

export default MyPhonesView;
