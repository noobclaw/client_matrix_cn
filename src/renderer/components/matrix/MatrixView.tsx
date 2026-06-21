import React, { useEffect, useState, useCallback } from 'react';

/**
 * 矩阵号主界面 —— 三屏:我的账号 / 矩阵任务 / 执行进度。
 * 全走 window.electron.matrix.*(sidecar IPC);进度走 matrix:progress SSE。
 * 约束:一次只一个平台多窗;全局同时只跑一个任务。
 * 设计参照老客户端 scenario 任务(配额/频率/任务列表),矩阵自成运行时(走指纹内核池)。
 */

type AccountStatus = 'idle' | 'running' | 'login_required' | 'limited' | 'banned';
interface MatrixAccount {
  id: string;
  platform: string;
  displayName: string;
  group?: string;
  persona?: string;
  status: AccountStatus;
  proxy?: { protocol?: string; host: string; port: number; username?: string; password?: string; geo?: string; health?: string };
  keywords?: string[];
  kernelVersion?: string;
}
interface MatrixTask {
  id: string; platform: string; type: 'engage'; name: string; enabled: boolean;
  accountIds: string[];
  quota: { daily_like_min?: number; daily_like_max?: number; daily_follow_min?: number; daily_follow_max?: number; daily_comment_min?: number; daily_comment_max?: number };
  concurrency?: number; frequency: string; nextPlannedRunAt?: number; lastRunAt?: number; createdAt: number;
}

function parseKeywords(s: string): string[] {
  return s.split(/[\s,，、\n]+/).map((x) => x.trim()).filter(Boolean);
}
interface ItemResult { accountId: string; state: 'success' | 'failed' | 'skipped'; reason?: string; counts?: { like: number; follow: number; comment: number } }

const PLATFORMS = ['douyin', 'xhs', 'bilibili', 'shipinhao', 'kuaishou', 'toutiao', 'tiktok', 'x'];
const PLATFORM_LABEL: Record<string, string> = {
  douyin: '抖音', xhs: '小红书', bilibili: 'B站', shipinhao: '视频号',
  kuaishou: '快手', toutiao: '头条', tiktok: 'TikTok', x: 'X',
};
const LOGIN_URL: Record<string, string> = {
  douyin: 'https://www.douyin.com/',
  xhs: 'https://www.xiaohongshu.com/',
  bilibili: 'https://passport.bilibili.com/login',
  shipinhao: 'https://channels.weixin.qq.com/',
  kuaishou: 'https://www.kuaishou.com/',
  toutiao: 'https://mp.toutiao.com/',
  tiktok: 'https://www.tiktok.com/login',
  x: 'https://x.com/login',
};
const STATUS_DOT: Record<AccountStatus, string> = {
  idle: 'bg-green-500', running: 'bg-blue-500', login_required: 'bg-amber-500',
  limited: 'bg-gray-400', banned: 'bg-red-500',
};
const STATUS_LABEL: Record<AccountStatus, string> = {
  idle: '已就绪', running: '运行中', login_required: '需登录', limited: '限流冷却', banned: '已封',
};
// 运行频率(对齐老客户端 DouyinConfigWizard)
const FREQ_OPTS = ['once', '30min', '1h', '3h', '6h', 'daily_random'];
const FREQ_LABEL: Record<string, string> = {
  once: '不重复(手动)', '30min': '每30分钟', '1h': '每小时', '3h': '每3小时', '6h': '每6小时', daily_random: '每日随机一次',
};

const M = () => (window as any).electron?.matrix;

interface Props { isSidebarCollapsed?: boolean; onToggleSidebar?: () => void }

