/* ============ 80-settings.js ============ */
/* ============ 80-settings.js ============ */
/* =====================================================================
 * 80-settings.js  —  设置中心 / 批量操作 / 整理辅助
 * ===================================================================== */

var Settings = {
  open: function (tabId) {
    var tabs = [
      { id: 'appearance', label: ICONS.label('\u{1F3A8} 外观') },
      { id: 'fetch',      label: ICONS.label('\u{1F310} 联网与宿主') },
      { id: 'cred',       label: ICONS.label('\u{1F510} 站点凭证') },
      { id: 'tagdict',    label: ICONS.label('\u{1F524} 标签翻译') },
      { id: 'tagmanage',  label: ICONS.label('\u{1F5C2} 标签管理') },
      { id: 'dict',       label: ICONS.label('\u{1F5C2} 分类与角色') },
      { id: 'icons',      label: ICONS.label('\u{1F3A8} 图标') },
      { id: 'ai',         label: ICONS.label('\u{1F916} AI 与模糊搜索') },
      { id: 'library',    label: ICONS.label('\u{1F4C1} 本地库与整理') },
      { id: 'data',       label: ICONS.label('\u{1F4BE} 数据管理') },
      { id: 'about',      label: ICONS.label('\u2139 关于与帮助') }
    ];
    var content = el('div', { class: 'settings-content' });
    var nav = el('div', { class: 'settings-nav' }, tabs.map(function (t) {
      return el('button', {
        class: 'settings-tab', dataset: { tab: t.id },
        onclick: function () { select(t.id); }
      }, t.label);   // v2.3.27：tabs 里的 label 已是 ICONS.label(...) 生成的节点数组，el() 会自动展平
    }));
    function select(id) {
      $$('.settings-tab', nav).forEach(function (b) { b.classList.toggle('active', b.dataset.tab === id); });
      content.innerHTML = '';
      content.appendChild(Settings['tab_' + id]());
      var sc = nav.closest ? nav.closest('.modal-body') : null;   // v2.3.8：切标签后右侧回到开头
      if (sc) sc.scrollTop = 0;
    }
    var h = Modal.open({
      title: '设置', size: 'lg',
      body: [el('div', { class: 'settings' }, [nav, content])],
      footer: [el('button', { class: 'btn btn-primary', onclick: function () { Modal.close(h); UI.renderAll(); } }, '完成')]
    });
    select(tabId || 'appearance');
  },

  /* ---------------- 外观 ---------------- */
  tab_appearance: function () {
    var box = el('div', { class: 'settings-pane' });
    box.appendChild(el('h3', { text: '主题与显示' }));

    var themeSel = el('select', { class: 'input', onchange: function () {
      App.settings.theme = themeSel.value; App.applyTheme(); App.saveSettings();
    } }, THEMES.map(function (t) {
      return el('option', { value: t.id, selected: App.settings.theme === t.id }, t.icon + ' ' + t.label);
    }));
    box.appendChild(Field.row('主题', themeSel, '樱粉马卡龙偏少女向（粉 + 杏黄），天际蓝是淡蓝配白'));

    /* v4.5：毛玻璃是独立开关，叠在任意主题上 */
    var glassCb = el('input', { type: 'checkbox', checked: App.settings.glass !== false, onchange: function () {
      App.settings.glass = glassCb.checked; App.applyTheme(); App.saveSettings();
    } });
    box.appendChild(el('label', { class: 'check check-row' }, [
      glassCb, el('span', { text: '毛玻璃效果（半透明面板 + 背景模糊，关掉更省一点性能）' })
    ]));

    var sizeSel = el('select', { class: 'input', onchange: function () {
      App.settings.cardSize = sizeSel.value; App.page = 1; App.saveSettings(); UI.renderMain();
    } }, [
      el('option', { value: 's', selected: App.settings.cardSize === 's' }, '小卡片（更密集）'),
      el('option', { value: 'm', selected: App.settings.cardSize === 'm' }, '中卡片（默认）'),
      el('option', { value: 'l', selected: App.settings.cardSize === 'l' }, '大卡片（看图）')
    ]);
    box.appendChild(Field.row('卡片尺寸', sizeSel));

    /* v5.0：每页数量不再让用户选 —— 按卡片大小自动换算，保持一页占的面积差不多 */
    box.appendChild(Field.row('每页数量', el('span', { class: 'field-hint', text: '跟随卡片大小自动决定：小 34 / 中 24 / 大 15，翻页条数量也随卡片大小变化' })));

    [['autoTranslateTags', '获取信息后自动翻译标签为中文'],
     ['autoDetectAvatar', '自动识别支持的角色'],
     ['autoFetchCover', '自动下载并压缩封面图到本地库'],
     ['showHidden', '在默认列表中也显示「已隐藏」的素材'],
     ['confirmDelete', '删除素材前二次确认']].forEach(function (p) {
      var cb = el('input', { type: 'checkbox', checked: !!App.settings[p[0]], onchange: function () {
        App.settings[p[0]] = cb.checked; App.saveSettings();
        if (p[0] === 'showHidden') UI.renderAll();
      } });
      box.appendChild(el('label', { class: 'check check-row' }, [cb, el('span', { text: p[1] })]));
    });

    box.appendChild(el('h3', { text: '封面图压缩' }));
    var wIn = el('input', { class: 'input input-sm', type: 'number', min: 240, max: 2000, value: App.settings.imageMaxWidth,
      onchange: function () { App.settings.imageMaxWidth = Math.max(240, Math.min(2000, +wIn.value || 720)); App.saveSettings(); } });
    var qIn = el('input', { class: 'input input-sm', type: 'number', min: 0.3, max: 1, step: 0.02, value: App.settings.imageQuality,
      onchange: function () { App.settings.imageQuality = Math.max(0.3, Math.min(1, +qIn.value || 0.82)); App.saveSettings(); } });
    box.appendChild(Field.row('最大宽度(px)', wIn, '超出该宽度的封面会等比缩小，节省存储空间'));
    box.appendChild(Field.row('压缩质量', qIn, '0.3 ~ 1.0，推荐 0.82'));

    box.appendChild(el('h3', { text: '快捷键' }));
    var keys = [['/ 或 Ctrl+K', '聚焦搜索框'], ['N', '新增素材'], ['Esc', '关闭弹窗 / 退出多选'],
      ['Ctrl+S', '导出备份'], ['G', '网格视图 / 列表视图切换'], ['T', '切换主题'],
      ['\u2190 / \u2192', '上一页 / 下一页'], ['R', '随机推荐一个素材']];
    box.appendChild(el('div', { class: 'kv-list' }, keys.map(function (k) {
      return el('div', { class: 'kv' }, [el('div', { class: 'kv-k' }, el('kbd', { text: k[0] })), el('div', { class: 'kv-v', text: k[1] })]);
    })));

    return box;
  },

  /* ---------------- 联网与宿主 ---------------- */
  tab_fetch: function () {
    var box = el('div', { class: 'settings-pane' });
    box.appendChild(el('div', { class: 'notice' }, [
      el('b', { text: '浏览器安全限制与内置宿主' }),
      el('p', { text: '浏览器同源策略决定了网页脚本不能直接读取 BOOTH / Gumroad 等外部站点。本工具因此只有两条路：默认「手动粘贴源码」（完全离线、零请求）；需要联网时，全部请求统一由本程序内置的宿主发起——不再使用任何 CORS 代理。' })
    ]));

    box.appendChild(el('h3', { text: '抓取方式' }));
    var modeBox = el('div', { class: 'mode-list' });
    function renderModes() {
      modeBox.innerHTML = '';
      FETCH_MODES.forEach(function (m) {
        var on = (App.settings.fetchMode || 'paste') === m.id;
        modeBox.appendChild(el('button', {
          class: 'mode-card' + (on ? ' on' : ''), type: 'button',
          onclick: function () {
            App.settings.fetchMode = m.id;
            App.saveSettings().then(function () {
              renderModes();
              Toast.ok('已切换为：' + m.label);
            });
          }
        }, [
          el('div', { class: 'mode-card-title' }, [
            el('span', { class: 'mode-radio', text: on ? '\u25C9' : '\u25CB' }),
            el('b', { text: m.label })
          ]),
          el('div', { class: 'mode-card-desc', text: m.desc })
        ]));
      });
    }
    renderModes();
    box.appendChild(modeBox);
    var autoCk = el('input', { type: 'checkbox', checked: !!App.settings.autoCookieFetch, onchange: function () {
      App.settings.autoCookieFetch = autoCk.checked; App.saveSettings();
    } });
    box.appendChild(el('label', { class: 'check check-row' }, [autoCk, el('span', { text: '编辑素材时，如已保存 Cookie 且该素材还没有版本/下载链接，自动获取已购版本、价格（需要内置宿主在线）' })]));

    box.appendChild(el('h3', { text: '内置宿主（联网与文件操作唯一通道）' }));
    var hostStatus = el('div', { class: 'local-proxy-status' });
    /* v4.1.0（Electron 单载体）：宿主由主进程随窗口启动 —— 没有外部进程可启动/停止，
     * 也就没有「宿主工具文件夹」「后台隐藏运行」这类启动器参数，旧 WebView2 入口已整体移除。 */
    function renderHostStatus() {
      hostStatus.innerHTML = '';
      var tip = el('div', { class: 'field-hint', text: '正在检测内置宿主（127.0.0.1:8788-8792）…' });
      hostStatus.appendChild(tip);
      FS.hostEnsure().then(function (ok) {
        hostStatus.innerHTML = '';
        if (ok) {
          var base = FS.host.base ? FS.host.base() : '';
          hostStatus.appendChild(el('span', { class: 'chip chip-ok' }, ICONS.label('\u2714 内置宿主在线（' + (base || '127.0.0.1') + '）')));
          hostStatus.appendChild(el('span', { class: 'field-hint', text: '打开文件夹 / 移动复制 / 联网抓取 / Cookie 已购识别 / AI 翻译 / 网盘全部由主进程的内置宿主执行，随窗口一起启动，不需要单独运行任何程序。' }));
          hostStatus.appendChild(el('div', { class: 'btn-row' }, [
            el('button', { class: 'btn btn-sm', onclick: function () { renderHostStatus(); } }, ICONS.label('\u{1F504} 重新检测'))
          ]));
        } else {
          hostStatus.appendChild(el('span', { class: 'chip' }, ICONS.label('\u26A0 内置宿主离线')));
          hostStatus.appendChild(el('div', { class: 'field-hint', text: '素材仍可正常浏览，手动粘贴源码也不受影响；但打开文件夹、移动/复制、联网抓取、Cookie 已购识别、AI 翻译、网盘将不可用。' }));
          hostStatus.appendChild(el('div', { class: 'field-hint', text: '内置宿主由主进程随窗口启动：请关闭程序后重新双击「启动素材库_Electron版.bat」。若反复出现，多半是 8788~8792 端口被其它程序占用。' }));
          hostStatus.appendChild(el('div', { class: 'btn-row' }, [
            el('button', { class: 'btn btn-sm', onclick: function () { renderHostStatus(); } }, ICONS.label('\u{1F504} 重新检测'))
          ]));
        }
      });
    }
    renderHostStatus();
    box.appendChild(hostStatus);

    box.appendChild(el('h3', { text: '解析结果缓存' }));
    box.appendChild(el('div', { class: 'field-hint', text: '同一个商品链接的解析结果会缓存到本机 IndexedDB，重复添加时直接命中缓存，不再重复请求或重复解析。' }));
    var cacheCb = el('input', { type: 'checkbox', checked: !!App.settings.cacheEnabled, onchange: function () {
      App.settings.cacheEnabled = cacheCb.checked; App.saveSettings();
    } });
    box.appendChild(el('label', { class: 'check check-row' }, [cacheCb, el('span', { text: '启用解析结果缓存' })]));
    var ttlIn = el('input', { class: 'input input-sm', type: 'number', min: 1, max: 8760, value: App.settings.cacheTTLHours,
      onchange: function () { App.settings.cacheTTLHours = Math.max(1, +ttlIn.value || 168); App.saveSettings(); } });
    box.appendChild(Field.row('缓存有效期（小时）', ttlIn, '默认 168 小时（7 天）'));
    var cacheInfo = el('span', { class: 'field-hint', text: '统计中…' });
    Store.cacheCount().then(function (n) { cacheInfo.textContent = '当前缓存条目：' + n; });
    box.appendChild(el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn btn-sm', onclick: function () {
        Store.cacheClear().then(function () { cacheInfo.textContent = '当前缓存条目：0'; Toast.ok('已清空解析缓存'); });
      } }, ICONS.label('\u{1F5D1} 清空解析缓存')),
      cacheInfo
    ]));

    box.appendChild(el('h3', { text: '下载' }));
    var concIn = el('input', {
      class: 'input input-sm', type: 'number', min: 1, max: 8, value: App.settings.dlConcurrency || 4,
      onchange: function () {
        App.settings.dlConcurrency = Math.max(1, Math.min(8, Math.round(+concIn.value || 4)));
        concIn.value = App.settings.dlConcurrency;
        App.saveSettings();
      }
    });
    box.appendChild(Field.row('同时下载文件数', concIn, '1~8，默认 4。单文件 ≥16MB 且服务器支持断点续传时，宿主会自动切成最多 8 段并发下载（慢速源提速用）；改完立刻对新任务生效。'));
    return box;
  },

  /* ---------------- 站点凭证（仅 Cookie） ---------------- */
  tab_cred: function () {
    var box = el('div', { class: 'settings-pane' });
    var lv = Secure.level();

    box.appendChild(el('div', { class: 'notice notice-warn' }, [
      el('b', null, ICONS.label('\u26A0 安全设计说明')),
      el('p', { text: '本工具「不存储账号密码」——按设计只接受你手动粘贴的 Cookie 字符串。Cookie 仅保存在你自己浏览器的本机数据库里，不会上传到任何服务器，也不会随备份文件导出。' }),
      el('p', { text: '当前保护级别：' + lv.name + '。' + lv.why }),
      el('p', { text: 'Cookie 只会在联网抓取时发送给本程序内置的宿主（127.0.0.1 回环地址，由它直接访问 BOOTH），绝不发给任何第三方代理或服务器。请勿在公用电脑上保存 Cookie，使用后建议及时清除。' })
    ]));

    var listBox = el('div', { class: 'cred-list' });
    function render() {
      listBox.innerHTML = '';
      var creds = App.settings.credentials || {};
      var hosts = Object.keys(creds);
      if (!hosts.length) listBox.appendChild(el('div', { class: 'multi-empty', text: '尚未配置任何站点 Cookie' }));
      hosts.forEach(function (host) {
        var c = creds[host] || {};
        var cookieIn = el('textarea', {
          class: 'input textarea mono', rows: 3,
          placeholder: '粘贴该站点的 Cookie 整行，例如：_plaza_session_nktz7u=xxxx; other=yyyy'
        });
        // v2.3.15：Cookie 不回显原文，但给出「已保存什么」的直观摘要（项名 / 条数 / 字符数 / 更新时间 / 掩码）
        var statusTip = el('span', { class: 'field-hint' });
        (function paintStatus() {
          if (!c.cookie) {
            statusTip.className = 'field-hint';
            statusTip.textContent = '尚未保存：粘贴 Cookie 后点右侧「\u{1F512} 加密保存」';
            return;
          }
          statusTip.className = 'field-hint cred-saved';
          var when = c.at ? String(c.at).slice(0, 16).replace('T', ' ') + ' 更新' : '';
          ICONS.apply(statusTip, '\u2714 已保存' + (when ? '（' + when + '）' : '') + '：读取摘要…');
          Secure.decrypt(c.cookie).then(function (plain) {
            var s = String(plain || '');
            var names = [];
            s.split(';').forEach(function (kv) {
              var n = String(kv).split('=')[0].trim();
              if (n) names.push(n);
            });
            var mask = s.slice(0, 6).replace(/[=;].*$/, '');
            ICONS.apply(statusTip, '\u2714 已保存' + (when ? '（' + when + '）' : '')
              + '：' + names.length + ' 项 Cookie'
              + (names.length ? '（' + names.slice(0, 4).join('、') + (names.length > 4 ? ' 等' : '') + '）' : '')
              + ' · 共 ' + s.length + ' 字符'
              + (mask ? ' · 掩码 ' + mask + '……' : ''));
            statusTip.title = '出于安全不回显原文；重新粘贴并保存会整条覆盖。';
          }).catch(function () {
            ICONS.apply(statusTip, ('\u2714 已保存（摘要读取失败：加密密钥不可用或保护级别变化）'));
          });
        })();
        listBox.appendChild(el('div', { class: 'cred-item' }, [
          el('div', { class: 'cred-head' }, [
            el('b', { text: host }),
            el('button', {
              class: 'btn btn-xs btn-danger-ghost', onclick: function () {
                delete App.settings.credentials[host];
                App.saveSettings().then(render);
              }
            }, ICONS.label('\u{1F5D1} 删除该站点'))
          ]),
          Field.row('Cookie', cookieIn, '获取方式：浏览器按 F12 \u2192 网络(Network) \u2192 点任意请求 \u2192 请求标头 \u2192 复制 Cookie 整行'),
          el('div', { class: 'inline-row' }, [
            statusTip,
            el('button', {
              class: 'btn btn-sm', onclick: function () {
                App.settings.credentials[host] = { cookie: '' };
                App.saveSettings().then(function () { render(); Toast.ok('已清除 ' + host + ' 的 Cookie'); });
              }
            }, '清除 Cookie'),
            el('button', {
              class: 'btn btn-sm btn-primary', onclick: function () {
                var val = cookieIn.value.trim();
                if (!val) { Toast.warn('请先粘贴 Cookie 内容'); return; }
                Secure.encrypt(val).then(function (enc) {
                  App.settings.credentials[host] = { cookie: enc, at: new Date().toISOString() };
                  return App.saveSettings();
                }).then(function () {
                  cookieIn.value = '';
                  render();
                  Toast.ok('已加密保存 ' + host + ' 的 Cookie（' + lv.name + '）');
                });
              }
            }, ICONS.label('\u{1F512} 加密保存'))
          ])
        ]));
      });
    }
    render();
    box.appendChild(listBox);
    box.appendChild(el('div', { class: 'btn-row' }, [
      el('button', {
        class: 'btn btn-sm', onclick: function () {
          Modal.prompt('输入站点域名（如 booth.pm、gumroad.com）：', '', { title: '添加站点 Cookie' }).then(function (v) {
            if (!v || !v.trim()) return;
            var host = v.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
            App.settings.credentials[host] = { cookie: '' };
            App.saveSettings().then(render);
          });
        }
      }, ICONS.label('\u2795 添加站点')),
      el('button', {
        class: 'btn btn-sm btn-danger-ghost', onclick: function () {
          Modal.confirm('确定清空所有已保存的站点 Cookie 吗？', { okText: '清空' }).then(function (ok) {
            if (!ok) return;
            App.settings.credentials = {};
            App.saveSettings().then(function () { render(); Toast.ok('已清空全部 Cookie'); });
          });
        }
      }, ICONS.label('\u{1F5D1} 清空全部 Cookie'))
    ]));

    /* ---- v2.3.25：可选 GitHub Token（不填=匿名 60 次/小时；填了=5000 次/小时） ---- */
    var tkBox = el('div', { class: 'cred-item' });
    function renderToken() {
      tkBox.innerHTML = '';
      var has = !!App.settings.githubToken;
      var tkIn = el('input', {          // 刻意不用 type=password：Token 明文可见便于核对粘贴内容（例外：DeepSeek API Key 与 WebDAV 密码仍用 type=password）
        class: 'input mono', type: 'text', autocomplete: 'off', spellcheck: 'false',
        placeholder: has ? '已保存（不回显原文；重新粘贴保存会整条覆盖）' : '粘贴 GitHub Token（可选）'
      });
      tkBox.appendChild(el('div', { class: 'field-label', text: 'GitHub Token（可选）' }));
      tkBox.appendChild(tkIn);
      tkBox.appendChild(el('div', { class: 'inline-row' }, [
        el('span', { class: 'field-hint', text: has ? ('已加密保存（' + lv.name + '）· 抓取额度 5000 次/小时') : '未配置：GitHub 走匿名额度 60 次/小时（每个仓库 2 次请求；README 已改走 raw，不占额度）' }),
        el('button', { class: 'btn btn-sm', onclick: function () {
          if (!App.settings.githubToken) { Toast.warn('尚未配置 Token'); return; }
          App.settings.githubToken = '';
          App.saveSettings().then(function () { renderToken(); Toast.ok('已清除 GitHub Token（恢复匿名额度）'); });
        } }, '清除'),
        el('button', { class: 'btn btn-sm btn-primary', onclick: function () {
          var v = tkIn.value.trim();
          if (!v) { Toast.warn('请先粘贴 Token'); return; }
          Secure.encrypt(v).then(function (enc) {
            App.settings.githubToken = enc;
            return App.saveSettings();
          }).then(function () { tkIn.value = ''; renderToken(); Toast.ok('已加密保存 GitHub Token（额度 5000 次/小时）'); });
        } }, ICONS.label('\u{1F512} 加密保存'))
      ]));
      tkBox.appendChild(el('div', { class: 'field-hint', text: '只读公开仓库即可：fine-grained Token 勾 Public Repositories (read-only)，或 classic Token 勾 public_repo。Token 与 Cookie 同样只存本机加密库，不写 settings.json、不随备份导出。' }));
    }
    renderToken();
    box.appendChild(tkBox);
    return box;
  },

  /* ---------------- 标签翻译 ---------------- */
  tab_tagdict: function () {
    var box = el('div', { class: 'settings-pane' });
    box.appendChild(el('div', { class: 'notice' }, [
      el('p', { text: '内置词典已收录数百条常见日文/英文素材标签的中文对照。此处维护你的个人词典，优先级高于内置词典；未命中的标签会保留原文并标注「（待翻译）」。' })
    ]));
        var tagTransCb = el('input', {
      type: 'checkbox', checked: App.settings.tagTranslationEnabled !== false,
      onchange: function () {
        App.settings.tagTranslationEnabled = tagTransCb.checked;
        App.saveSettings().then(function () { UI.renderAll(); Toast.ok(tagTransCb.checked ? '已开启标签翻译显示' : '已关闭标签翻译显示，当前显示原文标签'); });
      }
    });
    box.appendChild(el('label', { class: 'check check-row' }, [tagTransCb,
      el('span', { text: '显示翻译后的中文标签（关闭后直接显示原文标签，原文始终参与搜索）' })]));box.appendChild(el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn btn-sm btn-primary', onclick: function () { Settings.tagConsolidateDialog(); } }, ICONS.label('\u{1F916} AI 合并冗余标签（需审阅）'))
    ]));

    var untranslated = {};
    App.assets.forEach(function (a) {
      (a.tags || []).concat(a.rawTags || []).forEach(function (t) {
        if (Smart.isUntranslated(t)) untranslated[t] = (untranslated[t] || 0) + 1;
      });
    });
    var untransKeys = Object.keys(untranslated).sort(function (a, b) { return untranslated[b] - untranslated[a]; });

    var listBox = el('div', { class: 'dict-list' });
    var dictQuery = '';
    function render() {
      listBox.innerHTML = '';
      var d = App.settings.userTagDict || {};
      var keys = Object.keys(d).sort(collator.compare).filter(function (k) {
        return !dictQuery || k.toLowerCase().indexOf(dictQuery) >= 0 || String(d[k]).toLowerCase().indexOf(dictQuery) >= 0;
      });
      if (!keys.length) listBox.appendChild(el('div', { class: 'multi-empty', text: dictQuery ? '没有匹配的词条' : '个人词典为空' }));
      keys.forEach(function (k) {
        var vIn = el('input', { class: 'input input-sm', value: d[k], onchange: function () {
          App.settings.userTagDict[k] = vIn.value.trim(); App.saveSettings().then(function () { render(); Settings.applyDictToAssets(); });
        } });
        listBox.appendChild(el('div', { class: 'dict-row' }, [
          el('code', { class: 'dict-k', text: k }), el('span', { text: '→' }), vIn,
          el('button', { class: 'btn btn-xs btn-danger-ghost', onclick: function () {
            delete App.settings.userTagDict[k]; App.saveSettings().then(function () { render(); Settings.applyDictToAssets(); });
          } }, ICONS.label('\u{1F5D1}'))
        ]));
      });
    }
    render();

    box.appendChild(el('h3', { text: '待翻译标签（库中出现的未命中词条）' }));
    if (!untransKeys.length) {
      box.appendChild(el('div', { class: 'multi-empty', text: '很好，当前没有待翻译的标签。' }));
    } else {
      box.appendChild(el('div', { class: 'btn-row dict-tools-row' }, [
        el('button', { class: 'btn btn-sm btn-primary', onclick: function () {
          Toast.info('AI 翻译中，请稍候 …');
          AI.translateItems(untransKeys, function (m) { console.log('[AI]', m); }).then(function (r) {
            return AI.mergeTagResults(r.results).then(function (added) {
            Toast.ok('AI 翻译完成：词典新增 ' + added + ' 条，请在下方查看');
            render();
            if (added) Settings.applyDictToAssets();
          });
          }).catch(function (e) { Toast.err(e.message || 'AI 翻译失败'); });
        } }, ICONS.label('\u{1F916} AI 翻译全部待翻译标签')),
        el('button', { class: 'btn btn-sm', onclick: function () { Settings.applyDictToAssets(); } }, ICONS.label('\u{1F504} 用最新词典刷新素材标签'))
      ]));

      var pend = el('div', { class: 'chip-wrap' });
      untransKeys.slice(0, 60).forEach(function (k) {
        pend.appendChild(el('button', { class: 'tag tag-untrans', onclick: function () {
          Modal.prompt('为标签「' + k + '」设置中文显示名：', '', { title: '添加标签翻译' }).then(function (v) {
            if (!v || !v.trim()) return;
            App.settings.userTagDict[k] = v.trim();
            App.saveSettings().then(function () { render(); Toast.ok('已添加：' + k + ' → ' + v.trim()); Settings.applyDictToAssets(); });
          });
        } }, k + ' \u00D7' + untranslated[k]));
      });
      box.appendChild(pend);
      box.appendChild(el('div', { class: 'dict-tools-row' }, [
        el('button', { class: 'btn btn-sm', onclick: function () {
          Settings.applyDictToAssets();
        } }, ICONS.label('\u{1F504} 用最新词典重新翻译全部素材标签'))
      ]));
    }

    var dictContent = el('div', {}, []);
    var dictActions = el('div', { class: 'dict-actions' }, [
      el('button', { class: 'btn btn-sm', onclick: function () {
        Modal.prompt('原文标签（日文 / 英文）：', '', { title: '新增词条' }).then(function (k) {
          if (!k || !k.trim()) return;
          Modal.prompt('对应中文：', '', { title: '新增词条' }).then(function (v) {
            if (!v || !v.trim()) return;
            App.settings.userTagDict[k.trim()] = v.trim();
            App.saveSettings().then(function () { render(); Settings.applyDictToAssets(); });
          });
        });
      } }, ICONS.label('\u2795 新增词条')),
      el('button', { class: 'btn btn-sm', onclick: function () {
        var blob = new Blob([JSON.stringify(App.settings.userTagDict, null, 2)], { type: 'application/json' });
        downloadBlob(blob, '标签词典.json');
      } }, ICONS.label('\u2B07 导出词典')),
      el('button', { class: 'btn btn-sm', onclick: function () {
        var fi = el('input', { type: 'file', accept: '.json', style: { display: 'none' } });
        fi.onchange = function () {
          var f = fi.files[0]; if (!f) return;
          FS.readFileAsText(f).then(function (t) {
            var d = safeJSON(t, null);
            if (!d || typeof d !== 'object') { Toast.err('词典文件格式不正确'); return; }
            Object.keys(d).forEach(function (k) { App.settings.userTagDict[k] = String(d[k]); });
            App.saveSettings().then(function () { render(); Toast.ok('已导入 ' + Object.keys(d).length + ' 条词条'); Settings.applyDictToAssets(); });
          });
        };
        document.body.appendChild(fi); fi.click(); setTimeout(function () { fi.remove(); }, 1000);
      } }, ICONS.label('\u2B06 导入词典'))
    ]);
    dictContent.appendChild(el('div', { class: 'dict-head' }, [
      el('h3', { text: '个人词典' }),
      dictActions
    ]));
    dictContent.appendChild(el('input', {
      class: 'input dict-search', placeholder: '搜索个人词典（原文 / 译文）…',
      oninput: debounce(function (e) { dictQuery = e.target.value.trim().toLowerCase(); render(); }, 150)
    }));
    dictContent.appendChild(listBox);
    box.appendChild(Settings.collapse('个人词典（点击展开）', dictContent, false));

    return box;
  },


  /* ---------------- 标签管理（独立页签） ---------------- */
  /** 可折叠区块（用于大数据列表） */
  collapse: function (title, content, open) {
    return el('details', { class: 'settings-collapse', open: open ? 'open' : null }, [
      el('summary', { class: 'settings-collapse-summary' }, [el('span', { text: title })]),
      el('div', { class: 'settings-collapse-body' }, [content])
    ]);
  },

  tab_tagmanage: function () {
    var box = el('div', { class: 'settings-pane' });
    box.appendChild(el('h3', { text: '标签管理' }));
    box.appendChild(el('div', { class: 'notice' }, [
      el('p', { text: '这里管理标签本身：黑名单屏蔽规则、全局删除/修改。翻译相关请到「标签翻译」页。' })
    ]));

    box.appendChild(el('div', { class: 'section-title', text: '标签黑名单' }));
    var blBox = el('div', { class: 'chip-wrap' });
    function renderBl() {
      blBox.innerHTML = '';
      TAG_BLACKLIST.forEach(function (t) { blBox.appendChild(el('span', { class: 'chip', title: '内置黑名单' }, t)); });
      (App.settings.userTagBlacklist || []).forEach(function (t) {
        blBox.appendChild(el('span', { class: 'chip chip-custom' }, [
          el('span', { text: t }),
          el('button', { class: 'tag-x', onclick: function () {
            App.settings.userTagBlacklist = (App.settings.userTagBlacklist || []).filter(function (x) { return x !== t; });
            App.saveSettings().then(renderBl);
          } }, ICONS.label('\u{1F5D1}'))
        ]));
      });
    }
    renderBl();
    box.appendChild(blBox);
    box.appendChild(el('div', { class: 'dict-tools-row' }, [
      el('button', { class: 'btn btn-sm', onclick: function () {
        Modal.prompt('要屏蔽的标签（可多个，逗号分隔；支持正则：以 /开头、/结尾，如 /^v\\d+(\\.\\d+)*$/i）：', '', { title: '新增黑名单' }).then(function (v) {
          if (!v || !v.trim()) return;
          App.settings.userTagBlacklist = uniq((App.settings.userTagBlacklist || []).concat(v.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean)));
          App.saveSettings().then(function () { renderBl(); Toast.ok('已加入黑名单'); });
        });
      } }, ICONS.label('\u2795 新增黑名单'))
    ]));

    var tagMgmtQuery = '';
    var tagMgmtBox = el('div', { class: 'dict-list' });
    function tagStats() {
      var m = {};
      App.assets.forEach(function (a) {
        (a.tags || []).concat(a.rawTags || []).forEach(function (t) { m[t] = (m[t] || 0) + 1; });
      });
      return m;
    }
    function renderTags() {
      tagMgmtBox.innerHTML = '';
      var m = tagStats();
      var keys = Object.keys(m).sort(collator.compare).filter(function (k) {
        return !tagMgmtQuery || k.toLowerCase().indexOf(tagMgmtQuery) >= 0;
      });
      if (!keys.length) { tagMgmtBox.appendChild(el('div', { class: 'multi-empty', text: '没有匹配的标签' })); return; }
      keys.forEach(function (t) {
        tagMgmtBox.appendChild(el('div', { class: 'dict-row tag-mgmt-row' }, [
          el('code', { class: 'dict-k', text: t + ' ×' + m[t] }),
          el('div', { class: 'dict-actions' }, [
            el('button', { class: 'btn btn-xs', onclick: function () {
              Modal.prompt('把「' + t + '」全局修改为：', t, { title: '全局修改标签' }).then(function (v) {
                if (v == null) return;
                var nv = v.trim();
                if (!nv || nv === t) return;
                App.renameTag(t, nv).then(function (n) { renderTags(); Toast.ok('已修改 ' + n + ' 个素材'); });
              });
            } }, ICONS.label('\u270E 修改')),
            el('button', { class: 'btn btn-xs btn-danger-ghost', onclick: function () {
              Modal.confirm('从所有素材中删除标签「' + t + '」？', { okText: '删除' }).then(function (ok) {
                if (!ok) return;
                App.deleteTag(t).then(function (n) { renderTags(); Toast.ok('已从 ' + n + ' 个素材删除'); });
              });
            } }, ICONS.label('\u{1F5D1} 删除'))
          ])
        ]));
      });
    }
    renderTags();

    box.appendChild(el('div', { class: 'dict-tools-row' }, [
      el('button', {
        class: 'btn btn-sm', onclick: function () {
          Modal.confirm('将清理所有素材中的冗余标签：与支持角色重叠、与分类重叠、与来源重叠、黑名单词条，并去重。是否继续？', { okText: '开始清理' })
            .then(function (ok) {
              if (!ok) return;
              App.cleanRedundantTags().then(function (r) {
                renderTags();
                Toast.ok('清理完成：移除 ' + r.removed + ' 个冗余标签（' + r.assets + ' 个素材）');
              });
            });
        }
      }, ICONS.label('\u{1F9F9} 清理重复冗余标签'))
    ]));

    var tagListBlock = el('div', {}, [
      el('input', {
        class: 'input dict-search', placeholder: '搜索标签 …',
        oninput: debounce(function (e) { tagMgmtQuery = e.target.value.trim().toLowerCase(); renderTags(); }, 150)
      }),
      tagMgmtBox
    ]);
    box.appendChild(Settings.collapse('标签修改 / 删除（点击展开）', tagListBlock, false));
    return box;
  },
  applyDictToAssets: function () {
    var changed = 0;
    var list = App.assets.map(function (a) {
      // 原文标签 + 当前标签并集一起过词典：确保“看起来像中文、实际是日文”的词条加进个人词典后也会被强制替换
      var src = uniq((a.rawTags || []).concat(a.tags || []));
      var t = Smart.translateTags(src);
      if (t.join('|') !== (a.tags || []).join('|')) { a.tags = t; changed++; }
      return a;
    });
    return Store.putAssets(list).then(function () {
      UI.renderAll();
      Toast.ok('已更新 ' + changed + ' 条素材的标签显示');
    });
  },

  /** AI 建议合并冗余标签（需用户勾选审批后应用） */
  tagConsolidateDialog: function () {
    var logBox = el('div', { class: 'fetch-log', style: { display: 'block' } });
    function log(m) { logBox.appendChild(el('div', { class: 'log-line', text: m })); logBox.scrollTop = logBox.scrollHeight; }
    var listBox = el('div', { class: 'dict-list' });
    var running = false;
    var groups = [];
    var startBtn = el('button', { class: 'btn btn-primary', onclick: run }, ICONS.label('\u{1F916} 开始分析'));
    var applyBtn = el('button', { class: 'btn btn-primary', style: { display: 'none' }, onclick: apply }, ICONS.label('\u2714 应用勾选的合并'));
    var h = Modal.open({
      title: 'AI 合并冗余标签（需审阅）', size: 'md',
      body: [
        el('div', { class: 'notice' }, [
          el('p', { text: 'AI 会分析当前素材库中的标签，提出同义/冗余合并建议。建议不会自动生效：请逐项勾选审批后再应用。' })
        ]),
        logBox, listBox
      ],
      footer: [
        el('button', { class: 'btn', onclick: function () { Modal.close(h); } }, '关闭'),
        startBtn, applyBtn
      ]
    });

    function renderGroups() {
      listBox.innerHTML = '';
      if (!groups.length) { listBox.appendChild(el('div', { class: 'multi-empty', text: 'AI 没有提出可合并的标签组。' })); return; }
      groups.forEach(function (g, gi) {
        var cb = el('input', { type: 'checkbox', checked: true });
        var row = el('div', { class: 'dict-row tag-ai-row' }, [
          cb,
          el('code', { class: 'dict-k', text: g.canonical }),
          el('span', { class: 'field-hint', text: g.members.join(' / ') })
        ]);
        listBox.appendChild(row);
      });
      applyBtn.style.display = '';
    }

    function run() {
      if (running) return;
      running = true; startBtn.disabled = true; ICONS.apply(startBtn, ('\u23F3 分析中 …'));
      var tags = Object.keys(App.stats().tags).sort(function (a, b) { return App.stats().tags[b] - App.stats().tags[a]; }).slice(0, 200);
      if (!tags.length) { log('当前素材库没有标签可分析'); running = false; startBtn.disabled = false; ICONS.apply(startBtn, ('\u{1F916} 开始分析')); return; }
      AI.suggestConsolidations(tags, log).then(function (gs) {
        groups = gs;
        renderGroups();
        running = false; startBtn.disabled = false; ICONS.apply(startBtn, ('\u{1F916} 重新分析'));
      }).catch(function (e) {
        log('\u2716 ' + (e.message || e));
        running = false; startBtn.disabled = false; ICONS.apply(startBtn, ('\u{1F916} 开始分析'));
      });
    }

    function apply() {
      var rows = listBox.querySelectorAll('.tag-ai-row');
      var chosen = [];
      rows.forEach(function (row, i) {
        var cb = row.querySelector('input[type=checkbox]');
        if (cb && cb.checked && groups[i]) chosen.push(groups[i]);
      });
      if (!chosen.length) { Toast.warn('请先勾选要应用的合并建议'); return; }
      var map = Object.create(null);
      chosen.forEach(function (g) { g.members.forEach(function (m) { map[m] = g.canonical; }); });
      var changedAssets = 0;
      var list = App.assets.map(function (a) {
        var changed = false;
        ['tags', 'rawTags'].forEach(function (key) {
          var arr = a[key] || [];
          var next = uniq(arr.map(function (t) { return map[t] || t; }));
          if (next.join('|') !== arr.join('|')) { a[key] = next; changed = true; }
        });
        if (changed) changedAssets++;
        return a;
      });
      var dict = App.settings.userTagDict || {};
      Object.keys(map).forEach(function (m) { if (!dict[m]) dict[m] = map[m]; });
      App.settings.userTagDict = dict;
      Promise.all([Store.putAssets(list), App.saveSettings()]).then(function () {
        UI.renderAll();
        Toast.ok('已应用 ' + chosen.length + ' 组合并，更新 ' + changedAssets + ' 个素材');
        Modal.close(h);
      }).catch(function (e) { Toast.err('应用失败：' + (e.message || e)); });
    }
  },
  completeAllAssetsInfo: function () {
    var logBox = el('div', { class: 'fetch-log', style: { display: 'block' } });
    function log(m) { logBox.appendChild(el('div', { class: 'log-line', text: m })); logBox.scrollTop = logBox.scrollHeight; }
    var running = false;
    var startBtn = el('button', { class: 'btn btn-primary', onclick: run }, ICONS.label('\u{1F504} 开始补全'));
    var h = Modal.open({
      title: '批量补全所有素材信息', size: 'md',
      body: [
        el('div', { class: 'notice' }, [
          el('p', { text: '对每个有商店链接的素材重新抓取商品信息，只填写从未自动获取且用户未手改的空字段；闲鱼/好友分享/已下架素材自动跳过。如需强制覆盖，请到编辑页点「⚡ 强制使用获取信息」。' }),
          el('p', { text: '需要先在「设置 → 联网与宿主」选择「内置宿主联网」；宿主随程序启动，保持窗口运行即可。' })
        ]),
        logBox
      ],
      footer: [
        el('button', { class: 'btn', onclick: function () { Modal.close(h); } }, '关闭'),
        startBtn
      ]
    });

    function run() {
      if (running) return;
      if (!Net.networkAllowed()) {
        log('\u2716 当前为「手动粘贴源码」（不联网）。请先在「联网与宿主」中选择「内置宿主联网」，并启动内置宿主。');
        return;
      }
      running = true; startBtn.disabled = true; ICONS.apply(startBtn, ('\u23F3 补全中 …'));
      var targets = App.assets.filter(function (a) {
        // 闲鱼/好友分享不自动获取；已下架不再重复获取（用户可在编辑页手动重试）
        if (a.source === 'xianyu' || a.source === 'friend' || a.delisted) return false;
        return (a.links || []).some(function (l) { return isHttpUrl(l.url); });
      });
      var skippedAuto = App.assets.length - targets.length;
      if (!targets.length) { log('\u2716 没有需要补全的素材（闲鱼/好友分享/已下架素材会自动跳过）'); running = false; startBtn.disabled = false; ICONS.apply(startBtn, ('\u{1F504} 开始补全')); return; }
      if (skippedAuto > 0) log('\u26AA 已自动跳过 ' + skippedAuto + ' 条（闲鱼 / 好友分享 / 已下架）');
      log('共 ' + targets.length + ' 条素材需要补全，开始逐个处理（缓存命中会直接使用）…');
      var done = 0, updated = 0, failed = 0;
      var chain = Promise.resolve();
      targets.forEach(function (a) {
        chain = chain.then(function () {
          var url = (a.links || []).filter(function (l) { return isHttpUrl(l.url); })[0].url;
          var title = a.title || a.originalTitle || a.itemId || url;
          return Fetchers.fetchInfo(url, { onLog: function (m) { log('  [' + title + '] ' + m); } }).then(function (info) {
            if (!info || info.__failed) {
              var tried = (info && info.tried) || [];
              var gone = (info && (info.status === 404 || info.status === 410)) || tried.some(function (t) { return t && /HTTP (404|410)\b/.test(String(t.error || '')); });
              if (gone) {
                a.delisted = true;
                log('  [已下架] ' + title + ' 无法获取（404/410），已标记并跳过后续自动补全');
                return App.save(a).then(function () { failed++; });
              }
              failed++; return null;
            }
            var changed = false;
            a.autoFilled = a.autoFilled || {};
            function fill(key, val) {
              if (val == null || val === '' || (Array.isArray(val) && !val.length)) return;
              if (a.autoFilled[key]) return;   // 已自动获取过：正常批量补全不再覆盖
              if (key === 'title') { if (!a.title && val) { a.title = String(val).slice(0, 80); changed = true; a.autoFilled.title = true; } return; }
              if (!a[key] || (Array.isArray(a[key]) && !a[key].length)) { a[key] = val; changed = true; a.autoFilled[key] = true; }
            }
            fill('itemId', info.itemId);
            fill('author', info.author || info.shop);
            fill('shop', info.shop || info.author);
            fill('shopUrl', info.shopUrl);
            fill('description', info.description ? Smart.pickChinese(info.description) : '');
            // 商品价只读：BOOTH 用变体计算价（批量不解析变体时不写入），其他来源才存抓取到的商店价
            if (info.price && a.source !== 'booth') fill('shopPrice', info.price);
            var guess = Smart.guessCategory(info);
            if ((!a.category || a.category === 'other') && guess && guess !== 'other' && !a.autoFilled.category) { a.category = guess; a.autoFilled.category = true; changed = true; }
            if (info.tags && info.tags.length && !(a.tags || []).length && !a.autoFilled.tags) {
              var cleaned = Smart.filterBlacklist(Smart.purgeAvatarTags(info.tags));
              a.rawTags = Smart.filterBlacklist(Smart.purgeAvatarTags(info.tags));
              a.tags = App.settings.autoTranslateTags ? Smart.translateTags(cleaned) : cleaned;
              a.autoFilled.tags = true; a.autoFilled.raws = true; changed = true;
            }
            if (!(a.images || []).length && info.images && info.images.length && !a.autoFilled.images) { a.images = info.images.slice(); if (!a.coverURL) a.coverURL = info.coverURL || info.images[0]; a.autoFilled.images = true; changed = true; }
            if (!(a.versions || []).length && info.versions && info.versions.length && !a.autoFilled.versions) { a.versions = info.versions; a.autoFilled.versions = true; changed = true; }
            if (!(a.downloadLinks || []).length && info.downloadLinks && info.downloadLinks.length && !a.autoFilled.dls) { a.downloadLinks = info.downloadLinks; a.autoFilled.dls = true; changed = true; }
            fill('publishedAt', info.publishedAt);
            fill('shopUpdatedAt', info.shopUpdatedAt);
            if (info.r18 === true && !(a.extra && a.extra.r18)) { a.extra = a.extra || {}; a.extra.r18 = true; changed = true; }
            else if (info.r18 === false && (a.extra && a.extra.r18)) { delete a.extra.r18; changed = true; }
            if (!(a.links || []).some(function (l) { return l.url === url; })) { a.links = (a.links || []).concat([{ url: url, label: hostOf(url) }]); changed = true; }
            if (changed) { updated++; return App.save(a); }
            return null;
          }).then(function (saved) {
            done++;
            if ((done % 5) === 0 || done === targets.length) log('进度 ' + done + ' / ' + targets.length + '（已更新 ' + updated + ' 条）');
          }).catch(function (e) { done++; failed++; log('  [失败] ' + (e && e.message ? e.message : e)); });
        });
      });
      chain.then(function () {
        UI.renderAll();
        log('\u2714 补全完成：处理 ' + done + ' 条，更新 ' + updated + ' 条，失败 ' + failed + ' 条');
        Toast.ok('批量补全完成：更新 ' + updated + ' 条');
        running = false; startBtn.disabled = false; ICONS.apply(startBtn, ('\u{1F504} 开始补全'));
      });
    }
  },

  /* ---------------- 分类与角色 ---------------- */
    /* ---------------- 分类 / 来源 / 角色 ---------------- */
  tab_dict: function () {
    var box = el('div', { class: 'settings-pane' });

    function saveAvatarOrder(list) {
      App.settings.avatarOrder = list.map(function (x) { return x.id; });
      return App.saveSettings();
    }
    // 分类/来源：取消手动重排，顺序与左侧栏一致（来源按数量降序；分类按数量降序、「其他」最后）
    function sidebarOrdered(kind) {
      var st = App.stats();
      var list = (kind === 'cat' ? App.allCategories() : App.allSources()).slice();
      return list.sort(function (a, b) {
        var ca = kind === 'cat' ? (st.categories[a.id] || 0) : (st.sources[a.id] || 0);
        var cb = kind === 'cat' ? (st.categories[b.id] || 0) : (st.sources[b.id] || 0);
        if (kind === 'cat') {
          if (a.id === 'other') return 1;
          if (b.id === 'other') return -1;
        }
        return cb - ca;
      });
    }

    /* 分类 / 来源：左侧栏式 chips（仅图标 + 名称；自定义项带删除按钮；新增弹窗带图标设置） */
    function chipsEditor(title, kind) {
      var wrap = el('div', { class: 'dict-block' });
      wrap.appendChild(el('h3', { text: title }));
      var chipsBody = el('div', { class: 'side-group-body' });
      var chipsWrap = el('div', { class: 'side-group chips-group settings-chips' }, [chipsBody]);
      function isCustom(c) { return /^(cat|src)_/.test(c.id); }
      function deleteCustom(c) {
        Modal.confirm('删除自定义' + (kind === 'cat' ? '分类' : '来源') + '「' + c.label + '」？已有素材会保留原 id。', { okText: '删除' }).then(function (ok) {
          if (!ok) return;
          var key = kind === 'cat' ? 'customCategories' : 'customSources';
          var arr = App.settings[key] || [];
          App.settings[key] = arr.filter(function (x) { return x.id !== c.id; });
          App.saveSettings().then(function () { render(); UI.renderAll(); });
        });
      }
      function render() {
        chipsBody.innerHTML = '';
        sidebarOrdered(kind).forEach(function (c) {
          chipsBody.appendChild(el('div', { class: 'side-item' }, [
            App.icon(kind, c.id, { size: 14, class: 'side-ico' }),
            el('span', { class: 'side-item-label', text: c.label }),
            isCustom(c) ? el('button', { class: 'chip-x', title: '删除该' + (kind === 'cat' ? '分类' : '来源'), onclick: function () { deleteCustom(c); } }, ICONS.label('\u{1F5D1}')) : null
          ]));
        });
      }
      function addCustom() {
        var nameIn = el('input', { class: 'input', placeholder: '中文显示名（必填）' });
        var iconIn = el('input', { class: 'input input-sm', placeholder: 'Emoji 或图片 URL（留空用默认图标）' });
        var preview = el('span', { class: 'icon-preview' });
        function refreshPreview() {
          preview.innerHTML = '';
          var v = iconIn.value.trim();
          if (/^https?:\/\//i.test(v) || /^data:/i.test(v)) {
            var img = el('img', { src: v, style: { width: '18px', height: '18px', objectFit: 'contain' } });
            img.onerror = function () { ICONS.apply(preview, ('\u274C')); };
            preview.appendChild(img);
          } else if (v) {
            preview.textContent = v;
          } else {
            preview.appendChild(App.icon(kind, kind === 'cat' ? 'other' : 'unknown', { size: 18 }));
          }
        }
        iconIn.addEventListener('input', refreshPreview);
        refreshPreview();
        var h = Modal.open({
          title: '新增' + (kind === 'cat' ? '分类' : '来源'), size: 'sm',
          body: [Field.row('名称', nameIn), Field.row('图标', el('div', { class: 'inline-row' }, [iconIn, preview]))],
          footer: [
            el('button', { class: 'btn', onclick: function () { Modal.close(h); } }, '取消'),
            el('button', { class: 'btn btn-primary', onclick: function () {
              var label = nameIn.value.trim();
              if (!label) { Toast.warn('请填写名称'); return; }
              var key = kind === 'cat' ? 'customCategories' : 'customSources';
              var arr = App.settings[key] || [];
              var iv = iconIn.value.trim();
              var isURL = /^https?:\/\//i.test(iv) || /^data:/i.test(iv);
              arr.push({
                id: (kind === 'cat' ? 'cat' : 'src') + '_' + Date.now().toString(36),
                label: label,
                icon: iv ? (isURL ? (kind === 'cat' ? 'other' : 'unknown') : iv) : (kind === 'cat' ? 'other' : 'unknown'),
                iconURL: isURL ? iv : ''
              });
              App.settings[key] = arr;
              App.saveSettings().then(function () { Modal.close(h); render(); UI.renderAll(); });
            } }, '添加')
          ]
        });
      }
      render();
      wrap.appendChild(chipsWrap);
      wrap.appendChild(el('div', { class: 'btn-row' }, [
        el('button', { class: 'btn btn-sm', onclick: addCustom }, ICONS.label('\u2795 新增'))
      ]));
      return wrap;
    }

    /* 支持角色：搜索框 + 每条一行（序号 名称 {三语名} ↑↓ 编辑 删除） */
    function listEditor() {
      var wrap = el('div', { class: 'dict-block' });
      var LANG_PRIORITIES = [['label', '显示名（默认）'], ['zh', '中文'], ['ja', '日文'], ['en', '英文']];
      var curPriority = LANG_PRIORITIES.some(function (p) { return p[0] === App.settings.avatarNamePriority; })
        ? App.settings.avatarNamePriority : 'label';
      var langSel = el('select', { class: 'input input-sm', title: '优先显示语言', onchange: function () {
        App.settings.avatarNamePriority = langSel.value || 'label';
        App.saveSettings().then(function () { render(); UI.renderAll(); });
      } });
      LANG_PRIORITIES.forEach(function (p) {
        var o = el('option', { value: p[0] }, p[1]);
        if (p[0] === curPriority) o.selected = true;
        langSel.appendChild(o);
      });
      wrap.appendChild(el('div', { class: 'dict-head' }, [
        el('h3', { text: '支持角色（搜索 · 排序 · 中/日/英编辑删除）' }),
        el('div', { class: 'dict-actions' }, [el('span', { class: 'field-hint', text: '优先显示' }), langSel])
      ]));
      var searchIn = el('input', { class: 'input input-sm dict-search', placeholder: '搜索角色：中文 / 日文 / 英文 / 别名' });
      searchIn.addEventListener('input', function () { render(); });
      var listBox = el('div', { class: 'order-list' });
      var display = [];
            function preferredName(c) {
        var p = App.settings.avatarNamePriority || 'label';
        if (p === 'zh') return c.nameZh || c.label;
        if (p === 'ja') return c.nameJa || (c.alias || []).filter(function (x) { return /[\u3040-\u30FF]/.test(x); })[0] || c.label;
        if (p === 'en') return c.nameEn || (c.alias || []).filter(function (x) { return /^[A-Za-z]/.test(x); })[0] || c.label;
        return c.label;
      }
      function allNames(c) {
        return {
          zh: uniq([c.nameZh].concat(c.altZh || []).filter(Boolean)),
          ja: uniq([c.nameJa].concat(c.altJa || []).filter(Boolean)),
          en: uniq([c.nameEn].concat(c.altEn || []).filter(Boolean))
        };
      }
      function subText(c) {
        var n = allNames(c);
        var parts = [n.zh.join(' / '), n.ja.join(' / '), n.en.join(' / ')].filter(Boolean);
        return parts.length ? parts.join(' ／ ') : (c.alias || []).slice(0, 4).join(' / ');
      }
      function match(c) {
        var q = searchIn.value.trim().toLowerCase();
        if (!q) return true;
        return [c.label, c.nameZh, c.nameJa, c.nameEn]
          .concat(c.altZh || [], c.altJa || [], c.altEn || [], c.alias || [])
          .join(' ').toLowerCase().indexOf(q) >= 0;
      }      function render() {
        display = App.allAvatars().filter(match);
        listBox.innerHTML = '';
        if (!display.length) { listBox.appendChild(el('div', { class: 'multi-empty', text: '没有匹配的角色' })); return; }
        display.forEach(function (c, i) {
          var sub = subText(c);
          listBox.appendChild(el('div', { class: 'order-row' }, [
            el('span', { class: 'order-idx', text: String(i + 1) }),
            el('div', { class: 'order-main' }, [
              el('b', { text: preferredName(c) }),
              sub ? el('span', { class: 'order-sub', text: '{' + sub + '}' }) : null
            ]),
            el('button', { class: 'btn btn-xs', disabled: i === 0, title: '上移', onclick: function () { moveItem(i, -1); } }, ICONS.label('\u2191')),
            el('button', { class: 'btn btn-xs', disabled: i === display.length - 1, title: '下移', onclick: function () { moveItem(i, 1); } }, ICONS.label('\u2193')),
            el('button', { class: 'btn btn-xs', onclick: function () { editAvatar(c); } }, ICONS.label('\u270E 编辑')),
            el('button', { class: 'btn btn-xs btn-danger-ghost', onclick: function () { deleteAvatar(c); } }, ICONS.label('\u{1F5D1} 删除'))
          ]));
        });
      }
      function moveItem(itemIndex, dir) {
        var all = App.allAvatars();
        var target = display[itemIndex];
        var i = all.findIndex(function (x) { return x.id === target.id; });
        var j = i + dir;
        if (i < 0 || j < 0 || j >= all.length) return;
        var t = all[i]; all[i] = all[j]; all[j] = t;
        saveAvatarOrder(all).then(function () { render(); UI.renderAll(); });
      }
      function linesOf(v, extra) { return uniq([v].concat(extra || []).filter(Boolean)).join('\n'); }
      function parseLines(text) { return String(text || '').split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean); }
      function editAvatar(av) {
        var zhIn = el('textarea', { class: 'input textarea', rows: 3 });
        var jaIn = el('textarea', { class: 'input textarea', rows: 3 });
        var enIn = el('textarea', { class: 'input textarea', rows: 3 });
        zhIn.value = linesOf(av.nameZh || av.label, av.altZh);
        jaIn.value = linesOf(av.nameJa || (av.alias || []).filter(function (x) { return /[\u3040-\u30FF]/.test(x); })[0], av.altJa);
        enIn.value = linesOf(av.nameEn || (av.alias || []).filter(function (x) { return /^[A-Za-z]/.test(x); })[0], av.altEn);
        var h = Modal.open({
          title: '编辑角色（中 / 日 / 英，每行一个备选）', size: 'sm',
          body: [Field.row('中文名（每行一个）', zhIn), Field.row('日文名（每行一个）', jaIn), Field.row('英文名（每行一个）', enIn)],
          footer: [
            el('button', { class: 'btn', onclick: function () { Modal.close(h); } }, '取消'),
            el('button', { class: 'btn btn-primary', onclick: function () {
              var zhL = parseLines(zhIn.value), jaL = parseLines(jaIn.value), enL = parseLines(enIn.value);
              if (!zhL.length) { Toast.warn('请至少填写一个中文名'); return; }
              var v = {
                label: zhL[0] || av.label, nameZh: zhL[0], nameJa: jaL[0] || '', nameEn: enL[0] || '',
                altZh: zhL.slice(1), altJa: jaL.slice(1), altEn: enL.slice(1)
              };
              v.alias = uniq([v.nameZh, v.nameJa, v.nameEn, v.label].concat(v.altZh, v.altJa, v.altEn).filter(Boolean));
              var customs = App.settings.customAvatars || [];
              var idx = customs.findIndex(function (x) { return x.id === av.id; });
              if (idx >= 0) {
                customs[idx].label = v.label; customs[idx].nameZh = v.nameZh; customs[idx].nameJa = v.nameJa; customs[idx].nameEn = v.nameEn;
                customs[idx].altZh = v.altZh; customs[idx].altJa = v.altJa; customs[idx].altEn = v.altEn;
                customs[idx].alias = v.alias;
              } else {
                App.settings.avatarOverrides = App.settings.avatarOverrides || {};
                App.settings.avatarOverrides[av.id] = v;
              }
              App.saveSettings().then(function () { Modal.close(h); render(); UI.renderAll(); Toast.ok('已保存角色三语备选'); });
            } }, '保存')
          ]
        });
      }      function deleteAvatar(av) {
        var customs = App.settings.customAvatars || [];
        var idx = customs.findIndex(function (x) { return x.id === av.id; });
        Modal.confirm('删除角色「' + av.label + '」？相关素材的支持角色记录将保留。', { okText: '删除' }).then(function (ok) {
          if (!ok) return;
          if (idx >= 0) { customs.splice(idx, 1); }
          else { App.settings.deletedAvatars = uniq((App.settings.deletedAvatars || []).concat([av.id])); }
          App.saveSettings().then(function () { render(); UI.renderAll(); });
        });
      }
      function avatarText(av) {
        var sub = subText(av);
        return av.label + (sub ? '（' + sub + '）' : '');
      }
      function mergeAvatar() {
        var qIn = el('input', { class: 'input', placeholder: '输入要合并角色的中 / 日 / 英任一名称' });
        var matchBox = el('div', { class: 'order-list' });
        var targetSel = el('select', { class: 'input' });
        var sourceId = '';
        function refreshTargets() {
          var old = targetSel.value;
          targetSel.innerHTML = '';
          App.allAvatars().filter(function (av) { return av.id !== sourceId; }).forEach(function (av) {
            targetSel.appendChild(el('option', { value: av.id, selected: av.id === old }, avatarText(av)));
          });
        }
        function refreshMatches(keepSel) {
          matchBox.innerHTML = '';
          if (!keepSel) sourceId = '';
          var q = qIn.value.trim().toLowerCase();
          if (!q) {
            matchBox.appendChild(el('div', { class: 'multi-empty', text: '输入名称后显示匹配结果' }));
            refreshTargets();
            return;
          }
          var hits = App.allAvatars().filter(function (av) {
            return [av.label, av.nameZh, av.nameJa, av.nameEn].concat(av.alias || []).join(' ').toLowerCase().indexOf(q) >= 0;
          });
          if (!hits.length) {
            matchBox.appendChild(el('div', { class: 'multi-empty', text: '没有匹配的角色' }));
          }
          hits.forEach(function (av) {
            var sel = av.id === sourceId;
            var b = el('button', {
              class: 'btn btn-xs merge-pick' + (sel ? ' active' : ''),
              onclick: function () { sourceId = av.id; refreshMatches(true); refreshTargets(); }
            }, ICONS.label((sel ? '\u2713 已选中：' : '') + avatarText(av)));
            matchBox.appendChild(b);
          });
          refreshTargets();
        }
        qIn.addEventListener('input', function () { refreshMatches(); });
        refreshMatches();
        var h = Modal.open({
          title: '合并角色', size: 'sm',
          body: [
            Field.row('要合并的角色（输入中/日/英任一）', qIn),
            Field.row('匹配结果（点选一个）', matchBox),
            Field.row('合并到目标角色', targetSel)
          ],
          footer: [
            el('button', { class: 'btn', onclick: function () { Modal.close(h); } }, '取消'),
            el('button', { class: 'btn btn-primary', onclick: function () {
              if (!sourceId) { Toast.warn('请先从匹配结果里选择一个要合并的角色'); return; }
              var targetId = targetSel.value;
              if (!targetId || targetId === sourceId) { Toast.warn('请选择不同的目标角色'); return; }
              App.mergeAvatarRoles(sourceId, targetId).then(function (r) {
                Modal.close(h); render(); UI.renderAll();
                Toast.ok('已合并角色，更新了 ' + r.changed + ' 个素材');
              });
            } }, '合并')
          ]
        });
      }
      function cleanupZeroRoles() {
        var counts = App.stats().avatars || {};
        var zero = (App.settings.customAvatars || []).filter(function (c) {
          return !AVATARS.some(function (b) { return b.id === c.id; }) && (counts[c.id] || 0) === 0;
        });
        if (!zero.length) { Toast.info('没有 0 匹配的自定义角色'); return; }
        Modal.confirm('将删除 ' + zero.length + ' 个没有被任何素材引用的自定义角色：' + zero.map(function (c) { return c.label; }).join('、'), {
          okText: ICONS.label('\u{1F9F9} 清理'), title: '清理 0 匹配角色'
        }).then(function (ok) {
          if (!ok) return;
          var ids = zero.map(function (c) { return c.id; });
          App.settings.customAvatars = (App.settings.customAvatars || []).filter(function (c) { return ids.indexOf(c.id) < 0; });
          App.saveSettings().then(function () { render(); UI.renderAll(); Toast.ok('已清理 ' + ids.length + ' 个 0 匹配角色'); });
        });
      }
      render();
      wrap.appendChild(searchIn);
      wrap.appendChild(listBox);
      wrap.appendChild(el('div', { class: 'btn-row' }, [
        el('button', { class: 'btn btn-sm', title: '删除没有被任何素材引用的自定义角色', onclick: cleanupZeroRoles }, ICONS.label('\u{1F9F9} 清理 0 匹配角色')),
        el('button', { class: 'btn btn-sm', onclick: mergeAvatar }, ICONS.label('\u{1F500} 合并角色')),
        el('button', { class: 'btn btn-sm', onclick: function () {
          var zhIn = el('textarea', { class: 'input textarea', rows: 3, placeholder: '中文名（必填，每行一个）' });
          var jaIn = el('textarea', { class: 'input textarea', rows: 3, placeholder: '日文名（每行一个）' });
          var enIn = el('textarea', { class: 'input textarea', rows: 3, placeholder: '英文名（每行一个）' });
          var h = Modal.open({
            title: '新增角色（中 / 日 / 英，每行一个备选）', size: 'sm',
            body: [Field.row('中文名（每行一个）', zhIn), Field.row('日文名（每行一个）', jaIn), Field.row('英文名（每行一个）', enIn)],
            footer: [
              el('button', { class: 'btn', onclick: function () { Modal.close(h); } }, '取消'),
              el('button', { class: 'btn btn-primary', onclick: function () {
                var zhL = parseLines(zhIn.value), jaL = parseLines(jaIn.value), enL = parseLines(enIn.value);
                if (!zhL.length) { Toast.warn('请至少填写一个中文名'); return; }
                var all = uniq([zhL[0], jaL[0] || '', enL[0] || ''].concat(zhL.slice(1), jaL.slice(1), enL.slice(1)).filter(Boolean));
                App.settings.customAvatars.push({
                  id: 'av_' + Date.now().toString(36), label: zhL[0],
                  nameZh: zhL[0], nameJa: jaL[0] || '', nameEn: enL[0] || '',
                  altZh: zhL.slice(1), altJa: jaL.slice(1), altEn: enL.slice(1),
                  alias: all
                });
                App.saveSettings().then(function () { Modal.close(h); render(); UI.renderAll(); });
              } }, '添加')
            ]
          });
        } }, ICONS.label('\u2795 新增角色'))
      ]));
      return wrap;
    }

    /* 待确认角色：解析发现但尚未批准的新角色，用户在此统一批准 / 忽略 */
    function pendingEditor() {
      var wrap = el('div', { class: 'dict-block' });
      var head = el('div', { class: 'dict-head' }, [el('h3', { text: '待确认角色（解析到但未收录）' })]);
      var listBox = el('div', { class: 'order-list' });
      function renderPending() {
        var list = App.settings.pendingAvatars || [];
        head.querySelector('h3').textContent = '待确认角色（解析到但未收录' + (list.length ? ' · ' + list.length + ' 个）' : '）');
        listBox.innerHTML = '';
        if (!list.length) {
          listBox.appendChild(el('div', { class: 'multi-empty', text: '暂无待确认角色。解析商品时发现的新角色会先暂存在这里，由你确认后才会加入支持角色列表。' }));
          return;
        }
        list.forEach(function (p, i) {
          var sub = [p.nameZh, p.nameJa, p.nameEn].filter(Boolean).join(' ／ ');
          listBox.appendChild(el('div', { class: 'order-row' }, [
            el('span', { class: 'order-idx', text: String(i + 1) }),
            el('div', { class: 'order-main' }, [
              el('b', { text: p.label }),
              sub ? el('span', { class: 'order-sub', text: '{' + sub + '}' }) : null
            ]),
            el('button', {
              class: 'btn btn-xs btn-primary', onclick: function () {
                var names = [p.nameEn, p.nameJa, p.nameZh, p.label].concat(p.alias || []).filter(Boolean);
                var low = names.map(function (n) { return String(n).toLowerCase(); });
                var target = App.allAvatars().find(function (av) {
                  return [av.label, av.nameZh, av.nameJa, av.nameEn].concat(av.alias || [])
                    .some(function (n) { return low.indexOf(String(n || '').trim().toLowerCase()) >= 0; });
                });
                if (!target) {
                  target = {
                    id: 'av_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
                    label: p.nameEn || p.nameJa || p.nameZh || p.label,
                    nameZh: p.nameZh || '', nameJa: p.nameJa || '', nameEn: p.nameEn || '',
                    alias: names
                  };
                  App.settings.customAvatars.push(target);
                }
                App.settings.pendingAvatars = (App.settings.pendingAvatars || []).filter(function (x) { return x.id !== p.id; });
                App.saveSettings().then(function () {
                  var changed = [];
                  App.assets.forEach(function (a) {
                    if (a.category === 'avatar') return;
                    var hay = [a.title, a.originalTitle, a.description].concat(a.tags || [], a.rawTags || []).join(' ').toLowerCase();
                    var hit = names.some(function (n) { return n && n.length >= 2 && hay.indexOf(String(n).toLowerCase()) >= 0; });
                    if (hit && (a.avatars || []).indexOf(target.id) < 0) {
                      a.avatars = uniq((a.avatars || []).concat([target.id]));
                      if (changed.indexOf(a) < 0) changed.push(a);
                    }
                  });
                  var next = changed.length ? Store.putAssets(changed) : Promise.resolve(null);
                  return next.then(function () {
                    renderPending(); UI.renderAll();
                    Toast.ok('已批准角色：' + target.label + (changed.length ? '，并关联了 ' + changed.length + ' 个素材' : ''));
                  });
                });
              }
            }, ICONS.label('\u2713 批准')),
            el('button', {
              class: 'btn btn-xs', onclick: function () {
                App.settings.pendingAvatars = (App.settings.pendingAvatars || []).filter(function (x) { return x.id !== p.id; });
                App.saveSettings().then(function () { renderPending(); Toast.ok('已忽略：' + p.label); });
              }
            }, '忽略')
          ]));
        });
      }
      renderPending();
      wrap.appendChild(head);
      wrap.appendChild(listBox);
      return wrap;
    }

    box.appendChild(chipsEditor('分类（与左侧栏同序）', 'cat'));
    box.appendChild(chipsEditor('来源（与左侧栏同序）', 'src'));
    box.appendChild(listEditor());
    box.appendChild(pendingEditor());
    return box;
  },
