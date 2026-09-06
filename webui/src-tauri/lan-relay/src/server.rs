//! TLS-only network surface. Desktop administration is intentionally not routed here.
use crate::{hex, now, Relay, Result, MAX_BODY};
use axum::{
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    routing::post,
    Json, Router,
};
use axum_server::tls_rustls::RustlsConfig;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    net::{Ipv4Addr, TcpListener},
    path::Path,
    sync::Arc,
};

pub struct Running {
    pub relay: Arc<Relay>,
    pub endpoint: String,
    pub fingerprint: String,
    handle: axum_server::Handle<std::net::SocketAddr>,
}

impl Drop for Running {
    fn drop(&mut self) {
        self.handle.shutdown();
    }
}

/// Enumerate only usable private IPv4 interfaces; user selects the Wi-Fi adapter.
pub fn addresses() -> Result<Vec<String>> {
    let mut result: Vec<String> = if_addrs::get_if_addrs()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter_map(|i| match i.ip() {
            std::net::IpAddr::V4(ip) if ip.is_private() && !ip.is_loopback() => {
                Some(ip.to_string())
            }
            _ => None,
        })
        .collect();
    result.sort();
    result.dedup();
    Ok(result)
}

/// Keep the certificate and port stable across desktop restarts for paired-device reconnects.
pub fn start(dir: &Path, address: &str) -> Result<Running> {
    if !addresses()?.iter().any(|a| a == address) {
        return Err("Select a private address on this computer".into());
    }
    let ip: Ipv4Addr = address.parse().map_err(|_| "Invalid interface")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let identity = dir.join("tls-identity.json");
    let (cert, key, fingerprint) = if identity.exists() {
        let data: Value =
            serde_json::from_slice(&std::fs::read(&identity).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        (
            data["cert"]
                .as_str()
                .ok_or("Invalid certificate")?
                .to_owned(),
            data["key"].as_str().ok_or("Invalid key")?.to_owned(),
            data["fingerprint"]
                .as_str()
                .ok_or("Invalid fingerprint")?
                .to_owned(),
        )
    } else {
        let rcgen::CertifiedKey { cert, signing_key } =
            rcgen::generate_simple_self_signed(vec![address.to_string()])
                .map_err(|e| e.to_string())?;
        let fingerprint = hex(&Sha256::digest(cert.der().as_ref()));
        let pem = cert.pem();
        let key = signing_key.serialize_pem();
        let raw = serde_json::to_vec(&json!({"cert":pem,"key":key,"fingerprint":fingerprint}))
            .map_err(|e| e.to_string())?;
        std::fs::write(&identity, raw).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&identity, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
        }
        (pem, key, fingerprint)
    };
    let port_file = dir.join("port");
    let port = std::fs::read_to_string(&port_file)
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(0);
    let listener =
        TcpListener::bind((ip, port)).map_err(|e| format!("Cannot open LAN port: {e}"))?;
    let actual_port = listener.local_addr().map_err(|e| e.to_string())?.port();
    std::fs::write(port_file, actual_port.to_string()).map_err(|e| e.to_string())?;
    let relay = Arc::new(Relay::open(&dir.join("relay.db"))?);
    let handle = axum_server::Handle::new();
    let server_handle = handle.clone();
    let router = Router::new()
        .route("/v1/claim", post(claim))
        .route("/v1/leave", post(leave))
        .route("/v1/bootstrap", post(bootstrap))
        .route("/v1/exchange", post(exchange))
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .with_state(relay.clone());
    let runtime = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let tls = runtime
        .block_on(RustlsConfig::from_pem(cert.into_bytes(), key.into_bytes()))
        .map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        runtime.block_on(async move {
            if let Ok(server) = axum_server::from_tcp_rustls(listener, tls) {
                let _ = server
                    .handle(server_handle)
                    .serve(router.into_make_service())
                    .await;
            }
        });
    });
    Ok(Running {
        relay,
        endpoint: format!("https://{address}:{actual_port}"),
        fingerprint,
        handle,
    })
}

type Response = std::result::Result<Json<Value>, (StatusCode, Json<Value>)>;

async fn leave(State(relay): State<Arc<Relay>>, headers: HeaderMap) -> Response {
    let credential = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .unwrap_or("");
    relay
        .leave(credential)
        .map(|_| Json(json!({})))
        .map_err(failure)
}
fn failure(message: String) -> (StatusCode, Json<Value>) {
    (StatusCode::BAD_REQUEST, Json(json!({"error":message})))
}
fn authorized(
    relay: &Relay,
    headers: &HeaderMap,
) -> std::result::Result<(String, String), (StatusCode, Json<Value>)> {
    let token = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .unwrap_or("");
    relay.authorize(token).map_err(|_| {
        (
            StatusCode::FORBIDDEN,
            Json(json!({"error":"Await desktop approval or pair again"})),
        )
    })
}
async fn claim(State(relay): State<Arc<Relay>>, Json(body): Json<Value>) -> Response {
    relay
        .claim(
            body["invite"].as_str().unwrap_or(""),
            body["credential"].as_str().unwrap_or(""),
            body["name"].as_str().unwrap_or(""),
            now(),
        )
        .map(Json)
        .map_err(failure)
}
async fn bootstrap(State(relay): State<Arc<Relay>>, headers: HeaderMap) -> Response {
    let (room, _) = authorized(&relay, &headers)?;
    relay.bootstrap(&room).map(Json).map_err(failure)
}
async fn exchange(
    State(relay): State<Arc<Relay>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let (room, client) = authorized(&relay, &headers)?;
    relay
        .exchange(&room, &client, &body)
        .map(Json)
        .map_err(failure)
}
