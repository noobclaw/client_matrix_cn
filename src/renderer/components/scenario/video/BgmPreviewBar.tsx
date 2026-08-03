/**
 * BgmPreviewBar — 背景音乐「试听 + 打开文件夹」统一组件。
 *
 * ## 为什么抽出来
 * 视频这一大类下有 6 个向导(视频创作 / 模板速生 / 热搜成片 / 爆帖成片 / 本地混剪 / 翻译搬运),
 * 每个都各写了一套 BGM 试听:按钮颜色、尺寸、布局全不一样,只有主向导带「📂 文件夹」按钮,
 * 其余的选了曲子只能盲听或干脆没法定位文件。用户要求统一成主向导那一版。
 *
 * 现在这里是唯一实现:各向导用 useBgmPreview() 拿状态、渲染 <BgmPreviewBar/>,以后改样式只改这里。
 *
 * ## 为什么「打开文件夹」而不是只做内嵌播放
 * 内嵌 <audio> 在部分环境(webview 编解码 / 自动播放策略)播不出来。打开目录是兜底:
 * 内置 → 随包 bgm 目录;云端 → 缓存目录;上传 → 文件所在目录。两条路都给,总有一条通。
 */

import { useEffect, useState } from 'react';
import { videoCreationService } from '../../../services/videoCreation';

/** 试听出错时给用户看的一行(带原始原因,方便截图定位)。 */
export function bgmPreviewMsg(err: string, isZh: boolean): string {
  if (err === 'no_bgm_selected') return isZh ? '先选一首背景音乐再试听' : 'Pick a track first';
  return (isZh ? '试听失败：' : 'Preview failed: ') + err;
}

/**
 * 把 bgm token 解析成 <audio> 能播的 URL。
 * 云端曲目会在主进程按需下载并缓存;失败时把【原始原因】带出来,用户截图就能定位。
 */
export async function resolveBgmPreview(token: string): Promise<{ url: string; err: string }> {
  if (!token) return { url: '', err: 'no_bgm_selected' };
  if (!videoCreationService.available) return { url: '', err: 'video_ipc_unavailable(主进程没挂上)' };
  let raw = '';
  try {
    raw = await videoCreationService.prepareBgmPreview(token);
  } catch (e) {
    return { url: '', err: 'ipc_threw: ' + String((e as Error)?.message || e).slice(0, 120) };
  }
  try { console.info('[bgm-preview] token=' + token + ' raw=' + String(raw).slice(0, 160)); } catch { /* ignore */ }
  if (!raw) {
    // 空 = sidecar 要么不认这个 channel(装的包里 sidecar 比界面旧,未知 channel 一律回 null),
    // 要么解析确实没结果。再问一次【只解析路径】的老 channel 就能区分这两种,省一轮猜。
    let probe = '';
    try { probe = await videoCreationService.resolveBgmPath(token); } catch { probe = '(threw)'; }
    return { url: '', err: 'sidecar_returned_empty; resolveBgmPath=' + (probe || '(empty)') };
  }
  if (raw.startsWith('ERR:')) return { url: '', err: raw.slice(4) };
  if (!/^https?:/i.test(raw)) return { url: raw, err: '' };        // data: URL 直接播
  try {
    const r = await fetch(raw);
    if (!r.ok) return { url: '', err: 'http_' + r.status + ' from local-file' };
    const b = await r.blob();
    if (!b.size) return { url: '', err: 'empty_body(0 字节)' };
    return { url: URL.createObjectURL(b), err: '' };
  } catch (e) {
    // fetch 拿不到就退回直接把 http URL 交给 <audio>(webview 能直连 sidecar 时仍可播)
    try { console.warn('[bgm-preview] fetch failed, falling back to direct src', e); } catch { /* ignore */ }
    return { url: raw, err: '' };
  }
}

export interface BgmPreviewState {
  previewUrl: string;
  previewErr: string;
  loading: boolean;
  opening: boolean;
  preview: () => void;
  openFolder: () => void;
  setPreviewErr: (s: string) => void;
  /**
   * 每点一次试听自增。作为 <audio> 的 key 强制重挂 —— 否则第二次点同一首/同一个音色时,
   * setPreviewUrl 设的是同一个值,React 不重渲染,autoPlay 不会再触发,
   * 用户看到的就是「按钮点了没反应,得切走再切回来才行」。
   */
  nonce: number;
}

/**
 * BGM 试听状态 + 两个动作。各向导只需 `const bgm = useBgmPreview(bgmPath, isZh)`。
 * 切换曲目时自动清掉上一首的播放器和红字(选 A → 切 B 仍在会误导)。
 */
