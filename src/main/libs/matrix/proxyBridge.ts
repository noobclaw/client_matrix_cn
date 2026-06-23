/**
 * 带账密 SOCKS5 上游 → 本地【无认证】SOCKS5 中转。
 *
 * 为什么要它:Chromium `--proxy-server=socks5://` 只支持【无认证】SOCKS5;SOCKS5 的账密在 SOCKS 协议层
 * 握手(不走 HTTP 407)→ 我们给 HTTP 代理用的 Fetch.authRequired 喂不进去 → 带账密 SOCKS5 连不上、网页打不开。
 * 行业标准做法(AdsPower / 比特 / Multilogin 同款):本地起一个无认证 SOCKS5 server,Chromium 连它,它用
 * socks 库替 Chromium 跟上游做账密握手并双向转发。Chromium 发域名(remote DNS)原样透传给上游,不漏 DNS。
 *
 * 仅对 socks5/socks5h + 有账密的代理启用;同一上游(协议+账密+host+port)复用同一个本地 server。
 */

import net from 'net';
import { SocksClient } from 'socks';
import { coworkLog } from '../coworkLogger';
import type { Proxy } from './types';

const bridges = new Map<string, Promise<number>>();
const keyOf = (p: Proxy): string => `${p.protocol}|${p.host}|${p.port}|${p.username}|${p.password}`;

/**
 * 确保有一个本地无认证中转指向该上游;返回本地端口。仅 socks5/socks5h + 带账密时启用,否则返回 null
 * (上层走原路径:无认证 SOCKS5 / HTTP-407 认证 直连)。失败返回 null(回退直连,不致命)。
 */
export async function ensureProxyBridge(proxy?: Proxy): Promise<number | null> {
  if (!proxy || !proxy.username || !proxy.password) return null;
  if (proxy.protocol !== 'socks5' && proxy.protocol !== 'socks5h') return null;
  const key = keyOf(proxy);
  const existing = bridges.get(key);
  if (existing) { try { return await existing; } catch { bridges.delete(key); } }
  const p = startBridge(proxy);
  bridges.set(key, p);
  try { return await p; } catch (e) {
    bridges.delete(key);
    coworkLog('WARN', 'proxyBridge', `bridge start failed: ${String((e as Error)?.message || e)}`);
    return null;
  }
}

/**
 * 探测代理是否【能通】:经该代理连一个全球(含中国大陆)可达的中立目标(apple.com:443)。
 * 成功=能通(角标变绿),失败/超时=不通(角标变黄)。socks5 走 socks 库;http/https 走 CONNECT 隧道。
 */
export async function probeProxy(proxy: Proxy, timeoutMs = 6000): Promise<boolean> {
  const target = { host: 'www.apple.com', port: 443 }; // 国内外都可达的中立目标(避免 google 在墙内误判不通)
  try {
    if (proxy.protocol === 'socks5' || proxy.protocol === 'socks5h') {
      const info = await SocksClient.createConnection({
        proxy: { host: proxy.host, port: proxy.port, type: 5, userId: proxy.username, password: proxy.password },
        command: 'connect', destination: target, timeout: timeoutMs,
      });
      try { (info.socket as net.Socket).destroy(); } catch { /* ignore */ }
      return true;
    }
    return await probeHttpConnect(proxy, target.host, target.port, timeoutMs);
  } catch { return false; }
}

/** 探测该账号代理并把结果写进 proxy.health(无代理跳过返回 null)。供连接/刷新/保活复用。 */
export async function probeAndSaveHealth(account: { id: string; proxy?: Proxy }): Promise<'ok' | 'dead' | null> {
  if (!account.proxy) return null;
  let ok = false;
  try { ok = await probeProxy(account.proxy); } catch { ok = false; }
  try { const { setProxyHealth } = require('./accountManager'); setProxyHealth(account.id, ok ? 'ok' : 'dead'); } catch { /* ignore */ }
  return ok ? 'ok' : 'dead';
}

