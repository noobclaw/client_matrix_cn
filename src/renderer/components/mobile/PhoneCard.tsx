import React, { useState } from 'react';
import {
  ConsoleConfig, Device, L, Platform, PlatformId, shortId, taskName, TaskView, accountOf, bd, btnGhost, btnPrimary, countKeys, fmtCost, fmtTotals,
  fmtWhen, lastWarn, modeName, nextRunText, num, openExternal, shortTarget, stepLines, sub, surface, surface2, targetLabel, txt,
} from './cloudPhoneShared';
import { AccountRow } from './cloudPhoneUi';

/** Phone-shaped cards of the 云手机 grid: a connected phone, an empty slot (setup guide) and "add slots". */

const pillCls = 'flex-none text-[11px] font-bold px-2 py-[3px] rounded-full whitespace-nowrap';
const smallBtn = 'flex-1 basis-0 px-0.5 py-[5px] text-[11px] leading-snug rounded-lg whitespace-nowrap';
const stopBtn = 'flex-none px-4 py-[5px] text-[11px] font-bold rounded-lg border border-[#ff5c7a] bg-[#ff5c7a] text-white hover:brightness-110';

function StatusPill({ d }: { d: Device }) {
  if (!d.online) return <span className={`${pillCls} ${sub} bg-gray-500/15`}>{L('离线', '離線', 'Offline')}</span>;
  if (d.over_limit) return <span className={`${pillCls} text-amber-500 dark:text-amber-400 bg-amber-500/15`}>{L('超出会员数', '超出會員數', 'Over limit')}</span>;
  if (d.running) return <span className={`${pillCls} bg-claude-accent text-[#04140c]`}>{L('运行中', '運行中', 'Running')}</span>;
  if (!d.a11y) return <span className={`${pillCls} text-amber-500 dark:text-amber-400 bg-amber-500/15`}>{L('缺权限', '缺權限', 'Permission')}</span>;
  return <span className={`${pillCls} text-green-600 dark:text-claude-accent bg-claude-accent/10`}>{L('在线', '在線', 'Online')}</span>;
}

const Kv: React.FC<{ k: string; v: string }> = ({ k, v }) => (
  <div className={`flex justify-between gap-2 text-[10.5px] ${sub}`}>
    <span className="flex-none whitespace-nowrap">{k}</span>
    <em className={`not-italic truncate text-right ${txt}`} title={v}>{v}</em>
  </div>
);

const EmptyBox: React.FC<{ warn?: boolean; title: string; text: string; children?: React.ReactNode }> = ({ warn, title, text, children }) => (
  <div className={`flex-1 flex flex-col items-center justify-center gap-1.5 text-center px-1 py-2.5 text-[11px] ${sub}`}>
    <b className={`text-[12.5px] font-medium ${warn ? 'text-amber-500 dark:text-amber-400' : txt}`}>{title}</b>
    <span>{text}</span>
    {children}
  </div>
);

export interface PhoneCardProps {
  device: Device;
  /** Platform tabs left after the compliance filter (may be empty). */
  platforms: Platform[];
  platform: PlatformId;
  onPlatform: (p: PlatformId) => void;
  onCreate: () => void;
  onView: (t: TaskView) => void;
  onRun: (t: TaskView) => void;
  onStop: (taskId?: string) => void;
  onDeleteTask: (t: TaskView) => void;
  onRemove: () => void;
  onUpgrade: () => void;
  /** Batch selection; no checkbox when `onPick` is missing or the phone is over the plan limit. */
  picked?: boolean;
  onPick?: (on: boolean) => void;
}

