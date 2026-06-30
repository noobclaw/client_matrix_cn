/**
 * Scenario automation — shared types between Electron main process libs.
 *
 * Keep this file dependency-free (no runtime imports) so both renderer
 * (via a type-only import) and main can use it.
 */

export type Platform = 'xhs' | 'x' | 'binance' | 'douyin' | 'tiktok' | 'youtube' | 'kuaishou' | 'bilibili' | 'shipinhao' | 'toutiao' | 'video';

export type WorkflowType =
  | 'viral_production'
  | 'auto_reply'
  | 'mass_comment'
  | 'dm_reply'
  | 'data_monitor'
  | 'xhs_video_download'
  | 'douyin_video_download'
  | 'tiktok_video_download'
  | 'kuaishou_auto_engage'
  | 'kuaishou_video_download'
  | 'kuaishou_reply_fans_comment'
  | 'bilibili_auto_engage'
  | 'bilibili_video_download'
  | 'bilibili_reply_fans_comment'
  | 'shipinhao_image_text_creation'
  | 'shipinhao_reply_fans_comment'
  | 'toutiao_image_text_creation'
  | 'toutiao_reply_fans_comment';

export interface ScenarioManifest {
  id: string;                // e.g. "xhs_viral_production_career"
  version: string;           // "1.0.0"
  platform: Platform;
  workflow_type: WorkflowType;
  category: string;
  name_zh: string;
  name_en: string;
  description_zh: string;
  description_en: string;
  icon: string;
  default_config: ScenarioDefaultConfig;
  qualify?: {
    min_likes?: number;
    max_age_hours?: number;
    exclude_types?: string[];
  };
  risk_caps: RiskCaps;
  required_login_url: string;
  entry_urls: Record<string, string>;
  creator_urls?: Record<string, string>;
  skills: Record<string, any>;      // key → filename or nested object
  /**
   * Optional URL pattern (regex string) identifying which Chrome tab this
   * scenario's commands should be routed to. Introduced for multi-tab
   * concurrency (Twitter v1) so XHS tasks talk to xiaohongshu.com tabs
   * and Twitter tasks talk to x.com tabs without stepping on each other.
   *
   * Examples:
   *   '^https?://(www\\.)?xiaohongshu\\.com/'       — XHS scenarios
   *   '^https?://(www\\.)?(twitter|x)\\.com/'       — Twitter scenarios
   *
   * When omitted (legacy XHS scenarios pre-v4.18.5), commands route to
   * whichever tab the extension considers active — same behavior as before
   * this field existed. Backward compatible.
   */
  tab_url_pattern?: string;
  /**
   * Anchor URL for `tab_url_pattern`. Used by phaseRunner's pre-flight: if
   * NO open tab matches `tab_url_pattern` when about to send a routed
   * command (navigate / scroll / browser), the runner first opens this
   * URL via `tab_create`, waits, then proceeds with the original command.
   * Replaces the chrome-extension's hardcoded `anchorUrlFor` table — new
   * platforms (douyin / tiktok / youtube) ship a manifest with
   * `anchor_url` and don't need an extension republish to work without
   * a pre-opened tab.
   *
   * Optional but recommended whenever `tab_url_pattern` is set. Without
   * it, the extension's legacy `anchorUrlFor` is the only fallback (only
   * covers xhs / x / binance — other platforms throw "no anchor URL
   * known" if the user runs the task with no matching tab open).
   */
  anchor_url?: string;
  /**
   * Cross-tab scenarios (binance_from_x_repost / binance_from_x_link)
   * declare a secondary tab via `secondary_tab_url_pattern` /
   * `additional_tab_patterns`. This is its anchor — same role as
   * `anchor_url` but for the secondary pattern.
   */
  secondary_anchor_url?: string;
  /**
   * v4.25+ multi-tab patterns this scenario also touches. The pre-flight
   * walks each one and ensures a matching tab exists before the run.
   * Read by resourceKeysForPack today; pre-flight uses the same field.
   */
  additional_tab_patterns?: string[];
  /**
   * Single-string variant of additional_tab_patterns (used by
   * binance_from_x_repost). Kept here so types match runtime shape.
   */
  secondary_tab_url_pattern?: string;

  /**
   * v6.x window-routing rework (PR6): sub_platform ids the scenario
   * touches at any point during its run, e.g. ['xhs_creator', 'xhs_main'].
   * Used by scenarioManager.resourceKeysForPack as mutex keys (scenario
   * acquires `platform:${each}` lock per entry, blocks any other scenario
   * holding the same lock). Validated against SUB_PLATFORM_REGISTRY in
   * client/src/main/libs/scenario/subPlatformRegistry.ts — unknown ids
   * get a WARN log and still produce a standalone lock.
   */
  platforms?: string[];

