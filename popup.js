/* keep-watch popup */
var DEFAULTS = {
  enabled: true, fullAuto: false, autoAnswer: true, autoSubmit: true, autoNext: true, dryRun: false,
  videoOnly: false,
  usePage: true, useBank: true, useAI: true, autoLearn: true,
  aiProvider: 'deepseek', aiBase: 'https://api.deepseek.com',
  aiKey: '', aiModel: 'deepseek-chat', onlyPlatforms: true
};
var PRESETS = {
  deepseek:   { base: 'https://api.deepseek.com',            model: 'deepseek-chat' },
  volc:       { base: 'https://ark.cn-beijing.volces.com/api/coding/v1', model: 'ark-code-latest' },
  moonshot:   { base: 'https://api.moonshot.cn/v1',          model: 'moonshot-v1-8k' },
  zhipu:      { base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  dashscope:  { base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-turbo' },
  openai:     { base: 'https://api.openai.com/v1',           model: 'gpt-4o-mini' },
  openrouter: { base: 'https://openrouter.ai/api/v1',        model: 'deepseek/deepseek-chat' },
  custom:     { base: '', model: '' }
};
var $ = function (id) { return document.getElementById(id); };
var statusTimer = null;

function flash(msg, ok) {
  var s = $('status');
  s.textContent = msg;
  s.style.color = ok === false ? '#c33' : '#3a3';
  clearTimeout(statusTimer);
  statusTimer = setTimeout(function () { s.textContent = ''; }, 3000);
}

function bindChecks(cfg) {
  ['enabled', 'fullAuto', 'autoAnswer', 'autoSubmit', 'autoNext', 'videoOnly', 'dryRun', 'usePage', 'useBank', 'useAI', 'autoLearn', 'onlyPlatforms']
    .forEach(function (k) {
      var el = $(k);
      el.checked = !!cfg[k];
      el.onchange = function () {
        var patch = {}; patch[k] = el.checked;
        // 开启全自动：同步勾选三个子开关并落库，保证后台/各帧状态一致
        if (k === 'fullAuto' && el.checked) {
          ['autoAnswer', 'autoSubmit', 'autoNext'].forEach(function (s) {
            patch[s] = true; $(s).checked = true;
          });
          patch.videoOnly = false; $('videoOnly').checked = false;
        }
        chrome.storage.local.set(patch);
        flash('已保存');
        syncVideoOnlyHint();
        syncFullAutoHint();
      };
    });
  syncVideoOnlyHint();
  syncFullAutoHint();
}
function syncVideoOnlyHint() {
  var box = $('videoOnly'), hint = $('videoOnlyHint');
  if (box && hint) hint.style.display = box.checked ? 'block' : 'none';
}
function syncFullAutoHint() {
  var box = $('fullAuto'), hint = $('fullAutoHint');
  if (box && hint) hint.style.display = box.checked ? 'block' : 'none';
}

function refreshBankCount() {
  chrome.storage.local.get('bank', function (r) {
    var n = r.bank ? Object.keys(r.bank).length : 0;
    $('bankCount').textContent = n ? '（' + n + ' 题）' : '（空）';
  });
}

document.addEventListener('DOMContentLoaded', function () {
  chrome.storage.local.get(null, function (all) {
    var cfg = Object.assign({}, DEFAULTS, all || {});
    bindChecks(cfg);
    $('aiProvider').value = cfg.aiProvider || 'deepseek';
    $('aiBase').value = cfg.aiBase || '';
    $('aiModel').value = cfg.aiModel || '';
    $('aiKey').value = cfg.aiKey || '';
    refreshBankCount();
  });

  $('aiProvider').onchange = function () {
    var p = PRESETS[this.value];
    if (p.base) $('aiBase').value = p.base;
    if (p.model) $('aiModel').value = p.model;
    saveAI();
  };
  ['aiBase', 'aiModel', 'aiKey'].forEach(function (k) {
    $(k).onchange = saveAI;
  });

  function saveAI() {
    var patch = {
      aiProvider: $('aiProvider').value,
      aiBase: $('aiBase').value.trim(),
      aiModel: $('aiModel').value.trim(),
      aiKey: $('aiKey').value.trim()
    };
    function persist() {
      chrome.storage.local.set(patch, function () { flash('AI 配置已保存'); });
    }
    // 自定义/非预置域名：按需申请后台 fetch 权限
    var base = patch.aiBase;
    if (base && /^https?:\/\//.test(base) && chrome.permissions) {
      var origin = base.split('/').slice(0, 3).join('/');
      chrome.permissions.contains({ origins: [origin + '/*'] }, function (has) {
        if (has) return persist();
        chrome.permissions.request({ origins: [origin + '/*'] }, function (granted) {
          if (!granted) flash('未授权该域名，AI 请求可能被拦截', false);
          persist();
        });
      });
    } else persist();
  }

  // ---- 题库导入导出 ----
  var mode = 'export';
  $('exportBank').onclick = function () {
    mode = 'export';
    chrome.storage.local.get('bank', function (r) {
      var blob = new Blob([JSON.stringify(r.bank || {}, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'keep-watch-bank-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      URL.revokeObjectURL(a.href);
    });
  };
  $('importBank').onclick = function () { mode = 'replace'; $('fileInput').click(); };
  $('mergeBank').onclick = function () { mode = 'merge'; $('fileInput').click(); };

  $('fileInput').onchange = function () {
    var f = this.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      var data;
      try {
        data = JSON.parse(reader.result);
        if (Array.isArray(data)) { // 兼容 [{q, answer}, ...]
          var obj = {};
          data.forEach(function (it) { if (it && it.q) obj[normQ(it.q)] = { answer: String(it.answer || '').toUpperCase(), q: it.q }; });
          data = obj;
        }
      } catch (e) { flash('JSON 解析失败', false); return; }

      chrome.storage.local.get('bank', function (r) {
        var cur = r.bank || {};
        var next = mode === 'merge' ? Object.assign({}, cur, data) : data;
        chrome.storage.local.set({ bank: next }, function () {
          refreshBankCount();
          flash(mode === 'merge' ? '已合并，共 ' + Object.keys(next).length + ' 题' : '已导入 ' + Object.keys(next).length + ' 题');
        });
      });
    };
    reader.readAsText(f);
    this.value = '';
  };
});

function normQ(s) {
  return (s || '').replace(/[\s\u00a0]*/g, '').replace(/^[0-9]+[.、．]/, '').toLowerCase().slice(0, 80);
}
