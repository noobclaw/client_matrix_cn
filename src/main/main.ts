import { app, BrowserWindow, ipcMain, session, nativeTheme, dialog, shell, nativeImage, systemPreferences, Menu } from 'electron';
import type { WebContents } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { SqliteStore } from './sqliteStore';
import { CoworkStore } from './coworkStore';
import { CoworkRunner } from './libs/coworkRunner';
import { SkillManager } from './skillManager';
import type { PermissionResult } from './libs/toolSystem';
import { getCurrentApiConfig, resolveCurrentApiConfig, setStoreGetter, setNoobClawAuthToken } from './libs/claudeSettings';
import { setStoreGetter as setNewsUsageStoreGetter } from './libs/scenario/newsUsageStore';
import { setStoreGetter as setEngageHistoryStoreGetter } from './libs/scenario/engageHistoryStore';
import { saveCoworkApiConfig } from './libs/coworkConfigStore';
import { generateSessionTitle, probeCoworkModelReadiness } from './libs/coworkUtil';
import { classifyIntent } from './libs/intentClassifier';
import { ensureSandboxReady, getSandboxStatus, onSandboxProgress } from './libs/coworkSandboxRuntime';
import { startCoworkOpenAICompatProxy, stopCoworkOpenAICompatProxy, setScheduledTaskDeps } from './libs/coworkOpenAICompatProxy';
import { stopBrowserBridge, getBrowserBridgeStatus } from './libs/browserBridge';
import { IMGatewayManager, IMPlatform, IMGatewayConfig } from './im';
import { APP_NAME } from './appConstants';
import { getSkillServiceManager } from './skillServices';
import { createTray, destroyTray, updateTrayMenu } from './trayManager';
import { isAutoLaunched, getAutoLaunchEnabled, setAutoLaunchEnabled } from './autoLaunchManager';
import { McpStore } from './mcpStore';
import { ScheduledTaskStore } from './scheduledTaskStore';
import { Scheduler } from './libs/scheduler';
import { downloadUpdate, installUpdate, cancelActiveDownload } from './libs/appUpdateInstaller';
import { initLogger, getLogFilePath } from './logger';
import { getCoworkLogPath } from './libs/coworkLogger';
import { exportLogsZip } from './libs/logExport';
import { ensurePythonRuntimeReady } from './libs/pythonRuntime';
import { extractBundledZips } from './libs/extractBundledZips';
import {
  applySystemProxyEnv,
  resolveSystemProxyUrl,
  restoreOriginalProxyEnv,
  setSystemProxyEnabled,
} from './libs/systemProxy';

// Set the application name
app.name = APP_NAME;
app.setName(APP_NAME);

const INVALID_FILE_NAME_PATTERN = /[<>:"/\\|?*\u0000-\u001F]/g;
const MIN_MEMORY_USER_MEMORIES_MAX_ITEMS = 1;
const MAX_MEMORY_USER_MEMORIES_MAX_ITEMS = 60;
const IPC_MESSAGE_CONTENT_MAX_CHARS = 120_000;
const IPC_UPDATE_CONTENT_MAX_CHARS = 120_000;
const IPC_STRING_MAX_CHARS = 4_000;
const IPC_MAX_DEPTH = 5;
const IPC_MAX_KEYS = 80;
const IPC_MAX_ITEMS = 40;
const MAX_INLINE_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MIME_EXTENSION_MAP: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'application/json': '.json',
  'text/csv': '.csv',
};

const sanitizeExportFileName = (value: string): string => {
  const sanitized = value.replace(INVALID_FILE_NAME_PATTERN, ' ').replace(/\s+/g, ' ').trim();
  return sanitized || 'cowork-session';
};

const sanitizeAttachmentFileName = (value?: string): string => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return 'attachment';
  const fileName = path.basename(raw);
  const sanitized = fileName.replace(INVALID_FILE_NAME_PATTERN, ' ').replace(/\s+/g, ' ').trim();
  return sanitized || 'attachment';
};

const inferAttachmentExtension = (fileName: string, mimeType?: string): string => {
  const fromName = path.extname(fileName).toLowerCase();
  if (fromName) {
    return fromName;
  }
  if (typeof mimeType === 'string') {
    const normalized = mimeType.toLowerCase().split(';')[0].trim();
    return MIME_EXTENSION_MAP[normalized] ?? '';
  }
  return '';
};

const resolveInlineAttachmentDir = (cwd?: string): string => {
  const trimmed = typeof cwd === 'string' ? cwd.trim() : '';
  if (trimmed) {
    const resolved = path.resolve(trimmed);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return path.join(resolved, '.cowork-temp', 'attachments', 'manual');
    }
  }
  return path.join(app.getPath('temp'), 'noobclaw', 'attachments');
};

const ensurePngFileName = (value: string): string => {
  return value.toLowerCase().endsWith('.png') ? value : `${value}.png`;
};

const ensureZipFileName = (value: string): string => {
  return value.toLowerCase().endsWith('.zip') ? value : `${value}.zip`;
};

const padTwoDigits = (value: number): string => value.toString().padStart(2, '0');

const buildLogExportFileName = (): string => {
  const now = new Date();
  const datePart = `${now.getFullYear()}${padTwoDigits(now.getMonth() + 1)}${padTwoDigits(now.getDate())}`;
  const timePart = `${padTwoDigits(now.getHours())}${padTwoDigits(now.getMinutes())}${padTwoDigits(now.getSeconds())}`;
  return `noobclaw-logs-${datePart}-${timePart}.zip`;
};

