import React, { useEffect, useState, useCallback } from 'react';
import MatrixTaskWizard from './MatrixTaskWizard';
import { WalletBadge } from '../common/WalletBadge';

/**
 * 矩阵号主界面 —— 由左侧分组菜单驱动的 4 屏(screen prop):
 *   accounts 我的矩阵账号 / newTask 新建矩阵涨粉任务 / tasks 我的矩阵涨粉任务(含详情) / runs 运行记录
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

// 对齐支持「互动涨粉」的平台(与新建页一致)。
const PLATFORMS = ['douyin', 'kuaishou', 'bilibili', 'xhs', 'x', 'binance', 'youtube', 'tiktok'];
const PLATFORM_LABEL: Record<string, string> = { douyin: '抖音', xhs: '小红书', bilibili: 'B站', kuaishou: '快手', tiktok: 'TikTok', x: 'X', binance: '币安广场', youtube: 'YouTube', shipinhao: '视频号', toutiao: '头条' };
const LOGIN_URL: Record<string, string> = {
  douyin: 'https://www.douyin.com/', xhs: 'https://www.xiaohongshu.com/', bilibili: 'https://passport.bilibili.com/login',
  kuaishou: 'https://www.kuaishou.com/', tiktok: 'https://www.tiktok.com/login', x: 'https://x.com/login',
  binance: 'https://www.binance.com/zh-CN/square', youtube: 'https://www.youtube.com/',
  shipinhao: 'https://channels.weixin.qq.com/', toutiao: 'https://mp.toutiao.com/',
};
const STATUS_DOT: Record<AccountStatus, string> = { idle: 'bg-green-500', running: 'bg-blue-500', login_required: 'bg-amber-500', limited: 'bg-gray-400', banned: 'bg-red-500' };
const STATUS_LABEL: Record<AccountStatus, string> = { idle: '已就绪', running: '运行中', login_required: '需登录', limited: '限流冷却', banned: '已封' };
const FREQ_LABEL: Record<string, string> = { once: '不重复(手动)', '30min': '每30分钟', '1h': '每小时', '3h': '每3小时', '6h': '每6小时', daily_random: '每日随机一次' };

// 赛道预设(下拉可选):选了自动填关键词 + 人设建议(用户仍可在下面微调)。
const TRACK_PRESETS: Array<{ name: string; keywords: string[]; persona: string }> = [
  { name: '美食探店', keywords: ['美食探店', '本地美食', '街边小吃', '网红餐厅', '探店打卡', '吃播', '家常菜谱', '减脂餐', '烘焙教程', '地方菜系'], persona: '爱吃会做的美食博主,评论真诚接地气、带点烟火气' },
  { name: '日常vlog', keywords: ['vlog', '日常分享', '生活记录', '一人居', '上班族日常', '周末vlog', '晨间routine', '搬家', '装修日记', '学生日常'], persona: '记录真实生活的 vlogger,评论亲切自然' },
  { name: '宠物', keywords: ['宠物日常', '猫咪', '狗子', '萌宠', '养宠新手', '金毛', '橘猫', '柯基', '宠物搞笑', '猫狗日常'], persona: '资深铲屎官,评论暖心有爱' },
  { name: '音乐舞蹈', keywords: ['翻唱', '抖音神曲', '舞蹈翻跳', '吉他弹唱', '钢琴', '街舞', '原创歌曲', '民谣', '古风', '现代舞'], persona: '热爱音乐舞蹈的创作者,评论有共鸣有热情' },
  { name: '知识科普', keywords: ['知识分享', '科普', '冷知识', '历史', '心理学', '健康知识', '财经科普', '科技', 'AI科普', '育儿知识'], persona: '爱分享干货的知识博主,评论有理有据、不卖弄' },
  { name: '搞笑', keywords: ['搞笑', '段子', '反转', '沙雕日常', '剧情', '情景剧', '神回复', '脱口秀', '迷惑行为', '翻车现场'], persona: '幽默风趣的段子手,评论接梗会玩、轻松不尬' },
  { name: '母婴育儿', keywords: ['宝宝日常', '亲子', '辅食', '育儿', '早教', '萌娃', '带娃', '宝妈日常', '孕期', '亲子游戏'], persona: '过来人宝妈/宝爸,评论温柔实用、有共情' },
  { name: '游戏', keywords: ['游戏直播', '王者荣耀', '原神', '和平精英', '手游推荐', '游戏攻略', '游戏剪辑', '英雄联盟', '电竞解说', '单机游戏'], persona: '硬核游戏玩家,评论懂行、热血' },
  { name: '影视短剧', keywords: ['电影解说', '电视剧推荐', '影评', '影视剪辑', '高分电影', '热播剧', '短剧', '反转剧情', '悬疑片', '综艺'], persona: '影视剧爱好者,评论有梗会安利、带分寸' },
  { name: '体育健身', keywords: ['篮球', '足球', '健身', '跑步', '运动技巧', 'NBA', '减脂', '增肌', '马拉松', '极限运动'], persona: '热爱运动的健身达人,评论阳光有干货、爱鼓励' },
  { name: '旅行', keywords: ['旅行vlog', '国内旅游', '自驾游', '民宿推荐', '景点打卡', '小众目的地', 'citywalk', '露营', '穷游攻略', '美食旅行'], persona: '走南闯北的旅行达人,评论种草、有攻略感' },
  { name: '美妆穿搭', keywords: ['美妆教程', '穿搭', '护肤', '口红试色', '平价好物', '通勤穿搭', 'ootd', '彩妆', '发型', '复古风'], persona: '会变美爱分享的美妆穿搭博主,评论真诚种草、不浮夸' },
];

const M = () => (window as any).electron?.matrix;
const fmtTime = (ts?: number) => { if (!ts || ts >= Number.MAX_SAFE_INTEGER) return '—'; const d = new Date(ts); return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

interface Props { screen?: 'accounts' | 'newTask' | 'tasks' | 'runs'; onNavigate?: (s: string) => void; isSidebarCollapsed?: boolean; onToggleSidebar?: () => void; onShowInvite?: () => void }

const MatrixView: React.FC<Props> = ({ screen = 'accounts', onNavigate, onShowInvite }) => {
  const [accounts, setAccounts] = useState<MatrixAccount[]>([]);
  const [tasks, setTasks] = useState<MatrixTask[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [platform, setPlatform] = useState<string>('douyin');
  // kernelPath:调试用的手动内核路径覆盖(UI 已移除输入框,留空即由后端自动解析已装版本)。
  const [kernelPath] = useState<string>(() => localStorage.getItem('matrix:kernelPath') || '');
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

  // 指纹浏览器内核
  const [kernel, setKernel] = useState<{ installed?: boolean; installedVersion?: string; installedVersions?: string[]; configuredVersion?: string; needsUpdate?: boolean }>({});
  const [selectedVersion, setSelectedVersion] = useState<string>('');
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

  const loadKernel = useCallback(() => { M()?.kernelStatus?.().then((r: any) => { setKernel(r || {}); setSelectedVersion((prev) => prev || r?.installedVersion || ''); }); }, []);
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
  const openAdd = () => { if (!requireKernel()) return; setEditId(null); setNewName(`账号${platformAccounts.length + 1}-`); setNewGroup(''); setNewPersona(''); setNewKeywords(''); setNotice(''); setShowAdd(true); };
  // 选赛道 → 关键词 + 人设跟着填(人设为空才填,不覆盖用户已写的)。
  const pickTrack = (name: string) => {
    setNewGroup(name);
    const p = TRACK_PRESETS.find((t) => t.name === name);
    if (p) { setNewKeywords(p.keywords.join(' ')); setNewPersona((prev) => prev.trim() ? prev : p.persona); }
  };
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

  // 统计卡(照抄 TaskDetailPage 的 StatCard)
  const stat = (label: string, value: string, onClick?: () => void, actionLabel?: string) => {
    const Tag: any = onClick ? 'button' : 'div';
    return (
      <Tag type={onClick ? 'button' : undefined} onClick={onClick} className={`text-left w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-3 ${onClick ? 'hover:border-green-500/50 transition-colors cursor-pointer' : ''}`}>
        <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">{label}</div>
        <div className="font-bold dark:text-white text-sm">{value}</div>
        {onClick && actionLabel && <div className="text-[10px] text-green-500 dark:text-green-400 mt-1 truncate">{actionLabel}</div>}
      </Tag>
    );
  };

  const selectedTask = tasks.find((t) => t.id === selectedTaskId) || null;
  const SCREEN_TITLE: Record<string, string> = { accounts: '我的矩阵账号', newTask: '新建矩阵涨粉任务', tasks: '我的矩阵涨粉任务', runs: '矩阵涨粉运行记录' };

  return (
    <div className="h-full flex flex-col dark:text-claude-darkText text-claude-text">
      <div className="flex items-center gap-2 px-5 py-3 border-b dark:border-white/10 border-black/10 flex-wrap">
        <h1 className="text-lg font-medium mr-3">{SCREEN_TITLE[screen] || '矩阵号'}</h1>
        {/* 钱包(BSC/地址/积分/充值)—— 与新建页一致 */}
        <WalletBadge />
        {/* 分享给好友 */}
        {onShowInvite && (
          <button type="button" onClick={onShowInvite} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-green-500/10 text-green-500 border border-green-500/40 hover:bg-green-500/20 active:scale-95">🎁 分享给好友</button>
        )}
        {/* 涨粉教程 */}
        <button type="button" onClick={() => { try { (window as any).electron?.shell?.openExternal('https://docs.noobclaw.com'); } catch { /* ignore */ } }} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-gradient-to-r from-amber-500/15 via-orange-500/15 to-rose-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30 hover:border-amber-500/60">📖 涨粉教程</button>

        <div className="ml-auto flex items-center gap-2">
          {/* 指纹浏览器(版本下拉,多个时可选;不再手填路径) */}
          {kernel.installed ? (
            (kernel.installedVersions && kernel.installedVersions.length > 1) ? (
              <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg bg-green-500/15 text-green-500">
                🧬 指纹浏览器
                <select value={selectedVersion} onChange={(e) => setSelectedVersion(e.target.value)} className="bg-transparent text-green-500 text-xs outline-none">
                  {kernel.installedVersions.map((v) => <option key={v} value={v} className="text-black">v{v}</option>)}
                </select>
                {!kernel.needsUpdate && '✓'}
              </span>
            ) : (
              <span className={`text-xs px-2 py-1 rounded-lg ${kernel.needsUpdate ? 'bg-amber-500/15 text-amber-500' : 'bg-green-500/15 text-green-500'}`}>
                🧬 指纹浏览器 v{kernel.installedVersion || ''}{kernel.needsUpdate ? '(有新版)' : ' ✓'}
              </span>
            )
          ) : (
            <span className="text-xs px-2 py-1 rounded-lg bg-amber-500/15 text-amber-500">🧬 指纹浏览器 未安装</span>
          )}
          {(!kernel.installed || kernel.needsUpdate) && <button onClick={downloadKernel} disabled={kernelBusy} className="text-xs px-2.5 py-1 rounded-lg bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-50">{kernelBusy ? '下载中…' : (kernel.needsUpdate ? '更新' : '下载')}</button>}
          {kernelMsg && <span className="text-xs opacity-60 max-w-[180px] truncate">{kernelMsg}</span>}
        </div>
      </div>

      {notice && (
        <div className="mx-5 mt-3 text-sm px-3 py-2 rounded-lg bg-claude-accent/10 text-claude-accent flex items-center justify-between">
          <span>{notice}</span><button onClick={() => setNotice('')} className="opacity-60 hover:opacity-100 ml-3">✕</button>
        </div>
      )}

      <div className="flex-1 overflow-auto p-5">
        {/* 我的矩阵账号 —— 账号池(卡片样式对齐老客户端) */}
        {screen === 'accounts' && (
          <div className="max-w-6xl mx-auto">
            <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
              <h2 className="text-lg font-bold dark:text-white">🧬 我的矩阵账号</h2>
              <button onClick={openAdd} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-white text-sm font-semibold bg-violet-500 hover:bg-violet-600 shadow-sm shadow-violet-500/25 active:scale-95 transition-all">+ 添加{PLATFORM_LABEL[platform]}账号</button>
            </div>
            {/* 平台 tab 切换(跟新建页一致),按平台分别管理账号 */}
            <div className="flex flex-wrap gap-2 mb-4">
              {PLATFORMS.map((p) => (
                <button key={p} onClick={() => setPlatform(p)} className={`px-3.5 py-1.5 rounded-full text-sm border transition-colors ${platform === p ? 'border-violet-500 bg-violet-500/10 text-violet-500 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-violet-500/50'}`}>{PLATFORM_LABEL[p]}</button>
              ))}
            </div>
            {platformAccounts.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-700 p-10 text-center">
                <div className="text-4xl mb-2">📭</div>
                <div className="text-sm text-gray-500 dark:text-gray-400 mb-4">该平台还没有账号</div>
                <button onClick={openAdd} className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl text-white text-sm font-semibold bg-violet-500 hover:bg-violet-600 shadow-sm shadow-violet-500/25 active:scale-95">+ 添加{PLATFORM_LABEL[platform]}账号</button>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {platformAccounts.map((a, idx) => {
                  // 状态小标签(挪到名字后边,表示状态;不放右侧按钮区)。
                  const stChip = a.status === 'idle' ? 'text-green-600 dark:text-green-400 bg-green-500/15'
                    : a.status === 'login_required' ? 'text-amber-600 dark:text-amber-400 bg-amber-500/15'
                    : a.status === 'running' ? 'text-blue-600 dark:text-blue-400 bg-blue-500/15'
                    : a.status === 'banned' ? 'text-red-600 dark:text-red-400 bg-red-500/15'
                    : 'text-gray-500 bg-gray-500/15';
                  return (
                  <div key={a.id} className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 flex flex-col gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${STATUS_DOT[a.status]}`} />
                      <span className="text-sm font-medium dark:text-white truncate">{a.displayName}</span>
                      <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full ${stChip}`}>{STATUS_LABEL[a.status]}</span>
                      {a.group && <span className="shrink-0 text-xs text-gray-400">· {a.group}</span>}
                      {a.persona && <span className="shrink-0 text-xs text-gray-400">· 人设✓</span>}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 truncate">{a.keywords && a.keywords.length ? `🏷️ ${a.keywords.join(' · ')}` : <span className="text-amber-500">未配关键词(互动需要)</span>}</div>
                    {/* 右侧可点击按钮:全色按钮 */}
                    <div className="flex items-center gap-2 flex-wrap pt-1">
                      {a.proxy
                        ? <button onClick={() => openProxy(a)} className="text-[11px] px-2.5 py-1 rounded-lg bg-blue-500 text-white hover:bg-blue-600">🌐 {a.proxy.geo || a.proxy.host}</button>
                        : <button onClick={() => openProxy(a)} className={`text-[11px] px-2.5 py-1 rounded-lg text-white ${idx === 0 ? 'bg-gray-500 hover:bg-gray-600' : 'bg-amber-500 hover:bg-amber-600'}`}>{idx === 0 ? '本地IP(默认)' : 'IP 未配·点配'}</button>}
                      <button onClick={() => openEdit(a)} className="text-xs px-2.5 py-1 rounded-lg bg-gray-600 text-white hover:bg-gray-700">编辑</button>
                      {a.status === 'login_required' && (<>
                        <button onClick={() => { if (!requireKernel()) return; setNotice(`正在为「${a.displayName}」打开指纹浏览器,扫码后状态自动刷新`); M()?.openLogin({ accountId: a.id, kernelPath, loginUrl: LOGIN_URL[a.platform] || '' }); }} className="text-xs px-2.5 py-1 rounded-lg bg-violet-500 text-white hover:bg-violet-600">扫码登录</button>
                        <button onClick={() => refreshLogin(a)} className="text-xs px-2.5 py-1 rounded-lg bg-gray-600 text-white hover:bg-gray-700">刷新状态</button>
                      </>)}
                    </div>
                  </div>
                  );
                })}
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
                      <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed mb-3 flex-1">同时控制多个账号,每个号在自己的指纹浏览器里、按【自己的赛道关键词】搜抖音视频,按你配的随机区间做点赞 / 关注 / 评论。评论由 AI 按视频文案 + 该号人设自动生成,行为间隔随机模拟真人。赛道/关键词/人设在「我的矩阵账号」给每个号设。</p>
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
                      className={`w-full text-left rounded-xl border p-4 transition-colors relative ${isRunning ? 'border-green-500 ring-2 ring-green-500/30 bg-white dark:bg-gray-900 noobclaw-running-glow' : 'border-gray-200 dark:border-gray-700 hover:border-violet-500/50 dark:hover:border-violet-500/50 bg-white dark:bg-gray-900'}`}>
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
            {(() => {
              const tr = runs.filter((r) => r.taskId === selectedTask.id);
              const cum = tr.reduce((a, r) => ({ like: a.like + (r.totals?.like || 0), follow: a.follow + (r.totals?.follow || 0), comment: a.comment + (r.totals?.comment || 0) }), { like: 0, follow: 0, comment: 0 });
              const last = tr[0];
              return (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
                  {stat('累计完成', `👍 ${cum.like} · ➕ ${cum.follow} · 💬 ${cum.comment}`)}
                  {stat('累计运行', `${tr.length} 次`)}
                  {stat('上次完成', last ? `👍 ${last.totals.like} · ➕ ${last.totals.follow} · 💬 ${last.totals.comment}` : '—')}
                  {stat('上次结果', last ? `成功 ${last.success} · 失败 ${last.failed}` : '—')}
                  {stat('上次运行', last ? fmtTime(last.startedAt) : '尚未运行', () => onNavigate?.('runs'), '查看运行记录 →')}
                  {selectedTask.frequency !== 'once' ? stat('下次运行', selectedTask.enabled ? fmtTime(selectedTask.nextPlannedRunAt) : '已停用') : stat('运行方式', '手动触发')}
                </div>
              );
            })()}
            {(running || Object.keys(items).length > 0) && (
              <div className="rounded-xl border border-green-500/50 bg-green-500/5 p-4 mb-4 noobclaw-running-glow">
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-[40rem] max-w-full max-h-[88vh] overflow-y-auto rounded-2xl p-6 dark:bg-claude-darkBg bg-white border dark:border-white/10 border-black/10 shadow-xl">
            <div className="text-base font-semibold mb-4">{editId ? '编辑账号' : `添加 ${PLATFORM_LABEL[platform]} 账号`}</div>
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">账号备注名</label>
            <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="如:账号1-美食号" className="w-full text-sm px-3 py-2.5 rounded-lg border dark:border-white/15 border-black/15 bg-transparent mb-3" />
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">赛道(选了自动填关键词 + 人设建议)</label>
            <select value={TRACK_PRESETS.some((t) => t.name === newGroup) ? newGroup : ''} onChange={(e) => pickTrack(e.target.value)} className="w-full text-sm px-3 py-2.5 rounded-lg border dark:border-white/15 border-black/15 bg-transparent dark:bg-gray-800 mb-3">
              <option value="">自定义 / 其他(下面自己填关键词)</option>
              {TRACK_PRESETS.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
            </select>
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">赛道关键词(空格/逗号分隔,互动时按这些搜)</label>
            <textarea value={newKeywords} onChange={(e) => setNewKeywords(e.target.value)} placeholder="如:美食 探店 家常菜" rows={4} className="w-full text-sm px-3 py-2.5 rounded-lg border dark:border-white/15 border-black/15 bg-transparent mb-3" />
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">人设(可选)—— 自动评论时 AI 按这个口吻写</label>
            <textarea value={newPersona} onChange={(e) => setNewPersona(e.target.value)} placeholder="如:爱吃会做的美食博主,评论真诚接地气" rows={3} className="w-full text-sm px-3 py-2.5 rounded-lg border dark:border-white/15 border-black/15 bg-transparent mb-4" />
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
            <div className="text-sm font-medium mb-1">指纹浏览器</div>
            {kernel.installed && !kernelBusy ? (
              <div className="text-sm text-green-500 my-3">✓ 指纹浏览器已就绪{kernel.installedVersion ? `(v${kernel.installedVersion})` : ''},现在可以添加账号 / 扫码登录 / 跑任务了。</div>
            ) : (
              <>
                <div className="text-sm opacity-70 my-3">矩阵号需要专属指纹浏览器才能运行(独立指纹隔离,普通 Chrome 无法替代)。约 130MB,只需下载一次。</div>
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
