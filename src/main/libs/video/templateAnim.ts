/**
 * templateAnim — 「模板速生」HF 派的【声明式 paused timeline】核心协议。
 *
 * 这是抄 HyperFrames 思维框架的产物 —— HTML 元素自带 `data-start` / `data-duration` /
 * `data-anim` 属性声明动画,渲染时引擎调 `window.__nbc.seek(t)` 把整张画面 seek 到
 * 时间 t,**完全确定性、无壁钟、无 setInterval / requestAnimationFrame、可任意倒带**。
 *
 * 为什么不直接引 GSAP:① 离线渲染下我们把网络封死了,GSAP 要 inline 或 bundle 一份
 * ~80KB;② 我们的动画类型不多(fade / fade-up / scale-in / count-up / wipe / pop),
 * 自己写一份 ~120 行的极简 seek 函数比集成 GSAP 简单稳。LLM 也更好懂 —— 只需要会写
 * `data-start` 数字,不需要懂 GSAP API。
 *
 * 协议:
 *   1. 元素属性:`data-start`(秒)、`data-duration`(秒,默认 0.6)、
 *      `data-anim`(动画名,默认 'fade')、`data-ease`(可选,默认 'cubic')
 *   2. 字幕节点:`data-caption-start`、`data-caption-end`(秒)+ 时间窗口内 display
 *   3. 计数器节点:`data-count-from`、`data-count-to`、`data-count-decimals`、
 *      `data-count-prefix`、`data-count-suffix`(可选)—— 配 `data-anim="count-up"` 用
 *   4. 全局:`window.__nbc.seek(t)` 接 seek;`window.DURATION` 暴露总时长(供引擎读);
 *      `window.__nbc.ready=true` 表示协议就绪,引擎据此判等就位
 *
 * 没碰 GSAP,不引外网,纯 vanilla JS + CSS transform/opacity。
 */

/** 共用字体(覆盖中/日/韩 + Latin)。 */
export const SAFE_FONT = "'Microsoft YaHei','PingFang SC','Hiragino Sans GB','Noto Sans CJK SC','Segoe UI',sans-serif";

/**
 * 全模板共享的 base CSS。各模板 CSS 只写自己的布局/颜色,不重复 reset / background。
 */
