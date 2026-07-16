use super::*;
use std::io::Read as _;
use std::sync::OnceLock;

const MAX_HTTP_RESPONSE_BYTES: usize = 5 * 1024 * 1024;
static HTTP_CLIENT: OnceLock<Result<reqwest::blocking::Client, String>> = OnceLock::new();
static INSECURE_HTTP_CLIENT: OnceLock<Result<reqwest::blocking::Client, String>> = OnceLock::new();

fn build_http_client(
    dangerously_ignore_tls: bool,
) -> Result<reqwest::blocking::Client, reqwest::Error> {
    let mut builder =
        reqwest::blocking::Client::builder().redirect(reqwest::redirect::Policy::none());

    if let Some(resolved) = crate::config::get_resolved_proxy() {
        builder = builder.proxy(resolved.proxy.clone());
        log::debug!("[http] proxy active");
    } else {
        log::debug!("[http] proxy not used");
    }

    if dangerously_ignore_tls {
        builder = builder.danger_accept_invalid_certs(true);
    }

    builder.build()
}

fn shared_http_client(
    dangerously_ignore_tls: bool,
) -> Result<&'static reqwest::blocking::Client, &'static str> {
    let slot = if dangerously_ignore_tls {
        &INSECURE_HTTP_CLIENT
    } else {
        &HTTP_CLIENT
    };

    slot.get_or_init(|| build_http_client(dangerously_ignore_tls).map_err(|e| e.to_string()))
        .as_ref()
        .map_err(String::as_str)
}

fn redacted_body_preview(body: &str) -> String {
    // Redact before truncation so sensitive values cannot be split around the
    // preview boundary and escape the redaction patterns.
    let redacted_body = redact_body(body);
    if redacted_body.len() <= 500 {
        return redacted_body;
    }

    let truncated: String = redacted_body
        .char_indices()
        .take_while(|(index, _)| *index < 500)
        .map(|(_, character)| character)
        .collect();
    format!("{}... ({} bytes total)", truncated, body.len())
}

