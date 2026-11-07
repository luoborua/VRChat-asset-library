/*
 * 93-trash.js —— 回收站页：列出被打了删除标记的素材，可恢复或立刻彻底删除。
 *   数据来自 App.trashed（主库里带 trashAt 的记录），开关由左侧页签栏驱动（AppTab）；
 *   恢复与删除都走 App / Store，和素材库共用同一份数据。
 * 边界：这里不判断 48 小时是否到期——到期清理由 App.startTrashSweep 定期跑。
 */

var TrashUI = (function () {
  var state = { root: null, body: null, clearBtn: null, escBound: false };

  function fmtTime(ms) {
    var d = new Date(ms || Date.now());
    return (d.getMonth() + 1) + '-' + d.getDate() + ' '
      + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }
  /** 剩余时间按「删除时间 + 48h」算，和 Store 的清理口径保持一致 */
  function leftText(trashAt) {
    var left = (trashAt || 0) + Store.TRASH_TTL - Date.now();
    if (left <= 0) return '即将清理';
    var h = Math.floor(left / 3600000);
    if (h >= 1) return '还剩 ' + h + ' 小时';
    return '还剩 ' + Math.max(1, Math.round(left / 60000)) + ' 分钟';
  }

  function thumb(a) {
    var box = el('div', { class: 'trash-thumb' }, [
      el('span', { text: String(a.title || a.originalTitle || '?').slice(0, 1) })
    ]);
    /* 封面还在（标记删除不删封面），异步取回 Blob URL 再换成图 */
    try {
      App.coverURLFor(a).then(function (u) {
        if (!u) return;
        box.innerHTML = '';
        box.appendChild(el('img', { src: u, alt: '' }));
      }).catch(function () {});
    } catch (e) {}
    return box;
  }

  function row(a) {
    var name = a.title || a.originalTitle || '（未命名）';
    var tag = '';
    try { tag = a.category ? (App.categoryLabel(a.category) + ' · ') : ''; } catch (e) {}
    return el('div', { class: 'trash-row' }, [
      thumb(a),
      el('div', { class: 'trash-main' }, [
        el('b', { text: name }),
        el('span', { class: 'trash-meta', text: tag + '删除于 ' + fmtTime(a.trashAt) + ' · ' + leftText(a.trashAt) })
      ]),
      el('button', { class: 'btn btn-sm', onclick: function () {
        App.restoreDeleted([a.id]).then(function (n) {
          if (n) Toast.ok('已恢复「' + name + '」');
          else Toast.warn('这条已经不在回收站里了');
          paint();
        });
      } }, '恢复'),
      el('button', { class: 'btn btn-sm btn-danger-ghost', onclick: function () {
        Modal.confirm('立刻彻底删除「' + name + '」？\n\n删掉就找不回来了。', { title: '彻底删除', okText: '彻底删除' })
          .then(function (ok) {
            if (!ok) return;
            Store.trashDrop(a.id).then(function () {
              App.trashed = (App.trashed || []).filter(function (x) { return x.id !== a.id; });
              App.persistNow();
              Toast.ok('已彻底删除「' + name + '」');
              paint();
            }).catch(function (e) { Toast.err('删除失败：' + ((e && e.message) || e), 6000); });
          });
      } }, '立刻删除')
    ]);
  }

  function clearAll() {
    var n = (App.trashed || []).length;
    if (!n) { Toast.info('回收站是空的'); return; }
    Modal.confirm('彻底删除回收站里的全部 ' + n + ' 项？\n\n删掉就找不回来了，正在用的素材不受影响。', { title: '清空回收站', okText: '全部删除' })
      .then(function (ok) {
        if (!ok) return;
        Store.trashClear().then(function () {
          App.trashed = [];
          App.persistNow();
          Toast.ok('回收站已清空');
          paint();
        }).catch(function (e) { Toast.err('清空失败：' + ((e && e.message) || e), 6000); });
      });
  }

  function paint() {
    if (!state.root) return;
    var list = (App.trashed || []).slice().sort(function (x, y) { return (y.trashAt || 0) - (x.trashAt || 0); });
    state.body.innerHTML = '';
    if (!list.length) {
      state.body.appendChild(el('div', { class: 'trash-empty' }, [
        el('p', { text: '回收站是空的' }),
        el('p', { class: 'field-hint', text: '删除的素材会先放在这里，48 小时后自动彻底删除；期间可以随时恢复。' })
      ]));
    } else {
      state.body.appendChild(el('p', { class: 'trash-summary', text: '共 ' + list.length + ' 项 · 到期自动彻底删除' }));
      state.body.appendChild(el('div', { class: 'trash-list' }, list.map(row)));
    }
    if (state.clearBtn) state.clearBtn.disabled = !list.length;
  }

  function build() {
    if (state.root) return state.root;
    state.clearBtn = el('button', { class: 'btn', onclick: clearAll }, '清空回收站');
    state.body = el('div', { class: 'trash-body' });
    state.root = el('section', { class: 'trash-page', id: 'trashPage' }, [
      el('header', { class: 'trash-head' }, [
        el('div', { class: 'trash-title' }, [
          el('b', { text: '回收站' }),
          el('small', { text: '删除的素材先放这里，48 小时后自动彻底删除' })
        ]),
        el('div', { class: 'grow' }),
        state.clearBtn,
        el('button', { class: 'icon-btn', title: '回到素材库 (Esc)', onclick: function () { AppTab.set('library'); } },
          ICONS.label('\u2715'))
      ]),
      state.body
    ]);
    document.body.appendChild(state.root);
    return state.root;
  }

  function show() {
    build();
    paint();
    /* 先强制一次回流再加 .in：窗口在后台时 requestAnimationFrame 不跑，
     * 靠它加类会让页面一直停在 visibility:hidden */
    void state.root.offsetHeight;
    state.root.classList.add('in');
    if (!state.escBound) {
      state.escBound = true;
      document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape' || !state.root || !state.root.classList.contains('in')) return;
        /* 有弹窗时先让弹窗自己关，别把整页一起关掉 */
        if (document.querySelector('.modal-mask.in, .modal-overlay.in')) return;
        AppTab.set('library');
      });
    }
  }

  function hide() {
    if (!state.root) return;
    state.root.classList.remove('in');
  }

  /** 数据变了：只有页面在显示时才重画，隐藏时留给下次 show */
  function refresh() {
    if (state.root && state.root.classList.contains('in')) paint();
  }

  return { show: show, hide: hide, refresh: refresh, paint: paint };
})();
