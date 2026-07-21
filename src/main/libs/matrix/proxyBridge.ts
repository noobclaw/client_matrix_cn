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
import dns from 'dns';
import http from 'http';
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

/** 连通性探测目标:【任一通即算通】。首选咱们自己的 API 域(全球可达、自己控制,顺带验证
 *  代理能连到我们的服务);再兜 baidu/apple —— 有的代理出口封锁部分目标(如仅供国内平台用
 *  的代理连不到 apple),单目标会把能用的代理误判成不通(2026-07-20 用户实测)。 */
const PROBE_TARGETS = [
  { host: 'api.noobclaw.com', port: 443 },
  { host: 'www.baidu.com', port: 443 },
  { host: 'www.apple.com', port: 443 },
];

/** 连代理服务器本身的失败(区别于「代理通、但连不到目标站」)—— 这类错误后面再试别的
 *  目标/协议全是白等,直接中止。ETIMEDOUT/ECONNREFUSED/EHOSTUNREACH/socks 库的连接超时文案。 */
function isProxyUnreachable(err: string): boolean {
  return /ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|connection timed out|closed before/i.test(err);
}

/** 纯 TCP 探一下代理 host:port 是否可达(不走 socks/http 握手)。坏代理最常见就是端口连不上,
 *  4s 内快速失败,避免后面 6 次满超时握手把总时长累加到 90s(2026-07-21 用户实测卡死根因)。 */
function tcpReachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean): void => { if (done) return; done = true; try { sock.destroy(); } catch { /* ignore */ } resolve(ok); };
    const sock = net.connect(port, host);
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.once('connect', () => { clearTimeout(timer); finish(true); });
    sock.once('error', () => { clearTimeout(timer); finish(false); });
  });
}

/** 经 socks5 连一次目标(域名直传 = remote DNS)。成功即销毁连接。 */
async function socksConnectOnce(proxy: Proxy, host: string, port: number, timeoutMs: number): Promise<void> {
  const info = await SocksClient.createConnection({
    proxy: { host: proxy.host, port: proxy.port, type: 5, userId: proxy.username, password: proxy.password },
    command: 'connect', destination: { host, port }, timeout: timeoutMs,
  });
  try { (info.socket as net.Socket).destroy(); } catch { /* ignore */ }
}

/** 按指定协议探一遍所有目标:通返回 null,不通返回最后一次的错误描述。
 *  socks5 发域名(remote DNS)失败时,本地解析成 IP 再试一次 —— 有些代理远端 DNS 坏/慢,
 *  发域名必挂、发 IP 就通(curl 的 socks5:// 就是本地解析,所以「curl 能通我们不通」)。 */
async function probeVia(protocol: Proxy['protocol'], proxy: Proxy, timeoutMs: number): Promise<string | null> {
  let lastErr = 'timeout';
  for (const target of PROBE_TARGETS) {
    try {
      if (protocol === 'socks5' || protocol === 'socks5h') {
        try {
          await socksConnectOnce(proxy, target.host, target.port, timeoutMs);
          return null;
        } catch (e1) {
          // 连代理本身就失败 → 换目标也没用,直接中止(不再本地解析重试)。
          if (isProxyUnreachable(String((e1 as Error)?.message || e1))) throw e1;
          const ip = await dns.promises.lookup(target.host).then((r) => r.address).catch(() => null);
          if (!ip) throw e1;
          await socksConnectOnce(proxy, ip, target.port, timeoutMs);
          return null;
        }
      }
      if (await probeHttpConnect(proxy, target.host, target.port, timeoutMs)) return null;
      lastErr = 'HTTP CONNECT rejected/no response';
    } catch (e) {
      lastErr = String((e as Error)?.message || e);
      // 代理服务器都连不上 → 后面的目标全是白等,立即返回。
      if (isProxyUnreachable(lastErr)) return lastErr;
    }
  }
  return lastErr;
}

/**
 * 探测代理是否【能通】(角标/保活用的轻量布尔版)。socks5 走 socks 库;http/https 走 CONNECT 隧道。
 */
export async function probeProxy(proxy: Proxy, timeoutMs = 6000): Promise<boolean> {
  try { return (await probeVia(proxy.protocol, proxy, timeoutMs)) === null; } catch { return false; }
}

/** 代理出口 IP 的归属地(经代理查 ip-api.com 得到)。让用户直观看到「这个号在平台眼里来自哪」。 */
export interface ProxyGeo {
  ip?: string;
  country?: string;      // 'Vietnam'
  countryCode?: string;  // 'VN'
  city?: string;         // 'Quỳnh Lôi'
}