pub(crate) fn inject_http<'js>(
    ctx: &Ctx<'js>,
    host: &Object<'js>,
    plugin_id: &str,
    deadline: ProbeDeadline,
) -> rquickjs::Result<()> {
    let http_obj = Object::new(ctx.clone())?;
    let pid = plugin_id.to_string();

    http_obj.set(
        "_requestRaw",
        Function::new(
            ctx.clone(),
            move |ctx_inner: Ctx<'_>, req_json: String| -> rquickjs::Result<String> {
                let req: HttpReqParams = serde_json::from_str(&req_json).map_err(|e| {
                    Exception::throw_message(&ctx_inner, &format!("invalid request: {}", e))
                })?;

                if deadline.has_elapsed() {
                    return Err(Exception::throw_message(&ctx_inner, "probe timed out"));
                }

                let method_str = req.method.as_deref().unwrap_or("GET");
                let redacted_url = redact_url(&req.url);
                log::info!("[plugin:{}] HTTP {} {}", pid, method_str, redacted_url);

                let mut header_map = reqwest::header::HeaderMap::new();
                if let Some(headers) = &req.headers {
                    for (key, val) in headers {
                        let name = reqwest::header::HeaderName::from_bytes(key.as_bytes())
                            .map_err(|e| {
                                Exception::throw_message(
                                    &ctx_inner,
                                    &format!("invalid header name '{}': {}", key, e),
                                )
                            })?;
                        let value = reqwest::header::HeaderValue::from_str(val).map_err(|e| {
                            Exception::throw_message(
                                &ctx_inner,
                                &format!("invalid header value for '{}': {}", key, e),
                            )
                        })?;
                        header_map.insert(name, value);
                    }
                }

                let timeout_ms = req.timeout_ms.unwrap_or(10_000);
                let Some(timeout) = deadline.clamp_duration(Duration::from_millis(timeout_ms))
                else {
                    return Err(probe_timeout_error(&ctx_inner));
                };
                let client = shared_http_client(req.dangerously_ignore_tls.unwrap_or(false))
                    .map_err(|e| Exception::throw_message(&ctx_inner, e))?;

                let method = req.method.as_deref().unwrap_or("GET");
                let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| {
                    Exception::throw_message(
                        &ctx_inner,
                        &format!("invalid http method '{}': {}", method, e),
                    )
                })?;
                let mut builder = client.request(method, &req.url).timeout(timeout);
                builder = builder.headers(header_map);
                if let Some(body) = req.body_text {
                    builder = builder.body(body);
                }

                let response = builder
                    .send()
                    .map_err(|e| Exception::throw_message(&ctx_inner, &e.to_string()))?;

                let status = response.status().as_u16();
                let mut resp_headers = std::collections::HashMap::new();
                for (key, value) in response.headers().iter() {
                    let header_value = value.to_str().map_err(|e| {
                        Exception::throw_message(
                            &ctx_inner,
                            &format!("invalid response header '{}': {}", key, e),
                        )
                    })?;
                    resp_headers.insert(key.to_string(), header_value.to_string());
                }
                let body = {
                    let mut limited = response.take((MAX_HTTP_RESPONSE_BYTES + 1) as u64);
                    let mut buf = Vec::with_capacity(8192);
                    std::io::Read::read_to_end(&mut limited, &mut buf)
                        .map_err(|e| Exception::throw_message(&ctx_inner, &e.to_string()))?;
                    if buf.len() > MAX_HTTP_RESPONSE_BYTES {
                        return Err(Exception::throw_message(
                            &ctx_inner,
                            "HTTP response exceeded size limit",
                        ));
                    }
                    String::from_utf8_lossy(&buf).to_string()
                };

                log::info!(
                    "[plugin:{}] HTTP {} {} -> {} ({} bytes)",
                    pid,
                    method_str,
                    redacted_url,
                    status,
                    body.len()
                );
                if log::log_enabled!(log::Level::Debug) {
                    let body_preview = redacted_body_preview(&body);
                    log::debug!(
                        "[plugin:{}] HTTP {} {} response: {}",
                        pid,
                        method_str,
                        redacted_url,
                        body_preview
                    );
                }

                let resp = HttpRespParams {
                    status,
                    headers: resp_headers,
                    body_text: body,
                };

                serde_json::to_string(&resp)
                    .map_err(|e| Exception::throw_message(&ctx_inner, &e.to_string()))
            },
        )?,
    )?;

    ctx.eval::<(), _>(
        r#"
        (function() {
            // Will be patched after __openusage_ctx is set.
            if (typeof __openusage_ctx !== "undefined") {
                void 0;
            }
        })();
        "#
        .as_bytes(),
    )
    .map_err(|e| Exception::throw_message(ctx, &format!("http wrapper init failed: {}", e)))?;

    host.set("http", http_obj)?;
    Ok(())
}

pub fn patch_http_wrapper(ctx: &rquickjs::Ctx<'_>) -> rquickjs::Result<()> {
    ctx.eval::<(), _>(
        r#"
        (function() {
            var rawFn = __openusage_ctx.host.http._requestRaw;
            __openusage_ctx.host.http.request = function(req) {
                var json = JSON.stringify({
                    url: req.url,
                    method: req.method || "GET",
                    headers: req.headers || null,
                    bodyText: req.bodyText || null,
                    timeoutMs: req.timeoutMs || 10000,
                    dangerouslyIgnoreTls: req.dangerouslyIgnoreTls || false
                });
                var respJson = rawFn(json);
                return JSON.parse(respJson);
            };
        })();
        "#
        .as_bytes(),
    )
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HttpReqParams {
    url: String,
    method: Option<String>,
    headers: Option<std::collections::HashMap<String, String>>,
    body_text: Option<String>,
    timeout_ms: Option<u64>,
    dangerously_ignore_tls: Option<bool>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HttpRespParams {
    status: u16,
    headers: std::collections::HashMap<String, String>,
    body_text: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reuses_clients_by_tls_policy() {
        let secure = shared_http_client(false).expect("secure HTTP client");
        let secure_again = shared_http_client(false).expect("reused secure HTTP client");
        let insecure = shared_http_client(true).expect("insecure HTTP client");

        assert!(std::ptr::eq(secure, secure_again));
        assert!(!std::ptr::eq(secure, insecure));
    }

    #[test]
    fn response_preview_redacts_before_utf8_safe_truncation() {
        let secret = "secret_1234567890abcdefghijklmnop";
        let body = format!(
            r#"{{"token":"{}","message":"{}"}}"#,
            secret,
            "界".repeat(300)
        );

        let preview = redacted_body_preview(&body);

        assert!(!preview.contains(secret));
        assert!(preview.contains("bytes total"));
        assert!(preview.is_char_boundary(preview.len()));
    }
}
