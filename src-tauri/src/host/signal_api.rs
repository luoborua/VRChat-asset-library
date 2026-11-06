/* signal_api.rs — 应用内置的 P2P 信令服务（仅局域网）。
 *
 * 之前是让用户双击一个 bat 跑 Node 脚本，地址还要自己抄。现在改成应用里点一下开关：
 * 服务在 Rust 这边起，端口和本机内网地址直接算出来。
 *
 * 只服务同一个局域网：接收方不需要知道 IP —— 应用向局域网广播一个探测包，
 * 装了本服务的那台会回一句「我在这，端口是 X」，于是对方只需要一个 6 位口令。
 *
 * 为什么自己写 WebSocket 而不加依赖：
 *   离线构建（cargo --offline）拉不到 tungstenite，而这里只需要「文本帧 + 单帧」两条规则。
 *   代价是要自带一个 SHA-1，就六十行，比引一个包更省事。
 */

use base64::Engine;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

const DEFAULT_PORT: u16 = 8787;
const PORT_TRIES: u16 = 10;
const MAX_FRAME: u64 = 1 << 20; // 一条 SDP 也就几 KB，1 MB 是防炸上限

/* 局域网发现：UDP 探测。多个端口是为了「前一个被别的程序占了还能用」，
 * 两端都按这个顺序试，谁先回就用谁。 */
const DISCOVERY_PORTS: [u16; 5] = [8786, 8787, 8788, 8789, 8790];
const DISCOVERY_TAG: &str = "VRCLIB-P2P/1";

/* ============================ SHA-1 ============================ */

fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    let mut msg = data.to_vec();
    let bits = (msg.len() as u64).wrapping_mul(8);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bits.to_be_bytes());

    for chunk in msg.chunks(64) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let (mut a, mut b, mut c, mut d, mut e) = (h[0], h[1], h[2], h[3], h[4]);
        for i in 0..80 {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A827999u32),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };
            let t = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(w[i]);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = t;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }

    let mut out = [0u8; 20];
    for i in 0..5 {
        out[i * 4..i * 4 + 4].copy_from_slice(&h[i].to_be_bytes());
    }
    out
}

/* ============================ WebSocket 帧 ============================ */

fn ws_frame(text: &str) -> Vec<u8> {
    let p = text.as_bytes();
    let mut out = Vec::with_capacity(p.len() + 10);
    out.push(0x81); // FIN + text
    if p.len() < 126 {
        out.push(p.len() as u8);
    } else if p.len() < 65536 {
        out.push(126);
        out.extend_from_slice(&(p.len() as u16).to_be_bytes());
    } else {
        out.push(127);
        out.extend_from_slice(&(p.len() as u64).to_be_bytes());
    }
    out.extend_from_slice(p);
    out
}

enum Frame {
    Text(String),
    Other,
    Close,
}

async fn read_frame<R: tokio::io::AsyncRead + Unpin>(r: &mut R) -> Option<Frame> {
    let mut h = [0u8; 2];
    r.read_exact(&mut h).await.ok()?;
    let opcode = h[0] & 0x0f;
    let masked = h[1] & 0x80 != 0;
    let mut len = (h[1] & 0x7f) as u64;
    if len == 126 {
        let mut b = [0u8; 2];
        r.read_exact(&mut b).await.ok()?;
        len = u16::from_be_bytes(b) as u64;
    } else if len == 127 {
        let mut b = [0u8; 8];
        r.read_exact(&mut b).await.ok()?;
        len = u64::from_be_bytes(b);
    }
    if len > MAX_FRAME {
        return None;
    }
    let mut mask = [0u8; 4];
    if masked {
        r.read_exact(&mut mask).await.ok()?;
    }
    let mut payload = vec![0u8; len as usize];
    if len > 0 {
        r.read_exact(&mut payload).await.ok()?;
    }
    if masked {
        for i in 0..payload.len() {
            payload[i] ^= mask[i & 3];
        }
    }
    match opcode {
        0x8 => Some(Frame::Close),
        0x1 | 0x2 => match String::from_utf8(payload) {
            Ok(s) => Some(Frame::Text(s)),
            Err(_) => Some(Frame::Other),
        },
        _ => Some(Frame::Other),
    }
}

