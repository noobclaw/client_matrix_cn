interface ApiResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: any;
  error?: string;
}

interface ApiStreamResponse {
  ok: boolean;
  status: number;
  statusText: string;
  error?: string;
}

// Cowork types for IPC
interface CoworkSession {
  id: string;
  title: string;
  claudeSessionId: string | null;
  status: 'idle' | 'running' | 'completed' | 'error';
  pinned: boolean;
  cwd: string;
  systemPrompt: string;
  executionMode: 'auto' | 'local' | 'sandbox';
  activeSkillIds: string[];
  messages: CoworkMessage[];
  createdAt: number;
  updatedAt: number;
}

interface CoworkMessage {
  id: string;
  type: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system';
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

interface CoworkSessionSummary {
  id: string;
  title: string;
  status: 'idle' | 'running' | 'completed' | 'error';
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

interface CoworkConfig {
  workingDirectory: string;
  systemPrompt: string;
  executionMode: 'auto' | 'local' | 'sandbox';
  memoryEnabled: boolean;
  memoryImplicitUpdateEnabled: boolean;
  memoryLlmJudgeEnabled: boolean;
  memoryGuardLevel: 'strict' | 'standard' | 'relaxed';
  memoryUserMemoriesMaxItems: number;
  dangerouslySkipPermissions: boolean;
}

type CoworkConfigUpdate = Partial<Pick<
  CoworkConfig,
  | 'workingDirectory'
  | 'executionMode'
  | 'memoryEnabled'
  | 'memoryImplicitUpdateEnabled'
  | 'memoryLlmJudgeEnabled'
  | 'memoryGuardLevel'
  | 'memoryUserMemoriesMaxItems'
  | 'dangerouslySkipPermissions'
>>;

interface CoworkUserMemoryEntry {
  id: string;
  text: string;
  confidence: number;
  isExplicit: boolean;
  status: 'created' | 'stale' | 'deleted';
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

interface CoworkMemoryStats {
  total: number;
  created: number;
  stale: number;
  deleted: number;
  explicit: number;
  implicit: number;
}

interface CoworkPermissionRequest {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  requestId: string;
  toolUseId?: string | null;
}

interface CoworkApiConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  apiType?: 'anthropic' | 'openai';
}

interface CoworkSandboxStatus {
  supported: boolean;
  runtimeReady: boolean;
  imageReady: boolean;
  downloading: boolean;
  progress?: CoworkSandboxProgress;
  error?: string | null;
}

interface CoworkSandboxProgress {
  stage: 'runtime' | 'image';
  received: number;
  total?: number;
  percent?: number;
  url?: string;
}

interface AppUpdateDownloadProgress {
  received: number;
  total: number | undefined;
  percent: number | undefined;
  speed: number | undefined;
}

interface WindowState {
  isMaximized: boolean;
  isFullscreen: boolean;
  isFocused: boolean;
}

interface Skill {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  isOfficial: boolean;
  isBuiltIn: boolean;
  updatedAt: number;
  prompt: string;
  skillPath: string;
}

type EmailConnectivityCheckCode = 'imap_connection' | 'smtp_connection';
type EmailConnectivityCheckLevel = 'pass' | 'fail';
type EmailConnectivityVerdict = 'pass' | 'fail';

interface EmailConnectivityCheck {
  code: EmailConnectivityCheckCode;
  level: EmailConnectivityCheckLevel;
  message: string;
  durationMs: number;
}

interface EmailConnectivityTestResult {
  testedAt: number;
  verdict: EmailConnectivityVerdict;
  checks: EmailConnectivityCheck[];
}

// Scenario automation IPC types live in ./scenario.ts and are imported
// where needed. We re-import them here so IElectronAPI.scenario can refer
// to them without polluting the global namespace.
import type {
  ScenarioManifestIPC,
  ScenarioTaskIPC,
  ScenarioDraftIPC,
  ScenarioRunOutcome,
  ScenarioTaskRun,
  ScenarioRunProgress,
  XhsLoginStatus,
} from './scenario';

type CoworkPermissionResult =
  | {
      behavior: 'allow';
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: Record<string, unknown>[];
      toolUseID?: string;
    }
  | {
      behavior: 'deny';
      message: string;
      interrupt?: boolean;
      toolUseID?: string;
    };

interface McpServerConfigIPC {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  transportType: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  isBuiltIn: boolean;
  githubUrl?: string;
  registryId?: string;
  createdAt: number;
  updatedAt: number;
}

interface McpMarketplaceServer {
  id: string;
  name: string;
  description_zh: string;
  description_en: string;
  category: string;
  transportType: 'stdio' | 'sse' | 'http';
  command: string;
  defaultArgs: string[];
  requiredEnvKeys?: string[];
  optionalEnvKeys?: string[];
}

interface McpMarketplaceCategory {
  id: string;
  name_zh: string;
  name_en: string;
}

interface McpMarketplaceData {
  categories: McpMarketplaceCategory[];
  servers: McpMarketplaceServer[];
}

interface IElectronAPI {
  platform: string;
  arch: string;
  store: {
    get: (key: string) => Promise<any>;
    set: (key: string, value: any) => Promise<void>;
    remove: (key: string) => Promise<void>;
  };
  skills: {
    list: () => Promise<{ success: boolean; skills?: Skill[]; error?: string }>;
    setEnabled: (options: { id: string; enabled: boolean }) => Promise<{ success: boolean; skills?: Skill[]; error?: string }>;
    delete: (id: string) => Promise<{ success: boolean; skills?: Skill[]; error?: string }>;
    download: (source: string, meta?: { official?: boolean }) => Promise<{ success: boolean; skills?: Skill[]; error?: string }>;
    getRoot: () => Promise<{ success: boolean; path?: string; error?: string }>;
    autoRoutingPrompt: () => Promise<{ success: boolean; prompt?: string | null; error?: string }>;
    getConfig: (skillId: string) => Promise<{ success: boolean; config?: Record<string, string>; error?: string }>;
    setConfig: (skillId: string, config: Record<string, string>) => Promise<{ success: boolean; error?: string }>;
    testEmailConnectivity: (
      skillId: string,
      config: Record<string, string>
    ) => Promise<{ success: boolean; result?: EmailConnectivityTestResult; error?: string }>;
    onChanged: (callback: () => void) => () => void;
  };
  scenario: {
    listScenarios: () => Promise<{ scenarios: ScenarioManifestIPC[] }>;
    listTasks: () => Promise<ScenarioTaskIPC[]>;
    getTask: (id: string) => Promise<ScenarioTaskIPC | null>;
    createTask: (input: Omit<ScenarioTaskIPC, 'id' | 'created_at' | 'updated_at'>) => Promise<ScenarioTaskIPC>;
    updateTask: (id: string, patch: Partial<ScenarioTaskIPC>) => Promise<ScenarioTaskIPC | null>;
    deleteTask: (id: string) => Promise<boolean>;
    runTaskNow: (id: string) => Promise<ScenarioRunOutcome>;
    uploadDraft: (taskId: string, draftId: string) => Promise<{ status: 'started' | 'failed' | 'skipped' | 'ok'; reason?: string }>;
    runStatus: (id: string) => Promise<{ runs: ScenarioTaskRun[]; cooldown_ends_at: number }>;
    listDrafts: (taskId?: string) => Promise<ScenarioDraftIPC[]>;
    pushDraft: (draftId: string) => Promise<{ status: 'ready_for_user' | 'failed'; error?: string }>;
    deleteDraft: (draftId: string) => Promise<boolean>;
    markDraftPushed: (draftId: string) => Promise<ScenarioDraftIPC | null>;
    markDraftIgnored: (draftId: string) => Promise<ScenarioDraftIPC | null>;
    setActiveTask: (id: string) => Promise<ScenarioTaskIPC | null>;
    getActiveTask: () => Promise<ScenarioTaskIPC | null>;
    getRunningTaskId: () => Promise<{ runningTaskId: string | null }>;
    getRunningTaskIds: () => Promise<{ runningTaskIds: string[] }>;
    getConnectedExtensions: () => Promise<{
      extensions: Array<{ id: string; version: string; tabCount: number; connectedAt: number }>;
    }>;
    getAllRuns: () => Promise<{
      runs: Array<{
        task_id: string;
        started_at: number;
        finished_at?: number;
        status: 'success' | 'failure' | 'skipped' | 'running';
        reason?: string;
        collected_count?: number;
        draft_count?: number;
      }>;
    }>;
    listRunRecords: (filter?: { task_id?: string; platform?: string }) => Promise<{
      records: Array<{
        id: string;
        task_id: string;
        task_snapshot: any;
        scenario_snapshot: { id: string; platform: string; name_zh?: string; name_en?: string; icon?: string; workflow_type?: string };
        started_at: number;
        finished_at?: number;
        status: 'running' | 'done' | 'error' | 'stopped';
        error?: string;
        step_logs: Array<{ time: string; step: number; status: 'done' | 'running' | 'error'; message: string }>;
        result?: { collected_count?: number; draft_count?: number; posted?: number; [k: string]: any };
        output_dir?: string;
      }>;
    }>;
    getRunRecord: (id: string) => Promise<{ record: any | null }>;
    getTaskDir: (id: string) => Promise<{ dir: string }>;
    getRunProgress: (taskId?: string) => Promise<ScenarioRunProgress | null>;
    getLatestRunRecord: (taskId: string) => Promise<any | null>;
    requestAbort: (taskId?: string) => Promise<{ ok: boolean }>;
    checkXhsLogin: (platform?: 'xhs' | 'x' | 'binance' | 'tiktok' | 'youtube' | 'douyin' | 'kuaishou' | 'bilibili') => Promise<XhsLoginStatus>;
    openXhsLogin: (platform?: 'xhs' | 'x' | 'binance' | 'tiktok' | 'youtube' | 'douyin' | 'kuaishou' | 'bilibili') => Promise<{ ok: boolean; reason?: string }>;
    checkCreatorCenter: (platform: 'xhs' | 'douyin' | 'kuaishou' | 'bilibili') => Promise<XhsLoginStatus>;
    openCreatorCenter: (platform: 'xhs' | 'douyin' | 'kuaishou' | 'bilibili') => Promise<{ ok: boolean; reason?: string }>;
  };
  mcp: {
    list: () => Promise<{ success: boolean; servers?: McpServerConfigIPC[]; error?: string }>;
    create: (data: any) => Promise<{ success: boolean; servers?: McpServerConfigIPC[]; error?: string }>;
    update: (id: string, data: any) => Promise<{ success: boolean; servers?: McpServerConfigIPC[]; error?: string }>;
    delete: (id: string) => Promise<{ success: boolean; servers?: McpServerConfigIPC[]; error?: string }>;
    setEnabled: (options: { id: string; enabled: boolean }) => Promise<{ success: boolean; servers?: McpServerConfigIPC[]; error?: string }>;
    fetchMarketplace: () => Promise<{ success: boolean; data?: McpMarketplaceData; error?: string }>;
    oauthBegin?: (options: {
      id: string;
      authorizeUrl: string;
      tokenUrl: string;
      clientId: string;
      clientSecret?: string;
      scope?: string;
    }) => Promise<{ success: boolean; servers?: McpServerConfigIPC[]; error?: string }>;
    oauthClear?: (id: string) => Promise<{ success: boolean; servers?: McpServerConfigIPC[]; error?: string }>;
  };
  slashCommands?: {
    list: () => Promise<Array<{ name: string; description: string; file: string }>>;
    getDir: () => Promise<string | null>;
  };
  shellHooks?: {
    list: () => Promise<Record<string, Array<{ matcher?: string; command: string; timeoutMs?: number }>>>;
  };
  toolPolicy?: {
    get: () => Promise<{
      defaultMode: 'allow' | 'deny' | 'ask';
      rules: Array<{
        pattern: string;
        mode: 'allow' | 'deny' | 'ask';
        bashCommandContains?: string;
        reason?: string;
      }>;
    }>;
    set: (policy: any) => Promise<boolean>;
  };
  coworkConfig?: {
    get: () => Promise<{ thinkingBudget: number }>;
    setThinkingBudget: (budget: number) => Promise<boolean>;
  };
  workspace?: {
    listFiles: (root: string) => Promise<Array<{ rel: string; size: number; kind: 'file' | 'dir' }>>;
  };
  searchMessages?: (query: string, limit?: number) => Promise<Array<{
    sessionId: string;
    title: string;
    snippet: string;
    messageId: string;
    createdAt: number;
  }>>;
  crashes?: {
    list: () => Promise<Array<{
      ts: string;
      kind: string;
      message: string;
      stack?: string;
      file: string;
    }>>;
    getDir: () => Promise<string | null>;
    onCrash: (callback: (detail: { kind: string; message: string; file: string | null; ts: string }) => void) => () => void;
  };
  api: {
    fetch: (options: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }) => Promise<ApiResponse>;
    stream: (options: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
      requestId: string;
    }) => Promise<ApiStreamResponse>;
    cancelStream: (requestId: string) => Promise<boolean>;
    onStreamData: (requestId: string, callback: (chunk: string) => void) => () => void;
    onStreamDone: (requestId: string, callback: () => void) => () => void;
    onStreamError: (requestId: string, callback: (error: string) => void) => () => void;
    onStreamAbort: (requestId: string, callback: () => void) => () => void;
  };
  getApiConfig: () => Promise<CoworkApiConfig | null>;
  checkApiConfig: (options?: { probeModel?: boolean }) => Promise<{ hasConfig: boolean; config: CoworkApiConfig | null; error?: string }>;
  saveApiConfig: (config: CoworkApiConfig) => Promise<{ success: boolean; error?: string }>;
  generateSessionTitle: (userInput: string | null) => Promise<string>;
  getRecentCwds: (limit?: number) => Promise<string[]>;
  ipcRenderer: {
    send: (channel: string, ...args: any[]) => void;
    on: (channel: string, func: (...args: any[]) => void) => () => void;
  };
  window: {
    minimize: () => void;
    toggleMaximize: () => void;
    close: () => void;
    isMaximized: () => Promise<boolean>;
    showSystemMenu: (position: { x: number; y: number }) => void;
    onStateChanged: (callback: (state: WindowState) => void) => () => void;
  };
  cowork: {
    startSession: (options: { prompt: string; cwd?: string; systemPrompt?: string; title?: string; activeSkillIds?: string[]; imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }> }) => Promise<{ success: boolean; session?: CoworkSession; error?: string }>;
    continueSession: (options: { sessionId: string; prompt: string; systemPrompt?: string; activeSkillIds?: string[]; imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }> }) => Promise<{ success: boolean; session?: CoworkSession; error?: string }>;
    stopSession: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
    deleteSession: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
    deleteSessions: (sessionIds: string[]) => Promise<{ success: boolean; error?: string }>;
    setSessionPinned: (options: { sessionId: string; pinned: boolean }) => Promise<{ success: boolean; error?: string }>;
    renameSession: (options: { sessionId: string; title: string }) => Promise<{ success: boolean; error?: string }>;
    getSession: (sessionId: string) => Promise<{ success: boolean; session?: CoworkSession; error?: string }>;
    listSessions: () => Promise<{ success: boolean; sessions?: CoworkSessionSummary[]; error?: string }>;
    exportResultImage: (options: {
      rect: { x: number; y: number; width: number; height: number };
      defaultFileName?: string;
    }) => Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }>;
    captureImageChunk: (options: {
      rect: { x: number; y: number; width: number; height: number };
    }) => Promise<{ success: boolean; width?: number; height?: number; pngBase64?: string; error?: string }>;
    saveResultImage: (options: {
      pngBase64: string;
      defaultFileName?: string;
    }) => Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }>;
    respondToPermission: (options: { requestId: string; result: CoworkPermissionResult }) => Promise<{ success: boolean; error?: string }>;
    // Cost / token usage (B2d)
    getCostSummary: (range: 'today' | 'week' | 'month' | 'all') => Promise<{
      success: boolean;
      range?: string;
      since?: number;
      summary?: {
        turnCount: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
      };
      error?: string;
    }>;
    getCostHistogramDaily: (days?: number) => Promise<{
      success: boolean;
      buckets?: Array<{
        dayStart: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        turnCount: number;
      }>;
      error?: string;
    }>;
    getSessionCost: (sessionId: string) => Promise<{
      success: boolean;
      stats?: {
        turnCount: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
      };
      error?: string;
    }>;
    getConfig: () => Promise<{ success: boolean; config?: CoworkConfig; error?: string }>;
    setConfig: (config: CoworkConfigUpdate) => Promise<{ success: boolean; error?: string }>;
    listMemoryEntries: (input: {
      query?: string;
      status?: 'created' | 'stale' | 'deleted' | 'all';
      includeDeleted?: boolean;
      limit?: number;
      offset?: number;
    }) => Promise<{ success: boolean; entries?: CoworkUserMemoryEntry[]; error?: string }>;
    createMemoryEntry: (input: {
      text: string;
      confidence?: number;
      isExplicit?: boolean;
    }) => Promise<{ success: boolean; entry?: CoworkUserMemoryEntry; error?: string }>;
    updateMemoryEntry: (input: {
      id: string;
      text?: string;
      confidence?: number;
      status?: 'created' | 'stale' | 'deleted';
      isExplicit?: boolean;
    }) => Promise<{ success: boolean; entry?: CoworkUserMemoryEntry; error?: string }>;
    deleteMemoryEntry: (input: { id: string }) => Promise<{ success: boolean; error?: string }>;
    getMemoryStats: () => Promise<{ success: boolean; stats?: CoworkMemoryStats; error?: string }>;
    getSandboxStatus: () => Promise<CoworkSandboxStatus>;
    installSandbox: () => Promise<{ success: boolean; status: CoworkSandboxStatus; error?: string }>;
    onSandboxDownloadProgress: (callback: (data: CoworkSandboxProgress) => void) => () => void;
    onStreamMessage: (callback: (data: { sessionId: string; message: CoworkMessage }) => void) => () => void;
    onStreamMessageUpdate: (callback: (data: { sessionId: string; messageId: string; content: string }) => void) => () => void;
    onStreamMessageMetadata: (callback: (data: { sessionId: string; messageId: string; metadata: Record<string, unknown> }) => void) => () => void;
    onStreamStuck: (callback: (data: { sessionId: string; idleMs: number }) => void) => () => void;
    onStreamPermission: (callback: (data: { sessionId: string; request: CoworkPermissionRequest }) => void) => () => void;
    onStreamComplete: (callback: (data: { sessionId: string; claudeSessionId: string | null }) => void) => () => void;
    onStreamError: (callback: (data: { sessionId: string; error: string }) => void) => () => void;
  };
  dialog: {
    selectDirectory: () => Promise<{ success: boolean; path: string | null }>;
    selectFile: (options?: { title?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<{ success: boolean; path: string | null }>;
    selectFiles: (options?: { title?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<{ success: boolean; paths: string[] }>;
    saveInlineFile: (options: { dataBase64: string; fileName?: string; mimeType?: string; cwd?: string }) => Promise<{ success: boolean; path: string | null; error?: string }>;
    readFileAsDataUrl: (filePath: string) => Promise<{ success: boolean; dataUrl?: string; error?: string }>;
  };
  shell: {
    openPath: (filePath: string) => Promise<{ success: boolean; error?: string }>;
    showItemInFolder: (filePath: string) => Promise<{ success: boolean; error?: string }>;
    openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;
  };
  autoLaunch: {
    get: () => Promise<{ enabled: boolean }>;
    set: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
  };
  video: {
    generate: (input: unknown) => Promise<{ ok: boolean; outputPath?: string; error?: string }>;
    stop: (taskId: string) => Promise<{ ok: boolean; error?: string }>;
    pickImages: (max: number) => Promise<string[]>;
    pickVideos: (max: number) => Promise<string[]>;
    pickLocalFolder: () => Promise<{ dir: string; videoCount: number; imageCount: number } | null>;
    scanLocalFolder: (dir: string) => Promise<{ videoCount: number; imageCount: number }>;
    readImageDataUrl: (filePath: string) => Promise<string>;
    pickAudio: () => Promise<string>;
    resolveBgmPath: (token: string) => Promise<string>;
    openFile: (filePath: string) => Promise<unknown>;
    onProgress: (handler: (p: unknown) => void) => () => void;
  };
  appInfo: {
    getVersion: () => Promise<string>;
    getSystemLocale: () => Promise<string>;
  };
  appUpdate: {
    download: (url: string) => Promise<{ success: boolean; filePath?: string; error?: string }>;
    cancelDownload: () => Promise<{ success: boolean }>;
    install: (filePath: string) => Promise<{ success: boolean; error?: string }>;
    onDownloadProgress: (callback: (data: AppUpdateDownloadProgress) => void) => () => void;
  };
  log: {
    getPath: () => Promise<string>;
    openFolder: () => Promise<void>;
    exportZip: () => Promise<{
      success: boolean;
      canceled?: boolean;
      path?: string;
      missingEntries?: string[];
      error?: string;
    }>;
  };
  im: {
    getConfig: () => Promise<{ success: boolean; config?: IMGatewayConfig; error?: string }>;
    setConfig: (config: Partial<IMGatewayConfig>) => Promise<{ success: boolean; error?: string }>;
    startGateway: (platform: 'dingtalk' | 'feishu' | 'qq' | 'telegram' | 'discord' | 'wecom') => Promise<{ success: boolean; error?: string }>;
    stopGateway: (platform: 'dingtalk' | 'feishu' | 'qq' | 'telegram' | 'discord' | 'wecom') => Promise<{ success: boolean; error?: string }>;
    testGateway: (
      platform: 'dingtalk' | 'feishu' | 'qq' | 'telegram' | 'discord' | 'wecom',
      configOverride?: Partial<IMGatewayConfig>
    ) => Promise<{ success: boolean; result?: IMConnectivityTestResult; error?: string }>;
    getStatus: () => Promise<{ success: boolean; status?: IMGatewayStatus; error?: string }>;
    onStatusChange: (callback: (status: IMGatewayStatus) => void) => () => void;
    onMessageReceived: (callback: (message: IMMessage) => void) => () => void;
  };
  scheduledTasks: {
    list: () => Promise<any>;
    get: (id: string) => Promise<any>;
    create: (input: any) => Promise<any>;
    update: (id: string, input: any) => Promise<any>;
    delete: (id: string) => Promise<any>;
    toggle: (id: string, enabled: boolean) => Promise<any>;
    runManually: (id: string) => Promise<any>;
    stop: (id: string) => Promise<any>;
    listRuns: (taskId: string, limit?: number, offset?: number) => Promise<any>;
    countRuns: (taskId: string) => Promise<any>;
    listAllRuns: (limit?: number, offset?: number) => Promise<any>;
    onStatusUpdate: (callback: (data: any) => void) => () => void;
    onRunUpdate: (callback: (data: any) => void) => () => void;
  };
  permissions: {
    checkCalendar: () => Promise<{ success: boolean; status?: string; error?: string; autoRequested?: boolean }>;
    requestCalendar: () => Promise<{ success: boolean; granted?: boolean; status?: string; error?: string }>;
  };
  networkStatus: {
    send: (status: 'online' | 'offline') => void;
  };
  noobclaw: {
    setAuthToken: (token: string | null) => Promise<{ success: boolean }>;
    getMacAddress: () => Promise<string | null>;
    cacheAvatar: (url: string) => Promise<{ success: boolean; localPath: string | null }>;
    getCachedAvatar: () => Promise<string | null>;
    onSsePayload: (callback: (payload: Record<string, unknown>) => void) => () => void;
  };
}

// IM Gateway types
interface IMGatewayConfig {
  dingtalk: DingTalkConfig;
  feishu: FeishuConfig;
  qq: QQConfig;
  telegram: TelegramConfig;
  discord: DiscordConfig;
  wecom: WecomConfig;
  settings: IMSettings;
}

interface DingTalkConfig {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  robotCode?: string;
  corpId?: string;
  agentId?: string;
  messageType: 'markdown' | 'card';
  cardTemplateId?: string;
  debug?: boolean;
}

interface FeishuConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  domain: 'feishu' | 'lark' | string;
  encryptKey?: string;
  verificationToken?: string;
  renderMode: 'text' | 'card';
  debug?: boolean;
}

interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  debug?: boolean;
}

interface DiscordConfig {
  enabled: boolean;
  botToken: string;
  debug?: boolean;
}

interface QQConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  debug?: boolean;
}

