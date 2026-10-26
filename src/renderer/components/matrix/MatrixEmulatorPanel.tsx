/**
 * 雷电模拟器面板(feat/emulator-matrix,见 docs/emulator-matrix.md)。
 *
 * 一个弹窗里管:雷电是否就绪 / 安装目录、所有「模拟器执行端」账号的实例状态,以及每个号的
 * 启动、显示窗口、停止、我已登录、打开 App、自检、导出画面结构、删除实例。
 * 只在 Windows 上有意义;非 Windows 由调用方不渲染入口。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { i18nService } from '../../services/i18n';

const E = (): any => (window as any).electron?.emu;
const MX = (): any => (window as any).electron?.matrix;
const tr = (zh: string, en: string): string => (i18nService.currentLanguage === 'zh' ? zh : en);

/** 常用 App 包名(面板「打开 App / 自检」下拉)。 */
export const EMU_APPS: Array<{ pkg: string; label: string }> = [
  { pkg: 'com.zhiliaoapp.musically', label: 'TikTok' },
  { pkg: 'com.ss.android.ugc.aweme', label: '抖音' },
  { pkg: 'com.xingin.xhs', label: '小红书' },
  { pkg: 'com.smile.gifmaker', label: '快手' },
  { pkg: 'tv.danmaku.bili', label: '哔哩哔哩' },
  { pkg: 'com.instagram.android', label: 'Instagram' },
  { pkg: 'com.facebook.katana', label: 'Facebook' },
  { pkg: 'com.google.android.youtube', label: 'YouTube' },
];

interface EmuItem {
  accountId: string; displayName: string; platform: string; instanceName: string;
  index?: number; exists: boolean; running: boolean; androidStarted: boolean; connected: boolean;
  serial?: string; proxyMode?: string; busy: boolean;
}

interface Props {
  focusAccountId?: string | null;   // 从账号卡进来时高亮的号
  onClose: () => void;
  onChanged?: () => void;           // 账号状态有变(如「我已登录」)→ 父组件 reload
}

