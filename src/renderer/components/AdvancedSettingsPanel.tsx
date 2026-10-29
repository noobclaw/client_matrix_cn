/**
 * Advanced settings panel.
 *
 * Central home for the newer settings.json-driven features that
 * don't yet justify dedicated top-level tabs:
 *
 *   1. Tool permission policy — allowlist / denylist / ask rules per
 *      tool name + Bash command substring.
 *   2. Shell hooks — list configured PreToolUse / PostToolUse /
 *      Stop / SessionStart commands (read-only view + "edit in editor"
 *      button).
 *   3. User slash commands — list /foo commands from the commands
 *      folder and open the folder for the user to drop new markdown
 *      files.
 *   4. Extended thinking budget slider — set the default budget in
 *      tokens that the query engine passes through to the Anthropic
 *      API for claude-*-thinking models.
 *
 * Everything here lives in {UserDataPath}/settings.json under distinct
 * top-level keys (toolPermissions, hooks, thinkingBudget) so the user
 * can hand-edit the file without losing unrelated state.
 */

import React, { useEffect, useState, useCallback } from 'react';

interface PolicyRule {
  pattern: string;
  mode: 'allow' | 'deny' | 'ask';
  bashCommandContains?: string;
  reason?: string;
}

interface Policy {
  defaultMode: 'allow' | 'deny' | 'ask';
  rules: PolicyRule[];
}

interface ShellHook {
  matcher?: string;
  command: string;
  timeoutMs?: number;
}

interface SlashCmd {
  name: string;
  description: string;
  file: string;
}

// Lazy import to avoid circular dep
const getIsZh = () => {
  try { return require('../services/i18n').i18nService.currentLanguage === 'zh'; } catch { return false; }
};

