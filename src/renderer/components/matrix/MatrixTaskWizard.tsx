/**
 * MatrixTaskWizard — 直接照搬老客户端 DouyinConfigWizard 的样式/结构(violet 3-step
 * 向导 + RangeSlider 滑条 + 摘要卡 + 条款),只改两处:
 *   Step 1:赛道/关键词 → 「勾选多个已登录账号」(矩阵号:赛道/关键词/人设在各账号上设)
 *   onSave:走矩阵 saveTask(accountIds + 配额 + 频率 + 同时开窗)
 * 跟老客户端唯一区别就是「控制 1 个账号 vs 多个账号」。
 */

import React, { useEffect, useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { platformSupportsFavorite } from '../../services/engageActions';
import MatrixFunnelConfig, { FunnelUnsetConfirm, countUnconfigured, FUNNEL_PROB_DEFAULT as FPD } from './MatrixFunnelConfig';
import { NumMinMax, NumRow } from './NumberStepper';
import { AccountKeywordTabs, effectiveKw } from './MatrixAccountKeywords';
import { presetAccountIds, usePresetUsed, usePresetPrune } from '../../uiEdition';

const LIKE_HARDCAP = 500;
const FOLLOW_HARDCAP = 100;
const COMMENT_HARDCAP = 100;

// 引流(评论时按概率把引流文案融进 AI 评论)。与 MatrixReplyFansWizard 同一套口径。
const FUNNEL_PHRASE_MAX = 1000;
const FUNNEL_PROB_MIN = 1;
const FUNNEL_PROB_MAX = 100;
const FUNNEL_PROB_DEFAULT = 100;   // 2026-10-28:有引流语时默认 100%(原 50%);没填引流语时概率不生效
// 评论引流生效面(全平台统一,用户要求):
//   抖音/快手/B站/TikTok/YouTube/Facebook/Instagram/Reddit —— 评论走 comment_composer 单串出口,
//     客户端 makeAiCall 在该出口融入(engageRunner.maybeWeaveFunnel);
//   币安广场/X/小红书 —— 评论走 __raw__ 出口,由各自剧本读 task.funnel_phrase/probability 做 AI 融合
//     (币安融合结果仍过禁词质检),后端热下发即生效。
const FUNNEL_SUPPORTED_PLATFORMS = new Set(['douyin', 'kuaishou', 'bilibili', 'tiktok', 'youtube', 'binance', 'facebook', 'instagram', 'reddit', 'x', 'xhs', 'gate', 'bitget', 'bybit', 'okx']);

type WizardStep = number;
// 收藏上限跟点赞同量级(它比关注安全得多,但仍是可被风控的动作)。
const FAVORITE_HARDCAP = 100;
// 精准模式一次最多粘 50 条链接(与定向获客的种子上限同口径)。
// 精准模式也收博主主页链接的平台(剧本侧:打开主页取最近 5 条作品逐条互动)。
const PROFILE_LINK_PLATFORMS = new Set<string>(['douyin', 'xhs', 'tiktok']);
const PRECISE_URL_MAX = 50;
// 步骤(动态):1 选账号 / 2 点赞+关注 / 3 评论(数量+语言) / [4 引流(平台支持且评论>0 才有)] / 末步 频率+条款。
// 引流独立成一步:支持「所有账号共用」与「各账号各自配置」两种模式(用户需求 2026-08-09)。

export interface WizardAccount { id: string; displayName: string; status: string; keywords?: string[]; derivedKeywords?: string[]; group?: string; platform?: string; nickname?: string; displayId?: string; avatar?: string }

// 平台 id → 中文名(账号行里标出来,避免「分不清这是抖音还是 YouTube 的号」)。
const PLATFORM_NAME: Record<string, string> = { douyin: '抖音', xhs: '小红书', bilibili: 'B站', kuaishou: '快手', tiktok: 'TikTok', x: 'X', binance: '币安广场', youtube: 'YouTube', shipinhao: '视频号', toutiao: '头条' };
interface Props {
  platformLabel: string;
  platform?: string;                       // 平台 id(用于「无账号」引导跳到对应 tab)
  accounts: WizardAccount[];               // 可选账号(已登录 + 配了关键词)
  accountsLoading?: boolean;               // 账号异步加载中(弹窗先开、账号后填);加载中显「加载中」而非「无账号」
  initialTask?: any | null;                // 编辑时传入矩阵任务
  onCancel: () => void;
  onSave: (input: { name: string; accountIds: string[]; concurrency: number; frequency: string; quota: any; funnel: { funnel_phrase: string; funnel_probability: number }; funnelByAccount: Record<string, { funnel_phrase: string; funnel_probability: number }> | null }) => Promise<void> | void;
}

const MatrixTaskWizard: React.FC<Props> = ({ platformLabel, platform, accounts, accountsLoading, initialTask, onCancel, onSave }) => {
  const editing = !!initialTask;
  const [step, setStep] = useState<WizardStep>(1);
  // 评论语言选择器只给【海外平台 + 币安广场】;中文平台(抖音/小红书/B站/快手/视频号/头条)不显示(默认跟帖子语言)。
  const overseasEngage = ['x', 'tiktok', 'youtube', 'binance', 'facebook', 'reddit', 'instagram', 'gate', 'bitget', 'bybit', 'okx'].includes(String(platform || ''));

  // 📺 刷剧模式(仅抖音互动):无视关键词,AI 在账号自己的推荐流(沉浸式播放器)里
  //   像真人一样刷视频完成点赞/评论/关注。走 quota.engage_mode 透传(全链已贯通);
  //   未配关键词的账号后端剧本也会自动进入该模式(兜底)。
  const bingeSupported = ['douyin', 'kuaishou', 'tiktok'].includes(String(platform || ''));
  // 🎯 精准模式:用户粘一批作品链接,每条按配置做点赞/收藏/关注/评论 —— 不搜索、不刷推荐流。
  //   后半段(打开页 → 互动)复用的就是关键词模式那套动作函数,所以有 auto_engage 剧本的平台都支持。
  //   ⚠️ 只列【剧本真的实现了 precise 分支】的平台 —— 没实现就不给入口,否则用户选了会跑成
  //   「配额全 0,无动作可做」。X 还没适配(它只有 postReplyToTweet,没有点赞/收藏那套动作函数)。
  //   小红书 2026-08-26 补上了:它主循环是 actionQueue 驱动、每篇笔记只做一个动作,跟精准模式
  //   「一条链接把动作做完」对不上,所以是单写的一条 runPreciseFlow,不是塞进原循环。
  const preciseSupported = ['douyin', 'kuaishou', 'bilibili', 'tiktok', 'youtube', 'xhs'].includes(String(platform || ''));
  // ⭐ 收藏:只有这几家的剧本实现了收藏动作(其它平台要么没有收藏,要么 DOM 还没扒)。
  // 名单挪到 services/engageActions —— 原来这里、详情页累计完成、账号卡各抄一份,加平台漏改一处界面就自相矛盾
  const favoriteSupported = platformSupportsFavorite(platform);
  // 模式三态。新建默认:支持刷剧的平台进刷剧,其余进关键词 —— 精准要用户粘链接,不能当默认。
  //   编辑已有任务按存的 engage_mode 回填(老任务无该字段 = 关键词模式)。
  type EngageModeKind = 'binge' | 'search' | 'precise';
  const [engageMode, setEngageModeRaw] = useState<EngageModeKind>(() => {
    const saved = String(initialTask?.quota?.engage_mode || '');
    if (saved === 'precise') return 'precise';
    if (saved === 'binge') return 'binge';
    if (initialTask) return 'search';
    return bingeSupported ? 'binge' : 'search';
  });
  const bingeMode = engageMode === 'binge';
  const preciseMode = engageMode === 'precise';

  // 任务名不让用户填(对齐旧版):内部按平台+账号数自动命名。
  // 默认勾选所有「可用」账号(配了关键词 + 未封);编辑时用任务已存的账号。
  const [selected, setSelected] = useState<Set<string>>(() => {
    if (initialTask?.accountIds) return new Set(initialTask.accountIds);
    if (!initialTask && presetAccountIds(platform).length) return new Set<string>(presetAccountIds(platform));   // 简洁版:创建任务时已选好的号
    return new Set(accounts.filter((a) => effectiveKw(a).length && a.status !== 'banned' && a.status !== 'login_required').map((a) => a.id));
  });
  // 简洁版预选号:账号加载完后剔除不在本向导列表里的号(见 usePresetPrune)
  const presetUsed = usePresetUsed(initialTask, platform);
  usePresetPrune(presetUsed, accounts, accountsLoading, (live) => setSelected((prev) => { const n = new Set(Array.from(prev).filter((id) => live.has(id))); return n.size === prev.size ? prev : n; }));
  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  // 2026-10-28:关键词模式下没配词的账号也能勾 —— 下一步「关键词」里当场补(改的就是矩阵账号那份),
  //   补齐前过不了那一步,所以不会出现「没词的号被后端自动转成刷剧」。切模式不再剔号。
  const setEngageMode = (m: EngageModeKind) => { setEngageModeRaw(m); };
  // 向导里改过的关键词(已写回矩阵账号);校验/展示都按 effectiveKw(账号, kwOverride) 取。
  const [kwOverride, setKwOverride] = useState<Record<string, string[]>>({});
  const [kwEditingId, setKwEditingId] = useState<string | null>(null);

  const q = initialTask?.quota || {};
  const [likeMin, setLikeMinRaw] = useState<number>(typeof q.daily_like_min === 'number' ? q.daily_like_min : 3);
  const [likeMax, setLikeMaxRaw] = useState<number>(typeof q.daily_like_max === 'number' ? q.daily_like_max : 100);
  const setLikeMin = (v: number) => { const n = Math.max(0, Math.min(LIKE_HARDCAP, v)); setLikeMinRaw(n); setLikeMaxRaw((p) => (p < n ? n : p)); };
  const setLikeMax = (v: number) => { const n = Math.max(0, Math.min(LIKE_HARDCAP, v)); setLikeMaxRaw(n); setLikeMinRaw((p) => (p > n ? n : p)); };
  const [folMin, setFolMinRaw] = useState<number>(typeof q.daily_follow_min === 'number' ? q.daily_follow_min : 1);
  const [folMax, setFolMaxRaw] = useState<number>(typeof q.daily_follow_max === 'number' ? q.daily_follow_max : 10);
  const setFolMin = (v: number) => { const n = Math.max(0, Math.min(FOLLOW_HARDCAP, v)); setFolMinRaw(n); setFolMaxRaw((p) => (p < n ? n : p)); };
  const setFolMax = (v: number) => { const n = Math.max(0, Math.min(FOLLOW_HARDCAP, v)); setFolMaxRaw(n); setFolMinRaw((p) => (p > n ? n : p)); };
  // 单个作品最多评论几次(0~5)。老任务没存过 → 1 = 老行为「同一条评过就不再评」。
  const [maxCmtPerWork, setMaxCmtPerWork] = useState<number>(
    typeof q.max_comment_per_work === 'number' ? Math.min(5, Math.max(0, q.max_comment_per_work)) : 1);
  // ── 收藏配额(关键词/刷剧模式;放在关注下方)──
  const [favMin, setFavMinRaw] = useState<number>(typeof q.daily_favorite_min === 'number' ? q.daily_favorite_min : 1);
  const [favMax, setFavMaxRaw] = useState<number>(typeof q.daily_favorite_max === 'number' ? q.daily_favorite_max : 10);
  const setFavMin = (v: number) => { const n = Math.max(0, Math.min(FAVORITE_HARDCAP, v)); setFavMinRaw(n); setFavMaxRaw((prev) => (prev < n ? n : prev)); };
  const setFavMax = (v: number) => { const n = Math.max(0, Math.min(FAVORITE_HARDCAP, v)); setFavMaxRaw(n); setFavMinRaw((prev) => (prev > n ? n : prev)); };
  // ── 精准模式:链接清单 + 每条链接做几次 ──
  const [preciseText, setPreciseText] = useState<string>(() => (Array.isArray(q.precise_urls) ? q.precise_urls.join('\n') : ''));
  const [pLike, setPLike] = useState<number>(typeof q.precise_like === 'number' ? q.precise_like : 1);
  const [pFav, setPFav] = useState<number>(typeof q.precise_favorite === 'number' ? q.precise_favorite : 0);
  const [pFollow, setPFollow] = useState<number>(typeof q.precise_follow === 'number' ? q.precise_follow : 0);
  const [pComment, setPComment] = useState<number>(typeof q.precise_comment === 'number' ? q.precise_comment : 1);
  // 按行解析链接:去空行、去重、封顶 50。同一条粘两遍 = 做两遍动作,几乎肯定是手滑。
  const preciseUrls = React.useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const line of String(preciseText || '').split(/\r?\n/)) {
      const v = line.trim();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
      if (out.length >= PRECISE_URL_MAX) break;
    }
    return out;
  }, [preciseText]);
  const [cmtMin, setCmtMinRaw] = useState<number>(typeof q.daily_comment_min === 'number' ? q.daily_comment_min : 1);
  const [cmtMax, setCmtMaxRaw] = useState<number>(typeof q.daily_comment_max === 'number' ? q.daily_comment_max : 50);
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
  // ── 各账号独立引流语(编辑回填:任务存了 funnelByAccount 即进「各账号」模式) ──
  // 模式判定按【字段存在】而非条目数:各账号模式但一个都没配(允许放行)保存的是 {},
  // 用 length 判会误回共用(用户实测 bug)。兼容 camel(矩阵原始)与 snake(scenario 映射)两种形状。
  const initFba = (initialTask as any)?.funnelByAccount ?? (initialTask as any)?.funnel_by_account;
  const [funnelPerMode, setFunnelPerMode] = useState<boolean>(initFba !== undefined && initFba !== null && typeof initFba === 'object');
  const [funnelPerMap, setFunnelPerMap] = useState<Record<string, { funnel_phrase: string; funnel_probability: number }>>(() => {
    const src = initFba || {};
    const out: Record<string, { funnel_phrase: string; funnel_probability: number }> = {};
    for (const [id, v] of Object.entries(src) as any) out[id] = { funnel_phrase: String(v?.funnel_phrase || ''), funnel_probability: typeof v?.funnel_probability === 'number' && v.funnel_probability >= FUNNEL_PROB_MIN ? Math.min(FUNNEL_PROB_MAX, v.funnel_probability) : FPD };
    return out;
  });
  // 「不管了,下一步」确认弹层(各账号模式下有账号未配引流时,新建/编辑都拦一道)
  const [funnelUnsetConfirm, setFunnelUnsetConfirm] = useState<number | null>(null);

  const [runInterval, setRunInterval] = useState<string>(initialTask?.frequency || 'daily_random');
  // 评论语言:auto(跟帖子语言)+ 9 种 UI 语言;强制模式。默认 auto。
  const [commentLang, setCommentLang] = useState<string>(initialTask?.quota?.comment_lang || 'auto');
  const [termsAccepted, setTermsAccepted] = useState<boolean[]>([true, true]);
  const allTermsAccepted = termsAccepted.every(Boolean);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const funnelSupported = FUNNEL_SUPPORTED_PLATFORMS.has(platform || '');
  // 引流语只在会评论时才有意义 —— 精准模式看 pComment,其它模式看 cmtMax。
  const showFunnel = (preciseMode ? pComment > 0 : cmtMax > 0) && funnelSupported;
  const totalMaxActions = likeMax + folMax + cmtMax + favMax;
  // 动态步骤表:精准模式用自己那一步(链接 + 每条做几次),不走关键词模式的区间配额/评论两步。
  const stepNames: string[] = preciseMode
    ? (showFunnel ? ['accounts', 'precise', 'funnel', 'final'] : ['accounts', 'precise', 'final'])
    : (showFunnel ? ['accounts', 'keywords', 'quota', 'comment', 'funnel', 'final'] : ['accounts', 'keywords', 'quota', 'comment', 'final']);
  const TOTAL_STEPS = stepNames.length;
  const cur = stepNames[Math.min(step, TOTAL_STEPS) - 1];
  // 已选账号(引流步的卡片列表用;标题/赛道与 Step1 行一致)
  const selectedAccounts = accounts.filter((a) => selected.has(a.id)).map((a) => ({ id: a.id, title: a.nickname || a.displayName, group: a.group, platformName: PLATFORM_NAME[a.platform || ''] || a.platform, avatar: a.avatar }));
  useEffect(() => { if (saveError) setSaveError(null); /* eslint-disable-next-line */ }, [selected, likeMin, likeMax, folMin, folMax, cmtMin, cmtMax, favMin, favMax, maxCmtPerWork, preciseText, pLike, pFav, pFollow, pComment, funnelPhrase, funnelProb, runInterval, kwOverride, kwEditingId]);

  const KL = (zh: string, tw: string, en: string) => (i18nService.currentLanguage === 'zh' ? zh : i18nService.currentLanguage === 'zh-TW' ? tw : en);
  const kwMissingIds = accounts.filter((a) => selected.has(a.id) && effectiveKw(a, kwOverride).length === 0).map((a) => a.id);
  const canAdvance: Record<string, { ok: boolean; reason?: string }> = {
    accounts: { ok: selected.size >= 1, reason: i18nService.t('wzEngageErrSelectAccount') },
    // 关键词步(关键词 / 刷剧模式):关键词模式下每个选中号都得有词;刷剧模式词是可选的(用来判断视频对不对题)。
    keywords: kwEditingId
      ? { ok: false, reason: KL('还有关键词没保存,先保存或取消', '還有關鍵詞沒儲存,先儲存或取消', 'Save or cancel the keywords you are editing first') }
      : (!bingeMode && kwMissingIds.length > 0)
        ? { ok: false, reason: KL(`还有 ${kwMissingIds.length} 个账号没配关键词,点上面的账号补上`, `還有 ${kwMissingIds.length} 個帳號沒設定關鍵詞,點上面的帳號補上`, `${kwMissingIds.length} account(s) have no keywords yet — pick them above and add some`) }
        : { ok: true },
    quota: { ok: true }, // 点赞+关注:可全 0(只评论也行),校验放到评论那步保证「至少配一种动作」
    // 精准模式:链接和动作都在同一步填,所以两样都在这里卡。
    precise: preciseUrls.length === 0
      ? { ok: false, reason: i18nService.currentLanguage === 'zh' ? '请至少粘一条作品链接' : 'Paste at least one post link' }
      : (pLike + pFav + pFollow + pComment) === 0
        ? { ok: false, reason: i18nService.currentLanguage === 'zh' ? '点赞 / 收藏 / 关注 / 评论至少要开一项,否则打开链接后什么也不会做' : 'Enable at least one action, otherwise nothing happens after opening the links' }
        : { ok: true },
    comment: totalMaxActions === 0 ? { ok: false, reason: i18nService.t('wzEngageErrConfigAction') } : { ok: true },
    funnel: { ok: true }, // 未配置账号的拦截走确认弹层(下一步按钮里),不在这硬卡
    final: { ok: allTermsAccepted, reason: i18nService.t('wzEngageErrAcceptTerms') },
  };

  // 各账号模式:保存/透传用的净化 map(只留有引流语的账号,且只留已勾选账号)
  const cleanPerMap = () => {
    const out: Record<string, { funnel_phrase: string; funnel_probability: number }> = {};
    for (const id of selected) {
      const v = funnelPerMap[id];
      const ph = (v?.funnel_phrase || '').trim();
      if (ph) out[id] = { funnel_phrase: ph, funnel_probability: v.funnel_probability };
    }
    return out;
  };

  const handleSave = async () => {
    if (saving) return;
    // ⚠️ 按模式选闸:comment 那道查的是 likeMax+folMax+cmtMax+favMax(关键词/刷剧的【区间】配额),
    //   而精准模式把那四个区间【有意】存成 0(动作数在 precise_*)。写死用 comment 的话,
    //   新建时靠默认值 8/2/3 蒙混过关,一旦编辑已存的精准任务就回填全 0 → 明明配了动作却报「至少配一个」。
    const gate = preciseMode ? canAdvance.precise : canAdvance.comment;
    if (!gate.ok) { setSaveError(gate.reason || ''); return; }
    setSaving(true);
    try {
      await onSave({
        name: initialTask?.name || i18nService.t('wzEngageTaskName').replace('{platform}', platformLabel).replace('{n}', String(selected.size)),
        accountIds: [...selected],
        concurrency: selected.size,   // 选几个号就同时开几个窗(runner 内部有安全上限兜底)
        frequency: runInterval,
        // Reddit 无关注玩法 → 强制 follow=0(即使有老值也清零),隐藏了滑块也不落库脏数据。
        // ⚠️ 精准模式下【不能】把 like/follow/comment 区间也写成用户设的那些数 ——
        //   剧本在精准分支只读 precise_*,但这些区间会显示在详情页/摘要里,写错了用户会以为
        //   任务要按区间跑。所以精准模式把区间清零,只留 precise_*。
        quota: preciseMode
          ? {
            daily_like_min: 0, daily_like_max: 0, daily_follow_min: 0, daily_follow_max: 0,
            daily_comment_min: 0, daily_comment_max: 0, daily_favorite_min: 0, daily_favorite_max: 0,
            comment_lang: commentLang, engage_mode: 'precise',
            // 精准模式用自己的 precise_cmt 去重,这个值用不上,但要原样带着 ——
            //   否则用户在精准模式存一次,关键词模式那边配的上限就被抹成默认了。
            max_comment_per_work: maxCmtPerWork,
            precise_urls: preciseUrls,
            precise_like: pLike, precise_favorite: favoriteSupported ? pFav : 0,
            precise_follow: pFollow, precise_comment: pComment,
          }
          : {
            daily_like_min: likeMin, daily_like_max: likeMax,
            daily_follow_min: platform === 'reddit' ? 0 : folMin, daily_follow_max: platform === 'reddit' ? 0 : folMax,
            daily_comment_min: cmtMin, daily_comment_max: cmtMax,
            daily_favorite_min: favoriteSupported ? favMin : 0, daily_favorite_max: favoriteSupported ? favMax : 0,
            max_comment_per_work: maxCmtPerWork,
            comment_lang: commentLang, engage_mode: (bingeSupported && bingeMode) ? 'binge' : '',
          },
        // 引流:评论时按概率把引流文案融进 AI 评论。留空/平台不支持 → funnel_probability=0 → 视作未配,纯 AI 评论。
        // 各账号模式:任务级 funnel 置空,逐账号配置走 funnelByAccount;共用模式显式传 null 清掉旧的逐账号配置。
        funnel: (funnelSupported && !funnelPerMode && hasFunnel) ? { funnel_phrase: funnelPhrase.trim(), funnel_probability: funnelProb } : { funnel_phrase: '', funnel_probability: 0 },
        funnelByAccount: (funnelSupported && funnelPerMode) ? cleanPerMap() : null,
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
        {cur === 'accounts' && (
          <>
            {(bingeSupported || preciseSupported) && (() => {
              const zh = i18nService.currentLanguage === 'zh';
              const allOpts = [
                { on: 'binge' as EngageModeKind, show: bingeSupported, icon: '📺', title: zh ? '刷剧模式' : 'Binge mode',
                  desc: zh
                    ? '在账号自己的推荐流里像真人一样刷短视频,并在与账号赛道关键词匹配的视频下方随机点赞/评论/关注,更贴合推荐算法、精准找到受众粉丝。'
                    : 'Binge-watches the account\'s own recommendation feed like a real user, and likes/comments/follows on videos matching the account niche keywords — rides the recommendation algorithm to reach the right audience.' },
                { on: 'search' as EngageModeKind, show: true, icon: '🔍', title: zh ? '关键词筛选模式' : 'Keyword search mode',
                  desc: zh
                    ? '通过赛道关键词搜索,找到匹配合适的视频进行随机点赞/评论/关注互动,覆盖范围更大,适合增长探索。'
                    : 'Searches by niche keywords, finds matching videos and randomly likes/comments/follows — wider reach, good for growth exploration.' },
                { on: 'precise' as EngageModeKind, show: preciseSupported, icon: '🎯', title: zh ? '精准模式' : 'Targeted mode',
                  desc: zh
                    ? '你自己粘作品/帖子链接(最多 50 条),挨个打开按你设的次数点赞、收藏、关注作者、评论 —— 不搜索也不刷推荐流,打给你指定的那些内容。'
                    : 'Paste up to 50 post links yourself; each one is opened and gets exactly the likes / favorites / follows / comments you configure — no search, no feed.' },
              ];
              const opts = allOpts.filter((o) => o.show);
              return (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {opts.map((o) => {
                    const active = engageMode === o.on;
                    return (
                      <button key={String(o.on)} type="button" disabled={saving} onClick={() => setEngageMode(o.on)}
                        className={`text-left rounded-xl border px-4 py-3 transition-colors ${active ? 'border-violet-500 bg-violet-500/5 ring-1 ring-violet-500/40' : 'border-gray-200 dark:border-gray-700 hover:border-violet-500/40'} ${saving ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}>
                        <div className="flex items-center gap-2">
                          <span className={`h-3.5 w-3.5 rounded-full border shrink-0 ${active ? 'border-violet-500 bg-violet-500' : 'border-gray-400'}`} />
                          <span className="text-sm font-medium dark:text-gray-200">{o.icon} {o.title}</span>
                        </div>
                        <div className="text-[11px] text-gray-400 leading-relaxed mt-1">{o.desc}</div>
                      </button>
                    );
                  })}
                </div>
              );
            })()}
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
                  const hasKw = effectiveKw(a, kwOverride).length > 0;
                  // 未连接(login_required)/已封 → 不可选(置灰)。没配关键词的号也能勾:
                  //   关键词模式下一步「关键词」里必须补齐;刷剧模式没词就在推荐流里互动;精准模式不看词。
                  const bingeOk = bingeSupported && bingeMode;
                  const linked = a.status !== 'login_required' && a.status !== 'banned';
                  const ready = linked;   // 没配词的号也能勾,下一步「关键词」里当场补
                  const reason = a.status === 'banned' ? i18nService.t('wzEngageReasonBanned') : a.status === 'login_required' ? i18nService.t('wzEngageReasonNotConnected') : !hasKw ? (preciseMode ? (i18nService.currentLanguage === 'zh' ? '精准模式 · 不需要关键词' : 'targeted · no keywords needed') : bingeOk ? (i18nService.currentLanguage === 'zh' ? '无关键词 · 推荐流互动' : 'no keywords · feed mode') : KL('未配关键词 · 下一步补上', '未設定關鍵詞 · 下一步補上', 'no keywords · add next step')) : '';
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
                          {i18nService.t('wzEngageNoteLabel')}{a.displayName}{a.group ? ` · ${a.group}` : ''}{hasKw ? ` · 🏷️ ${effectiveKw(a, kwOverride).join('/')}` : ''}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {cur === 'keywords' && (
          <AccountKeywordTabs
            accounts={accounts.filter((a) => selected.has(a.id))}
            overrides={kwOverride}
            onSaved={(id, list) => setKwOverride((prev) => ({ ...prev, [id]: list }))}
            editingId={kwEditingId}
            onEditingIdChange={setKwEditingId}
            accent="violet"
            disabled={saving}
            intro={
              <div className="rounded-lg border px-3 py-2 text-[11px] leading-relaxed border-violet-500/30 bg-violet-500/5 text-violet-700 dark:text-violet-300">
                🏷️ {bingeMode
                  ? KL('刷剧时按账号的关键词判断视频对不对题(没配也能刷,只是不按赛道挑)。点上面的账号可以直接改它的关键词 —— 和「我的矩阵账号」是同一份,这里改了那边也跟着改。',
                    '刷劇時按帳號的關鍵詞判斷影片對不對題(沒設定也能刷,只是不按賽道挑)。點上面的帳號可以直接改它的關鍵詞 —— 和「我的矩陣帳號」是同一份,這裡改了那邊也跟著改。',
                    'In binge mode keywords decide which videos match the niche (optional). Pick an account above to edit its keywords — same keywords as My Matrix Accounts.')
                  : KL('每个账号按它自己的关键词搜视频去互动。点上面的账号可以直接改它的关键词 —— 和「我的矩阵账号」是同一份,这里改了那边也跟着改。每个号都要有关键词才能下一步。',
                    '每個帳號按它自己的關鍵詞搜影片去互動。點上面的帳號可以直接改它的關鍵詞 —— 和「我的矩陣帳號」是同一份,這裡改了那邊也跟著改。每個帳號都要有關鍵詞才能下一步。',
                    'Each account searches videos with its own keywords. Pick an account above to edit its keywords — same keywords as My Matrix Accounts. Every account needs keywords to continue.')}
              </div>
            }
            emptyHint={bingeMode
              ? KL('没配关键词 —— 会在推荐流里随便刷;想按赛道挑就点「修改关键词」补上', '沒設定關鍵詞 —— 會在推薦流裡隨便刷;想按賽道挑就點「修改關鍵詞」補上', 'No keywords — will engage on any feed video; add some to stay on-niche')
              : KL('没配关键词 —— 点「修改关键词」补上,否则没法搜', '沒設定關鍵詞 —— 點「修改關鍵詞」補上,否則沒法搜', 'No keywords — click Edit keywords to add some, otherwise nothing to search')}
          />
        )}

        {cur === 'quota' && (
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

            {/* ⭐ 收藏(2026-08-23):排在关注下方。只有实现了收藏动作的平台显示。 */}
            {favoriteSupported && (
              <RangeSlider
                label={i18nService.currentLanguage === 'zh' ? '⭐ 每次收藏' : '⭐ Favorites per run'}
                min={favMin} max={favMax} setMin={setFavMin} setMax={setFavMax} hardCap={FAVORITE_HARDCAP}
                hint={i18nService.currentLanguage === 'zh'
                  ? `每次运行随机收藏 ${favMin}-${favMax} 条(上限 ${FAVORITE_HARDCAP};设 0 = 不收藏)`
                  : `Randomly favorites ${favMin}-${favMax} posts per run (cap ${FAVORITE_HARDCAP}; 0 = off)`}
                disabled={saving} />
            )}

            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-700 dark:text-amber-300 leading-relaxed space-y-1">
              <div className="font-semibold">{i18nService.t('wzEngageSafetyTitle')}</div>
              <ul className="list-disc list-inside space-y-0.5">
                <li>{i18nService.t('wzEngageSafetyTip1')}</li>
                <li>{i18nService.t('wzEngageSafetyTip2')}</li>
              </ul>
            </div>
          </>
        )}

        {cur === 'precise' && (() => {
          const zh = i18nService.currentLanguage === 'zh';
          // 0/1 开关行 与 0-3 次数行:两种都用同一排按钮,少写一套样式。
          // 与「互动配置」用同一套数量输入框(NumBox 的 − [框] +),不再用按钮组 ——
          //   同一个向导里两种控件长得不一样,用户会以为是两类东西。
          const pickRow = (label: string, hint: string, val: number, set: (n: number) => void, hi: number) => (
            <NumRow label={label} hint={hint} value={val} onChange={set} min={0} max={hi}
              accent="violet" disabled={saving} suffix={zh ? '次' : ''} />
          );
          return (
            <>
              <div>
                <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                  {/* 抖音 / 小红书 / TikTok 精准模式也收博主主页链接:剧本打开主页取最近 5 条作品逐条互动,互动过的跳过(2026-10-29) */}
                  {PROFILE_LINK_PLATFORMS.has(platform || '')
                    ? (zh ? '作品 / 帖子 / 博主主页链接' : 'Post or profile links')
                    : (zh ? '作品 / 帖子链接' : 'Post links')}
                  <span className="text-xs text-gray-400 font-normal ml-1">
                    {zh
                      ? `一行一个,最多 ${PRECISE_URL_MAX} 条 · 已识别 ${preciseUrls.length} 条`
                      : `one per line, up to ${PRECISE_URL_MAX} · ${preciseUrls.length} detected`}
                  </span>
                </label>
                <textarea
                  value={preciseText}
                  onChange={(e) => setPreciseText(e.target.value)}
                  disabled={saving}
                  rows={7}
                  placeholder={PROFILE_LINK_PLATFORMS.has(platform || '')
                    ? (zh ? '把要互动的作品链接粘在这里,一行一个\n也可以粘博主主页链接:会打开主页,依次互动他最近的 5 条作品(互动过的跳过)' : 'Paste the post links here, one per line\nA profile link also works: its latest 5 posts are engaged one by one (already-engaged ones are skipped)')
                    : (zh ? '把要互动的作品链接粘在这里,一行一个' : 'Paste the post links here, one per line')}
                  className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent px-3 py-2 text-sm font-mono dark:text-gray-200 placeholder:text-gray-500 focus:outline-none focus:border-violet-500"
                />
                <div className="text-[11px] text-gray-400 mt-1 leading-relaxed">
                  {zh
                    ? '所选的每个账号都会把这批链接做一遍(各自独立)。同一条链接粘重复了会自动去重。'
                    : 'Every selected account runs through the whole list independently. Duplicate lines are removed.'}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {pickRow(zh ? '👍 每条点赞' : '👍 Like each', zh ? '0 或 1 次' : '0 or 1', pLike, setPLike, 1)}
                {favoriteSupported && pickRow(zh ? '⭐ 每条收藏' : '⭐ Favorite each', zh ? '0 或 1 次' : '0 or 1', pFav, setPFav, 1)}
                {pickRow(zh ? '➕ 关注作者' : '➕ Follow author', zh ? '0 或 1 次' : '0 or 1', pFollow, setPFollow, 1)}
                {pickRow(zh ? '💬 每条评论' : '💬 Comments each', zh ? '最多 5 条' : 'up to 5', pComment, setPComment, 5)}
              </div>

              {/* 评论语言:精准模式跳过了 comment 步,而语言选择器只挂在那一步 ——
                  不在这儿补一个的话,TikTok/YouTube 这些海外平台在精准模式下没有任何入口设置它。 */}
              {pComment > 0 && overseasEngage && (
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

              {pComment > 1 && (
                <div className="rounded-xl border border-violet-500/30 bg-violet-500/5 px-4 py-3 text-xs text-violet-700 dark:text-violet-300 leading-relaxed">
                  {zh
                    ? `同一条作品下要发 ${pComment} 条评论时,不会连着发 —— 会跟点赞/收藏/关注穿插,评论之间还会拉长到几分钟,避免刷屏被折叠。`
                    : `When posting ${pComment} comments on the same post they are never sent back-to-back — they get interleaved with the other actions and spaced minutes apart.`}
                </div>
              )}

              <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-700 dark:text-amber-300 leading-relaxed space-y-1">
                <div className="font-semibold">{i18nService.t('wzEngageSafetyTitle')}</div>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>{zh ? '每条链接之间会随机停留、按真人节奏操作,不会秒开秒点。' : 'Each link gets a human-paced dwell; nothing is instant.'}</li>
                  <li>{i18nService.t('wzEngageSafetyTip2')}</li>
                </ul>
              </div>
            </>
          );
        })()}

        {/* Step 3:评论(数量 + 语言);引流拆去下一步(共用/各账号两种模式)。 */}
        {cur === 'comment' && (
          <>
            <RangeSlider label={i18nService.t('wzEngageCommentLabel')} min={cmtMin} max={cmtMax} setMin={setCmtMin} setMax={setCmtMax} hardCap={COMMENT_HARDCAP} hint={i18nService.t('wzEngageCommentHint').replace('{min}', String(cmtMin)).replace('{max}', String(cmtMax)).replace('{cap}', String(COMMENT_HARDCAP))} disabled={saving} />

            {/* 同一条作品最多评几次。跟上面那条是一组:上面管「本次总共评几条」,这条管「同一条最多评几次」。
                默认 1 = 老行为(同一条评过就不再评);设 0 = 一次都不评(但点赞/关注照做)。 */}
            {cmtMax > 0 && (
              <NumRow
                label={i18nService.currentLanguage === 'zh' ? '单个作品最多评论' : 'Max comments per post'}
                hint={i18nService.currentLanguage === 'zh'
                  ? (maxCmtPerWork === 0 ? '设为 0 = 这条一次都不评(点赞/关注照做)' : `同一条作品最多评 ${maxCmtPerWork} 次,评满就不再评它`)
                  : (maxCmtPerWork === 0 ? '0 = never comment on a post (likes/follows still run)' : `at most ${maxCmtPerWork} comment(s) on the same post`)}
                value={maxCmtPerWork} onChange={setMaxCmtPerWork} min={0} max={5}
                accent="violet" disabled={saving} suffix={i18nService.currentLanguage === 'zh' ? '次' : ''}
              />
            )}

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

          </>
        )}

        {/* Step 4(动态):引流语 —— 共用一份 / 各账号各自配置(点账号卡逐号配,未配=该号不带引流)。 */}
        {cur === 'funnel' && (
          <MatrixFunnelConfig
            accounts={selectedAccounts}
            accent="violet"
            perMode={funnelPerMode}
            setPerMode={setFunnelPerMode}
            shared={{ funnel_phrase: funnelPhrase, funnel_probability: funnelProb }}
            setShared={(v) => { setFunnelPhrase(v.funnel_phrase.slice(0, FUNNEL_PHRASE_MAX)); setFunnelProb(v.funnel_probability); }}
            perMap={funnelPerMap}
            setPerMap={setFunnelPerMap}
            disabled={saving}
          />
        )}

        {cur === 'final' && (
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
              {preciseMode ? (
                <>
                  <SummaryRow label={i18nService.currentLanguage === 'zh' ? '模式' : 'Mode'} value={i18nService.currentLanguage === 'zh' ? '🎯 精准(指定链接)' : '🎯 Targeted (given links)'} />
                  <SummaryRow label={i18nService.currentLanguage === 'zh' ? '链接数' : 'Links'} value={String(preciseUrls.length)} />
                  <SummaryRow label={i18nService.currentLanguage === 'zh' ? '每条做' : 'Per link'} value={[
                    pLike ? '👍1' : '', pFav ? '⭐1' : '', pFollow ? '➕1' : '', pComment ? ('💬' + pComment) : '',
                  ].filter(Boolean).join(' · ') || (i18nService.currentLanguage === 'zh' ? '无' : 'none')} />
                </>
              ) : (
                <>
                  <SummaryRow label={i18nService.t('wzEngageSummaryLikes')} value={i18nService.t('wzEngageSummaryPerRunValue').replace('{min}', String(likeMin)).replace('{max}', String(likeMax))} />
                  <SummaryRow label={i18nService.t(platform === 'facebook' ? 'wzEngageSummaryAddFriends' : 'wzEngageSummaryFollows')} value={i18nService.t('wzEngageSummaryPerRunValue').replace('{min}', String(folMin)).replace('{max}', String(folMax))} />
                  {favoriteSupported && favMax > 0 && (
                    <SummaryRow label={i18nService.currentLanguage === 'zh' ? '每次收藏' : 'Favorites per run'} value={i18nService.t('wzEngageSummaryPerRunValue').replace('{min}', String(favMin)).replace('{max}', String(favMax))} />
                  )}
                </>
              )}
              {!preciseMode && (
                <SummaryRow label={i18nService.t('wzEngageSummaryComments')} value={i18nService.t('wzEngageSummaryPerRunValue').replace('{min}', String(cmtMin)).replace('{max}', String(cmtMax))} />
              )}
              {showFunnel && <SummaryRow label={i18nService.t('wzEngageSummaryFunnel')} value={funnelPerMode
                ? i18nService.t('wzFunnelSummaryPer').replace('{done}', String(selectedAccounts.length - countUnconfigured(selectedAccounts, funnelPerMap))).replace('{total}', String(selectedAccounts.length))
                : (hasFunnel ? `"${funnelPhrase.trim().slice(0, 40)}${funnelPhrase.trim().length > 40 ? '...' : ''}" · ${funnelProb}%` : i18nService.t('wzEngageSummaryFunnelEmpty'))} />}
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
        {step > 1 && <button type="button" onClick={() => { setKwEditingId(null); setStep((step - 1) as WizardStep); }} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50">{i18nService.t('wzEngagePrev')}</button>}
        {step < TOTAL_STEPS ? (
          <button type="button" onClick={() => {
            if (!canAdvance[cur].ok) { setSaveError(canAdvance[cur].reason || ''); return; }
            // 各账号模式下还有账号没配引流语 → 弹确认(返回配置 / 不管了下一步),新建与编辑同拦。
            if (cur === 'funnel' && funnelPerMode) {
              const unset = countUnconfigured(selectedAccounts, funnelPerMap);
              if (unset > 0) { setFunnelUnsetConfirm(unset); return; }
            }
            setSaveError(null); setStep((step + 1) as WizardStep);
          }} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-50">{i18nService.t('wzEngageNext')}</button>
        ) : (
          <button type="button" onClick={handleSave} disabled={saving || !allTermsAccepted} className="px-5 py-2 rounded-lg text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-50">{saving ? i18nService.t('wzEngageSaving') : (editing ? i18nService.t('wzEngageSaveEdit') : i18nService.t('wzEngageCreate'))}</button>
        )}
      </div>

      {funnelUnsetConfirm !== null && (
        <FunnelUnsetConfirm
          count={funnelUnsetConfirm}
          accent="violet"
          onBack={() => setFunnelUnsetConfirm(null)}
          onContinue={() => { setFunnelUnsetConfirm(null); setSaveError(null); setStep((step + 1) as WizardStep); }}
        />
      )}
    </div>
  );
};

// 名字沿用 RangeSlider(调用点不动),内部已换成数量输入框:滑杆在 0-500 区间拖不准。
const RangeSlider: React.FC<{ label: string; min: number; max: number; setMin: (v: number) => void; setMax: (v: number) => void; hardCap: number; hint: string; disabled?: boolean }> = ({ label, min, max, setMin, setMax, hardCap, hint, disabled }) => (
  <div>
    <label className="text-sm font-medium dark:text-gray-200 mb-2 block">{label}{i18nService.t('wzEngageRandomRangeSuffix')}</label>
    <NumMinMax
      min={min} max={max} setMin={setMin} setMax={setMax} lo={0} hi={hardCap}
      minLabel={i18nService.t('wzEngageRangeMin')} maxLabel={i18nService.t('wzEngageRangeMax')}
      disabled={disabled} accent="violet"
    />
    <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-1">{hint}</div>
  </div>
);

const SummaryRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex gap-3 text-xs"><span className="text-gray-500 dark:text-gray-400 shrink-0 w-20">{label}</span><span className="text-gray-800 dark:text-gray-200 break-all">{value}</span></div>
);

export default MatrixTaskWizard;
