/**
 * MatrixLeadEngageWizard — TikTok「定向获客」向导(独立卡片,不与互动涨粉/回复粉丝串)。
 *
 * 对应后端 tiktok_lead_engage 剧本。两段式:采集同行评论者当潜客名单 → 逐个触达点赞/评论/关注。
 * 4 步:① 选执行账号(自己的 TikTok 号) ② 获客模式+来源+单次新增名额 ③ 触达配置(每客户赞/评条数、
 * 单次触达人数、动作开关、评论口味) ④ 频率+条款+创建。
 *
 * 复用铁律:账号行照 MatrixReplyFansWizard fork;不复用其配额/引流字段。主色 cyan,与 TikTok 卡一致。
 * 文案内联中英(仅 TikTok 卡使用),不新增 i18n key。
 */

import React, { useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';

export interface LeadWizardAccount {
  id: string; displayName: string; status: string;
  group?: string; platform?: string; nickname?: string; displayId?: string; avatar?: string;
}

export interface LeadEngageInput {
  mode: 'accounts' | 'keywords';
  seedAccounts: string[];
  keywords: string[];
  maxLeads: number;
  likesPerLead: number;
  commentsPerLead: number;
  leadsPerRun: number;
  doLike: boolean;
  doComment: boolean;
  doFollow: boolean;
  commentPrompt: string;
}

interface Props {
  platformLabel: string;
  platform?: string;
  accounts: LeadWizardAccount[];
  accountsLoading?: boolean;
  initialTask?: any | null;
  onCancel: () => void;
  onSave: (input: {
    name: string;
    accountIds: string[];
    concurrency: number;
    frequency: string;
    leadEngage: LeadEngageInput;
  }) => Promise<void> | void;
}

const MAX_SEED = 50;
const clampInt = (v: number, lo: number, hi: number): number => {
  const n = Math.round(Number.isFinite(v) ? v : lo);
  return Math.min(hi, Math.max(lo, n));
};
// 一行一个,接受 @x / x / 完整链接 三种填法。
const parseSeedLines = (text: string): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split('\n')) {
    let s = raw.trim();
    if (!s) continue;
    s = s.replace(/^https?:\/\/(www\.)?tiktok\.com\//i, '').replace(/^@/, '').replace(/[/?#].*$/, '').toLowerCase();
    s = s.replace(/[^a-z0-9._]/g, '');
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
    if (out.length >= MAX_SEED) break;
  }
  return out;
};

