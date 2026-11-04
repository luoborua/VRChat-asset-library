/* WebDAV：test / list / put / get / mkcol
 * 只用标准方法（PROPFIND / PUT / GET / MKCOL）+ Basic 认证，零第三方依赖。 */
use serde_json::{json, Value};
use std::io::Write;
use std::path::Path;
use std::time::Duration;

fn auth_header(username: &str, password: &str) -> Option<String> {
    if username.is_empty() && password.is_empty() {
        return None;
    }
    use base64::Engine;
    let raw = format!("{username}:{password}");
    Some(format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(raw.as_bytes())
    ))
}

fn ensure_url(u: &str) -> Result<String, String> {
    let s = u.trim();
    if s.starts_with("http://") || s.starts_with("https://") {
        Ok(s.to_string())
    } else {
        Err("仅支持 http/https 地址".into())
    }
}

fn with_slash(u: &str) -> String {
    if u.ends_with('/') {
        u.to_string()
    } else {
        format!("{u}/")
    }
}

fn decode_name(href: &str) -> String {
    let clean = href.trim_end_matches('/');
    let seg = clean.rsplit('/').next().unwrap_or("");
    percent_encoding::percent_decode_str(seg)
        .decode_utf8_lossy()
        .to_string()
}

fn unescape(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

#[derive(Default, Debug)]
struct DavEntry {
    name: String,
    is_dir: bool,
    size: u64,
}

/// 极简 XML 记号化：<tag attr="x"> / </tag> / <tag/>
fn tokenize(xml: &str) -> Vec<(String, bool, bool, usize, usize)> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    while let Some(i) = xml[pos..].find('<') {
        let start = pos + i;
        let end = match xml[start..].find('>') {
            Some(j) => start + j + 1,
            None => break,
        };
        let inner = &xml[start + 1..end - 1];
        pos = end;
        if inner.starts_with('?') || inner.starts_with('!') || inner.trim().is_empty() {
            continue;
        }
        let closing = inner.starts_with('/');
        let body = inner.trim_start_matches('/');
        let self_closing = body.ends_with('/');
        let name: String = body
            .trim_end_matches('/')
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_lowercase();
        out.push((name, closing, self_closing, start, end));
    }
    out
}

fn parse_multistatus(xml: &str) -> Vec<DavEntry> {
    let tags = tokenize(xml);
    let mut out: Vec<DavEntry> = Vec::new();
    let mut in_resp = false;
    let mut cur = DavEntry::default();

    for (i, (name, closing, _self, _s, e)) in tags.iter().enumerate() {
        let text_end = tags.get(i + 1).map(|t| t.3).unwrap_or(xml.len());
        let text = xml[*e..text_end].trim().to_string();
        if name.ends_with("response") {
            if *closing {
                if in_resp && !cur.name.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
                in_resp = false;
            } else {
                in_resp = true;
                cur = DavEntry::default();
            }
            continue;
        }
        if !in_resp {
            continue;
        }
        if name.ends_with("collection") {
            cur.is_dir = true;
        } else if name.ends_with("href") && !*closing {
            cur.name = decode_name(&unescape(&text));
        } else if name.ends_with("getcontentlength") && !*closing {
            cur.size = text.parse().unwrap_or(0);
        }
    }
    out
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())
}

