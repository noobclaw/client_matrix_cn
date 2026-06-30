// NoobClaw Backend API Service
// Replaces direct AI provider calls with our proxied backend

import { noobClawAuth } from './noobclawAuth';
import { getBackendApiUrl } from './endpoints';

export interface TokenInfo {
  balance: number;
  totalUsed: number;
  walletAddress: string;
}

// v5.x+: notification row shape, shared between unread / list endpoints
// + rebate_received-specific metadata. severity drives UI: critical →
// full-screen modal, important → bottom-right banner + OS push, normal →
// top thin strip + red-dot badge in InviteView.
export interface NotificationRow {
  id: string;
  type: string;                  // 'rebate_received' | 'announcement' | ...
  severity: 'critical' | 'important' | 'normal';
  title_zh: string;
  title_en: string;
  body_zh: string;
  body_en: string;
  metadata?: {
    amount_usdt?: string;
    tx_hash?: string;
    batch_id?: string;
    recipient_wallet?: string;
    bscscan_url?: string;
    [k: string]: any;
  };
  read_at?: string | null;
  dismissed_at?: string | null;
  cta_clicked_at?: string | null;
  created_at: string;
  expires_at?: string | null;
}

// Per-chain block under PaymentInfo.chains. Backend emits these starting in
// v5.5 (TRON/USDT support). Older clients keep using the top-level fields
// (treasuryWallet/packages) so the response is forward+backward compatible.
export interface ChainBlock {
  treasuryWallet: string;
  bnbPriceUsd?: number;        // BSC only
  usdtContract?: string;       // TRON only
  enabled?: boolean;
  packages: Array<{
    bnb?: number;              // BSC packages
    usdt?: number;             // TRON packages
    label: string;
    usdValue: string;
    tokens: number;
    tokensDisplay: string;
  }>;
}

export interface PaymentInfo {
  treasuryWallet: string;
  bnbPriceUsd: number;
  chain: string;
  packages: Array<{
    bnb: number;
    label: string;
    usdValue: string;
    tokens: number;
    tokensDisplay: string;
  }>;
  noobPerDollar?: number;
  purchaseNoobPerDollarMin?: number;
  purchaseNoobPerDollarMax?: number;
  // Optional — present when backend has the multi-chain TRON channel enabled.
  // TRON is keyed only when tron_treasury_address is set in system_config; if
  // missing, the client falls back to BSC-only behavior.
  chains?: {
    BSC?: ChainBlock;
    TRON?: ChainBlock;
  };
}

// CNY 卡密充值 — 用户在咸鱼买卡密 → 客户端填入兑换积分。后端复用主站 USDT
// 套餐数组用 usdt_to_cny_rate 折算成 ¥档位,所以这里 rmb/tokens 都是算好的。
export interface RedeemPackage {
  usdt: number;
  rmb: number;
  tokens: number;
  tokensDisplay: string;
  label: string;
}

export interface RedeemPackagesResponse {
  packages: RedeemPackage[];
  xianyu_shop_url: string;
  cny_rate: number;
}

class NoobClawApiService {
  // Dynamically read, supports local/production environment switching
  private get backendUrl() {
    return getBackendApiUrl();
  }

  getBaseUrl(): string {
    return `${this.backendUrl}/api/ai`;
  }

  getAuthHeaders(): Record<string, string> {
    return noobClawAuth.getAuthHeaders();
  }

  // All authenticated requests funnel through here. On 401 we route the
  // response into noobClawAuth.handleAuthExpired() which clears local state +
  // dispatches `noobclaw:need-login` for App.tsx → LoginWall. The handler
  // self-gates on `isAuthenticated` so a 401 from a never-logged-in user
  // (which is the normal case for these endpoints) does NOT pop the modal.
  private async authedFetch(input: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(input, init);
    if (res.status === 401) noobClawAuth.handleAuthExpired();
    return res;
  }

