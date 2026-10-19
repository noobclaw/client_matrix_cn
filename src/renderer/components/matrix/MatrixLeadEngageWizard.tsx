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

import React, { useEffect, useMemo, useState } from 'react';
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
  mode: 'accounts' | 'keywords' | 'live';
  liveUrls?: string[];        // live 模式:直播间链接(TikTok / 抖音)
  liveDwellMinutes?: number;  // live 模式:每个直播间最多停几分钟
  seedAccounts: string[];
  seedByAccount?: Record<string, string[]>;
  keywords: string[];
  maxLeads: number;
  // 本次总量上限(2026-08-21 改定):不再是「每人几条」,每人分到多少由剧本按
  //   「总量 ÷ 实际触达人数」算 —— 优先保证互动人数。
  maxLikes: number;      // 0-5000
  maxFollows: number;    // 0-100
  maxComments: number;   // 0-100
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
    hint: '@账号名 或 主页链接 或 指定视频链接', ph: '@competitor1\nhttps://www.tiktok.com/@competitor2\nhttps://www.tiktok.com/@someone/video/7300000000000000000',
  },
  douyin: {
    host: /^https?:\/\/(www\.)?douyin\.com\/(user\/)?/i, strip: /^@/, allow: /[^a-zA-Z0-9._\-]/g,
    hint: '抖音号 或 主页链接 或 指定视频链接', ph: 'https://www.douyin.com/user/MS4wLjABAAAA...\nhttps://www.douyin.com/video/7640000000000000000',
  },
  xhs: {
    host: /^https?:\/\/(www\.)?xiaohongshu\.com\/user\/profile\//i, strip: /^@/, allow: /[^a-zA-Z0-9]/g,
    hint: '主页链接 或 24 位 uid 或 指定笔记链接', ph: 'https://www.xiaohongshu.com/user/profile/5f3a...\nhttps://www.xiaohongshu.com/explore/66xxxx?xsec_token=...',
  },
  kuaishou: {
    host: /^https?:\/\/(www\.)?kuaishou\.com\/profile\//i, strip: /^@/, allow: /[^a-zA-Z0-9._\-]/g,
    hint: '主页链接 或 用户 id 或 指定作品链接', ph: 'https://www.kuaishou.com/profile/3xabc...\nhttps://www.kuaishou.com/short-video/3xdef...',
  },
  bilibili: {
    host: /^https?:\/\/space\.bilibili\.com\//i, strip: /^(uid:?)/i, allow: /[^0-9]/g,
    hint: '空间链接 或 UID 或 指定视频链接', ph: 'https://space.bilibili.com/12345678\nhttps://www.bilibili.com/video/BV1xx411c7mD',
  },
  // 推特身份是 @handle(大小写不敏感);主页 = x.com/handle。也可以直接粘推文链接。
  x: {
    host: /^https?:\/\/(www\.)?(twitter|x)\.com\//i, strip: /^@/, allow: /[^a-zA-Z0-9_]/g,
    hint: '@账号 或 主页链接 或 指定推文链接', ph: '@competitor1\nhttps://x.com/competitor2\nhttps://x.com/someone/status/1234567890',
  },
  // YouTube 身份是 @handle(跟 TikTok 同制,大小写不敏感);频道主页 = youtube.com/@handle。
  youtube: {
    host: /^https?:\/\/(www\.)?youtube\.com\//i, strip: /^@/, allow: /[^a-zA-Z0-9._\-]/g,
    hint: '@频道 handle 或 频道链接 或 指定视频链接', ph: '@competitor1\nhttps://www.youtube.com/@competitor2\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ',
  },
  instagram: {
    // IG 主页就是 instagram.com/<用户名>/;帖子是 /<用户名>/p/<code>/ 或 /reel/<code>/。
    //   用户名允许字母数字点下划线(真机取到的样本:fcbayern / hakan.erdem.446190 / sashalmr_)。
    host: /^https?:\/\/(www\.)?instagram\.com\//i, strip: /^@/, allow: /[^a-zA-Z0-9._]/g,
    hint: '@用户名 或 主页链接 或 指定帖子链接',
    ph: '@competitor1\nhttps://www.instagram.com/competitor2/\nhttps://www.instagram.com/competitor2/p/DcWyIaZDxrO/',
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
    // TikTok / YouTube 的 handle 都不区分大小写(/@MKBHD 与 /@mkbhd 是同一个频道),
    //   不归一会把同一个同行填两遍、剧本再各收一轮。
    const key = (platform === 'tiktok' || platform === 'youtube' || platform === 'x') ? line.toLowerCase() : line;
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
  // YouTube 的「关注」在平台上叫【订阅】。用户 2026-08-23:每个平台的卡片/向导/详情都要
  //   说自己平台的词。剧本侧计数键仍是 follow(跨平台统一),只有给人看的文案按平台走。
  const isSubscribePlatform = platform === 'youtube';
  const followWord = isSubscribePlatform ? t('订阅', 'subscribe') : t('关注', 'follow');
  const followIcon = isSubscribePlatform ? '📌' : '➕';
  const le: Partial<LeadEngageInput> = initialTask?.leadEngage || {};

  const [step, setStep] = useState<number>(1);
  const TOTAL_STEPS = 6;

  const [selected, setSelected] = useState<Set<string>>(() => {
    if (initialTask?.accountIds) return new Set<string>(initialTask.accountIds);
    return new Set<string>(accounts.filter((a) => a.status !== 'banned' && a.status !== 'login_required').map((a) => a.id));
  });
  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // 直播间获客只有 TikTok / 抖音(2026-10-19)。
  const liveSupported = platform === 'tiktok' || platform === 'douyin';
  const [mode, setMode] = useState<'accounts' | 'keywords' | 'live'>(
    le.mode === 'keywords' ? 'keywords' : (le.mode === 'live' && liveSupported ? 'live' : 'accounts'));
  const [liveText, setLiveText] = useState<string>(Array.isArray(le.liveUrls) ? le.liveUrls.join('\n') : '');
  const [liveDwell, setLiveDwell] = useState<number>(typeof le.liveDwellMinutes === 'number' ? le.liveDwellMinutes : 20);
  const liveList = useMemo(() => {
    const out: string[] = []; const seen = new Set<string>();
    for (const raw of liveText.split(/[\n,，\s]+/)) {
      const v = raw.trim();
      if (!v) continue;
      const ok = platform === 'douyin'
        ? (/live\.douyin\.com\/\d{5,}/i.test(v) || /douyin\.com\/(root\/)?live\/\d{5,}/i.test(v) || /^\d{5,}$/.test(v) || /^https?:\/\/v\.douyin\.com\//i.test(v))
        : (/tiktok\.com\/@[^/\s]+/i.test(v) || /^@?[\w.]{2,}$/.test(v));
      if (ok && !seen.has(v)) { seen.add(v); out.push(v); }
      if (out.length >= 20) break;
    }
    return out;
  }, [liveText, platform]);
  // 回填:只有【裸 handle】且是 @handle 制的平台(TikTok/抖音)才补 @;
  //   存的是整条主页链接就原样显示 —— 否则回填出来是 `@https://www.douyin.com/user/...`
  //   (用户 2026-08-22 截图)。小红书/B站/快手存的是 id,本来就不加。
  // 同行种子回填成「显示文本」:@handle 制平台(TikTok/抖音/YT/X)给裸 handle 补 @,主页链接原样。
  const seedListToText = (list: any): string =>
    (Array.isArray(list) ? list : []).map((h) => {
      const v = String(h || '');
      const atStyle = platform === 'tiktok' || platform === 'douyin' || platform === 'youtube' || platform === 'x';
      return (atStyle && !/^https?:\/\//i.test(v)) ? '@' + v : v;
    }).join('\n');
  // 每个执行账号各自的同行种子文本。老任务只有共用 seedAccounts → 回落时铺到每个账号框(语义等价:大家原本用同一批)。
  const sharedSeedText = le.seedByAccount ? '' : seedListToText(le.seedAccounts);
  const [seedTextByAccount, setSeedTextByAccount] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    if (le.seedByAccount) for (const k of Object.keys(le.seedByAccount)) init[k] = seedListToText(le.seedByAccount[k]);
    return init;
  });
  // 某账号没显式编辑过 → 老任务回落共用文本;新任务是空。
  const seedTextFor = (id: string): string => (id in seedTextByAccount ? seedTextByAccount[id] : sharedSeedText);
  const setSeedTextFor = (id: string, v: string) => setSeedTextByAccount((m) => ({ ...m, [id]: v }));
  const applySeedToAll = (fromId: string) => {
    const v = seedTextFor(fromId);
    setSeedTextByAccount(() => { const m: Record<string, string> = {}; for (const a of selectedAccounts) m[a.id] = v; return m; });
  };

  // 2026-10-19:每个潜客一辈子只做 1 个动作,「获取潜客」和「互动潜客」合并成一个「本次潜客数」(1-5000,默认 300)。
  const [maxLeads, setMaxLeads] = useState<number>(typeof le.maxLeads === 'number' ? le.maxLeads : 300);
  const [maxLikes, setMaxLikes] = useState<number>(typeof le.maxLikes === 'number' ? le.maxLikes : 300);
  const [maxFollows, setMaxFollows] = useState<number>(typeof le.maxFollows === 'number' ? le.maxFollows : 0);
  const [maxComments, setMaxComments] = useState<number>(typeof le.maxComments === 'number' ? le.maxComments : 0);

  // 引流语(评论时按概率融进 AI 评论)。与互动涨粉同一套口径,直接复用 MatrixFunnelConfig。
  const [funnelPerMode, setFunnelPerMode] = useState<boolean>(!!initialTask?.funnelByAccount && Object.keys(initialTask.funnelByAccount).length > 0);
  const [funnelPhrase, setFunnelPhrase] = useState<string>(initialTask?.funnel?.funnel_phrase || '');
  const [funnelProb, setFunnelProb] = useState<number>(
    typeof initialTask?.funnel?.funnel_probability === 'number' && initialTask.funnel.funnel_probability > 0
      ? initialTask.funnel.funnel_probability : FUNNEL_PROB_DEFAULT);
  const [funnelPerMap, setFunnelPerMap] = useState<Record<string, FunnelValue>>(initialTask?.funnelByAccount || {});
  const [funnelUnsetConfirm, setFunnelUnsetConfirm] = useState<number | null>(null);
  const [seedUnsetConfirm, setSeedUnsetConfirm] = useState<number | null>(null);
  // 账号横条:当前编辑哪个号 + 左右渐隐(号多到滚出视野时提示两边还有)。
  const [activeSeedId, setActiveSeedId] = useState<string>('');
  const seedStripRef = React.useRef<HTMLDivElement | null>(null);
  const [seedFadeL, setSeedFadeL] = useState(false);
  const [seedFadeR, setSeedFadeR] = useState(false);
  const updateSeedFade = () => {
    const el = seedStripRef.current;
    if (!el) return;
    setSeedFadeL(el.scrollLeft > 4);
    setSeedFadeR(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  };

  const [runInterval, setRunInterval] = useState<string>(initialTask?.frequency || 'daily_random');
  const [termsAccepted, setTermsAccepted] = useState<boolean>(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const selectedAccounts = accounts.filter((a) => selected.has(a.id));
  // 各账号种子并集(去重)—— 用于任务名「已识别 N」和回落 seedAccounts。
  // 账号数变了（第 1 步勾选变动）或刚切到本步时，渐隐要重算 ——
  //   否则从 2 个号加到 20 个号，右侧渐隐不出现，用户看不出横条还能滚。
  useEffect(() => { updateSeedFade(); /* eslint-disable-next-line */ }, [selected, step]);
  const seedList = useMemo(() => {
    const seen = new Set<string>(); const out: string[] = [];
    for (const a of selectedAccounts) for (const x of parseSeedLines(seedTextFor(a.id), platform)) { if (!seen.has(x)) { seen.add(x); out.push(x); } }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedTextByAccount, sharedSeedText, selected, accounts, platform]);
  // 有几个选中账号配了种子(每账号独立配,未配的号本轮不采集)。
  const seededAcctCount = useMemo(() => selectedAccounts.filter((a) => parseSeedLines(seedTextFor(a.id), platform).length > 0).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [seedTextByAccount, sharedSeedText, selected, accounts, platform]);
  // 关键词模式下真正会用到的词 = 各账号自己配的关键词(与互动涨粉一致)。
  const acctsWithoutKw = selectedAccounts.filter((a) => kwOf(a).length === 0);
  const funnelAccounts = selectedAccounts.map((a) => ({
    id: a.id, title: a.nickname || a.displayName, group: a.group,
    platformName: platformLabel, avatar: a.avatar,
  }));

  const canAdvance: Record<number, { ok: boolean; reason?: string }> = {
    1: { ok: selected.size >= 1, reason: t('请至少选择一个执行账号', 'Select at least one account') },
    2: mode === 'live'
      ? (liveList.length >= 1 ? { ok: true } : { ok: false, reason: t('请至少填 1 个直播间链接', 'Add at least one live room link') })
      : mode === 'accounts'
      ? (seededAcctCount >= 1 ? { ok: true } : { ok: false, reason: t(`请至少给一个执行账号填同行${platformLabel}账号`, 'Fill competitor accounts for at least one executing account') })
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
    5: (clampInt(maxLikes, 0, 5000) + clampInt(maxFollows, 0, 100) + clampInt(maxComments, 0, 100)) > 0
      ? { ok: true }
      : { ok: false, reason: t(`点赞 / ${followWord} / 评论至少要开一项,否则获取到潜客后什么也不会做`, `Enable at least one of like / ${followWord} / comment — otherwise nothing happens after leads are collected`) },
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
    // 精准获客:有账号没填同行 → 先确认(未配的号本轮不采集,不是错误)。
    if (step === 2 && mode === 'accounts' && seedUnsetConfirm === null) {
      const un = selectedAccounts.length - seededAcctCount;
      if (un > 0) { setSeedUnsetConfirm(un); return; }
    }
    setSaveError(null);
    setFunnelUnsetConfirm(null);
    setSeedUnsetConfirm(null);
    setStep((s) => Math.min(TOTAL_STEPS, s + 1));
  };
  const back = () => { setSaveError(null); setFunnelUnsetConfirm(null); setSeedUnsetConfirm(null); setStep((s) => Math.max(1, s - 1)); };

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
          // seedAccounts 存并集,作为老客户端/回落用;权威是 seedByAccount(每号各自)。
          seedAccounts: mode === 'accounts' ? seedList : [],
          liveUrls: mode === 'live' ? liveList : (Array.isArray(le.liveUrls) ? le.liveUrls : []),
          liveDwellMinutes: clampInt(liveDwell, 1, 60),
          seedByAccount: mode === 'accounts' ? (() => {
            const out: Record<string, string[]> = {};
            for (const id of selected) { const list = parseSeedLines(seedTextFor(id), platform); if (list.length) out[id] = list; }
            return out;
          })() : undefined,
          // 关键词跟随账号设置,向导不再提供输入;但老任务里存过的任务级词要原样保留(同上,整体替换)。
          keywords: Array.isArray(le.keywords) ? le.keywords : [],
          maxLeads: clampInt(maxLeads, 1, 5000),
          // 条数 0 = 关闭该动作(开关行已按用户要求删掉,用数量本身表达开关)。
          //   do* 必须跟着算,否则剧本读到 doLike=true 仍会去点 —— 条数为 0 时
          //   剧本内部 nLikeLead 也会是 0,两边一致才不会出现「设了 0 还照做」。
          maxLikes: clampInt(maxLikes, 0, 5000),
          maxFollows: clampInt(maxFollows, 0, 100),
          maxComments: clampInt(maxComments, 0, 100),
          leadsPerRun: clampInt(maxLeads, 1, 5000),   // 与潜客数合并(2026-10-19)
          // 总量为 0 = 关闭该动作(向导没有单独的开关行,用数量本身表达)。
          doLike: clampInt(maxLikes, 0, 5000) > 0,
          doComment: clampInt(maxComments, 0, 100) > 0,
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
        {step === 2 && seedUnsetConfirm !== null && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/50 p-4">
            <div className="w-full max-w-sm rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-5">
              <div className="text-sm font-semibold dark:text-white mb-2">{t(`有 ${seedUnsetConfirm} 个账号没填同行`, `${seedUnsetConfirm} account(s) have no competitors`)}</div>
              <div className="text-[12px] text-gray-500 dark:text-gray-400 mb-4 leading-relaxed">{t('没填同行的账号本轮不会采集潜客(其它步骤照常)。确定继续?', 'Accounts without competitors won\'t collect leads this run. Continue?')}</div>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setSeedUnsetConfirm(null)} className="px-3 py-1.5 text-xs rounded-lg border border-gray-300 dark:border-gray-700 dark:text-gray-200">{t('返回填写', 'Go back')}</button>
                <button type="button" onClick={() => { setSeedUnsetConfirm(null); setSaveError(null); setStep((s) => Math.min(TOTAL_STEPS, s + 1)); }} className="px-3 py-1.5 text-xs rounded-lg bg-cyan-500 text-white">{t('继续', 'Continue')}</button>
              </div>
            </div>
          </div>
        )}
        {step === 2 && (
          <>
            {/* 推特只做精准获客:X 的搜索页对未登录/低权重账号限制大、结果噪音也高,
                与其给一个不稳的入口,不如只留稳的那个(用户 2026-08-23 明确要求)。 */}
            <div className={`grid gap-2.5 ${platform === 'x' ? 'grid-cols-1' : (liveSupported ? 'grid-cols-3' : 'grid-cols-2')}`}>
              {(platform === 'x'
                ? ([['accounts', '🎯', t('精准获客', 'Precise'), t('填同行账号或指定推文链接,采集回复区里的人再逐个互动', 'Competitor accounts or a tweet URL — harvest its repliers, then engage them')]] as const)
                : ([['accounts', '🎯', t('精准获客', 'Precise'), t('填同行账号或指定视频/帖子链接,采集评论区里的人再逐个互动', 'Competitor accounts or a post URL — harvest its commenters, then engage them')],
                    ['keywords', '🔍', t('关键词获客', 'Keyword'), t('按赛道关键词搜视频,采集评论区里的人', 'From videos found by niche keywords')],
                    ...(liveSupported ? [['live', '📺', t('直播间获客', 'Live room'), t('停在同行直播间里,收发弹幕/进场的观众再逐个互动', 'Stay in live rooms and collect viewers who chat or join')]] : [])] as const)
              ).map(([m, icon, title, desc]) => (
                <button key={m} type="button" onClick={() => setMode(m as any)}
                  className={`text-left p-3 rounded-xl border transition-colors ${mode === m ? 'border-cyan-500 bg-cyan-500/5' : 'border-gray-200 dark:border-gray-700 hover:border-cyan-500/40'}`}>
                  <div className="text-sm font-semibold dark:text-white mb-0.5">{icon} {title}</div>
                  <div className="text-[11px] text-gray-500 dark:text-gray-400 leading-snug">{desc}</div>
                </button>
              ))}
            </div>

            {mode === 'live' ? (
              <div className="space-y-3">
                <div className="text-[12px] text-gray-500 dark:text-gray-400 leading-relaxed">
                  {platform === 'douyin'
                    ? t('填抖音直播间链接(如 https://live.douyin.com/123456789),一行一个,最多 20 个。所选执行账号都会去这些直播间收人;执行账号要在网页端登录,否则看不到观众账号。',
                        'Douyin live room links (e.g. https://live.douyin.com/123456789), one per line, max 20. Executing accounts must be logged in on the web.')
                    : t('填 TikTok 直播间链接(如 https://www.tiktok.com/@xxx/live)或主播账号,一行一个,最多 20 个。所选执行账号都会去这些直播间收人。',
                        'TikTok live room links (e.g. https://www.tiktok.com/@xxx/live) or host handles, one per line, max 20.')}
                </div>
                <textarea value={liveText} onChange={(e) => setLiveText(e.target.value)} rows={5} disabled={saving}
                  placeholder={platform === 'douyin' ? 'https://live.douyin.com/123456789' : 'https://www.tiktok.com/@xxx/live'}
                  className="w-full text-sm rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 dark:text-gray-100 px-3 py-2 font-mono" />
                <div className="text-[11px] text-gray-500 dark:text-gray-400">{t(`已识别 ${liveList.length} 个直播间`, `${liveList.length} live room(s) recognised`)}</div>
                <div className="rounded-xl border border-gray-200 dark:border-gray-800 px-3">
                  {numRow(t('每个直播间最多停留(分钟)', 'Max minutes per live room'),
                    t('收够人数会提前离开;连续 5 分钟没有新观众也会换下一间', 'Leaves early when full, or after 5 minutes with no new viewers'),
                    liveDwell, setLiveDwell, 1, 60)}
                </div>
              </div>
            ) : mode === 'accounts' ? (
              <div className="space-y-3">
                <div className="text-[12px] text-gray-500 dark:text-gray-400 leading-relaxed">
                  {t(`每个执行账号盯自己的一批同行 —— 给下面每个账号分别填${specOf(platform).hint}(一行一个,最多 ${MAX_SEED} 个)。没填的账号本轮不采集。`,
                     `Each executing account targets its own competitors — fill ${specOf(platform).hint} per account below (one per line, max ${MAX_SEED}). Accounts left blank are skipped this run.`)}
                </div>
                {selectedAccounts.length === 0 ? (
                  <div className="text-[12px] text-amber-500">{t('请先在第 1 步选执行账号', 'Pick executing accounts in step 1 first')}</div>
                ) : (() => {
                  // 当前正在编辑哪个号。选中的号被取消勾选后 activeSeedId 会指向不存在的号 ——
                  //   回落到第一个,否则编辑区空白、用户以为填的东西丢了。
                  const act = selectedAccounts.find((x) => x.id === activeSeedId) || selectedAccounts[0];
                  const actCnt = act ? parseSeedLines(seedTextFor(act.id), platform).length : 0;
                  return (
                    <>
                      {/* 账号横条:一行装下所有号,点谁编谁(与引流语同款)。号多时横向滚,
                          两侧渐隐提示还有更多 —— 纵向堆 textarea 的老布局 10 个号就滚不完了。 */}
                      <div className="relative">
                        <div
                          ref={seedStripRef}
                          onScroll={updateSeedFade}
                          className="flex gap-1.5 overflow-x-auto pb-1"
                          style={{ scrollbarWidth: 'none' }}
                        >
                          {selectedAccounts.map((a) => {
                            const cnt = parseSeedLines(seedTextFor(a.id), platform).length;
                            const on = act && act.id === a.id;
                            return (
                              <button key={a.id} type="button" onClick={() => setActiveSeedId(a.id)}
                                className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-left transition-colors ${
                                  on ? 'border-cyan-500 bg-cyan-500/10 ring-1 ring-cyan-500/50' : 'border-gray-200 dark:border-gray-700 hover:border-gray-400 dark:hover:border-gray-500'
                                }`}>
                                {a.avatar
                                  ? <img src={String(a.avatar).replace(/^http:/, 'https:')} referrerPolicy="no-referrer" alt="" className="w-5 h-5 rounded-full object-cover bg-gray-200 dark:bg-gray-700 shrink-0" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                                  : <span className="w-5 h-5 rounded-full bg-cyan-500/20 shrink-0" />}
                                <span className="min-w-0">
                                  <span className="block text-xs font-medium dark:text-gray-200 truncate max-w-[120px]">{a.nickname || a.displayName}</span>
                                  <span className="block text-[10px] text-gray-400 truncate max-w-[120px]">{a.group || ''}</span>
                                </span>
                                <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded ${cnt ? 'bg-cyan-500/10 text-cyan-500' : 'bg-amber-400/10 text-amber-500'}`}>
                                  {cnt ? String(cnt) : t('未填', 'empty')}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                        {seedFadeL && <div className="pointer-events-none absolute left-0 top-0 bottom-1 w-8 bg-gradient-to-r from-white dark:from-gray-900 to-transparent" />}
                        {seedFadeR && <div className="pointer-events-none absolute right-0 top-0 bottom-1 w-8 bg-gradient-to-l from-white dark:from-gray-900 to-transparent" />}
                      </div>

                      {/* 编辑区:只编当前选中那个号 */}
                      {act && (
                        <div className="rounded-xl border border-cyan-500/25 bg-cyan-500/5 px-4 py-3">
                          <div className="flex items-center justify-between mb-1.5 gap-2">
                            <div className="text-xs text-gray-600 dark:text-gray-300 min-w-0 truncate">
                              {t(`正在给「${act.nickname || act.displayName}」填`, `Editing for ${act.nickname || act.displayName}`)}
                              <span className={`ml-1.5 ${actCnt ? 'text-gray-400' : 'text-amber-500'}`}>{actCnt ? t(`已识别 ${actCnt} 个`, `${actCnt} parsed`) : t('未填', 'empty')}</span>
                            </div>
                            {selectedAccounts.length > 1 && actCnt > 0 && (
                              <button type="button" onClick={() => applySeedToAll(act.id)} className="text-[11px] text-cyan-500 hover:underline shrink-0">{t('复制到全部账号', 'Copy to all')}</button>
                            )}
                          </div>
                          <textarea value={seedTextFor(act.id)} onChange={(e) => setSeedTextFor(act.id, e.target.value)} rows={5} placeholder={specOf(platform).ph}
                            className="w-full text-sm p-2.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 dark:text-white font-mono leading-relaxed" />
                        </div>
                      )}

                      {/* 一眼看出还有几个号没填 —— chip 条滚出视野时这行是唯一的提醒 */}
                      {selectedAccounts.length > 1 && (
                        <div className="text-[11px] text-gray-400">
                          {t(`${seededAcctCount}/${selectedAccounts.length} 个账号已填`, `${seededAcctCount}/${selectedAccounts.length} accounts filled`)}
                        </div>
                      )}
                    </>
                  );
                })()}
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
            {numRow(t('本次潜客数', 'Leads this run'),
              t('收这么多个新潜客,并对这么多个还没互动过的潜客各做 1 个动作(本地已有的不重复收;新客优先,以前收了没轮到的补上)',
                'Collect this many new leads and give this many not-yet-engaged leads one action each (new first)'),
              maxLeads, setMaxLeads, 1, 5000)}
          </div>
        )}

        {/* STEP 4 · 点赞 + 关注/订阅 */}
        {step === 4 && (
          <>
            <div className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
              {t('逐个打开潜客主页,每个潜客【一辈子只做 1 个动作】:点赞 / 评论 / 关注三选一(点赞、评论落在他的第一条作品上),做完就不再碰他。三样的总量按剩余比例轮流分配。',
                 'Each lead gets exactly one action ever — like, comment or follow (likes/comments on their first post). Totals are shared out in proportion.')}
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-800 px-3 divide-y divide-gray-100 dark:divide-gray-800">
              {numRow(t('👍 本次点赞最大数量', '👍 Total likes this run'),
                t('本次最多点赞多少人(每人 1 个赞) · 设为 0 = 不点赞', 'Max leads to like this run (1 like each) · 0 disables liking'),
                maxLikes, setMaxLikes, 0, 5000)}
              {numRow(t(`${followIcon} 本次${followWord}最大数量`, `${followIcon} Total ${followWord}s this run`),
                t(`本次最多${followWord}多少人 · 设为 0 = 不${followWord}`, `Max leads to ${followWord} this run · 0 disables it`),
                maxFollows, setMaxFollows, 0, 100)}
            </div>
          </>
        )}

        {/* STEP 5 · 评论 + 引流语 */}
        {step === 5 && (
          <>
            <div className="rounded-xl border border-gray-200 dark:border-gray-800 px-3">
              {numRow(t('💬 本次评论最大数量', '💬 Total comments this run'),
                t('本次最多评论多少人(每人 1 条) · 评论由 AI 生成(有 AI 费用) · 设为 0 = 不评论',
                  'Max leads to comment on this run (1 each) · AI-generated (incurs AI cost) · 0 disables commenting'),
                maxComments, setMaxComments, 0, 100)}
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
              <div className="flex justify-between"><span className="text-gray-500">{t('获客模式', 'Mode')}</span><span>{mode === 'live' ? t(`直播间 · ${liveList.length} 个`, `Live · ${liveList.length} rooms`) : mode === 'accounts' ? t(`精准 · ${seedList.length} 个同行`, `Precise · ${seedList.length} seeds`) : t('关键词 · 跟随账号设置', 'Keyword · from account settings')}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">{t('本次潜客数', 'Leads')}</span><span>{clampInt(maxLeads, 1, 5000)}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">{t('本次总量', 'Totals')}</span><span>{[
                clampInt(maxLikes,0,5000) > 0 ? `👍${clampInt(maxLikes,0,5000)}` : null,
                clampInt(maxComments,0,100) > 0 ? `💬${clampInt(maxComments,0,100)}` : null,
                clampInt(maxFollows,0,100) > 0 ? `➕${clampInt(maxFollows,0,100)}` : null,
              ].filter(Boolean).join(' · ') || '—'}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">{t('每个潜客', 'Per lead')}</span><span>{t('只做 1 个动作', 'one action')}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">{t('评论引流', 'Funnel')}</span><span>{funnelPerMode ? t(`各账号各自(${funnelAccounts.length - countUnconfigured(funnelAccounts, funnelPerMap)}/${funnelAccounts.length} 已配)`, `per account`) : (funnelPhrase.trim() ? t(`共用 · ${funnelProb}%`, `shared · ${funnelProb}%`) : t('未配置', 'none'))}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">{t('频率', 'Frequency')}</span><span>{intervalLabel}</span></div>
            </div>
            <label className="flex items-start gap-2 text-xs text-gray-500 dark:text-gray-400 cursor-pointer">
              <input type="checkbox" checked={termsAccepted} onChange={(e) => setTermsAccepted(e.target.checked)} className="h-4 w-4 accent-cyan-500 mt-0.5 shrink-0" />
              <span>{t('我已知悉:采集与互动均自然的操作节奏,潜客名单会保存在本地并长期累积,我将合规使用。',
                     'I understand collection and outreach keep a natural pace, the lead roster is stored locally and grows over time, and I will use it compliantly.')}</span>
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
