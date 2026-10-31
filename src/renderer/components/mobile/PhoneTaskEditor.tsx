import React, { useState } from 'react';
import {
  Device, L, LEVELS, RawTask, SCRIPT_IDS, Schedule, ScriptId, TaskView, bd, btnGhost, btnPrimary, capsText, errText, isLead,
  saveTask, scriptShort, scriptName, sub, surface, txt,
} from './cloudPhoneShared';

/**
 * Create / edit the TikTok task of one phone (one task per platform). Saves the phone's full task list via
 * PUT /devices/:id/tasks; fields of the existing task that the editor does not show are kept from `raw`.
 */

type Level = 'low' | 'mid' | 'high';
type SchedKey = '0.5' | '1' | '3' | '6' | 'daily' | 'manual';

const SCHEDULES: { k: SchedKey; label: () => string }[] = [
  { k: '0.5', label: () => L('每30分钟', '每30分鐘', 'Every 30 min') },
  { k: '1', label: () => L('每1小时', '每1小時', 'Every 1 h') },
  { k: '3', label: () => L('每3小时', '每3小時', 'Every 3 h') },
  { k: '6', label: () => L('每6小时', '每6小時', 'Every 6 h') },
  { k: 'daily', label: () => L('每天定时', '每天定時', 'Daily at') },
  { k: 'manual', label: () => L('手动', '手動', 'Manual') },
];

