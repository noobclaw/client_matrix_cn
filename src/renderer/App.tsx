import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from './store';
import Settings, { type SettingsOpenOptions } from './components/Settings';
import Sidebar from './components/Sidebar';
import Toast from './components/Toast';
import RebateDrawer from './components/RebateDrawer';
import { HIDE_WEB3 } from './buildFlags';
import { ErrorBoundary } from './components/ErrorBoundary';
import WindowTitleBar from './components/window/WindowTitleBar';
import { CoworkView } from './components/cowork';
import CoworkHistoryPage from './components/cowork/CoworkHistoryPage';
import { SkillsView } from './components/skills';
import { ScheduledTasksView } from './components/scheduledTasks';
import { Web3View } from './components/web3/Web3View';
import Web3NewsPage from './components/web3/Web3NewsPage';
import GlobalHotSearchPage from './components/web3/GlobalHotSearchPage';
import MatrixView from './components/matrix/MatrixView';
import HomeView from './components/home/HomeView';
import MembershipExpiryModal from './components/membership/MembershipExpiryModal';
import CoworkPermissionModal from './components/cowork/CoworkPermissionModal';
import CoworkQuestionWizard from './components/cowork/CoworkQuestionWizard';
import { configService } from './services/config';
import { apiService } from './services/api';
import { themeService } from './services/theme';
import { coworkService } from './services/cowork';
import { scheduledTaskService } from './services/scheduledTask';
import { openWallet } from './services/walletNav';
import { checkForAppUpdate, type AppUpdateInfo, type AppUpdateDownloadProgress, UPDATE_POLL_INTERVAL_MS, UPDATE_HEARTBEAT_INTERVAL_MS } from './services/appUpdate';
import { defaultConfig } from './config';
import { setAvailableModels, setSelectedModel } from './store/slices/modelSlice';
import { clearSelection } from './store/slices/quickActionSlice';
import type { ApiConfig } from './services/api';
import type { CoworkPermissionResult } from './types/cowork';
import { ChatBubbleLeftRightIcon } from '@heroicons/react/24/outline';
import { i18nService } from './services/i18n';
import { matchesShortcut } from './services/shortcuts';
import AppUpdateBadge from './components/update/AppUpdateBadge';
import AppUpdateModal from './components/update/AppUpdateModal';
import { WalletView } from './components/wallet/WalletView';
import { InviteView } from './components/invite/InviteView';
import NotificationCenter from './components/notifications/NotificationCenter';
import { ScenarioView } from './components/scenario/ScenarioView';
import PartnersView from './components/partners/PartnersView';
import PersonalityView from './components/personality/PersonalityView';
import LoginWall from './components/LoginWall';
import TokenInsufficientDialog from './components/TokenInsufficientDialog';
import { noobClawAuth } from './services/noobclawAuth';
import { noobClawApi } from './services/noobclawApi';
import { writeCachedPaymentInfo, writeCachedRedeemInfo } from './services/paymentInfoCache';
import { noobClawSSE } from './services/noobclawSSE';
import { MATRIX_EDITION } from './matrixEdition';