/* ============================ 房间 ============================ */

type Sender = mpsc::UnboundedSender<String>;

#[derive(Default)]
struct Room {
    host: Option<Sender>,
    guest: Option<Sender>,
}

impl Room {
    fn peer(&self, role: &str) -> Option<&Sender> {
        if role == "host" {
            self.guest.as_ref()
        } else {
            self.host.as_ref()
        }
    }
    fn send(&self, to: &str, msg: &str) {
        let tx = if to == "host" { self.host.as_ref() } else { self.guest.as_ref() };
        if let Some(t) = tx {
            let _ = t.send(msg.to_string());
        }
    }
}

#[derive(Default)]
struct Rooms {
    map: HashMap<String, Room>,
}

impl Rooms {
    fn leave(&mut self, code: &str, role: &str) {
        if let Some(r) = self.map.get_mut(code) {
            if role == "host" {
                r.host = None;
            } else {
                r.guest = None;
            }
            r.send(if role == "host" { "guest" } else { "host" }, r#"{"t":"peer-left"}"#);
            if r.host.is_none() && r.guest.is_none() {
                self.map.remove(code);
            }
        }
    }
}

/* ============================ 服务 ============================ */

pub struct SignalState {
    inner: Mutex<Option<Running>>,
}

struct Running {
    port: u16,
    lan: String,
    stop: Arc<AtomicBool>,
    task: tokio::task::JoinHandle<()>,
    disc: Option<tokio::task::JoinHandle<()>>,
}

impl Default for SignalState {
    fn default() -> Self {
        Self { inner: Mutex::new(None) }
    }
}

/// 本机在局域网里的地址：往 8.8.8.8 建一个 UDP「连接」拿路由选出的源地址。
/// UDP connect 不发包，所以断网也能用；比遍历网卡靠谱得多（虚拟网卡一大把）。
fn lan_ip() -> String {
    let sock = match std::net::UdpSocket::bind("0.0.0.0:0") {
        Ok(s) => s,
        Err(_) => return String::new(),
    };
    if sock.connect("8.8.8.8:80").is_err() {
        return String::new();
    }
    match sock.local_addr() {
        Ok(a) => a.ip().to_string(),
        Err(_) => String::new(),
    }
}

fn valid_code(c: &str) -> bool {
    c.len() == 6
        && c.bytes().all(|b| b.is_ascii_digit() || (b.is_ascii_uppercase() && !b"ILOU".contains(&b)))
}

pub fn status(state: &SignalState) -> Value {
    let g = state.inner.lock().unwrap();
    /* 看门狗可能已经置位 stop（空闲 15 分钟自动关闭），这时不能再报 running */
    if let Some(r) = g.as_ref() {
        if r.stop.load(Ordering::Relaxed) {
            return json!({ "ok": true, "running": false, "self": "", "peer": "" });
        }
    }
    match g.as_ref() {
        Some(r) => json!({
            "ok": true, "running": true, "port": r.port, "lan": r.lan,
            "self": format!("ws://127.0.0.1:{}", r.port),
            "peer": if r.lan.is_empty() { String::new() } else { format!("ws://{}:{}", r.lan, r.port) },
        }),
        None => json!({ "ok": true, "running": false, "self": "", "peer": "" }),
    }
}

pub fn stop(state: &SignalState) -> Value {
    let mut g = state.inner.lock().unwrap();
    if let Some(r) = g.take() {
        r.stop.store(true, Ordering::Relaxed);
        r.task.abort();
        if let Some(d) = r.disc {
            d.abort();
        }
        return json!({ "ok": true, "stopped": true, "port": r.port });
    }
    json!({ "ok": true, "stopped": false })
}

/* ======================= 局域网发现（UDP） ======================= */

async fn run_discovery(sock: tokio::net::UdpSocket, port: u16, stop: Arc<AtomicBool>) {
    let mut buf = [0u8; 256];
    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let got = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            sock.recv_from(&mut buf),
        )
        .await;
        let (n, from) = match got {
            Ok(Ok(v)) => v,
            Ok(Err(_)) => break,
            Err(_) => continue,
        };
        let text = String::from_utf8_lossy(&buf[..n]).to_string();
        let mut it = text.split_whitespace();
        if it.next() != Some(DISCOVERY_TAG) {
            continue;
        }
        /* 把对方的随机 token 原样带回去，方便它确认「这条回执是回应我那一次探测的」 */
        let token = match it.next() {
            Some(t) => t,
            None => continue,
        };
        let reply = format!("{} {} {}", DISCOVERY_TAG, token, port);
        let _ = sock.send_to(reply.as_bytes(), from).await;
    }
}

