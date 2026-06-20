/**
 * Tauri Shim — provides window.electron compatible API using HTTP + SSE.
 * When running in Tauri, this shim replaces Electron's preload bridge.
 * Frontend code continues using window.electron.* without any changes.
 *
 * IMPORTANT: All return formats MUST match the Electron IPC handlers in main.ts.
 */

const SIDECAR_PORT = 18800;
const BASE_URL = `http://127.0.0.1:${SIDECAR_PORT}`;

// ── Detect runtime mode ──

export function isTauriMode(): boolean {
  return !!(window as any).__TAURI__;
}

// ── Open URL in OS default browser (Tauri opener plugin) ──
//
// Bug: Tauri 2.x does NOT auto-populate window.__TAURI__.opener.openUrl
// just because the Rust plugin is installed — you'd also need to install
// the @tauri-apps/plugin-opener JS bindings package, which we don't.
// So `tauri?.opener?.openUrl` was always undefined, every wallet/Web3Auth
// login fell through to window.open() → Tauri's webview popup blocker
// killed it ("popup window is blocked"). The Tauri 2 invoke path goes
// straight to the Rust plugin without needing JS bindings.
//
// Returns true if the OS browser was opened, false if neither path worked
// (caller can decide whether to fall back to the blocked window.open or
// surface a copy-link UI to the user).
async function openInSystemBrowser(url: string): Promise<boolean> {
  const tauri = (window as any).__TAURI__;
  if (!tauri) return false;
  // Tauri 2 invoke path — works as long as opener:default capability is
  // granted (it is, see src-tauri/capabilities/default.json).
  if (tauri.core?.invoke) {
    try {
      await tauri.core.invoke('plugin:opener|open_url', { url });
      return true;
    } catch (e) {
      console.warn('[TauriShim] plugin:opener|open_url invoke failed:', e);
    }
  }
  // Legacy fallback — if a future build does install the JS bindings,
  // this path lights up automatically.
  if (tauri.opener?.openUrl) {
    try { await tauri.opener.openUrl(url); return true; } catch (_) {}
  }
  return false;
}

