/**
 * VideoLoginCheckModal — 视频任务【创建/保存前】的多平台登录校验。
 *
 * 跟 LoginRequiredModal 的区别:那个是单主平台(+可选 1 副平台)的「运行前检查」;
 * 视频发布是【N 选平台】(9 选若干),所以这里对【用户勾选的每个平台】各渲染一行,
 * 逐个显示登录态 + 各自「打开登录」按钮。
 *
 * 决策①(用户要求):必须【所有勾选平台都登录】才能保存 —— allReady 没全绿,底部
 * 「保存任务」按钮一直置灰(对齐币安任务 allReady gate 的严格度)。
 *
 * 检测顺序:cookie 批量为主(见 runCheck);cookie 判不了才退老 IPC 兜底:
 *   · 有创作者中心的(抖音/小红书/快手/B站)→ checkCreatorCenter(更准,能判断停在登录页)
 *   · 其余(TikTok/视频号/头条号)→ checkXhsLogin(主站/后台 tab 存在即视为登录)
 *   · 币安/推特例外:cookie 读成功且判 false = 权威未登录,【不退 tab 兜底】(见 COOKIE_FALSE_IS_FINAL)
 * 打开登录同理:有 creator 的 openCreatorCenter,其余 openXhsLogin。
 *
 * 3s 自动轮询,用户在打开的窗口里扫码 / 登录后无需手点「重新检测」就会自动转绿。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { scenarioService } from '../../../services/scenario';
import { i18nService } from '../../../services/i18n';

type StepStatus = 'pass' | 'fail' | 'checking' | 'waiting';

/** 视频可发布平台的展示元信息 + 登录入口。renderer 本地一份(不跨进程 import main)。 */
const PLATFORM_META: Record<string, { zh: string; en: string; emoji: string; url: string; creator: boolean }> = {
  douyin:    { zh: '抖音',     en: 'Douyin',    emoji: '🎵', url: 'https://creator.douyin.com/',                                    creator: true  },
  xhs:       { zh: '小红书',   en: 'Xiaohongshu', emoji: '📕', url: 'https://creator.xiaohongshu.com/',                            creator: true  },
  kuaishou:  { zh: '快手',     en: 'Kuaishou',  emoji: '⚡', url: 'https://cp.kuaishou.com/article/publish/video',                 creator: true  },
  bilibili:  { zh: 'B 站',     en: 'Bilibili',  emoji: '📺', url: 'https://member.bilibili.com/platform/upload/video/frame',      creator: true  },
  tiktok:    { zh: 'TikTok',   en: 'TikTok',    emoji: '🎬', url: 'https://www.tiktok.com/tiktokstudio/upload',                    creator: false },
  binance:   { zh: '币安广场', en: 'Binance',   emoji: '🟡', url: 'https://www.binance.com/square',                                creator: false },
  x:         { zh: '推特',     en: 'X',         emoji: '🐦', url: 'https://x.com/home',                                            creator: false },
  shipinhao: { zh: '视频号',   en: 'Channels',  emoji: '🟢', url: 'https://channels.weixin.qq.com/platform/post/create',          creator: false },
  toutiao:   { zh: '头条号',   en: 'Toutiao',   emoji: '🟠', url: 'https://mp.toutiao.com/',                                       creator: false },
};

function metaOf(id: string) {
  return PLATFORM_META[id] || { zh: id, en: id, emoji: '🌐', url: '', creator: false };
}

/**
 * cookie 判 false 即为【权威未登录】的平台:登录 cookie 名明确可靠(binance=p20t、x=auth_token),
 * 且 cdp_cookies_get 走 Network.getCookies 连 HttpOnly 都读得到 —— 读成功却没有这个 cookie,
 * 就是真没登录,【不退 tab 兜底】。
 * 背景:tab 兜底只看「该平台 tab 在不在」,点「打开登录」把检查窗导航到币安广场后,
 * 未登录页面也算 tab 在 → 误绿"已连接"(2026-06-15 896ac1a 把 cookie false 也放进兜底引入)。
 * 字节系/微信系(douyin/toutiao/shipinhao 等)当初就是因怕 HttpOnly 读不到才加的兜底,维持原样。
 */
const COOKIE_FALSE_IS_FINAL = new Set(['binance', 'x']);

