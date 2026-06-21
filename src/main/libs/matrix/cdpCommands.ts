/**
 * 命令适配层 —— 把发布 driver 的浏览器命令词汇翻译成指纹内核的 CDP 调用。
 *
 * 旧 client 里 driver 经 pubCmd → sendBrowserCommand(扩展/单实例 CDP)发命令;
 * 矩阵号里改走这里:matrixCmd(accountId, …) 把同一套命令路由到 kernelPool 中
 * 该 accountId 的 CDP 会话。命令契约与扩展侧保持一致(返回结构对齐),这样发布
 * driver 的脚本体一行不改即可运行。
 *
 * 支持的命令(对齐 publisherUtils 里 driver 实际用到的):
 *   cdp_eval / query_selector / main_world_click / set_input_value /
 *   editor_insert_text / click_with_text
 * (upload_file_from_url 不在此实现 —— 矩阵的 ctx.uploadVideo 直接走 CDP
 *  DOM.setFileInputFiles,见 driverCtx.ts。)
 */

import { kernelEval, kernelKeypress } from './kernelPool';

// 页面内三层深遍历(顶层 + open shadowRoot + 同源 iframe),对齐生产 nbDeepAll。
// fingerprint-chromium 的 fakeShadowRoot 让 closed shadow 也可达(待真机验证)。
const DEEP_FN =
  'function nbDeepAll(sel){var out=[];function walk(root,d){if(!root||d>6)return;' +
  'try{var m=root.querySelectorAll(sel);for(var i=0;i<m.length;i++)out.push(m[i]);}catch(e){}' +
  'var all=[];try{all=root.querySelectorAll("*");}catch(e){}' +
  'for(var k=0;k<all.length;k++){var sr=null;try{sr=all[k].shadowRoot;}catch(e){}if(sr)walk(sr,d+1);}' +
  'var fr=[];try{fr=root.querySelectorAll("iframe,frame");}catch(e){}' +
  'for(var j=0;j<fr.length;j++){var idoc=null;try{idoc=fr[j].contentDocument;}catch(e){}if(idoc)walk(idoc,d+1);}}' +
  'walk(document,0);return out;}';

function s(v: string): string { return JSON.stringify(v); }

