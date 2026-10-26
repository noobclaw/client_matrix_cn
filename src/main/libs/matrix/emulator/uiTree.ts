/**
 * 解析 UiAutomator dumpWindowHierarchy 的 XML → 扁平节点数组 + 简易选择器。
 *
 * 不引第三方 XML 库:hierarchy 的格式固定(<node attr="..."/> 嵌套),属性值经 XML 转义,
 * 用一个小的标签扫描器就够了,也方便在 node:test 里单测。
 */

export interface UiNode {
  index: number;            // 在扁平数组里的序号(文档顺序)
  depth: number;
  text: string;
  resourceId: string;
  desc: string;             // content-desc
  className: string;
  packageName: string;
  clickable: boolean;
  longClickable: boolean;
  scrollable: boolean;
  enabled: boolean;
  focused: boolean;
  selected: boolean;
  checked: boolean;
  visible: boolean;         // displayed 属性(新版 u2 有;没有则按 bounds 面积判断)
  bounds: [number, number, number, number]; // x1,y1,x2,y2
  cx: number;
  cy: number;
}

export interface UiSelector {
  text?: string;
  textContains?: string;
  textMatches?: string;     // 正则源码
  resourceId?: string;
  resourceIdContains?: string;
  desc?: string;
  descContains?: string;
  descMatches?: string;
  className?: string;
  packageName?: string;
  clickable?: boolean;
  scrollable?: boolean;
  selected?: boolean;
  visibleOnly?: boolean;    // 缺省 true:只要可见节点
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    }
    return ENT[e.toLowerCase()] ?? '';
  });
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:-]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1]] = unescapeXml(m[2]);
  return out;
}

function parseBounds(b: string | undefined): [number, number, number, number] {
  const m = (b || '').match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
  if (!m) return [0, 0, 0, 0];
  return [+m[1], +m[2], +m[3], +m[4]];
}

export function parseHierarchy(xml: string): UiNode[] {
  const nodes: UiNode[] = [];
  const re = /<(\/?)node\b([^>]*?)(\/?)>/g;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const closing = m[1] === '/';
    if (closing) { depth = Math.max(0, depth - 1); continue; }
    const a = parseAttrs(m[2]);
    const bounds = parseBounds(a.bounds);
    const area = Math.max(0, bounds[2] - bounds[0]) * Math.max(0, bounds[3] - bounds[1]);
    nodes.push({
      index: nodes.length,
      depth,
      text: a.text || '',
      resourceId: a['resource-id'] || '',
      desc: a['content-desc'] || '',
      className: a.class || '',
      packageName: a.package || '',
      clickable: a.clickable === 'true',
      longClickable: a['long-clickable'] === 'true',
      scrollable: a.scrollable === 'true',
      enabled: a.enabled !== 'false',
      focused: a.focused === 'true',
      selected: a.selected === 'true',
      checked: a.checked === 'true',
      visible: a.displayed ? a.displayed !== 'false' && area > 0 : area > 0,
      bounds,
      cx: Math.round((bounds[0] + bounds[2]) / 2),
      cy: Math.round((bounds[1] + bounds[3]) / 2),
    });
    if (m[3] !== '/') depth++;
  }
  return nodes;
}

function safeRegex(src: string): RegExp | null {
  try { return new RegExp(src); } catch { return null; }
}

export function matchNode(n: UiNode, sel: UiSelector): boolean {
  if (sel.visibleOnly !== false && !n.visible) return false;
  if (sel.text !== undefined && n.text !== sel.text) return false;
  if (sel.textContains !== undefined && !n.text.includes(sel.textContains)) return false;
  if (sel.textMatches !== undefined) { const r = safeRegex(sel.textMatches); if (!r || !r.test(n.text)) return false; }
  if (sel.resourceId !== undefined && n.resourceId !== sel.resourceId) return false;
  if (sel.resourceIdContains !== undefined && !n.resourceId.includes(sel.resourceIdContains)) return false;
  if (sel.desc !== undefined && n.desc !== sel.desc) return false;
  if (sel.descContains !== undefined && !n.desc.includes(sel.descContains)) return false;
  if (sel.descMatches !== undefined) { const r = safeRegex(sel.descMatches); if (!r || !r.test(n.desc)) return false; }
  if (sel.className !== undefined && n.className !== sel.className) return false;
  if (sel.packageName !== undefined && n.packageName !== sel.packageName) return false;
  if (sel.clickable !== undefined && n.clickable !== sel.clickable) return false;
  if (sel.scrollable !== undefined && n.scrollable !== sel.scrollable) return false;
  if (sel.selected !== undefined && n.selected !== sel.selected) return false;
  return true;
}

export function findAll(nodes: UiNode[], sel: UiSelector): UiNode[] {
  return nodes.filter((n) => matchNode(n, sel));
}

export function findOne(nodes: UiNode[], sel: UiSelector): UiNode | undefined {
  return nodes.find((n) => matchNode(n, sel));
}

/** 给 driver 作者看的精简文本(每行一个有内容的节点),也给日志用。 */
export function summarize(nodes: UiNode[], max = 200): string {
  const lines: string[] = [];
  for (const n of nodes) {
    if (!n.visible) continue;
    if (!n.text && !n.desc && !n.resourceId && !n.clickable) continue;
    const parts = [
      `#${n.index}`,
      n.className.split('.').pop(),
      n.resourceId ? `id=${n.resourceId}` : '',
      n.text ? `text=${JSON.stringify(n.text.slice(0, 40))}` : '',
      n.desc ? `desc=${JSON.stringify(n.desc.slice(0, 40))}` : '',
      n.clickable ? 'clickable' : '',
      `@${n.cx},${n.cy}`,
    ].filter(Boolean);
    lines.push('  '.repeat(Math.min(n.depth, 12)) + parts.join(' '));
    if (lines.length >= max) break;
  }
  return lines.join('\n');
}
