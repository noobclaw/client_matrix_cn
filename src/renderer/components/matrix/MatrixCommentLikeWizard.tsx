/**
 * MatrixCommentLikeWizard — 矩阵版「TikTok · 评论区点赞评论」向导(type='comment_like')。
 *
 * 对应后端 tiktok_comment_like 剧本(2026-10-29 改版):
 *   精准模式 —— 逐条打开用户粘贴的作品 / 主页作品,翻完整个评论区,每条评论点赞 + 回复;
 *   关键词模式 —— 用各执行账号自己的关键词搜视频,每条评论点赞、回复其中一半,跑到本次运行时长上限。
 *   点赞 / 回复可勾选,至少一个;不再设数量上限。回复由 AI 按评论逐条写(扣积分),点赞会员免费。
 *
 *   Step 1 — 模式 + 链接(精准)+ 要做的动作
 *   Step 2 — 选执行账号(可多选)
 *   Step 3 — 运行频率 + 摘要 + 条款
 *
 * 文案内联中/繁/英(同定向获客卡片的做法),不进 i18n 大表。
 */

import React, { useEffect, useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { presetAccountIds, usePresetUsed, usePresetPrune } from '../../uiEdition';

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
  onSave: (input: { name: string; accountIds: string[]; concurrency: number; frequency: string; urls: string[]; commentMode: 'precise' | 'keywords'; commentDoLike: boolean; commentDoReply: boolean }) => Promise<void> | void;
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
  // 2026-10-29:不再设数量;改成 模式(精准 / 关键词)+ 要不要点赞 / 回复(至少一个)。
  const [mode, setMode] = useState<'precise' | 'keywords'>(() => (initialTask?.commentMode === 'keywords' ? 'keywords' : 'precise'));
  const [doLike, setDoLike] = useState<boolean>(() => initialTask ? initialTask.commentDoLike !== false : true);
  const [doReply, setDoReply] = useState<boolean>(() => initialTask ? initialTask.commentDoReply === true : true);

  const [selected, setSelected] = useState<Set<string>>(() => new Set<string>((initialTask ? (initialTask.accountIds || []) : presetAccountIds(platform)).map(String)));
  // 简洁版预选号:账号加载完后剔除不在本向导列表里的号(见 usePresetPrune)
  const presetUsed = usePresetUsed(initialTask, platform);
  usePresetPrune(presetUsed, accounts, accountsLoading, (live) => setSelected((prev) => { const n = new Set(Array.from(prev).filter((id) => live.has(id))); return n.size === prev.size ? prev : n; }));
  const [runInterval, setRunInterval] = useState<string>(initialTask?.frequency || 'once');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => { if (saveError) setSaveError(null); /* eslint-disable-next-line */ }, [linksText, mode, doLike, doReply, selected, runInterval]);

  const readyAccounts = accounts.filter((a) => a.status !== 'banned' && a.status !== 'login_required');
  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const canAdvance: Record<WizardStep, { ok: boolean; reason?: string }> = {
    1: !doLike && !doReply
      ? { ok: false, reason: L('点赞和评论至少选一个', '按讚和留言至少選一個', 'Pick at least one: like or reply') }
      : mode === 'keywords'
      ? { ok: true }
      : validLinks.length === 0
      ? { ok: false, reason: L('请至少粘贴 1 个有效的 TikTok 作品或主页链接', '請至少貼上 1 個有效的 TikTok 作品或主頁連結', 'Paste at least one valid TikTok post or profile link') }
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
        name: initialTask?.name || (mode === 'keywords'
          ? L(`${platformLabel} 评论区点赞评论(关键词)`, `${platformLabel} 留言區按讚留言(關鍵詞)`, `${platformLabel} Comment Like & Reply (keywords)`)
          : L(`${platformLabel} 评论区点赞评论(${validLinks.length} 条作品)`, `${platformLabel} 留言區按讚留言(${validLinks.length} 則作品)`, `${platformLabel} Comment Like & Reply (${validLinks.length} posts)`)),
        accountIds: Array.from(selected),
        concurrency: Math.max(1, selected.size),   // 勾几个号就几个号一起跑(同互动任务;runner 内部有上限兜底)
        frequency: runInterval,
        urls: mode === 'keywords' ? [] : validLinks.slice(0, COMMENT_LIKE_MAX_LINKS),
        commentMode: mode,
        commentDoLike: doLike,
        commentDoReply: doReply,
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
        <div className="text-base font-semibold dark:text-white">💗 {editing ? L('编辑', '編輯', 'Edit') + ' · ' : ''}{platformLabel} · {L('评论区点赞评论', '留言區按讚留言', 'Comment Like & Reply')}</div>
        <div className="flex items-center gap-3">
          <span className="text-xs px-2.5 py-1 rounded-full border border-pink-500/40 text-pink-500 bg-pink-500/5">{L(`第 ${step}/3 步`, `第 ${step}/3 步`, `Step ${step}/3`)}</span>
          <button type="button" onClick={onCancel} disabled={saving} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">✕</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
        {step === 1 && (
          <>
            {/* 模式 */}
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">{L('模式', '模式', 'Mode')}</label>
              <div className="grid grid-cols-2 gap-2">
                {([
                  ['precise', L('🎯 精准模式', '🎯 精準模式', '🎯 Precise'), L('粘作品 / 主页链接,逐条处理', '貼作品 / 主頁連結,逐則處理', 'Paste post / profile links')],
                  ['keywords', L('🔍 关键词模式', '🔍 關鍵詞模式', '🔍 Keywords'), L('用各执行账号自己的关键词搜视频', '用各執行帳號自己的關鍵詞搜影片', "Search videos with each account's keywords")],
                ] as Array<['precise' | 'keywords', string, string]>).map(([v, t, d]) => (
                  <button key={v} type="button" onClick={() => setMode(v)} disabled={saving}
                    className={`text-left rounded-lg border px-3 py-2 transition-colors ${mode === v ? 'border-pink-500 bg-pink-500/10' : 'border-gray-300 dark:border-gray-700 hover:border-pink-500/50'}`}>
                    <div className={`text-sm font-semibold ${mode === v ? 'text-pink-500' : 'dark:text-gray-200'}`}>{t}</div>
                    <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">{d}</div>
                  </button>
                ))}
              </div>
            </div>
            <div className="rounded-lg border px-3 py-2 text-[11px] leading-relaxed border-pink-500/30 bg-pink-500/5 text-pink-700 dark:text-pink-300">
              💗 {mode === 'precise'
                ? L('每个执行账号逐条打开作品(主页链接会展开成他最近的作品),把评论区从头翻到底,每条评论点赞并回复(自己的、已赞过的跳过),链接用完为止。需要开 VPN。',
                    '每個執行帳號逐則打開作品(主頁連結會展開成他最近的作品),把留言區從頭翻到底,每則留言按讚並回覆(自己的、已讚過的跳過),連結用完為止。需要開 VPN。',
                    'Each account opens the posts one by one (profile links expand to recent posts), scrolls the whole comment section, likes and replies to every comment (skipping its own and liked ones) until the links run out. VPN required.')
                : L('每个执行账号用它自己的关键词(账号卡片「编辑」里设置)搜视频,每条评论点赞、回复其中一半,一直找新视频,跑到本次运行时长上限为止。需要开 VPN。',
                    '每個執行帳號用它自己的關鍵詞(帳號卡片「編輯」裡設定)搜影片,每則留言按讚、回覆其中一半,一直找新影片,跑到本次執行時長上限為止。需要開 VPN。',
                    "Each account searches videos with its own keywords (set under Edit on the account card), likes every comment and replies to half, and keeps finding new videos until the run's time limit. VPN required.")}
            </div>
            {mode === 'precise' && (
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                🔗 {L('作品或博主主页链接', '作品或博主主頁連結', 'Post or profile links')}<span className="text-xs text-gray-400 font-normal ml-1">{L(`每行 1 个,最多 ${COMMENT_LIKE_MAX_LINKS} 个`, `每行 1 個,最多 ${COMMENT_LIKE_MAX_LINKS} 個`, `one per line, up to ${COMMENT_LIKE_MAX_LINKS}`)}</span>
              </label>
              <textarea
                value={linksText}
                onChange={(e) => setLinksText(e.target.value)}
                placeholder={'https://www.tiktok.com/@user/video/...\nhttps://www.tiktok.com/@user/photo/...\nhttps://www.tiktok.com/@user  (博主主页 / profile)\nhttps://vm.tiktok.com/...'}
                rows={6}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-pink-500/40 resize-y min-h-[120px] font-mono"
                disabled={saving}
              />
              <div className="flex items-center gap-3 text-[11px] mt-1">
                <span className="text-pink-500">{L(`有效 ${validLinks.length} 条`, `有效 ${validLinks.length} 則`, `${validLinks.length} valid`)}</span>
                {badLinks.length > 0 && <span className="text-amber-500">{L(`${badLinks.length} 条不是 TikTok 链接,会被忽略`, `${badLinks.length} 則不是 TikTok 連結,會被忽略`, `${badLinks.length} not TikTok links (ignored)`)}</span>}
                {validLinks.length > COMMENT_LIKE_MAX_LINKS && <span className="text-red-500">{L(`超过 ${COMMENT_LIKE_MAX_LINKS} 条上限`, `超過 ${COMMENT_LIKE_MAX_LINKS} 則上限`, `over the ${COMMENT_LIKE_MAX_LINKS}-link limit`)}</span>}
              </div>
            </div>
            )}
            {/* 要做的动作:至少一个 */}
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">{L('对每条评论做什么', '對每則留言做什麼', 'What to do on each comment')}<span className="text-xs text-gray-400 font-normal ml-1">{L('至少选一个', '至少選一個', 'pick at least one')}</span></label>
              <div className="flex flex-col gap-2">
                <label className="flex items-start gap-2 text-sm dark:text-gray-200 cursor-pointer">
                  <input type="checkbox" checked={doLike} onChange={(e) => setDoLike(e.target.checked)} disabled={saving} className="mt-0.5 h-4 w-4 accent-pink-500" />
                  <span>👍 {L('点赞', '按讚', 'Like')}<span className="text-[11px] text-gray-400 ml-1">{L('基础版及以上会员免费', '基礎版及以上會員免費', 'free for Basic members and up')}</span></span>
                </label>
                <label className="flex items-start gap-2 text-sm dark:text-gray-200 cursor-pointer">
                  <input type="checkbox" checked={doReply} onChange={(e) => setDoReply(e.target.checked)} disabled={saving} className="mt-0.5 h-4 w-4 accent-pink-500" />
                  <span>💬 {L('回复评论', '回覆留言', 'Reply')}<span className="text-[11px] text-gray-400 ml-1">{mode === 'keywords' ? L('回复其中一半;AI 按每条评论写,每条回复扣积分', '回覆其中一半;AI 按每則留言寫,每則回覆扣積分', 'replies to half; AI-written, each reply costs credits') : L('AI 按每条评论写,每条回复扣积分', 'AI 按每則留言寫,每則回覆扣積分', 'AI-written per comment; each reply costs credits')}</span></span>
                </label>
              </div>
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
                        {mode === 'keywords' && ready && !(a.keywords && a.keywords.length) && <span className="text-[11px] text-amber-500 shrink-0">{L('没设关键词', '沒設關鍵詞', 'no keywords')}</span>}
                        {!ready && <span className="text-[11px] text-amber-500 shrink-0">{a.status === 'banned' ? L('已封禁', '已封鎖', 'banned') : L('掉线,需重新登录', '離線,需重新登入', 'logged out')}</span>}
                      </div>
                      <div className="text-[11px] text-gray-400 truncate">{a.displayName}{a.group ? ` · ${a.group}` : ''}</div>
                    </div>
                  </label>
                );
              })}
            </div>
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
              <SummaryRow label={L('模式', '模式', 'Mode')} value={mode === 'keywords' ? L('关键词模式(各账号自己的关键词)', '關鍵詞模式(各帳號自己的關鍵詞)', "Keywords (each account's own)") : L(`精准模式 · ${validLinks.length} 条链接`, `精準模式 · ${validLinks.length} 則連結`, `Precise · ${validLinks.length} links`)} />
              <SummaryRow label={L('执行账号', '執行帳號', 'Accounts')} value={L(`${selected.size} 个`, `${selected.size} 個`, `${selected.size}`)} />
              <SummaryRow label={L('动作', '動作', 'Actions')} value={[doLike ? L('点赞', '按讚', 'like') : '', doReply ? (mode === 'keywords' ? L('回复一半', '回覆一半', 'reply to half') : L('回复', '回覆', 'reply')) : ''].filter(Boolean).join(' + ')} />
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
