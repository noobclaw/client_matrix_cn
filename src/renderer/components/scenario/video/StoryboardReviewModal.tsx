/**
 * StoryboardReviewModal — 电影级「分镜表」审阅屏。
 *
 * ## 为什么必须有这一屏
 * 老链路是:填完向导 → 直接开跑 → 几分钟后出片才知道对不对。分镜表把【烧钱之前】的
 * 那一刻交还给用户:
 *   · 对齐   —— AI 猜歪了在这里就拦住,不用等出片
 *   · 校验   —— 用户粘的脚本解析对没对,一眼看穿
 *   · 止损   —— Seedance 是逐镜真金白银,跑完才发现方向错了钱就白烧了
 *   · 控成本 —— 「要动」逐镜勾选。不勾 = 首帧 + 运镜(几毛);勾了 = 生成视频(几块)
 *
 * ## 数据契约
 * shots 原样来自主进程 storyboardScript 的解析结果,用户改完后作为
 * `input.storyboardShots` 回传 pipeline —— pipeline 见到它就直接用,不再跑一次解析
 * (省一次 AI 调用,也保证用户改过的内容原样生效)。
 *
 * locked[] 记录的是【用户脚本里明确写了】的字段,这里用一个小锁标出来,提示用户
 * 这些内容来自他自己的脚本、AI 没有改过。
 */

import React, { useMemo, useState, useEffect } from 'react';
import type { StoryShot } from '../../../services/videoCreation';

type ShotType = StoryShot['type'];

