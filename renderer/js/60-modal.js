/* 模态框基座与通用表单控件：
 * 负责遮罩栈的开关、Esc / 背景关闭，以及确认框、输入框与 Field.* 控件。
 * 对外暴露 Modal 与 Field；控件取值依赖 App.settings、Store、FS 等全局服务。
 * 不承载具体业务表单，也不负责保存，body / footer 由调用方组装。
 */

var Modal = (function () {
  var stack = [];
  /** 已关闭但仍在等淡出动画的遮罩。开新模态前先摘掉，
   *  否则 DOM 里残留的旧遮罩会被 .modal 选择器命中。 */
  var pending = [];
  function purgePending() {
    while (pending.length) {
      var h = pending.pop();
      try { if (h && h.overlay && h.overlay.parentNode) h.overlay.parentNode.removeChild(h.overlay); } catch (e) {}
    }
  }

  /** 打开一层模态并压栈，返回的 handle 供后续关闭使用。 */
  function open(opts) {
    opts = opts || {};
    purgePending();
    var closable = opts.closable !== false;
    /* 记下打开前的焦点：关掉弹窗后要还回去，否则键盘用户被丢回页面顶部，
     * 得重新 Tab 十几下才回到刚才那颗按钮。 */
    var prevFocus = document.activeElement;
    var overlay = el('div', { class: 'modal-overlay' });
    var box = el('div', { class: 'modal modal-' + (opts.size || 'md') + (opts.cls ? ' ' + opts.cls : '') });
    var head = el('div', { class: 'modal-head' }, [
      el('h2', { class: 'modal-title', text: opts.title || '' }),
      closable ? el('button', { class: 'icon-btn', title: '关闭 (Esc)', onclick: function () { close(handle); } }, ICONS.label('\u2715')) : null
    ]);
    var body = el('div', { class: 'modal-body' });
    if (opts.body) appendChildren(body, opts.body);
    var foot = el('div', { class: 'modal-foot' });
    if (opts.footer) appendChildren(foot, opts.footer);

    box.appendChild(head); box.appendChild(body);
    if (opts.footer) box.appendChild(foot);
    overlay.appendChild(box);
    overlay.addEventListener('mousedown', function (e) {
      if (e.target === overlay && opts.closeOnBackdrop !== false && closable) close(handle);
    });
    $('#modalRoot').appendChild(overlay);
    requestAnimationFrame(function () { overlay.classList.add('in'); });

    var handle = { overlay: overlay, box: box, body: body, foot: foot, opts: opts, closable: closable, prevFocus: prevFocus };
    stack.push(handle);
    document.body.classList.add('modal-open');
    /* 有时限的弹窗（autoClose: 毫秒）：顶部挂同一条倒计时条，走完自动关闭。
     * 需要「N 秒后自己消失」的提示框都走这里，别再各写一个 setTimeout。 */
    if (opts.autoClose > 0) {
      var acMs = Number(opts.autoClose);
      box.insertBefore(el('div', { class: 'modal-prog' }, [el('i', { style: { animationDuration: acMs + 'ms' } })]), box.firstChild);
      setTimeout(function () { close(handle); }, acMs);
    }
    return handle;
  }

  /** 一个容器里当前能 Tab 到的元素（跳过隐藏与禁用） */
  var FOCUS_SEL = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]),'
    + ' select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  function focusables(root) {
    return Array.prototype.filter.call(root.querySelectorAll(FOCUS_SEL), function (n) {
      return n.getClientRects().length > 0;
    });
  }

  /* Tab 循环：焦点不能跑到遮罩后面去操作看不见的页面。
   * 监听挂在 document 的捕获阶段，因为刚打开时焦点可能还在 body 上，overlay 收不到 keydown。 */
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Tab' || !stack.length) return;
    var top = stack[stack.length - 1];
    var box = top.box;
    var act = document.activeElement;
    var f = focusables(box);
    if (!f.length) {
      /* 弹窗里没有任何可聚焦元素（纯提示）：拦下来，别让 Tab 把焦点带走 */
      if (!box.contains(act)) e.preventDefault();
      return;
    }
    var first = f[0], last = f[f.length - 1];
    if (!box.contains(act)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
    if (e.shiftKey && act === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && act === last) { e.preventDefault(); first.focus(); }
  }, true);

  /** 关闭指定层（缺省栈顶），淡出结束后再摘除节点。 */
  function close(handle) {
    handle = handle || stack[stack.length - 1];
    if (!handle) return;
    var i = stack.indexOf(handle);
    if (i >= 0) stack.splice(i, 1);
    handle.overlay.classList.remove('in');
    pending.push(handle);
    setTimeout(function () {
      if (handle.overlay.parentNode) handle.overlay.parentNode.removeChild(handle.overlay);
      var pi = pending.indexOf(handle);
      if (pi >= 0) pending.splice(pi, 1);
    }, 200);
    if (!stack.length) document.body.classList.remove('modal-open');
    /* 焦点还原要放在 onClose 之前：onClose 里可能又开一层，
     * 那样新层记下的「上一个焦点」才是原来那颗按钮，而不是被丢掉后的 body。 */
    if (handle.prevFocus && handle.prevFocus.isConnected && typeof handle.prevFocus.focus === 'function') {
      try { handle.prevFocus.focus(); } catch (e) {}
    }
    if (typeof handle.opts.onClose === 'function') handle.opts.onClose();
  }

  function closeTop() { if (stack.length) close(stack[stack.length - 1]); }

  /** Esc 关闭：不可关闭的模态不响应 */
  function closeByEsc() {
    if (!stack.length) return;
    if (stack[stack.length - 1].closable === false) return;
    closeTop();
  }

  /**
   * 先定值再关闭：close() 会同步触发 onClose，
   * 若先关闭，onClose 里的取消值会抢先兑现 Promise。
   */
  function confirm(message, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var settled = false;
      var finish = function (v) { if (settled) return; settled = true; resolve(v); };
      var okBtn = el('button', { class: 'btn btn-danger', onclick: function () { finish(true); close(h); } }, opts.okText || '确定');
      var h = open({
        title: opts.title || '请确认',
        size: 'sm',
        body: [el('p', { class: 'confirm-text', text: message })],
        footer: [
          el('button', { class: 'btn', onclick: function () { finish(false); close(h); } }, opts.cancelText || '取消'),
          okBtn
        ],
        onClose: function () { finish(false); }
      });
      // 默认动作 = 确认按钮：自动聚焦，回车/空格直接执行
      if (opts.focusOk !== false) setTimeout(function () { if (okBtn && okBtn.focus) okBtn.focus(); }, 60);
    });
  }

  /** 文本输入弹窗：回车确认，取消或 Esc 得到 null。 */
  function prompt(message, defValue, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var settled = false;
      var finish = function (v) { if (settled) return; settled = true; resolve(v); };
      var input = el('input', {
        class: 'input', value: defValue || '', placeholder: opts.placeholder || '',
        onkeydown: function (e) {
          if (e.key === 'Enter') { e.preventDefault(); finish(input.value); close(h); }
        }
      });
      var h = open({
        title: opts.title || '请输入', size: 'sm',
        body: [el('p', { class: 'confirm-text', text: message }), input,
          opts.hint ? el('div', { class: 'field-hint', text: opts.hint }) : null],
        footer: [
          el('button', { class: 'btn', onclick: function () { finish(null); close(h); } }, '取消'),
          el('button', { class: 'btn btn-primary', onclick: function () { finish(input.value); close(h); } }, '确定')
        ],
        onClose: function () { finish(null); }
      });
      setTimeout(function () { input.focus(); input.select(); }, 60);
    });
  }

  return { open: open, close: close, closeTop: closeTop, closeByEsc: closeByEsc, confirm: confirm, prompt: prompt, purgePending: purgePending, get stack() { return stack; } };
})();