interface WecomConfig {
  enabled: boolean;
  botId: string;
  secret: string;
  debug?: boolean;
}

interface IMSettings {
  systemPrompt?: string;
  skillsEnabled: boolean;
}

interface IMGatewayStatus {
  dingtalk: DingTalkGatewayStatus;
  feishu: FeishuGatewayStatus;
  qq: QQGatewayStatus;
  telegram: TelegramGatewayStatus;
  discord: DiscordGatewayStatus;
  wecom: WecomGatewayStatus;
}

type IMConnectivityVerdict = 'pass' | 'warn' | 'fail';

type IMConnectivityCheckLevel = 'pass' | 'info' | 'warn' | 'fail';

type IMConnectivityCheckCode =
  | 'missing_credentials'
  | 'auth_check'
  | 'gateway_running'
  | 'inbound_activity'
  | 'outbound_activity'
  | 'platform_last_error'
  | 'feishu_group_requires_mention'
  | 'feishu_event_subscription_required'
  | 'discord_group_requires_mention'
  | 'telegram_privacy_mode_hint'
  | 'dingtalk_bot_membership_hint'
  | 'qq_guild_mention_hint';

interface IMConnectivityCheck {
  code: IMConnectivityCheckCode;
  level: IMConnectivityCheckLevel;
  message: string;
  suggestion?: string;
}

interface IMConnectivityTestResult {
  platform: 'dingtalk' | 'feishu' | 'qq' | 'telegram' | 'discord' | 'wecom';
  testedAt: number;
  verdict: IMConnectivityVerdict;
  checks: IMConnectivityCheck[];
}

interface DingTalkGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

interface FeishuGatewayStatus {
  connected: boolean;
  startedAt: string | null;
  botOpenId: string | null;
  error: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

interface TelegramGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  botUsername: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

interface DiscordGatewayStatus {
  connected: boolean;
  starting: boolean;
  startedAt: number | null;
  lastError: string | null;
  botUsername: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

interface QQGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

interface WecomGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  botId: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

interface IMMessage {
  platform: 'dingtalk' | 'feishu' | 'qq' | 'telegram' | 'discord' | 'wecom';
  messageId: string;
  conversationId: string;
  senderId: string;
  senderName?: string;
  content: string;
  chatType: 'direct' | 'group';
  timestamp: number;
}

declare global {
  interface Window {
    electron: IElectronAPI;
  }
}

export {}; 
