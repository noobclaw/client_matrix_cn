/**
 * fontAsset — 把随包 vendor 的 Latin 展示字体(woff2)读出来,base64 内联成 @font-face,
 * 供「模板速生」主题(themes.ts)在无头渲染里用上真展示字体(Shrikhand / Syne / Space Grotesk /
 * Archivo / Instrument Serif)。
 *
 * 为什么内联 base64:htmlVideoRenderer 把网络封死(http/https/ws/wss),CDN 拿不到;直接把
 * woff2 当 data-URI 塞进 <style> 的 @font-face,离线也能用。文件都是 latin subset(~12–21KB),
 * 5 个加起来 ~78KB,内联进单张 HTML 完全可接受(HTML 只加载一次,不逐帧传)。
 *
 * 中文不内联:CJK 字体太大(思源黑 8.5MB),主题里中文走系统字体(宋体/PingFang/YaHei,按
 * serif/sans 切),已足够好看。这里只补 Latin 展示字。
 *
 * 路径探测 + 缓存套 gsapAsset / compose 的同款多根逻辑。文件在 resources/fonts/,由
 * prepare-tauri-resources.js 既有的 fonts 拷贝步骤打包(无需改打包脚本)。
 */

import path from 'path';
import fs from 'fs';
import { isPackaged, getResourcesPath, getUserDataPath } from '../platformAdapter';

// 文件名 → { family, weight, style }。family 要跟 themes.ts 的 font-family 名字对上。
// Archivo-800 同时登记成 'Archivo' 和 'Archivo Black'(bold_signal 用后者),一个文件两用。
const FONT_FACES: Array<{ file: string; family: string; weight: number; style?: string }> = [
  { file: 'Shrikhand-400.woff2', family: 'Shrikhand', weight: 400 },
  { file: 'Syne-800.woff2', family: 'Syne', weight: 800 },
  { file: 'SpaceGrotesk-700.woff2', family: 'Space Grotesk', weight: 700 },
  { file: 'Archivo-800.woff2', family: 'Archivo', weight: 800 },
  { file: 'Archivo-800.woff2', family: 'Archivo Black', weight: 400 },
  { file: 'InstrumentSerif-400.woff2', family: 'Instrument Serif', weight: 400 },
];

let _cached: string | null = null;
let _missingLogged = false;

/** 字体文件可能落地的目录集合(同 compose.bundledFontDirs / gsapAsset 的多根探测,子目录 fonts)。 */
function bundledFontDirs(): string[] {
  const dirs: string[] = [];
  const pushRoot = (root: string) => dirs.push(path.join(root, 'fonts'));
  if (isPackaged()) {
    const res = getResourcesPath();
    const exeDir = path.dirname(process.execPath);
    pushRoot(res);
    pushRoot(path.join(res, 'resources'));
    pushRoot(path.join(exeDir, 'resources'));
    pushRoot(path.join(exeDir, '..', 'Resources'));
    pushRoot(path.join(exeDir, '..', 'Resources', 'resources'));
  }
  for (const base of [
    path.resolve(__dirname, '..', '..', '..', '..'),
    path.resolve(__dirname, '..', '..', '..'),
    process.cwd(),
    path.join(process.cwd(), 'client'),
  ]) {
    pushRoot(path.join(base, 'resources'));
  }
  pushRoot(path.join(getUserDataPath(), 'runtimes'));
  return dirs;
}

function findFontFile(file: string, dirs: string[]): string | null {
  for (const dir of dirs) {
    const p = path.join(dir, file);
    try { if (fs.existsSync(p)) return p; } catch { /* keep probing */ }
  }
  return null;
}

/**
 * 生成所有随包 Latin 展示字体的 @font-face CSS(base64 内联,进程内缓存一次)。
 * 找不到文件就跳过那条(该字体自动退回系统 fallback);全找不到返回空串。绝不抛。
 */
export function loadFontFaceCss(): string {
  if (_cached !== null) return _cached;
  const dirs = bundledFontDirs();
  const faces: string[] = [];
  const missing: string[] = [];
  for (const f of FONT_FACES) {
    const p = findFontFile(f.file, dirs);
    if (!p) { missing.push(f.file); continue; }
    try {
      const b64 = fs.readFileSync(p).toString('base64');
      faces.push(
        `@font-face{font-family:'${f.family}';font-style:${f.style || 'normal'};font-weight:${f.weight};font-display:block;`
        + `src:url(data:font/woff2;base64,${b64}) format('woff2')}`,
      );
    } catch { missing.push(f.file); }
  }
  if (missing.length && !_missingLogged) {
    _missingLogged = true;
    try { console.warn('[fontAsset] missing bundled fonts: ' + missing.join(', ') + ' packaged=' + isPackaged()); } catch { /* ignore */ }
  }
  _cached = faces.join('\n');
  return _cached;
}
