/* keep-watch background —— AI 答题请求中转（key 不进页面） */

var ZHIPU_RE = /bigmodel\.cn/;
var DASHSCOPE_RE = /dashscope\.aliyuncs\.com/;

function buildPayload(model, question, options, qtype, verify) {
  var typeHint = qtype === 'multi' ? '多选题' : qtype === 'judge' ? '判断题' : qtype === 'fill' ? '填空题' : '单选题';
  var optBlock = options.length ? '\n选项：\n' + options.join('\n') : '';
  var rule;
  if (qtype === 'fill') {
    rule = '直接给出应填入的内容本身，不要任何解释，不加引号，20字以内。';
  } else if (qtype === 'multi') {
    rule = '多选题一般有2到3个正确选项，极少出现全部正确。请根据选项内容判断，只输出确实正确的字母连写（如AC）。' +
           '题干可能含个别识别乱码，请结合通顺的选项内容和常识判断；拿不准时只选最有把握的，严禁因为读不懂就全选。无解释无标点。';
  } else {
    rule = '只输出正确选项字母（判断题 A=正确 B=错误），不要任何解释或标点。';
  }
  if (verify && qtype === 'multi') {
    rule = '复核：你上一轮把所有选项都选了，这在多选题中极少见，大概率是误判。' +
           '请结合下面每个选项的具体内容逐个排除错误项，通常应只保留2到3个最确定正确的选项。' +
           '只输出最终字母连写（如AC），不要全选，无解释。';
  }
  return {
    model: model,
    temperature: verify ? 0.0 : 0.1,
    max_tokens: qtype === 'fill' ? 60 : (qtype === 'multi' ? 12 : 8),
    messages: [
      { role: 'system', content: '你是中国大学在线课程答题助手。严格按格式作答。' },
      { role: 'user', content: '【' + typeHint + '】' + question + optBlock + '\n\n' + rule }
    ]
  };
}

// 严格解析：优先取答案“开头”的选项字母簇；开头没有则取文中第一个字母簇（容忍“答案是AC”）。
// 绝不全局收集所有字母，避免解释里的 A/B/C/D 被误当多选答案。按 A-E 升序去重。
function parseLetters(raw) {
  var s = String(raw == null ? '' : raw).trim().toUpperCase();
  var cluster = '[A-E](?:[\\s,，、.和与及]*[A-E])*';
  var re = new RegExp('^[\\s（(【:：、.，,]*(?:答案|正确选项|正确答案|选项|应为|是)?[\\s:：、]*(' + cluster + ')');
  var m = s.match(re) || s.match(new RegExp(cluster));
  if (!m) return '';
  var grp = m[1] || m[0];
  var seen = {}; var out = [];
  String(grp).replace(/[^A-E]/g, '').split('').forEach(function (c) {
    if (!seen[c]) { seen[c] = 1; out.push(c); }
  });
  return out.sort().join('');
}

async function fetchOnce(url, headers, payload) {
  var resp = await fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(payload) });
  if (!resp.ok) {
    var errText = await resp.text().catch(function () { return ''; });
    throw new Error('AI HTTP ' + resp.status + ' ' + errText.slice(0, 200));
  }
  var data = await resp.json();
  return (data.choices && data.choices[0] && data.choices[0].message.content || '').trim();
}

