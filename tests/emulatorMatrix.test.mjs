// 模拟器矩阵(feat/emulator-matrix)纯逻辑单测:不需要雷电 / adb / 真机。
// 运行:npm run test:emulator(先 compile:electron,再跑本文件)。
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import net from 'node:net';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const uiTree = require('../dist-electron/libs/matrix/emulator/uiTree.js');
const ldplayer = require('../dist-electron/libs/matrix/emulator/ldplayer.js');
const adbMod = require('../dist-electron/libs/matrix/emulator/adb.js');
const emuProxy = require('../dist-electron/libs/matrix/emulator/emulatorProxy.js');

const XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.zhiliaoapp.musically" content-desc="" clickable="false" enabled="true" bounds="[0,0][720,1280]">
    <node index="0" text="For You" resource-id="com.zhiliaoapp.musically:id/tab_foryou" class="android.widget.TextView" package="com.zhiliaoapp.musically" content-desc="" clickable="true" enabled="true" selected="true" bounds="[300,40][420,90]" />
    <node index="1" text="" resource-id="com.zhiliaoapp.musically:id/like" class="android.widget.ImageView" package="com.zhiliaoapp.musically" content-desc="Like video. 1.2K likes" clickable="true" enabled="true" bounds="[640,600][700,660]" />
    <node index="2" text="R&amp;D &quot;測試&quot; &#x1F600;" resource-id="" class="android.widget.TextView" package="com.zhiliaoapp.musically" content-desc="" clickable="false" enabled="true" bounds="[20,1100][500,1140]" />
    <node index="3" text="hidden" resource-id="" class="android.widget.TextView" package="com.zhiliaoapp.musically" content-desc="" clickable="false" enabled="true" bounds="[0,0][0,0]" />
  </node>