export interface ProxyProbeResult {
  ok: boolean;
  /** 不通时的原因(socks 库/CONNECT 的原始错误,给 UI 显示定位)。 */
  error?: string;
  /** 按所选协议不通、但换这个协议能通 → 卖家标错协议(socks5↔http 很常见,AdsPower 等
   *  工具会自动探测所以「别家能用」)。UI 拿到后帮用户切协议。 */
  suggestProtocol?: Proxy['protocol'];
  /** 通了才有:出口 IP 归属地(经代理查)。查询失败不影响 ok(锦上添花)。 */
  geo?: ProxyGeo;
  /** 代理服务器 host 本身的归属地(本机直连查,连不通也有值)。失败时据此判断「这是海外代理→需开 TUN」。 */
  hostGeo?: ProxyGeo;
}

/**
 * 查【任意 IP/域名本身】的归属地。代理连不通时也能拿到「这个代理 IP 在哪个国家」→ 据此提示
 * 「海外代理需开全局 TUN」。**优先走后端中转**(api.noobclaw.com 客户端总连得上,后端在香港
 * 直连 ip-api 稳,不受用户国内网络影响 —— 2026-07-21 用户实测国内 Mac 直连 ip-api 查不到);
 * 后端不可用再退回本机直连 ip-api(海外用户 / 已开 VPN 时可用)。都失败返回 null。
 */
