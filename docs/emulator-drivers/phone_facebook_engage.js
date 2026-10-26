// phone_facebook_engage —— Facebook App(雷电模拟器)信息流自动点赞 + 评论。
// 运行环境同 phone_tiktok_engage(engageRunner ctx + ctx.phone)。后端下发同名脚本时以后端为准。
// 第一版只刷首页信息流(不按关键词搜);节奏沿用网页版 facebook_auto_engage 的 behavior 配置。
var P = ctx.phone, T = ctx.task || {}, CFG = (ctx.config && ctx.config.behavior) || {};
var PKG = 'com.facebook.katana';
function rint(a, b) { a = Number(a) || 0; b = Number(b) || 0; if (b < a) { var t = a; a = b; b = t; } return a + Math.floor(Math.random() * (b - a + 1)); }
function range(name, def) { var r = CFG[name]; return Array.isArray(r) && r.length === 2 ? r : def; }
async function pause(name, def) { var r = range(name, def); await ctx.sleep(r[0], r[1]); }
function say(m) { ctx.report(m); }

var nLike = rint(T.daily_like_min, T.daily_like_max);
var nCmt = rint(T.daily_comment_min, T.daily_comment_max);
if (nLike + nCmt === 0) { ctx.finish('error', 'no_actions'); return { status: 'failed', reason: '点赞/评论配额都是 0' }; }
ctx.setActionTargets({ like: nLike, comment: nCmt });
var done = { like: 0, comment: 0 };

if (!(await P.appInstalled(PKG))) { ctx.finish('error', 'app_not_installed'); return { status: 'failed', reason: '模拟器里没装 Facebook' }; }
var scr = await P.screen();
var W = scr.width, H = scr.height;
await P.appStop(PKG);
await ctx.sleep(1500);
await P.appStart(PKG);
say('📱 已打开 Facebook,等待首屏');
await pause('first_screen_pause', [8000, 14000]);

// Facebook 无障碍标签:点赞按钮 desc 形如 "Like button. Double tap and hold to react." / 中文「赞按钮」;
// 评论按钮 desc/text 含 Comment / 评论 / 留言。已赞时 desc 变成 "Liked" / "Unlike" / 「已赞」。
var LIKE_RE = '^(Like button|Like$|赞按钮|讚按鈕|赞$|讚$|Thích|Me gusta|いいね)';
var LIKED_RE = '(Liked|Unlike|已赞|已讚|取消赞|收回讚|Đã thích)';
var CMT_RE = '^(Comment|评论|評論|留言|Bình luận|Comentar|コメント)';
var LOGIN_RE = '^(Log in|Log In|登录|登入|Create new account|创建新帐户|建立新帳號)';

async function nodes() { return await P.dump(); }
function all(ns, field, re) { var rx = new RegExp(re, 'i'); return ns.filter(function (n) { return n.visible && rx.test(n[field] || ''); }); }
function first(ns, field, re) { var a = all(ns, field, re); return a.length ? a[0] : null; }

var ns0 = await nodes();
if (first(ns0, 'text', LOGIN_RE) && !first(ns0, 'desc', LIKE_RE) && !first(ns0, 'text', LIKE_RE)) {
  ctx.finish('error', 'login_required');
  return { status: 'failed', reason: 'login_required' };
}

