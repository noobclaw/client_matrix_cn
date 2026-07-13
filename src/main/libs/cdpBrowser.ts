/**
 * CDP Browser — Chrome DevTools Protocol browser automation.
 * Launches and manages a dedicated Chrome instance via CDP WebSocket.
 * Coexists with the existing Chrome Extension mode.
 *
 * Ported from OpenClaw extensions/browser/ (CDP integration pattern).
 * Uses raw WebSocket — no puppeteer dependency.
 */

import { spawn, type ChildProcess } from 'child_process';
import WebSocket from 'ws';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { coworkLog } from './coworkLogger';

// ── Types ──

export interface CDPPage {
  targetId: string;
  url: string;
  title: string;
  sessionId: string;
  ws: WebSocket | null;
}

export interface CDPBrowserSession {
  id: string;
  wsEndpoint: string;
  process: ChildProcess | null;
  pages: Map<string, CDPPage>;
  profileDir: string;
  debugPort: number;
}

// ── State ──

let browserSession: CDPBrowserSession | null = null;
let messageId = 1;
const pendingMessages = new Map<number, { resolve: (data: any) => void; reject: (err: Error) => void }>();

// ── Chrome detection (reuses pattern from browserBridge.ts) ──

function detectChromePath(): string | null {
  const candidates: string[] = [];

  if (process.platform === 'win32') {
    const programFiles = process.env['PROGRAMFILES'] || 'C:\\Program Files';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env['LOCALAPPDATA'] || '';
    candidates.push(
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
    );
  }

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ── Launch Chrome with remote debugging ──

export async function launchCDPBrowser(options?: {
  chromePath?: string;
  profileDir?: string;
  debugPort?: number;
  headless?: boolean;
}): Promise<CDPBrowserSession> {
  if (browserSession) {
    coworkLog('INFO', 'cdpBrowser', 'Reusing existing CDP browser session');
    return browserSession;
  }

  const chromePath = options?.chromePath || detectChromePath();
  if (!chromePath) {
    throw new Error('Chrome/Chromium not found. Please install Chrome or specify the path.');
  }

  const debugPort = options?.debugPort || 9222;
  const profileDir = options?.profileDir || path.join(os.tmpdir(), 'noobclaw-cdp-profile');

  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
  }

  const args = [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];

  if (options?.headless) {
    args.push('--headless=new');
  }

  coworkLog('INFO', 'cdpBrowser', `Launching Chrome: ${chromePath}`, { debugPort, profileDir });

  const proc = spawn(chromePath, args, {
    detached: false,
    stdio: 'ignore',
  });

  proc.on('error', (err) => {
    coworkLog('ERROR', 'cdpBrowser', `Chrome process error: ${err.message}`);
  });

  // Wait for debugging endpoint to be available
  let wsEndpoint = '';
  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(500);
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      const data = await response.json();
      wsEndpoint = data.webSocketDebuggerUrl;
      break;
    } catch {
      // Chrome not ready yet
    }
  }

  if (!wsEndpoint) {
    proc.kill();
    throw new Error(`Chrome failed to start debugging endpoint on port ${debugPort}`);
  }

  browserSession = {
    id: `cdp-${Date.now()}`,
    wsEndpoint,
    process: proc,
    pages: new Map(),
    profileDir,
    debugPort,
  };

  coworkLog('INFO', 'cdpBrowser', `Chrome launched, WebSocket: ${wsEndpoint}`);
  return browserSession;
}

// ── CDP Protocol communication ──