export const PhoneCard: React.FC<PhoneCardProps> = (p) => {
  const d = p.device;
  const offline = !d.online;
  const running = d.online && d.running;
  const perm = d.online && !d.a11y && !running;
  return (
    <article className={`cp-phone${offline ? ' cp-offline' : ''}${running ? ' cp-running' : ''}${p.picked ? ' outline outline-2 outline-offset-2 outline-claude-accent' : ''}`} aria-label={d.vendor || d.id}>
      {offline && (
        <button type="button" onClick={p.onRemove} aria-label={L('移除这台手机', '移除這台手機', 'Remove this phone')} title={L('移除这台手机', '移除這台手機', 'Remove this phone')}
          className={`absolute -top-2 -right-2 z-[3] w-[26px] h-[26px] rounded-full border ${bd} ${surface2} ${sub} text-base leading-none grid place-items-center hover:text-[#ff5c7a] hover:border-[#ff5c7a]`}>×</button>
      )}
      {d.over_limit && (
        <div className="absolute inset-[10px] z-[2] rounded-[22px] bg-white/75 dark:bg-[rgba(8,8,13,.72)] backdrop-blur-[3px] flex flex-col items-center justify-center gap-2 p-4 text-center">
          <div className="text-2xl" aria-hidden="true">🔒</div>
          <b className={`text-[13px] ${txt}`}>{L('超出当前会员可用手机数', '超出目前會員可用手機數', "Over your plan's phone limit")}</b>
          <span className={`text-[11px] leading-relaxed ${sub}`}>{L('会员降级或到期后，多出的手机暂停运行', '會員降級或到期後，多出的手機暫停運行', 'Extra phones pause when a plan is downgraded or expires')}</span>
          <button type="button" className={`${btnPrimary} mt-1 px-[18px] py-2 text-[12.5px]`} onClick={p.onUpgrade}>{L('升级会员', '升級會員', 'Upgrade')}</button>
        </div>
      )}
      <div className={`cp-scr ${offline ? 'bg-claude-surfaceMuted dark:bg-[#101018]' : surface}`}>
        <div className="cp-top flex items-center gap-1.5 min-w-0">
          {p.onPick && !d.over_limit && (
            <input type="checkbox" className="flex-none w-[15px] h-[15px] m-0 cursor-pointer accent-[#00ff88]" checked={!!p.picked}
              onChange={(e) => p.onPick?.(e.target.checked)} aria-label={`${L('选择', '選擇', 'Select')} ${d.id}`} />
          )}
          <span className={`min-w-0 font-mono text-[10.5px] font-semibold px-[7px] py-0.5 rounded-[7px] border ${bd} truncate ${offline ? `${sub} bg-gray-500/10` : `${txt} bg-black/[.04] dark:bg-white/[.06]`}`} title={d.id}>
            {L('设备ID', '設備ID', 'Device ID')}: {shortId(d.id)}
          </span>
        </div>
        <div className="cp-top flex items-center justify-between gap-2 min-w-0">
          <div className="flex-1 min-w-0 overflow-hidden">
            <div className={`text-[13.5px] font-bold truncate ${txt}`} title={d.vendor}>{d.vendor || d.id.slice(0, 8)}</div>
            <div className={`font-mono text-[11px] truncate ${sub}`}>
              {offline ? `${L('最后在线', '最後在線', 'Last seen')} ${fmtWhen(d.last_seen)}` : (d.ip || '')}
            </div>
          </div>
          <StatusPill d={d} />
        </div>
        {perm ? (
          <div className="flex-none flex flex-col items-start gap-2 p-3 rounded-[14px] border border-amber-500/35 bg-amber-500/[.06]">
            <b className="text-[12.5px] font-medium text-amber-500 dark:text-amber-400">{L('运行需要权限', '運行需要權限', 'Permission needed')}</b>
            <span className="text-xs leading-[1.75] text-amber-500 dark:text-amber-400">
              {L('需要您回到手机，为 NoobClaw App 打开无障碍服务权限', '需要您回到手機，為 NoobClaw App 打開無障礙服務權限', 'Go back to the phone and turn on the Accessibility service for the NoobClaw app')}
            </span>
          </div>
        ) : <PlatformPanel {...p} />}
      </div>
    </article>
  );
};

