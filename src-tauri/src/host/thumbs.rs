/* 缩略图：网格只加载 400px 小图，详情页才用原图。
 *
 * 为什么值得单独做一层：
 *   素材封面常常是 1000~2000px 的 PNG，一屏 24 张就是几十 MB 解码后的位图。
 *   落一份 400px JPEG 到 covers\thumb\ 之后，网格的内存与解码开销降到原来的十分之一量级，
 *   滚动跟手与否主要就取决于这件事。
 *
 * 约定：原图与缩略图的文件名只差目录（covers\<id>.<ext> → covers\thumb\<id>.jpg），
 *       这样素材里只要记一个 hasThumb 布尔，不必存第二套路径。
 */
use image::codecs::jpeg::JpegEncoder;
use serde_json::{json, Value};
use std::path::Path;
use std::time::SystemTime;

const THUMB_QUALITY: u8 = 78;

fn mtime(p: &Path) -> Option<SystemTime> {
    std::fs::metadata(p).ok().and_then(|m| m.modified().ok())
}

/// 生成缩略图；dst 已存在且不比 src 旧就直接复用。
pub fn thumb_ensure(src: &str, dst: &str, max_width: u32) -> Result<Value, String> {
    if src.is_empty() || dst.is_empty() {
        return Err("缺少 src/dst".into());
    }
    let src_p = Path::new(src);
    let dst_p = Path::new(dst);
    if !src_p.is_file() {
        return Err(format!("原图不存在：{src}"));
    }

    if dst_p.is_file() {
        if let (Some(a), Some(b)) = (mtime(src_p), mtime(dst_p)) {
            if b >= a {
                let size = std::fs::metadata(dst_p).map(|m| m.len()).unwrap_or(0);
                return Ok(json!({ "ok": true, "skipped": true, "path": dst, "size": size }));
            }
        }
    }

    let img = image::open(src_p).map_err(|e| format!("无法解码图片：{e}"))?;
    let (w, h) = (img.width(), img.height());
    let max = if max_width == 0 { 400 } else { max_width };

    let thumb = if w > max {
        let nh = ((h as f64) * (max as f64) / (w as f64)).round().max(1.0) as u32;
        img.resize(max, nh, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };

    if let Some(parent) = dst_p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let rgb = thumb.to_rgb8();
    let mut out = std::fs::File::create(dst_p).map_err(|e| e.to_string())?;
    let mut enc = JpegEncoder::new_with_quality(&mut out, THUMB_QUALITY);
    enc.encode_image(&rgb)
        .map_err(|e| format!("写缩略图失败：{e}"))?;

    let size = std::fs::metadata(dst_p).map(|m| m.len()).unwrap_or(0);
    Ok(json!({
        "ok": true,
        "path": dst,
        "size": size,
        "width": thumb.width(),
        "height": thumb.height(),
        "srcWidth": w,
        "srcHeight": h
    }))
}

/// 批量补齐：给一组 (src, dst) 生成缩略图；已存在的自动跳过
pub fn thumb_batch(items: &[Value], max_width: u32) -> Value {
    let mut made = 0;
    let mut skipped = 0;
    let mut failed: Vec<String> = Vec::new();
    for it in items {
        let src = it.get("src").and_then(|x| x.as_str()).unwrap_or("");
        let dst = it.get("dst").and_then(|x| x.as_str()).unwrap_or("");
        match thumb_ensure(src, dst, max_width) {
            Ok(v) => {
                if v.get("skipped").and_then(|x| x.as_bool()).unwrap_or(false) {
                    skipped += 1;
                } else {
                    made += 1;
                }
            }
            Err(e) => failed.push(format!("{src}：{e}")),
        }
    }
    json!({ "ok": true, "made": made, "skipped": skipped, "failed": failed })
}
