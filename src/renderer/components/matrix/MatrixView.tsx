import React, { useEffect, useState, useCallback } from 'react';

/**
 * 矩阵号主界面 —— 三屏:我的账号 / 矩阵发布 / 执行进度。
 * 全走 window.electron.matrix.*(sidecar IPC);进度走 matrix:progress SSE。
 * 约束:一次只一个平台、多号多窗。
 */

type AccountStatus = 'idle' | 'running' | 'login_required' | 'limited' | 'banned';
interface MatrixAccount {
  id: string;
  platform: string;
  displayName: string;
  group?: string;
  status: AccountStatus;
  proxy?: { host: string; port: number; geo?: string; health?: string };
  keywords?: string[];
  kernelVersion?: string;
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
// 各平台登录入口(扫码登录时导航到这里,而不是空白页)
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

const M = () => (window as any).electron?.matrix;

interface Props {
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
}

const MatrixView: React.FC<Props> = () => {
  const [tab, setTab] = useState<'accounts' | 'engage' | 'publish' | 'progress'>('accounts');
  const [quota, setQuota] = useState({ daily_like_min: 3, daily_like_max: 8, daily_follow_min: 0, daily_follow_max: 2, daily_comment_min: 1, daily_comment_max: 3 });
  const [accounts, setAccounts] = useState<MatrixAccount[]>([]);
  const [kernelPath, setKernelPath] = useState<string>(() => localStorage.getItem('matrix:kernelPath') || '');

  // 发布配置
  const [platform, setPlatform] = useState<string>('douyin');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [videoPath, setVideoPath] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [concurrency, setConcurrency] = useState(3);

  // 进度
  const [items, setItems] = useState<Record<string, ItemResult>>({});
  const [logs, setLogs] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [doneReport, setDoneReport] = useState<any>(null);

  // 添加账号弹窗 + 通知(Tauri webview 不支持原生 prompt/alert/confirm,全走 app 内 UI)
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null); // null=新建,否则编辑该号关键词
  const [newName, setNewName] = useState('');
  const [newKeywords, setNewKeywords] = useState('');
  const [notice, setNotice] = useState('');

  // 指纹内核(单版本,按需下载/更新)
  const [kernel, setKernel] = useState<{ installed?: boolean; installedVersion?: string; configuredVersion?: string; needsUpdate?: boolean }>({});
  const [kernelMsg, setKernelMsg] = useState('');
  const [kernelBusy, setKernelBusy] = useState(false);

