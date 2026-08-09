// 联系我们 — 三件套共享组件。数据源与官网同一个接口 GET /api/site/contact
// (免鉴权,admin「💬 官网联系方式」分组可改,30s 缓存,换客服号/二维码零发版):
//   1. useSiteContact()        — 拉取 + 模块级缓存(5min)
//   2. <ContactInlinePanel />  — 行内联系方式区(我的充值页底部 / 联系我们页复用)
//   3. <ContactFloatWidget />  — 右侧悬浮小组件(首页用,顶部「联系我们」字样,无回到顶部小火箭)
// 交互:点击条目弹居中卡片(二维码 / 链接 / 复制),再点关闭;链接经 shell.openExternal 出系统浏览器。
import React, { useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { getBackendApiUrl } from '../../services/endpoints';

export type SiteContact = Record<string, { link?: string; image?: string }>;

// ── 数据 ────────────────────────────────────────────────────────────
let _cache: { at: number; data: SiteContact } | null = null;
const CACHE_MS = 5 * 60_000;

export function useSiteContact(): SiteContact {
  const [data, setData] = useState<SiteContact>(_cache?.data || {});
  useEffect(() => {
    if (_cache && Date.now() - _cache.at < CACHE_MS) { setData(_cache.data); return; }
    fetch(`${getBackendApiUrl()}/api/site/contact`)
      .then((r) => r.json())
      .then((j) => {
        const c: SiteContact = (j && j.contact) || {};
        _cache = { at: Date.now(), data: c };
        setData(c);
        // 二维码预热:进浏览器缓存,点开卡片即出图
        Object.values(c).forEach((v) => { if (v.image) { const im = new Image(); im.src = v.image; } });
      })
      .catch(() => { /* 拉不到就不渲染,不影响页面 */ });
  }, []);
  return data;
}

// ── 图标(与官网浮窗同一套 path)────────────────────────────────────
const ICON_PATHS: Record<string, React.ReactNode> = {
  wechat: (<><path d="M8.7 3C4.9 3 1.8 5.6 1.8 8.8c0 1.8 1 3.5 2.6 4.6l-.7 2 2.3-1.2c.8.2 1.6.4 2.4.4h.6c-.1-.4-.2-.9-.2-1.3 0-3.2 3.1-5.8 6.9-5.8h.6C15.6 4.9 12.5 3 8.7 3zM6.4 7.6c-.5 0-.9-.4-.9-.9s.4-.9.9-.9.9.4.9.9-.4.9-.9.9zm4.6 0c-.5 0-.9-.4-.9-.9s.4-.9.9-.9.9.4.9.9-.4.9-.9.9z" /><path d="M22.2 13.3c0-2.7-2.7-4.9-6-4.9s-6 2.2-6 4.9 2.7 4.9 6 4.9c.7 0 1.4-.1 2-.3l1.9 1-.5-1.6c1.6-.9 2.6-2.3 2.6-4zm-8-1c-.4 0-.8-.3-.8-.8s.3-.8.8-.8.8.3.8.8-.4.8-.8.8zm4 0c-.4 0-.8-.3-.8-.8s.3-.8.8-.8.8.3.8.8-.4.8-.8.8z" /></>),
  telegram: <path d="M21.9 4.3 18.7 19.4c-.2 1.1-.9 1.3-1.8.8l-5-3.7-2.4 2.3c-.3.3-.5.5-1 .5l.4-5.1L19.1 5c.4-.4-.1-.6-.6-.2L6.1 12.6l-5-1.6c-1.1-.3-1.1-1 .2-1.5l19.5-7.5c.9-.3 1.7.2 1.4 1.6z" />,
  qq_service: <path d="M12 2C8.7 2 6.3 4.2 6.3 7.4c0 .8-.2 1.3-.7 2-.9 1.2-1.4 2.3-1.4 3.4 0 .6.3 1 .8 1 .4 0 .7-.2 1-.7.2.9.6 1.7 1.2 2.4-.8.4-1.4 1-1.4 1.7 0 1.2 1.7 2.1 4 2.4-.3.3-.5.7-.5 1.1 0 .8.8 1.3 2.7 1.3s2.7-.5 2.7-1.3c0-.4-.2-.8-.5-1.1 2.3-.3 4-1.2 4-2.4 0-.7-.6-1.3-1.4-1.7.6-.7 1-1.5 1.2-2.4.3.5.6.7 1 .7.5 0 .8-.4.8-1 0-1.1-.5-2.2-1.4-3.4-.5-.7-.7-1.2-.7-2C17.7 4.2 15.3 2 12 2z" />,
  qq_group: (<><circle cx="12" cy="7.5" r="3.2" /><path d="M12 12.2c-3 0-5.6 1.6-5.6 3.6V19h11.2v-3.2c0-2-2.6-3.6-5.6-3.6z" /><circle cx="4.6" cy="9.2" r="2.3" /><path d="M4.6 12.6c-1.9 0-3.9 1-4.1 2.5-.1.6.4 1.1 1 1.1h3.2v-.4c0-1.2.5-2.3 1.4-3.1-.5-.1-1-.1-1.5-.1z" /><circle cx="19.4" cy="9.2" r="2.3" /><path d="M19.4 12.6c-.5 0-1 0-1.5.1.9.8 1.4 1.9 1.4 3.1v.4h3.2c.6 0 1.1-.5 1-1.1-.2-1.5-2.2-2.5-4.1-2.5z" /></>),
  email: <path d="M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 4.2-8 4.8-8-4.8V6l8 4.8L20 6v2.2z" />,
};

export const ContactIcon: React.FC<{ id: string; size?: number }> = ({ id, size = 20 }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" width={size} height={size} aria-hidden="true">{ICON_PATHS[id]}</svg>
);

// 渲染顺序 + 文案 key(与官网浮窗一致:微信客服/Telegram/QQ客服/QQ群/邮箱)
export const CONTACT_ORDER = ['wechat', 'telegram', 'qq_service', 'qq_group', 'email'] as const;
const LABEL_KEY: Record<string, string> = {
  wechat: 'cuWechat', telegram: 'cuTelegram', qq_service: 'cuQqService', qq_group: 'cuQqGroup', email: 'cuEmail',
};
export const contactLabel = (id: string) => i18nService.t(LABEL_KEY[id] || id);

// 后端可能存裸值(QQ 号/@handle/邮箱)也可能是完整链接 — 与官网同一套归一化
function toHref(key: string, raw?: string): string {
  const v = String(raw || '').trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v) || /^mailto:/i.test(v)) return v;
  if (key === 'email') return `mailto:${v}`;
  if (key === 'telegram') return `https://t.me/${v.replace(/^@/, '')}`;
  if (key === 'qq_service') return /^\d+$/.test(v) ? `tencent://message/?uin=${v}` : v;
  if (key === 'qq_group') return /^\d+$/.test(v) ? '' : v; // 纯群号无跳转协议 → 卡片展示+复制
  return v;
}