async function connectToTarget(targetId: string): Promise<WebSocket> {
  if (!browserSession) throw new Error('No CDP browser session');

  const wsUrl = `ws://127.0.0.1:${browserSession.debugPort}/devtools/page/${targetId}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.on('open', () => resolve(ws));
    ws.on('error', (err) => reject(err));
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id && pendingMessages.has(msg.id)) {
          const handler = pendingMessages.get(msg.id)!;
          pendingMessages.delete(msg.id);
          if (msg.error) {
            handler.reject(new Error(msg.error.message));
          } else {
            handler.resolve(msg.result);
          }
        }
      } catch { /* ignore parse errors */ }
    });
  });
}

function sendCDPCommand(ws: WebSocket, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = messageId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingMessages.delete(id);
      reject(new Error(`CDP command timeout: ${method}`));
    }, 30000);

    pendingMessages.set(id, {
      resolve: (data) => { clearTimeout(timer); resolve(data); },
      reject: (err) => { clearTimeout(timer); reject(err); },
    });

    ws.send(JSON.stringify({ id, method, params }));
  });
}

// ── High-level CDP operations ──

export async function cdpNavigate(url: string): Promise<string> {
  const page = await getOrCreatePage();
  await sendCDPCommand(page.ws!, 'Page.navigate', { url });
  await sleep(1000); // Wait for navigation
  return `Navigated to ${url}`;
}

export async function cdpScreenshot(): Promise<{ data: string; mimeType: string }> {
  const page = await getOrCreatePage();
  const result = await sendCDPCommand(page.ws!, 'Page.captureScreenshot', {
    format: 'jpeg',
    quality: 75,
  });
  return { data: result.data, mimeType: 'image/jpeg' };
}

export async function cdpClick(x: number, y: number): Promise<string> {
  const page = await getOrCreatePage();
  await sendCDPCommand(page.ws!, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', clickCount: 1,
  });
  await sendCDPCommand(page.ws!, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
  });
  return `Clicked at (${x}, ${y})`;
}

export async function cdpType(text: string): Promise<string> {
  const page = await getOrCreatePage();
  for (const char of text) {
    await sendCDPCommand(page.ws!, 'Input.dispatchKeyEvent', {
      type: 'keyDown', text: char,
    });
    await sendCDPCommand(page.ws!, 'Input.dispatchKeyEvent', {
      type: 'keyUp', text: char,
    });
  }
  return `Typed "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"`;
}

export async function cdpEvaluate(expression: string): Promise<string> {
  const page = await getOrCreatePage();
  const result = await sendCDPCommand(page.ws!, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
  });
  return JSON.stringify(result?.result?.value ?? result);
}

export async function cdpGetPageInfo(): Promise<{ url: string; title: string }> {
  const page = await getOrCreatePage();
  const result = await sendCDPCommand(page.ws!, 'Runtime.evaluate', {
    expression: 'JSON.stringify({ url: window.location.href, title: document.title })',
    returnByValue: true,
  });
  try {
    return JSON.parse(result?.result?.value || '{}');
  } catch {
    return { url: '', title: '' };
  }
}

export async function cdpGetDOM(selector?: string): Promise<string> {
  const page = await getOrCreatePage();
  const expr = selector
    ? `document.querySelector(${JSON.stringify(selector)})?.outerHTML || '(not found)'`
    : `document.body.innerText.slice(0, 10000)`;
  const result = await sendCDPCommand(page.ws!, 'Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
  });
  return result?.result?.value || '';
}

// ── Page management ──

async function getOrCreatePage(): Promise<CDPPage> {
  if (!browserSession) throw new Error('No CDP browser session');

  // List targets
  const response = await fetch(`http://127.0.0.1:${browserSession.debugPort}/json/list`);
  const targets: any[] = await response.json();
  const pageTarget = targets.find(t => t.type === 'page');

  if (!pageTarget) {
    // Create a new tab. Chromium 109+ only accepts PUT for /json/new (GET returns plain text
    // "Using unsafe HTTP verb GET..." which breaks .json()); older builds accept PUT too.
    const newResponse = await fetch(`http://127.0.0.1:${browserSession.debugPort}/json/new`, { method: 'PUT' });
    let newTarget: any;
    const body = await newResponse.text();
    try { newTarget = JSON.parse(body); }
    catch {
      const legacy = await fetch(`http://127.0.0.1:${browserSession.debugPort}/json/new`);
      newTarget = await legacy.json();
    }
    const ws = await connectToTarget(newTarget.id);
    await sendCDPCommand(ws, 'Page.enable');
    const page: CDPPage = {
      targetId: newTarget.id,
      url: newTarget.url || '',
      title: newTarget.title || '',
      sessionId: newTarget.id,
      ws,
    };
    browserSession.pages.set(newTarget.id, page);
    return page;
  }

  // Use existing page
  let page = browserSession.pages.get(pageTarget.id);
  if (!page || !page.ws || page.ws.readyState !== WebSocket.OPEN) {
    const ws = await connectToTarget(pageTarget.id);
    await sendCDPCommand(ws, 'Page.enable');
    page = {
      targetId: pageTarget.id,
      url: pageTarget.url || '',
      title: pageTarget.title || '',
      sessionId: pageTarget.id,
      ws,
    };
    browserSession.pages.set(pageTarget.id, page);
  }
  return page;
}

