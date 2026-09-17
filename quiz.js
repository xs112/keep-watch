/* keep-watch quiz engine —— 后台自动答题（ISOLATED world，可访问 chrome.storage / chrome.runtime） */
(function () {
  'use strict';

  // 极早心跳：不依赖任何后续定义，只要 quiz.js 被加载执行就会写入
  try { document.documentElement.setAttribute('data-kw-hb-quiz', '2.6.3'); } catch (e) {}

  // CSS.escape 兜底（老旧环境）
  try {
    if (typeof CSS === 'undefined' || !CSS.escape) {
      window.CSS = window.CSS || {};
      CSS.escape = CSS.escape || function (s) {
        return String(s).replace(/[^a-zA-Z0-9_\-]/g, function (c) { return '\\' + c; });
      };
    }
  } catch (e) {}

  var HOST_RE = /chaoxing\.com|yuketang\.cn|xuetangx\.com|zhihuishu\.com|icve\.com|mooc\.cn|xuexi365|study\.xuexi\.cn/;
  var DEFAULTS = {
    enabled: true, autoAnswer: true, autoSubmit: true, autoNext: true, dryRun: false,
    videoOnly: false,
    usePage: true, useBank: true, useAI: true, autoLearn: true,
    aiProvider: 'deepseek', aiBase: 'https://api.deepseek.com',
    aiKey: '', aiModel: 'deepseek-chat', interval: 2500, onlyPlatforms: true
  };
  var CFG = Object.assign({}, DEFAULTS);
  var bank = {};
  var done = new WeakSet();           // 已处理的题目容器
  var answeredCount = 0, skippedCount = 0, busy = false;

  // ---------- 配置 ----------
  chrome.storage.local.get(null, function (all) {
    Object.assign(CFG, all || {});
    bank = all.bank || {};
    buildHud();
    bindVideosAndDialogs();
    loop();
    new MutationObserver(function () { scheduleLoop(); }).observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', bindVideosAndDialogs);
  });
  chrome.storage.onChanged.addListener(function (ch) {
    Object.keys(ch).forEach(function (k) {
      if (k === 'bank') bank = ch.bank.newValue || {};
      else if (k in DEFAULTS) CFG[k] = ch[k].newValue;
    });
  });

  function active() {
    if (!CFG.enabled) return false;
    if (CFG.onlyPlatforms && !HOST_RE.test(location.hostname)) return false;
    return true;
  }

  // ---------- 工具 ----------
  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    var s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  }
  function txt(el) { return (el && el.innerText || el && el.textContent || '').replace(/\s+/g, ' ').trim(); }
  function normQ(s) {
    return (s || '').replace(/[\s\u00a0]*/g, '')
      .replace(/[（(]\s*[A-D对错√×]\s*[)）]/g, '')
      .replace(/^[0-9]+[.、．]/, '').toLowerCase().slice(0, 80);
  }
  function letterOf(s) {
    s = (s || '').trim();
    // 判断题词（中文结尾无单词边界，显式列分隔符/结尾）
    var judge = s.match(/^[（(]?\s*(正确|错误|对|错|√|×|TRUE|FALSE|T|F|是|否|真|假)(?:[)）.、:：．\s]|$)/i);
    if (judge) {
      var c0 = judge[1];
      if (/^(正确|对|√|T|true|是|真)$/i.test(c0)) return 'A';
      if (/^(错误|错|×|F|false|否|假)$/i.test(c0)) return 'B';
    }
    // A–E 必须独立出现或后随分隔符，避免把 "CPU"、"TCP" 等选项内容误判为字母
    var m = s.match(/^[（(]?\s*([A-Ea-e])\s*(?:[)）.、:：．\s]|$)/);
    if (m) return m[1].toUpperCase();
    return '';
  }
  function isJudge(optTexts) {
    var t = optTexts.join('').replace(/\s/g, '');
    return optTexts.length === 2 && /^(正确|对|√|T|true|是|真)+(错误|错|×|F|false|否|假)+$/i.test(t);
  }

  // ---------- 题目识别 ----------
  var CONTAINER_SEL = [
    '.TiMu', '.Cu_Ti', '.newTiMu', '.singleQuesId', '.questionLi', '.topic-item',           // 超星（含 doHomeWork 新模板）
    '.subject-item', '.question-item', '.exam-question',        // 智慧树
    '.problem', '.exercise-card', '.question-card',             // 雨课堂/学堂在线
    '.question', '.topic', '.exam-topic', '[data-question]',    // 职教云/通用
    '.q-item', '.quiz-question', '.exercise-question', '.test-question',
    '.single-question', '.multi-question', '.judge-question', '.question-wrap',
    '[class*=question]', '[class*=topic-box]', '[class*=exam-item]'
  ].join(',');
  // "像选项"的控件/节点（用于最小容器判定和纯 div 兜底）
  var OPTISH = '[role=radio],[role=checkbox],input[type=radio],input[type=checkbox],' +
    '.nodeLab,.answerBg li,.option,.option-item,.opt-item,.choice,.choice-item,.answer-item,' +
    '.el-radio,.el-checkbox,[class*=option],[class*=choice],[class*=opt-]';

  function extractTitle(box) {
    var t = box.querySelector('.Cy_TItle .clearfix,.Zy_TItle,.mark_name,.subject-title,.subject_describe,.type-title,.problem-title,.stem,.card-title,.q-title,.question-title,.topic-title');
    var s = t ? txt(t) : '';
    if (!s) {
      // 退而求其次：容器内第一个有实质文字的块（排除选项行）
      var cands = box.querySelectorAll('div,span,p,h1,h2,h3,h4,li');
      for (var i = 0; i < cands.length; i++) {
        var x = cands[i];
        if (x.querySelector('input,[role=radio],[role=checkbox]')) continue;
        var sx = txt(x);
        if (sx.length >= 6 && /[?？.。:：]|单选|多选|判断|填空|下列|哪个|哪些|什么|如何|为什么|是指|属于|包括/.test(sx)) { s = sx; break; }
      }
    }
    return s.replace(/^\s*\d+\s*[.、．]?\s*/, '').slice(0, 500);
  }

  function buildOption(optEl, box) {
    var input = optEl.matches && optEl.matches('input') ? optEl : optEl.querySelector('input[type=radio],input[type=checkbox]');
    var raw = txt(optEl).slice(0, 200);
    var letter = letterOf(raw) || '';
    if (!letter && input) {
      var id = input.id, lab = id && box.querySelector('label[for="' + CSS.escape(id) + '"]');
      if (lab) {
        // 超星式：label 里只有字母，选项文字在 li/.nodeLab 里 → 取更长的容器
        var liWrap = input.closest('li,.option,.option-item,.opt-item,.nodeLab');
        if (liWrap && txt(liWrap).length > raw.length + 1) { optEl = liWrap; raw = txt(liWrap).slice(0, 200); }
        else { raw = txt(lab); optEl = lab; }
        letter = letterOf(raw);
      }
    }
    return { el: optEl, input: input, raw: raw, letter: letter, text: raw.replace(/^[（(]?\s*[A-Ea-e][)）.、\s]*/, '').trim() };
  }

  // ---------- 超星专用适配器 ----------
  // 新版(mooc-ans 作业/章节测验): div.questionLi > h3.mark_name + ul.mark_letter>li（纯 li 无 input）
  // 旧版(视频弹题/章节测验): .TiMu, 选项 .Zy_ulTop>li / .Cy_ulTop li / .answerBg li，字母 i.fl，含 label>input
  function isCX() { return /chaoxing\.com|org\.cn|edu\.cn/.test(location.hostname) || !!document.querySelector('.questionLi,.TiMu'); }

  function cxType(box) {
    var t = txt(box.querySelector('.colorShallow,.Zy_TItle .colorShallow,.Cy_TItle'));
    if (/多选/.test(t)) return 'multi';
    if (/判断/.test(t)) return 'judge';
    if (/填空/.test(t)) return 'fill';
    var cb = box.querySelectorAll('input[type=checkbox]').length;
    return cb ? 'multi' : 'single';
  }

  function cxOption(li, box, idx) {
    var input = li.querySelector('label>input,input[type=radio],input[type=checkbox]');
    var iel = li.querySelector('i.fl,i.num,em');
    var letter = letterOf(txt(iel)) || letterOf(txt(li)) || String.fromCharCode(65 + idx);
    var raw = txt(li).slice(0, 200);
    return { el: li, input: input || null, raw: raw, letter: letter,
             text: raw.replace(/^[（(]?\s*[A-Ea-e对错正确错误√×]\s*[)）.、：:]?\s*/, '').trim() };
  }

  function extractChaoxing(box) {
    if (done.has(box) || box.dataset.kwDone === '1') return null;

    // 最新版 doHomeWork：div.singleQuesId > div.TiMu.newTiMu，选项为 [role=radio]/[role=checkbox]（无 input）
    var newT = /(^|\s)newTiMu(\s|$)/.test(box.className || '') ? box
              : (box.matches && box.matches('.singleQuesId') ? box.querySelector('.newTiMu,.TiMu') : null);
    if (newT) {
      var roles = [].slice.call(newT.querySelectorAll('[role=radio],[role=checkbox]')).filter(visible);
      var nfills2 = [].slice.call(newT.querySelectorAll('textarea,input[type=text],input:not([type])')).filter(visible);
      if (roles.length >= 2) {
        var D = function (s) { try { return (window.__kwCx && window.__kwCx.size()) ? window.__kwCx.dec(s) : s; } catch (e) { return s; } };
        // 题型标签与正文都可能被加密字体打乱，必须在解密后的文本上判型
        var whole = D(txt(newT));
        var rtype = /多选/.test(whole) || roles.some(function (r) { return r.getAttribute('role') === 'checkbox'; }) ? 'multi'
                  : /判断/.test(whole) ? 'judge' : 'single';
        var rTitle = D(extractTitle(newT) || txt(newT).split(/[AＡ][\s.．、]/)[0]);
        return {
          box: newT, type: rtype,
          title: rTitle.replace(/^[\s\d]+[.、．]?\s*/, '').replace(/【[^】]*】/g, '').trim().slice(0, 500),
          options: roles.map(function (rEl, i) {
            var raw = D(txt(rEl)).slice(0, 200);
            return { el: rEl, input: null, raw: raw, letter: letterOf(raw) || String.fromCharCode(65 + i),
                     text: raw.replace(/^[（(]?\s*[A-Ea-e对错正确错误√×]\s*[)）.、：:]?\s*/, '').trim() };
          }),
          fills: nfills2, cx: 'newTiMu'
        };
      }
    }

    // 新版：questionLi
    var isNew = /(^|\s)questionLi(\s|$)/.test(box.className || '');
    if (isNew || box.querySelector('ul.mark_letter')) {
      var lis = [].slice.call(box.querySelectorAll('ul.mark_letter > li, .qtDetail > li')).filter(visible);
      var nfills = [].slice.call(box.querySelectorAll('textarea,input[type=text],input:not([type])')).filter(visible);
      if (lis.length < 2 && !nfills.length) return null;
      var nt = box.querySelector('.qtContent') || box.querySelector('.mark_name');
      var nTitle = txt(nt) || extractTitle(box);
      var ntype = lis.length < 2 ? 'fill' : cxType(box);
      return {
        box: box, type: ntype,
        title: nTitle.replace(/^\s*\d+\s*[.、．]?\s*/, '').slice(0, 500),
        options: lis.map(function (li, i) { return cxOption(li, box, i); }),
        fills: nfills, cx: 'new'
      };
    }

    // 旧版：TiMu
    var isOld = /(^|\s)TiMu(\s|$)/.test(box.className || '') || !!box.querySelector('.Cy_TItle,.Zy_TItle');
    if (isOld) {
      var olis = [].slice.call(box.querySelectorAll(
        '.Zy_ulTop > li.clearfix, .Cy_ulTop li, ul.answerBg > li, .clearfix > ul > li'
      )).filter(visible).filter(function (li) {
        return li.querySelector('input[type=radio],input[type=checkbox]') || /^[（(]?\s*[A-Ea-e对错正确错误√×]/.test(txt(li));
      });
      var ofills = [].slice.call(box.querySelectorAll('.Py_tk input[type=text],.Py_tk textarea,textarea,input[type=text]')).filter(visible);
      if (olis.length < 2 && !ofills.length) return null;
      var ot = box.querySelector('.Cy_TItle .clearfix,.Zy_TItle .clearfix,.Zy_TItle');
      return {
        box: box, type: olis.length < 2 ? 'fill' : cxType(box),
        title: txt(ot).replace(/^\s*\d+\s*[.、．]?\s*/, '').slice(0, 500),
        options: olis.map(function (li, i) { return cxOption(li, box, i); }),
        fills: ofills, cx: 'old'
      };
    }
    return null;
  }

  function extractQuestion(box) {
    if (done.has(box) || box.dataset.kwDone === '1') return null;
    var inputs = [].slice.call(box.querySelectorAll('input[type=radio],input[type=checkbox]'));
    var fakes = [].slice.call(box.querySelectorAll(OPTISH + ',label')).filter(function (el) {
      if (!visible(el)) return false;
      var r = txt(el);
      if (!r || r.length > 120) return false;
      var role = el.getAttribute('role');
      if (role === 'radio' || role === 'checkbox') return true;
      if (el.tagName === 'LABEL' && (letterOf(r) || el.querySelector('input'))) return true;
      // 类名像选项，或文本以 A./A) 等开头；但自身包着多个子选项的外层容器一律排除
      var looksLikeLetter = letterOf(r) && el.querySelectorAll(OPTISH).length === 0;
      if (looksLikeLetter) return true;
      if (/(^|[\s_-])(option|opt|choice|answer|nodeLab|item|radio|check)([\s_-]|$)/i.test(el.className || '') ||
          /option|choice|nodeLab|answer/.test(el.className || '')) {
        var inner = el.querySelectorAll(OPTISH);
        if (inner.length <= 1) return true;
      }
      return false;
    });
    var fills = [].slice.call(box.querySelectorAll('input[type=text],input:not([type]),textarea')).filter(visible).filter(function (f) {
      return !f.closest('[role=radio],[role=checkbox]');
    });

    var options = [];
    if (inputs.length) {
      // 按 name 成组，只取属于本题的一组
      var groups = {};
      inputs.forEach(function (i) {
        var key = i.type + '|' + (i.name || i.closest('form,[data-name]') && i.name || 'x');
        (groups[key] = groups[key] || []).push(i);
      });
      var group = Object.keys(groups).sort(function (a, b) { return groups[b].length - groups[a].length; })[0];
      options = groups[group].map(function (i) {
        var wrap = i.closest('label');
        if (!wrap) {
          var liWrap = i.closest('li,.option,.option-item,.opt-item,.item,.row,.Zy_ItTop,.answerBg li,.nodeLab');
          var lab = i.id && box.querySelector('label[for="' + CSS.escape(i.id) + '"]');
          if (liWrap && (!lab || txt(liWrap).length > txt(lab).length + 1)) wrap = liWrap;
          else wrap = lab || i;
        }
        return buildOption(wrap, box);
      });
    } else if (fakes.length >= 2) {
      // 嵌套取舍：role 节点 > 含原生 input 的 label/容器 > 外层 option 类
      // 例：雨课堂 .option>span[role=radio] 取内层；超星 li>input+.nodeLab 取外层 li
      function scoreOf(el) {
        var r = el.getAttribute('role');
        if (r === 'radio' || r === 'checkbox') return 100;
        if (el.tagName === 'LABEL' && el.querySelector('input')) return 95;
        if (el.querySelector('input[type=radio],input[type=checkbox]')) return 85;
        if (el.tagName === 'LABEL') return 70;
        return 60;
      }
      fakes = fakes.filter(function (el) {
        for (var i = 0; i < fakes.length; i++) {
          var o = fakes[i];
          if (o === el) continue;
          if (o.contains(el) && scoreOf(o) >= scoreOf(el)) return false; // 外层更优或同级 → 剔除内层
          if (el.contains(o) && scoreOf(o) > scoreOf(el)) return false;  // 内层更优 → 剔除外层
        }
        return true;
      });
      options = fakes.map(function (el) { return buildOption(el, box); });
    } else if (!fills.length) return null;

    options.forEach(function (o, i) { if (!o.letter) o.letter = String.fromCharCode(65 + i); });
    if (options.length && options.length > 8) return null;

    var title = extractTitle(box);
    if (!title && options.length < 2) return null;
    var type = /多选/.test(txt(box)) || (inputs.some(function (i) { return i.type === 'checkbox'; })) ? 'multi'
             : /判断/.test(txt(box)) || isJudge(options.map(function (o) { return o.text; })) ? 'judge'
             : fills.length && !options.length ? 'fill' : 'single';
    return { box: box, type: type, title: title, options: options, fills: fills };
  }

  function findQuestions() {
    var nodes = [].slice.call(document.querySelectorAll(CONTAINER_SEL)).filter(visible);
    // 通用兜底 1：原生 radio/checkbox 成组的最近容器
    document.querySelectorAll('input[type=radio],input[type=checkbox]').forEach(function (i) {
      if (i.closest(CONTAINER_SEL)) return;
      var p = i.parentElement, hops = 0, box = null;
      while (p && hops < 6 && p !== document.body) {
        var radios = p.querySelectorAll('input[type=radio],input[type=checkbox]');
        if (radios.length >= 2) {
          var sameName = [].filter.call(radios, function (r) { return r.name === i.name; });
          if (sameName.length >= 2 && p.querySelectorAll('input').length <= 12) { box = p; break; }
        }
        p = p.parentElement; hops++;
      }
      if (box && visible(box) && nodes.indexOf(box) < 0) nodes.push(box);
    });
    // 通用兜底 2：role=radio/checkbox 成组的最近容器（纯 div 实现的选项）
    document.querySelectorAll('[role=radio],[role=checkbox]').forEach(function (i) {
      if (i.closest(CONTAINER_SEL)) return;
      var p = i.parentElement, hops = 0, box = null;
      while (p && hops < 6 && p !== document.body) {
        var n = p.querySelectorAll('[role=radio],[role=checkbox]').length;
        if (n >= 2 && n <= 10) { box = p; break; }
        p = p.parentElement; hops++;
      }
      if (box && visible(box) && nodes.indexOf(box) < 0) nodes.push(box);
    });
    var out = [], seen = new WeakSet();
    nodes.forEach(function (n) {
      if (seen.has(n)) return;
      // 只保留最小题目容器，避免套娃
      if (nodes.some(function (m) { return m !== n && n.contains(m) && m.querySelector(OPTISH); })) return;
      seen.add(n);
      // 超星专用优先；返回 false 表示不适用，回退通用解析
      var q = (isCX() ? extractChaoxing(n) : null);
      if (q === false || q == null) q = extractQuestion(n);
      if (q && (q.options.length >= 2 || q.type === 'fill')) out.push(q);
    });
    return out;
  }

  // ---------- 答案来源 1：页面内嵌答案 ----------
  function pageAnswer(q) {
    var hit = q.box.getAttribute && q.box.getAttribute('data-answer') ? q.box
      : q.box.querySelector('.correctAnswer,.right-answer,.rightAnswer,.answer-key,.answerKey,.key_answer,.trueAnswer,[data-answer],[data-correct="true"],.is-correct,.is-right,.rightAnswerContent,.mark_key .rightAnswerContent,.Py_answer');
    var m;
    if (hit) {
      var s = (hit.getAttribute('data-answer') || txt(hit) || hit.value || '');
      m = s.match(/答案[:：\s]*([A-Ea-e对错正确错误√×]+)/) || s.match(/\b([A-E](?:\s*[A-E])*)\b/);
      if (m) return normAns(m[1], q);
    }
    // 超星新版：正确答案元素（可能与学生答案并列）
    var rac = q.box.querySelector('.rightAnswerContent');
    if (rac) { var rs = txt(rac).replace(/[\s,，、]/g, ''); if (/^[A-Ea-e对错正确错误√×]+$/.test(rs)) return normAns(rs, q); }
    // 选项自身带 correct/right/green 标记
    var marks = q.options.filter(function (o) {
      return /correct|right|is-true|green/.test(o.el.className) || o.el.getAttribute('data-correct') === 'true' ||
             o.el.querySelector && o.el.querySelector('.correct,.right,.is-correct');
    }).map(function (o) { return o.letter; });
    if (marks.length) return marks.join('');
    // 整块文本里的"正确答案：B"
    m = txt(q.box).match(/(?:正确答案|参考答案|答案)[:：\s]*([A-Ea-e](?:[\s,，、]*[A-Ea-e])*|正确|错误|对|错|√|×)/);
    if (m) return normAns(m[1], q);
    return '';
  }
  function normAns(s, q) {
    s = (s || '').replace(/[\s,，、]/g, '');
    if (/^(正确|对|√)$/.test(s)) return 'A';
    if (/^(错误|错|×)$/.test(s)) return 'B';
    return s.toUpperCase();
  }

  // ---------- 答案来源 2：本地题库 ----------
  function bankAnswer(q) { var b = bank[normQ(q.title)]; return b ? String(b.answer || b) : ''; }
  function remember(q, ans) {
    if (!CFG.autoLearn || !ans) return;
    bank[normQ(q.title)] = { answer: ans, q: q.title, t: Date.now() };
    chrome.storage.local.set({ bank: bank });
  }

  // ---------- 答案来源 3：AI ----------
  function aiAnswer(q, first) {
    if (!CFG.aiKey) { if (first) dbg('ai-fail', 'no-key'); return Promise.resolve(''); }
    if (first) dbg('ai-req', (CFG.aiBase || '') + '|' + (CFG.aiModel || ''));
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({
          type: 'aiAsk', base: CFG.aiBase, key: CFG.aiKey, model: CFG.aiModel,
          question: q.title,
          options: q.type === 'fill' ? [] : q.options.map(function (o) { return o.letter + '. ' + o.text; }),
          qtype: q.type
        }, function (r) {
          if (first) dbg('ai-resp', r ? (r.answer ? ('ok:' + String(r.answer).slice(0, 20)) : ('empty:' + String(r.error || r.status || 'no-answer'))) : 'no-response');
          if (chrome.runtime.lastError && first) dbg('ai-fail', (chrome.runtime.lastError.message || '').slice(0, 60));
          resolve(r && r.answer ? r.answer : '');
        });
      } catch (e) { if (first) dbg('ai-fail', (e.message || '').slice(0, 60)); resolve(''); }
    });
  }

  // ---------- 作答动作 ----------
  function clickOption(o) {
    var input = o.input, el = o.el;
    // 关键：整个选项只触发一次点击。先点容器（label 点击会自然激活内部 input，
    // 超星/Vue 等框架也通常监听容器的 click），避免"点 input + 点包裹 label"
    // 导致 checkbox 被切换两次反而取消。
    if (el && el !== input) {
      try { el.click(); } catch (e) {}
    } else if (input) {
      try { input.click(); } catch (e) {}
    }
    // role=radio/checkbox（超星 doHomeWork 新模板，无原生 input）：只点一次容器。
    // 框架（Vue/React）的选中态在下一 tick 才反映到 aria/class，故延迟复查，绝不同步立即重点
    // （同步重点会让 checkbox 点两次反而取消）。复查仍未选中才兜底：点内层、置 aria。
    var roleEl = el, roleNow = el && el.getAttribute && el.getAttribute('role');
    if (!input && (roleNow === 'radio' || roleNow === 'checkbox')) {
      setTimeout(function () {
        if (!roleEl || !roleEl.isConnected) return;
        var on2 = roleEl.getAttribute('aria-checked') === 'true' ||
                  /(^|\s)(checked|selected|active|on|cur|zx-check|check)(\s|$)/.test(roleEl.className || '');
        if (on2) return;
        var inner2 = roleEl.querySelector('[role=radio],[role=checkbox],label,a');
        try { if (inner2 && inner2 !== roleEl) inner2.click(); } catch (e) {}
        try { roleEl.setAttribute('aria-checked', 'true'); roleEl.classList.add('checked'); } catch (e) {}
      }, 60);
    }
    // 兜底：容器点击未使控件选中（div/li 容器，或 jsdom 等不模拟 label 激活）→ 直接点控件
    if (input && !input.checked) {
      try { input.click(); } catch (e) {}
    }
    // 最后手段：环境/脚本拦截了点击行为，强制选中并派发事件
    if (input && !input.checked) {
      try {
        input.checked = true;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (e) {}
    }
  }
  function setNativeValue(el, v) {
    var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, v); else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function findBtn(words, scope) {
    scope = scope || document;
    var btns = [].slice.call(scope.querySelectorAll('button,a.btn,.btn,[role=button],input[type=submit],input[type=button]'));
    return btns.filter(visible).find(function (b) {
      var t = (b.innerText || b.value || txt(b) || '').replace(/\s+/g, '');
      return words.some(function (w) { return t === w || t.indexOf(w) > -1; }) && t.length <= 8;
    });
  }
  function doSubmit(q) {
    if (q.box.dataset.kwSubmitted === '1') return;
    // 只在本题容器内找提交按钮；向上兜底仅当父容器只包本题一个题块（防止误点别题按钮）
    var btn = findBtn(['提交答案', '提交', '确 定', '确定', '完成作答'], q.box);
    var par = q.box.parentElement;
    if (!btn && par && par.querySelectorAll(CONTAINER_SEL).length === 1) {
      btn = findBtn(['提交答案', '提交', '确 定', '确定', '完成作答'], par);
    }
    if (!btn) return; // 整卷统一提交的页面：不强点
    q.box.dataset.kwSubmitted = '1';
    try { localStorage.setItem('kw_autoconfirm', '1'); } catch (e) {}
    btn.click();
    // 自定义弹窗里的二次确认（弹窗挂在 body 上，只能全局找）
    setTimeout(function () {
      var ok = findBtn(['确认提交', '确定', '确认', '知道了']);
      if (ok) ok.click();
      try { localStorage.removeItem('kw_autoconfirm'); } catch (e) {}
    }, 900);
    setTimeout(function () {
      var nx = findBtn(['下一题', '下一页', '继续学习', '继续', '关闭']);
      if (nx) nx.click();
    }, 1800);
  }

  // ---------- 看完自动下一节 ----------
  var boundVideos = new WeakMap();   // video -> {fired, sawEarly, src}
  var handledEpochs = new Set();     // 已处理的 SW 广播 epoch

  var NEXT_WORDS = ['下一节', '下一课时', '下一课', '下一讲', '下一个视频', '下一个', '下一页', '继续学习', '继续观看', '继续播放', '继续'];

  function findNextButton(scope) {
    scope = scope || document;
    var btns = [].slice.call(scope.querySelectorAll('button,a,[role=button],.btn,.next,.nextBtn,.next-button')).filter(visible);
    function disabled(b) {
      return b.disabled || b.getAttribute('aria-disabled') === 'true' ||
             /(^|\s)(disabled|forbid|gray|grey|locked|not-allowed)(\s|$)/.test(b.className || '');
    }
    for (var i = 0; i < NEXT_WORDS.length; i++) {
      var w = NEXT_WORDS[i];
      var hit = btns.find(function (b) {
        if (disabled(b)) return false;
        var t = (b.innerText || b.textContent || b.title || '').replace(/\s+/g, '');
        if (w === '继续') return t === '继续';                 // 裸"继续"才精确匹配
        return t === w || (t.indexOf(w) > -1 && t.length <= 10);
      });
      if (hit) return hit;
    }
    return null;
  }

  // 目录树：定位当前高亮章节标记（取目录容器内最深的激活标记）
  function catalogMarker() {
    var stateSel = '.active,.current,.on,.playing,.is-active,.cur,.numNow,.chapter-active,.lesson-active,.selected,.posCatalog_active,.catalog-active,.node-active';
    var itemSel = 'li,.chapter-item,.section-item,.catalog-item,.lesson-item,.item';
    var allMarks = [].slice.call(document.querySelectorAll(stateSel)).filter(visible)
      .map(function (m) { return { m: m, li: m.closest(itemSel) }; })
      .filter(function (x) { return x.li; });
    var inCatalog = allMarks.filter(function (x) {
      return x.m.closest('[class*=catalog],[class*=chapter],[class*=section],[class*=lesson],[class*=posCatalog],[class*=catalogue]');
    });
    if (inCatalog.length) allMarks = inCatalog;
    var marker = null, depth = -1;
    allMarks.forEach(function (x) {
      var d = 0, p = x.m;
      while (p && p !== document.body) { d++; p = p.parentElement; }
      if (d > depth || (d === depth && marker && marker.compareDocumentPosition(x.m) & Node.DOCUMENT_POSITION_FOLLOWING)) {
        depth = d; marker = x.m;
      }
    });
    return marker;
  }

  // 目录树当前章节的后继条目
  function nextFromCatalog() {
    var itemSel = 'li,.chapter-item,.section-item,.catalog-item,.lesson-item,.item';
    var marker = catalogMarker();
    var cur = marker ? marker.closest(itemSel) : null;
    if (!cur) return null;

    function usable(node) {
      if (!node) return false;
      var t = txt(node);
      if (!t) return false;
      if (node.querySelector('.lock,.locked,.icon-lock,[disabled]') || /未解锁|暂未开放|未开放/.test(t)) return false;
      return true;
    }
    var next = cur.nextElementSibling, hops = 0;
    while (next && !usable(next) && hops < 3) { next = next.nextElementSibling; hops++; }
    if (usable(next)) return next.querySelector('a,.posCatalog_select,.chapter-title,.section-title,.title,.name') || next;

    // 同级结束 → 父章节的下一组
    var parentLi = cur.parentElement && cur.parentElement.closest('li,.chapter-item');
    if (parentLi) {
      var pn = parentLi.nextElementSibling;
      if (usable(pn)) return pn.querySelector('li a,a,.posCatalog_select,.chapter-title,.title') || pn;
    }
    return null;
  }

  // ================= 只刷课模式辅助 =================
  var MIN_MAIN_DUR = 15;   // 主视频最短时长（秒）：广告/片头/预览通常更短
  function hasSrc(v) { return !!(v.currentSrc || v.src || v.srcObject || v.querySelector && v.querySelector('source')); }
  function realVideos() {
    return [].slice.call(document.querySelectorAll('video')).filter(function (v) {
      return isFinite(v.duration) && v.duration >= MIN_MAIN_DUR;
    });
  }
  // 是否为本帧“主视频”：可见、时长达标，且同帧没有明显更长的可见视频
  // （页面常并存广告/预览/备用清晰度多个 <video>，只允许真正的课程长视频触发完成；
  //  不强制 currentSrc，兼容 MSE srcObject / <source> 的播放器）
  function isMainVideo(v) {
    if (!v || !visible(v) || !isFinite(v.duration) || v.duration < MIN_MAIN_DUR) return false;
    var longer = realVideos().some(function (o) {
      return o !== v && visible(o) && o.duration > v.duration + 5;
    });
    return !longer;
  }
  function playingOrPausedVideo() {
    var vids = realVideos().filter(function (v) { return visible(v) && !v.ended; });
    if (!vids.length) {
      // 时长未就绪时退回“可见且有片源、未结束”的候选，避免加载中判空
      vids = [].slice.call(document.querySelectorAll('video')).filter(function (v) {
        return visible(v) && hasSrc(v) && !v.ended;
      });
    }
    // 多个候选时取时长最长者（主视频），避免选到广告/预览
    vids.sort(function (a, b) { return (b.duration || 0) - (a.duration || 0); });
    return vids[0] || null;
  }
  function ensurePlay(v) {
    if (!v || v.ended) return;
    if (v.paused) {
      try {
        var p = v.play();
        if (p && p.catch) p.catch(function () {});
        hudStatus('▶️ 正在播放视频…');
      } catch (e) {}
    } else {
      hudStatus('▶️ 刷课中… ' + (isFinite(v.duration) && v.duration ? Math.min(99, Math.round(v.currentTime / v.duration * 100)) : '') + '%');
    }
  }

  // 关掉“视频中途弹出的测验”而不答题（保留结束后的完成弹窗给连播逻辑）
  function dismissVideoQuiz() {
    var quizSel = '.TiMu,.newTiMu,.questionLi,.singleQuesId,[role=radio],[role=checkbox],input[type=radio],input[type=checkbox]';
    var overlays = [].slice.call(document.querySelectorAll(
      '.dialog,.modal,.el-dialog,.ant-modal,.popup,.pop,.layui-layer,.dialog-wrap,.vjs-modal,[class*=quiz],[class*=question],[class*=topic]'
    )).filter(visible);
    overlays.forEach(function (ov) {
      if (!ov.querySelector(quizSel)) return;            // 不含题，不管
      if (ov.getAttribute('data-kw-dismissed')) return;
      // 结束弹窗（含完成字样）交给连播，不在此关闭
      if (/完成|恭喜|看完|学时已达|本节学习任务已完成/.test(txt(ov))) return;
      var close = findBtn(['关闭', '取消', '我知道了', '知道了', '继续学习', '继续观看', '暂不答题', '下次再说', '跳过'], ov)
               || ov.querySelector('.close,[class*=close],[aria-label=Close],[aria-label=关闭]');
      if (close) {
        ov.setAttribute('data-kw-dismissed', '1');
        try { close.click(); } catch (e) {}
        hudStatus('⏭️ 跳过弹题，继续刷课');
        // 关闭后强制恢复播放
        setTimeout(function () { var vv = playingOrPausedVideo(); if (vv && vv.paused) ensurePlay(vv); }, 800);
      }
    });
  }

  // 当前节无视频：本 frame 能跳就点下一节；不能跳（独立作业/测验页无目录）→ 广播给目录 frame
  var jumpGuard = { key: '', at: 0 };
  var crossJumpAt = 0;
  function jumpToNextVideo() {
    var target = findNextButton() || nextFromCatalog();
    var now = Date.now();
    if (target) {
      var key = txt(target.closest('li,.chapter-item,.section-item,.catalog-item,.lesson-item,.item') || target).slice(0, 30)
              || (target.href || '');
      if (jumpGuard.key === key && now - jumpGuard.at < 4000) return false; // 同一节连点保护
      jumpGuard = { key: key, at: now };
      hudStatus('⏭️ 当前节非视频，跳到下一节找视频…');
      try { target.click(); } catch (e) {}
      afterNext();
      return true;
    }
    // 本 frame 无入口：广播给同 tab 的目录 frame（3 秒冷却，避免刷屏）
    if (now - crossJumpAt < 3000) return false;
    crossJumpAt = now;
    hudStatus('⏭️ 跳过测验页，请目录自动切到下一视频节…');
    kwSend('finish', { source: 'videoOnly-skip' });
    return true;
  }

  function completionDialog(scope) {
    scope = scope || document;
    var dlg = [].slice.call(scope.querySelectorAll(
      '.dialog,.modal,.el-dialog,.ant-modal,.complete,.finish,.tips,.popup,.pop,.mask,.layui-layer,.dialog-wrap,.vjs-modal'
    )).find(function (m) {
      return visible(m) && /本节.{0,8}完成|已完成本节|恭喜.{0,12}完成|学习完成|你已看完|本节视频已看完|课时.{0,4}完成|任务点.{0,6}完成|视频.{0,4}看完|本节学习任务已完成/.test(txt(m));
    });
    return dlg || null;
  }

  function afterNext() {
    setTimeout(function () {
      document.querySelectorAll('video').forEach(function (v) {
        if (v.paused && !v.ended) {
          try {
            var p = v.play();
            if (p && p.catch) p.catch(function () {});
          } catch (e) {}
        }
      });
      var close = findBtn(['我知道了', '知道了', '关闭']);
      if (close) close.click();
    }, 1500);
    scheduleLoop();
  }

  // ---- 跨 frame 协作：播完 → service worker 广播到本 tab 所有 frame ----
  // 每个 frame 各自寻找"下一节"入口；完成弹窗按钮立即点，目录/页面按钮延迟
  // 1 秒并比对页面签名——别的 frame 已完成切换（高亮移动/视频换源/弹窗消失）则放弃。

  function hasPendingQuiz() {
    return [].slice.call(document.querySelectorAll(CONTAINER_SEL)).some(function (box) {
      return visible(box) && box.dataset.kwDone !== '1' &&
        (box.querySelector('.correctAnswer') || box.querySelector('input[type=radio],input[type=checkbox],[role=radio]'));
    });
  }

  function reportFinish(source, retry) {
    if (!CFG.autoNext && !CFG.videoOnly) return;
    // 视频页弹题未答完：答題模式等引擎处理；只刷课模式不等待，直接切
    if (hasPendingQuiz() && !CFG.videoOnly && (retry || 0) < 3) {
      hudStatus('检测到弹题，答完后自动切换…');
      setTimeout(function () { reportFinish(source, (retry || 0) + 1); }, 3000);
      return;
    }
    // 本 frame 立刻试一次弹窗按钮（响应最快），SW 广播到达后其他 frame 自检防双跳
    var dlg = completionDialog();
    if (dlg && findNextButton(dlg)) clickDialogOnce(dlg);
    kwSend('finish', { source: String(source || '?') });
  }

  function clickDialogOnce(dlg) {
    var b = findNextButton(dlg);
    if (!b) return false;
    var sig = txt(dlg).slice(0, 60);
    var lastSig = dlg.getAttribute('data-kw-sig'), lastAt = +dlg.getAttribute('data-kw-at') || 0;
    if (sig === lastSig && Date.now() - lastAt < 30000) return false;
    dlg.setAttribute('data-kw-sig', sig);
    dlg.setAttribute('data-kw-at', String(Date.now()));
    try { b.click(); } catch (e) {}
    hudStatus('▶️ 本节完成，自动切换下一节…');
    afterNext();
    return true;
  }

  // 本 frame "当前在第几节"的指纹：目录高亮文本 + 视频源 + 完成弹窗
  function pageSig() {
    var cur = '';
    try {
      var marker = catalogMarker();
      cur = marker ? txt(marker.closest('li,.chapter-item,.section-item,.catalog-item,.lesson-item,.item') || marker).slice(0, 80) : '';
    } catch (e) {}
    var vids = [].slice.call(document.querySelectorAll('video')).map(function (v) {
      return (v.currentSrc || v.src || '').split('/').pop().slice(0, 60);
    }).join('|');
    var dlg = completionDialog();
    return JSON.stringify([cur, vids, dlg ? txt(dlg).slice(0, 40) : '']);
  }

  function handleGoNext(epoch, source) {
    if (!CFG.autoNext && !CFG.videoOnly) return;
    if (epoch && handledEpochs.has(epoch)) return;

    // 1) 完成弹窗内按钮：立即点（最强信号）
    var dlg = completionDialog();
    if (dlg && findNextButton(dlg)) {
      if (epoch) handledEpochs.add(epoch);
      clickDialogOnce(dlg);
      return;
    }

    // 2) 页面按钮 / 目录：延迟 1s，签名变化说明别的 frame 已切换 → 放弃
    var target = findNextButton() || nextFromCatalog();
    if (!target) { hudStatus('已是最后一节或未找到下一节入口'); return; }
    if (epoch) handledEpochs.add(epoch);
    var sigBefore = pageSig();
    setTimeout(function () {
      if (!CFG.autoNext && !CFG.videoOnly) return;
      var dlg2 = completionDialog();
      if (dlg2 && findNextButton(dlg2)) { clickDialogOnce(dlg2); return; } // 弹窗刚出现
      if (pageSig() !== sigBefore) { hudStatus('已由播放页切换下一节'); return; }
      if (target.disabled || (target.ownerDocument !== document)) return;
      hudStatus('▶️ 本节完成，自动切换下一节…');
      try { target.click(); } catch (e) {}
      afterNext();
    }, 1000);
  }

  // ---- 统一连播协议：所有跨 frame 消息走 {type:'kw', op} ----
  function kwSend(op, extra, cb) {
    var m = { type: 'kw', op: op };
    if (extra) Object.keys(extra).forEach(function (k) { m[k] = extra[k]; });
    try { chrome.runtime.sendMessage(m, cb || function () { void chrome.runtime.lastError; }); } catch (e) {}
  }

  // SW 广播（所有 frame 都会收到）
  try {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (msg && msg.type === 'kw' && msg.op === 'gonext') handleGoNext(msg.epoch, msg.source);
    });
  } catch (e) {}

  // ---- 视频监听：ended + 播放进度阈值（平台卡 99%/弹题不 fire ended 也能触发）----
  function tickVideos() {
    if (!active() || (!CFG.autoNext && !CFG.videoOnly)) return;
    document.querySelectorAll('video').forEach(function (v) {
      var st = boundVideos.get(v);
      if (!st) {
        st = { fired: false, sawEarly: false, src: v.currentSrc || v.src || '' };
        boundVideos.set(v, st);
        v.addEventListener('ended', function () {
          // 只认真正的课程主视频：片头广告/隐藏预览/备用流播完不得触发跳节（这是“没播完就跳”的主因）
          if (st.fired || !isMainVideo(v)) return;
          st.fired = true; reportFinish('ended');
        });
        // SPA 换节复用同一 video 元素 → 换源时重置触发状态与防抖（新节 = 新周期）
        v.addEventListener('loadstart', function () {
          var s = v.currentSrc || v.src || '';
          if (s && s !== st.src) {
            st.fired = false; st.sawEarly = false; st.src = s; handledEpochs.clear();
            try { kwSend('reset'); } catch (e) {}
          }
        });
        v.addEventListener('timeupdate', function () { checkProgress(v, st); });
      }
      checkProgress(v, st);
    });

    // 本 frame 内的完成弹窗：轮询兜底（无 ended/进度事件时），指纹去重
    var dlg = completionDialog();
    if (dlg && findNextButton(dlg)) clickDialogOnce(dlg);
  }

  function checkProgress(v, st) {
    if (st.fired) return;
    if (!isMainVideo(v)) return;                      // 只认真正的课程主视频
    var d = v.duration, t = v.currentTime;
    if (!d || !isFinite(d) || d < MIN_MAIN_DUR) return;
    if (t < d * 0.5) st.sawEarly = true;             // 确认从头看过
    // 只在真正贴近结尾时判定完成：提前最多 2.5 秒。
    // 不再用比例阈值（旧的 97% 对长视频会提前数分钟跳节，正是“没播完就跳”）。
    var reached = t >= d - 2.5;
    if (reached && (st.sawEarly || (t / d) >= 0.999)) {
      st.fired = true;
      reportFinish('progress@' + Math.round(t / d * 100) + '%');
    }
  }

  function bindVideosAndDialogs() { tickVideos(); }

  async function answerOne(q, idx) {
    var first = (answeredCount + skippedCount === 0);
    if (first) {
      try {
        dbg('q-title', (q.title || '').slice(0, 50));
        dbg('q-type', q.type);
        dbg('q-opts', (q.options || []).length);
        dbg('q-letters', (q.options || []).map(function (o) { return o.letter; }).join(''));
        dbg('cfg-useAI', CFG.useAI ? '1' : '0');
        dbg('cfg-hasKey', CFG.aiKey ? '1' : '0');
        dbg('q-aiModel', CFG.aiModel || '');
      } catch (e) {}
    }
    var ans = '';
    var source = '';
    if (CFG.usePage) { ans = pageAnswer(q); source = ans ? '页面答案' : ''; if (first) dbg('src-page', ans || 'none'); }
    if (!ans && CFG.useBank) { ans = bankAnswer(q); source = ans ? '本地题库' : ''; if (first) dbg('src-bank', ans || 'none'); }
    if (!ans && CFG.useAI) {
      hudStatus('AI 思考中…');
      ans = await aiAnswer(q, first);
      source = ans ? 'AI' : '';
      if (first) dbg('src-ai', ans || 'none');
    }

    if (!ans) {
      skippedCount++;
      if (first) dbg('q-result', 'skipped');
      hudStatus('未找到答案，跳过'); return false;
    }

    if (CFG.dryRun) { q.box.style.outline = '3px solid #f5a623'; source = '演练(不点击)'; }
    else if (q.type === 'fill') {
      q.fills.forEach(function (f) { setNativeValue(f, ans.replace(/^["'\s]+|["'\s]+$/g, '')); });
    } else {
      var letters = ans.toUpperCase().replace(/[^A-E]/g, '').split('');
      if (first) dbg('q-click', letters.join(''));
      letters.forEach(function (L) {
        var o = q.options.find(function (x) { return x.letter.toUpperCase() === L; });
        if (o) clickOption(o);
      });
      if (CFG.autoSubmit) setTimeout(function () { doSubmit(q); }, 700);
    }

    remember(q, ans);
    answeredCount++;
    q.box.dataset.kwDone = '1';
    done.add(q.box);
    if (first) dbg('q-result', 'answered:' + ans);
    hudStatus('✅ ' + source + '：' + ans);
    return true;
  }

  // 用当前超星字体映射还原一道题的题干与选项（映射未就绪则原样）
  function decryptQuestion(q) {
    try {
      var cx = window.__kwCx;
      if (!cx || !cx.size()) return q;
      if (cx.dec(q.title) !== q.title) q.title = cx.dec(q.title);
      (q.options || []).forEach(function (o) {
        var t = cx.dec(o.text); if (t !== o.text) o.text = t;
        var r = cx.dec(o.raw); if (r !== o.raw) o.raw = r;
      });
    } catch (e) {}
    return q;
  }

  // ---------- 自检：把隔离世界里的引擎状态写到 DOM，主世界控制台可读 ----------
  function dbg(k, v) {
    try { document.documentElement.setAttribute('data-kw-' + k, String(v)); } catch (e) {}
  }
  dbg('loaded', '2.6.3');

  // ---------- 主循环 ----------
  var loopQueued = false;
  function scheduleLoop() {
    if (loopQueued) return;
    loopQueued = true;
    setTimeout(function () { loopQueued = false; bindVideosAndDialogs(); loop(); }, 400);
  }
  async function loop() {
    dbg('host', location.hostname);
    dbg('active', active() ? '1' : '0');
    dbg('videoOnly', CFG.videoOnly ? '1' : '0');
    dbg('autoAnswer', CFG.autoAnswer ? '1' : '0');
    dbg('busy', busy ? '1' : '0');
    if (!active() || busy) return;

    // ===== 只刷课模式：不答题，只保证视频持续播放 + 跳过非视频节 =====
    if (CFG.videoOnly) {
      dismissVideoQuiz();                       // 关掉视频中途弹出的测验
      var v = playingOrPausedVideo();
      if (v) {
        ensurePlay(v); dbg('stage', 'video-playing');
        // 本 frame 有视频在播：持续心跳，阻止其他 frame（顶层/目录/测验层）误跳
        kwSend('beat');
        return;
      }
      // 本 frame 有可见 <video> 但还在加载（duration 未就绪）：占位心跳并等待，杜绝启动竞态误跳
      var loading = [].slice.call(document.querySelectorAll('video')).filter(function (x) {
        return visible(x) && !x.ended;
      })[0];
      if (loading && (!isFinite(loading.duration) || !(loading.duration > 0))) {
        dbg('stage', 'video-loading');
        kwSend('beat');
        try { if (loading.paused && loading.play) { var lp = loading.play(); if (lp && lp.catch) lp.catch(function(){}); } } catch (e) {}
        return;
      }
      // 本 frame 无视频。先问 SW：是否有兄弟 frame 的视频正在播？有则绝不能跳（这就是“视频被跳过”的根因）
      kwSend('query', null, function (resp) {
        if (chrome.runtime.lastError) return;
        if (resp && resp.playing) { dbg('stage', 'sibling-video-playing'); return; }
        var moved = jumpToNextVideo();
        dbg('stage', moved ? 'jump-to-video' : 'no-video-yet');
      });
      return;
    }

    if (!CFG.autoAnswer) return;
    // 加密字体：后台预热（不阻塞扫题），就绪后下一轮自然用上；解密失败也照常扫题
    try {
      if (window.__kwCx) {
        dbg('fontHas', window.__kwCx.has() ? '1' : '0');
        dbg('fontSize', window.__kwCx.size());
        if (window.__kwCx.has() && !window.__kwCx.size() && !fontWarming) {
          fontWarming = true; dbg('font', 'warming');
          window.__kwCx.ensure().then(function (m) {
            fontWarming = false;
            dbg('font', m ? ('map:' + window.__kwCx.size()) : 'failed');
          });
        }
      } else { dbg('font', 'no-module'); }
      var st = window.__kwCx && window.__kwCx.stats ? window.__kwCx.stats() : null;
      if (st) {
        dbg('fontTotal', st.total);
        dbg('fontMiss', st.total - st.matched);
        dbg('fontMissCp', (st.miss || []).join(','));
      }
    } catch (e) { dbg('fontErr', (e.message || '').slice(0, 60)); }

    var qs;
    try {
      qs = findQuestions(); dbg('found', qs.length);
      if (!qs.length) {
        // 记录原始命中，定位是“选择器没匹配”还是“匹配后被过滤/适配器返回 null”
        dbg('rawContainers', document.querySelectorAll(CONTAINER_SEL).length);
        dbg('rawNewTiMu', document.querySelectorAll('.newTiMu,.singleQuesId').length);
        dbg('rawRole', document.querySelectorAll('[role=radio],[role=checkbox]').length);
      }
    }
    catch (e) { dbg('scanErr', (e.message || '').slice(0, 80)); console.error('[kw findQ err]', e && e.stack); return; }
    if (!qs.length) { dbg('stage', 'listening'); return; }
    busy = true; dbg('stage', 'answering');
    for (var i = 0; i < qs.length; i++) {
      if (!active()) break;
      try { decryptQuestion(qs[i]); await answerOne(qs[i]); } catch (e) { dbg('ansErr', (e.message || '').slice(0, 80)); }
      await new Promise(function (r) { setTimeout(r, 500); });
    }
    busy = false;
    updateHud();
  }
  var fontWarming = false;
  setInterval(function () {
    if (!active()) return;
    bindVideosAndDialogs();
    loop();
  }, 3000);

  // ---------- 悬浮状态条 ----------
  function buildHud() {
    if (document.getElementById('kw-hud') || window.top !== window) return;
    var d = document.createElement('div');
    d.id = 'kw-hud';
    d.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;font:12px/1.6 system-ui,Microsoft YaHei;' +
      'background:rgba(20,20,24,.88);color:#eee;border:1px solid #444;border-radius:8px;padding:6px 10px;min-width:150px;cursor:default;box-shadow:0 2px 10px rgba(0,0,0,.4)';
    d.innerHTML = '<div><b>📺 keep-watch</b> <span id="kw-state" style="color:#6f6">运行中</span></div>' +
      '<div>已答 <b id="kw-ok">0</b> · 跳过 <b id="kw-skip">0</b></div>' +
      '<div id="kw-msg" style="color:#bbb;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">监听题目中…</div>';
    d.onclick = function () {
      CFG.enabled = !CFG.enabled;
      chrome.storage.local.set({ enabled: CFG.enabled });
      d.querySelector('#kw-state').textContent = CFG.enabled ? '运行中' : '已暂停';
      d.querySelector('#kw-state').style.color = CFG.enabled ? '#6f6' : '#f66';
    };
    (document.body || document.documentElement).appendChild(d);
  }
  function hudStatus(s) {
    buildHud();
    var el = document.getElementById('kw-msg'); if (el) el.textContent = s;
    updateHud();
  }
  function updateHud() {
    var a = document.getElementById('kw-ok'), b = document.getElementById('kw-skip');
    if (a) a.textContent = answeredCount;
    if (b) b.textContent = skippedCount;
  }
})();
