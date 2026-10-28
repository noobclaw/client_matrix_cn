/**
 * MatrixFolderPostWizard — 矩阵「抖音 · 文件夹定时发布」向导(type='folder_post',2026-10-28)。
 *
 * 用户把准备好的素材(视频 / 图片)、文案、话题按顺序放进每个号的时段文件夹,到点客户端自己按顺序取下一条发
 * (不用抖音自带定时)。图文从账号「我的收藏」音乐前 3 首随机配 BGM;视频用原声。
 *   Step 1 — 勾执行账号
 *   Step 2 — 账号横排,点一个号:设它 3 个时段(开关 + 时间),看每个时段文件夹里还剩多少,能直接打开文件夹
 *   Step 3 — 发布时间随机浮动 + 摘要
 */

import React, { useEffect, useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { AccountTabRow, accountAvatar, type KwAccount } from './MatrixAccountKeywords';

type WizardStep = 1 | 2 | 3;
export interface FolderSlot { time: string; on: boolean }
export interface WizardAccount { id: string; displayName: string; status: string; keywords?: string[]; group?: string; platform?: string; nickname?: string; displayId?: string; avatar?: string }
interface SlotStat { n: number; dir: string; media: number; videos: number; imageSets: number; captions: number; topics: number }

const DEFAULT_SLOTS: FolderSlot[] = [{ time: '08:30', on: true }, { time: '12:30', on: true }, { time: '19:30', on: true }];
const L = (zh: string, tw: string, en: string): string => {
  const lang = i18nService.currentLanguage;
  return lang === 'zh' ? zh : lang === 'zh-TW' ? tw : en;
};
const validTime = (t: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t);

interface Props {
  platformLabel: string;
  platform?: string;
  accounts: WizardAccount[];
  accountsLoading?: boolean;
  initialTask?: any | null;
  onCancel: () => void;
  onSave: (input: { name: string; accountIds: string[]; folderPost: { slotsByAccount: Record<string, FolderSlot[]>; jitterMin: number } }) => Promise<void> | void;
}

const MatrixFolderPostWizard: React.FC<Props> = ({ platformLabel, platform, accounts, accountsLoading, initialTask, onCancel, onSave }) => {
  const editing = !!initialTask;
  const [step, setStep] = useState<WizardStep>(1);
  const [selected, setSelected] = useState<Set<string>>(() => new Set<string>((initialTask?.accountIds || []).map(String)));
  const [slots, setSlots] = useState<Record<string, FolderSlot[]>>(() => {
    const src = initialTask?.folderPost?.slotsByAccount || {};
    const out: Record<string, FolderSlot[]> = {};
    for (const k of Object.keys(src)) out[k] = (src[k] || []).slice(0, 3).map((s: any) => ({ time: String(s?.time || ''), on: !!s?.on }));
    return out;
  });
  const [jitterMin, setJitterMin] = useState<number>(() => (typeof initialTask?.folderPost?.jitterMin === 'number' ? initialTask.folderPost.jitterMin : 15));
  const [activeAcc, setActiveAcc] = useState<string | null>(null);
  const [stats, setStats] = useState<Record<string, { dir: string; slots: SlotStat[] }>>({});
  const [root, setRoot] = useState('');
  const [statsLoading, setStatsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => { if (saveError) setSaveError(null); /* eslint-disable-next-line */ }, [selected, slots, jitterMin]);

  const linked = (a: WizardAccount) => a.status !== 'banned' && a.status !== 'login_required';
  const readyAccounts = accounts.filter(linked);
  const selectedAccounts = useMemo(() => accounts.filter((a) => selected.has(a.id)), [accounts, selected]);
  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const slotsOf = (id: string): FolderSlot[] => (slots[id] && slots[id].length === 3 ? slots[id] : DEFAULT_SLOTS);
  const setSlot = (id: string, i: number, patch: Partial<FolderSlot>) => setSlots((prev) => {
    const cur = (prev[id] && prev[id].length === 3 ? prev[id] : DEFAULT_SLOTS).map((s) => ({ ...s }));
    cur[i] = { ...cur[i], ...patch };
    return { ...prev, [id]: cur };
  });

  // 建好文件夹 + 读每个时段剩多少(第 2 步进来时、点「刷新」时)
  const refreshStats = async () => {
    const ids = Array.from(selected);
    if (!ids.length) return;
    setStatsLoading(true);
    try {
      const r = await (window as any).electron?.matrix?.folderPostStatus?.({ accountIds: ids });
      if (r?.ok) {
        setRoot(String(r.root || ''));
        const m: Record<string, { dir: string; slots: SlotStat[] }> = {};
        for (const a of (r.accounts || [])) if (a && !a.missing) m[a.id] = { dir: a.dir, slots: a.slots || [] };
        setStats(m);
      }
    } catch { /* ignore */ } finally { setStatsLoading(false); }
  };
  useEffect(() => { if (step === 2) void refreshStats(); /* eslint-disable-next-line */ }, [step]);
  const openDir = (p?: string) => { if (p) { try { (window as any).electron?.shell?.openPath?.(p); } catch { /* ignore */ } } };

  const enabledCount = (id: string) => slotsOf(id).filter((s) => s.on).length;
  const badTime = selectedAccounts.some((a) => slotsOf(a.id).some((s) => s.on && !validTime(s.time)));
  const totalPerDay = selectedAccounts.reduce((s, a) => s + enabledCount(a.id), 0);
  // 现有素材够发几天:每个开着的时段一天用一条,取最短的那个
  const daysLeft = (() => {
    let min = Infinity;
    for (const a of selectedAccounts) slotsOf(a.id).forEach((s, i) => { if (s.on) { const st = stats[a.id]?.slots?.[i]; if (st) min = Math.min(min, st.media); } });
    return Number.isFinite(min) ? min : null;
  })();

  const canAdvance: Record<WizardStep, { ok: boolean; reason?: string }> = {
    1: { ok: selected.size > 0, reason: L('请至少选 1 个账号', '請至少選 1 個帳號', 'Select at least one account') },
    2: totalPerDay === 0
      ? { ok: false, reason: L('至少给一个账号开一个时段', '至少給一個帳號開一個時段', 'Turn on at least one time slot') }
      : badTime ? { ok: false, reason: L('时间格式不对,请选 HH:MM', '時間格式不對,請選 HH:MM', 'Invalid time, use HH:MM') } : { ok: true },
    3: { ok: true },
  };

  const handleSave = async () => {
    if (saving) return;
    for (const s of [1, 2, 3] as WizardStep[]) { if (!canAdvance[s].ok) { setSaveError(canAdvance[s].reason || ''); setStep(s); return; } }
    setSaving(true);
    try {
      const slotsByAccount: Record<string, FolderSlot[]> = {};
      for (const a of selectedAccounts) slotsByAccount[a.id] = slotsOf(a.id);
      await onSave({
        name: initialTask?.name || L(`${platformLabel} 文件夹定时发布`, `${platformLabel} 資料夾定時發布`, `${platformLabel} Folder Scheduled Posts`),
        accountIds: Array.from(selected),
        folderPost: { slotsByAccount, jitterMin },
      });
    } catch (err) {
      setSaveError(String(err instanceof Error ? err.message : err) || L('保存失败', '儲存失敗', 'Save failed'));
    } finally { setSaving(false); }
  };

  return (
    <div className="w-full max-w-2xl max-h-[90vh] mx-auto rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden flex flex-col">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800 shrink-0">
        <div className="text-base font-semibold dark:text-white">📅 {editing ? L('编辑', '編輯', 'Edit') + ' · ' : ''}{platformLabel} · {L('文件夹定时发布', '資料夾定時發布', 'Folder Scheduled Posts')}</div>
        <div className="flex items-center gap-3">
          <span className="text-xs px-2.5 py-1 rounded-full border border-teal-500/40 text-teal-500 bg-teal-500/5">{L(`第 ${step}/3 步`, `第 ${step}/3 步`, `Step ${step}/3`)}</span>
          <button type="button" onClick={onCancel} disabled={saving} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">✕</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
        {step === 1 && (
          <>
            <div className="rounded-lg border px-3 py-2 text-[11px] leading-relaxed border-teal-500/30 bg-teal-500/5 text-teal-700 dark:text-teal-300">
              📅 {L('每个号有 3 个时段文件夹,你把准备好的素材(视频或图片)、文案、话题按顺序放进去,到点软件自动取下一条拼成帖子发出去,发完的挪进「已发布」。图文从账号「我的收藏」音乐前 3 首随机配背景音乐,视频用原声。客户端开着才会发。',
                '每個帳號有 3 個時段資料夾,你把準備好的素材(影片或圖片)、文案、話題按順序放進去,到點軟體自動取下一條拼成貼文發出去,發完的移進「已發布」。圖文從帳號「我的收藏」音樂前 3 首隨機配背景音樂,影片用原聲。客戶端開著才會發。',
                'Each account has 3 time-slot folders. Put your media (video or images), captions and topics in order; at each slot time the app posts the next one and moves it to "已发布". Image posts get a random track from the account\'s top-3 favorite music; videos keep their audio. The app must be running.')}
            </div>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                {L(`选择账号(${platformLabel},可多选)`, `選擇帳號(${platformLabel},可多選)`, `Accounts (${platformLabel})`)}
                <span className="text-xs text-gray-400 font-normal ml-1">{L(`已选 ${selected.size} 个`, `已選 ${selected.size} 個`, `${selected.size} selected`)}</span>
                {readyAccounts.length > 0 && (
                  <button type="button" className="ml-2 text-xs text-teal-500 hover:underline" onClick={() => setSelected(selected.size === readyAccounts.length ? new Set() : new Set(readyAccounts.map((a) => a.id)))}>
                    {selected.size === readyAccounts.length ? L('全不选', '全不選', 'Clear') : L('全选', '全選', 'Select all')}
                  </button>
                )}
              </label>
              <div className="space-y-1.5 max-h-72 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700 p-2">
                {accounts.length === 0 && accountsLoading && <div className="p-3 text-center text-xs text-gray-400">{L('账号加载中…', '帳號載入中…', 'Loading accounts…')}</div>}
                {accounts.length === 0 && !accountsLoading && (
                  <div className="p-3 text-center space-y-2.5">
                    <div className="text-xs text-gray-400">{L(`还没有 ${platformLabel} 账号`, `還沒有 ${platformLabel} 帳號`, `No ${platformLabel} accounts yet`)}</div>
                    <button type="button" onClick={() => { window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform } })); onCancel(); }} className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-white text-sm font-semibold bg-teal-500 hover:bg-teal-600 active:scale-95">{L('去添加账号', '去新增帳號', 'Add an account')}</button>
                  </div>
                )}
                {accounts.map((a) => {
                  const ready = linked(a);
                  const title = a.nickname || a.displayName;
                  return (
                    <label key={a.id} className={`flex items-center gap-2.5 text-sm px-2 py-1.5 rounded ${ready ? 'dark:text-gray-200 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800' : 'opacity-45 cursor-not-allowed'}`}>
                      <input type="checkbox" checked={selected.has(a.id)} onChange={() => ready && toggle(a.id)} disabled={saving || !ready} className="h-4 w-4 accent-teal-500 shrink-0" />
                      {accountAvatar(a as KwAccount, 'emerald')}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="font-medium truncate dark:text-white">{title}</span>
                          {a.displayId && <span className="text-[11px] text-gray-500 dark:text-gray-400 shrink-0">{L('抖音号:', '抖音號:', 'ID: ')}{a.displayId}</span>}
                          {!ready && <span className="text-[11px] text-amber-500 shrink-0">{a.status === 'banned' ? L('已封禁', '已封鎖', 'banned') : L('掉线,需重新登录', '離線,需重新登入', 'logged out')}</span>}
                        </div>
                        <div className="text-[11px] text-gray-400 truncate">{a.displayName}{a.group ? ` · ${a.group}` : ''}</div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {step === 2 && (() => {
          const cur = selectedAccounts.find((a) => a.id === activeAcc) || selectedAccounts[0];
          if (!cur) return null;
          const st = stats[cur.id];
          return (
            <>
              <div className="rounded-lg border px-3 py-2 text-[11px] leading-relaxed border-teal-500/30 bg-teal-500/5 text-teal-700 dark:text-teal-300 space-y-1">
                <div>📁 {L('点上面的账号设它的发布时间。每个时段文件夹里有「素材 / 文案 / 话题」3 个文件夹,都按文件名顺序用(建议 01、02、03 编号):',
                  '點上面的帳號設它的發布時間。每個時段資料夾裡有「素材 / 文案 / 話題」3 個資料夾,都按檔名順序用(建議 01、02、03 編號):',
                  'Pick an account above to set its post times. Each slot folder has 3 sub-folders used in file-name order (number them 01, 02, 03):')}</div>
                <div>· {L('素材:一个视频文件 = 一条视频;一张图片,或一个装着几张图的子文件夹 = 一条图文(最多 35 张)', '素材:一個影片檔 = 一條影片;一張圖片,或一個裝著幾張圖的子資料夾 = 一條圖文(最多 35 張)', 'media: one video file = one video post; one image, or a sub-folder of images = one image post (max 35)')}</div>
                <div>· {L('文案:一个 .txt = 一条,第一行是标题(图文 20 字、视频 30 字以内),下面是正文', '文案:一個 .txt = 一條,第一行是標題(圖文 20 字、影片 30 字以內),下面是正文', 'captions: one .txt each — first line = title (≤20 chars images, ≤30 video), rest = body')}</div>
                <div>· {L('话题:一个 .txt = 一组,一行一个,最多用 5 个', '話題:一個 .txt = 一組,一行一個,最多用 5 個', 'topics: one .txt per post, one per line, up to 5')}</div>
              </div>

              <AccountTabRow
                accounts={selectedAccounts as KwAccount[]}
                activeId={cur.id}
                onPick={setActiveAcc}
                accent="emerald"
                disabled={saving}
                badge={(a) => { const n = enabledCount(a.id); return n ? { t: L(`每天 ${n} 条`, `每天 ${n} 條`, `${n}/day`), warn: false } : { t: L('没开时段', '沒開時段', 'off'), warn: true }; }}
              />

              <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-3 space-y-2.5">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-medium text-sm truncate dark:text-white">{cur.nickname || cur.displayName}</span>
                  <button type="button" onClick={() => openDir(st?.dir)} disabled={!st?.dir} className="ml-auto text-[11px] text-teal-600 dark:text-teal-400 hover:underline disabled:opacity-40 shrink-0">📂 {L('打开这个号的文件夹', '打開這個帳號的資料夾', 'Open folder')}</button>
                  <button type="button" onClick={() => void refreshStats()} disabled={statsLoading} className="text-[11px] text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 shrink-0">{statsLoading ? L('读取中…', '讀取中…', 'Loading…') : '🔄 ' + L('刷新', '重新整理', 'Refresh')}</button>
                </div>
                {slotsOf(cur.id).map((s, i) => {
                  const ss = st?.slots?.[i];
                  return (
                    <div key={i} className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${s.on ? 'border-teal-500/40 bg-teal-500/5' : 'border-gray-200 dark:border-gray-700'}`}>
                      <label className="flex items-center gap-2 text-sm dark:text-gray-200 shrink-0 cursor-pointer">
                        <input type="checkbox" checked={s.on} onChange={(e) => setSlot(cur.id, i, { on: e.target.checked })} disabled={saving} className="h-4 w-4 accent-teal-500" />
                        {L(`时段${i + 1}`, `時段${i + 1}`, `Slot ${i + 1}`)}
                      </label>
                      <input type="time" value={s.time} onChange={(e) => setSlot(cur.id, i, { time: e.target.value })} disabled={saving || !s.on}
                        className={`rounded-md border px-2 py-1 text-sm bg-white dark:bg-gray-800 dark:text-white ${s.on && !validTime(s.time) ? 'border-red-500' : 'border-gray-300 dark:border-gray-700'} disabled:opacity-50`} />
                      <div className="flex-1 min-w-0 text-[11px] text-gray-500 dark:text-gray-400 truncate">
                        {ss
                          ? <>{L('素材', '素材', 'media')} <b className={ss.media ? 'text-gray-700 dark:text-gray-200' : 'text-amber-500'}>{ss.media}</b>{ss.media ? L(`(视频 ${ss.videos} · 图文 ${ss.imageSets})`, `(影片 ${ss.videos} · 圖文 ${ss.imageSets})`, ` (${ss.videos} video · ${ss.imageSets} image)`) : ''} · {L('文案', '文案', 'captions')} <b className={ss.captions ? 'text-gray-700 dark:text-gray-200' : 'text-amber-500'}>{ss.captions}</b> · {L('话题', '話題', 'topics')} {ss.topics}</>
                          : L('读取中…', '讀取中…', 'loading…')}
                      </div>
                      <button type="button" onClick={() => openDir(ss?.dir)} disabled={!ss?.dir} className="text-[11px] text-teal-600 dark:text-teal-400 hover:underline disabled:opacity-40 shrink-0">📂 {L('打开', '打開', 'Open')}</button>
                    </div>
                  );
                })}
                {selectedAccounts.length > 1 && (
                  <button type="button" disabled={saving} onClick={() => setSlots((prev) => { const n = { ...prev }; for (const b of selectedAccounts) n[b.id] = slotsOf(cur.id).map((x) => ({ ...x })); return n; })}
                    className="text-[11px] text-teal-600 dark:text-teal-400 hover:underline">{L('把这个号的时段复制到其他账号', '把這個帳號的時段複製到其他帳號', 'Copy these slots to all accounts')}</button>
                )}
              </div>
              {root && <div className="text-[11px] text-gray-400 break-all">{L('所有账号的文件夹都在:', '所有帳號的資料夾都在:', 'All folders live in: ')}{root}</div>}
            </>
          );
        })()}

        {step === 3 && (
          <>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">{L('发布时间随机浮动', '發布時間隨機浮動', 'Random offset')}</label>
              <div className="flex gap-2 flex-wrap">
                {[0, 5, 10, 15, 30].map((v) => (
                  <button key={v} type="button" onClick={() => setJitterMin(v)} className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${jitterMin === v ? 'border-teal-500 bg-teal-500/10 text-teal-600 dark:text-teal-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-teal-500/50'}`}>
                    {v === 0 ? L('准点发', '準點發', 'On time') : L(`前后 ${v} 分钟`, `前後 ${v} 分鐘`, `±${v} min`)}
                  </button>
                ))}
              </div>
              <div className="text-[11px] text-gray-400 mt-1">{L('每个号每天的发布时间会在设定时间前后随机一点,更像真人。', '每個帳號每天的發布時間會在設定時間前後隨機一點,更像真人。', 'Each day the time shifts a little around the set time.')}</div>
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-4 py-3 text-sm space-y-1.5">
              <div className="font-semibold dark:text-gray-200 mb-1">{L('任务摘要', '任務摘要', 'Summary')}</div>
              <SummaryRow label={L('账号', '帳號', 'Accounts')} value={L(`${selected.size} 个`, `${selected.size} 個`, `${selected.size}`)} />
              <SummaryRow label={L('每天', '每天', 'Per day')} value={L(`共 ${totalPerDay} 条`, `共 ${totalPerDay} 條`, `${totalPerDay} posts`)} />
              {selectedAccounts.map((a) => (
                <SummaryRow key={a.id} label={a.nickname || a.displayName} value={slotsOf(a.id).filter((s) => s.on).map((s) => s.time).join(' / ') || L('没开时段', '沒開時段', 'off')} />
              ))}
              {daysLeft !== null && <SummaryRow label={L('现有素材', '現有素材', 'Media now')} value={daysLeft > 0 ? L(`够发 ${daysLeft} 天(按最少的那个时段算)`, `夠發 ${daysLeft} 天(按最少的那個時段算)`, `enough for ${daysLeft} day(s)`) : L('有时段还没放素材,到点会跳过', '有時段還沒放素材,到點會跳過', 'some slots are empty and will be skipped')} />}
              <SummaryRow label={L('补发', '補發', 'Catch-up')} value={L('到点时电脑没开 / 正在跑别的抖音任务,3 小时内补发,超过就算错过', '到點時電腦沒開 / 正在跑別的抖音任務,3 小時內補發,超過就算錯過', 'missed slots are posted within 3 hours, otherwise skipped')} />
              <SummaryRow label={L('计费', '計費', 'Billing')} value={L('每成功发出一条按「发帖」计费', '每成功發出一條按「發帖」計費', 'charged per successful post')} />
            </div>
          </>
        )}
      </div>

      {saveError && (
        <div className="px-6 pt-2 pb-1 shrink-0">
          <div className="rounded-lg border px-3 py-2 text-xs leading-relaxed border-red-500/30 bg-red-500/5 text-red-600 dark:text-red-400">❌ {saveError}</div>
        </div>
      )}

      <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-800 flex items-center gap-2 shrink-0">
        <button type="button" onClick={onCancel} disabled={saving} className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 px-2">{L('取消', '取消', 'Cancel')}</button>
        <div className="flex-1" />
        {step > 1 && <button type="button" onClick={() => setStep((step - 1) as WizardStep)} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50">{L('上一步', '上一步', 'Back')}</button>}
        {step < 3 ? (
          <button type="button" onClick={() => { if (!canAdvance[step].ok) { setSaveError(canAdvance[step].reason || ''); return; } setSaveError(null); setStep((step + 1) as WizardStep); }} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-semibold bg-teal-500 text-white hover:bg-teal-600 disabled:opacity-50">{L('下一步', '下一步', 'Next')}</button>
        ) : (
          <button type="button" onClick={handleSave} disabled={saving} className="px-5 py-2 rounded-lg text-sm font-semibold bg-teal-500 text-white hover:bg-teal-600 disabled:opacity-50">{saving ? L('保存中…', '儲存中…', 'Saving…') : (editing ? L('保存修改', '儲存修改', 'Save') : L('创建任务', '建立任務', 'Create task'))}</button>
        )}
      </div>
    </div>
  );
};

const SummaryRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex gap-3 text-xs"><span className="text-gray-500 dark:text-gray-400 shrink-0 w-24 truncate">{label}</span><span className="text-gray-800 dark:text-gray-200 break-all">{value}</span></div>
);

export default MatrixFolderPostWizard;
