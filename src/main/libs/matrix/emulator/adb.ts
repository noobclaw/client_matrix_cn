/**
 * adb 封装。所有命令都带 -s <serial>,参数逐个传(不经 shell 拼接)。
 * 设备里执行的 shell 命令由我们自己拼,只含固定命令 + 校验过的参数(包名/路径/数字)。
 */

import { spawn, ChildProcess } from 'child_process';
import { execFileBuf, sleep } from './exec';

export interface AdbDevice { serial: string; state: string }

/** 安卓包名 / 设备路径白名单校验(拼进设备 shell 命令前必须过)。 */
export function assertPkg(pkg: string): string {
  if (!/^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$/.test(pkg)) throw new Error('invalid_package:' + pkg);
  return pkg;
}
export function assertDevicePath(p: string): string {
  if (!/^\/[\w\-./]+$/.test(p) || p.includes('..')) throw new Error('invalid_device_path:' + p);
  return p;
}

export class Adb {
  constructor(readonly bin: string) {}

  async raw(args: string[], timeoutMs = 30_000): Promise<{ ok: boolean; out: string; err: string }> {
    const r = await execFileBuf(this.bin, args, { timeoutMs });
    return { ok: r.code === 0 && !r.timedOut, out: r.stdout.toString('utf8'), err: r.stderr.toString('utf8') };
  }

  async startServer(): Promise<void> { await this.raw(['start-server'], 20_000); }

  async devices(): Promise<AdbDevice[]> {
    const r = await this.raw(['devices'], 15_000);
    return r.out.split(/\r?\n/).slice(1)
      .map((l) => l.trim().split(/\s+/))
      .filter((p) => p.length >= 2 && p[0])
      .map((p) => ({ serial: p[0], state: p[1] }));
  }

  async onlineSerials(): Promise<string[]> {
    return (await this.devices()).filter((d) => d.state === 'device').map((d) => d.serial);
  }

  async connect(hostPort: string): Promise<boolean> {
    const r = await this.raw(['connect', hostPort], 15_000);
    return /connected to|already connected/i.test(r.out);
  }

  async shell(serial: string, cmd: string[], timeoutMs = 30_000): Promise<string> {
    const r = await this.raw(['-s', serial, 'shell', ...cmd], timeoutMs);
    return r.out.trim();
  }

  async push(serial: string, local: string, remote: string, timeoutMs = 300_000): Promise<boolean> {
    const r = await this.raw(['-s', serial, 'push', local, assertDevicePath(remote)], timeoutMs);
    return r.ok;
  }

  /** adb forward tcp:0 → 由 adb 分配本机空闲端口并打印出来。 */
  async forward(serial: string, remotePort: number): Promise<number> {
    const r = await this.raw(['-s', serial, 'forward', 'tcp:0', `tcp:${remotePort}`], 15_000);
    const port = parseInt(r.out.trim(), 10);
    if (!Number.isFinite(port) || port <= 0) throw new Error('adb_forward_failed:' + (r.err || r.out).slice(0, 120));
    return port;
  }

  async forwardRemove(serial: string, localPort: number): Promise<void> {
    await this.raw(['-s', serial, 'forward', '--remove', `tcp:${localPort}`], 10_000);
  }

  /** 设备端口 → 本机端口(设备里连 127.0.0.1:devicePort 即连到电脑上的 hostPort)。 */
  async reverse(serial: string, devicePort: number, hostPort: number): Promise<boolean> {
    const r = await this.raw(['-s', serial, 'reverse', `tcp:${devicePort}`, `tcp:${hostPort}`], 15_000);
    return r.ok;
  }

  async reverseRemove(serial: string, devicePort: number): Promise<void> {
    await this.raw(['-s', serial, 'reverse', '--remove', `tcp:${devicePort}`], 10_000);
  }

  async bootCompleted(serial: string): Promise<boolean> {
    return (await this.shell(serial, ['getprop', 'sys.boot_completed'], 10_000)) === '1';
  }

  async waitBoot(serial: string, timeoutMs = 180_000): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if ((await this.onlineSerials()).includes(serial) && await this.bootCompleted(serial)) return true;
      await sleep(3000);
    }
    return false;
  }

  /** 长驻的设备进程(如 u2 server)。调用方负责 kill。 */
  spawnShell(serial: string, cmd: string): ChildProcess {
    return spawn(this.bin, ['-s', serial, 'shell', cmd], { windowsHide: true });
  }

  async md5(serial: string, remote: string): Promise<string> {
    const p = assertDevicePath(remote);
    let out = await this.shell(serial, ['md5sum', p], 15_000);
    if (/not found/i.test(out)) out = await this.shell(serial, ['md5', p], 15_000);
    return (out.split(/\s+/)[0] || '').toLowerCase();
  }
}

/**
 * 雷电实例 index → adb serial。官方文档自己前后不一致(5554+2i / 5555+2i),两种都试;
 * 都没有就尝试 adb connect 127.0.0.1:(5555+2i),最后看启动前后新出现的设备。
 */
export async function resolveLdSerial(adb: Adb, index: number, before: string[] = []): Promise<string | null> {
  const ports = [5554 + index * 2, 5555 + index * 2];
  const has = async (): Promise<string | null> => {
    const online = await adb.onlineSerials();
    for (const p of ports) {
      for (const s of [`emulator-${p}`, `127.0.0.1:${p}`]) if (online.includes(s)) return s;
    }
    return null;
  };
  let s = await has();
  if (s) return s;
  await adb.connect(`127.0.0.1:${5555 + index * 2}`);
  s = await has();
  if (s) return s;
  // 不再用「启动前后新出现的那台」兜底:多开同时冷启动时会把 A 号绑到 B 实例上(在错的号上操作)。
  void before;
  return null;
}