/// 本机所有可用的 IPv4 网段（地址 + 前缀长度）。
/// 虚拟网卡（Radmin / ZeroTier 这类）也要算 —— 它们不是默认路由，只往默认网卡广播是发不进去的。
#[cfg(windows)]
fn local_v4_networks() -> Vec<(std::net::Ipv4Addr, u8)> {
    use std::net::Ipv4Addr;
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER,
        GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH,
    };
    use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_UNSPEC, SOCKADDR_IN};

    const ERROR_BUFFER_OVERFLOW: u32 = 111;
    const IF_TYPE_SOFTWARE_LOOPBACK: u32 = 24;

    let mut out = Vec::new();
    let flags = (GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER) as u32;
    let mut size: u32 = 16 * 1024;
    let mut buf = vec![0u8; size as usize];

    let mut ret = unsafe {
        GetAdaptersAddresses(
            AF_UNSPEC as u32,
            flags,
            std::ptr::null_mut(),
            buf.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH,
            &mut size,
        )
    };
    if ret == ERROR_BUFFER_OVERFLOW {
        buf.resize(size as usize, 0);
        ret = unsafe {
            GetAdaptersAddresses(
                AF_UNSPEC as u32,
                flags,
                std::ptr::null_mut(),
                buf.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH,
                &mut size,
            )
        };
    }
    if ret != 0 {
        return out;
    }

    let mut p = buf.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
    while !p.is_null() {
        let adapter = unsafe { &*p };
        if adapter.IfType != IF_TYPE_SOFTWARE_LOOPBACK {
            let mut u = adapter.FirstUnicastAddress;
            while !u.is_null() {
                let uni = unsafe { &*u };
                let sa = uni.Address.lpSockaddr;
                if !sa.is_null() && unsafe { (*sa).sa_family } == AF_INET as u16 {
                    let sin = sa as *const SOCKADDR_IN;
                    /* S_addr 内存里已经是网络字节序，直接按内存读出来就是 a.b.c.d */
                    let b = unsafe { (*sin).sin_addr.S_un.S_addr }.to_ne_bytes();
                    let ip = Ipv4Addr::new(b[0], b[1], b[2], b[3]);
                    let prefix = uni.OnLinkPrefixLength;
                    /* 虚拟网卡（Radmin/ZeroTier/Hamachi）常报 /31 /32 或 0，不能因此丢掉它 */
                    if !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified() {
                        out.push((ip, prefix));
                    }
                }
                u = uni.Next;
            }
        }
        p = adapter.Next;
    }
    out
}

#[cfg(not(windows))]
fn local_v4_networks() -> Vec<(std::net::Ipv4Addr, u8)> {
    Vec::new()
}

/// 一张网卡可能对应多个候选广播地址：虚拟网卡上报的前缀经常不准（/32、/31、0），
/// 单靠上报值会直接算不出广播；这里再补 /24 /16 /8 三种常见掩码。
fn broadcast_candidates(ip: std::net::Ipv4Addr, prefix: u8) -> Vec<std::net::Ipv4Addr> {
    let mut out: Vec<std::net::Ipv4Addr> = Vec::new();
    let mut push = |bc: std::net::Ipv4Addr| {
        if !out.contains(&bc) && bc != ip {
            out.push(bc);
        }
    };
    if let Some(bc) = broadcast_of(ip, prefix) {
        push(bc);
    }
    for p in [24u8, 16, 8] {
        if let Some(bc) = broadcast_of(ip, p) {
            push(bc);
        }
    }
    out
}
/// 由地址 + 前缀长度算出该网段的广播地址
fn broadcast_of(ip: std::net::Ipv4Addr, prefix: u8) -> Option<std::net::Ipv4Addr> {
    if prefix == 0 || prefix >= 31 {
        return None;
    }
    let mask: u32 = u32::MAX << (32 - prefix);
    Some(std::net::Ipv4Addr::from(u32::from(ip) | !mask))
}

