/**
 * 子进程执行小工具(模拟器层共用)。
 *
 * 雷电 ldconsole 在中文 Windows 上输出 GBK;adb 输出 UTF-8。这里统一拿 Buffer,由调用方决定解码。
 * 绝不走 shell(参数逐个传,不拼字符串),避免路径里的空格/中文出问题,也杜绝注入。
 */

import { spawn } from 'child_process';

export interface ExecResult {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
}

export function execFileBuf(file: string, args: string[], opts?: { timeoutMs?: number; cwd?: string }): Promise<ExecResult> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    let child;
    try {
      child = spawn(file, args, { cwd: opts?.cwd, windowsHide: true });
    } catch (e: any) {
      resolve({ code: -1, stdout: Buffer.alloc(0), stderr: Buffer.from(String(e?.message || e)), timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* ignore */ }
    }, opts?.timeoutMs ?? 60_000);
    child.stdout?.on('data', (b: Buffer) => out.push(b));
    child.stderr?.on('data', (b: Buffer) => err.push(b));
    child.on('error', (e: Error) => { err.push(Buffer.from(String(e.message))); });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err), timedOut });
    });
  });
}

/** GBK 优先解码(中文 Windows 控制台);环境不支持 gbk 时退回 utf-8。 */
export function decodeConsole(buf: Buffer): string {
  if (process.platform === 'win32') {
    try { return new TextDecoder('gbk').decode(buf); } catch { /* fallthrough */ }
  }
  return buf.toString('utf8');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