  async getTokenBalance(): Promise<TokenInfo | null> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/ai/balance`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  }

  async getPaymentInfo(): Promise<PaymentInfo | null> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/payment/info`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  }

  /**
   * Create a pending top-up order.
   *
   * - createOrder(0.3)                       → BSC (legacy single-arg form)
   * - createOrder(10,  'TRON')               → TRON / USDT
   * - createOrder(0.3, 'BSC')                → BSC (explicit chain)
   *
   * Returns the inserted order row plus, for TRON, a `treasuryWallet` field
   * so the caller can render the receive address without a second /info hit.
   */
  async createOrder(
    amount: number,
    chain: 'BSC' | 'TRON' = 'BSC',
  ): Promise<{ order?: any; treasuryWallet?: string; error?: string; code?: string } | null> {
    try {
      const body = chain === 'TRON'
        ? { chain: 'TRON', usdtAmount: amount }
        : { chain: 'BSC',  bnbAmount: amount };
      const res = await this.authedFetch(`${this.backendUrl}/api/payment/create`, {
        method: 'POST',
        headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) return { error: data.message || data.error, code: data.code };
      return data;
    } catch {
      return null;
    }
  }

  // ─── 会员订阅 ───

  /** 拉套餐矩阵(含各周期折后价)+ 周期折扣 + 当前用户订阅/用量。会员中心用。 */
  async getPlanConfig(): Promise<{
    ok: boolean;
    plans: Array<{
      code: string; name_zh: string; name_en: string; sort_order: number;
      price_cny: number; price_usd: number; monthly_credits: number;
      max_accounts_per_platform: number; allowed_platforms: string;
      prices: Record<string, { usd: number; cny: number; months: number; discount: number }>;
    }>;
    periodDiscounts: Record<string, number>;
    current: {
      planCode: string; subActive: boolean; period: string | null;
      periodEnd: string | null; nextGrantAt: string | null;
      subUsedRatio: number; subExpireAt: string | null; paidBalance: number;
    };
  } | null> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/plan/config`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  }

  /**
   * 下订阅订单。金额由后端按套餐价(月价×月数×折扣)算,客户端只传档位+周期+链。
   * 复用充值同款 /api/payment/create + /status 轮询;返回结构同 createOrder。
   */
  async createSubscriptionOrder(
    planCode: string,
    period: 'month' | 'quarter' | 'half' | 'year',
    chain: 'BSC' | 'TRON' = 'TRON',
  ): Promise<{ order?: any; treasuryWallet?: string; error?: string; code?: string } | null> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/payment/create`, {
        method: 'POST',
        headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ chain, productType: 'subscription', planCode, period }),
      });
      const data = await res.json();
      if (!res.ok) return { error: data.message || data.error, code: data.code };
      return data;
    } catch {
      return null;
    }
  }

  // ─── CNY 卡密充值 ───
  // /packages 是 public(不需登录)— 充值页一进来就能拉档位 + 咸鱼地址。
  // /preview 和 /redeem 需要登录,走 authedFetch(401 自动弹登录)。

  async getRedeemPackages(): Promise<RedeemPackagesResponse | null> {
    try {
      const res = await fetch(`${this.backendUrl}/api/redeem/packages`);
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  }

  /** 预查询卡密面额 + 积分,不核销。前端弹 confirm 前用。 */
  async previewRedeemCode(code: string): Promise<{ ok?: boolean; face_value_rmb?: number; credits?: number; product_type?: string; plan_code?: string; plan_period?: string; plan_name?: string; error?: string; message?: string } | null> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/redeem/preview`, {
        method: 'POST',
        headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      return res.json();
    } catch {
      return null;
    }
  }

  /** 原子化核销卡密,成功后积分秒到账。 */
  async redeemCode(code: string): Promise<{ ok?: boolean; credits?: number; face_value_rmb?: number; balance_after?: number; product_type?: string; plan_code?: string; plan_period?: string; error?: string; message?: string } | null> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/redeem`, {
        method: 'POST',
        headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      return res.json();
    } catch {
      return null;
    }
  }

  async confirmOrder(orderNo: string, txHash: string): Promise<any> {
    const res = await this.authedFetch(`${this.backendUrl}/api/payment/confirm`, {
      method: 'POST',
      headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderNo, txHash }),
    });
    return res.json();
  }

  async pollOrderStatus(orderNo: string): Promise<{ order: any; tokenBalance?: number } | null> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/payment/status/${orderNo}`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  }

  async getOrderHistory(status?: string, orderNo?: string, from?: string, to?: string): Promise<{ orders: any[]; total: number }> {
    try {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (orderNo) params.set('orderNo', orderNo);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const qs = params.toString();
      const url = `${this.backendUrl}/api/payment/history${qs ? `?${qs}` : ''}`;
      const res = await fetch(url, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return { orders: [], total: 0 };
      const data = await res.json();
      return { orders: data.orders || [], total: data.total || 0 };
    } catch {
      return { orders: [], total: 0 };
    }
  }

  async cancelOrder(orderNo: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/payment/cancel`, {
        method: 'POST',
        headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderNo }),
      });
      const data = await res.json();
      if (!res.ok) return { success: false, error: data.error };
      return { success: true };
    } catch {
      return { success: false, error: 'Network error' };
    }
  }

  async getUserProfile(): Promise<any | null> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/user/profile`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  }

  async getInviteList(page = 1, pageSize = 20): Promise<{ list: Array<{ wallet: string; createdAt: string; level?: number }>; total: number }> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/user/referral/list?page=${page}&pageSize=${pageSize}`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return { list: [], total: 0 };
      return res.json();
    } catch {
      return { list: [], total: 0 };
    }
  }

  /**
   * v2.x: backend now returns ALL noob_earnings reasons when `reason=all` is
   * passed (referral_bonus / purchase_bonus / lucky_bag). Default behavior of
   * this method changed from "only referral_bonus" to "all" so the InviteView
   * 邀请奖励 tab shows the full picture per user feedback:
   *   "除了展示邀请奖励,还要展示充值奖励".
   * Pass an explicit reason to keep the old filtered shape.
   */
  async getReferralRewards(page = 1, pageSize = 20, reason: 'all' | 'referral_bonus' | 'purchase_bonus' | 'lucky_bag' = 'all'): Promise<{ list: Array<{ noobAmount: number; reason: string; status: string; createdAt: string; contributorWallet?: string; level?: number }>; total: number; totalEarned: number }> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/user/referral/rewards?page=${page}&pageSize=${pageSize}&reason=${reason}`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return { list: [], total: 0, totalEarned: 0 };
      return res.json();
    } catch {
      return { list: [], total: 0, totalEarned: 0 };
    }
  }

  async getAirdropRecords(): Promise<{ airdrops: any[] }> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/user/airdrops`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return { airdrops: [] };
      return res.json();
    } catch {
      return { airdrops: [] };
    }
  }

  async getReferralTicker(): Promise<{ items: Array<{ wallet: string; amount: number }>; day: string }> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/user/referral/ticker`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return { items: [], day: '' };
      return res.json();
    } catch { return { items: [], day: '' }; }
  }

  // ─── v5.x+: USDT real-cash rebate endpoints ───
  // Backend route prefix: /api/me/* (see backend/src/routes/rebate.ts).
  // All four require auth headers — they're scoped to req.walletAddress.

  async getUsdtRebateSummary(): Promise<{
    total_earned: string; total_sent: string; total_inflight: string; total_pending: string;
    // v6.x: backend also returns CNY-side fields for the cn-site flow;
    // client now reads them too to render a 「¥CNY 总返佣」 stat card
    // next to the existing USDT one. All optional — old backend without
    // CNY would just return undefined and the card renders ¥0.00.
    cny_total_earned?: string;
    cny_total_sent?: string;
    cny_total_inflight?: string;
    cny_total_pending?: string;
  } | null> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/me/rebate/summary`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return null;
      return res.json();
    } catch { return null; }
  }

  async getUsdtRebateBreakdown(): Promise<{ levels: Array<{ level: number; amount: string; contributor_count: number }> }> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/me/rebate/breakdown`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return { levels: [] };
      return res.json();
    } catch { return { levels: [] }; }
  }

  async getUsdtRebateHistory(limit = 50): Promise<{ items: Array<{ id: string; amount_usdt: string; tx_hash: string; bscscan_url: string; created_at: string }> }> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/me/rebate/history?limit=${limit}`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return { items: [] };
      return res.json();
    } catch { return { items: [] }; }
  }

  // v5.x+: unified per-row commission ledger with FIFO-derived payout status.
  // Each rebate_earnings row is annotated 'sent' or 'pending'. 'sent' rows
  // carry the tx_hash + paid_at of the rebate_sends row that covers them
  // (approximate FIFO match — batched payouts mean N earnings → 1 send).
  //
  // Pagination: page 1-indexed, pageSize capped at 100 server-side. Rows
  // are sorted by earned_at DESC (newest first). FIFO matching runs over
  // the full ordered set before pagination, so a row's status is stable
  // across pages — page 2 won't suddenly flip pending → sent.
  // v5.x+: one-shot endpoint returning summary + breakdown + paginated
  // earnings in a single HTTPS roundtrip. Replaces 3 parallel calls and
  // cuts the InviteView "USDT 返佣" tab load latency from ~3 roundtrips
  // (each with its own auth-middleware DB hit) down to 1. Backend does
  // the same DB work in less time since rebate_earnings + rebate_sends
  // are pulled exactly once, then summary/breakdown/page slice are all
  // derived in memory from the same arrays.
  async getUsdtRebateDashboard(page = 1, pageSize = 20): Promise<{
    summary: { total_earned: string; total_sent: string; total_inflight: string; total_pending: string };
    breakdown: { levels: Array<{ level: number; amount: string; contributor_count: number }> };
    earnings: {
      page: number;
      pageSize: number;
      total: number;
      totalPages: number;
      total_earned: string;
      total_sent: string;
      total_pending: string;
      items: Array<{
        id: string; level: number | null; contributor_wallet: string | null;
        amount_usdt: string; reason: string; source_asset: string; order_id: string | null;
        earned_at: string; status: 'sent' | 'pending';
        tx_hash: string | null; bscscan_url: string | null; paid_at: string | null;
      }>;
    };
  } | null> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/me/rebate/dashboard?page=${page}&pageSize=${pageSize}`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return null;
      return res.json();
    } catch { return null; }
  }

  async getUsdtRebateEarnings(page = 1, pageSize = 20): Promise<{
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    total_earned: string;
    total_sent: string;
    total_pending: string;
    items: Array<{
      id: string;
      level: number | null;
      contributor_wallet: string | null;
      amount_usdt: string;
      reason: string;
      source_asset: string;
      order_id: string | null;
      earned_at: string;
      status: 'sent' | 'pending';
      tx_hash: string | null;
      bscscan_url: string | null;
      paid_at: string | null;
    }>;
  }> {
    const empty = { page, pageSize, total: 0, totalPages: 1, total_earned: '0', total_sent: '0', total_pending: '0', items: [] };
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/me/rebate/earnings?page=${page}&pageSize=${pageSize}`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return empty;
      return res.json();
    } catch { return empty; }
  }

  // ─── CNY 返佣明细(走同一 earnings 接口的 ?currency=CNY 分支)───
  // 后端按 cny_amount 出行,字段名为 amount_cny;CNY 返佣是手动提现,无 tx_hash。
  async getCnyRebateEarnings(page = 1, pageSize = 20): Promise<{
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    total_earned: string;
    total_sent: string;
    total_pending: string;
    items: Array<{
      id: string;
      level: number | null;
      contributor_wallet: string | null;
      amount_cny: string;
      reason: string;
      source_asset: string;
      order_id: string | null;
      earned_at: string;
      status: 'sent' | 'pending';
    }>;
  }> {
    const empty = { page, pageSize, total: 0, totalPages: 1, total_earned: '0', total_sent: '0', total_pending: '0', items: [] };
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/me/rebate/earnings?currency=CNY&page=${page}&pageSize=${pageSize}`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return empty;
      return res.json();
    } catch { return empty; }
  }

  // ─── CNY 提现(后端 routes/withdrawCny.ts)───
  // 额度三数字 + 规则(¥50 起、上限、fee_pct)。
  async getCnyWithdrawSummary(): Promise<{
    total_earned: string; total_paid: string; total_pending: string;
    withdrawable: string; has_pending: boolean;
    min_amount: number; max_amount: number; fee_pct: number;
    qr_alipay?: string | null; qr_wechat?: string | null;
  } | null> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/me/withdraw/cny/summary`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return null;
      return res.json();
    } catch { return null; }
  }

  // AI 自动成片(Seedance)开跑前估价 + 余额校验。totalSeconds=全片预估总时长。
  async estimateSeedance(totalSeconds: number, resolution: string, tier: string): Promise<{
    estTokens: number; estCny: number; balance: number; sufficient: boolean; configured: boolean;
  } | null> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/video/seedance/estimate`, {
        method: 'POST',
        headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ totalSeconds, resolution, tier }),
      });
      if (!res.ok) return null;
      return res.json();
    } catch { return null; }
  }

  // 取 Seedance 该清晰度的每秒卖价($/秒),供卡片动态展示(不写死)。失败返 null。
  async seedanceRate(resolution: string): Promise<{ usdPerSec: number; cnyPerSec: number; creditsPerSec: number; resolution: string } | null> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/video/seedance/rate?resolution=${encodeURIComponent(resolution)}`, {
        method: 'GET',
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return null;
      return res.json();
    } catch { return null; }
  }

  // File → data URL(base64)。⚠️【根因】桌面 webview(Tauri/Electron)里 fetch + FormData(File) 发 multipart
  //   不可靠 → 后端收不到 file → "No file"(头像、收款码都中招)。改成把图读成 base64 走普通 JSON body,
  //   任何 webview 都稳(JSON 不依赖 multipart 边界序列化)。官网普通浏览器仍可走老 multipart(后端两种都收)。
  private fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ''));
      r.onerror = () => reject(new Error('read_failed'));
      r.readAsDataURL(file);
    });
  }

  // 上传收款码 → 返 R2 URL。走 base64 JSON(见 fileToDataUrl)。带 kind → 后端按支付宝/微信各记住一张,下次自动回填。
  async uploadCnyWithdrawQr(file: File, kind?: 'alipay' | 'wechat'): Promise<{ ok?: boolean; url?: string; error?: string }> {
    try {
      const image = await this.fileToDataUrl(file);
      const res = await this.authedFetch(`${this.backendUrl}/api/me/withdraw/cny/upload-qr`, {
        method: 'POST',
        headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ image, kind }),
      });
      const data = await res.json();
      if (!res.ok) return { error: data.error || 'upload_failed' };
      return { ok: true, url: data.url };
    } catch { return { error: 'network_error' }; }
  }

  // 删除记住的收款码(按收款方式)。
  async deleteCnyWithdrawQr(kind: 'alipay' | 'wechat'): Promise<{ ok?: boolean; error?: string }> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/me/withdraw/cny/qr-delete`, {
        method: 'POST',
        headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { error: data.error || 'delete_failed' };
      return { ok: true };
    } catch { return { error: 'network_error' }; }
  }

  // 创建提现申请。qrKind: 'alipay' | 'wechat'。
  async createCnyWithdraw(amount: number, qrImageUrl: string, qrKind: 'alipay' | 'wechat'): Promise<{
    ok?: boolean; id?: string; amount_cny?: string; amount_paid_cny?: string;
    status?: string; message?: string; error?: string; withdrawable?: string; min?: number; max?: number;
  }> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/me/withdraw/cny`, {
        method: 'POST',
        headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, qr_image_url: qrImageUrl, qr_kind: qrKind }),
      });
      const data = await res.json();
      if (!res.ok) return { error: data.error || 'create_failed', ...data };
      return data;
    } catch { return { error: 'network_error' }; }
  }

  async getCnyWithdrawHistory(limit = 50): Promise<{ items: Array<{
    id: string; amount_cny: string; fee_pct: number; amount_paid_cny: string;
    qr_kind: string; status: 'pending' | 'paid' | 'canceled';
    created_at: string; paid_at: string | null; paid_note: string | null; external_ref: string | null;
  }> }> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/me/withdraw/cny/history?limit=${limit}`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return { items: [] };
      return res.json();
    } catch { return { items: [] }; }
  }

  // ─── Generic notification endpoints (initially seeded with rebate_received) ───
  // The Modal/Banner/RedDot UI components poll these on launch + reactively.

  async getUnreadNotifications(): Promise<{ items: Array<NotificationRow> }> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/me/notifications/unread`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return { items: [] };
      return res.json();
    } catch { return { items: [] }; }
  }

  async getNotificationHistory(limit = 50): Promise<{ items: Array<NotificationRow> }> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/me/notifications/list?limit=${limit}`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return { items: [] };
      return res.json();
    } catch { return { items: [] }; }
  }

  async markNotificationRead(id: string): Promise<boolean> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/me/notifications/${id}/read`, {
        method: 'POST', headers: this.getAuthHeaders(),
      });
      return res.ok;
    } catch { return false; }
  }

  async markNotificationDismissed(id: string): Promise<boolean> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/me/notifications/${id}/dismiss`, {
        method: 'POST', headers: this.getAuthHeaders(),
      });
      return res.ok;
    } catch { return false; }
  }

  async markNotificationCtaClicked(id: string): Promise<boolean> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/me/notifications/${id}/cta-clicked`, {
        method: 'POST', headers: this.getAuthHeaders(),
      });
      return res.ok;
    } catch { return false; }
  }

  async markAllNotificationsRead(): Promise<number> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/me/notifications/mark-all-read`, {
        method: 'POST', headers: this.getAuthHeaders(),
      });
      if (!res.ok) return 0;
      const j = await res.json();
      return j.count || 0;
    } catch { return 0; }
  }

  async getNoobEarnings(page = 1, limit = 20, reason = '', from = '', to = ''): Promise<{ list: any[]; total: number; stats: any }> {
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (reason) params.set('reason', reason);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const res = await this.authedFetch(`${this.backendUrl}/api/user/noob/earnings?${params}`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return { list: [], total: 0, stats: {} };
      return res.json();
    } catch {
      return { list: [], total: 0, stats: {} };
    }
  }

  async getCreditHistory(page = 1, limit = 20, from = '', to = '', kind: 'all' | 'spend' | 'earn' = 'all'): Promise<{ list: any[]; total: number; stats: any }> {
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      if (kind && kind !== 'all') params.set('kind', kind);
      const res = await this.authedFetch(`${this.backendUrl}/api/user/credits/history?${params}`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return { list: [], total: 0, stats: {} };
      return res.json();
    } catch {
      return { list: [], total: 0, stats: {} };
    }
  }

  async getNoobSends(page = 1, limit = 20, from = '', to = ''): Promise<{ list: any[]; total: number }> {
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const res = await this.authedFetch(`${this.backendUrl}/api/user/noob/sends?${params}`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return { list: [], total: 0 };
      return res.json();
    } catch {
      return { list: [], total: 0 };
    }
  }
  async uploadAvatar(file: File): Promise<{ avatarUrl?: string; error?: string }> {
    try {
      const image = await this.fileToDataUrl(file); // base64 JSON,绕开桌面 webview multipart 不可靠的坑(见 fileToDataUrl)
      const res = await this.authedFetch(`${this.backendUrl}/api/user/avatar`, {
        method: 'POST',
        headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ image }),
      });
      const data = await res.json();
      if (!res.ok) return { error: data.error || 'Upload failed' };
      return { avatarUrl: data.avatarUrl };
    } catch {
      return { error: 'Network error' };
    }
  }

  async claimLuckyBag(): Promise<{ hit: boolean; reward: number } | null> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/ai/lucky-bag/claim`, {
        method: 'POST',
        headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  }

  async getNoobConfig(): Promise<{ tokenSymbol: string; totalSupply: string; contractAddress: string; taxRate: string }> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/user/noob/config`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return { tokenSymbol: 'Noob', totalSupply: '1000000000', contractAddress: '', taxRate: '2' };
      return res.json();
    } catch {
      return { tokenSymbol: 'Noob', totalSupply: '1000000000', contractAddress: '', taxRate: '2' };
    }
  }
  // ── Daily check-in ─────────────────────────────────────────────────

  /** Get today's check-in status: already checked in? pools remaining? */
  async getCheckinStatus(): Promise<{
    checked_in: boolean;
    noob_remaining: number;
    noob_cap: number;
    points_remaining: number;
    points_cap: number;
    pool_exhausted: boolean;
    last_reward: { noob: number; points: number } | null;
  }> {
    try {
      const deviceId = this.getDeviceId();
      const res = await this.authedFetch(`${this.backendUrl}/api/user/checkin/status`, {
        headers: { ...this.getAuthHeaders(), 'x-device-id': deviceId },
      });
      if (!res.ok) return { checked_in: false, noob_remaining: 0, noob_cap: 0, points_remaining: 0, points_cap: 0, pool_exhausted: false, last_reward: null };
      return res.json();
    } catch {
      return { checked_in: false, noob_remaining: 0, noob_cap: 0, points_remaining: 0, points_cap: 0, pool_exhausted: false, last_reward: null };
    }
  }

  /** Perform today's daily check-in. Returns reward or rejection reason. */
  async checkin(): Promise<{
    success: boolean;
    noob_reward?: number;
    points_reward?: number;
    already_checked_in?: boolean;
    pool_exhausted?: boolean;
    error?: string;
  }> {
    try {
      const deviceId = this.getDeviceId();
      const res = await this.authedFetch(`${this.backendUrl}/api/user/checkin`, {
        method: 'POST',
        headers: { ...this.getAuthHeaders(), 'x-device-id': deviceId, 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
      return res.json();
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Get status of all 4 daily activities + shared pool remaining. */
  async getActivityStatus(): Promise<{
    activities: Array<{ type: string; claimed: boolean; enabled?: boolean; last_reward: { noob: number; points: number } | null }>;
    pool: { noob_remaining: number; noob_cap: number; points_remaining: number; points_cap: number; exhausted: boolean };
  }> {
    const empty = {
      activities: [] as any[],
      pool: { noob_remaining: 0, noob_cap: 0, points_remaining: 0, points_cap: 0, exhausted: false },
    };
    try {
      const deviceId = this.getDeviceId();
      const res = await this.authedFetch(`${this.backendUrl}/api/user/activity/status`, {
        headers: { ...this.getAuthHeaders(), 'x-device-id': deviceId },
      });
      if (!res.ok) return empty;
      return res.json();
    } catch {
      return empty;
    }
  }

  /** Claim reward for one of: checkin / xhs_rewrite / og_brawl / personality_test */
  async claimActivity(activityType: string): Promise<{
    success: boolean;
    activity_type?: string;
    noob_reward?: number;
    points_reward?: number;
    already_claimed?: boolean;
    pool_exhausted?: boolean;
    error?: string;
  }> {
    try {
      const deviceId = this.getDeviceId();
      const res = await this.authedFetch(`${this.backendUrl}/api/user/activity/claim`, {
        method: 'POST',
        headers: { ...this.getAuthHeaders(), 'x-device-id': deviceId, 'Content-Type': 'application/json' },
        body: JSON.stringify({ activity_type: activityType }),
      });
      if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
      return res.json();
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Stable per-browser device ID for anti-abuse. Not cryptographically
   *  strong — just raises the cost of scripted farming. */
  private getDeviceId(): string {
    const KEY = 'noobclaw_device_id';
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(KEY, id);
    }
    return id;
  }
}

export const noobClawApi = new NoobClawApiService();