/*
 * 表单控件小工具
 */
var Field = {
  row: function (label, control, hint, labelRight) {
    // labelRight：标签右侧的右对齐元素（如「AI 翻译…」按钮）
    var labelNode = labelRight
      ? el('label', { class: 'field-label field-label-split' }, [el('span', { text: label }), labelRight])
      : el('label', { class: 'field-label', text: label });
    return el('div', { class: 'field' }, [
      labelNode,
      el('div', { class: 'field-control' }, [control, hint ? el('div', { class: 'field-hint', text: hint }) : null])
    ]);
  },
  /** 多值列表编辑器（链接 / 路径） */
  multi: function (items, opts) {
    opts = opts || {};
    var wrap = el('div', { class: 'multi' });
    var listBox = el('div', { class: 'multi-list' });
    /* 变更回调：调用方要靠它跟着链接变化重算派生字段（例如素材编号取 BOOTH 商品号） */
    function fire() { if (typeof opts.onChange === 'function') { try { opts.onChange(); } catch (e) {} } }
    var data = (items || []).map(function (x) {
      return typeof x === 'string' ? { url: x, label: '' } : { url: x.url || x.path || '', label: x.label || x.note || '' };
    });

    function render() {
      listBox.innerHTML = '';
      data.forEach(function (it, i) {
        var inp = el('input', {
          class: 'input mono', value: it.url, placeholder: opts.placeholder || '',
          oninput: function () { it.url = inp.value; fire(); }
        });
        var lbl = el('input', {
          class: 'input input-sm', value: it.label, placeholder: opts.labelPlaceholder || '备注',
          oninput: function () { it.label = lbl.value; }
        });
        // 本地路径行把标识放左侧、完整路径放右侧，便于对照
        var rowKids = opts.asPath ? [lbl, inp] : [inp, lbl];
        listBox.appendChild(el('div', { class: 'multi-row' + (opts.asPath ? ' multi-row-path' : '') }, rowKids.concat([
          opts.pickDir ? el('button', {
            class: 'btn btn-sm', type: 'button', title: '选择文件夹', onclick: function () {
              FS.pickDirectoryPath().then(function (r) {
                if (!r) return;
                it.url = ''; inp.value = '';
                if (r.handle) Store.kvSet('dir_' + r.name, r.handle);
                function write(full) {
                  if (full) {
                    it.url = full; inp.value = full;
                    Toast.ok('已写入完整路径：' + full);
                  } else {
                    it.url = ''; inp.value = '';
                    inp.placeholder = '请粘贴完整路径，例如 D:\\素材库\\衣装\\戚风';   // 示例用中性路径，避免暗示特定目录
                    Toast.warn('未能获取所选文件夹的完整路径。请在资源管理器地址栏复制完整路径后粘贴到此处（不会保存空路径）。', 6800);
                  }
                }
                if (r.path) { write(r.path); return; }   // 后端能直接给出绝对路径时免去解析
                Toast.info('正在识别所选文件夹的完整路径 …', 1600);
                FS.resolveDirectoryPath(r.handle).then(write);
              });
            }
          }, ICONS.label('\u{1F4C2}')) : null,
          el('button', {
            class: 'btn btn-sm btn-danger-ghost', type: 'button', title: '删除',
            onclick: function () { data.splice(i, 1); render(); fire(); }
          }, ICONS.label('\u{1F5D1}'))
        ])));
      });
      if (!data.length) listBox.appendChild(el('div', { class: 'multi-empty', text: opts.emptyText || '尚未添加' }));
    }
    render();
    wrap.appendChild(listBox);
    var addBtn = el('button', {
      class: 'btn btn-sm btn-ghost', type: 'button',
      onclick: function () { data.push({ url: '', label: '' }); render(); fire(); }
    }, ICONS.label('\u2795 ' + (opts.addText || '添加一项')));
    if (opts.dedupe) {
      wrap.appendChild(el('div', { class: 'btn-row' }, [
        addBtn,
        el('button', {
          class: 'btn btn-sm btn-ghost', type: 'button', title: '按链接地址去除重复项（保留第一条）',
          onclick: function () {
            var before = data.length;
            data = uniqBy(data, function (x) { return String(x.url || '').trim(); });
            render();
            Toast.ok('已去除 ' + (before - data.length) + ' 条重复下载链接');
          }
        }, ICONS.label('\u{1F9F9} 去重'))
      ]));
    } else {
      wrap.appendChild(addBtn);
    }
    wrap.getValue = function () {
      var out = [], bad = [];
      data.forEach(function (d) {
        var v = String(d.url || '').trim();
        if (!v) return;
        if (opts.asPath && !isAbsoluteWinPath(v)) { bad.push(v); return; }
        out.push(opts.asPath
          ? { path: normalizeWinPath(v), note: d.label }
          : { url: v, label: d.label });
      });
      if (opts.dedupe) out = uniqBy(out, function (x) { return String(x.path || x.url || ''); });
      if (bad.length) Toast.warn('有 ' + bad.length + ' 条本地路径不是完整路径，未保存：' + bad.join('；') + '。请补全为 G:\\… 或 \\\\服务器\\… 。', 7200);
      return out;
    };
    wrap.setValue = function (arr) {
      data = (arr || []).map(function (x) { return { url: x.url || x.path || '', label: x.label || x.note || '' }; });
      render(); fire();
    };
    return wrap;
  },

  /** 标签编辑器 */
  tags: function (tags, rawTags) {
    var wrap = el('div', { class: 'tagedit' });
    var box = el('div', { class: 'tagedit-list' });
    var data = (tags || []).slice();
    var raws = (rawTags || []).slice();

    function render() {
      box.innerHTML = '';
      data.forEach(function (t, i) {
        var untrans = Smart.isUntranslated(t);
        box.appendChild(el('span', { class: 'tag tag-edit' + (untrans ? ' tag-untrans' : '') }, [
          el('span', { text: t + (untrans ? '（待翻译）' : '') }),
          el('button', {
            class: 'tag-x', type: 'button', title: '编辑该标签的显示 / 翻译（对所有显示生效）',
            onclick: function () {
              Modal.prompt('标签「' + t + '」的显示名 / 翻译：', t, { title: '编辑标签显示' }).then(function (v) {
                if (v == null) return;
                var nv = v.trim();
                if (!nv) return;
                App.settings.userTagDict[t] = nv;
                App.saveSettings().then(function () {
                  data[i] = nv; render();
                  Toast.ok('已更新：' + t + ' → ' + nv);
                });
              });
            }
          }, ICONS.label('\u{1F4DD}')),
          untrans ? el('button', {
            class: 'tag-x', type: 'button', title: '标记为无需翻译（原样保留）',
            onclick: function () {
              App.settings.noTranslateTags = uniq((App.settings.noTranslateTags || []).concat([t]));
              App.saveSettings().then(function () { render(); Toast.ok('已标记无需翻译：' + t); });
            }
          }, '\u2298') : null,
          el('button', { class: 'tag-x', type: 'button', title: '移除', onclick: function () { data.splice(i, 1); render(); } }, ICONS.label('\u{1F5D1}'))
        ]));
      });
      if (!data.length) box.appendChild(el('span', { class: 'multi-empty', text: '暂无标签' }));
    }
    render();

    var input = el('input', {
      class: 'input', placeholder: '输入标签后按回车添加（支持逗号分隔批量添加）',
      onkeydown: function (e) {
        if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault();
          var v = input.value.trim();
          if (!v) return;
          v.split(/[,\uFF0C]/).map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (s) {
            if (Smart.filterBlacklist([s]).length && data.indexOf(s) < 0) data.push(s);
            else if (!Smart.filterBlacklist([s]).length) Toast.warn('「' + s + '」在标签黑名单中，已忽略');
          });
          input.value = ''; render();
        }
      }
    });

    // AI 翻译：把当前所有未翻译标签交给 DeepSeek
    var aiBox = el('div', { class: 'tag-suggest' });
    function renderAi() {
      aiBox.innerHTML = '';
      var unt = data.filter(function (t) { return Smart.isUntranslated(t); });
      if (!unt.length) return;
      aiBox.appendChild(el('button', {
        class: 'tag tag-sug ai-btn', type: 'button', title: '通过 DeepSeek AI 翻译这些标签（需在设置中配置 Key，并由本地后端发起请求）',
        onclick: function () {
          Toast.info('AI 翻译中，请稍候 …');
          AI.translateItems(unt, function (m) { console.log('[AI]', m); }).then(function (r) {
            return AI.mergeTagResults(r.results).then(function (added) {
              // 用最新词典刷新当前标签
              var dict = App.settings.userTagDict || {};
              data = data.map(function (t) { return dict[t] || t; });
              render();
              Toast.ok('AI 翻译完成：' + added + ' 条标签已更新');
            });
          }).catch(function (e) { Toast.err(e.message || 'AI 翻译失败'); });
        }
      }, ICONS.label('\u{1F916} AI 翻译 ' + unt.length + ' 个标签')));
    }
    renderAi();

    // 常用标签建议
    var st = App.stats();
    var suggestions = Object.keys(st.tags).sort(function (a, b) { return st.tags[b] - st.tags[a]; }).slice(0, 18);
    var sugBox = el('div', { class: 'tag-suggest' }, suggestions.map(function (t) {
      return el('button', {
        class: 'tag tag-sug', type: 'button',
        onclick: function () { if (data.indexOf(t) < 0) { data.push(t); render(); } }
      }, '+ ' + t);
    }));

    wrap.appendChild(box);
    wrap.appendChild(input);
    wrap.appendChild(aiBox);
    if (suggestions.length) {
      wrap.appendChild(el('div', { class: 'field-hint', text: '常用标签（点击添加）：' }));
      wrap.appendChild(sugBox);
    }
    if (raws.length) {
      wrap.appendChild(el('div', { class: 'field-hint', text: '原始标签：' + raws.join(' / ') }));
      wrap.appendChild(el('button', {
        class: 'btn btn-sm btn-ghost', type: 'button', onclick: function () {
          data = uniq(data.concat(Smart.translateTags(raws))); render();
        }
      }, ICONS.label('\u{1F504} 重新翻译原始标签')));
    }
    wrap.getValue = function () { return uniq(data); };
    wrap.getRaw = function () { return raws; };
    wrap.setValue = function (arr, rawArr) { data = uniq(arr || []); if (rawArr) raws = uniq(rawArr || []); render(); };
    return wrap;
  },

  /** 角色多选：选中「通用/多角色」时其他角色变灰锁定；已选中的保留数据，对外只按通用处理 */
  avatars: function (selected) {
    var wrap = el('div', { class: 'avpick' });
    var data = (selected || []).slice();
    /* 默认折叠成「已选 + 常用」一屏并配检索框：角色多时一次铺开会糊成一片 */
    var q = '', expanded = false, LIMIT = 8;
    var searchIn = el('input', {
      class: 'input input-sm avpick-search', type: 'text',
      placeholder: '搜索角色（中 / 日 / 英 / 别名）…',
      oninput: function () { q = searchIn.value.trim().toLowerCase(); expanded = !!q; render(); }
    });
    /* 展开/收起做成与角色胶囊同款的胶囊并放在列表末尾，与选中状态视觉一致 */
    var moreBtn = el('button', { class: 'chip chip-pick on avpick-more', type: 'button', style: { display: 'none' } });
    var toolbar = el('div', { class: 'avpick-toolbar' }, [searchIn]);
    var box = el('div', { class: 'avpick-list' });
    function avHay(av) {
      return [av.label, av.nameZh, av.nameJa, av.nameEn].concat(av.alias || []).filter(Boolean).join(' ').toLowerCase();
    }
    function render() {
      box.innerHTML = '';
      var universalOn = data.indexOf('universal') >= 0;
      var st = App.stats().avatars || {};
      // 与左侧栏一致：通用/多角色第一，其余按匹配数量降序（数量相同的保持原顺序，自定义角色排在最后）
      var list = App.allAvatars().map(function (av, idx) {
        return { av: av, idx: idx, count: st[av.id] || 0, on: data.indexOf(av.id) >= 0 };
      }).sort(function (a, b) {
        if (a.av.id === 'universal') return -1;
        if (b.av.id === 'universal') return 1;
        if (b.count !== a.count) return b.count - a.count;
        return a.idx - b.idx;
      });
      var hit = list.filter(function (e) { return !q || avHay(e.av).indexOf(q) >= 0; });
      if (!expanded) {
        var keep = hit.filter(function (e) { return e.on || e.av.id === 'universal'; });
        var rest = hit.filter(function (e) { return !(e.on || e.av.id === 'universal'); });
        hit = keep.concat(rest.slice(0, Math.max(0, LIMIT - keep.length)));
      }
      var hiddenN = list.filter(function (e) { return !q || avHay(e.av).indexOf(q) >= 0; }).length - hit.length;
      hit.forEach(function (entry) {
        var av = entry.av;
        var on = entry.on;
        var locked = universalOn && av.id !== 'universal';
        box.appendChild(el('button', {
          class: 'chip chip-pick' + (on ? ' on' : '') + (locked ? ' locked' : ''), type: 'button',
          title: locked ? (av.label + (on ? '（已选中，通用/多角色激活时锁定）' : '（通用/多角色激活时不可再选）')) : (av.alias || []).join(' / '),
          disabled: locked,
          onclick: function () {
            if (locked) return;
            var i = data.indexOf(av.id);
            if (i >= 0) data.splice(i, 1); else data.push(av.id);
            render();
          }
        }, av.label));
      });
      box.appendChild(el('button', {
        class: 'chip chip-add', type: 'button', onclick: function () {
          Modal.prompt('输入新角色的中文名称（可在设置中管理）：', '', { title: '添加自定义角色' }).then(function (v) {
            if (!v || !v.trim()) return;
            var id = 'av_' + Date.now().toString(36);
            App.settings.customAvatars.push({ id: id, label: v.trim(), alias: [v.trim()] });
            App.saveSettings().then(function () { data.push(id); render(); Toast.ok('已添加角色：' + v.trim()); });
          });
        }
      }, ICONS.label('\u2795 自定义')));
      moreBtn.style.display = (hiddenN > 0 || expanded) ? '' : 'none';
      moreBtn.textContent = expanded ? '收起' : ('展开全部（+' + hiddenN + '）');
      moreBtn.onclick = function () { expanded = !expanded; render(); };
      box.insertBefore(moreBtn, box.lastElementChild);   // 放在「+ 自定义」之前
    }
    render();
    wrap.appendChild(toolbar);
    wrap.appendChild(box);
    wrap.getValue = function () { return uniq(data); };
    wrap.setValue = function (arr) { data = (arr || []).slice(); render(); };
    return wrap;
  },

  /** 版本 / 变体编辑器：名称 + BOOTH / Gumroad 订单链接；有订单链接 = 已购买（正常显示），无 = 未购买（灰色，不计价） */
  versions: function (list) {
    var wrap = el('div', { class: 'multi' });
    var box = el('div', { class: 'multi-list' });
    var data = (list || []).map(function (v) { return Store.normalizeVersion(v); });
    var totalHint = el('div', { class: 'field-hint' });

    function isPurchased(v) { return !!(v.orderUrl && v.orderUrl.trim()); }

    function render() {
      box.innerHTML = '';
      if (!data.length) { box.appendChild(el('div', { class: 'multi-empty', text: '尚未添加版本（名称 + BOOTH / Gumroad 订单链接）' })); totalHint.textContent = ''; return; }
      data.forEach(function (v, i) {
        var nameIn = el('input', { class: 'input input-sm', value: v.name, placeholder: '版本名 / 变体名', oninput: function () { v.name = nameIn.value; renderHint(); } });
        var orderIn = el('input', { class: 'input mono input-sm', value: v.orderUrl || '', placeholder: 'BOOTH / Gumroad 订单链接（已购买才有）', oninput: function () { v.orderUrl = orderIn.value; render(); } });
        var row = el('div', { class: 'ver-row' + (isPurchased(v) ? '' : ' unpurchased') }, [
          nameIn, orderIn,
          el('button', {
            class: 'btn btn-xs btn-danger-ghost', type: 'button', title: '删除该版本',
            onclick: function () { data.splice(i, 1); render(); }
          }, ICONS.label('\u{1F5D1}'))
        ]);
        box.appendChild(row);
      });
      renderHint();
    }
    function renderHint() {
      var purchased = data.filter(isPurchased);
      var sum = 0, cur = '';
      purchased.forEach(function (v) {
        var pd = derivePrice(v.price);
        if (pd.value != null) { sum += pd.value; cur = pd.currency || cur; }
      });
      var label = '';
      if (sum) {
        var sym = cur === 'JPY' ? '\u00A5' : (cur === 'USD' ? '$' : (cur === 'EUR' ? '\u20AC' : '\u00A5'));
        label = '，合计 ' + sym + ' ' + sum.toLocaleString('ja-JP');
      }
      totalHint.textContent = purchased.length
        ? ('已购买 ' + purchased.length + ' 个版本' + label + '；灰色 = 未购买，不计价')
        : '未检测到已购买版本（无订单链接），价格将记为 0；灰色 = 未购买，不计价';
    }
    render();
    wrap.appendChild(box);
    wrap.appendChild(totalHint);
    wrap.appendChild(el('button', {
      class: 'btn btn-sm btn-ghost', type: 'button',
      onclick: function () { data.push(Store.normalizeVersion({ name: 'v' + (data.length + 1) })); render(); }
    }, ICONS.label('\u2795 添加版本')));
    wrap.getValue = function () {
      var seen = {};
      return data.filter(function (v) { return (v.name || v.orderUrl); }).filter(function (v) {
        var key = (v.orderUrl && v.orderUrl.trim())
          ? (v.orderUrl.trim() + (v.variationId ? '#vid:' + v.variationId : ''))
          : ((v.variationId ? 'vid:' + v.variationId : '') || ('name:' + (v.name || '')));
        if (seen[key]) return false;
        seen[key] = 1;
        return true;
      });
    };
    wrap.getPurchased = function () { return data.filter(isPurchased).map(function (v) { return v.id; }); };
    wrap.setValue = function (arr) {
      data = (arr || []).map(function (v) { return Store.normalizeVersion(v); });
      render();
    };
    return wrap;
  },

  /** 评分 */
  rating: function (value) {
    var wrap = el('div', { class: 'rating' });
    var v = value || 0;
    function render() {
      wrap.innerHTML = '';
      for (var i = 1; i <= 5; i++) {
        (function (n) {
          wrap.appendChild(el('button', {
            class: 'star' + (n <= v ? ' on' : ''), type: 'button', title: n + ' 星',
            onclick: function () { v = (v === n ? 0 : n); render(); }
          }, n <= v ? ICONS.label('\u2605') : ICONS.label('\u2606')));
        })(i);
      }
      wrap.appendChild(el('span', { class: 'field-hint', text: v ? v + ' 星' : '未评分' }));
    }
    render();
    wrap.getValue = function () { return v; };
    return wrap;
  }
};

