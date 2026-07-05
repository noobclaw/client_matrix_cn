import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { configService } from '../services/config';
import { apiService } from '../services/api';
import { checkForAppUpdate } from '../services/appUpdate';
import type { AppUpdateInfo } from '../services/appUpdate';
import { themeService } from '../services/theme';
import { i18nService, LanguageType } from '../services/i18n';
import { decryptSecret, encryptWithPassword, decryptWithPassword, EncryptedPayload, PasswordEncryptedPayload } from '../services/encryption';
import { coworkService } from '../services/cowork';
import { APP_ID, EXPORT_FORMAT_TYPE, EXPORT_PASSWORD } from '../constants/app';
import lauraAvatarUrl from '/laura-avatar.png?url';
import { isTestMode } from '../services/endpoints';
import { HIDE_WEB3 } from '../buildFlags';
import ErrorMessage from './ErrorMessage';
import AdvancedSettingsPanel from './AdvancedSettingsPanel';
import { XMarkIcon, SignalIcon, CheckCircleIcon, XCircleIcon } from '@heroicons/react/24/outline';
import { EyeIcon, EyeSlashIcon, XCircleIcon as XCircleIconSolid } from '@heroicons/react/20/solid';
import PlusCircleIcon from './icons/PlusCircleIcon';
import TrashIcon from './icons/TrashIcon';
import PencilIcon from './icons/PencilIcon';
import { useDispatch, useSelector } from 'react-redux';
import { setAvailableModels } from '../store/slices/modelSlice';
import { RootState } from '../store';
import ThemedSelect from './ui/ThemedSelect';
import type {
  CoworkExecutionMode,
  CoworkUserMemoryEntry,
  CoworkMemoryStats,
  CoworkSandboxProgress,
  CoworkSandboxStatus,
} from '../types/cowork';
import EmailSkillConfig from './skills/EmailSkillConfig';
import { defaultConfig, type AppConfig } from '../config';
import {
  OpenAIIcon,
  DeepSeekIcon,
  GeminiIcon,
  AnthropicIcon,
  MoonshotIcon,
  ZhipuIcon,
  MiniMaxIcon,
  QwenIcon,
} from './icons/providers';

type TabType = 'general' | 'model' | 'coworkMemory' | 'email' | 'advanced' | 'about';

export type SettingsOpenOptions = {
  initialTab?: TabType;
  notice?: string;
  /** Open in custom API key mode (switch off NoobClawServer toggle) */
  forceCustomApi?: boolean;
  /** Scroll to a specific section after opening */
  scrollToSection?: string;
};

interface SettingsProps extends SettingsOpenOptions {
  onClose: () => void;
  onUpdateFound?: (info: AppUpdateInfo) => void;
}

const providerKeys = [
  'openai',
  'gemini',
  'anthropic',
  'deepseek',
  'moonshot',
  'zhipu',
  'minimax',
  'qwen',
] as const;

type ProviderType = (typeof providerKeys)[number];
type ProvidersConfig = NonNullable<AppConfig['providers']>;
type ProviderConfig = ProvidersConfig[string];
type Model = NonNullable<ProviderConfig['models']>[number];
type ProviderConnectionTestResult = {
  success: boolean;
  message: string;
  provider: ProviderType;
};

interface ProviderExportEntry {
  enabled: boolean;
  apiKey: PasswordEncryptedPayload;
  baseUrl: string;
  apiFormat?: 'anthropic' | 'openai';
  codingPlanEnabled?: boolean;
  models?: Model[];
}

interface ProvidersExportPayload {
  type: typeof EXPORT_FORMAT_TYPE;
  version: 2;
  exportedAt: string;
  encryption: {
    algorithm: 'AES-GCM';
    keySource: 'password';
    keyDerivation: 'PBKDF2';
  };
  providers: Record<string, ProviderExportEntry>;
}

interface ProvidersImportEntry {
  enabled?: boolean;
  apiKey?: EncryptedPayload | PasswordEncryptedPayload | string;
  apiKeyEncrypted?: string;
  apiKeyIv?: string;
  baseUrl?: string;
  apiFormat?: 'anthropic' | 'openai' | 'native';
  codingPlanEnabled?: boolean;
  models?: Model[];
}

interface ProvidersImportPayload {
  type?: string;
  version?: number;
  encryption?: {
    algorithm?: string;
    keySource?: string;
    keyDerivation?: string;
  };
  providers?: Record<string, ProvidersImportEntry>;
}

const providerMeta: Record<ProviderType, { label: string; icon: React.ReactNode }> = {
  openai: { label: 'OpenAI', icon: <OpenAIIcon /> },
  deepseek: { label: 'DeepSeek', icon: <DeepSeekIcon /> },
  gemini: { label: 'Gemini', icon: <GeminiIcon /> },
  anthropic: { label: 'Anthropic', icon: <AnthropicIcon /> },
  moonshot: { label: 'Moonshot', icon: <MoonshotIcon /> },
  zhipu: { label: 'Zhipu', icon: <ZhipuIcon /> },
  minimax: { label: 'MiniMax', icon: <MiniMaxIcon /> },
  qwen: { label: 'Qwen', icon: <QwenIcon /> },
};

const providerApiPlatformUrls: Record<ProviderType, string> = {
  openai: 'https://platform.openai.com/api-keys',
  deepseek: 'https://platform.deepseek.com/api_keys',
  gemini: 'https://aistudio.google.com/apikey',
  anthropic: 'https://console.anthropic.com/settings/keys',
  moonshot: 'https://platform.moonshot.cn/console/api-keys',
  zhipu: 'https://open.bigmodel.cn/usercenter/apikeys',
  minimax: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
  qwen: 'https://dashscope.console.aliyun.com/apiKey',
};

const providerSwitchableDefaultBaseUrls: Partial<Record<ProviderType, { anthropic: string; openai: string }>> = {
  deepseek: {
    anthropic: 'https://api.deepseek.com/anthropic',
    openai: 'https://api.deepseek.com',
  },
  moonshot: {
    anthropic: 'https://api.moonshot.cn/anthropic',
    openai: 'https://api.moonshot.cn/v1',
  },
};

const providerRequiresApiKey = (_provider: ProviderType) => true;
const normalizeBaseUrl = (baseUrl: string): string => baseUrl.trim().replace(/\/+$/, '').toLowerCase();
const normalizeApiFormat = (value: unknown): 'anthropic' | 'openai' => (
  value === 'openai' ? 'openai' : 'anthropic'
);
const ABOUT_CONTACT_EMAIL = 'hi@noobclaw.com';
const ABOUT_USER_MANUAL_URL = 'https://noobclaw.com/cn/';

const copyTextFallback = (text: string): boolean => {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  const copied = document.execCommand('copy');
  document.body.removeChild(textarea);
  return copied;
};

const copyTextToClipboard = async (text: string): Promise<boolean> => {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (clipboardError) {
      console.warn('Navigator clipboard write failed, trying fallback:', clipboardError);
    }
  }

  try {
    return copyTextFallback(text);
  } catch (fallbackError) {
    console.error('Fallback clipboard copy failed:', fallbackError);
    return false;
  }
};

const getFixedApiFormatForProvider = (provider: string): 'anthropic' | 'openai' | null => {
  if (provider === 'openai' || provider === 'gemini') {
    return 'openai';
  }
  if (provider === 'anthropic') {
    return 'anthropic';
  }
  return null;
};
const getEffectiveApiFormat = (provider: string, value: unknown): 'anthropic' | 'openai' => (
  getFixedApiFormatForProvider(provider) ?? normalizeApiFormat(value)
);
const shouldShowApiFormatSelector = (provider: string): boolean => (
  getFixedApiFormatForProvider(provider) === null
);
const getProviderDefaultBaseUrl = (
  provider: ProviderType,
  apiFormat: 'anthropic' | 'openai'
): string | null => {
  const defaults = providerSwitchableDefaultBaseUrls[provider];
  return defaults ? defaults[apiFormat] : null;
};
const resolveBaseUrl = (
  provider: ProviderType,
  baseUrl: string,
  apiFormat: 'anthropic' | 'openai'
): string => {
  if (baseUrl.trim()) return baseUrl;
  return getProviderDefaultBaseUrl(provider, apiFormat)
    || defaultConfig.providers?.[provider]?.baseUrl
    || '';
};
const shouldAutoSwitchProviderBaseUrl = (provider: ProviderType, currentBaseUrl: string): boolean => {
  const defaults = providerSwitchableDefaultBaseUrls[provider];
  if (!defaults) {
    return false;
  }

  const normalizedCurrent = normalizeBaseUrl(currentBaseUrl);
  return (
    normalizedCurrent === normalizeBaseUrl(defaults.anthropic)
    || normalizedCurrent === normalizeBaseUrl(defaults.openai)
  );
};
const buildOpenAICompatibleChatCompletionsUrl = (baseUrl: string, provider: string): string => {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) {
    return '/v1/chat/completions';
  }
  if (normalized.endsWith('/chat/completions')) {
    return normalized;
  }

  const isGeminiLike = provider === 'gemini' || normalized.includes('generativelanguage.googleapis.com');
  if (isGeminiLike) {
    if (normalized.endsWith('/v1beta/openai') || normalized.endsWith('/v1/openai')) {
      return `${normalized}/chat/completions`;
    }
    if (normalized.endsWith('/v1beta') || normalized.endsWith('/v1')) {
      const betaBase = normalized.endsWith('/v1')
        ? `${normalized.slice(0, -3)}v1beta`
        : normalized;
      return `${betaBase}/openai/chat/completions`;
    }
    return `${normalized}/v1beta/openai/chat/completions`;
  }

  // Handle /v1, /v4 etc. versioned paths
  if (/\/v\d+$/.test(normalized)) {
    return `${normalized}/chat/completions`;
  }
  return `${normalized}/v1/chat/completions`;
};
const buildOpenAIResponsesUrl = (baseUrl: string): string => {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) {
    return '/v1/responses';
  }
  if (normalized.endsWith('/responses')) {
    return normalized;
  }
  if (normalized.endsWith('/v1')) {
    return `${normalized}/responses`;
  }
  return `${normalized}/v1/responses`;
};
const shouldUseOpenAIResponsesForProvider = (provider: string): boolean => (
  provider === 'openai'
);
const shouldUseMaxCompletionTokensForOpenAI = (provider: string, modelId?: string): boolean => {
  if (provider !== 'openai') {
    return false;
  }
  const normalizedModel = (modelId ?? '').toLowerCase();
  const resolvedModel = normalizedModel.includes('/')
    ? normalizedModel.slice(normalizedModel.lastIndexOf('/') + 1)
    : normalizedModel;
  return resolvedModel.startsWith('gpt-5')
    || resolvedModel.startsWith('o1')
    || resolvedModel.startsWith('o3')
    || resolvedModel.startsWith('o4');
};
const CONNECTIVITY_TEST_TOKEN_BUDGET = 64;

const getDefaultProviders = (): ProvidersConfig => {
  const providers = (defaultConfig.providers ?? {}) as ProvidersConfig;
  const entries = Object.entries(providers) as Array<[string, ProviderConfig]>;
  return Object.fromEntries(
    entries.map(([providerKey, providerConfig]) => [
      providerKey,
      {
        ...providerConfig,
        models: providerConfig.models?.map(model => ({
          ...model,
          supportsImage: model.supportsImage ?? false,
        })),
      },
    ])
  ) as ProvidersConfig;
};

const getDefaultActiveProvider = (): ProviderType => {
  const providers = (defaultConfig.providers ?? {}) as ProvidersConfig;
  const firstEnabledProvider = providerKeys.find(providerKey => providers[providerKey]?.enabled);
  return firstEnabledProvider ?? providerKeys[0];
};

