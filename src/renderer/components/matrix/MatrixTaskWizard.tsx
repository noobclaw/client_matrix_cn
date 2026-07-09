/**
 * MatrixTaskWizard — 直接照搬老客户端 DouyinConfigWizard 的样式/结构(violet 3-step
 * 向导 + RangeSlider 滑条 + 摘要卡 + 条款),只改两处:
 *   Step 1:赛道/关键词 → 「勾选多个已登录账号」(矩阵号:赛道/关键词/人设在各账号上设)
 *   onSave:走矩阵 saveTask(accountIds + 配额 + 频率 + 同时开窗)
 * 跟老客户端唯一区别就是「控制 1 个账号 vs 多个账号」。
 */

import React, { useEffect, useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';

const LIKE_HARDCAP = 500;
const FOLLOW_HARDCAP = 100;
const COMMENT_HARDCAP = 100;

// 引流(评论时按概率把引流文案融进 AI 评论)。与 MatrixReplyFansWizard 同一套口径。
const FUNNEL_PHRASE_MAX = 200;
const FUNNEL_PROB_MIN = 1;
const FUNNEL_PROB_MAX = 100;
const FUNNEL_PROB_DEFAULT = 50;
// 评论引流生效面(全平台统一,用户要求):
//   抖音/快手/B站/TikTok/YouTube/Facebook/Instagram/Reddit —— 评论走 comment_composer 单串出口,
//     客户端 makeAiCall 在该出口融入(engageRunner.maybeWeaveFunnel);
//   币安广场/X/小红书 —— 评论走 __raw__ 出口,由各自剧本读 task.funnel_phrase/probability 做 AI 融合
//     (币安融合结果仍过禁词质检),后端热下发即生效。
const FUNNEL_SUPPORTED_PLATFORMS = new Set(['douyin', 'kuaishou', 'bilibili', 'tiktok', 'youtube', 'binance', 'facebook', 'instagram', 'reddit', 'x', 'xhs']);

type WizardStep = 1 | 2 | 3 | 4;
// 步骤:1 选账号 / 2 点赞+关注 / 3 评论(数量+语言+引流,单独一步免拥挤) / 4 频率+条款。
const TOTAL_STEPS = 4;

export interface WizardAccount { id: string; displayName: string; status: string; keywords?: string[]; group?: string; platform?: string; nickname?: string; displayId?: string; avatar?: string }

// 平台 id → 中文名(账号行里标出来,避免「分不清这是抖音还是 YouTube 的号」)。
const PLATFORM_NAME: Record<string, string> = { douyin: '抖音', xhs: '小红书', bilibili: 'B站', kuaishou: '快手', tiktok: 'TikTok', x: 'X', binance: '币安广场', youtube: 'YouTube', shipinhao: '视频号', toutiao: '头条' };
interface Props {
  platformLabel: string;
  platform?: string;                       // 平台 id(用于「无账号」引导跳到对应 tab)
  accounts: WizardAccount[];               // 可选账号(已登录 + 配了关键词)
  accountsLoading?: boolean;               // 账号异步加载中(弹窗先开、账号后填);加载中显「加载中」而非「无账号」
  initialTask?: any | null;                // 编辑时传入矩阵任务
  onCancel: () => void;
  onSave: (input: { name: string; accountIds: string[]; concurrency: number; frequency: string; quota: any; funnel: { funnel_phrase: string; funnel_probability: number } }) => Promise<void> | void;
}

const MatrixTaskWizard: React.FC<Props> = ({ platformLabel, platform, accounts, accountsLoading, initialTask, onCancel, onSave }) => {
  const editing = !!initialTask;
  const [step, setStep] = useState<WizardStep>(1);
  // 评论语言选择器只给【海外平台 + 币安广场】;中文平台(抖音/小红书/B站/快手/视频号/头条)不显示(默认跟帖子语言)。
  const overseasEngage = ['x', 'tiktok', 'youtube', 'binance', 'facebook', 'reddit', 'instagram'].includes(String(platform || ''));

  // 📺 刷剧模式(仅抖音互动):无视关键词,AI 在账号自己的推荐流(沉浸式播放器)里
  //   像真人一样刷视频完成点赞/评论/关注。走 quota.engage_mode 透传(全链已贯通);
  //   未配关键词的账号后端剧本也会自动进入该模式(兜底)。
  const bingeSupported = ['douyin', 'kuaishou', 'tiktok'].includes(String(platform || ''));
  const [bingeMode, setBingeModeRaw] = useState<boolean>(initialTask?.quota?.engage_mode === 'binge');

  // 任务名不让用户填(对齐旧版):内部按平台+账号数自动命名。
  // 默认勾选所有「可用」账号(配了关键词 + 未封);编辑时用任务已存的账号。
  const [selected, setSelected] = useState<Set<string>>(() => {
    if (initialTask?.accountIds) return new Set(initialTask.accountIds);
    return new Set(accounts.filter((a) => a.keywords && a.keywords.length && a.status !== 'banned' && a.status !== 'login_required').map((a) => a.id));
  });
  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  // 关掉刷剧模式时:无关键词账号在「关键词搜索」下不可用,从已选里剔除 —— 否则保存后
  //   engage_mode='' 但后端 bingeCapable 仍会因关键词为空自动进 binge,与"关掉刷剧"的意图相悖。
  const setBingeMode = (on: boolean) => {
    setBingeModeRaw(on);
    if (!on) setSelected((prev) => new Set([...prev].filter((id) => { const a = accounts.find((x) => x.id === id); return !!(a && a.keywords && a.keywords.length); })));
  };

  const q = initialTask?.quota || {};
  const [likeMin, setLikeMinRaw] = useState<number>(typeof q.daily_like_min === 'number' ? q.daily_like_min : 3);
  const [likeMax, setLikeMaxRaw] = useState<number>(typeof q.daily_like_max === 'number' ? q.daily_like_max : 8);
  const setLikeMin = (v: number) => { const n = Math.max(0, Math.min(LIKE_HARDCAP, v)); setLikeMinRaw(n); setLikeMaxRaw((p) => (p < n ? n : p)); };
  const setLikeMax = (v: number) => { const n = Math.max(0, Math.min(LIKE_HARDCAP, v)); setLikeMaxRaw(n); setLikeMinRaw((p) => (p > n ? n : p)); };
  const [folMin, setFolMinRaw] = useState<number>(typeof q.daily_follow_min === 'number' ? q.daily_follow_min : 0);
  const [folMax, setFolMaxRaw] = useState<number>(typeof q.daily_follow_max === 'number' ? q.daily_follow_max : 2);
  const setFolMin = (v: number) => { const n = Math.max(0, Math.min(FOLLOW_HARDCAP, v)); setFolMinRaw(n); setFolMaxRaw((p) => (p < n ? n : p)); };
  const setFolMax = (v: number) => { const n = Math.max(0, Math.min(FOLLOW_HARDCAP, v)); setFolMaxRaw(n); setFolMinRaw((p) => (p > n ? n : p)); };
  const [cmtMin, setCmtMinRaw] = useState<number>(typeof q.daily_comment_min === 'number' ? q.daily_comment_min : 1);
  const [cmtMax, setCmtMaxRaw] = useState<number>(typeof q.daily_comment_max === 'number' ? q.daily_comment_max : 3);
  const setCmtMin = (v: number) => { const n = Math.max(0, Math.min(COMMENT_HARDCAP, v)); setCmtMinRaw(n); setCmtMaxRaw((p) => (p < n ? n : p)); };
  const setCmtMax = (v: number) => { const n = Math.max(0, Math.min(COMMENT_HARDCAP, v)); setCmtMaxRaw(n); setCmtMinRaw((p) => (p > n ? n : p)); };

  // ── 引流语 + 概率(评论时才用;编辑老任务时回填,老任务没配则空) ──
  const [funnelPhrase, setFunnelPhrase] = useState<string>(String(initialTask?.funnel?.funnel_phrase || ''));
  const hasFunnel = funnelPhrase.trim().length > 0;
  const [funnelProb, setFunnelProb] = useState<number>(
    // 只在保存过【真实概率(≥ MIN)】时回填;老任务没配引流保存的是 0 →
    //   原来 Math.max(1,0)=1 会让「编辑后补引流语」默认成 1% → 改成回落 50% 默认(用户实测)。
    typeof initialTask?.funnel?.funnel_probability === 'number' && initialTask.funnel.funnel_probability >= FUNNEL_PROB_MIN
      ? Math.min(FUNNEL_PROB_MAX, initialTask.funnel.funnel_probability)
      : FUNNEL_PROB_DEFAULT
  );

  const [runInterval, setRunInterval] = useState<string>(initialTask?.frequency || 'daily_random');
  // 评论语言:auto(跟帖子语言)+ 9 种 UI 语言;强制模式。默认 auto。
  const [commentLang, setCommentLang] = useState<string>(initialTask?.quota?.comment_lang || 'auto');
  const [termsAccepted, setTermsAccepted] = useState<boolean[]>([true, true]);
  const allTermsAccepted = termsAccepted.every(Boolean);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const funnelSupported = FUNNEL_SUPPORTED_PLATFORMS.has(platform || '');
  const showFunnel = cmtMax > 0 && funnelSupported;
  const totalMaxActions = likeMax + folMax + cmtMax;
  useEffect(() => { if (saveError) setSaveError(null); /* eslint-disable-next-line */ }, [selected, likeMin, likeMax, folMin, folMax, cmtMin, cmtMax, funnelPhrase, funnelProb, runInterval]);

  const canAdvance: Record<WizardStep, { ok: boolean; reason?: string }> = {
    1: { ok: selected.size >= 1, reason: i18nService.t('wzEngageErrSelectAccount') },
    2: { ok: true }, // 点赞+关注:可全 0(只评论也行),校验放到评论那步保证「至少配一种动作」
    3: totalMaxActions === 0 ? { ok: false, reason: i18nService.t('wzEngageErrConfigAction') } : { ok: true },
    4: { ok: allTermsAccepted, reason: i18nService.t('wzEngageErrAcceptTerms') },
  };

  const handleSave = async () => {
    if (saving) return;
    if (!canAdvance[3].ok) { setSaveError(canAdvance[3].reason || ''); return; }
    setSaving(true);
    try {
      await onSave({
        name: initialTask?.name || i18nService.t('wzEngageTaskName').replace('{platform}', platformLabel).replace('{n}', String(selected.size)),
        accountIds: [...selected],
        concurrency: selected.size,   // 选几个号就同时开几个窗(runner 内部有安全上限兜底)
        frequency: runInterval,
        // Reddit 无关注玩法 → 强制 follow=0(即使有老值也清零),隐藏了滑块也不落库脏数据。
        quota: { daily_like_min: likeMin, daily_like_max: likeMax, daily_follow_min: platform === 'reddit' ? 0 : folMin, daily_follow_max: platform === 'reddit' ? 0 : folMax, daily_comment_min: cmtMin, daily_comment_max: cmtMax, comment_lang: commentLang, engage_mode: (bingeSupported && bingeMode) ? 'binge' : '' },
        // 引流:评论时按概率把引流文案融进 AI 评论。留空/平台不支持 → funnel_probability=0 → 视作未配,纯 AI 评论。
        funnel: (funnelSupported && hasFunnel) ? { funnel_phrase: funnelPhrase.trim(), funnel_probability: funnelProb } : { funnel_phrase: '', funnel_probability: 0 },
      });
    } catch (err) {
      setSaveError(String(err instanceof Error ? err.message : err) || i18nService.t('wzEngageErrSaveFailed'));
    } finally { setSaving(false); }
  };

  const intervalLabel = useMemo(() => {
    const m: Record<string, string> = { once: i18nService.t('wzEngageFreqOnce'), '30min': i18nService.t('wzEngageFreq30min'), '1h': i18nService.t('wzEngageFreq1h'), '3h': i18nService.t('wzEngageFreq3h'), '6h': i18nService.t('wzEngageFreq6h'), daily_random: i18nService.t('wzEngageFreqDailyRandomFull') };
    return m[runInterval] || runInterval;
  }, [runInterval]);

  return (
    <div className="w-full max-w-2xl max-h-[90vh] mx-auto rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden flex flex-col">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800 shrink-0">
        <div className="text-base font-semibold dark:text-white">🎶 {editing ? i18nService.t('wzEngageTitleEdit').replace('{platform}', platformLabel) : i18nService.t('wzEngageTitleCreate').replace('{platform}', platformLabel)}</div>
        <div className="flex items-center gap-3">
          <span className="text-xs px-2.5 py-1 rounded-full border border-violet-500/40 text-violet-500 bg-violet-500/5">{i18nService.t('wzEngageStepCounter').replace('{n}', String(step)).replace('{total}', String(TOTAL_STEPS))}</span>
          <button type="button" onClick={onCancel} disabled={saving} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">✕</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
        {step === 1 && (
          <>
            {bingeSupported && (
              <label className={`flex items-start gap-2.5 rounded-xl border px-4 py-3 cursor-pointer transition-colors ${bingeMode ? 'border-violet-500/50 bg-violet-500/5' : 'border-gray-200 dark:border-gray-700 hover:border-violet-500/30'}`}>
                <input type="checkbox" checked={bingeMode} onChange={(e) => setBingeMode(e.target.checked)} disabled={saving} className="h-4 w-4 accent-violet-500 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-medium dark:text-gray-200">📺 {i18nService.currentLanguage === 'zh' ? '刷剧模式' : 'Binge mode'}</div>
                  <div className="text-[11px] text-gray-400 leading-relaxed mt-0.5">
                    {i18nService.currentLanguage === 'zh'
                      ? '开启后无视关键词:AI 在账号自己的推荐流里像真人一样刷短视频,随机点赞/评论/关注,看完上滑下一条。适合养号提活跃;要精准吸引某赛道粉丝请关闭它用关键词搜索。未配关键词的账号会自动按此模式运行。'
                      : 'Ignores keywords: AI binge-watches the account\'s own recommendation feed like a real user — random likes/comments/follows, then swipes to the next video. Great for warming up accounts; turn it off for keyword-targeted growth. Accounts without keywords run in this mode automatically.'}
                  </div>
                </div>
              </label>
            )}
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                {i18nService.t('wzEngageSelectAccounts').replace('{platform}', platformLabel)}<span className="text-xs text-gray-400 font-normal ml-1">{i18nService.t('wzEngageSelectAccountsHint').replace('{n}', String(selected.size))}</span>
              </label>
              <div className="space-y-1.5 max-h-64 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700 p-2">
                {accounts.length === 0 && accountsLoading && (
                  <div className="p-3 text-center text-xs text-gray-400">{i18nService.t('wzEngageAccountsLoading')}</div>
                )}
                {accounts.length === 0 && !accountsLoading && (
                  <div className="p-3 text-center space-y-2.5">
                    <div className="text-xs text-gray-400">{i18nService.t('wzEngageNoAccounts')}</div>
                    <button
                      type="button"
                      onClick={() => { window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform } })); onCancel(); }}
                      className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-white text-sm font-semibold bg-violet-500 hover:bg-violet-600 active:scale-95"
                    >{i18nService.t('wzEngageGoAddAccounts')}</button>
                  </div>
                )}
                {accounts.map((a) => {
                  const hasKw = !!(a.keywords && a.keywords.length);
                  // 未连接(login_required)/已封 → 不可选(置灰);还要配了关键词。
                  // 刷剧模式(抖音)开启时不需要关键词 — 无关键词账号也可选,提示改为推荐流互动。
                  const bingeOk = bingeSupported && bingeMode;
                  const linked = a.status !== 'login_required' && a.status !== 'banned';
                  const ready = (hasKw || bingeOk) && linked;
                  const reason = a.status === 'banned' ? i18nService.t('wzEngageReasonBanned') : a.status === 'login_required' ? i18nService.t('wzEngageReasonNotConnected') : !hasKw ? (bingeOk ? (i18nService.currentLanguage === 'zh' ? '无关键词 · 推荐流互动' : 'no keywords · feed mode') : i18nService.t('wzEngageReasonNoKeywords')) : '';
                  const title = a.nickname || a.displayName;
                  return (
                    <label key={a.id} className={`flex items-center gap-2.5 text-sm px-2 py-1.5 rounded ${ready ? 'dark:text-gray-200 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800' : 'opacity-45 cursor-not-allowed'}`}>
                      <input type="checkbox" checked={selected.has(a.id)} onChange={() => ready && toggle(a.id)} disabled={saving || !ready} className="h-4 w-4 accent-violet-500 shrink-0" />
                      {/* 头像 */}
                      {a.avatar
                        ? <img src={a.avatar.replace(/^http:/, 'https:')} referrerPolicy="no-referrer" alt="" className="w-7 h-7 rounded-full object-cover bg-gray-200 dark:bg-gray-700 shrink-0" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                        : <span className="w-7 h-7 rounded-full bg-violet-500/20 text-violet-500 flex items-center justify-center text-xs font-bold shrink-0">{(title || '?').slice(0, 1)}</span>}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-500">{PLATFORM_NAME[a.platform || ''] || a.platform}</span>
                          <span className="font-medium truncate dark:text-white">{title}</span>
                          {a.displayId && <span className="text-[11px] text-gray-500 dark:text-gray-400 shrink-0">{i18nService.t('wzEngageAccountIdLabel').replace('{platform}', PLATFORM_NAME[a.platform || ''] || '')}{a.displayId}</span>}
                          {a.status === 'login_required'
                            ? <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform: a.platform || platform } })); onCancel(); }} title={i18nService.t('wzEngageGoLoginTitle')} className="text-[11px] text-amber-500 underline decoration-dotted hover:text-amber-400 shrink-0">{i18nService.t('wzEngageNotConnectedGoLogin')}</button>
                            : reason ? <span className="text-[11px] text-amber-500 shrink-0">{reason}</span> : null}
                        </div>
                        <div className="text-[11px] text-gray-400 truncate">
                          {i18nService.t('wzEngageNoteLabel')}{a.displayName}{a.group ? ` · ${a.group}` : ''}{hasKw ? ` · 🏷️ ${(a.keywords || []).join('/')}` : ''}
                        </div>
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
            <RangeSlider label={i18nService.t('wzEngageLikeLabel')} min={likeMin} max={likeMax} setMin={setLikeMin} setMax={setLikeMax} hardCap={LIKE_HARDCAP} hint={i18nService.t('wzEngageLikeHint').replace('{min}', String(likeMin)).replace('{max}', String(likeMax)).replace('{cap}', String(LIKE_HARDCAP))} disabled={saving} />
            {/* Reddit 无「关注用户」玩法(涨粉靠发帖不靠关注)→ 隐藏关注数量;其余平台照常。
                FB 走「加好友」(FB 涨粉正道,对方通过=互相可见),文案与上限(20)专门收口,风控更敏感。 */}
            {platform !== 'reddit' && (() => {
              const isFb = platform === 'facebook';
              const folCap = isFb ? 20 : FOLLOW_HARDCAP;
              const folLabel = i18nService.t(isFb ? 'wzEngageAddFriendLabel' : 'wzEngageFollowLabel');
              return (
                <RangeSlider label={folLabel} min={folMin} max={Math.min(folMax, folCap)} setMin={setFolMin} setMax={setFolMax} hardCap={folCap} hint={i18nService.t(isFb ? 'wzEngageAddFriendHint' : 'wzEngageFollowHint').replace('{min}', String(folMin)).replace('{max}', String(Math.min(folMax, folCap))).replace('{cap}', String(folCap))} disabled={saving} />
              );
            })()}

            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-700 dark:text-amber-300 leading-relaxed space-y-1">
              <div className="font-semibold">{i18nService.t('wzEngageSafetyTitle')}</div>
              <ul className="list-disc list-inside space-y-0.5">
                <li>{i18nService.t('wzEngageSafetyTip1')}</li>
                <li>{i18nService.t('wzEngageSafetyTip2')}</li>
              </ul>
            </div>
          </>
        )}

        {/* Step 3:评论(数量 + 语言 + 引流)单独一步 —— 一页放不下,拆出来。 */}
        {step === 3 && (
          <>
            <RangeSlider label={i18nService.t('wzEngageCommentLabel')} min={cmtMin} max={cmtMax} setMin={setCmtMin} setMax={setCmtMax} hardCap={COMMENT_HARDCAP} hint={i18nService.t('wzEngageCommentHint').replace('{min}', String(cmtMin)).replace('{max}', String(cmtMax)).replace('{cap}', String(COMMENT_HARDCAP))} disabled={saving} />

            {/* 评论语言(评论 max>0 且海外平台才显示):auto=跟帖子语言;选具体语言=强制用该语言写评论。中文平台不显示。 */}
            {cmtMax > 0 && overseasEngage && (
              <div>
                <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                  {i18nService.currentLanguage === 'zh' ? '评论语言' : 'Comment language'}
                  <span className="text-xs text-gray-400 font-normal ml-1">{i18nService.currentLanguage === 'zh' ? '选具体语言=强制用它写;自动=跟帖子语言' : 'a specific language forces it; Auto follows the post'}</span>
                </label>
                <select value={commentLang} onChange={(e) => setCommentLang(e.target.value)} disabled={saving} className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500/40">
                  {[
                    { code: 'auto', label: i18nService.currentLanguage === 'zh' ? '自动(跟帖子语言)' : 'Auto (follow post)' },
                    { code: 'zh', label: '简体中文' }, { code: 'zh-TW', label: '繁體中文' }, { code: 'en', label: 'English' },
                    { code: 'ja', label: '日本語' }, { code: 'ko', label: '한국어' }, { code: 'ru', label: 'Русский' },
                    { code: 'fr', label: 'Français' }, { code: 'de', label: 'Deutsch' }, { code: 'vi', label: 'Tiếng Việt' },
                  ].map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
                </select>
              </div>
            )}

            {/* 引流(评论 max>0 且平台支持时显示):评论时 AI 按概率把引流文案自然融进评论。留空=纯 AI 评论,老任务不受影响。 */}
            {showFunnel && (
              <div className="rounded-xl border border-fuchsia-500/25 bg-fuchsia-500/5 px-4 py-3 space-y-3">
                <div>
                  <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                    {i18nService.t('wzEngageFunnelPhraseLabel')}<span className="text-xs text-gray-400 font-normal ml-1">{i18nService.t('wzEngageFunnelPhraseHint')}</span>
                  </label>
                  <textarea
                    value={funnelPhrase}
                    onChange={(e) => setFunnelPhrase(e.target.value.slice(0, FUNNEL_PHRASE_MAX))}
                    placeholder={i18nService.t('wzEngageFunnelPhrasePlaceholder')}
                    rows={2}
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-fuchsia-500/40 resize-y min-h-[64px]"
                    disabled={saving}
                  />
                  <div className="text-[11px] text-gray-400 mt-1">{i18nService.t('wzEngageFunnelCharCount').replace('{n}', String(funnelPhrase.trim().length)).replace('{max}', String(FUNNEL_PHRASE_MAX))}</div>
                </div>
                <div>
                  <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                    {i18nService.t('wzEngageFunnelProbLabel').replace('{n}', String(hasFunnel ? funnelProb : 0))}
                    <span className="text-xs text-gray-400 font-normal ml-1">
                      {hasFunnel ? i18nService.t('wzEngageFunnelProbHintOn') : i18nService.t('wzEngageFunnelProbHintOff')}
                    </span>
                  </label>
                  <input
                    type="range"
                    min={FUNNEL_PROB_MIN}
                    max={FUNNEL_PROB_MAX}
                    value={funnelProb}
                    onChange={(e) => setFunnelProb(parseInt(e.target.value, 10))}
                    disabled={saving || !hasFunnel}
                    className="w-full accent-fuchsia-500 disabled:opacity-40"
                  />
                </div>
              </div>
            )}
          </>
        )}

        {step === 4 && (
          <>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">{i18nService.t('wzEngageRunIntervalLabel')}</label>
              <div className="flex gap-2 flex-wrap">
                {[['once', i18nService.t('wzEngageFreqOnce')], ['30min', i18nService.t('wzEngageFreq30min')], ['1h', i18nService.t('wzEngageFreq1h')], ['3h', i18nService.t('wzEngageFreq3h')], ['6h', i18nService.t('wzEngageFreq6h')], ['daily_random', i18nService.t('wzEngageFreqDailyRandom')]].map(([value, label]) => (
                  <button key={value} type="button" onClick={() => setRunInterval(value)} className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${runInterval === value ? 'border-violet-500 bg-violet-500/10 text-violet-500 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-violet-500/50'}`}>{label}</button>
                ))}
              </div>
              {runInterval === 'daily_random' && <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">{i18nService.t('wzEngageDailyRandomTip')}</p>}
              {(runInterval === '30min' || runInterval === '1h' || runInterval === '3h' || runInterval === '6h') && <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1.5">{i18nService.t('wzEngageJitterTip').replace('{range}', (runInterval === '3h' || runInterval === '6h') ? '1-45' : '1-10')}</p>}
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-4 py-3 text-sm space-y-1.5">
              <div className="font-semibold dark:text-gray-200 mb-1">{i18nService.t('wzEngageSummaryTitle')}</div>
              <SummaryRow label={i18nService.t('wzEngageSummaryAccounts')} value={i18nService.t('wzEngageSummaryAccountsValue').replace('{n}', String(selected.size))} />
              <SummaryRow label={i18nService.t('wzEngageSummaryLikes')} value={i18nService.t('wzEngageSummaryPerRunValue').replace('{min}', String(likeMin)).replace('{max}', String(likeMax))} />
              <SummaryRow label={i18nService.t(platform === 'facebook' ? 'wzEngageSummaryAddFriends' : 'wzEngageSummaryFollows')} value={i18nService.t('wzEngageSummaryPerRunValue').replace('{min}', String(folMin)).replace('{max}', String(folMax))} />
              <SummaryRow label={i18nService.t('wzEngageSummaryComments')} value={i18nService.t('wzEngageSummaryPerRunValue').replace('{min}', String(cmtMin)).replace('{max}', String(cmtMax))} />
              {showFunnel && <SummaryRow label={i18nService.t('wzEngageSummaryFunnel')} value={hasFunnel ? `"${funnelPhrase.trim().slice(0, 40)}${funnelPhrase.trim().length > 40 ? '...' : ''}" · ${funnelProb}%` : i18nService.t('wzEngageSummaryFunnelEmpty')} />}
              <SummaryRow label={i18nService.t('wzEngageSummaryConcurrency')} value={i18nService.t('wzEngageSummaryConcurrencyValue').replace('{n}', String(selected.size))} />
              <SummaryRow label={i18nService.t('wzEngageSummaryFrequency')} value={intervalLabel} />
            </div>
            <div className="space-y-2">
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{i18nService.t('wzEngageTermsTitle')}</div>
              {[i18nService.t('wzEngageTerm1'), i18nService.t('wzEngageTerm2')].map((term, i) => (
                <label key={i} className="flex items-start gap-2 text-xs text-gray-700 dark:text-gray-300 cursor-pointer">
                  <input type="checkbox" checked={termsAccepted[i]} onChange={(e) => { const next = [...termsAccepted]; next[i] = e.target.checked; setTermsAccepted(next); }} disabled={saving} className="mt-0.5 h-4 w-4 accent-violet-500 shrink-0" />
                  <span className="leading-relaxed">{term}</span>
                </label>
              ))}
            </div>
          </>
        )}
      </div>

      {/* 仅在用户点了「下一步/创建」校验不过(saveError 被置)时才提示;不再常驻显示「请勾选」 */}
      {saveError && (
        <div className="px-6 pt-2 pb-1 shrink-0">
          <div className="rounded-lg border px-3 py-2 text-xs leading-relaxed border-red-500/30 bg-red-500/5 text-red-600 dark:text-red-400">
            ❌ {saveError}
          </div>
        </div>
      )}

      <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-800 flex items-center gap-2 shrink-0">
        <button type="button" onClick={onCancel} disabled={saving} className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 px-2">{i18nService.t('wzEngageCancel')}</button>
        <div className="flex-1" />
        {step > 1 && <button type="button" onClick={() => setStep((step - 1) as WizardStep)} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50">{i18nService.t('wzEngagePrev')}</button>}
        {step < TOTAL_STEPS ? (
          <button type="button" onClick={() => { if (!canAdvance[step].ok) { setSaveError(canAdvance[step].reason || ''); return; } setSaveError(null); setStep((step + 1) as WizardStep); }} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-50">{i18nService.t('wzEngageNext')}</button>
        ) : (
          <button type="button" onClick={handleSave} disabled={saving || !allTermsAccepted} className="px-5 py-2 rounded-lg text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-50">{saving ? i18nService.t('wzEngageSaving') : (editing ? i18nService.t('wzEngageSaveEdit') : i18nService.t('wzEngageCreate'))}</button>
        )}
      </div>
    </div>
  );
};

const RangeSlider: React.FC<{ label: string; min: number; max: number; setMin: (v: number) => void; setMax: (v: number) => void; hardCap: number; hint: string; disabled?: boolean }> = ({ label, min, max, setMin, setMax, hardCap, hint, disabled }) => (
  <div>
    <label className="text-sm font-medium dark:text-gray-200 mb-2 block">{label}{i18nService.t('wzEngageRandomRangeSuffix')}</label>
    <div className="grid grid-cols-2 gap-4">
      <div>
        <div className="text-[11px] text-gray-500 dark:text-gray-400 mb-1">{i18nService.t('wzEngageRangeMin')} <span className="font-bold text-violet-500">{min}</span></div>
        <input type="range" min={0} max={hardCap} value={min} onChange={(e) => setMin(parseInt(e.target.value, 10))} disabled={disabled} className="w-full accent-violet-500" />
      </div>
      <div>
        <div className="text-[11px] text-gray-500 dark:text-gray-400 mb-1">{i18nService.t('wzEngageRangeMax')} <span className="font-bold text-violet-500">{max}</span></div>
        <input type="range" min={0} max={hardCap} value={max} onChange={(e) => setMax(parseInt(e.target.value, 10))} disabled={disabled} className="w-full accent-violet-500" />
      </div>
    </div>
    <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-1">{hint}</div>
  </div>
);

const SummaryRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex gap-3 text-xs"><span className="text-gray-500 dark:text-gray-400 shrink-0 w-20">{label}</span><span className="text-gray-800 dark:text-gray-200 break-all">{value}</span></div>
);

export default MatrixTaskWizard;
