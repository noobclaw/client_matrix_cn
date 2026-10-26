// phone_tiktok_engage —— TikTok App(雷电模拟器)自动点赞 + 评论。
// 运行环境:engageRunner 的 ctx(task 配额 / aiCall 评论 / chargeAction 计费 / engageHistory 去重 / report 日志)
//          + ctx.phone(模拟器操作,见 emulator/phoneDriverCtx.ts)。
// 后端 /api/matrix/drivers 下发同名脚本时以后端为准(热更新),本文件是客户端内置兜底。
// 节奏沿用网页版 tiktok_auto_engage 的 behavior 配置;只做点赞、评论(关注/收藏不做)。
var P = ctx.phone, T = ctx.task || {}, CFG = (ctx.config && ctx.config.behavior) || {};
var PKGS = ['com.zhiliaoapp.musically', 'com.ss.android.ugc.trill'];
function rint(a, b) { a = Number(a) || 0; b = Number(b) || 0; if (b < a) { var t = a; a = b; b = t; } return a + Math.floor(Math.random() * (b - a + 1)); }
function range(name, def) { var r = CFG[name]; return Array.isArray(r) && r.length === 2 ? r : def; }
async function pause(name, def) { var r = range(name, def); await ctx.sleep(r[0], r[1]); }
function say(m) { ctx.report(m); }

var nLike = rint(T.daily_like_min, T.daily_like_max);
var nCmt = rint(T.daily_comment_min, T.daily_comment_max);
if (nLike + nCmt === 0) { ctx.finish('error', 'no_actions'); return { status: 'failed', reason: '点赞/评论配额都是 0' }; }
ctx.setActionTargets({ like: nLike, comment: nCmt });
var done = { like: 0, comment: 0 };

// ── 打开 App ──
var pkg = null;
for (var i = 0; i < PKGS.length; i++) { if (await P.appInstalled(PKGS[i])) { pkg = PKGS[i]; break; } }
if (!pkg) { ctx.finish('error', 'app_not_installed'); return { status: 'failed', reason: '模拟器里没装 TikTok' }; }
var scr = await P.screen();
var W = scr.width, H = scr.height;
await P.appStop(pkg);
await ctx.sleep(1500);
await P.appStart(pkg);
say('📱 已打开 TikTok,等待首屏');
await pause('first_screen_pause', [8000, 14000]);

var LIKE_RE = '^(Like|Liked|点赞|讚|赞|喜欢|いいね|좋아요|Thích|Me gusta)';
var CMT_RE = '(comment|评论|評論|留言|コメント|댓글|Bình luận|Comentar)';
var LOGIN_RE = '^(Log in|Sign up|Log in to TikTok|Sign up for TikTok|登录|登入|注册|註冊|ログイン)';

async function nodes() { return await P.dump(); }
function findRe(ns, field, re, extra) {
  var rx = new RegExp(re, 'i');
  for (var k = 0; k < ns.length; k++) { var n = ns[k]; if (!n.visible) continue; if (rx.test(n[field] || '') && (!extra || extra(n))) return n; }
  return null;
}
function rightRail(n) { return n.cx > W * 0.75; }

// 登录墙检测:有登录/注册按钮且右侧栏没有点赞按钮 → 未登录。
var ns0 = await nodes();
if (findRe(ns0, 'text', LOGIN_RE) && !findRe(ns0, 'desc', LIKE_RE, rightRail)) {
  ctx.finish('error', 'login_required');
  return { status: 'failed', reason: 'login_required' };
}

