import { contextBridge, ipcRenderer } from 'electron';

// Expose safe APIs to the renderer process
contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  arch: process.arch,
  store: {
    get: (key: string) => ipcRenderer.invoke('store:get', key),
    set: (key: string, value: any) => ipcRenderer.invoke('store:set', key, value),
    remove: (key: string) => ipcRenderer.invoke('store:remove', key),
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    setEnabled: (options: { id: string; enabled: boolean }) => ipcRenderer.invoke('skills:setEnabled', options),
    delete: (id: string) => ipcRenderer.invoke('skills:delete', id),
    download: (source: string, meta?: { official?: boolean; skillId?: string }) => ipcRenderer.invoke('skills:download', source, meta),
    getRoot: () => ipcRenderer.invoke('skills:getRoot'),
    autoRoutingPrompt: () => ipcRenderer.invoke('skills:autoRoutingPrompt'),
    getConfig: (skillId: string) => ipcRenderer.invoke('skills:getConfig', skillId),
    setConfig: (skillId: string, config: Record<string, string>) => ipcRenderer.invoke('skills:setConfig', skillId, config),
    testEmailConnectivity: (skillId: string, config: Record<string, string>) =>
      ipcRenderer.invoke('skills:testEmailConnectivity', skillId, config),
    onChanged: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('skills:changed', handler);
      return () => ipcRenderer.removeListener('skills:changed', handler);
    },
  },
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    create: (data: any) => ipcRenderer.invoke('mcp:create', data),
    update: (id: string, data: any) => ipcRenderer.invoke('mcp:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('mcp:delete', id),
    setEnabled: (options: { id: string; enabled: boolean }) => ipcRenderer.invoke('mcp:setEnabled', options),
    fetchMarketplace: () => ipcRenderer.invoke('mcp:fetchMarketplace'),
    // OAuth 2.0 authorization-code flow for MCP servers that expose an
    // OAuth endpoint (e.g. Claude Code's remote MCP servers). Begin opens
    // the authorize URL in the system browser and waits for the loopback
    // callback; clear wipes stored tokens while keeping the provider
    // metadata so the user can re-authorize without re-entering config.
    oauthBegin: (options: {
      id: string;
      authorizeUrl: string;
      tokenUrl: string;
      clientId: string;
      clientSecret?: string;
      scope?: string;
    }) => ipcRenderer.invoke('mcp:oauth:begin', options),
    oauthClear: (id: string) => ipcRenderer.invoke('mcp:oauth:clear', id),
  },
  permissions: {
    checkCalendar: () => ipcRenderer.invoke('permissions:checkCalendar'),
    requestCalendar: () => ipcRenderer.invoke('permissions:requestCalendar'),
  },
  scenario: {
    // Catalogue
    listScenarios: () => ipcRenderer.invoke('scenario:listScenarios'),
    // Tasks
    listTasks: () => ipcRenderer.invoke('scenario:listTasks'),
    getTask: (id: string) => ipcRenderer.invoke('scenario:getTask', id),
    createTask: (input: unknown) => ipcRenderer.invoke('scenario:createTask', input),
    updateTask: (id: string, patch: unknown) => ipcRenderer.invoke('scenario:updateTask', id, patch),
    deleteTask: (id: string) => ipcRenderer.invoke('scenario:deleteTask', id),
    runTaskNow: (id: string) => ipcRenderer.invoke('scenario:runTaskNow', id),
    runStatus: (id: string) => ipcRenderer.invoke('scenario:runStatus', id),
    // Drafts
    listDrafts: (taskId?: string) => ipcRenderer.invoke('scenario:listDrafts', taskId),
    pushDraft: (draftId: string) => ipcRenderer.invoke('scenario:pushDraft', draftId),
    deleteDraft: (draftId: string) => ipcRenderer.invoke('scenario:deleteDraft', draftId),
    markDraftPushed: (draftId: string) => ipcRenderer.invoke('scenario:markDraftPushed', draftId),
    markDraftIgnored: (draftId: string) => ipcRenderer.invoke('scenario:markDraftIgnored', draftId),
    // XHS login gate
    setActiveTask: (id: string) => ipcRenderer.invoke('scenario:setActiveTask', id),
    getActiveTask: () => ipcRenderer.invoke('scenario:getActiveTask'),
    getRunningTaskId: () => ipcRenderer.invoke('scenario:getRunningTaskId'),
    /** Twitter v1 concurrency: ALL running task ids (legacy returns just the first). */
    getRunningTaskIds: () => ipcRenderer.invoke('scenario:getRunningTaskIds'),
    /** Connected browser extensions (one per Chrome instance). Used to
     *  detect outdated extension versions and prompt the user to update. */
    getConnectedExtensions: () => ipcRenderer.invoke('scenario:getConnectedExtensions'),
    /** Aggregate runs across all tasks for the unified Run History page. */
    getAllRuns: () => ipcRenderer.invoke('scenario:getAllRuns'),
    /** Rich run records (v2.4.22+) — full step logs + task snapshot. */
    listRunRecords: (filter?: { task_id?: string; platform?: string }) =>
      ipcRenderer.invoke('scenario:listRunRecords', filter),
    getRunRecord: (id: string) => ipcRenderer.invoke('scenario:getRunRecord', id),
    getRunProgress: (taskId?: string) => ipcRenderer.invoke('scenario:getRunProgress', taskId),
    getLatestRunRecord: (taskId: string) => ipcRenderer.invoke('scenario:getLatestRunRecord', taskId),
    requestAbort: (taskId?: string) => ipcRenderer.invoke('scenario:requestAbort', taskId),
    checkXhsLogin: (platform?: 'xhs' | 'x' | 'binance' | 'tiktok' | 'youtube' | 'douyin' | 'kuaishou' | 'bilibili' | 'shipinhao' | 'toutiao') => ipcRenderer.invoke('scenario:checkXhsLogin', platform),
    openXhsLogin: (platform?: 'xhs' | 'x' | 'binance' | 'tiktok' | 'youtube' | 'douyin' | 'kuaishou' | 'bilibili' | 'shipinhao' | 'toutiao') => ipcRenderer.invoke('scenario:openXhsLogin', platform),
    checkCreatorCenter: (platform: 'xhs' | 'douyin' | 'kuaishou' | 'bilibili' | 'shipinhao' | 'toutiao') => ipcRenderer.invoke('scenario:checkCreatorCenter', platform),
    openCreatorCenter: (platform: 'xhs' | 'douyin' | 'kuaishou' | 'bilibili' | 'shipinhao' | 'toutiao') => ipcRenderer.invoke('scenario:openCreatorCenter', platform),
    checkVideoLoginByCookie: (platform: string, which?: 'main' | 'creator') => ipcRenderer.invoke('video:checkLoginByCookie', platform, which),
    checkVideoLoginByCookieBatch: (items: { platform: string; which?: 'main' | 'creator' }[]) => ipcRenderer.invoke('video:checkLoginByCookieBatch', items),
    openLoginInCheckWindow: (url: string, role?: string) => ipcRenderer.invoke('video:openLoginInCheckWindow', url, role),
    closeLoginCheckWindow: () => ipcRenderer.invoke('video:closeLoginCheckWindow'),
    uploadCnyQr: (args: { path: string; name?: string; backendUrl: string; headers: Record<string, string> }) => ipcRenderer.invoke('video:uploadCnyQr', args),
  },
  // ── Multi-platform Video Creation (phase 1: local synthesis) ──
  video: {
    /** Start one local render job. Resolves with the final result. */
    generate: (input: unknown) => ipcRenderer.invoke('video:generate', input),
    /** Stop a running render job by taskId — aborts the pipeline + SIGKILLs ffmpeg/seedance/tts. */
    stop: (taskId: string) => ipcRenderer.invoke('video:stop', taskId),
    /** Open the system file picker to choose reference images (returns abs paths). */
    pickImages: (max: number) => ipcRenderer.invoke('video:pickImages', max),
    /** Open the system file picker to choose local video material (returns abs paths). */
    pickVideos: (max: number) => ipcRenderer.invoke('video:pickVideos', max),
    /** Local remix: pick a local material folder; returns { dir, videoCount, imageCount } or null. */
    pickLocalFolder: () => ipcRenderer.invoke('video:pickLocalFolder'),
    /** Local remix: re-scan a folder for video/image counts. */
    scanLocalFolder: (dir: string) => ipcRenderer.invoke('video:scanLocalFolder', dir),
    /** Read a local image file as a data: URL for thumbnail preview. */
    readImageDataUrl: (filePath: string) => ipcRenderer.invoke('video:readImageDataUrl', filePath),
    /** Open the system file picker to choose one background-music file (returns abs path or ''). */
    pickAudio: () => ipcRenderer.invoke('video:pickAudio'),
    /** Resolve a BGM token to its local absolute path (downloads cloud tracks on first use) so the renderer can reveal it in the file manager. */
    resolveBgmPath: (token: string) => ipcRenderer.invoke('video:resolveBgmPath', token),
    /** Open a produced file with the OS default player. */
    openFile: (filePath: string) => ipcRenderer.invoke('video:openFile', filePath),
    /** Subscribe to per-job progress events. Returns an unsubscribe fn. */
    onProgress: (callback: (progress: unknown) => void) => {
      const handler = (_event: unknown, progress: unknown) => callback(progress);
      ipcRenderer.on('video:progress', handler);
      return () => ipcRenderer.removeListener('video:progress', handler);
    },
  },
  api: {
    // Regular API request (non-streaming)
    fetch: (options: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }) => ipcRenderer.invoke('api:fetch', options),

    // Streaming API request
    stream: (options: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
      requestId: string;
    }) => ipcRenderer.invoke('api:stream', options),

    // Cancel streaming request
    cancelStream: (requestId: string) => ipcRenderer.invoke('api:stream:cancel', requestId),

    // Listen for streaming data
    onStreamData: (requestId: string, callback: (chunk: string) => void) => {
      const handler = (_event: any, chunk: string) => callback(chunk);
      ipcRenderer.on(`api:stream:${requestId}:data`, handler);
      return () => ipcRenderer.removeListener(`api:stream:${requestId}:data`, handler);
    },

    // Listen for streaming completion
    onStreamDone: (requestId: string, callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(`api:stream:${requestId}:done`, handler);
      return () => ipcRenderer.removeListener(`api:stream:${requestId}:done`, handler);
    },

    // Listen for streaming errors
    onStreamError: (requestId: string, callback: (error: string) => void) => {
      const handler = (_event: any, error: string) => callback(error);
      ipcRenderer.on(`api:stream:${requestId}:error`, handler);
      return () => ipcRenderer.removeListener(`api:stream:${requestId}:error`, handler);
    },

    // Listen for streaming abort
    onStreamAbort: (requestId: string, callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(`api:stream:${requestId}:abort`, handler);
      return () => ipcRenderer.removeListener(`api:stream:${requestId}:abort`, handler);
    },
  },
  ipcRenderer: {
    send: (channel: string, ...args: any[]) => {
      ipcRenderer.send(channel, ...args);
    },
    on: (channel: string, func: (...args: any[]) => void) => {
      const handler = (_event: any, ...args: any[]) => func(...args);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
  },
  window: {
    minimize: () => ipcRenderer.send('window-minimize'),
    toggleMaximize: () => ipcRenderer.send('window-maximize'),
    close: () => ipcRenderer.send('window-close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    showSystemMenu: (position: { x: number; y: number }) => ipcRenderer.send('window:showSystemMenu', position),
    onStateChanged: (callback: (state: { isMaximized: boolean; isFullscreen: boolean; isFocused: boolean }) => void) => {
      const handler = (_event: any, state: { isMaximized: boolean; isFullscreen: boolean; isFocused: boolean }) => callback(state);
      ipcRenderer.on('window:state-changed', handler);
      return () => ipcRenderer.removeListener('window:state-changed', handler);
    },
  },
  getApiConfig: () => ipcRenderer.invoke('get-api-config'),
  checkApiConfig: (options?: { probeModel?: boolean }) => ipcRenderer.invoke('check-api-config', options),
  saveApiConfig: (config: { apiKey: string; baseURL: string; model: string; apiType?: 'anthropic' | 'openai' }) =>
    ipcRenderer.invoke('save-api-config', config),
  generateSessionTitle: (userInput: string | null) =>
    ipcRenderer.invoke('generate-session-title', userInput),
  getRecentCwds: (limit?: number) =>
    ipcRenderer.invoke('get-recent-cwds', limit),
  cowork: {
    // Session management
    startSession: (options: { prompt: string; cwd?: string; systemPrompt?: string; activeSkillIds?: string[]; imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }> }) =>
      ipcRenderer.invoke('cowork:session:start', options),
    continueSession: (options: { sessionId: string; prompt: string; systemPrompt?: string; activeSkillIds?: string[]; imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }> }) =>
      ipcRenderer.invoke('cowork:session:continue', options),
    stopSession: (sessionId: string) =>
      ipcRenderer.invoke('cowork:session:stop', sessionId),
    deleteSession: (sessionId: string) =>
      ipcRenderer.invoke('cowork:session:delete', sessionId),
    deleteSessions: (sessionIds: string[]) =>
      ipcRenderer.invoke('cowork:session:deleteBatch', sessionIds),
    setSessionPinned: (options: { sessionId: string; pinned: boolean }) =>
      ipcRenderer.invoke('cowork:session:pin', options),
    renameSession: (options: { sessionId: string; title: string }) =>
      ipcRenderer.invoke('cowork:session:rename', options),
    getSession: (sessionId: string) =>
      ipcRenderer.invoke('cowork:session:get', sessionId),
    listSessions: () =>
      ipcRenderer.invoke('cowork:session:list'),
    exportResultImage: (options: { rect: { x: number; y: number; width: number; height: number }; defaultFileName?: string }) =>
      ipcRenderer.invoke('cowork:session:exportResultImage', options),
    captureImageChunk: (options: { rect: { x: number; y: number; width: number; height: number } }) =>
      ipcRenderer.invoke('cowork:session:captureImageChunk', options),
    saveResultImage: (options: { pngBase64: string; defaultFileName?: string }) =>
      ipcRenderer.invoke('cowork:session:saveResultImage', options),

    // Permission handling
    respondToPermission: (options: { requestId: string; result: any }) =>
      ipcRenderer.invoke('cowork:permission:respond', options),

    // Cost / token usage stats (B2d) — raw token aggregates, no currency
    getCostSummary: (range: 'today' | 'week' | 'month' | 'all') =>
      ipcRenderer.invoke('cowork:cost:summary', range),
    getCostHistogramDaily: (days?: number) =>
      ipcRenderer.invoke('cowork:cost:histogram', days ?? 14),
    getSessionCost: (sessionId: string) =>
      ipcRenderer.invoke('cowork:cost:session', sessionId),

    // Configuration
    getConfig: () =>
      ipcRenderer.invoke('cowork:config:get'),
    setConfig: (config: {
      workingDirectory?: string;
      executionMode?: 'auto' | 'local' | 'sandbox';
      memoryEnabled?: boolean;
      memoryImplicitUpdateEnabled?: boolean;
      memoryLlmJudgeEnabled?: boolean;
      memoryGuardLevel?: 'strict' | 'standard' | 'relaxed';
      memoryUserMemoriesMaxItems?: number;
      dangerouslySkipPermissions?: boolean;
    }) =>
      ipcRenderer.invoke('cowork:config:set', config),
    listMemoryEntries: (input: {
      query?: string;
      status?: 'created' | 'stale' | 'deleted' | 'all';
      includeDeleted?: boolean;
      limit?: number;
      offset?: number;
    }) =>
      ipcRenderer.invoke('cowork:memory:listEntries', input),
    createMemoryEntry: (input: {
      text: string;
      confidence?: number;
      isExplicit?: boolean;
    }) =>
      ipcRenderer.invoke('cowork:memory:createEntry', input),
    updateMemoryEntry: (input: {
      id: string;
      text?: string;
      confidence?: number;
      status?: 'created' | 'stale' | 'deleted';
      isExplicit?: boolean;
    }) =>
      ipcRenderer.invoke('cowork:memory:updateEntry', input),
    deleteMemoryEntry: (input: { id: string }) =>
      ipcRenderer.invoke('cowork:memory:deleteEntry', input),
    getMemoryStats: () =>
      ipcRenderer.invoke('cowork:memory:getStats'),
    getSandboxStatus: () =>
      ipcRenderer.invoke('cowork:sandbox:status'),
    installSandbox: () =>
      ipcRenderer.invoke('cowork:sandbox:install'),
    onSandboxDownloadProgress: (callback: (data: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('cowork:sandbox:downloadProgress', handler);
      return () => ipcRenderer.removeListener('cowork:sandbox:downloadProgress', handler);
    },
    // Stream event listeners
    onStreamMessage: (callback: (data: { sessionId: string; message: any }) => void) => {
      const handler = (_event: any, data: { sessionId: string; message: any }) => callback(data);
      ipcRenderer.on('cowork:stream:message', handler);
      return () => ipcRenderer.removeListener('cowork:stream:message', handler);
    },
    onStreamMessageUpdate: (callback: (data: { sessionId: string; messageId: string; content: string }) => void) => {
      const handler = (_event: any, data: { sessionId: string; messageId: string; content: string }) => callback(data);
      ipcRenderer.on('cowork:stream:messageUpdate', handler);
      return () => ipcRenderer.removeListener('cowork:stream:messageUpdate', handler);
    },
    onStreamMessageMetadata: (callback: (data: { sessionId: string; messageId: string; metadata: Record<string, unknown> }) => void) => {
      const handler = (_event: any, data: { sessionId: string; messageId: string; metadata: Record<string, unknown> }) => callback(data);
      ipcRenderer.on('cowork:stream:messageMetadata', handler);
      return () => ipcRenderer.removeListener('cowork:stream:messageMetadata', handler);
    },
    onStreamStuck: (callback: (data: { sessionId: string; idleMs: number }) => void) => {
      const handler = (_event: any, data: { sessionId: string; idleMs: number }) => callback(data);
      ipcRenderer.on('cowork:stream:stuck', handler);
      return () => ipcRenderer.removeListener('cowork:stream:stuck', handler);
    },
    onStreamPermission: (callback: (data: { sessionId: string; request: any }) => void) => {
      const handler = (_event: any, data: { sessionId: string; request: any }) => callback(data);
      ipcRenderer.on('cowork:stream:permission', handler);
      return () => ipcRenderer.removeListener('cowork:stream:permission', handler);
    },
    onStreamComplete: (callback: (data: { sessionId: string; claudeSessionId: string | null }) => void) => {
      const handler = (_event: any, data: { sessionId: string; claudeSessionId: string | null }) => callback(data);
      ipcRenderer.on('cowork:stream:complete', handler);
      return () => ipcRenderer.removeListener('cowork:stream:complete', handler);
    },
    onStreamError: (callback: (data: { sessionId: string; error: string }) => void) => {
      const handler = (_event: any, data: { sessionId: string; error: string }) => callback(data);
      ipcRenderer.on('cowork:stream:error', handler);
      return () => ipcRenderer.removeListener('cowork:stream:error', handler);
    },
  },
  dialog: {
    selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
    selectFile: (options?: { title?: string; filters?: { name: string; extensions: string[] }[] }) =>
      ipcRenderer.invoke('dialog:selectFile', options),
    selectFiles: (options?: { title?: string; filters?: { name: string; extensions: string[] }[] }) =>
      ipcRenderer.invoke('dialog:selectFiles', options),
    saveInlineFile: (options: { dataBase64: string; fileName?: string; mimeType?: string; cwd?: string }) =>
      ipcRenderer.invoke('dialog:saveInlineFile', options),
    readFileAsDataUrl: (filePath: string) =>
      ipcRenderer.invoke('dialog:readFileAsDataUrl', filePath),
  },
  shell: {
    openPath: (filePath: string) => ipcRenderer.invoke('shell:openPath', filePath),
    showItemInFolder: (filePath: string) => ipcRenderer.invoke('shell:showItemInFolder', filePath),
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  },
  autoLaunch: {
    get: () => ipcRenderer.invoke('app:getAutoLaunch'),
    set: (enabled: boolean) => ipcRenderer.invoke('app:setAutoLaunch', enabled),
  },
  appInfo: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    getSystemLocale: () => ipcRenderer.invoke('app:getSystemLocale'),
  },
  appUpdate: {
    download: (url: string) => ipcRenderer.invoke('appUpdate:download', url),
    cancelDownload: () => ipcRenderer.invoke('appUpdate:cancelDownload'),
    install: (filePath: string) => ipcRenderer.invoke('appUpdate:install', filePath),
    onDownloadProgress: (callback: (data: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('appUpdate:downloadProgress', handler);
      return () => ipcRenderer.removeListener('appUpdate:downloadProgress', handler);
    },
  },
  log: {
    getPath: () => ipcRenderer.invoke('log:getPath'),
    openFolder: () => ipcRenderer.invoke('log:openFolder'),
    exportZip: () => ipcRenderer.invoke('log:exportZip'),
  },
  im: {
    // Configuration
    getConfig: () => ipcRenderer.invoke('im:config:get'),
    setConfig: (config: any) => ipcRenderer.invoke('im:config:set', config),

    // Gateway control
    startGateway: (platform: 'dingtalk' | 'feishu' | 'telegram' | 'discord' | 'wecom') => ipcRenderer.invoke('im:gateway:start', platform),
    stopGateway: (platform: 'dingtalk' | 'feishu' | 'telegram' | 'discord' | 'wecom') => ipcRenderer.invoke('im:gateway:stop', platform),
    testGateway: (
      platform: 'dingtalk' | 'feishu' | 'telegram' | 'discord' | 'wecom',
      configOverride?: any
    ) => ipcRenderer.invoke('im:gateway:test', platform, configOverride),

    // Status
    getStatus: () => ipcRenderer.invoke('im:status:get'),

    // Event listeners
    onStatusChange: (callback: (status: any) => void) => {
      const handler = (_event: any, status: any) => callback(status);
      ipcRenderer.on('im:status:change', handler);
      return () => ipcRenderer.removeListener('im:status:change', handler);
    },
    onMessageReceived: (callback: (message: any) => void) => {
      const handler = (_event: any, message: any) => callback(message);
      ipcRenderer.on('im:message:received', handler);
      return () => ipcRenderer.removeListener('im:message:received', handler);
    },
  },
  scheduledTasks: {
    // Task CRUD
    list: () => ipcRenderer.invoke('scheduledTask:list'),
    get: (id: string) => ipcRenderer.invoke('scheduledTask:get', id),
    create: (input: any) => ipcRenderer.invoke('scheduledTask:create', input),
    update: (id: string, input: any) => ipcRenderer.invoke('scheduledTask:update', id, input),
    delete: (id: string) => ipcRenderer.invoke('scheduledTask:delete', id),
    toggle: (id: string, enabled: boolean) => ipcRenderer.invoke('scheduledTask:toggle', id, enabled),

    // Execution
    runManually: (id: string) => ipcRenderer.invoke('scheduledTask:runManually', id),
    stop: (id: string) => ipcRenderer.invoke('scheduledTask:stop', id),

    // Run history
    listRuns: (taskId: string, limit?: number, offset?: number) =>
      ipcRenderer.invoke('scheduledTask:listRuns', taskId, limit, offset),
    countRuns: (taskId: string) => ipcRenderer.invoke('scheduledTask:countRuns', taskId),
    listAllRuns: (limit?: number, offset?: number) =>
      ipcRenderer.invoke('scheduledTask:listAllRuns', limit, offset),

    // Stream event listeners
    onStatusUpdate: (callback: (data: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('scheduledTask:statusUpdate', handler);
      return () => ipcRenderer.removeListener('scheduledTask:statusUpdate', handler);
    },
    onRunUpdate: (callback: (data: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('scheduledTask:runUpdate', handler);
      return () => ipcRenderer.removeListener('scheduledTask:runUpdate', handler);
    },
  },
  networkStatus: {
    send: (status: 'online' | 'offline') => ipcRenderer.send('network:status-change', status),
  },
  onAuthCallback: (callback: (token: string, wallet: string) => void) => {
    const handler = (_event: any, token: string, wallet: string) => callback(token, wallet);
    ipcRenderer.on('auth:callback', handler);
    return () => ipcRenderer.removeListener('auth:callback', handler);
  },
  noobclaw: {
    setAuthToken: (token: string | null) => ipcRenderer.invoke('noobclaw:set-auth-token', token),
    getMacAddress: () => ipcRenderer.invoke('noobclaw:get-mac-address') as Promise<string | null>,
    cacheAvatar: (url: string) => ipcRenderer.invoke('noobclaw:cache-avatar', url) as Promise<{ success: boolean; localPath: string | null }>,
    getCachedAvatar: () => ipcRenderer.invoke('noobclaw:get-cached-avatar') as Promise<string | null>,
    onSsePayload: (callback: (payload: Record<string, unknown>) => void) => {
      const handler = (_event: any, payload: Record<string, unknown>) => callback(payload);
      ipcRenderer.on('noobclaw:sse-payload', handler);
      return () => ipcRenderer.removeListener('noobclaw:sse-payload', handler);
    },
  },
});
