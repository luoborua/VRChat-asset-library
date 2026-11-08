/*
 * 80-settings.js —— 设置中心：外观、抓取、站点凭据、标签词典、本地库、数据目录、关于
 *   选择写进 App.settings，再由 Store.local / FS.host 落到磁盘；界面全部现搭在弹窗里。
 *   只负责把选择记下来、把代价讲清楚；抓取、解析、文件搬运本身由 Net / Fetchers / FS 做。
 *   不实现素材编辑表单，也不直接操作素材记录。
 */

var Settings = {
  /** 打开设置中心，默认停在首个页签 */
  open: function (tabId) {
    var tabs = [
      { id: 'appearance', label: ICONS.label('\u{1F3A8} 外观') },
      { id: 'fetch',      label: ICONS.label('\u{1F310} 联网与抓取') },
      { id: 'cred',       label: ICONS.label('\u{1F510} 站点凭证') },
      { id: 'tagdict',    label: ICONS.label('\u{1F524} 标签翻译') },
      { id: 'tagmanage',  label: ICONS.label('\u{1F5C2} 标签管理') },
      { id: 'dict',       label: ICONS.label('\u{1F5C2} 分类与角色') },
      { id: 'icons',      label: ICONS.label('\u{1F3A8} 图标') },
      { id: 'ai',         label: ICONS.label('\u{1F916} AI 与模糊搜索') },
      { id: 'library',    label: ICONS.label('\u{1F4C1} 本地库与整理') },
      { id: 'p2p',        label: ICONS.label('\u{1F517} 点对点传输') },
      { id: 'data',       label: ICONS.label('\u{1F4BE} 数据管理') },
      { id: 'about',      label: ICONS.label('\u2139 关于与帮助') }
    ];
    var content = el('div', { class: 'settings-content' });
    var nav = el('div', { class: 'settings-nav' }, tabs.map(function (t) {
      return el('button', {
        class: 'settings-tab', dataset: { tab: t.id },
        onclick: function () { select(t.id); }
      }, t.label);   // label 已是 ICONS.label 生成的节点数组，el() 会自己展平
    }));
    function select(id) {
      $$('.settings-tab', nav).forEach(function (b) { b.classList.toggle('active', b.dataset.tab === id); });
      content.innerHTML = '';
      content.appendChild(Settings['tab_' + id]());
      /* 设置窗是固定尺寸，滚动容器在 .settings-content 而不是 .modal-body
       * （左侧导航不跟着滚），切页签时这两处都要滚回顶部。 */
      content.scrollTop = 0;
      var body = nav.closest ? nav.closest('.modal-body') : null;
      if (body) body.scrollTop = 0;
    }
    var h = Modal.open({
      title: '设置', size: 'lg', cls: 'modal-settings',
      body: [el('div', { class: 'settings' }, [nav, content])],
      footer: [el('button', { class: 'btn btn-primary', onclick: function () { Modal.close(h); UI.renderAll(); } }, '完成')]
    });
    select(tabId || 'appearance');
  },

  /* ---------------- 点对点传输 ---------------- */
  tab_p2p: function () {
    var box = el('div', { class: 'settings-pane' });
    box.appendChild(el('h3', { text: '点对点传输' }));
    box.appendChild(el('p', {
      class: 'settings-desc',
      text: '和同一个局域网里的好友直接连起来传文件，文件内容不经过任何服务器。'
          + '只需要一个「信令服务」帮忙交换连接地址 —— 它只转发几百字节的握手信息，看不到也存不下文件内容。'
    }));

    if (typeof P2PUI !== 'undefined' && P2PUI.signalBox) box.appendChild(P2PUI.signalBox());

    box.appendChild(el('h3', { text: '说明' }));
    box.appendChild(el('ul', { class: 'settings-list' }, [
      el('li', { text: '只支持同一个局域网（同一个路由器 / 同一个 WiFi）。跨网络传请用「导出素材包」。' }),
      el('li', { text: '发起方点「传给好友」时会自动把服务开起来；接收方只要一个 6 位口令，地址是自动找的。' }),
      el('li', { text: '信令服务连续 15 分钟没有传输会自动关闭，避免长期开着；关闭后需要重新分享，口令会换新的。' }),
      el('li', { text: '传输中断后可以点「重连」接着传，已经传完的块不会重来。' })
    ]));
    return box;
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

    /* 毛玻璃独立于主题：任意主题都能叠一层半透明模糊 */
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

    /* 滚轮手感是性能取舍，不是审美：「顺滑」带缓动，窗口线程跟不上时会短暂无响应，
     * 三档的代价写在下面的提示里。 */
    var wheelSel = el('select', { class: 'input', onchange: function () {
      App.settings.wheelMode = wheelSel.value; App.saveSettings();
    } }, [
      el('option', { value: 'fine', selected: (App.settings.wheelMode || 'fine') === 'fine' }, '细密（推荐：无缓动但步子小，最不卡）'),
      el('option', { value: 'system', selected: App.settings.wheelMode === 'system' }, '跟系统（一格 120px，硬跳）'),
      el('option', { value: 'smooth', selected: App.settings.wheelMode === 'smooth' }, '顺滑（有缓动，可能短暂卡住）')
    ]);
    box.appendChild(Field.row('滚轮手感', wheelSel, '细密/跟系统 都只花 1 帧；顺滑每格要十几帧，窗口线程跟不上时会短暂无响应'));

    /* 每页数量不给选项：按卡片大小换算，才能让一页占的面积差不多大 */
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

  /* ---------------- 联网与抓取 ---------------- */
  tab_fetch: function () {
    var box = el('div', { class: 'settings-pane' });
    box.appendChild(el('div', { class: 'notice' }, [
      el('b', { text: '联网抓取的两种方式' }),
      el('p', { text: '抓取商品信息的路径只有两条：默认「手动粘贴源码」（不抓取商品信息、零请求）；需要自动抓取时，全部请求由程序自身的后端直接发出——不经过端口、外部进程或 CORS 代理。'
        + '默认下唯一会联网的是下面「粘贴链接自动取标题」：粘贴商品链接时只请求一次、只取标题，可以关掉。' })
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
    /* 自动补全是最容易「点开就悄悄发请求」的地方，单独给一个总开关：
     * 关掉后只有手动按钮（强制联网填充 / 重新解析 / 批量）才会联网。 */
    var varCk = el('input', { type: 'checkbox', checked: App.settings.autoVariantFetch !== false, onchange: function () {
      App.settings.autoVariantFetch = varCk.checked; App.saveSettings();
    } });
    box.appendChild(el('label', { class: 'check check-row' }, [varCk, el('span', {
      text: '打开素材详情 / 编辑页时自动补全版本与变体（只在存过 Cookie 的站点联网；同一条素材失败后冷却从 20 分钟起逐次翻倍，最长 6 小时）'
    })]));
    box.appendChild(el('div', { class: 'field-hint', style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } }, [
      el('span', { text: '刚更新过 Cookie，想立刻重试？' }),
      el('button', { class: 'btn btn-xs', type: 'button', onclick: function () {
        try { localStorage.removeItem('vrclib.autoEnrich.tried.v1'); } catch (e) {}
        Toast.ok('已清除自动补全的冷却记录，下次打开详情会重新尝试');
      } }, '清除冷却记录')
    ]));
    /* 导入时按「名字里的商品编号」解析：一批几十个素材会挨个请求商品页，
     * 节奏虽然已经放到 1~2 秒，仍然给一个开关 —— 想离线批量入库时直接关掉。 */
    var parseCk = el('input', { type: 'checkbox', checked: App.settings.autoParseOnImport !== false, onchange: function () {
      App.settings.autoParseOnImport = parseCk.checked; App.saveSettings();
    } });
    box.appendChild(el('label', { class: 'check check-row' }, [parseCk, el('span', {
      text: '导入时按名字里的商品编号自动解析（例如「[5058951]-xxx」「5058951」：当成 BOOTH 商品号抓一次商品页，补标题 / 封面 / 标签；每项间隔 1~2 秒）'
    })]));
    var autoCk = el('input', { type: 'checkbox', checked: !!App.settings.autoCookieFetch, onchange: function () {
      App.settings.autoCookieFetch = autoCk.checked; App.saveSettings();
    } });
    box.appendChild(el('label', { class: 'check check-row' }, [autoCk, el('span', { text: '编辑素材时，如已保存 Cookie 且该素材还没有版本/下载链接，自动获取已购版本（需要联网）' })]));

    /* 标题：这是「手动粘贴源码」下唯一允许联网的动作，所以单独一个开关，关了就一次都不发。 */
    var titleCk = el('input', { type: 'checkbox', checked: App.settings.autoTitleFetch !== false, onchange: function () {
      App.settings.autoTitleFetch = titleCk.checked; App.saveSettings();
    } });
    box.appendChild(el('label', { class: 'check check-row' }, [titleCk, el('span', {
      text: '粘贴商品链接时自动获取标题（只发一次请求、只取标题，填到「原标题」；关掉后连这一次也不发）'
    })]));

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
    box.appendChild(Field.row('同时下载文件数', concIn, '1~8，默认 4。单文件 ≥16MB 且服务器支持断点续传时会自动切成最多 8 段并发下载（慢速源提速用）；改完立刻对新任务生效。'));
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
      el('p', { text: 'Cookie 只会在联网抓取时交给程序自身的后端，由它直接访问 BOOTH / Gumroad，绝不发给任何第三方代理或服务器。请勿在公用电脑上保存 Cookie，使用后建议及时清除。' })
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
        // Cookie 不回显原文，只给摘要：整串凭据不该长期留在屏幕上
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

    /* ---- GitHub Token：不填走匿名额度，填了额度高得多 ---- */
    var tkBox = el('div', { class: 'cred-item' });
    function renderToken() {
      tkBox.innerHTML = '';
      var has = !!App.settings.githubToken;
      var tkIn = el('input', {          // 故意用 text：粘贴后要能肉眼核对；DeepSeek 的 Key 才用 password
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
  /** 用最新词典重算全部素材的标签显示，并把结果写回主库 */
  applyDictToAssets: function () {
    var changed = 0;
    var list = App.assets.map(function (a) {
      // 原文与当前标签取并集再过词典：否则「看着像中文、其实是日文」的词条改了词典也不会被替换
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
  /** 批量补全素材信息：只填从未自动获取、用户也没手改过的空字段 */
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
          el('p', { text: '需要先在「设置 → 联网与抓取」选择「内置联网」；它随程序运行，不需要额外设置。' })
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
      running = true; startBtn.disabled = true; ICONS.apply(startBtn, ('\u23F3 补全中 …'));
      var targets = App.assets.filter(function (a) {
        // 闲鱼/好友分享不自动获取；已下架不再重复获取（用户可在编辑页手动重试）
        if (a.source === 'xianyu' || a.source === 'friend' || a.delisted) return false;
        return (a.links || []).some(function (l) { return isHttpUrl(l.url); });
      });
      var skippedAuto = App.assets.length - targets.length;
      if (!targets.length) { log('\u2716 没有需要补全的素材（闲鱼/好友分享/已下架素材会自动跳过）'); running = false; startBtn.disabled = false; ICONS.apply(startBtn, ('\u{1F504} 开始补全')); return; }
      if (skippedAuto > 0) log('\u26AA 已自动跳过 ' + skippedAuto + ' 条（闲鱼 / 好友分享 / 已下架）');
      log('共 ' + targets.length + ' 条素材需要补全，开始逐个处理（每条都强制联网，不吃本地缓存）…');
      var done = 0, updated = 0, failed = 0;
      var chain = Promise.resolve();
      targets.forEach(function (a, ti) {
        chain = chain.then(function () {
          var url = (a.links || []).filter(function (l) { return isHttpUrl(l.url); })[0].url;
          var title = a.title || a.originalTitle || a.itemId || url;
          return Fetchers.fetchInfo(url, { forceNetwork: true, noCache: true, onLog: function (m) { log('  [' + title + '] ' + m); } }).then(function (info) {
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
              if (a.autoFilled[key]) return;   // 自动获取过的字段不再覆盖，批量补全只填空
              if (key === 'title') { if (!a.title && val) { a.title = String(val).slice(0, 80); changed = true; a.autoFilled.title = true; } return; }
              if (!a[key] || (Array.isArray(a[key]) && !a[key].length)) { a[key] = val; changed = true; a.autoFilled[key] = true; }
            }
            fill('itemId', info.itemId);
            fill('author', info.author || info.shop);
            fill('shop', info.shop || info.author);
            fill('shopUrl', info.shopUrl);
            fill('description', info.description ? Smart.pickChinese(info.description) : '');
            // BOOTH 的价要靠变体算出来，这一批不解析变体，写进去只会是错的价
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
          }).catch(function (e) { done++; failed++; log('  [失败] ' + (e && e.message ? e.message : e)); })
            .then(function () {
              /* 每条之间歇 900~1500ms：一次补全整个库时，这个节奏才像个在读页面的人 */
              if (ti < targets.length - 1) return new Promise(function (r) { setTimeout(r, 900 + Math.random() * 600); });
            });
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

  /* ---------------- 分类 / 来源 / 角色 ---------------- */
  tab_dict: function () {
    var box = el('div', { class: 'settings-pane' });

    function saveAvatarOrder(list) {
      App.settings.avatarOrder = list.map(function (x) { return x.id; });
      return App.saveSettings();
    }
    // 顺序跟左侧栏一致，用户不用记两套排法：「其他」压在分类最后
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

    /* 分类 / 来源：左侧栏样式的 chips，自定义项可删、可加自定义图标 */
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

    /* 支持角色：可搜索、可排序、可改中 / 日 / 英三套名字 */
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
      el('p', { text: 'API Key 仅保存在本机（AES-GCM 加密，永不随备份导出，可一键清除）。只有在你点击「AI 翻译」时，选中的文本才会发送给 DeepSeek 官方接口；请求由程序后端直连官方接口，不经过任何代理。后端不可用时只有 AI 翻译受影响，其它功能照常。' })
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
        /* 框里显示的是「前 8 位…后 4 位」的掩码。不点输入框直接按保存，
         * 存进去的就是这串掩码 —— 之后所有翻译 401，原 Key 也找不回来。 */
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
    /* 超时按秒存；读到大于 600 的值当作毫秒写法归一化，限幅 10~600 秒 */
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
    box.appendChild(Field.row('请求超时（秒）', tmoIn, 'AI 翻译单次请求的等待上限（默认 120 秒，10~600）。响应是流式的：只要还在持续接收就不会被掐断。'));
    var autoTagsCb = el('input', { type: 'checkbox', checked: !!App.settings.aiAutoTags, onchange: function () {
      App.settings.aiAutoTags = autoTagsCb.checked; App.saveSettings();
    } });
    box.appendChild(el('label', { class: 'check check-row' }, [autoTagsCb, el('span', { text: '导入 / 解析素材时自动用 AI 翻译未命中的标签（会消耗 API 额度）' })]));

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
      '程序内置后端（同一进程，无端口）\n' +
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
      el('p', { text: '桌面版由程序直接读写磁盘：选择文件夹、创建分类目录、整项移动/复制都是原生操作，不需要额外授权。下面的「生成目录结构与批处理脚本」仍可给外部工具用。' })
    ]));

    // 文案不能写「尚未选择」：下面输入框里就显示着生效的默认路径，看着自相矛盾
var rootInfo = el('div', { class: 'kv-v', text: App.settings.libraryRootName ? '已选择目录：' + App.settings.libraryRootName : '未手动设置 · 当前使用默认路径（下方输入框里显示的就是它）' });
    box.appendChild(Field.row('素材库根目录', el('div', {}, [
      rootInfo,
      el('div', { class: 'btn-row' }, [
        el('button', { class: 'btn btn-sm btn-primary', onclick: function () {
          /* 原生对话框直接给绝对路径，用户不必再手抄一遍 */
          FS.pickDirectoryPath('vrc-library-root').then(function (r) {
            if (!r) return;
            if (!r.path) { Toast.warn('未能获取该文件夹的完整路径，请在下方输入框手动填写'); return; }
            rootPathIn.value = r.path;
            App.settings.libraryRootPath = r.path;
            App.settings.libraryRootName = r.name;
            // 路径一变就清掉旧的目录句柄，否则句柄和路径会指向两个不同的目录
            Store.kvSet('libraryRoot', null).catch(function () {});
            App.saveSettings();
            rootInfo.textContent = '已选择目录：' + r.name + '（' + r.path + '）';
            Toast.ok('已填入素材库完整路径：' + r.path);
            /* 选定根目录就扫一遍：里面已经整理好的素材可以直接登记进主库 */
            Settings.scanLibraryRoot();
          });
        } }, ICONS.label('\u{1F4C2} 选择文件夹（自动填路径）')),
        el('button', { class: 'btn btn-sm', onclick: function () {
          /* 直接扫配置里的根目录，不依赖浏览器目录句柄 */
          Settings.scanLibraryRoot();
        } }, ICONS.label('\u{1F50D} 扫描目录')),
        el('button', { class: 'btn btn-sm', onclick: function () {
          FS.createCategoryFolders().then(function (created) {
            if (created) Toast.ok('已创建/确认 ' + created.length + ' 个分类文件夹：' + created.join('、'));
          });
        } }, ICONS.label('\u{1F4C1} 按分类创建文件夹'))
      ])
    ])));

    var rootPathIn = el('input', {
      class: 'input mono', value: App.libraryRoot(),   // 没手动设过也要显示生效的默认路径，不能留空
      placeholder: '例如 D:\\素材库\\本地素材库',   // 示例用中性路径，不暴露任何人的真实目录
      onchange: function () {
        App.settings.libraryRootPath = rootPathIn.value.trim();
        // 手改路径后必须清掉库根句柄，否则句柄和路径不一致会生成假路径
        Store.kvSet('libraryRoot', null).catch(function () {});
        App.saveSettings();
      }
    });
    box.appendChild(Field.row('素材库根目录的完整路径', rootPathIn,
      '点上面的「选择文件夹」会直接填入完整路径（v3.0.5），也可手动填写。填写后，导入 / 整理生成的路径都会是可以直接粘贴进资源管理器的完整路径。'
      + (App.settings.libraryRootPath ? '' : '当前显示的是「未设置时的默认值」，改动后即以你填写的为准。')));

    /* 数据目录和素材库根目录是两件事：这里放主库 / 封面 / 缩略图 / 下载队列，
     * 素材文件本体在上一节的库根目录里。 */
    box.appendChild(el('h3', { text: '数据存放位置（主库 / 封面 / 缩略图）' }));
    var dataPath = el('div', { class: 'field-hint mono', text: Settings.dataRoot() || '(未知)' });
    box.appendChild(Field.row('当前数据目录', el('div', {}, [
      dataPath,
      el('div', { class: 'btn-row' }, [
        el('button', { class: 'btn btn-sm btn-primary', onclick: function () {
          Settings.changeDataDir().then(function (ok) {
            if (ok) dataPath.textContent = Settings.dataRoot() || '(未知)';
          });
        } }, ICONS.label('\u{1F4E6} 更改位置并迁移')),
        el('button', { class: 'btn btn-sm', onclick: function () {
          var p = Settings.dataRoot();
          if (p) FS.openPath(p);
        } }, ICONS.label('\u{1F4C2} 打开该目录'))
      ])
    ]), '主库（library.db）、封面、缩略图、下载队列都在这里。换到别的盘时会把现有数据整体迁过去并校验；'
      + 'settings.json 仍留在程序目录（它是「指向哪里」的指针，不能跟着搬）。'));

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
      el('button', { class: 'btn btn-sm', onclick: function () { Tools.categoryCleanup(); } }, ICONS.label('\u{1F5C2} 按分类整理素材目录')),
      el('button', { class: 'btn btn-sm', onclick: function () { Tools.bulkOrderUpdate(); } }, ICONS.label('\u{1F504} 批量获取更新'))
    ]));

    // 只补不删，不动已有路径
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
      Modal.confirm('将清空素材库中的全部数据（素材、封面）。设置与词典会保留。建议先导出备份！\n\n清掉的记录会进回收站，48 小时内可以找回。', { okText: '我确认清空' })
        .then(function (ok) {
          if (!ok) return;
          var all = App.assets.slice();
          /* 只打标记，不删记录：整批写一次库，比逐条删快，也留下可撤回的现场 */
          Store.trashMarkMany(all).then(function (marked) {
            App.assets = [];
            App.trashed = marked.concat(App.trashed);
            // 换新对象前先逐个回收 blob URL，否则清库后内存停在峰值不降
            try { Object.keys(App.coverCache || {}).forEach(function (k) { App.dropCover(k); }); } catch (e) {}
            App.coverCache = Object.create(null);
            App.persistNow();
            UI.renderAll();
            App.deletedToast(all);
          }).catch(function (e) {
            Toast.err('清空失败：' + ((e && e.message) || e), 7000);
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
    box.appendChild(el('p', { class: 'field-hint', text: '离线桌面工具：数据本体存在与程序同目录的 vrclib-data\\ 文件夹（library.db 为主库，浏览器 IndexedDB 只是缓存副本），不依赖任何服务器，也不会上传你的任何数据。' }));

    /* ---------------- 程序更新（只在点按钮时联网一次） ----------------
     * 更新源固定在仓库里：让用户自己填 owner/repo 只会白查 404。 */
    var updStatus = el('div', { class: 'field-hint', text: '' });
    function refreshUpdStatus() {
      updStatus.textContent = '当前版本 v' + Updater.currentVersion()
        + ' · 更新源：' + Updater.describe();
    }
    var upBtnCheck = el('button', {
      class: 'btn btn-sm btn-primary',
      onclick: function () { Updater.check(); }
    }, ICONS.label('\u{1F504} 检查更新'));
    var upBtnRepo = el('button', {
      class: 'btn btn-sm',
      onclick: function () {
        var s = Updater.source();
        Updater.openUrl(Updater.repoUrl(s.owner, s.repo));
      }
    }, ICONS.label('\u{1F517} 打开仓库'));

    box.appendChild(el('h3', { text: '程序更新' }));
    box.appendChild(el('div', { class: 'notice' }, [
      el('p', { text: '「检查更新」只在点按钮时联网一次（读 GitHub Releases 的最新版本号），平时不发任何请求。'
        + '发现有新版可以直接点「立即更新并重启」：程序自己下载、覆盖安装目录、再启动，不用手动解压。'
        + '只覆盖程序文件，vrclib-data、本地素材库与 runtime 里的数据都不动；'
        + '若程序装在不可写的目录（如 Program Files），会提示你换到桌面或 D 盘。' })
    ]));
    box.appendChild(updStatus);
    box.appendChild(el('div', { class: 'btn-row' }, [upBtnCheck, upBtnRepo]));
    box.appendChild(el('p', { class: 'field-hint', text: '更新源固定为 ' + Updater.describe() + '，不需要也不能在界面里改。' }));
    refreshUpdStatus();

    box.appendChild(el('h3', { text: '信息获取方式' }));
    box.appendChild(el('ul', { class: 'help-list' }, [
      el('li', { text: '手动粘贴源码（默认）：不发起任何外部请求。打开商品页 → 查看网页源代码 → 复制 → 粘贴 → 本地解析。BOOTH 建议直接粘贴 items/<商品ID>.json 的内容，识别率最高。' }),
      el('li', { text: '内置联网：全部外部请求由程序自身的后端直接发出，支持自动抓取、Cookie 已购识别、订单下载解析与 AI 翻译；不使用也不配置任何 CORS 代理。' }),
      el('li', { text: '后端不可用时：浏览 / 手动粘贴 / 拖拽导入照常可用，只有打开文件夹、移动复制、联网抓取、已购识别与 AI 翻译会受限。' })
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

    box.appendChild(el('h3', { text: '运行形态：Electron 主进程 + 渲染层' }));
    box.appendChild(el('p', { class: 'field-hint', text: '程序以原生窗口运行。文件与网络操作由主进程完成，页面通过预加载脚本提供的接口调用，没有需要单独启动的外部程序。' }));
    box.appendChild(el('ul', { class: 'help-list' }, [
      el('li', { text: '主进程提供的能力：读写任意路径、按路径建目录、移动/复制、读取目录、打开资源管理器、发起 HTTP 请求、下载与断点续传、SQLite 主库、缩略图生成。' }),
      el('li', { text: '改模工作台的磁盘重活由随程序附带的边车进程处理，走标准输入输出通信；边车只在打开工作台时拉起，用完即退。' }),
      el('li', { text: '素材主库为 vrclib-data\\library.db（SQLite），只写改动的行；二进制（封面 / 图集）以原始字节读写，不经过 base64。' }),
      el('li', { text: '「传给好友」会在本机临时监听 TCP 8787（信令）与 UDP 8786-8790（局域网发现），传输结束或关掉窗口即关闭；其余时间不监听任何端口。' })
    ]));

    box.appendChild(el('h3', { text: '数据安全' }));
    box.appendChild(el('ul', { class: 'help-list' }, [
      el('li', { text: '数据本体默认在「与程序同目录的 vrclib-data\\」，可在「设置 → 本地库与整理 → 数据存放位置」改到别的盘（会整体迁移并校验）；settings.json 始终留在程序目录，它是指向数据位置的指针。' }),
      el('li', { text: '若数据文件读不出来（例如损坏），程序会进入只读并弹出红色告警，绝不覆盖原文件。' }),
      el('li', { text: '不存储账号密码；仅支持手动粘贴 Cookie，使用 ' + Secure.level().name + ' 保存，永不随备份导出。' }),
      el('li', { text: '默认「手动粘贴源码」下，工具不会向任何外部服务器发送请求。' })
    ]));
    return box;
  },

  /* ================= 扫描库根并登记已有素材 =================
   * 识别「分类 / 素材」两层结构，每个素材文件夹登记一条主库记录。
   * 只登记路径，绝不移动、复制或删除文件。 */
  scanLibraryRoot: function () {
    var root = App.libraryRoot();
    if (!root) { Toast.warn('尚未选择根目录'); return Promise.resolve(); }
    var ARCHIVE_EXT = ['zip', 'rar', '7z', 'unitypackage', 'vrca', 'fbx', 'blend', 'psd', 'clip', 'pmx', 'tar', 'gz'];
    var IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];
    function extOf(name) {
      var m = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
      return m ? m[1] : '';
    }
    /** 分类文件夹名 → 分类 id（先按内置/自定义分类的中文标签精确匹配，失败再按名称智能推断） */
    function catIdFor(label, name) {
      var want = String(label || '').trim();
      if (want) {
        var hit = App.allCategories().find(function (c) { return String(c.label).trim() === want; });
        if (hit) return hit.id;
      }
      var guessed = Smart.guessCategory({ originalTitle: name, tags: [], description: '' });
      return guessed || 'other';
    }
    /** 这条路径是否已被现有素材登记过（防重复登记） */
    function pathKnown(p) {
      return App.assets.some(function (a) {
        return (a.paths || []).some(function (x) { return normalizeWinPath(x.path || '') === p; });
      });
    }

    Toast.info('正在扫描目录 …');
    return FS.host.exists(root).then(function (kind) {
      if (kind !== 'dir') {
        Toast.warn('根目录不存在：' + root + '。请先在上方选择有效的素材库根目录。', 6000);
        return null;
      }
      /* 深度 3：一级=分类、二级=素材文件夹、三级=素材文件夹里的文件（不再更深） */
      return FS.host.scan(root, 3).then(function (entries) {
        var dirs1 = {}, loose = 0, totalFiles = 0, totalSize = 0;
        entries.forEach(function (e) {
          var parts = String(e.rel || '').split('\\');
          if (e.kind === 'file') { totalFiles++; totalSize += e.size || 0; }
          if (parts.length === 1) {
            if (e.kind === 'directory') dirs1[e.name] = { name: e.name, subs: {}, files: [] };
            else loose++;
          } else if (parts.length === 2) {
            var d = dirs1[parts[0]]; if (!d) return;
            if (e.kind === 'directory') d.subs[parts[1]] = { name: parts[1], files: [] };
            else d.files.push(e);
          } else if (parts.length === 3) {
            var d2 = dirs1[parts[0]], s = d2 && d2.subs[parts[1]];
            if (s && e.kind === 'file') s.files.push(e);
          }
        });

        /* 组装候选：分类\素材 双层 → 每个二级文件夹一条；单层库（一级文件夹本身就是素材）也认 */
        var cands = [];
        Object.keys(dirs1).forEach(function (k) {
          var d = dirs1[k];
          var subs = Object.keys(d.subs);
          if (subs.length) {
            subs.forEach(function (sk) {
              var s = d.subs[sk];
              cands.push({ name: sk, catLabel: k, files: s.files, path: joinWinPath(root, [k, sk]), selected: true });
            });
          } else {
            cands.push({ name: k, catLabel: '', files: d.files, path: joinWinPath(root, [k]), selected: true });
          }
        });

        cands.forEach(function (c) {
          c.cat = catIdFor(c.catLabel, c.name);
          c.size = c.files.reduce(function (s, f) { return s + (f.size || 0); }, 0);
          c.archives = c.files.filter(function (f) { return ARCHIVE_EXT.indexOf(extOf(f.name)) >= 0; })
            .sort(function (a, b) { return (b.mtime || 0) - (a.mtime || 0); });
          c.image = c.files.filter(function (f) { return IMAGE_EXT.indexOf(extOf(f.name)) >= 0; })
            .sort(function (a, b) { return (b.size || 0) - (a.size || 0); })[0] || null;
          c.dup = pathKnown(c.path) || App.assets.some(function (a) {
            return (a.title || '').trim() === c.name.trim() && a.category === c.cat;
          });
          if (c.dup) c.selected = false;
        });

        var fresh = cands.filter(function (c) { return !c.dup; });
        var known = cands.length - fresh.length;

        var listBox = el('div', { class: 'scan-cand-list' });
        function renderList() {
          listBox.innerHTML = '';
          if (!cands.length) {
            listBox.appendChild(el('div', { class: 'multi-empty', text: '根目录下没有识别到素材文件夹。' }));
            return;
          }
          cands.slice(0, 300).forEach(function (c) {
            var cb = el('input', { type: 'checkbox', checked: c.selected, disabled: c.dup, onchange: function () { c.selected = cb.checked; } });
            listBox.appendChild(el('div', { class: 'import-row' }, [
              el('label', { class: 'check' }, [cb]),
              App.categoryIcon(c.cat, { size: 22 }),
              el('div', { class: 'import-main' }, [
                el('div', { class: 'scan-cand-name', text: c.name }),
                el('div', { class: 'field-hint' },
                  App.categoryLabel(c.cat) + ' · ' + c.files.length + ' 个文件 · ' + fmtSize(c.size) +
                  (c.archives.length ? ' · ' + c.archives.length + ' 个压缩包' : '') +
                  (c.image ? ' · 含封面图' : '') +
                  (c.dup ? ' · 已登记过（跳过）' : ''))
              ])
            ]));
          });
          if (cands.length > 300)
            listBox.appendChild(el('div', { class: 'field-hint', text: '… 其余 ' + (cands.length - 300) + ' 项结构相同，全部按勾选处理。' }));
        }
        renderList();

        var coverCheck = el('input', { type: 'checkbox', checked: true });
        var regBtn = null, registering = false;

        function register() {
          if (registering) return;
          var sel = cands.filter(function (c) { return c.selected && !c.dup; });
          if (!sel.length) { Toast.warn('请至少勾选一项'); return; }
          registering = true;
          if (regBtn) { regBtn.disabled = true; }
          var chain = Promise.resolve(), done = 0, fail = 0;
          sel.forEach(function (c) {
            chain = chain.then(function () {
              var asset = Store.normalizeAsset({
                title: c.name,
                source: 'other',
                category: c.cat,
                downloaded: true, downloadedAt: nowISO(),
                fileSize: c.size,
                importedFrom: 'folder',
                paths: [{ path: c.path, note: '本地登记（文件未移动）' }],
                versions: c.archives.map(function (f, i) {
                  return { name: String(f.name).replace(/\.[^.]+$/, ''), fileName: f.name, size: f.size || 0, isLatest: i === 0 };
                })
              });
              var coverStep = Promise.resolve();
              if (coverCheck.checked && c.image && (c.image.size || 0) < 16 * 1024 * 1024) {
                coverStep = FS.host.readFileBase64(joinWinPath(c.path, [c.image.name])).then(function (r) {
                  var bin = atob(r.dataBase64), arr = new Uint8Array(bin.length);
                  for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
                  return compressImage(new Blob([arr], { type: 'image/' + (extOf(c.image.name) === 'jpg' ? 'jpeg' : extOf(c.image.name)) }),
                    App.settings.imageMaxWidth, App.settings.imageQuality).then(function (b) {
                      asset.hasCover = true;
                      return Store.putCover(asset.id, b);
                    });
                }).catch(function () { /* 单张封面失败不影响登记 */ });
              }
              return coverStep.then(function () { return App.save(asset); }).then(function () { done++; });
            }).catch(function (e) { fail++; console.warn('登记失败：' + c.name, e); });
          });
          return chain.then(function () {
            UI.renderAll();
            Toast.ok('已登记 ' + done + ' 项素材' + (fail ? '，' + fail + ' 项失败' : '') + '。文件均未移动，位置记录在素材详情里。', 7000);
            Modal.close(h);
          });
        }

        var h = Modal.open({
          title: '扫描结果 · ' + root, size: 'lg',
          body: [
            el('p', { text: '文件数：' + totalFiles + '，总大小：' + fmtSize(totalSize) +
              (loose ? '，根目录散文件 ' + loose + ' 个（不会登记）' : '') }),
            el('p', { class: 'field-hint', text: '识别到 ' + cands.length + ' 个素材文件夹，其中 ' + known + ' 个已登记过。勾选后「登记到主库」——只记录名称、分类和路径，不移动、不复制、不删除任何文件。' }),
            el('label', { class: 'check check-row' }, [coverCheck, el('span', { text: '用文件夹里最大的图片作封面' })]),
            listBox
          ],
          footer: [
            el('button', { class: 'btn', onclick: function () { Modal.close(h); } }, '关闭'),
            (regBtn = el('button', { class: 'btn btn-primary', onclick: register }, '登记 ' + fresh.length + ' 项到主库'))
          ]
        });
      });
    }).catch(function (e) { Toast.err('扫描失败：' + ((e && e.message) || e)); });
  },

  /* ================= 数据目录 =================
   * settings.json 固定留在程序目录（它存着「数据放哪」这个指针），
   * 只有主库 / 封面 / 缩略图 / 下载队列跟着用户选的位置走。 */
  dataRoot: function () { return Store.local.dataDir(App.settings) || ''; },

  markDataDirAsked: function () {
    App.settings.dataDirAsked = true;
    App.saveSettings();
  },

  /** 首次运行问一次：数据放程序目录，还是另选一个盘。
   *  只认「问过没有」这个标记——启动时就会先建出空的 library.db，
   *  按「库里有没有数据」判断会把全新安装误判成用了很久的人。 */
  askDataDirIfNeeded: function () {
    var s = App.settings || {};
    if (s.localDataDir || s.dataDirAsked) return;
    if (App.localOffline || !FS.hostAvailable()) return;      // 后端不可用时别打扰
    var h = Modal.open({
      title: '选择数据存放位置',
      size: 'md',
      body: [
        el('p', { class: 'field-hint', text: '素材库数据（主库、封面、缩略图、下载队列）默认放在程序目录下的 vrclib-data 文件夹里，整个文件夹可以随时拷走。' }),
        el('p', { class: 'field-hint', text: '如果想把它们放到别的盘（比如空间更大的 D 盘），现在就可以选；以后也能在「设置 → 本地库与整理」里更改，数据会自动迁过去。' }),
        el('div', { class: 'field-hint', text: '当前默认位置：' + Settings.dataRoot() })
      ],
      closeOnBackdrop: false,
      footer: [
        el('button', { class: 'btn', onclick: function () { Settings.markDataDirAsked(); Modal.close(h); } }, '就用程序目录'),
        el('button', { class: 'btn btn-primary', onclick: function () {
          FS.pickDirectoryPath('vrclib-data').then(function (r) {
            if (!r || !r.path) return;
            Modal.close(h);
            Settings.changeDataDir(r.path);
          });
        } }, '选择文件夹…')
      ]
    });
  },

  /* 搬迁进行中：挡住第二次「更改位置并搬迁」 */
  _migrating: false,

  /** 更改数据位置：确认 → 整体搬迁 → 切库 → 清理原目录 → 刷新 */
  changeDataDir: function (targetPath) {
    if (Settings._migrating) { Toast.info('正在迁移数据，请等这次迁移结束'); return Promise.resolve(false); }
    Settings._migrating = true;
    var pick = targetPath
      ? Promise.resolve({ path: targetPath })
      : FS.pickDirectoryPath('vrclib-data');
    return pick.then(function (r) {
      if (!r || !r.path) return false;
      var to = normalizeWinPath(String(r.path));
      var from = Settings.dataRoot();
      if (from && to && from.toLowerCase() === to.toLowerCase()) { Toast.info('已经是当前数据位置'); return false; }
      return FS.host.dataScan(to).then(function (sc) {
        if (!sc || sc.ok === false) throw new Error((sc && sc.error) || '无法读取目标目录');
        if (sc.hasData) throw new Error('目标目录里已经有一份素材库数据，请换一个空文件夹');
        return FS.host.dataScan(from);
      }).then(function (cur) {
        var n = (cur && cur.files) || 0, b = (cur && cur.bytes) || 0;
        var msg = n
          ? ('把 ' + n + ' 个文件（' + fmtSize(b) + '）从\n' + from + '\n迁移到\n' + to + '\n\n复制并校验无误后，会删除旧目录里的素材库数据（settings.json 保留）。迁移期间请不要关闭程序。')
          : ('数据将存放到\n' + to + '\n\n当前还没有素材数据，直接切换即可。');
        return Modal.confirm(msg, { title: '迁移数据目录', okText: '开始迁移', cancelText: '取消' });
      }).then(function (yes) {
        if (!yes) return false;
        return Settings._migrateRun(from, to);
      });
    }).catch(function (e) {
      Toast.err('迁移失败：' + ((e && e.message) || e) + (e && e.cleaned ? '（已清理半成品，可重试）' : ''), 8000);
      return false;
    }).then(function (v) { Settings._migrating = false; return v; });
  },

  /** 执行搬迁（带进度窗）。失败时按当前设置重新打开数据库，别停在「库已关闭」的状态 */
  _migrateRun: function (from, to) {
    var txt = el('div', { class: 'field-hint', text: '准备中 …' });
    /* 不能取消也不能关窗：否则数据搬了一半、库还关着，没有人知道 */
    var h = Modal.open({ title: '正在迁移数据', size: 'sm', body: [txt], closeOnBackdrop: false, closable: false });
    var copyStarted = false, copyDone = false;   // 失败时据此判断目标目录里是不是半成品
    function say(t) { txt.textContent = t; }
    return FS.host.dataMigrate(from, to, function (ev) {
      if (!ev) return;
      if (ev.phase === 'start') { copyStarted = true; say('共 ' + ev.total + ' 个文件，开始复制 …'); }
      else if (ev.phase === 'copy') say('正在复制 ' + ev.done + ' / ' + ev.total + (ev.name ? '：' + ev.name : ''));
      else if (ev.phase === 'verify') say('复制完成，正在校验 …');
      else if (ev.phase === 'done') say('完成');
    }).then(function (r) {
      if (!r || r.ok === false) throw new Error((r && r.error) || '迁移失败');
      copyDone = true;
      App.settings.localDataDir = to;
      App.settings.dataDirAsked = true;
      /* 必须立刻落盘再切库：saveSettings 有 1.2 秒防抖，而切库要去读 settings.json
       * 决定新根在哪，写晚了就会读到旧值——数据搬了、库还开在原处。 */
      return Promise.resolve(Store.local.saveSettings(App.settings))
        .then(function () { return FS.host.dataApplyRoot(); })
        .then(function (ap) {
          if (!ap || ap.ok === false) throw new Error((ap && ap.error) || '切换数据目录后打开主库失败');
          App.localDir = Store.local.dataDir(App.settings);
          if (r.moved === false) return null;             // 源目录没有数据：只改了指针
          return FS.host.dataCleanup(from);
        })
        .then(function () {
          Modal.close(h);
          Toast.ok('数据已存放到：' + to, 6000);
          return App.reload().then(function () { return true; });
        });
    }).catch(function (e) {
      Modal.close(h);
      /* 复制已经开始却没走完：目标目录里是半份库，不回收的话下次会被 hasData 挡在门外 */
      var half = copyStarted && !copyDone;
      return FS.host.dataApplyRoot().catch(function () {})
        .then(function () { if (half) return FS.host.dataCleanup(to).catch(function () {}); })
        .then(function () {
          if (half && e && typeof e === 'object') e.cleaned = true;
          throw e;
        });
    });
  }
};


