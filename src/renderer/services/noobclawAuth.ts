// NoobClaw Auth Service - Wallet-based authentication
import { getBackendApiUrl, getWebsiteUrl } from './endpoints';

export interface AuthState {
  isAuthenticated: boolean;
  walletAddress: string | null;
  tokenBalance: number;       // 可消费总额(增量包永久桶 + 有效订阅桶)
  paidBalance: number;        // 增量包(永久桶)余额
  planCode: string;           // 当前会员档位 free/basic/pro/max
  planName: string;           // 档位中文名
  subActive: boolean;         // 订阅是否有效
  subUsedRatio: number;       // 订阅桶用量比例 0~1
  authToken: string | null;
  avatarUrl: string | null;
  // Web3Auth social login provenance (null when user signed in with their own wallet)
  socialEmail: string | null;
  socialProvider: string | null; // 'google' | 'twitter' | 'discord'
}

class NoobClawAuthService {
  private state: AuthState = {
    isAuthenticated: false,
    walletAddress: null,
    tokenBalance: 0,
    paidBalance: 0,
    planCode: 'free',
    planName: '免费版',
    subActive: false,
    subUsedRatio: 0,
    authToken: null,
    avatarUrl: null,
    socialEmail: null,
    socialProvider: null,
  };

  private listeners: Array<(state: AuthState) => void> = [];
  // v1.x: 全局 15s 轮询 /api/ai/balance — 之前这个 interval 只挂在 WalletView 内部,
  // 用户停在 InviteView / CoworkView 等其它页面时不轮询 → 新到账的 BUSDT 返佣
  // pendingRebates 永远没人拉,RebateDrawer 永远不弹(用户反馈"明明有佣金但抽
  // 屉没弹")。提到 service 全局后,只要 authToken 存在就持续 poll,跨 view 不丢。
  // logout / 401 失效时停止。15s 跟原 WalletView interval 保持一致。
  private _balancePollTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly BALANCE_POLL_MS = 15_000;

  // v1.x: RebateDrawer 握手机制 —— singleton 在 import 时 new,可能比 React
  // 渲染早。drawerReady=false 时收到的 pendingRebates 先 push 进 queue,等
  // RebateDrawer mount 时通过 'noobclaw:rebate-drawer-ready' 事件 flush。
  private _drawerReady = false;
  private _pendingDrawerQueue: Array<{ amount: string; fromWallet?: string; level?: number }> = [];

  // Dynamically read, supports local/production environment switching
  private get backendUrl() { return getBackendApiUrl(); }

  constructor() {
    // 监听 RebateDrawer mount 完成信号,flush 任何 ready 之前积压的 pending。
    // typeof window check:服务端 import / unit test 没 window 时不挂 listener。
    if (typeof window !== 'undefined') {
      window.addEventListener('noobclaw:rebate-drawer-ready', () => {
        if (this._drawerReady) return;  // 幂等,防 RebateDrawer 多次 remount 重复 flush
        this._drawerReady = true;
        const queue = this._pendingDrawerQueue;
        this._pendingDrawerQueue = [];
        if (queue.length > 0) this.dispatchRebatesNow(queue);
      });
    }
    // Restore from localStorage if available
    const savedToken = localStorage.getItem('noobclaw_auth_token');
    const savedWallet = localStorage.getItem('noobclaw_wallet_address');
    const savedAvatar = localStorage.getItem('noobclaw_avatar_url');
    if (savedToken && savedWallet) {
      this.state.authToken = savedToken;
      this.state.walletAddress = savedWallet;
      this.state.isAuthenticated = true;
      this.state.avatarUrl = savedAvatar || null;
      this.state.socialEmail = localStorage.getItem('noobclaw_social_email') || null;
      this.state.socialProvider = localStorage.getItem('noobclaw_social_provider') || null;
      // Sync token to main process and refresh balance in background
      // Use setTimeout to ensure window.electron is available
      setTimeout(() => {
        this.syncTokenToMain(savedToken);
        this.reportDeviceInfo(savedToken);
        // Load cached avatar from local disk first (instant, no network)
        this.loadCachedAvatar();
      }, 0);
      this.refreshBalance().catch(console.error);
      this.refreshAvatar().catch(console.error);
      this.startBalancePolling();
    }
  }

