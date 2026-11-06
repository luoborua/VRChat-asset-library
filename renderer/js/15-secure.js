/* ============ 15-secure.js ============ */
/* =====================================================================
 * 15-secure.js  —  本机加密（仅用于用户手动输入的 Cookie）
 *   · 使用 Web Crypto AES-GCM，密钥为「不可导出」CryptoKey，存于本机 IndexedDB
 *   · 托管对象：站点 Cookie / AI Key / GitHub Token（账号密码一律不存储）
 *   · 非安全上下文 / 无 crypto.subtle 时降级为混淆编码，并在界面明确提示
 * ===================================================================== */

var Secure = (function () {
  var keyP = null;

  function available() {
    return !!(window.crypto && window.crypto.subtle && window.isSecureContext);
  }

  function getKey() {
    if (keyP) return keyP;
    keyP = Promise.resolve().then(function () {
      if (!available() || !Store.isIDB) return null;      // LocalStorage 无法保存 CryptoKey
      return Store.kvGet('cryptoKey', null).then(function (k) {
        if (k) return k;
        return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
          .then(function (key) { return Store.kvSet('cryptoKey', key).then(function () { return key; }); });
      });
    }).catch(function () { return null; });
    return keyP;
  }

  function b64enc(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function b64dec(str) {
    var raw = atob(str), out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  /** 加密（返回 Promise<string>）。失败时降级为混淆编码。 */
  function encrypt(text) {
    if (!text) return Promise.resolve('');
    return getKey().then(function (key) {
      if (!key) return obfuscate(text);
      var iv = crypto.getRandomValues(new Uint8Array(12));
      return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(text))
        .then(function (buf) {
          var body = new Uint8Array(buf);
          var all = new Uint8Array(iv.length + body.length);
          all.set(iv, 0); all.set(body, iv.length);
          return 'enc:' + b64enc(all);
        });
    }).catch(function () { return obfuscate(text); });
  }

  /** 解密（返回 Promise<string>），兼容旧的混淆编码 */
  function decrypt(payload) {
    var s = String(payload || '');
    if (!s) return Promise.resolve('');
    if (s.slice(0, 4) !== 'enc:') return Promise.resolve(deobfuscate(s));
    return getKey().then(function (key) {
      if (!key) return '';
      var all = b64dec(s.slice(4));
      var iv = all.slice(0, 12), body = all.slice(12);
      return crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, body)
        .then(function (buf) { return new TextDecoder().decode(buf); });
    }).catch(function () { return ''; });
  }

  /** 描述当前的保护级别，用于界面提示 */
  function level() {
    if (!Store.isIDB) return { name: '混淆编码（降级）', strong: false, why: '当前为 LocalStorage 降级模式，无法保存加密密钥。' };
    if (!available())  return { name: '混淆编码（降级）', strong: false, why: '当前上下文不支持 Web Crypto（需安全上下文，如 https 或 localhost / 本地文件）。' };
    return { name: 'AES-GCM 256 本机加密', strong: true, why: '密钥为不可导出的 CryptoKey，仅存在于本机浏览器数据库中。' };
  }

  return { encrypt: encrypt, decrypt: decrypt, available: available, level: level };
})();

