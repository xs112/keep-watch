(function () {
  // 心跳：证明 MAIN 世界内容脚本已注入（两世界共享同一 DOM，主世界控制台可读）
  try { document.documentElement.setAttribute('data-kw-hb-keep', '2.6.3'); } catch (e) {}
  // 只在主流挂课平台生效；其他网站不受影响
  var host = location.hostname;
  var platforms = /chaoxing\.com|yuketang\.cn|xuetangx\.com|zhihuishu\.com|icve\.com|mooc\.cn|xuexi365|study\.xuexi\.cn/;
  if (!platforms.test(host)) return;

  // 1) 页面任何时刻读到的都是"可见、未离开"
  try {
    Object.defineProperty(document, 'hidden',            { configurable: true, get: function () { return false; } });
    Object.defineProperty(document, 'visibilityState',   { configurable: true, get: function () { return 'visible'; } });
    Object.defineProperty(document, 'webkitHidden',      { configurable: true, get: function () { return false; } });
    Object.defineProperty(document, 'webkitVisibilityState', { configurable: true, get: function () { return 'visible'; } });
  } catch (e) {}

  // 2) 页面注册"离开/失焦"监听时直接吞掉（早于页面所有脚本执行）
  var blocked = ['visibilitychange', 'webkitvisibilitychange', 'mozvisibilitychange',
                 'msvisibilitychange', 'blur', 'focusout', 'pagehide'];
  var origAdd = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type) {
    if (blocked.indexOf(String(type)) > -1) return this;
    return origAdd.apply(this, arguments);
  };

  // 3) 属性式回调（window.onblur = ...）同样吞掉
  try {
    Object.defineProperty(window, 'onblur', { configurable: true, set: function () {}, get: function () { return null; } });
    Object.defineProperty(document, 'onvisibilitychange', { configurable: true, set: function () {}, get: function () { return null; } });
  } catch (e) {}

  // 4) 兜底：万一仍被暂停，3 秒内自动续播
  setInterval(function () {
    document.querySelectorAll('video').forEach(function (v) {
      if (v.paused && !v.ended && v.currentTime > 0) { v.play().catch(function () {}); }
    });
  }, 3000);
})();