const Settings: React.FC<SettingsProps> = ({ onClose, initialTab, notice, forceCustomApi, onUpdateFound, scrollToSection }) => {
  const dispatch = useDispatch();
  // State
  const [activeTab, setActiveTab] = useState<TabType>(initialTab ?? 'general');
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('system');
  const [language, setLanguage] = useState<LanguageType>('zh');
  const [autoLaunch, setAutoLaunchState] = useState(false);
  const [useSystemProxy, setUseSystemProxy] = useState(false);
  const [useNoobClawServer, setUseNoobClawServer] = useState(true);
  const [aiAssistantName, setAiAssistantName] = useState('Adia Laura');
  const [aiAssistantAvatar, setAiAssistantAvatar] = useState<string | undefined>(undefined);
  const aiAvatarInputRef = useRef<HTMLInputElement>(null);
  const [isUpdatingAutoLaunch, setIsUpdatingAutoLaunch] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noticeMessage, setNoticeMessage] = useState<string | null>(notice ?? null);
  const [testResult, setTestResult] = useState<ProviderConnectionTestResult | null>(null);
  const [isTestResultModalOpen, setIsTestResultModalOpen] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isImportingProviders, setIsImportingProviders] = useState(false);
  const [isExportingProviders, setIsExportingProviders] = useState(false);
  const initialThemeRef = useRef<'light' | 'dark' | 'system'>(themeService.getTheme());
  const initialLanguageRef = useRef<LanguageType>(i18nService.getLanguage());
  const didSaveRef = useRef(false);

  // Add state for active provider
  const [activeProvider, setActiveProvider] = useState<ProviderType>(getDefaultActiveProvider());
  const [showApiKey, setShowApiKey] = useState(false);

  // Add state for providers configuration
  const [providers, setProviders] = useState<ProvidersConfig>(() => getDefaultProviders());

  const isBaseUrlLocked = (activeProvider === 'moonshot' && providers.moonshot.codingPlanEnabled);
  
  // Create refs to ensure content area scrolling
  const contentRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const emailCopiedTimerRef = useRef<number | null>(null);
  const updateCheckTimerRef = useRef<number | null>(null);
  
  // Shortcut settings
  const [shortcuts, setShortcuts] = useState({
    newChat: 'Ctrl+N',
    search: 'Ctrl+F',
    settings: 'Ctrl+,',
  });

  // State for model editing
  const [isAddingModel, setIsAddingModel] = useState(false);
  const [isEditingModel, setIsEditingModel] = useState(false);
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [newModelName, setNewModelName] = useState('');
  const [newModelId, setNewModelId] = useState('');
  const [newModelSupportsImage, setNewModelSupportsImage] = useState(false);
  const [modelFormError, setModelFormError] = useState<string | null>(null);

  // About tab
  const [appVersion, setAppVersion] = useState('');
  const [emailCopied, setEmailCopied] = useState(false);
  const [isExportingLogs, setIsExportingLogs] = useState(false);
  const [testMode, setTestMode] = useState(false);
  const [logoClickCount, setLogoClickCount] = useState(0);
  const [testModeUnlocked, setTestModeUnlocked] = useState(false);
  const [updateCheckStatus, setUpdateCheckStatus] = useState<'idle' | 'checking' | 'upToDate' | 'error'>('idle');

  useEffect(() => {
    window.electron.appInfo.getVersion().then(setAppVersion);
  }, []);

  useEffect(() => {
    setShowApiKey(false);
  }, [activeProvider]);

  const handleCopyContactEmail = useCallback(async () => {
    const copied = await copyTextToClipboard(ABOUT_CONTACT_EMAIL);
    if (copied) {
      setEmailCopied(true);
      if (emailCopiedTimerRef.current != null) {
        window.clearTimeout(emailCopiedTimerRef.current);
      }
      emailCopiedTimerRef.current = window.setTimeout(() => {
        setEmailCopied(false);
        emailCopiedTimerRef.current = null;
      }, 1200);
    }
  }, []);

  const handleCheckUpdate = useCallback(async () => {
    if (updateCheckStatus === 'checking' || !appVersion) return;
    setUpdateCheckStatus('checking');
    try {
      const info = await checkForAppUpdate(appVersion);
      if (info) {
        setUpdateCheckStatus('idle');
        onUpdateFound?.(info);
      } else {
        setUpdateCheckStatus('upToDate');
        if (updateCheckTimerRef.current != null) {
          window.clearTimeout(updateCheckTimerRef.current);
        }
        updateCheckTimerRef.current = window.setTimeout(() => {
          setUpdateCheckStatus('idle');
          updateCheckTimerRef.current = null;
        }, 3000);
      }
    } catch {
      setUpdateCheckStatus('error');
      if (updateCheckTimerRef.current != null) {
        window.clearTimeout(updateCheckTimerRef.current);
      }
      updateCheckTimerRef.current = window.setTimeout(() => {
        setUpdateCheckStatus('idle');
        updateCheckTimerRef.current = null;
      }, 3000);
    }
  }, [appVersion, updateCheckStatus, onUpdateFound]);

  const handleOpenUserManual = useCallback(() => {
    void window.electron.shell.openExternal(ABOUT_USER_MANUAL_URL);
  }, []);

  const handleExportLogs = useCallback(async () => {
    if (isExportingLogs) {
      return;
    }

    setError(null);
    setNoticeMessage(null);
    setIsExportingLogs(true);
    try {
      const result = await window.electron.log.exportZip();
      if (!result.success) {
        setError(result.error || i18nService.t('aboutExportLogsFailed'));
        return;
      }
      if (result.canceled) {
        return;
      }

      if (result.path) {
        await window.electron.shell.showItemInFolder(result.path);
      }

      if ((result.missingEntries?.length ?? 0) > 0) {
        const missingList = result.missingEntries?.join(', ') || '';
        setNoticeMessage(`${i18nService.t('aboutExportLogsPartial')}: ${missingList}`);
      } else {
        setNoticeMessage(i18nService.t('aboutExportLogsSuccess'));
      }
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : i18nService.t('aboutExportLogsFailed'));
    } finally {
      setIsExportingLogs(false);
    }
  }, [isExportingLogs]);

  const coworkConfig = useSelector((state: RootState) => state.cowork.config);

  const [coworkExecutionMode, setCoworkExecutionMode] = useState<CoworkExecutionMode>(coworkConfig.executionMode || 'local');
  const [coworkMemoryEnabled, setCoworkMemoryEnabled] = useState<boolean>(coworkConfig.memoryEnabled ?? true);
  const [coworkMemoryLlmJudgeEnabled, setCoworkMemoryLlmJudgeEnabled] = useState<boolean>(coworkConfig.memoryLlmJudgeEnabled ?? false);
  const [coworkMemoryEntries, setCoworkMemoryEntries] = useState<CoworkUserMemoryEntry[]>([]);
  const [coworkMemoryStats, setCoworkMemoryStats] = useState<CoworkMemoryStats | null>(null);
  const [coworkMemoryListLoading, setCoworkMemoryListLoading] = useState<boolean>(false);
  const [coworkMemoryQuery, setCoworkMemoryQuery] = useState<string>('');
  const [coworkMemoryEditingId, setCoworkMemoryEditingId] = useState<string | null>(null);
  const [coworkMemoryDraftText, setCoworkMemoryDraftText] = useState<string>('');
  const [showMemoryModal, setShowMemoryModal] = useState<boolean>(false);
  const [, setCoworkSandboxStatus] = useState<CoworkSandboxStatus | null>(null);
  const [, setCoworkSandboxLoading] = useState(true);
  const [, setCoworkSandboxProgress] = useState<CoworkSandboxProgress | null>(null);
  useState(false); // coworkSandboxInstalling - reserved for future use

  useEffect(() => {
    setCoworkExecutionMode(coworkConfig.executionMode || 'local');
    setCoworkMemoryEnabled(coworkConfig.memoryEnabled ?? true);
    setCoworkMemoryLlmJudgeEnabled(coworkConfig.memoryLlmJudgeEnabled ?? false);
  }, [
    coworkConfig.executionMode,
    coworkConfig.memoryEnabled,
    coworkConfig.memoryLlmJudgeEnabled,
  ]);

  useEffect(() => () => {
    if (emailCopiedTimerRef.current != null) {
      window.clearTimeout(emailCopiedTimerRef.current);
    }
    if (updateCheckTimerRef.current != null) {
      window.clearTimeout(updateCheckTimerRef.current);
    }
  }, []);

  const loadCoworkSandboxStatus = useCallback(async () => {
    setCoworkSandboxLoading(true);
    try {
      const status = await coworkService.getSandboxStatus();
      setCoworkSandboxStatus(status);
      if (status?.progress) {
        setCoworkSandboxProgress(status.progress);
      }
    } catch (loadError) {
      console.error('Failed to load cowork sandbox status:', loadError);
      setCoworkSandboxStatus(null);
    } finally {
      setCoworkSandboxLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCoworkSandboxStatus();
  }, [loadCoworkSandboxStatus]);

  useEffect(() => {
    const unsubscribe = coworkService.onSandboxDownloadProgress((progress) => {
      setCoworkSandboxProgress(progress);
      if (progress.percent !== undefined && progress.percent >= 1) {
        void loadCoworkSandboxStatus();
      }
    });
    return () => unsubscribe();
  }, [loadCoworkSandboxStatus]);

  useEffect(() => {
    try {
      const config = configService.getConfig();
      
      // Set general settings
      initialThemeRef.current = config.theme;
      initialLanguageRef.current = config.language as import('../services/i18n').LanguageType;
      setTheme(config.theme);
      setLanguage(config.language as import('../services/i18n').LanguageType);
      setUseSystemProxy(config.useSystemProxy ?? false);
      setAiAssistantName(config.aiAssistantName || 'Adia Laura');
      setAiAssistantAvatar(config.aiAssistantAvatar || undefined);
      setUseNoobClawServer(forceCustomApi ? false : config.app?.useNoobClawServer !== false);
      const savedTestMode = config.app?.testMode ?? false;
      setTestMode(savedTestMode);
      if (savedTestMode) setTestModeUnlocked(true);

      // Load auto-launch setting
      window.electron.autoLaunch.get().then(({ enabled }) => {
        setAutoLaunchState(enabled);
      }).catch(err => {
        console.error('Failed to load auto-launch setting:', err);
      });
      
      // Set up providers based on saved config
      if (config.api) {
        // For backward compatibility with older config
        // Initialize active provider based on baseUrl
        const normalizedApiBaseUrl = config.api.baseUrl.toLowerCase();
        if (normalizedApiBaseUrl.includes('openai')) {
          setActiveProvider('openai');
          setProviders(prev => ({
            ...prev,
            openai: {
              ...prev.openai,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        } else if (normalizedApiBaseUrl.includes('deepseek')) {
          setActiveProvider('deepseek');
          setProviders(prev => ({
            ...prev,
            deepseek: {
              ...prev.deepseek,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        } else if (normalizedApiBaseUrl.includes('moonshot.ai') || normalizedApiBaseUrl.includes('moonshot.cn')) {
          setActiveProvider('moonshot');
          setProviders(prev => ({
            ...prev,
            moonshot: {
              ...prev.moonshot,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        } else if (normalizedApiBaseUrl.includes('googleapis')) {
          setActiveProvider('gemini');
          setProviders(prev => ({
            ...prev,
            gemini: {
              ...prev.gemini,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        } else if (normalizedApiBaseUrl.includes('anthropic')) {
          setActiveProvider('anthropic');
          setProviders(prev => ({
            ...prev,
            anthropic: {
              ...prev.anthropic,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        }
      }
      
      // Load provider-specific configurations if available
      // Merge saved config with default config to ensure newly added providers are visible
      if (config.providers) {
        setProviders(prev => {
          const merged = {
            ...prev,  // Keep default providers (including newly added anthropic)
            ...config.providers,  // Override with saved config
          };

          // After merging, find the first enabled provider to set as activeProvider
          // This ensures we don't use stale activeProvider from old config.api.baseUrl
          const firstEnabledProvider = providerKeys.find(providerKey => merged[providerKey]?.enabled);
          if (firstEnabledProvider) {
            setActiveProvider(firstEnabledProvider);
          }

          return Object.fromEntries(
            Object.entries(merged).map(([providerKey, providerConfig]) => {
              const models = providerConfig.models?.map(model => ({
                ...model,
                supportsImage: model.supportsImage ?? false,
              }));
              return [
                providerKey,
                {
                  ...providerConfig,
                  apiFormat: getEffectiveApiFormat(providerKey, (providerConfig as ProviderConfig).apiFormat),
                  models,
                },
              ];
            })
          ) as ProvidersConfig;
        });
      }
      
      // Load shortcut settings
      if (config.shortcuts) {
        setShortcuts(prev => ({
          ...prev,
          ...config.shortcuts,
        }));
      }
    } catch (error) {
      setError('Failed to load settings');
    }
  }, []);

  useEffect(() => {
    return () => {
      if (didSaveRef.current) {
        return;
      }
      themeService.setTheme(initialThemeRef.current);
      i18nService.setLanguage(initialLanguageRef.current, { persist: false });
    };
  }, []);

  // Watch for tab switch to ensure content area scrolls to top
  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = 0;
    }
  }, [activeTab]);

  useEffect(() => {
    setNoticeMessage(notice ?? null);
  }, [notice]);

  useEffect(() => {
    if (initialTab) {
      setActiveTab(initialTab);
    }
  }, [initialTab]);

  // Scroll to a specific section when requested
  useEffect(() => {
    if (scrollToSection && contentRef.current) {
      // Allow tab switch and render to complete
      const timer = setTimeout(() => {
        const el = contentRef.current?.querySelector(`[data-section="${scrollToSection}"]`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [scrollToSection, activeTab]);

  // Subscribe to language changes
  useEffect(() => {
    const unsubscribe = i18nService.subscribe(() => {
      setLanguage(i18nService.getLanguage());
    });
    return unsubscribe;
  }, []);

  // Compute visible providers — only show the supported provider list
  const visibleProviders = useMemo(() => {
    const filtered: Partial<ProvidersConfig> = {};
    for (const key of providerKeys) {
      if (providers[key as keyof ProvidersConfig]) {
        filtered[key as keyof ProvidersConfig] = providers[key as keyof ProvidersConfig];
      }
    }
    return filtered as ProvidersConfig;
  }, [providers]);

  // Ensure activeProvider is always in visibleProviders when language changes
  useEffect(() => {
    const visibleKeys = Object.keys(visibleProviders) as ProviderType[];
    if (visibleKeys.length > 0 && !visibleKeys.includes(activeProvider)) {
      // If current activeProvider is not visible, switch to first visible provider
      const firstEnabledVisible = visibleKeys.find(key => visibleProviders[key]?.enabled);
      setActiveProvider(firstEnabledVisible ?? visibleKeys[0]);
    }
  }, [visibleProviders, activeProvider]);

  // Handle provider change
  const handleProviderChange = (provider: ProviderType) => {
    setIsAddingModel(false);
    setIsEditingModel(false);
    setEditingModelId(null);
    setNewModelName('');
    setNewModelId('');
    setNewModelSupportsImage(false);
    setModelFormError(null);
    setActiveProvider(provider);
    // Clear test results when switching provider
    setIsTestResultModalOpen(false);
    setTestResult(null);
  };

  // Handle provider configuration change
  const handleProviderConfigChange = (provider: ProviderType, field: string, value: string) => {
    setProviders(prev => {
      if (field === 'apiFormat') {
        const nextApiFormat = getEffectiveApiFormat(provider, value);
        const nextProviderConfig: ProviderConfig = {
          ...prev[provider],
          apiFormat: nextApiFormat,
        };

        // Only auto-switch URL when current value is still a known default URL.
        if (shouldAutoSwitchProviderBaseUrl(provider, prev[provider].baseUrl)) {
          const defaultBaseUrl = getProviderDefaultBaseUrl(provider, nextApiFormat);
          if (defaultBaseUrl) {
            nextProviderConfig.baseUrl = defaultBaseUrl;
          }
        }

        return {
          ...prev,
          [provider]: nextProviderConfig,
        };
      }

      // Handle codingPlanEnabled toggle for moonshot
      if (field === 'codingPlanEnabled' && provider === 'moonshot') {
        const codingPlanEnabled = value === 'true';
        return {
          ...prev,
          moonshot: {
            ...prev.moonshot,
            codingPlanEnabled,
          },
        };
      }

      return {
        ...prev,
        [provider]: {
          ...prev[provider],
          [field]: value,
        },
      };
    });
  };

  const hasCoworkConfigChanges = coworkExecutionMode !== coworkConfig.executionMode
    || coworkMemoryEnabled !== coworkConfig.memoryEnabled
    || coworkMemoryLlmJudgeEnabled !== coworkConfig.memoryLlmJudgeEnabled;


  const loadCoworkMemoryData = useCallback(async () => {
    setCoworkMemoryListLoading(true);
    try {
      const [entries, stats] = await Promise.all([
        coworkService.listMemoryEntries({
          query: coworkMemoryQuery.trim() || undefined,
        }),
        coworkService.getMemoryStats(),
      ]);
      setCoworkMemoryEntries(entries);
      setCoworkMemoryStats(stats);
    } catch (loadError) {
      console.error('Failed to load cowork memory data:', loadError);
      setCoworkMemoryEntries([]);
      setCoworkMemoryStats(null);
    } finally {
      setCoworkMemoryListLoading(false);
    }
  }, [
    coworkMemoryQuery,
  ]);

  useEffect(() => {
    if (activeTab !== 'coworkMemory') return;
    void loadCoworkMemoryData();
  }, [activeTab, loadCoworkMemoryData]);

  const resetCoworkMemoryEditor = () => {
    setCoworkMemoryEditingId(null);
    setCoworkMemoryDraftText('');
    setShowMemoryModal(false);
  };

  const handleSaveCoworkMemoryEntry = async () => {
    const text = coworkMemoryDraftText.trim();
    if (!text) return;

    setCoworkMemoryListLoading(true);
    try {
      if (coworkMemoryEditingId) {
        await coworkService.updateMemoryEntry({
          id: coworkMemoryEditingId,
          text,
          status: 'created',
          isExplicit: true,
        });
      } else {
        await coworkService.createMemoryEntry({
          text,
          isExplicit: true,
        });
      }
      resetCoworkMemoryEditor();
      await loadCoworkMemoryData();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : i18nService.t('coworkMemoryCrudSaveFailed'));
    } finally {
      setCoworkMemoryListLoading(false);
    }
  };

  const handleEditCoworkMemoryEntry = (entry: CoworkUserMemoryEntry) => {
    setCoworkMemoryEditingId(entry.id);
    setCoworkMemoryDraftText(entry.text);
    setShowMemoryModal(true);
  };

  const handleDeleteCoworkMemoryEntry = async (entry: CoworkUserMemoryEntry) => {
    setCoworkMemoryListLoading(true);
    try {
      await coworkService.deleteMemoryEntry({ id: entry.id });
      if (coworkMemoryEditingId === entry.id) {
        resetCoworkMemoryEditor();
      }
      await loadCoworkMemoryData();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : i18nService.t('coworkMemoryCrudDeleteFailed'));
    } finally {
      setCoworkMemoryListLoading(false);
    }
  };

  const getMemoryStatusLabel = (status: CoworkUserMemoryEntry['status']): string => {
    if (status === 'created') return i18nService.t('coworkMemoryStatusActive');
    if (status === 'stale') return i18nService.t('coworkMemoryStatusInactive');
    return i18nService.t('coworkMemoryStatusDeleted');
  };

  const formatMemoryUpdatedAt = (timestamp: number): string => {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '-';
    try {
      return new Date(timestamp).toLocaleString(i18nService.getDateLocale());
    } catch {
      return '-';
    }
  };

  const handleOpenCoworkMemoryModal = () => {
    resetCoworkMemoryEditor();
    setShowMemoryModal(true);
  };

  // Toggle provider enabled status
  const toggleProviderEnabled = (provider: ProviderType) => {
    const providerConfig = providers[provider];
    const isEnabling = !providerConfig.enabled;
    const missingApiKey = providerRequiresApiKey(provider) && !providerConfig.apiKey.trim();

    if (isEnabling && missingApiKey) {
      setError(i18nService.t('apiKeyRequired'));
      return;
    }

    setProviders(prev => ({
      ...prev,
      [provider]: {
        ...prev[provider],
        enabled: !prev[provider].enabled
      }
    }));
  };

  const enableProvider = (provider: ProviderType) => {
    setProviders(prev => {
      if (prev[provider].enabled) {
        return prev;
      }

      return {
        ...prev,
        [provider]: {
          ...prev[provider],
          enabled: true,
        },
      };
    });
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsSaving(true);
    setError(null);

    try {
      const normalizedProviders = Object.fromEntries(
        Object.entries(providers).map(([providerKey, providerConfig]) => {
          const apiFormat = getEffectiveApiFormat(providerKey, providerConfig.apiFormat);
          return [
            providerKey,
            {
              ...providerConfig,
              apiFormat,
              baseUrl: resolveBaseUrl(providerKey as ProviderType, providerConfig.baseUrl, apiFormat),
            },
          ];
        })
      ) as ProvidersConfig;

      // Find the first enabled provider to use as the primary API
      const firstEnabledProvider = Object.entries(normalizedProviders).find(
        ([_, config]) => config.enabled
      );

      const primaryProvider = firstEnabledProvider
        ? firstEnabledProvider[1]
        : normalizedProviders[activeProvider];

      await configService.updateConfig({
        api: {
          key: primaryProvider.apiKey,
          baseUrl: primaryProvider.baseUrl,
        },
        providers: normalizedProviders, // Save all providers configuration
        theme,
        language,
        useSystemProxy,
        aiAssistantName: aiAssistantName.trim() || 'Adia Laura',
        aiAssistantAvatar: aiAssistantAvatar || undefined,
        shortcuts,
        app: {
          ...configService.getConfig().app,
          testMode,
          useNoobClawServer,
        },
      });

      // Apply theme
      themeService.setTheme(theme);

      // Apply language
      i18nService.setLanguage(language, { persist: false });

      // Set API with the primary provider
      apiService.setConfig({
        apiKey: primaryProvider.apiKey,
        baseUrl: primaryProvider.baseUrl,
      });

      // Update available model list in Redux store
      // When server mode is on, only show NoobClawAI; when off, only show third-party models
      const isNoobClawProvider = (name: string) => name === 'noobclawAI' || name === 'noobclawzhiyun';
      const allModels: { id: string; name: string; provider?: string; providerKey?: string; supportsImage?: boolean }[] = [];
      Object.entries(normalizedProviders).forEach(([providerName, config]) => {
        if (!config.enabled || !config.models) return;
        if (useNoobClawServer && !isNoobClawProvider(providerName)) return;
        if (!useNoobClawServer && isNoobClawProvider(providerName)) return;
        config.models.forEach(model => {
          allModels.push({
            id: model.id,
            name: model.name,
            provider: providerName.charAt(0).toUpperCase() + providerName.slice(1),
            providerKey: providerName,
            supportsImage: model.supportsImage ?? false,
          });
        });
      });
      dispatch(setAvailableModels(allModels));

      if (hasCoworkConfigChanges) {
        await coworkService.updateConfig({
          executionMode: coworkExecutionMode,
          memoryEnabled: coworkMemoryEnabled,
          memoryLlmJudgeEnabled: coworkMemoryLlmJudgeEnabled,
        });
      }

      didSaveRef.current = true;
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to save settings');
    } finally {
      setIsSaving(false);
    }
  };

  // Tab switch handler
  const handleTabChange = (tab: TabType) => {
    if (tab !== 'model') {
      setIsAddingModel(false);
      setIsEditingModel(false);
      setEditingModelId(null);
      setNewModelName('');
      setNewModelId('');
      setNewModelSupportsImage(false);
      setModelFormError(null);
    }
    setActiveTab(tab);
  };


  // Prevent click event propagation to background when clicking the settings window
  const handleSettingsClick = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  // Handlers for model operations
  const handleAddModel = () => {
    setIsAddingModel(true);
    setIsEditingModel(false);
    setEditingModelId(null);
    setNewModelName('');
    setNewModelId('');
    setNewModelSupportsImage(false);
    setModelFormError(null);
  };

  const handleEditModel = (modelId: string, modelName: string, supportsImage?: boolean) => {
    setIsAddingModel(false);
    setIsEditingModel(true);
    setEditingModelId(modelId);
    setNewModelName(modelName);
    setNewModelId(modelId);
    setNewModelSupportsImage(!!supportsImage);
    setModelFormError(null);
  };

  const handleDeleteModel = (modelId: string) => {
    if (!providers[activeProvider].models) return;
    
    const updatedModels = providers[activeProvider].models.filter(
      model => model.id !== modelId
    );
    
    setProviders(prev => ({
      ...prev,
      [activeProvider]: {
        ...prev[activeProvider],
        models: updatedModels
      }
    }));
  };

  const handleSaveNewModel = () => {
    const modelId = newModelId.trim();

    const modelName = newModelName.trim();
    if (!modelName || !modelId) {
      setModelFormError(i18nService.t('modelNameAndIdRequired'));
      return;
    }

    const currentModels = providers[activeProvider].models ?? [];
    const duplicateModel = currentModels.find(
      model => model.id === modelId && (!isEditingModel || model.id !== editingModelId)
    );
    if (duplicateModel) {
      setModelFormError(i18nService.t('modelIdExists'));
      return;
    }

    const nextModel = {
      id: modelId,
      name: modelName,
      supportsImage: newModelSupportsImage,
    };
    const updatedModels = isEditingModel && editingModelId
      ? currentModels.map(model => (model.id === editingModelId ? nextModel : model))
      : [...currentModels, nextModel];

    setProviders(prev => ({
      ...prev,
      [activeProvider]: {
        ...prev[activeProvider],
        models: updatedModels
      }
    }));

    setIsAddingModel(false);
    setIsEditingModel(false);
    setEditingModelId(null);
    setNewModelName('');
    setNewModelId('');
    setNewModelSupportsImage(false);
    setModelFormError(null);
  };

  const handleCancelModelEdit = () => {
    setIsAddingModel(false);
    setIsEditingModel(false);
    setEditingModelId(null);
    setNewModelName('');
    setNewModelId('');
    setNewModelSupportsImage(false);
    setModelFormError(null);
  };

  const handleModelDialogKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleCancelModelEdit();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSaveNewModel();
    }
  };

  const showTestResultModal = (
    result: Omit<ProviderConnectionTestResult, 'provider'>,
    provider: ProviderType
  ) => {
    setTestResult({
      ...result,
      provider,
    });
    setIsTestResultModalOpen(true);
  };

  // Test API connection
  const handleTestConnection = async () => {
    const testingProvider = activeProvider;
    const providerConfig = providers[testingProvider];
    setIsTesting(true);
    setIsTestResultModalOpen(false);
    setTestResult(null);

    if (providerRequiresApiKey(testingProvider) && !providerConfig.apiKey) {
      showTestResultModal({ success: false, message: i18nService.t('apiKeyRequired') }, testingProvider);
      setIsTesting(false);
      return;
    }

    // Get the first available model
    const firstModel = providerConfig.models?.[0];
    if (!firstModel) {
      showTestResultModal({ success: false, message: i18nService.t('noModelsConfigured') }, testingProvider);
      setIsTesting(false);
      return;
    }

    try {
      let response: Awaited<ReturnType<typeof window.electron.api.fetch>>;
      // Apply Coding Plan endpoint switch
      let effectiveBaseUrl = resolveBaseUrl(testingProvider, providerConfig.baseUrl, getEffectiveApiFormat(testingProvider, providerConfig.apiFormat));
      let effectiveApiFormat = getEffectiveApiFormat(testingProvider, providerConfig.apiFormat);
      
      // Handle Moonshot Coding Plan endpoint switch
      if (testingProvider === 'moonshot' && (providerConfig as { codingPlanEnabled?: boolean }).codingPlanEnabled) {
        if (effectiveApiFormat === 'anthropic') {
          effectiveBaseUrl = 'https://api.kimi.com/coding';
        } else {
          effectiveBaseUrl = 'https://api.kimi.com/coding/v1';
          effectiveApiFormat = 'openai';
        }
      }
      
      const normalizedBaseUrl = effectiveBaseUrl.replace(/\/+$/, '');
      // Unified into two protocol formats:
      // - anthropic: /v1/messages
      // - openai provider: /v1/responses
      // - other openai-compatible providers: /v1/chat/completions
      const useAnthropicFormat = effectiveApiFormat === 'anthropic';

      if (useAnthropicFormat) {
        const anthropicUrl = normalizedBaseUrl.endsWith('/v1')
          ? `${normalizedBaseUrl}/messages`
          : `${normalizedBaseUrl}/v1/messages`;
        response = await window.electron.api.fetch({
          url: anthropicUrl,
          method: 'POST',
          headers: {
            'x-api-key': providerConfig.apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: firstModel.id,
            max_tokens: CONNECTIVITY_TEST_TOKEN_BUDGET,
            messages: [{ role: 'user', content: 'Hi' }],
          }),
        });
      } else {
        const useResponsesApi = shouldUseOpenAIResponsesForProvider(testingProvider);
        const openaiUrl = useResponsesApi
          ? buildOpenAIResponsesUrl(normalizedBaseUrl)
          : buildOpenAICompatibleChatCompletionsUrl(normalizedBaseUrl, testingProvider);
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (providerConfig.apiKey) {
          headers.Authorization = `Bearer ${providerConfig.apiKey}`;
        }
        const openAIRequestBody: Record<string, unknown> = useResponsesApi
          ? {
              model: firstModel.id,
              input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }],
              max_output_tokens: CONNECTIVITY_TEST_TOKEN_BUDGET,
            }
          : {
              model: firstModel.id,
              messages: [{ role: 'user', content: 'Hi' }],
            };
        if (!useResponsesApi && shouldUseMaxCompletionTokensForOpenAI(testingProvider, firstModel.id)) {
          openAIRequestBody.max_completion_tokens = CONNECTIVITY_TEST_TOKEN_BUDGET;
        } else {
          if (!useResponsesApi) {
            openAIRequestBody.max_tokens = CONNECTIVITY_TEST_TOKEN_BUDGET;
          }
        }
        response = await window.electron.api.fetch({
          url: openaiUrl,
          method: 'POST',
          headers,
          body: JSON.stringify(openAIRequestBody),
        });
      }

      if (response.ok) {
        enableProvider(testingProvider);
        showTestResultModal({ success: true, message: i18nService.t('connectionSuccess') }, testingProvider);
      } else {
        const data = response.data || {};
        // Extract error message
        const errorMessage = data.error?.message || data.message || `${i18nService.t('connectionFailed')}: ${response.status}`;
        if (typeof errorMessage === 'string' && errorMessage.toLowerCase().includes('model output limit was reached')) {
          enableProvider(testingProvider);
          showTestResultModal({ success: true, message: i18nService.t('connectionSuccess') }, testingProvider);
          return;
        }
        showTestResultModal({ success: false, message: errorMessage }, testingProvider);
      }
    } catch (err) {
      showTestResultModal({
        success: false,
        message: err instanceof Error ? err.message : i18nService.t('connectionFailed'),
      }, testingProvider);
    } finally {
      setIsTesting(false);
    }
  };

  const buildProvidersExport = async (password: string): Promise<ProvidersExportPayload> => {
    const entries = await Promise.all(
      Object.entries(providers).map(async ([providerKey, providerConfig]) => {
        const apiKey = await encryptWithPassword(providerConfig.apiKey, password);
        const apiFormat = getEffectiveApiFormat(providerKey, providerConfig.apiFormat);
        return [
          providerKey,
          {
            enabled: providerConfig.enabled,
            apiKey,
            baseUrl: resolveBaseUrl(providerKey as ProviderType, providerConfig.baseUrl, apiFormat),
            apiFormat,
            codingPlanEnabled: (providerConfig as ProviderConfig).codingPlanEnabled,
            models: providerConfig.models,
          },
        ] as const;
      })
    );

    return {
      type: EXPORT_FORMAT_TYPE,
      version: 2,
      exportedAt: new Date().toISOString(),
      encryption: {
        algorithm: 'AES-GCM',
        keySource: 'password',
        keyDerivation: 'PBKDF2',
      },
      providers: Object.fromEntries(entries),
    };
  };

  const normalizeModels = (models?: Model[]) =>
    models?.map(model => ({
      ...model,
      supportsImage: model.supportsImage ?? false,
    }));

  const DEFAULT_EXPORT_PASSWORD = EXPORT_PASSWORD;

  const handleExportProviders = async () => {
    setError(null);
    setIsExportingProviders(true);

    try {
      const payload = await buildProvidersExport(DEFAULT_EXPORT_PASSWORD);
      const json = JSON.stringify(payload, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const date = new Date().toISOString().slice(0, 10);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${APP_ID}-providers-${date}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (err) {
      console.error('Failed to export providers:', err);
      setError(i18nService.t('exportProvidersFailed'));
    } finally {
      setIsExportingProviders(false);
    }
  };

  const handleImportProvidersClick = () => {
    importInputRef.current?.click();
  };

  const handleImportProviders = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }

    setError(null);

    try {
      const raw = await file.text();
      let payload: ProvidersImportPayload;
      try {
        payload = JSON.parse(raw) as ProvidersImportPayload;
      } catch (parseError) {
        setError(i18nService.t('invalidProvidersFile'));
        return;
      }

      if (!payload || payload.type !== EXPORT_FORMAT_TYPE || !payload.providers) {
        setError(i18nService.t('invalidProvidersFile'));
        return;
      }

      // Check if it's version 2 (password-based encryption)
      if (payload.version === 2 && payload.encryption?.keySource === 'password') {
        await processImportPayloadWithPassword(payload);
        return;
      }

      // Version 1 (legacy local-store key) - try to decrypt with local key
      if (payload.version === 1) {
        await processImportPayloadWithLocalKey(payload);
        return;
      }

      setError(i18nService.t('invalidProvidersFile'));
    } catch (err) {
      console.error('Failed to import providers:', err);
      setError(i18nService.t('importProvidersFailed'));
    }
  };

  const processImportPayloadWithLocalKey = async (payload: ProvidersImportPayload) => {
    setIsImportingProviders(true);
    try {
      const providerUpdates: Partial<ProvidersConfig> = {};
      let hadDecryptFailure = false;
      for (const providerKey of providerKeys) {
        const providerData = payload.providers?.[providerKey];
        if (!providerData) {
          continue;
        }

        let apiKey: string | undefined;
        if (typeof providerData.apiKey === 'string') {
          apiKey = providerData.apiKey;
        } else if (providerData.apiKey && typeof providerData.apiKey === 'object') {
          try {
            apiKey = await decryptSecret(providerData.apiKey as EncryptedPayload);
          } catch (error) {
            hadDecryptFailure = true;
            console.warn(`Failed to decrypt provider key for ${providerKey}`, error);
          }
        } else if (typeof providerData.apiKeyEncrypted === 'string' && typeof providerData.apiKeyIv === 'string') {
          try {
            apiKey = await decryptSecret({ encrypted: providerData.apiKeyEncrypted, iv: providerData.apiKeyIv });
          } catch (error) {
            hadDecryptFailure = true;
            console.warn(`Failed to decrypt provider key for ${providerKey}`, error);
          }
        }

        const models = normalizeModels(providerData.models);

        providerUpdates[providerKey] = {
          enabled: typeof providerData.enabled === 'boolean' ? providerData.enabled : providers[providerKey].enabled,
          apiKey: apiKey ?? providers[providerKey].apiKey,
          baseUrl: typeof providerData.baseUrl === 'string' ? providerData.baseUrl : providers[providerKey].baseUrl,
          apiFormat: getEffectiveApiFormat(providerKey, providerData.apiFormat ?? providers[providerKey].apiFormat),
          codingPlanEnabled: typeof providerData.codingPlanEnabled === 'boolean' ? providerData.codingPlanEnabled : (providers[providerKey] as ProviderConfig).codingPlanEnabled,
          models: models ?? providers[providerKey].models,
        };
      }

      if (Object.keys(providerUpdates).length === 0) {
        setError(i18nService.t('invalidProvidersFile'));
        return;
      }

      setProviders(prev => {
        const next = { ...prev };
        Object.entries(providerUpdates).forEach(([providerKey, update]) => {
          next[providerKey] = {
            ...prev[providerKey],
            ...update,
          };
        });
        return next;
      });
      setIsTestResultModalOpen(false);
      setTestResult(null);
      if (hadDecryptFailure) {
        setNoticeMessage(i18nService.t('decryptProvidersPartial'));
      }
    } catch (err) {
      console.error('Failed to import providers:', err);
      const isDecryptError = err instanceof Error
        && (err.message === 'Invalid encrypted payload' || err.name === 'OperationError');
      const message = isDecryptError
        ? i18nService.t('decryptProvidersFailed')
        : i18nService.t('importProvidersFailed');
      setError(message);
    } finally {
      setIsImportingProviders(false);
    }
  };

  const processImportPayloadWithPassword = async (payload: ProvidersImportPayload) => {
    if (!payload.providers) {
      return;
    }

    setIsImportingProviders(true);

    try {
      const providerUpdates: Partial<ProvidersConfig> = {};
      let hadDecryptFailure = false;

      for (const providerKey of providerKeys) {
        const providerData = payload.providers[providerKey];
        if (!providerData) {
          continue;
        }

        let apiKey: string | undefined;
        if (typeof providerData.apiKey === 'string') {
          apiKey = providerData.apiKey;
        } else if (providerData.apiKey && typeof providerData.apiKey === 'object') {
          const apiKeyObj = providerData.apiKey as PasswordEncryptedPayload;
          if (apiKeyObj.salt) {
            // Version 2 password-based encryption
            try {
              apiKey = await decryptWithPassword(apiKeyObj, DEFAULT_EXPORT_PASSWORD);
            } catch (error) {
              hadDecryptFailure = true;
              console.warn(`Failed to decrypt provider key for ${providerKey}`, error);
            }
          }
        }

        const models = normalizeModels(providerData.models);

        providerUpdates[providerKey] = {
          enabled: typeof providerData.enabled === 'boolean' ? providerData.enabled : providers[providerKey].enabled,
          apiKey: apiKey ?? providers[providerKey].apiKey,
          baseUrl: typeof providerData.baseUrl === 'string' ? providerData.baseUrl : providers[providerKey].baseUrl,
          apiFormat: getEffectiveApiFormat(providerKey, providerData.apiFormat ?? providers[providerKey].apiFormat),
          codingPlanEnabled: typeof providerData.codingPlanEnabled === 'boolean' ? providerData.codingPlanEnabled : (providers[providerKey] as ProviderConfig).codingPlanEnabled,
          models: models ?? providers[providerKey].models,
        };
      }

      if (Object.keys(providerUpdates).length === 0) {
        setError(i18nService.t('invalidProvidersFile'));
        return;
      }

      // Check if any key was successfully decrypted
      const anyKeyDecrypted = Object.entries(providerUpdates).some(
        ([key, update]) => update?.apiKey && update.apiKey !== providers[key]?.apiKey
      );

      if (!anyKeyDecrypted && hadDecryptFailure) {
        // All decryptions failed - likely wrong password
        setError(i18nService.t('decryptProvidersFailed'));
        return;
      }

      setProviders(prev => {
        const next = { ...prev };
        Object.entries(providerUpdates).forEach(([providerKey, update]) => {
          next[providerKey] = {
            ...prev[providerKey],
            ...update,
          };
        });
        return next;
      });
      setIsTestResultModalOpen(false);
      setTestResult(null);
      if (hadDecryptFailure) {
        setNoticeMessage(i18nService.t('decryptProvidersPartial'));
      }
    } catch (err) {
      console.error('Failed to import providers:', err);
      const isDecryptError = err instanceof Error
        && (err.message === 'Invalid encrypted payload' || err.name === 'OperationError');
      const message = isDecryptError
        ? i18nService.t('decryptProvidersFailed')
        : i18nService.t('importProvidersFailed');
      setError(message);
    } finally {
      setIsImportingProviders(false);
    }
  };

  // Render tabs
  const sidebarTabs: { key: TabType; label: string; icon: React.ReactNode }[] = useMemo(() => [
    { key: 'general',        label: i18nService.t('general'),        icon: <span className="text-base">&#x2699;&#xFE0F;</span> },
    // 「AI服务」tab(model)已下线:矩阵版始终用 NoobClaw AI 服务,不暴露切换自定义 API Key 的入口。
    // useNoobClawServer 默认 true,渲染分支与 LoginWall/Cowork 的旧入口保留但侧栏不再可达。
    { key: 'email',          label: i18nService.t('emailTab'),       icon: <span className="text-base">&#x1F4E7;</span> },
    { key: 'coworkMemory',   label: i18nService.t('coworkMemoryTitle'), icon: <span className="text-base">&#x1F9E0;</span> },
    { key: 'advanced',       label: i18nService.t('stAdvancedTab'), icon: <span className="text-base">&#x1F527;</span> },
    { key: 'about',          label: i18nService.t('about'),          icon: <span className="text-base">&#x2139;&#xFE0F;</span> },
  ], [language]);

  const activeTabLabel = useMemo(() => {
    return sidebarTabs.find(t => t.key === activeTab)?.label ?? '';
  }, [activeTab, sidebarTabs]);

  const renderTabContent = () => {
    switch(activeTab) {
      case 'general':
        return (
          <div className="space-y-8">
            {/* Language Section */}
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                {i18nService.t('language')}
              </h4>
              <div className="w-[140px] shrink-0">
                <ThemedSelect
                  id="language"
                  value={language}
                  onChange={(value) => {
                    const nextLanguage = value as LanguageType;
                    setLanguage(nextLanguage);
                    i18nService.setLanguage(nextLanguage, { persist: false });
                  }}
                  options={HIDE_WEB3 ? [
                    // 国内版只支持简体中文,其余语言隐藏
                    { value: 'zh', label: '简体中文' },
                  ] : [
                    { value: 'zh', label: '简体中文' },
                    { value: 'en', label: 'English' },
                    { value: 'zh-TW', label: '繁體中文' },
                    { value: 'ko', label: '한국어' },
                    { value: 'ja', label: '日本語' },
                    { value: 'ru', label: 'Русский' },
                    { value: 'fr', label: 'Français' },
                    { value: 'de', label: 'Deutsch' },
                    { value: 'vi', label: 'Tiếng Việt' },
                  ]}
                />
              </div>
            </div>

            {/* AI Assistant Personalization Section */}
            <div data-section="ai-assistant">
              <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-3">
                {i18nService.t('aiAssistantSection')}
              </h4>
              <div className="flex items-start gap-4">
                {/* Avatar */}
                <div className="flex flex-col items-center gap-1.5">
                  <div
                    className="relative w-16 h-16 rounded-full overflow-hidden cursor-pointer group border-2 border-transparent hover:border-claude-accent transition-colors"
                    onClick={() => aiAvatarInputRef.current?.click()}
                  >
                    <img
                      src={aiAssistantAvatar || lauraAvatarUrl}
                      alt={aiAssistantName}
                      className="w-full h-full object-cover"
                    />
                    <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-white" viewBox="0 0 20 20" fill="currentColor">
                        <path d="M4 5a2 2 0 00-2 2v8a2 2 0 002 2h12a2 2 0 002-2V7a2 2 0 00-2-2h-1.586a1 1 0 01-.707-.293l-1.121-1.121A2 2 0 0011.172 3H8.828a2 2 0 00-1.414.586L6.293 4.707A1 1 0 015.586 5H4zm6 9a3 3 0 100-6 3 3 0 000 6z" />
                      </svg>
                    </div>
                  </div>
                  <input
                    ref={aiAvatarInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      if (file.size > 2 * 1024 * 1024) {
                        setError(i18nService.t('aiAssistantAvatarTooLarge'));
                        return;
                      }
                      const reader = new FileReader();
                      reader.onload = () => {
                        setAiAssistantAvatar(reader.result as string);
                      };
                      reader.readAsDataURL(file);
                      e.target.value = '';
                    }}
                  />
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => aiAvatarInputRef.current?.click()}
                      className="px-2 py-0.5 text-[10px] rounded dark:bg-gray-700 bg-gray-200 dark:text-gray-300 text-gray-600 hover:opacity-80 transition-opacity"
                    >
                      {i18nService.t('aiAssistantAvatarChange')}
                    </button>
                    {(aiAssistantAvatar || aiAssistantName !== 'Adia Laura') && (
                      <button
                        type="button"
                        onClick={() => { setAiAssistantAvatar(undefined); setAiAssistantName('Adia Laura'); }}
                        className="px-2 py-0.5 text-[10px] rounded dark:bg-gray-700 bg-gray-200 dark:text-gray-300 text-gray-600 hover:opacity-80 transition-opacity"
                      >
                        {i18nService.t('aiAssistantAvatarReset')}
                      </button>
                    )}
                  </div>
                </div>
                {/* Name */}
                <div className="flex-1 min-w-0">
                  <label className="text-xs dark:text-claude-darkSecondaryText text-claude-secondaryText mb-1 block">
                    {i18nService.t('aiAssistantName')}
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={aiAssistantName}
                      onChange={(e) => {
                        const val = [...e.target.value].slice(0, 30).join('');
                        setAiAssistantName(val);
                      }}
                      placeholder={i18nService.t('aiAssistantNamePlaceholder')}
                      className="flex-1 px-3 py-1.5 rounded-lg text-sm border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-white dark:text-claude-darkText text-claude-text focus:outline-none focus:ring-1 focus:ring-claude-accent"
                    />
                    {(aiAssistantName !== 'Adia Laura' || aiAssistantAvatar) && (
                      <button
                        type="button"
                        onClick={() => { setAiAssistantName('Adia Laura'); setAiAssistantAvatar(undefined); }}
                        className="px-2.5 py-1.5 text-xs rounded-lg dark:bg-gray-700 bg-gray-200 dark:text-gray-300 text-gray-600 hover:opacity-80 transition-opacity whitespace-nowrap"
                      >
                        {i18nService.t('aiAssistantNameDefault')}
                      </button>
                    )}
                  </div>
                  <p className="text-[10px] dark:text-claude-darkSecondaryText/70 text-claude-secondaryText/70 mt-1">
                    {i18nService.t('aiAssistantNameDesc')}
                  </p>
                </div>
              </div>
            </div>

            {/* Auto-launch Section */}
            <div>
              <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-3">
                {i18nService.t('autoLaunch')}
              </h4>
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-sm dark:text-claude-darkSecondaryText text-claude-secondaryText">
                  {i18nService.t('autoLaunchDescription')}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoLaunch}
                  onClick={async () => {
                    if (isUpdatingAutoLaunch) return;
                    const next = !autoLaunch;
                    setIsUpdatingAutoLaunch(true);
                    try {
                      const result = await window.electron.autoLaunch.set(next);
                      if (result.success) {
                        setAutoLaunchState(next);
                      } else {
                        setError(result.error || 'Failed to update auto-launch setting');
                      }
                    } catch (err) {
                      console.error('Failed to set auto-launch:', err);
                      setError('Failed to update auto-launch setting');
                    } finally {
                      setIsUpdatingAutoLaunch(false);
                    }
                  }}
                  disabled={isUpdatingAutoLaunch}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                    isUpdatingAutoLaunch ? 'opacity-50 cursor-not-allowed' : ''
                  } ${
                    autoLaunch
                      ? 'bg-claude-accent'
                      : 'bg-gray-300 dark:bg-gray-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      autoLaunch ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </label>
            </div>

            {/* System proxy Section */}
            <div>
              <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-3">
                {i18nService.t('useSystemProxy')}
              </h4>
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-sm dark:text-claude-darkSecondaryText text-claude-secondaryText">
                  {i18nService.t('useSystemProxyDescription')}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={useSystemProxy}
                  onClick={() => {
                    setUseSystemProxy((prev) => !prev);
                  }}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                    useSystemProxy
                      ? 'bg-claude-accent'
                      : 'bg-gray-300 dark:bg-gray-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      useSystemProxy ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </label>
            </div>

            {false && (
            <div>
              <div className="grid grid-cols-1 gap-4">
                {([
                  { value: 'dark', label: '' },
                ] as { value: string; label: string }[]).map((option) => {
                  const isSelected = true;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      disabled
                      className=""
                    >
                      <svg viewBox="0 0 120 80" className="w-full h-auto rounded-md mb-2 overflow-hidden" xmlns="http://www.w3.org/2000/svg">
                        {option.value === 'light' && (
                          <>
                            <rect width="120" height="80" fill="#F8F9FB" />
                            <rect x="0" y="0" width="30" height="80" fill="#EBEDF0" />
                            <rect x="4" y="8" width="22" height="4" rx="2" fill="#C8CBD0" />
                            <rect x="4" y="16" width="18" height="3" rx="1.5" fill="#D5D7DB" />
                            <rect x="4" y="22" width="20" height="3" rx="1.5" fill="#D5D7DB" />
                            <rect x="4" y="28" width="16" height="3" rx="1.5" fill="#D5D7DB" />
                            <rect x="36" y="8" width="78" height="64" rx="4" fill="#FFFFFF" />
                            <rect x="42" y="16" width="50" height="4" rx="2" fill="#D5D7DB" />
                            <rect x="42" y="24" width="66" height="3" rx="1.5" fill="#E2E4E7" />
                            <rect x="42" y="30" width="60" height="3" rx="1.5" fill="#E2E4E7" />
                            <rect x="42" y="36" width="55" height="3" rx="1.5" fill="#E2E4E7" />
                            <rect x="42" y="46" width="40" height="4" rx="2" fill="#D5D7DB" />
                            <rect x="42" y="54" width="66" height="3" rx="1.5" fill="#E2E4E7" />
                            <rect x="42" y="60" width="58" height="3" rx="1.5" fill="#E2E4E7" />
                          </>
                        )}
                        {option.value === 'dark' && (
                          <>
                            <rect width="120" height="80" fill="#0F1117" />
                            <rect x="0" y="0" width="30" height="80" fill="#151820" />
                            <rect x="4" y="8" width="22" height="4" rx="2" fill="#3A3F4B" />
                            <rect x="4" y="16" width="18" height="3" rx="1.5" fill="#2A2F3A" />
                            <rect x="4" y="22" width="20" height="3" rx="1.5" fill="#2A2F3A" />
                            <rect x="4" y="28" width="16" height="3" rx="1.5" fill="#2A2F3A" />
                            <rect x="36" y="8" width="78" height="64" rx="4" fill="#1A1D27" />
                            <rect x="42" y="16" width="50" height="4" rx="2" fill="#3A3F4B" />
                            <rect x="42" y="24" width="66" height="3" rx="1.5" fill="#252930" />
                            <rect x="42" y="30" width="60" height="3" rx="1.5" fill="#252930" />
                            <rect x="42" y="36" width="55" height="3" rx="1.5" fill="#252930" />
                            <rect x="42" y="46" width="40" height="4" rx="2" fill="#3A3F4B" />
                            <rect x="42" y="54" width="66" height="3" rx="1.5" fill="#252930" />
                            <rect x="42" y="60" width="58" height="3" rx="1.5" fill="#252930" />
                          </>
                        )}
                        {option.value === 'system' && (
                          <>
                            <defs>
                              <clipPath id="left-half">
                                <rect x="0" y="0" width="60" height="80" />
                              </clipPath>
                              <clipPath id="right-half">
                                <rect x="60" y="0" width="60" height="80" />
                              </clipPath>
                            </defs>
                            {/* Light half */}
                            <g clipPath="url(#left-half)">
                              <rect width="120" height="80" fill="#F8F9FB" />
                              <rect x="0" y="0" width="30" height="80" fill="#EBEDF0" />
                              <rect x="4" y="8" width="22" height="4" rx="2" fill="#C8CBD0" />
                              <rect x="4" y="16" width="18" height="3" rx="1.5" fill="#D5D7DB" />
                              <rect x="4" y="22" width="20" height="3" rx="1.5" fill="#D5D7DB" />
                              <rect x="4" y="28" width="16" height="3" rx="1.5" fill="#D5D7DB" />
                              <rect x="36" y="8" width="78" height="64" rx="4" fill="#FFFFFF" />
                              <rect x="42" y="16" width="50" height="4" rx="2" fill="#D5D7DB" />
                              <rect x="42" y="24" width="66" height="3" rx="1.5" fill="#E2E4E7" />
                              <rect x="42" y="30" width="60" height="3" rx="1.5" fill="#E2E4E7" />
                              <rect x="42" y="36" width="55" height="3" rx="1.5" fill="#E2E4E7" />
                              <rect x="42" y="46" width="40" height="4" rx="2" fill="#D5D7DB" />
                              <rect x="42" y="54" width="66" height="3" rx="1.5" fill="#E2E4E7" />
                            </g>
                            {/* Dark half */}
                            <g clipPath="url(#right-half)">
                              <rect width="120" height="80" fill="#0F1117" />
                              <rect x="0" y="0" width="30" height="80" fill="#151820" />
                              <rect x="4" y="8" width="22" height="4" rx="2" fill="#3A3F4B" />
                              <rect x="4" y="16" width="18" height="3" rx="1.5" fill="#2A2F3A" />
                              <rect x="4" y="22" width="20" height="3" rx="1.5" fill="#2A2F3A" />
                              <rect x="4" y="28" width="16" height="3" rx="1.5" fill="#2A2F3A" />
                              <rect x="36" y="8" width="78" height="64" rx="4" fill="#1A1D27" />
                              <rect x="42" y="16" width="50" height="4" rx="2" fill="#3A3F4B" />
                              <rect x="42" y="24" width="66" height="3" rx="1.5" fill="#252930" />
                              <rect x="42" y="30" width="60" height="3" rx="1.5" fill="#252930" />
                              <rect x="42" y="36" width="55" height="3" rx="1.5" fill="#252930" />
                              <rect x="42" y="46" width="40" height="4" rx="2" fill="#3A3F4B" />
                              <rect x="42" y="54" width="66" height="3" rx="1.5" fill="#252930" />
                            </g>
                            {/* Divider line */}
                            <line x1="60" y1="0" x2="60" y2="80" stroke="#888" strokeWidth="0.5" />
                          </>
                        )}
                      </svg>
                      <span className={`text-xs font-medium ${
                        isSelected
                          ? 'text-claude-accent'
                          : 'dark:text-claude-darkText text-claude-text'
                      }`}>
                        {option.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
            )}
          </div>
        );

      case 'email':
        return <EmailSkillConfig />;

      case 'coworkMemory':
        return (
          <div className="space-y-6">
            <div className="space-y-3 rounded-xl border px-4 py-4 dark:border-claude-darkBorder border-claude-border">
              <div className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                {i18nService.t('coworkMemoryTitle')}
              </div>
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={coworkMemoryEnabled}
                  onChange={(event) => setCoworkMemoryEnabled(event.target.checked)}
                  className="mt-1"
                />
                <span>
                  <span className="block text-sm dark:text-claude-darkText text-claude-text">
                    {i18nService.t('coworkMemoryEnabled')}
                  </span>
                  <span className="block text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('coworkMemoryEnabledHint')}
                  </span>
                  <span className="mt-1 block text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('coworkMemorySimpleHint')}
                  </span>
                </span>
              </label>
              <label className={`flex items-start gap-3 ${coworkMemoryEnabled ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}>
                <input
                  type="checkbox"
                  checked={coworkMemoryLlmJudgeEnabled}
                  onChange={(event) => setCoworkMemoryLlmJudgeEnabled(event.target.checked)}
                  disabled={!coworkMemoryEnabled}
                  className="mt-1"
                />
                <span>
                  <span className="block text-sm dark:text-claude-darkText text-claude-text">
                    {i18nService.t('coworkMemoryLlmJudgeEnabled')}
                  </span>
                  <span className="block text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('coworkMemoryLlmJudgeEnabledHint')}
                  </span>
                </span>
              </label>
            </div>

            <div className="space-y-4 rounded-xl border px-4 py-4 dark:border-claude-darkBorder border-claude-border">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <div className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                    {i18nService.t('coworkMemoryCrudTitle')}
                  </div>
                  <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('coworkMemoryManageHint')}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleOpenCoworkMemoryModal}
                  className="inline-flex items-center justify-center px-3 py-1.5 rounded-lg bg-claude-accent hover:bg-claude-accentHover text-white text-sm transition-colors active:scale-[0.98]"
                >
                  <PlusCircleIcon className="h-4 w-4 mr-1.5" />
                  {i18nService.t('coworkMemoryCrudCreate')}
                </button>
              </div>

              {coworkMemoryStats && (
                <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {`${i18nService.t('coworkMemoryTotalLabel')}: ${coworkMemoryStats.created + coworkMemoryStats.stale} · ${i18nService.t('coworkMemoryActiveLabel')}: ${coworkMemoryStats.created} · ${i18nService.t('coworkMemoryInactiveLabel')}: ${coworkMemoryStats.stale}`}
                </div>
              )}

              <input
                type="text"
                value={coworkMemoryQuery}
                onChange={(event) => setCoworkMemoryQuery(event.target.value)}
                placeholder={i18nService.t('coworkMemorySearchPlaceholder')}
                className="w-full rounded-lg border px-3 py-2 text-sm dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface"
              />

              <div className="max-h-[500px] overflow-auto rounded-lg border dark:border-claude-darkBorder border-claude-border">
                {coworkMemoryListLoading ? (
                  <div className="px-3 py-3 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('loading')}
                  </div>
                ) : coworkMemoryEntries.length === 0 ? (
                  <div className="px-3 py-3 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('coworkMemoryEmpty')}
                  </div>
                ) : (
                  <div className="divide-y dark:divide-claude-darkBorder divide-claude-border">
                    {coworkMemoryEntries.map((entry) => (
                      <div key={entry.id} className="px-3 py-3 text-xs hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 space-y-1 min-w-0">
                            <div className="font-medium dark:text-claude-darkText text-claude-text break-words">
                              {entry.text}
                            </div>
                            <div className="flex flex-wrap items-center gap-2 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                              <span className="rounded-full border px-2 py-0.5 dark:border-claude-darkBorder border-claude-border">
                                {getMemoryStatusLabel(entry.status)}
                              </span>
                              <span>
                                {`${i18nService.t('coworkMemoryUpdatedAt')}: ${formatMemoryUpdatedAt(entry.updatedAt)}`}
                              </span>
                            </div>
                          </div>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <button
                              type="button"
                              onClick={() => handleEditCoworkMemoryEntry(entry)}
                              className="rounded border px-2 py-1 dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
                            >
                              {i18nService.t('edit')}
                            </button>
                            <button
                              type="button"
                              onClick={() => { void handleDeleteCoworkMemoryEntry(entry); }}
                              className="rounded border px-2 py-1 text-red-500 dark:border-claude-darkBorder border-claude-border hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-60 transition-colors"
                              disabled={coworkMemoryListLoading}
                            >
                              {i18nService.t('delete')}
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

          </div>
        );

      case 'model':
        return (
          <div className="flex flex-col h-full">
            {/* NoobClawAI service toggle */}
            <div className="flex items-center justify-between mb-4 pb-4 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
              <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                {useNoobClawServer ? i18nService.t('stUseNoobClawServer') : i18nService.t('stUseCustomApiKey')}
              </h4>
              <button
                type="button"
                role="switch"
                aria-checked={useNoobClawServer}
                onClick={() => setUseNoobClawServer((prev) => !prev)}
                className={`relative inline-flex h-6 w-11 ml-4 shrink-0 items-center rounded-full transition-colors ${
                  useNoobClawServer ? 'bg-claude-accent' : 'bg-gray-300 dark:bg-gray-600'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    useNoobClawServer ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>
            {!useNoobClawServer && (
            <div className="flex flex-1 min-h-0">
            {/* Provider List - Left Side */}
            <div className="w-2/5 border-r dark:border-claude-darkBorder border-claude-border pr-3 space-y-1.5 overflow-y-auto">
              <div className="flex items-center justify-between mb-2 px-1">
                <h3 className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                  {i18nService.t('modelProviders')}
                </h3>
                <div className="flex items-center space-x-1">
                  <button
                    type="button"
                    onClick={handleImportProvidersClick}
                    disabled={isImportingProviders || isExportingProviders}
                    className="inline-flex items-center px-2 py-1 text-[11px] font-medium rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
                  >
                    {i18nService.t('import')}
                  </button>
                  <button
                    type="button"
                    onClick={handleExportProviders}
                    disabled={isImportingProviders || isExportingProviders}
                    className="inline-flex items-center px-2 py-1 text-[11px] font-medium rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
                  >
                    {i18nService.t('export')}
                  </button>
                </div>
              </div>
              <input
                ref={importInputRef}
                type="file"
                accept="application/json"
                className="hidden"
                onChange={handleImportProviders}
              />
              {Object.entries(visibleProviders).map(([provider, config]) => {
                const providerKey = provider as ProviderType;
                const providerInfo = providerMeta[providerKey];
                const missingApiKey = providerRequiresApiKey(providerKey) && !config.apiKey.trim();
                const canToggleProvider = config.enabled || !missingApiKey;
                return (
                  <div
                    key={provider}
                    onClick={() => handleProviderChange(providerKey)}
                    className={`flex items-center p-2 rounded-xl cursor-pointer transition-colors ${
                      activeProvider === provider
                        ? 'bg-claude-accent/10 dark:bg-claude-accent/20 border border-claude-accent/30 shadow-subtle'
                        : 'dark:bg-claude-darkSurface/50 bg-claude-surface hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover border border-transparent'
                    }`}
                  >
                    <div className="flex flex-1 items-center">
                      <div className="mr-2 flex h-7 w-7 items-center justify-center">
                        <span className="dark:text-claude-darkText text-claude-text">
                          {providerInfo?.icon}
                        </span>
                      </div>
                      <span className={`text-sm font-medium truncate ${
                        activeProvider === provider
                          ? 'text-claude-accent'
                          : 'dark:text-claude-darkText text-claude-text'
                      }`}>
                        {providerInfo?.label ?? provider.charAt(0).toUpperCase() + provider.slice(1)}
                      </span>
                    </div>
                    <div className="flex items-center ml-2">
                      <div
                        title={!canToggleProvider ? i18nService.t('configureApiKey') : undefined}
                        className={`w-7 h-4 rounded-full flex items-center transition-colors ${
                          config.enabled ? 'bg-claude-accent' : 'dark:bg-claude-darkBorder bg-claude-border'
                        } ${
                          canToggleProvider ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'
                        }`}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!canToggleProvider) {
                            return;
                          }
                          toggleProviderEnabled(providerKey);
                        }}
                      >
                        <div
                          className={`w-3 h-3 rounded-full bg-white shadow-md transform transition-transform ${
                            config.enabled ? 'translate-x-3.5' : 'translate-x-0.5'
                          }`}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Provider Settings - Right Side */}
            <div className="w-3/5 pl-4 pr-2 space-y-4 overflow-y-auto [scrollbar-gutter:stable]">
              <div className="flex items-center justify-between pb-2 border-b dark:border-claude-darkBorder border-claude-border">
                <h3 className="text-base font-medium dark:text-claude-darkText text-claude-text">
                  {(providerMeta[activeProvider]?.label ?? activeProvider.charAt(0).toUpperCase() + activeProvider.slice(1))} {i18nService.t('providerSettings')}
                </h3>
                <div
                  className={`px-2 py-0.5 rounded-lg text-xs font-medium ${
                    providers[activeProvider].enabled
                      ? 'bg-green-500/20 text-green-600 dark:text-green-400'
                      : 'bg-red-500/20 text-red-600 dark:text-red-400'
                  }`}
                >
                  {providers[activeProvider].enabled ? i18nService.t('providerStatusOn') : i18nService.t('providerStatusOff')}
                </div>
              </div>

              {providerRequiresApiKey(activeProvider) && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label htmlFor={`${activeProvider}-apiKey`} className="text-xs font-medium dark:text-claude-darkText text-claude-text">
                      {i18nService.t('apiKey')}
                    </label>
                    <a
                      href="#"
                      onClick={(e) => { e.preventDefault(); window.electron.shell.openExternal(providerApiPlatformUrls[activeProvider]); }}
                      className="text-xs font-medium text-claude-accent hover:underline cursor-pointer"
                    >
                      {i18nService.t('stGetApiKeyLink')}
                    </a>
                  </div>
                  <div className="relative">
                    <input
                      type={showApiKey ? 'text' : 'password'}
                      id={`${activeProvider}-apiKey`}
                      value={providers[activeProvider].apiKey}
                      onChange={(e) => handleProviderConfigChange(activeProvider, 'apiKey', e.target.value)}
                      className="block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-16 text-xs"
                      placeholder={i18nService.t('apiKeyPlaceholder')}
                    />
                    <div className="absolute right-2 inset-y-0 flex items-center gap-1">
                      {providers[activeProvider].apiKey && (
                        <button
                          type="button"
                          onClick={() => handleProviderConfigChange(activeProvider, 'apiKey', '')}
                          className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                          title={i18nService.t('clear') || 'Clear'}
                        >
                          <XCircleIconSolid className="h-4 w-4" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setShowApiKey(!showApiKey)}
                        className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                        title={showApiKey ? (i18nService.t('hide') || 'Hide') : (i18nService.t('show') || 'Show')}
                      >
                        {showApiKey ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              <div>
                <label htmlFor={`${activeProvider}-baseUrl`} className="block text-xs font-medium dark:text-claude-darkText text-claude-text mb-1">
                  {i18nService.t('baseUrl')}
                </label>
                <div className="relative">
                  <input
                    type="text"
                    id={`${activeProvider}-baseUrl`}
                    value={
                      activeProvider === 'moonshot' && providers.moonshot.codingPlanEnabled
                        ? (getEffectiveApiFormat('moonshot', providers.moonshot.apiFormat) === 'anthropic'
                            ? 'https://api.kimi.com/coding'
                            : 'https://api.kimi.com/coding/v1')
                        : providers[activeProvider].baseUrl
                    }
                    onChange={(e) => handleProviderConfigChange(activeProvider, 'baseUrl', e.target.value)}
                    disabled={isBaseUrlLocked}
                    className={`block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-8 text-xs ${isBaseUrlLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
                    placeholder={getProviderDefaultBaseUrl(activeProvider, getEffectiveApiFormat(activeProvider, providers[activeProvider].apiFormat)) || defaultConfig.providers?.[activeProvider]?.baseUrl || i18nService.t('baseUrlPlaceholder')}
                  />
                  {providers[activeProvider].baseUrl && !isBaseUrlLocked && (
                    <div className="absolute right-2 inset-y-0 flex items-center">
                      <button
                        type="button"
                        onClick={() => handleProviderConfigChange(activeProvider, 'baseUrl', '')}
                        className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                        title={i18nService.t('clear') || 'Clear'}
                      >
                        <XCircleIconSolid className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                </div>
                {/* Moonshot Coding Plan hint */}
                {activeProvider === 'moonshot' && providers.moonshot.codingPlanEnabled && (
                  <div className="mt-1.5 p-2 rounded-lg bg-claude-accent/10 border border-claude-accent/20">
                    <p className="text-[11px] text-claude-accent dark:text-claude-accent">
                      <span className="font-medium">Coding Plan:</span> {i18nService.t('moonshotCodingPlanEndpointHint')}
                    </p>
                  </div>
                )}
              </div>

              {/* API format selector */}
              {shouldShowApiFormatSelector(activeProvider) && (
                <div>
                  <label htmlFor={`${activeProvider}-apiFormat`} className="block text-xs font-medium dark:text-claude-darkText text-claude-text mb-1">
                    {i18nService.t('apiFormat')}
                  </label>
                  <div className="flex items-center space-x-4">
                    <label className="flex items-center">
                      <input
                        type="radio"
                        name={`${activeProvider}-apiFormat`}
                        value="anthropic"
                        checked={getEffectiveApiFormat(activeProvider, providers[activeProvider].apiFormat) !== 'openai'}
                        onChange={() => handleProviderConfigChange(activeProvider, 'apiFormat', 'anthropic')}
                        className="h-3.5 w-3.5 text-claude-accent focus:ring-claude-accent dark:bg-claude-darkSurface bg-claude-surface"
                      />
                      <span className="ml-2 text-xs dark:text-claude-darkText text-claude-text">
                        {i18nService.t('apiFormatNative')}
                      </span>
                    </label>
                    <label className="flex items-center">
                      <input
                        type="radio"
                        name={`${activeProvider}-apiFormat`}
                        value="openai"
                        checked={getEffectiveApiFormat(activeProvider, providers[activeProvider].apiFormat) === 'openai'}
                        onChange={() => handleProviderConfigChange(activeProvider, 'apiFormat', 'openai')}
                        className="h-3.5 w-3.5 text-claude-accent focus:ring-claude-accent dark:bg-claude-darkSurface bg-claude-surface"
                      />
                      <span className="ml-2 text-xs dark:text-claude-darkText text-claude-text">
                        {i18nService.t('apiFormatOpenAI')}
                      </span>
                    </label>
                  </div>
                  <p className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('apiFormatHint')}
                  </p>
                </div>
              )}

              {/* Moonshot Coding Plan toggle (Moonshot only) */}
              {activeProvider === 'moonshot' && (
                <div className="flex items-center justify-between p-3 rounded-xl dark:bg-claude-darkSurface/50 bg-claude-surface/50 border dark:border-claude-darkBorder border-claude-border">
                  <div className="flex-1">
                    <div className="flex items-center space-x-2">
                      <span className="text-xs font-medium dark:text-claude-darkText text-claude-text">
                        Coding Plan
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-claude-accent/10 text-claude-accent">
                        Beta
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {i18nService.t('moonshotCodingPlanHint')}
                    </p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer ml-3">
                    <input
                      type="checkbox"
                      checked={providers.moonshot.codingPlanEnabled ?? false}
                      onChange={(e) => handleProviderConfigChange('moonshot', 'codingPlanEnabled', e.target.checked ? 'true' : 'false')}
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-claude-accent/50 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all dark:border-gray-600 peer-checked:bg-claude-accent"></div>
                  </label>
                </div>
              )}

              {/* Test connection button */}
              <div className="flex items-center space-x-3">
                <button
                  type="button"
                  onClick={handleTestConnection}
                  disabled={isTesting || (providerRequiresApiKey(activeProvider) && !providers[activeProvider].apiKey)}
                  className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
                >
                  <SignalIcon className="h-3.5 w-3.5 mr-1.5" />
                  {isTesting ? i18nService.t('testing') : i18nService.t('testConnection')}
                </button>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <h3 className="text-xs font-medium dark:text-claude-darkText text-claude-text">
                    {i18nService.t('availableModels')}
                  </h3>
                  <button
                    type="button"
                    onClick={handleAddModel}
                    className="inline-flex items-center text-xs text-claude-accent hover:text-claude-accentHover"
                  >
                    <PlusCircleIcon className="h-3.5 w-3.5 mr-1" />
                    {i18nService.t('addModel')}
                  </button>
                </div>

                {/* Models List */}
                <div className="space-y-1.5 max-h-60 overflow-y-auto">
                  {providers[activeProvider].models?.map(model => (
                    <div
                      key={model.id}
                      className="dark:bg-claude-darkSurface/50 bg-claude-surface/50 p-2 rounded-xl dark:border-claude-darkBorder border-claude-border border transition-colors hover:border-claude-accent group"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-1.5">
                          <div className="w-1.5 h-1.5 rounded-full bg-green-400"></div>
                          <span className="dark:text-claude-darkText text-claude-text font-medium text-[11px]">{model.name}</span>
                        </div>
                        <div className="flex items-center space-x-1">
                          <span className="text-[10px] px-1.5 py-0.5 bg-claude-surfaceHover dark:bg-claude-darkSurfaceHover rounded-md dark:text-claude-darkTextSecondary text-claude-textSecondary">{model.id}</span>
                          {model.supportsImage && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-claude-accent/10 text-claude-accent">
                              {i18nService.t('imageInput')}
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => handleEditModel(model.id, model.name, model.supportsImage)}
                            className="p-0.5 dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-accent opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <PencilIcon className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteModel(model.id)}
                            className="p-0.5 dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <TrashIcon className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}

                  {(!providers[activeProvider].models || providers[activeProvider].models.length === 0) && (
                    <div className="dark:bg-claude-darkSurface/20 bg-claude-surface/20 p-2.5 rounded-xl border dark:border-claude-darkBorder/50 border-claude-border/50 text-center">
                      <p className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('noModelsAvailable')}</p>
                      <button
                        type="button"
                        onClick={handleAddModel}
                        className="mt-1.5 inline-flex items-center text-[11px] font-medium text-claude-accent hover:text-claude-accentHover"
                      >
                        <PlusCircleIcon className="h-3 w-3 mr-1" />
                        {i18nService.t('addFirstModel')}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
            )}
          </div>
        );

      case 'advanced':
        return <AdvancedSettingsPanel />;

      case 'about':
        return (
          <div className="flex h-full flex-col items-center justify-between py-4">
            {/* Logo & App Name */}
            <div className="flex flex-col items-center">
              <img
                src="logo.png"
                alt="NoobClaw"
                className="w-14 h-14 mb-2 cursor-pointer select-none rounded-2xl"
                onClick={() => {
                  const next = logoClickCount + 1;
                  setLogoClickCount(next);
                  if (next >= 10 && !testModeUnlocked) {
                    setTestModeUnlocked(true);
                  }
                }}
              />
              <h3 className="text-base font-semibold dark:text-claude-darkText text-claude-text">{HIDE_WEB3 ? 'NoobClaw 矩阵号 中文版' : i18nService.t('stAppName')}</h3>
              <span className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">v{appVersion}</span>
            </div>

            {/* Info Card */}
            <div className="w-full mt-3 rounded-xl border border-claude-border dark:border-claude-darkBorder overflow-hidden text-[13px]">
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-claude-border dark:border-claude-darkBorder">
                <span className="dark:text-claude-darkText text-claude-text">{i18nService.t('aboutVersion')}</span>
                <div className="flex items-center gap-2">
                  <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">{appVersion}</span>
                  <button
                    type="button"
                    disabled={updateCheckStatus === 'checking'}
                    onClick={(e) => { e.stopPropagation(); void handleCheckUpdate(); }}
                    className="text-[11px] px-1.5 py-0.5 rounded border border-claude-border dark:border-claude-darkBorder dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-accent dark:hover:text-claude-accent hover:border-claude-accent transition-colors disabled:opacity-50"
                  >
                    {updateCheckStatus === 'checking' && i18nService.t('updateChecking')}
                    {updateCheckStatus === 'upToDate' && i18nService.t('updateUpToDate')}
                    {updateCheckStatus === 'error' && i18nService.t('updateCheckFailed')}
                    {updateCheckStatus === 'idle' && i18nService.t('checkForUpdate')}
                  </button>
                </div>
              </div>
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-claude-border dark:border-claude-darkBorder">
                <span className="dark:text-claude-darkText text-claude-text">Author</span>
                <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">Taylor / Chris</span>
              </div>
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-claude-border dark:border-claude-darkBorder">
                <span className="dark:text-claude-darkText text-claude-text">{i18nService.t('aboutContactEmail')}</span>
                <div className="flex items-center gap-1.5">
                  <button type="button" onClick={(e) => { e.stopPropagation(); void handleCopyContactEmail(); }} className="dark:text-claude-darkTextSecondary text-claude-textSecondary bg-transparent border-none p-0 cursor-pointer hover:text-claude-accent transition-colors">
                    {ABOUT_CONTACT_EMAIL}
                  </button>
                  {emailCopied && <span className="text-[10px] text-emerald-500">{i18nService.t('stCopied')}</span>}
                </div>
              </div>
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-claude-border dark:border-claude-darkBorder">
                <span className="dark:text-claude-darkText text-claude-text">{i18nService.t('aboutUserManual')}</span>
                <button type="button" onClick={(e) => { e.stopPropagation(); handleOpenUserManual(); }} className="dark:text-claude-darkTextSecondary text-claude-textSecondary bg-transparent border-none p-0 cursor-pointer hover:text-claude-accent transition-colors">
                  https://noobclaw.com/cn/
                </button>
              </div>
              <div className={`flex items-center justify-between px-4 py-2.5${isTestMode() ? ' border-b border-claude-border dark:border-claude-darkBorder' : ''}`}>
                <span className="dark:text-claude-darkText text-claude-text">Twitter</span>
                <button type="button" onClick={(e) => { e.stopPropagation(); window.electron.shell.openExternal('https://x.com/noobclaw_com'); }} className="dark:text-claude-darkTextSecondary text-claude-textSecondary bg-transparent border-none p-0 cursor-pointer hover:text-claude-accent transition-colors">
                  https://x.com/noobclaw_com
                </button>
              </div>
              {isTestMode() && (
                <div className="flex items-center justify-between px-4 py-2.5">
                  <span className="dark:text-claude-darkText text-claude-text">{i18nService.t('testMode')}</span>
                  <svg className="w-5 h-5 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="w-full pt-3 flex flex-col items-center gap-1.5">
              <button type="button" onClick={(e) => { e.stopPropagation(); void handleExportLogs(); }} disabled={isExportingLogs}
                className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary bg-transparent border-none cursor-pointer hover:text-claude-accent transition-colors disabled:opacity-50">
                {isExportingLogs ? i18nService.t('aboutExportingLogs') : i18nService.t('aboutExportLogs')}
              </button>
              <p className="text-[11px] dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60">
                Copyright &copy; {new Date().getFullYear()} NoobClaw. All Rights Reserved.
              </p>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 modal-backdrop flex items-center justify-center"
      
    >
      <div
        className="relative flex w-[900px] h-[80vh] rounded-2xl dark:border-claude-darkBorder border-claude-border border shadow-modal overflow-hidden modal-content"
        onClick={handleSettingsClick}
      >
        {/* Left sidebar */}
        <div className="w-[220px] shrink-0 flex flex-col dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted border-r dark:border-claude-darkBorder border-claude-border rounded-l-2xl overflow-y-auto">
          <div className="px-5 pt-5 pb-3">
            <h2 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">{i18nService.t('settings')}</h2>
          </div>
          <nav className="flex flex-col gap-0.5 px-3 pb-4">
            {sidebarTabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => handleTabChange(tab.key)}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors text-left ${
                  activeTab === tab.key
                    ? 'bg-claude-accent/10 text-claude-accent'
                    : 'dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:text-claude-darkText hover:text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover'
                }`}
              >
                {tab.icon}
                <span>{tab.label}</span>
              </button>
            ))}
          </nav>
        </div>

        {/* Right content */}
        <div className="relative flex-1 flex flex-col min-w-0 overflow-hidden dark:bg-claude-darkBg bg-claude-bg rounded-r-2xl">
          {/* Content header */}
          <div className="flex justify-between items-center px-6 pt-5 pb-3 shrink-0">
            <h3 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">{activeTabLabel}</h3>
            <button
              onClick={onClose}
              className="dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:text-claude-darkText hover:text-claude-text p-1.5 dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover rounded-lg transition-colors"
            >
              <XMarkIcon className="h-5 w-5" />
            </button>
          </div>

          {noticeMessage && (
            <div className="px-6">
              <ErrorMessage
                message={noticeMessage}
                onClose={() => setNoticeMessage(null)}
              />
            </div>
          )}

          {error && (
            <div className="px-6">
              <ErrorMessage
                message={error}
                onClose={() => setError(null)}
              />
            </div>
          )}

          <form onSubmit={handleSubmit} className="flex flex-col flex-1 overflow-hidden">
            {/* Tab content */}
            <div
              ref={contentRef}
              className="px-6 py-4 flex-1 overflow-y-auto"
              style={{ scrollbarGutter: 'stable' }}
            >
              {renderTabContent()}
            </div>

            {/* Footer buttons */}
            <div className="flex justify-end space-x-4 p-4 dark:border-claude-darkBorder border-claude-border border-t dark:bg-claude-darkBg bg-claude-bg shrink-0">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover rounded-xl transition-colors text-sm font-medium border dark:border-claude-darkBorder border-claude-border active:scale-[0.98]"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                type="submit"
                disabled={isSaving}
                className="px-4 py-2 bg-claude-accent hover:bg-claude-accentHover text-white rounded-xl transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98]"
              >
                {isSaving ? i18nService.t('saving') : i18nService.t('save')}
              </button>
            </div>
          </form>

        </div>

        {isTestResultModalOpen && testResult && (
          <div
            className="absolute inset-0 z-30 flex items-center justify-center bg-black/35 px-4 rounded-2xl"
            onClick={() => setIsTestResultModalOpen(false)}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-label={i18nService.t('connectionTestResult')}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-md rounded-2xl dark:bg-claude-darkSurface bg-claude-bg dark:border-claude-darkBorder border-claude-border border shadow-modal p-4"
            >
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-semibold dark:text-claude-darkText text-claude-text">
                  {i18nService.t('connectionTestResult')}
                </h4>
                <button
                  type="button"
                  onClick={() => setIsTestResultModalOpen(false)}
                  className="p-1 dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:text-claude-darkText hover:text-claude-text rounded-md dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover"
                >
                  <XMarkIcon className="h-4 w-4" />
                </button>
              </div>

              <div className="flex items-center gap-2 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                <span>{providerMeta[testResult.provider]?.label ?? testResult.provider}</span>
                <span className="text-[11px]">•</span>
                <span className={`inline-flex items-center gap-1 ${testResult.success ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                  {testResult.success ? (
                    <CheckCircleIcon className="h-4 w-4" />
                  ) : (
                    <XCircleIcon className="h-4 w-4" />
                  )}
                  {testResult.success ? i18nService.t('connectionSuccess') : i18nService.t('connectionFailed')}
                </span>
              </div>

              <p className="mt-3 text-xs leading-5 dark:text-claude-darkText text-claude-text whitespace-pre-wrap break-words max-h-56 overflow-y-auto">
                {testResult.message}
              </p>

              <div className="mt-4 flex justify-end">
                <button
                  type="button"
                  onClick={() => setIsTestResultModalOpen(false)}
                  className="px-3 py-1.5 text-xs font-medium rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors active:scale-[0.98]"
                >
                  {i18nService.t('close')}
                </button>
              </div>
            </div>
          </div>
        )}

        {(isAddingModel || isEditingModel) && (
          <div
            className="absolute inset-0 z-20 flex items-center justify-center bg-black/35 px-4 rounded-2xl"
            onClick={handleCancelModelEdit}
          >
              <div
                role="dialog"
                aria-modal="true"
                aria-label={isEditingModel ? i18nService.t('editModel') : i18nService.t('addNewModel')}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={handleModelDialogKeyDown}
                className="w-full max-w-md rounded-2xl dark:bg-claude-darkSurface bg-claude-bg dark:border-claude-darkBorder border-claude-border border shadow-modal p-4"
              >
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-semibold dark:text-claude-darkText text-claude-text">
                    {isEditingModel ? i18nService.t('editModel') : i18nService.t('addNewModel')}
                  </h4>
                  <button
                    type="button"
                    onClick={handleCancelModelEdit}
                    className="p-1 dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:text-claude-darkText hover:text-claude-text rounded-md dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover"
                  >
                    <XMarkIcon className="h-4 w-4" />
                  </button>
                </div>

                {modelFormError && (
                  <p className="mb-3 text-xs text-red-600 dark:text-red-400">
                    {modelFormError}
                  </p>
                )}

                <div className="space-y-3">
                  {false ? (
                    <>
                      <div>
                        <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                          {i18nService.t('ollamaModelName')}
                        </label>
                        <input
                          autoFocus
                          type="text"
                          value={newModelId}
                          onChange={(e) => {
                            setNewModelId(e.target.value);
                            if (!newModelName || newModelName === newModelId) {
                              setNewModelName(e.target.value);
                            }
                            if (modelFormError) {
                              setModelFormError(null);
                            }
                          }}
                          className="block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-xs"
                          placeholder={i18nService.t('ollamaModelNamePlaceholder')}
                        />
                        <p className="mt-1 text-[11px] dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
                          {i18nService.t('ollamaModelNameHint')}
                        </p>
                      </div>
                      <div>
                        <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                          {i18nService.t('ollamaDisplayName')}
                        </label>
                        <input
                          type="text"
                          value={newModelName === newModelId ? '' : newModelName}
                          onChange={(e) => {
                            setNewModelName(e.target.value || newModelId);
                            if (modelFormError) {
                              setModelFormError(null);
                            }
                          }}
                          className="block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-xs"
                          placeholder={i18nService.t('ollamaDisplayNamePlaceholder')}
                        />
                        <p className="mt-1 text-[11px] dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
                          {i18nService.t('ollamaDisplayNameHint')}
                        </p>
                      </div>
                    </>
                  ) : (
                    <>
                      <div>
                        <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                          {i18nService.t('modelName')}
                        </label>
                        <input
                          autoFocus
                          type="text"
                          value={newModelName}
                          onChange={(e) => {
                            setNewModelName(e.target.value);
                            if (modelFormError) {
                              setModelFormError(null);
                            }
                          }}
                          className="block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-xs"
                          placeholder="GPT-4"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                          {i18nService.t('modelId')}
                        </label>
                        <input
                          type="text"
                          value={newModelId}
                          onChange={(e) => {
                            setNewModelId(e.target.value);
                            if (modelFormError) {
                              setModelFormError(null);
                            }
                          }}
                          className="block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-xs"
                          placeholder="gpt-4"
                        />
                      </div>
                    </>
                  )}
                  <div className="flex items-center space-x-2">
                    <input
                      id={`${activeProvider}-supportsImage`}
                      type="checkbox"
                      checked={newModelSupportsImage}
                      onChange={(e) => setNewModelSupportsImage(e.target.checked)}
                      className="h-3.5 w-3.5 text-claude-accent focus:ring-claude-accent dark:bg-claude-darkSurface bg-claude-surface border-claude-border dark:border-claude-darkBorder rounded"
                    />
                    <label
                      htmlFor={`${activeProvider}-supportsImage`}
                      className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary"
                    >
                      {i18nService.t('supportsImageInput')}
                    </label>
                  </div>
                </div>

                <div className="flex justify-end space-x-2 mt-4">
                  <button
                    type="button"
                    onClick={handleCancelModelEdit}
                    className="px-3 py-1.5 text-xs dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover rounded-xl border dark:border-claude-darkBorder border-claude-border"
                  >
                    {i18nService.t('cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveNewModel}
                    className="px-3 py-1.5 text-xs text-white bg-claude-accent hover:bg-claude-accentHover rounded-xl active:scale-[0.98]"
                  >
                    {i18nService.t('save')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Memory Modal */}
          {showMemoryModal && (
            <div
              className="absolute inset-0 z-20 flex items-center justify-center bg-black/35 px-4 rounded-2xl"
              onClick={resetCoworkMemoryEditor}
            >
              <div
                className="dark:bg-claude-darkSurface bg-claude-surface dark:border-claude-darkBorder border-claude-border border rounded-2xl shadow-xl w-full max-w-md"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="px-5 pt-5 pb-4 border-b dark:border-claude-darkBorder border-claude-border">
                  <h3 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
                    {coworkMemoryEditingId ? i18nService.t('coworkMemoryCrudUpdate') : i18nService.t('coworkMemoryCrudCreate')}
                  </h3>
                </div>

                <div className="px-5 py-4 space-y-4">
                  {coworkMemoryEditingId && (
                    <div className="rounded-lg border px-2 py-1 text-xs dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {i18nService.t('coworkMemoryEditingTag')}
                    </div>
                  )}
                  <textarea
                    value={coworkMemoryDraftText}
                    onChange={(event) => setCoworkMemoryDraftText(event.target.value)}
                    placeholder={i18nService.t('coworkMemoryCrudTextPlaceholder')}
                    autoFocus
                    className="min-h-[200px] w-full rounded-lg border px-3 py-2 text-sm dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30"
                  />
                </div>

                <div className="flex justify-end space-x-2 px-5 pb-5">
                  <button
                    type="button"
                    onClick={resetCoworkMemoryEditor}
                    className="px-3 py-1.5 text-sm dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover rounded-xl border dark:border-claude-darkBorder border-claude-border transition-colors"
                  >
                    {i18nService.t('cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={() => { void handleSaveCoworkMemoryEntry(); }}
                    disabled={!coworkMemoryDraftText.trim() || coworkMemoryListLoading}
                    className="px-3 py-1.5 text-sm text-white bg-claude-accent hover:bg-claude-accentHover rounded-xl disabled:opacity-60 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
                  >
                    {coworkMemoryEditingId ? i18nService.t('save') : i18nService.t('coworkMemoryCrudCreate')}
                  </button>
                </div>
              </div>
            </div>
          )}
      </div>
    </div>
  );
};

export default Settings; 