export async function lookupIpGeo(hostOrIp: string, timeoutMs = 5000): Promise<ProxyGeo | null> {
  const h = (hostOrIp || '').trim();
  if (!h) return null;
  // ① 后端中转(首选)
  try {
    const base = process.env.NOOBCLAW_API_BASE_URL || 'https://api.noobclaw.com';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(`${base}/api/matrix/ip-geo?ip=${encodeURIComponent(h)}`, { signal: ctrl.signal });
      const j: any = await r.json();
      if (j && j.ok && j.countryCode) return { ip: j.ip, country: j.country, countryCode: j.countryCode, city: j.city };
    } finally { clearTimeout(timer); }
  } catch { /* 后端不可用 → 退回本机直连 */ }
  // ② 本机直连 ip-api 兜底
  return await new Promise<ProxyGeo | null>((resolve) => {
    let buf = '';
    const req = http.get(
      { host: 'ip-api.com', path: `/json/${encodeURIComponent(h)}`, timeout: timeoutMs },
      (res) => {
        res.on('data', (d) => { buf += d.toString('utf8'); });
        res.on('end', () => {
          try {
            const j = JSON.parse(buf);
            resolve(!j || j.status === 'fail' ? null : { ip: j.query, country: j.country, countryCode: j.countryCode, city: j.city });
          } catch { resolve(null); }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { try { req.destroy(); } catch { /* ignore */ } resolve(null); });
  });
}

/** 从 HTTP 响应文本里解析 ip-api.com 的 JSON,取出归属地字段。解析失败返回 null。 */
function parseGeoResponse(raw: string): ProxyGeo | null {
  try {
    const body = raw.split('\r\n\r\n')[1] || '';
    const j = JSON.parse(body);
    if (!j || j.status === 'fail') return null;
    return { ip: j.query, country: j.country, countryCode: j.countryCode, city: j.city };
  } catch { return null; }
}

/**
 * 经代理查出口 IP 归属地(ip-api.com,免 key、http 80 端口)。socks5 走 socks 库拿裸 socket 发
 * HTTP;http/https 代理发绝对 URL 的 GET 让代理转发。必须【经代理本身】发出,否则查到的是本机 IP。
 * 失败/超时返回 null —— 归属地是展示增强,绝不阻塞校验主流程。
 */
export async function fetchProxyExitGeo(proxy: Proxy, timeoutMs = 7000): Promise<ProxyGeo | null> {
  try {
    if (proxy.protocol === 'socks5' || proxy.protocol === 'socks5h') {
      const info = await SocksClient.createConnection({
        proxy: { host: proxy.host, port: proxy.port, type: 5, userId: proxy.username, password: proxy.password },
        command: 'connect', destination: { host: 'ip-api.com', port: 80 }, timeout: timeoutMs,
      });
      const sock = info.socket as net.Socket;
      return await new Promise<ProxyGeo | null>((resolve) => {
        let buf = '';
        const timer = setTimeout(() => { try { sock.destroy(); } catch { /* ignore */ } resolve(null); }, timeoutMs);
        sock.on('data', (d: Buffer) => { buf += d.toString('utf8'); });
        sock.on('end', () => { clearTimeout(timer); resolve(parseGeoResponse(buf)); });
        sock.on('error', () => { clearTimeout(timer); resolve(null); });
        sock.write('GET /json HTTP/1.1\r\nHost: ip-api.com\r\nConnection: close\r\n\r\n');
      });
    }
    // http/https 代理:直接对代理发绝对 URL 的 GET,代理负责转发。
    return await new Promise<ProxyGeo | null>((resolve) => {
      let buf = '';
      const sock = net.connect(proxy.port, proxy.host);
      const timer = setTimeout(() => { try { sock.destroy(); } catch { /* ignore */ } resolve(null); }, timeoutMs);
      sock.on('connect', () => {
        const auth = proxy.username
          ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}\r\n`
          : '';
        sock.write(`GET http://ip-api.com/json HTTP/1.1\r\nHost: ip-api.com\r\n${auth}Connection: close\r\n\r\n`);
      });
      sock.on('data', (d: Buffer) => { buf += d.toString('utf8'); });
      sock.on('end', () => { clearTimeout(timer); resolve(parseGeoResponse(buf)); });
      sock.on('error', () => { clearTimeout(timer); resolve(null); });
    });
  } catch { return null; }
}

/** 绑定代理时的详细校验:所选协议不通时自动换协议再试,能通就给出正确协议建议。
 *  单次握手超时 7s(跨境慢代理够用);整体 12s 硬上限,任何情况都保证返回,绝不让 UI 卡死
 *  (2026-07-21 用户实测:一条端口连不上的代理原来串行探测要 90s,UI 一直转「校验中」)。 */
export async function probeProxyDetailed(proxy: Proxy, timeoutMs = 7_000): Promise<ProxyProbeResult> {
  // 代理 host 归属地【提到 race 外面独立查】:即使连通性探测撞 12s 超时(deadline 赢),
  //   也能补上归属地 → 关了 TUN、代理连不上时仍能识别「这是海外代理」(2026-07-21 用户实测:
  //   原来 hostGeo 塞在 work 里,超时路径丢了它,退回通用提示)。
  const hostGeoP = lookupIpGeo(proxy.host).catch(() => null);
  const deadline = new Promise<ProxyProbeResult>((resolve) =>
    setTimeout(() => resolve({ ok: false, error: '校验超时(代理响应过慢或不通)' }), 12_000));
  const work = (async (): Promise<ProxyProbeResult> => {
    // 先纯 TCP 探代理端口本身:连不上直接失败,不进 6 次满超时握手(坏代理最常见的死法)。
    if (!(await tcpReachable(proxy.host, proxy.port, 5_000))) {
      return { ok: false, error: '代理地址无法连接(host/端口不通,或该 IP 未对本机授权)' };
    }
    const err = await probeVia(proxy.protocol, proxy, timeoutMs);
    if (!err) {
      const geo = await fetchProxyExitGeo(proxy).catch(() => null);
      return { ok: true, geo: geo || undefined };
    }
    // 连代理本身失败(端口通但握手超时/被拒)→ 换协议也没意义,直接报错。
    if (isProxyUnreachable(err)) return { ok: false, error: err };
    const alt: Proxy['protocol'] = (proxy.protocol === 'socks5' || proxy.protocol === 'socks5h') ? 'http' : 'socks5';
    const altErr = await probeVia(alt, proxy, timeoutMs);
    if (!altErr) return { ok: false, error: err, suggestProtocol: alt };
    return { ok: false, error: err };
  })();
  const result = await Promise.race([work, deadline]);
  // 无论 work 正常返回还是 deadline 超时,都补上 host 归属地(hostGeoP 最坏 ~10s，早于 12s 超时完成)。
  if (!result.geo && !result.hostGeo) {
    const hg = await hostGeoP;
    if (hg) result.hostGeo = hg;
  }
  return result;
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
    //    上游远端 DNS 坏(发域名必挂)时,本地解析成 IP 重试一次兜底(与 probeVia 同款;
    //    代价是该代理场景下 DNS 走本地,兼容性优先)。
    let info;
    try {
      info = await SocksClient.createConnection({
        proxy: { host: proxy.host, port: proxy.port, type: 5, userId: proxy.username, password: proxy.password },
        command: 'connect',
        destination: { host, port },
        timeout: 30000,
      });
    } catch (e1) {
      const isDomain = !net.isIP(host);
      const ip = isDomain ? await dns.promises.lookup(host).then((r) => r.address).catch(() => null) : null;
      if (!ip) throw e1;
      info = await SocksClient.createConnection({
        proxy: { host: proxy.host, port: proxy.port, type: 5, userId: proxy.username, password: proxy.password },
        command: 'connect',
        destination: { host: ip, port },
        timeout: 30000,
      });
    }
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
