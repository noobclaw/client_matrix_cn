/**
 * 手机端 UiAutomator JSON-RPC 客户端(协议对齐 openatx/uiautomator2 3.x 的 core.py,MIT)。
 *
 * 流程:push u2.jar → `CLASSPATH=/data/local/tmp/u2.jar app_process / com.wetest.uia2.Main -p 9008`
 *       → adb forward 到本机随机端口 → POST /jsonrpc/0。
 * 与 Python 版的差异:我们用 Node 直接讲协议,不需要用户装 Python。
 *
 * 注意:同一台设备上同时只能有一个 UiAutomation 连接。用户如果同时开着别的自动化工具
 * (AScript / 其它 u2 客户端),启动会报 "already registered",这里转成可读错误。
 */

import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import { ChildProcess } from 'child_process';
import { coworkLog } from '../../coworkLogger';
import { Adb } from './adb';
import { ensureU2Jar } from './u2Jar';
import { sleep } from './exec';

const DEVICE_JAR = '/data/local/tmp/u2.jar';
const DEVICE_PORT = 9008;

export class U2Error extends Error {
  constructor(public code: string, message?: string) { super(message || code); }
}

export interface DeviceInfo {
  displayWidth?: number;
  displayHeight?: number;
  currentPackageName?: string;
  sdkInt?: number;
  productName?: string;
  [k: string]: unknown;
}

export class U2Agent {
  private proc: ChildProcess | null = null;
  private procOutput = '';
  private localPort = 0;

  constructor(readonly adb: Adb, readonly serial: string) {}

  get port(): number { return this.localPort; }