// ── Install fetch proxy IMMEDIATELY on module load (before any other code runs) ──
// This MUST happen at the top level, not inside initTauriShim(), because
// other modules (noobclawAuth) make fetch() calls during their own import/init
// which happens before initTauriShim() is called.
if (isTauriMode()) {
  const _origFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const isStaticResource = /\.(svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf|eot|css|js)(\?|$)/i.test(url);
    const isApiCall = url.startsWith('http') && !url.includes('127.0.0.1') && !url.includes('localhost') && !isStaticResource;

    if (isApiCall) {
      try {
        const headers: Record<string, string> = {};
        if (init?.headers) {
          if (init.headers instanceof Headers) {
            init.headers.forEach((v, k) => { headers[k] = v; });
          } else if (Array.isArray(init.headers)) {
            init.headers.forEach(([k, v]) => { headers[k] = v; });
          } else {
            Object.assign(headers, init.headers);
          }
        }
        let bodyStr: string | undefined;
        if (init?.body) {
          if (typeof init.body === 'string') bodyStr = init.body;
          else { try { bodyStr = JSON.stringify(init.body); } catch { bodyStr = String(init.body); } }
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        const proxyRes = await _origFetch(`${BASE_URL}/api/proxy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({ url, method: init?.method || 'GET', headers, body: bodyStr }),
        });
        clearTimeout(timeout);
        const data = await proxyRes.json();
        let contentType = 'application/json';
        if (data.body && typeof data.body === 'string') {
          if (data.body.startsWith('<')) contentType = 'text/html';
          else if (!data.body.startsWith('{') && !data.body.startsWith('[')) contentType = 'text/plain';
        }
        return new Response(data.body ?? '', {
          status: data.status || 200,
          statusText: data.ok ? 'OK' : 'Error',
          headers: { 'Content-Type': contentType },
        });
      } catch (e) {
        console.warn('[TauriShim] Proxy fetch failed for:', url, e);
        try { return await _origFetch(input, init); } catch {}
        return new Response(JSON.stringify({ error: 'Proxy failed', url }), { status: 502, headers: { 'Content-Type': 'application/json' } });
      }
    }
    return _origFetch(input, init);
  };
}

// ── SSE Event Source for streaming ──

let eventSource: EventSource | null = null;
const eventListeners = new Map<string, Set<Function>>();

function ensureSSE(): void {
  if (eventSource) return;
  eventSource = new EventSource(`${BASE_URL}/api/stream`);

  // Generic message handler dispatches ALL event types (not just pre-registered ones)
  // This handles dynamic event types like api:stream:${id}:data
  eventSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      const listeners = eventListeners.get('message');
      if (listeners) for (const fn of listeners) fn(data);
    } catch {}
  };

  // Override addEventListener to also register on EventSource for named events
  // The sidecar sends named events like "event: cowork:stream:message\ndata: {...}\n\n"
  // We need to register listeners dynamically as they're added
}

function onSSE(event: string, callback: Function): () => void {
  ensureSSE();
  if (!eventListeners.has(event)) {
    eventListeners.set(event, new Set());
    // Register on EventSource for this specific event type
    if (eventSource) {
      eventSource.addEventListener(event, (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          const listeners = eventListeners.get(event);
          if (listeners) for (const fn of listeners) fn(data);
        } catch {}
      });
    }
  }
  eventListeners.get(event)!.add(callback);
  return () => eventListeners.get(event)?.delete(callback);
}

// ── HTTP helpers ──

async function apiGet(path: string): Promise<any> {
  try {
    const res = await fetch(`${BASE_URL}${path}`);
    return res.json();
  } catch (e) {
    console.warn(`[TauriShim] GET ${path} failed:`, e);
    return null;
  }
}

async function apiPost(path: string, body?: any): Promise<any> {
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  } catch (e) {
    console.warn(`[TauriShim] POST ${path} failed:`, e);
    return null;
  }
}

// Generic IPC invoke via HTTP
async function ipcInvoke(channel: string, ...args: any[]): Promise<any> {
  return apiPost('/api/ipc/invoke', { channel, args });
}

// ── Tauri Dialog helpers ──

async function tauriDialogOpen(opts: any): Promise<string | string[] | null> {
  try {
    const tauri = (window as any).__TAURI__;
    if (tauri?.dialog?.open) return await tauri.dialog.open(opts);
  } catch (e) { console.warn('[TauriShim] dialog.open failed:', e); }
  return null;
}

// 弹一个只读提示框(用于「部分文件超限已忽略」之类反馈)。Tauri 原生 message
// 不可用时退回 window.alert,再不行就只打日志,绝不抛错挡住主流程。
async function tauriDialogMessage(text: string, title: string): Promise<void> {
  try {
    const tauri = (window as any).__TAURI__;
    if (tauri?.dialog?.message) { await tauri.dialog.message(text, { title, kind: 'warning' }); return; }
  } catch (e) { console.warn('[TauriShim] dialog.message failed:', e); }
  try { window.alert(`${title}\n\n${text}`); } catch { /* noop */ }
}

// 选完文件后按格式 + 大小白名单校验(走 sidecar 的 video:validateMedia,
// 那里有 fs)。剔除超限文件并弹提示,返回有效路径。
async function validatePickedMedia(paths: string[], kind: 'audio' | 'video'): Promise<string[]> {
  if (!paths || paths.length === 0) return [];
  try {
    const r: any = await ipcInvoke('video:validateMedia', paths, kind);
    const valid: string[] = Array.isArray(r?.valid) ? r.valid : paths;
    const rejected: { name: string; reason: string }[] = Array.isArray(r?.rejected) ? r.rejected : [];
    if (rejected.length > 0) {
      const detail = rejected.map((x) => `· ${x.name}：${x.reason}`).join('\n');
      await tauriDialogMessage(detail, kind === 'audio' ? '背景音乐已忽略' : '部分视频已忽略');
    }
    return valid;
  } catch {
    return paths; // 校验通道异常不挡用户(主进程合成时还会 existsSync 兜底)
  }
}

// ── Build the shim ──
// Every method's return format MUST match the corresponding ipcMain.handle in main.ts

export function createTauriElectronShim(): typeof window.electron {
  return {
    platform: navigator.platform.includes('Win') ? 'win32'
      : navigator.platform.includes('Mac') ? 'darwin' : 'linux',
    arch: navigator.userAgent.includes('arm') ? 'arm64' : 'x64',

    // ── Store (KV) ──
    store: {
      get: (key: string) => ipcInvoke('store:get', key),
      set: (key: string, value: any) => ipcInvoke('store:set', key, value),
      remove: (key: string) => ipcInvoke('store:remove', key),
    },

    // ── Skills ──
    skills: {
      list: () => ipcInvoke('skills:list').then(r => r ?? { success: true, skills: [] }),
      setEnabled: (opts: any) => ipcInvoke('skills:setEnabled', opts).then(r => r ?? { success: true }),
      delete: (id: string) => ipcInvoke('skills:delete', id).then(r => r ?? { success: true }),
      download: (source: string, meta?: any) => ipcInvoke('skills:download', source, meta).then(r => r ?? { success: false, error: 'Not available in Tauri mode' }),
      getRoot: () => ipcInvoke('skills:getRoot').then(r => r ?? ''),
      autoRoutingPrompt: () => ipcInvoke('skills:autoRoutingPrompt').then(r => r ?? { success: true, prompt: '' }),
      getConfig: (id: string) => ipcInvoke('skills:getConfig', id).then(r => r ?? {}),
      setConfig: (id: string, config: any) => ipcInvoke('skills:setConfig', id, config).then(r => r ?? { success: true }),
      testEmailConnectivity: (id: string, config: any) => ipcInvoke('skills:testEmailConnectivity', id, config).then(r => r ?? { success: false }),
      onChanged: (cb: () => void) => onSSE('skills:changed', cb),
    },

    // ── MCP ──
    mcp: {
      list: () => ipcInvoke('mcp:list').then(r => r ?? []),
      create: (data: any) => ipcInvoke('mcp:create', data).then(r => r ?? { success: true }),
      update: (id: string, data: any) => ipcInvoke('mcp:update', id, data).then(r => r ?? { success: true }),
      delete: (id: string) => ipcInvoke('mcp:delete', id).then(r => r ?? { success: true }),
      setEnabled: (opts: any) => ipcInvoke('mcp:setEnabled', opts).then(r => r ?? { success: true }),
      fetchMarketplace: () => ipcInvoke('mcp:fetchMarketplace').then(r => r ?? []),
      // OAuth flow — see src/main/libs/mcpOAuth.ts. oauthBegin can block
      // up to 5 minutes while the user approves in their browser, so
      // callers should show a pending UI while waiting.
      oauthBegin: (options: any) => ipcInvoke('mcp:oauth:begin', options).then(r => r ?? { success: false }),
      oauthClear: (id: string) => ipcInvoke('mcp:oauth:clear', id).then(r => r ?? { success: false }),
    },

    // ── User slash commands + shell hooks (settings.json-driven) ──
    // Used by the composer autocomplete (slash commands) and the
    // settings view (hooks list).
    slashCommands: {
      list: () => ipcInvoke('slashCommands:list').then((r: any) => r?.commands ?? []),
      getDir: () => ipcInvoke('slashCommands:getDir').then((r: any) => r?.dir ?? null),
    },
    shellHooks: {
      list: () => ipcInvoke('shellHooks:list').then((r: any) => r?.hooks ?? {}),
    },
    toolPolicy: {
      get: () => ipcInvoke('toolPolicy:get').then((r: any) => r?.policy ?? { defaultMode: 'ask', rules: [] }),
      set: (policy: any) => ipcInvoke('toolPolicy:set', policy).then((r: any) => r?.success ?? false),
    },
    coworkConfig: {
      get: () => ipcInvoke('thinkingBudget:get').then((r: any) => ({ thinkingBudget: r?.budget ?? 10000 })),
      setThinkingBudget: (budget: number) => ipcInvoke('thinkingBudget:set', budget).then((r: any) => r?.success ?? false),
    },
    workspace: {
      listFiles: (root: string) => ipcInvoke('workspace:listFiles', root).then((r: any) => r?.entries ?? []),
    },
    searchMessages: (query: string, limit?: number) =>
      ipcInvoke('cowork:search:messages', query, limit ?? 50).then((r: any) => r?.hits ?? []),
    crashes: {
      list: () => ipcInvoke('crashes:list').then((r: any) => r?.crashes ?? []),
      getDir: () => ipcInvoke('crashes:getDir').then((r: any) => r?.dir ?? null),
      onCrash: (cb: (detail: { kind: string; message: string; file: string | null; ts: string }) => void) =>
        onSSE('system:crash', cb),
    },

    // ── Permissions ──
    permissions: {
      checkCalendar: () => Promise.resolve({ status: 'denied' }),
      requestCalendar: () => Promise.resolve({ status: 'denied' }),
    },

    // ── Scenario automation (XHS viral production etc.) ──
    scenario: {
      listScenarios: () => ipcInvoke('scenario:listScenarios').then(r => r ?? { scenarios: [] }),
      listTasks: () => ipcInvoke('scenario:listTasks').then(r => r ?? []),
      getTask: (id: string) => ipcInvoke('scenario:getTask', id),
      createTask: (input: any) => ipcInvoke('scenario:createTask', input),
      updateTask: (id: string, patch: any) => ipcInvoke('scenario:updateTask', id, patch),
      deleteTask: (id: string) => ipcInvoke('scenario:deleteTask', id),
      runTaskNow: (id: string) => ipcInvoke('scenario:runTaskNow', id).then(r => r ?? { status: 'failed', reason: 'ipc_error' }),
      uploadDraft: (taskId: string, draftId: string) => ipcInvoke('scenario:uploadDraft', { taskId, draftId }).then(r => r ?? { status: 'failed', reason: 'ipc_error' }),
      runStatus: (id: string) => ipcInvoke('scenario:runStatus', id).then(r => r ?? { runs: [], cooldown_ends_at: 0 }),
      listDrafts: (taskId?: string) => ipcInvoke('scenario:listDrafts', taskId).then(r => r ?? []),
      pushDraft: (draftId: string) => ipcInvoke('scenario:pushDraft', draftId).then(r => r ?? { status: 'failed', error: 'ipc_error' }),
      deleteDraft: (draftId: string) => ipcInvoke('scenario:deleteDraft', draftId),
      markDraftPushed: (draftId: string) => ipcInvoke('scenario:markDraftPushed', draftId),
      markDraftIgnored: (draftId: string) => ipcInvoke('scenario:markDraftIgnored', draftId),
      setActiveTask: (id: string) => ipcInvoke('scenario:setActiveTask', id),
      getActiveTask: () => ipcInvoke('scenario:getActiveTask'),
      getRunningTaskId: () => ipcInvoke('scenario:getRunningTaskId').then(r => r ?? { runningTaskId: null }),
      getRunningTaskIds: () => ipcInvoke('scenario:getRunningTaskIds').then(r => r ?? { runningTaskIds: [] }),
      getConnectedExtensions: () => ipcInvoke('scenario:getConnectedExtensions').then(r => r ?? { extensions: [] }),
      getAllRuns: () => ipcInvoke('scenario:getAllRuns').then(r => r ?? { runs: [] }),
      listRunRecords: (filter?: { task_id?: string; platform?: string }) =>
        ipcInvoke('scenario:listRunRecords', filter).then(r => r ?? { records: [] }),
      getRunRecord: (id: string) => ipcInvoke('scenario:getRunRecord', id).then(r => r ?? { record: null }),
      getTaskDir: (id: string) => ipcInvoke('scenario:getTaskDir', id).then(r => r ?? { dir: '' }),
      getRunProgress: (taskId?: string) => ipcInvoke('scenario:getRunProgress', { taskId }),
      getLatestRunRecord: (taskId: string) => ipcInvoke('scenario:getLatestRunRecord', { taskId }),
      requestAbort: (taskId?: string) => ipcInvoke('scenario:requestAbort', { taskId }).then(r => r ?? { ok: true }),
      checkXhsLogin: (platform?: 'xhs' | 'x' | 'binance' | 'tiktok' | 'youtube' | 'douyin' | 'kuaishou' | 'bilibili') =>
        ipcInvoke('scenario:checkXhsLogin', platform).then(r => r ?? { loggedIn: false, reason: 'ipc_error' }),
      openXhsLogin: (platform?: 'xhs' | 'x' | 'binance' | 'tiktok' | 'youtube' | 'douyin' | 'kuaishou' | 'bilibili') =>
        ipcInvoke('scenario:openXhsLogin', platform).then(r => r ?? { ok: false }),
      checkCreatorCenter: (platform: 'xhs' | 'douyin' | 'kuaishou' | 'bilibili') =>
        ipcInvoke('scenario:checkCreatorCenter', platform).then(r => r ?? { loggedIn: false, reason: 'ipc_error' }),
      openCreatorCenter: (platform: 'xhs' | 'douyin' | 'kuaishou' | 'bilibili') =>
        ipcInvoke('scenario:openCreatorCenter', platform).then(r => r ?? { ok: false }),
      // ── 视频发布前登录检查:之前只加进了【没用的 Electron preload.ts】,漏了【Tauri 真正用的这份 shim】
      //   → 渲染层调 window.electron.scenario.openLoginInCheckWindow 拿到 undefined → 掉进回退开多窗。
      //   走 sidecar 的 video:* channel(sidecar 才有扩展连接,task_open_tab 才到得了扩展 = 一窗一 tab)。
      checkVideoLoginByCookie: (platform: string, which?: 'main' | 'creator') =>
        ipcInvoke('video:checkLoginByCookie', platform, which),
      checkVideoLoginByCookieBatch: (items: { platform: string; which?: 'main' | 'creator' }[]) =>
        ipcInvoke('video:checkLoginByCookieBatch', items).then((r: any) => r ?? {}),
      openLoginInCheckWindow: (url: string, role?: string) =>
        ipcInvoke('video:openLoginInCheckWindow', url, role).then((r: any) => r ?? { ok: false }),
      closeLoginCheckWindow: () => ipcInvoke('video:closeLoginCheckWindow'),
    },

    // ── API proxy (for Settings provider validation) ──
    api: {
      fetch: (opts: any) => ipcInvoke('api:fetch', opts).then(r => r ?? { ok: false, status: 0, statusText: '', headers: {}, data: null }),
      stream: (opts: any) => ipcInvoke('api:stream', opts),
      cancelStream: (id: string) => ipcInvoke('api:stream:cancel', id),
      onStreamData: (id: string, cb: (chunk: string) => void) => onSSE(`api:stream:${id}:data`, cb),
      onStreamDone: (id: string, cb: () => void) => onSSE(`api:stream:${id}:done`, cb),
      onStreamError: (id: string, cb: (err: string) => void) => onSSE(`api:stream:${id}:error`, cb),
      onStreamAbort: (id: string, cb: () => void) => onSSE(`api:stream:${id}:abort`, cb),
    },

    // ── IPC Renderer ──
    ipcRenderer: {
      send: (channel: string, ...args: any[]) => { apiPost('/api/ipc/send', { channel, args }); },
      on: (channel: string, func: (...args: any[]) => void) => onSSE(channel, func),
    },

    // ── Window controls (Tauri uses native titlebar) ──
    window: {
      minimize: () => {},
      toggleMaximize: () => {},
      close: () => { try { (window as any).__TAURI__?.window?.getCurrent?.()?.close?.(); } catch {} },
      isMaximized: () => Promise.resolve(false),
      showSystemMenu: () => {},
      onStateChanged: (cb: any) => onSSE('window:state-changed', cb),
    },

    // ── API Config ──
    getApiConfig: () => apiGet('/api/apiConfig'),
    checkApiConfig: (opts?: any) => apiPost('/api/apiConfig/check', opts || {}),
    saveApiConfig: (config: any) => apiPost('/api/apiConfig/save', config),
    generateSessionTitle: (input: string | null) => ipcInvoke('generate-session-title', input).then(r => r ?? null),
    getRecentCwds: (limit?: number) => ipcInvoke('get-recent-cwds', limit).then(r => r ?? []),

    // ── Cowork ──
    cowork: {
      startSession: (opts: any) => apiPost('/api/session/start', opts),
      continueSession: (opts: any) => apiPost('/api/session/continue', opts),
      stopSession: (id: string) => apiPost('/api/session/stop', { sessionId: id }),
      deleteSession: (id: string) => apiPost('/api/session/delete', { sessionId: id }),
      deleteSessions: (ids: string[]) => apiPost('/api/session/deleteBatch', { sessionIds: ids }),
      setSessionPinned: (opts: any) => apiPost('/api/session/pin', opts),
      renameSession: (opts: any) => apiPost('/api/session/rename', opts),
      getSession: (id: string) => apiGet(`/api/session/${id}`),
      listSessions: () => apiGet('/api/sessions'),
      exportResultImage: () => Promise.resolve({ success: false }),
      captureImageChunk: () => Promise.resolve({ success: false }),
      saveResultImage: () => Promise.resolve({ success: false }),

      respondToPermission: (opts: any) => apiPost('/api/permission/respond', opts),

      // Cost / token tracking (B2d) — reads from cost_records table
      // via sidecar HTTP routes. Matches the Electron preload shape.
      getCostSummary: (range: 'today' | 'week' | 'month' | 'all') =>
        apiGet(`/api/cost/summary?range=${range}`),
      getCostHistogramDaily: (days?: number) =>
        apiGet(`/api/cost/histogram?days=${days ?? 14}`),
      getSessionCost: (sessionId: string) =>
        apiGet(`/api/cost/session?sessionId=${encodeURIComponent(sessionId)}`),

      getConfig: () => apiGet('/api/config'),
      setConfig: (config: any) => apiPost('/api/config', config),

      listMemoryEntries: (input: any) => apiPost('/api/memory/list', input),
      createMemoryEntry: (input: any) => apiPost('/api/memory/create', input),
      updateMemoryEntry: (input: any) => apiPost('/api/memory/update', input),
      deleteMemoryEntry: (input: any) => apiPost('/api/memory/delete', input),
      getMemoryStats: () => apiGet('/api/memory/stats'),

      getSandboxStatus: () => apiGet('/api/sandbox/status'),
      installSandbox: () => apiPost('/api/sandbox/install'),
      onSandboxDownloadProgress: (cb: any) => onSSE('cowork:sandbox:downloadProgress', cb),

      onStreamMessage: (cb: any) => onSSE('cowork:stream:message', cb),
      onStreamMessageUpdate: (cb: any) => onSSE('cowork:stream:messageUpdate', cb),
      onStreamMessageMetadata: (cb: any) => onSSE('cowork:stream:messageMetadata', cb),
      onStreamStuck: (cb: any) => onSSE('cowork:stream:stuck', cb),
      onStreamPermission: (cb: any) => onSSE('cowork:stream:permission', cb),
      onStreamComplete: (cb: any) => onSSE('cowork:stream:complete', cb),
      onStreamError: (cb: any) => onSSE('cowork:stream:error', cb),
    },

    // ── Dialog (Tauri native) ──
    dialog: {
      selectDirectory: async () => {
        const selected = await tauriDialogOpen({ directory: true, multiple: false });
        if (selected) return { success: true, path: typeof selected === 'string' ? selected : selected[0] };
        return { success: true, path: null };
      },
      selectFile: async (opts?: any) => {
        const filters = opts?.filters?.map((f: any) => ({ name: f.name, extensions: f.extensions }));
        const selected = await tauriDialogOpen({ directory: false, multiple: false, filters });
        if (selected) return { success: true, path: typeof selected === 'string' ? selected : selected[0] };
        return { success: true, path: null };
      },
      selectFiles: async (opts?: any) => {
        const filters = opts?.filters?.map((f: any) => ({ name: f.name, extensions: f.extensions }));
        const selected = await tauriDialogOpen({ directory: false, multiple: true, filters });
        if (selected) {
          const paths = Array.isArray(selected) ? selected : [selected];
          return { success: true, filePaths: paths };
        }
        return { success: true, filePaths: [] };
      },
      saveInlineFile: () => Promise.resolve({ success: false, error: 'Not available in Tauri mode' }),
      readFileAsDataUrl: (filePath: string) => ipcInvoke('dialog:readFileAsDataUrl', filePath).then(r => r ?? { success: false }),
    },

    // ── Multi-platform Video Creation (local synthesis) ──
    // 文件选择必须走 Tauri 原生弹窗 —— sidecar 是无 GUI 的 node 进程,弹不了框。
    // 其余重活(读图 dataURL / 合成出片 / 打开成片 / 定位文件)走 sidecar HTTP IPC,
    // 出片进度通过 SSE 'video:progress' 推回(对应 sidecar 里的 broadcastSSE)。
    video: {
      pickImages: async (max: number) => {
        const filters = [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'] }];
        const selected = await tauriDialogOpen({ directory: false, multiple: true, filters, title: '选择视频参考图' });
        if (!selected) return [];
        const paths = Array.isArray(selected) ? selected : [selected];
        return paths.slice(0, Math.max(1, Math.min(Number(max) || 3, 9)));
      },
      pickVideos: async (max: number) => {
        const filters = [{ name: 'Videos', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'] }];
        const selected = await tauriDialogOpen({ directory: false, multiple: true, filters, title: '选择本地视频素材' });
        if (!selected) return [];
        const paths = (Array.isArray(selected) ? selected : [selected])
          .slice(0, Math.max(1, Math.min(Number(max) || 8, 30)));
        return validatePickedMedia(paths, 'video');
      },
      pickAudio: async () => {
        const filters = [{ name: 'Audio', extensions: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg'] }];
        const selected = await tauriDialogOpen({ directory: false, multiple: false, filters, title: '选择背景音乐' });
        if (!selected) return '';
        const p = typeof selected === 'string' ? selected : (selected[0] || '');
        if (!p) return '';
        const valid = await validatePickedMedia([p], 'audio');
        return valid[0] || '';
      },
      readImageDataUrl: (filePath: string) => ipcInvoke('video:readImageDataUrl', filePath).then((r: any) => r ?? ''),
      resolveBgmPath: (token: string) => ipcInvoke('video:resolveBgmPath', token).then((r: any) => r ?? ''),
      generate: (input: unknown) => ipcInvoke('video:generate', input).then((r: any) => r ?? { ok: false, error: 'ipc_error' }),
      stop: (taskId: string) => ipcInvoke('video:stop', taskId).then((r: any) => r ?? { ok: false }),
      openFile: (filePath: string) => ipcInvoke('video:openFile', filePath),
      onProgress: (handler: (p: unknown) => void) => onSSE('video:progress', handler),
    },

    // ── Matrix(矩阵号:多账号同平台铺内容)──
    matrix: {
      listAccounts: () => ipcInvoke('matrix:listAccounts').then((r: any) => r ?? { ok: false }),
      createAccount: (args: unknown) => ipcInvoke('matrix:createAccount', args).then((r: any) => r ?? { ok: false }),
      setAccountProxy: (args: unknown) => ipcInvoke('matrix:setAccountProxy', args).then((r: any) => r ?? { ok: false }),
      setAccountStatus: (args: unknown) => ipcInvoke('matrix:setAccountStatus', args).then((r: any) => r ?? { ok: false }),
      setAccountKeywords: (args: unknown) => ipcInvoke('matrix:setAccountKeywords', args).then((r: any) => r ?? { ok: false }),
      removeAccount: (args: unknown) => ipcInvoke('matrix:removeAccount', args).then((r: any) => r ?? { ok: false }),
      openLogin: (args: unknown) => ipcInvoke('matrix:openLogin', args).then((r: any) => r ?? { ok: false }),
      runTask: (args: unknown) => ipcInvoke('matrix:runTask', args).then((r: any) => r ?? { ok: false }),
      runEngage: (args: unknown) => ipcInvoke('matrix:runEngage', args).then((r: any) => r ?? { ok: false }),
      buildContent: (args: unknown) => ipcInvoke('matrix:buildContent', args).then((r: any) => r ?? { ok: false }),
      selftest: (args: unknown) => ipcInvoke('matrix:selftest', args).then((r: any) => r ?? { ok: false }),
      kernelStatus: () => ipcInvoke('matrix:kernelStatus').then((r: any) => r ?? { ok: false, installed: false }),
      ensureKernel: () => ipcInvoke('matrix:ensureKernel').then((r: any) => r ?? { ok: false }),
      onProgress: (handler: (p: unknown) => void) => onSSE('matrix:progress', handler),
      onContent: (handler: (p: unknown) => void) => onSSE('matrix:content', handler),
      onKernel: (handler: (p: unknown) => void) => onSSE('matrix:kernel', handler),
    },

    // ── Shell ──
    shell: {
      openPath: (p: string) => ipcInvoke('shell:openPath', p),
      showItemInFolder: (p: string) => ipcInvoke('shell:showItemInFolder', p),
      openExternal: async (url: string) => {
        if (await openInSystemBrowser(url)) return;
        // Last-ditch fallback — almost certainly will be blocked by Tauri
        // webview, but matches Electron behavior on platforms where the
        // shell helper isn't available.
        window.open(url, '_blank');
      },
    },

    // ── Auto Launch — bridged to tauri-plugin-autostart ──
    // Settings.tsx talks to `window.electron.autoLaunch.{get,set}` which
    // on Electron hits the autoLaunchManager IPC. Under Tauri we route
    // the same calls to the autostart plugin (Mac LaunchAgent, Windows
    // registry Run key) so the user-facing toggle just works without
    // any renderer changes.
    autoLaunch: {
      get: async () => {
        try {
          const tauri = (window as any).__TAURI__;
          const enabled = await tauri?.autostart?.isEnabled?.();
          return { enabled: !!enabled };
        } catch (e) {
          console.warn('[TauriShim] autostart.isEnabled failed:', e);
          return { enabled: false };
        }
      },
      set: async (enabled: boolean) => {
        try {
          const tauri = (window as any).__TAURI__;
          if (enabled) {
            await tauri?.autostart?.enable?.();
          } else {
            await tauri?.autostart?.disable?.();
          }
          return { success: true };
        } catch (e: any) {
          console.warn('[TauriShim] autostart toggle failed:', e);
          return { success: false, error: String(e?.message || e) };
        }
      },
    },

    // ── App Info ──
    appInfo: {
      getVersion: () => apiGet('/api/version').then((r: any) => r?.version || '1.0.0'),
      getSystemLocale: () => Promise.resolve(navigator.language),
    },

    // ── App Update ──
    //
    // Tauri intentionally does NOT do in-app auto-updates. Every
    // `appUpdate.download(url)` call is redirected into the OS browser
    // (same path shell.openExternal takes), so users always download the
    // new installer the same way they did the first one and run it
    // manually. This mirrors the "fallback page" code path that App.tsx
    // already uses when the update endpoint returns a non-direct URL —
    // we just make it unconditional for Tauri. No signing keys, no
    // backend manifest, no Tauri updater plugin, no mystery binary
    // replacement. The Electron build keeps its in-app downloader; only
    // Tauri users follow the manual reinstall flow.
    appUpdate: {
      download: async (url?: string) => {
        if (!url) return { success: false, error: 'No download URL' };
        try {
          if (!(await openInSystemBrowser(url))) window.open(url, '_blank');
          // Return success with no filePath so App.tsx's handleConfirmUpdate
          // treats it as an externally-handled download and skips the
          // install() step below.
          return { success: true, filePath: null };
        } catch (e: any) {
          return { success: false, error: e?.message || 'Failed to open download URL' };
        }
      },
      cancelDownload: () => Promise.resolve(),
      // Install is a no-op in Tauri — the installer the user just downloaded
      // handles everything itself. Returning success keeps the UI happy.
      install: () => Promise.resolve({ success: true }),
      onDownloadProgress: () => () => {},
    },

    // ── Log ──
    log: {
      getPath: () => ipcInvoke('log:getPath'),
      openFolder: () => ipcInvoke('log:openFolder'),
      exportZip: () => Promise.resolve({ success: false }),
    },

    // ── IM Gateway ──
    im: {
      getConfig: () => ipcInvoke('im:config:get').then(r => r ?? {}),
      setConfig: (config: any) => ipcInvoke('im:config:set', config).then(r => r ?? { success: true }),
      startGateway: (platform: string) => ipcInvoke('im:gateway:start', platform).then(r => r ?? { success: false }),
      stopGateway: (platform: string) => ipcInvoke('im:gateway:stop', platform).then(r => r ?? { success: true }),
      testGateway: (platform: string, override?: any) => ipcInvoke('im:gateway:test', platform, override).then(r => r ?? { success: false }),
      getStatus: () => ipcInvoke('im:status:get').then(r => r ?? {}),
      onStatusChange: (cb: any) => onSSE('im:status:change', cb),
      onMessageReceived: (cb: any) => onSSE('im:message:received', cb),
    },

    // ── Scheduled Tasks ──
    scheduledTasks: {
      list: () => ipcInvoke('scheduledTask:list').then(r => r ?? []),
      get: (id: string) => ipcInvoke('scheduledTask:get', id).then(r => r ?? null),
      create: (input: any) => ipcInvoke('scheduledTask:create', input).then(r => r ?? { success: false }),
      update: (id: string, input: any) => ipcInvoke('scheduledTask:update', id, input).then(r => r ?? { success: false }),
      delete: (id: string) => ipcInvoke('scheduledTask:delete', id).then(r => r ?? { success: true }),
      toggle: (id: string, enabled: boolean) => ipcInvoke('scheduledTask:toggle', id, enabled).then(r => r ?? { success: true }),
      runManually: (id: string) => ipcInvoke('scheduledTask:runManually', id).then(r => r ?? { success: false }),
      stop: (id: string) => ipcInvoke('scheduledTask:stop', id).then(r => r ?? { success: true }),
      listRuns: (taskId: string, limit?: number, offset?: number) =>
        ipcInvoke('scheduledTask:listRuns', taskId, limit, offset).then(r => r ?? []),
      countRuns: (taskId: string) => ipcInvoke('scheduledTask:countRuns', taskId).then(r => r ?? 0),
      listAllRuns: (limit?: number, offset?: number) =>
        ipcInvoke('scheduledTask:listAllRuns', limit, offset).then(r => r ?? []),
      onStatusUpdate: (cb: any) => onSSE('scheduledTask:statusUpdate', cb),
      onRunUpdate: (cb: any) => onSSE('scheduledTask:runUpdate', cb),
    },

    // ── Network Status ──
    networkStatus: {
      send: (status: string) => { apiPost('/api/ipc/send', { channel: 'network:status-change', args: [status] }); },
    },

    // ── Auth ──
    onAuthCallback: (cb: (token: string, wallet: string, email?: string, socialProvider?: string) => void) =>
      onSSE('auth:callback', (data: any) => cb(data?.token, data?.wallet, data?.email, data?.socialProvider)),

    // ── NoobClaw Platform ──
    noobclaw: {
      setAuthToken: (token: string | null) => ipcInvoke('noobclaw:set-auth-token', token),
      getMacAddress: () => ipcInvoke('noobclaw:get-mac-address').then(r => r ?? null),
      cacheAvatar: (url: string) => ipcInvoke('noobclaw:cache-avatar', url).then(r => r ?? { success: false, localPath: null }),
      getCachedAvatar: () => ipcInvoke('noobclaw:get-cached-avatar').then(r => r ?? null),
      onSsePayload: (cb: any) => onSSE('noobclaw:sse-payload', cb),
    },
  } as any;
}

// ── Extension Install Modal (Store + Cancel only) ──
// Local-install path was retired once the extension shipped on the
// Chrome / Firefox / Edge stores. The standalone chrome-extension folder
// is no longer bundled in the app package.

function showExtensionInstallModal(storeUrl: string): Promise<'install' | 'cancel'> {
  return new Promise((resolve) => {
    const isZh = navigator.language.startsWith('zh');

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:999999;display:flex;align-items:center;justify-content:center;';

    const modal = document.createElement('div');
    modal.style.cssText = 'background:#1a1a2e;border:1px solid #333;border-radius:12px;padding:24px;max-width:480px;width:90%;color:#e8e8ff;font-family:system-ui;';

    modal.innerHTML = `
      <h2 style="margin:0 0 8px;font-size:18px;">${isZh ? '🦀 NoobClaw 浏览器助手' : '🦀 NoobClaw Browser Assistant'}</h2>
      <p style="margin:0 0 16px;font-size:14px;color:#a5a5ff;">${isZh ? '启用 AI 浏览器自动化' : 'Enable AI Browser Automation'}</p>
      <p style="margin:0 0 20px;font-size:13px;line-height:1.6;color:#ccc;">${isZh
        ? '安装 NoobClaw 浏览器助手，让 AI 像真人一样操控您的浏览器。\n\n• AI 像真人一样操作浏览器 — 不会被网站检测\n• 使用您已登录的账号（社交媒体、邮箱等）\n• 全天候 24 小时自动化浏览和数据采集\n• 所有数据留在本地，不会发送到外部服务器'
        : 'Install the NoobClaw Browser Assistant to let AI control your browser.\n\n• AI operates like a real person — no bot detection\n• Works with your logged-in accounts\n• 24/7 automated browsing and data collection\n• All data stays local'
      }</p>
      <div style="display:flex;flex-direction:column;gap:8px;">
        <button id="nc-ext-store" style="padding:10px 16px;border-radius:8px;border:none;background:#6366f1;color:white;font-size:14px;cursor:pointer;font-weight:500;">${isZh ? '从 Chrome 商店安装' : 'Install from Chrome Store'}</button>
        <button id="nc-ext-cancel" style="padding:10px 16px;border-radius:8px;border:none;background:transparent;color:#888;font-size:13px;cursor:pointer;">${isZh ? '暂不安装' : 'Not Now'}</button>
      </div>
    `;

    // Replace \n with <br> in description
    const desc = modal.querySelector('p:nth-of-type(2)');
    if (desc) desc.innerHTML = desc.innerHTML.replace(/\n/g, '<br>');

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const cleanup = () => { try { document.body.removeChild(overlay); } catch {} };

    modal.querySelector('#nc-ext-store')!.addEventListener('click', () => {
      cleanup();
      // Open Chrome Store
      void openInSystemBrowser(storeUrl).then((ok) => {
        if (!ok) window.open(storeUrl, '_blank');
      });
      resolve('install');
    });

    modal.querySelector('#nc-ext-cancel')!.addEventListener('click', () => {
      cleanup();
      resolve('cancel');
    });

    // Close on overlay click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { cleanup(); resolve('cancel'); }
    });
  });
}

// ── Initialize shim ──

export function initTauriShim(): void {
  if (!isTauriMode()) return;

  console.log('[TauriShim] Tauri detected, installing electron shim');
  (window as any).electron = createTauriElectronShim();

  // Intercept window.open — prevent new Tauri windows, open in system browser instead
  const originalWindowOpen = window.open.bind(window);
  window.open = (url?: string | URL, target?: string, features?: string): WindowProxy | null => {
    if (url) {
      const urlStr = typeof url === 'string' ? url : url.toString();
      // Open external URLs in system browser, not a new Tauri window
      if (urlStr.startsWith('http')) {
        void openInSystemBrowser(urlStr).then((ok) => {
          if (!ok) originalWindowOpen(urlStr, '_blank');
        });
        return null;
      }
    }
    return originalWindowOpen(url, target, features);
  };

  // Disable right-click context menu in Tauri (production only)
  document.addEventListener('contextmenu', (e) => {
    // Allow right-click in text inputs/textareas for copy/paste
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
    e.preventDefault();
  });

  // Fetch proxy is installed at module level (top of file) — no duplicate here.

  // Listen for browser extension install prompt from sidecar
  onSSE('extension:install-prompt', async (data: any) => {
    const { requestId, storeUrl } = data || {};
    if (!requestId) return;

    // Show custom modal with 3 options (matching Electron version)
    const choice = await showExtensionInstallModal(storeUrl);

    // Send response back to sidecar
    fetch(`${BASE_URL}/api/ipc/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'extension:prompt-response', args: [requestId, choice] }),
    }).catch(() => {});
  });

  // Listen for deep link auth callback from Tauri
  // (noobclaw://auth?token=xxx&wallet=xxx&email=...&socialProvider=...)
  window.addEventListener('noobclaw-auth', ((e: CustomEvent) => {
    const { token, wallet, email, socialProvider } = e.detail || {};
    if (token && wallet) {
      console.log('[TauriShim] Auth callback received from deep link');
      const listeners = eventListeners.get('auth:callback');
      if (listeners) {
        for (const fn of listeners) fn({ token, wallet, email, socialProvider });
      }
    }
  }) as EventListener);

  // ── Dock badge + notifications wired to cowork SSE events ──
  //
  // While an AI session is running we show a "●" badge on the
  // NoobClaw Dock icon (macOS only; Tauri command is a no-op on
  // Windows/Linux). When the session completes or errors we clear
  // the badge and fire a system notification so the user knows the
  // background task finished even if the window is hidden.
  const runningSessionIds = new Set<string>();
  const updateDockBadge = () => {
    try {
      const tauri = (window as any).__TAURI__;
      const count = runningSessionIds.size;
      const label = count > 0 ? (count === 1 ? '●' : String(count)) : null;
      tauri?.core?.invoke?.('set_dock_badge', { label });
    } catch { /* ignore */ }
  };
  const notifyComplete = (title: string, body: string) => {
    try {
      const notif = (window as any).__TAURI__?.notification;
      if (!notif?.sendNotification) return;
      // Best-effort permission check. Tauri's JS API resolves
      // sendNotification synchronously if permission was already
      // granted; on first call it may prompt.
      const doSend = () => notif.sendNotification({ title, body });
      if (notif.isPermissionGranted) {
        Promise.resolve(notif.isPermissionGranted())
          .then((granted: boolean) => {
            if (granted) return doSend();
            if (notif.requestPermission) {
              return Promise.resolve(notif.requestPermission()).then((p: string) => {
                if (p === 'granted') doSend();
              });
            }
          })
          .catch(() => {});
      } else {
        doSend();
      }
    } catch { /* ignore */ }
  };

  // Track which sessions are currently running by watching for the
  // first stream event of each sessionId and the terminal complete/
  // error events. Drives the Dock badge above.
  const onSessionProgress = (sessionId: string) => {
    if (!sessionId || runningSessionIds.has(sessionId)) return;
    runningSessionIds.add(sessionId);
    updateDockBadge();
  };
  const onSessionEnd = (sessionId: string, kind: 'complete' | 'error') => {
    if (!sessionId) return;
    if (runningSessionIds.delete(sessionId)) {
      updateDockBadge();
    }
    if (kind === 'complete') {
      notifyComplete('NoobClaw', 'AI task finished');
    } else {
      notifyComplete('NoobClaw', 'AI task failed');
    }
  };
  onSSE('cowork:stream:message', (data: any) => onSessionProgress(data?.sessionId));
  onSSE('cowork:stream:messageUpdate', (data: any) => onSessionProgress(data?.sessionId));
  onSSE('cowork:stream:complete', (data: any) => onSessionEnd(data?.sessionId, 'complete'));
  onSSE('cowork:stream:error', (data: any) => onSessionEnd(data?.sessionId, 'error'));

  // Stuck watchdog — long-silent sessions surface as a desktop
  // notification so unattended users come back and see why something
  // stalled. The in-app system message is already appended by the
  // sidecar (see runStuckWatchdog in coworkRunner.ts).
  onSSE('cowork:stream:stuck', (data: any) => {
    const minutes = Math.round((Number(data?.idleMs) || 0) / 60_000);
    notifyComplete('NoobClaw', `会话 ${minutes} 分钟无进展 — 可能卡住了`);
  });

  // System power events from the sidecar (Mac Sleep/Wake) — show a
  // short toast so the user understands why an in-flight AI task
  // suddenly stopped.
  onSSE('system:will-sleep', () => {
    console.log('[TauriShim] system willSleep — active sessions paused');
  });
  onSSE('system:did-wake', () => {
    console.log('[TauriShim] system didWake');
  });

  // Native drag&drop from Finder — Rust side (src-tauri/src/lib.rs)
  // captures the WindowEvent::DragDrop and re-fires a custom
  // `nc://file-drop` event on window with { detail: { paths: [...] } }.
  // We bridge that to an `electron.onFileDrop` listener registration
  // so the cowork composer (or whoever wants to consume it) can just:
  //     window.electron.onFileDrop((paths) => ...)
  // Same API shape we can later implement for Electron if needed.
  const fileDropListeners = new Set<(paths: string[]) => void>();
  window.addEventListener('nc://file-drop', ((e: CustomEvent) => {
    const paths: string[] = Array.isArray(e.detail?.paths) ? e.detail.paths : [];
    if (paths.length === 0) return;
    for (const fn of fileDropListeners) {
      try { fn(paths); } catch (err) {
        console.warn('[TauriShim] file-drop listener threw:', err);
      }
    }
  }) as EventListener);
  (window as any).electron.onFileDrop = (cb: (paths: string[]) => void) => {
    fileDropListeners.add(cb);
    return () => fileDropListeners.delete(cb);
  };

  // Sidecar health probe — on macOS Tauri builds we had recurring
  // reports that chat and lucky bag content never appeared. Almost
  // always this turns out to be a sidecar-side failure (TLS cert store
  // missing, pkg binary not executable, port conflict, etc.) that
  // leaves the renderer with a broken EventSource and no visible
  // signal. Ping /api/status and /api/diagnostic at startup and show a
  // persistent banner when the probe fails so the user sees *something*
  // actionable instead of a silent empty UI.
  probeSidecarHealth();
}