const openExternal = (url: string) => { try { (window as any).electron?.shell?.openExternal?.(url); } catch { /* noop */ } };

// ── 弹出卡片(点击条目触发,点遮罩/×关闭)──────────────────────────
const ContactModal: React.FC<{ id: string; conf: { link?: string; image?: string }; onClose: () => void }> = ({ id, conf, onClose }) => {
  const [copied, setCopied] = useState(false);
  const raw = String(conf.link || '').trim().replace(/^mailto:/i, '');
  const href = toHref(id, conf.link);
  const copyable = id === 'email' || (id === 'qq_group' && !href);
  const doCopy = () => {
    try { navigator.clipboard.writeText(raw); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* noop */ }
  };
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-white text-gray-900 rounded-2xl p-5 text-center shadow-2xl max-w-[280px] w-[85%]" onClick={(e) => e.stopPropagation()}>
        <div className="font-semibold mb-3">{contactLabel(id)}</div>
        {conf.image && (
          <img src={conf.image} alt={contactLabel(id)} className="w-[200px] h-[200px] object-contain mx-auto mb-3" />
        )}
        {copyable && raw && (
          <div className="flex items-center justify-center gap-2 text-sm">
            <span className="break-all">{id === 'qq_group' ? `${i18nService.t('cuGroupNo')} ${raw}` : raw}</span>
            <button type="button" onClick={doCopy} className="shrink-0 px-2 py-1 rounded-lg bg-gray-100 hover:bg-gray-200 text-xs">
              {copied ? i18nService.t('cuCopied') : i18nService.t('cuCopy')}
            </button>
          </div>
        )}
        {!copyable && href && (
          <button type="button" onClick={() => openExternal(href)} className="text-sm text-blue-600 hover:underline break-all">
            {i18nService.t('cuClickContact')} {raw}
          </button>
        )}
        <div className="mt-4">
          <button type="button" onClick={onClose} className="px-4 py-1.5 rounded-lg text-xs dark:bg-gray-100 bg-gray-100 hover:bg-gray-200 text-gray-600">
            {i18nService.t('cuClose')}
          </button>
        </div>
      </div>
    </div>
  );
};

