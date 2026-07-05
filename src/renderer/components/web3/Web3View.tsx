/**
 * Web3View - Web3 Connection Page
 * Card list + modal configuration for Telegram/Lark, visit buttons for exchanges
 */

import React, { useState, useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { SignalIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { EyeIcon, EyeSlashIcon, XCircleIcon as XCircleIconSolid } from '@heroicons/react/20/solid';
import { RootState } from '../../store';
import { imService } from '../../services/im';
import { setFeishuConfig, setTelegramConfig, setDingTalkConfig, clearError } from '../../store/slices/imSlice';
import type { IMConnectivityTestResult, IMGatewayConfig } from '../../types/im';
import { getBackendApiUrl } from '../../services/endpoints';
import { i18nService } from '../../services/i18n';
import WindowTitleBar from '../window/WindowTitleBar';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import ComposeIcon from '../icons/ComposeIcon';

interface Web3ViewProps {
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
}

type ModalPlatform = 'telegram' | 'feishu' | 'lark' | 'dingtalk' | null;

type TabKey = 'im' | 'news' | 'jobs' | 'exchange';

const getTabLabels = (): { key: TabKey; label: string }[] => {
  return [
    { key: 'im', label: i18nService.t('web3TabIM') },
    { key: 'news', label: i18nService.t('web3TabKOL') },
    { key: 'jobs', label: i18nService.t('web3TabJobs') },
    { key: 'exchange', label: i18nService.t('web3TabExchanges') },
  ];
};

export const Web3View: React.FC<Web3ViewProps> = ({ isSidebarCollapsed, onToggleSidebar, onNewChat, updateBadge }) => {
  const dispatch = useDispatch();
  const isMac = window.electron.platform === 'darwin';

  const { config, status, isLoading } = useSelector((state: RootState) => state.im);

  const [activeTab, setActiveTab] = useState<TabKey>('im');
  const [configLoaded, setConfigLoaded] = useState(false);
  const [modalPlatform, setModalPlatform] = useState<ModalPlatform>(null);
  const [togglingPlatform, setTogglingPlatform] = useState<'telegram' | 'feishu' | 'lark' | 'dingtalk' | null>(null);
  const [testingPlatform, setTestingPlatform] = useState<'telegram' | 'feishu' | 'lark' | 'dingtalk' | null>(null);
  const [connectivityResult, setConnectivityResult] = useState<IMConnectivityTestResult | null>(null);
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [allowedUserIdInput, setAllowedUserIdInput] = useState('');
  // Local form state (edited in modal, saved on submit)
  const [localTelegram, setLocalTelegram] = useState({ botToken: '', allowedUserIds: [] as string[] });
  const [localFeishu, setLocalFeishu] = useState({ appId: '', appSecret: '' });
  const [localLark, setLocalLark] = useState({ appId: '', appSecret: '' });
  const [localDingtalk, setLocalDingtalk] = useState({ clientId: '', clientSecret: '' });

  // KOL state
  const [kolLang, setKolLang] = useState<'zh' | 'en'>('zh');
  const [kols, setKols] = useState<any[]>([]);
  const [kolPage, setKolPage] = useState(1);
  const [kolHasMore, setKolHasMore] = useState(false);
  const [kolLoading, setKolLoading] = useState(false);

  // Jobs state
  const [jobSource, setJobSource] = useState<'web3career' | 'cryptojobs' | 'dejob'>('web3career');
  const [jobs, setJobs] = useState<any[]>([]);
  const [jobPage, setJobPage] = useState(1);
  const [jobTotal, setJobTotal] = useState(0);
  const [jobLoading, setJobLoading] = useState(false);

  // Exchanges state (fetched from API)
  const [exchanges, setExchanges] = useState<any[]>([]);

  useEffect(() => {
    let cancelled = false;
    void imService.init().then(() => {
      if (!cancelled) setConfigLoaded(true);
    });
    return () => {
      cancelled = true;
      setConfigLoaded(false);
      imService.destroy();
    };
  }, []);

  // Fetch KOLs
  const [kolTotal, setKolTotal] = useState(0);

  const fetchKols = async (lang: 'zh' | 'en', page: number) => {
    setKolLoading(true);
    try {
      const backendUrl = getBackendApiUrl();
      const resp = await fetch(`${backendUrl}/api/kols?lang=${lang}&page=${page}&pageSize=20`);
      const data = await resp.json();
      setKols(data.kols || []);
      setKolTotal(data.pagination?.total ?? 0);
      setKolHasMore(data.pagination?.hasMore ?? false);
      setKolPage(page);
    } catch {
      setKols([]);
    } finally {
      setKolLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'news') {
      fetchKols(kolLang, 1);
    }
  }, [activeTab, kolLang]);

  // Jobs fetching
  const fetchJobs = async (source: 'web3career' | 'cryptojobs' | 'dejob', page: number) => {
    setJobLoading(true);
    try {
      const backendUrl = getBackendApiUrl();
      const resp = await fetch(`${backendUrl}/api/web3/jobs?source=${source}&page=${page}&limit=15`);
      const data = await resp.json();
      setJobs(data.jobs || []);
      setJobTotal(data.total || 0);
      setJobPage(page);
    } catch {
      setJobs([]);
    } finally {
      setJobLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'jobs') {
      fetchJobs(jobSource, 1);
    }
  }, [activeTab, jobSource]);

  // Fetch exchanges from API
  useEffect(() => {
    if (activeTab === 'exchange' && exchanges.length === 0) {
      const backendUrl = getBackendApiUrl();
      fetch(`${backendUrl}/api/exchanges`)
        .then(r => r.json())
        .then(d => setExchanges(d.exchanges || []))
        .catch(err => console.error('[Web3View] Fetch exchanges failed:', err));
    }
  }, [activeTab]);

  // Sync local state from Redux when modal opens
  const openModal = (platform: 'telegram' | 'feishu' | 'lark' | 'dingtalk') => {
    setConnectivityResult(null);
    setShowSecrets({});
    setAllowedUserIdInput('');
    if (platform === 'telegram') {
      setLocalTelegram({
        botToken: config.telegram.botToken,
        allowedUserIds: [...(config.telegram.allowedUserIds || [])],
      });
    } else if (platform === 'feishu') {
      // Load feishu creds from settings (preferred) or current config
      setLocalFeishu({
        appId: config.settings?.feishuAppId || ((config.feishu.domain || 'feishu') !== 'lark' ? config.feishu.appId : '') || '',
        appSecret: config.settings?.feishuAppSecret || ((config.feishu.domain || 'feishu') !== 'lark' ? config.feishu.appSecret : '') || '',
      });
    } else if (platform === 'lark') {
      setLocalLark({ appId: config.settings?.larkAppId || '', appSecret: config.settings?.larkAppSecret || '' });
    } else if (platform === 'dingtalk') {
      setLocalDingtalk({ clientId: config.dingtalk.clientId, clientSecret: config.dingtalk.clientSecret });
    }
    setModalPlatform(platform);
  };

  const closeModal = () => {
    setModalPlatform(null);
    setConnectivityResult(null);
  };

  // Save config to Redux + backend
  const handleSave = async () => {
    if (!configLoaded) return;
    if (modalPlatform === 'telegram') {
      dispatch(setTelegramConfig({ botToken: localTelegram.botToken, allowedUserIds: localTelegram.allowedUserIds }));
      await imService.updateConfig({ telegram: { ...config.telegram, botToken: localTelegram.botToken, allowedUserIds: localTelegram.allowedUserIds } });
    } else if (modalPlatform === 'feishu') {
      // Store feishu creds in settings for later restore, and update feishu config
      dispatch(setFeishuConfig({ appId: localFeishu.appId, appSecret: localFeishu.appSecret, domain: 'feishu' }));
      await imService.updateConfig({
        settings: { ...config.settings, feishuAppId: localFeishu.appId, feishuAppSecret: localFeishu.appSecret },
        feishu: { ...config.feishu, appId: localFeishu.appId, appSecret: localFeishu.appSecret, domain: 'feishu' },
      });
    } else if (modalPlatform === 'lark') {
      // Store lark creds in settings, and also update feishu config with lark domain + creds
      await imService.updateConfig({
        settings: { ...config.settings, larkAppId: localLark.appId, larkAppSecret: localLark.appSecret },
        feishu: { ...config.feishu, appId: localLark.appId, appSecret: localLark.appSecret, domain: 'lark' },
      });
      dispatch(setFeishuConfig({ appId: localLark.appId, appSecret: localLark.appSecret, domain: 'lark' }));
    } else if (modalPlatform === 'dingtalk') {
      dispatch(setDingTalkConfig({ clientId: localDingtalk.clientId, clientSecret: localDingtalk.clientSecret }));
      await imService.updateConfig({ dingtalk: { ...config.dingtalk, clientId: localDingtalk.clientId, clientSecret: localDingtalk.clientSecret } });
    }
    closeModal();
  };

  const toggleGateway = async (platform: 'telegram' | 'feishu' | 'lark' | 'dingtalk') => {
    if (togglingPlatform === platform) return;
    setTogglingPlatform(platform);
    try {
      // lark maps to feishu gateway with domain='lark'
      const gwPlatform = platform === 'lark' ? 'feishu' as const : platform;
      const isEnabled = config[gwPlatform].enabled;
      const newEnabled = !isEnabled;
      const setAction = gwPlatform === 'telegram' ? setTelegramConfig : gwPlatform === 'feishu' ? setFeishuConfig : setDingTalkConfig;
      if (platform === 'lark') {
        // Switch feishu gateway to lark mode with lark credentials
        const larkId = config.settings?.larkAppId || '';
        const larkSecret = config.settings?.larkAppSecret || '';
        dispatch(setFeishuConfig({ enabled: newEnabled, domain: 'lark', appId: larkId, appSecret: larkSecret }));
        await imService.updateConfig({ feishu: { ...config.feishu, enabled: newEnabled, domain: 'lark', appId: larkId, appSecret: larkSecret } });
      } else if (platform === 'feishu') {
        // Restore feishu credentials from settings (lark may have overwritten config.feishu)
        const feishuId = config.settings?.feishuAppId || config.feishu.appId || '';
        const feishuSecret = config.settings?.feishuAppSecret || config.feishu.appSecret || '';
        dispatch(setFeishuConfig({ enabled: newEnabled, domain: 'feishu', appId: feishuId, appSecret: feishuSecret }));
        await imService.updateConfig({ feishu: { ...config.feishu, enabled: newEnabled, domain: 'feishu', appId: feishuId, appSecret: feishuSecret } });
      } else {
        dispatch(setAction({ enabled: newEnabled }));
        await imService.updateConfig({ [gwPlatform]: { ...config[gwPlatform], enabled: newEnabled } });
      }
      if (newEnabled) {
        dispatch(clearError());
        // For feishu/lark: always stop first to ensure clean reconnect with correct credentials
        if (gwPlatform === 'feishu') {
          try { await imService.stopGateway('feishu'); } catch {}
        }
        const success = await imService.startGateway(gwPlatform);
        if (!success) {
          dispatch(setAction({ enabled: false }));
          await imService.updateConfig({ [gwPlatform]: { ...config[gwPlatform], enabled: false } });
        }
      } else {
        await imService.stopGateway(gwPlatform);
      }
    } finally {
      setTogglingPlatform(null);
    }
  };

  const runConnectivityTest = async (platform: 'telegram' | 'feishu' | 'lark' | 'dingtalk') => {
    if (testingPlatform) return;
    setTestingPlatform(platform);
    setConnectivityResult(null);
    const gwPlatform = platform === 'lark' ? 'feishu' as const : platform;
    let override: Partial<IMGatewayConfig>;
    if (gwPlatform === 'telegram') {
      override = { telegram: { ...config.telegram, botToken: localTelegram.botToken, allowedUserIds: localTelegram.allowedUserIds } };
    } else if (gwPlatform === 'feishu') {
      // Lark 和 Feishu 有独立的 local state，必须按用户实际打开的 modal 选择
      const localCreds = platform === 'lark' ? localLark : localFeishu;
      const domain = platform === 'lark' ? 'lark' : 'feishu';
      override = { feishu: { ...config.feishu, appId: localCreds.appId, appSecret: localCreds.appSecret, domain } };
    } else {
      override = { dingtalk: { ...config.dingtalk, clientId: localDingtalk.clientId, clientSecret: localDingtalk.clientSecret } };
    }
    const result = await imService.testGateway(gwPlatform, override);
    setConnectivityResult(result);
    setTestingPlatform(null);
  };

  const addAllowedUserId = () => {
    const id = allowedUserIdInput.trim();
    if (id && !localTelegram.allowedUserIds.includes(id)) {
      setLocalTelegram(prev => ({ ...prev, allowedUserIds: [...prev.allowedUserIds, id] }));
      setAllowedUserIdInput('');
    }
  };

  const removeAllowedUserId = (id: string) => {
    setLocalTelegram(prev => ({ ...prev, allowedUserIds: prev.allowedUserIds.filter(u => u !== id) }));
  };

  const telegramConnected = status.telegram.connected;
  const feishuConnected = status.feishu.connected;
  const dingtalkConnected = status.dingtalk.connected;

  const canToggleTelegram = config.telegram.enabled || !!config.telegram.botToken;
  const canToggleFeishu = config.feishu.enabled || !!(config.feishu.appId && config.feishu.appSecret);
  const canToggleDingtalk = config.dingtalk.enabled || !!(config.dingtalk.clientId && config.dingtalk.clientSecret);

  // Close modal on Escape
  useEffect(() => {
    if (!modalPlatform) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeModal(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modalPlatform]);

  const Toggle = ({ enabled, connected, canToggle, toggling, onToggle }: {
    enabled: boolean; connected: boolean; canToggle: boolean; toggling: boolean; onToggle: () => void;
  }) => (
    <div
      onClick={canToggle && !toggling && !isLoading ? onToggle : undefined}
      className={`w-9 h-5 rounded-full flex items-center transition-colors ${
        enabled ? (connected ? 'bg-green-500' : 'bg-yellow-400') : 'dark:bg-claude-darkBorder bg-gray-300'
      } ${canToggle && !toggling && !isLoading ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed'}`}
    >
      <div className={`w-4 h-4 rounded-full bg-white shadow transform transition-transform mx-0.5 ${enabled ? 'translate-x-4' : 'translate-x-0'}`} />
    </div>
  );

  return (
    <div className="flex flex-col h-full dark:bg-claude-darkBg bg-claude-bg">
      {/* Header */}
      <div className="draggable flex h-12 items-center justify-between px-4 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
        <div className="flex items-center space-x-3 h-8">
          {isSidebarCollapsed && (
            <div className={`non-draggable flex items-center gap-1 ${isMac ? 'pl-[68px]' : ''}`}>
              <button type="button" onClick={onToggleSidebar} className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors">
                <SidebarToggleIcon className="h-4 w-4" isCollapsed={true} />
              </button>
              <button type="button" onClick={onNewChat} className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors">
                <ComposeIcon className="h-4 w-4" />
              </button>
              {updateBadge}
            </div>
          )}
          <h1 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">{i18nService.t('web3Connect')}</h1>
        </div>
        <WindowTitleBar inline />
      </div>

      {/* Tab Bar */}
      <div className="flex gap-1 p-1 rounded-xl dark:bg-claude-darkSurface/50 bg-gray-100 mx-6 mt-4">
        {getTabLabels().map(tab => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)}
            className={`flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all ${
              activeTab === tab.key
                ? 'dark:bg-claude-darkBg bg-white dark:text-white text-gray-900 shadow-sm'
                : 'dark:text-gray-400 text-gray-500 hover:dark:text-gray-300'
            }`}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-xl mx-auto space-y-6">

          {activeTab === 'im' && (
            <>
              {/* Telegram */}
              <div className="space-y-2">
                <div className="flex items-center gap-4 p-4 rounded-2xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/30 bg-white">
                  <img src="telegram.svg" alt="Telegram" className="w-10 h-10 object-contain flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold dark:text-claude-darkText text-claude-text">Telegram</p>
                      {config.telegram.enabled && (
                        <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${telegramConnected ? 'bg-green-500/15 text-green-600 dark:text-green-400' : 'bg-yellow-500/15 text-yellow-600 dark:text-yellow-400'}`}>
                          {telegramConnected ? i18nService.t('web3Connected') : i18nService.t('web3Connecting')}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5">{i18nService.t('web3TelegramDesc')}</p>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <Toggle
                      enabled={config.telegram.enabled}
                      connected={telegramConnected}
                      canToggle={canToggleTelegram}
                      toggling={togglingPlatform === 'telegram'}
                      onToggle={() => toggleGateway('telegram')}
                    />
                    <button
                      type="button"
                      onClick={() => openModal('telegram')}
                      className="px-4 py-1.5 rounded-xl text-xs font-semibold bg-claude-accent text-white hover:bg-claude-accentHover transition-colors"
                    >
                      {i18nService.t('web3Setup')}
                    </button>
                  </div>
                </div>

                {/* Feishu (China) */}
                <div className="flex items-center gap-4 p-4 rounded-2xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/30 bg-white">
                  <img src="feishu.png" alt="飞书" className="w-10 h-10 object-contain flex-shrink-0 rounded-xl" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold dark:text-claude-darkText text-claude-text">{i18nService.t('web3Feishu')}</p>
                      {config.feishu.enabled && (config.feishu.domain || 'feishu') !== 'lark' && (
                        <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${feishuConnected ? 'bg-green-500/15 text-green-600 dark:text-green-400' : 'bg-yellow-500/15 text-yellow-600 dark:text-yellow-400'}`}>
                          {feishuConnected ? i18nService.t('web3Connected') : i18nService.t('web3Connecting')}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5">{i18nService.t('web3FeishuDesc')} (open.feishu.cn)</p>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <Toggle
                      enabled={config.feishu.enabled && (config.feishu.domain || 'feishu') !== 'lark'}
                      connected={feishuConnected && (config.feishu.domain || 'feishu') !== 'lark'}
                      canToggle={canToggleFeishu}
                      toggling={togglingPlatform === 'feishu'}
                      onToggle={() => toggleGateway('feishu')}
                    />
                    <button
                      type="button"
                      onClick={() => openModal('feishu')}
                      className="px-4 py-1.5 rounded-xl text-xs font-semibold bg-claude-accent text-white hover:bg-claude-accentHover transition-colors"
                    >
                      {i18nService.t('web3Setup')}
                    </button>
                  </div>
                </div>

                {/* Lark (International) */}
                <div className="flex items-center gap-4 p-4 rounded-2xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/30 bg-white">
                  <img src="feishu.png" alt="Lark" className="w-10 h-10 object-contain flex-shrink-0 rounded-xl" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold dark:text-claude-darkText text-claude-text">Lark</p>
                      {config.feishu.enabled && config.feishu.domain === 'lark' && (
                        <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${feishuConnected ? 'bg-green-500/15 text-green-600 dark:text-green-400' : 'bg-yellow-500/15 text-yellow-600 dark:text-yellow-400'}`}>
                          {feishuConnected ? i18nService.t('web3Connected') : i18nService.t('web3Connecting')}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5">International collaboration platform (open.larksuite.com)</p>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <Toggle
                      enabled={config.feishu.enabled && config.feishu.domain === 'lark'}
                      connected={feishuConnected && config.feishu.domain === 'lark'}
                      canToggle={canToggleFeishu}
                      toggling={togglingPlatform === 'lark'}
                      onToggle={() => toggleGateway('lark')}
                    />
                    <button
                      type="button"
                      onClick={() => openModal('lark')}
                      className="px-4 py-1.5 rounded-xl text-xs font-semibold bg-claude-accent text-white hover:bg-claude-accentHover transition-colors"
                    >
                      {i18nService.t('web3Setup')}
                    </button>
                  </div>
                </div>

                {/* DingTalk */}
                <div className="flex items-center gap-4 p-4 rounded-2xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/30 bg-white">
                  <div className="w-10 h-10 rounded-xl bg-blue-500 flex items-center justify-center flex-shrink-0 text-xl">
                    🔔
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold dark:text-claude-darkText text-claude-text">{i18nService.t('web3DingTalk')}</p>
                      {config.dingtalk.enabled && (
                        <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${dingtalkConnected ? 'bg-green-500/15 text-green-600 dark:text-green-400' : 'bg-yellow-500/15 text-yellow-600 dark:text-yellow-400'}`}>
                          {dingtalkConnected ? i18nService.t('web3Connected') : i18nService.t('web3Connecting')}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5">{i18nService.t('web3DingTalkDesc')}</p>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <Toggle
                      enabled={config.dingtalk.enabled}
                      connected={dingtalkConnected}
                      canToggle={canToggleDingtalk}
                      toggling={togglingPlatform === 'dingtalk'}
                      onToggle={() => toggleGateway('dingtalk')}
                    />
                    <button
                      type="button"
                      onClick={() => openModal('dingtalk')}
                      className="px-4 py-1.5 rounded-xl text-xs font-semibold bg-claude-accent text-white hover:bg-claude-accentHover transition-colors"
                    >
                      {i18nService.t('web3Setup')}
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}

          {activeTab === 'exchange' && (
            <div className="space-y-4">
              {!Array.isArray(exchanges) || exchanges.length === 0 ? (
                <div className="flex justify-center py-12">
                  <div className="w-6 h-6 border-2 border-claude-accent border-t-transparent rounded-full animate-spin" />
                </div>
              ) : (
                <>
                  {/* Centralized Exchanges */}
                  {exchanges.filter((e: any) => e.category === 'cex').length > 0 && (
                    <div>
                      <h3 className="text-xs font-semibold uppercase tracking-wider dark:text-claude-darkTextSecondary text-claude-textSecondary mb-2">
                        {i18nService.t('web3CentralizedExchanges')}
                      </h3>
                      <div className="space-y-1.5">
                        {exchanges.filter((e: any) => e.category === 'cex').map((item: any) => (
                          <div key={item.id} className="flex items-center gap-3 p-3 rounded-2xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/30 bg-white hover:dark:border-claude-accent/30 transition-colors">
                            <img src={item.logo_url} alt={item.name} className="w-9 h-9 rounded-xl object-contain flex-shrink-0" />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-semibold dark:text-claude-darkText text-claude-text">{item.name}</p>
                              <p className="text-xs text-gray-400 mt-0.5 line-clamp-1">{i18nService.currentLanguage === 'zh' ? item.description_zh : item.description_en}</p>
                            </div>
                            <button type="button" onClick={() => { try { window.electron?.shell?.openExternal(item.link); } catch {} }}
                              className="flex-shrink-0 px-3 py-1 rounded-xl text-xs font-semibold bg-claude-accent text-white hover:bg-claude-accentHover transition-colors">
                              {i18nService.t('web3Visit')}
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {/* MEME Launchpad */}
                  {exchanges.filter((e: any) => e.category === 'meme_launchpad').length > 0 && (
                    <div>
                      <h3 className="text-xs font-semibold uppercase tracking-wider dark:text-claude-darkTextSecondary text-claude-textSecondary mb-2">
                        MEME {i18nService.t('web3MemeLaunchpad')}
                      </h3>
                      <div className="space-y-1.5">
                        {exchanges.filter((e: any) => e.category === 'meme_launchpad').map((item: any) => (
                          <div key={item.id} className="flex items-center gap-3 p-3 rounded-2xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/30 bg-white hover:dark:border-claude-accent/30 transition-colors">
                            <img src={item.logo_url} alt={item.name} className="w-9 h-9 rounded-xl object-contain flex-shrink-0" />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-semibold dark:text-claude-darkText text-claude-text">{item.name}</p>
                              <p className="text-xs text-gray-400 mt-0.5 line-clamp-1">{i18nService.currentLanguage === 'zh' ? item.description_zh : item.description_en}</p>
                            </div>
                            <button type="button" onClick={() => { try { window.electron?.shell?.openExternal(item.link); } catch {} }}
                              className="flex-shrink-0 px-3 py-1 rounded-xl text-xs font-semibold bg-claude-accent text-white hover:bg-claude-accentHover transition-colors">
                              {i18nService.t('web3Visit')}
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {activeTab === 'news' && (
            <div className="space-y-4">
              {/* Language sub-tabs */}
              <div className="flex gap-2">
                <button
                  onClick={() => setKolLang('zh')}
                  className={`px-4 py-1.5 rounded-full text-xs font-medium transition-colors ${
                    kolLang === 'zh'
                      ? 'bg-claude-accent text-white'
                      : 'dark:bg-claude-darkSurface bg-gray-100 dark:text-gray-400 text-gray-500 hover:dark:text-gray-300'
                  }`}
                >
                  {i18nService.t('web3ChineseKOL')}
                </button>
                <button
                  onClick={() => setKolLang('en')}
                  className={`px-4 py-1.5 rounded-full text-xs font-medium transition-colors ${
                    kolLang === 'en'
                      ? 'bg-claude-accent text-white'
                      : 'dark:bg-claude-darkSurface bg-gray-100 dark:text-gray-400 text-gray-500 hover:dark:text-gray-300'
                  }`}
                >
                  English KOL
                </button>
              </div>

              {/* KOL List */}
              {kolLoading && kols.length === 0 ? (
                <div className="flex justify-center py-12">
                  <div className="w-6 h-6 border-2 border-claude-accent border-t-transparent rounded-full animate-spin" />
                </div>
              ) : kols.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16">
                  <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('web3NoKOLData')}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {kols.map((kol: any) => (
                    <div key={kol.id} className="flex items-center gap-3 p-3 rounded-xl border dark:border-claude-darkBorder border-claude-border hover:dark:bg-claude-darkSurface/30 transition-colors">
                      <span className="text-xs font-bold text-green-400 w-8 text-center flex-shrink-0">#{kol.rank || '?'}</span>
                      {kol.avatar_url ? (
                        <img src={kol.avatar_url} className="w-10 h-10 rounded-full object-cover flex-shrink-0" />
                      ) : (
                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white font-bold text-sm flex-shrink-0">
                          {kol.name?.charAt(0)?.toUpperCase() || '?'}
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold dark:text-claude-darkText truncate">{kol.name}</p>
                        <p className="text-xs text-gray-400 truncate">@{kol.twitter_handle} · {Number(kol.followers || 0).toLocaleString()} followers</p>
                      </div>
                      <button onClick={() => window.electron.shell.openExternal(kol.twitter_url)}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition-colors flex-shrink-0">
                        {i18nService.t('web3Follow')}
                      </button>
                    </div>
                  ))}

                  {/* Pagination */}
                  <div className="flex items-center justify-center gap-3 pt-2">
                    <button
                      disabled={kolPage <= 1 || kolLoading}
                      onClick={() => fetchKols(kolLang, kolPage - 1)}
                      className="px-3 py-1.5 rounded-lg text-xs dark:bg-claude-darkSurface bg-gray-100 dark:text-gray-400 text-gray-500 disabled:opacity-40"
                    >
                      {i18nService.t('web3PrevPage')}
                    </button>
                    <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {kolPage} / {Math.ceil(kolTotal / 20) || 1}
                    </span>
                    <button
                      disabled={!kolHasMore || kolLoading}
                      onClick={() => fetchKols(kolLang, kolPage + 1)}
                      className="px-3 py-1.5 rounded-lg text-xs dark:bg-claude-darkSurface bg-gray-100 dark:text-gray-400 text-gray-500 disabled:opacity-40"
                    >
                      {i18nService.t('web3NextPage')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'jobs' && (
            <div className="space-y-4">
              {/* Source tabs */}
              <div className="flex gap-2">
                <button
                  onClick={() => { setJobSource('web3career'); setJobPage(1); }}
                  className={`px-4 py-1.5 rounded-full text-xs font-medium transition-colors ${
                    jobSource === 'web3career'
                      ? 'bg-claude-accent text-white'
                      : 'dark:bg-claude-darkSurface bg-gray-100 dark:text-gray-400 text-gray-500 hover:dark:text-gray-300'
                  }`}
                >
                  Web3.Career
                </button>
                <button
                  onClick={() => { setJobSource('cryptojobs'); setJobPage(1); }}
                  className={`px-4 py-1.5 rounded-full text-xs font-medium transition-colors ${
                    jobSource === 'cryptojobs'
                      ? 'bg-claude-accent text-white'
                      : 'dark:bg-claude-darkSurface bg-gray-100 dark:text-gray-400 text-gray-500 hover:dark:text-gray-300'
                  }`}
                >
                  CryptoJobsList
                </button>
                <button
                  onClick={() => { setJobSource('dejob'); setJobPage(1); }}
                  className={`px-4 py-1.5 rounded-full text-xs font-medium transition-colors ${
                    jobSource === 'dejob'
                      ? 'bg-claude-accent text-white'
                      : 'dark:bg-claude-darkSurface bg-gray-100 dark:text-gray-400 text-gray-500 hover:dark:text-gray-300'
                  }`}
                >
                  DeJob
                </button>
              </div>

              {/* Jobs list */}
              {jobLoading && jobs.length === 0 ? (
                <div className="flex justify-center py-12">
                  <div className="w-6 h-6 border-2 border-claude-accent border-t-transparent rounded-full animate-spin" />
                </div>
              ) : jobs.length === 0 ? (
                <div className="text-center py-12 dark:text-claude-darkTextSecondary text-claude-textSecondary text-sm">{i18nService.t('web3NoData')}</div>
              ) : (
                <>
                  <div className="space-y-3">
                    {jobs.map((job: any, idx: number) => (
                      <div
                        key={job.id || idx}
                        className="p-4 rounded-2xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/30 bg-white hover:dark:border-claude-accent/30 hover:border-claude-accent/30 transition-colors cursor-pointer"
                        onClick={() => job.applyUrl && window.electron?.shell?.openExternal(job.applyUrl)}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold dark:text-claude-darkText text-claude-text truncate">{job.title}</p>
                            <div className="flex items-center gap-2 mt-1">
                              <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{job.company}</span>
                              {job.location && (
                                <span className="text-xs dark:text-gray-500 text-gray-400">📍 {job.location}</span>
                              )}
                            </div>
                            {job.salary && (
                              <p className="text-xs text-green-500 mt-1 font-medium">{job.salary}</p>
                            )}
                            {job.tags && job.tags.length > 0 && (
                              <div className="flex flex-wrap gap-1 mt-2">
                                {job.tags.slice(0, 5).map((tag: string, i: number) => (
                                  <span key={i} className="px-2 py-0.5 rounded-full text-[10px] dark:bg-claude-darkBorder/50 bg-gray-100 dark:text-gray-400 text-gray-500">{tag}</span>
                                ))}
                              </div>
                            )}
                          </div>
                          <span className="text-xs dark:text-gray-500 text-gray-400 flex-shrink-0 mt-1">
                            {job.publishedAt ? new Date(job.publishedAt).toLocaleDateString(i18nService.getDateLocale()) : ''}
                          </span>
                        </div>
                        <div className="flex justify-between items-center mt-2 pt-2 border-t dark:border-claude-darkBorder/30 border-gray-100">
                          <span className="text-[10px] dark:text-gray-500 text-gray-400">via {job.source}</span>
                          <span className="text-xs text-claude-accent font-medium">Apply →</span>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Pagination */}
                  <div className="flex items-center justify-center gap-3 pt-2">
                    <button
                      disabled={jobPage <= 1 || jobLoading}
                      onClick={() => fetchJobs(jobSource, jobPage - 1)}
                      className="px-3 py-1.5 rounded-lg text-xs dark:bg-claude-darkSurface bg-gray-100 dark:text-gray-400 text-gray-500 disabled:opacity-40"
                    >
                      {i18nService.t('web3PrevPage')}
                    </button>
                    <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {jobPage} / {Math.ceil(jobTotal / 15) || 1}
                    </span>
                    <button
                      disabled={jobPage >= Math.ceil(jobTotal / 15) || jobLoading}
                      onClick={() => fetchJobs(jobSource, jobPage + 1)}
                      className="px-3 py-1.5 rounded-lg text-xs dark:bg-claude-darkSurface bg-gray-100 dark:text-gray-400 text-gray-500 disabled:opacity-40"
                    >
                      {i18nService.t('web3NextPage')}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

        </div>
      </div>

      {/* Config Modal */}
      {modalPlatform && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div
            className="w-full max-w-md rounded-2xl dark:bg-claude-darkSurface bg-white shadow-2xl flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b dark:border-claude-darkBorder border-claude-border">
              <div className="flex items-center gap-3">
                {modalPlatform === 'dingtalk' ? (
                  <div className="w-7 h-7 rounded-lg bg-blue-500 flex items-center justify-center text-sm">🔔</div>
                ) : (
                  <img
                    src={modalPlatform === 'telegram' ? 'telegram.svg' : 'feishu.png'}
                    alt={modalPlatform === 'telegram' ? 'Telegram' : modalPlatform === 'lark' ? 'Lark' : modalPlatform === 'feishu' ? i18nService.t('web3Feishu') : i18nService.t('web3DingTalk')}
                    className="w-7 h-7 object-contain rounded-lg"
                  />
                )}
                <h3 className="text-sm font-semibold dark:text-claude-darkText text-claude-text">
                  {modalPlatform === 'telegram' ? 'Telegram' : modalPlatform === 'lark' ? 'Lark' : modalPlatform === 'feishu' ? i18nService.t('web3Feishu') : i18nService.t('web3DingTalk')} {i18nService.t('web3Settings')}
                </h3>
              </div>
              <button type="button" onClick={closeModal} className="p-1 rounded-lg hover:dark:bg-claude-darkSurfaceHover hover:bg-gray-100 transition-colors">
                <XMarkIcon className="w-4 h-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-5 space-y-4 flex-1 overflow-y-auto">
              {modalPlatform === 'telegram' && (
                <>
                  {/* Bot Token */}
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      Bot Token <span className="text-red-500">*</span>
                    </label>
                    <div className="relative">
                      <input
                        type={showSecrets['botToken'] ? 'text' : 'password'}
                        value={localTelegram.botToken}
                        onChange={e => setLocalTelegram(prev => ({ ...prev, botToken: e.target.value }))}
                        className="block w-full rounded-xl dark:bg-claude-darkBg bg-gray-50 dark:border-claude-darkBorder border-gray-200 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2.5 pr-16 text-sm transition-colors"
                        placeholder="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
                      />
                      <div className="absolute right-2 inset-y-0 flex items-center gap-1">
                        {localTelegram.botToken && (
                          <button type="button" onClick={() => setLocalTelegram(prev => ({ ...prev, botToken: '' }))} className="p-0.5 rounded text-gray-400 hover:text-claude-accent transition-colors">
                            <XCircleIconSolid className="h-4 w-4" />
                          </button>
                        )}
                        <button type="button" onClick={() => setShowSecrets(p => ({ ...p, botToken: !p.botToken }))} className="p-0.5 rounded text-gray-400 hover:text-claude-accent transition-colors">
                          {showSecrets['botToken'] ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
                        </button>
                      </div>
                    </div>
                    <p className="text-xs text-gray-400">{i18nService.t('web3BotTokenHint')}</p>
                  </div>

                  {/* Allowed User IDs */}
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      Allowed User IDs
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={allowedUserIdInput}
                        onChange={e => setAllowedUserIdInput(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addAllowedUserId(); } }}
                        className="block flex-1 rounded-xl dark:bg-claude-darkBg bg-gray-50 dark:border-claude-darkBorder border-gray-200 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2.5 text-sm transition-colors"
                        placeholder={i18nService.t('web3EnterTelegramUserId')}
                      />
                      <button type="button" onClick={addAllowedUserId} className="px-3 py-2 rounded-xl text-xs font-medium bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20 transition-colors whitespace-nowrap">
                        {i18nService.t('web3Add')}
                      </button>
                    </div>
                    {localTelegram.allowedUserIds.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {localTelegram.allowedUserIds.map(id => (
                          <span key={id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-xs dark:bg-claude-darkBg bg-gray-100 dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-gray-200">
                            {id}
                            <button type="button" onClick={() => removeAllowedUserId(id)} className="text-gray-400 hover:text-red-500 transition-colors">
                              <XMarkIcon className="w-3 h-3" />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                    <p className="text-xs text-gray-400">{i18nService.t('web3AllowAllUsersHint')}</p>
                  </div>
                </>
              )}

              {(modalPlatform === 'feishu' || modalPlatform === 'lark') && (() => {
                const isLark = modalPlatform === 'lark';
                const localState = isLark ? localLark : localFeishu;
                const setLocalState = isLark ? setLocalLark : setLocalFeishu;
                return (
                <>
                  {/* App ID */}
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      App ID <span className="text-red-500">*</span>
                    </label>
                    <div className="relative">
                      <input
                        type="text"
                        value={localState.appId}
                        onChange={e => setLocalState(prev => ({ ...prev, appId: e.target.value }))}
                        className="block w-full rounded-xl dark:bg-claude-darkBg bg-gray-50 dark:border-claude-darkBorder border-gray-200 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2.5 pr-8 text-sm transition-colors"
                        placeholder="cli_xxxxx"
                      />
                      {localState.appId && (
                        <div className="absolute right-2 inset-y-0 flex items-center">
                          <button type="button" onClick={() => setLocalState(prev => ({ ...prev, appId: '' }))} className="p-0.5 rounded text-gray-400 hover:text-claude-accent transition-colors">
                            <XCircleIconSolid className="h-4 w-4" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* App Secret */}
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      App Secret <span className="text-red-500">*</span>
                    </label>
                    <div className="relative">
                      <input
                        type={showSecrets['appSecret'] ? 'text' : 'password'}
                        value={localState.appSecret}
                        onChange={e => setLocalState(prev => ({ ...prev, appSecret: e.target.value }))}
                        className="block w-full rounded-xl dark:bg-claude-darkBg bg-gray-50 dark:border-claude-darkBorder border-gray-200 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2.5 pr-16 text-sm transition-colors"
                        placeholder="••••••••••••"
                      />
                      <div className="absolute right-2 inset-y-0 flex items-center gap-1">
                        {localState.appSecret && (
                          <button type="button" onClick={() => setLocalState(prev => ({ ...prev, appSecret: '' }))} className="p-0.5 rounded text-gray-400 hover:text-claude-accent transition-colors">
                            <XCircleIconSolid className="h-4 w-4" />
                          </button>
                        )}
                        <button type="button" onClick={() => setShowSecrets(p => ({ ...p, appSecret: !p.appSecret }))} className="p-0.5 rounded text-gray-400 hover:text-claude-accent transition-colors">
                          {showSecrets['appSecret'] ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
                        </button>
                      </div>
                    </div>
                  </div>
                </>
                );
              })()}

              {modalPlatform === 'dingtalk' && (
                <>
                  {/* Client ID */}
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      Client ID <span className="text-red-500">*</span>
                    </label>
                    <div className="relative">
                      <input
                        type="text"
                        value={localDingtalk.clientId}
                        onChange={e => setLocalDingtalk(prev => ({ ...prev, clientId: e.target.value }))}
                        className="block w-full rounded-xl dark:bg-claude-darkBg bg-gray-50 dark:border-claude-darkBorder border-gray-200 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2.5 pr-8 text-sm transition-colors"
                        placeholder="dingxxxxxxxx"
                      />
                      {localDingtalk.clientId && (
                        <div className="absolute right-2 inset-y-0 flex items-center">
                          <button type="button" onClick={() => setLocalDingtalk(prev => ({ ...prev, clientId: '' }))} className="p-0.5 rounded text-gray-400 hover:text-claude-accent transition-colors">
                            <XCircleIconSolid className="h-4 w-4" />
                          </button>
                        </div>
                      )}
                    </div>
                    <p className="text-xs text-gray-400">{i18nService.t('web3DingTalkClientIdHint')}</p>
                  </div>

                  {/* Client Secret */}
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      Client Secret <span className="text-red-500">*</span>
                    </label>
                    <div className="relative">
                      <input
                        type={showSecrets['clientSecret'] ? 'text' : 'password'}
                        value={localDingtalk.clientSecret}
                        onChange={e => setLocalDingtalk(prev => ({ ...prev, clientSecret: e.target.value }))}
                        className="block w-full rounded-xl dark:bg-claude-darkBg bg-gray-50 dark:border-claude-darkBorder border-gray-200 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2.5 pr-16 text-sm transition-colors"
                        placeholder="••••••••••••"
                      />
                      <div className="absolute right-2 inset-y-0 flex items-center gap-1">
                        {localDingtalk.clientSecret && (
                          <button type="button" onClick={() => setLocalDingtalk(prev => ({ ...prev, clientSecret: '' }))} className="p-0.5 rounded text-gray-400 hover:text-claude-accent transition-colors">
                            <XCircleIconSolid className="h-4 w-4" />
                          </button>
                        )}
                        <button type="button" onClick={() => setShowSecrets(p => ({ ...p, clientSecret: !p.clientSecret }))} className="p-0.5 rounded text-gray-400 hover:text-claude-accent transition-colors">
                          {showSecrets['clientSecret'] ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
                        </button>
                      </div>
                    </div>
                  </div>
                </>
              )}

              {/* Connectivity test result */}
              {connectivityResult && (
                <div className={`rounded-xl p-3 text-xs space-y-1.5 ${
                  connectivityResult.verdict === 'pass' ? 'bg-green-500/10 border border-green-500/20' :
                  connectivityResult.verdict === 'warn' ? 'bg-yellow-500/10 border border-yellow-500/20' :
                  'bg-red-500/10 border border-red-500/20'
                }`}>
                  <p className={`font-semibold ${
                    connectivityResult.verdict === 'pass' ? 'text-green-600 dark:text-green-400' :
                    connectivityResult.verdict === 'warn' ? 'text-yellow-600 dark:text-yellow-400' :
                    'text-red-600 dark:text-red-400'
                  }`}>
                    {connectivityResult.verdict === 'pass' ? i18nService.t('web3ConnectedSuccess') : connectivityResult.verdict === 'warn' ? i18nService.t('web3PartialPass') : i18nService.t('web3ConnectionFailed')}
                  </p>
                  {connectivityResult.checks.map((c, i) => (
                    <p key={i} className="dark:text-claude-darkTextSecondary text-claude-textSecondary">{c.message}</p>
                  ))}
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-between px-5 py-4 border-t dark:border-claude-darkBorder border-claude-border gap-3">
              <button
                type="button"
                onClick={() => runConnectivityTest(modalPlatform)}
                disabled={!!testingPlatform}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <SignalIcon className="h-3.5 w-3.5" />
                {testingPlatform ? i18nService.t('web3Testing') : i18nService.t('web3TestConnection')}
              </button>
              <div className="flex gap-2">
                <button type="button" onClick={closeModal} className="px-4 py-2 text-xs font-medium rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-gray-50 transition-colors">
                  {i18nService.t('cancel')}
                </button>
                <button type="button" onClick={handleSave} className="px-5 py-2 text-xs font-semibold rounded-xl bg-claude-accent text-white hover:bg-claude-accentHover transition-colors">
                  {i18nService.t('save')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Web3View;