const AdvancedSettingsPanel: React.FC = () => {
  const isZh = getIsZh();
  const [policy, setPolicy] = useState<Policy>({ defaultMode: 'allow', rules: [] });
  const [hooks, setHooks] = useState<Record<string, ShellHook[]>>({});
  const [slashCmds, setSlashCmds] = useState<SlashCmd[]>([]);
  const [slashDir, setSlashDir] = useState<string>('');
  const [thinkingBudget, setThinkingBudget] = useState<number>(0);
  const [savedToast, setSavedToast] = useState<string | null>(null);

  // Load everything on mount. Each call is independent so a single
  // failed endpoint doesn't block the others.
  useEffect(() => {
    const anyWindow = window as any;
    const e = anyWindow.electron;
    if (!e) return;
    (async () => {
      try {
        const p = await e.toolPolicy?.get?.();
        if (p) setPolicy(p);
      } catch { /* ignore */ }
      try {
        const h = await e.shellHooks?.list?.();
        if (h) setHooks(h);
      } catch { /* ignore */ }
      try {
        const list = await e.slashCommands?.list?.();
        if (Array.isArray(list)) setSlashCmds(list);
        const dir = await e.slashCommands?.getDir?.();
        if (typeof dir === 'string') setSlashDir(dir);
      } catch { /* ignore */ }
      try {
        // Read thinkingBudget out of settings.json via the same
        // toolPolicy endpoint (it's stored alongside). For now,
        // default to 0; we fetch via the cowork config API below.
        const cfg = await e.coworkConfig?.get?.();
        if (cfg?.thinkingBudget) setThinkingBudget(cfg.thinkingBudget);
      } catch { /* ignore */ }
    })();
  }, []);

  const savePolicy = useCallback(async (next: Policy) => {
    setPolicy(next);
    const e = (window as any).electron;
    const ok = await e?.toolPolicy?.set?.(next);
    if (ok) {
      setSavedToast('Policy saved');
      setTimeout(() => setSavedToast(null), 1200);
    }
  }, []);

  const addRule = () => {
    savePolicy({
      ...policy,
      rules: [...policy.rules, { pattern: 'Bash', mode: 'ask' }],
    });
  };

  const updateRule = (idx: number, patch: Partial<PolicyRule>) => {
    const next = policy.rules.slice();
    next[idx] = { ...next[idx], ...patch };
    savePolicy({ ...policy, rules: next });
  };

  const removeRule = (idx: number) => {
    const next = policy.rules.slice();
    next.splice(idx, 1);
    savePolicy({ ...policy, rules: next });
  };

  return (
    <div className="space-y-10 text-sm">
      {savedToast && (
        <div className="fixed top-4 right-4 z-50 rounded bg-claude-accent px-3 py-1.5 text-xs text-black shadow">
          {savedToast}
        </div>
      )}

      {/* ── Tool permission policy ──────────────────────────────── */}
      <section>
        <h3 className="text-sm font-semibold dark:text-claude-darkText text-claude-text mb-2">
          {isZh ? 'Tool 权限策略' : 'Tool permission policy'}
        </h3>
        <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-3">
          {isZh ? '预先批准或拦截特定工具，无需每次确认。模式匹配工具名称，从上到下匹配，首条命中生效。' : 'Pre-approve or block specific tools without per-call prompts. Patterns are regexes matched against the tool name. Rules are evaluated top-down; first match wins.'}
        </p>

        <div className="flex items-center gap-2 mb-3">
          <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{isZh ? '默认模式:' : 'Default mode:'}</span>
          <select
            className="px-2 py-1 rounded text-xs dark:bg-claude-darkSurface bg-claude-surface dark:border-claude-darkBorder border-claude-border border"
            value={policy.defaultMode}
            onChange={(e) => savePolicy({ ...policy, defaultMode: e.target.value as any })}
          >
            <option value="ask">ask</option>
            <option value="allow">allow</option>
            <option value="deny">deny</option>
          </select>
        </div>

        <div className="space-y-2">
          {policy.rules.map((rule, idx) => (
            <div
              key={idx}
              className="flex items-center gap-2 rounded dark:border-claude-darkBorder border-claude-border border px-3 py-2"
            >
              <input
                className="flex-1 bg-transparent text-xs font-mono focus:outline-none dark:text-claude-darkText text-claude-text"
                placeholder="Tool regex (e.g. Bash, Edit|Write, mcp__.*)"
                value={rule.pattern}
                onChange={(e) => updateRule(idx, { pattern: e.target.value })}
              />
              <input
                className="flex-1 bg-transparent text-xs font-mono focus:outline-none dark:text-claude-darkText text-claude-text"
                placeholder="Bash command contains (optional)"
                value={rule.bashCommandContains ?? ''}
                onChange={(e) => updateRule(idx, { bashCommandContains: e.target.value || undefined })}
              />
              <select
                className="px-2 py-1 rounded text-xs dark:bg-claude-darkSurface bg-claude-surface dark:border-claude-darkBorder border-claude-border border"
                value={rule.mode}
                onChange={(e) => updateRule(idx, { mode: e.target.value as any })}
              >
                <option value="ask">ask</option>
                <option value="allow">allow</option>
                <option value="deny">deny</option>
              </select>
              <button
                type="button"
                className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary hover:underline"
                onClick={() => removeRule(idx)}
              >
                {isZh ? '删除' : 'Remove'}
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={addRule}
            className="text-xs dark:text-claude-accent text-claude-accent hover:underline"
          >
            + Add rule
          </button>
        </div>
      </section>

      {/* ── Extended thinking budget ────────────────────────────── */}
      <section>
        <h3 className="text-sm font-semibold dark:text-claude-darkText text-claude-text mb-2">
          Extended thinking budget
        </h3>
        <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-3">
          Token budget Anthropic models get for private reasoning before
          replying. 0 = off (faster, cheaper). 1,024 – 32,768 gives the
          model room to think for hard problems. Changes affect the next
          session.
        </p>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={32768}
            step={1024}
            value={thinkingBudget}
            onChange={(e) => setThinkingBudget(parseInt(e.target.value, 10))}
            onMouseUp={async () => {
              const api = (window as any).electron?.coworkConfig;
              if (api?.setThinkingBudget) {
                await api.setThinkingBudget(thinkingBudget);
                setSavedToast('Thinking budget saved');
                setTimeout(() => setSavedToast(null), 1200);
              }
            }}
            className="flex-1"
          />
          <span className="font-mono text-xs dark:text-claude-darkText text-claude-text w-20 text-right">
            {thinkingBudget === 0 ? 'off' : `${thinkingBudget.toLocaleString()} tok`}
          </span>
        </div>
      </section>

      {/* ── Shell hooks (read-only list) ────────────────────────── */}
      <section>
        <h3 className="text-sm font-semibold dark:text-claude-darkText text-claude-text mb-2">
          Shell hooks
        </h3>
        <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-3">
          Shell commands that fire on agent lifecycle events.
          Hand-edit via <code>settings.json</code> under the
          <code> hooks</code> key. PreToolUse non-zero exit blocks the
          tool.
        </p>
        {(['PreToolUse', 'PostToolUse', 'Stop', 'SessionStart'] as const).map((ev) => {
          const list = hooks[ev] ?? [];
          return (
            <div key={ev} className="mb-2">
              <div className="text-[11px] uppercase tracking-wider dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                {ev} · {list.length}
              </div>
              {list.length === 0 ? (
                <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary italic">none</div>
              ) : (
                list.map((h, i) => (
                  <div key={i} className="text-xs font-mono dark:text-claude-darkText text-claude-text px-2 py-1 rounded dark:bg-claude-darkSurface bg-claude-surface">
                    {h.matcher && <span className="dark:text-claude-accent text-claude-accent">[{h.matcher}] </span>}
                    {h.command}
                  </div>
                ))
              )}
            </div>
          );
        })}
      </section>

      {/* ── User slash commands ─────────────────────────────────── */}
      <section>
        <h3 className="text-sm font-semibold dark:text-claude-darkText text-claude-text mb-2">
          User slash commands
        </h3>
        <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-3">
          Drop markdown files into the commands folder — each becomes a
          <code> /name</code> you can type in the composer. Use
          <code> $ARGUMENTS</code> in the body for the post-command text.
        </p>
        {slashDir && (
          <div className="text-[11px] font-mono dark:text-claude-darkTextSecondary text-claude-textSecondary mb-2">
            {slashDir}
          </div>
        )}
        {slashCmds.length === 0 ? (
          <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary italic">
            No commands configured yet.
          </div>
        ) : (
          slashCmds.map((c) => (
            <div key={c.name} className="text-xs mb-1">
              <span className="font-mono dark:text-claude-accent text-claude-accent">/{c.name}</span>
              {c.description && (
                <span className="ml-2 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {c.description}
                </span>
              )}
            </div>
          ))
        )}
      </section>
    </div>
  );
};

export default AdvancedSettingsPanel;
