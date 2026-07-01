/**
 * Centralized management of all business API endpoints.
 * New business interfaces should also be configured in this file.
 *
 * Environment switching:
 *   Local testing -> app.testMode = true  (NODE_ENV=development)
 *   Production    -> app.testMode = false (NODE_ENV=production)
 */

import { configService } from './config';
import { HIDE_WEB3 } from '../buildFlags';

// VITE_TEST_MODE is replaced by Vite at compile time as a literal, unaffected by localStorage config
// When building with dist:win:test = 'true'; for dist:win production build = undefined
const BUILD_TEST_MODE = import.meta.env.VITE_TEST_MODE === 'true';

export const isTestMode = () => {
  // Compile-time flag takes priority, otherwise check runtime config
  if (BUILD_TEST_MODE || configService.getConfig().app?.testMode === true) return true;
  // Tauri mode: never test mode (tauri://localhost is NOT a dev server)
  if ((window as any).__TAURI__) return false;
  // Only treat as test mode when accessing via http on localhost
  // After Electron packaging, protocol is file:, which should not be treated as test mode
  try {
    const host = window.location.hostname;
    const proto = window.location.protocol;
    if (proto !== 'file:' && proto !== 'tauri:' && (host === 'localhost' || host === '127.0.0.1')) return true;
  } catch {}
  return false;
};

// ── Core service URLs ──────────────────────────────────────────────
/** Backend API URL */
export const getBackendApiUrl = () => isTestMode()
  ? 'http://127.0.0.1:3001'
  : 'https://api.noobclaw.com';

/** Website URL (wallet login redirect) —— 国内版走 /cn 站 */
export const getWebsiteUrl = () => isTestMode()
  ? 'http://127.0.0.1:3001'
  : (HIDE_WEB3 ? 'https://noobclaw.com/cn' : 'https://noobclaw.com');

// ── Auto-update (fetched from own backend) ─────────────────────────────────
// 国内矩阵版:更新渠道 edition=cn-matrix(HIDE_WEB3 时);非国内则 global-matrix。
// 后端 4 个 edition:global(国际原版)/global-matrix(国际矩阵版)/cn(国内原版)/cn-matrix(国内矩阵版),
// 各自独立版本号+安装包,strict 不跨 edition fallback。这里必须发 *-matrix,绝不能是 cn(那是国内【原版】,会撞 client_cn)。
export const getUpdateCheckUrl = () => `${getBackendApiUrl()}/api/skills/latest-releases?edition=${HIDE_WEB3 ? 'cn-matrix' : 'global-matrix'}`;

export const getFallbackDownloadUrl = () => HIDE_WEB3 ? 'https://noobclaw.com/cn/#/download-list' : 'https://noobclaw.com/#/download-list';

// Skill store
export const getSkillStoreUrl = () => `${getBackendApiUrl()}/api/skills/marketplace`;
