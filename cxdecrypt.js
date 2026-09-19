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
    document.documentElement.setAttribute('data-kw-hb-cxdec', '2.6.6');
    document.documentElement.setAttribute('data-kw-dep-typr', (typeof window.Typr !== 'undefined' && window.Typr.U) ? 'ok' : 'MISSING');
    document.documentElement.setAttribute('data-kw-dep-table', (typeof window.KW_CX_TABLE === 'object' && window.KW_CX_TABLE) ? 'ok' : 'MISSING');
  } catch (e) {}
  if (window.__kwCx) return;

  var TABLE = window.KW_CX_TABLE || {};
  var map = null;          // 加密码点 -> 真字
  var building = null;     // Promise
  var fontKey = '';
  var stats = null;        // {total, matched, miss}
  var missCodes = null;    // Object set: 本页未能还原的加密码位

  function scanOne(text, sink) {
    if (!text || text.indexOf('font-cxsecret') < 0) return;
    // 一页可能有【多个】同名 @font-face 分片（各自带 unicode-range + 一段 base64），
    // 必须全部收集后合并；旧实现只取第一个，导致只有几十字被还原、其余仍是乱码。
    var re = /font-cxsecret[\s\S]{0,800}?base64,([A-Za-z0-9+/=]+)/g, m;
    while ((m = re.exec(text))) sink(m[1]);
  }

  // 收集本页全部 font-cxsecret 字体分片（去重，保持顺序）
  function findAllFontBase64() {
    var list = [], seen = Object.create(null);
    function sink(b) { if (b && !seen[b]) { seen[b] = 1; list.push(b); } }
    // 1) 内联 <style>
    try {
      var styles = document.querySelectorAll('style');
      for (var i = 0; i < styles.length; i++) scanOne(styles[i].textContent, sink);
    } catch (e) {}
    // 2) 可访问的样式表规则（同源/内联）——与内联合并，不互斥
    try {
      for (var s = 0; s < document.styleSheets.length; s++) {
        var ss = document.styleSheets[s];
        try {
          var rules = ss.cssRules;
          for (var r = 0; r < rules.length; r++) {
            if (rules[r].cssText && rules[r].cssText.indexOf('font-cxsecret') > -1) scanOne(rules[r].cssText, sink);
          }
        } catch (e) { /* 跨域样式表不可读，跳过 */ }
      }
    } catch (e) {}
    return list;
  }

  function findFontBase64() { return findAllFontBase64()[0] || null; }

  function b64ToBytes(b64) {
    var bin = atob(b64), buf = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf;
  }

  // 解析当前字体，构建 加密码点 -> 真实汉字
  // 解析单个字体分片，把其 加密码位->真字 合并进 m；累计 total/miss
  function parseFontInto(b64, m, acc) {
    var fonts = window.Typr.parse(b64ToBytes(b64));
    var font = Array.isArray(fonts) ? fonts[0] : fonts;
    var U = window.Typr.U;
    // 加密字的码位与正常字都落在 CJK 基本区 19968..40869；该字体里只有被用到的字才有字形
    for (var code = 0x4e00; code <= 0x9fbf; code++) {
      var gid = U.codeToGlyph(font, code);
      if (!gid) continue;
      var path;
      try { path = U.glyphToPath(font, gid); } catch (e) { continue; }
      if (!path || !path.crds || !path.crds.length) continue;
      acc.total++;
      var h = window.md5(JSON.stringify(path)).slice(24); // 末 8 位 hex，与制表一致
      var real = TABLE[h];
      if (real) m[code] = real;
      else {
        if (acc.miss.length < 40) acc.miss.push(code.toString(16));
        acc.missSet[code] = 1;   // 本页未能还原的加密码位（≈残留乱码）
      }
    }
  }

  function buildMap() {
    var list = findAllFontBase64();
    if (!list.length) return Promise.resolve(null);
    var key = list.map(function (b) { return b.slice(0, 48); }).join('|');
    if (map && fontKey === key) return Promise.resolve(map);
    fontKey = key;
    return new Promise(function (resolve) {
      var done = false;
      function finish(v) { if (!done) { done = true; resolve(v); } }
      var later = typeof setTimeout === 'function' ? setTimeout : function (fn) { fn(); };
      // 硬超时 6s：解密绝不能拖死答题主流程（多分片比单分片耗时）
      later(function () { finish(map || null); }, 6000);
      later(function () {
        try {
          var m = Object.create(null);
          var acc = { total: 0, miss: [], missSet: Object.create(null) };
          for (var i = 0; i < list.length; i++) {
            try { parseFontInto(list[i], m, acc); } catch (e) { /* 坏分片跳过 */ }
          }
          map = m;
          missCodes = acc.missSet;
          stats = { total: acc.total, matched: Object.keys(m).length, miss: acc.miss, shards: list.length };
          finish(map);
        } catch (e) {
          map = null;
          missCodes = null;
          finish(null);
        }
      }, 0);
    });
  }

  function ensure() {
    if (map) return Promise.resolve(map);
    if (!findAllFontBase64().length) return Promise.resolve(null);
    if (!building) building = buildMap();
    return building;
  }

  function hasSecretFont() { return findAllFontBase64().length > 0; }

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

  // 统计文本里“残留乱码 CJK 字”的占比（码点落在本页未还原集合中）
  function garbleRatio(text) {
    if (!text || !missCodes) return 0;
    var cjk = 0, bad = 0, i = 0;
    while (i < text.length) {
      var cp = text.codePointAt(i);
      if (cp >= 0x4e00 && cp <= 0x9fff) { cjk++; if (missCodes[cp]) bad++; }
      i += cp > 0xffff ? 2 : 1;
    }
    return cjk ? bad / cjk : 0;
  }

  window.__kwCx = { ensure: ensure, dec: dec, has: hasSecretFont, size: mapSize,
                    stats: function () { return stats; },
                    garbleRatio: garbleRatio,
                    _rebuild: function () { map = null; building = null; missCodes = null; return ensure(); } };
})();