async function probeSidecarHealth(): Promise<void> {
  // Retry budget: ~14s worst case, ~5s if the sidecar is hard-dead
  // (connection refused throws immediately). The sidecar on macOS can
  // take a few seconds to cold-start (codesign + launchservices + Node
  // init) and the first probe may legitimately race startup, so the
  // banner would flash on a healthy boot if we only tried once.
  //
  //   attempts=6, timeout=1500ms, interval=1000ms
  //   hard-dead: 0 + 5*1000 = 5s
  //   hanging:   6*1500 + 5*1000 = 14s
  const attempts = 6;
  const fetchTimeoutMs = 1500;
  const intervalMs = 1000;
  let lastDetail = '';
  for (let i = 0; i < attempts; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
      const res = await fetch(`${BASE_URL}/api/status`, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        console.log(`[TauriShim] Sidecar health: ok (attempt ${i + 1})`);
        return;
      }
      lastDetail = `HTTP ${res.status}`;
    } catch (e: any) {
      lastDetail = String(e?.message || e);
    }
    console.log(`[TauriShim] Sidecar health: attempt ${i + 1}/${attempts} failed — ${lastDetail}`);
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, intervalMs));
  }

  // Diagnostic only — intentionally NEVER surface a UI banner to the user.
  // The sidecar self-heals port conflicts at startup (see killPortHolders in
  // sidecar-server.ts), so a transient failed probe must not block or alarm
  // the user. We just log it for support; by the time the user interacts the
  // sidecar is virtually always up.
  console.error('[TauriShim] sidecar health probe failed after retries:', lastDetail);
}