// 帖子正文 / 作者:取点赞按钮上方、同一屏里最长的那段文字;作者取其上方第一条短文字。
function postContext(ns, likeBtn) {
  var text = '', author = '';
  var top = Math.max(0, likeBtn.cy - H * 0.55);
  for (var k = 0; k < ns.length; k++) {
    var n = ns[k];
    if (!n.visible) continue;
    var t = n.text || n.desc || '';
    if (n.cy < top || n.cy >= likeBtn.cy - 10) continue;
    if (t.length > text.length && t.length > 15 && !/button|按钮|按鈕/i.test(t)) text = t;
  }
  for (var j = 0; j < ns.length; j++) {
    var m = ns[j];
    if (!m.visible) continue;
    var s = m.text || '';
    if (m.cy < top || m.cy >= likeBtn.cy) continue;
    if (s && s.length <= 40 && s !== text && !/[·•]/.test(s)) { author = s; break; }
  }
  return { text: text.slice(0, 800), author: author };
}
function keyOf(c) { var s = (c.author + '|' + c.text).slice(0, 160); var h = 0; for (var k = 0; k < s.length; k++) { h = ((h << 5) - h + s.charCodeAt(k)) | 0; } return 'f' + (h >>> 0).toString(36); }
async function scrollFeed() { await P.swipe(W / 2 + rint(-40, 40), H * 0.8, W / 2 + rint(-40, 40), H * 0.35, rint(350, 600)); }

var langHint = T.comment_language_hint || (ctx.config && ctx.config.language_modes && ctx.config.language_modes.auto && ctx.config.language_modes.auto.system_hint) || '';
var maxScreens = Math.min(150, (nLike + nCmt) * 4 + 15);
var screens = 0;