export function templateBaseCss(brandColor: string): string {
  return `
*{margin:0;padding:0;box-sizing:border-box;font-family:${SAFE_FONT};-webkit-font-smoothing:antialiased}
html,body{width:1080px;height:1920px;overflow:hidden;background:#0b0e11;color:#fff}
#stage{width:1080px;height:1920px;position:relative;background:radial-gradient(120% 60% at 50% 0%,#1c2026 0%,#0b0e11 55%)}
.bg-grid{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,0.03) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.03) 1px,transparent 1px);background-size:60px 60px;pointer-events:none}
.bg-glow{position:absolute;width:1000px;height:1000px;border-radius:50%;left:40px;top:-280px;filter:blur(50px);background:radial-gradient(circle,${brandColor}33,transparent 70%);pointer-events:none}
#caption-track{position:absolute;left:60px;right:60px;bottom:60px;text-align:center;font-size:42px;font-weight:800;line-height:1.25;color:#fff;text-shadow:0 4px 18px rgba(0,0,0,0.9),0 0 2px #000;pointer-events:none;z-index:30}
#caption-track .cap{display:inline-block;padding:10px 22px;border-radius:12px;background:rgba(0,0,0,0.6);backdrop-filter:blur(8px)}
/* 字幕开启时给主内容区让出底部安全区,避免字幕跟列表/网格末尾重叠把最后一条遮住。
   各模板默认 bottom 140 是为没字幕时贴底用的,有字幕时整体上抬 ~60-80px。 */
.has-caption #list-area,.has-caption #grid-area,.has-caption #quote-area{bottom:220px}
#watermark{position:absolute;bottom:70px;width:100%;text-align:center;font-size:24px;color:#5e6673;letter-spacing:2px;pointer-events:none;z-index:30}
[data-anim]{will-change:opacity,transform}
/* ── HF 派视觉配方(2026-06 酷炫化改造,抄 nexu-io/html-video 模板的纯 CSS 技法)── */
/* 胶片颗粒:SVG feTurbulence data-URI,静态纹理零成本;overlay 混合让暗部更脏、亮部更糙 */
.fx-grain{position:absolute;inset:0;opacity:0.09;mix-blend-mode:overlay;z-index:20;pointer-events:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='n'%3E%3CfeTurbulence baseFrequency='0.85' numOctaves='2'/%3E%3C/filter%3E%3Crect width='220' height='220' filter='url(%23n)'/%3E%3C/svg%3E")}
/* 暗角:radial 渐变,把视线压向中心 */
.fx-vignette{position:absolute;inset:0;background:radial-gradient(circle at 50% 45%,transparent 46%,rgba(0,0,0,0.55) 100%);z-index:19;pointer-events:none}
/* 扫描线:Breaking News / 终端质感 */
.fx-scanlines{position:absolute;inset:0;background-image:repeating-linear-gradient(0deg,rgba(0,0,0,0.16) 0px,rgba(0,0,0,0.16) 1px,transparent 1px,transparent 4px);mix-blend-mode:multiply;opacity:0.55;z-index:18;pointer-events:none}
/* 液态极光 blob:大圆重模糊 + screen 混合,配 data-loop=float 缓慢漂移 */
.fx-blob{position:absolute;border-radius:50%;mix-blend-mode:screen;filter:blur(60px);pointer-events:none;will-change:transform}
/* 白闪转场层:页切换时 data-anim=flash 快进快出 */
.fx-flash{position:absolute;inset:0;background:#fff;opacity:0;z-index:25;pointer-events:none}
/* 行内光泽扫过:伪元素斜向高光,配 data-loop=sweep 周期平移 */
.fx-sheen{position:absolute;top:0;bottom:0;width:220px;background:linear-gradient(105deg,transparent 0%,rgba(255,255,255,0.07) 45%,rgba(255,255,255,0.14) 50%,rgba(255,255,255,0.07) 55%,transparent 100%);pointer-events:none}
/* 逐字 kinetic 容器:span 不换行断词 */
.kchar{display:inline-block;white-space:pre}
`;
}

// ── 视觉配方生成器(templateLibrary 各模板按需取用)─────────────────────────

/** 液态极光背景:3 个 blur 大圆围绕品牌色取类比色,data-loop=float 确定性漂移。 */
export function liquidBlobsHtml(brandColor: string, accentColor?: string): string {
  const a = accentColor || '#7c5cff';
  return `
<div class="fx-blob" data-loop="float" data-loop-period="11" data-loop-amp="70" style="width:640px;height:640px;background:${brandColor};opacity:0.5;top:-140px;left:-160px"></div>
<div class="fx-blob" data-loop="float" data-loop-period="14" data-loop-amp="90" data-loop-phase="2.1" style="width:560px;height:560px;background:${a};opacity:0.42;top:34%;right:-180px"></div>
<div class="fx-blob" data-loop="float" data-loop-period="17" data-loop-amp="60" data-loop-phase="4.4" style="width:520px;height:520px;background:#ec4899;opacity:0.30;bottom:-120px;left:22%"></div>`;
}

/**
 * 逐字 kinetic 拆分:每个字一个 span,各自 data-start 错开 —— 标题像被「打」出来。
 * CJK 按字符拆;连续 Latin/数字按词拆(避免英文单词断字)。
 */
export function splitKinetic(
  text: string, baseStart: number,
  opts?: { stagger?: number; anim?: string; duration?: number; ease?: string },
): string {
  const stagger = opts?.stagger ?? 0.045;
  const anim = opts?.anim ?? 'fade-up';
  const dur = opts?.duration ?? 0.5;
  const ease = opts?.ease ? ` data-ease="${opts.ease}"` : '';
  // 按「CJK 单字 | Latin 词 | 空白 | 其他单字符」切
  const units = (text || '').match(/[㐀-鿿豈-﫿]|[A-Za-z0-9]+|\s+|./gu) || [];
  let i = 0;
  return units.map((u) => {
    if (/^\s+$/.test(u)) return escapeHtml(u); // 空白不参与动画,原样保留
    const start = baseStart + i * stagger;
    i++;
    return `<span class="kchar" data-anim="${anim}" data-start="${start.toFixed(2)}" data-duration="${dur}"${ease}>${escapeHtml(u)}</span>`;
  }).join('');
}

