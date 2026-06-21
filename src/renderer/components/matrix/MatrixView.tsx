import React, { useEffect, useState, useCallback } from 'react';
import MatrixTaskWizard from './MatrixTaskWizard';

/**
 * 矩阵号主界面 —— 由左侧分组菜单驱动的 4 屏(screen prop):
 *   accounts 我的矩阵号 / newTask 新建矩阵涨粉任务 / tasks 我的矩阵涨粉任务(含详情) / runs 运行记录
 * 全走 window.electron.matrix.*(sidecar IPC);进度走 matrix:progress SSE。
 * 设计参照老客户端 scenario(账号池→任务→调度→详情→运行记录),矩阵自成运行时(指纹内核池)。
 */

type AccountStatus = 'idle' | 'running' | 'login_required' | 'limited' | 'banned';
interface MatrixAccount {
  id: string; platform: string; displayName: string; group?: string; persona?: string; status: AccountStatus;
  proxy?: { protocol?: string; host: string; port: number; username?: string; password?: string; geo?: string; health?: string };
  keywords?: string[]; kernelVersion?: string;
}
interface MatrixTask {
  id: string; platform: string; type: 'engage'; name: string; enabled: boolean; accountIds: string[];
  quota: { daily_like_min?: number; daily_like_max?: number; daily_follow_min?: number; daily_follow_max?: number; daily_comment_min?: number; daily_comment_max?: number };
  concurrency?: number; frequency: string; nextPlannedRunAt?: number; lastRunAt?: number; createdAt: number;
}
interface RunItem { accountId: string; displayName?: string; state: string; reason?: string; counts?: { like: number; follow: number; comment: number } }
interface RunRecord { id: string; taskId: string; taskName: string; platform: string; startedAt: number; finishedAt: number; success: number; failed: number; skipped: number; totals: { like: number; follow: number; comment: number }; items: RunItem[] }
interface ItemResult { accountId: string; state: 'success' | 'failed' | 'skipped'; reason?: string; counts?: { like: number; follow: number; comment: number } }

function parseKeywords(s: string): string[] { return s.split(/[\s,，、\n]+/).map((x) => x.trim()).filter(Boolean); }

const PLATFORMS = ['douyin', 'xhs', 'bilibili', 'shipinhao', 'kuaishou', 'toutiao', 'tiktok', 'x'];
const PLATFORM_LABEL: Record<string, string> = { douyin: '抖音', xhs: '小红书', bilibili: 'B站', shipinhao: '视频号', kuaishou: '快手', toutiao: '头条', tiktok: 'TikTok', x: 'X' };
const LOGIN_URL: Record<string, string> = {
  douyin: 'https://www.douyin.com/', xhs: 'https://www.xiaohongshu.com/', bilibili: 'https://passport.bilibili.com/login',
  shipinhao: 'https://channels.weixin.qq.com/', kuaishou: 'https://www.kuaishou.com/', toutiao: 'https://mp.toutiao.com/',
  tiktok: 'https://www.tiktok.com/login', x: 'https://x.com/login',
};
const STATUS_DOT: Record<AccountStatus, string> = { idle: 'bg-green-500', running: 'bg-blue-500', login_required: 'bg-amber-500', limited: 'bg-gray-400', banned: 'bg-red-500' };
const STATUS_LABEL: Record<AccountStatus, string> = { idle: '已就绪', running: '运行中', login_required: '需登录', limited: '限流冷却', banned: '已封' };
const FREQ_LABEL: Record<string, string> = { once: '不重复(手动)', '30min': '每30分钟', '1h': '每小时', '3h': '每3小时', '6h': '每6小时', daily_random: '每日随机一次' };