/// 找局域网里正在跑信令服务的那台。找不到返回 found=false，由界面给提示。
pub async fn discover() -> Result<Value, String> {
    /* 每张网卡各发一份：绑到该网卡的地址上，广播才走那张网卡。
     * 只绑 0.0.0.0 的话，包只会从默认路由出去 —— Radmin / ZeroTier 这类虚拟网卡
     * 的 metric 很高，永远排不到默认路由，于是永远找不到对方。 */
    let mut socks: Vec<tokio::net::UdpSocket> = Vec::new();
    /* 每张网卡都建一个 socket：即使前缀算不出广播（/31、/32 的虚拟网卡），
       也要能从这张网卡发出去（受限广播 + 候选广播地址）。 */
    for (ip, _prefix) in local_v4_networks() {
        if let Ok(s) = tokio::net::UdpSocket::bind((ip, 0)).await {
            socks.push(s);
        }
    }
    /* 兜底：普通局域网（单网卡 / 默认路由就是对的）走受限广播，最省事也最可靠 */
    if let Ok(s) = tokio::net::UdpSocket::bind("0.0.0.0:0").await {
        socks.push(s);
    }
    if socks.is_empty() {
        return Err("没有可用的网卡，无法在局域网里找对方".into());
    }

    let token = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
        .to_string();
    let probe = format!("{} {}", DISCOVERY_TAG, token);

    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();

    for s in socks {
        let _ = s.set_broadcast(true);
        let probe2 = probe.clone();
        let tx2 = tx.clone();
        let token2 = token.clone();
        tokio::spawn(async move {
            /* 先把探测包发出去：定向广播 + 受限广播各一次，覆盖不同路由器的过滤策略 */
            let local = s.local_addr().ok();
            if let Some(addr) = local {
                let ip = match addr.ip() {
                    std::net::IpAddr::V4(v4) => v4,
                    _ => std::net::Ipv4Addr::UNSPECIFIED,
                };
                if let Some((_, prefix)) = local_v4_networks()
                    .into_iter()
                    .find(|(a, _)| *a == ip)
                {
                    for bc in broadcast_candidates(ip, prefix) {
                        for p in DISCOVERY_PORTS {
                            let _ = s.send_to(probe2.as_bytes(), (bc, p)).await;
                        }
                    }
                }
            }
            for p in DISCOVERY_PORTS {
                let _ = s.send_to(probe2.as_bytes(), ("255.255.255.255", p)).await;
            }

            /* 重发两轮：广播本身不可靠，虚拟网卡（Radmin / Hamachi）尤其容易丢第一包 */
            for _ in 0..2 {
                tokio::time::sleep(std::time::Duration::from_millis(350)).await;
                for p in DISCOVERY_PORTS {
                    let _ = s.send_to(probe2.as_bytes(), ("255.255.255.255", p)).await;
                }
                if let Ok(local2) = s.local_addr() {
                    if let std::net::IpAddr::V4(v4) = local2.ip() {
                        for bc in broadcast_candidates(v4, 24) {
                            for p in DISCOVERY_PORTS {
                                let _ = s.send_to(probe2.as_bytes(), (bc, p)).await;
                            }
                        }
                    }
                }
            }
            /* 收 3.2 秒，命中就回报，然后自我了断 */
            let me = lan_ip();
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(3200);
            let mut buf = [0u8; 256];
            loop {
                let left = deadline.saturating_duration_since(std::time::Instant::now());
                if left.is_zero() {
                    break;
                }
                match tokio::time::timeout(left, s.recv_from(&mut buf)).await {
                    Ok(Ok((n, from))) => {
                        let text = String::from_utf8_lossy(&buf[..n]).to_string();
                        let mut it = text.split_whitespace();
                        if it.next() != Some(DISCOVERY_TAG) {
                            continue;
                        }
                        if it.next() != Some(token2.as_str()) {
                            continue;
                        }
                        let port = it
                            .next()
                            .and_then(|p| p.parse::<u16>().ok())
                            .unwrap_or(DEFAULT_PORT);
                        let ip = from.ip().to_string();
                        /* 同一台机器上如果本服务也开着，广播会打到自己；连自己只会干等 */
                        if ip == me {
                            continue;
                        }
                        let _ = tx2.send(json!({
                            "ok": true, "found": true,
                            "url": format!("ws://{ip}:{port}"), "lan": ip,
                        }));
                        break;
                    }
                    _ => break,
                }
            }
        });
    }

    /* 外层必须比内层（3.2s）宽，否则收包窗口还没走完就被判「没找到」 */
    let nets: Vec<Value> = local_v4_networks()
        .iter()
        .map(|(ip, prefix)| {
            json!({
                "ip": ip.to_string(),
                "prefix": prefix,
                "broadcast": broadcast_candidates(*ip, *prefix).iter().map(|b| b.to_string()).collect::<Vec<_>>()
            })
        })
        .collect();
    match tokio::time::timeout(std::time::Duration::from_millis(4500), rx.recv()).await {
        Ok(Some(v)) => Ok(v),
        _ => Ok(json!({ "ok": true, "found": false, "url": "", "lan": "", "networks": nets })),
    }
}

