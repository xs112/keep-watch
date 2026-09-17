/* keep-watch 诊断脚本（MAIN world，所有 frame）
 * 出问题的题目页按 F12 → Console，输入：__kwDiag()
 * 会打印并（尝试）复制一份 JSON，把结果发给开发者即可精确适配。
 */
(function () {
  function pick(el) {
    return { tag: el.tagName, cls: String(el.className || '').slice(0, 120), id: el.id || '', role: el.getAttribute('role') || '' };
  }
  function brief(el) {
    try { return el.outerHTML.replace(/\s+/g, ' ').slice(0, 1000); } catch (e) { return ''; }
  }
  function visible(el) {
    var r = el.getBoundingClientRect();
    return (r.width || r.height) && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
  }

  function diag() {
    var report = { url: location.href, time: new Date().toISOString() };

    report.videos = [].slice.call(document.querySelectorAll('video')).map(function (v) {
      return { src: (v.currentSrc || v.src || '').slice(0, 160), currentTime: v.currentTime, duration: v.duration, paused: v.paused, ended: v.ended };
    });

    report.iframes = [].slice.call(document.querySelectorAll('iframe')).map(function (f) {
      var note = '';
      try { note = f.contentWindow ? 'accessible' : 'cross-origin'; } catch (e) { note = 'cross-origin'; }
      return { src: (f.src || '').slice(0, 160), id: f.id, cls: f.className, note: note };
    });

    var sel = '.TiMu,.Cu_Ti,.questionLi,.singleQuesId,.topic-item,.subject-item,.question-item,.exam-question,.problem,' +
      '.question-card,.quiz-question,.exercise-question,.q-item,[data-question],[class*=question],[class*=topic],[class*=exam-item]';
    var boxes = [].slice.call(document.querySelectorAll(sel)).filter(visible);
    report.containerCount = boxes.length;
    report.containerCandidates = boxes.slice(0, 8).map(function (b) {
      return { pick: pick(b), text: (b.innerText || '').replace(/\s+/g, ' ').slice(0, 150), html: brief(b) };
    });

    report.nativeRadios = document.querySelectorAll('input[type=radio]').length;
    report.nativeCheckboxes = document.querySelectorAll('input[type=checkbox]').length;
    report.roleRadios = document.querySelectorAll('[role=radio]').length;
    report.roleCheckboxes = document.querySelectorAll('[role=checkbox]').length;

    var groups = {};
    document.querySelectorAll('input[type=radio]').forEach(function (r) { groups[r.name || '(noname)'] = (groups[r.name || '(noname)'] || 0) + 1; });
    report.radioGroups = groups;

    var rr = document.querySelector('[role=radio],[role=checkbox]');
    if (rr) {
      var chain = [], p = rr, hops = 0;
      while (p && hops < 7) { chain.push(pick(p)); p = p.parentElement; hops++; }
      report.roleChain = chain;
      var wrap = rr.closest('[class*=option],[class*=choice],[class*=opt],li,div');
      report.roleOptionHtml = wrap ? brief(wrap) : '';
    }

    var ansHits = [];
    [].slice.call(document.querySelectorAll('[class*=answer],[class*=correct],[class*=right],[data-answer]')).forEach(function (e) {
      var t = (e.innerText || e.value || '').trim();
      if (/(答案|正确|参考)/.test(t) && t.length < 120) ansHits.push({ pick: pick(e), text: t.slice(0, 100) });
    });
    report.answerHits = ansHits.slice(0, 10);

    // 递归同源 iframe
    report.childFrames = [].slice.call(document.querySelectorAll('iframe')).map(function (f) {
      try {
        if (f.contentWindow && typeof f.contentWindow.__kwDiag === 'function') return f.contentWindow.__kwDiag(true);
        return { src: (f.src || '').slice(0, 120), note: 'cross-origin — 请在 Console 顶部切换到该 frame 后再运行 __kwDiag()' };
      } catch (e) { return { src: (f.src || '').slice(0, 120), error: String(e) }; }
    }).filter(Boolean);

    if (!arguments[0]) {
      var json = JSON.stringify(report, null, 1);
      console.log('%c[keep-watch 诊断] 复制下面整段发给开发者（如已自动复制可忽略）', 'color:#0a0;font-weight:bold;font-size:13px');
      console.log(json);
      try {
        if (window.copy) { copy(json); console.log('%c✅ 已自动复制到剪贴板', 'color:#06c'); }
      } catch (e) {}
    }
    return report;
  }

  try { window.__kwDiag = diag; } catch (e) {}
  try { console.log('%c[keep-watch] 题目识别异常时，在控制台运行 __kwDiag() 导出页面结构', 'color:#888'); } catch (e) {}
})();