const PlatformPanel: React.FC<PhoneCardProps> = ({ device: d, platforms, platform, onPlatform, onCreate, onView, onRun, onStop, onDeleteTask }) => {
  const panel = `flex-1 min-h-0 flex flex-col border ${bd} rounded-[14px] ${surface2} overflow-hidden`;
  const body = 'flex-1 min-h-0 flex flex-col gap-2 px-2.5 pt-[9px] pb-2.5';
  const acct = accountOf(d);
  const acctRow = acct ? <AccountRow handle={acct.handle} nickname={acct.nickname} className={`pb-2 border-b ${bd}`} /> : null;

  // Every platform hidden by the compliance config → no tabs / task panel at all.
  if (platforms.length === 0) return null;
  const tiktokVisible = platforms.some((x) => x.id === 'tiktok');

  // Running: marquee + progress replace the platform tabs; friendly log; small red stop.
  if (d.online && d.running && tiktokVisible) {
    const pr = d.progress;
    const t = d.tasks.find((x) => x.id === pr?.task_id) || d.tasks.find((x) => (x.platform || 'tiktok') === 'tiktok');
    const msg = `${L('正在运行', '正在運行', 'Running')} TikTok${t ? ` · ${taskName(t)}` : ''}`;
    const items = countKeys(t?.script_id || '').filter(({ k }) => (pr?.targets?.[k] || 0) > 0 || (pr?.counts?.[k] || 0) > 0);
    const lines = stepLines(pr?.steps).slice(-8);
    return (
      <div className={panel}>
        <div className="mx-2 mt-2 rounded-[10px] overflow-hidden bg-claude-accent/[.07] border border-claude-accent/35">
          <div className="h-[26px] overflow-hidden flex items-center border-b border-claude-accent/20" aria-label={msg}>
            <div className="cp-mq-track text-[11.5px] font-bold text-green-600 dark:text-claude-accent"><span>● {msg}</span><span>● {msg}</span></div>
          </div>
          {pr && (
            <div className="flex flex-col gap-[5px] px-[9px] py-[7px]">
              <div className={`flex items-center justify-between gap-1.5 whitespace-nowrap text-[10.5px] ${sub}`}>
                <span className="text-[10px] font-bold text-green-600 dark:text-claude-accent">{L('进度', '進度', 'Progress')}</span>
                <span className="flex gap-2 min-w-0 overflow-hidden">
                  {items.length ? items.map(({ k, icon }) => (
                    <span key={k}>{icon}<b className={`font-mono font-semibold ${txt}`}>{num(pr.counts?.[k] || 0)}</b>{pr.targets?.[k] ? `/${pr.targets[k]}` : ''}</span>
                  )) : '—'}
                </span>
              </div>
              <div className={`flex items-center justify-between gap-1.5 whitespace-nowrap text-[10.5px] ${sub}`}>
                <span className="text-[10px] font-bold text-green-600 dark:text-claude-accent">{L('消耗', '消耗', 'Cost')}</span>
                <span className={`font-mono font-semibold ${txt}`}>{fmtCost(pr.credits || 0, pr.usd || 0)}</span>
              </div>
            </div>
          )}
        </div>
        <div className={body}>
          {acctRow}
          <ol className="cp-runlog flex-1 min-h-0 overflow-hidden list-none m-0 p-0 flex flex-col justify-end gap-1.5" aria-label={L('运行日志', '運行日誌', 'Run log')}>
            {lines.length === 0 && <li className={`text-[10.5px] ${txt}`}><span className="cp-now">{L('等待手机响应…', '等待手機回應…', 'Waiting for the phone…')}</span></li>}
            {lines.map((l, i) => (
              <li key={i} className={`grid grid-cols-[32px_1fr] gap-1.5 text-[10.5px] leading-normal ${i === lines.length - 1 ? txt : sub}`}>
                <time className="tabular-nums opacity-80">{l.time}</time>
                <span className={i === lines.length - 1 ? 'cp-now' : ''}>{l.text}</span>
              </li>
            ))}
          </ol>
          <div className="flex justify-center">
            <button type="button" className={stopBtn} onClick={() => onStop(pr?.task_id || t?.id)}>■ {L('停止', '停止', 'Stop')}</button>
          </div>
        </div>
      </div>
    );
  }

  const tabs = (
    <div className="mx-2 mt-2 flex gap-1 p-[3px] rounded-[10px] bg-black/[.05] dark:bg-black/35 border dark:border-claude-darkBorder border-claude-border" role="radiogroup">
      {platforms.map((x) => {
        const on = x.id === platform;
        return (
          <button key={x.id} type="button" role="radio" aria-checked={on} onClick={() => onPlatform(x.id)}
            title={x.live ? x.name() : `${x.name()} · ${L('即将推出', '即將推出', 'coming soon')}`}
            className={`flex-1 h-7 px-0.5 rounded-lg text-[11.5px] font-bold whitespace-nowrap transition-colors ${on
              ? 'bg-claude-accent text-[#04140c] shadow-[0_2px_8px_rgba(0,255,136,.25)]'
              : `${x.live ? 'text-claude-text dark:text-[#c4c4dc]' : 'text-claude-textSecondary dark:text-[#8f8fad]'} hover:bg-black/5 dark:hover:bg-white/5`}`}>
            {x.name()}
          </button>
        );
      })}
    </div>
  );
  const wrap = (children: React.ReactNode) => <div className={panel}>{tabs}<div className={body}>{children}</div></div>;

  const pf = platforms.find((x) => x.id === platform) || platforms[0];
  if (!pf.live) {
    return wrap(
      <div className={`flex-1 flex flex-col items-center justify-center gap-1.5 text-center px-1 text-[11px] ${sub}`}>
        <b className={`text-[15px] font-bold tracking-wider ${txt}`}>{L('即将推出', '即將推出', 'Coming soon')}</b>
        <span>{L(`${pf.name()} 任务正在开发中`, `${pf.name()} 任務正在開發中`, `${pf.name()} tasks are on the way`)}</span>
      </div>,
    );
  }

  const t = d.tasks.find((x) => (x.platform || 'tiktok') === 'tiktok');
  const noApp = d.apps?.tiktok === false;
  const disabledCreate = <button type="button" disabled className={`${btnGhost} px-3.5 py-[7px] text-[11.5px] ${surface}`}>＋ {L('创建任务', '建立任務', 'Create task')}</button>;
  if (!t) {
    if (noApp) return wrap(<EmptyBox warn title={L('未检测到 TikTok 应用', '未偵測到 TikTok 應用', 'TikTok app not found')} text={L('请先在这台手机上安装 TikTok，再创建任务', '請先在這台手機上安裝 TikTok，再建立任務', 'Install TikTok on this phone first, then create a task')}>{disabledCreate}</EmptyBox>);
    if (!acct) return wrap(<EmptyBox warn title={L('未检测到 TikTok 账号', '未偵測到 TikTok 帳號', 'No TikTok account found')} text={L('请在这台手机上打开 TikTok 并登录账号，再创建任务', '請在這台手機上打開 TikTok 並登入帳號，再建立任務', 'Open TikTok on this phone and log in, then create a task')}>{disabledCreate}</EmptyBox>);
    return wrap(<>
      {acctRow}
      <EmptyBox title={L('TikTok 还没有任务', 'TikTok 還沒有任務', 'No TikTok task yet')} text={L('每个平台可以建 1 个任务', '每個平台可以建 1 個任務', 'One task per platform')}>
        <button type="button" className={`${btnPrimary} px-3.5 py-[7px] text-[11.5px]`} onClick={onCreate}>＋ {L('创建任务', '建立任務', 'Create task')}</button>
      </EmptyBox>
    </>);
  }

  const where = (t.mode === 'precise' ? t.targets : t.keywords) || [];
  const warn = lastWarn(t.last_status);
  const alert = noApp ? L('未检测到 TikTok 应用', '未偵測到 TikTok 應用', 'TikTok app not found')
    : !acct ? L('未检测到 TikTok 账号，请在手机上登录', '未偵測到 TikTok 帳號，請在手機上登入', 'No TikTok account — log in on the phone') : '';
  const canRun = d.online && d.a11y && !d.over_limit;
  return wrap(<>
    {acctRow}
    <div className="flex flex-col gap-[3px]">
      <div className="flex justify-between items-baseline gap-1.5 mb-0.5"><b className={`text-xs truncate ${txt}`} title={taskName(t)}>{taskName(t)}</b></div>
      <Kv k={L('模式', '模式', 'Mode')} v={modeName(t.mode)} />
      <Kv k={targetLabel(t.script_id, t.mode)} v={where.map(shortTarget).join('、') || '—'} />
      <Kv k={L('最近运行', '最近運行', 'Last run')} v={fmtWhen(t.last_run_at)} />
      {warn && <div className="text-[10.5px] leading-normal text-amber-500 dark:text-amber-400">{warn}</div>}
      <Kv k={L('下次运行', '下次運行', 'Next run')} v={nextRunText(t)} />
      <div className={`mt-[3px] pt-1.5 border-t ${bd} text-[10px] ${sub} flex flex-col gap-0.5`}>
        <span>{L('累计完成', '累計完成', 'Total done')}</span>
        <em className={`not-italic text-[10.5px] leading-normal tabular-nums ${txt}`}>{fmtTotals(t.script_id, t.totals)}</em>
      </div>
    </div>
    {alert && <div className="text-[11px] leading-normal px-[9px] py-[7px] rounded-[9px] text-amber-500 dark:text-amber-400 bg-amber-500/[.08] border border-amber-500/25">{alert}</div>}
    <div className="flex-1" />
    <div className="flex gap-1.5 justify-center">
      <button type="button" className={`${btnGhost} ${surface} ${smallBtn} !text-[#ff5c7a] !border-[#ff5c7a]/40`} onClick={() => onDeleteTask(t)}>{L('删除', '刪除', 'Delete')}</button>
      <button type="button" className={`${btnGhost} ${surface} ${smallBtn}`} onClick={() => onView(t)}>{L('查看', '查看', 'View')}</button>
      <button type="button" className={`${btnPrimary} ${smallBtn}`} disabled={!canRun} onClick={() => onRun(t)}>▶ {L('运行', '運行', 'Run')}</button>
    </div>
  </>);
};