  private request(method: 'GET' | 'POST', pathName: string, body?: unknown, timeoutMs = 20_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = http.request({
        host: '127.0.0.1', port: this.localPort, method, path: pathName,
        // nanohttpd 的 gzip 有资源泄漏(uiautomator2 core.py 同样禁用),必须 identity。
        headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity', ...(data ? { 'Content-Length': data.length } : {}) },
        timeout: timeoutMs,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) reject(new U2Error('http_' + res.statusCode, text.slice(0, 200)));
          else resolve(text);
        });
      });
      req.on('timeout', () => { req.destroy(new U2Error('timeout')); });
      req.on('error', (e) => reject(e instanceof U2Error ? e : new U2Error('conn', String(e.message))));
      if (data) req.write(data);
      req.end();
    });
  }

  private async alive(): Promise<boolean> {
    if (!this.localPort) return false;
    try { return (await this.request('GET', '/ping', undefined, 3000)) === 'pong'; } catch { return false; }
  }

  private async ensureJarOnDevice(): Promise<void> {
    const local = await ensureU2Jar();
    if (!local) throw new U2Error('u2_jar_unavailable', '控制组件下载失败,请检查网络后重试');
    // 设备上已是同一份就不重复 push(md5 比较本地文件)。
    const localMd5 = crypto.createHash('md5').update(fs.readFileSync(local)).digest('hex');
    if ((await this.adb.md5(this.serial, DEVICE_JAR)) === localMd5) return;
    if (!(await this.adb.push(this.serial, local, DEVICE_JAR))) throw new U2Error('push_failed', '控制组件推送到模拟器失败');
  }

  /** 启动(或复用)设备上的 u2 服务,返回后即可 rpc。 */
  async start(): Promise<void> {
    if (!this.localPort) this.localPort = await this.adb.forward(this.serial, DEVICE_PORT);
    if (await this.alive()) return;
    await this.ensureJarOnDevice();
    this.stopProc();
    this.procOutput = '';
    this.proc = this.adb.spawnShell(this.serial, `CLASSPATH=${DEVICE_JAR} app_process / com.wetest.uia2.Main -p ${DEVICE_PORT}`);
    const onData = (b: Buffer): void => { this.procOutput = (this.procOutput + b.toString('utf8')).slice(-4000); };
    this.proc.stdout?.on('data', onData);
    this.proc.stderr?.on('data', onData);
    let exited = false;
    this.proc.on('close', () => { exited = true; });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (/already registered/i.test(this.procOutput)) {
        throw new U2Error('uiautomation_busy', '模拟器里已有其它自动化工具在运行(如 AScript / 其它 uiautomator 客户端),请先关闭');
      }
      if (await this.alive()) return;
      if (exited) break;
      await sleep(500);
    }
    coworkLog('WARN', 'u2Agent', 'u2 server not ready', { serial: this.serial, out: this.procOutput.slice(-800) });
    throw new U2Error('u2_not_ready', '控制组件启动失败');
  }

  private stopProc(): void {
    if (this.proc) { try { this.proc.kill(); } catch { /* ignore */ } this.proc = null; }
  }

  killSync(): void { this.stopProc(); }

  async stop(): Promise<void> {
    this.stopProc();
    if (this.localPort) { try { await this.adb.forwardRemove(this.serial, this.localPort); } catch { /* ignore */ } }
    this.localPort = 0;
  }

  /** JSON-RPC 调用;连接类错误自动重启服务重试一次。 */
  async rpc<T = unknown>(method: string, params: unknown[] = [], timeoutMs = 20_000): Promise<T> {
    const call = async (): Promise<T> => {
      const text = await this.request('POST', '/jsonrpc/0', { jsonrpc: '2.0', id: 1, method, params }, timeoutMs);
      let data: any;
      try { data = JSON.parse(text); } catch { throw new U2Error('rpc_bad_json', text.slice(0, 120)); }
      if (data && data.error) {
        const msg = String(data.error.message || '');
        if (/UiAutomation not connected|DeadObjectException|DeadSystem/i.test(msg)) throw new U2Error('uia_disconnected', msg);
        if (/UiObjectNotFound/i.test(msg)) throw new U2Error('not_found', msg);
        throw new U2Error('rpc_error', msg.slice(0, 200));
      }
      if (!data || !('result' in data)) throw new U2Error('rpc_no_result');
      return data.result as T;
    };
    try {
      return await call();
    } catch (e: any) {
      if (e instanceof U2Error && (e.code === 'conn' || e.code === 'uia_disconnected' || e.code.startsWith('http_'))) {
        await this.start();
        return call();
      }
      throw e;
    }
  }

  // ── 常用指令 ──
  deviceInfo(): Promise<DeviceInfo> { return this.rpc<DeviceInfo>('deviceInfo'); }
  dumpXml(): Promise<string> { return this.rpc<string>('dumpWindowHierarchy', [false], 30_000); }
  /** base64 JPEG;部分系统返回 null,调用方可回落 adb screencap。 */
  screenshotBase64(): Promise<string | null> { return this.rpc<string | null>('takeScreenshot', [1, 80], 30_000); }
  click(x: number, y: number): Promise<boolean> { return this.rpc<boolean>('click', [Math.round(x), Math.round(y)]); }
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs = 400): Promise<boolean> {
    // UiAutomator swipe 的 steps 约 5ms 一步。
    const steps = Math.max(2, Math.round(durationMs / 5));
    return this.rpc<boolean>('swipe', [Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2), steps], durationMs + 10_000);
  }
  async longPress(x: number, y: number, ms = 600): Promise<void> {
    await this.rpc('injectInputEvent', [0, x, y, 0]);
    await sleep(ms);
    await this.rpc('injectInputEvent', [1, x, y, 0]);
  }
  pressKey(key: 'back' | 'home' | 'enter' | 'recent' | 'delete'): Promise<boolean> { return this.rpc<boolean>('pressKey', [key]); }
  /** 输入到当前焦点框:剪贴板 + 粘贴(中文/emoji 都行,不依赖输入法)。 */
  async inputText(text: string): Promise<void> {
    await this.rpc('setClipboard', ['', text]);
    await this.rpc('pasteClipboard');
  }
  clearText(): Promise<void> { return this.rpc('clearInputText'); }
}
