/**
 * MatrixCommentLikeWizard — 矩阵版「TikTok · 作品评论区点赞」向导(type='comment_like')。
 *
 * 对应后端 tiktok_comment_like 剧本:每个执行账号逐条打开用户粘贴的作品(视频/图文),
 * 打开评论区逐屏往下翻,给每位留言者的评论点赞,直到本号本次点赞上限或评论翻完。
 *
 *   Step 1 — 粘贴作品链接(每行 1 个,1-20 个)+ 每个账号本次最多点赞数(1-5000,默认 100)
 *   Step 2 — 选执行账号(可多选)
 *   Step 3 — 运行频率 + 摘要 + 条款
 *
 * 文案内联中/繁/英(同定向获客卡片的做法),不进 i18n 大表。
 */

import React, { useEffect, useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { NumBox } from './NumberStepper';

type WizardStep = 1 | 2 | 3;

export const COMMENT_LIKE_MAX_LINKS = 20;
export const COMMENT_LIKE_MAX_MIN = 1;
export const COMMENT_LIKE_MAX_MAX = 5000; // 和 main/libs/matrix/types.ts COMMENT_LIKE_LIMITS.maxMax 一致
export const COMMENT_LIKE_MAX_DEFAULT = 100;

export interface WizardAccount { id: string; displayName: string; status: string; keywords?: string[]; group?: string; platform?: string; nickname?: string; displayId?: string; avatar?: string }

const TIKTOK_LINK_RE = /^https?:\/\/([\w-]+\.)?tiktok\.com\//i;

/** zh / zh-TW / 其它语言(英文)三选一。 */
const L = (zh: string, tw: string, en: string): string => {
  const lang = i18nService.currentLanguage;
  return lang === 'zh' ? zh : lang === 'zh-TW' ? tw : en;
};

interface Props {
  platformLabel: string;
  platform?: string;
  accounts: WizardAccount[];
  accountsLoading?: boolean;
  initialTask?: any | null;
  onCancel: () => void;
  onSave: (input: { name: string; accountIds: string[]; concurrency: number; frequency: string; urls: string[]; commentLikeMax: number }) => Promise<void> | void;
}

const MatrixCommentLikeWizard: React.FC<Props> = ({ platformLabel, platform, accounts, accountsLoading, initialTask, onCancel, onSave }) => {
  const editing = !!initialTask;
  const [step, setStep] = useState<WizardStep>(1);

  const [linksText, setLinksText] = useState<string>(() => (Array.isArray(initialTask?.urls) ? initialTask.urls.join('\n') : ''));
  const parsedLinks = useMemo(() => linksText.split(/[\s\n]+/).map((s) => s.trim()).filter(Boolean), [linksText]);
  const validLinks = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const u of parsedLinks) { if (TIKTOK_LINK_RE.test(u) && !seen.has(u)) { seen.add(u); out.push(u); } }
    return out;
  }, [parsedLinks]);
  const badLinks = useMemo(() => parsedLinks.filter((u) => !TIKTOK_LINK_RE.test(u)), [parsedLinks]);
  const [maxLikes, setMaxLikes] = useState<number>(() => {
    const n = Number(initialTask?.commentLikeMax);
    return Number.isFinite(n) && n >= COMMENT_LIKE_MAX_MIN ? Math.min(COMMENT_LIKE_MAX_MAX, Math.round(n)) : COMMENT_LIKE_MAX_DEFAULT;
  });

  const [selected, setSelected] = useState<Set<string>>(() => new Set<string>((initialTask?.accountIds || []).map(String)));
  const [concurrency, setConcurrency] = useState<number>(() => Math.max(1, Number(initialTask?.concurrency) || 1));
  const [runInterval, setRunInterval] = useState<string>(initialTask?.frequency || 'once');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => { if (saveError) setSaveError(null); /* eslint-disable-next-line */ }, [linksText, maxLikes, selected, runInterval]);

  const readyAccounts = accounts.filter((a) => a.status !== 'banned' && a.status !== 'login_required');
  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const canAdvance: Record<WizardStep, { ok: boolean; reason?: string }> = {
    1: validLinks.length === 0
      ? { ok: false, reason: L('请至少粘贴 1 个有效的 TikTok 作品链接', '請至少貼上 1 個有效的 TikTok 作品連結', 'Paste at least one valid TikTok post link') }
      : validLinks.length > COMMENT_LIKE_MAX_LINKS
        ? { ok: false, reason: L(`最多 ${COMMENT_LIKE_MAX_LINKS} 个链接`, `最多 ${COMMENT_LIKE_MAX_LINKS} 個連結`, `At most ${COMMENT_LIKE_MAX_LINKS} links`) }
        : { ok: true },
    2: { ok: selected.size > 0, reason: L('请至少选 1 个执行账号', '請至少選 1 個執行帳號', 'Select at least one account') },
    3: { ok: true },
  };

  const handleSave = async () => {
    if (saving) return;
    for (const s of [1, 2, 3] as WizardStep[]) { if (!canAdvance[s].ok) { setSaveError(canAdvance[s].reason || ''); setStep(s); return; } }
    setSaving(true);
    try {
      await onSave({
        name: initialTask?.name || L(`${platformLabel} 作品评论区点赞(${validLinks.length} 条作品)`, `${platformLabel} 作品留言區按讚(${validLinks.length} 則作品)`, `${platformLabel} Comment Liker (${validLinks.length} posts)`),
        accountIds: Array.from(selected),
        concurrency: Math.min(concurrency, Math.max(1, selected.size)),
        frequency: runInterval,
        urls: validLinks.slice(0, COMMENT_LIKE_MAX_LINKS),
        commentLikeMax: maxLikes,
      });
    } catch (err) {
      setSaveError(String(err instanceof Error ? err.message : err) || L('保存失败', '儲存失敗', 'Save failed'));
    } finally { setSaving(false); }
  };

  const freqOptions: Array<[string, string]> = [
    ['once', L('仅手动运行', '僅手動執行', 'Manual only')],
    ['6h', L('每 6 小时', '每 6 小時', 'Every 6h')],
    ['daily_random', L('每天随机一次', '每天隨機一次', 'Once a day (random time)')],
  ];
  const freqLabel = (freqOptions.find(([v]) => v === runInterval) || [runInterval, runInterval])[1];

  return (
    <div className="w-full max-w-2xl mx-auto rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden flex flex-col">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800 shrink-0">
        <div className="text-base font-semibold dark:text-white">💗 {editing ? L('编辑', '編輯', 'Edit') + ' · ' : ''}{platformLabel} · {L('作品评论区点赞', '作品留言區按讚', 'Comment Liker')}</div>
        <div className="flex items-center gap-3">
          <span className="text-xs px-2.5 py-1 rounded-full border border-pink-500/40 text-pink-500 bg-pink-500/5">{L(`第 ${step}/3 步`, `第 ${step}/3 步`, `Step ${step}/3`)}</span>
          <button type="button" onClick={onCancel} disabled={saving} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">✕</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
        {step === 1 && (
          <>
            <div className="rounded-lg border px-3 py-2 text-[11px] leading-relaxed border-pink-500/30 bg-pink-500/5 text-pink-700 dark:text-pink-300">
              💗 {L(
                '粘贴 TikTok 作品(视频/图文)链接。开始后每个执行账号会逐条打开作品,打开评论区一屏一屏往下翻,给每位留言者的评论点赞(已赞过的、自己的留言会跳过)。需要开 VPN。',
                '貼上 TikTok 作品(影片/圖文)連結。開始後每個執行帳號會逐則打開作品,打開留言區一屏一屏往下翻,為每位留言者的留言按讚(已讚過的、自己的留言會跳過)。需要開 VPN。',
                'Paste TikTok post (video/photo) links. Each account opens them one by one, scrolls the comment section page by page and likes every commenter\'s comment (already-liked ones and its own are skipped). VPN required.',
              )}
            </div>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                🔗 {L('作品链接', '作品連結', 'Post links')}<span className="text-xs text-gray-400 font-normal ml-1">{L(`每行 1 个,最多 ${COMMENT_LIKE_MAX_LINKS} 个`, `每行 1 個,最多 ${COMMENT_LIKE_MAX_LINKS} 個`, `one per line, up to ${COMMENT_LIKE_MAX_LINKS}`)}</span>
              </label>
              <textarea
                value={linksText}
                onChange={(e) => setLinksText(e.target.value)}
                placeholder={'https://www.tiktok.com/@user/video/...\nhttps://www.tiktok.com/@user/photo/...\nhttps://vm.tiktok.com/...'}
                rows={7}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-pink-500/40 resize-y min-h-[130px] font-mono"
                disabled={saving}
              />
              <div className="flex items-center gap-3 text-[11px] mt-1">
                <span className="text-pink-500">{L(`有效 ${validLinks.length} 条`, `有效 ${validLinks.length} 則`, `${validLinks.length} valid`)}</span>
                {badLinks.length > 0 && <span className="text-amber-500">{L(`${badLinks.length} 条不是 TikTok 链接,会被忽略`, `${badLinks.length} 則不是 TikTok 連結,會被忽略`, `${badLinks.length} not TikTok links (ignored)`)}</span>}
                {validLinks.length > COMMENT_LIKE_MAX_LINKS && <span className="text-red-500">{L(`超过 ${COMMENT_LIKE_MAX_LINKS} 条上限`, `超過 ${COMMENT_LIKE_MAX_LINKS} 則上限`, `over the ${COMMENT_LIKE_MAX_LINKS}-link limit`)}</span>}
              </div>
            </div>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                👍 {L('每个账号本次最多点赞', '每個帳號本次最多按讚', 'Max likes per account per run')}
                <span className="text-xs text-gray-400 font-normal ml-1">{L(`${COMMENT_LIKE_MAX_MIN}-${COMMENT_LIKE_MAX_MAX},点满或评论翻完就停`, `${COMMENT_LIKE_MAX_MIN}-${COMMENT_LIKE_MAX_MAX},按滿或留言翻完就停`, `${COMMENT_LIKE_MAX_MIN}-${COMMENT_LIKE_MAX_MAX}; stops when reached or comments run out`)}</span>
              </label>
              <NumBox value={maxLikes} onChange={setMaxLikes} min={COMMENT_LIKE_MAX_MIN} max={COMMENT_LIKE_MAX_MAX} step={10} accent="pink" disabled={saving} />
            </div>
          </>
        )}

        {step === 2 && (
          <div>
            <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
              {L(`选择执行账号(${platformLabel},可多选)`, `選擇執行帳號(${platformLabel},可多選)`, `Accounts (${platformLabel}, multiple allowed)`)}
              <span className="text-xs text-gray-400 font-normal ml-1">{L(`已选 ${selected.size} 个`, `已選 ${selected.size} 個`, `${selected.size} selected`)}</span>
              {readyAccounts.length > 0 && (
                <button type="button" className="ml-2 text-xs text-pink-500 hover:underline" onClick={() => setSelected(selected.size === readyAccounts.length ? new Set() : new Set(readyAccounts.map((a) => a.id)))}>
                  {selected.size === readyAccounts.length ? L('全不选', '全不選', 'Clear') : L('全选', '全選', 'Select all')}
                </button>
              )}
            </label>
            <div className="space-y-1.5 max-h-72 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700 p-2">
              {accounts.length === 0 && accountsLoading && <div className="p-3 text-center text-xs text-gray-400">{L('账号加载中…', '帳號載入中…', 'Loading accounts…')}</div>}
              {accounts.length === 0 && !accountsLoading && (
                <div className="p-3 text-center space-y-2.5">
                  <div className="text-xs text-gray-400">{L(`还没有 ${platformLabel} 账号`, `還沒有 ${platformLabel} 帳號`, `No ${platformLabel} accounts yet`)}</div>
                  <button type="button" onClick={() => { window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform } })); onCancel(); }} className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-white text-sm font-semibold bg-pink-500 hover:bg-pink-600 active:scale-95">{L('去添加账号', '去新增帳號', 'Add an account')}</button>
                </div>
              )}
              {accounts.map((a) => {
                const ready = a.status !== 'login_required' && a.status !== 'banned';
                const title = a.nickname || a.displayName;
                return (
                  <label key={a.id} className={`flex items-center gap-2.5 text-sm px-2 py-1.5 rounded ${ready ? 'dark:text-gray-200 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800' : 'opacity-45 cursor-not-allowed'}`}>
                    <input type="checkbox" checked={selected.has(a.id)} onChange={() => ready && toggle(a.id)} disabled={saving || !ready} className="h-4 w-4 accent-pink-500 shrink-0" />
                    {a.avatar
                      ? <img src={a.avatar.replace(/^http:/, 'https:')} referrerPolicy="no-referrer" alt="" className="w-7 h-7 rounded-full object-cover bg-gray-200 dark:bg-gray-700 shrink-0" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                      : <span className="w-7 h-7 rounded-full bg-pink-500/20 text-pink-500 flex items-center justify-center text-xs font-bold shrink-0">{(title || '?').slice(0, 1)}</span>}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="font-medium truncate dark:text-white">{title}</span>
                        {a.displayId && <span className="text-[11px] text-gray-500 dark:text-gray-400 shrink-0">@{a.displayId}</span>}
                        {!ready && <span className="text-[11px] text-amber-500 shrink-0">{a.status === 'banned' ? L('已封禁', '已封鎖', 'banned') : L('掉线,需重新登录', '離線,需重新登入', 'logged out')}</span>}
                      </div>
                      <div className="text-[11px] text-gray-400 truncate">{a.displayName}{a.group ? ` · ${a.group}` : ''}</div>
                    </div>
                  </label>
                );
              })}
            </div>
            {selected.size > 1 && (
              <div className="mt-3 flex items-center gap-3 text-sm dark:text-gray-200">
                <span>{L('同时运行账号数', '同時執行帳號數', 'Run in parallel')}</span>
                <NumBox value={Math.min(concurrency, selected.size)} onChange={setConcurrency} min={1} max={Math.max(1, Math.min(5, selected.size))} accent="pink" disabled={saving} />
              </div>
            )}
          </div>
        )}

        {step === 3 && (
          <>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">{L('运行频率', '執行頻率', 'Schedule')}</label>
              <div className="flex gap-2 flex-wrap">
                {freqOptions.map(([value, label]) => (
                  <button key={value} type="button" onClick={() => setRunInterval(value)} className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${runInterval === value ? 'border-pink-500 bg-pink-500/10 text-pink-500 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-pink-500/50'}`}>{label}</button>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-4 py-3 text-sm space-y-1.5">
              <div className="font-semibold dark:text-gray-200 mb-1">{L('任务摘要', '任務摘要', 'Summary')}</div>
              <SummaryRow label={L('作品', '作品', 'Posts')} value={L(`${validLinks.length} 条`, `${validLinks.length} 則`, `${validLinks.length}`)} />
              <SummaryRow label={L('执行账号', '執行帳號', 'Accounts')} value={L(`${selected.size} 个`, `${selected.size} 個`, `${selected.size}`)} />
              <SummaryRow label={L('点赞上限', '按讚上限', 'Like cap')} value={L(`每个账号每次最多 ${maxLikes} 个`, `每個帳號每次最多 ${maxLikes} 個`, `${maxLikes} per account per run`)} />
              <SummaryRow label={L('运行频率', '執行頻率', 'Schedule')} value={freqLabel} />
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
          <button type="button" onClick={() => { if (!canAdvance[step].ok) { setSaveError(canAdvance[step].reason || ''); return; } setSaveError(null); setStep((step + 1) as WizardStep); }} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-semibold bg-pink-500 text-white hover:bg-pink-600 disabled:opacity-50">{L('下一步', '下一步', 'Next')}</button>
        ) : (
          <button type="button" onClick={handleSave} disabled={saving} className="px-5 py-2 rounded-lg text-sm font-semibold bg-pink-500 text-white hover:bg-pink-600 disabled:opacity-50">{saving ? L('保存中…', '儲存中…', 'Saving…') : (editing ? L('保存修改', '儲存修改', 'Save') : L('创建任务', '建立任務', 'Create task'))}</button>
        )}
      </div>
    </div>
  );
};

const SummaryRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex gap-3 text-xs"><span className="text-gray-500 dark:text-gray-400 shrink-0 w-20">{label}</span><span className="text-gray-800 dark:text-gray-200 break-all">{value}</span></div>
);

export default MatrixCommentLikeWizard;