async function callAI(base, key, model, question, options, qtype) {
  base = (base || '').replace(/\/+$/, '');
  var url, headers;

  if (ZHIPU_RE.test(base)) {
    // 智谱 GLM：JWT 应由用户侧换好；此处兼容用户直接填的短期 JWT
    url = base + '/api/paas/v4/chat/completions';
    headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key };
  } else if (DASHSCOPE_RE.test(base)) {
    url = base + '/compatible-mode/v1/chat/completions';
    headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key };
  } else {
    // DeepSeek / OpenAI / Moonshot / OpenRouter / 火山方舟 等 OpenAI 兼容接口
    url = base + '/chat/completions';
    headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key };
  }

  var raw = await fetchOnce(url, headers, buildPayload(model, question, options, qtype, false));

  var answer;
  if (qtype === 'fill') {
    answer = raw.replace(/^["'“”\s]+|["'“”\s。.；;]+$/g, '').slice(0, 60);
    return answer;
  }
  if (/^(正确|对|√|T\b|TRUE|是|真)/.test(raw)) return 'A';
  if (/^(错误|错|×|F\b|FALSE|否|假)/.test(raw)) return 'B';

  answer = parseLetters(raw);

  // 多选防误全选：模型选满所有项时复核一次；复核仍选满才接受（确有全对题）
  if (qtype === 'multi' && options.length >= 3 && answer.length === options.length) {
    try {
      var raw2 = await fetchOnce(url, headers, buildPayload(model, question, options, qtype, true));
      var ans2 = parseLetters(raw2);
      if (ans2 && ans2.length < answer.length) answer = ans2;
    } catch (e) { /* 复核失败则保留原答案 */ }
  }
  return answer;
}

// ---- 跨 frame 连播协作（统一协议 {type:'kw', op}）----
// 超星视频 iframe 与目录 iframe 是兄弟关系，postMessage 到顶层找不到目录，故全部经 SW 中转。
//   frame -> SW : op=beat（本帧视频在播）/ op=query（是否有帧在播）/ op=finish（看完或跳过）/ op=reset（换源）
//   SW   -> 所有帧 : op=gonext（防抖后广播，去切下一节）
var finishEpoch = {};   // tabId -> {at, epoch}
var videoBeat = {};     // tabId -> 最近一次任意 frame 报告"视频正在播"的时间戳
var VIDEO_TTL = 7000;   // 心跳有效期（内容脚本约每 2-3 秒报一次）

function handleKw(msg, sender, sendResponse) {
  var tabId = sender.tab && sender.tab.id;
  var op = msg.op;

  if (op === 'beat') {                                  // 心跳：本帧视频在播
    if (tabId != null) videoBeat[tabId] = Date.now();
    sendResponse({ ok: true });
    return false;
  }
  if (op === 'query') {                                 // 查询：同 tab 是否有任意帧视频在播
    var playing = tabId != null && videoBeat[tabId] && (Date.now() - videoBeat[tabId] < VIDEO_TTL);
    sendResponse({ ok: true, playing: !!playing });
    return false;
  }
  if (op === 'reset') {                                 // 视频换源 = 新一节开始，清防抖（心跳由新视频重新建立）
    if (tabId != null) delete finishEpoch[tabId];
    sendResponse({ ok: true });
    return false;
  }
  if (op === 'finish') {                                // 某帧看完/跳过：防抖后广播 gonext
    if (tabId == null) { sendResponse({ ok: false }); return false; }
    delete videoBeat[tabId];                            // 本节已结束，立即清“在播”，避免残留心跳挡住切节
    var now = Date.now();
    var rec = finishEpoch[tabId];
    if (rec && now - rec.at < 10000) { sendResponse({ ok: false, throttled: true }); return false; }
    var epoch = now + ':' + Math.random().toString(36).slice(2, 7);
    finishEpoch[tabId] = { at: now, epoch: epoch };
    chrome.tabs.sendMessage(tabId,
      { type: 'kw', op: 'gonext', epoch: epoch, source: String(msg.source || '?') },
      function () { void chrome.runtime.lastError; });  // 无接收方等情况忽略
    sendResponse({ ok: true, epoch: epoch });
    return false;
  }
  sendResponse({ ok: false, error: 'unknown-op' });
  return false;
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg && msg.type === 'aiAsk') {
    callAI(msg.base, msg.key, msg.model, msg.question, msg.options || [], msg.qtype)
      .then(function (answer) { sendResponse({ ok: true, answer: answer }); })
      .catch(function (e) { sendResponse({ ok: false, answer: '', error: String(e.message || e) }); });
    return true; // async
  }
  if (msg && msg.type === 'kw') return handleKw(msg, sender, sendResponse);
});

chrome.runtime.onInstalled.addListener(function () {
  chrome.storage.local.get(null, function (all) {
    if (!all.aiBase) chrome.storage.local.set({ aiBase: 'https://api.deepseek.com' });
  });
});