pub async fn start(state: &SignalState, v: &Value) -> Result<Value, String> {
    {
        let g = state.inner.lock().unwrap();
        if let Some(r) = g.as_ref() {
            return Ok(json!({
                "ok": true, "running": true, "port": r.port, "lan": r.lan,
                "self": format!("ws://127.0.0.1:{}", r.port),
                "peer": if r.lan.is_empty() { String::new() } else { format!("ws://{}:{}", r.lan, r.port) },
            }));
        }
    }

    let want = v.get("port").and_then(|x| x.as_u64()).unwrap_or(DEFAULT_PORT as u64) as u16;
    let mut bound = None;
    for off in 0..PORT_TRIES {
        let p = want.saturating_add(off);
        if let Ok(l) = TcpListener::bind(("0.0.0.0", p)).await {
            bound = Some((l, p));
            break;
        }
    }
    let (listener, port) = bound.ok_or_else(|| {
        format!("{}~{} 这些端口都被占用了，先关掉占用的程序", want, want + PORT_TRIES - 1)
    })?;

    let lan = lan_ip();
    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop2 = stop_flag.clone();
    let stop3 = stop_flag.clone();
    let rooms = Arc::new(Mutex::new(Rooms::default()));
    let rooms_task = rooms.clone();
    let rooms_wd = rooms.clone();

    /* 先占一个 UDP 端口做发现应答。全被占也不影响收发，只是对方得手动填地址。 */
    let mut disc_sock = None;
    for p in DISCOVERY_PORTS {
        if let Ok(s) = tokio::net::UdpSocket::bind(("0.0.0.0", p)).await {
            disc_sock = Some(s);
            break;
        }
    }
    let disc = disc_sock.map(|s| tokio::spawn(run_discovery(s, port, stop3)));

    /* 空闲看门狗：连续 15 分钟没有任何连接，自动关掉服务，避免长期占用端口 */
    let idle_stop = stop_flag.clone();
    let last_busy = Arc::new(Mutex::new(std::time::Instant::now()));
    let last_busy_wd = last_busy.clone();
    tokio::spawn(async move {
        const IDLE: std::time::Duration = std::time::Duration::from_secs(15 * 60);
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(20)).await;
            if idle_stop.load(Ordering::Relaxed) {
                break;
            }
            let busy = {
                let g = rooms_wd.lock().unwrap();
                g.map.values().any(|r| r.host.is_some() || r.guest.is_some())
            };
            if busy {
                *last_busy_wd.lock().unwrap() = std::time::Instant::now();
            } else if last_busy_wd.lock().unwrap().elapsed() >= IDLE {
                idle_stop.store(true, Ordering::Relaxed);
                break;
            }
        }
    });

    let task = tokio::spawn(async move {
        let rooms = rooms_task.clone();
        loop {
            if stop2.load(Ordering::Relaxed) {
                break;
            }
            let accept = tokio::time::timeout(
                std::time::Duration::from_millis(500),
                listener.accept(),
            )
            .await;
            match accept {
                Ok(Ok((stream, _addr))) => {
                    let r = rooms.clone();
                    tokio::spawn(async move {
                        let _ = handle_conn(stream, r).await;
                    });
                }
                Ok(Err(_)) => break,
                Err(_) => continue, // 超时：回去看一眼 stop 标志
            }
        }
    });

    let mut g = state.inner.lock().unwrap();
    *g = Some(Running { port, lan: lan.clone(), stop: stop_flag, task, disc });

    Ok(json!({
        "ok": true, "running": true, "port": port, "lan": lan,
        "self": format!("ws://127.0.0.1:{port}"),
        "peer": if lan.is_empty() { String::new() } else { format!("ws://{lan}:{port}") },
    }))
}