  /**
   * v6.x (PR9): role names whose tabs should be closed at task end by
   * phaseRunner's _releaseAllWindows cleanup hook. Long-lived roles (e.g.
   * 'creator', 'main', 'home') are NOT listed here — they survive in the
   * windowRegistry so the next task hitting the same sub_platform reuses
   * them. Throwaway roles (e.g. 'explore' in xhs_reply_fans_comment) ARE
   * listed so the user's screen doesn't pile up dead tabs.
   * Only matched against ctx.openTab / ctx.waitChildTab calls that took
   * the v6 sub_platform path; v1.5.3-style tabs aren't tracked for cleanup.
   */
  transient_roles?: string[];
}

export interface ScenarioDefaultConfig {
  keywords: string[];
  persona: string;
  daily_count: number;
  variants_per_post: number;
  schedule_window: string;          // 'HH:MM-HH:MM'
}

export interface RiskCaps {
  max_daily_runs: number;
  max_scroll_per_run: number;
  min_scroll_delay_ms: number;
  max_scroll_delay_ms: number;
  read_dwell_min_ms: number;
  read_dwell_max_ms: number;
  max_run_duration_ms: number;
  min_interval_hours: number;
  weekly_rest_days: number;
  cooldown_captcha_hours: number;
  cooldown_rate_limit_hours: number;
  cooldown_account_flag_hours: number;
}

/** Config for discovery behavior (from config.json on server) */
export interface DiscoveryConfig {
  strategy: 'search_first' | 'explore_first';
  search_filters: {
    tab: string;
    sort: string;
    time: string;
    open_filter_panel: boolean;
  };
  qualify: {
    min_likes: number;
    exclude_types: string[];
    require_keyword_on_search: boolean;
    require_keyword_on_explore: boolean;
  };
  behavior: {
    first_screen_pause: [number, number];
    scroll_pause: [number, number];
    detail_page_pause: [number, number];
    filter_click_pause: [number, number];
    max_scrolls_no_new: number;
  };
}

/**
 * ScenarioPack — downloaded from server on each run.
 * Contains everything needed to execute a scenario:
 *   - scripts: browser-injected JS code (hot-updatable)
 *   - prompts: AI system prompts (hot-updatable)
 *   - config: discovery strategy/thresholds (hot-updatable)
 *   - manifest: metadata + risk caps
 */
export interface ScenarioPack {
  manifest: ScenarioManifest;
  scripts: Record<string, string>;
  prompts: Record<string, string>;
  config: DiscoveryConfig;
  orchestrator: string;           // JS code downloaded from server
  /** JS code for uploading a single already-generated draft. Used by
   *  TaskDetailPage "📤 上传" per-draft button. Downloaded from
   *  scenario pack's upload_draft_script slot. */
  upload_draft_script?: string;
  draft_uploader?: any;
}

// ── Task (a user's configured instance of a scenario) ──