function schedKeyOf(s: Schedule | null | undefined): SchedKey {
  if (!s) return '3';
  if (s.kind === 'manual') return 'manual';
  if (s.kind === 'daily') return 'daily';
  const h = String(s.hours);
  return (['0.5', '1', '3', '6'] as string[]).includes(h) ? (h as SchedKey) : '3';
}
function toSchedule(k: SchedKey, at: string): Schedule {
  if (k === 'manual') return { kind: 'manual' };
  if (k === 'daily') return { kind: 'daily', at };
  return { kind: 'every', hours: Number(k) };
}
const splitList = (s: string): string[] => Array.from(new Set(s.split(/[\n,，、]/).map((x) => x.trim()).filter(Boolean)));
/** Level stored on the task; null = custom caps (no level) — those are kept unless the user picks a level. */
const levelOf = (t: TaskView | null): Level | null => {
  if (!t) return 'mid';
  const lv = (t.raw?.config as { level?: string } | undefined)?.level || t.level;
  return lv === 'low' || lv === 'mid' || lv === 'high' ? lv : null;
};
/** The server keeps only these video links (normalizeTask). */
const TIKTOK_URL = /^https:\/\/(www\.|m\.|vm\.|vt\.)?tiktok\.com\/\S+$/i;
/** "@user" / "user" → profile URL, missing scheme → https://, http → https. */
function normalizeLink(x: string): string {
  const v = x.trim();
  if (v.startsWith('@')) return `https://www.tiktok.com/${v}`;
  if (/^http:\/\//i.test(v)) return v.replace(/^http:\/\//i, 'https://');
  if (/^https:\/\//i.test(v)) return v;
  if (!/[./]/.test(v)) return `https://www.tiktok.com/@${v}`;
  return `https://${v.replace(/^\/+/, '')}`;
}

const PhoneTaskEditor: React.FC<{ device: Device; initial: TaskView | null; onCancel: () => void; onSaved: (msg: string) => void }> = ({ device, initial, onCancel, onSaved }) => {
  const [script, setScript] = useState<ScriptId>((SCRIPT_IDS as readonly string[]).includes(initial?.script_id || '') ? (initial!.script_id as ScriptId) : 'tiktok_comment_like');
  const [mode, setMode] = useState<'keywords' | 'precise'>(initial?.mode === 'precise' ? 'precise' : 'keywords');
  const [keywords, setKeywords] = useState((initial?.keywords || []).join('\n'));
  const [targets, setTargets] = useState((initial?.targets || []).join('\n'));
  const [level, setLevel] = useState<Level | null>(() => levelOf(initial));
  const [levelTouched, setLevelTouched] = useState(false);
  const [sched, setSched] = useState<SchedKey>(schedKeyOf(initial?.schedule));
  const [at, setAt] = useState(() => { const s = initial?.schedule; return s && s.kind === 'daily' ? s.at : '09:30'; });
  const [persona, setPersona] = useState(initial?.persona || '');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const lead = isLead(script);
  // Level table applies to new tasks, a changed script, or once the user picks a level; otherwise the
  // task's current caps (possibly custom, set on the phone) are kept as they are.
  const useTable = !initial || levelTouched || initial.script_id !== script;
  const caps = useTable ? LEVELS[script][level || 'mid'] : initial.caps;
  const custom = !useTable && !level;
  const pickLevel = (k: Level) => { setLevel(k); setLevelTouched(true); };

  const save = async () => {
    const kw = splitList(keywords);
    let tg = splitList(targets);
    if (lead) tg = tg.map((x) => (/^https?:/i.test(x) || x.startsWith('@') ? x : `@${x}`));
    else {
      const raw = tg;
      tg = raw.map(normalizeLink);
      const bad = raw.filter((_, i) => !TIKTOK_URL.test(tg[i]));
      tg = tg.filter((x) => TIKTOK_URL.test(x));
      if (mode === 'precise' && bad.length) {
        setErr(L('这些不是 TikTok 作品链接：', '這些不是 TikTok 作品連結：', 'Not TikTok video links: ') + bad.join('、'));
        return;
      }
    }
    if (mode === 'keywords' && !kw.length) { setErr(L('请填写关键词', '請填寫關鍵詞', 'Enter at least one keyword')); return; }
    if (mode === 'precise' && !tg.length) { setErr(lead ? L('请填写同行账号', '請填寫同行帳號', 'Enter at least one rival account') : L('请填写作品链接', '請填寫作品連結', 'Enter at least one video link')); return; }
    if (sched === 'daily' && !/^\d{2}:\d{2}$/.test(at)) { setErr(L('请选择每天运行的时间', '請選擇每天運行的時間', 'Pick a time of day')); return; }

    const prev = initial?.raw;
    const sameScript = !!prev && prev.script_id === script;
    const prevCfg: Record<string, unknown> = sameScript ? { ...(prev!.config || {}) } : {};
    const config: Record<string, unknown> = { ...prevCfg };
    if (useTable) config.level = level || 'mid';
    if (lead) {
      if (useTable) config.leads_per_run = caps.leads;
      Object.assign(config, {
        mode: mode === 'precise' ? 'accounts' : 'keywords', keywords: kw, seed_accounts: tg,
        lead_do_like: prevCfg.lead_do_like !== false, lead_do_follow: prevCfg.lead_do_follow !== false, lead_do_comment: prevCfg.lead_do_comment !== false,
      });
    } else {
      Object.assign(config, {
        comment_mode: mode, keywords: kw, urls: tg,
        cl_do_like: prevCfg.cl_do_like !== false, cl_do_reply: prevCfg.cl_do_reply !== false,
      });
    }
    const task: RawTask = {
      ...(prev || {}),
      id: prev?.id || initial?.id || 't' + Date.now().toString(36),
      name: sameScript && prev?.name ? prev.name : scriptName(script),
      script_id: script,
      platform: 'tiktok',
      schedule: toSchedule(sched, at),
      // A daily time picked here means this computer's local time (old tasks often carry tz 'UTC').
      tz: sched === 'daily' || !prev?.tz ? Intl.DateTimeFormat().resolvedOptions().timeZone : prev.tz,
      ...(useTable ? { max_likes: caps.likes, max_comments: caps.comments, max_follows: caps.follows } : {}),
      persona: persona.trim().slice(0, 400),
      config,
    };
    // Legacy fields are re-derived by the server from `schedule` (for old phone apps).
    delete task.enabled;
    delete task.slots;

    setSaving(true); setErr('');
    try {
      await saveTask(device, task);
      onSaved(L('已保存，手机 1 分钟内同步', '已儲存，手機 1 分鐘內同步', 'Saved — the phone syncs within a minute'));
    } catch (e) {
      setErr(L('保存失败：', '儲存失敗：', 'Save failed: ') + errText(e));
    } finally {
      setSaving(false);
    }
  };

  const chip = (on: boolean) => `px-3 py-1.5 rounded-lg text-[12.5px] font-semibold border transition-colors ${on ? 'bg-claude-accent border-claude-accent text-[#04140c]' : `${bd} ${txt} hover:border-claude-accent/60`}`;
  const label = `text-xs font-semibold ${sub} mb-1.5 block`;
  const input = `w-full rounded-lg border ${bd} dark:bg-claude-darkSurfaceInset bg-claude-surfaceInset px-3 py-2 text-sm ${txt} outline-none focus:border-claude-accent`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className={`w-full max-w-[480px] max-h-[90vh] overflow-y-auto rounded-2xl border ${bd} ${surface} p-5 shadow-modal`}>
        <h3 className={`text-base font-bold ${txt} mb-1`}>{initial ? L('编辑任务', '編輯任務', 'Edit task') : L('创建任务', '建立任務', 'Create task')}</h3>
        <p className={`text-xs ${sub} mb-4`}>TikTok · {device.vendor || device.id}</p>

        <span className={label}>{L('任务类型', '任務類型', 'Task type')}</span>
        <div className="flex gap-2 mb-4">
          {SCRIPT_IDS.map((id) => (
            <button key={id} type="button" className={`${chip(script === id)} flex-1`} onClick={() => setScript(id)}>{isLead(id) ? '🎯' : '💬'} {scriptShort(id)}</button>
          ))}
        </div>

        <span className={label}>{L('模式', '模式', 'Mode')}</span>
        <div className="flex gap-2 mb-2">
          <button type="button" className={`${chip(mode === 'keywords')} flex-1`} onClick={() => setMode('keywords')}>🔎 {L('关键词模式', '關鍵詞模式', 'Keyword mode')}</button>
          <button type="button" className={`${chip(mode === 'precise')} flex-1`} onClick={() => setMode('precise')}>🎯 {L('精准模式', '精準模式', 'Precise mode')}</button>
        </div>
        {mode === 'keywords' ? (
          <textarea className={`${input} mb-4`} rows={3} value={keywords} onChange={(e) => setKeywords(e.target.value)}
            placeholder={L('每行一个关键词，例如 latte art', '每行一個關鍵詞，例如 latte art', 'One keyword per line, e.g. latte art')} />
        ) : (
          <textarea className={`${input} mb-4`} rows={3} value={targets} onChange={(e) => setTargets(e.target.value)}
            placeholder={lead
              ? L('每行一个同行账号，例如 @cafe_rival', '每行一個同行帳號，例如 @cafe_rival', 'One rival account per line, e.g. @cafe_rival')
              : L('每行一个 TikTok 作品链接', '每行一個 TikTok 作品連結', 'One TikTok video link per line')} />
        )}

        <span className={label}>{L('数量', '數量', 'Amount')}</span>
        <div className="flex gap-2 mb-1.5">
          {(['low', 'mid', 'high'] as const).map((k) => (
            <button key={k} type="button" className={`${chip(!custom && (level || 'mid') === k)} flex-1`} onClick={() => pickLevel(k)}>
              {k === 'low' ? L('少', '少', 'Few') : k === 'mid' ? L('中', '中', 'Normal') : L('多', '多', 'Many')}
            </button>
          ))}
        </div>
        <p className={`text-xs ${sub} mb-4`}>
          {custom && <span className="mr-1.5 px-1.5 py-0.5 rounded-md bg-amber-500/15 text-amber-500 dark:text-amber-400 font-semibold">{L('自定义', '自訂', 'Custom')}</span>}
          {L('每次上限：', '每次上限：', 'Per run: ')}{capsText(script, caps)}
          {custom && <span className="block mt-1">{L('保持手机上设置的数量；点 少/中/多 会改用对应数量', '保持手機上設定的數量；點 少/中/多 會改用對應數量', 'Keeps the amounts set on the phone; pick Few/Normal/Many to replace them')}</span>}
        </p>

        <span className={label}>{L('运行频率', '運行頻率', 'Schedule')}</span>
        <div className="grid grid-cols-3 gap-2 mb-2">
          {SCHEDULES.map((s) => (
            <button key={s.k} type="button" className={chip(sched === s.k)} onClick={() => setSched(s.k)}>{s.label()}</button>
          ))}
        </div>
        {sched === 'daily' && <input type="time" className={`${input} mb-2`} value={at} onChange={(e) => setAt(e.target.value)} />}
        <div className="mb-4" />

        <span className={label}>{L('人设（选填）', '人設（選填）', 'Persona (optional)')}</span>
        <input className={`${input} mb-4`} value={persona} maxLength={400} onChange={(e) => setPersona(e.target.value)}
          placeholder={L('例如：东京咖啡店店员，语气轻松', '例如：東京咖啡店店員，語氣輕鬆', 'e.g. a barista at a Tokyo coffee shop, relaxed tone')} />

        {err && <p className="text-sm text-[#ff5c7a] mb-3">{err}</p>}
        <div className="flex justify-end gap-2 mt-2">
          <button type="button" className={`${btnGhost} px-4 py-2 text-sm`} onClick={onCancel}>{L('取消', '取消', 'Cancel')}</button>
          <button type="button" className={`${btnPrimary} px-4 py-2 text-sm`} disabled={saving} onClick={save}>{saving ? L('保存中…', '儲存中…', 'Saving…') : L('保存', '儲存', 'Save')}</button>
        </div>
      </div>
    </div>
  );
};

export default PhoneTaskEditor;
