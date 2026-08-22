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
  FunnelUnsetConfirm, countUnconfigured, FUNNEL_PHRASE_MAX, FUNNEL_PROB_DEFAULT,
  type FunnelValue,
} from './MatrixFunnelConfig';
import { NumRow } from './NumberStepper';

export interface LeadWizardAccount {
  id: string; displayName: string; status: string;
  keywords?: string[]; derivedKeywords?: string[];
  group?: string; platform?: string; nickname?: string; displayId?: string; avatar?: string;
}

// 与运行时 effectiveKeywords(accountManager) 同口径:原始词 + AI 衍生词。
//   只看 acc.keywords 会把「只有衍生词」的账号误判成未配关键词。
const kwOf = (a: LeadWizardAccount): string[] => {
  const seen = new Set<string>();
  return [...(a.keywords || []), ...(a.derivedKeywords || [])]
    .map((k) => String(k || '').trim())
    .filter((k) => k && !seen.has(k) && seen.add(k));
};

export interface LeadEngageInput {
  mode: 'accounts' | 'keywords';
  seedAccounts: string[];
  keywords: string[];
  maxLeads: number;
  // 本次总量上限(2026-08-21 改定):不再是「每人几条」,每人分到多少由剧本按
  //   「总量 ÷ 实际触达人数」算 —— 优先保证互动人数。
  maxLikes: number;      // 1-500
  maxFollows: number;    // 1-100
  maxComments: number;   // 0-300
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

// 各平台「同行账号」的写法差别很大:TikTok/抖音是 @handle,小红书/B站/快手主页是 id 段。
//   统一策略:把用户粘的主页链接剥成【平台自己的主页标识】,剧本再按各自规则拼回主页 URL。
//   allow 决定剥完之后保留哪些字符 —— 小红书 uid 是 24 位十六进制、B站是纯数字 uid。
const SEED_SPEC: Record<string, { host: RegExp; strip: RegExp; allow: RegExp; hint: string; ph: string }> = {
  tiktok: {
    host: /^https?:\/\/(www\.)?tiktok\.com\//i, strip: /^@/, allow: /[^a-z0-9._]/g,
    hint: '@账号名 或 主页链接', ph: '@competitor1\n@competitor2\nhttps://www.tiktok.com/@competitor3',
  },
  douyin: {
    host: /^https?:\/\/(www\.)?douyin\.com\/(user\/)?/i, strip: /^@/, allow: /[^a-zA-Z0-9._\-]/g,
    hint: '抖音号 或 主页链接', ph: 'https://www.douyin.com/user/MS4wLjABAAAA...\nMS4wLjABAAAA...',
  },
  xhs: {
    host: /^https?:\/\/(www\.)?xiaohongshu\.com\/user\/profile\//i, strip: /^@/, allow: /[^a-zA-Z0-9]/g,
    hint: '小红书主页链接(含 24 位 uid)', ph: 'https://www.xiaohongshu.com/user/profile/5f3a...\n5f3a...',
  },
  kuaishou: {
    host: /^https?:\/\/(www\.)?kuaishou\.com\/profile\//i, strip: /^@/, allow: /[^a-zA-Z0-9._\-]/g,
    hint: '快手主页链接 或 用户 id', ph: 'https://www.kuaishou.com/profile/3xabc...\n3xabc...',
  },
  bilibili: {
    host: /^https?:\/\/space\.bilibili\.com\//i, strip: /^(uid:?)/i, allow: /[^0-9]/g,
    hint: 'B站空间链接 或 UID(纯数字)', ph: 'https://space.bilibili.com/12345678\n12345678',
  },
};
const specOf = (p?: string) => SEED_SPEC[String(p || 'tiktok')] || SEED_SPEC.tiktok;

// 一行一个,接受 @x / x / 完整主页链接 三种填法。
//
// ⚠️ 这里【只做去空行 / 去重 / 限 50】,原样往下传 —— 认不认得出来是剧本的事。
//   平台的 URL 规则变得很勤(小红书主页现在必须带 ?xsec_token=,拆掉就打不开;
//   抖音分享短链也一样),而剧本是服务端下发、热更新的,客户端改一次却要重新打包发版。
//   所以归一化和残渣剔除都放在剧本里(见各 *_lead_engage 的 normSeed / seedUrl)。
//   2026-08-22 之前这里做过一版「剥域名再按白名单过滤」,把
//   `www.douyin.com/user/xxx` 剥成了 `www.douyin.com` 存进去,编辑任务时显示成
//   一个凭空多出来的 `@douyin.com` 同行号。
const parseSeedLines = (text: string, platform?: string): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^@/, '');
    if (!line) continue;
    const key = platform === 'tiktok' ? line.toLowerCase() : line;   // TikTok handle 不区分大小写
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
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
  // 回填:只有 @handle 制的平台(TikTok/抖音)加 @ 前缀;小红书/B站/快手存的是 id,加了反而错。
  const [seedText, setSeedText] = useState<string>(
    Array.isArray(le.seedAccounts)
      ? le.seedAccounts.map((h) => ((platform === 'tiktok' || platform === 'douyin') ? '@' + h : h)).join('\n')
      : '');

  const [maxLeads, setMaxLeads] = useState<number>(typeof le.maxLeads === 'number' ? le.maxLeads : 20);
  const [leadsPerRun, setLeadsPerRun] = useState<number>(typeof le.leadsPerRun === 'number' ? le.leadsPerRun : 20);
  const [maxLikes, setMaxLikes] = useState<number>(typeof le.maxLikes === 'number' ? le.maxLikes : 100);
  const [maxFollows, setMaxFollows] = useState<number>(typeof le.maxFollows === 'number' ? le.maxFollows : 20);
  const [maxComments, setMaxComments] = useState<number>(typeof le.maxComments === 'number' ? le.maxComments : 100);

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

  // 把总量按「实际互动人数」平摊,给用户一个直观预期(与剧本 STEP2 的 ceil 口径一致)。
  const perLead = (total: number) => {
    const reach = Math.max(1, clampInt(leadsPerRun, 1, 100));
    const n = clampInt(total, 0, 500);
    return n > 0 ? Math.max(1, Math.ceil(n / reach)) : 0;
  };
  const seedList = useMemo(() => parseSeedLines(seedText, platform), [seedText, platform]);
  const selectedAccounts = accounts.filter((a) => selected.has(a.id));
  // 关键词模式下真正会用到的词 = 各账号自己配的关键词(与互动涨粉一致)。
  const acctsWithoutKw = selectedAccounts.filter((a) => kwOf(a).length === 0);
  const funnelAccounts = selectedAccounts.map((a) => ({
    id: a.id, title: a.nickname || a.displayName, group: a.group,
    platformName: platformLabel, avatar: a.avatar,
  }));

  const canAdvance: Record<number, { ok: boolean; reason?: string }> = {
    1: { ok: selected.size >= 1, reason: t('请至少选择一个执行账号', 'Select at least one account') },
    2: mode === 'accounts'
      ? (seedList.length >= 1 ? { ok: true } : { ok: false, reason: t(`请至少填写一个同行${platformLabel}账号`, 'Add at least one competitor account') })
      // ⚠️ 账号是弹窗开了之后【异步】填进来的(编辑任务 + sidecar 忙时要等几秒,listAccounts
      //   失败还会一直是空)。此时 selectedAccounts 为空 → `0 < 0` 恒 false → 这一步被判死,
      //   用户看到「所选账号都没配关键词」且永远过不去。账号没到位时先放行,别拿未知当错误。
      : (selectedAccounts.length === 0 || acctsWithoutKw.length < selectedAccounts.length
        ? { ok: true }
        : { ok: false, reason: t('所选账号都没有配关键词 —— 请先去「我的矩阵账号」给账号设置关键词', 'None of the selected accounts has keywords - set them in My Accounts first') }),
    3: { ok: true },
    4: { ok: true },
    // 点赞/关注/评论三个总量都填 0 = 采完潜客后挨个打开主页干等、什么也不做(采集那步照样跑)。
    //   这肯定不是用户想要的,拦在第 5 步(评论数是最后一个填的)。
    5: (clampInt(maxLikes, 0, 500) + clampInt(maxFollows, 0, 100) + clampInt(maxComments, 0, 300)) > 0
      ? { ok: true }
      : { ok: false, reason: t('点赞 / 关注 / 评论至少要开一项,否则获取到潜客后什么也不会做', 'Enable at least one of like / follow / comment — otherwise nothing happens after leads are collected') },
    6: termsAccepted ? { ok: true } : { ok: false, reason: t('请先同意条款', 'Please accept the terms') },
  };

  const next = () => {
    const c = canAdvance[step];
    if (!c.ok) { setSaveError(c.reason || ''); return; }
    // 各账号引流模式下有账号没配 → 先弹确认(与互动涨粉同款)。
    //   ⚠️ 不能加 `&& funnelUnsetConfirm === null` —— 那样第二次点「下一步」就直接放行了,
    //   等于确认形同虚设。浮层自己的「继续」按钮才是唯一的放行入口。
    if (step === 5 && funnelPerMode) {
      const un = countUnconfigured(funnelAccounts, funnelPerMap);
      if (un > 0) { setFunnelUnsetConfirm(un); return; }
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
        name: initialTask?.name || t(`${platformLabel} 定向获客 · ${selected.size} 个账号`, `${platformLabel} Lead Finder · ${selected.size} accounts`),
        accountIds: [...selected],
        concurrency: selected.size,
        frequency: runInterval,
        leadEngage: {
          mode,
          seedAccounts: mode === 'accounts' ? seedList : [],
          // 关键词跟随账号设置,向导不再提供输入;但老任务里存过的任务级词要原样保留(同上,整体替换)。
          keywords: Array.isArray(le.keywords) ? le.keywords : [],
          maxLeads: clampInt(maxLeads, 1, 100),
          // 条数 0 = 关闭该动作(开关行已按用户要求删掉,用数量本身表达开关)。
          //   do* 必须跟着算,否则剧本读到 doLike=true 仍会去点 —— 条数为 0 时
          //   剧本内部 nLikeLead 也会是 0,两边一致才不会出现「设了 0 还照做」。
          maxLikes: clampInt(maxLikes, 0, 500),
          maxFollows: clampInt(maxFollows, 0, 100),
          maxComments: clampInt(maxComments, 0, 300),
          leadsPerRun: clampInt(leadsPerRun, 1, 100),
          // 总量为 0 = 关闭该动作(向导没有单独的开关行,用数量本身表达)。
          doLike: clampInt(maxLikes, 0, 500) > 0,
          doComment: clampInt(maxComments, 0, 300) > 0,
          doFollow: clampInt(maxFollows, 0, 100) > 0,
          // ⚠️ taskStore 对 leadEngage 是整体替换(`input.leadEngage ?? 旧值`),不是逐字段合并。
          //   这两项已经从向导里去掉了,若硬写空,老任务只要被打开编辑一次(哪怕只改频率)
          //   就会把之前存过的任务级关键词/评论口味永久抹掉 —— 所以原样带回。
          commentPrompt: le.commentPrompt || '',
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

  // 走共用的 NumRow。之前这里是本地写的 <input type="number">,配 clampInt 有个「删不空」的坑:
  //   把 60 整个删掉的瞬间 parseInt('')=NaN → 立刻被夹成 lo,用户想改成 50 得先经历「变成 1」;
  //   而 max_likes 的 lo=0,删空就等于静默把点赞关掉(doLike 跟着变 false)。NumRow 用 draft
  //   字符串扛住中间态、失焦才夹取,没这个问题。
  const numRow = (label: string, hint: string, val: number, set: (n: number) => void, lo: number, hi: number) => (
    <NumRow label={label} hint={hint} value={val} onChange={set} min={lo} max={hi} disabled={saving} accent="cyan" />
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
              <span className="text-xs text-gray-400 font-normal ml-1">{t(`用这些自己的${platformLabel}号去获客(已选 ${selected.size} 个)`, `Your own ${platformLabel} accounts to run the outreach (${selected.size} selected)`)}</span>
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-800 divide-y divide-gray-100 dark:divide-gray-800 max-h-72 overflow-y-auto">
              {accountsLoading && accounts.length === 0 && <div className="px-3 py-6 text-center text-sm text-gray-400">{t('账号加载中…', 'Loading accounts…')}</div>}
              {!accountsLoading && accounts.length === 0 && (
                <div className="px-3 py-6 text-center text-sm text-gray-400">
                  {t(`还没有已登录的${platformLabel}账号`, `No linked ${platformLabel} accounts yet`)}
                  <button type="button" onClick={() => { window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform } })); onCancel(); }} className="ml-2 text-cyan-500 underline">{t('去添加', 'Add one')}</button>
                </div>
              )}
              {accounts.map((a) => {
                const ready = a.status !== 'login_required' && a.status !== 'banned';
                const title = a.nickname || a.displayName;
                const kwN = kwOf(a).length;
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
                <div className="text-sm font-medium dark:text-gray-200 mb-1">{t(`同行${platformLabel}账号`, 'Competitor accounts')}
                  <span className="text-xs text-gray-400 font-normal ml-1">{t(`${specOf(platform).hint} · 一行一个,最多 ${MAX_SEED} 个 · 已识别 ${seedList.length} 个`, `one per line, max ${MAX_SEED} · ${seedList.length} parsed`)}</span>
                </div>
                <textarea value={seedText} onChange={(e) => setSeedText(e.target.value)} rows={8} placeholder={specOf(platform).ph}
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
                    const kws = kwOf(a);
                    return (
                      <div key={a.id} className="flex items-start gap-2 text-[12px]">
                        <span className="shrink-0 dark:text-gray-300">{a.nickname || a.displayName}</span>
                        <span className={kws.length ? 'text-gray-500 dark:text-gray-400' : 'text-amber-500'}>
                          {kws.length ? kws.slice(0, 8).join('、') + (kws.length > 8 ? ` …(${kws.length})` : '') : t('未配关键词 —— 该号本轮会失败', 'no keywords - this account will fail')}
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
              {numRow(t('👍 本次点赞最大数量', '👍 Total likes this run'),
                t(`总量,按实际互动人数平摊 · 每人约 ${perLead(maxLikes)} 条 · 设为 0 = 不点赞`,
                  `Total, spread across the leads reached (~${perLead(maxLikes)} each) · 0 disables liking`),
                maxLikes, setMaxLikes, 0, 500)}
              {numRow(t('➕ 本次关注最大数量', '➕ Total follows this run'),
                t('每个潜客终身只关注一次,已关注过的不再重复 · 设为 0 = 不关注',
                  'Each lead is followed once ever · 0 disables following'),
                maxFollows, setMaxFollows, 0, 100)}
            </div>
          </>
        )}

        {/* STEP 5 · 评论 + 引流语 */}
        {step === 5 && (
          <>
            <div className="rounded-xl border border-gray-200 dark:border-gray-800 px-3">
              {numRow(t('💬 本次评论最大数量', '💬 Total comments this run'),
                t(`总量,按实际互动人数平摊 · 每人约 ${perLead(maxComments)} 条 · 评论由 AI 生成(有 AI 费用) · 设为 0 = 不评论`,
                  `Total, spread across the leads reached (~${perLead(maxComments)} each) · AI-generated (incurs AI cost) · 0 disables commenting`),
                maxComments, setMaxComments, 0, 300)}
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
            {/* 未配置确认用【共用的 fixed 浮层】,不能内联在滚动内容末尾 ——
                第 5 步内容(评论条数 + 整个引流配置)很长,内联的确认块会落在折叠线以下,
                用户点「下一步」看着像没反应(与 MatrixTaskWizard / MatrixReplyFansWizard 对齐)。 */}
            {funnelUnsetConfirm !== null && (
              <FunnelUnsetConfirm
                count={funnelUnsetConfirm}
                accent="fuchsia"
                onBack={() => setFunnelUnsetConfirm(null)}
                onContinue={() => { setFunnelUnsetConfirm(null); setStep((s) => Math.min(TOTAL_STEPS, s + 1)); }}
              />
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
              <div className="flex justify-between"><span className="text-gray-500">{t('本次总量', 'Totals')}</span><span>{[
                clampInt(maxLikes,0,500) > 0 ? `👍${clampInt(maxLikes,0,500)}` : null,
                clampInt(maxComments,0,300) > 0 ? `💬${clampInt(maxComments,0,300)}` : null,
                clampInt(maxFollows,0,100) > 0 ? `➕${clampInt(maxFollows,0,100)}` : null,
              ].filter(Boolean).join(' · ') || '—'}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">{t('平摊到每人', 'Per lead')}</span><span>{[
                perLead(maxLikes) > 0 ? `👍≈${perLead(maxLikes)}` : null,
                perLead(maxComments) > 0 ? `💬≈${perLead(maxComments)}` : null,
                clampInt(maxFollows,0,100) > 0 ? '➕1' : null,
              ].filter(Boolean).join(' · ') || '—'}</span></div>
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