const MatrixLeadEngageWizard: React.FC<Props> = ({ platformLabel, platform, accounts, accountsLoading, initialTask, onCancel, onSave }) => {
  const zh = i18nService.currentLanguage === 'zh';
  const editing = !!initialTask;
  const le: Partial<LeadEngageInput> = initialTask?.leadEngage || {};

  const [step, setStep] = useState<number>(1);
  const TOTAL_STEPS = 4;

  const [selected, setSelected] = useState<Set<string>>(() => {
    if (initialTask?.accountIds) return new Set<string>(initialTask.accountIds);
    return new Set<string>(accounts.filter((a) => a.status !== 'banned' && a.status !== 'login_required').map((a) => a.id));
  });
  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const [mode, setMode] = useState<'accounts' | 'keywords'>(le.mode === 'keywords' ? 'keywords' : 'accounts');
  const [seedText, setSeedText] = useState<string>(Array.isArray(le.seedAccounts) ? le.seedAccounts.map((h) => '@' + h).join('\n') : '');
  const [keywordText, setKeywordText] = useState<string>(Array.isArray(le.keywords) ? le.keywords.join('\n') : '');
  const [maxLeads, setMaxLeads] = useState<number>(typeof le.maxLeads === 'number' ? le.maxLeads : 20);

  const [likesPerLead, setLikesPerLead] = useState<number>(typeof le.likesPerLead === 'number' ? le.likesPerLead : 3);
  const [commentsPerLead, setCommentsPerLead] = useState<number>(typeof le.commentsPerLead === 'number' ? le.commentsPerLead : 1);
  const [leadsPerRun, setLeadsPerRun] = useState<number>(typeof le.leadsPerRun === 'number' ? le.leadsPerRun : 20);
  const [doLike, setDoLike] = useState<boolean>(le.doLike !== false);
  const [doComment, setDoComment] = useState<boolean>(le.doComment !== false);
  const [doFollow, setDoFollow] = useState<boolean>(le.doFollow !== false);
  const [commentPrompt, setCommentPrompt] = useState<string>(le.commentPrompt || '用一句自然短评，口语化，不要拍马屁，不要超过 30 字 / 20 词；语言匹配视频与评论区的主语言。');

  const [runInterval, setRunInterval] = useState<string>(initialTask?.frequency || 'daily_random');
  const [termsAccepted, setTermsAccepted] = useState<boolean>(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const seedList = useMemo(() => parseSeedLines(seedText), [seedText]);
  const keywordList = useMemo(() => keywordText.split('\n').map((k) => k.trim()).filter(Boolean), [keywordText]);

  const t = (a: string, b: string) => (zh ? a : b);

  const canAdvance: Record<number, { ok: boolean; reason?: string }> = {
    1: { ok: selected.size >= 1, reason: t('请至少选择一个执行账号', 'Select at least one account') },
    2: mode === 'accounts'
      ? (seedList.length >= 1 ? { ok: true } : { ok: false, reason: t('请至少填写一个同行 TikTok 账号', 'Add at least one competitor account') })
      : (keywordList.length >= 1 ? { ok: true } : { ok: false, reason: t('请至少填写一个赛道关键词', 'Add at least one keyword') }),
    3: (doLike || doComment || doFollow) ? { ok: true } : { ok: false, reason: t('请至少开启一种触达动作', 'Enable at least one action') },
    4: termsAccepted ? { ok: true } : { ok: false, reason: t('请先同意条款', 'Please accept the terms') },
  };

  const next = () => {
    const c = canAdvance[step];
    if (!c.ok) { setSaveError(c.reason || ''); return; }
    setSaveError(null);
    setStep((s) => Math.min(TOTAL_STEPS, s + 1));
  };
  const back = () => { setSaveError(null); setStep((s) => Math.max(1, s - 1)); };

  const handleSave = async () => {
    if (saving) return;
    for (let s = 1; s <= 4; s++) { if (!canAdvance[s].ok) { setStep(s); setSaveError(canAdvance[s].reason || ''); return; } }
    setSaving(true);
    try {
      await onSave({
        name: initialTask?.name || t(`TikTok 定向获客 · ${selected.size} 个账号`, `TikTok Lead Finder · ${selected.size} accounts`),
        accountIds: [...selected],
        concurrency: selected.size,
        frequency: runInterval,
        leadEngage: {
          mode,
          seedAccounts: mode === 'accounts' ? seedList : [],
          keywords: mode === 'keywords' ? keywordList : [],
          maxLeads: clampInt(maxLeads, 1, 100),
          likesPerLead: clampInt(likesPerLead, 1, 10),
          commentsPerLead: clampInt(commentsPerLead, 1, 10),
          leadsPerRun: clampInt(leadsPerRun, 1, 100),
          doLike, doComment, doFollow,
          commentPrompt: commentPrompt.trim(),
        },
      });
    } catch (err) {
      setSaveError(String(err instanceof Error ? err.message : err) || t('保存失败', 'Save failed'));
    } finally { setSaving(false); }
  };

  const intervalLabel = useMemo(() => {
    const m: Record<string, string> = {
      once: t('仅运行一次', 'Once'), '30min': t('每 30 分钟', 'Every 30 min'), '1h': t('每小时', 'Hourly'),
      '3h': t('每 3 小时', 'Every 3h'), '6h': t('每 6 小时', 'Every 6h'), daily_random: t('每天随机时段', 'Daily (random time)'),
    };
    return m[runInterval] || runInterval;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runInterval, zh]);

  const numRow = (label: string, hint: string, val: number, set: (n: number) => void, lo: number, hi: number) => (
    <div className="flex items-center justify-between gap-3 py-2">
      <div className="min-w-0">
        <div className="text-sm font-medium dark:text-gray-200">{label}</div>
        <div className="text-[11px] text-gray-400">{hint}</div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button type="button" onClick={() => set(clampInt(val - 1, lo, hi))} className="w-7 h-7 rounded-lg border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-cyan-500">−</button>
        <input type="number" value={val} min={lo} max={hi} onChange={(e) => set(clampInt(parseInt(e.target.value, 10), lo, hi))}
          className="w-16 text-center text-sm py-1.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-transparent dark:text-white" />
        <button type="button" onClick={() => set(clampInt(val + 1, lo, hi))} className="w-7 h-7 rounded-lg border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-cyan-500">+</button>
      </div>
    </div>
  );

  return (
    <div className="w-full max-w-2xl max-h-[90vh] mx-auto rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden flex flex-col">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800 shrink-0">
        <div className="text-base font-semibold dark:text-white">🎯 {editing ? t(`编辑${platformLabel} 定向获客`, `Edit ${platformLabel} Lead Finder`) : t(`${platformLabel} 定向获客`, `${platformLabel} Lead Finder`)}</div>
        <div className="flex items-center gap-3">
          <span className="text-xs px-2.5 py-1 rounded-full border border-cyan-500/40 text-cyan-500 bg-cyan-500/5">{t(`第 ${step} / ${TOTAL_STEPS} 步`, `Step ${step} / ${TOTAL_STEPS}`)}</span>
          <button type="button" onClick={onCancel} disabled={saving} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">✕</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
        {/* STEP 1 · 执行账号 */}
        {step === 1 && (
          <>
            <div className="text-sm font-medium dark:text-gray-200">{t('选择执行账号', 'Select accounts')}
              <span className="text-xs text-gray-400 font-normal ml-1">{t(`用这些自己的 TikTok 号去获客(已选 ${selected.size} 个)`, `Your own TikTok accounts to run the outreach (${selected.size} selected)`)}</span>
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-800 divide-y divide-gray-100 dark:divide-gray-800 max-h-72 overflow-y-auto">
              {accountsLoading && accounts.length === 0 && <div className="px-3 py-6 text-center text-sm text-gray-400">{t('账号加载中…', 'Loading accounts…')}</div>}
              {!accountsLoading && accounts.length === 0 && (
                <div className="px-3 py-6 text-center text-sm text-gray-400">
                  {t('还没有已登录的 TikTok 账号', 'No linked TikTok accounts yet')}
                  <button type="button" onClick={() => { window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform } })); onCancel(); }} className="ml-2 text-cyan-500 underline">{t('去添加', 'Add one')}</button>
                </div>
              )}
              {accounts.map((a) => {
                const ready = a.status !== 'login_required' && a.status !== 'banned';
                const title = a.nickname || a.displayName;
                return (
                  <label key={a.id} className={`flex items-center gap-2.5 text-sm px-3 py-2 ${ready ? 'dark:text-gray-200 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800' : 'opacity-45 cursor-not-allowed'}`}>
                    <input type="checkbox" checked={selected.has(a.id)} onChange={() => ready && toggle(a.id)} disabled={saving || !ready} className="h-4 w-4 accent-cyan-500 shrink-0" />
                    {a.avatar
                      ? <img src={a.avatar.replace(/^http:/, 'https:')} referrerPolicy="no-referrer" alt="" className="w-7 h-7 rounded-full object-cover bg-gray-200 dark:bg-gray-700 shrink-0" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                      : <span className="w-7 h-7 rounded-full bg-cyan-500/20 text-cyan-500 flex items-center justify-center text-xs font-bold shrink-0">{(title || '?').slice(0, 1)}</span>}
                    <div className="min-w-0 flex-1">
                      <span className="font-medium truncate dark:text-white">{title}</span>
                      {a.displayId && <span className="ml-1.5 text-[11px] text-gray-500 dark:text-gray-400">@{a.displayId}</span>}
                      {!ready && <span className="ml-1.5 text-[11px] text-amber-500">{a.status === 'banned' ? t('已封禁', 'banned') : t('需重新登录', 'disconnected')}</span>}
                    </div>
                  </label>
                );
              })}
            </div>
          </>
        )}

        {/* STEP 2 · 获客模式 + 来源 + 名额 */}
        {step === 2 && (
          <>
            <div className="grid grid-cols-2 gap-2.5">
              {([['accounts', '🎯', t('精准获客', 'Precise'), t('填同行账号,采集他们作品评论区里的人', 'From competitor accounts\' commenters')],
                 ['keywords', '🔍', t('关键词获客', 'Keyword'), t('按赛道关键词搜视频,采集评论区里的人', 'From videos found by niche keywords')]] as const).map(([m, icon, title, desc]) => (
                <button key={m} type="button" onClick={() => setMode(m)}
                  className={`text-left p-3 rounded-xl border transition-colors ${mode === m ? 'border-cyan-500 bg-cyan-500/5' : 'border-gray-200 dark:border-gray-700 hover:border-cyan-500/40'}`}>
                  <div className="text-sm font-semibold dark:text-white mb-0.5">{icon} {title}</div>
                  <div className="text-[11px] text-gray-500 dark:text-gray-400 leading-snug">{desc}</div>
                </button>
              ))}
            </div>

            {mode === 'accounts' ? (
              <div>
                <div className="text-sm font-medium dark:text-gray-200 mb-1">{t('同行 TikTok 账号', 'Competitor accounts')}
                  <span className="text-xs text-gray-400 font-normal ml-1">{t(`一行一个,最多 ${MAX_SEED} 个 · 已识别 ${seedList.length} 个`, `one per line, max ${MAX_SEED} · ${seedList.length} parsed`)}</span>
                </div>
                <textarea value={seedText} onChange={(e) => setSeedText(e.target.value)} rows={6} placeholder={'@competitor1\n@competitor2\nhttps://www.tiktok.com/@competitor3'}
                  className="w-full text-sm p-3 rounded-xl border border-gray-300 dark:border-gray-700 bg-transparent dark:text-white font-mono leading-relaxed" />
              </div>
            ) : (
              <div>
                <div className="text-sm font-medium dark:text-gray-200 mb-1">{t('赛道关键词', 'Niche keywords')}
                  <span className="text-xs text-gray-400 font-normal ml-1">{t(`一行一个 · 已识别 ${keywordList.length} 个`, `one per line · ${keywordList.length} parsed`)}</span>
                </div>
                <textarea value={keywordText} onChange={(e) => setKeywordText(e.target.value)} rows={6} placeholder={t('美食探店\n家常菜教程\n烘焙', 'street food\nhome cooking\nbaking')}
                  className="w-full text-sm p-3 rounded-xl border border-gray-300 dark:border-gray-700 bg-transparent dark:text-white leading-relaxed" />
              </div>
            )}

            <div className="rounded-xl border border-gray-200 dark:border-gray-800 px-3">
              {numRow(t('单次新增获客上限', 'New leads per run'), t('本次最多收录多少个【新】潜客(本地已有的不重复收)', 'Max NEW leads to collect this run (dedup vs local roster)'), maxLeads, setMaxLeads, 1, 100)}
            </div>
          </>
        )}

        {/* STEP 3 · 触达配置 */}
        {step === 3 && (
          <>
            <div className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
              {t('拿到名单后,逐个打开潜客主页,挑他【还没互动过】的作品做以下动作。第二次运行会自动换新作品,形成长期互动。',
                 'For each lead, opens their profile and acts on videos not touched before. Re-runs rotate to fresh videos for long-term touch.')}
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-800 px-3 divide-y divide-gray-100 dark:divide-gray-800">
              <label className="flex items-center justify-between py-2.5 cursor-pointer">
                <span className="text-sm dark:text-gray-200">👍 {t('点赞', 'Like')}</span>
                <input type="checkbox" checked={doLike} onChange={(e) => setDoLike(e.target.checked)} className="h-4 w-4 accent-cyan-500" />
              </label>
              {doLike && numRow(t('每个客户点赞条数', 'Likes per lead'), t('单次运行给每人点赞几条作品(1-10)', 'Videos to like per lead per run (1-10)'), likesPerLead, setLikesPerLead, 1, 10)}
              <label className="flex items-center justify-between py-2.5 cursor-pointer">
                <span className="text-sm dark:text-gray-200">💬 {t('评论', 'Comment')}</span>
                <input type="checkbox" checked={doComment} onChange={(e) => setDoComment(e.target.checked)} className="h-4 w-4 accent-cyan-500" />
              </label>
              {doComment && numRow(t('每个客户评论条数', 'Comments per lead'), t('单次运行给每人评论几条作品(1-10),评论由 AI 生成', 'AI comments per lead per run (1-10)'), commentsPerLead, setCommentsPerLead, 1, 10)}
              <label className="flex items-center justify-between py-2.5 cursor-pointer">
                <span className="text-sm dark:text-gray-200">➕ {t('关注(每人终身一次)', 'Follow (once per lead)')}</span>
                <input type="checkbox" checked={doFollow} onChange={(e) => setDoFollow(e.target.checked)} className="h-4 w-4 accent-cyan-500" />
              </label>
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-800 px-3">
              {numRow(t('单次触达人数', 'Leads per run'), t('本次最多触达多少人(新客优先,老客轮转,轮不到的下次接着)', 'Max leads to reach this run (new first, then rotate)'), leadsPerRun, setLeadsPerRun, 1, 100)}
            </div>
            {doComment && (
              <div>
                <div className="text-sm font-medium dark:text-gray-200 mb-1">{t('评论口味(AI 提示词)', 'Comment style (AI prompt)')}</div>
                <textarea value={commentPrompt} onChange={(e) => setCommentPrompt(e.target.value)} rows={3}
                  className="w-full text-sm p-3 rounded-xl border border-gray-300 dark:border-gray-700 bg-transparent dark:text-white leading-relaxed" />
              </div>
            )}
          </>
        )}

        {/* STEP 4 · 频率 + 条款 */}
        {step === 4 && (
          <>
            <div>
              <div className="text-sm font-medium dark:text-gray-200 mb-2">{t('运行频率', 'Frequency')}</div>
              <div className="flex flex-wrap gap-2">
                {(['once', '1h', '3h', '6h', 'daily_random'] as const).map((f) => (
                  <button key={f} type="button" onClick={() => setRunInterval(f)}
                    className={`px-3 py-1.5 rounded-full text-sm border ${runInterval === f ? 'border-cyan-500 bg-cyan-500/10 text-cyan-500' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400'}`}>
                    {({ once: t('仅一次', 'Once'), '1h': t('每小时', 'Hourly'), '3h': t('每 3 小时', 'Every 3h'), '6h': t('每 6 小时', 'Every 6h'), daily_random: t('每天随机', 'Daily random') } as Record<string, string>)[f]}
                  </button>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-800 p-3 text-sm space-y-1.5 dark:text-gray-300">
              <div className="flex justify-between"><span className="text-gray-500">{t('执行账号', 'Accounts')}</span><span>{selected.size}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">{t('获客模式', 'Mode')}</span><span>{mode === 'accounts' ? t(`精准 · ${seedList.length} 个同行`, `Precise · ${seedList.length} seeds`) : t(`关键词 · ${keywordList.length} 个`, `Keyword · ${keywordList.length}`)}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">{t('单次新增名额', 'New leads')}</span><span>{clampInt(maxLeads, 1, 100)}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">{t('每客户', 'Per lead')}</span><span>{[doLike && `👍${clampInt(likesPerLead, 1, 10)}`, doComment && `💬${clampInt(commentsPerLead, 1, 10)}`, doFollow && '➕1'].filter(Boolean).join(' · ') || '—'}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">{t('单次触达人数', 'Leads/run')}</span><span>{clampInt(leadsPerRun, 1, 100)}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">{t('频率', 'Frequency')}</span><span>{intervalLabel}</span></div>
            </div>
            <label className="flex items-start gap-2 text-xs text-gray-500 dark:text-gray-400 cursor-pointer">
              <input type="checkbox" checked={termsAccepted} onChange={(e) => setTermsAccepted(e.target.checked)} className="h-4 w-4 accent-cyan-500 mt-0.5 shrink-0" />
              <span>{t('我已知悉:采集与互动均模拟真人节奏,潜客名单会保存在本地并长期累积,我将合规使用。',
                     'I understand collection and outreach mimic human pacing, the lead roster is stored locally and grows over time, and I will use it compliantly.')}</span>
            </label>
          </>
        )}

        {saveError && <div className="text-sm text-red-500">{saveError}</div>}
      </div>

      <div className="flex items-center justify-between px-6 py-4 border-t border-gray-200 dark:border-gray-800 shrink-0">
        <button type="button" onClick={step === 1 ? onCancel : back} disabled={saving} className="px-4 py-2 rounded-lg text-sm border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300">
          {step === 1 ? t('取消', 'Cancel') : t('上一步', 'Back')}
        </button>
        {step < TOTAL_STEPS
          ? <button type="button" onClick={next} className="px-5 py-2 rounded-lg text-sm font-semibold text-white bg-cyan-500 hover:bg-cyan-600">{t('下一步', 'Next')}</button>
          : <button type="button" onClick={handleSave} disabled={saving} className="px-5 py-2 rounded-lg text-sm font-semibold text-white bg-cyan-500 hover:bg-cyan-600 disabled:opacity-50">{saving ? t('保存中…', 'Saving…') : (editing ? t('保存', 'Save') : t('创建并运行', 'Create & Run'))}</button>}
      </div>
    </div>
  );
};

export default MatrixLeadEngageWizard;