const MatrixEmulatorPanel: React.FC<Props> = ({ focusAccountId, onClose, onChanged }) => {
  const [status, setStatus] = useState<{ supported: boolean; ldFound: boolean; ldDir?: string | null } | null>(null);
  const [items, setItems] = useState<EmuItem[]>([]);
  const [msgs, setMsgs] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [app, setApp] = useState<string>(EMU_APPS[0].pkg);
  const [dirInput, setDirInput] = useState('');
  const [result, setResult] = useState<{ title: string; body: string } | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    const e = E(); if (!e) return;
    const s = await e.status();
    if (!mounted.current) return;
    setStatus({ supported: !!s?.supported, ldFound: !!s?.ldFound, ldDir: s?.ldDir });
    if (s?.ldFound) {
      const r = await e.list();
      if (mounted.current) setItems(Array.isArray(r?.items) ? r.items : []);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const e = E();
    const off = e?.onProgress?.((p: any) => {
      if (!p?.accountId) return;
      setMsgs((m) => ({ ...m, [p.accountId]: String(p.msg || '') }));
      if (p.done) { setPending((x) => ({ ...x, [p.accountId]: false })); void refresh(); }
    });
    const t = setInterval(() => { void refresh(); }, 8000);
    return () => { mounted.current = false; clearInterval(t); try { off?.(); } catch { /* ignore */ } };
  }, [refresh]);

  const act = async (accountId: string, label: string, fn: () => Promise<any>, keepPending = false): Promise<any> => {
    setPending((x) => ({ ...x, [accountId]: true }));
    setMsgs((m) => ({ ...m, [accountId]: label + '…' }));
    try {
      const r = await fn();
      if (r && r.ok === false) setMsgs((m) => ({ ...m, [accountId]: '❌ ' + (r.error || r.code || tr('失败', 'Failed')) }));
      else if (!keepPending) setMsgs((m) => ({ ...m, [accountId]: '✓ ' + label }));
      return r;
    } catch (err: any) {
      setMsgs((m) => ({ ...m, [accountId]: '❌ ' + String(err?.message || err) }));
      return null;
    } finally {
      if (!keepPending) setPending((x) => ({ ...x, [accountId]: false }));
      void refresh();
    }
  };

  const markLoggedIn = async (accountId: string): Promise<void> => {
    await MX()?.setAccountStatus?.({ id: accountId, status: 'idle' });
    setMsgs((m) => ({ ...m, [accountId]: tr('✓ 已标记为已登录', '✓ Marked as logged in') }));
    onChanged?.();
  };

  const saveDir = async (): Promise<void> => {
    const r = await E()?.setLdDir(dirInput.trim() || null);
    if (r?.ok) { setDirInput(''); void refresh(); }
    else setResult({ title: tr('目录无效', 'Invalid folder'), body: r?.error || tr('该目录下没有 ldconsole.exe', 'ldconsole.exe not found in that folder') });
  };

  const btn = 'text-xs px-2.5 py-1 rounded-lg border dark:border-white/15 border-black/15 hover:border-claude-accent/60 disabled:opacity-40';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-[52rem] max-w-full max-h-[88vh] overflow-y-auto rounded-2xl p-6 dark:bg-claude-darkBg bg-white border dark:border-white/10 border-black/10 shadow-xl">
        <div className="flex items-center gap-2 mb-3">
          <div className="text-base font-semibold">{tr('雷电模拟器', 'LDPlayer emulators')}</div>
          <span className="text-[11px] px-2 py-0.5 rounded-full border border-amber-500/40 text-amber-600 bg-amber-500/5">Beta</span>
          <button type="button" onClick={onClose} className="ml-auto w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:bg-black/5 dark:hover:bg-white/10" aria-label="close">✕</button>
        </div>

        {!status && <div className="text-sm text-gray-500">{tr('检查中…', 'Checking…')}</div>}

        {status && !status.supported && (
          <div className="text-sm text-gray-500">{tr('模拟器矩阵目前仅支持 Windows(雷电模拟器没有 Mac 版)。', 'Emulator matrix is Windows-only for now (LDPlayer has no Mac version).')}</div>
        )}

        {status?.supported && !status.ldFound && (
          <div className="text-sm space-y-3">
            <div>{tr('没找到雷电模拟器。请先安装雷电 9,安装后回来刷新;装在其它位置的话,在下面填安装目录(里面要有 ldconsole.exe)。', 'LDPlayer not found. Install LDPlayer 9 and refresh, or enter its install folder (must contain ldconsole.exe).')}</div>
            <div className="flex gap-2">
              <input value={dirInput} onChange={(e) => setDirInput(e.target.value)} placeholder="D:\\LDPlayer\\LDPlayer9" className="flex-1 text-sm px-3 py-2 rounded-lg border dark:border-white/15 border-black/15 bg-transparent" />
              <button className={btn} onClick={saveDir}>{tr('保存', 'Save')}</button>
              <button className={btn} onClick={() => void refresh()}>{tr('刷新', 'Refresh')}</button>
            </div>
          </div>
        )}

        {status?.supported && status.ldFound && (<>
          <div className="text-xs text-gray-500 mb-3 flex items-center gap-2 flex-wrap">
            <span>{tr('雷电目录:', 'LDPlayer: ')}{status.ldDir}</span>
            <button className={btn} onClick={() => E()?.sortWindows()}>{tr('排列窗口', 'Arrange windows')}</button>
            <span className="ml-auto flex items-center gap-1">
              {tr('App:', 'App:')}
              <select value={app} onChange={(e) => setApp(e.target.value)} className="text-xs px-2 py-1 rounded-lg border dark:border-white/15 border-black/15 bg-transparent">
                {EMU_APPS.map((a) => <option key={a.pkg} value={a.pkg}>{a.label}</option>)}
              </select>
            </span>
          </div>

          <div className="text-xs text-gray-500 mb-3 leading-relaxed rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
            {tr(
              '提示:模拟器和机房 IP 在平台眼中风险较高,账号被限流或要求验证的机率比真手机高。第一期代理用的是安卓系统 HTTP 代理,部分 App 或 UDP 流量可能不走代理。登录请在模拟器窗口里手动完成,登录后点「我已登录」。',
              'Note: emulators and datacenter IPs are treated as higher-risk by platforms. This beta uses Android\'s system HTTP proxy; some apps or UDP traffic may bypass it. Log in manually in the emulator window, then click "I\'m logged in".',
            )}
          </div>

          {items.length === 0 && (
            <div className="text-sm text-gray-500">{tr('还没有使用模拟器的账号。添加账号时把「执行端」选成「雷电模拟器」即可。', 'No emulator accounts yet. When adding an account, set "Runs on" to "LDPlayer emulator".')}</div>
          )}

          <div className="space-y-2">
            {items.map((it) => {
              const busy = !!pending[it.accountId] || it.busy;
              const focus = it.accountId === focusAccountId;
              const state = !it.exists ? tr('实例不存在', 'Missing') : it.connected ? tr('已连接', 'Connected') : it.running ? tr('运行中', 'Running') : tr('已停止', 'Stopped');
              return (
                <div key={it.accountId} className={`rounded-xl border px-3 py-2.5 ${focus ? 'border-claude-accent/60 bg-claude-accent/5' : 'dark:border-white/10 border-black/10'}`}>
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium">{it.displayName}</span>
                    <span className="text-xs text-gray-400">{it.platform} · {it.instanceName}{it.index !== undefined ? ` · #${it.index}` : ''}</span>
                    <span className={`ml-auto text-xs ${it.connected ? 'text-green-600' : it.running ? 'text-blue-500' : 'text-gray-400'}`}>{state}{it.proxyMode === 'http_bridge' ? tr(' · 代理', ' · proxy') : ''}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {!it.exists && <button className={btn} disabled={busy} onClick={() => act(it.accountId, tr('重建实例', 'Recreate'), () => E().bind(it.accountId))}>{tr('重建实例', 'Recreate')}</button>}
                    {it.exists && <button className={btn} disabled={busy} onClick={() => act(it.accountId, tr('启动中', 'Starting'), () => E().start(it.accountId), true)}>{tr('启动 / 连接', 'Start / connect')}</button>}
                    {it.exists && <button className={btn} disabled={busy} onClick={() => act(it.accountId, tr('显示窗口', 'Show'), () => E().show(it.accountId))}>{tr('显示窗口', 'Show window')}</button>}
                    {it.connected && <button className={btn} disabled={busy} onClick={() => act(it.accountId, tr('打开 App', 'Open app'), () => E().openApp(it.accountId, app))}>{tr('打开 App', 'Open app')}</button>}
                    {it.exists && <button className={btn} disabled={busy} onClick={() => void markLoggedIn(it.accountId)}>{tr('我已登录', "I'm logged in")}</button>}
                    {it.connected && <button className={btn} disabled={busy} onClick={async () => {
                      const r = await act(it.accountId, tr('自检', 'Self-test'), () => E().probe(it.accountId, app));
                      if (r?.ok) setResult({ title: tr('自检结果', 'Self-test result'), body: JSON.stringify(r.result, null, 2) });
                    }}>{tr('自检', 'Self-test')}</button>}
                    {it.connected && <button className={btn} disabled={busy} onClick={async () => {
                      const r = await act(it.accountId, tr('导出画面结构', 'Export UI'), () => E().exportUi(it.accountId));
                      if (r?.ok) setResult({ title: tr('已导出到 ', 'Exported to ') + r.dir, body: (r.currentPackage ? `[${r.currentPackage}]\n` : '') + String(r.summary || '') });
                    }}>{tr('导出画面结构', 'Export UI')}</button>}
                    {it.running && <button className={btn} disabled={busy} onClick={() => act(it.accountId, tr('停止', 'Stop'), () => E().stop(it.accountId))}>{tr('停止', 'Stop')}</button>}
                    {it.exists && <button className={`${btn} text-red-500`} disabled={busy} onClick={() => {
                      if (!window.confirm(tr('删除这个号的雷电实例?实例里的 App 登录状态和数据都会清掉,账号会改回浏览器执行端。', 'Delete this account\'s LDPlayer instance? App logins and data inside it will be erased; the account goes back to browser mode.'))) return;
                      void act(it.accountId, tr('删除实例', 'Delete'), () => E().remove(it.accountId)).then(() => onChanged?.());
                    }}>{tr('删除实例', 'Delete instance')}</button>}
                  </div>
                  {msgs[it.accountId] && <div className="text-xs text-gray-500 mt-1.5">{msgs[it.accountId]}</div>}
                </div>
              );
            })}
          </div>
        </>)}

        {result && (
          <div className="mt-4 rounded-xl border dark:border-white/10 border-black/10 p-3">
            <div className="flex items-center text-xs font-medium mb-2">
              <span className="truncate">{result.title}</span>
              <button className="ml-auto text-gray-400" onClick={() => setResult(null)}>✕</button>
            </div>
            <pre className="text-[11px] leading-snug max-h-72 overflow-auto whitespace-pre-wrap">{result.body}</pre>
          </div>
        )}
      </div>
    </div>
  );
};

export default MatrixEmulatorPanel;