const truncateIpcString = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated in main IPC forwarding]`;
};

const sanitizeIpcPayload = (value: unknown, depth = 0, seen?: WeakSet<object>): unknown => {
  const localSeen = seen ?? new WeakSet<object>();
  if (
    value === null
    || typeof value === 'number'
    || typeof value === 'boolean'
    || typeof value === 'undefined'
  ) {
    return value;
  }
  if (typeof value === 'string') {
    return truncateIpcString(value, IPC_STRING_MAX_CHARS);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'function') {
    return '[function]';
  }
  if (depth >= IPC_MAX_DEPTH) {
    return '[truncated-depth]';
  }
  if (Array.isArray(value)) {
    const result = value.slice(0, IPC_MAX_ITEMS).map((entry) => sanitizeIpcPayload(entry, depth + 1, localSeen));
    if (value.length > IPC_MAX_ITEMS) {
      result.push(`[truncated-items:${value.length - IPC_MAX_ITEMS}]`);
    }
    return result;
  }
  if (typeof value === 'object') {
    if (localSeen.has(value as object)) {
      return '[circular]';
    }
    localSeen.add(value as object);
    const entries = Object.entries(value as Record<string, unknown>);
    const result: Record<string, unknown> = {};
    for (const [key, entry] of entries.slice(0, IPC_MAX_KEYS)) {
      result[key] = sanitizeIpcPayload(entry, depth + 1, localSeen);
    }
    if (entries.length > IPC_MAX_KEYS) {
      result.__truncated_keys__ = entries.length - IPC_MAX_KEYS;
    }
    return result;
  }
  return String(value);
};

const sanitizeCoworkMessageForIpc = (message: any): any => {
  if (!message || typeof message !== 'object') {
    return message;
  }

  // Preserve imageAttachments in metadata as-is (base64 data can be very large
  // and must not be truncated by the generic sanitizer).
  let sanitizedMetadata: unknown;
  if (message.metadata && typeof message.metadata === 'object') {
    const { imageAttachments, ...rest } = message.metadata as Record<string, unknown>;
    const sanitizedRest = sanitizeIpcPayload(rest) as Record<string, unknown> | undefined;
    sanitizedMetadata = {
      ...(sanitizedRest && typeof sanitizedRest === 'object' ? sanitizedRest : {}),
      ...(Array.isArray(imageAttachments) && imageAttachments.length > 0
        ? { imageAttachments }
        : {}),
    };
  } else {
    sanitizedMetadata = undefined;
  }

  return {
    ...message,
    content: typeof message.content === 'string'
      ? truncateIpcString(message.content, IPC_MESSAGE_CONTENT_MAX_CHARS)
      : '',
    metadata: sanitizedMetadata,
  };
};

const sanitizePermissionRequestForIpc = (request: any): any => {
  if (!request || typeof request !== 'object') {
    return request;
  }
  return {
    ...request,
    toolInput: sanitizeIpcPayload(request.toolInput ?? {}),
  };
};

type CaptureRect = { x: number; y: number; width: number; height: number };

const normalizeCaptureRect = (rect?: Partial<CaptureRect> | null): CaptureRect | null => {
  if (!rect) return null;
  const normalized = {
    x: Math.max(0, Math.round(typeof rect.x === 'number' ? rect.x : 0)),
    y: Math.max(0, Math.round(typeof rect.y === 'number' ? rect.y : 0)),
    width: Math.max(0, Math.round(typeof rect.width === 'number' ? rect.width : 0)),
    height: Math.max(0, Math.round(typeof rect.height === 'number' ? rect.height : 0)),
  };
  return normalized.width > 0 && normalized.height > 0 ? normalized : null;
};

const resolveTaskWorkingDirectory = (workspaceRoot: string): string => {
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  fs.mkdirSync(resolvedWorkspaceRoot, { recursive: true });
  if (!fs.statSync(resolvedWorkspaceRoot).isDirectory()) {
    throw new Error(`Selected workspace is not a directory: ${resolvedWorkspaceRoot}`);
  }
  return resolvedWorkspaceRoot;
};

const resolveExistingTaskWorkingDirectory = (workspaceRoot: string): string => {
  const trimmed = workspaceRoot.trim();
  if (!trimmed) {
    throw new Error('Please select a task folder before submitting.');
  }
  const resolvedWorkspaceRoot = path.resolve(trimmed);
  if (!fs.existsSync(resolvedWorkspaceRoot) || !fs.statSync(resolvedWorkspaceRoot).isDirectory()) {
    throw new Error(`Task folder does not exist or is not a directory: ${resolvedWorkspaceRoot}`);
  }
  return resolvedWorkspaceRoot;
};

const getDefaultExportImageName = (defaultFileName?: string): string => {
  const normalized = typeof defaultFileName === 'string' && defaultFileName.trim()
    ? defaultFileName.trim()
    : `cowork-session-${Date.now()}`;
  return ensurePngFileName(sanitizeExportFileName(normalized));
};

const savePngWithDialog = async (
  webContents: WebContents,
  pngData: Buffer,
  defaultFileName?: string,
): Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }> => {
  const defaultName = getDefaultExportImageName(defaultFileName);
  const ownerWindow = BrowserWindow.fromWebContents(webContents);
  const saveOptions = {
    title: 'Export Session Image',
    defaultPath: path.join(app.getPath('downloads'), defaultName),
    filters: [{ name: 'PNG Image', extensions: ['png'] }],
  };
  const saveResult = ownerWindow
    ? await dialog.showSaveDialog(ownerWindow, saveOptions)
    : await dialog.showSaveDialog(saveOptions);

  if (saveResult.canceled || !saveResult.filePath) {
    return { success: true, canceled: true };
  }

  const outputPath = ensurePngFileName(saveResult.filePath);
  await fs.promises.writeFile(outputPath, pngData);
  return { success: true, canceled: false, path: outputPath };
};

const configureUserDataPath = (): void => {
  const appDataPath = app.getPath('appData');
  const preferredUserDataPath = path.join(appDataPath, APP_NAME);
  const currentUserDataPath = app.getPath('userData');

  if (currentUserDataPath !== preferredUserDataPath) {
    app.setPath('userData', preferredUserDataPath);
    console.log(`[Main] userData path updated: ${currentUserDataPath} -> ${preferredUserDataPath}`);
  }
};

configureUserDataPath();
initLogger();

const isDev = process.env.NODE_ENV === 'development';
const isLinux = process.platform === 'linux';
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';
const DEV_SERVER_URL = process.env.ELECTRON_START_URL || 'http://localhost:5175';
const enableVerboseLogging =
  process.env.ELECTRON_ENABLE_LOGGING === '1' ||
  process.env.ELECTRON_ENABLE_LOGGING === 'true';
const disableGpu =
  process.env.NOOBCLAW_DISABLE_GPU === '1' ||
  process.env.NOOBCLAW_DISABLE_GPU === 'true' ||
  process.env.ELECTRON_DISABLE_GPU === '1' ||
  process.env.ELECTRON_DISABLE_GPU === 'true';
const reloadOnChildProcessGone =
  process.env.ELECTRON_RELOAD_ON_CHILD_PROCESS_GONE === '1' ||
  process.env.ELECTRON_RELOAD_ON_CHILD_PROCESS_GONE === 'true';
const TITLEBAR_HEIGHT = 48;
const TITLEBAR_COLORS = {
  dark: { color: '#0F1117', symbolColor: '#E4E5E9' },
  // Align light title bar with app light surface-muted tone to reduce visual contrast.
  light: { color: '#F3F4F6', symbolColor: '#1A1D23' },
} as const;

const safeDecodeURIComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const normalizeWindowsShellPath = (inputPath: string): string => {
  if (!isWindows) return inputPath;

  const trimmed = inputPath.trim();
  if (!trimmed) return inputPath;

  let normalized = trimmed;
  if (/^file:\/\//i.test(normalized)) {
    normalized = safeDecodeURIComponent(normalized.replace(/^file:\/\//i, ''));
  }

  if (/^\/[A-Za-z]:/.test(normalized)) {
    normalized = normalized.slice(1);
  }

  const unixDriveMatch = normalized.match(/^[/\\]([A-Za-z])[/\\](.+)$/);
  if (unixDriveMatch) {
    const drive = unixDriveMatch[1].toUpperCase();
    const rest = unixDriveMatch[2].replace(/[/\\]+/g, '\\');
    return `${drive}:\\${rest}`;
  }

  if (/^[A-Za-z]:[/\\]/.test(normalized)) {
    const drive = normalized[0].toUpperCase();
    const rest = normalized.slice(1).replace(/\//g, '\\');
    return `${drive}${rest}`;
  }

  return normalized;
};

// ==================== macOS Permissions ====================

/**
 * Check calendar permission on macOS by attempting to access Calendar app
 * Returns: 'authorized' | 'denied' | 'restricted' | 'not-determined'
 * On Windows, checks if Outlook is available
 * On Linux, returns 'not-supported'
 */
const checkCalendarPermission = async (): Promise<string> => {
  if (process.platform === 'darwin') {
    try {
      // Try to access Calendar to check permission
      const { exec } = require('child_process');
      const util = require('util');
      const execAsync = util.promisify(exec);

      // Quick test to see if we can access Calendar
      await execAsync('osascript -l JavaScript -e \'Application("Calendar").name()\'', { timeout: 5000 });
      console.log('[Permissions] macOS Calendar access: authorized');
      return 'authorized';
    } catch (error: any) {
      // Check if it's a permission error
      if (error.stderr?.includes('不能获取对象') ||
          error.stderr?.includes('not authorized') ||
          error.stderr?.includes('Permission denied')) {
        console.log('[Permissions] macOS Calendar access: not-determined (needs permission)');
        return 'not-determined';
      }
      console.warn('[Permissions] Failed to check macOS calendar permission:', error);
      return 'not-determined';
    }
  }

  if (process.platform === 'win32') {
    // Windows doesn't have a system-level calendar permission like macOS
    // Instead, we check if Outlook is available
    try {
      const { exec } = require('child_process');
      const util = require('util');
      const execAsync = util.promisify(exec);

      // Check if Outlook COM object is accessible
      const checkScript = `
        try {
          $Outlook = New-Object -ComObject Outlook.Application
          $Outlook.Version
        } catch { exit 1 }
      `;
      await execAsync('powershell -Command "' + checkScript + '"', { timeout: 10000 });
      console.log('[Permissions] Windows Outlook is available');
      return 'authorized';
    } catch (error) {
      console.log('[Permissions] Windows Outlook not available or not accessible');
      return 'not-determined';
    }
  }

  return 'not-supported';
};

/**
 * Request calendar permission on macOS
 * On Windows, attempts to initialize Outlook COM object
 */
const requestCalendarPermission = async (): Promise<boolean> => {
  if (process.platform === 'darwin') {
    try {
      // On macOS, we trigger permission by trying to access Calendar
      // The system will show permission dialog if needed
      const { exec } = require('child_process');
      const util = require('util');
      const execAsync = util.promisify(exec);

      await execAsync('osascript -l JavaScript -e \'Application("Calendar").calendars()[0].name()\'', { timeout: 10000 });
      return true;
    } catch (error) {
      console.warn('[Permissions] Failed to request macOS calendar permission:', error);
      return false;
    }
  }

  if (process.platform === 'win32') {
    // Windows doesn't have a permission dialog for COM objects
    // We just check if Outlook is available
    const status = await checkCalendarPermission();
    return status === 'authorized';
  }

  return false;
};



// Configure the application
if (isLinux) {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-dev-shm-usage');
}
if (disableGpu) {
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  // Disable hardware acceleration
  app.disableHardwareAcceleration();
}
if (enableVerboseLogging) {
  app.commandLine.appendSwitch('enable-logging');
  app.commandLine.appendSwitch('v', '1');
}

// Configure network services
app.on('ready', () => {
  // Configure network service restart strategy
  app.configureHostResolver({
    enableBuiltInResolver: true,
    secureDnsMode: 'off'
  });
});

// Add error handling
app.on('render-process-gone', (_event, webContents, details) => {
  console.error('Render process gone:', details);
  const shouldReload =
    details.reason === 'crashed' ||
    details.reason === 'killed' ||
    details.reason === 'oom' ||
    details.reason === 'launch-failed' ||
    details.reason === 'integrity-failure';
  if (shouldReload) {
    scheduleReload(`render-process-gone (${details.reason})`, webContents);
  }
});

app.on('child-process-gone', (_event, details) => {
  console.error('Child process gone:', details);
  if (reloadOnChildProcessGone && (details.type === 'GPU' || details.type === 'Utility')) {
    scheduleReload(`child-process-gone (${details.type}/${details.reason})`);
  }
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error);
});

process.on('exit', (code) => {
  console.log(`[Main] Process exiting with code: ${code}`);
});

let store: SqliteStore | null = null;
let coworkStore: CoworkStore | null = null;
let coworkRunner: CoworkRunner | null = null;
let skillManager: SkillManager | null = null;
let mcpStore: McpStore | null = null;
let imGatewayManager: IMGatewayManager | null = null;
let scheduledTaskStore: ScheduledTaskStore | null = null;
let scheduler: Scheduler | null = null;
let storeInitPromise: Promise<SqliteStore> | null = null;

const initStore = async (): Promise<SqliteStore> => {
  if (!storeInitPromise) {
    if (!app.isReady()) {
      throw new Error('Store accessed before app is ready.');
    }
    storeInitPromise = Promise.race([
      SqliteStore.create(app.getPath('userData')),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Store initialization timed out after 15s')), 15_000)
      ),
    ]);
  }
  return storeInitPromise;
};

const getStore = (): SqliteStore => {
  if (!store) {
    throw new Error('Store not initialized. Call initStore() first.');
  }
  return store;
};

const getCoworkStore = () => {
  if (!coworkStore) {
    const sqliteStore = getStore();
    coworkStore = new CoworkStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
    const cleaned = coworkStore.autoDeleteNonPersonalMemories();
    if (cleaned > 0) {
      console.info(`[cowork-memory] Auto-deleted ${cleaned} non-personal/procedural memories`);
    }
  }
  return coworkStore;
};

const getCoworkRunner = () => {
  if (!coworkRunner) {
    coworkRunner = new CoworkRunner(getCoworkStore());

    // Provide AI assistant name from user config
    coworkRunner.setAiAssistantNameProvider(() => {
      try {
        const config = getStore().get<any>('app_config');
        return config?.aiAssistantName || 'Adia Laura';
      } catch {
        return 'Adia Laura';
      }
    });

    // Provide MCP server configuration to the runner. Each entry carries
    // its oauth config (if any) and an onOAuthRefreshed callback so the
    // mcpClient can persist refreshed access tokens back into McpStore
    // without coworkRunner needing to know about persistence.
    coworkRunner.setMcpServerProvider(() => {
      const servers = getMcpStore().getEnabledServers();
      return servers.map((s) => ({
        name: s.name,
        transportType: s.transportType,
        command: s.command,
        args: s.args,
        env: s.env,
        url: s.url,
        headers: s.headers,
        oauth: s.oauth,
        onOAuthRefreshed: (updated: any) => {
          try {
            getMcpStore().setOAuth(s.id, updated);
          } catch (e) {
            console.warn('[mcp] failed to persist refreshed oauth token:', e);
          }
        },
      }));
    });

    // Set up event listeners to forward to renderer
    coworkRunner.on('message', (sessionId: string, message: any) => {
      // Debug: log user messages with metadata to trace imageAttachments
      if (message?.type === 'user') {
        const meta = message.metadata;
        console.log('[main] coworkRunner message event (user)', {
          sessionId,
          messageId: message.id,
          hasMetadata: !!meta,
          metadataKeys: meta ? Object.keys(meta) : [],
          hasImageAttachments: !!(meta?.imageAttachments),
          imageAttachmentsCount: Array.isArray(meta?.imageAttachments) ? meta.imageAttachments.length : 0,
          imageAttachmentsBase64Lengths: Array.isArray(meta?.imageAttachments) ? meta.imageAttachments.map((a: any) => a?.base64Data?.length ?? 0) : [],
        });
      }
      const safeMessage = sanitizeCoworkMessageForIpc(message);
      // Debug: check sanitized result
      if (message?.type === 'user') {
        const safeMeta = safeMessage?.metadata;
        console.log('[main] sanitized user message', {
          hasMetadata: !!safeMeta,
          metadataKeys: safeMeta ? Object.keys(safeMeta) : [],
          hasImageAttachments: !!(safeMeta?.imageAttachments),
          imageAttachmentsCount: Array.isArray(safeMeta?.imageAttachments) ? safeMeta.imageAttachments.length : 0,
          imageAttachmentsBase64Lengths: Array.isArray(safeMeta?.imageAttachments) ? safeMeta.imageAttachments.map((a: any) => a?.base64Data?.length ?? 0) : [],
        });
      }
      const windows = BrowserWindow.getAllWindows();
      windows.forEach(win => {
        if (!win.isDestroyed()) {
          try {
            win.webContents.send('cowork:stream:message', { sessionId, message: safeMessage });
          } catch (error) {
            console.error('Failed to forward cowork message:', error);
          }
        }
      });
    });

    coworkRunner.on('messageUpdate', (sessionId: string, messageId: string, content: string) => {
      const safeContent = truncateIpcString(content, IPC_UPDATE_CONTENT_MAX_CHARS);
      const windows = BrowserWindow.getAllWindows();
      windows.forEach(win => {
        if (!win.isDestroyed()) {
          try {
            win.webContents.send('cowork:stream:messageUpdate', { sessionId, messageId, content: safeContent });
          } catch (error) {
            console.error('Failed to forward cowork message update:', error);
          }
        }
      });
    });

    coworkRunner.on('messageMetadata', (sessionId: string, messageId: string, metadata: Record<string, unknown>) => {
      // Metadata-only updates (token usage, etc.) — forwarded to renderer
      // so bubbles can display "12.5K in · 841 out" under the AI reply
      // without re-adding the message to the Redux store.
      const windows = BrowserWindow.getAllWindows();
      windows.forEach(win => {
        if (!win.isDestroyed()) {
          try {
            win.webContents.send('cowork:stream:messageMetadata', { sessionId, messageId, metadata });
          } catch (error) {
            console.error('Failed to forward cowork message metadata:', error);
          }
        }
      });
    });

    coworkRunner.on('stuck', (sessionId: string, detail: { idleMs: number }) => {
      // Fired by the stuck watchdog when a running session has had no
      // forward progress for STUCK_WATCHDOG_MS. Forwarded to renderer
      // so it can show a toast / system notification — users running
      // overnight jobs come back to see WHY a task stalled.
      const windows = BrowserWindow.getAllWindows();
      windows.forEach(win => {
        if (!win.isDestroyed()) {
          try {
            win.webContents.send('cowork:stream:stuck', { sessionId, ...detail });
          } catch (error) {
            console.error('Failed to forward cowork stuck event:', error);
          }
        }
      });
    });

    coworkRunner.on('permissionRequest', (sessionId: string, request: any) => {
      if (coworkRunner?.getSessionConfirmationMode(sessionId) === 'text') {
        return;
      }
      const safeRequest = sanitizePermissionRequestForIpc(request);
      const windows = BrowserWindow.getAllWindows();
      windows.forEach(win => {
        if (!win.isDestroyed()) {
          try {
            win.webContents.send('cowork:stream:permission', { sessionId, request: safeRequest });
          } catch (error) {
            console.error('Failed to forward cowork permission request:', error);
          }
        }
      });
    });

    coworkRunner.on('complete', (sessionId: string, claudeSessionId: string | null) => {
      const windows = BrowserWindow.getAllWindows();
      windows.forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('cowork:stream:complete', { sessionId, claudeSessionId });
        }
      });
    });

    coworkRunner.on('error', (sessionId: string, error: string) => {
      const windows = BrowserWindow.getAllWindows();
      windows.forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('cowork:stream:error', { sessionId, error });
        }
      });
    });
  }
  return coworkRunner;
};

const getSkillManager = () => {
  if (!skillManager) {
    skillManager = new SkillManager(getStore);
  }
  return skillManager;
};

const getMcpStore = () => {
  if (!mcpStore) {
    const sqliteStore = getStore();
    mcpStore = new McpStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  }
  return mcpStore;
};

const getIMGatewayManager = () => {
  if (!imGatewayManager) {
    const sqliteStore = getStore();

    // Get Cowork dependencies for IM Cowork mode
    const runner = getCoworkRunner();
    const store = getCoworkStore();

    imGatewayManager = new IMGatewayManager(
      sqliteStore.getDatabase(),
      sqliteStore.getSaveFunction(),
      {
        coworkRunner: runner,
        coworkStore: store,
      }
    );

    // Initialize with LLM config provider
    imGatewayManager.initialize({
      getLLMConfig: async () => {
        const appConfig = sqliteStore.get<any>('app_config');
        if (!appConfig) return null;

        // Find first enabled provider
        const providers = appConfig.providers || {};
        for (const [providerName, providerConfig] of Object.entries(providers) as [string, any][]) {
          if (providerConfig.enabled && providerConfig.apiKey) {
            const model = providerConfig.models?.[0]?.id;
            return {
              apiKey: providerConfig.apiKey,
              baseUrl: providerConfig.baseUrl,
              model: model,
              provider: providerName,
            };
          }
        }

        // Fallback to legacy api config
        if (appConfig.api?.key) {
          return {
            apiKey: appConfig.api.key,
            baseUrl: appConfig.api.baseUrl,
            model: appConfig.model?.defaultModel,
          };
        }

        return null;
      },
      getSkillsPrompt: async () => {
        return getSkillManager().buildAutoRoutingPrompt();
      },
    });

    // Forward IM events to renderer
    imGatewayManager.on('statusChange', (status) => {
      const windows = BrowserWindow.getAllWindows();
      windows.forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('im:status:change', status);
        }
      });
    });

    imGatewayManager.on('message', (message) => {
      const windows = BrowserWindow.getAllWindows();
      windows.forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('im:message:received', message);
        }
      });
    });

    imGatewayManager.on('error', ({ platform, error }) => {
      console.error(`[IM Gateway] ${platform} error:`, error);
    });
  }
  return imGatewayManager;
};

const getScheduledTaskStore = () => {
  if (!scheduledTaskStore) {
    const sqliteStore = getStore();
    scheduledTaskStore = new ScheduledTaskStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  }
  return scheduledTaskStore;
};

const getScheduler = () => {
  if (!scheduler) {
    scheduler = new Scheduler({
      scheduledTaskStore: getScheduledTaskStore(),
      coworkStore: getCoworkStore(),
      getCoworkRunner,
      getIMGatewayManager: () => {
        try { return getIMGatewayManager(); } catch { return null; }
      },
      getSkillsPrompt: async () => {
        return getSkillManager().buildAutoRoutingPrompt();
      },
    });
  }
  return scheduler;
};

// Get the correct preload script path
const getPreloadPath = (): string => {
  if (app.isPackaged) {
    // In packaged apps, resolve from app.asar to avoid relying on __dirname layout.
    return path.join(app.getAppPath(), 'dist-electron', 'preload.js');
  }
  // In dev, dist-electron is emitted next to the project root.
  return path.join(__dirname, '../dist-electron/preload.js');
};

const getRendererIndexPath = (): string => {
  if (app.isPackaged) {
    return path.join(app.getAppPath(), 'dist', 'index.html');
  }
  // Dev renderer is loaded via Vite URL.
  return path.join(__dirname, '../dist/index.html');
};

// Get the application icon path (Windows uses .ico, other platforms use .png)
const getAppIconPath = (): string | undefined => {
  if (process.platform !== 'win32' && process.platform !== 'linux') return undefined;
  const basePath = app.isPackaged
    ? path.join(process.resourcesPath, 'tray')
    : path.join(__dirname, '..', 'resources', 'tray');
  return process.platform === 'win32'
    ? path.join(basePath, 'tray-icon.ico')
    : path.join(basePath, 'tray-icon.png');
};

// Keep a reference to the main window
let mainWindow: BrowserWindow | null = null;

onSandboxProgress((progress) => {
  const windows = BrowserWindow.getAllWindows();
  windows.forEach((win) => {
    win.webContents.send('cowork:sandbox:downloadProgress', progress);
  });
});
let isQuitting = false;

// Store active streaming request controllers
const activeStreamControllers = new Map<string, AbortController>();
let lastReloadAt = 0;
const MIN_RELOAD_INTERVAL_MS = 5000;
type AppConfigSettings = {
  theme?: string;
  language?: string;
  useSystemProxy?: boolean;
};

const getUseSystemProxyFromConfig = (config?: { useSystemProxy?: boolean }): boolean => {
  return config?.useSystemProxy === true;
};

const resolveThemeFromConfig = (config?: AppConfigSettings): 'light' | 'dark' => {
  if (config?.theme === 'dark') {
    return 'dark';
  }
  if (config?.theme === 'light') {
    return 'light';
  }
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
};

const getInitialTheme = (): 'light' | 'dark' => {
  const config = getStore().get<AppConfigSettings>('app_config');
  return resolveThemeFromConfig(config);
};

const getTitleBarOverlayOptions = () => {
  const config = getStore().get<AppConfigSettings>('app_config');
  const theme = resolveThemeFromConfig(config);
  return {
    color: TITLEBAR_COLORS[theme].color,
    symbolColor: TITLEBAR_COLORS[theme].symbolColor,
    height: TITLEBAR_HEIGHT,
  };
};

const updateTitleBarOverlay = () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!isMac && !isWindows) {
    mainWindow.setTitleBarOverlay(getTitleBarOverlayOptions());
  }
  // Also update the window background color to match the theme
  const config = getStore().get<AppConfigSettings>('app_config');
  const theme = resolveThemeFromConfig(config);
  mainWindow.setBackgroundColor(theme === 'dark' ? '#0F1117' : '#F8F9FB');
};

const applyProxyPreference = async (useSystemProxy: boolean): Promise<void> => {
  try {
    await session.defaultSession.setProxy({ mode: useSystemProxy ? 'system' : 'direct' });
  } catch (error) {
    console.error('[Main] Failed to apply session proxy mode:', error);
  }

  setSystemProxyEnabled(useSystemProxy);

  if (!useSystemProxy) {
    restoreOriginalProxyEnv();
    console.log('[Main] System proxy disabled (direct mode).');
    return;
  }

  const proxyUrl = await resolveSystemProxyUrl('https://openrouter.ai');
  applySystemProxyEnv(proxyUrl);

  if (proxyUrl) {
    console.log('[Main] System proxy enabled for process env:', proxyUrl);
  } else {
    console.warn('[Main] System proxy mode enabled, but no proxy endpoint was resolved (DIRECT).');
  }
};

const emitWindowState = () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send('window:state-changed', {
    isMaximized: mainWindow.isMaximized(),
    isFullscreen: mainWindow.isFullScreen(),
    isFocused: mainWindow.isFocused(),
  });
};

const showSystemMenu = (position?: { x?: number; y?: number }) => {
  if (!isWindows) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const isMaximized = mainWindow.isMaximized();
  const menu = Menu.buildFromTemplate([
    { label: 'Restore', enabled: isMaximized, click: () => mainWindow.restore() },
    { role: 'minimize' },
    { label: 'Maximize', enabled: !isMaximized, click: () => mainWindow.maximize() },
    { type: 'separator' },
    { role: 'close' },
  ]);

  menu.popup({
    window: mainWindow,
    x: Math.max(0, Math.round(position?.x ?? 0)),
    y: Math.max(0, Math.round(position?.y ?? 0)),
  });
};

const scheduleReload = (reason: string, webContents?: WebContents) => {
  const target = webContents ?? mainWindow?.webContents;
  if (!target || target.isDestroyed()) {
    return;
  }
  const now = Date.now();
  if (now - lastReloadAt < MIN_RELOAD_INTERVAL_MS) {
    console.warn(`Skipping reload (${reason}); last reload was ${now - lastReloadAt}ms ago.`);
    return;
  }
  lastReloadAt = now;
  console.warn(`Reloading window due to ${reason}`);
  target.reloadIgnoringCache();
};


// Register noobclaw:// deep link protocol (for web wallet login callback)
app.setAsDefaultProtocolClient('noobclaw');

// macOS: handle deep link via open-url event
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

function handleDeepLink(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'auth') {
      const token = parsed.searchParams.get('token');
      const wallet = parsed.searchParams.get('wallet');
      if (token && wallet && mainWindow) {
        mainWindow.webContents.send('auth:callback', token, wallet);
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    }
  } catch (e) {
    console.error('[Main] Failed to parse deep link:', url, e);
  }
}

// Ensure only one instance of the application
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine, workingDirectory) => {
    console.log('[Main] second-instance event', { commandLine, workingDirectory });
    // If a second instance is launched, focus the main window
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      if (!mainWindow.isFocused()) mainWindow.focus();
    }
    // Handle deep link (Windows: URL is in the last commandLine item)
    const deepLinkUrl = commandLine.find(arg => arg.startsWith('noobclaw://'));
    if (deepLinkUrl) {
      handleDeepLink(deepLinkUrl);
    }
  });

  // IPC handlers
  ipcMain.handle('store:get', (_event, key) => {
    return getStore().get(key);
  });

  ipcMain.handle('store:set', (_event, key, value) => {
    getStore().set(key, value);
  });

  ipcMain.handle('store:remove', (_event, key) => {
    getStore().delete(key);
  });

  // Network status change handler
  // Remove any existing listener first to avoid duplicate registrations
  ipcMain.removeAllListeners('network:status-change');
  ipcMain.on('network:status-change', (_event, status: 'online' | 'offline') => {
    console.log(`[Main] Network status changed: ${status}`);

    if (status === 'online' && imGatewayManager) {
      console.log('[Main] Network restored, reconnecting IM gateways...');
      imGatewayManager.reconnectAllDisconnected();
    }
  });

  // Log IPC handlers
  ipcMain.handle('log:getPath', () => {
    return getLogFilePath();
  });

  ipcMain.handle('log:openFolder', () => {
    const logPath = getLogFilePath();
    if (logPath) {
      shell.showItemInFolder(logPath);
    }
  });

  ipcMain.handle('log:exportZip', async (event) => {
    try {
      const ownerWindow = BrowserWindow.fromWebContents(event.sender);
      const saveOptions = {
        title: 'Export Logs',
        defaultPath: path.join(app.getPath('downloads'), buildLogExportFileName()),
        filters: [{ name: 'Zip Archive', extensions: ['zip'] }],
      };

      const saveResult = ownerWindow
        ? await dialog.showSaveDialog(ownerWindow, saveOptions)
        : await dialog.showSaveDialog(saveOptions);

      if (saveResult.canceled || !saveResult.filePath) {
        return { success: true, canceled: true };
      }

      const outputPath = ensureZipFileName(saveResult.filePath);
      const archiveResult = await exportLogsZip({
        outputPath,
        entries: [
          { archiveName: 'main.log', filePath: getLogFilePath() },
          { archiveName: 'cowork.log', filePath: getCoworkLogPath() },
        ],
      });

      return {
        success: true,
        canceled: false,
        path: outputPath,
        missingEntries: archiveResult.missingEntries,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to export logs',
      };
    }
  });

  // Browser bridge status IPC
  ipcMain.handle('browser-bridge:getStatus', async () => {
    try {
      const { getBrowserBridgeStatus } = await import('./libs/browserBridge');
      return getBrowserBridgeStatus();
    } catch {
      return { running: false, port: null, connected: false };
    }
  });

  // Auto-launch IPC handlers
  // Use SQLite store as the source of truth for UI state, because
  // app.getLoginItemSettings() returns unreliable values on macOS and
  // requires matching args on Windows.
  ipcMain.handle('app:getAutoLaunch', () => {
    const stored = getStore().get<boolean>('auto_launch_enabled');
    // Fall back to OS API if SQLite has no record yet (e.g. upgraded from older version)
    const enabled = stored ?? getAutoLaunchEnabled();
    return { enabled };
  });

  ipcMain.handle('app:setAutoLaunch', (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') {
      return { success: false, error: 'Invalid parameter: enabled must be boolean' };
    }
    try {
      setAutoLaunchEnabled(enabled);
      getStore().set('auto_launch_enabled', enabled);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set auto-launch',
      };
    }
  });

  // Window control IPC handlers
  ipcMain.on('window-minimize', () => {
    mainWindow?.minimize();
  });

  ipcMain.on('window-maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });

  ipcMain.on('window-close', () => {
    mainWindow?.close();
  });

  ipcMain.handle('window:isMaximized', () => {
    return mainWindow?.isMaximized() ?? false;
  });

  ipcMain.on('window:showSystemMenu', (_event, position: { x?: number; y?: number } | undefined) => {
    showSystemMenu(position);
  });

  ipcMain.handle('app:getVersion', () => app.getVersion());
  ipcMain.handle('app:getSystemLocale', () => app.getLocale());

  // Skills IPC handlers
  ipcMain.handle('skills:list', () => {
    try {
      const skills = getSkillManager().listSkills();
      return { success: true, skills };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to load skills' };
    }
  });

  ipcMain.handle('skills:setEnabled', (_event, options: { id: string; enabled: boolean }) => {
    try {
      const skills = getSkillManager().setSkillEnabled(options.id, options.enabled);
      return { success: true, skills };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update skill' };
    }
  });

  ipcMain.handle('skills:delete', (_event, id: string) => {
    try {
      const skills = getSkillManager().deleteSkill(id);
      return { success: true, skills };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete skill' };
    }
  });

  ipcMain.handle('skills:download', async (_event, source: string, meta?: { official?: boolean; skillId?: string }) => {
    return getSkillManager().downloadSkill(source, meta);
  });

  ipcMain.handle('skills:getRoot', () => {
    try {
      const root = getSkillManager().getSkillsRoot();
      return { success: true, path: root };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to resolve skills root' };
    }
  });

  ipcMain.handle('skills:autoRoutingPrompt', () => {
    try {
      const prompt = getSkillManager().buildAutoRoutingPrompt();
      return { success: true, prompt };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to build auto-routing prompt' };
    }
  });

  ipcMain.handle('skills:getConfig', (_event, skillId: string) => {
    return getSkillManager().getSkillConfig(skillId);
  });

  ipcMain.handle('skills:setConfig', (_event, skillId: string, config: Record<string, string>) => {
    return getSkillManager().setSkillConfig(skillId, config);
  });

  ipcMain.handle('skills:testEmailConnectivity', async (
    _event,
    skillId: string,
    config: Record<string, string>
  ) => {
    return getSkillManager().testEmailConnectivity(skillId, config);
  });

  // MCP Server IPC handlers
  ipcMain.handle('mcp:list', () => {
    try {
      const servers = getMcpStore().listServers();
      return { success: true, servers };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to list MCP servers' };
    }
  });

  ipcMain.handle('mcp:create', (_event, data: {
    name: string;
    description: string;
    transportType: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  }) => {
    try {
      getMcpStore().createServer(data as any);
      const servers = getMcpStore().listServers();
      return { success: true, servers };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to create MCP server' };
    }
  });

  ipcMain.handle('mcp:update', (_event, id: string, data: {
    name?: string;
    description?: string;
    transportType?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  }) => {
    try {
      getMcpStore().updateServer(id, data as any);
      const servers = getMcpStore().listServers();
      return { success: true, servers };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update MCP server' };
    }
  });

  ipcMain.handle('mcp:delete', (_event, id: string) => {
    try {
      getMcpStore().deleteServer(id);
      const servers = getMcpStore().listServers();
      return { success: true, servers };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete MCP server' };
    }
  });

  ipcMain.handle('mcp:setEnabled', (_event, options: { id: string; enabled: boolean }) => {
    try {
      getMcpStore().setEnabled(options.id, options.enabled);
      const servers = getMcpStore().listServers();
      return { success: true, servers };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update MCP server' };
    }
  });

  // ── MCP OAuth 2.0 authorization-code flow ──
  //
  // Renderer calls `mcp:oauth:begin` with a server id and the provider's
  // authorizeUrl / tokenUrl / clientId / scope. We spin up a loopback
  // HTTP server, construct the authorize URL, open it in the default
  // browser via shell.openExternal, wait for the callback on loopback,
  // exchange the code for tokens, and persist the tokens onto the
  // McpServerRecord via setOAuth(). No prompts or permission gates —
  // OAuth is the user's explicit intent by invoking this handler from
  // the MCP config UI.
  ipcMain.handle('mcp:oauth:begin', async (_event, options: {
    id: string;
    authorizeUrl: string;
    tokenUrl: string;
    clientId: string;
    clientSecret?: string;
    scope?: string;
  }) => {
    try {
      const server = getMcpStore().getServer(options.id);
      if (!server) return { success: false, error: 'MCP server not found' };

      const { beginMcpOAuthFlow } = await import('./libs/mcpOAuth');
      const flow = await beginMcpOAuthFlow({
        authorizeUrl: options.authorizeUrl,
        tokenUrl: options.tokenUrl,
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        scope: options.scope,
      });

      // Open the provider's authorize URL in the user's default browser.
      try { shell.openExternal(flow.authorizeUrl); } catch (e) {
        console.warn('[mcp:oauth] openExternal failed:', e);
      }

      // Wait for the callback (up to 5 minutes). If it resolves, persist
      // the tokens back onto the server record.
      const oauth = await flow.waitForCallback;
      getMcpStore().setOAuth(options.id, oauth);
      const servers = getMcpStore().listServers();
      return { success: true, servers };
    } catch (error) {
      console.warn('[mcp:oauth] flow failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('mcp:oauth:clear', async (_event, id: string) => {
    try {
      const server = getMcpStore().getServer(id);
      if (!server) return { success: false, error: 'MCP server not found' };
      // Clear by setting an oauth record with no tokens but preserving
      // the provider metadata so the user doesn't have to re-enter it.
      if (server.oauth) {
        getMcpStore().setOAuth(id, {
          type: 'oauth',
          authorizeUrl: server.oauth.authorizeUrl,
          tokenUrl: server.oauth.tokenUrl,
          clientId: server.oauth.clientId,
          clientSecret: server.oauth.clientSecret,
          scope: server.oauth.scope,
        });
      }
      const servers = getMcpStore().listServers();
      return { success: true, servers };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('mcp:fetchMarketplace', async () => {
    const url = app.isPackaged
      ? 'https://api-overmind.noobclaw.com/openapi/get/luna/hardware/noobclaw/prod/mcp-marketplace'
      : 'https://api-overmind.noobclaw.com/openapi/get/luna/hardware/noobclaw/test/mcp-marketplace';
    try {
      const https = await import('https');
      const data = await new Promise<string>((resolve, reject) => {
        const req = https.get(url, { timeout: 10000 }, (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            res.resume();
            return;
          }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => { body += chunk; });
          res.on('end', () => resolve(body));
          res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      });
      const json = JSON.parse(data);
      const value = json?.data?.value;
      if (!value) {
        return { success: false, error: 'Invalid response: missing data.value' };
      }
      const marketplace = typeof value === 'string' ? JSON.parse(value) : value;
      return { success: true, data: marketplace };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to fetch marketplace' };
    }
  });

  // Browser Bridge IPC handlers
  ipcMain.handle('browser-bridge:status', async () => {
    return getBrowserBridgeStatus();
  });

  ipcMain.handle('browser-bridge:restart', async () => {
    // v2.8: the bridge no longer owns its own listener — the ws + sse
    // routes are attached to the sidecar's HTTP server. "Restart" here
    // just tears down active connections; the next extension reconnect
    // will land on the (still-running) attached routes.
    await stopBrowserBridge();
    return getBrowserBridgeStatus();
  });

  // Cowork IPC handlers
  ipcMain.handle('cowork:session:start', async (_event, options: {
    prompt: string;
    cwd?: string;
    systemPrompt?: string;
    title?: string;
    activeSkillIds?: string[];
    imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }>;
  }) => {
    try {
      const coworkStoreInstance = getCoworkStore();
      const config = coworkStoreInstance.getConfig();
      const systemPrompt = options.systemPrompt ?? config.systemPrompt;
      const selectedWorkspaceRoot = (options.cwd || config.workingDirectory || '').trim();

      if (!selectedWorkspaceRoot) {
        return {
          success: false,
          error: 'Please select a task folder before submitting.',
        };
      }

      // Generate title from first line of prompt
      const fallbackTitle = options.prompt.split('\n')[0].slice(0, 50) || 'New Session';
      const title = options.title?.trim() || fallbackTitle;
      const taskWorkingDirectory = resolveTaskWorkingDirectory(selectedWorkspaceRoot);

      const session = coworkStoreInstance.createSession(
        title,
        taskWorkingDirectory,
        systemPrompt,
        config.executionMode || 'local',
        options.activeSkillIds || []
      );
      // Build metadata, include imageAttachments if present
      const messageMetadata: Record<string, unknown> = {};
      if (options.activeSkillIds?.length) {
        messageMetadata.skillIds = options.activeSkillIds;
      }
      if (options.imageAttachments?.length) {
        messageMetadata.imageAttachments = options.imageAttachments;
      }
      coworkStoreInstance.addMessage(session.id, {
        type: 'user',
        content: options.prompt,
        metadata: Object.keys(messageMetadata).length > 0 ? messageMetadata : undefined,
      });

      const probe = await probeCoworkModelReadiness();
      if (probe.ok === false) {
        coworkStoreInstance.updateSession(session.id, { status: 'error' });
        coworkStoreInstance.addMessage(session.id, {
          type: 'system',
          content: `Error: ${probe.error}`,
          metadata: { error: probe.error },
        });
        const failedSession = coworkStoreInstance.getSession(session.id) || {
          ...session,
          status: 'error' as const,
        };
        return { success: true, session: failedSession };
      }

      const runner = getCoworkRunner();

      // Update session status to 'running' before starting async task
      // This ensures the frontend receives the correct status immediately
      coworkStoreInstance.updateSession(session.id, { status: 'running' });

      // Run intent classification to auto-inject the most relevant SKILL.md.
      // Only runs when user hasn't manually selected a skill.
      // Fails silently — original systemPrompt is used as fallback.
      let enrichedSystemPrompt: string | undefined;
      try {
        const hasManualSkill = (options.activeSkillIds?.length ?? 0) > 0;
        const enabledSkills = getSkillManager().listSkills()
          .filter(s => s.enabled)
          .map(s => ({ id: s.id, name: s.name, description: s.description }));
        const intentResult = await classifyIntent(options.prompt, enabledSkills, hasManualSkill);
        if (intentResult.skillIds.length > 0) {
          const injected = getSkillManager().getSkillInjectionContent(intentResult.skillIds);
          if (injected) {
            enrichedSystemPrompt = `${injected}\n\n${systemPrompt}`.trim();
            console.log(`[intent] classified as [${intentResult.skillIds.join(', ')}] via ${intentResult.source}`);
          }
        }
      } catch (err) {
        console.warn('[intent] classification failed, using original systemPrompt:', err);
      }

      // Start the session asynchronously (skip initial user message since we already added it)
      runner.startSession(session.id, options.prompt, {
        skipInitialUserMessage: true,
        skillIds: options.activeSkillIds,
        systemPrompt: enrichedSystemPrompt,
        workspaceRoot: selectedWorkspaceRoot,
        confirmationMode: config.dangerouslySkipPermissions ? 'text' : 'modal',
        imageAttachments: options.imageAttachments,
      }).catch(error => {
        console.error('Cowork session error:', error);
      });

      const sessionWithMessages = coworkStoreInstance.getSession(session.id) || {
        ...session,
        status: 'running' as const,
      };
      return { success: true, session: sessionWithMessages };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to start session',
      };
    }
  });

  ipcMain.handle('cowork:session:continue', async (_event, options: {
    sessionId: string;
    prompt: string;
    systemPrompt?: string;
    activeSkillIds?: string[];
    imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }>;
  }) => {
    try {
      console.log('[main] cowork:session:continue handler', {
        sessionId: options.sessionId,
        hasImageAttachments: !!options.imageAttachments,
        imageAttachmentsCount: options.imageAttachments?.length ?? 0,
        imageAttachmentsNames: options.imageAttachments?.map(a => a.name),
      });
      const runner = getCoworkRunner();

      // Run intent classification for follow-up messages too.
      let continueSystemPrompt = options.systemPrompt;
      try {
        const hasManualSkill = (options.activeSkillIds?.length ?? 0) > 0;
        const enabledSkills = getSkillManager().listSkills()
          .filter(s => s.enabled)
          .map(s => ({ id: s.id, name: s.name, description: s.description }));
        const intentResult = await classifyIntent(options.prompt, enabledSkills, hasManualSkill);
        if (intentResult.skillIds.length > 0) {
          const injected = getSkillManager().getSkillInjectionContent(intentResult.skillIds);
          if (injected) {
            const base = options.systemPrompt || '';
            continueSystemPrompt = `${injected}\n\n${base}`.trim();
            console.log(`[intent] continue classified as [${intentResult.skillIds.join(', ')}] via ${intentResult.source}`);
          }
        }
      } catch (err) {
        console.warn('[intent] continue classification failed:', err);
      }

      runner.continueSession(options.sessionId, options.prompt, {
        systemPrompt: continueSystemPrompt,
        skillIds: options.activeSkillIds,
        imageAttachments: options.imageAttachments,
      }).catch(error => {
        console.error('Cowork continue error:', error);
      });

      const session = getCoworkStore().getSession(options.sessionId);
      return { success: true, session };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to continue session',
      };
    }
  });

  ipcMain.handle('cowork:session:stop', async (_event, sessionId: string) => {
    try {
      const runner = getCoworkRunner();
      runner.stopSession(sessionId);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to stop session',
      };
    }
  });

  ipcMain.handle('cowork:session:delete', async (_event, sessionId: string) => {
    try {
      const coworkStoreInstance = getCoworkStore();
      coworkStoreInstance.deleteSession(sessionId);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete session',
      };
    }
  });

  ipcMain.handle('cowork:session:deleteBatch', async (_event, sessionIds: string[]) => {
    try {
      const coworkStoreInstance = getCoworkStore();
      coworkStoreInstance.deleteSessions(sessionIds);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to batch delete sessions',
      };
    }
  });

  ipcMain.handle('cowork:session:pin', async (_event, options: { sessionId: string; pinned: boolean }) => {
    try {
      const coworkStoreInstance = getCoworkStore();
      coworkStoreInstance.setSessionPinned(options.sessionId, options.pinned);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update session pin',
      };
    }
  });

  ipcMain.handle('cowork:session:rename', async (_event, options: { sessionId: string; title: string }) => {
    try {
      const title = options.title.trim();
      if (!title) {
        return { success: false, error: 'Title is required' };
      }
      const coworkStoreInstance = getCoworkStore();
      coworkStoreInstance.updateSession(options.sessionId, { title });
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to rename session',
      };
    }
  });

  ipcMain.handle('cowork:session:get', async (_event, sessionId: string) => {
    try {
      const session = getCoworkStore().getSession(sessionId);
      return { success: true, session };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get session',
      };
    }
  });

  ipcMain.handle('cowork:session:list', async () => {
    try {
      const sessions = getCoworkStore().listSessions();
      return { success: true, sessions };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list sessions',
      };
    }
  });

  // ── Cost / token usage (B2d) ────────────────────────────────
  ipcMain.handle('cowork:cost:summary', async (_event, range: 'today' | 'week' | 'month' | 'all') => {
    try {
      const store = getCoworkStore();
      const now = Date.now();
      const DAY = 24 * 60 * 60 * 1000;
      let since: number;
      if (range === 'today') {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        since = today.getTime();
      } else if (range === 'week') {
        since = now - 7 * DAY;
      } else if (range === 'month') {
        since = now - 30 * DAY;
      } else {
        since = 0;
      }
      const summary = store.getCostSummary(since);
      return { success: true, range, since, summary };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('cowork:cost:histogram', async (_event, days: number) => {
    try {
      const buckets = getCoworkStore().getCostHistogramDaily(Number(days) || 14);
      return { success: true, buckets };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('cowork:cost:session', async (_event, sessionId: string) => {
    try {
      const stats = getCoworkStore().getSessionCost(String(sessionId || ''));
      return { success: true, stats };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('cowork:session:exportResultImage', async (
    event,
    options: {
      rect: { x: number; y: number; width: number; height: number };
      defaultFileName?: string;
    }
  ) => {
    try {
      const { rect, defaultFileName } = options || {};
      const captureRect = normalizeCaptureRect(rect);
      if (!captureRect) {
        return { success: false, error: 'Capture rect is required' };
      }

      const image = await event.sender.capturePage(captureRect);
      return savePngWithDialog(event.sender, image.toPNG(), defaultFileName);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to export session image',
      };
    }
  });

  ipcMain.handle('cowork:session:captureImageChunk', async (
    event,
    options: {
      rect: { x: number; y: number; width: number; height: number };
    }
  ) => {
    try {
      const captureRect = normalizeCaptureRect(options?.rect);
      if (!captureRect) {
        return { success: false, error: 'Capture rect is required' };
      }

      const image = await event.sender.capturePage(captureRect);
      const pngBuffer = image.toPNG();

      return {
        success: true,
        width: captureRect.width,
        height: captureRect.height,
        pngBase64: pngBuffer.toString('base64'),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to capture session image chunk',
      };
    }
  });

  ipcMain.handle('cowork:session:saveResultImage', async (
    event,
    options: {
      pngBase64: string;
      defaultFileName?: string;
    }
  ) => {
    try {
      const base64 = typeof options?.pngBase64 === 'string' ? options.pngBase64.trim() : '';
      if (!base64) {
        return { success: false, error: 'Image data is required' };
      }

      const pngBuffer = Buffer.from(base64, 'base64');
      if (pngBuffer.length <= 0) {
        return { success: false, error: 'Invalid image data' };
      }

      return savePngWithDialog(event.sender, pngBuffer, options?.defaultFileName);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save session image',
      };
    }
  });

  ipcMain.handle('cowork:permission:respond', async (_event, options: {
    requestId: string;
    result: PermissionResult;
  }) => {
    try {
      const runner = getCoworkRunner();
      runner.respondToPermission(options.requestId, options.result);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to respond to permission',
      };
    }
  });

  ipcMain.handle('cowork:config:get', async () => {
    try {
      const config = getCoworkStore().getConfig();
      return { success: true, config };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get config',
      };
    }
  });

  ipcMain.handle('cowork:sandbox:status', async () => {
    return getSandboxStatus();
  });
  ipcMain.handle('cowork:memory:listEntries', async (_event, input: {
    query?: string;
    status?: 'created' | 'stale' | 'deleted' | 'all';
    includeDeleted?: boolean;
    limit?: number;
    offset?: number;
  }) => {
    try {
      const entries = getCoworkStore().listUserMemories({
        query: input?.query?.trim() || undefined,
        status: input?.status || 'all',
        includeDeleted: Boolean(input?.includeDeleted),
        limit: input?.limit,
        offset: input?.offset,
      });
      return { success: true, entries };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list memory entries',
      };
    }
  });
  ipcMain.handle('cowork:memory:createEntry', async (_event, input: {
    text: string;
    confidence?: number;
    isExplicit?: boolean;
  }) => {
    try {
      const entry = getCoworkStore().createUserMemory({
        text: input.text,
        confidence: input.confidence,
        isExplicit: input?.isExplicit,
      });
      return { success: true, entry };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create memory entry',
      };
    }
  });
  ipcMain.handle('cowork:memory:updateEntry', async (_event, input: {
    id: string;
    text?: string;
    confidence?: number;
    status?: 'created' | 'stale' | 'deleted';
    isExplicit?: boolean;
  }) => {
    try {
      const entry = getCoworkStore().updateUserMemory({
        id: input.id,
        text: input.text,
        confidence: input.confidence,
        status: input.status,
        isExplicit: input.isExplicit,
      });
      if (!entry) {
        return { success: false, error: 'Memory entry not found' };
      }
      return { success: true, entry };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update memory entry',
      };
    }
  });
  ipcMain.handle('cowork:memory:deleteEntry', async (_event, input: {
    id: string;
  }) => {
    try {
      const success = getCoworkStore().deleteUserMemory(input.id);
      return success
        ? { success: true }
        : { success: false, error: 'Memory entry not found' };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete memory entry',
      };
    }
  });
  ipcMain.handle('cowork:memory:getStats', async () => {
    try {
      const stats = getCoworkStore().getUserMemoryStats();
      return { success: true, stats };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get memory stats',
      };
    }
  });
  ipcMain.handle('cowork:sandbox:install', async () => {
    const result = await ensureSandboxReady();
    return {
      success: result.ok,
      status: getSandboxStatus(),
      error: result.ok ? undefined : ('error' in result ? result.error : undefined),
    };
  });

  ipcMain.handle('cowork:config:set', async (_event, config: {
    workingDirectory?: string;
    executionMode?: 'auto' | 'local' | 'sandbox';
    memoryEnabled?: boolean;
    memoryImplicitUpdateEnabled?: boolean;
    memoryLlmJudgeEnabled?: boolean;
    memoryGuardLevel?: 'strict' | 'standard' | 'relaxed';
    memoryUserMemoriesMaxItems?: number;
    dangerouslySkipPermissions?: boolean;
  }) => {
    try {
      const normalizedExecutionMode =
        config.executionMode && String(config.executionMode) === 'container'
          ? 'sandbox'
          : config.executionMode;
      const normalizedMemoryEnabled = typeof config.memoryEnabled === 'boolean'
        ? config.memoryEnabled
        : undefined;
      const normalizedMemoryImplicitUpdateEnabled = typeof config.memoryImplicitUpdateEnabled === 'boolean'
        ? config.memoryImplicitUpdateEnabled
        : undefined;
      const normalizedMemoryLlmJudgeEnabled = typeof config.memoryLlmJudgeEnabled === 'boolean'
        ? config.memoryLlmJudgeEnabled
        : undefined;
      const normalizedMemoryGuardLevel = config.memoryGuardLevel === 'strict'
        || config.memoryGuardLevel === 'standard'
        || config.memoryGuardLevel === 'relaxed'
        ? config.memoryGuardLevel
        : undefined;
      const normalizedMemoryUserMemoriesMaxItems =
        typeof config.memoryUserMemoriesMaxItems === 'number' && Number.isFinite(config.memoryUserMemoriesMaxItems)
          ? Math.max(
            MIN_MEMORY_USER_MEMORIES_MAX_ITEMS,
            Math.min(MAX_MEMORY_USER_MEMORIES_MAX_ITEMS, Math.floor(config.memoryUserMemoriesMaxItems))
          )
        : undefined;
      const normalizedDangerouslySkipPermissions = typeof config.dangerouslySkipPermissions === 'boolean'
        ? config.dangerouslySkipPermissions
        : undefined;
      const normalizedConfig = {
        ...config,
        executionMode: normalizedExecutionMode,
        memoryEnabled: normalizedMemoryEnabled,
        memoryImplicitUpdateEnabled: normalizedMemoryImplicitUpdateEnabled,
        memoryLlmJudgeEnabled: normalizedMemoryLlmJudgeEnabled,
        memoryGuardLevel: normalizedMemoryGuardLevel,
        memoryUserMemoriesMaxItems: normalizedMemoryUserMemoriesMaxItems,
        dangerouslySkipPermissions: normalizedDangerouslySkipPermissions,
      };
      const previousWorkingDir = getCoworkStore().getConfig().workingDirectory;
      getCoworkStore().setConfig(normalizedConfig);
      if (normalizedConfig.workingDirectory !== undefined && normalizedConfig.workingDirectory !== previousWorkingDir) {
        getSkillManager().handleWorkingDirectoryChange();
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set config',
      };
    }
  });

  // ==================== Scheduled Task IPC Handlers ====================

  ipcMain.handle('scheduledTask:list', async () => {
    try {
      const tasks = getScheduledTaskStore().listTasks();
      return { success: true, tasks };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to list tasks' };
    }
  });

  ipcMain.handle('scheduledTask:get', async (_event, id: string) => {
    try {
      const task = getScheduledTaskStore().getTask(id);
      return { success: true, task };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get task' };
    }
  });

  ipcMain.handle('scheduledTask:create', async (_event, input: any) => {
    try {
      const coworkConfig = getCoworkStore().getConfig();
      const normalizedInput = input && typeof input === 'object' ? { ...input } : {};
      const candidateWorkingDirectory = typeof normalizedInput.workingDirectory === 'string' && normalizedInput.workingDirectory.trim()
        ? normalizedInput.workingDirectory
        : coworkConfig.workingDirectory;
      normalizedInput.workingDirectory = resolveExistingTaskWorkingDirectory(candidateWorkingDirectory);

      const task = getScheduledTaskStore().createTask(normalizedInput);
      getScheduler().reschedule();
      return { success: true, task };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to create task' };
    }
  });

  ipcMain.handle('scheduledTask:update', async (_event, id: string, input: any) => {
    try {
      const scheduledTaskStore = getScheduledTaskStore();
      const existingTask = scheduledTaskStore.getTask(id);
      if (!existingTask) {
        return { success: false, error: `Task not found: ${id}` };
      }

      const coworkConfig = getCoworkStore().getConfig();
      const normalizedInput = input && typeof input === 'object' ? { ...input } : {};
      const candidateWorkingDirectory = typeof normalizedInput.workingDirectory === 'string'
        ? (normalizedInput.workingDirectory.trim() || existingTask.workingDirectory || coworkConfig.workingDirectory)
        : (existingTask.workingDirectory || coworkConfig.workingDirectory);
      normalizedInput.workingDirectory = resolveExistingTaskWorkingDirectory(candidateWorkingDirectory);

      const task = scheduledTaskStore.updateTask(id, normalizedInput);
      getScheduler().reschedule();
      return { success: true, task };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update task' };
    }
  });

  ipcMain.handle('scheduledTask:delete', async (_event, id: string) => {
    try {
      getScheduler().stopTask(id);
      const result = getScheduledTaskStore().deleteTask(id);
      getScheduler().reschedule();
      return { success: true, result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete task' };
    }
  });

  ipcMain.handle('scheduledTask:toggle', async (_event, id: string, enabled: boolean) => {
    try {
      const { task, warning } = getScheduledTaskStore().toggleTask(id, enabled);
      getScheduler().reschedule();
      return { success: true, task, warning };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to toggle task' };
    }
  });

  ipcMain.handle('scheduledTask:runManually', async (_event, id: string) => {
    try {
      getScheduler().runManually(id).catch((err) => {
        console.error(`[IPC] Manual run failed for ${id}:`, err);
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to run task' };
    }
  });

  ipcMain.handle('scheduledTask:stop', async (_event, id: string) => {
    try {
      const result = getScheduler().stopTask(id);
      return { success: true, result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to stop task' };
    }
  });

  ipcMain.handle('scheduledTask:listRuns', async (_event, taskId: string, limit?: number, offset?: number) => {
    try {
      const runs = getScheduledTaskStore().listRuns(taskId, limit, offset);
      return { success: true, runs };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to list runs' };
    }
  });

  ipcMain.handle('scheduledTask:countRuns', async (_event, taskId: string) => {
    try {
      const count = getScheduledTaskStore().countRuns(taskId);
      return { success: true, count };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to count runs' };
    }
  });

  ipcMain.handle('scheduledTask:listAllRuns', async (_event, limit?: number, offset?: number) => {
    try {
      const runs = getScheduledTaskStore().listAllRuns(limit, offset);
      return { success: true, runs };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to list all runs' };
    }
  });

  // ==================== Permissions IPC Handlers ====================

  ipcMain.handle('permissions:checkCalendar', async () => {
    try {
      const status = await checkCalendarPermission();
      
      // Development mode: Auto-request permission if not determined
      // This provides a better dev experience without affecting production
      if (isDev && status === 'not-determined' && process.platform === 'darwin') {
        console.log('[Permissions] Development mode: Auto-requesting calendar permission...');
        try {
          await requestCalendarPermission();
          const newStatus = await checkCalendarPermission();
          console.log('[Permissions] Development mode: Permission status after request:', newStatus);
          return { success: true, status: newStatus, autoRequested: true };
        } catch (requestError) {
          console.warn('[Permissions] Development mode: Auto-request failed:', requestError);
        }
      }
      
      return { success: true, status };
    } catch (error) {
      console.error('[Main] Error checking calendar permission:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to check permission' };
    }
  });

  ipcMain.handle('permissions:requestCalendar', async () => {
    try {
      // Request permission and check status
      const granted = await requestCalendarPermission();
      const status = await checkCalendarPermission();
      return { success: true, granted, status };
    } catch (error) {
      console.error('[Main] Error requesting calendar permission:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to request permission' };
    }
  });

  // ==================== IM Gateway IPC Handlers ====================

  ipcMain.handle('im:config:get', async () => {
    try {
      const config = getIMGatewayManager().getConfig();
      return { success: true, config };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get IM config',
      };
    }
  });

  ipcMain.handle('im:config:set', async (_event, config: Partial<IMGatewayConfig>) => {
    try {
      getIMGatewayManager().setConfig(config);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set IM config',
      };
    }
  });

  ipcMain.handle('im:gateway:start', async (_event, platform: IMPlatform) => {
    try {
      // Persist enabled state
      const manager = getIMGatewayManager();
      manager.setConfig({ [platform]: { enabled: true } });
      await manager.startGateway(platform);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to start gateway',
      };
    }
  });

  ipcMain.handle('im:gateway:stop', async (_event, platform: IMPlatform) => {
    try {
      // Persist disabled state
      const manager = getIMGatewayManager();
      manager.setConfig({ [platform]: { enabled: false } });
      await manager.stopGateway(platform);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to stop gateway',
      };
    }
  });

  ipcMain.handle('im:gateway:test', async (
    _event,
    platform: IMPlatform,
    configOverride?: Partial<IMGatewayConfig>
  ) => {
    try {
      const result = await getIMGatewayManager().testGateway(platform, configOverride);
      return { success: true, result };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to test gateway connectivity',
      };
    }
  });

  ipcMain.handle('im:status:get', async () => {
    try {
      const status = getIMGatewayManager().getStatus();
      return { success: true, status };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get IM status',
      };
    }
  });

  ipcMain.handle('generate-session-title', async (_event, userInput: string | null) => {
    return generateSessionTitle(userInput);
  });

  ipcMain.handle('get-recent-cwds', async (_event, limit?: number) => {
    const boundedLimit = limit ? Math.min(Math.max(limit, 1), 20) : 8;
    return getCoworkStore().listRecentCwds(boundedLimit);
  });

  ipcMain.handle('get-api-config', async () => {
    return getCurrentApiConfig();
  });

  ipcMain.handle('check-api-config', async (_event, options?: { probeModel?: boolean }) => {
    const { config, error } = resolveCurrentApiConfig();
    if (config && options?.probeModel) {
      const probe = await probeCoworkModelReadiness();
      if (probe.ok === false) {
        return { hasConfig: false, config: null, error: probe.error };
      }
    }
    return { hasConfig: config !== null, config, error };
  });

  // NoobClaw: renderer sends JWT token when user logs in/out
  ipcMain.handle('noobclaw:set-auth-token', (_event, token: string | null) => {
    setNoobClawAuthToken(token);
    return { success: true };
  });

  // NoobClaw: cache avatar image to local disk
  ipcMain.handle('noobclaw:cache-avatar', async (_event, url: string) => {
    try {
      const cacheDir = path.join(app.getPath('userData'), 'cache');
      if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
      const res = await (await import('node:https')).default;
      const filePath = path.join(cacheDir, 'user-avatar.png');
      // Download image
      const fetchMod = await import('node:http' + (url.startsWith('https') ? 's' : ''));
      const data = await new Promise<Buffer>((resolve, reject) => {
        fetchMod.default.get(url, { timeout: 10000 }, (resp: any) => {
          if (resp.statusCode && resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
            // Follow redirect
            fetchMod.default.get(resp.headers.location, { timeout: 10000 }, (resp2: any) => {
              const chunks: Buffer[] = [];
              resp2.on('data', (c: Buffer) => chunks.push(c));
              resp2.on('end', () => resolve(Buffer.concat(chunks)));
              resp2.on('error', reject);
            }).on('error', reject);
            return;
          }
          const chunks: Buffer[] = [];
          resp.on('data', (c: Buffer) => chunks.push(c));
          resp.on('end', () => resolve(Buffer.concat(chunks)));
          resp.on('error', reject);
        }).on('error', reject);
      });
      await fs.promises.writeFile(filePath, data);
      return { success: true, localPath: `file://${filePath.replace(/\\/g, '/')}` };
    } catch (err) {
      console.error('[Main] Failed to cache avatar:', err);
      return { success: false, localPath: null };
    }
  });

  // NoobClaw: get cached avatar local path
  ipcMain.handle('noobclaw:get-cached-avatar', () => {
    try {
      const filePath = path.join(app.getPath('userData'), 'cache', 'user-avatar.png');
      if (fs.existsSync(filePath)) {
        return `file://${filePath.replace(/\\/g, '/')}`;
      }
    } catch { /* ignore */ }
    return null;
  });

  // NoobClaw: get device MAC address
  ipcMain.handle('noobclaw:get-mac-address', () => {
    const os = require('os');
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] || []) {
        if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
          return iface.mac;
        }
      }
    }
    return null;
  });

  ipcMain.handle('save-api-config', async (_event, config: {
    apiKey: string;
    baseURL: string;
    model: string;
    apiType?: 'anthropic' | 'openai';
  }) => {
    try {
      saveCoworkApiConfig(config);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save API config',
      };
    }
  });

  // Dialog handlers
  ipcMain.handle('dialog:selectDirectory', async (event) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions = {
      properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[],
    };
    const result = ownerWindow
      ? await dialog.showOpenDialog(ownerWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled || result.filePaths.length === 0) {
      return { success: true, path: null };
    }
    return { success: true, path: result.filePaths[0] };
  });

  ipcMain.handle('dialog:selectFile', async (event, options?: { title?: string; filters?: { name: string; extensions: string[] }[] }) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions = {
      properties: ['openFile'] as ('openFile')[],
      title: options?.title,
      filters: options?.filters,
    };
    const result = ownerWindow
      ? await dialog.showOpenDialog(ownerWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled || result.filePaths.length === 0) {
      return { success: true, path: null };
    }
    return { success: true, path: result.filePaths[0] };
  });

  ipcMain.handle('dialog:selectFiles', async (event, options?: { title?: string; filters?: { name: string; extensions: string[] }[] }) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions = {
      properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[],
      title: options?.title,
      filters: options?.filters,
    };
    const result = ownerWindow
      ? await dialog.showOpenDialog(ownerWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled || result.filePaths.length === 0) {
      return { success: true, paths: [] };
    }
    return { success: true, paths: result.filePaths };
  });

  ipcMain.handle(
    'dialog:saveInlineFile',
    async (
      _event,
      options?: { dataBase64?: string; fileName?: string; mimeType?: string; cwd?: string }
    ) => {
      try {
        const dataBase64 = typeof options?.dataBase64 === 'string' ? options.dataBase64.trim() : '';
        if (!dataBase64) {
          return { success: false, path: null, error: 'Missing file data' };
        }

        const buffer = Buffer.from(dataBase64, 'base64');
        if (!buffer.length) {
          return { success: false, path: null, error: 'Invalid file data' };
        }
        if (buffer.length > MAX_INLINE_ATTACHMENT_BYTES) {
          return {
            success: false,
            path: null,
            error: `File too large (max ${Math.floor(MAX_INLINE_ATTACHMENT_BYTES / (1024 * 1024))}MB)`,
          };
        }

        const dir = resolveInlineAttachmentDir(options?.cwd);
        await fs.promises.mkdir(dir, { recursive: true });

        const safeFileName = sanitizeAttachmentFileName(options?.fileName);
        const extension = inferAttachmentExtension(safeFileName, options?.mimeType);
        const baseName = extension ? safeFileName.slice(0, -extension.length) : safeFileName;
        const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const finalName = `${baseName || 'attachment'}-${uniqueSuffix}${extension}`;
        const outputPath = path.join(dir, finalName);

        await fs.promises.writeFile(outputPath, buffer);
        return { success: true, path: outputPath };
      } catch (error) {
        return {
          success: false,
          path: null,
          error: error instanceof Error ? error.message : 'Failed to save inline file',
        };
      }
    }
  );

  // Read a local file as a data URL (data:<mime>;base64,...)
  const MAX_READ_AS_DATA_URL_BYTES = 20 * 1024 * 1024;
  const MIME_BY_EXT: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
  };
  ipcMain.handle(
    'dialog:readFileAsDataUrl',
    async (_event, filePath?: string): Promise<{ success: boolean; dataUrl?: string; error?: string }> => {
      try {
        if (typeof filePath !== 'string' || !filePath.trim()) {
          return { success: false, error: 'Missing file path' };
        }
        const resolvedPath = path.resolve(filePath.trim());
        const stat = await fs.promises.stat(resolvedPath);
        if (!stat.isFile()) {
          return { success: false, error: 'Not a file' };
        }
        if (stat.size > MAX_READ_AS_DATA_URL_BYTES) {
          return {
            success: false,
            error: `File too large (max ${Math.floor(MAX_READ_AS_DATA_URL_BYTES / (1024 * 1024))}MB)`,
          };
        }
        const buffer = await fs.promises.readFile(resolvedPath);
        const ext = path.extname(resolvedPath).toLowerCase();
        const mimeType = MIME_BY_EXT[ext] || 'application/octet-stream';
        const base64 = buffer.toString('base64');
        return { success: true, dataUrl: `data:${mimeType};base64,${base64}` };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to read file',
        };
      }
    }
  );

  // Shell handlers - open files/folders
  ipcMain.handle('shell:openPath', async (_event, filePath: string) => {
    try {
      const normalizedPath = normalizeWindowsShellPath(filePath);
      const result = await shell.openPath(normalizedPath);
      if (result) {
        // If a non-empty string is returned, it means the open failed
        return { success: false, error: result };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle('shell:showItemInFolder', async (_event, filePath: string) => {
    try {
      const normalizedPath = normalizeWindowsShellPath(filePath);
      shell.showItemInFolder(normalizedPath);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    try {
      await shell.openExternal(url);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  // App update download & install
  ipcMain.handle('appUpdate:download', async (event, url: string) => {
    try {
      const filePath = await downloadUpdate(url, (progress) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('appUpdate:downloadProgress', progress);
        }
      });
      return { success: true, filePath };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Download failed' };
    }
  });

  ipcMain.handle('appUpdate:cancelDownload', async () => {
    const cancelled = cancelActiveDownload();
    return { success: cancelled };
  });

  ipcMain.handle('appUpdate:install', async (_event, filePath: string) => {
    try {
      await installUpdate(filePath);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Installation failed' };
    }
  });

  // API proxy handler - resolve CORS issues
  ipcMain.handle('api:fetch', async (_event, options: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }) => {
    try {
      const response = await session.defaultSession.fetch(options.url, {
        method: options.method,
        headers: options.headers,
        body: options.body,
      });

      const contentType = response.headers.get('content-type') || '';
      let data: string | object;

      if (contentType.includes('text/event-stream')) {
        // SSE streaming response, return the full text
        data = await response.text();
      } else if (contentType.includes('application/json')) {
        data = await response.json();
      } else {
        data = await response.text();
      }

      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        data,
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        statusText: error instanceof Error ? error.message : 'Network error',
        headers: {},
        data: null,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  // SSE streaming API proxy
  ipcMain.handle('api:stream', async (event, options: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
    requestId: string;
  }) => {
    const controller = new AbortController();

    // Store the controller for later cancellation
    activeStreamControllers.set(options.requestId, controller);

    try {
      const response = await session.defaultSession.fetch(options.url, {
        method: options.method,
        headers: options.headers,
        body: options.body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorData = await response.text();
        activeStreamControllers.delete(options.requestId);
        return {
          ok: false,
          status: response.status,
          statusText: response.statusText,
          error: errorData,
        };
      }

      if (!response.body) {
        activeStreamControllers.delete(options.requestId);
        return {
          ok: false,
          status: response.status,
          statusText: 'No response body',
        };
      }

      // Read the streaming response and send via IPC
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      const readStream = async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) {
              event.sender.send(`api:stream:${options.requestId}:done`);
              break;
            }
            const chunk = decoder.decode(value);
            event.sender.send(`api:stream:${options.requestId}:data`, chunk);
          }
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            event.sender.send(`api:stream:${options.requestId}:abort`);
          } else {
            event.sender.send(`api:stream:${options.requestId}:error`,
              error instanceof Error ? error.message : 'Stream error');
          }
        } finally {
          activeStreamControllers.delete(options.requestId);
        }
      };

      // Read the stream asynchronously, return success status immediately
      readStream();

      return {
        ok: true,
        status: response.status,
        statusText: response.statusText,
      };
    } catch (error) {
      activeStreamControllers.delete(options.requestId);
      return {
        ok: false,
        status: 0,
        statusText: error instanceof Error ? error.message : 'Network error',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  // Cancel streaming request
  ipcMain.handle('api:stream:cancel', (_event, requestId: string) => {
    const controller = activeStreamControllers.get(requestId);
    if (controller) {
      controller.abort();
      activeStreamControllers.delete(requestId);
      return true;
    }
    return false;
  });

  // ── Scenario Automation (XHS viral production etc.) ──
  // Initialize once, then expose IPC for the renderer's "one-click" feature.
  {
    const userData = app.getPath('userData');
    const scenarioRiskGuard = require('./libs/scenario/riskGuard');
    const scenarioTaskStore = require('./libs/scenario/taskStore');
    const scenarioManager = require('./libs/scenario/scenarioManager');
    const scenarioViralPool = require('./libs/scenario/viralPoolClient');
    scenarioRiskGuard.initRiskGuard(userData);
    scenarioTaskStore.initTaskStore(userData);
    // v5.x+: 让 scenarioManager 能拿到 app_config.language,送进 orchestrator
    // 的 ctx.appLocale。orchestrator 用它替代 navigator.language 决定输出语言,
    // 解决"中文 noobclaw + 英文 Chrome → 推特发出来全英文"的问题。
    scenarioManager.setAppConfigGetter(() => getStore().get('app_config'));

    ipcMain.handle('scenario:listTasks', () => scenarioTaskStore.listTasks());
    ipcMain.handle('scenario:getTask', (_e, id: string) => scenarioTaskStore.getTask(id));
    ipcMain.handle('scenario:createTask', (_e, input: unknown) => {
      const newTask = scenarioTaskStore.createTask(input as any);
      // v2.4.31: pre-compute next_planned_run_at on create — same as
      // sidecar-server path (see comment there). Without this, freshly
      // created tasks show "下次运行: 即将（计算中）" until next tick.
      // v2.4.32: isFirstRun=true → first fire in first bucket / today's
      // remaining slot (not a full interval later).
      try {
        const interval = (newTask as any).run_interval || 'daily';
        if (interval !== 'once') {
          const planned = scenarioManager.computeNextPlannedRun(interval, newTask.daily_time, Date.now(), true);
          const updated = scenarioTaskStore.updateTask(newTask.id, { next_planned_run_at: planned } as any);
          if (updated) return updated;
        }
      } catch (e) {
        console.warn('[scenario:createTask] pre-compute next run failed:', e);
      }
      return newTask;
    });
    ipcMain.handle('scenario:updateTask', (_e, id: string, patch: unknown) => {
      const p = (patch || {}) as any;
      const before = scenarioTaskStore.getTask(id);
      const updated = scenarioTaskStore.updateTask(id, p);
      // v2.4.31: reschedule on interval / daily_time change
      if (updated && before) {
        const intervalChanged = p.run_interval !== undefined && p.run_interval !== (before as any).run_interval;
        const dailyTimeChanged = p.daily_time !== undefined && p.daily_time !== before.daily_time;
        if (intervalChanged || dailyTimeChanged) {
          try {
            const interval = (updated as any).run_interval || 'daily';
            if (interval !== 'once') {
              // isFirstRun=true on interval edit — fresh schedule.
              const planned = scenarioManager.computeNextPlannedRun(interval, updated.daily_time, Date.now(), true);
              const reUpdated = scenarioTaskStore.updateTask(updated.id, { next_planned_run_at: planned } as any);
              if (reUpdated) return reUpdated;
            } else {
              const reUpdated = scenarioTaskStore.updateTask(updated.id, { next_planned_run_at: undefined } as any);
              if (reUpdated) return reUpdated;
            }
          } catch (e) {
            console.warn('[scenario:updateTask] reschedule failed:', e);
          }
        }
      }
      return updated;
    });
    ipcMain.handle('scenario:deleteTask', (_e, id: string) => scenarioTaskStore.deleteTask(id));

    ipcMain.handle('scenario:runTaskNow', async (_e, id: string) => {
      const task = scenarioTaskStore.getTask(id);
      if (!task) return { status: 'failed', reason: 'task_not_found' };
      return await scenarioManager.runTask(task);
    });

    ipcMain.handle('scenario:listDrafts', (_e, task_id?: string) =>
      scenarioTaskStore.listDrafts(task_id),
    );
    ipcMain.handle('scenario:deleteDraft', (_e, id: string) => scenarioTaskStore.deleteDraft(id));
    ipcMain.handle('scenario:markDraftPushed', (_e, id: string) =>
      scenarioTaskStore.updateDraft(id, { status: 'pushed', pushed_at: Date.now() }),
    );
    ipcMain.handle('scenario:markDraftIgnored', (_e, id: string) =>
      scenarioTaskStore.updateDraft(id, { status: 'ignored' }),
    );

    ipcMain.handle('scenario:pushDraft', async (_e, draft_id: string) => {
      const draft = scenarioTaskStore.getDraft(draft_id);
      if (!draft) return { status: 'failed', error: 'draft_not_found' };
      // Load the pack to get the creator URL + selectors
      const pack = await scenarioViralPool.fetchScenarioPack(
        scenarioTaskStore.getTask(draft.task_id)?.scenario_id,
      );
      if (!pack?.manifest) return { status: 'failed', error: 'scenario_pack_not_found' };
      const { uploadXhsDraft } = require('./libs/scenario/xhsDriver');
      const result = await uploadXhsDraft({
        manifest: pack.manifest,
        variant: draft.variant,
        images: draft.source_post.images || [],
      });
      if (result.status === 'ready_for_user') {
        scenarioTaskStore.updateDraft(draft_id, { status: 'pushed', pushed_at: Date.now() });
      }
      return result;
    });

    ipcMain.handle('scenario:listScenarios', async () => {
      try {
        const base = process.env.NOOBCLAW_API_BASE_URL || 'https://api.noobclaw.com';
        const res = await fetch(`${base}/api/viral/scenarios`);
        if (!res.ok) return { scenarios: [] };
        return await res.json();
      } catch {
        return { scenarios: [] };
      }
    });

    ipcMain.handle('scenario:runStatus', (_e, task_id: string) => ({
      runs: scenarioRiskGuard.getRuns(task_id),
      cooldown_ends_at: scenarioRiskGuard.getCooldown(task_id),
    }));

    ipcMain.handle('scenario:checkXhsLogin', async (_e, platform?: 'xhs' | 'x' | 'binance' | 'tiktok' | 'youtube' | 'douyin' | 'kuaishou' | 'bilibili' | 'shipinhao' | 'toutiao') => {
      const { checkXhsLogin } = require('./libs/scenario/xhsDriver');
      return await checkXhsLogin(platform);
    });

    ipcMain.handle('scenario:openXhsLogin', async (_e, platform?: 'xhs' | 'x' | 'binance' | 'tiktok' | 'youtube' | 'douyin' | 'kuaishou' | 'bilibili' | 'shipinhao' | 'toutiao') => {
      const { openXhsLogin } = require('./libs/scenario/xhsDriver');
      return await openXhsLogin(platform);
    });

    ipcMain.handle('scenario:checkCreatorCenter', async (_e, platform: 'xhs' | 'douyin' | 'kuaishou' | 'bilibili' | 'shipinhao' | 'toutiao') => {
      const { checkCreatorCenter } = require('./libs/scenario/platformLoginDriver');
      return await checkCreatorCenter(platform);
    });

    // 视频任务【保存/运行前】登录预检 cookie 快路径:读各平台(创作中心走 creator 子域)登录 cookie,
    //   有效即过,不依赖对应页面开着(req 3)。fail-safe:拿不准返回 null,modal 回退老 tab 校验。
    ipcMain.handle('video:checkLoginByCookie', async (_e, platform: string, which?: 'main' | 'creator') => {
      const { checkVideoLoginByCookie } = require('./libs/video/videoLoginCheck');
      return await checkVideoLoginByCookie(platform, which === 'creator' ? 'creator' : 'main');
    });

    // 多平台一次性 cookie 校验(用户勾选多个上传平台时用):一次 CDP 读全部、按域名+名逐平台判,
    //   避免并发各开一次 attach 互抢 + 同名 cookie 串台。返回 { [platform]: true|false|null }。
    ipcMain.handle('video:checkLoginByCookieBatch', async (_e, items: { platform: string; which?: 'main' | 'creator' }[]) => {
      const { checkVideoLoginByCookieBatch } = require('./libs/video/videoLoginCheck');
      return await checkVideoLoginByCookieBatch(Array.isArray(items) ? items : []);
    });

    // 多平台登录【复用同一个窗口】:把唯一的检查/登录窗导航到该平台登录页(不再每点一个开新窗)。
    ipcMain.handle('video:openLoginInCheckWindow', async (_e, url: string, _role?: string) => {
      // _role 仅为兼容旧渲染端调用签名,已不用:登录检查是【一窗一 tab navigate】,不按 role 分 tab。
      const { openLoginInCheckWindow } = require('./libs/video/videoLoginCheck');
      return await openLoginInCheckWindow(String(url || ''));
    });

    // 模态关闭时收掉检查/登录窗(避免空白窗常驻)。
    ipcMain.handle('video:closeLoginCheckWindow', async () => {
      const { closeVideoCheckWindow } = require('./libs/video/videoLoginCheck');
      await closeVideoCheckWindow();
      return { ok: true };
    });

    // CNY 收款码上传:渲染进程 fetch+FormData 在 Electron 里发不出 multipart(实测客户端必报 "No file",
    //   官网普通浏览器没事)→ 改由【主进程】用 Node 全局 fetch+FormData 从【文件路径】读出来发,server 级稳。
    ipcMain.handle('video:uploadCnyQr', async (
      _e,
      args: { b64: string; name?: string; backendUrl: string; headers: Record<string, string> },
    ) => {
      try {
        // ⚠️ Electron 40 已删除 File.path,所以不能靠路径读文件 —— 渲染进程把文件字节(base64)直接传进来。
        const buf = Buffer.from(String(args.b64 || ''), 'base64');
        if (!buf || buf.length === 0) return { error: 'empty_file' };
        const name = args.name || 'qr.png';
        const ext = String(name.split('.').pop() || '').toLowerCase();
        const type = (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg'
          : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/png';
        const G: any = globalThis as any;
        const fd = new G.FormData();
        fd.append('qr', new G.Blob([buf], { type }), name);
        const res = await G.fetch(`${args.backendUrl}/api/me/withdraw/cny/upload-qr`, {
          method: 'POST',
          headers: args.headers || {}, // 只有 Authorization + x-wallet-address;Content-Type 交给 FormData 带 boundary
          body: fd,
        });
        const data: any = await res.json().catch(() => ({}));
        console.log('[uploadCnyQr] main upload', { bytes: buf.length, status: res.status, ok: res.ok, url: data && data.url });
        if (!res.ok) return { error: (data && data.error) || ('http_' + res.status) };
        return { ok: true, url: data.url };
      } catch (e: any) {
        console.error('[uploadCnyQr] main upload failed', e);
        return { error: 'main_upload_failed:' + String((e && e.message) || e).slice(0, 100) };
      }
    });

    ipcMain.handle('scenario:openCreatorCenter', async (_e, platform: 'xhs' | 'douyin' | 'kuaishou' | 'bilibili' | 'shipinhao' | 'toutiao') => {
      const { openCreatorCenter } = require('./libs/scenario/platformLoginDriver');
      return await openCreatorCenter(platform);
    });
  }

  // ── Multi-platform Video Creation (phase 1: local synthesis) ──
  // 本地出片工具,不走 scenario 任务体系。配音/素材/合成全在主进程,
  // 进度通过 mainWindow webContents 推回渲染端。
  {
    ipcMain.handle('video:pickImages', async (_e, max: number) => {
      const limit = Math.max(1, Math.min(Number(max) || 3, 9));
      // Anchor the picker to the focused window so it reliably appears in
      // front (an app-modal dialog with no parent can open behind the
      // window on some setups → looks like "nothing happened").
      const parent = BrowserWindow.getFocusedWindow() || mainWindow || undefined;
      const opts = {
        title: '选择视频参考图',
        properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
        filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'] }],
      };
      const result = parent
        ? await dialog.showOpenDialog(parent, opts)
        : await dialog.showOpenDialog(opts);
      if (result.canceled || !Array.isArray(result.filePaths)) return [];
      return result.filePaths.slice(0, limit);
    });

    ipcMain.handle('video:pickVideos', async (_e, max: number) => {
      const limit = Math.max(1, Math.min(Number(max) || 8, 30));
      const parent = BrowserWindow.getFocusedWindow() || mainWindow || undefined;
      const opts = {
        title: '选择本地视频素材',
        properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
        filters: [{ name: 'Videos', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'] }],
      };
      const result = parent
        ? await dialog.showOpenDialog(parent, opts)
        : await dialog.showOpenDialog(opts);
      if (result.canceled || !Array.isArray(result.filePaths)) return [];
      // 格式 + 大小白名单兜底:超限的剔除并弹原生提示告诉用户为什么。
      const { validateMediaFiles, rejectedMessage } = require('./libs/video/mediaLimits');
      const { valid, rejected } = validateMediaFiles(result.filePaths.slice(0, limit), 'video');
      if (rejected.length > 0) {
        try {
          await dialog.showMessageBox(parent || mainWindow || undefined, {
            type: 'warning',
            title: '部分视频已忽略',
            message: '以下文件不符合要求，已忽略：',
            detail: rejectedMessage(rejected),
          });
        } catch { /* 提示失败不影响返回有效文件 */ }
      }
      return valid;
    });

    // 本地混剪:选素材文件夹(视频或图片)并回扫描统计 { dir, videoCount, imageCount }。
    ipcMain.handle('video:pickLocalFolder', async () => {
      const parent = BrowserWindow.getFocusedWindow() || mainWindow || undefined;
      const opts = { title: '选择本地素材文件夹', properties: ['openDirectory'] as Array<'openDirectory'> };
      const result = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
      if (result.canceled || !Array.isArray(result.filePaths) || !result.filePaths[0]) return null;
      const dir = result.filePaths[0];
      const { scanLocalMediaFolder } = require('./libs/video/pipeline');
      const media = scanLocalMediaFolder(dir);
      return { dir, videoCount: media.videos.length, imageCount: media.images.length };
    });
    ipcMain.handle('video:scanLocalFolder', async (_e, dir: string) => {
      const { scanLocalMediaFolder } = require('./libs/video/pipeline');
      const media = scanLocalMediaFolder(String(dir || ''));
      return { videoCount: media.videos.length, imageCount: media.images.length };
    });

    // Read a local image file and return it as a data: URL so the renderer
    // can show a real thumbnail (renderer can't load file:// under CSP).
    ipcMain.handle('video:readImageDataUrl', async (_e, filePath: string) => {
      try {
        const fs = require('fs');
        const path = require('path');
        const buf: Buffer = fs.readFileSync(filePath);
        // Guard against huge files — thumbnails don't need more than a few MB.
        if (buf.length > 12 * 1024 * 1024) return '';
        const ext = path.extname(filePath).toLowerCase().replace('.', '');
        const mime =
          ext === 'png' ? 'image/png'
          : ext === 'webp' ? 'image/webp'
          : ext === 'bmp' ? 'image/bmp'
          : ext === 'gif' ? 'image/gif'
          : 'image/jpeg';
        return `data:${mime};base64,${buf.toString('base64')}`;
      } catch {
        return '';
      }
    });

    // resolveBgmPath(「打开文件夹」用):返回该 BGM 所在【目录】——不下载、不要求文件已存在,
    // 直接打开目录让用户自己双击试听。builtin→内置 bgm 目录;remote→缓存目录;上传→文件目录。
    ipcMain.handle('video:resolveBgmPath', async (_e, token: string) => {
      try {
        const fs = require('fs');
        const { resolveBgmFolder } = require('./libs/video/bgm');
        const dir: string | undefined = resolveBgmFolder(token);
        return dir && fs.existsSync(dir) ? dir : '';
      } catch {
        return '';
      }
    });

    ipcMain.handle('video:pickAudio', async () => {
      const parent = BrowserWindow.getFocusedWindow() || mainWindow || undefined;
      const result = await dialog.showOpenDialog({
        title: '选择背景音乐',
        properties: ['openFile'],
        filters: [{ name: 'Audio', extensions: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg'] }],
      });
      if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) return '';
      // 格式 + 大小白名单兜底:不合规则不返回路径,并弹原生提示。
      const { validateMediaFiles, rejectedMessage } = require('./libs/video/mediaLimits');
      const { valid, rejected } = validateMediaFiles([result.filePaths[0]], 'audio');
      if (rejected.length > 0) {
        try {
          await dialog.showMessageBox(parent, {
            type: 'warning',
            title: '背景音乐已忽略',
            message: '该文件不符合要求：',
            detail: rejectedMessage(rejected),
          });
        } catch { /* noop */ }
      }
      return valid[0] || '';
    });

    ipcMain.handle('video:openFile', async (_e, filePath: string) => {
      try { await shell.openPath(filePath); } catch {}
      return true;
    });

    // 运行中的视频任务注册表(taskId → AbortController),供「停止」中断 pipeline + kill 子进程。
    const activeVideoRuns = new Map<string, AbortController>();
    ipcMain.handle('video:generate', async (_e, input: unknown) => {
      const { generateVideoBatch } = require('./libs/video/pipeline');
      const inp = (input || {}) as { taskId?: unknown; engine?: unknown; videoCount?: unknown; videoCountMin?: unknown; videoCountMax?: unknown };
      const taskId = inp?.taskId ? String(inp.taskId) : '';
      const ctrl = new AbortController();
      if (taskId) { activeVideoRuns.get(taskId)?.abort(); activeVideoRuns.set(taskId, ctrl); }
      const emit = (progress: unknown) => {
        try {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('video:progress', progress);
          }
        } catch {}
      };

      // 批量编排统一走 pipeline.generateVideoBatch —— IPC(本 handler)与 sidecar-server 的
      //   video:generate(scenario 定时/后台任务走这条!)共用同一套,避免两份漂移、避免某条路径
      //   漏掉批量(此前 sidecar 没批量,hotspot/stock 走定时只出 1 条)。
      //   fire-and-forget:N 条几分钟~几小时,await 会撞 IPC 超时;进度 + 终态全走 video:progress,
      //   renderer 靠终态事件 resolve generate()。每条完整跑完(本地保存 + 按需发布)才进下一条。
      void generateVideoBatch(inp as any, emit, ctrl.signal)
        .catch(() => { /* 后台兜底:不抛(终态已由 generateVideoBatch 发出) */ })
        .finally(() => { if (taskId && activeVideoRuns.get(taskId) === ctrl) activeVideoRuns.delete(taskId); });
      return { ok: true, status: 'started' };
    });
    // 停止某个正在出片的视频任务:abort → pipeline 步骤边界退出 + ffmpeg/seedance/tts 子进程 SIGKILL。
    ipcMain.handle('video:stop', async (_e, taskId: unknown) => {
      const ctrl = activeVideoRuns.get(String(taskId || ''));
      if (ctrl) { ctrl.abort(); return { ok: true }; }
      return { ok: false };
    });
  }

  // Set Content Security Policy
  const setContentSecurityPolicy = () => {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const devPort = process.env.ELECTRON_START_URL?.match(/:(\d+)/)?.[1] || '5175';
      const cspDirectives = [
        "default-src 'self'",
        // Vite's built index.html contains a small inline bootstrap script. Allow it in production.
        // Electron app loads only local files, so this is an acceptable tradeoff vs. a blank window.
        isDev
          ? `script-src 'self' 'unsafe-inline' http://localhost:${devPort} ws://localhost:${devPort}`
          : "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https: http:",
        // Allow connections to all domains without restrictions
        "connect-src *",
        "font-src 'self' data:",
        // data:/blob: so the video wizard can preview BGM via in-memory data: URLs.
        "media-src 'self' data: blob:",
        "worker-src 'self' blob:",
        "frame-src 'self'"
      ];

      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': cspDirectives.join('; ')
        }
      });
    });
  };

  // Create the main window
  const createWindow = () => {
    // If the window already exists, do not create a new one
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      if (!mainWindow.isFocused()) mainWindow.focus();
      return;
    }

    mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      title: APP_NAME,
      icon: getAppIconPath(),
      ...(isMac
        ? {
            titleBarStyle: 'hiddenInset' as const,
            trafficLightPosition: { x: 12, y: 20 },
          }
        : isWindows
          ? {
              frame: false,
              titleBarStyle: 'hidden' as const,
            }
          : {
            titleBarStyle: 'hidden' as const,
            titleBarOverlay: getTitleBarOverlayOptions(),
          }),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        preload: getPreloadPath(),
        backgroundThrottling: false,
        // DevTools off in packaged builds so end users can't pop the
        // inspector via F12, the menu, or `webContents.openDevTools()`
        // calls leaking from third-party code. Dev mode (electron .)
        // keeps it on for debugging. Renderer also blocks F12 / Ctrl+R
        // hotkeys (see src/renderer/main.tsx) — this is the runtime
        // backstop in case the keyboard handler is bypassed.
        devTools: !app.isPackaged,
        spellcheck: false,
        enableWebSQL: false,
        autoplayPolicy: 'document-user-activation-required',
        disableDialogs: true,
        navigateOnDragDrop: false
      },
      backgroundColor: getInitialTheme() === 'dark' ? '#0F1117' : '#F8F9FB',
      show: false,
      autoHideMenuBar: true,
      enableLargerThanScreen: false
    });

    // Set macOS Dock icon (in dev mode, Electron's default icon is not the app logo)
    if (isMac && isDev) {
      const iconPath = path.join(__dirname, '../build/icons/png/512x512.png');
      if (fs.existsSync(iconPath)) {
        app.dock.setIcon(nativeImage.createFromPath(iconPath));
      }
    }

    // Disable the window menu
    mainWindow.setMenu(null);

    // Set the minimum window size
    mainWindow.setMinimumSize(800, 600);

    // Set window load timeout
    const loadTimeout = setTimeout(() => {
      if (mainWindow && mainWindow.webContents.isLoadingMainFrame()) {
        console.log('Window load timed out, attempting to reload...');
        scheduleReload('load-timeout');
      }
    }, 30000);

    // Clear the timeout
    mainWindow.webContents.once('did-finish-load', () => {
      clearTimeout(loadTimeout);
    });
    mainWindow.webContents.on('did-finish-load', () => {
      emitWindowState();
    });

    // Handle window close
    mainWindow.on('close', (e) => {
      // In development, close should actually quit so `npm run electron:dev`
      // restarts from a clean process. In production we keep tray behavior.
      if (mainWindow && !isQuitting && !isDev) {
        e.preventDefault();
        mainWindow.hide();
      }
    });

    // Handle renderer process crash or exit
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      console.error('Window render process gone:', details);
      scheduleReload('webContents-crashed');
    });

    // Capture renderer console output in main logs (helps diagnose "blank window" issues).
    mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      const levels = ['debug', 'info', 'warn', 'error'] as const;
      const tag = levels[Math.min(Math.max(level, 0), levels.length - 1)];
      console[tag](`[RendererConsole] ${message} (${sourceId}:${line})`);
    });

    // Electron fires this when a preload script fails to load/execute.
    // Typings for this event vary across Electron versions, so we cast to avoid TS friction.
    (mainWindow.webContents as any).on('preload-error', (_event: any, preloadPath: string, error: Error) => {
      console.error('[Main] preload-error', { preloadPath, error });
    });

    if (isDev) {
      // Development environment
      const maxRetries = 3;
      let retryCount = 0;

      const tryLoadURL = () => {
        mainWindow?.loadURL(DEV_SERVER_URL).catch((err) => {
          console.error('Failed to load URL:', err);
          retryCount++;
          
          if (retryCount < maxRetries) {
            console.log(`Retrying to load URL (${retryCount}/${maxRetries})...`);
            setTimeout(tryLoadURL, 3000);
          } else {
            console.error('Failed to load URL after maximum retries');
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.loadFile(path.join(__dirname, '../resources/error.html'));
            }
          }
        });
      };

      tryLoadURL();
      
      // Open developer tools
      mainWindow.webContents.openDevTools();
    } else {
      // Production environment
      const indexPath = getRendererIndexPath();
      mainWindow.loadFile(indexPath).catch((error) => {
        console.error('[Main] Failed to load renderer index.html:', { indexPath, error });
      });
    }

    // Add error handling
    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      console.error('Page failed to load:', errorCode, errorDescription);
      // If load fails in production, show a simple inline error page instead of a blank window.
      if (!isDev) {
        const details = `Load failed (${errorCode}): ${errorDescription}`;
        const logPath = getLogFilePath();
        const html = encodeURIComponent(`
          <html>
            <head><meta charset="utf-8" /><title>NoobClaw - 启动失败</title></head>
            <body style="font-family: ui-sans-serif, system-ui; padding: 24px;">
              <h2>NoobClaw 启动失败</h2>
              <p>${details}</p>
              <p>日志文件：${logPath}</p>
              <p>请把该日志发给开发者排查。</p>
            </body>
          </html>
        `);
        void mainWindow?.loadURL(`data:text/html;charset=utf-8,${html}`);
        return;
      }
      // Dev: retry reload.
      setTimeout(() => scheduleReload('did-fail-load'), 3000);
    });

    // When the window is closed, clear the reference
    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    const forwardWindowState = () => emitWindowState();
    mainWindow.on('maximize', forwardWindowState);
    mainWindow.on('unmaximize', forwardWindowState);
    mainWindow.on('enter-full-screen', forwardWindowState);
    mainWindow.on('leave-full-screen', forwardWindowState);
    mainWindow.on('focus', forwardWindowState);
    mainWindow.on('blur', forwardWindowState);

    // Wait for content to finish loading before showing the window
    mainWindow.once('ready-to-show', () => {
      emitWindowState();
      // When auto-launched at startup, do not show the window, only show the tray icon
      if (!isAutoLaunched()) {
        mainWindow?.show();
      }
      // Create the system tray after the window is ready
      createTray(() => mainWindow, getStore());

      // Start the scheduler
      getScheduler().start();
    });
  };

  let isCleanupFinished = false;
  let isCleanupInProgress = false;

  const runAppCleanup = async (): Promise<void> => {
    console.log('[Main] App is quitting, starting cleanup...');
    destroyTray();
    skillManager?.stopWatching();

    // Stop Cowork sessions without blocking shutdown.
    if (coworkRunner) {
      console.log('[Main] Stopping cowork sessions...');
      coworkRunner.stopAllSessions();
    }

    await stopCoworkOpenAICompatProxy().catch((error) => {
      console.error('Failed to stop OpenAI compatibility proxy:', error);
    });

    await stopBrowserBridge().catch((error) => {
      console.error('Failed to stop browser bridge:', error);
    });

    // Stop skill services.
    const skillServices = getSkillServiceManager();
    await skillServices.stopAll();

    // Stop all IM gateways gracefully.
    if (imGatewayManager) {
      await imGatewayManager.stopAll().catch(err => {
        console.error('[IM Gateway] Error stopping gateways on quit:', err);
      });
    }

    // Stop the scheduler
    if (scheduler) {
      scheduler.stop();
    }
  };

  app.on('before-quit', (e) => {
    if (isCleanupFinished) return;

    e.preventDefault();
    if (isCleanupInProgress) {
      return;
    }

    isCleanupInProgress = true;
    isQuitting = true;

    void runAppCleanup()
      .catch((error) => {
        console.error('[Main] Cleanup error:', error);
      })
      .finally(() => {
        isCleanupFinished = true;
        isCleanupInProgress = false;
        app.exit(0);
      });
  });

  const handleTerminationSignal = (signal: NodeJS.Signals) => {
    if (isCleanupFinished || isCleanupInProgress) {
      return;
    }
    console.log(`[Main] Received ${signal}, running cleanup before exit...`);
    isCleanupInProgress = true;
    isQuitting = true;
    void runAppCleanup()
      .catch((error) => {
        console.error(`[Main] Cleanup error during ${signal}:`, error);
      })
      .finally(() => {
        isCleanupFinished = true;
        isCleanupInProgress = false;
        app.exit(0);
      });
  };

  process.once('SIGINT', () => handleTerminationSignal('SIGINT'));
  process.once('SIGTERM', () => handleTerminationSignal('SIGTERM'));

  // Initialize the application
  const initApp = async () => {
    console.log('[Main] initApp: waiting for app.whenReady()');
    await app.whenReady();
    console.log('[Main] initApp: app is ready');

    // Note: Calendar permission is checked on-demand when calendar operations are requested
    // We don't trigger permission dialogs at startup to avoid annoying users

    // Ensure default working directory exists
    const defaultProjectDir = path.join(os.homedir(), 'noobclaw', 'project');
    if (!fs.existsSync(defaultProjectDir)) {
      fs.mkdirSync(defaultProjectDir, { recursive: true });
      console.log('Created default project directory:', defaultProjectDir);
    }
    console.log('[Main] initApp: default project dir ensured');

    console.log('[Main] initApp: starting initStore()');
    store = await initStore();
    console.log('[Main] initApp: store initialized');

    // Defensive recovery: app may be force-closed during execution and leave
    // stale running flags in DB. Normalize them on startup.
    const resetCount = getCoworkStore().resetRunningSessions();
    console.log('[Main] initApp: resetRunningSessions done, count:', resetCount);
    if (resetCount > 0) {
      console.log(`[Main] Reset ${resetCount} stuck cowork session(s) from running -> idle`);
    }
    // Inject store getter into claudeSettings
    setStoreGetter(() => store);
    // v2.x: same getter for news_usage dedup (used by binance / x writing
    // scenarios to avoid posting on the same web3_news article twice).
    setNewsUsageStoreGetter(() => store);
    // v6.x: same getter for engage_history dedup (used by auto_engage /
    // reply_fans_comment scenarios to avoid commenting on the same video
    // or replying to the same fan comment twice across runs).
    setEngageHistoryStoreGetter(() => store);
    console.log('[Main] initApp: setStoreGetter done');
    const manager = getSkillManager();
    console.log('[Main] initApp: getSkillManager done');

    // Non-critical: sync bundled skills to user data.
    // Wrapped in try-catch so a failure here does not block window creation.
    try {
      manager.syncBundledSkillsToUserData();
      console.log('[Main] initApp: syncBundledSkillsToUserData done');
    } catch (error) {
      console.error('[Main] initApp: syncBundledSkillsToUserData failed:', error);
    }

    try {
      const runtimeResult = await ensurePythonRuntimeReady();
      if (!runtimeResult.success) {
        console.error('[Main] initApp: ensurePythonRuntimeReady failed:', runtimeResult.error);
      } else {
        console.log('[Main] initApp: ensurePythonRuntimeReady done');
      }
    } catch (error) {
      console.error('[Main] initApp: ensurePythonRuntimeReady threw:', error);
    }

    try {
      manager.startWatching();
      console.log('[Main] initApp: startWatching done');
    } catch (error) {
      console.error('[Main] initApp: startWatching failed:', error);
    }

    // Start skill services (non-critical)
    try {
      const skillServices = getSkillServiceManager();
      console.log('[Main] initApp: getSkillServiceManager done');
      await skillServices.startAll();
      console.log('[Main] initApp: skill services started');
    } catch (error) {
      console.error('[Main] initApp: skill services failed:', error);
    }

    const appConfig = getStore().get<AppConfigSettings>('app_config');
    await applyProxyPreference(getUseSystemProxyFromConfig(appConfig));

    await startCoworkOpenAICompatProxy().catch((error) => {
      console.error('Failed to start OpenAI compatibility proxy:', error);
    });

    // v2.8: NM was removed, so Electron mode no longer needs to spin up
    // a standalone TCP listener for the bridge. The actual ws + sse
    // endpoints live on the sidecar's HTTP server (sidecar-server.ts
    // calls attachBrowserBridge). Electron mode talks to extensions only
    // when running alongside the sidecar; no init step needed here.

    // Inject scheduled task dependencies into the proxy server
    setScheduledTaskDeps({ getScheduledTaskStore, getScheduler });

    // Set security policy
    setContentSecurityPolicy();

    // Create the window
    console.log('[Main] initApp: creating window');
    createWindow();
    console.log('[Main] initApp: window created');

    // Handle deep link carried at first launch (user clicked noobclaw:// when app was not running)
    const initialDeepLink = process.argv.find(arg => arg.startsWith('noobclaw://'));
    if (initialDeepLink && mainWindow) {
      mainWindow.webContents.once('did-finish-load', () => {
        handleDeepLink(initialDeepLink);
      });
    }

    // Auto-reconnect IM bots that were enabled before restart
    getIMGatewayManager().startAllEnabled().catch((error) => {
      console.error('[IM] Failed to auto-start enabled gateways:', error);
    });

    // Enable auto-launch by default on first startup (write the flag before setting, to avoid repeated setup after a crash)
    if (!getStore().get('auto_launch_initialized')) {
      getStore().set('auto_launch_initialized', true);
      getStore().set('auto_launch_enabled', true);
      setAutoLaunchEnabled(true);
    }

    let lastLanguage = getStore().get<AppConfigSettings>('app_config')?.language;
    let lastUseSystemProxy = getUseSystemProxyFromConfig(getStore().get<AppConfigSettings>('app_config'));
    getStore().onDidChange<AppConfigSettings>('app_config', (newConfig, oldConfig) => {
      updateTitleBarOverlay();
      // Only refresh tray menu text when the language changes
      const currentLanguage = newConfig?.language;
      if (currentLanguage !== lastLanguage) {
        lastLanguage = currentLanguage;
        updateTrayMenu(() => mainWindow, getStore());
      }

      const previousUseSystemProxy = oldConfig
        ? getUseSystemProxyFromConfig(oldConfig)
        : lastUseSystemProxy;
      const currentUseSystemProxy = getUseSystemProxyFromConfig(newConfig);
      if (currentUseSystemProxy !== previousUseSystemProxy) {
        void applyProxyPreference(currentUseSystemProxy);
      }
      lastUseSystemProxy = currentUseSystemProxy;
    });

    // On macOS, show the existing window or recreate when the dock icon is clicked
    app.on('activate', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (!mainWindow.isVisible()) mainWindow.show();
        if (!mainWindow.isFocused()) mainWindow.focus();
        return;
      }
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  };

  // Start the application
  initApp().catch(console.error);

  // Quit the application when all windows are closed
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
} 
