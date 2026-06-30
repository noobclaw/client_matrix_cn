import React from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import { coworkService } from '../../services/cowork';
import CoworkSessionList from './CoworkSessionList';
import { i18nService } from '../../services/i18n';

/**
 * 主区域「所有 AI 对话」历史列表页 —— 把原来只在侧栏/搜索浮层里的会话列表搬到主内容区:
 *   · 复用 CoworkSessionList(自带空状态 coworkNoSessions + 每条删除/置顶/重命名)。
 *   · 点击某条 → loadSession + onOpenSession() 跳到对话界面(cowork view)。
 * 矩阵版侧栏不常驻对话历史,所以单独成页。
 */
interface Props {
  /** 选中某条对话后调用 —— 让 App 切到 cowork 聊天视图。 */
  onOpenSession: () => void;
}

const CoworkHistoryPage: React.FC<Props> = ({ onOpenSession }) => {
  const sessions = useSelector((s: RootState) => s.cowork.sessions);
  const currentSessionId = useSelector((s: RootState) => s.cowork.currentSessionId);
  const isZh = i18nService.currentLanguage === 'zh';

  const handleSelect = async (id: string) => { await coworkService.loadSession(id); onOpenSession(); };
  const handleDelete = async (id: string) => { await coworkService.deleteSession(id); };
  const handleTogglePin = async (id: string, pinned: boolean) => { await coworkService.setSessionPinned(id, pinned); };
  const handleRename = async (id: string, title: string) => { await coworkService.renameSession(id, title); };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-6">
        <div className="flex items-baseline justify-between mb-4">
          <h1 className="text-lg font-semibold dark:text-white text-claude-text">{isZh ? '所有 AI 对话' : 'All AI Conversations'}</h1>
          <span className="text-xs text-gray-400">{isZh ? `${sessions.length} 个对话` : `${sessions.length} chats`}</span>
        </div>
        <CoworkSessionList
          sessions={sessions}
          currentSessionId={currentSessionId}
          isBatchMode={false}
          selectedIds={new Set()}
          showBatchOption={false}
          onSelectSession={handleSelect}
          onDeleteSession={handleDelete}
          onTogglePin={handleTogglePin}
          onRenameSession={handleRename}
          onToggleSelection={() => { /* 批量模式本页不启用 */ }}
          onEnterBatchMode={() => { /* 批量模式本页不启用 */ }}
        />
      </div>
    </div>
  );
};

export default CoworkHistoryPage;