/* ---------------- 图标 ---------------- */
  tab_icons: function () {
    var box = el('div', { class: 'settings-pane' });
    box.appendChild(el('div', { class: 'notice' }, [
      el('p', { text: '内置图标为本项目自绘的线性 SVG（Gumroad 图标来自 Simple Icons，CC0 公共领域），全部内联在单文件中、随主题自动变色。你也可以为任意分类 / 来源换成自己的图标：填 Emoji 直接生效，填图片 URL（或 data: 开头的 Base64）则显示该图片。' })
    ]));

    function grid(title, kind, list) {
      var wrap = el('div', { class: 'dict-block' });
      wrap.appendChild(el('h3', { text: title }));
      var g = el('div', { class: 'icon-grid' });
      list.forEach(function (c) {
        var key = kind + ':' + c.id;
        var preview = el('div', { class: 'icon-preview' });
        function refresh() {
          preview.innerHTML = '';
          preview.appendChild(App.icon(kind, c.id, { size: 24 }));
        }
        refresh();
        var input = el('input', {
          class: 'input input-sm', value: (App.settings.customIcons || {})[key] || '',
          placeholder: 'Emoji 或图片 URL',
          onchange: function () {
            var v = input.value.trim();
            App.settings.customIcons = App.settings.customIcons || {};
            if (v) App.settings.customIcons[key] = v; else delete App.settings.customIcons[key];
            App.saveSettings().then(function () { refresh(); UI.renderAll(); });
          }
        });
        g.appendChild(el('div', { class: 'icon-cell' }, [
          preview,
          el('div', { class: 'icon-cell-body' }, [
            el('div', { class: 'icon-cell-name', text: c.label }),
            input
          ]),
          el('button', {
            class: 'btn btn-xs', title: '恢复内置图标', onclick: function () {
              delete (App.settings.customIcons || {})[key];
              input.value = '';
              App.saveSettings().then(function () { refresh(); UI.renderAll(); });
            }
          }, ICONS.label('\u21BA'))
        ]));
      });
      wrap.appendChild(g);
      return wrap;
    }

    box.appendChild(grid('来源图标', 'src', App.allSources()));
    box.appendChild(grid('分类图标', 'cat', App.allCategories()));

    box.appendChild(el('h3', { text: '想换成官方 / 更好看的图标？' }));
    box.appendChild(el('p', { class: 'field-hint', text: '下面是可直接使用的检索关键词与 AI 生成提示词。拿到图片后，把它的 URL 或 Base64（data:image/png;base64,…）填进上面的输入框即可。' }));
    var kw = [
      ['BOOTH', 'booth.pm favicon / "BOOTH pixiv logo svg" / https://booth.pm/favicon.ico'],
      ['Gumroad', '"gumroad logo svg" / simpleicons.org/?q=gumroad（CC0，可直接商用）'],
      ['闲鱼', '"闲鱼 logo svg" / "goofish logo png" / https://www.goofish.com/favicon.ico'],
      ['通用图标库', 'simpleicons.org（品牌图标，CC0）、lucide.dev、tabler-icons.io、iconify.design（均可免费商用）'],
      ['获取网站图标', 'https://www.google.com/s2/favicons?domain=booth.pm&sz=64（直接当图片 URL 填入即可）']
    ];
    box.appendChild(el('div', { class: 'kv-list' }, kw.map(function (k) {
      return el('div', { class: 'kv' }, [el('div', { class: 'kv-k', text: k[0] }), el('div', { class: 'kv-v mono', text: k[1] })]);
    })));

    box.appendChild(el('h3', { text: 'AI 生成提示词（可直接复制给 ChatGPT / 即梦 / Midjourney）' }));
    var prompt = '为一个 VRChat 改模素材管理工具设计一套图标，共 11 个：衣装、发型、配饰、功能组件、着色器、纹理贴图、工具、身体部件、角色模型、世界场景、其他。\n' +
      '要求：扁平线性风格（line icon），2px 均匀描边，圆角线帽，24x24 网格，无填充、无渐变、无阴影，单色（使用 currentColor），视觉重量一致，透明背景，输出 SVG。\n' +
      '风格参考：Lucide / Feather Icons。每个图标语义清晰，缩到 16px 仍可辨认。';
    var pre = el('pre', { class: 'tree-pre', text: prompt });
    box.appendChild(pre);
    box.appendChild(el('button', {
      class: 'btn btn-sm', onclick: function () { copyText(prompt).then(function () { Toast.ok('提示词已复制'); }); }
    }, ICONS.label('\u{1F4CB} 复制提示词')));
    return box;
  },

  /* ---------------- AI 翻译（DeepSeek） ---------------- */
  tab_ai: function () {
    var box = el('div', { class: 'settings-pane' });
    box.appendChild(el('div', { class: 'notice' }, [
      el('b', { text: 'DeepSeek AI 翻译（标签 / 简介 / 标题汉化）' }),
      el('p', { text: 'API Key 仅保存在本机（AES-GCM 加密，永不随备份导出，可一键清除）。只有在你点击「AI 翻译」时，选中的文本才会发送给 DeepSeek 官方接口；请求由内置宿主直连官方接口，不经过任何代理。宿主离线时网页其他功能不受影响，仅 AI 翻译暂不可用。' })
    ]));

    var keyIn = el('input', {
      class: 'input mono', type: 'password', placeholder: 'sk-…（在 platform.deepseek.com/api_keys 申请）',
      autocomplete: 'new-password'
    });
    AI.getApiKey().then(function (k) {
      if (k) { keyIn.value = k.slice(0, 8) + '…' + k.slice(-4); keyIn.dataset.saved = '1'; }
    });
    keyIn.addEventListener('focus', function () { if (keyIn.dataset.saved === '1') { keyIn.value = ''; keyIn.dataset.saved = ''; } });

    var modelSel = el('select', { class: 'input', onchange: function () {
      App.settings.ai = App.settings.ai || {};
      App.settings.ai.model = modelSel.value; App.saveSettings();
    } }, [
      el('option', { value: 'deepseek-flash', selected: (App.settings.ai || {}).model !== 'deepseek-v4-pro' }, 'deepseek-flash（快，适合批量标签）'),
      el('option', { value: 'deepseek-v4-pro',   selected: (App.settings.ai || {}).model === 'deepseek-v4-pro' }, 'deepseek-v4-pro（质量更高）')
    ]);

    box.appendChild(Field.row('API Key', keyIn, '输入框只回显前 8 位与后 4 位；保存后本页不再显示完整 Key（本机加密存储）'));
    box.appendChild(el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn btn-sm btn-primary', onclick: function () {
        /* v4.3.2：输入框里显示的是「前 8 位…后 4 位」的掩码。用户不点输入框直接按保存，
         * 存进去的就是这串掩码 —— 界面提示"已加密保存"，之后所有翻译 401，原 Key 还找不回来。 */
        if (keyIn.dataset.saved === '1') {
          Toast.info('API Key 未修改。要换新的，请先点一下输入框再粘贴（现在框里显示的是掩码）。', 6000);
          return;
        }
        var v = keyIn.value.trim();
        if (!v) { Toast.warn('请先粘贴 API Key'); return; }
        AI.setApiKey(v).then(function () { keyIn.value = v.slice(0, 8) + '…' + v.slice(-4); keyIn.dataset.saved = '1'; Toast.ok('已加密保存 API Key'); });
      } }, ICONS.label('\u{1F512} 保存（本机加密）')),
      el('button', { class: 'btn btn-sm btn-danger-ghost', onclick: function () {
        AI.clearApiKey().then(function () { keyIn.value = ''; keyIn.dataset.saved = ''; Toast.ok('已清除 API Key'); });
      } }, ICONS.label('\u{1F5D1} 清除 Key'))
    ]));
    box.appendChild(Field.row('模型', modelSel));
    /* v2.5.15（借鉴 kiss-translator 的可配置 httpTimeout）：AI 请求超时做成设置项。
     * 秒为单位（>600 视为历史毫秒写法，自动归一化）；限幅 10~600 秒。 */
    var tmoIn = el('input', {
      class: 'input', type: 'number', min: '10', max: '600', step: '10',
      value: String(Math.round((AI.httpTimeoutMs ? AI.httpTimeoutMs() : 120000) / 1000))
    });
    tmoIn.addEventListener('change', function () {
      App.settings.ai = App.settings.ai || {};
      var v = Number(tmoIn.value);
      if (!isFinite(v) || v <= 0) v = 120;
      v = Math.max(10, Math.min(600, Math.round(v)));
      App.settings.ai.httpTimeout = v;
      tmoIn.value = String(v);
      App.saveSettings();
      Toast.ok('AI 请求超时已设为 ' + v + ' 秒');
    });
    box.appendChild(Field.row('请求超时（秒）', tmoIn, 'AI 翻译单次请求的等待上限（默认 120 秒，10~600）。宿主在线时会走流式：只要还在持续接收就不会被掐断。'));
    var autoTagsCb = el('input', { type: 'checkbox', checked: !!App.settings.aiAutoTags, onchange: function () {
      App.settings.aiAutoTags = autoTagsCb.checked; App.saveSettings();
    } });
    box.appendChild(el('label', { class: 'check check-row' }, [autoTagsCb, el('span', { text: '导入 / 解析素材时自动用 AI 翻译未命中的标签（会消耗 API 额度）' })]));

    var hostStatus = el('div', { class: 'field-hint', text: '正在检测内置宿主 …' });
    FS.hostEnsure().then(function (ok) {
      ICONS.apply(hostStatus, ok ? '\u2714 内置宿主在线：AI 请求由宿主直连 DeepSeek 官方接口。' : ICONS.label('\u26A0 内置宿主离线：AI 翻译暂不可用，请启动内置宿主。'));
    });
    box.appendChild(hostStatus);

    box.appendChild(el('h3', { text: '模糊搜索词表（近义词 / 俗称 / 常见错拼）' }));
    box.appendChild(el('p', { class: 'field-hint', text: '把当前的标签词典、支持角色（三语名与别名）、分类名、来源名发给 DeepSeek，生成一张用于扩展搜索的词表；搜索框右侧的「模糊搜索」开关打开后生效。词表只存在本机设置里，搜索过程本身不联网。' }));
    var fuzzyInfo = el('div', { class: 'field-hint' });
    function renderFuzzyInfo() {
      var d = App.settings.fuzzyDict || {};
      var keys = Object.keys(d), w = 0;
      keys.forEach(function (k) { w += (d[k] || []).length; });
      var src = AI.fuzzySourceTerms().length;
      fuzzyInfo.textContent = '开关状态：' + (App.settings.fuzzySearch ? '已开启' : '已关闭') + '；可用词源 ' + src + ' 条；'
        + (keys.length ? ('当前词表 ' + keys.length + ' 个词条 / ' + w + ' 个扩展词') : '当前还没有词表');
    }
    renderFuzzyInfo();
    var fuzzyLog = el('div', { class: 'fetch-log', style: { display: 'none' } });
    function fuzzyLogLine(m) { fuzzyLog.style.display = ''; fuzzyLog.appendChild(el('div', { class: 'log-line', text: m })); fuzzyLog.scrollTop = fuzzyLog.scrollHeight; }
    var genFuzzyBtn = el('button', { class: 'btn btn-sm btn-primary' }, ICONS.label('\u{1F9E0} 生成 / 更新词表'));
    genFuzzyBtn.onclick = function () {
      genFuzzyBtn.disabled = true; ICONS.apply(genFuzzyBtn, ('\u23F3 生成中 …'));
      AI.generateFuzzyDict(fuzzyLogLine).then(function (n) {
        renderFuzzyInfo(); Toast.ok('模糊搜索词表已更新：' + n + ' 个词条');
      }).catch(function (e) {
        Toast.err('生成失败：' + (e && e.message));
      }).then(function () { genFuzzyBtn.disabled = false; ICONS.apply(genFuzzyBtn, ('\u{1F9E0} 生成 / 更新词表')); });
    };
    box.appendChild(el('div', { class: 'btn-row' }, [
      genFuzzyBtn,
      el('button', { class: 'btn btn-sm btn-danger-ghost', onclick: function () {
        App.settings.fuzzyDict = {}; App.fuzzyIndexCache = null; App.saveSettings(); renderFuzzyInfo(); Toast.ok('已清空词表');
      } }, ICONS.label('\u{1F5D1} 清空词表'))
    ]));
    box.appendChild(fuzzyInfo);
    box.appendChild(fuzzyLog);

    box.appendChild(el('h3', { text: '批量翻译标签' }));
    var pendingBox = el('div', { class: 'chip-wrap' });
    function renderPending() {
      pendingBox.innerHTML = '';
      var pending = AI.pendingTags();
      if (!pending.length) { pendingBox.appendChild(el('span', { class: 'multi-empty', text: '当前没有待翻译的标签。' })); return; }
      pending.slice(0, 40).forEach(function (t) { pendingBox.appendChild(el('span', { class: 'tag tag-untrans' }, t)); });
      if (pending.length > 40) pendingBox.appendChild(el('span', { class: 'field-hint', text: '… 共 ' + pending.length + ' 条' }));
    }
    renderPending();
    box.appendChild(pendingBox);

    var logBox = el('div', { class: 'fetch-log', style: { display: 'none' } });
    function log(m) { logBox.style.display = ''; logBox.appendChild(el('div', { class: 'log-line', text: m })); logBox.scrollTop = logBox.scrollHeight; }

    box.appendChild(el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn btn-sm btn-primary', onclick: function () { run(); } }, ICONS.label('\u{1F916} 翻译所有待翻译标签')),
      el('button', { class: 'btn btn-sm', onclick: function () {
        Settings.applyDictToAssets();
      } }, ICONS.label('\u{1F504} 翻译后用词典刷新全部素材标签'))
    ]));
    box.appendChild(logBox);

    function run() {
      logBox.innerHTML = ''; logBox.style.display = '';
      var pending = AI.pendingTags();
      if (!pending.length) { Toast.info('没有待翻译的标签'); return; }
      AI.translateItems(pending, log).then(function (r) {
        return AI.mergeTagResults(r.results).then(function (added) {
          log('\u2714 新增 / 更新词典 ' + added + ' 条，未翻译 ' + r.untranslated.length + ' 条');
          Toast.ok('AI 翻译完成：词典新增 ' + added + ' 条');
          renderPending();
        });
      }).catch(function (e) {
        log('\u2716 ' + (e.message || e));
        Toast.err(e.message || '翻译失败');
      });
    }

    box.appendChild(el('h3', { text: '缓存' }));
    var cacheInfo = el('span', { class: 'field-hint', text: '统计中…' });
    AI.cacheCount().then(function (n) { cacheInfo.textContent = '当前缓存：' + n + ' 条（同一文本不会重复调用）'; });
    box.appendChild(el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn btn-sm', onclick: function () { AI.cacheClear().then(function () { cacheInfo.textContent = '当前缓存：0 条'; }); } }, ICONS.label('\u{1F5D1} 清空翻译缓存')),
      cacheInfo
    ]));

    box.appendChild(el('h3', { text: '数据流向（透明化）' }));
    box.appendChild(el('pre', { class: 'tree-pre', text:
      '素材库页面（点击「AI 翻译」）\n' +
      '   \u2193 选中的标签 / 简介文本\n' +
      '内置宿主（127.0.0.1，唯一通道）\n' +
      '   \u2193 POST（Authorization: Bearer <本机解密出的 Key>）\n' +
      'https://api.deepseek.com/chat/completions\n' +
      '   \u2193 返回中文翻译\n' +
      '本机 vrclib-data\\settings.json（个人词典）+ 浏览器 IndexedDB（翻译缓存）\n\n' +
      'Key 永不写入备份文件；不经过任何代理。'
    }));

    return box;
  },

  /* ---------------- 本地库与整理 ---------------- */
  tab_library: function () {
    var box = el('div', { class: 'settings-pane' });
    box.appendChild(el('div', { class: 'notice' }, [
      el('p', { text: '纯网页环境受浏览器安全策略限制，无法直接读写任意磁盘位置。本工具提供两条路径：①（推荐，Chrome/Edge）授权一个「素材库根目录」，即可直接在其中创建分类文件夹；②生成目录结构与批处理脚本，由你在资源管理器中执行。' })
    ]));

    var status = el('div', { class: 'field-hint' }, ICONS.label(FS.supported() ? '\u2714 当前浏览器支持文件系统访问 API' : '\u26A0 当前浏览器不支持文件系统访问 API（请使用 Chrome / Edge）'));
    box.appendChild(status);

    var hostStatus = el('div', { class: 'field-hint', text: '内置宿主：正在检测…' });
    box.appendChild(hostStatus);
    FS.hostEnsure().then(function (ok) {
      ICONS.apply(hostStatus, ok ? '\u2714 内置宿主已连接（文件操作将由宿主执行）' : ICONS.label('\u26A0 内置宿主未就绪：请重启程序（可用原生对话框选路径、整项移动/复制）'));
    }).catch(function () {
      ICONS.apply(hostStatus, ('\u26A0 内置宿主检测失败'));
    });
    box.appendChild(el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn btn-sm', onclick: function () {
        hostStatus.textContent = '内置宿主：正在检测…';
        FS.hostEnsure().then(function (ok) {
          ICONS.apply(hostStatus, ok ? '\u2714 内置宿主已连接（文件操作将由宿主执行）' : ICONS.label('\u26A0 内置宿主未就绪：请重启程序'));
        });
      } }, ICONS.label('\u{1F504} 重新检测宿主'))
    ]));

    // v2.5.1（L4）：原来写「尚未选择素材库根目录」，而下面的输入框里显示着默认路径——看着自相矛盾