</hierarchy>`;

test('parseHierarchy: 扁平节点、深度、中心点、XML 反转义', () => {
  const nodes = uiTree.parseHierarchy(XML);
  assert.equal(nodes.length, 5);
  assert.equal(nodes[0].depth, 0);
  assert.equal(nodes[1].depth, 1);
  assert.equal(nodes[1].text, 'For You');
  assert.deepEqual([nodes[2].cx, nodes[2].cy], [670, 630]);
  assert.equal(nodes[3].text, 'R&D "測試" 😀');
  assert.equal(nodes[4].visible, false, '零面积节点视为不可见');
});

test('选择器:resourceId / descContains / textMatches / 缺省只取可见', () => {
  const nodes = uiTree.parseHierarchy(XML);
  assert.equal(uiTree.findOne(nodes, { resourceId: 'com.zhiliaoapp.musically:id/like' }).index, 2);
  assert.equal(uiTree.findOne(nodes, { descContains: 'Like video' }).index, 2);
  assert.equal(uiTree.findOne(nodes, { textMatches: '^For' }).index, 1);
  assert.equal(uiTree.findOne(nodes, { text: 'hidden' }), undefined);
  assert.equal(uiTree.findOne(nodes, { text: 'hidden', visibleOnly: false }).index, 4);
  assert.equal(uiTree.findOne(nodes, { textMatches: '(' }), undefined, '坏正则不抛');
  assert.equal(uiTree.findAll(nodes, { clickable: true }).length, 2);
});

test('summarize 只列有内容的可见节点', () => {
  const s = uiTree.summarize(uiTree.parseHierarchy(XML));
  assert.match(s, /id=com\.zhiliaoapp\.musically:id\/tab_foryou/);
  assert.doesNotMatch(s, /hidden/);
});

test('parseList2:雷电 list2 输出', () => {
  const out = '0,雷电模拟器,0,0,0,-1,-1,720,1280,320\r\n1,nc_tiktok_abc,262874,329500,1,10872,11240,720,1280,320\r\n\r\n';
  const rows = ldplayer.parseList2(out);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].name, 'nc_tiktok_abc');
  assert.equal(rows[1].androidStarted, true);
  assert.equal(rows[1].pid, 10872);
  assert.equal(rows[0].pid, -1);
});

test('adb 参数白名单:包名 / 设备路径', () => {
  assert.equal(adbMod.assertPkg('com.zhiliaoapp.musically'), 'com.zhiliaoapp.musically');
  assert.throws(() => adbMod.assertPkg('com.x; rm -rf /'));
  assert.throws(() => adbMod.assertPkg('nodots'));
  assert.equal(adbMod.assertDevicePath('/sdcard/DCIM/NoobClaw/a.mp4'), '/sdcard/DCIM/NoobClaw/a.mp4');
  assert.throws(() => adbMod.assertDevicePath('/sdcard/../data'));
  assert.throws(() => adbMod.assertDevicePath('/sdcard/a b.mp4'));
});

// ── 代理中转端到端:客户端 → 本机 HTTP 中转 → 假上游(HTTP CONNECT,带账密)→ 目标 TCP 服务 ──
function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

test('ensureHttpBridge:CONNECT 经带账密的 HTTP 上游打通,账密正确才放行', async () => {
  const target = net.createServer((s) => s.on('data', (d) => s.write('echo:' + d.toString())));
  const targetPort = await listen(target);

  let sawAuth = '';
  const upstream = http.createServer();
  upstream.on('connect', (req, client) => {
    sawAuth = req.headers['proxy-authorization'] || '';
    if (sawAuth !== 'Basic ' + Buffer.from('u:p').toString('base64')) { client.end('HTTP/1.1 407 Auth\r\n\r\n'); return; }
    const [h, p] = req.url.split(':');
    const up = net.connect(+p, h, () => { client.write('HTTP/1.1 200 OK\r\n\r\n'); up.pipe(client); client.pipe(up); });
  });
  const upstreamPort = await listen(upstream);

  const bridgePort = await emuProxy.ensureHttpBridge({ protocol: 'http', host: '127.0.0.1', port: upstreamPort, username: 'u', password: 'p' });
  const again = await emuProxy.ensureHttpBridge({ protocol: 'http', host: '127.0.0.1', port: upstreamPort, username: 'u', password: 'p' });
  assert.equal(again, bridgePort, '同一上游复用同一中转');

  const reply = await new Promise((resolve, reject) => {
    const c = net.connect(bridgePort, '127.0.0.1', () => c.write(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: x\r\n\r\n`));
    let buf = '';
    let sent = false;
    c.on('data', (d) => {
      buf += d.toString();
      if (!sent && buf.includes('\r\n\r\n')) { assert.match(buf, /^HTTP\/1\.1 200/); sent = true; buf = ''; c.write('hi'); return; }
      if (sent && buf) { resolve(buf); c.destroy(); }
    });
    c.on('error', reject);
    setTimeout(() => reject(new Error('timeout')), 5000);
  });
  assert.equal(reply, 'echo:hi');
  assert.equal(sawAuth, 'Basic ' + Buffer.from('u:p').toString('base64'));

  // 账密错误的上游 → 中转回 502
  const badPort = await emuProxy.ensureHttpBridge({ protocol: 'http', host: '127.0.0.1', port: upstreamPort, username: 'u', password: 'wrong' });
  const bad = await new Promise((resolve) => {
    const c = net.connect(badPort, '127.0.0.1', () => c.write(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\n\r\n`));
    c.on('data', (d) => { resolve(d.toString()); c.destroy(); });
  });
  assert.match(bad, /^HTTP\/1\.1 502/);

  target.close(); upstream.close();
});

test('ensureHttpBridge:上游握手期间客户端断开不会打崩进程;上游不回就断开时客户端收到 502', async () => {
  // 慢上游:收到 CONNECT 后 300ms 才回 200
  const slow = net.createServer((s) => { s.once('data', () => setTimeout(() => { try { s.write('HTTP/1.1 200 OK\r\n\r\n'); } catch {} }, 300)); s.on('error', () => {}); });
  const slowPort = await listen(slow);
  const bridge = await emuProxy.ensureHttpBridge({ protocol: 'http', host: '127.0.0.1', port: slowPort });
  await new Promise((resolve) => {
    const c = net.connect(bridge, '127.0.0.1', () => { c.write('CONNECT example.com:443 HTTP/1.1\r\n\r\n'); setTimeout(() => { c.resetAndDestroy ? c.resetAndDestroy() : c.destroy(); resolve(); }, 50); });
    c.on('error', () => {});
  });
  await new Promise((r) => setTimeout(r, 600)); // 进程还活着就算过

  // 哑上游:收到 CONNECT 直接关连接
  const mute = net.createServer((s) => { s.once('data', () => s.end()); s.on('error', () => {}); });
  const mutePort = await listen(mute);
  const bridge2 = await emuProxy.ensureHttpBridge({ protocol: 'http', host: '127.0.0.1', port: mutePort });
  const reply = await new Promise((resolve, reject) => {
    const c = net.connect(bridge2, '127.0.0.1', () => c.write('CONNECT example.com:443 HTTP/1.1\r\n\r\n'));
    c.on('data', (d) => { resolve(d.toString()); c.destroy(); });
    c.on('error', reject);
    setTimeout(() => reject(new Error('hung')), 5000);
  });
  assert.match(reply, /^HTTP\/1\.1 502/);
  slow.close(); mute.close();
});
