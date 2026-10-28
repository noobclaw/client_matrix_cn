/**
 * 抖音「文件夹定时发布」(folder_post,2026-10-28)—— 文件夹布局、按顺序取下一条、发完归档、时段排期、防重账本。
 *
 * 每个号一个文件夹(第一次用时按「昵称_id后6位」建好,之后名字固定存在 dirs 表里,改昵称不会丢文件):
 *   ~/NoobClaw/抖音定时发布/<账号>/
 *     时段1/ 素材/  文案/  话题/        ← 用户往里丢东西,按文件名顺序用
 *     时段2/ …   时段3/ …
 *     已发布/<日期>/…                    ← 发成功的挪到这
 *     待确认/<日期>/…                    ← 点了发布但没确认到成功的挪到这(防止下一次重复发),请用户去抖音核对
 *
 * 素材:一个视频文件 = 一条视频;一张图片 = 一条单图图文;一个子文件夹(里面放图)= 一条多图图文(最多 35 张)。
 * 文案:一个 .txt = 一条,第一行 = 标题,其余 = 正文。话题:一个 .txt = 一组,按换行 / 空格 / 逗号分开,# 可有可无。
 *
 * 排期:时段时间 HH:MM(本机时区)± 随机浮动(每天每时段固定一个偏移,同一天重算结果一样)。到点后
 *   catchUpMin 分钟内还没发的照发(电脑刚开机 / 当时有别的抖音任务在跑);超过就算错过,不补发。
 * 账本:每个「号 × 时段 × 日期」发之前先登记,发完更新结果 —— 中途崩了重启也不会把同一时段再发一遍。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { FolderPostConfig, FolderPostSlot } from './types';
import { FOLDER_POST_LIMITS } from './types';

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.flv', '.avi', '.mkv', '.mpg', '.mpeg', '.wmv', '.ts']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);
export const SLOT_DIR = (n: number) => `时段${n}`;
export const SUB_MEDIA = '素材', SUB_CAPTION = '文案', SUB_TOPIC = '话题';
const DIR_DONE = '已发布', DIR_UNSURE = '待确认';

export function folderPostRoot(): string {
  return process.env.NOOBCLAW_FOLDER_POST_DIR || path.join(os.homedir(), 'NoobClaw', '抖音定时发布');
}
function matrixDir(): string { return process.env.NOOBCLAW_MATRIX_DIR || path.join(os.homedir(), 'NoobClaw', 'matrix'); }
function readJson<T>(p: string, def: T): T { try { return JSON.parse(fs.readFileSync(p, 'utf8')) as T; } catch { return def; } }
function writeJsonStrict(p: string, v: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true }); const tmp = p + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(v, null, 2), 'utf8'); fs.renameSync(tmp, p);
}
function writeJson(p: string, v: unknown): void { try { writeJsonStrict(p, v); } catch { /* ignore */ } }
const natural = (a: string, b: string) => a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' });
const visible = (name: string) => !name.startsWith('.') && !/^(thumbs\.db|desktop\.ini)$/i.test(name);
const safeName = (s: string) => String(s || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 40) || 'account';

// ── 每个号的文件夹名(第一次定下来后固定) ──
const DIRS_FILE = () => path.join(matrixDir(), 'folderPostDirs.json');
export function accountDir(acc: { id: string; nickname?: string; displayName?: string }): string {
  const map = readJson<Record<string, string>>(DIRS_FILE(), {});
  let name = map[acc.id];
  if (!name) {
    name = `${safeName(acc.nickname || acc.displayName || '')}_${String(acc.id).slice(-6)}`;
    map[acc.id] = name;
    writeJson(DIRS_FILE(), map);
  }
  return path.join(folderPostRoot(), name);
}
export function ensureAccountDirs(acc: { id: string; nickname?: string; displayName?: string }): string {
  const dir = accountDir(acc);
  for (let n = 1; n <= FOLDER_POST_LIMITS.slots; n++) {
    for (const sub of [SUB_MEDIA, SUB_CAPTION, SUB_TOPIC]) {
      try { fs.mkdirSync(path.join(dir, SLOT_DIR(n), sub), { recursive: true }); } catch { /* ignore */ }
    }
  }
  return dir;
}