while (screens < maxScreens && (done.like < nLike || done.comment < nCmt)) {
  if (ctx.aborted()) { ctx.finish('error', 'user_stopped'); return { status: 'failed', reason: 'user_stopped', done: done }; }
  screens++;
  if ((await P.appCurrent()) !== PKG) { say('⚠️ Facebook 不在前台,重新打开'); await P.appStart(PKG); await ctx.sleep(5000, 8000); continue; }
  var ns = await nodes();
  // 本屏可见、未赞过、在屏幕中下部(帖子正文大概率在屏内)的点赞按钮
  var likes = all(ns, 'desc', LIKE_RE).concat(all(ns, 'text', LIKE_RE)).filter(function (n) { return n.cy > H * 0.3 && n.cy < H * 0.92 && !new RegExp(LIKED_RE, 'i').test(n.desc + ' ' + n.text); });
  if (!likes.length) { await scrollFeed(); await pause('feed_scroll_pause', [4000, 10000]); continue; }
  var btn = likes[0];
  var c = postContext(ns, btn);
  var key = keyOf(c);
  if (!c.text || /Sponsored|赞助内容|贊助|广告/i.test(c.author + ' ' + c.text) || (ctx.engageHistory && ctx.engageHistory.has('phone', key))) {
    await scrollFeed(); await pause('feed_scroll_pause', [4000, 10000]); continue;
  }
  await pause('watch_dwell_ms', [6000, 30000]);
  var acted = false;
  var remain = Math.max(1, maxScreens - screens + 1);

  if (done.like < nLike && Math.random() < Math.min(1, (nLike - done.like) / remain * 2.2)) {
    await pause('before_like_pause', [3000, 8000]);
    if (ctx.aborted()) break;
    await P.tap(btn.cx, btn.cy);
    await ctx.sleep(1500, 2500);
    var nsA = await nodes();
    var nowLiked = all(nsA, 'desc', LIKED_RE).concat(all(nsA, 'text', LIKED_RE)).some(function (n) { return Math.abs(n.cy - btn.cy) < 40; });
    if (nowLiked) {
      done.like++; acted = true; ctx.addActionCount('like', 1);
      await ctx.chargeAction('like', 'facebook');
      say('👍 点赞 ' + done.like + '/' + nLike + (c.author ? ' · ' + c.author : ''));
    } else { say('⚠️ 点赞没生效(或弹出了表情面板),跳过'); await P.back(); await ctx.sleep(800, 1500); }
  }

  if (done.comment < nCmt && Math.random() < Math.min(1, (nCmt - done.comment) / remain * 2.2)) {
    var nsB = await nodes();
    var cmt = all(nsB, 'desc', CMT_RE).concat(all(nsB, 'text', CMT_RE)).filter(function (n) { return Math.abs(n.cy - btn.cy) < 60; })[0];
    if (cmt) {
      await pause('before_comment_open_pause', [4000, 10000]);
      if (ctx.aborted()) break;
      await P.tap(cmt.cx, cmt.cy);
      await pause('comment_panel_pause', [3000, 6000]);
      var text = '';
      try {
        var raw = await ctx.aiCall('comment_composer', JSON.stringify({
          author_name: c.author, post_text: c.text, track: T.track || '', user_prompt: T.comment_prompt || '', language_hint: langHint,
        }), undefined, { expectJson: false });
        text = String(raw || '').trim().replace(/^["'“”]+|["'“”]+$/g, '').trim().slice(0, 150);
      } catch (e) { say('⚠️ AI 生成评论失败:' + String(e && e.message || e).slice(0, 60)); }
      var nsC = await nodes();
      // 只认真正的输入框(EditText);「Write a comment」可能只是个占位 TextView,点了也输不进去。
      var input = null;
      for (var k = 0; k < nsC.length; k++) { if (nsC[k].visible && /EditText/.test(nsC[k].className)) { input = nsC[k]; break; } }
      if (!input) {
        var ph = first(nsC, 'text', '^(Write a comment|写评论|撰寫留言|留言|Viết bình luận|Escribe un comentario)');
        if (ph) { await P.tap(ph.cx, ph.cy); await ctx.sleep(1500, 2500); var nsC2 = await nodes(); for (var k2 = 0; k2 < nsC2.length; k2++) { if (nsC2[k2].visible && /EditText/.test(nsC2[k2].className)) { input = nsC2[k2]; break; } } }
      }
      if (text && input) {
        await P.tap(input.cx, input.cy);
        await pause('comment_input_focus_pause', [1200, 2500]);
        await P.inputText(text);
        await ctx.sleep(1500, 3000);
        var nsS = await nodes();
        var held = nsS.some(function (n) { return n.visible && /EditText/.test(n.className) && (n.text || '').indexOf(text.slice(0, 12)) >= 0; });
        // 发送按钮只在输入框同一行或下方找,避免点到帖子上的「Comment」按钮。
        var send = all(nsS, 'desc', '^(Send|Post|Comment|发送|發送|发布|發佈|留言|Gửi|Enviar)$').filter(function (n) { return n.cy >= input.cy - 40; })[0];
        if (!held) { say('⚠️ 评论文字没输进去,跳过'); }
        else if (!ctx.aborted()) {
        if (send) { await P.tap(send.cx, send.cy); } else { await P.enter(); }
        await ctx.sleep(3000, 5000);
        var nsV = await nodes();
        var pending = nsV.some(function (n) { return n.visible && /EditText/.test(n.className) && (n.text || '').indexOf(text.slice(0, 12)) >= 0; });
        if (!pending) {
          done.comment++; acted = true; ctx.addActionCount('comment', 1);
          await ctx.chargeAction('comment', 'facebook');
          say('💬 评论 ' + done.comment + '/' + nCmt + ':' + text);
        } else { say('⚠️ 评论好像没发出去,跳过'); }
        }
      } else if (!input) { say('⚠️ 没找到评论输入框'); }
      await P.back(); await ctx.sleep(800, 1500);
      if (!(await P.find({ descMatches: LIKE_RE })) && !(await P.find({ textMatches: LIKE_RE }))) { await P.back(); await ctx.sleep(800, 1500); }
    }
  }

  if (ctx.engageHistory) ctx.engageHistory.remember('phone', key);
  await (acted ? pause('between_videos_pause', [10000, 40000]) : pause('feed_scroll_pause', [4000, 10000]));
  await scrollFeed();
  await ctx.sleep(1500, 3000);
}

if (ctx.aborted()) { ctx.finish('error', 'user_stopped'); return { status: 'failed', reason: 'user_stopped', done: done }; }
say('✅ 完成:点赞 ' + done.like + '/' + nLike + ',评论 ' + done.comment + '/' + nCmt + '(刷了 ' + screens + ' 屏)');
ctx.finish('done');
return { status: 'done', done: done };