  // 启动全局 balance 轮询。重复调用幂等(已经在跑的不会被重复启动)。
  // refreshBalance 内部会把 pendingRebates 派 DOM 事件给 RebateDrawer,
  // 所以这个 interval 是"佣金到账通知"机制的核心心跳。
  // v1.x perf:document.hidden = true 时跳过 fetch(窗口最小化 / 切到后台),
  //   不增加无效请求。从 hidden 切回 visible 时立即补一次(visibilitychange
  //   listener),所以用户切回来不用等下一个 15s tick 才看到最新余额/佣金。
  private startBalancePolling() {
    if (this._balancePollTimer) return;
    this._balancePollTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      // 静默 catch:这是后台定时器,失败不应该污染 console.error(单次失败的话
      // 下一轮 15s 再试;真彻底挂了 401 路径会走 handleAuthExpired 清登录态)。
      this.refreshBalance().catch(() => {});
    }, NoobClawAuthService.BALANCE_POLL_MS);
    // visibilitychange:用户切回来立刻 refresh 一次,不等下一个 tick。
    // 仅在第一次 startBalancePolling 时挂(整个 service 生命周期一份)。
    if (typeof document !== 'undefined' && !this._visibilityListenerAttached) {
      this._visibilityListenerAttached = true;
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && this.state.isAuthenticated) {
          this.refreshBalance().catch(() => {});
        }
      });
    }
  }
  private _visibilityListenerAttached = false;

  private stopBalancePolling() {
    if (this._balancePollTimer) {
      clearInterval(this._balancePollTimer);
      this._balancePollTimer = null;
    }
    // 不解绑 visibilitychange — listener 内部已经判断 isAuthenticated,
    // 退登期间触发只是一次 no-op,下次登录直接复用,免去重复 addEventListener
    // 引起的累积监听器。
  }

  // Load avatar from local disk cache (instant, no flicker)
  private async loadCachedAvatar() {
    try {
      const localPath = await window.electron?.noobclaw?.getCachedAvatar();
      if (localPath) {
        this.state.avatarUrl = localPath;
        this.notify();
      }
    } catch { /* ignore */ }
  }

  // Cache avatar image to local disk via main process
  private async cacheAvatarToDisk(url: string) {
    try {
      const result = await window.electron?.noobclaw?.cacheAvatar(url);
      if (result?.success && result.localPath) {
        // Update to local path for instant loading next time
        localStorage.setItem('noobclaw_cached_avatar_local', result.localPath);
      }
    } catch { /* ignore */ }
  }

  getState(): AuthState {
    return { ...this.state };
  }

  subscribe(listener: (state: AuthState) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private notify() {
    this.listeners.forEach(l => l(this.getState()));
  }

  private syncTokenToMain(token: string | null) {
    window.electron?.noobclaw?.setAuthToken(token).catch(() => {});
  }

  // Called from website after wallet connect (or social login via web3auth).
  // socialEmail/socialProvider are passed through the noobclaw:// deep link
  // when the user signed in via Google/X/Discord; pass empty string for plain
  // wallet logins so we know to clear stale social state.
  setAuthFromWebsite(token: string, walletAddress: string, socialEmail = '', socialProvider = '') {
    this.state.authToken = token;
    this.state.walletAddress = walletAddress;
    this.state.isAuthenticated = true;
    this.state.socialEmail = socialEmail || null;
    this.state.socialProvider = socialProvider || null;
    localStorage.setItem('noobclaw_auth_token', token);
    localStorage.setItem('noobclaw_wallet_address', walletAddress);
    if (socialEmail) localStorage.setItem('noobclaw_social_email', socialEmail);
    else localStorage.removeItem('noobclaw_social_email');
    if (socialProvider) localStorage.setItem('noobclaw_social_provider', socialProvider);
    else localStorage.removeItem('noobclaw_social_provider');
    this.syncTokenToMain(token);
    this.refreshBalance();
    this.refreshAvatar();
    this.reportDeviceInfo(token);
    this.startBalancePolling();  // 登录后启动全局心跳,跨 view 拉 pendingRebates
    this.notify();
  }

  // Report device MAC address to backend
  private async reportDeviceInfo(token: string) {
    try {
      const mac = await window.electron?.noobclaw?.getMacAddress();
      if (!mac) return;
      await fetch(`${this.backendUrl}/api/auth/device-info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ macAddress: mac }),
      });
    } catch { /* ignore */ }
  }

  /**
   * Client-side pre-flight check before kicking off any task that will burn
   * credits (创建涨粉任务 / 直接运行任务). If balance is below `threshold`,
   * fires the same 'noobclaw:token-insufficient' event used by /api/ai 402
   * responses so App-level TokenInsufficientDialog renders — caller should
   * `return` when this returns false.
   *
   * Default threshold 10000: one 涨粉 round burns roughly 1.5-4.5K tokens
   * (action charges + AI 写评论的 token),10000 ≈ 2-3 轮 buffer 让用户至少
   * 跑完手头这个任务再充。
   *
   * Returns true when balance is sufficient OR user is unauthenticated
   * (login UI 会先拦在前面,这里不重复弹窗)。
   */
  hasEnoughBalanceForTask(threshold = 10000): boolean {
    if (!this.state.isAuthenticated) return true;
    if (this.state.tokenBalance >= threshold) return true;
    window.dispatchEvent(new CustomEvent('noobclaw:token-insufficient', {
      detail: { balance: this.state.tokenBalance, threshold },
    }));
    return false;
  }

  async refreshBalance(): Promise<number> {
    if (!this.state.authToken) return 0;
    try {
      const res = await fetch(`${this.backendUrl}/api/ai/balance`, {
        headers: { Authorization: `Bearer ${this.state.authToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        this.state.tokenBalance = data.tokenBalance;
        // 双桶 + 会员档位明细(顶部条 tag / 订阅进度条 / 增量包数 用)。后端老版本不返这些时兜底。
        if (typeof data.paidBalance === 'number') this.state.paidBalance = data.paidBalance;
        if (typeof data.planCode === 'string') this.state.planCode = data.planCode;
        if (typeof data.planName === 'string') this.state.planName = data.planName;
        if (typeof data.subActive === 'boolean') this.state.subActive = data.subActive;
        if (typeof data.subUsedRatio === 'number') this.state.subUsedRatio = data.subUsedRatio;
        this.notify();
        // v1.x: 后端在 /api/ai/balance 顺道返回"已上链已结算但还没通知客户端"
        // 的 BUSDT 返佣列表(并原子标记 notified_at)。客户端每 15s 调一次本接口,
        // 所以新到账的返佣最多延迟 15s 弹 RebateDrawer 抽屉。
        // 多笔时错开 4.6s 触发,让 RebateDrawer 的"新事件接管旧事件"逻辑给
        // 每一笔一个完整的 4s 展示窗口。
        const pending = (data as any).pendingRebates as Array<{ id: string; amount: string; fromWallet: string | null; level: number | null }> | undefined;
        if (Array.isArray(pending) && pending.length > 0) {
          // v1.x 关键 bugfix: 这个 service 是 module-level singleton(line 153
          // `export const noobClawAuth = new NoobClawAuthService()`),import 时
          // 立即 new + constructor 直接调 this.refreshBalance() → 后端 atomic
          // UPDATE 不可逆地把 notified_at = NOW(),返 pendingRebates。但此时
          // React 还没渲染,RebateDrawer 还没 mount,listener 还没注册,
          // setTimeout(..., 0) 派的事件落入虚空。等 React mount 完,notified_at
          // 已经被标已通知,下次 polling 永远拿不到 → 抽屉永远不弹。
          // 这就是"我明明有返佣收不到推送"的根因。LuckyBag 没事是因为它在
          // AI task 跑起来之后才 fire,listener 早就 ready 了。
          //
          // 修法:不用 magic number 延迟,而是跟 RebateDrawer 握手 ——
          //   RebateDrawer mount 时 dispatch 'noobclaw:rebate-drawer-ready',
          //   本 service 监听这个信号,标 _drawerReady = true。
          //   - ready: 立即 dispatch
          //   - 未 ready: 把事件 push 进 _pendingDrawerQueue,等到 ready 信号
          //     一次性 flush。
          // 多笔间保持 4.6s 错峰(让"新事件接管"逻辑给每笔完整 4s 展示)。
          this.enqueueOrDispatchRebates(pending);
        }
        return data.tokenBalance;
      }
      if (res.status === 401) {
        this.handleAuthExpired();
      }
    } catch (err) {
      console.error('Failed to refresh balance:', err);
      return this.state.tokenBalance;
    }
    return this.state.tokenBalance;
  }

  /**
   * 决定是立即 dispatch 还是排队等 RebateDrawer ready 信号。
   * - drawerReady=true: 直接走 dispatchRebatesNow,4.6s 错峰
   * - drawerReady=false: push 进 _pendingDrawerQueue,等 ready 事件 flush
   */
  private enqueueOrDispatchRebates(
    pending: Array<{ id: string; amount: string; fromWallet: string | null; level: number | null }>,
  ): void {
    const items = pending
      .filter(item => item && item.amount !== undefined && item.amount !== null)
      .map(item => ({
        amount: item.amount,
        fromWallet: item.fromWallet ?? undefined,
        level: item.level ?? undefined,
      }));
    if (items.length === 0) return;
    if (this._drawerReady) {
      this.dispatchRebatesNow(items);
    } else {
      this._pendingDrawerQueue.push(...items);
    }
  }

  /**
   * 立即派发(假设 listener 已 ready)。多笔错峰 4.6s,让"新事件接管"逻辑给每
   * 一笔完整 4s 展示窗口 + 600ms 切换间隙。
   */
  private dispatchRebatesNow(
    items: Array<{ amount: string; fromWallet?: string; level?: number }>,
  ): void {
    items.forEach((item, idx) => {
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('noobclaw:rebate-received', { detail: item }));
      }, idx * (4000 + 600));
    });
  }

  async refreshAvatar(): Promise<void> {
    if (!this.state.authToken) return;
    try {
      const res = await fetch(`${this.backendUrl}/api/user/profile`, {
        headers: { Authorization: `Bearer ${this.state.authToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        if (data.avatar_url) {
          this.state.avatarUrl = data.avatar_url;
          localStorage.setItem('noobclaw_avatar_url', data.avatar_url);
          this.notify();
          // Cache to local disk in background for instant loading next time
          this.cacheAvatarToDisk(data.avatar_url);
        }
        return;
      }
      if (res.status === 401) {
        this.handleAuthExpired();
      }
    } catch { /* ignore */ }
  }

  // Central 401 handler — invoked whenever any authenticated request comes
  // back as 401. Only acts if the user was previously logged in (so we don't
  // pop the login modal at boot for never-logged-in users whose unauthed
  // requests get rejected). Clears local state, then fires the
  // `noobclaw:need-login` event that App.tsx listens for to show LoginWall.
  handleAuthExpired() {
    if (!this.state.isAuthenticated) return;
    this.logout();
    try {
      window.dispatchEvent(new CustomEvent('noobclaw:need-login', { detail: { reason: 'expired' } }));
    } catch { /* SSR / non-window contexts — never hits in renderer */ }
  }

  setAvatarUrl(url: string) {
    this.state.avatarUrl = url;
    localStorage.setItem('noobclaw_avatar_url', url);
    this.notify();
  }

  getAuthHeaders(): Record<string, string> {
    if (!this.state.authToken) return {};
    return {
      Authorization: `Bearer ${this.state.authToken}`,
      'x-wallet-address': this.state.walletAddress || '',
    };
  }

  logout() {
    this.state = {
      isAuthenticated: false,
      walletAddress: null,
      tokenBalance: 0,
      paidBalance: 0,
      planCode: 'free',
      planName: '免费版',
      subActive: false,
      subUsedRatio: 0,
      authToken: null,
      avatarUrl: null,
      socialEmail: null,
      socialProvider: null,
    };
    localStorage.removeItem('noobclaw_auth_token');
    localStorage.removeItem('noobclaw_wallet_address');
    localStorage.removeItem('noobclaw_avatar_url');
    localStorage.removeItem('noobclaw_social_email');
    localStorage.removeItem('noobclaw_social_provider');
    this.syncTokenToMain(null);
    this.stopBalancePolling();  // 退登后停掉全局心跳,避免对 401 旧 token 持续打/balance
    this.notify();
  }

  openWebsiteLogin() {
    // Dynamically read: points to localhost:3001 for local testing, noobclaw.com for production
    const websiteUrl = getWebsiteUrl() + '?action=connect&from=app';
    // Open in default browser via electron
    if (typeof window !== 'undefined' && (window as any).electron) {
      (window as any).electron.shell.openExternal(websiteUrl);
    } else {
      window.open(websiteUrl, '_blank');
    }
  }

  /**
   * Show the in-app LoginWall modal first instead of jumping straight to the
   * external website. App.tsx mounts LoginWall globally and listens for the
   * `noobclaw:need-login` event — dispatching it here makes the modal pop up
   * with the "Connect Wallet" button (which itself calls openWebsiteLogin()
   * when the user clicks). This gives users a chance to read what's about to
   * happen before being thrown into the browser.
   *
   * Use this from buttons / page actions; reserve openWebsiteLogin() for the
   * Connect button INSIDE LoginWall (otherwise you'd loop the modal).
   */
  requireLoginUI() {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('noobclaw:need-login'));
    }
  }
}

export const noobClawAuth = new NoobClawAuthService();