// ── 行内面板(充值页底部 / 联系我们页)────────────────────────────
export const ContactInlinePanel: React.FC<{ showTitle?: boolean }> = ({ showTitle = true }) => {
  const contact = useSiteContact();
  const [openId, setOpenId] = useState<string | null>(null);
  const entries = CONTACT_ORDER.filter((k) => contact[k]);
  if (entries.length === 0) return null;
  return (
    <div className="mt-8 pt-5 border-t dark:border-claude-darkBorder border-claude-border">
      {showTitle && (
        <p className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-3">{i18nService.t('contactUsMenu')}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {entries.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setOpenId(k)}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-primary hover:border-primary/40 transition-colors"
          >
            <ContactIcon id={k} size={16} />
            {contactLabel(k)}
          </button>
        ))}
      </div>
      {openId && contact[openId] && (
        <ContactModal id={openId} conf={contact[openId]} onClose={() => setOpenId(null)} />
      )}
    </div>
  );
};

// ── 右侧悬浮小组件(首页)— 顶部「联系我们」字样,不带回到顶部 ────────
export const ContactFloatWidget: React.FC = () => {
  const contact = useSiteContact();
  const [openId, setOpenId] = useState<string | null>(null);
  const entries = CONTACT_ORDER.filter((k) => contact[k]);
  if (entries.length === 0) return null;
  return (
    <>
      <div className="fixed right-4 top-1/2 -translate-y-1/2 z-40 flex flex-col items-center gap-1 px-1.5 py-2.5 rounded-3xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/90 bg-claude-surface/95 backdrop-blur shadow-lg">
        <span className="text-[10px] leading-tight text-center dark:text-claude-darkTextSecondary text-claude-textSecondary select-none px-0.5" style={{ writingMode: 'initial' }}>
          {i18nService.t('contactUsMenu')}
        </span>
        <div className="w-5 h-px dark:bg-claude-darkBorder bg-claude-border my-0.5" />
        {entries.map((k) => (
          <button
            key={k}
            type="button"
            title={contactLabel(k)}
            aria-label={contactLabel(k)}
            onClick={() => setOpenId(k)}
            className="w-9 h-9 rounded-full flex items-center justify-center dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-primary hover:bg-primary/10 transition-all"
          >
            <ContactIcon id={k} size={18} />
          </button>
        ))}
      </div>
      {openId && contact[openId] && (
        <ContactModal id={openId} conf={contact[openId]} onClose={() => setOpenId(null)} />
      )}
    </>
  );
};
