// 联系我们页(侧栏入口)— 上半:官网 / 推特 / 开源地址 三张跳转卡;
// 下半:客服联系方式(与官网浮窗同源,GET /api/site/contact,admin 可改零发版)。
import React, { useState } from 'react';
import { i18nService } from '../../services/i18n';
import { getWebsiteUrl } from '../../services/endpoints';
import { useSiteContact, ContactIcon, contactLabel, CONTACT_ORDER } from '../common/ContactWidgets';

const TWITTER_URL = 'https://x.com/noobclaw_com';
const GITHUB_URL = 'https://github.com/noobclaw';

const openExternal = (url: string) => { try { (window as any).electron?.shell?.openExternal?.(url); } catch { /* noop */ } };

interface ContactViewProps {
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
}

// 官网/推特/开源 的小图标(与 CoworkView 顶部同风格,内联 SVG 免资源依赖)
const LinkIcons: Record<string, React.ReactNode> = {
  site: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="22" height="22" aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.9 5.7 3.9 9S14.5 18.4 12 21c-2.5-2.6-3.9-5.7-3.9-9S9.5 5.6 12 3z" />
    </svg>
  ),
  twitter: (
    <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  ),
  github: (
    <svg viewBox="0 0 24 24" fill="currentColor" width="21" height="21" aria-hidden="true">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  ),
};

const ContactView: React.FC<ContactViewProps> = () => {
  const contact = useSiteContact();
  const [openId, setOpenId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const entries = CONTACT_ORDER.filter((k) => contact[k]);

  const links = [
    { id: 'site', label: i18nService.t('cuOfficialSite'), url: getWebsiteUrl(), display: getWebsiteUrl().replace(/^https?:\/\//, '') },
    { id: 'twitter', label: i18nService.t('cuTwitter'), url: TWITTER_URL, display: 'x.com/noobclaw_com' },
    { id: 'github', label: i18nService.t('cuGithub'), url: GITHUB_URL, display: 'github.com/noobclaw' },
  ];

  const conf = openId ? contact[openId] : null;
  const rawLink = conf ? String(conf.link || '').trim().replace(/^mailto:/i, '') : '';
  const doCopy = (v: string) => {
    try { navigator.clipboard.writeText(v); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* noop */ }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-lg font-bold dark:text-claude-darkText text-claude-text mb-1">💬 {i18nService.t('contactUsMenu')}</h2>
          <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-6">{i18nService.t('cuPageDesc')}</p>

          {/* 官网 / 推特 / 开源地址 */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-8">
            {links.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => openExternal(l.url)}
                className="p-4 rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface text-left hover:border-primary/50 transition-colors group"
              >
                <div className="flex items-center gap-2 mb-1.5 dark:text-claude-darkText text-claude-text group-hover:text-primary transition-colors">
                  {LinkIcons[l.id]}
                  <span className="text-sm font-semibold">{l.label}</span>
                </div>
                <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary break-all">{l.display} ↗</div>
              </button>
            ))}
          </div>

          {/* 客服联系方式 */}
          {entries.length > 0 && (
            <>
              <h3 className="text-sm font-semibold dark:text-claude-darkText text-claude-text mb-3">{i18nService.t('cuSupportTitle')}</h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {entries.map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => { setOpenId(k); setCopied(false); }}
                    className="p-4 rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface flex flex-col items-center gap-2 hover:border-primary/50 hover:text-primary transition-colors dark:text-claude-darkTextSecondary text-claude-textSecondary"
                  >
                    <ContactIcon id={k} size={24} />
                    <span className="text-xs font-medium">{contactLabel(k)}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* 弹出卡片:二维码 / 链接 / 复制 */}
      {openId && conf && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60" onClick={() => setOpenId(null)}>
          <div className="bg-white text-gray-900 rounded-2xl p-5 text-center shadow-2xl max-w-[280px] w-[85%]" onClick={(e) => e.stopPropagation()}>
            <div className="font-semibold mb-3">{contactLabel(openId)}</div>
            {conf.image && <img src={conf.image} alt={contactLabel(openId)} className="w-[200px] h-[200px] object-contain mx-auto mb-3" />}
            {rawLink && (
              <div className="flex items-center justify-center gap-2 text-sm">
                <span className="break-all">{rawLink}</span>
                <button type="button" onClick={() => doCopy(rawLink)} className="shrink-0 px-2 py-1 rounded-lg bg-gray-100 hover:bg-gray-200 text-xs">
                  {copied ? i18nService.t('cuCopied') : i18nService.t('cuCopy')}
                </button>
              </div>
            )}
            <div className="mt-4">
              <button type="button" onClick={() => setOpenId(null)} className="px-4 py-1.5 rounded-lg text-xs bg-gray-100 hover:bg-gray-200 text-gray-600">
                {i18nService.t('cuClose')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ContactView;