// ── 关键词搜索(有关键词且非刷剧模式);失败就退回推荐流 ──
var kws = Array.isArray(T.keywords) ? T.keywords.filter(Boolean) : [];
var keyword = '';
if (kws.length && String(T.engage_mode || '') !== 'binge') {
  keyword = kws[rint(0, kws.length - 1)];
  var searchBtn = findRe(ns0, 'desc', '^(Search|搜索|搜尋|検索|검색|Tìm kiếm|Buscar)');
  if (searchBtn) {
    await P.tap(searchBtn.cx, searchBtn.cy);
    await ctx.sleep(2500, 4000);
    var ns1 = await nodes();
    var box = null;
    for (var b = 0; b < ns1.length; b++) { if (ns1[b].visible && /EditText/.test(ns1[b].className)) { box = ns1[b]; break; } }
    if (box) {
      await P.tap(box.cx, box.cy);
      await ctx.sleep(800, 1500);
      await P.inputText(keyword);
      await ctx.sleep(800, 1500);
      await P.enter();
      say('🔍 搜索关键词:' + keyword);
      await ctx.sleep(4000, 7000);
      var ns2 = await nodes();
      var vtab = findRe(ns2, 'text', '^(Videos|视频|影片|動画|동영상|Video)$');
      if (vtab) { await P.tap(vtab.cx, vtab.cy); await ctx.sleep(3000, 5000); ns2 = await nodes(); }
      // 结果网格:第一个在标签栏下方、足够大的可点击块
      var first = null;
      for (var g = 0; g < ns2.length; g++) {
        var n2 = ns2[g];
        if (!n2.visible || !n2.clickable) continue;
        var bw = n2.bounds[2] - n2.bounds[0], bh = n2.bounds[3] - n2.bounds[1];
        if (n2.bounds[1] > H * 0.18 && bw > W * 0.3 && bh > H * 0.15) { first = n2; break; }
      }
      if (first) { await P.tap(first.cx, first.cy); say('▶ 打开搜索结果'); await ctx.sleep(4000, 6000); }
      else { say('⚠️ 没找到搜索结果,改刷推荐流'); await P.back(); await ctx.sleep(1000, 2000); await P.back(); keyword = ''; }
    } else { say('⚠️ 没找到搜索框,改刷推荐流'); await P.back(); keyword = ''; }
  } else { say('⚠️ 没找到搜索按钮,改刷推荐流'); }
} else {
  say('📺 推荐流模式');
}

// ── 逐个视频处理 ──
function videoInfo(ns) {
  var author = '', desc = '', live = false, ad = false;
  for (var k = 0; k < ns.length; k++) {
    var n = ns[k];
    if (!n.visible) continue;
    var t = n.text || '';
    if (/^LIVE$|直播中|LIVE NOW/i.test(t)) live = true;
    if (/^(Sponsored|Ad|广告|廣告|赞助|贊助)$/i.test(t)) ad = true;
    if (!author && /^@/.test(t) && n.cy > H * 0.55) author = t;
    if (n.cy > H * 0.55 && n.cx < W * 0.78 && t.length > desc.length && t.length > 8 && !/^@/.test(t)) desc = t;
  }
  return { author: author, desc: desc, live: live, ad: ad };
}
function keyOf(info) { var s = (info.author + '|' + info.desc).slice(0, 160); var h = 0; for (var k = 0; k < s.length; k++) { h = ((h << 5) - h + s.charCodeAt(k)) | 0; } return 'v' + (h >>> 0).toString(36); }
async function nextVideo() { await P.swipe(W / 2 + rint(-30, 30), H * 0.78, W / 2 + rint(-30, 30), H * 0.22, rint(250, 450)); }

var maxVideos = Math.min(200, (nLike + nCmt) * 4 + 15);
var seen = 0;
var langHint = T.comment_language_hint || (ctx.config && ctx.config.language_modes && ctx.config.language_modes.auto && ctx.config.language_modes.auto.system_hint) || '';