// ── 列内容 ──
export interface MediaItem { kind: 'video' | 'images'; name: string; path: string; files: string[] }
function list(dir: string): fs.Dirent[] {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => visible(d.name)).sort((a, b) => natural(a.name, b.name)); } catch { return []; }
}
export function listMedia(slotDir: string): MediaItem[] {
  const out: MediaItem[] = [];
  const base = path.join(slotDir, SUB_MEDIA);
  for (const d of list(base)) {
    const p = path.join(base, d.name);
    const ext = path.extname(d.name).toLowerCase();
    if (d.isFile() && VIDEO_EXT.has(ext)) out.push({ kind: 'video', name: d.name, path: p, files: [p] });
    else if (d.isFile() && IMAGE_EXT.has(ext)) out.push({ kind: 'images', name: d.name, path: p, files: [p] });
    else if (d.isDirectory()) {
      const imgs = list(p).filter((x) => x.isFile() && IMAGE_EXT.has(path.extname(x.name).toLowerCase())).map((x) => path.join(p, x.name)).slice(0, FOLDER_POST_LIMITS.maxImages);
      if (imgs.length) out.push({ kind: 'images', name: d.name, path: p, files: imgs });
    }
  }
  return out;
}
function listTxt(dir: string): string[] {
  return list(dir).filter((d) => d.isFile() && path.extname(d.name).toLowerCase() === '.txt').map((d) => path.join(dir, d.name));
}
export function listCaptions(slotDir: string): string[] { return listTxt(path.join(slotDir, SUB_CAPTION)); }
export function listTopics(slotDir: string): string[] { return listTxt(path.join(slotDir, SUB_TOPIC)); }
function readText(p: string): string {
  try { return fs.readFileSync(p, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n'); } catch { return ''; }
}
export function parseCaption(p: string): { title: string; body: string } {
  const lines = readText(p).split('\n');
  const i = lines.findIndex((l) => l.trim());
  if (i < 0) return { title: '', body: '' };
  return { title: lines[i].trim(), body: lines.slice(i + 1).join('\n').trim() };
}
export function parseTopics(p: string): string[] {
  const seen = new Set<string>();
  return readText(p).split(/[\n,，、\s]+/).map((t) => t.replace(/^#+/, '').trim()).filter((t) => t && !seen.has(t) && seen.add(t)).slice(0, 5);
}

export interface SlotStatus { n: number; dir: string; media: number; videos: number; imageSets: number; captions: number; topics: number }
export function slotStatus(accDir: string, n: number): SlotStatus {
  const dir = path.join(accDir, SLOT_DIR(n));
  const media = listMedia(dir);
  return { n, dir, media: media.length, videos: media.filter((m) => m.kind === 'video').length, imageSets: media.filter((m) => m.kind === 'images').length, captions: listCaptions(dir).length, topics: listTopics(dir).length };
}

/** 按顺序取这个时段的下一条(只读,不挪文件)。没有素材 → null。 */
export function pickNext(accDir: string, n: number): { media: MediaItem; captionPath?: string; topicPath?: string; title: string; body: string; tags: string[] } | null {
  const dir = path.join(accDir, SLOT_DIR(n));
  const media = listMedia(dir)[0];
  if (!media) return null;
  const captionPath = listCaptions(dir)[0];
  const topicPath = listTopics(dir)[0];
  const cap = captionPath ? parseCaption(captionPath) : { title: '', body: '' };
  return { media, captionPath, topicPath, title: cap.title, body: cap.body, tags: topicPath ? parseTopics(topicPath) : [] };
}

/** 发完把这一条用到的素材 / 文案 / 话题挪走(成功 → 已发布,没确认 → 待确认)。
 *  返回 { dest, ok }:ok=false 表示素材【没挪走】(还留在原处)—— 调用方必须停发这个号,否则下个时段会重复发。
 *  图片子文件夹超过 35 张时只挪用掉的那几张,剩下的留在原文件夹(下次当一条新图文发)。 */
export function archiveUsed(accDir: string, n: number, used: { media: MediaItem; captionPath?: string; topicPath?: string }, outcome: 'done' | 'unsure', now = new Date()): { dest: string; ok: boolean } {
  const day = localDate(now);
  const hhmm = String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');
  const dest = path.join(accDir, outcome === 'done' ? DIR_DONE : DIR_UNSURE, day, `${SLOT_DIR(n)}_${hhmm}_${safeName(path.parse(used.media.name).name)}`);
  try { fs.mkdirSync(dest, { recursive: true }); } catch { return { dest, ok: false }; }
  const move = (src: string | undefined, to: string): boolean => {
    if (!src || !fs.existsSync(src)) return true;
    try { fs.renameSync(src, to); }
    catch { try { fs.cpSync(src, to, { recursive: true }); fs.rmSync(src, { recursive: true, force: true }); } catch { /* 下面按「源还在不在」判 */ } }
    return !fs.existsSync(src);
  };
  let mediaOk: boolean;
  const m = used.media;
  let isDir = false;
  try { isDir = fs.statSync(m.path).isDirectory(); } catch { /* gone */ }
  // 文件夹里还有【不在这次用过的清单里】的图(>35 张没用完 / 恢复时只剩一部分)→ 只挪用过的那几张,别整夹搬走
  const usedSet = new Set(m.files.map((f) => path.resolve(f)));
  const hasUnused = isDir && m.files.length > 0 && list(m.path).some((x) => x.isFile() && IMAGE_EXT.has(path.extname(x.name).toLowerCase()) && !usedSet.has(path.resolve(path.join(m.path, x.name))));
  if (hasUnused) {
    const sub = path.join(dest, SUB_MEDIA + '_' + path.basename(m.path));
    try { fs.mkdirSync(sub, { recursive: true }); } catch { return { dest, ok: false }; }
    mediaOk = m.files.every((f) => move(f, path.join(sub, path.basename(f))));
  } else {
    mediaOk = move(m.path, path.join(dest, SUB_MEDIA + '_' + path.basename(m.path)));
  }
  // 文案 / 话题挪失败不会导致重复发(下一条素材配下一份文案而已),只影响配对,不算失败。
  if (used.captionPath) move(used.captionPath, path.join(dest, SUB_CAPTION + '_' + path.basename(used.captionPath)));
  if (used.topicPath) move(used.topicPath, path.join(dest, SUB_TOPIC + '_' + path.basename(used.topicPath)));
  return { dest, ok: mediaOk };
}

// ── 排期 ──
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function hash(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
export function normSlots(slots: FolderPostSlot[] | undefined): FolderPostSlot[] {
  const out: FolderPostSlot[] = [];
  for (let i = 0; i < FOLDER_POST_LIMITS.slots; i++) {
    const s = (slots || [])[i];
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s?.time || ''));
    const ok = !!m && Number(m[1]) < 24 && Number(m[2]) < 60;
    out.push({ time: ok ? `${m![1].padStart(2, '0')}:${m![2]}` : ['08:30', '12:30', '19:30'][i], on: !!s?.on && ok });
  }
  return out;
}
export interface Occurrence { key: string; accountId: string; slot: number; date: string; at: number }
/** 某号某天各时段的计划时间(含当天固定的随机偏移)。 */
function occurrencesForDay(taskId: string, accountId: string, slots: FolderPostSlot[], day: Date, jitterMin: number): Occurrence[] {
  const out: Occurrence[] = [];
  const date = localDate(day);
  slots.forEach((s, i) => {
    if (!s.on) return;
    const [h, m] = s.time.split(':').map(Number);
    const d = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
    const j = Math.max(0, Math.min(FOLDER_POST_LIMITS.jitterMaxMin, Math.round(jitterMin || 0)));
    const off = j ? (hash(`${taskId}|${accountId}|${i}|${date}`) % (2 * j + 1)) - j : 0;
    out.push({ key: `${accountId}|${i + 1}|${date}`, accountId, slot: i + 1, date, at: d.getTime() + off * 60_000 });
  });
  return out;
}
function occurrencesAround(taskId: string, accountIds: string[], cfg: FolderPostConfig | undefined, from: number): Occurrence[] {
  const out: Occurrence[] = [];
  const base = new Date(from);
  for (const dd of [-1, 0, 1, 2]) {
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dd);
    for (const id of accountIds) out.push(...occurrencesForDay(taskId, id, normSlots(cfg?.slotsByAccount?.[id]), day, cfg?.jitterMin ?? 0));
  }
  return out.sort((a, b) => a.at - b.at);
}

// ── 账本 ──
export interface LedgerEntry {
  ts: number; ok: boolean | null; note?: string;
  // 发之前就记下这次用的文件:万一中途崩了,下次启动据此把它们挪进「待确认」,不会再发一遍。
  slot?: number; media?: string; mediaName?: string; mediaFiles?: string[]; caption?: string; topic?: string;
  /** 发出去了(或可能发出去了)但素材没能挪走 → 下次先挪,挪不走这个号就不发 */
  stuck?: boolean; stuckTo?: 'done' | 'unsure';
}
const LEDGER_FILE = () => path.join(matrixDir(), 'folderPostLedger.json');
function loadLedger(): Record<string, Record<string, LedgerEntry>> { return readJson(LEDGER_FILE(), {}); }
export function ledgerHas(taskId: string, key: string): boolean { return !!loadLedger()[taskId]?.[key]; }
/** 写账本。strict=true 时写不进去就抛错(发布前那一笔必须写成功,否则不发 —— 防「账本写不进 → 每分钟连发」)。 */
export function ledgerMark(taskId: string, key: string, e: LedgerEntry, strict = false): void {
  const all = loadLedger();
  const t = all[taskId] || (all[taskId] = {});
  t[key] = { ...(t[key] || {}), ...e };
  // 只留最近 10 天(「发布中」和「素材没挪走」的不删,留给恢复)
  const cut = Date.now() - 10 * 86400_000;
  for (const k of Object.keys(t)) if ((t[k]?.ts || 0) < cut && t[k]?.ok !== null && !t[k]?.stuck) delete t[k];
  if (strict) {
    writeJsonStrict(LEDGER_FILE(), all);
    if (!loadLedger()[taskId]?.[key]) throw new Error('ledger_write_failed');
  } else writeJson(LEDGER_FILE(), all);
}
/** 这个号还停在「发布中」(ok=null)的记录 —— 上次点了发布但没等到结果就崩了 / 被关了。 */
export function ledgerPending(taskId: string, accountId: string): Array<{ key: string } & LedgerEntry> {
  const t = loadLedger()[taskId] || {};
  return Object.keys(t).filter((k) => k.startsWith(accountId + '|') && t[k]?.ok === null).map((k) => ({ key: k, ...t[k] }));
}
/** 这个号「发出去了(或可能发出去了)但素材没能挪走」(stuck)的记录 —— 文件还在原处的话绝不能再发,要先挪走。 */
export function ledgerStuck(taskId: string, accountId: string): Array<{ key: string } & LedgerEntry> {
  const t = loadLedger()[taskId] || {};
  return Object.keys(t).filter((k) => k.startsWith(accountId + '|') && t[k]?.stuck).map((k) => ({ key: k, ...t[k] }));
}
export function ledgerRecent(taskId: string, limit = 30): Array<{ key: string } & LedgerEntry> {
  const t = loadLedger()[taskId] || {};
  return Object.keys(t).map((k) => ({ key: k, ...t[k] })).sort((a, b) => b.ts - a.ts).slice(0, limit);
}

const CATCH_UP_MS = FOLDER_POST_LIMITS.catchUpMin * 60_000;
/** 现在该发的(到点、还在补发窗口内、账本里没有)。 */
export function dueOccurrences(taskId: string, accountIds: string[], cfg: FolderPostConfig | undefined, now: number): Occurrence[] {
  const done = loadLedger()[taskId] || {};
  return occurrencesAround(taskId, accountIds, cfg, now).filter((o) => o.at <= now && now - o.at <= CATCH_UP_MS && !done[o.key]);
}
/** 下一次该叫醒任务的时间:有到点没发的 → 现在;否则最近的一个未来时段。没有任何时段 → undefined。 */
export function folderPostNextRunAt(taskId: string, accountIds: string[], cfg: FolderPostConfig | undefined, from: number): number | undefined {
  const done = loadLedger()[taskId] || {};
  let best: number | undefined;
  for (const o of occurrencesAround(taskId, accountIds, cfg, from)) {
    if (done[o.key]) continue;
    if (o.at <= from) { if (from - o.at <= CATCH_UP_MS) return from; continue; }
    best = best === undefined ? o.at : Math.min(best, o.at);
  }
  return best;
}
/** 接下来的计划(详情页展示)。 */
export function upcomingOccurrences(taskId: string, accountIds: string[], cfg: FolderPostConfig | undefined, from: number, limit = 12): Occurrence[] {
  const done = loadLedger()[taskId] || {};
  return occurrencesAround(taskId, accountIds, cfg, from).filter((o) => !done[o.key] && o.at > from - CATCH_UP_MS).slice(0, limit);
}