  const reload = useCallback(async () => {
    const r = await M()?.listAccounts();
    if (r?.ok) setAccounts(r.accounts || []);
  }, []);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    const off = M()?.onProgress?.((p: any) => {
      if (p?.type === 'item') {
        setItems((prev) => ({ ...prev, [p.accountId]: { accountId: p.accountId, state: p.state, reason: p.reason, counts: p.counts } }));
      } else if (p?.type === 'log') {
        setLogs((prev) => [`[${p.accountId}] ${p.msg}`, ...prev].slice(0, 200));
      } else if (p?.type === 'done') {
        setRunning(false); setDoneReport(p.report); reload();
      } else if (p?.type === 'error') {
        setRunning(false); setLogs((prev) => [`任务错误: ${p.error}`, ...prev]);
      }
    });
    return () => { if (typeof off === 'function') off(); };
  }, [reload]);

  useEffect(() => { localStorage.setItem('matrix:kernelPath', kernelPath); }, [kernelPath]);

  const loadKernel = useCallback(() => {
    M()?.kernelStatus?.().then((r: any) => setKernel(r || {}));
  }, []);

  // 内核状态 + 下载进度订阅
  useEffect(() => {
    loadKernel();
    const off = M()?.onKernel?.((p: any) => {
      setKernelMsg(p?.msg || '');
      if (p?.done) { setKernelBusy(false); loadKernel(); }
    });
    return () => { if (typeof off === 'function') off(); };
  }, [loadKernel]);

  const downloadKernel = async () => { setKernelBusy(true); setKernelMsg('准备下载…'); await M()?.ensureKernel(); };

  const platformAccounts = accounts.filter((a) => a.platform === platform);

  const toggleSel = (id: string) => {
    setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  const openAdd = () => { setEditId(null); setNewName(''); setNewKeywords(''); setNotice(''); setShowAdd(true); };
  const openEditKeywords = (a: MatrixAccount) => {
    setEditId(a.id); setNewName(a.displayName); setNewKeywords((a.keywords || []).join(' ')); setNotice(''); setShowAdd(true);
  };

  const confirmAdd = async (thenLogin: boolean) => {
    const m = M();
    if (!m) { setNotice('matrix 接口未就绪(请确认运行的是矩阵版)'); return; }
    const keywords = parseKeywords(newKeywords);

    // 编辑模式:只改关键词
    if (editId) {
      await m.setAccountKeywords({ id: editId, keywords });
      setShowAdd(false); await reload(); setNotice('已更新'); return;
    }

    const name = newName.trim();
    if (!name) { setNotice('请填账号备注名'); return; }
    const r = await m.createAccount({ platform, displayName: name, keywords });
    setShowAdd(false);
    if (r?.ok) {
      await reload();
      setNotice(thenLogin ? '已建号,正在打开指纹浏览器扫码…' : `已建号:${name}`);
      if (thenLogin && r.account) {
        await m.openLogin({ accountId: r.account.id, kernelPath, loginUrl: LOGIN_URL[platform] || '' });
      }
    } else {
      setNotice('创建失败:' + (r?.error || 'IPC 未响应'));
    }
  };

  const startEngage = async () => {
    const ids = [...selected].filter((id) => {
      const a = accounts.find((x) => x.id === id);
      return a && a.keywords && a.keywords.length > 0;
    });
    if (!ids.length) { setNotice('请勾选【已配赛道关键词】的账号'); setTab('engage'); return; }
    setNotice('');
    setItems({}); setLogs([]); setDoneReport(null); setRunning(true); setTab('progress');
    await M()?.runEngage({ platform, accountIds: ids, concurrency, kernelPath, quota });
  };

  const startTask = async () => {
    const ids = [...selected];
    if (!ids.length) { setNotice('请先勾选账号'); setTab('publish'); return; }
    if (!videoPath) { setNotice('请填视频文件路径'); setTab('publish'); return; }
    setNotice('');
    setItems({}); setLogs([]); setDoneReport(null); setRunning(true); setTab('progress');
    await M()?.runTask({
      platform, accountIds: ids, concurrency, kernelPath,
      input: { videoPath, title, description, tags: [] },
    });
  };

  // ── 渲染 ──
  const Tab = ({ id, label }: { id: typeof tab; label: string }) => (
    <button
      onClick={() => setTab(id)}
      className={`px-4 py-2 text-sm rounded-lg ${tab === id ? 'bg-claude-accent text-white' : 'dark:text-claude-darkText text-claude-text hover:bg-black/5 dark:hover:bg-white/5'}`}
    >{label}</button>
  );

  return (
    <div className="h-full flex flex-col dark:text-claude-darkText text-claude-text">
      <div className="flex items-center gap-2 px-5 py-3 border-b dark:border-white/10 border-black/10">
        <h1 className="text-lg font-medium mr-4">矩阵号</h1>
        <Tab id="accounts" label={`我的账号 (${accounts.length})`} />
        <Tab id="engage" label="自动互动" />
        <Tab id="publish" label="矩阵发布" />
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
          <input
            value={kernelPath} onChange={(e) => setKernelPath(e.target.value)}
            placeholder="或手动指定内核路径"
            className="text-xs px-2 py-1.5 w-40 rounded border dark:border-white/15 border-black/15 bg-transparent"
          />
        </div>
      </div>

      {notice && (
        <div className="mx-5 mt-3 text-sm px-3 py-2 rounded-lg bg-claude-accent/10 text-claude-accent flex items-center justify-between">
          <span>{notice}</span>
          <button onClick={() => setNotice('')} className="opacity-60 hover:opacity-100 ml-3">✕</button>
        </div>
      )}

      <div className="flex-1 overflow-auto p-5">
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
              {platformAccounts.map((a) => (
                <div key={a.id} className="flex items-center gap-3 p-3 rounded-lg border dark:border-white/10 border-black/10">
                  <span className={`w-2.5 h-2.5 rounded-full ${STATUS_DOT[a.status]}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm">{a.displayName}{a.group ? ` · ${a.group}` : ''}</div>
                    <div className="text-xs opacity-50 truncate">
                      {a.keywords && a.keywords.length
                        ? `赛道词: ${a.keywords.join(' / ')}`
                        : <span className="text-amber-500">未配赛道关键词(互动需要)</span>}
                    </div>
                  </div>
                  <span className="text-xs px-2 py-0.5 rounded bg-black/5 dark:bg-white/10">
                    {a.proxy ? `IP ${a.proxy.geo || a.proxy.host}` : 'IP 未配'}
                  </span>
                  <span className="text-xs px-2 py-0.5 rounded bg-black/5 dark:bg-white/10">{STATUS_LABEL[a.status]}</span>
                  <button onClick={() => openEditKeywords(a)} className="text-xs px-2 py-1 rounded border dark:border-white/15 border-black/15">改词</button>
                  {a.status === 'login_required' && (
                    <button onClick={() => M()?.openLogin({ accountId: a.id, kernelPath, loginUrl: LOGIN_URL[a.platform] || '' })} className="text-xs px-2 py-1 rounded border dark:border-white/15 border-black/15">扫码登录</button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'engage' && (
          <div className="max-w-2xl space-y-5">
            <div className="text-sm opacity-70">控制多个抖音号,按各自赛道关键词自动【点赞 / 评论 / 关注】。每号在独立指纹浏览器里跑、错峰。</div>
            <div>
              <div className="text-sm mb-2">① 平台</div>
              <div className="flex flex-wrap gap-2">
                {PLATFORMS.filter((p) => p === 'douyin').map((p) => (
                  <button key={p} onClick={() => { setPlatform(p); setSelected(new Set()); }}
                    className={`px-3 py-1.5 text-sm rounded-lg border ${platform === p ? 'bg-claude-accent text-white border-transparent' : 'dark:border-white/15 border-black/15'}`}>{PLATFORM_LABEL[p]}</button>
                ))}
                <span className="text-xs opacity-50 self-center">(其他平台互动后续接入)</span>
              </div>
            </div>
            <div>
              <div className="text-sm mb-2">② 选账号 <span className="opacity-50">(需已配赛道关键词;已选 {selected.size})</span></div>
              <div className="space-y-1.5">
                {platformAccounts.length === 0 && <div className="text-sm opacity-50">该平台无账号,先去「我的账号」添加。</div>}
                {platformAccounts.map((a) => {
                  const hasKw = !!(a.keywords && a.keywords.length);
                  return (
                    <label key={a.id} className={`flex items-center gap-2 text-sm ${hasKw ? '' : 'opacity-40'}`}>
                      <input type="checkbox" disabled={!hasKw} checked={selected.has(a.id)} onChange={() => toggleSel(a.id)} />
                      <span className={`w-2 h-2 rounded-full ${STATUS_DOT[a.status]}`} />
                      {a.displayName}
                      <span className="opacity-50 text-xs">{hasKw ? `[${a.keywords!.join('/')}]` : '未配关键词'}</span>
                    </label>
                  );
                })}
              </div>
            </div>
            <div>
              <div className="text-sm mb-2">③ 每号配额(区间内随机)</div>
              <div className="grid grid-cols-3 gap-3 text-sm">
                {([['点赞', 'daily_like_min', 'daily_like_max'], ['关注', 'daily_follow_min', 'daily_follow_max'], ['评论', 'daily_comment_min', 'daily_comment_max']] as const).map(([label, kMin, kMax]) => (
                  <div key={label} className="p-2 rounded-lg border dark:border-white/10 border-black/10">
                    <div className="text-xs opacity-60 mb-1">{label}</div>
                    <div className="flex items-center gap-1">
                      <input type="number" min={0} value={(quota as any)[kMin]} onChange={(e) => setQuota((q) => ({ ...q, [kMin]: Number(e.target.value) || 0 }))} className="w-12 text-sm px-1 py-1 rounded border dark:border-white/15 border-black/15 bg-transparent" />
                      <span className="opacity-50">~</span>
                      <input type="number" min={0} value={(quota as any)[kMax]} onChange={(e) => setQuota((q) => ({ ...q, [kMax]: Number(e.target.value) || 0 }))} className="w-12 text-sm px-1 py-1 rounded border dark:border-white/15 border-black/15 bg-transparent" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm">④ 同时开窗</span>
              <input type="number" min={1} max={10} value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value) || 1)} className="w-16 text-sm px-2 py-1 rounded border dark:border-white/15 border-black/15 bg-transparent" />
              <button onClick={startEngage} disabled={running} className="ml-auto px-5 py-2 rounded-lg bg-claude-accent text-white text-sm disabled:opacity-50">{running ? '互动中…' : '开始自动互动'}</button>
            </div>
          </div>
        )}

        {tab === 'publish' && (
          <div className="max-w-2xl space-y-5">
            <div>
              <div className="text-sm mb-2">① 选平台 <span className="opacity-50">(一次只能一个)</span></div>
              <div className="flex flex-wrap gap-2">
                {PLATFORMS.map((p) => (
                  <button key={p} onClick={() => { setPlatform(p); setSelected(new Set()); }}
                    className={`px-3 py-1.5 text-sm rounded-lg border ${platform === p ? 'bg-claude-accent text-white border-transparent' : 'dark:border-white/15 border-black/15'}`}>
                    {PLATFORM_LABEL[p]}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="text-sm mb-2">② 选账号 <span className="opacity-50">(已选 {selected.size})</span></div>
              <div className="space-y-1.5">
                {platformAccounts.length === 0 && <div className="text-sm opacity-50">该平台无账号,先去「我的账号」添加。</div>}
                {platformAccounts.map((a) => (
                  <label key={a.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggleSel(a.id)} />
                    <span className={`w-2 h-2 rounded-full ${STATUS_DOT[a.status]}`} />
                    {a.displayName} <span className="opacity-50 text-xs">{STATUS_LABEL[a.status]}</span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <div className="text-sm mb-2">③ 内容(MVP:同一条铺所有号;差异化产片后续接入)</div>
              <input value={videoPath} onChange={(e) => setVideoPath(e.target.value)} placeholder="视频文件绝对路径 (.mp4)" className="w-full text-sm px-3 py-2 rounded border dark:border-white/15 border-black/15 bg-transparent mb-2" />
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="标题" className="w-full text-sm px-3 py-2 rounded border dark:border-white/15 border-black/15 bg-transparent mb-2" />
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="正文 / 描述" rows={3} className="w-full text-sm px-3 py-2 rounded border dark:border-white/15 border-black/15 bg-transparent" />
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm">④ 同时开窗</span>
              <input type="number" min={1} max={10} value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value) || 1)} className="w-16 text-sm px-2 py-1 rounded border dark:border-white/15 border-black/15 bg-transparent" />
              <button onClick={startTask} disabled={running} className="ml-auto px-5 py-2 rounded-lg bg-claude-accent text-white text-sm disabled:opacity-50">
                {running ? '发布中…' : '开始发布'}
              </button>
            </div>
          </div>
        )}

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
              {Object.keys(items).length === 0 && !running && <div className="text-sm opacity-50">还没有运行记录。去「矩阵发布」开始一个任务。</div>}
            </div>
            <div className="text-xs font-mono opacity-60 space-y-0.5 max-h-64 overflow-auto">
              {logs.map((l, i) => <div key={i}>{l}</div>)}
            </div>
          </div>
        )}
      </div>

      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-96 rounded-xl p-5 dark:bg-claude-darkBg bg-white border dark:border-white/10 border-black/10">
            <div className="text-sm font-medium mb-3">{editId ? '编辑赛道关键词' : `添加 ${PLATFORM_LABEL[platform]} 账号`}</div>
            {!editId && (
              <input
                autoFocus value={newName} onChange={(e) => setNewName(e.target.value)}
                placeholder="账号备注名(如:美食1号)"
                className="w-full text-sm px-3 py-2 rounded border dark:border-white/15 border-black/15 bg-transparent mb-3"
              />
            )}
            <textarea
              value={newKeywords} onChange={(e) => setNewKeywords(e.target.value)}
              placeholder="赛道关键词,空格/逗号分隔(如:美食 探店 家常菜)—— 自动互动时按这些词搜内容去点赞/评论/关注"
              rows={3}
              className="w-full text-sm px-3 py-2 rounded border dark:border-white/15 border-black/15 bg-transparent mb-3"
            />
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
    </div>
  );
};

export default MatrixView;
