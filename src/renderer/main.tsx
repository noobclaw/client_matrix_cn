import { initTauriShim } from './tauriShim';
import { installRangeDragFix } from './utils/rangeDragFix';

// Initialize Tauri shim BEFORE any React code runs.
// In Tauri mode, this creates a window.electron compatible API using HTTP+SSE.
// In Electron mode, this is a no-op (window.electron already exists from preload).
initTauriShim();

// Windows(WebView2) 下原生 range 滑杆拖拽失效的全局兜底(详见 utils/rangeDragFix.ts)
installRangeDragFix();

// ── DevTools / refresh / right-click suppression ──────────────────────
// In production (Vite PROD bundles only — dev keeps everything for
// debugging), silently swallow keyboard shortcuts and context menus that
// open DevTools, refresh the renderer (which would dump in-memory state
// and look like a crash to users), or expose the page source. We attach
// in the capture phase so React component handlers can't accidentally
// let these through. Tauri's release build is also compiled without the
// devtools webview feature (src-tauri/Cargo.toml) and Electron's
// BrowserWindow is constructed with devTools:false in production
// (src/main/main.ts) — three layers of defense, since each one alone
// has known bypasses (e.g. menu items can call openDevTools even when
// the F12 shortcut is captured).
//
// Blocked: F5, Ctrl/Cmd+R, Ctrl/Cmd+Shift+R (reload),
//          F12, Ctrl/Cmd+Shift+I, Ctrl/Cmd+Shift+J, Ctrl/Cmd+Shift+C (devtools),
//          Ctrl/Cmd+U (view source),
//          right-click context menu.
if (import.meta.env.PROD) {
  const block = (e: Event) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    return false;
  };
  window.addEventListener('contextmenu', block, true);
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    const blockedNoMod = k === 'F5' || k === 'F12';
    const blockedReload = mod && (k === 'r' || k === 'R');
    const blockedDevtools =
      mod && e.shiftKey && (k === 'I' || k === 'i' || k === 'J' || k === 'j' || k === 'C' || k === 'c');
    const blockedViewSource = mod && (k === 'u' || k === 'U');
    if (blockedNoMod || blockedReload || blockedDevtools || blockedViewSource) {
      block(e);
    }
  }, true);
}

import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';
import { store } from './store';
import App from './App';
import CommandBarView from './components/commandBar/CommandBarView';
import './noobclaw-theme.css';
import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Failed to find the root element');
}

// The `command-bar` secondary Tauri window loads index.html with
// `#command-bar` in its URL (see tauri.conf.json windows[1].url).
// Mount a tiny Spotlight-style component instead of the full app in
// that window — it shares the same bundle so there's zero extra CSS
// / JS to ship, but renders a totally different tree.
const isCommandBar =
  typeof window !== 'undefined' &&
  (window.location.hash === '#command-bar' ||
    window.location.hash.startsWith('#command-bar'));

try {
  if (isCommandBar) {
    ReactDOM.createRoot(rootElement).render(
      <React.StrictMode>
        <Provider store={store}>
          <CommandBarView />
        </Provider>
      </React.StrictMode>
    );
  } else {
    ReactDOM.createRoot(rootElement).render(
      <React.StrictMode>
        <Provider store={store}>
          <App />
        </Provider>
      </React.StrictMode>
    );
  }
} catch (error) {
  console.error('Failed to render the app:', error);
}