/**
 * 页转场白闪:每个【页边界】一个全屏白闪(0→峰值→0,持续 0.36s,中点正好是切页时刻)。
 * 用 data-anim=flash(runtime 里 opacity=sin(p·π)·峰值),纯确定性。单页模板不需要。
 */
export function pageFlashesHtml(pageStartSecs: number[]): string {
  // pageStartSecs[0] 是第一页(片头),不闪;从第二页起每个切换点闪一下。
  return pageStartSecs.slice(1).map((s) => {
    const start = Math.max(0, s - 0.18);
    return `<div class="fx-flash" data-anim="flash" data-start="${start.toFixed(2)}" data-duration="0.36"></div>`;
  }).join('');
}

/**
 * 协议运行时:把这段 JS 内嵌到每个模板 HTML 末尾。给 window 上挂 `__nbc.seek(t)`。
 *
 * seek(t) 做的事:
 *   · 扫每个 `[data-anim]` 元素,按 progress 应用 opacity + transform
 *   · 扫每个 `[data-caption-start]` 元素,按时间窗显示当前一句字幕
 *   · 扫每个 `[data-count-from]` 元素,按 progress 插值数值并改 textContent
 *
 * 严格遵守 HF 硬规则:
 *   · 无 setInterval / setTimeout / requestAnimationFrame / Math.random / Date.now
 *   · seek(t) 同步、纯函数:同一 t 调多少次结果都相同(确定性)
 */