const M = () => (window as any).electron?.matrix;
const fmtTime = (ts?: number) => { if (!ts || ts >= Number.MAX_SAFE_INTEGER) return '—'; const d = new Date(ts); return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

interface Props { screen?: 'accounts' | 'newTask' | 'tasks' | 'runs'; onNavigate?: (s: string) => void; isSidebarCollapsed?: boolean; onToggleSidebar?: () => void }

const MatrixView: React.FC<Props> = ({ screen = 'accounts', onNavigate }) => {
  const [accounts, setAccounts] = useState<MatrixAccount[]>([]);
  const [tasks, setTasks] = useState<MatrixTask[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [platform, setPlatform] = useState<string>('douyin');
  const [kernelPath, setKernelPath] = useState<string>(() => localStorage.getItem('matrix:kernelPath') || '');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  // 进度
  const [items, setItems] = useState<Record<string, ItemResult>>({});
  const [logs, setLogs] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);
  const [doneReport, setDoneReport] = useState<any>(null);

  // 账号弹窗 + 通知
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newGroup, setNewGroup] = useState('');
  const [newPersona, setNewPersona] = useState('');
  const [newKeywords, setNewKeywords] = useState('');
  const [notice, setNotice] = useState('');

  // 代理弹窗
  const [proxyFor, setProxyFor] = useState<string | null>(null);
  const [proxyForm, setProxyForm] = useState({ protocol: 'socks5', host: '', port: '', username: '', password: '', geo: '' });

  // 任务编辑(用 MatrixTaskWizard,样式照搬老客户端 DouyinConfigWizard)
  const [taskEditId, setTaskEditId] = useState<string | null>(null);
  const [showTaskEditModal, setShowTaskEditModal] = useState(false);
  const [showNewWizard, setShowNewWizard] = useState(false); // 新建页:点卡片才弹向导

  // 内核
  const [kernel, setKernel] = useState<{ installed?: boolean; installedVersion?: string; configuredVersion?: string; needsUpdate?: boolean }>({});
  const [kernelMsg, setKernelMsg] = useState('');
  const [kernelBusy, setKernelBusy] = useState(false);
  const [kernelPct, setKernelPct] = useState(0);
  const [showKernelModal, setShowKernelModal] = useState(false);

  const reload = useCallback(async () => { const r = await M()?.listAccounts(); if (r?.ok) setAccounts(r.accounts || []); }, []);
  const reloadTasks = useCallback(async () => { const r = await M()?.listTasks?.(); if (r?.ok) { setTasks(r.tasks || []); if (typeof r.running === 'boolean') setRunning(r.running); } }, []);
  const reloadRuns = useCallback(async () => { const r = await M()?.listRuns?.(); if (r?.ok) setRuns(r.runs || []); }, []);

  useEffect(() => { reload(); reloadTasks(); }, [reload, reloadTasks]);
  useEffect(() => { if (screen === 'runs') reloadRuns(); }, [screen, reloadRuns]);

  useEffect(() => {
    const off = M()?.onProgress?.((p: any) => {
      if (p?.type === 'taskStart') { setItems({}); setLogs([]); setDoneReport(null); setRunning(true); setRunningTaskId(p.taskId || null); }
      else if (p?.type === 'item') setItems((prev) => ({ ...prev, [p.accountId]: { accountId: p.accountId, state: p.state, reason: p.reason, counts: p.counts } }));
      else if (p?.type === 'log') setLogs((prev) => [`[${p.accountId}] ${p.msg}`, ...prev].slice(0, 200));
      else if (p?.type === 'done') { setRunning(false); setRunningTaskId(null); setDoneReport(p.report); reload(); reloadTasks(); reloadRuns(); }
      else if (p?.type === 'error') { setRunning(false); setRunningTaskId(null); setLogs((prev) => [`任务错误: ${p.error}`, ...prev]); reloadTasks(); }
    });
    return () => { if (typeof off === 'function') off(); };
  }, [reload, reloadTasks, reloadRuns]);

  useEffect(() => { const off = M()?.onAccount?.(() => { reload(); }); return () => { if (typeof off === 'function') off(); }; }, [reload]);
  useEffect(() => { localStorage.setItem('matrix:kernelPath', kernelPath); }, [kernelPath]);
  useEffect(() => { const h = setInterval(() => { reloadTasks(); }, 30000); return () => clearInterval(h); }, [reloadTasks]);

  const loadKernel = useCallback(() => { M()?.kernelStatus?.().then((r: any) => setKernel(r || {})); }, []);
  useEffect(() => {
    loadKernel();
    const off = M()?.onKernel?.((p: any) => { if (typeof p?.pct === 'number') setKernelPct(p.pct); setKernelMsg(p?.msg || ''); if (p?.done) { setKernelBusy(false); loadKernel(); } });
    return () => { if (typeof off === 'function') off(); };
  }, [loadKernel]);

  const downloadKernel = async () => { setShowKernelModal(true); setKernelBusy(true); setKernelPct(0); setKernelMsg('准备下载…'); await M()?.ensureKernel(); };

  const platformAccounts = accounts.filter((a) => a.platform === platform);
  const platformTasks = tasks.filter((t) => t.platform === platform);
  const kernelReady = !!kernel.installed || !!kernelPath.trim();
  const requireKernel = (): boolean => { if (kernelReady) return true; setShowKernelModal(true); return false; };

  // ── 账号 ──
  const openAdd = () => { if (!requireKernel()) return; setEditId(null); setNewName(''); setNewGroup(''); setNewPersona(''); setNewKeywords(''); setNotice(''); setShowAdd(true); };
  const openEdit = (a: MatrixAccount) => { setEditId(a.id); setNewName(a.displayName); setNewGroup(a.group || ''); setNewPersona(a.persona || ''); setNewKeywords((a.keywords || []).join(' ')); setNotice(''); setShowAdd(true); };
  const confirmAdd = async (thenLogin: boolean) => {
    const m = M(); if (!m) { setNotice('matrix 接口未就绪'); return; }
    const keywords = parseKeywords(newKeywords); const group = newGroup.trim() || undefined; const persona = newPersona.trim() || undefined;
    if (editId) { await m.updateAccountMeta({ id: editId, displayName: newName.trim() || undefined, group, persona, keywords }); setShowAdd(false); await reload(); setNotice('已更新'); return; }
    const name = newName.trim(); if (!name) { setNotice('请填账号备注名'); return; }
    const r = await m.createAccount({ platform, displayName: name, group, persona, keywords });
    setShowAdd(false);
    if (r?.ok) { await reload(); setNotice(thenLogin ? '已建号,正在打开指纹浏览器扫码…成功后状态自动变「已就绪」' : `已建号:${name}`); if (thenLogin && r.account) await m.openLogin({ accountId: r.account.id, kernelPath, loginUrl: LOGIN_URL[platform] || '' }); }
    else setNotice('创建失败:' + (r?.error || 'IPC 未响应'));
  };
  const refreshLogin = async (a: MatrixAccount) => { const r = await M()?.checkLogin?.({ accountId: a.id, platform: a.platform }); if (r?.loggedIn) { setNotice(`${a.displayName} 已登录 ✓`); await reload(); } else setNotice(`${a.displayName} 还没检测到登录——确认扫码完成、窗口停在平台页`); };
  const openProxy = (a: MatrixAccount) => { setProxyForm({ protocol: a.proxy?.protocol || 'socks5', host: a.proxy?.host || '', port: a.proxy?.port ? String(a.proxy.port) : '', username: a.proxy?.username || '', password: a.proxy?.password || '', geo: a.proxy?.geo || '' }); setProxyFor(a.id); };
  const saveProxy = async () => {
    const host = proxyForm.host.trim(); const port = Number(proxyForm.port);
    if (!host || !Number.isInteger(port) || port <= 0) { setNotice('请填写正确的代理 host 和 port'); return; }
    await M()?.setAccountProxy({ id: proxyFor, proxy: { protocol: proxyForm.protocol, host, port, username: proxyForm.username.trim() || undefined, password: proxyForm.password.trim() || undefined, geo: proxyForm.geo.trim() || undefined } });
    setProxyFor(null); await reload(); setNotice('已绑定代理 IP');
  };

  // ── 任务 ──
  // 向导(MatrixTaskWizard)保存:成功回 tasks 屏;失败抛出让向导显示红字。
  const saveTaskFromWizard = async (input: { name: string; accountIds: string[]; concurrency: number; frequency: string; quota: any }) => {
    const r = await M()?.saveTask({ id: taskEditId || undefined, platform, type: 'engage', name: input.name, accountIds: input.accountIds, quota: input.quota, concurrency: input.concurrency, frequency: input.frequency, enabled: true });
    if (!r?.ok) throw new Error(({ platform_task_limit: '该平台任务已达 5 个上限', duplicate_type: '该平台已有同类型(互动)任务,直接编辑它即可', task_not_found: '任务不存在' } as any)[r?.error] || r?.error || '保存失败');
    await reloadTasks(); setNotice('任务已保存');
    setShowTaskEditModal(false); setTaskEditId(null);
    onNavigate?.('tasks');
  };
  const runTaskNow = async (t: MatrixTask) => {
    if (!requireKernel()) return;
    if (running) { setNotice('已有任务在跑,同时只能跑一个'); return; }
    setItems({}); setLogs([]); setDoneReport(null); setRunning(true); setSelectedTaskId(t.id);
    const r = await M()?.runTaskById({ taskId: t.id, kernelPath });
    if (!r?.ok) { setRunning(false); setNotice('启动失败:' + (r?.error === 'another_task_running' ? '已有任务在跑' : r?.error || '未知')); }
  };
  const stopTask = async () => { setNotice('已请求停止,正在关闭窗口…'); await M()?.stopTask?.(); };
  const toggleTask = async (t: MatrixTask) => { await M()?.setTaskEnabled({ id: t.id, enabled: !t.enabled }); await reloadTasks(); };
  const deleteTask = async (t: MatrixTask) => { await M()?.removeTask({ id: t.id }); setSelectedTaskId(null); await reloadTasks(); };

  // ── 复用片段 ──
  const renderProgress = () => (
    <div className="mt-4">
      {doneReport && <div className="mb-3 text-sm p-3 rounded-lg bg-black/5 dark:bg-white/10">完成:成功 {doneReport.success} · 失败 {doneReport.failed} · 跳过 {doneReport.skipped}</div>}
      <div className="grid grid-cols-2 gap-2 mb-3">
        {Object.values(items).map((it) => {
          const acc = accounts.find((a) => a.id === it.accountId);
          const color = it.state === 'success' ? 'text-green-500' : it.state === 'skipped' ? 'text-amber-500' : 'text-red-500';
          return (
            <div key={it.accountId} className="flex items-center gap-2 text-sm p-2 rounded border dark:border-white/10 border-black/10">
              <span className={color}>●</span><span className="flex-1 truncate">{acc?.displayName || it.accountId}</span>
              {it.counts && <span className="text-xs opacity-60">赞{it.counts.like}/关{it.counts.follow}/评{it.counts.comment}</span>}
              <span className="text-xs opacity-60">{it.state}{it.reason ? `:${it.reason}` : ''}</span>
            </div>
          );
        })}
      </div>
      <div className="text-xs font-mono opacity-60 space-y-0.5 max-h-56 overflow-auto">{logs.map((l, i) => <div key={i}>{l}</div>)}</div>
    </div>
  );

  const selectedTask = tasks.find((t) => t.id === selectedTaskId) || null;
  const SCREEN_TITLE: Record<string, string> = { accounts: '我的矩阵号', newTask: '新建矩阵涨粉任务', tasks: '我的矩阵涨粉任务', runs: '矩阵涨粉运行记录' };

  return (
    <div className="h-full flex flex-col dark:text-claude-darkText text-claude-text">
      <div className="flex items-center gap-2 px-5 py-3 border-b dark:border-white/10 border-black/10">
        <h1 className="text-lg font-medium mr-4">{SCREEN_TITLE[screen] || '矩阵号'}</h1>
        <div className="ml-auto flex items-center gap-2">
          <span className={`text-xs px-2 py-0.5 rounded ${kernel.installed && !kernel.needsUpdate ? 'bg-green-500/15 text-green-500' : 'bg-amber-500/15 text-amber-500'}`}>
            {kernel.installed ? (kernel.needsUpdate ? `内核 ${kernel.installedVersion}(有新版)` : `内核 ${kernel.installedVersion || ''} ✓`) : '内核 未安装'}
          </span>
          {(!kernel.installed || kernel.needsUpdate) && <button onClick={downloadKernel} disabled={kernelBusy} className="text-xs px-2 py-1 rounded-lg bg-claude-accent text-white disabled:opacity-50">{kernelBusy ? '下载中…' : (kernel.needsUpdate ? '更新内核' : '下载内核')}</button>}
          {kernelMsg && <span className="text-xs opacity-60 max-w-[180px] truncate">{kernelMsg}</span>}
          <input value={kernelPath} onChange={(e) => setKernelPath(e.target.value)} placeholder="或手动指定内核路径" className="text-xs px-2 py-1.5 w-40 rounded border dark:border-white/15 border-black/15 bg-transparent" />
        </div>
      </div>

      {notice && (
        <div className="mx-5 mt-3 text-sm px-3 py-2 rounded-lg bg-claude-accent/10 text-claude-accent flex items-center justify-between">
          <span>{notice}</span><button onClick={() => setNotice('')} className="opacity-60 hover:opacity-100 ml-3">✕</button>
        </div>
      )}

      <div className="flex-1 overflow-auto p-5">
        {/* 我的矩阵号 —— 账号池(卡片样式对齐老客户端) */}
        {screen === 'accounts' && (
          <div className="max-w-6xl mx-auto">
            <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
              <h2 className="text-lg font-bold dark:text-white">🧬 我的矩阵号</h2>
              <div className="flex items-center gap-2">
                <select value={platform} onChange={(e) => setPlatform(e.target.value)} className="text-sm px-2.5 py-1.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 dark:text-white">
                  {PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}
                </select>
                <button onClick={openAdd} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-white text-sm font-semibold bg-violet-500 hover:bg-violet-600 shadow-sm shadow-violet-500/25 active:scale-95 transition-all">+ 添加账号</button>
              </div>
            </div>
            {platformAccounts.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-700 p-10 text-center">
                <div className="text-4xl mb-2">📭</div>
                <div className="text-sm text-gray-500 dark:text-gray-400 mb-4">该平台还没有账号</div>
                <button onClick={openAdd} className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl text-white text-sm font-semibold bg-violet-500 hover:bg-violet-600 shadow-sm shadow-violet-500/25 active:scale-95">+ 添加{PLATFORM_LABEL[platform]}账号</button>
              </div>
            ) : (
              <div className="space-y-3">
                {platformAccounts.map((a, idx) => (
                  <div key={a.id} className="flex items-center gap-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4">
                    <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${STATUS_DOT[a.status]}`} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium dark:text-white">{a.displayName}{a.group ? <span className="text-gray-400 font-normal"> · {a.group}</span> : ''}{a.persona ? <span className="text-gray-400 font-normal"> · 人设✓</span> : ''}</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5">{a.keywords && a.keywords.length ? `🏷️ ${a.keywords.join(' · ')}` : <span className="text-amber-500">未配关键词(互动需要)</span>}</div>
                    </div>
                    {a.proxy
                      ? <button onClick={() => openProxy(a)} className="text-[11px] px-2 py-1 rounded-full border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300">🌐 {a.proxy.geo || a.proxy.host}</button>
                      : <button onClick={() => openProxy(a)} className={`text-[11px] px-2 py-1 rounded-full border ${idx === 0 ? 'border-gray-300 dark:border-gray-700 text-gray-500' : 'text-amber-500 border-amber-500/40'}`}>{idx === 0 ? '本地IP(默认)' : 'IP 未配·点配'}</button>}
                    <span className={`text-[11px] px-2 py-1 rounded-full border ${a.status === 'idle' ? 'text-green-500 border-green-500/30 bg-green-500/10' : a.status === 'login_required' ? 'text-amber-500 border-amber-500/30 bg-amber-500/10' : 'border-gray-300 dark:border-gray-700 text-gray-500'}`}>{STATUS_LABEL[a.status]}</span>
                    <button onClick={() => openEdit(a)} className="text-xs px-2.5 py-1 rounded-lg border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800">编辑</button>
                    {a.status === 'login_required' && (<>
                      <button onClick={() => { if (!requireKernel()) return; setNotice(`正在为「${a.displayName}」打开指纹浏览器,扫码后状态自动刷新`); M()?.openLogin({ accountId: a.id, kernelPath, loginUrl: LOGIN_URL[a.platform] || '' }); }} className="text-xs px-2.5 py-1 rounded-lg bg-violet-500 text-white hover:bg-violet-600">扫码登录</button>
                      <button onClick={() => refreshLogin(a)} className="text-xs px-2.5 py-1 rounded-lg border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800">刷新状态</button>
                    </>)}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 新建矩阵涨粉任务 —— 平台 tab + 场景卡片入口(照抄 DouyinWorkflowsPage),点卡片弹向导 */}
        {screen === 'newTask' && (
          <div className="max-w-6xl mx-auto">
            <div className="flex flex-wrap gap-2 mb-6">
              {PLATFORMS.map((p) => (
                <button key={p} onClick={() => setPlatform(p)} className={`px-3.5 py-1.5 rounded-full text-sm border transition-colors ${platform === p ? 'border-violet-500 bg-violet-500/10 text-violet-500 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-violet-500/50'}`}>{PLATFORM_LABEL[p]}</button>
              ))}
            </div>
            {platform === 'douyin' ? (
              <>
                <section className="mb-6 grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="relative rounded-2xl border border-violet-500/30 bg-gradient-to-br from-violet-500/10 via-purple-500/5 to-transparent p-5 overflow-hidden flex flex-col">
                    <div className="absolute -top-16 -right-16 w-40 h-40 rounded-full bg-violet-500/10 blur-3xl pointer-events-none" />
                    <div className="relative flex flex-col flex-1">
                      <div className="inline-flex items-center gap-1.5 text-xs font-medium text-violet-500 mb-2"><span className="inline-block w-1.5 h-1.5 rounded-full bg-violet-500 animate-pulse" />互动涨粉</div>
                      <h3 className="text-base font-bold dark:text-white mb-1.5">🎶 抖音 · 互动涨粉(矩阵)</h3>
                      <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed mb-3 flex-1">同时控制多个账号,每个号在自己的指纹浏览器里、按【自己的赛道关键词】搜抖音视频,按你配的随机区间做点赞 / 关注 / 评论。评论由 AI 按视频文案 + 该号人设自动生成,行为间隔随机模拟真人。赛道/关键词/人设在「我的矩阵号」给每个号设。</p>
                      <button onClick={() => { if (!requireKernel()) return; setShowNewWizard(true); }} className="w-full py-2.5 rounded-lg text-sm font-semibold text-white bg-violet-500 hover:bg-violet-600 shadow-lg shadow-violet-500/25">🎶 开始互动 →</button>
                    </div>
                  </div>
                </section>
                <section className="mb-6">
                  <div className="flex flex-wrap gap-2 justify-center">
                    {[['🛡️', '完全模拟人类行为不封号'], ['🚀', '多号并发 · 涨粉快'], ['💰', '成本超低'], ['🤖', '全智能控制']].map(([icon, t]) => (
                      <span key={t} className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full border border-violet-500/20 bg-violet-500/5 text-gray-700 dark:text-gray-300">{icon} {t}</span>
                    ))}
                  </div>
                </section>
              </>
            ) : (
              <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-700 p-10 text-center text-sm text-gray-500 dark:text-gray-400">{PLATFORM_LABEL[platform]} 互动后续接入,目前先做抖音。</div>
            )}
            {showNewWizard && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 overflow-auto">
                <MatrixTaskWizard
                  platformLabel={PLATFORM_LABEL[platform]}
                  accounts={platformAccounts as any}
                  initialTask={null}
                  onCancel={() => setShowNewWizard(false)}
                  onSave={async (input) => { await saveTaskFromWizard(input); setShowNewWizard(false); }}
                />
              </div>
            )}
          </div>
        )}

        {/* 我的矩阵涨粉任务(列表)—— 卡片样式对齐老客户端 MyTasksPage */}
        {screen === 'tasks' && !selectedTask && (
          <div className="max-w-6xl mx-auto">
            <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
              <h2 className="text-lg font-bold dark:text-white">📋 我的{PLATFORM_LABEL[platform]}涨粉任务</h2>
              <div className="flex items-center gap-2">
                <select value={platform} onChange={(e) => setPlatform(e.target.value)} className="text-sm px-2.5 py-1.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 dark:text-white">
                  {PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}
                </select>
                <button onClick={() => onNavigate?.('newTask')} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-white text-sm font-semibold bg-violet-500 hover:bg-violet-600 shadow-sm shadow-violet-500/25 active:scale-95 transition-all">🎶 新建任务</button>
              </div>
            </div>
            {platformTasks.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-700 p-10 text-center">
                <div className="text-4xl mb-2">📭</div>
                <div className="text-sm text-gray-500 dark:text-gray-400 mb-4">还没有{PLATFORM_LABEL[platform]}涨粉任务</div>
                <button onClick={() => onNavigate?.('newTask')} className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl text-white text-sm font-semibold bg-violet-500 hover:bg-violet-600 shadow-sm shadow-violet-500/25 active:scale-95">🎶 新建{PLATFORM_LABEL[platform]}互动任务</button>
              </div>
            ) : (
              <div className="space-y-3">
                {platformTasks.map((t) => {
                  const isRunning = runningTaskId === t.id;
                  return (
                    <button key={t.id} type="button" onClick={() => setSelectedTaskId(t.id)}
                      className={`w-full text-left rounded-xl border p-4 transition-colors relative ${isRunning ? 'border-green-500 ring-2 ring-green-500/30 bg-white dark:bg-gray-900' : 'border-gray-200 dark:border-gray-700 hover:border-violet-500/50 dark:hover:border-violet-500/50 bg-white dark:bg-gray-900'}`}>
                      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300">🎵 {PLATFORM_LABEL[t.platform]}</span>
                          <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border text-violet-500 bg-violet-500/10 border-violet-500/30">🎶 互动涨粉</span>
                          <span className="font-medium dark:text-white truncate">{t.name}</span>
                          <span className="text-[10px] text-gray-500 font-mono shrink-0">#{t.id.slice(0, 8)}</span>
                        </div>
                        <div className="shrink-0">
                          {isRunning ? (
                            <span className="text-xs px-2 py-1 rounded bg-green-500/10 text-green-500 border border-green-500/30 flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />运行中</span>
                          ) : t.frequency === 'once' ? (
                            <span className="text-xs px-2 py-1 rounded bg-purple-500/10 text-purple-500 border border-purple-500/30">✋ 手动运行</span>
                          ) : t.enabled ? (
                            <span className="text-xs px-2 py-1 rounded bg-blue-500/10 text-blue-500 border border-blue-500/30">⏰ {fmtTime(t.nextPlannedRunAt)}</span>
                          ) : (
                            <span className="text-xs px-2 py-1 rounded bg-gray-500/10 text-gray-500 border border-gray-500/30">⏸ 已停用</span>
                          )}
                        </div>
                      </div>
                      <div className="text-xs text-gray-600 dark:text-gray-300 mb-1">👥 账号 {t.accountIds.length} 个 · 各用自己的赛道关键词</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">⏰ {FREQ_LABEL[t.frequency] || t.frequency} · 👍 {t.quota.daily_like_min}-{t.quota.daily_like_max} · ➕ {t.quota.daily_follow_min}-{t.quota.daily_follow_max} · 💬 {t.quota.daily_comment_min}-{t.quota.daily_comment_max} / 次</div>
                      <div className="text-[11px] text-gray-400 mt-1">{t.lastRunAt ? `上次运行 ${fmtTime(t.lastRunAt)}` : '尚未运行'}</div>
                      <div className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-800 flex items-center justify-end">
                        {isRunning
                          ? <span onClick={(e) => { e.stopPropagation(); stopTask(); }} className="text-xs px-3 py-1 rounded-lg font-semibold bg-red-500 text-white hover:bg-red-600">⏹ 停止</span>
                          : <span onClick={(e) => { e.stopPropagation(); runTaskNow(t); }} className={`text-xs px-3 py-1 rounded-lg font-semibold ${running ? 'bg-gray-300 text-gray-500 dark:bg-gray-700' : 'bg-violet-500 text-white hover:bg-violet-600'}`}>🎯 运行</span>}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {/* 任务详情 —— 对齐老客户端 TaskDetailPage(摘要卡 + 运行中 glow + 运行历史) */}
        {screen === 'tasks' && selectedTask && (
          <div className="max-w-3xl mx-auto">
            <button onClick={() => setSelectedTaskId(null)} className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 mb-3">← 返回任务列表</button>
            <div className="flex items-center gap-2 mb-4 flex-wrap">
              <h2 className="text-lg font-bold dark:text-white">{selectedTask.name}</h2>
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border text-violet-500 bg-violet-500/10 border-violet-500/30">🎶 互动涨粉</span>
              <div className="ml-auto flex gap-2">
                {runningTaskId === selectedTask.id
                  ? <button onClick={stopTask} className="px-4 py-2 rounded-lg text-sm font-semibold bg-red-500 text-white hover:bg-red-600">⏹ 停止</button>
                  : <button onClick={() => runTaskNow(selectedTask)} disabled={running} className="px-4 py-2 rounded-lg text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-50">{running ? '运行中…' : '🎯 直接运行'}</button>}
                {selectedTask.frequency !== 'once' && <button onClick={() => toggleTask(selectedTask)} className="px-3 py-2 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800">{selectedTask.enabled ? '停用定时' : '启用定时'}</button>}
                <button onClick={() => { setTaskEditId(selectedTask.id); setShowTaskEditModal(true); }} className="px-3 py-2 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800">编辑</button>
                <button onClick={() => deleteTask(selectedTask)} className="px-3 py-2 rounded-lg text-sm font-medium border border-red-500/40 text-red-500 hover:bg-red-500/5">删除</button>
              </div>
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-4 py-3 text-sm space-y-1.5 mb-4">
              <div className="font-semibold dark:text-gray-200 mb-1">📋 任务摘要</div>
              <div className="flex gap-3 text-xs"><span className="text-gray-500 dark:text-gray-400 w-20 shrink-0">频率</span><span className="text-gray-800 dark:text-gray-200">{FREQ_LABEL[selectedTask.frequency] || selectedTask.frequency}{selectedTask.frequency !== 'once' && selectedTask.enabled ? ` · 下次 ${fmtTime(selectedTask.nextPlannedRunAt)}` : ''}</span></div>
              <div className="flex gap-3 text-xs"><span className="text-gray-500 dark:text-gray-400 w-20 shrink-0">配额/次</span><span className="text-gray-800 dark:text-gray-200">👍 {selectedTask.quota.daily_like_min}-{selectedTask.quota.daily_like_max} · ➕ {selectedTask.quota.daily_follow_min}-{selectedTask.quota.daily_follow_max} · 💬 {selectedTask.quota.daily_comment_min}-{selectedTask.quota.daily_comment_max} · 同时开窗 {selectedTask.concurrency || 3}</span></div>
              <div className="flex gap-3 text-xs"><span className="text-gray-500 dark:text-gray-400 w-20 shrink-0">账号({selectedTask.accountIds.length})</span><span className="text-gray-800 dark:text-gray-200 break-all">{selectedTask.accountIds.map((id) => accounts.find((a) => a.id === id)?.displayName || id).join('、')}</span></div>
            </div>
            {(running || Object.keys(items).length > 0) && (
              <div className="rounded-xl border border-green-500/40 bg-green-500/5 p-4 mb-4">
                <div className="text-sm font-semibold text-green-600 dark:text-green-400 mb-1">本次运行进度</div>
                {renderProgress()}
              </div>
            )}
            <h3 className="text-sm font-bold dark:text-white mb-2">🕑 运行历史</h3>
            <div className="space-y-2">
              {runs.filter((r) => r.taskId === selectedTask.id).slice(0, 20).map((r) => (
                <div key={r.id} className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-xs flex items-center gap-3">
                  <span className="text-gray-500">{fmtTime(r.startedAt)}</span>
                  <span className="text-green-500">成功 {r.success}</span><span className="text-red-500">失败 {r.failed}</span><span className="text-amber-500">跳过 {r.skipped}</span>
                  <span className="ml-auto text-gray-600 dark:text-gray-300">👍{r.totals.like} ➕{r.totals.follow} 💬{r.totals.comment}</span>
                </div>
              ))}
              {runs.filter((r) => r.taskId === selectedTask.id).length === 0 && <div className="text-xs text-gray-400">还没有运行记录。</div>}
            </div>
          </div>
        )}

        {/* 矩阵涨粉运行记录 —— 对齐老客户端 RunHistoryPage */}
        {screen === 'runs' && (
          <div className="max-w-4xl mx-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold dark:text-white">🕑 矩阵涨粉运行记录</h2>
              <button onClick={reloadRuns} className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800">刷新</button>
            </div>
            {runs.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-700 p-10 text-center">
                <div className="text-4xl mb-2">📭</div>
                <div className="text-sm text-gray-500 dark:text-gray-400">还没有运行记录。去「我的矩阵涨粉任务」跑一个任务。</div>
              </div>
            ) : (
              <div className="space-y-3">
                {runs.map((r) => (
                  <div key={r.id} className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4">
                    <div className="flex items-center gap-2 mb-2 flex-wrap">
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300">🎵 {PLATFORM_LABEL[r.platform] || r.platform}</span>
                      <span className="font-medium dark:text-white">{r.taskName}</span>
                      <span className="text-xs text-gray-500">{fmtTime(r.startedAt)}</span>
                      <span className="ml-auto text-xs"><span className="text-green-500">成功 {r.success}</span> · <span className="text-red-500">失败 {r.failed}</span> · <span className="text-amber-500">跳过 {r.skipped}</span></span>
                    </div>
                    <div className="text-xs text-gray-600 dark:text-gray-300 mb-1">合计 👍 {r.totals.like} · ➕ {r.totals.follow} · 💬 {r.totals.comment}</div>
                    <div className="text-[11px] text-gray-400 truncate">{r.items.map((it) => `${it.displayName || it.accountId}(${it.state === 'success' ? '成功' : it.state === 'skipped' ? '跳过' : '失败'})`).join('、')}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 添加/编辑账号 */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-[26rem] rounded-xl p-5 dark:bg-claude-darkBg bg-white border dark:border-white/10 border-black/10">
            <div className="text-sm font-medium mb-3">{editId ? '编辑账号' : `添加 ${PLATFORM_LABEL[platform]} 账号`}</div>
            <input autoFocus={!editId} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="账号备注名(如:美食1号)" className="w-full text-sm px-3 py-2 rounded border dark:border-white/15 border-black/15 bg-transparent mb-2" />
            <input value={newGroup} onChange={(e) => setNewGroup(e.target.value)} placeholder="赛道/分组(如:美食,可选)" className="w-full text-sm px-3 py-2 rounded border dark:border-white/15 border-black/15 bg-transparent mb-2" />
            <textarea value={newPersona} onChange={(e) => setNewPersona(e.target.value)} placeholder="人设(可选)—— 自动评论时 AI 按这个口吻写" rows={2} className="w-full text-sm px-3 py-2 rounded border dark:border-white/15 border-black/15 bg-transparent mb-2" />
            <textarea value={newKeywords} onChange={(e) => setNewKeywords(e.target.value)} placeholder="赛道关键词,空格/逗号分隔(如:美食 探店 家常菜)" rows={2} className="w-full text-sm px-3 py-2 rounded border dark:border-white/15 border-black/15 bg-transparent mb-3" />
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowAdd(false)} className="px-3 py-1.5 text-sm rounded-lg border dark:border-white/15 border-black/15">取消</button>
              {editId ? <button onClick={() => confirmAdd(false)} className="px-3 py-1.5 text-sm rounded-lg bg-claude-accent text-white">保存</button>
                : (<><button onClick={() => confirmAdd(false)} className="px-3 py-1.5 text-sm rounded-lg border dark:border-white/15 border-black/15">仅创建</button><button onClick={() => confirmAdd(true)} className="px-3 py-1.5 text-sm rounded-lg bg-claude-accent text-white">创建并扫码登录</button></>)}
            </div>
          </div>
        </div>
      )}

      {/* 编辑任务弹窗(详情页用)—— 同一个向导 */}
      {showTaskEditModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 overflow-auto">
          <MatrixTaskWizard
            platformLabel={PLATFORM_LABEL[platform]}
            accounts={platformAccounts as any}
            initialTask={tasks.find((t) => t.id === taskEditId) || null}
            onCancel={() => { setShowTaskEditModal(false); setTaskEditId(null); }}
            onSave={saveTaskFromWizard}
          />
        </div>
      )}

      {/* 内核下载 */}
      {showKernelModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-[26rem] rounded-xl p-5 dark:bg-claude-darkBg bg-white border dark:border-white/10 border-black/10">
            <div className="text-sm font-medium mb-1">指纹浏览器内核</div>
            {kernel.installed && !kernelBusy ? (
              <div className="text-sm text-green-500 my-3">✓ 内核已就绪{kernel.installedVersion ? `(v${kernel.installedVersion})` : ''},现在可以添加账号 / 扫码登录 / 跑任务了。</div>
            ) : (
              <>
                <div className="text-sm opacity-70 my-3">矩阵号需要专属指纹浏览器内核才能运行(独立指纹隔离,普通 Chrome 无法替代)。内核约 130MB,只需下载一次。</div>
                {(kernelBusy || kernelPct > 0) && (
                  <div className="mb-3"><div className="h-2 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden"><div className="h-full bg-claude-accent transition-all duration-200" style={{ width: `${Math.max(2, kernelPct)}%` }} /></div><div className="text-xs opacity-60 mt-1">{kernelMsg || '准备中…'}{kernelBusy ? ` · ${kernelPct}%` : ''}</div></div>
                )}
                {!kernelBusy && kernelMsg && !kernel.installed && <div className="text-xs text-red-500 mb-2">{kernelMsg}</div>}
              </>
            )}
            <div className="flex justify-end gap-2 mt-2">
              <button onClick={() => setShowKernelModal(false)} className="px-3 py-1.5 text-sm rounded-lg border dark:border-white/15 border-black/15">关闭</button>
              {!kernel.installed && <button onClick={downloadKernel} disabled={kernelBusy} className="px-3 py-1.5 text-sm rounded-lg bg-claude-accent text-white disabled:opacity-50">{kernelBusy ? '下载中…' : (kernelPct > 0 ? '重试下载' : '开始下载')}</button>}
            </div>
          </div>
        </div>
      )}

      {/* 代理 */}
      {proxyFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-[26rem] rounded-xl p-5 dark:bg-claude-darkBg bg-white border dark:border-white/10 border-black/10">
            <div className="text-sm font-medium mb-1">绑定代理 IP</div>
            <div className="text-xs opacity-60 mb-3">多开同平台必须每号一个独立 IP,否则同 IP 会被风控。第一个号可留空走本地 IP。</div>
            <div className="flex gap-2 mb-2">
              <select value={proxyForm.protocol} onChange={(e) => setProxyForm((f) => ({ ...f, protocol: e.target.value }))} className="text-sm px-2 py-2 rounded border dark:border-white/15 border-black/15 bg-transparent">
                <option value="socks5">socks5</option><option value="socks5h">socks5h</option><option value="http">http</option><option value="https">https</option>
              </select>
              <input value={proxyForm.host} onChange={(e) => setProxyForm((f) => ({ ...f, host: e.target.value }))} placeholder="host(如 1.2.3.4)" className="flex-1 text-sm px-3 py-2 rounded border dark:border-white/15 border-black/15 bg-transparent" />
              <input value={proxyForm.port} onChange={(e) => setProxyForm((f) => ({ ...f, port: e.target.value.replace(/[^0-9]/g, '') }))} placeholder="port" className="w-20 text-sm px-2 py-2 rounded border dark:border-white/15 border-black/15 bg-transparent" />
            </div>
            <div className="flex gap-2 mb-2">
              <input value={proxyForm.username} onChange={(e) => setProxyForm((f) => ({ ...f, username: e.target.value }))} placeholder="用户名(可选)" className="flex-1 text-sm px-3 py-2 rounded border dark:border-white/15 border-black/15 bg-transparent" />
              <input value={proxyForm.password} onChange={(e) => setProxyForm((f) => ({ ...f, password: e.target.value }))} placeholder="密码(可选)" className="flex-1 text-sm px-3 py-2 rounded border dark:border-white/15 border-black/15 bg-transparent" />
            </div>
            <input value={proxyForm.geo} onChange={(e) => setProxyForm((f) => ({ ...f, geo: e.target.value }))} placeholder="归属地标注(可选,仅显示用)" className="w-full text-sm px-3 py-2 rounded border dark:border-white/15 border-black/15 bg-transparent mb-3" />
            <div className="flex justify-end gap-2">
              <button onClick={() => setProxyFor(null)} className="px-3 py-1.5 text-sm rounded-lg border dark:border-white/15 border-black/15">取消</button>
              <button onClick={saveProxy} className="px-3 py-1.5 text-sm rounded-lg bg-claude-accent text-white">保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MatrixView;