// ───────────────────────── empty slot: setup guide ─────────────────────────
export const GuideCard: React.FC<{ n: number; config: ConsoleConfig | null }> = ({ n, config }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!config?.apk_url) return;
    try { await navigator.clipboard.writeText(config.apk_url); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* clipboard blocked */ }
  };
  const stepNo = (i: number) => (
    <i className={`not-italic w-[17px] h-[17px] rounded-full border ${bd} ${surface2} text-green-600 dark:text-claude-accent text-[10px] font-bold grid place-items-center`}>{i}</i>
  );
  const li = 'grid grid-cols-[17px_1fr] gap-[7px] text-[11px] leading-[1.45]';
  const mini = `${btnGhost} flex-1 px-0.5 py-[5px] text-[10px] rounded-lg whitespace-nowrap`;
  return (
    <article className="cp-phone cp-empty" aria-label={L(`空手机槽位 ${n}`, `空手機槽位 ${n}`, `Empty phone slot ${n}`)}>
      <div className="cp-scr bg-claude-surface/60 dark:bg-[rgba(18,18,31,.55)]">
        <div className="cp-top flex"><span className={`text-[11px] ${sub}`}>{L(`手机槽位 ${n} · 空`, `手機槽位 ${n} · 空`, `Phone slot ${n} · empty`)}</span></div>
        <div className="my-auto flex flex-col gap-[9px]">
          <div className={`text-[12.5px] font-bold ${txt}`}>{L('如何接入一台新安卓机？', '如何接入一台新安卓機？', 'How to add an Android phone?')}</div>
          <ol className={`list-none m-0 p-0 flex flex-col gap-[7px] ${txt}`}>
            <li className={li}>{stepNo(1)}<div className="min-w-0">
              {L('购买一台安卓真/云机', '購買一台安卓真機/雲機', 'Get an Android phone or cloud phone')}
              <button type="button" disabled={!config?.vmos_url} onClick={() => openExternal(config?.vmos_url)}
                className={`whitespace-nowrap inline-flex items-center gap-1 mt-[5px] px-2 py-1 rounded-lg bg-[rgba(0,255,136,.07)] border border-[rgba(0,255,136,.25)] text-[10px] ${txt} disabled:opacity-50`}>
                {L('推荐云机', '推薦雲機', 'Recommended')} <b className="text-green-600 dark:text-claude-accent">VMOSCloud ›</b>
              </button>
            </div></li>
            <li className={li}>{stepNo(2)}<div className="min-w-0">
              {L('在新机上安装 NoobClaw App', '在新機上安裝 NoobClaw App', 'Install the NoobClaw app on it')}
              <div className="flex gap-1.5 mt-1.5">
                <button type="button" className={mini} disabled={!config?.apk_url} onClick={copy}>{copied ? L('已复制', '已複製', 'Copied') : L('复制下载链接', '複製下載連結', 'Copy link')}</button>
                <button type="button" className={`${btnPrimary} flex-1 px-0.5 py-[5px] text-[10px] rounded-lg whitespace-nowrap`} disabled={!config?.apk_url} onClick={() => openExternal(config?.apk_url)}>{L('直接下载', '直接下載', 'Download')}</button>
              </div>
            </div></li>
            <li className={li}>{stepNo(3)}<div className="min-w-0">
              {L('在手机 App 上登录同一个账号即可同步', '在手機 App 上登入同一個帳號即可同步', 'Log in with this same account in the app')}
              <small className={`block text-[10px] ${sub}`}>{L('登录后自动出现在这里', '登入後自動出現在這裡', 'It shows up here automatically')}</small>
            </div></li>
            <li className={li}>{stepNo(4)}<div className="min-w-0">
              {L('创建任务，开始运行', '建立任務，開始運行', 'Create a task and run it')}
              <small className={`block text-[10px] ${sub}`}>{L('手机上或电脑上都能建', '手機上或電腦上都能建', 'On the phone or here on the desktop')}</small>
            </div></li>
          </ol>
        </div>
      </div>
    </article>
  );
};

// ───────────────────────── add slots ─────────────────────────
export const AddCard: React.FC<{ onUpgrade: () => void }> = ({ onUpgrade }) => (
  // Not phone-shaped: just a + button and an upgrade button, centred in the grid cell.
  <div className="self-center justify-self-center flex flex-col items-center gap-3 py-6">
    <button type="button" onClick={onUpgrade} aria-label={L('升级会员，增加手机槽位', '升級會員，增加手機槽位', 'Upgrade to add phone slots')}
      className="w-14 h-14 rounded-2xl bg-neon-purple text-white text-[30px] leading-none grid place-items-center hover:opacity-90 transition-opacity">+</button>
    <button type="button" className={`${btnPrimary} px-[18px] py-2 text-[12.5px]`} onClick={onUpgrade}>
      {L('升级会员，增加槽位', '升級會員，增加槽位', 'Upgrade for more slots')}
    </button>
  </div>
);