export const NBC_RUNTIME_JS = `(function(){
  function clamp(x,lo,hi){return x<lo?lo:x>hi?hi:x;}
  // ── auto-fit(抄 html-video / HyperFrames「文字必然落进盒子」的纪律,但做成【动态】版)──
  // 静态 maxLength 猜不准(CJK/Latin 宽度差、字号阶梯不同),我们直接在渲染前测量:
  // 任何带 [data-fit] 的元素,若内容溢出它的盒子(高或宽),就【逐档降字号】直到落进去或触底。
  //   data-fit-min   最小字号 px(默认 20,再小就认命不再降,至少不塌)
  //   data-fit-maxh  给盒子一个最大高度 px(自动加 overflow:hidden)—— 用于 height:auto 的
  //                  标题/副标题带,没有它就测不出纵向溢出。宽度靠 left/right 或 max-width 天然界定。
  //   data-fit-maxw  给盒子一个最大宽度 px(可选)
  // 纯布局数学、无壁钟、只在 init 跑一次(seek 不重复跑,省算力)。
  function fitEl(el){
    var minPx = parseFloat(el.getAttribute('data-fit-min')); if(!isFinite(minPx)) minPx = 20;
    var maxh = parseFloat(el.getAttribute('data-fit-maxh'));
    var maxw = parseFloat(el.getAttribute('data-fit-maxw'));
    if(isFinite(maxh)){ el.style.maxHeight = maxh+'px'; el.style.overflow = 'hidden'; }
    if(isFinite(maxw)){ el.style.maxWidth = maxw+'px'; }
    var size = parseFloat(window.getComputedStyle(el).fontSize)||40;
    var guard = 0;
    // 纵向容差:line-height(常 1.15~1.2)比字体固有行盒略矮时,单行文字的 scrollHeight 会
    //   比 clientHeight 高出几像素(粗体尤甚)—— 这是【假溢出】,容差太小会把正常单行标题一路缩到底。
    //   真正多一行 ≈ 1.2×字号(几十像素),远超容差,所以按字号比例给容差绝不会漏判真溢出。
    // 横向容差小(粗体/斜体溢出个位像素),给 2px 即可。
    function over(){
      var vtol = Math.max(4, size*0.15);
      return el.scrollHeight > el.clientHeight+vtol || el.scrollWidth > el.clientWidth+2;
    }
    while(over() && size > minPx && guard < 240){ size -= 1; guard++; el.style.fontSize = size+'px'; }
  }
  function fitAll(){
    var xs = document.querySelectorAll('[data-fit]');
    for(var i=0;i<xs.length;i++){ try{ fitEl(xs[i]); }catch(e){} }
  }
  // 缓动函数(对齐 GSAP 的 .out 系列,纯确定性数学,无壁钟):
  //   cubic / quad / linear / back(回弹过冲) / expo(迅猛冲入) / elastic(弹性) / bounce(弹跳)
  function ease(p,kind){
    if(p<=0) return 0; if(p>=1) return 1;
    if(kind==='linear') return p;
    if(kind==='quad') return 1-Math.pow(1-p,2);
    if(kind==='expo') return 1-Math.pow(2,-10*p);                                  // easeOutExpo:开头猛、收尾稳
    if(kind==='back'){var c=2.4;return 1+(c+1)*Math.pow(p-1,3)+c*Math.pow(p-1,2);}  // easeOutBack:冲过头再回弹(加强 c)
    if(kind==='elastic'){var c4=(2*Math.PI)/3;return Math.pow(2,-10*p)*Math.sin((p*10-0.75)*c4)+1;} // 弹性
    if(kind==='bounce'){var n=7.5625,d=2.75;var q=1-p;var b;if(q<1/d)b=n*q*q;else if(q<2/d){q-=1.5/d;b=n*q*q+0.75;}else if(q<2.5/d){q-=2.25/d;b=n*q*q+0.9375;}else{q-=2.625/d;b=n*q*q+0.984375;}return 1-b;} // 弹跳
    return 1-Math.pow(1-p,3); // cubic 默认(easeOutCubic)
  }
  // 数字滚动专用:用【单调】缓动,绝不用 back/elastic/bounce(否则数值会冲过目标再回落,
  // 百分比看着像 98→101→98 很怪)。回弹类一律退化成 expo(同样迅猛但不过冲)。
  function countEase(p,kind){
    if(kind==='back'||kind==='elastic'||kind==='bounce') kind='expo';
    return ease(p,kind);
  }
  // 单个 [data-anim] 元素:按 progress 算 opacity + transform
  function applyAnim(el,p,kind,easeKind){
    var e = ease(p, easeKind);
    var op = e, tx = '';
    switch(kind){
      case 'fade': op = e; break;
      case 'fade-up': op = e; tx = 'translateY('+((1-e)*60)+'px)'; break;
      case 'fade-down': op = e; tx = 'translateY('+((1-e)*-60)+'px)'; break;
      case 'fade-left': op = e; tx = 'translateX('+((1-e)*60)+'px)'; break;
      case 'fade-right': op = e; tx = 'translateX('+((1-e)*-60)+'px)'; break;
      case 'slide-in-right': op = e; tx = 'translateX('+((1-e)*760)+'px)'; break;
      case 'slide-in-left': op = e; tx = 'translateX('+((1-e)*-760)+'px)'; break;
      case 'scale-in': op = e; tx = 'scale('+(0.85+0.15*e)+')'; break;
      case 'pop': op = e; tx = 'scale('+(0.6+0.4*e)+')'; break;
      case 'wipe-right': op = 1; el.style.clipPath = 'inset(0 '+((1-e)*100)+'% 0 0)'; break;
      case 'wipe-left':  op = 1; el.style.clipPath = 'inset(0 0 0 '+((1-e)*100)+'%)'; break;
      case 'rise': op = e; tx = 'translateY('+((1-e)*120)+'px) scale('+(0.94+0.06*e)+')'; break;
      // 柱状图长高:SVG rect 从基线往上长(改 height/y 属性,非 transform)。data-bar-y/data-bar-h 为终值。
      case 'grow-bar': {
        var by = parseFloat(el.getAttribute('data-bar-y'))||0;
        var bh = parseFloat(el.getAttribute('data-bar-h'))||0;
        el.setAttribute('height', (bh*e).toFixed(1));
        el.setAttribute('y', (by + bh*(1-e)).toFixed(1));
        op = 1; break;
      }
      // 白闪转场:p 走 0→1,亮度 sin(p·π) 走 0→1→0,中点最亮。用【线性 p】不用缓动,
      // 保证对称;duration 外恒 0。
      case 'flash': op = Math.sin(Math.min(1,Math.max(0,p))*Math.PI)*0.92; break;
      default: op = e;
    }
    el.style.opacity = op;
    if(tx) el.style.transform = tx;
  }
  // ── data-loop 环境动画:整段时长内持续循环,全部 sin/cos 由 t 算(确定性、可倒带)──
  //   float: 双 sin 不同频的有机漂移(液态 blob 用)   pulse: 透明度呼吸
  //   sweep: 高光从左扫到右(行内光泽)               spin: 匀速旋转
  //   glitch: 间歇抖动(高频 sin 过阈值才触发,Breaking News 标题用)
  function applyLoop(el,t){
    var kind = el.getAttribute('data-loop');
    var period = parseFloat(el.getAttribute('data-loop-period'))||10;
    var amp = parseFloat(el.getAttribute('data-loop-amp'))||40;
    var phase = parseFloat(el.getAttribute('data-loop-phase'))||0;
    var w = 2*Math.PI/period;
    if(kind==='float'){
      var x = Math.sin(t*w+phase)*amp;
      var y = Math.cos(t*w*0.73+phase*1.3)*amp*0.8;
      var s = 1+Math.sin(t*w*0.5+phase)*0.06;
      el.style.transform = 'translate('+x.toFixed(1)+'px,'+y.toFixed(1)+'px) scale('+s.toFixed(3)+')';
    } else if(kind==='pulse'){
      var base = parseFloat(el.getAttribute('data-loop-base'))||0.65;
      el.style.opacity = base + (Math.sin(t*w+phase)*0.5+0.5)*(1-base);
    } else if(kind==='sweep'){
      // 高光条从 -宽 平移到 容器宽+宽,循环;data-loop-travel 是行进距离 px(默认 1200)
      var travel = parseFloat(el.getAttribute('data-loop-travel'))||1200;
      var prog = ((t+phase)%period)/period;
      el.style.transform = 'translateX('+((prog*1.6-0.3)*travel).toFixed(1)+'px) skewX(-12deg)';
    } else if(kind==='spin'){
      el.style.transform = 'rotate('+((t/period*360+phase*57.3)%360).toFixed(1)+'deg)';
    } else if(kind==='glitch'){
      // 高频确定性伪随机:两路大频 sin 相乘,>0.92 才触发位移 → 大部分时间静止、偶发抖一下
      var n = Math.sin(t*13.7+phase)*Math.sin(t*7.3+phase*2.7);
      if(n>0.92){ el.style.transform='translate('+(Math.sin(t*97)*7).toFixed(1)+'px,'+(Math.cos(t*61)*3).toFixed(1)+'px)'; }
      else if(n<-0.94){ el.style.transform='translate('+(Math.cos(t*83)*-6).toFixed(1)+'px,1px)'; }
      else { el.style.transform='translate(0,0)'; }
    }
  }
  // 计数器:[data-count-from] [data-count-to] [data-count-decimals] [data-count-prefix] [data-count-suffix]
  function applyCount(el,p,easeKind){
    var e = countEase(p, easeKind);
    var from = parseFloat(el.getAttribute('data-count-from'))||0;
    var to = parseFloat(el.getAttribute('data-count-to'))||0;
    var dec = parseInt(el.getAttribute('data-count-decimals'))||0;
    var pre = el.getAttribute('data-count-prefix')||'';
    var suf = el.getAttribute('data-count-suffix')||'';
    var v = from + (to-from)*e;
    el.textContent = pre + v.toFixed(dec) + suf;
  }
  // 字幕节点:[data-caption-start] [data-caption-end] (单位秒)
  function applyCaption(el,t){
    var s = parseFloat(el.getAttribute('data-caption-start'))||0;
    var e = parseFloat(el.getAttribute('data-caption-end'))||0;
    var show = (t>=s && t<e);
    el.style.display = show ? '' : 'none';
  }
  var nbc = {
    ready: false,
    seek: function(t){
      if(!isFinite(t)||t<0) t = 0;
      // 1. data-anim 元素:进场动画
      var nodes = document.querySelectorAll('[data-anim]');
      for(var i=0;i<nodes.length;i++){
        var n = nodes[i];
        var start = parseFloat(n.getAttribute('data-start'))||0;
        var dur = parseFloat(n.getAttribute('data-duration'))||0.6;
        var anim = n.getAttribute('data-anim') || 'fade';
        // 没显式指定 data-ease 时,按动画类型给【弹簧/迅猛】默认缓动 —— 这是"变酷"的核心:
        //   缩放类(pop/scale-in)用 back 冲过头再回弹;位移/上浮类用 expo 猛地入场;其余(纯 fade/wipe)保持 cubic。
        var easeKind = n.getAttribute('data-ease');
        if(!easeKind){
          easeKind = (anim==='pop'||anim==='scale-in') ? 'back'
            : (anim==='slide-in-right'||anim==='slide-in-left'||anim==='rise'||anim==='fade-up'||anim==='fade-down'||anim==='fade-left'||anim==='fade-right') ? 'expo'
            : 'cubic';
        }
        var p = clamp((t-start)/Math.max(0.01,dur), 0, 1);
        applyAnim(n, p, anim, easeKind);
        // 内含计数器 → 同步更新数值
        if(n.hasAttribute('data-count-to')) applyCount(n, p, easeKind);
        // 退场(可选):data-exit-start + data-exit-duration(都不写就默认不退场)
        var exitStart = parseFloat(n.getAttribute('data-exit-start'));
        if(isFinite(exitStart)){
          var exitDur = parseFloat(n.getAttribute('data-exit-duration'))||0.4;
          var ep = clamp((t-exitStart)/Math.max(0.01,exitDur), 0, 1);
          if(ep > 0) n.style.opacity = (1-ease(ep, easeKind)) * (parseFloat(n.style.opacity)||1);
        }
      }
      // 2. 独立计数器节点(不带 data-anim 的)
      var counters = document.querySelectorAll('[data-count-to]:not([data-anim])');
      for(var j=0;j<counters.length;j++){
        var c = counters[j];
        var cs = parseFloat(c.getAttribute('data-start'))||0;
        var cd = parseFloat(c.getAttribute('data-duration'))||0.8;
        var ce = c.getAttribute('data-ease') || 'cubic';
        var cp = clamp((t-cs)/Math.max(0.01,cd), 0, 1);
        applyCount(c, cp, ce);
      }
      // 3. 字幕节点
      var caps = document.querySelectorAll('[data-caption-start]');
      for(var k=0;k<caps.length;k++) applyCaption(caps[k], t);
      // 4. data-loop 环境动画(背景 blob / 光泽扫过 / 标题故障抖动等,持续循环)
      var loops = document.querySelectorAll('[data-loop]');
      for(var m=0;m<loops.length;m++) applyLoop(loops[m], t);
      // 5. GSAP paused 时间线(「AI 自由排版」ai_freeform 用):totalTime(t) 确定性 seek。
      //    AI 在 setup 脚本里建 gsap.timeline({paused:true}),存进 window.__timelines。
      //    我们逐条把 playhead 推到 t(超出总时长就钉在末帧),纯函数、无壁钟、可倒带 ——
      //    跟 data-* 协议同一个 seek 入口,音画/字幕对齐误差仍为 0。
      if(window.__timelines){
        for(var tk in window.__timelines){
          var gtl = window.__timelines[tk];
          if(gtl && typeof gtl.totalTime==='function'){
            try{ var td=(typeof gtl.totalDuration==='function')?gtl.totalDuration():t; gtl.totalTime(t>td?td:t); }catch(e){}
          }
        }
      }
    }
  };
  nbc.fit = fitAll;
  window.__nbc = nbc;
  // 渲染前先把所有 [data-fit] 元素收进盒子(一次性),再置 ready —— 引擎 waitReady 通过后
  //   逐帧 seek 时字号已锁定,不会每帧重算,也不会有溢出/叠字残留。
  try{ fitAll(); }catch(e){}
  nbc.ready = true;
})();`;

