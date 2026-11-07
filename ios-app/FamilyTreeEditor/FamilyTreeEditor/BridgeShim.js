// 族谱编写 iOS 壳桥接垫片（文档开始处注入）：定义与安卓壳同名的 window.NativeBridge，
// 网页内核（app/ui.js）零改动即可在 iOS 上跑同一套 App 锁/导出/复制逻辑。
// 原生侧在页面加载前另行注入 window.__ftBioStatus（见 ViewController.biometricStatus）。
(function () {
  if (window.NativeBridge) return;
  function post(body) {
    try { window.webkit.messageHandlers.ftBridge.postMessage(body); } catch (e) { /* 原生不在场时静默 */ }
  }
  window.NativeBridge = {
    // 同步返回：读原生预先算好并注入的状态常量，词表与安卓一致：
    // ok / none_enrolled / no_hardware / unavailable / unsupported_os
    biometricStatus: function () { return window.__ftBioStatus || 'unavailable'; },
    // 异步：原生用 LAContext 验证后 evaluateJavaScript 回调 window.__ftBioResult(ok, code)
    biometricAuth: function () { post({ action: 'biometricAuth' }); },
    saveJson: function (json) { post({ action: 'saveJson', json: String(json == null ? '' : json) }); },
    copyText: function (text) { post({ action: 'copyText', text: String(text == null ? '' : text) }); }
  };
})();
