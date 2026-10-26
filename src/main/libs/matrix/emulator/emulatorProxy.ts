/**
 * 模拟器代理:本机起一个【无认证 HTTP 代理】(支持 CONNECT),替模拟器跟上游代理(http/https/socks5,可带账密)握手。
 *
 * 为什么不直接把上游填进安卓:安卓系统 http_proxy 只认 host:port 的 HTTP 代理,填不了账密,也不认 socks5。
 * 设备侧用 `adb reverse tcp:18765 tcp:<本机中转端口>`,系统代理设成 127.0.0.1:18765,
 * 不用关心雷电的虚拟网络拓扑(宿主机在模拟器里的 IP 各版本不一样)。
 *
 * 已知限制(第一期,文档 §3 已向用户说明):系统 HTTP 代理只管遵守系统代理设置的 TCP 流量;
 * 不遵守的 App 和 UDP(QUIC)不会走这里。第二期换模拟器内 VPN 型代理 App 解决。
 */

import http from 'http';
import net from 'net';
import tls from 'tls';
import { SocksClient } from 'socks';
import { coworkLog } from '../../coworkLogger';
import type { Proxy } from '../types';
import type { Adb } from './adb';

export const DEVICE_PROXY_PORT = 18765;

const servers = new Map<string, Promise<number>>();
const keyOf = (p: Proxy): string => `${p.protocol}|${p.host}|${p.port}|${p.username || ''}|${p.password || ''}`;

function parseTarget(hostPort: string, defPort: number): { host: string; port: number } {
  const m = hostPort.match(/^\[?([^\]]+?)\]?(?::(\d+))?$/);
  return { host: m ? m[1] : hostPort, port: m && m[2] ? parseInt(m[2], 10) : defPort };
}

/** 经上游代理打通到 host:port 的 TCP 隧道。 */
export async function openTunnel(proxy: Proxy, host: string, port: number, timeoutMs = 15_000): Promise<net.Socket> {
  if (proxy.protocol === 'socks5' || proxy.protocol === 'socks5h') {
    const info = await SocksClient.createConnection({
      proxy: { host: proxy.host, port: proxy.port, type: 5, userId: proxy.username || undefined, password: proxy.password || undefined },
      command: 'connect',
      destination: { host, port },   // 域名直传 = remote DNS,不在本机解析
      timeout: timeoutMs,
    });
    return info.socket as net.Socket;
  }
  // http / https 上游:发 CONNECT。
  const sock: net.Socket = await new Promise((resolve, reject) => {
    const onErr = (e: Error): void => reject(e);
    const s = proxy.protocol === 'https'
      ? tls.connect({ host: proxy.host, port: proxy.port, servername: proxy.host }, () => resolve(s))
      : net.connect(proxy.port, proxy.host, () => resolve(s));
    s.once('error', onErr);
    s.setTimeout(timeoutMs, () => s.destroy(new Error('upstream_timeout')));
  });
  const auth = proxy.username
    ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64')}\r\n`
    : '';
  sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
  await new Promise<void>((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (c: Buffer): void => {
      buf = Buffer.concat([buf, c]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) { if (buf.length > 16_384) { cleanup(); reject(new Error('upstream_bad_response')); } return; }
      cleanup();
      const status = buf.slice(0, buf.indexOf('\r\n')).toString();
      if (!/^HTTP\/1\.[01] 200/.test(status)) { reject(new Error('upstream_connect_' + status.slice(9, 12))); return; }
      const rest = buf.slice(end + 4);
      if (rest.length) sock.unshift(rest);
      resolve();
    };
    const onErr = (e: Error): void => { cleanup(); reject(e); };
    const cleanup = (): void => { sock.off('data', onData); sock.off('error', onErr); };
    sock.on('data', onData);
    sock.once('error', onErr);
  });
  sock.setTimeout(0);
  return sock;
}

function startServer(proxy: Proxy): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // 明文 HTTP:绝对 URI → 经隧道连目标:80,改写成 origin-form 转发。
      let url: URL;
      try { url = new URL(req.url || ''); } catch { res.writeHead(400); res.end(); return; }
      const port = url.port ? parseInt(url.port, 10) : 80;
      openTunnel(proxy, url.hostname, port).then((up) => {
        const headers = Object.entries(req.headers)
          .filter(([k]) => !/^(proxy-|connection$|keep-alive$)/i.test(k))
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\r\n');
        // 一连接一请求(Connection: close),响应原样回写客户端 socket,不跟 http server 的 keep-alive 解析打架。
        up.write(`${req.method} ${url.pathname}${url.search} HTTP/1.1\r\n${headers}\r\nConnection: close\r\n\r\n`);
        req.pipe(up);
        up.pipe(res.socket as net.Socket);
        up.on('error', () => res.socket?.destroy());
        res.socket?.on('error', () => up.destroy());
      }).catch((e) => {
        coworkLog('WARN', 'emuProxy', 'http forward failed', { host: url.hostname, err: String(e?.message || e) });
        if (!res.headersSent) { res.writeHead(502); } res.end();
      });
    });
    server.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
      const { host, port } = parseTarget(req.url || '', 443);
      openTunnel(proxy, host, port).then((up) => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) up.write(head);
        up.pipe(client);
        client.pipe(up);
        up.on('error', () => client.destroy());
        client.on('error', () => up.destroy());
      }).catch((e) => {
        coworkLog('WARN', 'emuProxy', 'connect tunnel failed', { host, err: String(e?.message || e) });
        try { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch { /* ignore */ }
      });
    });
    server.on('clientError', (_e, sock) => { try { sock.destroy(); } catch { /* ignore */ } });
    server.once('error', reject);
    // 不拖住进程退出(sidecar 自己的 HTTP server 维持生命周期;单测里也能正常结束)。
    server.unref();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') resolve(addr.port); else reject(new Error('listen_failed'));
    });
  });
}

/** 确保有一个指向该上游的本机 HTTP 中转,返回本机端口。同一上游复用。 */
export async function ensureHttpBridge(proxy: Proxy): Promise<number> {
  const key = keyOf(proxy);
  const existing = servers.get(key);
  if (existing) { try { return await existing; } catch { servers.delete(key); } }
  const p = startServer(proxy);
  servers.set(key, p);
  try { return await p; } catch (e) { servers.delete(key); throw e; }
}

/**
 * 把帐号的代理套到模拟器上。proxy 为空 = 清掉系统代理(走本机网络)。
 * 返回实际设置的值,便于面板展示。
 */
export async function applyDeviceProxy(adb: Adb, serial: string, proxy?: Proxy): Promise<{ mode: 'none' | 'http_bridge'; hostPort?: number }> {
  if (!proxy || !proxy.host) {
    await adb.shell(serial, ['settings', 'put', 'global', 'http_proxy', ':0']);
    try { await adb.reverseRemove(serial, DEVICE_PROXY_PORT); } catch { /* ignore */ }
    return { mode: 'none' };
  }
  const hostPort = await ensureHttpBridge(proxy);
  if (!(await adb.reverse(serial, DEVICE_PROXY_PORT, hostPort))) throw new Error('adb_reverse_failed');
  await adb.shell(serial, ['settings', 'put', 'global', 'http_proxy', `127.0.0.1:${DEVICE_PROXY_PORT}`]);
  return { mode: 'http_bridge', hostPort };
}