async fn handle_conn(stream: TcpStream, rooms: Arc<Mutex<Rooms>>) -> Result<(), String> {
    let (mut rd, mut wr) = stream.into_split();

    /* ---- 读 HTTP 头 ---- */
    let mut buf = Vec::with_capacity(1024);
    let mut tmp = [0u8; 1024];
    loop {
        let n = rd.read(&mut tmp).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("连接提前关闭".into());
        }
        buf.extend_from_slice(&tmp[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if buf.len() > 16384 {
            return Err("请求头过大".into());
        }
    }
    let head = String::from_utf8_lossy(&buf).to_string();
    let mut lines = head.split("\r\n");
    let first = lines.next().unwrap_or("");
    let path = first.split_whitespace().nth(1).unwrap_or("/").to_string();

    let mut ws_key = String::new();
    let mut is_upgrade = false;
    for l in lines {
        if let Some((k, v)) = l.split_once(':') {
            let k = k.trim().to_ascii_lowercase();
            let v = v.trim();
            if k == "sec-websocket-key" {
                ws_key = v.to_string();
            } else if k == "upgrade" && v.eq_ignore_ascii_case("websocket") {
                is_upgrade = true;
            }
        }
    }

    /* ---- 探活 ---- */
    if path == "/ping" || path == "/" {
        let body = "ok";
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let _ = wr.write_all(resp.as_bytes()).await;
        return Ok(());
    }

    /* ---- 房间路径 ---- */
    let (raw_path, query) = path.split_once('?').unwrap_or((path.as_str(), ""));
    let code = match raw_path.strip_prefix("/room/") {
        Some(c) if valid_code(c) => c.to_ascii_uppercase(),
        _ => {
            let _ = wr
                .write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 9\r\n\r\nbad room ")
                .await;
            return Ok(());
        }
    };
    if !is_upgrade || ws_key.is_empty() {
        let _ = wr
            .write_all(b"HTTP/1.1 426 Upgrade Required\r\nContent-Length: 8\r\n\r\nupgrade!")
            .await;
        return Ok(());
    }

    let role = if query.contains("role=host") { "host" } else { "guest" };

    /* ---- 握手 ---- */
    let accept = base64::engine::general_purpose::STANDARD
        .encode(sha1(format!("{}258EAFA5-E914-47DA-95CA-C5AB0DC85B11", ws_key).as_bytes()));
    let resp = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
    );
    wr.write_all(resp.as_bytes()).await.map_err(|e| e.to_string())?;

    /* ---- 注册到房间 ---- */
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    {
        let mut g = rooms.lock().unwrap();
        let room = g.map.entry(code.clone()).or_default();
        /* 同角色重连：直接顶掉旧的，旧连接的读循环会自然退出 */
        if role == "host" {
            room.host = Some(tx.clone());
        } else {
            room.guest = Some(tx.clone());
        }
        if let Some(_p) = room.peer(role) {
            let peer = if role == "host" { "guest" } else { "host" };
            room.send(peer, r#"{"t":"peer-joined"}"#);
            let _ = tx.send(r#"{"t":"peer-joined"}"#.to_string());
        }
    }

    /* ---- 写任务 ---- */
    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if wr.write_all(&ws_frame(&msg)).await.is_err() {
                break;
            }
        }
    });

    /* ---- 读循环 ---- */
    loop {
        match read_frame(&mut rd).await {
            Some(Frame::Text(text)) => {
                let g = rooms.lock().unwrap();
                if let Some(room) = g.map.get(&code) {
                    /* 转发给「对方」，不是回给自己 —— 这里传错就等于消息原地打转 */
                    let peer = if role == "host" { "guest" } else { "host" };
                    room.send(peer, &text);
                }
            }
            Some(Frame::Other) => continue,
            Some(Frame::Close) | None => break,
        }
    }

    rooms.lock().unwrap().leave(&code, role);
    writer.abort();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 发现协议：探什么回什么，并且要带上真实的 TCP 端口。
    /// 不打广播（回环上收不到），直接把包发给 127.0.0.1 上临时绑的那个端口。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn discovery_echoes_token_and_port() {
        let sock = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let port = sock.local_addr().unwrap().port();
        let stop_flag = Arc::new(AtomicBool::new(false));
        let stop2 = stop_flag.clone();
        let task = tokio::spawn(run_discovery(sock, 9999, stop2));

        let cli = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        cli.send_to(b"VRCLIB-P2P/1 abc123", ("127.0.0.1", port)).await.unwrap();

        let mut buf = [0u8; 128];
        let got = tokio::time::timeout(std::time::Duration::from_secs(2), cli.recv_from(&mut buf))
            .await
            .expect("应收到回执")
            .unwrap();
        let text = String::from_utf8_lossy(&buf[..got.0]).to_string();
        assert_eq!(text, "VRCLIB-P2P/1 abc123 9999");

        stop_flag.store(true, Ordering::Relaxed);
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), task).await;
    }

    /// 不是我们协议的包不能回应，否则会变成一个向全网广播噪音的应答器。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn discovery_ignores_foreign_packets() {
        let sock = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let port = sock.local_addr().unwrap().port();
        let stop_flag = Arc::new(AtomicBool::new(false));
        let stop2 = stop_flag.clone();
        let task = tokio::spawn(run_discovery(sock, 9999, stop2));

        let cli = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        cli.send_to(b"hello world", ("127.0.0.1", port)).await.unwrap();

        let mut buf = [0u8; 128];
        let r = tokio::time::timeout(std::time::Duration::from_millis(900), cli.recv_from(&mut buf)).await;
        assert!(r.is_err(), "不相干的包不应该有回执");

        stop_flag.store(true, Ordering::Relaxed);
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), task).await;
    }

    #[test]
    fn sha1_vectors() {
        let hex = |b: [u8; 20]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
        assert_eq!(hex(sha1(b"")), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(hex(sha1(b"abc")), "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(
            hex(sha1(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
            "84983e441c3bd26ebaae4aa1f95129e5e54670f1"
        );
    }

    #[test]
    fn frame_roundtrip() {
        for s in ["a", &"x".repeat(200), &"y".repeat(70000)] {
            let f = ws_frame(s);
            assert_eq!(f[0], 0x81);
            assert_eq!(&f[f.len() - s.len()..], s.as_bytes());
        }
    }

    async fn ws_handshake(port: u16, code: &str, role: &str) -> TcpStream {
        let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let req = format!(
            "GET /room/{code}?role={role} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
        );
        s.write_all(req.as_bytes()).await.unwrap();
        /* 必须逐字节读到空行为止：用 512 字节的 read 会把紧跟在 101 后面的
           第一条 WebSocket 帧一起吞进缓冲区，测试就会以为对方没发消息。 */
        let mut buf = Vec::new();
        let mut one = [0u8; 1];
        loop {
            let n = s.read(&mut one).await.unwrap();
            assert!(n == 1, "握手期间连接关闭");
            buf.push(one[0]);
            if buf.ends_with(b"\r\n\r\n") {
                break;
            }
            assert!(buf.len() < 4096, "响应头过大");
        }
        let head = String::from_utf8_lossy(&buf).to_string();
        assert!(head.starts_with("HTTP/1.1 101"), "握手失败：{head}");
        s
    }

    fn client_frame(text: &str) -> Vec<u8> {
        let p = text.as_bytes();
        let mut out = vec![0x81u8];
        if p.len() < 126 {
            out.push(0x80 | p.len() as u8);
        } else {
            out.push(0x80 | 126);
            out.extend_from_slice(&(p.len() as u16).to_be_bytes());
        }
        let mask = [0x11u8, 0x22, 0x33, 0x44];
        out.extend_from_slice(&mask);
        for (i, b) in p.iter().enumerate() {
            out.push(b ^ mask[i & 3]);
        }
        out
    }

    async fn read_text(s: &mut TcpStream, secs: u64) -> Option<String> {
        match tokio::time::timeout(std::time::Duration::from_secs(secs), read_frame(s)).await {
            Ok(Some(Frame::Text(t))) => Some(t),
            _ => None,
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn relay_between_two_clients() {
        let st = SignalState::default();
        let r = start(&st, &json!({ "port": 18787 })).await.unwrap();
        let port = r["port"].as_u64().unwrap() as u16;

        let mut a = ws_handshake(port, "TEST01", "host").await;
        let mut b = ws_handshake(port, "TEST01", "guest").await;

        /* 第二个人进来时，双方各收一条 peer-joined */
        let f1 = read_text(&mut a, 5).await.expect("host 应收到 peer-joined");
        assert!(f1.contains("peer-joined"), "got {f1}");
        let f2 = read_text(&mut b, 5).await.expect("guest 应收到 peer-joined");
        assert!(f2.contains("peer-joined"), "got {f2}");

        /* 双向转发；顺便用一个 3 KB 的假 SDP 走一遍长度扩展帧 */
        let big = format!("{{\"t\":\"sdp\",\"s\":\"{}\"}}", "x".repeat(3000));
        a.write_all(&client_frame(&big)).await.unwrap();
        let got = read_text(&mut b, 5).await.expect("guest 应收到转发");
        assert!(got.len() > 3000, "len={}", got.len());

        b.write_all(&client_frame("{\"t\":\"ice\"}")).await.unwrap();
        let back = read_text(&mut a, 5).await.expect("host 应收到转发");
        assert!(back.contains("ice"), "got {back}");

        /* 断开：另一方收到 peer-left */
        drop(b);
        let bye = read_text(&mut a, 5).await;
        assert!(bye.as_deref().map(|t| t.contains("peer-left")).unwrap_or(false), "应收到 peer-left，实际 {bye:?}");

        stop(&st);
    }

    #[test]
    fn room_code() {
        assert!(valid_code("ABC123"));
        assert!(!valid_code("ABC12"));
        assert!(!valid_code("ABC12I"));
        assert!(!valid_code("abc123"));
    }
}

#[cfg(test)]
mod lan_tests {
    use super::*;

    #[test]
    fn prints_adapters_and_candidates() {
        let nets = local_v4_networks();
        println!("本机 IPv4 网段：{:?}", nets);
        for (ip, prefix) in nets.iter() {
            println!("  {}/{} -> 候选广播 {:?}", ip, prefix, broadcast_candidates(*ip, *prefix));
        }
    }

    #[test]
    fn candidates_cover_odd_prefixes() {
        let ip: std::net::Ipv4Addr = "26.12.34.56".parse().unwrap();
        let c32 = broadcast_candidates(ip, 32);
        assert!(c32.contains(&"26.12.34.255".parse().unwrap()), "/32 也要能推出可用广播");
        let c8 = broadcast_candidates(ip, 8);
        assert!(c8.contains(&"26.255.255.255".parse().unwrap()), "/8 应推出 26.255.255.255");
    }
}
