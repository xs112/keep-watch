/* keep-watch 超星 font-cxsecret 字体解密
 * 原理：超星把题目里部分汉字的字形随机重映射到 CJK 区的其它码位（每次刷新随机），
 *       靠自定义字体 font-cxsecret 把它们"画成"正确的字。字形本身不变，只是码位被打乱。
 *       因此：解析当前页字体 -> 对每个有字形的码位取矢量路径 -> md5 路径 -> 查内置
 *       (字形hash -> 真实码点) 表，得到 当前字体专用 的 加密码位->真字 映射。
 *       每次页面字体随机，必须运行时解析，不能写死码位表。
 * 依赖（须在本文件之前加载）：vendor/typr.js (Typr+Typr.U+md5)、vendor/cxtable.js (KW_CX_TABLE)
 */
(function () {
  'use strict';
  // 心跳 + 依赖自检（隔离世界）
  try {
    document.documentElement.setAttribute('data-kw-hb-cxdec', '2.6.3');
    document.documentElement.setAttribute('data-kw-dep-typr', (typeof window.Typr !== 'undefined' && window.Typr.U) ? 'ok' : 'MISSING');
    document.documentElement.setAttribute('data-kw-dep-table', (typeof window.KW_CX_TABLE === 'object' && window.KW_CX_TABLE) ? 'ok' : 'MISSING');
  } catch (e) {}
  if (window.__kwCx) return;

  var TABLE = window.KW_CX_TABLE || {};
  var map = null;          // 加密码点 -> 真字
  var building = null;     // Promise
  var fontKey = '';
  var stats = null;        // {total, matched, miss}

  function findFontBase64() {
    var hit = null;
    function scan(text) {
      if (!text || text.indexOf('font-cxsecret') < 0) return;
      var m = text.match(/font-cxsecret[\s\S]{0,400}?base64,([A-Za-z0-9+/=]+)/);
      if (m) hit = m[1];
    }
    // 1) 内联 <style>
    try {
      var styles = document.querySelectorAll('style');
      for (var i = 0; i < styles.length && !hit; i++) scan(styles[i].textContent);
    } catch (e) {}
    // 2) 可访问的样式表规则（同源/内联）
    if (!hit) {
      try {
        for (var s = 0; s < document.styleSheets.length && !hit; s++) {
          var ss = document.styleSheets[s];
          try {
            var rules = ss.cssRules;
            for (var r = 0; r < rules.length; r++) {
              if (rules[r].cssText && rules[r].cssText.indexOf('font-cxsecret') > -1) { scan(rules[r].cssText); if (hit) break; }
            }
          } catch (e) { /* 跨域样式表不可读，跳过 */ }
        }
      } catch (e) {}
    }
    return hit;
  }

  function b64ToBytes(b64) {
    var bin = atob(b64), buf = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf;
  }

  // 解析当前字体，构建 加密码点 -> 真实汉字
  function buildMap() {
    var b64 = findFontBase64();
    if (!b64) return Promise.resolve(null);
    if (map && fontKey === b64.slice(0, 64)) return Promise.resolve(map);
    fontKey = b64.slice(0, 64);
    return new Promise(function (resolve) {
      var done = false;
      function finish(v) { if (!done) { done = true; resolve(v); } }
      var later = typeof setTimeout === 'function' ? setTimeout : function (fn) { fn(); };
      // 硬超时 4s：解密绝不能拖死答题主流程
      later(function () { finish(map || null); }, 4000);
      later(function () {
        try {
          var fonts = window.Typr.parse(b64ToBytes(b64));
          var font = Array.isArray(fonts) ? fonts[0] : fonts;
          var U = window.Typr.U;
          var m = Object.create(null);
          var total = 0, miss = [];
          // 加密字的码位与正常字都落在 CJK 基本区 19968..40869；该字体里只有被用到的字才有字形
          for (var code = 0x4e00; code <= 0x9fbf; code++) {
            var gid = U.codeToGlyph(font, code);
            if (!gid) continue;
            var path;
            try { path = U.glyphToPath(font, gid); } catch (e) { continue; }
            if (!path || !path.crds || !path.crds.length) continue;
            total++;
            var h = window.md5(JSON.stringify(path)).slice(24); // 末 8 位 hex，与制表一致
            var real = TABLE[h];
            if (real) m[code] = real;
            else if (miss.length < 12) miss.push(code.toString(16));
          }
          map = m;
          stats = { total: total, matched: Object.keys(m).length, miss: miss };
          finish(map);
        } catch (e) {
          map = null;
          finish(null);
        }
      }, 0);
    });
  }

  function ensure() {
    if (map) return Promise.resolve(map);
    if (!findFontBase64()) return Promise.resolve(null);
    if (!building) building = buildMap();
    return building;
  }

  function hasSecretFont() { return !!findFontBase64(); }

  // 用当前映射还原文本；映射未就绪或无加密字体时原样返回
  function dec(text) {
    if (!text || !map) return text;
    var out = '', i = 0;
    while (i < text.length) {
      var cp = text.codePointAt(i);
      var real = map[cp];
      out += real ? String.fromCodePoint(real) : text[i];
      i += cp > 0xffff ? 2 : 1;
    }
    return out;
  }

  function mapSize() { return map ? Object.keys(map).length : 0; }

  window.__kwCx = { ensure: ensure, dec: dec, has: hasSecretFont, size: mapSize,
                    stats: function () { return stats; },
                    _rebuild: function () { map = null; building = null; return ensure(); } };
})();
