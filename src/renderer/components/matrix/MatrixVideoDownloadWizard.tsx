/**
 * MatrixVideoDownloadWizard — 矩阵版「抖音 · 视频无水印下载」向导。
 *
 * 由老客户端 DouyinWorkflowsPage 的视频下载表单迁移而来。这是个**单账号**工具任务:
 * 跟旧版几乎一样(粘贴 1-20 个链接逐个下载),唯一区别 = 配置时要**选 1 个抖音账号**
 * (用该号的指纹浏览器登录态借抖音页面 fetch wrapper 拿无水印源)。无法多开,选 1 个号即可。
 *
 *   Step 1 — 选 1 个抖音账号(单选,账号段照搬 MatrixReplyFansWizard 的展示)
 *   Step 2 — 粘贴抖音视频链接(每行 1 个,1-20 个)
 *   Step 3 — 运行频率 + 摘要 + 条款
 */

import React, { useEffect, useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';

type WizardStep = 1 | 2 | 3;

const MAX_LINKS = 20;

export interface WizardAccount { id: string; displayName: string; status: string; keywords?: string[]; group?: string; platform?: string; nickname?: string; displayId?: string; avatar?: string }

const PLATFORM_NAME: Record<string, string> = { douyin: '抖音', xhs: '小红书', bilibili: 'B站', kuaishou: '快手', tiktok: 'TikTok', x: 'X', binance: '币安广场', youtube: 'YouTube', shipinhao: '视频号', toutiao: '头条' };

const t = (k: string) => i18nService.t(k);

// 各平台链接校验(对齐各后端 orchestrator 的 isXxxLink)+ 占位示例。
const LINK_RE: Record<string, RegExp> = {
  douyin: /^https?:\/\/([\w-]+\.)?(douyin|iesdouyin)\.com\//i,
  kuaishou: /^https?:\/\/([\w-]+\.)?(kuaishou\.com|kwai\.com|chenzhongtech\.com|gifshow\.com)\//i,
  bilibili: /^https?:\/\/(([\w-]+\.)?bilibili\.com|b23\.tv)\//i,
  tiktok: /^https?:\/\/([\w-]+\.)?tiktok\.com\//i,
  xhs: /^https?:\/\/(([\w-]+\.)?xiaohongshu\.com|xhslink\.com)\//i,
};
const linkValidatorFor = (platform?: string) => {
  const re = LINK_RE[platform || 'douyin'] || LINK_RE.douyin;
  return (u: string): boolean => re.test(u.trim());
};
const LINK_PLACEHOLDER: Record<string, string> = {
  douyin: 'https://www.douyin.com/video/...\nhttps://v.douyin.com/...',
  kuaishou: 'https://www.kuaishou.com/short-video/...\nhttps://v.kuaishou.com/...',
  bilibili: 'https://www.bilibili.com/video/BV...\nhttps://b23.tv/...',
  tiktok: 'https://www.tiktok.com/@user/video/...\nhttps://vm.tiktok.com/...',
  xhs: 'https://www.xiaohongshu.com/explore/...\nhttps://xhslink.com/...',
};
const LINK_HINT_KEY: Record<string, string> = {
  douyin: 'wzDownloadHintDouyin',
  kuaishou: 'wzDownloadHintKuaishou',
  bilibili: 'wzDownloadHintBilibili',
  tiktok: 'wzDownloadHintTiktok',
  xhs: 'wzDownloadHintXhs',
};

interface Props {
  platformLabel: string;
  platform?: string;
  accounts: WizardAccount[];
  accountsLoading?: boolean;
  initialTask?: any | null;
  onCancel: () => void;
  onSave: (input: { name: string; accountIds: string[]; concurrency: number; frequency: string; urls: string[] }) => Promise<void> | void;
}

const MatrixVideoDownloadWizard: React.FC<Props> = ({ platformLabel, platform, accounts, accountsLoading, initialTask, onCancel, onSave }) => {
  const editing = !!initialTask;
  const [step, setStep] = useState<WizardStep>(1);

  // ── 单账号(只选 1 个) ──
  const [selectedId, setSelectedId] = useState<string>(() => {
    if (initialTask?.accountIds?.length) return String(initialTask.accountIds[0]);
    const first = accounts.find((a) => a.status !== 'banned' && a.status !== 'login_required');
    return first ? first.id : '';
  });

  // ── 链接清单(textarea,逐行) ── 按平台校验。
  const isValidLink = useMemo(() => linkValidatorFor(platform), [platform]);
  const [linksText, setLinksText] = useState<string>(() => (Array.isArray(initialTask?.urls) ? initialTask.urls.join('\n') : ''));
  const parsedLinks = useMemo(() => linksText.split(/[\s\n]+/).map((s) => s.trim()).filter(Boolean), [linksText]);
  const validLinks = useMemo(() => parsedLinks.filter(isValidLink), [parsedLinks, isValidLink]);
  const badLinks = useMemo(() => parsedLinks.filter((u) => !isValidLink(u)), [parsedLinks, isValidLink]);

  const [runInterval, setRunInterval] = useState<string>(initialTask?.frequency || 'once');
  const [termsAccepted, setTermsAccepted] = useState<boolean[]>([true, true]);
  const allTermsAccepted = termsAccepted.every(Boolean);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => { if (saveError) setSaveError(null); /* eslint-disable-next-line */ }, [selectedId, linksText, runInterval]);

  const canAdvance: Record<WizardStep, { ok: boolean; reason?: string }> = {
    1: { ok: !!selectedId, reason: t('wzDownloadErrSelectAccount') },
    2: validLinks.length === 0
      ? { ok: false, reason: t('wzDownloadErrNoValidLink') }
      : validLinks.length > MAX_LINKS
        ? { ok: false, reason: t('wzDownloadErrMaxLinks').replace('{n}', String(MAX_LINKS)) }
        : { ok: true },
    3: { ok: allTermsAccepted, reason: t('wzDownloadErrAcceptTerms') },
  };

  const handleSave = async () => {
    if (saving) return;
    if (!canAdvance[3].ok) { setSaveError(canAdvance[3].reason || ''); return; }
    if (!selectedId) { setSaveError(canAdvance[1].reason || ''); return; }
    if (validLinks.length === 0) { setSaveError(canAdvance[2].reason || ''); return; }
    setSaving(true);
    try {
      await onSave({
        name: initialTask?.name || t('wzDownloadTaskName').replace('{platform}', platformLabel).replace('{n}', String(validLinks.length)),
        accountIds: [selectedId],
        concurrency: 1,
        frequency: runInterval,
        urls: validLinks.slice(0, MAX_LINKS),
      });
    } catch (err) {
      setSaveError(String(err instanceof Error ? err.message : err) || t('wzDownloadErrSaveFailed'));
    } finally { setSaving(false); }
  };

  const intervalLabel = useMemo(() => {
    const m: Record<string, string> = { once: t('wzDownloadFreqOnce'), '3h': t('wzDownloadFreq3h'), '6h': t('wzDownloadFreq6h'), daily_random: t('wzDownloadFreqDailyRandomSummary') };
    return m[runInterval] || runInterval;
  }, [runInterval]);

  return (
    <div className="w-full max-w-2xl mx-auto rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden flex flex-col">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800 shrink-0">
        <div className="text-base font-semibold dark:text-white">⬇️ {editing ? t('wzDownloadTitleEdit').replace('{platform}', platformLabel) : t('wzDownloadTitleCreate').replace('{platform}', platformLabel)}</div>
        <div className="flex items-center gap-3">
          <span className="text-xs px-2.5 py-1 rounded-full border border-sky-500/40 text-sky-500 bg-sky-500/5">{t('wzDownloadStepIndicator').replace('{n}', String(step))}</span>
          <button type="button" onClick={onCancel} disabled={saving} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">✕</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
        {step === 1 && (
          <>
            <div className="rounded-lg border px-3 py-2 text-[11px] leading-relaxed border-sky-500/30 bg-sky-500/5 text-sky-700 dark:text-sky-300">
              ⬇️ {t('wzDownloadIntro').replace('{platform}', platformLabel)}{platform === 'tiktok' ? <span className="text-amber-600 dark:text-amber-400"> {t('wzDownloadIntroTiktok')}</span> : null}
            </div>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                {t('wzDownloadSelectAccountLabel').replace('{platform}', platformLabel)}<span className="text-xs text-gray-400 font-normal ml-1">{t('wzDownloadSelectAccountHint').replace('{platform}', platformLabel)}{selectedId ? t('wzDownloadSelectedSuffix') : ''}</span>
              </label>
              <div className="space-y-1.5 max-h-64 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700 p-2">
                {accounts.length === 0 && accountsLoading && (
                  <div className="p-3 text-center text-xs text-gray-400">{t('wzDownloadAccountsLoading')}</div>
                )}
                {accounts.length === 0 && !accountsLoading && (
                  <div className="p-3 text-center space-y-2.5">
                    <div className="text-xs text-gray-400">{t('wzDownloadNoAccounts').replace('{platform}', platformLabel)}</div>
                    <button
                      type="button"
                      onClick={() => { window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform } })); onCancel(); }}
                      className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-white text-sm font-semibold bg-sky-500 hover:bg-sky-600 active:scale-95"
                    >{t('wzDownloadGoAddAccount')}</button>
                  </div>
                )}
                {accounts.map((a) => {
                  const ready = a.status !== 'login_required' && a.status !== 'banned';
                  const reason = a.status === 'banned' ? t('wzDownloadStatusBanned') : a.status === 'login_required' ? t('wzDownloadStatusDisconnected') : '';
                  const title = a.nickname || a.displayName;
                  return (
                    <label key={a.id} className={`flex items-center gap-2.5 text-sm px-2 py-1.5 rounded ${ready ? 'dark:text-gray-200 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800' : 'opacity-45 cursor-not-allowed'}`}>
                      <input type="radio" name="mx-vd-account" checked={selectedId === a.id} onChange={() => ready && setSelectedId(a.id)} disabled={saving || !ready} className="h-4 w-4 accent-sky-500 shrink-0" />
                      {a.avatar
                        ? <img src={a.avatar.replace(/^http:/, 'https:')} referrerPolicy="no-referrer" alt="" className="w-7 h-7 rounded-full object-cover bg-gray-200 dark:bg-gray-700 shrink-0" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                        : <span className="w-7 h-7 rounded-full bg-sky-500/20 text-sky-500 flex items-center justify-center text-xs font-bold shrink-0">{(title || '?').slice(0, 1)}</span>}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-500">{PLATFORM_NAME[a.platform || ''] || a.platform}</span>
                          <span className="font-medium truncate dark:text-white">{title}</span>
                          {a.displayId && <span className="text-[11px] text-gray-500 dark:text-gray-400 shrink-0">{t('wzDownloadAccountIdLabel').replace('{platform}', PLATFORM_NAME[a.platform || ''] || '')}{a.displayId}</span>}
                          {a.status === 'login_required'
                            ? <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform: a.platform || platform } })); onCancel(); }} title={t('wzDownloadGoLoginTitle')} className="text-[11px] text-amber-500 underline decoration-dotted hover:text-amber-400 shrink-0">{t('wzDownloadDisconnectedGoLogin')}</button>
                            : reason ? <span className="text-[11px] text-amber-500 shrink-0">{reason}</span> : null}
                        </div>
                        <div className="text-[11px] text-gray-400 truncate">{t('wzDownloadRemarkLabel')}{a.displayName}{a.group ? ` · ${a.group}` : ''}</div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                🔗 {t('wzDownloadLinksLabel').replace('{platform}', platformLabel)}<span className="text-xs text-gray-400 font-normal ml-1">{t('wzDownloadLinksHint').replace('{n}', String(MAX_LINKS))}{t(LINK_HINT_KEY[platform || 'douyin'] || 'wzDownloadHintDouyin')}</span>
              </label>
              <textarea
                value={linksText}
                onChange={(e) => setLinksText(e.target.value)}
                placeholder={LINK_PLACEHOLDER[platform || 'douyin'] || LINK_PLACEHOLDER.douyin}
                rows={8}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-sky-500/40 resize-y min-h-[140px] font-mono"
                disabled={saving}
              />
              <div className="flex items-center gap-3 text-[11px] mt-1">
                <span className="text-sky-500">{t('wzDownloadValidCount').replace('{n}', String(validLinks.length))}</span>
                {badLinks.length > 0 && <span className="text-amber-500">{t('wzDownloadBadCount').replace('{platform}', platformLabel).replace('{n}', String(badLinks.length))}</span>}
                {validLinks.length > MAX_LINKS && <span className="text-red-500">{t('wzDownloadOverLimit').replace('{n}', String(MAX_LINKS))}</span>}
              </div>
            </div>
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-700 dark:text-amber-300 leading-relaxed space-y-1">
              <div className="font-semibold">{t('wzDownloadNotesTitle')}</div>
              <ul className="list-disc list-inside space-y-0.5">
                <li>{t('wzDownloadNote1')}</li>
                <li>{t('wzDownloadNote2').replace('{platform}', platform || 'douyin')}</li>
                <li>{t('wzDownloadNote3')}</li>
              </ul>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">{t('wzDownloadFreqLabel')}</label>
              <div className="flex gap-2 flex-wrap">
                {[['once', t('wzDownloadFreqOnce')], ['3h', t('wzDownloadFreq3h')], ['6h', t('wzDownloadFreq6h')], ['daily_random', t('wzDownloadFreqDailyRandom')]].map(([value, label]) => (
                  <button key={value} type="button" onClick={() => setRunInterval(value)} className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${runInterval === value ? 'border-sky-500 bg-sky-500/10 text-sky-500 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-sky-500/50'}`}>{label}</button>
                ))}
              </div>
              {runInterval === 'once' && <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">{t('wzDownloadFreqOnceTip')}</p>}
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-4 py-3 text-sm space-y-1.5">
              <div className="font-semibold dark:text-gray-200 mb-1">{t('wzDownloadSummaryTitle')}</div>
              <SummaryRow label={t('wzDownloadSummaryAccount')} value={t('wzDownloadSummaryAccountValue')} />
              <SummaryRow label={t('wzDownloadSummaryLinks')} value={`${t('wzDownloadSummaryLinksValue').replace('{n}', String(validLinks.length))}${badLinks.length ? t('wzDownloadSummaryLinksSkip').replace('{n}', String(badLinks.length)) : ''}`} />
              <SummaryRow label={t('wzDownloadSummaryFreq')} value={intervalLabel} />
            </div>
            <div className="space-y-2">
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{t('wzDownloadTermsTitle')}</div>
              {[t('wzDownloadTerm1'), t('wzDownloadTerm2')].map((term, i) => (
                <label key={i} className="flex items-start gap-2 text-xs text-gray-700 dark:text-gray-300 cursor-pointer">
                  <input type="checkbox" checked={termsAccepted[i]} onChange={(e) => { const next = [...termsAccepted]; next[i] = e.target.checked; setTermsAccepted(next); }} disabled={saving} className="mt-0.5 h-4 w-4 accent-sky-500 shrink-0" />
                  <span className="leading-relaxed">{term}</span>
                </label>
              ))}
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
        <button type="button" onClick={onCancel} disabled={saving} className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 px-2">{t('wzDownloadCancel')}</button>
        <div className="flex-1" />
        {step > 1 && <button type="button" onClick={() => setStep((step - 1) as WizardStep)} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50">{t('wzDownloadPrev')}</button>}
        {step < 3 ? (
          <button type="button" onClick={() => { if (!canAdvance[step].ok) { setSaveError(canAdvance[step].reason || ''); return; } setSaveError(null); setStep((step + 1) as WizardStep); }} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-semibold bg-sky-500 text-white hover:bg-sky-600 disabled:opacity-50">{t('wzDownloadNext')}</button>
        ) : (
          <button type="button" onClick={handleSave} disabled={saving || !allTermsAccepted} className="px-5 py-2 rounded-lg text-sm font-semibold bg-sky-500 text-white hover:bg-sky-600 disabled:opacity-50">{saving ? t('wzDownloadSaving') : (editing ? t('wzDownloadSaveEdit') : t('wzDownloadCreate'))}</button>
        )}
      </div>
    </div>
  );
};

const SummaryRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex gap-3 text-xs"><span className="text-gray-500 dark:text-gray-400 shrink-0 w-20">{label}</span><span className="text-gray-800 dark:text-gray-200 break-all">{value}</span></div>
);

export default MatrixVideoDownloadWizard;
