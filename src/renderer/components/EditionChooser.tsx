/**
 * 第一次打开时选「简洁版 / 专业版」(2026-10-28)。之后随时在侧栏顶部切换,两版数据完全共用。
 */
import React from 'react';
import { i18nService } from '../services/i18n';
import type { UiEdition } from '../uiEdition';

const L = (zh: string, tw: string, en: string): string => {
  const lang = i18nService.currentLanguage;
  return lang === 'zh' ? zh : lang === 'zh-TW' ? tw : en;
};

const EditionChooser: React.FC<{ onPick: (e: UiEdition) => void }> = ({ onPick }) => {
  const cards: Array<{ e: UiEdition; icon: string; title: string; tag?: string; lines: string[] }> = [
    {
      e: 'simple', icon: '🌱', title: L('简洁版', '簡潔版', 'Simple'), tag: L('新手推荐', '新手推薦', 'For beginners'),
      lines: [
        L('菜单少,一眼看懂', '選單少,一眼看懂', 'Fewer menus, easy to follow'),
        L('首页三步引导 + 教学视频', '首頁三步引導 + 教學影片', 'Home: 3-step guide + video tutorials'),
        L('选平台 → 选账号 → 选任务,一路点下去就建好', '選平台 → 選帳號 → 選任務,一路點下去就建好', 'Pick platform → accounts → task, done'),
        L('所有任务放一起,下拉筛选', '所有任務放一起,下拉篩選', 'All tasks in one list with a filter'),
      ],
    },
    {
      e: 'pro', icon: '🚀', title: L('专业版', '專業版', 'Pro'),
      lines: [
        L('完整功能和全部菜单', '完整功能和全部選單', 'Every feature and menu'),
        L('按平台分开管理任务、运行记录', '按平台分開管理任務、執行紀錄', 'Tasks and run history per platform'),
        L('AI 对话、热点等进阶工具', 'AI 對話、熱點等進階工具', 'AI chat, trending and other advanced tools'),
        L('适合已经熟悉矩阵运营的用户', '適合已經熟悉矩陣運營的用戶', 'For experienced matrix operators'),
      ],
    },
  ];
  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-2xl p-6">
        <div className="text-center mb-5">
          <img src="logo.png" alt="logo" className="w-12 h-12 mx-auto rounded-2xl shadow mb-2" />
          <div className="text-lg font-bold dark:text-white text-gray-900">{L('欢迎使用 NoobClaw,选一个界面开始吧', '歡迎使用 NoobClaw,選一個介面開始吧', 'Welcome to NoobClaw — pick a layout')}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">{L('之后随时可以在左上角切换,账号和任务两边通用', '之後隨時可以在左上角切換,帳號和任務兩邊通用', 'You can switch any time at the top-left; accounts and tasks are shared')}</div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {cards.map((c) => (
            <button
              key={c.e}
              type="button"
              onClick={() => onPick(c.e)}
              className={`text-left rounded-2xl border-2 p-4 transition-all hover:-translate-y-0.5 hover:shadow-lg ${c.e === 'simple' ? 'border-claude-accent/60 bg-claude-accent/5 hover:border-claude-accent' : 'border-gray-200 dark:border-gray-700 hover:border-claude-accent/50'}`}
            >
              <div className="flex items-center gap-2 mb-2">
                <span className="text-2xl">{c.icon}</span>
                <span className="text-base font-bold dark:text-white text-gray-900">{c.title}</span>
                {c.tag && <span className="ml-auto text-[11px] font-semibold px-2 py-0.5 rounded-full bg-claude-accent text-[#04130B]">{c.tag}</span>}
              </div>
              <ul className="space-y-1">
                {c.lines.map((l) => <li key={l} className="text-xs text-gray-600 dark:text-gray-300">· {l}</li>)}
              </ul>
              <div className={`mt-3 w-full py-2 rounded-xl text-center text-sm font-semibold ${c.e === 'simple' ? 'bg-claude-accent text-[#04130B]' : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200'}`}>
                {L(`用${c.title}`, `用${c.title}`, `Use ${c.title}`)}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default EditionChooser;