export interface ScenarioTask {
  id: string;                       // local uuid
  scenario_id: string;              // references a scenario manifest id
  /** Fine-grained niche id (e.g. "career_side_hustle") — used for
   *  on-disk artifact organization and default keywords. */
  track: string;
  keywords: string[];
  /** Link-mode: if set, orchestrator skips keyword search and visits
   *  these XHS article URLs directly. 1-3 URLs. */
  urls?: string[];
  persona: string;
  daily_count: number;
  variants_per_post: number;
  /** Preferred run time in HH:MM (24h local). Used when interval is 'daily'. */
  daily_time: string;
  /** Run interval. `daily_random` = once per day at a random hour (no fixed time);
   *  used by auto-reply scenarios where pinning to the same hour would trip XHS risk-control. */
  run_interval: '30min' | '1h' | '3h' | '6h' | 'daily' | 'daily_random' | 'once';
  /** Pre-picked timestamp (ms epoch) of when the scheduler should fire
   *  this task next. Computed AFTER each successful run (or on the first
   *  scheduler tick if no last run yet) using the interval + jitter, then
   *  stored so the user can SEE the exact wall-clock time the next run
   *  will happen — without it daily_random just shows "in ~24-27h".
   *  The scheduler uses this as the authoritative fire time. */
  next_planned_run_at?: number;
  /** 任务末步是否自动上传到 XHS 草稿箱。
   *  true（默认）= 跑完改写+生图后自动调上传 orchestrator；
   *  false = 停在 step 3，草稿留本地待用户人工上传，降低封号风险。
   *  任务创建时用户在 wizard/modal 里选。 */
  auto_upload?: boolean;
  /** Legacy field */
  schedule_window?: string;
  /** Twitter v1: content language mode for tweet generation. zh/en/mixed.
   *  Optional — XHS scenarios ignore this. */
  language?: 'zh' | 'en' | 'mixed';
  /** Twitter v1: user's "real-experience pool" — free-form notes about
   *  recent activity, positions, opinions. AI scenarios (post_creator /
   *  link_rewrite) inject this into rewrite/original prompts so generated
   *  tweets have real substance instead of generic templates. Optional. */
  user_context?: string;
  /** douyin_image_text: 用户填的 3 段灵感来源。每次任务运行随机抽 1 段交给
   *  AI 改写。允许少于 3 段（最少 1 段）。空段被 orchestrator 过滤掉。 */
  source_segments?: string[];
  /** douyin_image_text: true → 跑完直接走"发布"按钮; false → 走"存草稿"。
   *  仅当 auto_upload=true 时生效。默认 true(抖音图文草稿只 1 篇上限,
   *  多篇任务用草稿模式只剩最后一篇)。 */
  auto_publish?: boolean;
  /** Twitter v1.x: x_auto_engage daily action ranges (min/max). System
   *  picks random in [min,max] each day. Optional — old tasks default to
   *  (0,3) follows / (1,daily_count) replies. */
  daily_follow_min?: number;
  daily_follow_max?: number;
  daily_reply_min?: number;
  daily_reply_max?: number;
  /** v4.22.x: XHS auto-reply article-count range. Each scheduled run
   *  picks random in [min, max]. Defaults: 1-6 if absent. Authoritative
   *  for auto_reply scenarios — when set, supersedes the legacy single
   *  daily_count field. */
  daily_count_min?: number;
  daily_count_max?: number;
  /** Twitter v2.4.27: is the user's X account a Blue V (subscribed)?
   *  Default false. Drives the per-tweet length cap that orchestrators
   *  inject into AI generation prompts:
   *    false → AI must keep generated tweets ≤ 140 chars (non-Blue cap)
   *    true  → AI free to pick short / medium / long (Blue gets 25k chars)
   *  Affects post_creator, link_rewrite, and auto_engage reply lengths. */
  is_blue_v?: boolean;
  enabled: boolean;
  /** v4.25.4 (语义变更):"当前选中的任务" — UI 高亮用,不再驱动调度。
   *  之前是"only active 可以 scheduler 自动运行"的单选闸门,导致多任务时
   *  其他任务到点不跑。现在 scheduler 看的是 enabled,active 仅供 UI 显示
   *  "starred / current" 状态。setActiveTask 仍可用,只影响 UI 不影响调度。 */
  active: boolean;
  created_at: number;
  updated_at: number;
}

// ── Discovery output ──

export interface DiscoveredNote {
  external_post_id: string;
  external_url: string;
  title: string;
  body: string;
  images: string[];
  hashtags: string[];
  publish_time?: string;
  author_name?: string;
  author_followers?: number;
  metrics: {
    likes: number;
    comments: number;
    collects?: number;
    collected_at: number;
  };
}

// ── Extraction / composition output ──

export interface ExtractionResult {
  hook_type: string;
  hook_first_sentence: string;
  body_structure: string[];
  emotion_arc: string;
  core_value_prop: string;
  cta_type: string;
  cta_sentence: string;
  hashtag_strategy: {
    big_traffic: string[];
    niche: string[];
    count_total: number;
  };
  visual_pattern: string;
  length_char_count: number;
  paragraph_count: number;
  emoji_density: string;
  signature_phrases: string[];
}

export interface ComposedVariant {
  title: string;
  body: string;
  hashtags: string[];
  suggested_cover_text: string;
  route: string;
  notes_for_user: string;
  /** LLM-generated image prompt for the XHS cover. Saved to local md
   *  and passed to /api/image/generate as `cover_prompt`. */
  cover_image_prompt?: string;
  /** Same, for the inline content image. */
  content_image_prompt?: string;
}

export interface Draft {
  id: string;
  task_id: string;
  source_post: DiscoveredNote;
  extraction: ExtractionResult;
  variant: ComposedVariant;
  status: 'pending' | 'pushed' | 'ignored';
  created_at: number;
  pushed_at?: number;
}

// ── Run record (for riskGuard + UI status) ──

export interface TaskRun {
  task_id: string;
  started_at: number;
  ended_at?: number;
  status: 'running' | 'ok' | 'failed' | 'skipped';
  reason?: string;
  collected_count?: number;
  draft_count?: number;
  /** Per-action successful counts (like / follow / comment / reply / post).
   *  Populated from ctx.addActionCount() in the orchestrator. Drives the
   *  TaskDetailPage "累计完成" + "上次完成" stat cards. Undefined for
   *  pre-rollout runs — UI shows '-' in that case. */
  action_counts?: Record<string, number>;
  /** Credits consumed by this run (LLM + image gen + interaction charges). */
  tokens_used?: number;
  /** USD cost at the time of the run, from system_config.token_price_per_million. */
  cost_usd?: number;
}