export function useBgmPreview(bgmPath: string, isZh: boolean): BgmPreviewState {
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewErr, setPreviewErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => { setPreviewErr(''); setPreviewUrl(''); }, [bgmPath]);

  const preview = async () => {
    if (!bgmPath || loading) return;
    setNonce((n) => n + 1);   // 再点一次要能重播,见 BgmPreviewState.nonce
    setLoading(true);
    setPreviewErr('');
    try {
      const r = await resolveBgmPreview(bgmPath);
      if (r.url) setPreviewUrl(r.url);
      if (r.err) setPreviewErr(bgmPreviewMsg(r.err, isZh));
    } catch {
      setPreviewErr(isZh ? '试听失败' : 'Preview failed');
    } finally {
      setLoading(false);
    }
  };

  const openFolder = async () => {
    if (!bgmPath || opening) return;
    setOpening(true);
    try {
      // 主进程返回的是【目录】(不下载、不要求文件已存在),比定位单文件健壮。
      const dir = await videoCreationService.resolveBgmPath(bgmPath);
      if (dir) {
        try { (window as any).electron?.shell?.openPath?.(dir); } catch { /* ignore */ }
        setPreviewErr('');
      } else {
        setPreviewErr(isZh ? '打开失败：找不到 BGM 目录' : 'Failed: BGM folder not found');
      }
    } catch {
      setPreviewErr(isZh ? '打开失败：无法打开 BGM 目录' : 'Failed to open the BGM folder');
    } finally {
      setOpening(false);
    }
  };

  return { previewUrl, previewErr, loading, opening, preview, openFolder, setPreviewErr, nonce };
}

/**
 * 配音试听。跟 BGM 用同一套 UI 和状态形状,只是没有「文件夹」按钮(音频是现合成的,
 * 不落盘也没有目录可开)。
 *
 * ⚠️ 豆包音色走后端代理【按字符计费】,所以主进程那边样例句只有十来个字(voiceSample.ts)。
 *    Edge 音色免费。
 */
/**
 * 已合成过的样例缓存(音色+语速 → dataURL)。模块级,跨向导/跨开关弹窗都命中。
 *
 * ⚠️ 必须有:豆包音色走后端代理【按字符计费】,用户来回比对几个音色就会重复扣费。
 *    同一个音色 + 同一档语速,合成结果本来就一样,没有任何理由再跑一遍。
 *    上限 40 条,超了按插入顺序丢最旧的(样例句很短,内存压力可忽略)。
 */
const voiceSampleCache = new Map<string, string>();
const VOICE_CACHE_MAX = 40;

export function useVoicePreview(voice: string, rate: number | undefined, lang: string | undefined, isZh: boolean): BgmPreviewState {
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewErr, setPreviewErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);

  // 换音色/语速就清掉播放器,避免听到的还是上一个音色。
  useEffect(() => { setPreviewErr(''); setPreviewUrl(''); }, [voice, rate]);

  const preview = async () => {
    if (!voice || loading) return;
    setNonce((n) => n + 1);   // 再点一次要能重播,见 BgmPreviewState.nonce
    const key = `${voice}|${rate ?? ''}`;
    // 听过的直接回放,不再合成、不再扣费。
    const cached = voiceSampleCache.get(key);
    if (cached) { setPreviewErr(''); setPreviewUrl(cached); return; }
    setLoading(true);
    setPreviewErr('');
    try {
      const api = (window as any).electron?.video;
      if (!api?.previewVoice) {
        setPreviewErr(isZh ? '当前版本不支持配音试听' : 'Voice preview unavailable');
        return;
      }
      const r = await api.previewVoice({ voice, rate, lang });
      if (r?.ok && r.dataUrl) {
        if (voiceSampleCache.size >= VOICE_CACHE_MAX) {
          const oldest = voiceSampleCache.keys().next().value;
          if (oldest) voiceSampleCache.delete(oldest);
        }
        voiceSampleCache.set(key, r.dataUrl);
        setPreviewUrl(r.dataUrl);
      } else setPreviewErr((isZh ? '试听失败：' : 'Preview failed: ') + (r?.error || 'unknown'));
    } catch (e) {
      setPreviewErr((isZh ? '试听失败：' : 'Preview failed: ') + String((e as Error)?.message || e).slice(0, 120));
    } finally {
      setLoading(false);
    }
  };

  return {
    previewUrl, previewErr, loading, opening: false,
    preview, openFolder: () => { /* 配音没有目录可开 */ }, setPreviewErr, nonce,
  };
}

export interface BgmPreviewBarProps {
  isZh: boolean;
  /** 当前选中的 bgm token / 音色 id;空 = 不渲染(没选就没什么可试听的)。 */
  bgmPath: string;
  state: BgmPreviewState;
  /** 主色调,跟所在向导的配色走。默认玫红(与视频创作向导一致)。 */
  tone?: 'rose' | 'fuchsia' | 'amber' | 'emerald' | 'sky';
  /** 云端曲目的下载提示行(只有曲库那种下拉需要)。 */
  showCloudHint?: boolean;
  /** 是否显示「📂 文件夹」按钮。配音试听传 false(现合成的音频没有目录)。默认 true。 */
  showFolder?: boolean;
  /** 按钮文案覆盖(如配音用「▶ 试听音色」)。 */
  previewLabel?: string;
}