while (seen < maxVideos && (done.like < nLike || done.comment < nCmt)) {
  if (ctx.aborted()) { ctx.finish('error', 'user_stopped'); return { status: 'failed', reason: 'user_stopped', done: done }; }
  seen++;
  var ns = await nodes();
  if (P && (await P.appCurrent()) !== pkg) { say('⚠️ TikTok 不在前台,重新打开'); await P.appStart(pkg); await ctx.sleep(5000, 8000); continue; }
  var info = videoInfo(ns);
  var key = keyOf(info);
  if (info.live || info.ad || (ctx.engageHistory && ctx.engageHistory.has('phone', key))) { await nextVideo(); await pause('feed_scroll_pause', [4000, 10000]); continue; }
  await pause('watch_dwell_ms', [10000, 30000]);
  var acted = false;
  var remainVideos = Math.max(1, maxVideos - seen + 1);

  // 点赞
  if (done.like < nLike && Math.random() < Math.min(1, (nLike - done.like) / remainVideos * 2.2)) {
    var likeBtn = findRe(await nodes(), 'desc', LIKE_RE, rightRail);
    if (likeBtn && !likeBtn.selected && !/^Liked/i.test(likeBtn.desc)) {
      await pause('before_like_pause', [3000, 8000]);
      await P.tap(likeBtn.cx, likeBtn.cy);
      await ctx.sleep(1200, 2000);
      var after = findRe(await nodes(), 'desc', LIKE_RE, rightRail);
      if (!after || after.selected || /^Liked/i.test(after.desc) || after.desc !== likeBtn.desc) {
        done.like++; acted = true; ctx.addActionCount('like', 1);
        await ctx.chargeAction('like', 'tiktok');
        say('👍 点赞 ' + done.like + '/' + nLike + (info.author ? ' · ' + info.author : ''));
      } else { say('⚠️ 点赞没生效,跳过'); }
    }
  }

  // 评论
  if (done.comment < nCmt && info.desc && Math.random() < Math.min(1, (nCmt - done.comment) / remainVideos * 2.2)) {
    var cmtBtn = findRe(await nodes(), 'desc', CMT_RE, rightRail);
    if (cmtBtn) {
      await pause('before_comment_open_pause', [4000, 10000]);
      await P.tap(cmtBtn.cx, cmtBtn.cy);
      await pause('comment_panel_pause', [3000, 6000]);
      var text = '';
      try {
        var raw = await ctx.aiCall('comment_composer', JSON.stringify({
          author_name: info.author, video_desc: info.desc, top_comments: '', track: T.track || '', keyword: keyword,
          user_prompt: T.comment_prompt || '', language_hint: langHint,
        }), undefined, { expectJson: false });
        text = String(raw || '').trim().replace(/^["'“”]+|["'“”]+$/g, '').trim().slice(0, 150);
      } catch (e) { say('⚠️ AI 生成评论失败:' + String(e && e.message || e).slice(0, 60)); }
      var nsC = await nodes();
      var input = findRe(nsC, 'text', '^(Add comment|Add a comment|添加评论|新增留言|發表留言|说点什么|コメントを追加|댓글 추가|Thêm bình luận|Añadir comentario)');
      if (!input) { for (var e2 = 0; e2 < nsC.length; e2++) { if (nsC[e2].visible && /EditText/.test(nsC[e2].className) && nsC[e2].cy > H * 0.6) { input = nsC[e2]; break; } } }
      if (text && input) {
        await P.tap(input.cx, input.cy);
        await pause('comment_input_focus_pause', [1200, 2500]);
        await P.inputText(text);
        await ctx.sleep(1500, 3000);
        var nsS = await nodes();
        var send = findRe(nsS, 'desc', '^(Post|Post comment|Send|发送|發送|发布|發佈|送信|게시|Đăng|Publicar)');
        if (!send) send = findRe(nsS, 'text', '^(Post|Send|发送|發送|发布|發佈|送信|게시|Đăng|Publicar)$');
        if (send) { await P.tap(send.cx, send.cy); } else { await P.enter(); }
        await ctx.sleep(2500, 4000);
        var nsV = await nodes();
        var stillThere = false;
        for (var v = 0; v < nsV.length; v++) { if (nsV[v].visible && (nsV[v].text || '') === text && /EditText/.test(nsV[v].className)) { stillThere = true; break; } }
        if (!stillThere) {
          done.comment++; acted = true; ctx.addActionCount('comment', 1);
          await ctx.chargeAction('comment', 'tiktok');
          say('💬 评论 ' + done.comment + '/' + nCmt + ':' + text);
        } else { say('⚠️ 评论好像没发出去,跳过'); }
      } else if (!input) { say('⚠️ 没找到评论输入框'); }
      await P.back(); await ctx.sleep(800, 1500);
      // 输入法/面板可能要两次返回
      var nsB = await nodes();
      if (!findRe(nsB, 'desc', LIKE_RE, rightRail)) { await P.back(); await ctx.sleep(800, 1500); }
    }
  }

  if (acted && ctx.engageHistory) ctx.engageHistory.remember('phone', key);
  await (acted ? pause('between_videos_pause', [10000, 40000]) : pause('feed_scroll_pause', [4000, 10000]));
  await nextVideo();
  await ctx.sleep(1500, 3000);
}

say('✅ 完成:点赞 ' + done.like + '/' + nLike + ',评论 ' + done.comment + '/' + nCmt + '(看了 ' + seen + ' 个视频)');
ctx.finish('done');
return { status: 'done', done: done };
