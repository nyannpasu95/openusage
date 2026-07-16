use super::cache::{cache_state, enabled_snapshots_ordered};
use serde::Serialize;
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

const BIND_ADDR: &str = "127.0.0.1:6736";
const MAX_CONCURRENT_CONNECTIONS: usize = 16;
const CONNECTION_TIMEOUT: Duration = Duration::from_secs(5);
const TOKEN_FILE_NAME: &str = "local-api-token";

static API_TOKEN: OnceLock<String> = OnceLock::new();
static SERVER_STATUS: OnceLock<LocalApiState> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalApiStatus {
    pub enabled: bool,
    pub state: LocalApiState,
    pub bind_addr: String,
    pub port: u16,
    pub token_file_path: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LocalApiState {
    Starting,
    Listening,
    PortInUse,
    TokenFileError,
    BindError,
}

pub fn get_local_api_status(app_data_dir: &Path) -> LocalApiStatus {
    let state = SERVER_STATUS
        .get()
        .copied()
        .unwrap_or(LocalApiState::Starting);
    let enabled = matches!(state, LocalApiState::Listening);
    let token_file_path = API_TOKEN.get().map(|_| {
        app_data_dir
            .join(TOKEN_FILE_NAME)
            .to_string_lossy()
            .to_string()
    });
    LocalApiStatus {
        enabled,
        state,
        bind_addr: BIND_ADDR.to_string(),
        port: BIND_ADDR
            .rsplit(':')
            .next()
            .and_then(|p| p.parse().ok())
            .unwrap_or(0),
        token_file_path,
    }
}

struct ConnectionLimiter {
    active: Arc<AtomicUsize>,
    max: usize,
}

struct ConnectionPermit {
    active: Arc<AtomicUsize>,
}

impl ConnectionLimiter {
    fn new(max: usize) -> Self {
        Self {
            active: Arc::new(AtomicUsize::new(0)),
            max,
        }
    }

    fn acquire(&self) -> Option<ConnectionPermit> {
        loop {
            let active = self.active.load(Ordering::Acquire);
            if active >= self.max {
                return None;
            }
            if self
                .active
                .compare_exchange(active, active + 1, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                return Some(ConnectionPermit {
                    active: Arc::clone(&self.active),
                });
            }
        }
    }

    #[cfg(test)]
    fn active_count(&self) -> usize {
        self.active.load(Ordering::Acquire)
    }
}

impl Drop for ConnectionPermit {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::AcqRel);
    }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

pub fn start_server(app_data_dir: &Path) {
    let token = generate_token();
    if let Err(err) = write_token_file(app_data_dir, &token) {
        log::error!(
            "failed to securely write local API token file: {} — feature disabled for this session",
            err
        );
        let _ = SERVER_STATUS.set(LocalApiState::TokenFileError);
        return;
    }

    if API_TOKEN.set(token).is_err() {
        log::error!("local HTTP API was started more than once");
        return;
    }

    std::thread::spawn(|| {
        let listener = match TcpListener::bind(BIND_ADDR) {
            Ok(l) => {
                log::info!("local HTTP API listening on {}", BIND_ADDR);
                let _ = SERVER_STATUS.set(LocalApiState::Listening);
                l
            }
            Err(e) => {
                log::warn!(
                    "failed to bind local HTTP API on {}: {} — feature disabled for this session",
                    BIND_ADDR,
                    e
                );
                let status = if e.kind() == std::io::ErrorKind::AddrInUse {
                    LocalApiState::PortInUse
                } else {
                    LocalApiState::BindError
                };
                let _ = SERVER_STATUS.set(status);
                return;
            }
        };

        let limiter = ConnectionLimiter::new(MAX_CONCURRENT_CONNECTIONS);
        for stream in listener.incoming() {
            match stream {
                Ok(mut stream) => {
                    let Some(permit) = limiter.acquire() else {
                        log::warn!(
                            "local HTTP API connection limit reached (max={})",
                            MAX_CONCURRENT_CONNECTIONS
                        );
                        let _ = stream.set_write_timeout(Some(CONNECTION_TIMEOUT));
                        let _ = stream.write_all(response_service_unavailable().as_bytes());
                        let _ = stream.flush();
                        continue;
                    };
                    std::thread::spawn(move || handle_connection(stream, permit));
                }
                Err(e) => log::debug!("local HTTP API accept error: {}", e),
            }
        }
    });
}

