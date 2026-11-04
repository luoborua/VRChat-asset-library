/* 下载：/api/download（等下载完成才返回）与 /api/downloadProgress（进度轮询）
 * 行为对齐原宿主：同路径互斥、覆盖重下走 .part 临时文件、断点续传、失败重试、可取消。 */
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::io::AsyncWriteExt;

const RETRIES: u32 = 2;

#[derive(Clone, Default)]
pub struct DlJob {
    pub job_id: String,
    pub path: String,
    pub received: u64,
    pub total: u64,
    pub speed: u64,
    pub attempt: u32,
    pub done: bool,
    pub error: String,
    pub started_at: u64,
    pub sample_at: u64,
    pub sample_bytes: u64,
}

impl DlJob {
    fn to_json(&self) -> Value {
        json!({
            "jobId": self.job_id,
            "path": self.path,
            "received": self.received,
            "total": self.total,
            "speed": self.speed,
            "attempt": self.attempt,
            "segments": 1,
            "done": self.done,
            "error": self.error,
            "startedAt": self.started_at
        })
    }
}

#[derive(Default)]
pub struct DlState {
    pub jobs: Arc<Mutex<HashMap<String, DlJob>>>,
    pub active: Arc<Mutex<HashMap<String, String>>>,
    pub cancels: Arc<Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
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

pub fn progress(state: &DlState, job_id: &str) -> Value {
    let jobs = state.jobs.lock().unwrap();
    match jobs.get(job_id) {
        Some(j) => {
            let mut out = j.to_json();
            if let Value::Object(ref mut m) = out {
                m.insert("ok".into(), Value::Bool(true));
                m.insert("job".into(), j.to_json());
            }
            out
        }
        None => json!({
            "ok": true,
            "jobId": job_id,
            "received": 0, "total": 0, "speed": 0, "done": false, "error": "",
            "job": { "jobId": job_id, "received": 0, "total": 0, "speed": 0, "done": false, "error": "" }
        }),
    }
}

pub fn cancel(state: &DlState, job_id: &str) -> Value {
    let cancels = state.cancels.lock().unwrap();
    match cancels.get(job_id) {
        Some(tx) => {
            let _ = tx.send(true);
            if let Some(j) = state.jobs.lock().unwrap().get_mut(job_id) {
                j.error = "已取消".into();
                j.done = true;
            }
            json!({ "ok": true, "cancelled": true })
        }
        None => json!({ "ok": true, "cancelled": false, "reason": "任务已结束或不存在" }),
    }
}

pub async fn api_download(state: &DlState, payload: &Value) -> Result<Value, String> {
    let url = payload.get("url").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let dst = payload.get("path").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let job_id = payload
        .get("jobId")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("dl_{}", now_ms()));
    let overwrite = payload.get("overwrite").and_then(|x| x.as_bool()).unwrap_or(false);
    let headers = header_map(payload);

    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("仅支持 http/https URL".into());
    }
    if dst.is_empty() {
        return Err("缺少 path".into());
    }

    let key = dst.to_lowercase();
    {
        let mut active = state.active.lock().unwrap();
        if active.contains_key(&key) {
            return Err(format!("同一文件正在下载中，已忽略重复请求：{dst}"));
        }
        active.insert(key.clone(), job_id.clone());
    }

    if let Ok(m) = tokio::fs::metadata(&dst).await {
        if m.is_file() && !overwrite {
            state.active.lock().unwrap().remove(&key);
            return Ok(json!({ "ok": true, "exists": true, "size": m.len(), "path": dst, "jobId": job_id }));
        }
    }

    let job = DlJob {
        job_id: job_id.clone(),
        path: dst.clone(),
        started_at: now_ms(),
        sample_at: now_ms(),
        ..Default::default()
    };
    state.jobs.lock().unwrap().insert(job_id.clone(), job);
    let (tx, rx) = tokio::sync::watch::channel(false);
    state.cancels.lock().unwrap().insert(job_id.clone(), tx);

    let result = download_inner(state, &url, &dst, headers, &job_id, overwrite, rx).await;

    state.active.lock().unwrap().remove(&key);
    state.cancels.lock().unwrap().remove(&job_id);

    match result {
        Ok(size) => {
            if let Some(j) = state.jobs.lock().unwrap().get_mut(&job_id) {
                j.done = true;
                j.received = size;
                j.total = size;
                j.speed = 0;
            }
            Ok(json!({ "ok": true, "size": size, "path": dst, "jobId": job_id }))
        }
        Err(e) => {
            if let Some(j) = state.jobs.lock().unwrap().get_mut(&job_id) {
                if j.error.is_empty() {
                    j.error = e.clone();
                }
            }
            Err(e)
        }
    }
}