const TYPE_META: Record<ShotType, { zh: string; en: string; cls: string }> = {
  chart:      { zh: '图表',   en: 'Chart',      cls: 'bg-violet-500/15 text-violet-700 dark:text-violet-300' },
  textcard:   { zh: '文字卡', en: 'Text card',  cls: 'bg-blue-500/15 text-blue-700 dark:text-blue-300' },
  scene:      { zh: '实景',   en: 'Scene',      cls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
  person:     { zh: '人物',   en: 'Person',     cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
  logo:       { zh: '标识',   en: 'Logo',       cls: 'bg-slate-500/15 text-slate-700 dark:text-slate-300' },
  transition: { zh: '转场',   en: 'Transition', cls: 'bg-gray-500/15 text-gray-600 dark:text-gray-400' },
};
const TYPE_ORDER: ShotType[] = ['scene', 'person', 'chart', 'textcard', 'logo', 'transition'];

export interface StoryboardReviewModalProps {
  open: boolean;
  isZh: boolean;
  /** 解析中 → 显示骨架/进度。 */
  loading: boolean;
  /** 解析失败原因(非空时显示错误态 + 重试)。 */
  error?: string | null;
  shots: StoryShot[];
  /** 解析器的告警(逐字保真、截断等),原样透传给用户。 */
  warnings?: string[];
  /** 口播逐字复核 0~1。<1 说明 AI 可能改写了原文 —— 必须让用户看见。 */
  fidelity?: number;
  /** Seedance 每秒积分(用于估「要动」的镜要花多少)。拿不到就不显示金额。 */
  creditsPerSec?: number | null;
  usdPerSec?: number | null;
  onChange: (shots: StoryShot[]) => void;
  onRetry: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function StoryboardReviewModal(props: StoryboardReviewModalProps) {
  const {
    open, isZh, loading, error, shots, warnings, fidelity,
    creditsPerSec, usdPerSec, onChange, onRetry, onConfirm, onCancel,
  } = props;
  const [expanded, setExpanded] = useState<number | null>(null);
  // 解析已跑了多少秒。长脚本要分块跑几次 LLM,十几二十秒很正常 —— 没有动的东西
  // 用户会以为卡死了,所以给一个走字的计时 + 转圈。
  const [elapsed, setElapsed] = useState(0);
  const [copied, setCopied] = useState(false);

  // 关闭时收起展开态,避免下次打开还停在上一次那一行。
  useEffect(() => { if (!open) setExpanded(null); }, [open]);
  useEffect(() => {
    if (!loading) { setElapsed(0); return; }
    setElapsed(0);
    const t = setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [loading]);

  const totalSec = useMemo(
    () => Math.round(shots.reduce((a, s) => a + (Number(s.seconds) || 0), 0)),
    [shots],
  );
  // 电影级每一镜都生成 AI 视频 → 按全部镜的时长估(单镜 clamp 到 Seedance 的 [4,12])。
  // 每镜在整片时间轴上的起点,用来显示「0:20 - 0:50」这种时间码。
  const startAt = useMemo(() => {
    const out: number[] = [];
    let t = 0;
    for (const x of shots) { out.push(t); t += Number(x.seconds) || 0; }
    return out;
  }, [shots]);
  const animateSec = useMemo(
    () => shots.reduce((a, s) => a + Math.max(4, Math.min(12, Number(s.seconds) || 5)), 0),
    [shots],
  );
  const estCredits = creditsPerSec != null ? Math.round(creditsPerSec * animateSec) : null;
  const estUsd = usdPerSec != null ? usdPerSec * animateSec : null;

  if (!open) return null;

  const patch = (i: number, p: Partial<StoryShot>) => {
    const next = shots.slice();
    next[i] = { ...next[i], ...p };
    onChange(next);
  };
  const removeAt = (i: number) => onChange(shots.filter((_, k) => k !== i));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= shots.length) return;
    const next = shots.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const isLocked = (s: StoryShot, field: string) => Array.isArray(s.locked) && s.locked.includes(field);

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-5xl max-h-[90vh] flex flex-col rounded-2xl bg-white dark:bg-gray-900 shadow-2xl border border-gray-200 dark:border-gray-800">
        {/* 头 */}
        <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-800 flex items-start justify-between gap-4">
          <div>
            <div className="text-base font-semibold dark:text-white">
              {isZh ? '分镜脚本' : 'Storyboard script'}
              {shots.length > 0 && (
                <span className="ml-2 text-[12px] font-normal text-gray-400">
                  {isZh ? `${shots.length} 镜 · 约 ${totalSec} 秒` : `${shots.length} shots · ~${totalSec}s`}
                </span>
              )}
            </div>
            <div className="text-[12px] text-gray-500 dark:text-gray-400 mt-0.5 leading-relaxed">
              {isZh
                ? '按你的内容生成的完整分镜稿：每一镜念什么、画什么、怎么动、打什么字、配什么乐。每一镜都会用 AI 生成视频。可以直接改，也可以复制／导出留档。'
                : 'A complete storyboard for your video: what each shot says, shows, how it moves, its caption and score. Every shot is generated as AI video. Edit it, copy it, or export it.'}
            </div>
          </div>
          <div className="shrink-0 flex items-center gap-2">
            {shots.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  try { void navigator.clipboard.writeText(toScriptText(shots, isZh)); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* ignore */ }
                }}
                className="px-2.5 py-1.5 rounded-lg text-xs border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                {copied ? (isZh ? '✓ 已复制' : '✓ Copied') : (isZh ? '📋 复制脚本' : '📋 Copy')}
              </button>
            )}
            <button
              type="button"
              onClick={onCancel}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none px-1"
              aria-label={isZh ? '关闭' : 'Close'}
            >
              ×
            </button>
          </div>
        </div>

        {/* 体 */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading && (
            <div className="py-16 flex flex-col items-center gap-3">
              <span className="w-7 h-7 rounded-full border-2 border-fuchsia-500/30 border-t-fuchsia-500 animate-spin" />
              <div className="text-sm text-gray-500 dark:text-gray-400">
                {isZh ? '正在解析分镜…' : 'Parsing storyboard…'}
                <span className="ml-1 tabular-nums text-fuchsia-500 font-medium">{elapsed}s</span>
              </div>
              <div className="text-[11px] text-gray-400">
                {isZh
                  ? '只跑文字，不出图、不生成视频。脚本越长拆得越多，通常 10~40 秒。'
                  : 'Text only — no images, no video. Longer scripts take more passes, usually 10-40s.'}
              </div>
            </div>
          )}

          {!loading && error && (
            <div className="py-12 text-center">
              <div className="text-sm text-red-500 mb-3">
                {isZh ? `分镜解析失败：${error}` : `Storyboard parse failed: ${error}`}
              </div>
              <button
                type="button"
                onClick={onRetry}
                className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 text-sm dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                {isZh ? '重试' : 'Retry'}
              </button>
            </div>
          )}

          {!loading && !error && (
            <>
              {/* 逐字保真告警:口播被 AI 改写过是最严重的问题,必须显眼 */}
              {typeof fidelity === 'number' && fidelity < 0.99 && (
                <div className="mb-3 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-[12px] text-amber-800 dark:text-amber-300">
                  {isZh
                    ? `⚠️ 口播逐字复核 ${(fidelity * 100).toFixed(0)}% —— AI 可能改动了原文措辞，请核对下面的「口播」列。`
                    : `⚠️ Verbatim check ${(fidelity * 100).toFixed(0)}% — the AI may have reworded your script. Please check the Narration column.`}
                </div>
              )}
              {Array.isArray(warnings) && warnings.length > 0 && (
                <div className="mb-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 px-3 py-2 text-[12px] text-gray-600 dark:text-gray-400">
                  {warnings.map((w, i) => <div key={i}>· {w}</div>)}
                </div>
              )}

              {shots.length === 0 && (
                <div className="py-12 text-center text-sm text-gray-500">
                  {isZh ? '没有解析出任何分镜' : 'No shots parsed'}
                </div>
              )}

              <div className="space-y-2">
                {shots.map((s, i) => {
                  const meta = TYPE_META[s.type] || TYPE_META.scene;
                  const isOpen = expanded === i;
                  return (
                    <div
                      key={i}
                      className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-800/40"
                    >
                      {/* 一镜 = 一个场景块,版式对齐用户手写分镜稿:
                          序号 + 标题 / 时间码 · 时长 / 景别类型,下面是分节标签的字段。 */}
                      <div className="px-4 py-3">
                        <div className="flex items-baseline gap-2 mb-2">
                          <span className="text-[15px] font-semibold text-fuchsia-600 dark:text-fuchsia-400 tabular-nums">{i + 1}</span>
                          <input
                            value={s.title || ''}
                            onChange={(e) => patch(i, { title: e.target.value })}
                            placeholder={isZh ? '这一镜干什么（如：黄金3秒钩子 · 砸出悬念）' : 'What this shot does'}
                            className="flex-1 min-w-0 bg-transparent border-0 border-b border-transparent hover:border-gray-300 dark:hover:border-gray-700 focus:border-fuchsia-500 focus:outline-none text-[14px] font-medium dark:text-white px-0 py-0.5"
                          />
                          <button type="button" onClick={() => move(i, -1)} disabled={i === 0}
                            className="px-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-30" title={isZh ? '上移' : 'Up'}>↑</button>
                          <button type="button" onClick={() => move(i, 1)} disabled={i === shots.length - 1}
                            className="px-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-30" title={isZh ? '下移' : 'Down'}>↓</button>
                          <button type="button" onClick={() => removeAt(i)}
                            className="px-1 text-gray-400 hover:text-red-500" title={isZh ? '删除这一镜' : 'Delete'}>🗑</button>
                          <button type="button" onClick={() => setExpanded(isOpen ? null : i)}
                            className="px-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                            title={isZh ? '编辑这一镜' : 'Edit'}>{isOpen ? '▴' : '✎'}</button>
                        </div>
                        {/* 时间码 · 时长 · 景别 —— 对齐手写稿里「0:00 - 0:08 · 8秒」那一行 */}
                        <div className="flex items-center gap-2 mb-2 text-[12px] text-gray-500 dark:text-gray-400">
                          <span className="tabular-nums">{fmtClock(startAt[i])} - {fmtClock(startAt[i] + s.seconds)}</span>
                          <span className="text-gray-300 dark:text-gray-700">·</span>
                          <input
                            type="number" min={1} max={120} value={s.seconds}
                            onChange={(e) => patch(i, { seconds: Math.max(1, Math.min(120, Number(e.target.value) || 1)) })}
                            className="w-12 rounded border border-gray-300 dark:border-gray-700 bg-transparent px-1 py-0.5 text-[12px] dark:text-white tabular-nums"
                          />
                          <span>{isZh ? '秒' : 's'}</span>
                          <span className="text-gray-300 dark:text-gray-700">·</span>
                          <select
                            value={s.type}
                            onChange={(e) => patch(i, { type: e.target.value as ShotType })}
                            className={`rounded px-1.5 py-0.5 text-[11px] border-0 ${meta.cls}`}
                          >
                            {TYPE_ORDER.map((t) => (
                              <option key={t} value={t}>{isZh ? TYPE_META[t].zh : TYPE_META[t].en}</option>
                            ))}
                          </select>
                        </div>
                        {/* 分节字段 —— 对齐手写稿的「景别运镜 / 画面内容 / 口播旁白 / 字幕花字 / 音乐音效」 */}
                        <div className="space-y-2">
                          <ScriptField label={isZh ? '画面内容' : 'Visual'} value={s.visualFirst}
                            empty={isZh ? '（没写画面，AI 会自己发挥）' : '(none — AI will improvise)'} warn={!s.visualFirst} />
                          {s.motion && <ScriptField label={isZh ? '景别运镜' : 'Camera'} value={s.motion} muted />}
                          <ScriptField label={isZh ? '口播旁白' : 'Narration'} value={s.narration}
                            empty={isZh ? '（这一镜不说话）' : '(silent)'} />
                          {s.onScreenText && <ScriptField label={isZh ? '字幕花字' : 'Caption'} value={s.onScreenText} />}
                          {(s.bgmMood || s.sfx) && (
                            <ScriptField
                              label={isZh ? '音乐音效' : 'Audio'}
                              value={[s.bgmMood, s.sfx].filter(Boolean).join(' · ')}
                              muted
                            />
                          )}
                        </div>
                      </div>
                      {isOpen && (
                        <div className="px-3 pb-3 pt-1 space-y-2 border-t border-gray-100 dark:border-gray-800">
                          <Row
                            label={isZh ? '口播（逐字照念）' : 'Narration (verbatim)'}
                            locked={isLocked(s, 'narration')}
                            isZh={isZh}
                          >
                            <textarea
                              value={s.narration}
                              onChange={(e) => patch(i, { narration: e.target.value })}
                              rows={2}
                              className="w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1 text-[12px] dark:text-white resize-y"
                            />
                          </Row>
                          <Row
                            label={isZh ? '画面（决定这镜画什么）' : 'Visual (what gets generated)'}
                            locked={isLocked(s, 'visual_first')}
                            isZh={isZh}
                          >
                            <textarea
                              value={s.visualFirst}
                              onChange={(e) => patch(i, { visualFirst: e.target.value })}
                              rows={2}
                              className="w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1 text-[12px] dark:text-white resize-y"
                            />
                          </Row>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <Row label={isZh ? '花字（打在屏幕上）' : 'On-screen text'} locked={isLocked(s, 'on_screen_text')} isZh={isZh}>
                              <input
                                value={s.onScreenText || ''}
                                onChange={(e) => patch(i, { onScreenText: e.target.value })}
                                className="w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1 text-[12px] dark:text-white"
                              />
                            </Row>
                            <Row label={isZh ? '配乐情绪' : 'Music mood'} locked={isLocked(s, 'bgm_mood')} isZh={isZh}>
                              <input
                                value={s.bgmMood || ''}
                                onChange={(e) => patch(i, { bgmMood: e.target.value })}
                                placeholder={isZh ? '轻快 / 紧张 / 悬疑 / 大气…' : 'upbeat / tense / mystery…'}
                                className="w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1 text-[12px] dark:text-white"
                              />
                            </Row>
                          </div>
                          {/* 每一镜都会生成视频 → 运动始终可编辑,不再按 animate 条件显示。 */}
                          {(
                            <Row label={isZh ? '景别运镜' : 'Camera'} locked={isLocked(s, 'motion')} isZh={isZh}>
                              <input
                                value={s.motion || ''}
                                onChange={(e) => patch(i, { motion: e.target.value })}
                                placeholder={isZh ? '如：镜头缓慢推近，人物转头看向窗外' : 'e.g. slow push-in, subject turns toward the window'}
                                className="w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1 text-[12px] dark:text-white"
                              />
                            </Row>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* 脚:统计 + 费用 + 确认 */}
        <div className="px-5 py-3 border-t border-gray-200 dark:border-gray-800 flex flex-wrap items-center gap-x-4 gap-y-2 justify-between">
          <div className="text-[12px] text-gray-600 dark:text-gray-400">
            <span className="dark:text-gray-200 font-medium">{shots.length}</span> {isZh ? '镜' : 'shots'}
            <span className="mx-2 text-gray-300 dark:text-gray-700">·</span>
            {isZh ? '约' : '~'} <span className="dark:text-gray-200 font-medium">{totalSec}</span>s
            {estCredits != null && (
              <>
                <span className="mx-2 text-gray-300 dark:text-gray-700">·</span>
                <span className="text-fuchsia-600 dark:text-fuchsia-400">
                  {isZh ? '预估 ' : 'est. '}{estCredits.toLocaleString()} {isZh ? '积分' : 'credits'}
                  {estUsd != null && ` ($${estUsd.toFixed(2)})`}
                </span>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 text-sm dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              {isZh ? '返回修改' : 'Back'}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={loading || !!error || shots.length === 0}
              className="px-5 py-2 rounded-lg bg-fuchsia-600 hover:bg-fuchsia-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium"
            >
              {isZh ? '确认，开始生成' : 'Confirm & generate'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 分镜脚本 → 纯文本。用户可以复制走存档、发给剪辑、或下次直接粘回来。
 *  格式与主进程写进成片目录的「分镜表.txt」保持一致。 */
function toScriptText(shots: StoryShot[], isZh: boolean): string {
  const total = Math.round(shots.reduce((a, x) => a + (Number(x.seconds) || 0), 0));
  const out: string[] = [
    isZh ? `分镜脚本 · ${shots.length} 镜 · 约 ${total} 秒` : `Storyboard · ${shots.length} shots · ~${total}s`,
    '',
  ];
  let clock = 0;
  shots.forEach((x, i) => {
    const dur = Number(x.seconds) || 0;
    out.push(`${i + 1}  ${x.title || ''}`.trimEnd());
    out.push(`${fmtClock(clock)} - ${fmtClock(clock + dur)} · ${dur}${isZh ? '秒' : 's'} · ${TYPE_META[x.type]?.[isZh ? 'zh' : 'en'] || x.type}`);
    clock += dur;
    if (x.visualFirst) { out.push(isZh ? '画面内容' : 'Visual'); out.push(x.visualFirst); }
    if (x.visualLast) { out.push(isZh ? '尾帧画面' : 'End frame'); out.push(x.visualLast); }
    if (x.motion) { out.push(isZh ? '景别运镜' : 'Camera'); out.push(x.motion); }
    if (x.narration) { out.push(isZh ? '口播旁白' : 'Narration'); out.push(x.narration); }
    if (x.onScreenText) { out.push(isZh ? '字幕花字' : 'Caption'); out.push(x.onScreenText); }
    if (x.bgmMood || x.sfx) { out.push(isZh ? '音乐音效' : 'Audio'); out.push([x.bgmMood, x.sfx].filter(Boolean).join(' · ')); }
    out.push('');
  });
  return out.join('\n');
}

/** 秒 → mm:ss。分镜稿要有时间码,不然看不出这一镜落在片子哪一段。 */
function fmtClock(sec: number): string {
  const t = Math.max(0, Math.round(sec));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

/** 一节字段:上面小标签,下面内容 —— 对齐手写分镜稿「画面内容 / 口播旁白」那种版式。 */
function ScriptField(props: { label: string; value?: string; empty?: string; muted?: boolean; warn?: boolean }) {
  const { label, value, empty, muted, warn } = props;
  if (!value && !empty) return null;
  return (
    <div>
      <div className="text-[11px] text-gray-400 dark:text-gray-500 mb-0.5">{label}</div>
      <div className={`text-[13px] leading-relaxed break-words ${
        !value ? (warn ? 'text-amber-500' : 'text-gray-400')
        : muted ? 'text-gray-500 dark:text-gray-400'
        : 'text-gray-800 dark:text-gray-200'}`}>
        {value || empty}
      </div>
    </div>
  );
}

function Row(props: { label: string; locked?: boolean; isZh: boolean; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] text-gray-500 dark:text-gray-400 mb-0.5 flex items-center gap-1">
        {props.label}
        {props.locked && (
          <span
            className="text-[10px] px-1 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
            title={props.isZh ? '来自你的脚本，AI 没有改动' : 'From your script — untouched by AI'}
          >
            🔒 {props.isZh ? '你写的' : 'yours'}
          </span>
        )}
      </div>
      {props.children}
    </div>
  );
}