const TONE: Record<NonNullable<BgmPreviewBarProps['tone']>, { solid: string; ghost: string }> = {
  rose:     { solid: 'bg-rose-500 hover:bg-rose-600',       ghost: 'border-rose-400 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10' },
  fuchsia:  { solid: 'bg-fuchsia-500 hover:bg-fuchsia-600', ghost: 'border-fuchsia-400 text-fuchsia-500 hover:bg-fuchsia-50 dark:hover:bg-fuchsia-500/10' },
  amber:    { solid: 'bg-amber-500 hover:bg-amber-600',     ghost: 'border-amber-400 text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-500/10' },
  emerald:  { solid: 'bg-emerald-500 hover:bg-emerald-600', ghost: 'border-emerald-400 text-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-500/10' },
  sky:      { solid: 'bg-sky-500 hover:bg-sky-600',         ghost: 'border-sky-400 text-sky-500 hover:bg-sky-50 dark:hover:bg-sky-500/10' },
};

/**
 * 试听 + 文件夹两个按钮。**放进 select 所在的那一行**(左右布局:select 占大部分宽度,
 * 两个按钮贴右)—— 这是原来的样子,别再让试听独占一整行。
 * 播放器和错误行由 <BgmPreviewPlayer/> 渲染在这一行【下面】。
 */
export function BgmPreviewButtons({ isZh, bgmPath, state, tone = 'rose', showFolder = true, previewLabel }: BgmPreviewBarProps) {
  if (!bgmPath) return null;
  const t = TONE[tone] || TONE.rose;
  return (
    <>
      <button
        type="button"
        onClick={state.preview}
        disabled={state.loading}
        className={`shrink-0 px-3 py-2 rounded-lg text-xs font-medium text-white transition-colors disabled:opacity-60 ${t.solid}`}
      >
        {state.loading ? '⏳' : (previewLabel || (isZh ? '▶ 试听' : '▶ Preview'))}
      </button>
      {showFolder && (
        <button
          type="button"
          onClick={state.openFolder}
          disabled={state.opening}
          className={`shrink-0 px-2.5 py-2 rounded-lg text-xs font-medium border transition-colors disabled:opacity-60 ${t.ghost}`}
        >
          {state.opening ? '⏳' : (isZh ? '📂 文件夹' : '📂 Folder')}
        </button>
      )}
    </>
  );
}

/** 播放器 + 错误行 + 云端提示。放在 select 那一行【下面】。 */
export function BgmPreviewPlayer({ isZh, bgmPath, state, showCloudHint }: BgmPreviewBarProps) {
  if (!bgmPath) return null;
  const hasCloudHint = !!showCloudHint && bgmPath.startsWith('remote:');
  if (!state.previewUrl && !state.previewErr && !hasCloudHint) return null;
  return (
    <div className="mt-1.5 space-y-1.5">
      {state.previewUrl && (
        <audio
          key={`${bgmPath}|${state.nonce}`}
          controls
          autoPlay
          src={state.previewUrl}
          className="w-full h-9"
          onCanPlay={(e) => {
            const el = e.currentTarget;
            el.play().catch(() => state.setPreviewErr(bgmPreviewMsg('autoplay_blocked(点播放器上的 ▶ 手动播)', isZh)));
          }}
          onError={() => state.setPreviewErr(bgmPreviewMsg('audio_decode_failed(格式不支持/文件坏)', isZh))}
        />
      )}
      {state.previewErr && <div className="text-[11px] text-red-500 break-all">{state.previewErr}</div>}
      {hasCloudHint && (
        <div className="text-[11px] text-gray-400">
          {isZh
            ? '☁️ 云端曲目首次打开文件夹/合成时自动下载并缓存，之后复用不再下载。'
            : '☁️ Cloud track downloads on first open/compose, then cached.'}
        </div>
      )}
    </div>
  );
}

/**
 * 独立成块的版本(没有 select 可并排时用,如「上传的曲子」那种场景)。
 * 有 select 的地方请用 BgmPreviewButtons + BgmPreviewPlayer,保持左右布局。
 */
export default function BgmPreviewBar(props: BgmPreviewBarProps) {
  if (!props.bgmPath) return null;
  return (
    <div className="mt-2">
      <div className="flex gap-2 justify-end">
        <BgmPreviewButtons {...props} />
      </div>
      <BgmPreviewPlayer {...props} />
    </div>
  );
}
