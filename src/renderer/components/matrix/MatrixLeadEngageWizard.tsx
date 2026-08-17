/**
 * MatrixLeadEngageWizard — TikTok「定向获客」向导(独立卡片,不与互动涨粉/回复粉丝串)。
 *
 * 对应后端 tiktok_lead_engage 剧本。6 步(2026-08-17 按用户要求拆分):
 *   1 选执行账号
 *   2 获客模式 + 来源(精准=填同行账号;关键词=跟随账号自己的关键词,不在这里填)
 *   3 数量(本次获取潜客上限 / 本次最多互动多少潜客)
 *   4 点赞 + 关注
 *   5 评论(条数 + 引流语:共用或各账号各自,一行一条最多 20,带概率)
 *   6 频率 + 条款
 *
 * 复用铁律:账号行照 MatrixReplyFansWizard fork;引流语直接复用 MatrixFunnelConfig
 * (它本就支持一行一条 ≤20 + 概率 + 共用/各账号双模式)。主色 cyan,与 TikTok 卡一致。
 * 文案内联中英(仅 TikTok 卡使用),不新增 i18n key。
 */

import React, { useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';
import MatrixFunnelConfig, {
  countUnconfigured, FUNNEL_PHRASE_MAX, FUNNEL_PROB_DEFAULT,
  type FunnelValue,
} from './MatrixFunnelConfig';

export interface LeadWizardAccount {
  id: string; displayName: string; status: string;
  keywords?: string[]; group?: string; platform?: string; nickname?: string; displayId?: string; avatar?: string;
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
    funnel: FunnelValue;
    funnelByAccount: Record<string, FunnelValue> | null;
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
  const t = (a: string, b: string) => (zh ? a : b);
  const editing = !!initialTask;
  const le: Partial<LeadEngageInput> = initialTask?.leadEngage || {};

  const [step, setStep] = useState<number>(1);
  const TOTAL_STEPS = 6;

  const [selected, setSelected] = useState<Set<string>>(() => {
    if (initialTask?.accountIds) return new Set<string>(initialTask.accountIds);
    return new Set<string>(accounts.filter((a) => a.status !== 'banned' && a.status !== 'login_required').map((a) => a.id));
  });
  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const [mode, setMode] = useState<'accounts' | 'keywords'>(le.mode === 'keywords' ? 'keywords' : 'accounts');
  const [seedText, setSeedText] = useState<string>(Array.isArray(le.seedAccounts) ? le.seedAccounts.map((h) => '@' + h).join('\n') : '');

  const [maxLeads, setMaxLeads] = useState<number>(typeof le.maxLeads === 'number' ? le.maxLeads : 20);
  const [leadsPerRun, setLeadsPerRun] = useState<number>(typeof le.leadsPerRun === 'number' ? le.leadsPerRun : 20);
  const [likesPerLead, setLikesPerLead] = useState<number>(typeof le.likesPerLead === 'number' ? le.likesPerLead : 3);
  const [commentsPerLead, setCommentsPerLead] = useState<number>(typeof le.commentsPerLead === 'number' ? le.commentsPerLead : 1);

  // 引流语(评论时按概率融进 AI 评论)。与互动涨粉同一套口径,直接复用 MatrixFunnelConfig。
  const [funnelPerMode, setFunnelPerMode] = useState<boolean>(!!initialTask?.funnelByAccount && Object.keys(initialTask.funnelByAccount).length > 0);
  const [funnelPhrase, setFunnelPhrase] = useState<string>(initialTask?.funnel?.funnel_phrase || '');
  const [funnelProb, setFunnelProb] = useState<number>(
    typeof initialTask?.funnel?.funnel_probability === 'number' && initialTask.funnel.funnel_probability > 0
      ? initialTask.funnel.funnel_probability : FUNNEL_PROB_DEFAULT);
  const [funnelPerMap, setFunnelPerMap] = useState<Record<string, FunnelValue>>(initialTask?.funnelByAccount || {});
  const [funnelUnsetConfirm, setFunnelUnsetConfirm] = useState<number | null>(null);

  const [runInterval, setRunInterval] = useState<string>(initialTask?.frequency || 'daily_random');
  const [termsAccepted, setTermsAccepted] = useState<boolean>(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const seedList = useMemo(() => parseSeedLines(seedText), [seedText]);
  const selectedAccounts = accounts.filter((a) => selected.has(a.id));
  // 关键词模式下真正会用到的词 = 各账号自己配的关键词(与互动涨粉一致)。
  const acctsWithoutKw = selectedAccounts.filter((a) => !(a.keywords && a.keywords.length));
  const funnelAccounts = selectedAccounts.map((a) => ({
    id: a.id, title: a.nickname || a.displayName, group: a.group,
    platformName: platformLabel, avatar: a.avatar,
  }));

  const canAdvance: Record<number, { ok: boolean; reason?: string }> = {
    1: { ok: selected.size >= 1, reason: t('请至少选择一个执行账号', 'Select at least one account') },
    2: mode === 'accounts'
      ? (seedList.length >= 1 ? { ok: true } : { ok: false, reason: t('请至少填写一个同行 TikTok 账号', 'Add at least one competitor account') })
      : (acctsWithoutKw.length < selectedAccounts.length
        ? { ok: true }
        : { ok: false, reason: t('所选账号都没有配关键词 —— 请先去「我的矩阵账号」给账号设置关键词', 'None of the selected accounts has keywords - set them in My Accounts first') }),
    3: { ok: true },
    4: { ok: true },
    5: { ok: true },
    6: termsAccepted ? { ok: true } : { ok: false, reason: t('请先同意条款', 'Please accept the terms') },
  };

  const next = () => {
    const c = canAdvance[step];
    if (!c.ok) { setSaveError(c.reason || ''); return; }
    // 各账号引流模式下有账号没配 → 先弹确认(与互动涨粉同款)
    if (step === 5 && funnelPerMode) {
      const un = countUnconfigured(funnelAccounts, funnelPerMap);
      if (un > 0 && funnelUnsetConfirm === null) { setFunnelUnsetConfirm(un); return; }
    }
    setSaveError(null);
    setFunnelUnsetConfirm(null);
    setStep((s) => Math.min(TOTAL_STEPS, s + 1));
  };
  const back = () => { setSaveError(null); setFunnelUnsetConfirm(null); setStep((s) => Math.max(1, s - 1)); };

  const cleanPerMap = () => {
    const out: Record<string, FunnelValue> = {};
    for (const id of selected) {
      const v = funnelPerMap[id];
      const ph = (v?.funnel_phrase || '').trim();
      if (ph) out[id] = { funnel_phrase: ph, funnel_probability: v.funnel_probability };
    }
    return out;
  };

  const handleSave = async () => {
    if (saving) return;
    for (let s = 1; s <= TOTAL_STEPS; s++) { if (!canAdvance[s].ok) { setStep(s); setSaveError(canAdvance[s].reason || ''); return; } }
    setSaving(true);
    try {
      const hasShared = funnelPhrase.trim().length > 0;
      await onSave({
        name: initialTask?.name || t(`TikTok 定向获客 · ${selected.size} 个账号`, `TikTok Lead Finder · ${selected.size} accounts`),
        accountIds: [...selected],
        concurrency: selected.size,
        frequency: runInterval,
        leadEngage: {
          mode,
          seedAccounts: mode === 'accounts' ? seedList : [],
          keywords: [],                       // 关键词跟随账号设置,不在任务里存
          maxLeads: clampInt(maxLeads, 1, 100),
          likesPerLead: clampInt(likesPerLead, 1, 10),
          commentsPerLead: clampInt(commentsPerLead, 1, 10),
          leadsPerRun: clampInt(leadsPerRun, 1, 100),
          doLike: true, doComment: true, doFollow: true,
          commentPrompt: '',                  // 评论口味不再让用户填,用剧本默认
        },
        funnel: (!funnelPerMode && hasShared)
          ? { funnel_phrase: funnelPhrase.trim(), funnel_probability: funnelProb }
          : { funnel_phrase: '', funnel_probability: 0 },
        funnelByAccount: funnelPerMode ? cleanPerMap() : null,
      });
    } catch (err) {
      setSaveError(String(err instanceof Error ? err.message : err) || t('保存失败', 'Save failed'));
    } finally { setSaving(false); }
  };

  const intervalLabel = useMemo(() => {
    const m: Record<string, string> = {
      once: t('仅运行一次', 'Once'), '1h': t('每小时', 'Hourly'),
      '3h': t('每 3 小时', 'Every 3h'), '6h': t('每 6 小时', 'Every 6h'), daily_random: t('每天随机时段', 'Daily (random time)'),
    };
    return m[runInterval] || runInterval;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runInterval, zh]);

  const numRow = (label: string, hint: string, val: number, set: (n: number) => void, lo: number, hi: number) => (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <div className="text-sm font-medium dark:text-gray-200">{label}</div>
        <div className="text-[11px] text-gray-400 leading-snug">{hint}</div>
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
                const kwN = (a.keywords || []).length;
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
                      <div className="text-[11px] text-gray-400">{kwN ? t(`关键词 ${kwN} 个`, `${kwN} keywords`) : t('未配关键词', 'no keywords')}</div>
                    </div>
                  </label>
                );
              })}
            </div>
          </>
        )}

        {/* STEP 2 · 获客模式 + 来源 */}
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
                <textarea value={seedText} onChange={(e) => setSeedText(e.target.value)} rows={8} placeholder={'@competitor1\n@competitor2\nhttps://www.tiktok.com/@competitor3'}
                  className="w-full text-sm p-3 rounded-xl border border-gray-300 dark:border-gray-700 bg-transparent dark:text-white font-mono leading-relaxed" />
              </div>
            ) : (
              <div className="rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-3">
                <div className="text-sm font-medium dark:text-gray-200">{t('赛道关键词', 'Niche keywords')}</div>
                <div className="text-[12px] text-gray-500 dark:text-gray-400 leading-relaxed">
                  {t('关键词跟随每个账号自己的设置,不在这里单独填 —— 要改请去「我的矩阵账号」编辑该账号的关键词。',
                     'Keywords follow each account\'s own settings rather than being entered here - edit them in My Accounts to change.')}
                </div>
                <div className="space-y-1.5">
                  {selectedAccounts.map((a) => {
                    const kws = a.keywords || [];
                    return (
                      <div key={a.id} className="flex items-start gap-2 text-[12px]">
                        <span className="shrink-0 dark:text-gray-300">{a.nickname || a.displayName}</span>
                        <span className={kws.length ? 'text-gray-500 dark:text-gray-400' : 'text-amber-500'}>
                          {kws.length ? kws.slice(0, 8).join('、') + (kws.length > 8 ? ` …(${kws.length})` : '') : t('未配关键词,本轮会跳过', 'no keywords - will be skipped')}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <button type="button" onClick={() => { window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform } })); onCancel(); }}
                  className="text-xs text-cyan-500 underline">{t('去「我的矩阵账号」修改关键词', 'Edit keywords in My Accounts')}</button>
              </div>
            )}
          </>
        )}

        {/* STEP 3 · 数量 */}
        {step === 3 && (
          <div className="rounded-xl border border-gray-200 dark:border-gray-800 px-3 divide-y divide-gray-100 dark:divide-gray-800">
            {numRow(t('本次获取潜客上限', 'New leads per run'), t('（本地已有的不重复收）', '(dedup against the local roster)'), maxLeads, setMaxLeads, 1, 100)}
            {numRow(t('本次最多互动多少潜客', 'Leads to engage per run'), t('新客优先,老客轮转,轮不到的下次接着', 'New leads first, then rotate through existing ones'), leadsPerRun, setLeadsPerRun, 1, 100)}
          </div>
        )}

        {/* STEP 4 · 点赞 + 关注 */}
        {step === 4 && (
          <>
            <div className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
              {t('逐个打开潜客主页,挑他【还没互动过】的作品做动作。第二次运行会自动换新作品,形成长期互动。',
                 'Opens each lead\'s profile and acts on videos not touched before; re-runs rotate to fresh ones.')}
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-800 px-3 divide-y divide-gray-100 dark:divide-gray-800">
              {numRow(t('👍 每个潜客点赞条数', '👍 Likes per lead'), t('单次运行给每人点赞几条作品', 'Videos to like per lead per run'), likesPerLead, setLikesPerLead, 1, 10)}
              <div className="py-2.5">
                <div className="text-sm font-medium dark:text-gray-200">{t('➕ 关注', '➕ Follow')}</div>
                <div className="text-[11px] text-gray-400 leading-snug">{t('每个潜客终身只关注一次,已关注过的不再重复', 'Each lead is followed once, ever')}</div>
              </div>
            </div>
          </>
        )}

        {/* STEP 5 · 评论 + 引流语 */}
        {step === 5 && (
          <>
            <div className="rounded-xl border border-gray-200 dark:border-gray-800 px-3">
              {numRow(t('💬 每个潜客评论条数', '💬 Comments per lead'), t('评论由 AI 按作品内容生成', 'Comments are AI-generated from the video'), commentsPerLead, setCommentsPerLead, 1, 10)}
            </div>
            <MatrixFunnelConfig
              accounts={funnelAccounts}
              accent="fuchsia"
              perMode={funnelPerMode}
              setPerMode={setFunnelPerMode}
              shared={{ funnel_phrase: funnelPhrase, funnel_probability: funnelProb }}
              setShared={(v) => { setFunnelPhrase(v.funnel_phrase.slice(0, FUNNEL_PHRASE_MAX)); setFunnelProb(v.funnel_probability); }}
              perMap={funnelPerMap}
              setPerMap={setFunnelPerMap}
              disabled={saving}
            />
            {funnelUnsetConfirm !== null && (
              <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
                <div className="dark:text-gray-200 mb-2">
                  {t(`还有 ${funnelUnsetConfirm} 个账号没配引流语,它们的评论将不带引流。继续?`,
                     `${funnelUnsetConfirm} account(s) have no phrase; their comments will carry none. Continue?`)}
                </div>
                <div className="flex gap-2 justify-end">
                  <button type="button" onClick={() => setFunnelUnsetConfirm(null)} className="px-3 py-1.5 rounded-lg text-xs border border-gray-300 dark:border-gray-700">{t('回去配置', 'Go back')}</button>
                  <button type="button" onClick={() => { setFunnelUnsetConfirm(null); setStep((s) => Math.min(TOTAL_STEPS, s + 1)); }} className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-500 text-white">{t('继续', 'Continue')}</button>
                </div>
              </div>
            )}
          </>
        )}

        {/* STEP 6 · 频率 + 条款 */}
        {step === 6 && (
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
              <div className="flex justify-between"><span className="text-gray-500">{t('获客模式', 'Mode')}</span><span>{mode === 'accounts' ? t(`精准 · ${seedList.length} 个同行`, `Precise · ${seedList.length} seeds`) : t('关键词 · 跟随账号设置', 'Keyword · from account settings')}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">{t('本次获取潜客上限', 'New leads')}</span><span>{clampInt(maxLeads, 1, 100)}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">{t('本次最多互动潜客', 'Engage per run')}</span><span>{clampInt(leadsPerRun, 1, 100)}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">{t('每个潜客', 'Per lead')}</span><span>{`👍${clampInt(likesPerLead, 1, 10)} · 💬${clampInt(commentsPerLead, 1, 10)} · ➕1`}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">{t('评论引流', 'Funnel')}</span><span>{funnelPerMode ? t(`各账号各自(${funnelAccounts.length - countUnconfigured(funnelAccounts, funnelPerMap)}/${funnelAccounts.length} 已配)`, `per account`) : (funnelPhrase.trim() ? t(`共用 · ${funnelProb}%`, `shared · ${funnelProb}%`) : t('未配置', 'none'))}</span></div>
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