fn handle_connection(mut stream: TcpStream, _permit: ConnectionPermit) {
    let _ = stream.set_read_timeout(Some(CONNECTION_TIMEOUT));
    let _ = stream.set_write_timeout(Some(CONNECTION_TIMEOUT));

    let mut buf = [0u8; 4096];
    let n = match stream.read(&mut buf) {
        Ok(n) => n,
        Err(_) => return,
    };
    let request = String::from_utf8_lossy(&buf[..n]);

    let first_line = request.lines().next().unwrap_or("");
    let mut parts = first_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let raw_path = parts.next().unwrap_or("");

    let path = raw_path.split('?').next().unwrap_or(raw_path);
    let path = if path.len() > 1 {
        path.trim_end_matches('/')
    } else {
        path
    };

    let headers = parse_headers(&request);
    let origin = headers.get("origin").map(|s| s.as_str());
    let cors_origin = allowed_cors_origin(origin);

    let response = match method {
        "OPTIONS" => route_options(cors_origin),
        "GET" => {
            if !check_auth(&headers) {
                response_unauthorized(cors_origin)
            } else {
                route_get(path, cors_origin)
            }
        }
        _ => response_method_not_allowed(cors_origin),
    };
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn parse_headers(request: &str) -> std::collections::HashMap<String, String> {
    let mut headers = std::collections::HashMap::new();
    for line in request.lines().skip(1) {
        if line.is_empty() {
            break;
        }
        if let Some((key, value)) = line.split_once(": ") {
            headers.insert(key.to_ascii_lowercase(), value.trim().to_string());
        }
    }
    headers
}

fn check_auth(headers: &std::collections::HashMap<String, String>) -> bool {
    let Some(token) = API_TOKEN.get() else {
        return false;
    };
    check_auth_with_token(headers, token)
}

fn check_auth_with_token(headers: &std::collections::HashMap<String, String>, token: &str) -> bool {
    let Some(auth_header) = headers.get("authorization") else {
        return false;
    };
    auth_header.trim() == format!("Bearer {}", token)
}

fn allowed_cors_origin(origin: Option<&str>) -> Option<&str> {
    let origin = origin?;
    let authority = origin.strip_prefix("http://")?;
    if is_loopback_authority(authority) {
        Some(origin)
    } else {
        None
    }
}

fn is_loopback_authority(authority: &str) -> bool {
    if authority.is_empty() || authority.contains(['/', '?', '#', '@']) || authority.ends_with(':')
    {
        return false;
    }

    if let Some(rest) = authority.strip_prefix("[::1]") {
        return valid_optional_port(rest);
    }

    let (host, port) = authority
        .split_once(':')
        .map_or((authority, ""), |(host, port)| (host, port));
    (host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1")
        && (port.is_empty() || valid_port(port))
}

fn valid_optional_port(rest: &str) -> bool {
    rest.is_empty() || rest.strip_prefix(':').is_some_and(valid_port)
}

fn valid_port(port: &str) -> bool {
    !port.is_empty() && port.parse::<u16>().is_ok()
}

fn route_get(path: &str, cors_origin: Option<&str>) -> String {
    if path == "/v1/usage" {
        return handle_get_usage_collection(cors_origin);
    }

    if let Some(provider_id) = path.strip_prefix("/v1/usage/")
        && !provider_id.is_empty()
        && !provider_id.contains('/')
    {
        return handle_get_usage_single(provider_id, cors_origin);
    }

    response_not_found("not_found", cors_origin)
}

fn route_options(cors_origin: Option<&str>) -> String {
    response_no_content(cors_origin)
}

fn handle_get_usage_collection(cors_origin: Option<&str>) -> String {
    let snapshots = {
        let state = cache_state().lock().unwrap_or_else(|e| e.into_inner());
        enabled_snapshots_ordered(&state)
    };
    let body = serde_json::to_string(&snapshots).unwrap_or_else(|_| "[]".to_string());
    response_json(200, "OK", &body, cors_origin)
}

fn handle_get_usage_single(provider_id: &str, cors_origin: Option<&str>) -> String {
    let state = cache_state().lock().unwrap_or_else(|e| e.into_inner());

    let is_known = state.known_plugin_ids.iter().any(|id| id == provider_id);
    if !is_known {
        return response_not_found("provider_not_found", cors_origin);
    }

    match state.snapshots.get(provider_id) {
        Some(snapshot) => {
            let body = serde_json::to_string(snapshot).unwrap_or_else(|_| "{}".to_string());
            response_json(200, "OK", &body, cors_origin)
        }
        None => response_no_content(cors_origin),
    }
}

// ---------------------------------------------------------------------------
// Token generation
// ---------------------------------------------------------------------------

fn generate_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn write_token_file(app_data_dir: &Path, token: &str) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(app_data_dir)?;
    let path: PathBuf = app_data_dir.join(TOKEN_FILE_NAME);
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    let mut file = options.open(&path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(token.as_bytes())?;
    file.sync_all()?;
    Ok(path)
}

// ---------------------------------------------------------------------------
// HTTP response builders
// ---------------------------------------------------------------------------

fn cors_header_string(cors_origin: Option<&str>) -> String {
    let origin = cors_origin.unwrap_or("null");
    format!(
        "Access-Control-Allow-Origin: {}\r\n\
         Access-Control-Allow-Methods: GET, OPTIONS\r\n\
         Access-Control-Allow-Headers: Content-Type, Authorization",
        origin
    )
}

fn response_json(status: u16, reason: &str, body: &str, cors_origin: Option<&str>) -> String {
    format!(
        "HTTP/1.1 {} {}\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\n{}\r\nContent-Length: {}\r\n\r\n{}",
        status,
        reason,
        cors_header_string(cors_origin),
        body.len(),
        body,
    )
}

fn response_no_content(cors_origin: Option<&str>) -> String {
    format!(
        "HTTP/1.1 204 No Content\r\nConnection: close\r\n{}\r\n\r\n",
        cors_header_string(cors_origin),
    )
}

fn response_not_found(error_code: &str, cors_origin: Option<&str>) -> String {
    let body = format!(r#"{{"error":"{}"}}"#, error_code);
    response_json(404, "Not Found", &body, cors_origin)
}

fn response_method_not_allowed(cors_origin: Option<&str>) -> String {
    let body = r#"{"error":"method_not_allowed"}"#;
    response_json(405, "Method Not Allowed", body, cors_origin)
}

fn response_unauthorized(cors_origin: Option<&str>) -> String {
    let body = r#"{"error":"unauthorized"}"#;
    response_json(401, "Unauthorized", body, cors_origin)
}

fn response_service_unavailable() -> String {
    let body = r#"{"error":"server_busy"}"#;
    response_json(503, "Service Unavailable", body, None)
}

#[cfg(test)]
mod tests {
    use super::super::cache::{CachedPluginSnapshot, cache_state};
    use super::*;
    use serial_test::serial;

    fn make_snapshot(id: &str, name: &str) -> CachedPluginSnapshot {
        CachedPluginSnapshot {
            provider_id: id.to_string(),
            display_name: name.to_string(),
            plan: Some("Pro".to_string()),
            lines: vec![],
            fetched_at: "2026-03-26T08:15:30Z".to_string(),
        }
    }

    #[test]
    fn route_get_usage_returns_200() {
        let resp = route_get("/v1/usage", None);
        assert!(resp.starts_with("HTTP/1.1 200"));
    }

    #[test]
    fn route_unknown_path_returns_404() {
        let resp = route_get("/v2/something", None);
        assert!(resp.starts_with("HTTP/1.1 404"));
    }

    #[test]
    fn route_options_returns_204_with_cors() {
        let resp = route_options(Some("http://localhost:3000"));
        assert!(resp.starts_with("HTTP/1.1 204"));
        assert!(resp.contains("Access-Control-Allow-Origin: http://localhost:3000"));
    }

    #[test]
    fn route_options_rejects_non_localhost_origin() {
        let filtered = allowed_cors_origin(Some("https://evil.com"));
        let resp = route_options(filtered);
        assert!(resp.starts_with("HTTP/1.1 204"));
        assert!(resp.contains("Access-Control-Allow-Origin: null"));
    }

    #[test]
    #[serial]
    fn route_unknown_provider_returns_404() {
        {
            let mut state = cache_state().lock().unwrap();
            state.known_plugin_ids = vec!["claude".to_string()];
            state.snapshots.clear();
        }

        let resp = route_get("/v1/usage/nonexistent", None);
        assert!(resp.starts_with("HTTP/1.1 404"));
        assert!(resp.contains("provider_not_found"));
    }

    #[test]
    #[serial]
    fn route_known_uncached_provider_returns_204() {
        {
            let mut state = cache_state().lock().unwrap();
            state.known_plugin_ids = vec!["claude".to_string()];
            state.snapshots.clear();
        }

        let resp = route_get("/v1/usage/claude", None);
        assert!(resp.starts_with("HTTP/1.1 204"));
    }

    #[test]
    #[serial]
    fn route_known_cached_provider_returns_200() {
        {
            let mut state = cache_state().lock().unwrap();
            state.known_plugin_ids = vec!["claude".to_string()];
            state
                .snapshots
                .insert("claude".to_string(), make_snapshot("claude", "Claude"));
        }

        let resp = route_get("/v1/usage/claude", None);
        assert!(resp.starts_with("HTTP/1.1 200"));
        assert!(resp.contains("fetchedAt"));
    }

    #[test]
    fn route_options_on_provider_returns_204() {
        let resp = route_options(None);
        assert!(resp.starts_with("HTTP/1.1 204"));
        assert!(resp.contains("Access-Control-Allow-Methods: GET, OPTIONS"));
    }

    #[test]
    fn response_json_includes_cors_headers() {
        let resp = response_json(200, "OK", "[]", Some("http://localhost:3000"));
        assert!(resp.contains("Access-Control-Allow-Origin: http://localhost:3000"));
        assert!(resp.contains("Content-Type: application/json; charset=utf-8"));
    }

    #[test]
    fn response_json_includes_authorization_in_allow_headers() {
        let resp = response_json(200, "OK", "[]", None);
        assert!(resp.contains("Access-Control-Allow-Headers: Content-Type, Authorization"));
    }

    #[test]
    fn check_auth_rejects_missing_token() {
        let headers = std::collections::HashMap::new();
        assert!(!check_auth_with_token(&headers, "secret"));
    }

    #[test]
    fn check_auth_rejects_wrong_token() {
        let mut headers = std::collections::HashMap::new();
        headers.insert("authorization".to_string(), "Bearer wrong".to_string());
        assert!(!check_auth_with_token(&headers, "secret"));
    }

    #[test]
    fn check_auth_accepts_correct_token() {
        let mut headers = std::collections::HashMap::new();
        headers.insert("authorization".to_string(), "Bearer secret".to_string());
        assert!(check_auth_with_token(&headers, "secret"));
    }

    #[test]
    fn allowed_cors_origin_accepts_localhost() {
        assert_eq!(
            allowed_cors_origin(Some("http://localhost:3000")),
            Some("http://localhost:3000")
        );
        assert_eq!(
            allowed_cors_origin(Some("http://127.0.0.1:8080")),
            Some("http://127.0.0.1:8080")
        );
        assert_eq!(
            allowed_cors_origin(Some("http://[::1]:5173")),
            Some("http://[::1]:5173")
        );
    }

    #[test]
    fn allowed_cors_origin_rejects_external() {
        assert_eq!(allowed_cors_origin(Some("https://evil.com")), None);
        assert_eq!(
            allowed_cors_origin(Some("http://localhost.evil.example")),
            None
        );
        assert_eq!(
            allowed_cors_origin(Some("http://localhost@evil.example")),
            None
        );
        assert_eq!(allowed_cors_origin(Some("http://127.0.0.2")), None);
        assert_eq!(allowed_cors_origin(Some("http://[::1].evil.example")), None);
        assert_eq!(allowed_cors_origin(None), None);
    }

    #[test]
    #[cfg(unix)]
    fn token_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        use std::time::{SystemTime, UNIX_EPOCH};

        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before unix epoch")
            .as_nanos();
        let app_data_dir = std::env::temp_dir().join(format!(
            "openusage-local-api-token-{}-{}",
            std::process::id(),
            suffix
        ));

        let path = write_token_file(&app_data_dir, "secret").expect("write token file");
        let metadata = std::fs::metadata(&path).expect("read token metadata");

        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::read_to_string(path).unwrap(), "secret");

        std::fs::remove_dir_all(app_data_dir).expect("remove test directory");
    }

    #[test]
    fn response_unauthorized_returns_401() {
        let resp = response_unauthorized(None);
        assert!(resp.starts_with("HTTP/1.1 401"));
        assert!(resp.contains(r#""error":"unauthorized""#));
    }

    #[test]
    fn connection_limiter_rejects_above_capacity_and_releases_on_drop() {
        let limiter = ConnectionLimiter::new(2);
        let first = limiter.acquire().expect("first permit");
        let second = limiter.acquire().expect("second permit");

        assert!(limiter.acquire().is_none());
        assert_eq!(limiter.active_count(), 2);

        drop(first);

        let third = limiter.acquire().expect("permit after release");
        assert_eq!(limiter.active_count(), 2);

        drop(second);
        drop(third);
        assert_eq!(limiter.active_count(), 0);
    }

    #[test]
    fn response_service_unavailable_returns_503_json() {
        let resp = response_service_unavailable();

        assert!(resp.starts_with("HTTP/1.1 503"));
        assert!(resp.contains(r#""error":"server_busy""#));
    }
}