/**
 * 把字幕 cues(秒级时间戳)渲染成 HTML 节点数组,塞进 #caption-track。
 * 每条 cue 一个 `<span class="cap" data-caption-start data-caption-end>` —— 协议运行时
 * 会根据 t 切换 display。这样字幕跟动画同一引擎,无对齐误差(HF 派核心 insight)。
 */
export interface CaptionCue {
  text: string;
  startSec: number;
  endSec: number;
}

export function renderCaptionTrack(cues: CaptionCue[] | undefined): string {
  if (!cues || cues.length === 0) return '';
  const items = cues.map((c) => {
    const safe = escapeHtml(c.text);
    return `<span class="cap" data-caption-start="${c.startSec.toFixed(3)}" data-caption-end="${c.endSec.toFixed(3)}" style="display:none">${safe}</span>`;
  }).join('');
  return `<div id="caption-track">${items}</div>`;
}

/** 模板专用 HTML 转义(单字符替换,够用)。 */
export function escapeHtml(s: string): string {
  if (!s) return '';
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/**
 * 把 templateLibrary 各模板产的 bodyHtml + 自有 CSS 包成完整 HTML 文档。
 *   · 自动注入 base CSS、字幕轨道、watermark
 *   · 自动注入 __nbc.seek 协议运行时
 *   · 通过 window.DURATION / window.FPS 暴露时长/帧率给引擎读
 *
 * 设计上,模板的 body / css 不需要任何 JS —— 所有动画都靠 data-* 属性 + 共享 seek 协议。
 */
export interface WrapHtmlOptions {
  bodyHtml: string;
  css: string;
  brandColor: string;
  durationSec: number;
  fps: number;
  captionCues?: CaptionCue[];
  watermark?: string;
  /**
   * 「AI 自由排版」用:内联的 GSAP 源码字符串(gsapAsset.loadGsapSource())。
   * 非空时注入到 <head> 顶部,让 setupScript / AI body 能用 window.gsap。
   * 网络封死下不能走 CDN,必须内联。
   */
  gsapSource?: string;
  /**
   * 「AI 自由排版」用:AI 产的时间线 setup 脚本。在 DOM + GSAP 都就绪后、NBC seek
   * 运行时之前执行 —— 通常做的事是建若干 `gsap.timeline({paused:true})` 存进
   * window.__timelines,供 __nbc.seek(t) 逐帧 totalTime(t)。
   */
  setupScript?: string;
  /** 随包 Latin 展示字体的 @font-face CSS(base64 内联,fontAsset.loadFontFaceCss())。
   *  放 <style> 最前,让主题的 font-family(Shrikhand/Syne/Space Grotesk…)解析到内嵌字体。
   *  空 = 全走系统字体(themes 已给系统 fallback,仍好看)。 */
  fontFaceCss?: string;
}

export function wrapTemplateHtml(opts: WrapHtmlOptions): string {
  // 水印:默认【不显示】,要露品牌需要显式传 opts.watermark 非空。原先默认会显示 "NoobClaw"
  //   作为兜底,但用户不希望成片上有这个 logo,改为只在显式配置时才渲染。
  const watermark = opts.watermark ? `<div id="watermark">${escapeHtml(opts.watermark)}</div>` : '';
  const captionTrack = renderCaptionTrack(opts.captionCues);
  // has-caption 状态类:有字幕时给 #stage 加 class,让模板里的 #list-area / #grid-area /
  //   #quote-area 自动让出底部安全区(见 templateBaseCss 里 .has-caption 选择器)。
  //   否则 caption-track 会跟列表/网格底部重叠,字幕把最后一条数据挡住。
  const stageClass = captionTrack ? ' class="has-caption"' : '';
  // GSAP 内联(AI 自由排版):放 <head>,保证 body 脚本 / setupScript 执行时 window.gsap 已就绪。
  const gsapTag = opts.gsapSource ? `<script>${opts.gsapSource}</script>` : '';
  // AI 的时间线 setup:在 body 之后(DOM 已在)、NBC seek 运行时之前跑。包 try/catch,
  // 单条 setup 失败不至于让整页 __nbc 起不来(probe/audit 会照出动画没接上)。
  const setupTag = opts.setupScript
    ? `<script>try{(function(){${opts.setupScript}\n})();}catch(e){}</script>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8">${gsapTag}<style>${opts.fontFaceCss || ''}${templateBaseCss(opts.brandColor)}${opts.css}</style></head>
<body><div id="stage"${stageClass}>
<div class="bg-grid"></div><div class="bg-glow"></div>
${opts.bodyHtml}
${captionTrack}
${watermark}
</div>
${setupTag}
<script>
window.FPS=${opts.fps};
window.DURATION=${opts.durationSec};
${NBC_RUNTIME_JS}
window.__nbc.seek(0);
</script></body></html>`;
}
