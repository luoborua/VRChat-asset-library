/* 网络接口：一次性抓取 + SSE 流式转发（AI 翻译用）。
 * 返回结构与原宿主 /api/fetch 一致：{ok, okFlag, status, text, headers, url} */
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::time::Duration;

const DEFAULT_TIMEOUT: u64 = 30_000;
const MIN_TIMEOUT: u64 = 5_000;
const MAX_TIMEOUT: u64 = 300_000;

fn clamp_timeout(ms: Option<u64>) -> u64 {
    match ms {
        Some(n) if n > 0 => n.clamp(MIN_TIMEOUT, MAX_TIMEOUT),
        _ => DEFAULT_TIMEOUT,
    }
}

fn only_http(url: &str) -> Result<String, String> {
    let u = url.trim();
    if u.starts_with("http://") || u.starts_with("https://") {
        Ok(u.to_string())
    } else {
        Err("仅支持 http/https URL".into())
    }
}

fn header_map(v: &Value) -> reqwest::header::HeaderMap {
    let mut map = reqwest::header::HeaderMap::new();
    if let Some(obj) = v.get("headers").and_then(|h| h.as_object()) {
        for (k, val) in obj {
            if let (Ok(name), Some(text)) = (
                reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                val.as_str(),
            ) {
                if let Ok(mut hv) = reqwest::header::HeaderValue::from_str(text) {
                    hv.set_sensitive(true);
                    map.insert(name, hv);
                }
            }
        }
    }
    map
}

pub async fn api_fetch(payload: &Value) -> Result<Value, String> {
    let url = only_http(payload.get("url").and_then(|x| x.as_str()).unwrap_or(""))?;
    let method = payload
        .get("method")
        .and_then(|x| x.as_str())
        .unwrap_or("GET")
        .to_uppercase();
    let timeout = clamp_timeout(payload.get("timeoutMs").and_then(|x| x.as_u64()));
    let headers = header_map(payload);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())?;

    let mut req = client
        .request(
            reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?,
            &url,
        )
        .headers(headers);
    if let Some(body) = payload.get("body").and_then(|x| x.as_str()) {
        if method != "GET" && method != "HEAD" {
            req = req.body(body.to_string());
        }
    }

    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let ok_flag = res.status().is_success();
    let final_url = res.url().to_string();
    let mut out_headers = serde_json::Map::new();
    for (k, v) in res.headers().iter() {
        out_headers.insert(
            k.as_str().to_string(),
            Value::String(v.to_str().unwrap_or("").to_string()),
        );
    }
    let text = res.text().await.map_err(|e| e.to_string())?;
    Ok(json!({
        "ok": true,
        "okFlag": ok_flag,
        "status": status,
        "text": text,
        "headers": out_headers,
        "url": final_url
    }))
}

/// 流式转发：把上游分块以 {type:'head'|'chunk'|'error'} 的 JSON 帧推给页面。
/// 与 40-fs.js 的 streamFetch 解析器一一对应（换成 Tauri Channel 传输，语义不变）。
pub async fn api_stream(
    payload: &Value,
    on_event: &tauri::ipc::Channel<String>,
) -> Result<Value, String> {
    let url = only_http(payload.get("url").and_then(|x| x.as_str()).unwrap_or(""))?;
    let method = payload
        .get("method")
        .and_then(|x| x.as_str())
        .unwrap_or("GET")
        .to_uppercase();
    let idle = clamp_timeout(payload.get("timeoutMs").and_then(|x| x.as_u64()));
    let headers = header_map(payload);

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())?;

    let mut req = client
        .request(
            reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?,
            &url,
        )
        .headers(headers);
    if let Some(body) = payload.get("body").and_then(|x| x.as_str()) {
        if method != "GET" && method != "HEAD" {
            req = req.body(body.to_string());
        }
    }

    let res = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            let _ = on_event.send(json!({"type":"error","error": e.to_string()}).to_string());
            return Ok(json!({ "ok": false, "error": e.to_string() }));
        }
    };

    let status = res.status().as_u16();
    let ok_flag = res.status().is_success();
    let _ = on_event.send(
        json!({"type":"head","status": status, "ok": ok_flag}).to_string(),
    );

    let mut stream = res.bytes_stream();
    let mut total = String::new();
    loop {
        let next = tokio::time::timeout(Duration::from_millis(idle), stream.next()).await;
        match next {
            Err(_) => {
                let msg = format!("请求超时（{idle}ms 无数据）");
                let _ = on_event.send(json!({"type":"error","error": msg}).to_string());
                return Ok(json!({ "ok": false, "error": msg }));
            }
            Ok(None) => break,
            Ok(Some(Err(e))) => {
                let _ = on_event.send(json!({"type":"error","error": e.to_string()}).to_string());
                return Ok(json!({ "ok": false, "error": e.to_string() }));
            }
            Ok(Some(Ok(chunk))) => {
                let text = String::from_utf8_lossy(&chunk).to_string();
                if !text.is_empty() {
                    total.push_str(&text);
                    let _ = on_event.send(json!({"type":"chunk","text": text}).to_string());
                }
            }
        }
    }
    Ok(json!({ "ok": true, "status": status, "text": total }))
}
