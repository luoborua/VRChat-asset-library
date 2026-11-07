/*
 * 86c-context-menu.js  —  素材右键菜单
 *
 * 负责：CtxMenu 一个通用浮层菜单（视口内夹取定位、键盘导航、悬停二级菜单），
 *       AssetMenu 素材专属的菜单内容（编辑 / 分类 / 标签 / 角色 / 路径 / 复制 / 删除）。
 * 与谁交互：菜单动作调用 App / Modals / Packer / WB，菜单自身不读写存储。
 * 边界：不放需要走长表单的重操作 —— 那类一律交给详情页或编辑弹窗。
 */

var CtxMenu = (function () {
  var cur = null;      // { root, onDown, onKey, onBlur, levels, idx }

  function close() {
    var h = cur;
    if (!h) return;
    cur = null;
    try { document.removeEventListener('mousedown', h.onDown, true); } catch (e) {}
    try { document.removeEventListener('keydown', h.onKey, true); } catch (e) {}
    try { window.removeEventListener('blur', h.onBlur); } catch (e) {}
    try { window.removeEventListener('resize', h.onBlur); } catch (e) {}
    try { document.removeEventListener('scroll', h.onScroll, true); } catch (e) {}
    try { var fe = h.flyoutEl; if (fe && fe.parentNode) fe.parentNode.removeChild(fe); } catch (e) {}
    if (h.root && h.root.parentNode) h.root.parentNode.removeChild(h.root);
  }

  function isOpen() { return !!cur; }

  /** 一项菜单：{label, icon, hint, danger, disabled, checked, sub, action} / {sep:true} / {head, sub} */
  function itemNode(it, onSub) {
    if (it.sep) return el('div', { class: 'ctx-sep' });
    if (it.head != null) {
      return el('div', { class: 'ctx-head' }, [
        el('div', { class: 'ctx-head-title', title: it.head, text: it.head }),
        it.sub ? el('div', { class: 'ctx-head-sub', title: it.sub, text: it.sub }) : null
      ]);
    }
    var btn = el('button', {
      class: 'ctx-item' + (it.danger ? ' ctx-danger' : ''),
      type: 'button', role: 'menuitem',
      title: it.hint || it.label,
      onclick: function () {
        if (it.disabled) return;
        if (it.sub) { if (typeof onSub === 'function') onSub(it.sub, it.label, btn); return; }
        close();
        try {
          if (it.action) it.action();
        } catch (e) {
          console.error('[ctx] 菜单动作失败', e);
          Toast.err('操作失败：' + ((e && e.message) || e));
        }
      }
    }, [
      it.checked ? el('span', { class: 'ctx-check', text: '\u2713' }) : null,
      it.icon ? el('span', { class: 'ctx-ico' }, [ICONS.make(it.icon, { size: 15 })]) : el('span', { class: 'ctx-ico' }),
      el('span', { class: 'ctx-label', text: it.label }),
      it.sub ? el('span', { class: 'ctx-arrow', text: '\u203A' })
        : (it.hint ? el('span', { class: 'ctx-hint', text: it.hint }) : null)
    ]);
    if (it.disabled) btn.disabled = true;
    return btn;
  }

  /**
   * open(x, y, items) —— x/y 用 clientX/clientY（菜单是 position:fixed）。
   * 二级菜单悬停 90ms 后浮出，右边放不下翻到左侧；键盘 → 打开、← 返回、Esc 逐层关。
   */
  function open(x, y, items) {
    close();
    var root = el('div', { class: 'ctx-menu', role: 'menu' });
    var flyout = null;          // { root, owner }
    var openTimer = null;
    var closeTimer = null;

    function clearTimers() {
      if (openTimer) { clearTimeout(openTimer); openTimer = null; }
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    }

    function placeRoot() {
      var pad = 8;
      var w = root.offsetWidth, hgt = root.offsetHeight;
      var vw = window.innerWidth, vh = window.innerHeight;
      root.style.left = Math.max(pad, Math.min(x, vw - w - pad)) + 'px';
      root.style.top = Math.max(pad, Math.min(y, vh - hgt - pad)) + 'px';
    }

    function removeFlyout() {
      if (!flyout) return;
      if (flyout.owner) flyout.owner.classList.remove('ctx-open');
      if (flyout.root && flyout.root.parentNode) flyout.root.parentNode.removeChild(flyout.root);
      flyout = null;
    }
    function closeFlyout() { clearTimers(); removeFlyout(); }
    function scheduleFlyoutClose() {
      clearTimers();
      closeTimer = setTimeout(removeFlyout, 180);
    }

    function openFlyout(owner, sub, focusIt) {
      if (!owner || !sub || !sub.length) return;
      clearTimers();
      if (flyout && flyout.owner === owner) return;
      removeFlyout();

      var f = el('div', { class: 'ctx-menu ctx-flyout', role: 'menu' });
      sub.forEach(function (it) { if (it) f.appendChild(itemNode(it, null)); });
      f.addEventListener('mouseenter', clearTimers);
      f.addEventListener('mouseleave', scheduleFlyoutClose);
      document.body.appendChild(f);

      var r = owner.getBoundingClientRect();
      var w = f.offsetWidth, hgt = f.offsetHeight;
      var pad = 8, vw = window.innerWidth, vh = window.innerHeight;
      var left = r.right + 4;
      if (left + w > vw - pad) left = r.left - w - 4;          // 右边放不下 → 翻到左边
      left = Math.max(pad, Math.min(left, vw - w - pad));
      var top = Math.max(pad, Math.min(r.top - 6, vh - hgt - pad));
      f.style.left = left + 'px';
      f.style.top = top + 'px';

      flyout = { root: f, owner: owner };
      owner.classList.add('ctx-open');

      if (focusIt) {
        var firstBtn = f.querySelector('button.ctx-item:not([disabled])');
        if (firstBtn) { try { firstBtn.focus({ preventScroll: true }); } catch (e) { firstBtn.focus(); } }
      }
    }

    /** 鼠标悬停：带二级的项 90ms 后浮出；普通项不打断已经开着的浮层（防斜穿闪断） */
    function bindHover(node, it) {
      node.__sub = it.sub || null;
      node.addEventListener('mouseenter', function () {
        clearTimers();
        if (!it.sub) return;
        openTimer = setTimeout(function () { openFlyout(node, it.sub, false); }, 90);
      });
    }

    function scopeItems() {
      var scope = (flyout && flyout.root.contains(document.activeElement)) ? flyout.root : root;
      return Array.prototype.slice.call(scope.querySelectorAll('button.ctx-item:not([disabled])'));
    }
    function focusFirstIn(scope) {
      var list = Array.prototype.slice.call(scope.querySelectorAll('button.ctx-item:not([disabled])'));
      if (list.length) { try { list[0].focus({ preventScroll: true }); } catch (e) { list[0].focus(); } }
    }

    function render() {
      root.innerHTML = '';
      removeFlyout();
      (items || []).forEach(function (it) {
        if (!it) return;
        var node = itemNode(it, function (sub, label, owner) {
          if (owner) openFlyout(owner, sub, true);
        });
        if (node.tagName === 'BUTTON') bindHover(node, it);
        root.appendChild(node);
      });
      placeRoot();
    }

    root.addEventListener('mouseleave', function (e) {
      if (!flyout) return;
      if (e.relatedTarget && flyout.root.contains(e.relatedTarget)) return;
      scheduleFlyoutClose();
    });

    function onDown(e) {
      if (root.contains(e.target)) return;
      if (flyout && flyout.root.contains(e.target)) return;
      close();
    }
    function onScroll(e) {
      if (root.contains(e.target)) return;
      if (flyout && flyout.root.contains(e.target)) return;
      close();
    }
    function onKey(e) {
      if (!cur) return;
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        if (flyout) closeFlyout(); else close();
        return;
      }
      if (e.key === 'ArrowRight') {
        var a = document.activeElement;
        if (a && a.__sub) { e.preventDefault(); openFlyout(a, a.__sub, true); }
        return;
      }
      if (e.key === 'ArrowLeft') {
        if (flyout) {
          e.preventDefault();
          var owner = flyout.owner;
          closeFlyout();
          if (owner && owner.focus) owner.focus({ preventScroll: true });
        }
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        var list = scopeItems();
        if (!list.length) return;
        var i = list.indexOf(document.activeElement);
        var next = e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
        if (i < 0) next = e.key === 'ArrowDown' ? 0 : list.length - 1;
        list[next].focus({ preventScroll: true });
        return;
      }
      if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        var ls = scopeItems();
        if (!ls.length) return;
        (e.key === 'Home' ? ls[0] : ls[ls.length - 1]).focus({ preventScroll: true });
      }
    }
    function onBlur() { close(); }

    var handle = {
      root: root, onDown: onDown, onKey: onKey, onBlur: onBlur, onScroll: onScroll,
      closeFlyout: closeFlyout,
      get flyoutEl() { return flyout ? flyout.root : null; }
    };
    cur = handle;

    // 先挂到 DOM 再量尺寸，位置才准
    document.body.appendChild(root);
    root.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    render();
    focusFirstIn(root);

    // 延迟一拍再挂全局监听：否则触发本次菜单的那次 mousedown / contextmenu 会立刻把它关掉
    setTimeout(function () {
      if (cur !== handle) return;
      document.addEventListener('mousedown', onDown, true);
      document.addEventListener('keydown', onKey, true);
      document.addEventListener('scroll', onScroll, true);
      window.addEventListener('blur', onBlur);
      window.addEventListener('resize', onBlur);
    }, 0);
    return handle;
  }

  return { open: open, close: close, isOpen: isOpen };
})();


