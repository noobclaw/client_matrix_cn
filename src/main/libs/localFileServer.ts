/**
 * localFileServer — token-based local file serving for sidecar HTTP.
 *
 * Use case: chrome-extension needs to upload a file (video / large file) into
 * a website's file input. Native messaging IPC can't carry hundreds of MB
 * (single-message limit + JSON serialization). Solution: register the file
 * here, get a one-time token, build URL like:
 *   http://127.0.0.1:18801/api/local-file?token=xxx
 * Extension `fetch()`s that URL, gets a Blob, builds a File, and assigns to
 * input.files via DataTransfer.
 *
 * Registrations auto-expire (default 10 min) so we don't leak references to
 * temp files after the upload completes.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { coworkLog } from './coworkLogger';

interface Registration {
  filePath: string;
  mimeType: string;
  expiresAt: number;
  fileName: string;
}

const registry = new Map<string, Registration>();
const DEFAULT_TTL_MS = 10 * 60 * 1000;

function gc(): void {
  const now = Date.now();
  for (const [token, reg] of registry.entries()) {
    if (reg.expiresAt < now) registry.delete(token);
  }
}

setInterval(gc, 60 * 1000).unref?.();

/**
 * Register a local file for serving via HTTP. Returns a one-time token.
 * Use buildUrl(token, port) to construct the URL the extension will fetch.
 */
export function registerFile(
  filePath: string,
  opts?: { mimeType?: string; ttlMs?: number; fileName?: string }
): string {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('localFileServer: file not found: ' + filePath);
  }
  const token = crypto.randomBytes(24).toString('hex');
  const fileName = opts?.fileName || path.basename(filePath);
  const mimeType = opts?.mimeType || guessMime(fileName);
  const ttl = opts?.ttlMs || DEFAULT_TTL_MS;
  registry.set(token, {
    filePath,
    mimeType,
    fileName,
    expiresAt: Date.now() + ttl,
  });
  coworkLog('INFO', 'localFileServer', 'registered', {
    token: token.slice(0, 8) + '...', fileName, mimeType, ttlSec: Math.round(ttl / 1000),
  });
  return token;
}

export function buildUrl(token: string, port: number): string {
  return `http://127.0.0.1:${port}/api/local-file?token=${encodeURIComponent(token)}`;
}

export function unregister(token: string): void {
  registry.delete(token);
}

/**
 * HTTP handler — call from sidecar-server.ts when matching `/api/local-file`.
 * Streams the file to the response, sets correct headers, then unregisters
 * the token (one-time use) to avoid leaks.
 */
export function handleLocalFileRequest(req: any, res: any, urlSearchParams: URLSearchParams): void {
  const token = urlSearchParams.get('token') || '';
  if (!token) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('token required');
    return;
  }
  const reg = registry.get(token);
  if (!reg) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found or expired');
    return;
  }
  if (reg.expiresAt < Date.now()) {
    registry.delete(token);
    res.writeHead(410, { 'Content-Type': 'text/plain' });
    res.end('expired');
    return;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(reg.filePath);
  } catch (err: any) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('stat failed: ' + err.message);
    return;
  }
  // Stream file. Don't unregister yet — extension may retry on flaky network.
  // The TTL gc will clean up.
  res.writeHead(200, {
    'Content-Type': reg.mimeType,
    'Content-Length': stat.size,
    'Content-Disposition': `inline; filename="${encodeURIComponent(reg.fileName)}"`,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  const stream = fs.createReadStream(reg.filePath);
  stream.on('error', (err) => {
    coworkLog('WARN', 'localFileServer', 'stream error', { err: String(err) });
    try { res.end(); } catch {}
  });
  stream.pipe(res);
}

function guessMime(fileName: string): string {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  const m: Record<string, string> = {
    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
    m4v: 'video/x-m4v', mkv: 'video/x-matroska',
    avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv', flv: 'video/x-flv',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac',
    wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac',
  };
  return m[ext] || 'application/octet-stream';
}