async fn propfind(
    url: &str,
    depth: u8,
    cred: &Value,
) -> Result<(u16, String), String> {
    let user = cred.get("username").and_then(|x| x.as_str()).unwrap_or("");
    let pass = cred.get("password").and_then(|x| x.as_str()).unwrap_or("");
    let body = if depth == 0 {
        r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>"#
    } else {
        r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>"#
    };
    let mut req = client()?
        .request(
            reqwest::Method::from_bytes(b"PROPFIND").map_err(|e| e.to_string())?,
            url,
        )
        .header("Depth", depth.to_string())
        .header("Content-Type", "application/xml; charset=utf-8")
        .body(body);
    if let Some(a) = auth_header(user, pass) {
        req = req.header("Authorization", a);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let text = res.text().await.map_err(|e| e.to_string())?;
    Ok((status, text))
}

fn cred_of(payload: &Value) -> Value {
    json!({
        "username": payload.get("username").and_then(|x| x.as_str()).unwrap_or(""),
        "password": payload.get("password").and_then(|x| x.as_str()).unwrap_or("")
    })
}

pub async fn test(payload: &Value) -> Result<Value, String> {
    let url = with_slash(&ensure_url(
        payload.get("url").and_then(|x| x.as_str()).unwrap_or(""),
    )?);
    let (status, _) = propfind(&url, 0, &cred_of(payload)).await?;
    if status == 401 || status == 403 {
        return Err(format!("认证失败（HTTP {status}）"));
    }
    if !(200..300).contains(&status) && status != 207 {
        return Err(format!("连接失败（HTTP {status}）"));
    }
    Ok(json!({ "ok": true, "status": status, "url": url }))
}

pub async fn list(payload: &Value) -> Result<Value, String> {
    let url = with_slash(&ensure_url(
        payload.get("url").and_then(|x| x.as_str()).unwrap_or(""),
    )?);
    let (status, text) = propfind(&url, 1, &cred_of(payload)).await?;
    if status == 401 || status == 403 {
        return Err(format!("认证失败（HTTP {status}）"));
    }
    if !(200..300).contains(&status) && status != 207 {
        return Err(format!("读取目录失败（HTTP {status}）"));
    }
    let self_name = decode_name(&url);
    let mut entries: Vec<Value> = parse_multistatus(&text)
        .into_iter()
        .filter(|e| !(e.is_dir && e.name == self_name))
        .filter(|e| !e.name.is_empty() && e.name != ".." && e.name != ".")
        .map(|e| json!({ "href": e.name, "name": e.name, "isDir": e.is_dir, "size": e.size }))
        .collect();
    entries.sort_by(|a, b| {
        let ad = a.get("isDir").and_then(|x| x.as_bool()).unwrap_or(false);
        let bd = b.get("isDir").and_then(|x| x.as_bool()).unwrap_or(false);
        bd.cmp(&ad).then_with(|| {
            a.get("name")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .cmp(b.get("name").and_then(|x| x.as_str()).unwrap_or(""))
        })
    });
    Ok(json!({ "ok": true, "entries": entries }))
}

pub async fn put(payload: &Value) -> Result<Value, String> {
    let url = ensure_url(payload.get("url").and_then(|x| x.as_str()).unwrap_or(""))?;
    let local = payload
        .get("localPath")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let m = tokio::fs::metadata(&local).await.map_err(|_| format!("本地不是文件：{local}"))?;
    if !m.is_file() {
        return Err(format!("本地不是文件：{local}"));
    }
    let bytes = tokio::fs::read(&local).await.map_err(|e| e.to_string())?;
    let user = payload.get("username").and_then(|x| x.as_str()).unwrap_or("");
    let pass = payload.get("password").and_then(|x| x.as_str()).unwrap_or("");
    let mut req = client()?
        .put(&url)
        .header("Content-Length", bytes.len().to_string())
        .body(bytes);
    if let Some(a) = auth_header(user, pass) {
        req = req.header("Authorization", a);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    if !(200..300).contains(&status) && status != 201 && status != 204 {
        return Err(format!("上传失败（HTTP {status}）"));
    }
    Ok(json!({ "ok": true, "status": status, "size": m.len() }))
}

pub async fn get(payload: &Value) -> Result<Value, String> {
    let url = ensure_url(payload.get("url").and_then(|x| x.as_str()).unwrap_or(""))?;
    let local = payload
        .get("localPath")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    if local.is_empty() {
        return Err("缺少 localPath".into());
    }
    let user = payload.get("username").and_then(|x| x.as_str()).unwrap_or("");
    let pass = payload.get("password").and_then(|x| x.as_str()).unwrap_or("");
    let mut req = client()?.get(&url);
    if let Some(a) = auth_header(user, pass) {
        req = req.header("Authorization", a);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("下载失败（HTTP {}）", res.status().as_u16()));
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    if let Some(parent) = Path::new(&local).parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    let part = format!("{local}.part");
    let mut f = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    f.write_all(&bytes).map_err(|e| e.to_string())?;
    drop(f);
    let _ = tokio::fs::remove_file(&local).await;
    tokio::fs::rename(&part, &local).await.map_err(|e| e.to_string())?;
    Ok(json!({ "ok": true, "size": bytes.len(), "path": local }))
}

pub async fn mkcol(payload: &Value) -> Result<Value, String> {
    let url = with_slash(&ensure_url(
        payload.get("url").and_then(|x| x.as_str()).unwrap_or(""),
    )?);
    let user = payload.get("username").and_then(|x| x.as_str()).unwrap_or("");
    let pass = payload.get("password").and_then(|x| x.as_str()).unwrap_or("");
    let mut req = client()?.request(
        reqwest::Method::from_bytes(b"MKCOL").map_err(|e| e.to_string())?,
        &url,
    );
    if let Some(a) = auth_header(user, pass) {
        req = req.header("Authorization", a);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    if !(200..300).contains(&status) && status != 405 {
        return Err(format!("新建目录失败（HTTP {status}）"));
    }
    Ok(json!({ "ok": true, "status": status }))
}