const App: React.FC = () => {
  const [showSettings, setShowSettings] = useState(false);
  const [settingsOptions, setSettingsOptions] = useState<SettingsOpenOptions>({});
  // 启动默认落到「一键涨粉」(scenarioCreate),而不是 AI 对话(cowork)。副作用:Sidebar 的
  // 「AI对话」二级折叠组只在其子项(cowork/mcp/web3news/scheduledTasks)激活时才强制展开,
  // 默认页非该组子项 → 该组保持收起(aiChatOpen 初始 false),正好满足「AI对话菜单默认收起」。
  const [mainView, setMainView] = useState<'home' | 'cowork' | 'coworkHistory' | 'skills' | 'scheduledTasks' | 'mcp' | 'wallet' | 'invite' | 'quickuse' | 'scenarioCreate' | 'scenarioRuns' | 'web3news' | 'hotsearch' | 'partners' | 'personality' | 'matrix' | 'matrixTaskNew' | 'matrixTasks' | 'matrixRuns'>(MATRIX_EDITION ? 'home' : 'scenarioCreate');
  // 从「所有 AI 对话」列表点进某条对话时置 true:此时侧栏仍高亮「所有 AI 对话」、详情页左上显示返回按钮。
  const [coworkFromHistory, setCoworkFromHistory] = useState(false);
  // v4.31.44: 主页 6 个涨粉标签可以指定打开"一键使用"时初选哪个平台
  const [quickUseInitialPlatform, setQuickUseInitialPlatform] = useState<'xhs' | 'x' | 'binance' | 'youtube' | 'tiktok' | 'douyin' | 'kuaishou' | 'bilibili' | 'shipinhao' | 'toutiao' | 'instagram' | 'facebook' | 'reddit' | 'video' | undefined>(undefined);
  // ScenarioView 下钻到任务/运行记录详情时为 true:任务详情逻辑上属于「我的涨粉任务」,
  // 在「新建涨粉任务 / 涨粉运行记录」菜单下钻时,把左侧菜单高亮临时切到「我的涨粉任务」。
  const [scenarioInDetail, setScenarioInDetail] = useState(false);
  // 侧栏每次点涨粉菜单就 +1,传给 ScenarioView 让它退回列表(即使 mainView 同值、setMainView 是 no-op)。
  const [scenarioNavNonce, setScenarioNavNonce] = useState(0);
  const [isInitialized, setIsInitialized] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [, forceLanguageRefresh] = useState(0);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [updateModalState, setUpdateModalState] = useState<'info' | 'downloading' | 'installing' | 'error'>('info');
  const [downloadProgress, setDownloadProgress] = useState<AppUpdateDownloadProgress | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [authState, setAuthState] = useState(noobClawAuth.getState());
  const [showTokenDialog, setShowTokenDialog] = useState(false);
  // 镜像 showTokenDialog 供 SSE 事件回调同步读(闭包里读 state 会拿到旧值)。
  //   窗口开着时,后续「余额不足」事件(多任务并发)一律忽略 → 没关闭就只弹一次。
  const tokenDialogOpenRef = useRef(false);
  const [showLoginWall, setShowLoginWall] = useState(false);
  const toastTimerRef = useRef<number | null>(null);
  const hasInitialized = useRef(false);
  const dispatch = useDispatch();
  const selectedModel = useSelector((state: RootState) => state.model.selectedModel);
  const currentSessionId = useSelector((state: RootState) => state.cowork.currentSessionId);
  const pendingPermissions = useSelector((state: RootState) => state.cowork.pendingPermissions);
  const pendingPermission = pendingPermissions[0] ?? null;
  const isWindows = window.electron.platform === 'win32';

  // Initialize application
  useEffect(() => {
    if (hasInitialized.current) {
      return;
    }
    hasInitialized.current = true;

    const initializeApp = async () => {
      try {
        // Mark platform for CSS conditional styles (e.g. Windows title bar button area padding)
        document.documentElement.classList.add(`platform-${window.electron.platform}`);

        // Initialize configuration
        await configService.init();
        
        // Initialize theme
        themeService.initialize();

        // Initialize language
        await i18nService.initialize();
        
        const config = await configService.getConfig();
        
        const apiConfig: ApiConfig = {
          apiKey: config.api.key,
          baseUrl: config.api.baseUrl,
        };
        apiService.setConfig(apiConfig);

        // Load available models from providers config into Redux
        const useNoobClawServer = config.app?.useNoobClawServer !== false;
        let resolvedModels: { id: string; name: string; provider?: string; providerKey?: string; supportsImage?: boolean }[];

        if (useNoobClawServer) {
          // v4.31.28: 砍掉 reasoner 选项,后端两路都走 v4-flash,UI 只暴露一个 chat。
          resolvedModels = [
            { id: 'noobclawai-chat', name: 'NoobClawAI-Chat', provider: 'NoobClaw', providerKey: 'noobclawAI' },
          ];
        } else {
          // Custom API Key mode: load models from enabled third-party providers (skip NoobClaw own services)
          const providerModels: typeof resolvedModels = [];
          if (config.providers) {
            Object.entries(config.providers).forEach(([providerName, providerConfig]) => {
              if (providerName === 'noobclawAI' || providerName === 'noobclawzhiyun') return;
              if (providerConfig.enabled && providerConfig.models) {
                providerConfig.models.forEach((model: { id: string; name: string; supportsImage?: boolean }) => {
                  providerModels.push({
                    id: model.id,
                    name: model.name,
                    provider: providerName.charAt(0).toUpperCase() + providerName.slice(1),
                    providerKey: providerName,
                    supportsImage: model.supportsImage ?? false,
                  });
                });
              }
            });
          }
          const fallbackModels = config.model.availableModels.map(model => ({
            id: model.id,
            name: model.name,
            providerKey: undefined,
            supportsImage: model.supportsImage ?? false,
          }));
          resolvedModels = providerModels.length > 0 ? providerModels : fallbackModels;
        }

        if (resolvedModels.length > 0) {
          dispatch(setAvailableModels(resolvedModels));
          // v4.31.28: reasoner 砍掉了,老用户存的 noobclawai-reasoner / deepseek-reasoner
          // 也要回落到 chat。
          let defaultModelId = config.model.defaultModel;
          if (
            defaultModelId === 'deepseek-chat'
            || defaultModelId === 'deepseek-reasoner'
            || defaultModelId === 'noobclawai-reasoner'
          ) {
            defaultModelId = 'noobclawai-chat';
          }
          const preferredModel = resolvedModels.find(
            model => model.id === defaultModelId
              && (!config.model.defaultModelProvider || model.providerKey === config.model.defaultModelProvider)
          ) ?? resolvedModels.find(m => m.id === 'noobclawai-chat') ?? resolvedModels[0];
          dispatch(setSelectedModel(preferredModel));
        }
        
        // Initialize scheduled task service —— 矩阵 edition 不跑旧的 AI 定时任务调度
        // (避免与矩阵任务争抢资源/浏览器;矩阵的调度走自己的 taskRunner)。
        if (!MATRIX_EDITION) {
          await scheduledTaskService.init();
        }

        // Initialize cowork service early so SSE listeners (including
        // noobclaw:sse-payload for lucky bag / balance update) are registered
        // as soon as possible, not only when the user first opens CoworkView.
        // Without this, lucky bag events broadcast before the user navigates
        // to cowork would be silently dropped.
        void coworkService.init().catch((err) => {
          console.error('[App] coworkService.init failed:', err);
        });

        setIsInitialized(true);

        // No longer automatically showing LoginWall at startup; users can browse freely
        // LoginWall only appears when the user tries to send a message
      } catch (error) {
        console.error('Failed to initialize app:', error);
        setInitError(i18nService.t('initializationError'));
        setIsInitialized(true);
      }
    };

    initializeApp();
  }, []);

  useEffect(() => {
    const unsubscribe = i18nService.subscribe(() => {
      forceLanguageRefresh((prev) => prev + 1);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  // Network status monitoring
  useEffect(() => {
    const handleOnline = () => {
      console.log('[Renderer] Network online');
      window.electron.networkStatus.send('online');
    };

    const handleOffline = () => {
      console.log('[Renderer] Network offline');
      window.electron.networkStatus.send('offline');
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    if (!isInitialized || !selectedModel?.id) return;
    const config = configService.getConfig();
    if (
      config.model.defaultModel === selectedModel.id
      && (config.model.defaultModelProvider ?? '') === (selectedModel.providerKey ?? '')
    ) {
      return;
    }
    void configService.updateConfig({
      model: {
        ...config.model,
        defaultModel: selectedModel.id,
        defaultModelProvider: selectedModel.providerKey,
      },
    });
  }, [isInitialized, selectedModel?.id, selectedModel?.providerKey]);

  const handleShowSettings = useCallback((options?: SettingsOpenOptions) => {
    setSettingsOptions({
      initialTab: options?.initialTab,
      notice: options?.notice,
    });
    setShowSettings(true);
  }, []);

  const handleShowSkills = useCallback(() => {
    setMainView('skills');
  }, []);

  const handleShowCowork = useCallback(() => {
    setCoworkFromHistory(false);
    setMainView('cowork');
  }, []);

  const handleShowCoworkHistory = useCallback(() => {
    setMainView('coworkHistory');
  }, []);

  const handleShowScheduledTasks = useCallback(() => {
    setMainView('scheduledTasks');
  }, []);

  const handleShowMcp = useCallback(() => {
    setMainView('mcp');
  }, []);

  const handleToggleSidebar = useCallback(() => {
    setIsSidebarCollapsed((prev) => !prev);
  }, []);

  const handleNewChat = useCallback(() => {
    // New chat no longer shows LoginWall; login check happens when user sends a message
    const shouldClearInput = mainView === 'cowork' || !!currentSessionId;
    coworkService.clearSession();
    dispatch(clearSelection());
    setCoworkFromHistory(false);
    setMainView('cowork');
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('cowork:focus-input', {
        detail: { clear: shouldClearInput },
      }));
    }, 0);
  }, [dispatch, mainView, currentSessionId]);

  const showToast = useCallback((message: string) => {
    setToastMessage(message);
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToastMessage(null);
      toastTimerRef.current = null;
    }, 2200);
  }, []);

  const handleShowLogin = useCallback(() => {
    noobClawAuth.requireLoginUI();
  }, []);

  const runUpdateCheck = useCallback(async () => {
    try {
      const currentVersion = await window.electron.appInfo.getVersion();
      const nextUpdate = await checkForAppUpdate(currentVersion);
      setUpdateInfo(nextUpdate);
      if (!nextUpdate) {
        setShowUpdateModal(false);
      }
    } catch (error) {
      console.error('Failed to check app update:', error);
      setUpdateInfo(null);
      setShowUpdateModal(false);
    }
  }, []);

  const handleOpenUpdateModal = useCallback(() => {
    if (!updateInfo) return;
    setUpdateModalState('info');
    setUpdateError(null);
    setDownloadProgress(null);
    setShowUpdateModal(true);
  }, [updateInfo]);

  const handleUpdateFound = useCallback((info: AppUpdateInfo) => {
    setUpdateInfo(info);
    setUpdateModalState('info');
    setUpdateError(null);
    setDownloadProgress(null);
    setShowUpdateModal(true);
  }, []);

  const handleConfirmUpdate = useCallback(async () => {
    if (!updateInfo) return;

    // Tauri always delegates updates to the OS browser — the user
    // downloads the new installer and runs it manually, exactly like the
    // first install. No in-app downloader, no binary replacement, no
    // updater plugin. Fall into the same code path as the Electron
    // fallback page branch below.
    const isTauri = !!(window as any).__TAURI__;

    // If the URL is a fallback page (not a direct file download), open in browser
    if (isTauri || updateInfo.url.includes('#') || updateInfo.url.endsWith('/download-list')) {
      setShowUpdateModal(false);
      try {
        const result = await window.electron.shell.openExternal(updateInfo.url);
        if (!result.success) {
          showToast(i18nService.t('updateOpenFailed'));
        }
      } catch (error) {
        console.error('Failed to open update url:', error);
        showToast(i18nService.t('updateOpenFailed'));
      }
      return;
    }

    setUpdateModalState('downloading');
    setDownloadProgress(null);
    setUpdateError(null);

    const unsubscribe = window.electron.appUpdate.onDownloadProgress((progress) => {
      setDownloadProgress(progress);
    });

    try {
      const downloadResult = await window.electron.appUpdate.download(updateInfo.url);
      unsubscribe();

      if (!downloadResult.success) {
        // If user cancelled, handleCancelDownload already set the state — don't overwrite
        if (downloadResult.error === 'Download cancelled') {
          return;
        }
        setUpdateModalState('error');
        setUpdateError(downloadResult.error || i18nService.t('updateDownloadFailed'));
        return;
      }

      setUpdateModalState('installing');
      const installResult = await window.electron.appUpdate.install(downloadResult.filePath!);

      if (!installResult.success) {
        setUpdateModalState('error');
        setUpdateError(installResult.error || i18nService.t('updateInstallFailed'));
      }
      // If successful, app will quit and relaunch
    } catch (error) {
      unsubscribe();
      const msg = error instanceof Error ? error.message : '';
      // If user cancelled, handleCancelDownload already set the state — don't overwrite
      if (msg === 'Download cancelled') {
        return;
      }
      setUpdateModalState('error');
      setUpdateError(msg || i18nService.t('updateDownloadFailed'));
    }
  }, [updateInfo, showToast]);

  const handleCancelDownload = useCallback(async () => {
    await window.electron.appUpdate.cancelDownload();
    setUpdateModalState('info');
    setDownloadProgress(null);
  }, []);

  const handleRetryUpdate = useCallback(() => {
    setUpdateModalState('info');
    setUpdateError(null);
    setDownloadProgress(null);
  }, []);

  const handlePermissionResponse = useCallback(async (result: CoworkPermissionResult) => {
    if (!pendingPermission) return;
    await coworkService.respondToPermission(pendingPermission.requestId, result);
  }, [pendingPermission]);

  const handleCloseSettings = () => {
    setShowSettings(false);
    const config = configService.getConfig();
    apiService.setConfig({
      apiKey: config.api.key,
      baseUrl: config.api.baseUrl,
    });

    const useServer = config.app?.useNoobClawServer !== false;
    if (useServer) {
      // v4.31.28: 单 chat 项,reasoner 已砍。
      dispatch(setAvailableModels([
        { id: 'noobclawai-chat', name: 'NoobClawAI-Chat', provider: 'NoobClaw', providerKey: 'noobclawAI' },
      ]));
      dispatch(setSelectedModel({ id: 'noobclawai-chat', name: 'NoobClawAI-Chat', provider: 'NoobClaw', providerKey: 'noobclawAI' }));
    } else if (config.providers) {
      const allModels: { id: string; name: string; provider?: string; providerKey?: string; supportsImage?: boolean }[] = [];
      Object.entries(config.providers).forEach(([providerName, providerConfig]) => {
        if (providerName === 'noobclawAI' || providerName === 'noobclawzhiyun') return;
        if (providerConfig.enabled && providerConfig.models) {
          providerConfig.models.forEach((model: { id: string; name: string; supportsImage?: boolean }) => {
            allModels.push({
              id: model.id,
              name: model.name,
              provider: providerName.charAt(0).toUpperCase() + providerName.slice(1),
              providerKey: providerName,
              supportsImage: model.supportsImage ?? false,
            });
          });
        }
      });
      if (allModels.length > 0) {
        dispatch(setAvailableModels(allModels));
      }
    }
  };

  const isShortcutInputActive = () => {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) return false;
    return activeElement.dataset.shortcutInput === 'true';
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || isShortcutInputActive()) return;

      const { shortcuts } = configService.getConfig();
      const activeShortcuts = {
        ...defaultConfig.shortcuts,
        ...(shortcuts ?? {}),
      };

      if (matchesShortcut(event, activeShortcuts.newChat)) {
        event.preventDefault();
        handleNewChat();
        return;
      }

      if (matchesShortcut(event, activeShortcuts.search)) {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent('cowork:shortcut:search'));
        return;
      }

      if (matchesShortcut(event, activeShortcuts.settings)) {
        event.preventDefault();
        handleShowSettings();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleShowSettings, handleNewChat]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  // Listen for toast events from child components
  useEffect(() => {
    const handler = (e: Event) => {
      const message = (e as CustomEvent<string>).detail;
      if (message) showToast(message);
    };
    window.addEventListener('app:showToast', handler);
    return () => window.removeEventListener('app:showToast', handler);
  }, [showToast]);

  // v4.31.45: 全局监听定时任务被 SKIPPED 事件,toast 提示用户。手动触发已有
  //   类似提示(在 TaskDetailPage),定时跑跟它对齐 — 用户能看到"X 任务到点
  //   没启动:被 XXX 占用",不再 silently 错过。
  useEffect(() => {
    const off = (window.electron as any)?.ipcRenderer?.on?.('scenario:scheduledSkipped', (info: any) => {
      const taskShort = info?.taskId ? `#${String(info.taskId).slice(0, 8)}` : '任务';
      const reason = String(info?.reason || '');
      let msg: string;
      if (reason.startsWith('resource_busy:') && Array.isArray(info?.busyPlatforms) && info.busyPlatforms.length) {
        const plats = info.busyPlatforms.join(' + ');
        const holder = info?.busyTaskName || '其他任务';
        msg = `⏰ 定时任务 ${taskShort} 到点未启动:${plats} 被 ${holder} 占用,下个 tick 重试`;
      } else if (reason === 'concurrency_limit_reached') {
        msg = `⏰ 定时任务 ${taskShort} 到点未启动:同时运行任务已达上限,下个 tick 重试`;
      } else {
        msg = `⏰ 定时任务 ${taskShort} 到点未启动:${reason || '未知'}`;
      }
      showToast(msg);
    });
    return () => { if (typeof off === 'function') off(); };
  }, [showToast]);

  // Subscribe to auth state changes
  useEffect(() => {
    const unsub = noobClawAuth.subscribe(setAuthState);
    return unsub;
  }, []);

  // v1.x: 启动预拉 paymentInfo —— 用户反馈"客户端加载套餐还是很慢"。
  // 对照官网快是因为 ucRender 进 UC 页面那一刻就并行 fetch /api/payment/info,
  // 等用户点"我的充值"tab 时数据早就到了内存。客户端之前没做预拉,WalletView
  // mount 那一刻才开始 fetch,首次进我的充值就要等 200~800ms 网络。
  // 这里在认证完成的瞬间 fire-and-forget 拉一次,响应写 paymentInfoCache
  // localStorage,后续 WalletView lazy-init 从 cache 拿,套餐卡秒出。
  // 已认证状态下做,避免给登录前的用户白触发一次 401。
  useEffect(() => {
    if (!authState.isAuthenticated) return;
    noobClawApi.getPaymentInfo().then((info) => {
      if (info) writeCachedPaymentInfo(info);
    }).catch(() => { /* 静默 — 失败不影响主流程,WalletView mount 时会自己重试 */ });
    // CNY 卡密档位也启动预取(对齐 USDT/BNB),写 redeem 缓存 → WalletView lazy-init 从 cache 秒出,
    //   首次进我的充值不用再等 getRedeemPackages 网络。没配卡密通道(packages 空)就不写,CNY tab 自然不露。
    noobClawApi.getRedeemPackages().then((info) => {
      if (info && info.packages && info.packages.length > 0) writeCachedRedeemInfo(info);
    }).catch(() => { /* 静默 — WalletView mount 时会自己重试 */ });
  }, [authState.isAuthenticated]);

  // v1.x: SSE 实时推送通道。认证后 open EventSource('/api/me/events/stream'),
  // 服务器在 rebate batch 上链确认后立即 push,客户端 0 延迟弹 RebateDrawer
  // (对比之前最多 15s polling 延迟)。
  // /balance pendingRebates 轮询保留作为兜底:SSE 没连上 / 浏览器不支持 /
  // 服务端推送漏发的话,polling 还能托底,两条路径靠后端 notified_at 原子
  // 标记自动去重(同一笔不会被两边都触发)。
  // EventSource 不支持 custom header,token 走 query param,后端 SSE 路由
  // 单独做 JWT 验证。logout / authExpired → stop(),自动清理重连 timer。
  useEffect(() => {
    if (authState.isAuthenticated && authState.authToken) {
      noobClawSSE.start(authState.authToken);
    } else {
      noobClawSSE.stop();
    }
  }, [authState.isAuthenticated, authState.authToken]);

  // Listen for token-insufficient event from api.ts / noobclawAuth 预检(renderer 内 CustomEvent)
  useEffect(() => {
    const handler = () => setShowTokenDialog(true);
    window.addEventListener('noobclaw:token-insufficient', handler);
    return () => window.removeEventListener('noobclaw:token-insufficient', handler);
  }, []);

  // 运行中(含定时任务)余额不足:sidecar 检测到 runner 命中 402 → broadcastSSE
  //   'noobclaw:token-insufficient' → 这里弹同一个充值/续费弹窗(否则用户只在流式日志里看到,
  //   任务一直失败却不知道要去充值/续费)。先刷一次余额让弹窗数字最新,再弹。
  //   守卫:弹窗已开着就整段忽略(多个任务并发命中不足时不重复刷余额/重触发)——没关闭只弹一次。
  useEffect(() => {
    const off = (window.electron as any)?.ipcRenderer?.on?.('noobclaw:token-insufficient', () => {
      if (tokenDialogOpenRef.current) return;
      noobClawAuth.refreshBalance().catch(() => {});
      setShowTokenDialog(true);
    });
    return () => { try { off?.(); } catch { /* noop */ } };
  }, []);

  // 保持 ref 与弹窗开关同步,供上面的 SSE 回调即时读到最新状态。
  useEffect(() => { tokenDialogOpenRef.current = showTokenDialog; }, [showTokenDialog]);

  // Listen for show-wallet event (e.g. from low-balance button)
  useEffect(() => {
    const handler = () => setMainView('wallet');
    window.addEventListener('noobclaw:show-wallet', handler);
    return () => window.removeEventListener('noobclaw:show-wallet', handler);
  }, []);

  // 矩阵号:从深层组件(热搜成片向导「无可用账号」引导)跳到「我的矩阵账号」管理页。
  // detail.platform 携带来源平台,落到 MatrixView 对应平台 tab。
  const [matrixInitialPlatform, setMatrixInitialPlatform] = useState<string | undefined>(undefined);
  useEffect(() => {
    const handler = (e: Event) => {
      const p = (e as CustomEvent)?.detail?.platform;
      if (typeof p === 'string' && p) setMatrixInitialPlatform(p);
      setMainView('matrix');
    };
    window.addEventListener('noobclaw:show-matrix-accounts', handler);
    return () => window.removeEventListener('noobclaw:show-matrix-accounts', handler);
  }, []);
  // 离开「我的矩阵账号」就清掉引导平台,避免粘滞(否则下次从侧栏进会停在上次引导的平台而非默认抖音)。
  useEffect(() => { if (mainView !== 'matrix' && matrixInitialPlatform) setMatrixInitialPlatform(undefined); }, [mainView, matrixInitialPlatform]);
  // 矩阵号:记住账号页当前选中的平台 —— 「新建涨粉任务」互动向导默认落在这个平台,
  // 而不是写死抖音(否则在 YouTube tab 点新建,弹出的却是「配置抖音互动涨粉」=串台)。
  // 初值用 'video'(多平台视频创作):新建/我的/运行记录三页默认就停在这个 tab。
  const [matrixPlatform, setMatrixPlatform] = useState<string>('video');
  // 矩阵号:全平台「登录过期」账号总数 —— 喂给侧栏「我的矩阵账号」菜单右上角红圈角标(与账号页各平台 tab 角标口径一致),
  // 即便当前不在矩阵页也独立订阅,保证用户在任何页面都能看到「有号过期了,去重连」的提醒。
  const [matrixExpiredTotal, setMatrixExpiredTotal] = useState(0);
  useEffect(() => {
    if (!MATRIX_EDITION) return;
    const M = () => (window as any).electron?.matrix;
    const recompute = async () => {
      try {
        const r = await M()?.listAccounts();
        if (!r?.ok) return;
        // 「登录过期」= login_required 且连过有身份(昵称/头像/平台号任一存在),与 MatrixView 卡片/tab 角标一致。
        const n = (r.accounts || []).filter((a: any) => a.status === 'login_required' && !!(a.nickname || a.avatar || a.displayId)).length;
        setMatrixExpiredTotal(n);
      } catch { /* 拉不到账号不挡 UI */ }
    };
    recompute();
    const off = M()?.onAccount?.(() => { recompute(); });
    return () => { if (typeof off === 'function') off(); };
  }, []);

  // Listen for command-bar submissions from the floating NSPanel window
  // (src/renderer/components/commandBar/CommandBarView.tsx). When the
  // user hits ⌘K / Ctrl+K and enters a prompt, the command bar uses a
  // BroadcastChannel to push the text here; we switch to the cowork
  // view and dispatch a custom `noobclaw:prefill-prompt` event which
  // the composer picks up. Also checked on mount against localStorage
  // as a fallback for webviews without BroadcastChannel.
  useEffect(() => {
    const forward = (payload: { prompt?: string; source?: string }) => {
      if (!payload?.prompt) return;
      setCoworkFromHistory(false);
      setMainView('cowork');
      // Give React a tick to mount the cowork view before dispatching.
      setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent('noobclaw:prefill-prompt', {
            detail: { prompt: payload.prompt, source: payload.source || 'command-bar' },
          })
        );
      }, 50);
    };

    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel('noobclaw-command-bar');
      bc.onmessage = (ev) => {
        if (ev?.data?.type === 'submit') forward(ev.data.payload);
      };
    } catch { /* older webviews */ }

    // Fallback: consume pending prompt persisted by the command bar.
    try {
      const pending = localStorage.getItem('noobclaw:command-bar:pending');
      if (pending) {
        localStorage.removeItem('noobclaw:command-bar:pending');
        forward(JSON.parse(pending));
      }
    } catch { /* ignore */ }

    return () => {
      if (bc) {
        try { bc.close(); } catch { /* ignore */ }
      }
    };
  }, []);

  // Listen for need-login event from api.ts
  useEffect(() => {
    const handler = () => setShowLoginWall(true);
    window.addEventListener('noobclaw:need-login', handler);
    return () => window.removeEventListener('noobclaw:need-login', handler);
  }, []);

  // Sidecar crash events — the crash reporter (main/libs/crashReporter.ts)
  // broadcasts a system:crash SSE whenever it catches an uncaught
  // exception or unhandled rejection in the sidecar. Surface it as a
  // one-line toast so the user knows to restart or file a bug. The
  // full record lives on disk and is retrievable via electron.crashes.list.
  useEffect(() => {
    const api = (window as any).electron?.crashes;
    if (!api?.onCrash) return;
    const off = api.onCrash((detail: { kind: string; message: string }) => {
      setToastMessage(`Sidecar ${detail.kind}: ${detail.message.slice(0, 80)}`);
    });
    return () => { if (typeof off === 'function') off(); };
  }, []);

  // Renderer ErrorBoundary-adjacent global handlers: unhandled promise
  // rejections and thrown errors in React callbacks land here. We log
  // them to console for debugging + show a toast — but we suppress a
  // handful of expected-but-noisy errors that the user cannot act on.
  //
  // Suppressed (logged-only, no toast):
  //   - "Unexpected end of JSON input" / "Failed to execute 'json' on 'Response'"
  //     Fires when fetch hits an empty-body response (204 No Content,
  //     an Electron IPC redirect, auth-expired handler that empties the
  //     stream, etc). All of our app-level fetch wrappers handle this
  //     case correctly via try/catch around res.json(); the noise comes
  //     from third-party / SDK code paths we don't control. User-facing
  //     toast adds zero value — operator sees the symptom on console
  //     during dev, prod users just see meaningless "Unhandled: ..."
  useEffect(() => {
    const SILENT_PATTERNS = [
      /Unexpected end of JSON input/i,
      /Failed to execute 'json' on 'Response'/i,
      /JSON\.parse:/i,
      // URL-parse failures from `new URL(badStr)` / `fetch(badStr)`. Each
      // WebView engine words it differently — silence all three so users
      // on every OS get the same (clean) experience. Stack still hits the
      // console via the onRejection logger below; open DevTools console
      // next time it happens to pinpoint the callsite passing a bad URL.
      //   WebKit (macOS WKWebView / Safari)
      /The string did not match the expected pattern/i,
      //   Chromium (Windows WebView2 / older Linux WebKitGTK builds)
      /Failed to construct 'URL'/i,
      //   Firefox / fetch spec wording
      /Invalid URL/i,
    ];
    const shouldSilence = (msg: string) => SILENT_PATTERNS.some((re) => re.test(msg));

    const onError = (event: ErrorEvent) => {
      const msg = (event.message || 'unknown');
      // For Error objects the console formats stack automatically; only
      // append .stack explicitly when event.error isn't an Error (rare —
      // some libs throw strings/POJOs and lose the stack otherwise).
      const extra = (event.error instanceof Error) ? [] : [event.error?.stack || ''];
      // eslint-disable-next-line no-console
      console.error('[window.error]', event.error || msg, ...extra);
      if (shouldSilence(msg)) return;
      setToastMessage(`Error: ${msg.slice(0, 80)}`);
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      const msg = event.reason instanceof Error ? event.reason.message : String(event.reason);
      // For Error objects the console already prints stack — don't dupe.
      // For non-Error rejections (string / POJO / null), JSON-dump so we
      // still get *something* in the console to debug from.
      if (event.reason instanceof Error) {
        // eslint-disable-next-line no-console
        console.error('[unhandledrejection]', event.reason);
      } else {
        let dump = '';
        try { dump = JSON.stringify(event.reason) ?? ''; } catch { /* circular */ }
        // eslint-disable-next-line no-console
        console.error('[unhandledrejection]', event.reason, '\nDUMP:', dump);
      }
      if (shouldSilence(msg)) {
        // Mark as handled so it stops bubbling to the host (Electron) too.
        event.preventDefault?.();
        return;
      }
      setToastMessage(`Unhandled: ${msg.slice(0, 80)}`);
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  // Listen for auth token from website (via electron IPC or deep link)
  useEffect(() => {
    if (typeof window !== 'undefined' && (window as any).electron) {
      (window as any).electron.onAuthCallback?.((token: string, wallet: string, email?: string, socialProvider?: string) => {
        noobClawAuth.setAuthFromWebsite(token, wallet, email || '', socialProvider || '');
      });
    }
  }, []);

  // Listen for tray menu open-settings IPC event
  useEffect(() => {
    const unsubscribe = window.electron.ipcRenderer.on('app:openSettings', () => {
      handleShowSettings();
    });
    return unsubscribe;
  }, [handleShowSettings]);

  // Listen for tray menu new-task IPC event
  useEffect(() => {
    const unsubscribe = window.electron.ipcRenderer.on('app:newTask', () => {
      handleNewChat();
    });
    return unsubscribe;
  }, [handleNewChat]);

  // Listen for scheduled task view-session event
  useEffect(() => {
    const handleViewSession = async (event: Event) => {
      const { sessionId } = (event as CustomEvent).detail;
      if (sessionId) {
        setCoworkFromHistory(false);
        setMainView('cowork');
        await coworkService.loadSession(sessionId);
      }
    };
    window.addEventListener('scheduledTask:viewSession', handleViewSession);
    return () => window.removeEventListener('scheduledTask:viewSession', handleViewSession);
  }, []);

  useEffect(() => {
    if (!isInitialized) return;

    let cancelled = false;
    let lastCheckTime = 0;

    const maybeCheck = async () => {
      if (cancelled) return;
      const now = Date.now();
      if (lastCheckTime > 0 && now - lastCheckTime < UPDATE_POLL_INTERVAL_MS) return;
      lastCheckTime = now;
      await runUpdateCheck();
    };

    // Check immediately on startup
    void maybeCheck();

    // Heartbeat: every 30 minutes, check if more than 12 hours since last check
    const timer = window.setInterval(() => {
      void maybeCheck();
    }, UPDATE_HEARTBEAT_INTERVAL_MS);

    // Check when window becomes visible again (covers sleep/wake scenarios)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void maybeCheck();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isInitialized, runUpdateCheck]);

  // Choose which permission component to use based on the scenario
  const permissionModal = useMemo(() => {
    if (!pendingPermission) return null;

    // Check if it's AskUserQuestion with multiple questions -> use wizard component
    const isQuestionTool = pendingPermission.toolName === 'AskUserQuestion';
    if (isQuestionTool && pendingPermission.toolInput) {
      const rawQuestions = (pendingPermission.toolInput as Record<string, unknown>).questions;
      const hasMultipleQuestions = Array.isArray(rawQuestions) && rawQuestions.length > 1;

      if (hasMultipleQuestions) {
        return (
          <CoworkQuestionWizard
            permission={pendingPermission}
            onRespond={handlePermissionResponse}
          />
        );
      }
    }

    // For other cases, use the original permission modal
    return (
      <CoworkPermissionModal
        permission={pendingPermission}
        onRespond={handlePermissionResponse}
      />
    );
  }, [pendingPermission, handlePermissionResponse]);

  const isOverlayActive = showSettings || showUpdateModal || pendingPermissions.length > 0;
  const updateBadge = updateInfo ? (
    <AppUpdateBadge
      latestVersion={updateInfo.latestVersion}
      onClick={handleOpenUpdateModal}
    />
  ) : null;
  const windowsStandaloneTitleBar = isWindows ? (
    <div className="draggable relative h-9 shrink-0 dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted">
      <WindowTitleBar isOverlayActive={isOverlayActive} />
    </div>
  ) : null;

  if (!isInitialized) {
    return (
      <div className="h-screen overflow-hidden flex flex-col">
        {windowsStandaloneTitleBar}
        <div className="flex-1 flex items-center justify-center dark:bg-claude-darkBg bg-claude-bg">
          <div className="flex flex-col items-center space-y-4">
            <div className="w-16 h-16 rounded-full bg-gradient-to-br from-claude-accent to-claude-accentHover flex items-center justify-center shadow-glow-accent animate-pulse">
              <ChatBubbleLeftRightIcon className="h-8 w-8 text-white" />
            </div>
            <div className="w-24 h-1 rounded-full bg-claude-accent/20 overflow-hidden">
              <div className="h-full w-1/2 rounded-full bg-claude-accent animate-shimmer" />
            </div>
            <div className="dark:text-claude-darkText text-claude-text text-xl font-medium">{i18nService.t('loading')}</div>
          </div>
        </div>
      </div>
    );
  }

  if (initError) {
    return (
      <div className="h-screen overflow-hidden flex flex-col">
        {windowsStandaloneTitleBar}
        <div className="flex-1 flex flex-col items-center justify-center dark:bg-claude-darkBg bg-claude-bg">
          <div className="flex flex-col items-center space-y-6 max-w-md px-6">
            <div className="w-16 h-16 rounded-full bg-red-500 flex items-center justify-center shadow-lg">
              <ChatBubbleLeftRightIcon className="h-8 w-8 text-white" />
            </div>
            <div className="dark:text-claude-darkText text-claude-text text-xl font-medium text-center">{initError}</div>
            <button
              onClick={() => handleShowSettings()}
              className="px-6 py-2.5 bg-claude-accent hover:bg-claude-accentHover text-white rounded-xl shadow-md transition-colors text-sm font-medium"
            >
              {i18nService.t('openSettings')}
            </button>
          </div>
          {showSettings && (
            <Settings
              onClose={handleCloseSettings}
              initialTab={settingsOptions.initialTab}
              notice={settingsOptions.notice}
              onUpdateFound={handleUpdateFound}
            />
          )}
        </div>
      </div>
    );
  }

  const handleShowHome = () => setMainView('home');
  const handleShowWallet = () => setMainView('wallet');
  const handleShowInvite = () => setMainView('invite');
  // v6.x: 菜单拆分 ——「一键涨粉」(新建页)= 'scenarioCreate';「我的涨粉任务」(管理页)= 'quickuse'。
  // 「一键涨粉」create 页(可带平台,落到对应平台的新建 tab)。
  const handleShowScenarioCreate = (platform?: 'xhs' | 'x' | 'binance' | 'youtube' | 'tiktok' | 'douyin' | 'kuaishou' | 'bilibili' | 'shipinhao' | 'toutiao' | 'instagram' | 'facebook' | 'reddit' | 'video') => {
    setQuickUseInitialPlatform(platform);
    setMainView('scenarioCreate');
    setScenarioNavNonce((n) => n + 1);
  };
  // 带平台调用(首页快捷入口「立即在 X 平台涨粉」)→ 直接进新建页;无参(侧栏
  // 「我的涨粉任务」)→ 管理页。
  const handleShowQuickUse = (platform?: 'xhs' | 'x' | 'binance' | 'youtube' | 'tiktok' | 'douyin' | 'kuaishou' | 'bilibili') => {
    if (platform) { handleShowScenarioCreate(platform); return; }
    setQuickUseInitialPlatform(undefined);
    setMainView('quickuse');
    setScenarioNavNonce((n) => n + 1);
  };
  // v6.x:「涨粉运行记录」独立菜单(原 manage 内的「运行记录」L1 段拆出来)。
  const handleShowScenarioRuns = () => {
    setQuickUseInitialPlatform(undefined);
    setMainView('scenarioRuns');
    setScenarioNavNonce((n) => n + 1);
  };
  const handleShowWeb3News = () => setMainView('web3news');
  const handleShowHotSearch = () => setMainView('hotsearch');
  const handleShowPartners = () => setMainView('partners');
  const handleShowPersonality = () => setMainView('personality');
  const handleShowMatrix = () => setMainView('matrix');
  // 侧栏点「新建/我的/记录」:复位到默认【多平台视频创作】tab(从某平台「已有任务」跳过去才带具体平台)。
  // bump navNonce 让 ScenarioView 按新 initialPlatform 复位 tab。
  const handleShowMatrixTaskNew = () => { setMatrixPlatform('video'); setMainView('matrixTaskNew'); setScenarioNavNonce((n) => n + 1); };
  const handleShowMatrixTasks = () => { setMatrixPlatform('video'); setMainView('matrixTasks'); setScenarioNavNonce((n) => n + 1); };
  const handleShowMatrixRuns = () => { setMatrixPlatform('video'); setMainView('matrixRuns'); setScenarioNavNonce((n) => n + 1); };

  return (
    <div className="relative h-screen overflow-hidden flex flex-col dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted">
      {showLoginWall && !authState.isAuthenticated && (
        <LoginWall
          onDismiss={() => setShowLoginWall(false)}
        />
      )}
      {showTokenDialog && (
        <TokenInsufficientDialog
          onConfirm={() => { setShowTokenDialog(false); openWallet('topup'); }}
          onSubscribe={() => { setShowTokenDialog(false); openWallet('subscription'); }}
          onCancel={() => setShowTokenDialog(false)}
        />
      )}
      {toastMessage && (
        <Toast message={toastMessage} onClose={() => setToastMessage(null)} />
      )}
      {/* v1.x: 全局合伙人佣金到账抽屉 — 任何 view 下都会触发,不依赖 mainView。
          监听 `noobclaw:rebate-received` DOM 事件;事件由 services/cowork.ts 的
          SSE handler 在 _noobclaw payload 含 rebate 字段时桥接派发。点击跳邀请页。
          v2.x: ErrorBoundary fallback={null} — 浮层组件出错不显示红色错误卡,
          安静失败,避免黑屏。具体报错仍打到 console 方便排查。 */}
      {/* 加密返佣到账抽屉 — 国内版隐藏(HIDE_WEB3) */}
      {!HIDE_WEB3 && (
      <ErrorBoundary name="RebateDrawer" fallback={null}>
        <RebateDrawer onShowInvite={handleShowInvite} />
      </ErrorBoundary>
      )}
      {/* 会员到期续费提醒弹窗(矩阵版):订阅过期且有号被暂停时弹一次,引导续费恢复。 */}
      <ErrorBoundary name="MembershipExpiryModal" fallback={null}>
        <MembershipExpiryModal />
      </ErrorBoundary>
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <Sidebar
          onShowLogin={handleShowLogin}
          onShowSettings={handleShowSettings}
          /* create/runs 菜单下钻到任务详情时,高亮临时归到「我的涨粉任务」(quickuse),
             保持「任务详情属于我的涨粉任务」的认知一致;从「所有 AI 对话」列表点进对话详情时,
             高亮仍归到「所有 AI 对话」(coworkHistory);其余情况按真实 mainView 高亮。 */
          activeView={
            scenarioInDetail && mainView === 'scenarioCreate'
              ? 'quickuse'
              : mainView === 'cowork' && coworkFromHistory
                ? 'coworkHistory'
                : mainView
          }
          onShowHome={handleShowHome}
          onShowSkills={handleShowSkills}
          onShowCowork={handleShowCowork}
          onShowCoworkHistory={handleShowCoworkHistory}
          onShowScheduledTasks={handleShowScheduledTasks}
          onShowMcp={handleShowMcp}
          onShowWallet={handleShowWallet}
          onShowInvite={handleShowInvite}
          onShowQuickUse={handleShowQuickUse}
          onShowScenarioRuns={handleShowScenarioRuns}
          onShowScenarioCreate={() => handleShowScenarioCreate()}
          onShowWeb3News={handleShowWeb3News}
          onShowHotSearch={handleShowHotSearch}
          onShowPersonality={handleShowPersonality}
          onShowPartners={handleShowPartners}
          onShowMatrix={handleShowMatrix}
          matrixExpiredCount={matrixExpiredTotal}
          onShowMatrixTaskNew={handleShowMatrixTaskNew}
          onShowMatrixTasks={handleShowMatrixTasks}
          onShowMatrixRuns={handleShowMatrixRuns}
          onNewChat={handleNewChat}
          isCollapsed={isSidebarCollapsed}
          onToggleCollapse={handleToggleSidebar}
          updateBadge={!isSidebarCollapsed ? updateBadge : null}
        />
        <div className={`flex-1 min-w-0 py-1.5 pr-1.5 ${isSidebarCollapsed ? 'pl-1.5' : ''}`}>
          <div className="h-full min-h-0 rounded-xl dark:bg-claude-darkBg bg-claude-bg overflow-hidden">
            {/* v1.x: 包整个 mainView 切换区。real partner real rebate 到账后切
                菜单导致黑屏的真实路径:新 view (InviteView / WalletView 等) 在
                render 时读到刚更新的 profile.partner / pendingRebates / usdtSummary
                数据,某行炸 → 整棵 React 树没保护就全 unmount → 用户看到 body
                暗色背景 (#09090E) = 黑屏。包一层 ErrorBoundary,出错时让用户至少
                看到"哪个 view 哪一行炸了"的红色卡片 + Reload 按钮,而不是死黑屏。 */}
            <ErrorBoundary name={`MainView:${mainView}`} key={mainView}>
            {mainView === 'home' ? (
              <HomeView
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={isSidebarCollapsed ? updateBadge : null}
                onShowMatrix={handleShowMatrix}
                onShowMatrixTaskNew={handleShowMatrixTaskNew}
                onShowMatrixTasks={handleShowMatrixTasks}
                onShowWallet={handleShowWallet}
                onShowInvite={handleShowInvite}
                matrixExpiredCount={matrixExpiredTotal}
              />
            ) : mainView === 'skills' ? (
              <SkillsView
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={isSidebarCollapsed ? updateBadge : null}
              />
            ) : mainView === 'scheduledTasks' ? (
              <ScheduledTasksView
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={isSidebarCollapsed ? updateBadge : null}
              />
            ) : mainView === 'mcp' ? (
              <Web3View
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={isSidebarCollapsed ? updateBadge : null}
              />
            ) : mainView === 'wallet' ? (
              <WalletView
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={isSidebarCollapsed ? updateBadge : null}
                onShowInvite={handleShowInvite}
              />
            ) : mainView === 'invite' ? (
              <InviteView
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={isSidebarCollapsed ? updateBadge : null}
              />
            ) : mainView === 'scenarioCreate' ? (
              <ScenarioView
                mode="create"
                /* 「已有任务」→ 切到「我的涨粉任务」管理页(mainView='quickuse'),并把初选平台
                   带过去(视频卡片传 'video' → 管理页直接定位到视频 tab)。这样侧栏高亮、
                   顶栏标题、内容三者都切到「我的涨粉任务」,而不是停在「新建涨粉任务」。 */
                onSwitchToManage={(platform) => { setQuickUseInitialPlatform(platform); setMainView('quickuse'); }}
                onInDetailChange={setScenarioInDetail}
                navNonce={scenarioNavNonce}
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={isSidebarCollapsed ? updateBadge : null}
                initialPlatform={quickUseInitialPlatform}
                onShowInvite={handleShowInvite}
              />
            ) : mainView === 'quickuse' ? (
              <ScenarioView
                mode="manage"
                onSwitchToCreate={handleShowScenarioCreate}
                onInDetailChange={setScenarioInDetail}
                navNonce={scenarioNavNonce}
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={isSidebarCollapsed ? updateBadge : null}
                initialPlatform={quickUseInitialPlatform}
                onShowInvite={handleShowInvite}
              />
            ) : mainView === 'scenarioRuns' ? (
              <ScenarioView
                mode="runs"
                onSwitchToCreate={handleShowScenarioCreate}
                onInDetailChange={setScenarioInDetail}
                navNonce={scenarioNavNonce}
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={isSidebarCollapsed ? updateBadge : null}
                initialPlatform={quickUseInitialPlatform}
                onShowInvite={handleShowInvite}
              />
            ) : mainView === 'partners' ? (
              <PartnersView
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={isSidebarCollapsed ? updateBadge : null}
                onShowInvite={handleShowInvite}
                onShowXhs={() => handleShowScenarioCreate('xhs')}
                onShowPersonality={handleShowPersonality}
              />
            ) : mainView === 'personality' ? (
              <PersonalityView
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={isSidebarCollapsed ? updateBadge : null}
              />
            ) : mainView === 'web3news' ? (
              <Web3NewsPage
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={isSidebarCollapsed ? updateBadge : null}
              />
            ) : mainView === 'hotsearch' ? (
              <GlobalHotSearchPage
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={isSidebarCollapsed ? updateBadge : null}
              />
            ) : (mainView === 'matrix') ? (
              // 「我的矩阵账号」= 账号管理(增删/登录/配赛道关键词人设),仍走 MatrixView。
              <MatrixView
                screen={'accounts'}
                initialPlatform={matrixInitialPlatform}
                onPlatformChange={setMatrixPlatform}
                onNavigate={(s: string) => setMainView(s === 'newTask' ? 'matrixTaskNew' : s === 'tasks' ? 'matrixTasks' : s === 'runs' ? 'matrixRuns' : 'matrix')}
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onShowInvite={handleShowInvite}
              />
            ) : (mainView === 'matrixTaskNew' || mainView === 'matrixTasks' || mainView === 'matrixRuns') ? (
              // 矩阵「新建 / 我的涨粉任务 / 运行记录」全用真 ScenarioView(matrixMode:engage 平台 tab +
              // 完整头部链 + 各平台互动涨粉卡片→账号向导)。数据经 scenarioService 的 MATRIX 适配层。
              <ScenarioView
                matrixMode
                mode={mainView === 'matrixRuns' ? 'runs' : mainView === 'matrixTaskNew' ? 'create' : 'manage'}
                initialPlatform={matrixPlatform as any}
                onSwitchToCreate={(platform) => { if (platform) setMatrixPlatform(platform); setMainView('matrixTaskNew'); setScenarioNavNonce((n) => n + 1); }}
                onSwitchToManage={(platform) => { if (platform) setMatrixPlatform(platform); setMainView('matrixTasks'); setScenarioNavNonce((n) => n + 1); }}
                onInDetailChange={setScenarioInDetail}
                navNonce={scenarioNavNonce}
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={isSidebarCollapsed ? updateBadge : null}
                onShowInvite={handleShowInvite}
              />
            ) : mainView === 'coworkHistory' ? (
              <CoworkHistoryPage onOpenSession={() => { setCoworkFromHistory(true); setMainView('cowork'); }} />
            ) : (
              <CoworkView
                onRequestAppSettings={handleShowSettings}
                onShowSkills={handleShowSkills}
                onShowWallet={handleShowWallet}
                onShowQuickUse={handleShowQuickUse}
                onShowInvite={handleShowInvite}
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={isSidebarCollapsed ? updateBadge : null}
                onBackToHistory={coworkFromHistory ? handleShowCoworkHistory : undefined}
              />
            )}
            </ErrorBoundary>
          </div>
        </div>
      </div>

      {/* Settings window displays above all main content without affecting main UI interaction */}
      {showSettings && (
        <Settings
          onClose={handleCloseSettings}
          initialTab={settingsOptions.initialTab}
          notice={settingsOptions.notice}
          onUpdateFound={handleUpdateFound}
        />
      )}
      {showUpdateModal && updateInfo && (
        <AppUpdateModal
          updateInfo={updateInfo}
          onCancel={() => {
            if (updateModalState === 'info' || updateModalState === 'error') {
              setShowUpdateModal(false);
              setUpdateModalState('info');
              setUpdateError(null);
              setDownloadProgress(null);
            }
          }}
          onConfirm={handleConfirmUpdate}
          modalState={updateModalState}
          downloadProgress={downloadProgress}
          errorMessage={updateError}
          onCancelDownload={handleCancelDownload}
          onRetry={handleRetryUpdate}
        />
      )}
      {permissionModal}
      {/* v5.x+: global notification center — handles critical full-screen
          modal (USDT 返佣 ≥ $50), important bottom-right banner ($5-50)
          + OS push, all from /api/me/notifications/unread. Renders only
          when authenticated.
          v2.x: 用 ErrorBoundary 包住,出错不再让整棵 React 树 unmount → 黑屏。 */}
      <ErrorBoundary name="NotificationCenter" fallback={null}>
        <NotificationCenter />
      </ErrorBoundary>
    </div>
  );
};

export default App;