async fn download_inner(
    state: &DlState,
    url: &str,
    dst: &str,
    headers: reqwest::header::HeaderMap,
    job_id: &str,
    overwrite: bool,
    rx: tokio::sync::watch::Receiver<bool>,
) -> Result<u64, String> {
    if let Some(parent) = PathBuf::from(dst).parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }
    let part = format!("{dst}.part");
    if overwrite {
        let _ = tokio::fs::remove_file(&part).await;
    }

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())?;

    let mut last_err = String::new();
    for attempt in 1..=RETRIES {
        if let Some(j) = state.jobs.lock().unwrap().get_mut(job_id) {
            j.attempt = attempt;
        }
        match once(state, &client, url, &part, &headers, job_id, rx.clone()).await {
            Ok(size) => {
                let _ = tokio::fs::remove_file(dst).await;
                tokio::fs::rename(&part, dst).await.map_err(|e| e.to_string())?;
                return Ok(size);
            }
            Err(e) => {
                if e == "已取消" {
                    return Err(e);
                }
                last_err = e;
                if attempt < RETRIES {
                    tokio::time::sleep(std::time::Duration::from_millis(800 * attempt as u64)).await;
                }
            }
        }
    }
    Err(last_err)
}

/// 单次尝试（支持从 .part 续传）；返回最终字节数
async fn once(
    state: &DlState,
    client: &reqwest::Client,
    url: &str,
    part: &str,
    headers: &reqwest::header::HeaderMap,
    job_id: &str,
    mut cancel: tokio::sync::watch::Receiver<bool>,
) -> Result<u64, String> {
    let mut start = tokio::fs::metadata(part).await.map(|m| m.len()).unwrap_or(0);

    let mut req = client.get(url).headers(headers.clone());
    if start > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={start}-"));
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    if !status.is_success() && status.as_u16() != 206 {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    let resumed = status.as_u16() == 206;
    if start > 0 && !resumed {
        start = 0;
    }
    let len = res.content_length().unwrap_or(0);
    let total = if resumed { start + len } else { len };

    if let Some(j) = state.jobs.lock().unwrap().get_mut(job_id) {
        j.total = total;
        j.received = start;
        j.sample_bytes = start;
        j.sample_at = now_ms();
    }

    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(resumed)
        .truncate(!resumed)
        .open(part)
        .await
        .map_err(|e| e.to_string())?;

    let mut received = start;
    let mut stream = res.bytes_stream();
    loop {
        tokio::select! {
            changed = cancel.changed() => {
                if changed.is_ok() && *cancel.borrow() {
                    let _ = file.flush().await;
                    return Err("已取消".into());
                }
            }
            item = stream.next() => {
                match item {
                    None => break,
                    Some(Err(e)) => return Err(e.to_string()),
                    Some(Ok(chunk)) => {
                        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
                        received += chunk.len() as u64;
                        let now = now_ms();
                        if let Some(j) = state.jobs.lock().unwrap().get_mut(job_id) {
                            j.received = received;
                            let dt = (now.saturating_sub(j.sample_at)) as f64 / 1000.0;
                            if dt >= 0.4 {
                                j.speed = (((received.saturating_sub(j.sample_bytes)) as f64) / dt) as u64;
                                j.sample_at = now;
                                j.sample_bytes = received;
                            }
                        }
                    }
                }
            }
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    Ok(received)
}
