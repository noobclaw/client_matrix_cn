/**
 * 简洁版「创建任务」前两步(2026-10-28):① 选平台 ② 选账号 → 交回 ScenarioView 展示该平台的任务卡片(③ 选任务类型),
 * 点哪张卡打开对应向导时,这里选好的账号已经勾好(uiEdition.setPresetAccounts)。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';

const L = (zh: string, tw: string, en: string): string => {
  const lang = i18nService.currentLanguage;
  return lang === 'zh' ? zh : lang === 'zh-TW' ? tw : en;
};

export interface SimplePlatform { id: string; label: string; icon: string }
interface Acc { id: string; displayName: string; nickname?: string; status: string; platform: string; avatar?: string; group?: string; loginScope?: string; displayId?: string }

interface Props {
  platforms: SimplePlatform[];
  initialPlatform?: string;
  onPicked: (platform: string, accountIds: string[]) => void;
}

const usable = (a: Acc) => a.status !== 'banned' && a.status !== 'login_required';

const SimpleCreatePicker: React.FC<Props> = ({ platforms, initialPlatform, onPicked }) => {
  const [accounts, setAccounts] = useState<Acc[] | null>(null);
  const [platform, setPlatform] = useState<string>(() => (initialPlatform && platforms.some((p) => p.id === initialPlatform) ? initialPlatform : ''));
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await (window as any).electron?.matrix?.listAccounts?.();
        if (alive) setAccounts(r?.ok && Array.isArray(r.accounts) ? (r.accounts as Acc[]).filter((a) => (a.loginScope || 'main') === 'main') : []);
      } catch { if (alive) setAccounts([]); }
    })();
    return () => { alive = false; };
  }, []);

  const byPlat = useMemo(() => {
    const m: Record<string, Acc[]> = {};
    for (const a of accounts || []) (m[a.platform] = m[a.platform] || []).push(a);
    return m;
  }, [accounts]);
  // 有账号的平台排前面,其余保持原顺序
  const ordered = useMemo(() => {
    const has = platforms.filter((p) => (byPlat[p.id] || []).length > 0);
    const none = platforms.filter((p) => !(byPlat[p.id] || []).length);
    return [...has, ...none];
  }, [platforms, byPlat]);

  const pickPlatform = (id: string) => {
    setPlatform(id);
    // 默认把能用的号全勾上(大多数人就是要全部号一起跑)
    setSelected(new Set((byPlat[id] || []).filter(usable).map((a) => a.id)));
  };
  // 从「我的任务」带平台进来:账号到了再默认全勾
  useEffect(() => { if (platform && accounts && selected.size === 0) setSelected(new Set((byPlat[platform] || []).filter(usable).map((a) => a.id))); /* eslint-disable-next-line */ }, [accounts]);

  const goAccounts = (p?: string) => { window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform: p } })); };
  const plat = platforms.find((p) => p.id === platform);
  const list = platform ? (byPlat[platform] || []) : [];
  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const StepDot: React.FC<{ n: number; on: boolean; label: string }> = ({ n, on, label }) => (
    <div className={`flex items-center gap-2 ${on ? 'text-claude-accent' : 'text-gray-400'}`}>
      <span className={`w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold ${on ? 'bg-claude-accent text-white' : 'bg-gray-200 dark:bg-gray-700 text-gray-500'}`}>{n}</span>
      <span className="text-sm font-semibold">{label}</span>
    </div>
  );

  return (
    <div className="max-w-4xl mx-auto px-5 py-6 space-y-5">
      <div className="flex items-center gap-3 flex-wrap">
        <StepDot n={1} on={!platform} label={L('选平台', '選平台', 'Platform')} />
        <span className="text-gray-300">—</span>
        <StepDot n={2} on={!!platform} label={L('选账号', '選帳號', 'Accounts')} />
        <span className="text-gray-300">—</span>
        <StepDot n={3} on={false} label={L('选任务', '選任務', 'Task')} />
      </div>

      {accounts === null ? (
        <div className="flex items-center gap-2 text-sm text-gray-400 py-10 justify-center">
          <span className="h-4 w-4 rounded-full border-2 border-claude-accent border-t-transparent animate-spin" />
          {L('读取账号中…', '讀取帳號中…', 'Loading accounts…')}
        </div>
      ) : !platform ? (
        <>
          <div className="text-base font-bold dark:text-white text-gray-900">{L('要在哪个平台做任务?', '要在哪個平台做任務?', 'Which platform?')}</div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {ordered.map((p) => {
              const n = (byPlat[p.id] || []).length;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => pickPlatform(p.id)}
                  className={`flex flex-col items-center gap-1.5 rounded-2xl border-2 px-3 py-4 transition-all hover:-translate-y-0.5 hover:shadow-md ${n ? 'border-claude-accent/40 bg-claude-accent/5 hover:border-claude-accent' : 'border-gray-200 dark:border-gray-700 opacity-70 hover:opacity-100'}`}
                >
                  <span className="text-3xl">{p.icon}</span>
                  <span className="text-sm font-semibold dark:text-white text-gray-900">{p.label}</span>
                  <span className={`text-[11px] ${n ? 'text-claude-accent' : 'text-gray-400'}`}>{n ? L(`${n} 个账号`, `${n} 個帳號`, `${n} account(s)`) : L('还没有账号', '還沒有帳號', 'No accounts yet')}</span>
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <button type="button" onClick={() => { setPlatform(''); setSelected(new Set()); }} className="px-3 py-1.5 rounded-lg text-sm font-semibold border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800">← {L('换平台', '換平台', 'Change platform')}</button>
            <div className="text-base font-bold dark:text-white text-gray-900">{plat?.icon} {plat?.label} · {L('用哪些账号?', '用哪些帳號?', 'Which accounts?')}</div>
            {list.filter(usable).length > 0 && (
              <button type="button" className="ml-auto text-xs text-claude-accent hover:underline" onClick={() => setSelected(selected.size === list.filter(usable).length ? new Set() : new Set(list.filter(usable).map((a) => a.id)))}>
                {selected.size === list.filter(usable).length ? L('全不选', '全不選', 'Clear') : L('全选', '全選', 'Select all')}
              </button>
            )}
          </div>
          {list.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-gray-300 dark:border-gray-700 p-10 text-center space-y-3">
              <div className="text-4xl">👥</div>
              <div className="text-sm text-gray-500 dark:text-gray-400">{L(`还没有 ${plat?.label} 账号,先去添加一个吧`, `還沒有 ${plat?.label} 帳號,先去新增一個吧`, `No ${plat?.label} accounts yet — add one first`)}</div>
              <button type="button" onClick={() => goAccounts(platform)} className="px-5 py-2.5 rounded-xl text-sm font-bold bg-claude-accent text-white hover:brightness-110">{L('去添加账号', '去新增帳號', 'Add an account')}</button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {list.map((a) => {
                const ok = usable(a);
                const on = selected.has(a.id);
                return (
                  <label key={a.id} className={`flex items-center gap-3 rounded-xl border-2 px-3 py-2.5 transition-colors ${!ok ? 'opacity-50 cursor-not-allowed border-gray-200 dark:border-gray-700' : on ? 'cursor-pointer border-claude-accent bg-claude-accent/5' : 'cursor-pointer border-gray-200 dark:border-gray-700 hover:border-claude-accent/50'}`}>
                    <input type="checkbox" className="h-4 w-4 accent-emerald-500 shrink-0" checked={on} disabled={!ok} onChange={() => ok && toggle(a.id)} />
                    {a.avatar
                      ? <img src={a.avatar} alt="" className="w-9 h-9 rounded-full object-cover shrink-0" referrerPolicy="no-referrer" />
                      : <span className="w-9 h-9 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center text-sm shrink-0">{(a.nickname || a.displayName || '?').slice(0, 1)}</span>}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold truncate dark:text-white text-gray-900">{a.nickname || a.displayName}</div>
                      <div className="text-[11px] text-gray-400 truncate">
                        {!ok ? <span className="text-amber-500">{a.status === 'banned' ? L('已封禁', '已封鎖', 'banned') : L('掉线了,先去账号页重新登录', '離線了,先去帳號頁重新登入', 'logged out — re-login first')}</span> : (a.group || a.displayName)}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          )}
          {list.length > 0 && (
            <div className="flex items-center gap-3 pt-2">
              <button type="button" onClick={() => goAccounts(platform)} className="text-xs text-gray-500 hover:text-claude-accent">{L('+ 添加 / 管理账号', '+ 新增 / 管理帳號', '+ Add / manage accounts')}</button>
              <div className="flex-1" />
              <button
                type="button"
                disabled={selected.size === 0}
                onClick={() => onPicked(platform, Array.from(selected))}
                className="px-8 py-3 rounded-2xl text-base font-bold text-white bg-claude-accent hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-claude-accent/30"
              >
                {L(`下一步:选任务(已选 ${selected.size} 个号)`, `下一步:選任務(已選 ${selected.size} 個帳號)`, `Next: pick a task (${selected.size} selected)`)} →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default SimpleCreatePicker;
