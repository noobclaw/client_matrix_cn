/**
 * docs/emulator-drivers/*.js → src/main/libs/matrix/emulator/builtinDrivers.ts
 * 客户端内置的手机版剧本(后端 /api/matrix/drivers 没下发同名脚本时兜底)。改了 docs 下的脚本后跑:
 *   node scripts/gen-emulator-drivers.js
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'docs', 'emulator-drivers');
const OUT = path.join(ROOT, 'src', 'main', 'libs', 'matrix', 'emulator', 'builtinDrivers.ts');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const entries = {};
for (const f of fs.readdirSync(SRC).filter((x) => /^phone_\w+\.js$/.test(x)).sort()) {
  const code = fs.readFileSync(path.join(SRC, f), 'utf8');
  new AsyncFunction('ctx', code); // 语法检查:编译不过直接抛
  entries[f.replace(/\.js$/, '')] = code;
}
const body = Object.entries(entries).map(([k, v]) => `  ${k}: ${JSON.stringify(v)},`).join('\n');
fs.writeFileSync(OUT, `// 自动生成,勿手改 —— 源文件在 docs/emulator-drivers/,改完跑 node scripts/gen-emulator-drivers.js\n/* eslint-disable */\nexport const BUILTIN_DRIVERS: Record<string, string> = {\n${body}\n};\n`);
console.log('generated', Object.keys(entries).join(', '));