/*
 * AssetMenu —— 素材右键菜单的内容
 */
var AssetMenu = (function () {

  /** 卡片里的 `a` 是渲染那一刻的快照，写回前必须拿库里最新的一条 */
  function liveOf(a) {
    return (App.assets || []).find(function (x) { return x.id === a.id; }) || a;
  }

  function commit(a, mutate, okText) {
    var live = liveOf(a);
    mutate(live);
    live.updatedAt = nowISO();
    return App.save(live).then(function () {
      /* 只改一条的操作只重画那一张卡：整页重建会让所有卡片重播入场动画。
       * 卡片被筛掉或翻到别的页时，refreshCard 会退回整体重绘。 */
      UI.refreshCard(live.id) || UI.renderAll();   // 找不到那张卡（异常情形）就退回整体重绘
      UI.renderSidebar();          // 侧栏里「喜欢 / 标签 / 分类」的计数要跟着变
      if (okText) Toast.ok(okText, 3200);
    }).catch(function (e) {
      Toast.err('保存失败：' + ((e && e.message) || e), 6000);
    });
  }

  function copyValue(text, okText) {
    if (!text) return;
    copyText(String(text)).then(function () { Toast.ok(okText || '已复制', 2600); })
      .catch(function () { Toast.err('复制失败'); });
  }

  /* 改名统一交给 App.renameAssetTo：查重 → 改磁盘目录 → 更新存储路径 → 落库 → 刷新。 */
  function rename(a) {
    var live = liveOf(a);
    Modal.prompt('新的标题（留空 / 取消 = 不改）', live.title || '', {
      title: '重命名素材',
      hint: '改标题会同步重命名素材库里的文件夹并更新存储路径；与库里其它素材重名时会被拒绝。'
    }).then(function (v) {
      if (v == null) return;
      var t = String(v).trim();
      if (!t) return;
      App.renameAssetTo(live.id, t).then(function (r) {
        if (!r || !r.ok) { Toast.warn((r && r.reason) || '重命名失败', 5200); return; }
        if (!r.changed) { Toast.info('标题没有变化', 2400); return; }
        Toast.ok('已重命名为「' + t + '」' + (r.renamed ? '，目录已同步改名' : '（目录未改：原路径不存在）'), 3800);
      });
    });
  }

  function addTags(a) {
    Modal.prompt('要添加的标签（逗号分隔可多个）', '', { title: '添加标签' }).then(function (v) {
      if (!v) return;
      var tags = String(v).split(/[,\uFF0C]/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (!tags.length) return;
      commit(a, function (x) { x.tags = uniq((x.tags || []).concat(tags)); }, '已添加标签：' + tags.join('、'));
    });
  }

  function setAvatars(a) {
    var live = liveOf(a);
    var picker = Field.avatars((live.avatars || []).slice());
    var h = Modal.open({
      title: '设置支持角色 · ' + (live.title || '未命名'),
      size: 'md',
      body: [
        el('div', { class: 'field-hint', text: '可以多选；保存后立即写入这条素材。' }),
        picker
      ],
      footer: [
        el('button', { class: 'btn', onclick: function () { Modal.close(h); } }, '取消'),
        el('button', {
          class: 'btn btn-primary',
          onclick: function () {
            var avs = picker.getValue();
            Modal.close(h);
            commit(live, function (x) { x.avatars = uniq(avs); }, '已更新支持角色');
          }
        }, '保存')
      ]
    });
  }

  function removeAsset(a) {
    var title = a.title || a.originalTitle || '（未命名）';
    Modal.confirm('删除素材「' + title + '」？\n\n只摘掉素材库里的记录，磁盘上的文件不会被动。\n删掉的记录会进回收站，48 小时内可以找回。',
      { title: '删除素材', okText: '删除' }).then(function (ok) {
        if (!ok) return;
        var live = liveOf(a);
        App.remove(live.id).then(function (asset) {
          UI.renderAll();
          App.deletedToast([asset || live]);     // 10 秒内可撤回，错过就在左侧「回收站」里找回
        }).catch(function (e) {
          Toast.err('删除失败：' + ((e && e.message) || e), 6000);
        });
      });
  }

  /** 生成菜单项 */
  function items(a) {
    var cur = liveOf(a);
    var path = App.primaryLocalPath(cur);
    var link = (cur.links || []).filter(function (l) { return l && isHttpUrl(l.url); })[0];
    var category = App.categoryLabel(cur.category);
    var source = App.sourceLabel({ source: cur.source, sourceCustom: cur.sourceCustom });

    var list = [
      { head: cur.title || cur.originalTitle || '（未命名）', sub: category + ' · ' + source },

      { label: '查看详情', icon: 'doc', action: function () { Modals.detail(cur.id); } },
      { label: '编辑素材…', icon: 'edit', hint: '全部字段', action: function () { Modals.edit(cur.id); } },
      { label: '重命名…', icon: 'note', action: function () { rename(cur); } },
      {
        label: '设置分类',
        icon: 'folder',
        hint: category,
        sub: App.allCategories().map(function (c) {
          return {
            label: c.label,
            icon: c.icon || 'folder',
            checked: c.id === cur.category,
            action: function () {
              if (c.id === cur.category) return;
              var oldCat = cur.category;
              var pr = commit(cur, function (x) { x.category = c.id; }, '已移到「' + c.label + '」');
              /* 分类换了：库内文件夹跟着搬到新分类目录 */
              if (pr && pr.then) {
                pr.then(function () {
                  var live2 = (App.assets || []).filter(function (x) { return x.id === cur.id; })[0] || cur;
                  App.relocateToCategory(live2, oldCat).catch(function () {});
                });
              }
            }
          };
        })
      },
      { label: '添加标签…', icon: 'tag', action: function () { addTags(cur); } },
      { label: '设置支持角色…', icon: 'character', action: function () { setAvatars(cur); } },

      { sep: true },

      {
        label: '打开素材文件夹',
        icon: 'folderOut',
        disabled: !path,
        hint: path ? '' : '未关联路径',
        action: function () { FS.openPath(path); }
      },
      link ? {
        label: '打开商店页面',
        icon: 'link',
        action: function () { FS.openExternal(link.url); }
      } : null,
      {
        label: '复制…',
        icon: 'clipboard',
        sub: [
          { label: '标题', disabled: !cur.title, action: function () { copyValue(cur.title, '标题已复制'); } },
          { label: '原标题', disabled: !cur.originalTitle, action: function () { copyValue(cur.originalTitle, '原标题已复制'); } },
          { label: '本地路径', disabled: !path, action: function () { copyValue(path, '路径已复制'); } },
          { label: '商店链接', disabled: !link, action: function () { copyValue(link && link.url, '链接已复制'); } }
        ]
      },

      { sep: true },

      {
        label: cur.favorite ? '取消喜欢' : '加入喜欢',
        icon: 'star',
        action: function () {
          commit(cur, function (x) { x.favorite = !x.favorite; }, cur.favorite ? '已取消喜欢' : '已加入喜欢');
        }
      },
      {
        label: cur.hidden ? '取消隐藏' : '隐藏这个素材',
        icon: cur.hidden ? 'eye' : 'eyeOff',
        action: function () {
          commit(cur, function (x) { x.hidden = !x.hidden; }, cur.hidden ? '已取消隐藏' : '已隐藏（可在侧栏「隐藏」里找回）');
        }
      },
      { label: '导出为素材包', icon: 'parcel', action: function () { Packer.exportDialog([cur]); } },
      /* 右键直接把素材送进「导入与工程」的队列 */
      {
        label: '导入到 Unity',
        icon: 'box',
        hint: '送进导入与工程的队列',
        action: function () {
          if (window.WB && WB.importToUnity) WB.importToUnity([cur]);
          else Toast.err('「导入与工程」页还没加载，稍后再试');
        }
      },

      { sep: true },

      { label: '删除素材…', icon: 'trash', danger: true, action: function () { removeAsset(cur); } }
    ];
    return list.filter(Boolean);
  }

  /** 给卡片挂右键：普通右键直接弹；选择模式下右键不改变已选集合 */
  function attach(cardEl, a) {
    cardEl.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      e.stopPropagation();
      CtxMenu.open(e.clientX, e.clientY, items(a));
    });
  }

  return { items: items, attach: attach };
})();