export async function matrixCmd(
  accountId: string,
  command: string,
  params: any,
  _timeoutMs?: number,
): Promise<any> {
  switch (command) {
    // 直通求值:driver 的 cdp_eval 期望 { ok:true, value }。
    case 'cdp_eval': {
      const value = await kernelEval(accountId, String(params?.expression || ''));
      return { ok: true, value };
    }

    // 元素查询:深遍历兼容 shadow/iframe。每个元素带 tag/text/id + 调用方请求的 attrs
    // (对齐老客户端扩展:剧本靠 attrs:'id' 读 [id^="waterfall_item_"] 采集视频,
    //  之前只返回 {tag,text} 丢了 id → 候选池恒 0 → 互动跑一会就空手放弃)。
    case 'query_selector': {
      const sel = String(params?.selector || '');
      const limit = Number(params?.limit) || 50;
      const attrList = String(params?.attrs || '').split(',').map((x) => x.trim()).filter(Boolean);
      const expr =
        '(function(){' + DEEP_FN +
        'var ATTRS=' + JSON.stringify(attrList) + ';' +
        'try{var n=nbDeepAll(' + s(sel) + ');var out=[];' +
        'for(var i=0;i<Math.min(n.length,' + limit + ');i++){var e=n[i];' +
        'var o={tag:(e.tagName||"").toLowerCase(),text:((e.innerText||e.value||"")+"").slice(0,80),id:e.id||""};' +
        'for(var k=0;k<ATTRS.length;k++){try{o[ATTRS[k]]=e.getAttribute(ATTRS[k])||"";}catch(_e){}}' +
        'out.push(o);}' +
        'return out;}catch(e){return[];}})()';
      const elements = await kernelEval(accountId, expr);
      return { ok: true, elements: Array.isArray(elements) ? elements : [] };
    }

    // 主世界 click(穿透 React 合成事件):CDP Runtime.evaluate 默认主世界。
    case 'main_world_click': {
      const sel = String(params?.selector || '');
      const expr =
        '(function(){' + DEEP_FN +
        'var els=nbDeepAll(' + s(sel) + ');if(!els.length)return {ok:false,error:"not_found"};' +
        'try{els[0].click();return {ok:true};}catch(e){return {ok:false,error:String(e&&e.message||e).slice(0,80)};}})()';
      return await kernelEval(accountId, expr);
    }

    // 普通 input 赋值:走 native setter + 派 input/change。
    case 'set_input_value': {
      const sel = String(params?.selector || '');
      const val = String(params?.value ?? '');
      const expr =
        '(function(){' + DEEP_FN +
        'var els=nbDeepAll(' + s(sel) + ');if(!els.length)return {ok:false,error:"not_found"};var el=els[0];' +
        'try{var proto=el.tagName==="TEXTAREA"?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;' +
        'var setter=Object.getOwnPropertyDescriptor(proto,"value").set;setter.call(el,' + s(val) + ');' +
        'el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));' +
        'return {ok:true};}catch(e){return {ok:false,error:String(e&&e.message||e).slice(0,80)};}})()';
      return await kernelEval(accountId, expr);
    }

    // 富文本插入:focus 后 execCommand insertText(contentEditable/ProseMirror/Slate 通吃)。
    case 'editor_insert_text': {
      const sel = String(params?.selector || '');
      const text = String(params?.text ?? '');
      const expr =
        '(function(){' + DEEP_FN +
        'var els=nbDeepAll(' + s(sel) + ');if(!els.length)return {ok:false,error:"not_found"};var el=els[0];' +
        'try{el.focus();var doc=el.ownerDocument||document;doc.execCommand("insertText",false,' + s(text) + ');' +
        'return {ok:true};}catch(e){return {ok:false,error:String(e&&e.message||e).slice(0,80)};}})()';
      return await kernelEval(accountId, expr);
    }

    // 文本匹配点击:在容器内找文本命中的元素点击(fuzzy includes,跳过隐藏)。
    case 'click_with_text': {
      const containerSel = params?.containerSel ? String(params.containerSel) : '';
      const texts: string[] = Array.isArray(params?.acceptedTexts) ? params.acceptedTexts.map(String) : [];
      const expr =
        '(function(){' + DEEP_FN +
        'var texts=' + JSON.stringify(texts) + ';' +
        'var roots=' + (containerSel ? 'nbDeepAll(' + s(containerSel) + ')' : '[document.body]') + ';' +
        'function vis(e){var r=e.getBoundingClientRect();var st=getComputedStyle(e);' +
        'return r.width>0&&r.height>0&&st.visibility!=="hidden"&&st.display!=="none";}' +
        'for(var ri=0;ri<roots.length;ri++){var root=roots[ri];if(!root)continue;' +
        'var cands=[];try{cands=root.querySelectorAll("button,a,div,span,*");}catch(e){}' +
        'for(var i=0;i<cands.length;i++){var el=cands[i];var t=((el.innerText||el.textContent||"")+"").trim();if(!t)continue;' +
        'for(var j=0;j<texts.length;j++){if(t===texts[j]||t.indexOf(texts[j])>=0){' +
        'if(!vis(el))continue;try{el.click();return {ok:true};}catch(e){}}}}}' +
        'return {ok:false,error:"no_match"};})()';
      return await kernelEval(accountId, expr);
    }

    // 任意 JS 求值(orchestrator 收集 video_id 等用)。返回 { result }(对齐扩展形状)。
    case 'javascript': {
      const value = await kernelEval(accountId, String(params?.code || ''));
      return { ok: true, result: value, value };
    }

    // 当前页 URL。
    case 'get_url': {
      const url = await kernelEval(accountId, 'location.href');
      return { ok: true, url: String(url || ''), value: url };
    }

    // 滚动(抖音 feed)。amount=屏数,默认 3。
    case 'scroll': {
      const amount = Number(params?.amount) || 3;
      const dir = params?.direction === 'up' ? -1 : 1;
      const expr =
        '(function(){try{window.scrollBy(0,' + (dir) + '*' + amount + '*Math.round(window.innerHeight*0.85));' +
        'return {ok:true};}catch(e){return {ok:false,error:String(e&&e.message||e)};}})()';
      return await kernelEval(accountId, expr);
    }

    // 输入框打字(搜索框):focus 后 execCommand insertText。
    case 'type': {
      const sel = params?.selector ? String(params.selector) : '';
      const text = String(params?.text ?? '');
      const expr =
        '(function(){' + DEEP_FN +
        'var el=' + (sel ? 'nbDeepAll(' + s(sel) + ')[0]' : 'document.activeElement') + ';' +
        'if(!el)return {ok:false,error:"no_target"};try{el.focus();' +
        'document.execCommand("insertText",false,' + s(text) + ');return {ok:true};}' +
        'catch(e){return {ok:false,error:String(e&&e.message||e).slice(0,80)};}})()';
      return await kernelEval(accountId, expr);
    }

    // 填充 input(native setter + 派 input/change)。等价 set_input_value。
    case 'fill': {
      return await matrixCmd(accountId, 'set_input_value', { selector: params?.selector, value: params?.value });
    }

    // 滚到元素(触发抖音搜索结果懒加载 waterfall_item / 把评论框滚进视口)。
    // 多个匹配时滚最后一个(剧本就是要滚到末尾触发加载更多)。没它候选池恒 0。
    case 'scroll_to': {
      const sel = String(params?.selector || '');
      const expr =
        '(function(){' + DEEP_FN +
        'var els=nbDeepAll(' + s(sel) + ');if(!els.length)return {ok:false,error:"not_found"};' +
        'var el=els[els.length-1];try{el.scrollIntoView({block:"center"});return {ok:true,count:els.length};}' +
        'catch(e){try{el.scrollIntoView();return {ok:true};}catch(_e){return {ok:false,error:String(_e&&_e.message||_e).slice(0,80)}}}})()';
      return await kernelEval(accountId, expr);
    }

    // 可信按键(走 CDP):剧本搜索框 Enter 提交。
    case 'keypress': {
      try { await kernelKeypress(accountId, String(params?.key || 'Enter')); return { ok: true }; }
      catch (e: any) { return { ok: false, error: String(e?.message || e).slice(0, 80) }; }
    }

    // 写入富文本编辑器(抖音评论框):派 paste ClipboardEvent,失败回落 execCommand insertText。
    case 'editor_paste_text': {
      const sel = String(params?.selector || '');
      const text = String(params?.text ?? params?.value ?? '');
      const expr =
        '(function(){' + DEEP_FN +
        'var els=nbDeepAll(' + s(sel) + ');if(!els.length)return {ok:false,error:"not_found"};var el=els[0];' +
        'try{el.focus();}catch(e){}' +
        'try{var dt=new DataTransfer();dt.setData("text/plain",' + s(text) + ');' +
        'var ev=new ClipboardEvent("paste",{clipboardData:dt,bubbles:true,cancelable:true});' +
        'el.dispatchEvent(ev);return {ok:true};}catch(e){' +
        'try{document.execCommand("insertText",false,' + s(text) + ');return {ok:true};}' +
        'catch(_e){return {ok:false,error:String(_e&&_e.message||_e).slice(0,80)}}}})()';
      return await kernelEval(accountId, expr);
    }

    default:
      return { ok: false, error: 'unsupported_command:' + command };
  }
}