const MatrixView: React.FC<Props> = () => {
  const [tab, setTab] = useState<'accounts' | 'tasks' | 'progress'>('accounts');
  const [accounts, setAccounts] = useState<MatrixAccount[]>([]);
  const [tasks, setTasks] = useState<MatrixTask[]>([]);
  const [platform, setPlatform] = useState<string>('douyin');
  const [kernelPath, setKernelPath] = useState<string>(() => localStorage.getItem('matrix:kernelPath') || '');

  // 进度
  const [items, setItems] = useState<Record<string, ItemResult>>({});
  const [logs, setLogs] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [doneReport, setDoneReport] = useState<any>(null);

  // 添加/编辑账号弹窗 + 通知
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newGroup, setNewGroup] = useState('');
  const [newPersona, setNewPersona] = useState('');
  const [newKeywords, setNewKeywords] = useState('');
  const [notice, setNotice] = useState('');

  // 代理配置弹窗
  const [proxyFor, setProxyFor] = useState<string | null>(null);
  const [proxyForm, setProxyForm] = useState({ protocol: 'socks5', host: '', port: '', username: '', password: '', geo: '' });

  // 任务编辑弹窗
  const [showTaskEditor, setShowTaskEditor] = useState(false);
  const [taskEditId, setTaskEditId] = useState<string | null>(null);
  const [taskName, setTaskName] = useState('');
  const [taskAccountIds, setTaskAccountIds] = useState<Set<string>>(new Set());
  const [taskQuota, setTaskQuota] = useState({ daily_like_min: 3, daily_like_max: 8, daily_follow_min: 0, daily_follow_max: 2, daily_comment_min: 1, daily_comment_max: 3 });
  const [taskFreq, setTaskFreq] = useState('once');
  const [taskConc, setTaskConc] = useState(3);

  // 指纹内核
  const [kernel, setKernel] = useState<{ installed?: boolean; installedVersion?: string; configuredVersion?: string; needsUpdate?: boolean }>({});
  const [kernelMsg, setKernelMsg] = useState('');
  const [kernelBusy, setKernelBusy] = useState(false);
  const [kernelPct, setKernelPct] = useState(0);
  const [showKernelModal, setShowKernelModal] = useState(false);

  const reload = useCallback(async () => {
    const r = await M()?.listAccounts(); if (r?.ok) setAccounts(r.accounts || []);
  }, []);
  const reloadTasks = useCallback(async () => {
    const r = await M()?.listTasks?.(); if (r?.ok) { setTasks(r.tasks || []); if (typeof r.running === 'boolean') setRunning(r.running); }
  }, []);

  useEffect(() => { reload(); reloadTasks(); }, [reload, reloadTasks]);

  useEffect(() => {
    const off = M()?.onProgress?.((p: any) => {
      if (p?.type === 'taskStart') { setItems({}); setLogs([]); setDoneReport(null); setRunning(true); }
      else if (p?.type === 'item') setItems((prev) => ({ ...prev, [p.accountId]: { accountId: p.accountId, state: p.state, reason: p.reason, counts: p.counts } }));
      else if (p?.type === 'log') setLogs((prev) => [`[${p.accountId}] ${p.msg}`, ...prev].slice(0, 200));
      else if (p?.type === 'done') { setRunning(false); setDoneReport(p.report); reload(); reloadTasks(); }
      else if (p?.type === 'error') { setRunning(false); setLogs((prev) => [`任务错误: ${p.error}`, ...prev]); reloadTasks(); }
    });
    return () => { if (typeof off === 'function') off(); };
  }, [reload, reloadTasks]);

  useEffect(() => {
    const off = M()?.onAccount?.(() => { reload(); });
    return () => { if (typeof off === 'function') off(); };
  }, [reload]);

  useEffect(() => { localStorage.setItem('matrix:kernelPath', kernelPath); }, [kernelPath]);

  const loadKernel = useCallback(() => { M()?.kernelStatus?.().then((r: any) => setKernel(r || {})); }, []);
  useEffect(() => {
    loadKernel();
    const off = M()?.onKernel?.((p: any) => {
      if (typeof p?.pct === 'number') setKernelPct(p.pct);
      setKernelMsg(p?.msg || '');
      if (p?.done) { setKernelBusy(false); loadKernel(); }
    });
    return () => { if (typeof off === 'function') off(); };
  }, [loadKernel]);

  // 定时调度在 sidecar 跑(切到别的页面也不停);这里只轻量轮询同步状态/下次运行时间。
  useEffect(() => {
    const h = setInterval(() => { reloadTasks(); }, 30000);
    return () => clearInterval(h);
  }, [reloadTasks]);

  const downloadKernel = async () => { setShowKernelModal(true); setKernelBusy(true); setKernelPct(0); setKernelMsg('准备下载…'); await M()?.ensureKernel(); };

  const platformAccounts = accounts.filter((a) => a.platform === platform);
  const platformTasks = tasks.filter((t) => t.platform === platform);
  const kernelReady = !!kernel.installed || !!kernelPath.trim();
  const requireKernel = (): boolean => { if (kernelReady) return true; setShowKernelModal(true); return false; };

  // ── 账号 ──
  const openAdd = () => { if (!requireKernel()) return; setEditId(null); setNewName(''); setNewGroup(''); setNewPersona(''); setNewKeywords(''); setNotice(''); setShowAdd(true); };
  const openEdit = (a: MatrixAccount) => {
    setEditId(a.id); setNewName(a.displayName); setNewGroup(a.group || ''); setNewPersona(a.persona || '');
    setNewKeywords((a.keywords || []).join(' ')); setNotice(''); setShowAdd(true);
  };
  const confirmAdd = async (thenLogin: boolean) => {
    const m = M(); if (!m) { setNotice('matrix 接口未就绪(请确认运行的是矩阵版)'); return; }
    const keywords = parseKeywords(newKeywords);
    const group = newGroup.trim() || undefined;
    const persona = newPersona.trim() || undefined;
    if (editId) {
      await m.updateAccountMeta({ id: editId, displayName: newName.trim() || undefined, group, persona, keywords });
      setShowAdd(false); await reload(); setNotice('已更新'); return;
    }
    const name = newName.trim();
    if (!name) { setNotice('请填账号备注名'); return; }
    const r = await m.createAccount({ platform, displayName: name, group, persona, keywords });
    setShowAdd(false);
    if (r?.ok) {
      await reload();
      setNotice(thenLogin ? '已建号,正在打开指纹浏览器扫码…扫码成功后状态会自动变「已就绪」' : `已建号:${name}`);
      if (thenLogin && r.account) await m.openLogin({ accountId: r.account.id, kernelPath, loginUrl: LOGIN_URL[platform] || '' });
    } else setNotice('创建失败:' + (r?.error || 'IPC 未响应'));
  };
  const refreshLogin = async (a: MatrixAccount) => {
    const r = await M()?.checkLogin?.({ accountId: a.id, platform: a.platform });
    if (r?.loggedIn) { setNotice(`${a.displayName} 已登录 ✓`); await reload(); }
    else setNotice(`${a.displayName} 还没检测到登录——请确认扫码完成、且该号窗口停在平台页面`);
  };
  const openProxy = (a: MatrixAccount) => {
    setProxyForm({ protocol: a.proxy?.protocol || 'socks5', host: a.proxy?.host || '', port: a.proxy?.port ? String(a.proxy.port) : '', username: a.proxy?.username || '', password: a.proxy?.password || '', geo: a.proxy?.geo || '' });
    setProxyFor(a.id);
  };
  const saveProxy = async () => {
    const host = proxyForm.host.trim(); const port = Number(proxyForm.port);
    if (!host || !Number.isInteger(port) || port <= 0) { setNotice('请填写正确的代理 host 和 port'); return; }
    await M()?.setAccountProxy({ id: proxyFor, proxy: { protocol: proxyForm.protocol, host, port, username: proxyForm.username.trim() || undefined, password: proxyForm.password.trim() || undefined, geo: proxyForm.geo.trim() || undefined } });
    setProxyFor(null); await reload(); setNotice('已绑定代理 IP(该号此后固定走这个出口)');
  };

  // ── 任务 ──
  const openNewTask = () => {
    if (!requireKernel()) return;
    setTaskEditId(null); setTaskName(`${PLATFORM_LABEL[platform]}互动`); setTaskAccountIds(new Set());
    setTaskQuota({ daily_like_min: 3, daily_like_max: 8, daily_follow_min: 0, daily_follow_max: 2, daily_comment_min: 1, daily_comment_max: 3 });
    setTaskFreq('once'); setTaskConc(3); setShowTaskEditor(true);
  };
  const openEditTask = (t: MatrixTask) => {
    setTaskEditId(t.id); setTaskName(t.name); setTaskAccountIds(new Set(t.accountIds || []));
    setTaskQuota({ daily_like_min: t.quota.daily_like_min ?? 3, daily_like_max: t.quota.daily_like_max ?? 8, daily_follow_min: t.quota.daily_follow_min ?? 0, daily_follow_max: t.quota.daily_follow_max ?? 2, daily_comment_min: t.quota.daily_comment_min ?? 1, daily_comment_max: t.quota.daily_comment_max ?? 3 });
    setTaskFreq(t.frequency || 'once'); setTaskConc(t.concurrency || 3); setShowTaskEditor(true);
  };
  const saveTaskNow = async () => {
    const ids = [...taskAccountIds];
    if (!ids.length) { setNotice('请至少勾选一个已登录账号'); return; }
    const r = await M()?.saveTask({ id: taskEditId || undefined, platform, type: 'engage', name: taskName.trim() || `${PLATFORM_LABEL[platform]}互动`, accountIds: ids, quota: taskQuota, concurrency: taskConc, frequency: taskFreq, enabled: true });
    if (r?.ok) { setShowTaskEditor(false); await reloadTasks(); setNotice('任务已保存'); }
    else setNotice('保存失败:' + ({ platform_task_limit: '该平台任务已达 5 个上限', duplicate_type: '该平台已有同类型(互动)任务,直接编辑它即可', task_not_found: '任务不存在' } as any)[r?.error] || r?.error || '未知错误');
  };
  const runTaskNow = async (t: MatrixTask) => {
    if (!requireKernel()) return;
    if (running) { setNotice('已有任务在跑,同时只能跑一个'); return; }
    setItems({}); setLogs([]); setDoneReport(null); setRunning(true); setTab('progress');
    const r = await M()?.runTaskById({ taskId: t.id, kernelPath });
    if (!r?.ok) { setRunning(false); setNotice('启动失败:' + (r?.error === 'another_task_running' ? '已有任务在跑' : r?.error || '未知')); }
  };
  const toggleTask = async (t: MatrixTask) => { await M()?.setTaskEnabled({ id: t.id, enabled: !t.enabled }); await reloadTasks(); };
  const deleteTask = async (t: MatrixTask) => { await M()?.removeTask({ id: t.id }); await reloadTasks(); };
  const toggleTaskAcc = (id: string) => setTaskAccountIds((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // ── 渲染 ──
  const Tab = ({ id, label }: { id: typeof tab; label: string }) => (
    <button onClick={() => setTab(id)} className={`px-4 py-2 text-sm rounded-lg ${tab === id ? 'bg-claude-accent text-white' : 'dark:text-claude-darkText text-claude-text hover:bg-black/5 dark:hover:bg-white/5'}`}>{label}</button>
  );
  const fmtTime = (ts?: number) => { if (!ts || ts >= Number.MAX_SAFE_INTEGER) return '—'; const d = new Date(ts); return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  // 互动可选账号:已登录(已就绪)且配了关键词
  const eligibleAccounts = platformAccounts.filter((a) => (a.status === 'idle' || a.status === 'limited') && a.keywords && a.keywords.length);

  return (
    <div className="h-full flex flex-col dark:text-claude-darkText text-claude-text">
      <div className="flex items-center gap-2 px-5 py-3 border-b dark:border-white/10 border-black/10">
        <h1 className="text-lg font-medium mr-4">矩阵号</h1>
        <Tab id="accounts" label={`我的账号 (${accounts.length})`} />
        <Tab id="tasks" label="矩阵任务" />
        <Tab id="progress" label="执行进度" />
        <div className="ml-auto flex items-center gap-2">
          <span className={`text-xs px-2 py-0.5 rounded ${kernel.installed && !kernel.needsUpdate ? 'bg-green-500/15 text-green-500' : 'bg-amber-500/15 text-amber-500'}`}>
            {kernel.installed ? (kernel.needsUpdate ? `内核 ${kernel.installedVersion}(有新版 ${kernel.configuredVersion})` : `内核 ${kernel.installedVersion || ''} ✓`) : '内核 未安装'}
          </span>
          {(!kernel.installed || kernel.needsUpdate) && (
            <button onClick={downloadKernel} disabled={kernelBusy} className="text-xs px-2 py-1 rounded-lg bg-claude-accent text-white disabled:opacity-50">
              {kernelBusy ? '下载中…' : (kernel.needsUpdate ? '更新内核' : '下载内核')}
            </button>
          )}
          {kernelMsg && <span className="text-xs opacity-60 max-w-[180px] truncate">{kernelMsg}</span>}
          <input value={kernelPath} onChange={(e) => setKernelPath(e.target.value)} placeholder="或手动指定内核路径" className="text-xs px-2 py-1.5 w-40 rounded border dark:border-white/15 border-black/15 bg-transparent" />
        </div>
      </div>

      {notice && (
        <div className="mx-5 mt-3 text-sm px-3 py-2 rounded-lg bg-claude-accent/10 text-claude-accent flex items-center justify-between">
          <span>{notice}</span>
          <button onClick={() => setNotice('')} className="opacity-60 hover:opacity-100 ml-3">✕</button>
        </div>
      )}

      <div className="flex-1 overflow-auto p-5">
        {/* ── 我的账号 ── */}
        {tab === 'accounts' && (
          <div>
            <div className="flex items-center mb-4">
              <span className="text-sm opacity-70">平台</span>
              <select value={platform} onChange={(e) => setPlatform(e.target.value)} className="ml-2 text-sm px-2 py-1 rounded border dark:border-white/15 border-black/15 bg-transparent">
                {PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}
              </select>
              <button onClick={openAdd} className="ml-auto px-3 py-1.5 text-sm rounded-lg bg-claude-accent text-white">+ 添加账号</button>
            </div>
            <div className="space-y-2">
              {platformAccounts.length === 0 && <div className="text-sm opacity-50 py-8 text-center">该平台还没有账号,点「添加账号」开始。</div>}
              {platformAccounts.map((a, idx) => (
                <div key={a.id} className="flex items-center gap-3 p-3 rounded-lg border dark:border-white/10 border-black/10">
                  <span className={`w-2.5 h-2.5 rounded-full ${STATUS_DOT[a.status]}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm">{a.displayName}{a.group ? ` · ${a.group}` : ''}{a.persona ? <span className="opacity-40"> · 人设✓</span> : ''}</div>
                    <div className="text-xs opacity-50 truncate">
                      {a.keywords && a.keywords.length ? `赛道词: ${a.keywords.join(' / ')}` : <span className="text-amber-500">未配关键词(互动需要)</span>}
                    </div>
                  </div>
                  {/* 第一个号默认本地 IP;其余建议独立代理 */}
                  {a.proxy
                    ? <button onClick={() => openProxy(a)} className="text-xs px-2 py-0.5 rounded border bg-black/5 dark:bg-white/10 dark:border-white/15 border-black/15">IP {a.proxy.geo || a.proxy.host}</button>
                    : <button onClick={() => openProxy(a)} className={`text-xs px-2 py-0.5 rounded border ${idx === 0 ? 'opacity-60 dark:border-white/15 border-black/15' : 'text-amber-500 border-amber-500/40'}`}>{idx === 0 ? '本地IP(默认)' : 'IP 未配·点配'}</button>}
                  <span className="text-xs px-2 py-0.5 rounded bg-black/5 dark:bg-white/10">{STATUS_LABEL[a.status]}</span>
                  <button onClick={() => openEdit(a)} className="text-xs px-2 py-1 rounded border dark:border-white/15 border-black/15">编辑</button>
                  {a.status === 'login_required' && (<>
                    <button onClick={() => { if (!requireKernel()) return; setNotice(`正在为「${a.displayName}」打开指纹浏览器,扫码后状态会自动刷新`); M()?.openLogin({ accountId: a.id, kernelPath, loginUrl: LOGIN_URL[a.platform] || '' }); }} className="text-xs px-2 py-1 rounded border dark:border-white/15 border-black/15">扫码登录</button>
                    <button onClick={() => refreshLogin(a)} className="text-xs px-2 py-1 rounded border dark:border-white/15 border-black/15">刷新状态</button>
                  </>)}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── 矩阵任务 ── */}
        {tab === 'tasks' && (
          <div>
            <div className="flex items-center mb-4">
              <span className="text-sm opacity-70">平台</span>
              <select value={platform} onChange={(e) => setPlatform(e.target.value)} className="ml-2 text-sm px-2 py-1 rounded border dark:border-white/15 border-black/15 bg-transparent">
                {PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}
              </select>
              <span className="ml-3 text-xs opacity-50">每平台最多 5 个任务、同类型只 1 个;全局同时只跑一个</span>
              <button onClick={openNewTask} className="ml-auto px-3 py-1.5 text-sm rounded-lg bg-claude-accent text-white">+ 新建任务</button>
            </div>
            <div className="space-y-2">
              {platformTasks.length === 0 && <div className="text-sm opacity-50 py-8 text-center">该平台还没有任务。点「新建任务」配置点赞/评论/关注 + 频率 + 账号。</div>}
              {platformTasks.map((t) => (
                <div key={t.id} className="p-3 rounded-lg border dark:border-white/10 border-black/10">
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium">{t.name}</span>
                    <span className="text-xs px-2 py-0.5 rounded bg-blue-500/15 text-blue-500">🔥 互动</span>
                    <span className="text-xs px-2 py-0.5 rounded bg-black/5 dark:bg-white/10">{t.frequency === 'once' ? '手动' : (t.enabled ? '定时' : '已停用')}</span>
                    <span className="text-xs opacity-50">{FREQ_LABEL[t.frequency] || t.frequency}</span>
                    <div className="ml-auto flex items-center gap-2">
                      <button onClick={() => runTaskNow(t)} disabled={running} className="text-xs px-3 py-1 rounded-lg bg-claude-accent text-white disabled:opacity-50">{running ? '运行中…' : '运行'}</button>
                      {t.frequency !== 'once' && <button onClick={() => toggleTask(t)} className="text-xs px-2 py-1 rounded border dark:border-white/15 border-black/15">{t.enabled ? '停用' : '启用'}</button>}
                      <button onClick={() => openEditTask(t)} className="text-xs px-2 py-1 rounded border dark:border-white/15 border-black/15">编辑</button>
                      <button onClick={() => deleteTask(t)} className="text-xs px-2 py-1 rounded border border-red-500/40 text-red-500">删除</button>
                    </div>
                  </div>
                  <div className="text-xs opacity-50 mt-1.5">
                    账号 {t.accountIds.length} 个 · 赞{t.quota.daily_like_min}-{t.quota.daily_like_max}/关{t.quota.daily_follow_min}-{t.quota.daily_follow_max}/评{t.quota.daily_comment_min}-{t.quota.daily_comment_max}
                    {t.frequency !== 'once' && t.enabled ? ` · 下次 ${fmtTime(t.nextPlannedRunAt)}` : ''}
                    {t.lastRunAt ? ` · 上次 ${fmtTime(t.lastRunAt)}` : ''}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── 执行进度 ── */}
        {tab === 'progress' && (
          <div>
            {doneReport && (
              <div className="mb-4 text-sm p-3 rounded-lg bg-black/5 dark:bg-white/10">
                完成:成功 {doneReport.success} · 失败 {doneReport.failed} · 跳过 {doneReport.skipped}
                {doneReport.charged ? ` · 扣费 ${doneReport.charged.charged}` : ''}
              </div>
            )}
            <div className="grid grid-cols-2 gap-2 mb-4">
              {Object.values(items).map((it) => {
                const acc = accounts.find((a) => a.id === it.accountId);
                const color = it.state === 'success' ? 'text-green-500' : it.state === 'skipped' ? 'text-amber-500' : 'text-red-500';
                return (
                  <div key={it.accountId} className="flex items-center gap-2 text-sm p-2 rounded border dark:border-white/10 border-black/10">
                    <span className={color}>●</span>
                    <span className="flex-1 truncate">{acc?.displayName || it.accountId}</span>
                    {it.counts && <span className="text-xs opacity-60">赞{it.counts.like}/关{it.counts.follow}/评{it.counts.comment}</span>}
                    <span className="text-xs opacity-60">{it.state}{it.reason ? `:${it.reason}` : ''}</span>
                  </div>
                );
              })}
              {Object.keys(items).length === 0 && !running && <div className="text-sm opacity-50">还没有运行记录。去「矩阵任务」运行一个任务。</div>}
            </div>
            <div className="text-xs font-mono opacity-60 space-y-0.5 max-h-64 overflow-auto">
              {logs.map((l, i) => <div key={i}>{l}</div>)}
            </div>
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
            <textarea value={newPersona} onChange={(e) => setNewPersona(e.target.value)} placeholder="人设(可选)—— 自动评论时 AI 按这个口吻写,如:爱探店的美食博主,语气活泼" rows={2} className="w-full text-sm px-3 py-2 rounded border dark:border-white/15 border-black/15 bg-transparent mb-2" />
            <textarea value={newKeywords} onChange={(e) => setNewKeywords(e.target.value)} placeholder="赛道关键词,空格/逗号分隔(如:美食 探店 家常菜)—— 互动时按这些词搜内容" rows={2} className="w-full text-sm px-3 py-2 rounded border dark:border-white/15 border-black/15 bg-transparent mb-3" />
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowAdd(false)} className="px-3 py-1.5 text-sm rounded-lg border dark:border-white/15 border-black/15">取消</button>
              {editId ? (
                <button onClick={() => confirmAdd(false)} className="px-3 py-1.5 text-sm rounded-lg bg-claude-accent text-white">保存</button>
              ) : (<>
                <button onClick={() => confirmAdd(false)} className="px-3 py-1.5 text-sm rounded-lg border dark:border-white/15 border-black/15">仅创建</button>
                <button onClick={() => confirmAdd(true)} className="px-3 py-1.5 text-sm rounded-lg bg-claude-accent text-white">创建并扫码登录</button>
              </>)}
            </div>
          </div>
        </div>
      )}

      {/* 任务编辑 */}
      {showTaskEditor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-[32rem] max-h-[90vh] overflow-auto rounded-xl p-5 dark:bg-claude-darkBg bg-white border dark:border-white/10 border-black/10">
            <div className="text-sm font-medium mb-3">{taskEditId ? '编辑任务' : `新建 ${PLATFORM_LABEL[platform]} 互动任务`}</div>
            <input value={taskName} onChange={(e) => setTaskName(e.target.value)} placeholder="任务名" className="w-full text-sm px-3 py-2 rounded border dark:border-white/15 border-black/15 bg-transparent mb-3" />

            <div className="text-sm mb-1.5">① 选账号 <span className="opacity-50">(已登录且配了关键词;已选 {taskAccountIds.size})</span></div>
            <div className="space-y-1 mb-3 max-h-32 overflow-auto">
              {eligibleAccounts.length === 0 && <div className="text-xs opacity-50">没有可用账号——需「已就绪」且配了关键词。先去「我的账号」登录/配词。</div>}
              {eligibleAccounts.map((a) => (
                <label key={a.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={taskAccountIds.has(a.id)} onChange={() => toggleTaskAcc(a.id)} />
                  <span className={`w-2 h-2 rounded-full ${STATUS_DOT[a.status]}`} />
                  {a.displayName}<span className="opacity-50 text-xs">[{a.keywords!.join('/')}]</span>
                </label>
              ))}
            </div>

            <div className="text-sm mb-1.5">② 每号配额(区间内随机)</div>
            <div className="grid grid-cols-3 gap-2 text-sm mb-3">
              {([['点赞', 'daily_like_min', 'daily_like_max'], ['关注', 'daily_follow_min', 'daily_follow_max'], ['评论', 'daily_comment_min', 'daily_comment_max']] as const).map(([label, kMin, kMax]) => (
                <div key={label} className="p-2 rounded-lg border dark:border-white/10 border-black/10">
                  <div className="text-xs opacity-60 mb-1">{label}</div>
                  <div className="flex items-center gap-1">
                    <input type="number" min={0} value={(taskQuota as any)[kMin]} onChange={(e) => setTaskQuota((q) => ({ ...q, [kMin]: Number(e.target.value) || 0 }))} className="w-11 text-sm px-1 py-1 rounded border dark:border-white/15 border-black/15 bg-transparent" />
                    <span className="opacity-50">~</span>
                    <input type="number" min={0} value={(taskQuota as any)[kMax]} onChange={(e) => setTaskQuota((q) => ({ ...q, [kMax]: Number(e.target.value) || 0 }))} className="w-11 text-sm px-1 py-1 rounded border dark:border-white/15 border-black/15 bg-transparent" />
                  </div>
                </div>
              ))}
            </div>

            <div className="text-sm mb-1.5">③ 运行频率</div>
            <div className="flex flex-wrap gap-2 mb-3">
              {FREQ_OPTS.map((f) => (
                <button key={f} onClick={() => setTaskFreq(f)} className={`px-3 py-1 text-xs rounded-lg border ${taskFreq === f ? 'bg-claude-accent text-white border-transparent' : 'dark:border-white/15 border-black/15'}`}>{FREQ_LABEL[f]}</button>
              ))}
            </div>

            <div className="flex items-center gap-3 mb-4">
              <span className="text-sm">④ 同时开窗</span>
              <input type="number" min={1} max={10} value={taskConc} onChange={(e) => setTaskConc(Number(e.target.value) || 1)} className="w-16 text-sm px-2 py-1 rounded border dark:border-white/15 border-black/15 bg-transparent" />
            </div>

            <div className="flex justify-end gap-2">
              <button onClick={() => setShowTaskEditor(false)} className="px-3 py-1.5 text-sm rounded-lg border dark:border-white/15 border-black/15">取消</button>
              <button onClick={saveTaskNow} className="px-3 py-1.5 text-sm rounded-lg bg-claude-accent text-white">保存任务</button>
            </div>
          </div>
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
                  <div className="mb-3">
                    <div className="h-2 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden"><div className="h-full bg-claude-accent transition-all duration-200" style={{ width: `${Math.max(2, kernelPct)}%` }} /></div>
                    <div className="text-xs opacity-60 mt-1">{kernelMsg || '准备中…'}{kernelBusy ? ` · ${kernelPct}%` : ''}</div>
                  </div>
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
            <div className="text-xs opacity-60 mb-3">多开同平台必须每号一个独立 IP,否则同 IP 会被风控(扫码登录第二个号常因此失败)。第一个号可留空走本地 IP。</div>
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
            <input value={proxyForm.geo} onChange={(e) => setProxyForm((f) => ({ ...f, geo: e.target.value }))} placeholder="归属地标注(可选,如 上海;仅显示用)" className="w-full text-sm px-3 py-2 rounded border dark:border-white/15 border-black/15 bg-transparent mb-3" />
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
