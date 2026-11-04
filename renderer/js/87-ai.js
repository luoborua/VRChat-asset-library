/* ============ 87-ai.js ============ */
/* =====================================================================
 * 87-ai.js  —  DeepSeek AI 翻译（标签 / 简介 / 标题汉化）
 *   · 用户批复范围：可选配置 API Key（本机 AES-GCM 加密，永不随备份导出）
 *   · 仅在用户点击「AI 翻译」时发起请求；全部由程序后端直连 DeepSeek，
 *     不经过任何代理；后端离线时 AI 翻译暂不可用，页面其他功能不受影响
 *   · 结果写入本地缓存，避免重复调用
 * ===================================================================== */

var AI = (function () {

  var CACHE_STORE = 'aiCache';
  var FENCE = ['\u0060', '\u0060', '\u0060'];

  /* ---------------- 配置读取 ---------------- */
  function config() {
    var a = App.settings.ai || {};
    return {
      model: a.model || 'deepseek-flash',
      apiBase: a.apiBase || 'https://api.deepseek.com'
    };
  }

  /** 官方已改名的旧模型（api-docs：模型名请使用 deepseek-flash） */
  var RETIRED_MODELS = { 'deepseek-v4-flash': 'deepseek-flash' };

  function normalizeConfig() {
    var a = App.settings.ai = App.settings.ai || {};
    if (!a.model) a.model = 'deepseek-flash';
    if (RETIRED_MODELS[a.model]) a.model = RETIRED_MODELS[a.model];
    if (!a.apiBase) a.apiBase = 'https://api.deepseek.com';
    // v2.3.27 修复：历史明文 Key 做一次性真加密。
    // 旧写法 a.apiKeyEnc = 'enc:' + a.apiKey 只是加前缀，Secure.decrypt 会按 AES 去解 → 失败 → catch 返回 ''，
    // 于是启动时（90-main.js 会调用本函数）历史 Key 被无声清空。
    var step = Promise.resolve();
    if (a.apiKey) {
      var plain = String(a.apiKey);
      delete a.apiKey;
      step = Secure.encrypt(plain).then(function (enc) { a.apiKeyEnc = enc; })
        .catch(function () { a.apiKeyEnc = ''; });
    }
    return step.then(function () { return App.saveSettings(); });
  }

  function setApiKey(plain) {
    return Secure.encrypt(plain).then(function (enc) {
      App.settings.ai = App.settings.ai || {};
      App.settings.ai.apiKeyEnc = enc;
      delete App.settings.ai.apiKey;
      return App.saveSettings();
    });
  }
  function clearApiKey() {
    App.settings.ai = App.settings.ai || {};
    delete App.settings.ai.apiKey; delete App.settings.ai.apiKeyEnc;
    return App.saveSettings();
  }
  function getApiKey() {
    var a = App.settings.ai || {};
    var payload = a.apiKeyEnc || a.apiKey || '';
    if (String(payload).slice(0, 4) === 'enc:') return Secure.decrypt(payload);
    return Promise.resolve(deobfuscate(payload));
  }

  /* ---------------- 请求超时（v2.5.15：可在设置里配；秒/毫秒自动归一化） ----------------
   * 思路借鉴 kiss-translator（fishjar/kiss-translator）的 httpTimeout：老配置可能是毫秒（>600），
   * 新配置按秒记；两端都做限幅，避免用户填 0 或 999999 把界面拖死。 */
  var DEFAULT_TIMEOUT_SEC = 120;
  function httpTimeoutMs() {
    var v = Number((App.settings.ai || {}).httpTimeout);
    if (!v || !isFinite(v) || v <= 0) v = DEFAULT_TIMEOUT_SEC;
    var ms = v > 600 ? v : v * 1000;
    return Math.min(600000, Math.max(10000, Math.round(ms)));
  }
  /** 术语表：把个人词典里「原文 ≠ 译文」的条目做成「原文 = 译文」行，注入 system prompt
   *  （kiss-translator 的「自定义 AI 术语词典」思路）—— 保证同一术语每次译法一致。 */
  function glossaryLines(max) {
    var dict = App.settings.userTagDict || {};
    var keys = Object.keys(dict);
    var out = [], limit = max || 60;
    for (var i = 0; i < keys.length && out.length < limit; i++) {
      var k = keys[i], v = dict[k];
      if (!k || !v || v === k) continue;
      var line = k + ' = ' + v;
      if (line.length > 80) continue;          // 太长的条目不进提示词，避免挤掉正文
      out.push(line);
    }
    return out;
  }
  function glossaryBlock(max) {
    var lines = glossaryLines(max);
    if (!lines.length) return '';
    return '术语表（下列术语必须采用给定译法，不要另译）：\n' + lines.join('\n') + '\n';
  }
  /** 解析上游 SSE（DeepSeek stream:true）文本 → { content, usage, error } */
  function parseStreamText(raw) {
    var content = '', usage = null, error = '';
    String(raw || '').split(/\r?\n/).forEach(function (line) {
      var t = line.trim();
      if (t.indexOf('data:') !== 0) return;
      var payload = t.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      var j = null;
      try { j = JSON.parse(payload); } catch (e) { return; }
      if (j && j.error) { error = (j.error && (j.error.message || j.error)) || 'AI 接口错误'; return; }
      var ch = j && j.choices && j.choices[0];
      if (ch && ch.delta && typeof ch.delta.content === 'string') content += ch.delta.content;
      else if (ch && ch.message && typeof ch.message.content === 'string') content += ch.message.content;
      if (j && j.usage) usage = j.usage;
    });
    return { content: content, usage: usage, error: error };
  }

  /* ---------------- 基础调用（全部由程序后端负责，不再使用本地代理） ---------------- */
  function chatCompletion(messages, opts) {
    opts = opts || {};
    var cfg = config();
    var body = {
      model: cfg.model,
      messages: messages,
      temperature: opts.temperature == null ? 0.2 : opts.temperature,
      stream: false
    };
    if (opts.json) body.response_format = { type: 'json_object' };

    // 程序后端唯一通道：Rust 侧直连 DeepSeek，绕过 CORS，不经过任何代理
    var keyP = opts.key ? Promise.resolve(opts.key) : getApiKey();
    return keyP.then(function (key) {
      return FS.hostEnsure().then(function (hok) {
        if (!hok) throw new Error('程序后端未就绪：AI 翻译需要后端。请重启程序后重试（手动粘贴等离线功能不受影响）。');
        var url = cfg.apiBase + '/chat/completions';
        var hdrs = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (key || '') };
        var tmo = httpTimeoutMs();
        var onDelta = (typeof opts.onDelta === 'function') ? opts.onDelta : null;
        /** 整份请求（老后端 / 流式不可用时的回退） */
        function viaFetch() {
          return FS.host.fetchURL(url, hdrs, 'POST', JSON.stringify(body), tmo).then(function (j) {
            if (!j || !j.okFlag) throw new Error('DeepSeek HTTP ' + ((j && j.status) || 0));
            var data = safeJSON(String((j && j.text) || ''), null);
            if (!data || data.error) throw new Error('AI 接口错误：' + (data && data.error && (data.error.message || data.error)));
            return data;
          });
        }
        /** v2.5.15：流式（后端 2.3.18 的 /api/stream）——长回答边到边用，后端侧是**空闲超时**，
         *  不会因为"整份响应太慢"被掐断；页面侧还能实时显示进度。 */
        function viaStream() {
          var acc = '';
          return FS.host.streamFetch(url, hdrs, 'POST',
            JSON.stringify(Object.assign({}, body, { stream: true })),
            { timeoutMs: tmo, onChunk: function (t) { acc += t; if (onDelta) { try { onDelta(t, acc); } catch (e) {} } } }
          ).then(function (r) {
            if (!r.ok) throw new Error('DeepSeek HTTP ' + (r.status || 0));
            var parsed = parseStreamText(r.text);
            if (parsed.error) throw new Error('AI 接口错误：' + parsed.error);
            if (!parsed.content) {
              // 有些兼容端点会忽略 stream:true 直接回整份 JSON —— 那就按整份解析
              var whole = safeJSON(String(r.text || ''), null);
              if (whole && whole.choices) return whole;
              throw new Error('AI 流式返回为空');
            }
            return { choices: [{ message: { role: 'assistant', content: parsed.content } }], usage: parsed.usage || null, streamed: true };
          });
        }
        return viaStream().catch(function (e) {
          var msg = String((e && e.message) || e);
          /* 旧后端没有 /api/stream（404 → 「后端流式接口不可用」）→ 退回整份请求，功能不受影响 */
          if (/后端流式接口不可用|程序后端未启动/.test(msg)) return viaFetch();
          if (!/aborted|超时|timeout/i.test(msg)) throw e;
          return viaFetch().catch(function () {
            throw new Error('AI 请求超时或被中断（' + msg + '）。可稍后重试；若经常出现：把「设置 → AI 翻译 → 请求超时（秒）」调大，或把每次翻译条数调小。');
          });
        });
      });
    });
  }

  function extractJSONText(content) {
    if (!content) return '';
    var s = String(content).trim();
    var m = s.match(/^\u0060\u0060\u0060json\s*/i);
    if (m) s = s.slice(m[0].length).replace(/\u0060\u0060\u0060\s*$/, '');
    return s;
  }

  /* ---------------- 缓存 ---------------- */
  function cacheMap() { return Store.kvGet(CACHE_STORE, {}); }
  /* v2.5.3：翻译缓存加上限——原来只增不减，批量翻译会让这张表无限膨胀（每次落盘还要整表写回）。
   * 字符串键保留插入顺序，超限时丢最早写入的条目。 */
  var CACHE_MAX = 2000;
  /** v4.3.2：长文本的缓存键。djb2 —— 够快，且不同简介撞键的概率可以忽略。 */
  function textHash(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }
  function trimCache(map) {
    var keys = Object.keys(map).filter(function (k) { return k !== '__at'; });
    if (keys.length <= CACHE_MAX) return map;
    keys.slice(0, keys.length - CACHE_MAX).forEach(function (k) { delete map[k]; });
    return map;
  }
  function cacheSet(key, value) {
    return Store.kvGet(CACHE_STORE, {}).then(function (map) {
      map[key] = value; map['__at'] = Date.now();
      return Store.kvSet(CACHE_STORE, trimCache(map));
    });
  }
  function cacheClear() { return Store.kvDel(CACHE_STORE); }
  function cacheCount() {
    return Store.kvGet(CACHE_STORE, {}).then(function (m) {
      return Object.keys(m).filter(function (k) { return k !== '__at'; }).length;
    });
  }

  /* ---------------- 翻译接口 ---------------- */
  function translateItems(items, onLog) {
    onLog = onLog || function () {};
    var list = uniq(items.map(function (s) { return String(s).trim(); }).filter(Boolean));
    if (!list.length) return Promise.resolve({ results: {}, untranslated: [], usage: null });

    return getApiKey().then(function (key) {
      if (!key) {
        var e = new Error('未配置 DeepSeek API Key。请到「设置 → AI 翻译」填写（Key 仅本机加密保存）。');
        e.code = 'NO_KEY';
        throw e;
      }
      return Store.kvGet(CACHE_STORE, {}).then(function (map) {
        var pending = [], results = {};
        list.forEach(function (s) {
          if (map['t:' + s] !== undefined) results[s] = map['t:' + s];
          else pending.push(s);
        });
        if (!pending.length) {
          onLog('\u2714 全部命中本地缓存，未调用接口（' + list.length + ' 条）');
          return { results: results, untranslated: [], usage: null };
        }
        onLog('共 ' + list.length + ' 条：缓存命中 ' + (list.length - pending.length) + ' 条，待翻译 ' + pending.length + ' 条');

        var CHUNK = 30;
        function chunk() {
          var part = pending.splice(0, CHUNK);
          if (!part.length) return Promise.resolve();
          return translateChunk(part, key, onLog).then(function (r) {
            r.results.forEach(function (pair) {
              if (pair && pair.zh) { results[pair.src] = pair.zh; map['t:' + pair.src] = pair.zh; }
            });
            onLog('\u2714 本批完成 ' + part.length + ' 条（累计 ' + Object.keys(results).length + '）');
            return Store.kvSet(CACHE_STORE, trimCache(map)).then(function () { return chunk(); });
          });
        }
        return chunk().then(function () {
          var untranslated = list.filter(function (s) { return !results[s]; });
          return { results: results, untranslated: untranslated, usage: null };
        });
      });
    });
  }

  /** 单块翻译：强制 JSON 输出 {"0": "中文", ...} */
  function translateChunk(part, key, onLog) {
    /* v2.5.15：把个人词典做成术语表注入（同一术语每次译法一致） */
    var prompt = glossaryBlock(60) +
      '你是 VRChat 改模素材标签的日英->简体中文翻译器。把下列词语/短语翻译成中文素材标签风格（服装、发型、功能组件、着色器等语境），专有名词（如 VRChat、PhysBone、lilToon、BOOTH、Quest）保留原文。\n' +
      '只输出一个 JSON 对象，键为数字序号（字符串），值为中文翻译，不要输出任何解释。\n' +
      part.map(function (s, i) { return i + ': ' + s; }).join('\n');
    var messages = [
      { role: 'system', content: '你是一个专业翻译引擎。你必须只输出合法 JSON，不要 markdown，不要解释。' },
      { role: 'user', content: prompt }
    ];
    var gN = glossaryLines(60).length;
    onLog('\u23F3 调用 DeepSeek（' + config().model + '，' + part.length + ' 条' + (gN ? '，术语表 ' + gN + ' 条' : '') + '）…');
    var lastTick = 0;
    return chatCompletion(messages, {
      json: true, key: key,
      // v2.5.15：流式进度（后端 2.3.18 起）——长回答不再"静默等"，也便于判断是不是卡住
      onDelta: function (t, acc) {
        var now = Date.now();
        if (now - lastTick > 1500) { lastTick = now; onLog('\u23F3 接收中 ' + acc.length + ' 字符 …'); }
      }
    }).then(function (data) {
      var content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      var obj = safeJSON(extractJSONText(content), null);
      if (!obj) {
        onLog('\u26A0 接口未按 JSON 返回，尝试文本解析');
        obj = {};
        String(content || '').split(/\r?\n/).forEach(function (line) {
          var m = line.match(/^(\d+)[\s:：\-]+(.+)$/);
          if (m) obj[m[1]] = m[2].trim();
        });
      }
      return {
        results: part.map(function (s, i) {
          var zh = obj[i] !== undefined ? String(obj[i]).trim() : (obj[String(i)] !== undefined ? String(obj[String(i)]).trim() : '');
          if (zh && zh.length > 0 && zh.length <= 30 && zh !== s) return { src: s, zh: zh };
          return { src: s, zh: '' };
        })
      };
    }).catch(function (e) {
      onLog('\u2716 ' + e.message + (e.message.indexOf('Failed to fetch') >= 0 || e.message.indexOf('NetworkError') >= 0 ? '（请确认程序正常运行：程序后端随窗口启动）' : ''));
      throw e;
    });
  }

  /** 翻译一段长文本（简介 / 描述），返回中文或 null */
  function translateText(text, onLog) {
    text = String(text || '').trim();
    if (!text) return Promise.resolve('');
    return getApiKey().then(function (key) {
      if (!key) { var e = new Error('未配置 DeepSeek API Key'); e.code = 'NO_KEY'; throw e; }
      return Store.kvGet(CACHE_STORE, {}).then(function (map) {
        /* v4.3.2：缓存键以前只用前 60 个字。BOOTH 店铺模板的开头常常一模一样
         * （「ご購入ありがとうございます。本商品は…」），于是两个不同商品会共用同一份译文，
         * 用户还会看到「命中缓存」，把错的译文存进简介。改成「长度 + 全文哈希」。 */
        var ck = 'txt:' + text.length + ':' + textHash(text);
        if (map[ck] !== undefined) { onLog('\u2714 命中简介翻译缓存'); return map[ck]; }
        onLog('\u23F3 正在翻译简介（' + Math.min(text.length, 2000) + ' 字符）…');
        return chatCompletion([
          { role: 'system', content: glossaryBlock(40) + '你是 VRChat 改模素材的中日英->简体中文翻译助手。保留专有名词（VRChat / PhysBone / lilToon / BOOTH / 模型名等），把整段商品简介翻译成自然的中文，直接输出译文，不要解释。' },
          { role: 'user', content: text.slice(0, 2000) }
        ], { key: key }).then(function (data) {
          var out = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
          out = String(out).replace(/^\s*(json|\u0060\u0060\u0060json|\u0060\u0060\u0060)\s*/i, '').replace(/\u0060\u0060\u0060\s*$/, '').trim();
          map[ck] = out;
          /* 以前这里直接 kvSet，绕过了 CACHE_MAX —— 简介条目可以无限长（v2.5.3 的上限只管标签）。 */
          return Store.kvSet(CACHE_STORE, trimCache(map)).then(function () { return out; });
        });
      });
    });
  }

  /** 把标签翻译结果并入个人词典 */
  function mergeTagResults(results) {
    var dict = App.settings.userTagDict || {};
    var added = 0;
    Object.keys(results).forEach(function (src) {
      var zh = results[src];
      if (!zh) return;
      if (!dict[src] || dict[src] === src) { dict[src] = zh; added++; }
    });
    App.settings.userTagDict = dict;
    return App.saveSettings().then(function () { return added; });
  }

  /** 待翻译标签统计 */
  function pendingTags() {
    var pending = {};
    App.assets.forEach(function (a) {
      (a.rawTags || []).concat(a.tags || []).forEach(function (t) {
        if (Smart.isUntranslated(t)) pending[t] = (pending[t] || 0) + 1;
      });
    });
    (App.settings.noTranslateTags || []).forEach(function (t) { delete pending[t]; });
    return Object.keys(pending).sort(function (a, b) { return pending[b] - pending[a]; });
  }

  /**
   * AI 建议合并冗余标签：
   * 输入一组当前标签，返回 [{canonical, members:[...]}]。
   * 结果只做建议，最终由用户在设置页勾选审批后应用。
   */
  function suggestConsolidations(tags, onLog) {
    onLog = onLog || function () {};
    var list = uniq((tags || []).map(function (s) { return String(s).trim(); }).filter(Boolean));
    if (list.length < 2) return Promise.resolve([]);
    return getApiKey().then(function (key) {
      if (!key) { var e = new Error('未配置 DeepSeek API Key。请到「设置 → AI 翻译」填写。'); e.code = 'NO_KEY'; throw e; }
      onLog('\u23F3 调用 DeepSeek 分析 ' + list.length + ' 个标签的同义/冗余关系 …');
      var prompt = '你是 VRChat 改模素材标签整理专家。下面是一组素材标签。' +
        '请找出表达同一含义、可以合并的标签（同义词、大小写/空格差异、多语言同义、分类重叠、无意义后缀等）。' +
        '每个标签最多归入一组；没有把握的不要合并。只输出 JSON：{"groups":[{"canonical":"规范标签","members":["变体1","变体2"]}]}' +
        'canonical 必须从输入的标签中选择或使用简洁中文；members 必须全部来自输入标签。\n' +
        list.map(function (s, i) { return i + ': ' + s; }).join('\n');
      return chatCompletion([
        { role: 'system', content: '你只输出合法 JSON，不要 markdown，不要解释。' },
        { role: 'user', content: prompt }
      ], { json: true, key: key }).then(function (data) {
        var content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        var obj = safeJSON(extractJSONText(content), null);
        var groups = (obj && Array.isArray(obj.groups) && obj.groups) || [];
        var have = Object.create(null), out = [];
        groups.forEach(function (g) {
          var canonical = String(g && g.canonical || '').trim();
          var members = uniq((g && g.members || []).map(String).filter(function (m) {
            return m && list.indexOf(m) >= 0 && m !== canonical && !have[m];
          }));
          if (!canonical || members.length < 2) return;
          members.forEach(function (m) { have[m] = 1; });
          if (!have['c:' + canonical]) { have['c:' + canonical] = 1; out.push({ canonical: canonical, members: members }); }
        });
        onLog('\u2714 AI 提出 ' + out.length + ' 组合并建议，请审阅勾选');
        return out;
      });
    });
  }

  /* ------------------------------------------------------------------
   * 模糊搜索词表（v2.2.12）
   * 把标签词典 + 支持角色（三语名/别名）+ 分类名 + 来源名交给 DeepSeek，
   * 生成 { 原词: [近义词, 俗称, 常见错拼…] } 写入 settings.fuzzyDict。
   * 只在你点按钮时调用，搜索过程本身不联网。
   * ------------------------------------------------------------------ */
  function fuzzySourceTerms() {
    var seen = Object.create(null), out = [];
    function push(x) {
      var s = String(x == null ? '' : x).trim();
      if (!s || s.length < 2 || s.length > 24) return;
      if (seen[s.toLowerCase()]) return;
      seen[s.toLowerCase()] = 1; out.push(s);
    }
    Object.keys(TAG_DICT || {}).forEach(function (k) { push(k); push(TAG_DICT[k]); });
    (App.allAvatars() || []).forEach(function (av) {
      push(av.label); push(av.nameZh); push(av.nameJa); push(av.nameEn);
      (av.alias || []).forEach(push);
    });
    (App.allCategories() || []).forEach(function (c) { push(c.label); });
    (App.allSources() || []).forEach(function (s) { push(s.label); });
    return out;
  }

  function generateFuzzyDict(onLog) {
    onLog = onLog || function () {};
    var terms = fuzzySourceTerms();
    if (!terms.length) return Promise.reject(new Error('没有可用的词典词条'));
    var CHUNK = 120, MAXCHUNK = 8, chunks = [];
    for (var i = 0; i < terms.length && chunks.length < MAXCHUNK; i += CHUNK) chunks.push(terms.slice(i, i + CHUNK));
    if (terms.length > CHUNK * MAXCHUNK) onLog('\u26A0 词条较多，本次只处理前 ' + (CHUNK * MAXCHUNK) + ' 条');
    return getApiKey().then(function (key) {
      if (!key) throw new Error('尚未保存 API Key');
      var merged = {};
      var chain = Promise.resolve();
      chunks.forEach(function (part, ci) {
        chain = chain.then(function () {
          var prompt = '你是 VRChat 改模素材库的搜索优化助手。下面是素材库里的标签、角色名、分类名、来源名。\n' +
            '请为其中**确有需要**的词生成搜索扩展词，让用户用别的说法也能搜到同一素材。\n' +
            '每个词给 1~4 个扩展，包含：常见近义词 / 俗称、中英日之间的对应写法（原词是中文时尤其需要日文/英文写法）、以及常见的错别字或漏字母拼写。\n' +
            '不需要扩展的词直接省略，不要硬凑。键必须与给定列表中的原词完全一致。\n' +
            '只输出一个 JSON 对象，不要输出任何解释。\n\n' + part.join('\n');
          onLog('\u23F3 调用 DeepSeek（' + config().model + '，第 ' + (ci + 1) + '/' + chunks.length + ' 批，' + part.length + ' 词）…');
          return chatCompletion([
            { role: 'system', content: '你只输出合法 JSON，不要 markdown，不要解释。' },
            { role: 'user', content: prompt }
          ], { json: true, key: key }).then(function (data) {
            var content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
            var obj = safeJSON(extractJSONText(content), null);
            if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { onLog('\u26A0 第 ' + (ci + 1) + ' 批未按 JSON 返回，已跳过'); return; }
            var n = 0;
            Object.keys(obj).forEach(function (k) {
              var v = obj[k];
              if (!Array.isArray(v)) return;
              var list = v.map(function (x) { return String(x == null ? '' : x).trim(); })
                .filter(function (x) { return x && x.length <= 24 && x.toLowerCase() !== String(k).toLowerCase(); });
              if (!list.length) return;
              merged[k] = uniq((merged[k] || []).concat(list));
              n++;
            });
            onLog('\u2714 第 ' + (ci + 1) + ' 批：' + n + ' 个词条');
          }).catch(function (e) { onLog('\u2716 第 ' + (ci + 1) + ' 批失败：' + (e && e.message)); });
        });
      });
      return chain.then(function () {
        var keys = Object.keys(merged);
        if (!keys.length) throw new Error('接口没有返回可用词条');
        App.settings.fuzzyDict = merged;
        App.fuzzyIndexCache = null;
        App.saveSettings();
        onLog('\u2714 词表已保存：' + keys.length + ' 个词条');
        return keys.length;
      });
    });
  }

  return {
    config: config, normalizeConfig: normalizeConfig,
    setApiKey: setApiKey, clearApiKey: clearApiKey, getApiKey: getApiKey,
    translateItems: translateItems, translateText: translateText,
    mergeTagResults: mergeTagResults, pendingTags: pendingTags,
    suggestConsolidations: suggestConsolidations, generateFuzzyDict: generateFuzzyDict, fuzzySourceTerms: fuzzySourceTerms,
    cacheClear: cacheClear, cacheCount: cacheCount, chatCompletion: chatCompletion,
    glossaryLines: glossaryLines, httpTimeoutMs: httpTimeoutMs, parseStreamText: parseStreamText
  };
})();

