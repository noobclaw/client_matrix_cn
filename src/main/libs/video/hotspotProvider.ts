/**
 * hotspotProvider — 热搜成片:调 NoobClaw 服务端的 hotspot API。
 *
 * key(Serper)全留服务端,客户端只拿结果:
 *   · pickHotspotTopic            选题(从用户勾选的热点源最新 N 条随机 1 条)
 *   · fetchHotspotMaterial        Serper /news 联网取这条热点的最新资料(给 scriptWriter 当 material)
 *
 * 配图已不走 Serper(2026-06 决策:中文→抖音、英文/小语种→TikTok,见 pipeline.ts visuals);
 * 原 Serper 配图编排(fetchHotspotImagePlan / downloadHotspotImages 等)已删。
 *
 * 全部"降级不报错":服务端没配 serper key / 没网 → 选题返 null、material 返空,
 * 上层据此走纯文案 / 文字卡兜底,不让整条任务崩。
 */

function apiBase(): string {
  return process.env.NOOBCLAW_API_BASE_URL || 'https://api.noobclaw.com';
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getNoobClawAuthToken } = require('../claudeSettings');
    const token = getNoobClawAuthToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch { /* 取不到 token 就裸调,服务端会 401 → 下面 catch 返空降级 */ }
  return headers;
}

const REQ_TIMEOUT_MS = 20_000;

async function postJson(apiPath: string, body: unknown): Promise<any | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(`${apiBase()}${apiPath}`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface HotspotTopic {
  id: string;
  title: string;
  url: string;
  source: string;
  summary?: string;
  category: string;
  lang?: string;
  /** 传了赛道但该赛道无相关热点、backend 回退全量选的这条 → true(调用方打日志)。 */
  trackMiss?: boolean;
}

/** 选题:从勾选源(hotsearch/web3/tech)最新 pool 条里随机 1 条。无可选 / 失败返回 null。
 *  exclude = 该任务已用过的热点 id,后端选题时排除(都用光才退回整池)→ 一次跑 N 条不重复、
 *  跨次运行也不重复同一热点。
 *  track = 赛道筛选(可选,track-presets id):只从该赛道相关热点里选;该赛道无相关时 backend
 *  回退全量并回 trackMiss=true。 */
export async function pickHotspotTopic(sources: string[], exclude: string[] = [], pool = 20, track = ''): Promise<HotspotTopic | null> {
  const json = await postJson('/api/video/hotspot/pick', { sources, pool, exclude, track: track || undefined });
  const t = json?.topic;
  if (!t || !t.title) return null;
  return {
    id: String(t.id || ''),
    title: String(t.title),
    url: String(t.url || ''),
    source: String(t.source || ''),
    summary: t.summary ? String(t.summary) : undefined,
    category: String(t.category || ''),
    lang: t.lang ? String(t.lang) : undefined,
    trackMiss: json?.trackMiss === true,
  };
}

/** 取材:Serper /news 查该热点的最新报道,返回资料块(喂 scriptWriter 的 material)。失败返空串。 */
export async function fetchHotspotMaterial(title: string, lang = 'zh'): Promise<string> {
  const json = await postJson('/api/video/hotspot/material', { title, lang });
  return typeof json?.material === 'string' ? json.material : '';
}
