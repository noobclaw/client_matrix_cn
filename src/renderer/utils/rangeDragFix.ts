// Windows(WebView2)下 <input type="range"> 原生拖拽失效的全局兜底(2026-08-15 用户实报:
// 引流概率滑杆 Windows 拖不动、mac 正常;全 app 共 40 处数值滑杆,逐处换组件回归面太大)。
//
// 机制:捕获阶段监听 pointerdown,命中未禁用的 range 输入就接管 —— 后续 pointermove
// 按几何位置自算数值,用【原生 setter + 冒泡 input 事件】写回,React 的受控 onChange
// 照常触发(与本仓 CDP 填表同款成熟手法)。原生拖拽正常的平台上,垫片和原生算出同一个
// 值,写入是幂等的,互不干扰;原生被 WebView2 吞掉时,垫片独立完成拖拽。
// 只处理水平滑杆(全 app 无竖向/RTL 用例)。
let active: HTMLInputElement | null = null;

function setSliderValue(el: HTMLInputElement, clientX: number) {
  const rect = el.getBoundingClientRect();
  if (rect.width < 8) return;
  const min = parseFloat(el.min || '0');
  const max = parseFloat(el.max || '100');
  const step = parseFloat(el.step || '1') || 1;
  let ratio = (clientX - rect.left) / rect.width;
  ratio = Math.max(0, Math.min(1, ratio));
  let v = min + ratio * (max - min);
  v = Math.round(v / step) * step;
  v = Math.max(min, Math.min(max, v));
  // step 可能是小数,消掉浮点尾巴
  const decimals = (String(step).split('.')[1] || '').length;
  const next = decimals > 0 ? v.toFixed(decimals) : String(v);
  if (el.value === next) return;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  if (!setter) return;
  setter.call(el, next);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

export function installRangeDragFix() {
  document.addEventListener(
    'pointerdown',
    (e) => {
      const t = e.target;
      if (t instanceof HTMLInputElement && t.type === 'range' && !t.disabled && e.isPrimary && e.button === 0) {
        active = t;
        setSliderValue(t, e.clientX);
      }
    },
    true,
  );
  document.addEventListener(
    'pointermove',
    (e) => {
      if (!active) return;
      if (e.buttons !== 1) { active = null; return; }
      setSliderValue(active, e.clientX);
    },
    true,
  );
  const end = () => { active = null; };
  document.addEventListener('pointerup', end, true);
  document.addEventListener('pointercancel', end, true);
  window.addEventListener('blur', end);
}
