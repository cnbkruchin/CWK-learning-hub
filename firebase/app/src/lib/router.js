/**
 * นำทางแบบ stack (เหมือนรุ่น Apps Script) + ขอบเขตของตัวฟังเรียลไทม์ต่อหน้า (ยกเลิกเมื่อออกจากหน้า)
 */
export const views = {};
const stack = [];
let scope = null;
let renderHook = null;
let homeName = () => 'login';

export function currentScope() { return scope; }
export function setHome(fn) { homeName = fn; }
export function onRender(fn) { renderHook = fn; }
export function top() { return stack[stack.length - 1] || { name: homeName(), params: {} }; }
export function depth() { return stack.length; }

export function render() {
  if (scope) scope.splice(0).forEach((u) => { try { u(); } catch (e) { /* ignore */ } });
  scope = [];
  const t = top();
  const view = views[t.name];
  if (renderHook) renderHook(t);
  if (!view) return renderHook && renderHook(t, new Error('ไม่พบหน้า ' + t.name));
  return Promise.resolve().then(() => view(t.params || {})).catch((err) => renderHook && renderHook(t, err));
}
export function go(name, params) { stack.push({ name, params: params || {} }); render(); window.scrollTo(0, 0); }
export function swap(name, params) { stack[stack.length ? stack.length - 1 : 0] = { name, params: params || {} }; render(); }
export function back() { if (stack.length > 1) stack.pop(); render(); }
export function home() { stack.splice(0, stack.length, { name: homeName(), params: {} }); render(); }
export function reset(name, params) { stack.splice(0, stack.length, { name, params: params || {} }); render(); }