/** 「主站模式」(取素材)用的主站 URL —— 抖音/TikTok 取材只需主站登录,不进创作者中心。 */
const MAIN_SITE_URL: Record<string, string> = {
  douyin: 'https://www.douyin.com/',
  tiktok: 'https://www.tiktok.com/',
};

interface Props {
  /** 用户在向导里勾选的发布平台 id 列表。 */
  platforms: string[];
  onCancel: () => void;
  /** 全部平台登录通过、用户点「保存任务」时回调(向导据此真正提交保存)。 */
  onConfirmed: () => void;
  /**
   * 这些 id 用【主站登录】校验(checkXhsLogin/主站 URL),即使它在 PLATFORM_META 里是
   * 创作者中心平台(如抖音)。用于「取素材」场景:抖音混剪/图文只需主站登录,不需创作者中心。
   * 默认空 = 全按 PLATFORM_META.creator 走(发布场景不变)。
   */
  mainSiteOverride?: string[];
  /** 自定义标题/副标题(默认是「发布平台登录校验」;取素材场景可传更贴切的文案)。 */
  title?: string;
  subtitle?: string;
}

export const VideoLoginCheckModal: React.FC<Props> = ({ platforms, onCancel, onConfirmed, mainSiteOverride, title, subtitle }) => {
  const isZh = i18nService.currentLanguage === 'zh';
  const list = (platforms || []).filter((p) => !!PLATFORM_META[p]);
  const override = mainSiteOverride || [];
  /** 这个 id 这次是否按创作者中心校验(主站 override 命中则否)。 */
  const useCreatorFor = (id: string) => metaOf(id).creator && !override.includes(id);

  const [extensionStatus, setExtensionStatus] = useState<StepStatus>('checking');
  const [platformStatus, setPlatformStatus] = useState<Record<string, StepStatus>>(
    () => Object.fromEntries(list.map((p) => [p, 'checking' as StepStatus])),
  );
  const [checking, setChecking] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  // 一旦某平台确认登录过(变绿)就【粘住】绿:本次校验不再因 tab 导航走 / cookie 暂读不到而翻回红。
  //   登录态(cookie)是持久的,人登录着就行;真到发布时 runPublish 各平台还会再校验一次,不怕这里"宽松"。
  const confirmedRef = useRef<Set<string>>(new Set());
  // 防重入:批量 cookie 读一次可能 10s+(12s 开窗 + 10s 读),4s 轮询会叠上一趟没跑完的 ——
  //   迟到的旧结果(读的是登出前的 cookie)会把刚判定的权威未登录又刷回绿。跑着就跳过本 tick。
  const runningRef = useRef(false);

  const checkOne = useCallback(async (id: string) => {
    const useCreator = metaOf(id).creator && !override.includes(id);
    try {
      const st = useCreator
        ? await scenarioService.checkCreatorCenter(id as any)
        : await scenarioService.checkXhsLogin(id as any);
      return { id, st };
    } catch {
      return { id, st: { loggedIn: false, reason: 'check_threw' } as { loggedIn: boolean; reason?: string } };
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [override.join(',')]);

  const runCheck = useCallback(async () => {
    if (list.length === 0) { setExtensionStatus('pass'); return; }
    if (runningRef.current) return; // 上一趟还没跑完,跳过本 tick(防迟到旧结果覆盖新判定)
    runningRef.current = true;
    setChecking(true);
    try {
      // 【cookie 批量为主】一次 CDP attach 把所有勾选平台的 cookie 全读出来,按【域名+名】逐平台判
      //   (抖音/TikTok 同名 sessionid 靠域名区分)。这样【开一个窗口就知道所有平台登录态】,不需要
      //   每个平台页面都在线。cookie 判不了的(null:没配/没读到)才退老 tab 校验(需页面在线)。
      const items = list.map((id) => ({
        platform: id,
        which: (metaOf(id).creator && !override.includes(id)) ? ('creator' as const) : ('main' as const),
      }));
      const cookiePass = await scenarioService.checkVideoLoginByCookieBatch(items);
      const results = await Promise.all(list.map((p) => {
        if (cookiePass[p] === true) return Promise.resolve({ id: p, st: { loggedIn: true } as { loggedIn: boolean; reason?: string } });
        // cookie 权威平台(binance/x)【完全不进 tab 兜底】—— 兜底在矩阵版是
        //   checkXhsLogin 开头的 `if (MATRIX_EDITION) return {loggedIn:true}`(scenario.ts),
        //   无条件说"已登录",连扩展断了都绿(审计 2026-07-31 查实,这才是矩阵版误绿的真根因)。
        //   · false = 读成功且无登录 cookie → 权威未登录:红 + 解除粘住绿(cookie_definitive)
        //   · null/undefined = 读不到(扩展断/CDP 抢占/超时)→ 红但【不解除】粘住绿:之前确认过
        //     登录的靠 rescue 保持绿,瞬时读失败不闪红;从没绿过的显示红(宁可让用户多点一次
        //     打开登录,不放一个验证不了的平台过关 —— allReady 闸门本来就是严格语义)。
        if (COOKIE_FALSE_IS_FINAL.has(p)) {
          const v = cookiePass[p];
          return Promise.resolve({ id: p, st: {
            loggedIn: false,
            reason: v === false ? 'cookie_definitive' : 'cookie_unknown',
          } as { loggedIn: boolean; reason?: string } });
        }
        // 其余平台 cookie 没命中(false/null)—— 可能该平台 session 是 HttpOnly、扩展读不到 → 退【tab 兜底】:
        //   看该平台的 tab 在不在线且已登录(用户在登录窗里开着的那个 tab 就算)。在 → 放过。
        return checkOne(p);
      }));
      let extConnected = true;
      const next: Record<string, StepStatus> = {};
      for (const { id, st } of results) {
        if (st.reason === 'browser_not_connected') {
          extConnected = false;
          next[id] = 'waiting';
        } else if (st.loggedIn) {
          next[id] = 'pass';
        } else {
          next[id] = 'fail';
          // cookie 权威 false:同时解除「粘住绿」—— 比如用户刚在检查窗里退出了该平台,
          //   不能让早先的绿粘着盖住确凿的未登录。
          if (st.reason === 'cookie_definitive') confirmedRef.current.delete(id);
        }
      }
      // 粘住绿:本次确认登录过的记下;之前确认过的即使这次没验到(tab 导航走/cookie 暂读不到)也保持绿。
      //   (扩展没连上 waiting 不强制覆盖 —— 那是插件问题,不是登录问题。)
      for (const id of Object.keys(next)) {
        if (next[id] === 'pass') confirmedRef.current.add(id);
        else if (next[id] === 'fail' && confirmedRef.current.has(id)) next[id] = 'pass';
      }
      setExtensionStatus(extConnected ? 'pass' : 'fail');
      setPlatformStatus(next);
    } finally {
      runningRef.current = false;
      setChecking(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, checkOne, override.join(',')]);

  useEffect(() => { void runCheck(); }, []); // eslint-disable-line  首次读 cookie

  // 自动轮询(cookie 批量,4s):用户在【那一个登录窗】里挨个登录后自动转绿,不需保持各平台页面在线。
  useEffect(() => {
    const h = setInterval(() => { void runCheck(); }, 4000);
    return () => clearInterval(h);
  }, [runCheck]);

  // 模态卸载:收掉那个唯一的检查/登录窗(别让它常驻)。
  useEffect(() => () => { void scenarioService.closeVideoLoginCheckWindow(); }, []);

  const handleOpen = async (id: string) => {
    // 插件【确认没连上】(fail,非 checking 中)→ 跟 ①「安装并连接浏览器插件」同逻辑:先去装插件,默认打开
    //   Edge 安装页。没插件时登录窗根本开不出,引导装插件比点了没反应强。用 ==='fail' 而非 !=='pass',
    //   避免初始 checking 态误跳安装页(那时插件可能其实连着、只是还没检测完)。
    if (extensionStatus === 'fail') {
      window.open('https://microsoftedge.microsoft.com/addons/detail/laphnggbfbalnemcgjcgmdjaaehldkbd', '_blank');
      return;
    }
    const m = metaOf(id);
    const useCreator = useCreatorFor(id);
    setOpening(id);
    try {
      // 复用【同一个】检查/登录窗:把它导航到该平台登录页(不再每点一个开新窗 → 8 平台 8 个窗)。
      //   用户在这一个窗里挨个登录,cookie 轮询从同一个窗读 → 全部平台都能转绿。
      const loginUrl = useCreator ? m.url : (MAIN_SITE_URL[id] || m.url);
      // 一窗一 tab:直接 task_open_tab(windowKey=video_check)复用同一个 tab。【不再 fallback 开多窗。】
      const res = await scenarioService.openVideoLoginInCheckWindow(loginUrl) as { ok: boolean; diag?: string };
      if (!res.ok) {
        // 开不出检查窗时静默(不再弹诊断窗);留一行 console 便于排查,不打扰用户。
        // eslint-disable-next-line no-console
        console.warn('[videoLoginCheck] openLoginInCheckWindow failed:', res.diag || '(no diag)');
      }
      setTimeout(() => void runCheck(), 2500);
    } finally {
      setOpening(null);
    }
  };

  const allReady = extensionStatus === 'pass' && list.length > 0
    && list.every((p) => platformStatus[p] === 'pass');

  const ICON: Record<StepStatus, string> = { pass: '✅', fail: '❌', checking: '⏳', waiting: '⏳' };

  const installActionButtons = (
    <>
      <div className="flex flex-col gap-1.5">
        <button type="button" onClick={() => window.open('https://chromewebstore.google.com/detail/noobclaw-browser-assistan/abchfdkiphahgkoalhnmlfpfmgkedigf', '_blank')}
          className="text-xs px-3 py-1.5 rounded-lg border border-green-500/30 text-green-500 hover:bg-green-500/10 transition-colors text-left">
          {isZh ? '🌐 安装 Chrome 浏览器插件' : '🌐 Install Chrome Extension'}
        </button>
        <button type="button" onClick={() => window.open('https://addons.mozilla.org/firefox/addon/noobclaw-browser-assistant/', '_blank')}
          className="text-xs px-3 py-1.5 rounded-lg border border-orange-500/30 text-orange-500 hover:bg-orange-500/10 transition-colors text-left">
          {isZh ? '🦊 安装 Firefox 浏览器插件' : '🦊 Install Firefox Extension'}
        </button>
        <button type="button" onClick={() => window.open('https://microsoftedge.microsoft.com/addons/detail/laphnggbfbalnemcgjcgmdjaaehldkbd', '_blank')}
          className="text-xs px-3 py-1.5 rounded-lg border border-blue-500/30 text-blue-500 hover:bg-blue-500/10 transition-colors text-left">
          {isZh ? '🔷 安装 Edge 浏览器插件' : '🔷 Install Edge Extension'}
        </button>
      </div>
      <button type="button" onClick={() => { void runCheck(); }} disabled={checking}
        className="text-xs text-blue-500 hover:underline mt-1">
        {checking ? (isZh ? '检测中...' : 'Checking...') : (isZh ? '🔄 重新检测' : '🔄 Re-check')}
      </button>
    </>
  );

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-3xl max-h-[90vh] flex flex-col rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-2xl overflow-hidden">
        <div className="px-6 pt-5 pb-2 text-center shrink-0">
          <div className="text-3xl mb-1">🔐</div>
          <h3 className="text-lg font-bold dark:text-white">{title || (isZh ? '发布平台登录校验' : 'Publish Platform Login Check')}</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            {subtitle || (isZh ? '保存前需确认每个发布平台都已登录(全部登录才能保存)' : 'All selected platforms must be logged in before saving')}
          </p>
        </div>

        <div className="px-6 py-2 space-y-2.5 overflow-y-auto flex-1">
          {/* Step 1: 浏览器插件 —— 所有 tab 检测的依赖根节点 */}
          <div className={`flex items-start gap-3 rounded-xl px-3 py-2.5 border ${
            extensionStatus === 'fail' ? 'border-red-500/30 bg-red-500/5'
              : extensionStatus === 'pass' ? 'border-green-500/30 bg-green-500/5'
              : 'border-gray-200 dark:border-gray-700'
          }`}>
            <div className="text-xl shrink-0 mt-0.5">{ICON[extensionStatus]}</div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium dark:text-white">{isZh ? '① 安装并连接浏览器插件' : '① Install & connect browser extension'}</div>
              {extensionStatus === 'fail' && (
                <div className="mt-2 space-y-2">
                  <div className="text-xs text-red-500">{isZh ? '插件未连接，请打开浏览器，如尚未安装，点击下方选项进行安装：' : 'Extension not connected. Open your browser; if not installed, click below:'}</div>
                  {installActionButtons}
                </div>
              )}
              {extensionStatus === 'pass' && (
                <div className="text-xs text-green-500 mt-1">{isZh ? '已连接' : 'Connected'}</div>
              )}
            </div>
          </div>

          {/* Step 2: 逐个勾选平台 —— 一平台一行,各自登录态 + 打开登录按钮 */}
          <div className="text-sm font-medium dark:text-white px-1 pt-1">
            {isZh ? `② 登录所选 ${list.length} 个发布平台` : `② Log in to ${list.length} selected platform(s)`}
          </div>
          {/* 平台多(常 8 个)→ 两列排,省竖向空间 */}
          <div className="grid grid-cols-2 gap-2">
          {list.map((id) => {
            const m = metaOf(id);
            const raw = platformStatus[id] || 'checking';
            const realPass = extensionStatus === 'pass' && raw === 'pass';
            const realFail = extensionStatus === 'pass' && raw === 'fail';
            const visualStatus: StepStatus = realPass ? 'pass' : (realFail ? 'fail' : 'checking');
            const label = `${m.emoji} ${isZh ? m.zh : m.en}${useCreatorFor(id) ? (isZh ? '(创作中心)' : ' (Creator)') : ''}`;
            return (
              <div key={id} className={`flex items-start gap-3 rounded-xl px-3 py-2.5 border ${
                visualStatus === 'fail' ? 'border-red-500/30 bg-red-500/5'
                  : visualStatus === 'pass' ? 'border-green-500/30 bg-green-500/5'
                  : 'border-gray-200 dark:border-gray-700'
              }`}>
                <div className="text-xl shrink-0 mt-0.5">{ICON[visualStatus]}</div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium dark:text-white">{label}</div>
                  {realPass && (
                    <div className="text-xs text-green-500 mt-1">{isZh ? '已登录' : 'Logged in'}</div>
                  )}
                  {realFail && (
                    <div className="text-xs text-red-500 mt-1">
                      {isZh ? '未登录(未打开,或停在登录页)' : 'Not logged in (tab missing or on login page)'}
                    </div>
                  )}
                  {!realPass && extensionStatus !== 'pass' && (
                    <div className="text-xs text-gray-400 mt-1">
                      {isZh ? '装好插件后这里会自动确认' : 'Auto-verifies once extension is connected'}
                    </div>
                  )}
                  {!realPass && (
                    <button type="button" onClick={() => handleOpen(id)} disabled={opening === id}
                      className="mt-2 text-xs font-medium px-3 py-1.5 rounded-lg bg-blue-500 text-white hover:bg-blue-600 transition-colors disabled:opacity-50">
                      {opening === id ? '...' : (isZh ? `🌐 打开 ${m.zh} 登录` : `🌐 Open ${m.en} login`)}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          </div>

          {/* Step 3: 使用须知 */}
          <div className="rounded-xl p-3 border border-gray-200 dark:border-gray-700">
            <div className="text-sm font-medium dark:text-white mb-2">{isZh ? '③ 使用须知' : '③ Usage Notes'}</div>
            <ul className="text-xs text-gray-600 dark:text-gray-300 space-y-1.5 leading-relaxed">
              <li>🚀 {isZh ? '发布时所有平台会在【同一个窗口】依次上传(不会每平台开一个窗口)' : 'All platforms upload one-by-one in a single window'}</li>
              <li>🔐 {isZh ? <>运行期间请<strong>不要退出任一平台登录</strong></> : <><strong>Do not log out</strong> of any platform during a run</>}</li>
              <li>⏰ {isZh ? '某平台运行时未登录会等待 3 分钟,超时则跳过该平台(本条视频不再补传)' : 'A platform not logged in at run time waits 3 min, then is skipped for this video'}</li>
            </ul>
          </div>
        </div>

        {/* Bottom button — allReady 才能保存(决策①:必须全登录) */}
        <div className="px-6 py-3 flex flex-col items-center gap-1.5 border-t border-gray-200 dark:border-gray-800 shrink-0">
          <button
            type="button"
            onClick={onConfirmed}
            disabled={!allReady}
            className={`w-full max-w-[280px] text-sm font-semibold px-6 py-2.5 rounded-xl transition-colors ${
              allReady
                ? 'bg-green-500 text-white hover:bg-green-600'
                : 'bg-gray-300 dark:bg-gray-700 text-gray-500 cursor-not-allowed'
            }`}
          >
            {allReady
              ? (isZh ? '✅ 全部已登录，保存任务' : '✅ All logged in, Save')
              : (isZh ? '请先登录全部平台' : 'Log in to all platforms first')}
          </button>
          <button type="button" onClick={onCancel}
            className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
            {isZh ? '返回' : 'Back'}
          </button>
        </div>
      </div>
    </div>
  );
};