var rootInfo = el('div', { class: 'kv-v', text: App.settings.libraryRootName ? '已授权目录：' + App.settings.libraryRootName : '未手动设置 · 当前使用默认路径（下方输入框里显示的就是它）' });
    box.appendChild(Field.row('素材库根目录', el('div', {}, [
      rootInfo,
      el('div', { class: 'btn-row' }, [
        el('button', { class: 'btn btn-sm btn-primary', onclick: function () {
          /* v3.0.5：宿主原生对话框 → 直接得到绝对路径（不再需要手动粘贴） */
          FS.pickDirectoryPath('vrc-library-root').then(function (r) {
            if (!r) return;
            if (!r.path) { Toast.warn('未能获取该文件夹的完整路径，请在下方输入框手动填写'); return; }
            rootPathIn.value = r.path;
            App.settings.libraryRootPath = r.path;
            App.settings.libraryRootName = r.name;
            // 与手动填写保持一致：路径一旦改变就清掉旧句柄，避免句柄/路径指向不同目录
            Store.kvSet('libraryRoot', null).catch(function () {});
            App.saveSettings();
            rootInfo.textContent = '已授权目录：' + r.name + '（' + r.path + '）';
            Toast.ok('已填入素材库完整路径：' + r.path);
          });
        } }, ICONS.label('\u{1F4C2} 选择文件夹（自动填路径）')),
        el('button', { class: 'btn btn-sm', onclick: function () {
          /* 授权浏览器目录句柄：导入/搬运/扫描要用它（浏览器 API 不返回路径，只给句柄） */
          FS.setLibraryRoot().then(function (r) {
            if (!r) return;
            rootInfo.textContent = '已授权目录：' + r.name;
            Toast.ok('已授权浏览器访问该目录：' + r.name + '（导入 / 扫描 / 建文件夹可用）');
          });
        } }, ICONS.label('\u{1F513} 授权目录（供浏览器导入）')),
        el('button', { class: 'btn btn-sm', onclick: function () {
          FS.getLibraryRoot().then(function (root) {
            if (!root) { Toast.warn('尚未选择根目录'); return; }
            return FS.ensurePermission(root, 'read').then(function (ok) {
              if (!ok) { Toast.err('未获得访问权限'); return; }
              Toast.info('正在扫描目录 …');
              return FS.scanDirectory(root, 2).then(function (r) {
                Modal.open({
                  title: '目录扫描结果', size: 'md', body: [
                    el('p', { text: '文件数：' + r.files + '，总大小：' + fmtSize(r.size) }),
                    el('h3', { text: '一级子文件夹（' + r.folders.length + '）' }),
                    el('div', { class: 'chip-wrap' }, r.folders.slice(0, 200).map(function (f) { return el('span', { class: 'chip' }, f); }))
                  ]
                });
              });
            });
          });
        } }, ICONS.label('\u{1F50D} 扫描目录')),
        el('button', { class: 'btn btn-sm', onclick: function () {
          FS.createCategoryFolders().then(function (created) {
            if (created) Toast.ok('已创建/确认 ' + created.length + ' 个分类文件夹：' + created.join('、'));
          });
        } }, ICONS.label('\u{1F4C1} 按分类创建文件夹'))
      ])
    ])));

    var rootPathIn = el('input', {
      class: 'input mono', value: App.libraryRoot(),   // v2.3.15：没手动设置过就显示生效的默认路径，而不是空白
      placeholder: '例如 D:\\素材库\\本地素材库',   // v3.0.4：中性示例，不暴露作者机器的路径
      onchange: function () {
        App.settings.libraryRootPath = rootPathIn.value.trim();
        // 路径字符串一旦手动修改，就清掉旧库根句柄，避免句柄/路径不一致生成假路径
        Store.kvSet('libraryRoot', null).catch(function () {});
        App.saveSettings();
      }
    });
    box.appendChild(Field.row('素材库根目录的完整路径', rootPathIn,
      '宿主在线时点上面的「选择文件夹」会自动填入完整路径（v3.0.5），也可手动填写。填写后，导入 / 整理生成的路径都会是可以直接粘贴进资源管理器的完整路径。'
      + (App.settings.libraryRootPath ? '' : '当前显示的是「未设置时的默认值」，改动后即以你填写的为准。')));

    box.appendChild(el('h3', { text: '导入本地已下载的素材' }));
    (function () {
      var cb = el('input', { type: 'checkbox', checked: !!App.settings.importMoveInsteadOfCopy, onchange: function () {
        App.settings.importMoveInsteadOfCopy = cb.checked; App.saveSettings();
      } });
      box.appendChild(el('label', { class: 'check check-row' }, [cb, el('span', { text: '导入本地文件时默认「移动」而非「复制」' })]));
    })();
    box.appendChild(el('p', { class: 'field-hint', text: '该开关只决定默认搬运方式：勾选后优先移动，移动失败会跳过该项并提示（不再自动改为复制）；取消勾选则始终复制。' }));
    box.appendChild(el('p', { class: 'field-hint', text: '扫描一个文件夹：每个子文件夹识别为一个素材，压缩包按版本号归并为「版本」，图片自动作为封面，.url 文件里的链接自动识别为商店链接。可选择把文件导入素材库。' }));
    box.appendChild(el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn btn-sm btn-primary', onclick: function () { Modal.closeTop(); Importer.folderWizard(); } }, ICONS.label('\u{1F4C2} 文件夹导入向导'))
    ]));

    box.appendChild(el('h3', { text: '整理辅助' }));
    box.appendChild(el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn btn-sm', onclick: function () { Tools.structurePlan(); } }, ICONS.label('\u{1F5C2} 生成建议目录结构')),
      el('button', { class: 'btn btn-sm', onclick: function () { FS.downloadCSV(App.filtered()); } }, ICONS.label('\u2B07 导出当前列表为 CSV')),
      el('button', { class: 'btn btn-sm', onclick: function () { Tools.pathAudit(); } }, ICONS.label('\u{1F50E} 素材库体检')),
      el('button', { class: 'btn btn-sm', onclick: function () { Tools.bulkOrderUpdate(); } }, ICONS.label('\u{1F504} 批量获取更新'))
    ]));

    // ---- v2.2.12 网盘（WebDAV）----
    box.appendChild(el('h3', { text: '网盘（WebDAV）' }));
    box.appendChild(el('p', { class: 'field-hint', text: '这里只配置 WebDAV 地址与账号；能访问哪些网盘完全取决于你自己部署的 WebDAV 网关（Nextcloud / 群晖 / Alist 等），本程序不内置任何网盘 SDK。配置后，素材的「本地文件路径」可填 webdav://账号名/远端路径，详情页即可浏览远端目录、上传与下载。密码用本机加密（' + Secure.level().name + '）保存，永不随备份导出。' }));
    var davLog = el('div', { class: 'field-hint' });
    var davList = el('div', { class: 'link-list' });
    function davCreds(acc) {
      return Secure.decrypt(acc.passwordEnc || '').then(function (pw) {
        return { url: acc.url, username: acc.username || '', password: pw || '' };
      }).catch(function () { return { url: acc.url, username: acc.username || '', password: '' }; });
    }
    function davTest(acc) {
      davLog.textContent = '正在测试 ' + acc.label + ' …';
      davCreds(acc).then(function (c) {
        return FS.davCall('/api/webdav/test', c);
      }).then(function (r) {
        ICONS.apply(davLog, r.ok ? ('\u2714 ' + acc.label + '：连接正常（支持 WebDAV）') : ('\u26A0 ' + acc.label + '：' + r.error));
      }).catch(function (e) { ICONS.apply(davLog, '\u2716 ' + acc.label + '：' + (e && e.message)); });
    }
    function renderDav() {
      davList.innerHTML = '';
      var accs = App.settings.webdavAccounts || [];
      if (!accs.length) { davList.appendChild(el('div', { class: 'field-hint', text: '还没有配置任何 WebDAV 账号。' })); return; }
      accs.forEach(function (acc) {
        davList.appendChild(el('div', { class: 'link-row' }, [
          el('code', { class: 'path', title: acc.url }, acc.label + '  ·  ' + acc.url + (acc.username ? '  ·  ' + acc.username : '')),
          // v2.3.15：像站点 Cookie 一样给出直观状态——密码是本机加密保存的，不回显原文
          el('span', { class: acc.passwordEnc ? 'field-hint cred-saved' : 'field-hint' }, ICONS.label(acc.passwordEnc ? '\u{1F512} 已加密保存密码' : '未设密码（匿名访问）')),
          el('button', { class: 'btn btn-xs', onclick: function () { davTest(acc); } }, '测试'),
          el('button', { class: 'btn btn-xs btn-danger-ghost', onclick: function () {
            App.settings.webdavAccounts = (App.settings.webdavAccounts || []).filter(function (x) { return x.id !== acc.id; });
            App.saveSettings(); renderDav(); Toast.ok('已删除 WebDAV 账号：' + acc.label);
          } }, '删除')
        ]));
      });
    }
    var davLabel = el('input', { class: 'input', placeholder: '账号名，例如 坚果云（用于 webdav://坚果云/素材）' });
    var davUrl = el('input', { class: 'input mono', placeholder: 'https://dav.jianguoyun.com/dav/' });
    var davUser = el('input', { class: 'input', placeholder: '用户名（可留空）' });
    var davPass = el('input', { class: 'input', type: 'password', placeholder: '密码 / 应用密码', autocomplete: 'new-password' });
    box.appendChild(Field.row('账号名', davLabel, '填进 webdav:// 里的名字，需唯一'));
    box.appendChild(Field.row('WebDAV 地址', davUrl, '必须 http:// 或 https:// 开头，指向 WebDAV 根或子目录'));
    box.appendChild(Field.row('用户名', davUser));
    box.appendChild(Field.row('密码', davPass, '本机加密保存；建议用网关生成的「应用密码」而非主密码'));
    box.appendChild(el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn btn-sm btn-primary', onclick: function () {
        var label = davLabel.value.trim(), url = davUrl.value.trim();
        if (!label) { Toast.warn('请先填账号名'); return; }
        if (!/^https?:\/\//i.test(url)) { Toast.warn('WebDAV 地址必须以 http:// 或 https:// 开头'); return; }
        if ((App.settings.webdavAccounts || []).some(function (x) { return x.label === label; })) { Toast.warn('账号名已存在：' + label); return; }
        Secure.encrypt(davPass.value).then(function (enc) {
          App.settings.webdavAccounts = (App.settings.webdavAccounts || []).concat([{
            id: 'dav_' + Date.now().toString(36), label: label, url: url,
            username: davUser.value.trim(), passwordEnc: enc
          }]);
          App.saveSettings();
          davLabel.value = davUrl.value = davUser.value = davPass.value = '';
          renderDav(); Toast.ok('已保存 WebDAV 账号：' + label);
        });
      } }, ICONS.label('\u2795 添加账号'))
    ]));
    box.appendChild(davList);
    box.appendChild(davLog);
    renderDav();

    // v2.3.3：扫描补路径（只补不删，不动已有路径）
    var scanLog = el('div', { class: 'fetch-log', style: { display: 'none' } });
    function scanLogLine(m) { scanLog.style.display = ''; scanLog.appendChild(el('div', { class: 'log-line', text: m })); scanLog.scrollTop = scanLog.scrollHeight; }
    var scanBtn = el('button', { class: 'btn btn-sm' }, ICONS.label('\u{1F50E} 扫描素材库补全缺失路径'));
    scanBtn.onclick = function () {
      scanBtn.disabled = true; ICONS.apply(scanBtn, ('\u23F3 扫描中 …'));
      App.scanAndFillPaths(scanLogLine).then(function (r) {
        Toast.ok(r.filled ? ('已为 ' + r.filled + ' 个素材补上本地路径') : '没有需要补的素材' + (r.checked ? '（检查 ' + r.checked + ' 个无路径素材）' : ''), 5200);
      }).catch(function (e) {
        Toast.err('扫描失败：' + (e && e.message ? e.message : e));
      }).then(function () { scanBtn.disabled = false; ICONS.apply(scanBtn, ('\u{1F50E} 扫描素材库补全缺失路径')); });
    };
    box.appendChild(el('div', { class: 'btn-row' }, [scanBtn]));
    box.appendChild(el('div', { class: 'field-hint', text: '给「磁盘上已有文件夹但素材没记路径」的素材补上路径（按素材文件夹名在各分类目录下查找）。只补不删，也不会新建文件夹。' }));
    box.appendChild(scanLog);


    return box;
  },

  /* ---------------- 数据管理 ---------------- */

  /* ---------------- 数据管理 ---------------- */
  tab_data: function () {
    var box = el('div', { class: 'settings-pane' });
    var info = el('div', { class: 'field-hint', text: '浏览器缓存后端：' + (Store.isIDB ? 'IndexedDB' : 'LocalStorage（降级模式）') + '（数据本体在 ' + (App.localDir || 'vrclib-data\\') + '）' });
    box.appendChild(info);
    Store.estimate().then(function (e) {
      if (!e) return;
      box.insertBefore(el('div', { class: 'field-hint', text: '已用空间约 ' + fmtSize(e.usage) + ' / 可用配额约 ' + fmtSize(e.quota) }), info.nextSibling);
    });

    box.appendChild(el('h3', { text: '备份与恢复' }));
    box.appendChild(el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn btn-sm btn-primary', onclick: function () { FS.downloadJSON(true); } }, ICONS.label('\u2B07 导出完整备份（含封面）')),
      el('button', { class: 'btn btn-sm', onclick: function () { FS.downloadJSON(false); } }, ICONS.label('\u2B07 导出数据（不含封面）')),
      el('button', { class: 'btn btn-sm', onclick: function () { FS.downloadCSV(App.assets); } }, ICONS.label('\u2B07 导出全部为 CSV')),
      el('button', { class: 'btn btn-sm', onclick: function () {
        Modal.confirm('会向当前素材库追加 12 条带封面的示例素材，用来看卡片布局；之后可以逐条删除。继续？', { okText: '加入示例' }).then(function (ok) {
          if (!ok) return;
          if (window.VRCLib && typeof window.VRCLib.seedSamples === 'function') window.VRCLib.seedSamples();
        });
      } }, ICONS.label('\u2B07 载入示例素材（12 条，带封面）'))
    ]));

    box.appendChild(el('h3', { text: '导入' }));
    var fi = el('input', { type: 'file', accept: '.json', style: { display: 'none' } });
    fi.onchange = function () {
      var f = fi.files[0]; if (!f) return;
      FS.readFileAsText(f).then(function (t) {
        var payload = safeJSON(t, null);
        if (!payload) { Toast.err('无法解析 JSON 文件'); return; }
        var n = (payload.assets || []).length;
        Modal.confirm('文件包含 ' + n + ' 条素材。选择「确定」将合并到现有库中（同 ID 会被覆盖）。', { okText: '合并导入' })
          .then(function (ok) {
            if (!ok) return;
            Toast.info('正在导入 …');
            FS.importJSON(payload, 'merge').then(function (r) {
              return App.reload();
            }).then(function () {
              UI.renderAll(); Toast.ok('导入完成，共 ' + n + ' 条素材');
            }).catch(function (e) { Toast.err('导入失败：' + (e.message || e)); });
          });
      });
      fi.value = '';
    };
    box.appendChild(fi);
    box.appendChild(el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn btn-sm', onclick: function () { fi.click(); } }, ICONS.label('\u2B06 从备份文件导入')),
      el('button', { class: 'btn btn-sm', onclick: function () { Tools.importCSVHelp(); } }, ICONS.label('\u2139 CSV 导入说明'))
    ]));

    box.appendChild(el('h3', { text: '缓存' }));
    box.appendChild(el('button', { class: 'btn btn-sm', onclick: function () {
      Store.cacheClear().then(function () { Toast.ok('已清空商品解析缓存'); });
    } }, ICONS.label('\u{1F5D1} 清空商品解析缓存')));

    box.appendChild(el('h3', { text: '危险操作' }));
    box.appendChild(el('button', { class: 'btn btn-sm btn-danger', onclick: function () {
      Modal.confirm('将清空素材库中的全部数据（素材、封面）。设置与词典会保留。建议先导出备份！', { okText: '我确认清空' })
        .then(function (ok) {
          if (!ok) return;
          // v2.3.18：清空后必须把空的 assets.json 写回 vrclib-data，否则重启会以文件为准把素材「复活」
          Store.clearAll()
            .then(function () { return Store.local.saveAssets([], App.settings); })
            .then(function () {
              // v2.5.3：整表换新对象前先逐个回收 blob URL（否则清库后内存停在峰值不降）
              try { Object.keys(App.coverCache || {}).forEach(function (k) { App.dropCover(k); }); } catch (e) {}
              App.assets = []; App.coverCache = Object.create(null);
              UI.renderAll(); Toast.ok('素材库已清空（含 vrclib-data\assets.json）');
            });
        });
    } }, ICONS.label('\u{1F5D1} 清空素材库')));
    return box;
  },

  /** 用户脚本安装说明 */
  userscriptHelp: function () {
    var steps = [
      '① 给浏览器安装用户脚本管理器：Tampermonkey（Chrome / Edge / Firefox 均可）或 Violentmonkey。',
      '② 打开随程序附带的 scripts\\vrc-library-bridge.user.js，把内容粘贴到管理器的「添加新脚本」里保存；或直接把该文件拖进浏览器，管理器会提示安装。',
      '③ 正常登录 BOOTH（或 Gumroad），打开 https://accounts.booth.pm/library （购买记录）或 https://app.gumroad.com/library 。',
      '④ 页面右下角会出现「VRC 素材库桥接」面板，点「导出本页 / 导出全部页」，它会自动翻页收集商品信息与下载直链。',
      '⑤ 点「复制 JSON」或「下载 JSON」，回到本工具 → 设置 → 数据管理 → 从用户脚本导入 → 粘贴 / 选择文件 → 导入。',
      '也可以在任意商品页点「导出本页商品」，用来给单个素材补全信息。'
    ];
    Modal.open({
      title: '用户脚本安装与使用', size: 'md',
      body: [
        el('div', { class: 'notice' }, [
          el('b', { text: '为什么用用户脚本？' }),
          el('p', { text: '已购列表和下载直链都需要登录态。用户脚本运行在你自己已登录的浏览器标签页里，直接读取页面内容，既不需要把账号密码交给本工具，也不受同源策略限制——这是最安全也最可靠的方式。' })
        ]),
        el('ul', { class: 'help-list' }, steps.map(function (s) { return el('li', { text: s }); })),
        el('p', { class: 'field-hint', text: '脚本文件位置：程序同目录下的 scripts\\vrc-library-bridge.user.js' })
      ]
    });
  },

  /* ---------------- 关于 ---------------- */
  tab_about: function () {
    var box = el('div', { class: 'settings-pane' });
    box.appendChild(el('h3', { text: APP.name + ' v' + APP.version }));
    box.appendChild(el('p', { class: 'field-hint', text: '单文件离线网页工具：数据本体存在与 HTML 同目录的 vrclib-data\\ 文件夹（v2.3.0 起，浏览器 IndexedDB 只是缓存副本），不依赖任何服务器，也不会上传你的任何数据。' }));

    /* ---------------- v4.3.2：程序更新（手动检查） ---------------- */
    var updStatus = el('div', { class: 'field-hint', text: '' });
    function refreshUpdStatus() {
      var s = Updater.source();
      updStatus.textContent = '当前版本 v' + Updater.currentVersion()
        + ' · 更新源：' + (s.configured ? (s.owner + '/' + s.repo) : '未配置');
    }
    var upOwner = el('input', {
      class: 'input mono', placeholder: 'owner（GitHub 用户名 / 组织名）',
      value: ((App.settings.updateSource || {}).owner) || ''
    });
    var upRepo = el('input', {
      class: 'input mono', placeholder: 'repo（仓库名）',
      value: ((App.settings.updateSource || {}).repo) || ''
    });
    var upBtnCheck = el('button', {
      class: 'btn btn-sm btn-primary',
      onclick: function () { Updater.check(); }
    }, ICONS.label('\u{1F504} 检查更新'));
    var upBtnRepo = el('button', {
      class: 'btn btn-sm',
      onclick: function () {
        var s = Updater.source();
        if (!s.configured) { Toast.warn('先填好下面的 owner / repo 再打开仓库', 5000); return; }
        Updater.openUrl(Updater.repoUrl(s.owner, s.repo));
      }
    }, ICONS.label('\u{1F517} 打开仓库'));
    var upBtnSave = el('button', {
      class: 'btn btn-sm',
      onclick: function () {
        App.settings.updateSource = { owner: upOwner.value.trim(), repo: upRepo.value.trim() };
        App.saveSettings(); refreshUpdStatus();
        Toast.ok('更新源已保存');
      }
    }, '保存更新源');

    box.appendChild(el('h3', { text: '程序更新' }));
    box.appendChild(el('div', { class: 'notice' }, [
      el('p', { text: '「检查更新」只在点按钮时联网一次（读 GitHub Releases 的最新版本号），平时不发任何请求。'
        + '程序不会自动替换自己：发现有新版会打开下载页，你把压缩包解压覆盖到当前目录即可，'
        + 'vrclib-data 与素材库不受影响。' })
    ]));
    box.appendChild(updStatus);
    box.appendChild(el('div', { class: 'btn-row' }, [upBtnCheck, upBtnRepo]));
    box.appendChild(Field.row('更新源 owner', upOwner));
    box.appendChild(Field.row('更新源 repo', upRepo));
    box.appendChild(el('div', { class: 'btn-row' }, [upBtnSave]));
    refreshUpdStatus();

    box.appendChild(el('h3', { text: '信息获取方式' }));
    box.appendChild(el('ul', { class: 'help-list' }, [
      el('li', { text: '手动粘贴源码（默认）：不发起任何外部请求。打开商品页 → 查看网页源代码 → 复制 → 粘贴 → 本地解析。BOOTH 建议直接粘贴 items/<商品ID>.json 的内容，识别率最高。' }),
      el('li', { text: '内置宿主联网：全部外部请求由程序内置的宿主发起，支持自动抓取、Cookie 已购识别、订单下载解析与 AI 翻译；不使用也不配置任何 CORS 代理。' }),
      el('li', { text: '宿主离线时网页照常打开：浏览 / 手动粘贴 / 拖拽导入照常可用；打开文件夹、移动复制、联网抓取、已购识别与 AI 翻译会提示受限。' })
    ]));

    box.appendChild(el('h3', { text: '解析器覆盖范围' }));
    box.appendChild(el('ul', { class: 'help-list' }, [
      el('li', { text: 'BOOTH：解析官方 items/<ID>.json（商品 ID、名称、描述、价格、图集、标签、分类、店铺），也支持商品页 HTML。' }),
      el('li', { text: 'Gumroad：解析页面内 data-page 数据（名称、封面、作者、价格、变体 options）；登录后自动识别已购变体的下载页链接（gumroad.com/d/…），并解析下载页里的全部文件链接。' }),
      el('li', { text: 'GitHub：粘贴 api.github.com/repos/<owner>/<repo> 的整页 JSON 或仓库页源码即可；商品 ID 取 owner/repo，名称 / 描述 / topics / 语言 / 创建与推送时间入库，Star 数占「价格」位（开源素材一律视为免费），封面与图集取自 README 图片，可下载 release 附件与默认分支源码包。填写 Token 后自动鉴权（额度 60 → 5000 次/小时）。' }),
      el('li', { text: '通用网页：解析 og:title / og:image / og:description / JSON-LD Product 等标准元数据。' }),
      el('li', { text: '解析器是可插拔的：Fetchers.register({ id, name, match(url), parse(text, url) }) 即可新增站点策略。' })
    ]));

    box.appendChild(el('h3', { text: '设计参考（仅借鉴思路，未复用任何代码）' }));
    box.appendChild(el('ul', { class: 'help-list' }, [
      el('li', { text: 'BoothPM-SDK（Node 爬虫库）：借鉴其商品数据模型（商品ID / 名称 / 描述 / 价格 / 分类 / 图集 / 标签 / 店铺）与列表的分页、免费·付费筛选维度。其 axios + cheerio 实现无法在浏览器中运行，本工具改用 DOMParser 在本地解析。' }),
      el('li', { text: 'booth-library-manager（浏览器扩展）：借鉴其本地缓存思路（改用 IndexedDB 代替 browser.storage，避免重复请求）、卡片网格 + 实时搜索过滤，以及收藏 / 隐藏 / 标签等用户偏好的组织方式。扩展权限相关实现不适用于本工具。' }),
      el('li', { text: '通用「从 URL 自动填充」交互：粘贴链接 → 获取标题 / 主图 / 描述 → 填入表单 → 失败则回退到手动填写或粘贴源码。' }),
      el('li', { text: '明确排除：Unity 编辑器插件（依赖 Editor 环境）与浏览器扩展（依赖扩展权限），与纯网页技术栈不匹配，未作为实现参考。' })
    ]));

    box.appendChild(el('h3', { text: '运行形态：Electron 桌面程序 + 内置宿主' }));
    box.appendChild(el('p', { class: 'field-hint', text: '程序以 Electron 原生窗口运行，真实文件操作由主进程内置的宿主完成（随窗口启动，监听 127.0.0.1:8788~8792），不需要再单独运行任何宿主程序。' }));
    box.appendChild(el('ul', { class: 'help-list' }, [
      el('li', { text: '内置宿主提供的能力：读写任意路径、按路径建目录、移动/复制、读取目录、打开资源管理器、代发 HTTP 请求（绕过 CORS）、下载与断点续传、WebDAV 客户端、AI 流式转发。' }),
      el('li', { text: '宿主离线时：素材照常从缓存读取，改动只留在本地缓存并显示顶部提示条，点「重试连接」可补写落盘。' }),
      el('li', { text: 'v4.1.0 起只保留 Electron 单一载体：旧的 WebView2 桌面壳、独立宿主 VRCLibHost.exe 与「结构修复」工具均已移除（归档在 runtime\\_旧版归档\\）。' })
    ]));

    box.appendChild(el('h3', { text: '数据安全' }));
    box.appendChild(el('ul', { class: 'help-list' }, [
      el('li', { text: '素材数据本体存在「与 HTML 同目录的 vrclib-data\\」文件夹里（assets.json / settings.json / covers / gallery / download-queue.json），浏览器 IndexedDB 只是缓存副本；清理浏览器数据不会丢数据，但换电脑时记得一并拷贝 vrclib-data。' }),
      el('li', { text: '若数据文件读不出来（例如损坏），程序会进入只读并弹出红色告警，绝不覆盖原文件。' }),
      el('li', { text: '不存储账号密码；仅支持手动粘贴 Cookie，使用 ' + Secure.level().name + ' 保存，永不随备份导出。' }),
      el('li', { text: '默认「手动粘贴源码」下，工具不会向任何外部服务器发送请求。' })
    ]));
    return box;
  }
};