// ── Shutdown ──

export function closeCDPBrowser(): void {
  if (!browserSession) return;

  for (const page of browserSession.pages.values()) {
    if (page.ws) page.ws.close();
  }

  if (browserSession.process && !browserSession.process.killed) {
    browserSession.process.kill();
  }

  coworkLog('INFO', 'cdpBrowser', 'CDP browser closed');
  browserSession = null;
}

export function isCDPBrowserRunning(): boolean {
  return browserSession !== null && browserSession.process !== null && !browserSession.process.killed;
}

// ── Console & Network Event Tracking ──

const consoleMessages: Array<{ level: string; text: string; timestamp: number }> = [];
const networkRequests: Array<{ url: string; method: string; status: number; timestamp: number }> = [];

/** Enable console + network tracking on a page */
export async function enablePageTracking(page: CDPPage): Promise<void> {
  if (!page.ws) return;
  try {
    await sendCDPCommand(page.ws, 'Runtime.enable');
    await sendCDPCommand(page.ws, 'Network.enable');

    // Listen for console messages
    page.ws.on('message', (data: string) => {
      try {
        const msg = JSON.parse(data);
        if (msg.method === 'Runtime.consoleAPICalled') {
          const args = msg.params?.args?.map((a: any) => a.value ?? a.description ?? '').join(' ') || '';
          consoleMessages.push({ level: msg.params?.type || 'log', text: args, timestamp: Date.now() });
          if (consoleMessages.length > 200) consoleMessages.shift();
        }
        if (msg.method === 'Network.responseReceived') {
          const resp = msg.params?.response;
          if (resp) {
            networkRequests.push({ url: resp.url, method: resp.requestHeaders?.Method || 'GET', status: resp.status, timestamp: Date.now() });
            if (networkRequests.length > 200) networkRequests.shift();
          }
        }
      } catch {}
    });
  } catch (e) {
    coworkLog('WARN', 'cdpBrowser', `Failed to enable page tracking: ${e}`);
  }
}

/** Get recent console messages */
export function getConsoleMessages(limit: number = 50): typeof consoleMessages {
  return consoleMessages.slice(-limit);
}

/** Get recent network requests */
export function getNetworkRequests(limit: number = 50): typeof networkRequests {
  return networkRequests.slice(-limit);
}

// ── Aria Snapshot (Accessibility Tree) ──

/** Get the accessibility tree for the current page — lets AI understand page structure */
export async function getAriaSnapshot(page: CDPPage, maxDepth: number = 10): Promise<string> {
  if (!page.ws) throw new Error('Page not connected');

  const result = await sendCDPCommand(page.ws, 'Accessibility.getFullAXTree', { max_depth: maxDepth });
  if (!result.nodes) return 'No accessibility tree available';

  // Format into readable text
  const lines: string[] = [];
  for (const node of result.nodes.slice(0, 200)) {
    const role = node.role?.value || '';
    const name = node.name?.value || '';
    const value = node.value?.value || '';
    if (!role || role === 'none' || role === 'generic') continue;
    const indent = '  '.repeat(Math.min(node.depth || 0, 5));
    const desc = [name, value].filter(Boolean).join(': ');
    lines.push(`${indent}[${role}] ${desc}`);
  }

  return lines.join('\n') || 'Empty accessibility tree';
}

// ── Helpers ──

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