// HTTP/HTTPS 代理:发 CONNECT 隧道请求,回 200 即能通。
function probeHttpConnect(proxy: Proxy, host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean): void => { if (done) return; done = true; try { sock.destroy(); } catch { /* ignore */ } resolve(ok); };
    const sock = net.connect(proxy.port, proxy.host);
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.on('connect', () => {
      const auth = proxy.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}\r\n`
        : '';
      sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
    });
    sock.once('data', (d: Buffer) => { clearTimeout(timer); finish(/^HTTP\/1\.[01] 200/.test(d.toString('latin1', 0, 16))); });
    sock.on('error', () => { clearTimeout(timer); finish(false); });
  });
}

function startBridge(proxy: Proxy): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => { handleClient(client, proxy); });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        coworkLog('INFO', 'proxyBridge', `SOCKS5 auth bridge 127.0.0.1:${addr.port} → ${proxy.host}:${proxy.port}`);
        resolve(addr.port);
      } else { reject(new Error('no_port')); }
    });
  });
}

// 缓冲读:按需读 N 字节(处理 TCP 分片);flush 摘掉 data 监听并交出残留,之后可直接 pipe。
function makeReader(sock: net.Socket) {
  let buf = Buffer.alloc(0);
  let done = false;
  const waiters: Array<{ n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void }> = [];
  const pump = (): void => {
    while (waiters.length && buf.length >= waiters[0].n) {
      const w = waiters.shift()!;
      w.resolve(buf.subarray(0, w.n));
      buf = buf.subarray(w.n);
    }
  };
  const onData = (d: Buffer): void => { buf = Buffer.concat([buf, d]); pump(); };
  const onEnd = (): void => { done = true; while (waiters.length) waiters.shift()!.reject(new Error('closed')); };
  sock.on('data', onData);
  sock.once('end', onEnd);
  sock.once('close', onEnd);
  return {
    read(n: number): Promise<Buffer> {
      return new Promise((resolve, reject) => {
        if (done) { reject(new Error('closed')); return; }
        waiters.push({ n, resolve, reject });
        pump();
      });
    },
    flush(): Buffer { sock.removeListener('data', onData); const b = buf; buf = Buffer.alloc(0); return b; },
  };
}

function ipv6(a: Buffer): string {
  const parts: string[] = [];
  for (let i = 0; i < 16; i += 2) parts.push((((a[i] << 8) | a[i + 1]) >>> 0).toString(16));
  return parts.join(':');
}

function handleClient(client: net.Socket, proxy: Proxy): void {
  client.on('error', () => client.destroy());
  const reader = makeReader(client);
  (async () => {
    // 1) greeting:VER NMETHODS METHODS… → 回 no-auth(05 00)
    const g = await reader.read(2);
    if (g[0] !== 0x05) throw new Error('not_socks5');
    if (g[1] > 0) await reader.read(g[1]);
    client.write(Buffer.from([0x05, 0x00]));
    // 2) 请求:VER CMD RSV ATYP DST.ADDR DST.PORT(只支持 CONNECT)
    const h = await reader.read(4);
    if (h[0] !== 0x05 || h[1] !== 0x01) throw new Error('only_connect');
    const atyp = h[3];
    let host = '';
    if (atyp === 0x01) { const a = await reader.read(4); host = `${a[0]}.${a[1]}.${a[2]}.${a[3]}`; }
    else if (atyp === 0x03) { const l = (await reader.read(1))[0]; host = (await reader.read(l)).toString('utf8'); }
    else if (atyp === 0x04) { host = ipv6(await reader.read(16)); }
    else throw new Error('bad_atyp');
    const pb = await reader.read(2);
    const port = (pb[0] << 8) | pb[1];
    // 3) 用 socks 库连上游(它做账密握手 + 地址类型);Chromium 发的域名原样透传 → remote DNS 不漏。
    const info = await SocksClient.createConnection({
      proxy: { host: proxy.host, port: proxy.port, type: 5, userId: proxy.username, password: proxy.password },
      command: 'connect',
      destination: { host, port },
      timeout: 30000,
    });
    const up = info.socket as net.Socket;
    // 4) 回 Chromium 成功(BND 用 0,Chromium 不校验)→ 冲掉残留 → 双向 pipe
    client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    const leftover = reader.flush();
    if (leftover.length) up.write(leftover);
    up.on('error', () => { client.destroy(); up.destroy(); });
    client.on('error', () => { up.destroy(); client.destroy(); });
    up.pipe(client);
    client.pipe(up);
  })().catch(() => {
    try { client.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); } catch { /* ignore */ } // general failure
    client.destroy();
  });
}
