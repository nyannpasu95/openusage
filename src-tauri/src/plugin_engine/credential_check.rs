use crate::plugin_engine::host_api;
use crate::plugin_engine::manifest::LoadedPlugin;
use rquickjs::{Context, Ctx, Object, Promise, Runtime, Value};
use serde::Serialize;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

const CHECK_TIMEOUT_SECS: u64 = 10;
const MEMORY_LIMIT_BYTES: usize = 256 * 1024 * 1024;
const STACK_LIMIT_BYTES: usize = 1024 * 1024;
const MAX_SOURCE_LEN: usize = 200;

/// Result of running a plugin's optional `checkCredentials(ctx)` export in the
/// sandbox. `error` is set when the export is missing or fails; the caller
/// surfaces it so plugin authoring bugs are loud instead of silent.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialCheckResult {
    pub configured: bool,
    pub source: Option<String>,
    pub error: Option<String>,
}

pub fn run_credential_check(
    plugin: &LoadedPlugin,
    app_data_dir: &Path,
    app_version: &str,
) -> CredentialCheckResult {
    run_credential_check_with_timeout(
        plugin,
        app_data_dir,
        app_version,
        Duration::from_secs(CHECK_TIMEOUT_SECS),
    )
}

fn run_credential_check_with_timeout(
    plugin: &LoadedPlugin,
    app_data_dir: &Path,
    app_version: &str,
    timeout: Duration,
) -> CredentialCheckResult {
    let timeout_message = format!("credential check timed out after {}s", timeout.as_secs());
    let deadline_at = Instant::now()
        .checked_add(timeout)
        .unwrap_or_else(Instant::now);
    let deadline = host_api::ProbeDeadline::at(deadline_at);

    let rt = match Runtime::new() {
        Ok(rt) => rt,
        Err(_) => return error_result("runtime creation failed".to_string()),
    };
    rt.set_memory_limit(MEMORY_LIMIT_BYTES);
    rt.set_max_stack_size(STACK_LIMIT_BYTES);
    rt.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline_at)));

    let ctx = match Context::full(&rt) {
        Ok(ctx) => ctx,
        Err(_) => return error_result("context creation failed".to_string()),
    };

    let plugin_id = plugin.manifest.id.clone();
    let entry_script = Arc::clone(&plugin.entry_script);

    ctx.with(|ctx| {
        if host_api::inject_host_api_with_deadline(
            &ctx,
            &plugin_id,
            app_data_dir,
            app_version,
            deadline,
        )
        .is_err()
        {
            return timeout_or_error(&deadline, &timeout_message, "host api injection failed");
        }
        if host_api::patch_http_wrapper(&ctx).is_err() {
            return timeout_or_error(&deadline, &timeout_message, "http wrapper patch failed");
        }
        if host_api::patch_ls_wrapper(&ctx).is_err() {
            return timeout_or_error(&deadline, &timeout_message, "ls wrapper patch failed");
        }
        if host_api::patch_ccusage_wrapper(&ctx).is_err() {
            return timeout_or_error(&deadline, &timeout_message, "ccusage wrapper patch failed");
        }
        if host_api::inject_utils(&ctx).is_err() {
            return timeout_or_error(&deadline, &timeout_message, "utils injection failed");
        }

        if ctx.eval::<(), _>(entry_script.as_bytes()).is_err() {
            return timeout_or_error(&deadline, &timeout_message, "script eval failed");
        }

        let globals = ctx.globals();
        let plugin_obj: Object = match globals.get("__openusage_plugin") {
            Ok(obj) => obj,
            Err(_) => return error_result("missing __openusage_plugin".to_string()),
        };

        let check_fn: rquickjs::Function = match plugin_obj.get("checkCredentials") {
            Ok(f) => f,
            Err(_) => return error_result("missing checkCredentials()".to_string()),
        };

        let probe_ctx: Value = globals
            .get("__openusage_ctx")
            .unwrap_or_else(|_| Value::new_undefined(ctx.clone()));

        let result_value: Value = match check_fn.call((probe_ctx,)) {
            Ok(r) => r,
            Err(_) => {
                return timeout_or_error(&deadline, &timeout_message, &extract_error_string(&ctx));
            }
        };
        if deadline.has_elapsed() {
            return error_result(timeout_message);
        }
        let result: Object = if result_value.is_promise() {
            let promise: Promise = match result_value.into_promise() {
                Some(p) => p,
                None => {
                    return error_result("checkCredentials() returned invalid promise".to_string());
                }
            };
            match promise.finish::<Object>() {
                Ok(obj) => obj,
                Err(rquickjs::Error::WouldBlock) => {
                    return error_result(
                        "checkCredentials() returned unresolved promise".to_string(),
                    );
                }
                Err(_) => {
                    return timeout_or_error(
                        &deadline,
                        &timeout_message,
                        &extract_error_string(&ctx),
                    );
                }
            }
        } else {
            match result_value.into_object() {
                Some(obj) => obj,
                None => {
                    return error_result("checkCredentials() returned non-object".to_string());
                }
            }
        };

        let configured = result.get::<_, bool>("configured").unwrap_or(false);
        let source = result
            .get::<_, String>("source")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .map(truncate_source);

        CredentialCheckResult {
            configured,
            source,
            error: None,
        }
    })
}

fn timeout_or_error(
    deadline: &host_api::ProbeDeadline,
    timeout_message: &str,
    message: &str,
) -> CredentialCheckResult {
    if deadline.has_elapsed() {
        error_result(timeout_message.to_string())
    } else {
        error_result(message.to_string())
    }
}

fn error_result(message: String) -> CredentialCheckResult {
    CredentialCheckResult {
        configured: false,
        source: None,
        error: Some(message),
    }
}

fn extract_error_string(ctx: &Ctx<'_>) -> String {
    let exc = ctx.catch();
    if exc.is_null() || exc.is_undefined() {
        return "The credential check failed.".to_string();
    }
    if let Some(str_val) = exc.as_string() {
        let message: String = str_val.to_string().unwrap_or_default();
        let trimmed = message.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    "The credential check failed.".to_string()
}

fn truncate_source(s: String) -> String {
    if s.len() <= MAX_SOURCE_LEN {
        return s;
    }
    let truncated: String = s
        .char_indices()
        .take_while(|(i, _)| *i < MAX_SOURCE_LEN)
        .map(|(_, c)| c)
        .collect();
    format!("{}...(truncated)", truncated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_engine::manifest::{LoadedPlugin, ManifestCredential, PluginManifest};
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_plugin(entry_script: &str) -> LoadedPlugin {
        LoadedPlugin {
            manifest: PluginManifest {
                schema_version: 1,
                id: "test".to_string(),
                name: "Test".to_string(),
                version: "0.0.0".to_string(),
                entry: "plugin.js".to_string(),
                icon: "icon.svg".to_string(),
                brand_color: None,
                lines: vec![],
                links: vec![],
                credential: Some(ManifestCredential {
                    kind: "apiKey".to_string(),
                    label: "Test API Key".to_string(),
                    hint: None,
                }),
            },
            plugin_dir: PathBuf::from("."),
            entry_script: Arc::from(entry_script),
            icon_data_url: Arc::from("data:image/svg+xml;base64,"),
        }
    }

    fn temp_app_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("openusage-credcheck-{}-{}", label, nanos))
    }

    #[test]
    fn check_returns_configured_and_source() {
        let plugin = test_plugin(
            r#"
            globalThis.__openusage_plugin = {
                probe() { return { lines: [] }; },
                checkCredentials() {
                    return { configured: true, source: "Keychain" };
                }
            };
            "#,
        );
        let result = run_credential_check(&plugin, &temp_app_dir("ok"), "0.0.0");
        assert!(result.configured);
        assert_eq!(result.source.as_deref(), Some("Keychain"));
        assert!(result.error.is_none());
    }

    #[test]
    fn check_supports_async_export() {
        let plugin = test_plugin(
            r#"
            globalThis.__openusage_plugin = {
                probe() { return { lines: [] }; },
                checkCredentials: async function () {
                    return { configured: false };
                }
            };
            "#,
        );
        let result = run_credential_check(&plugin, &temp_app_dir("async"), "0.0.0");
        assert!(!result.configured);
        assert!(result.error.is_none());
    }

    #[test]
    fn missing_export_reports_error() {
        let plugin = test_plugin(
            r#"
            globalThis.__openusage_plugin = {
                probe() { return { lines: [] }; }
            };
            "#,
        );
        let result = run_credential_check(&plugin, &temp_app_dir("missing"), "0.0.0");
        assert!(!result.configured);
        assert_eq!(result.error.as_deref(), Some("missing checkCredentials()"));
    }

    #[test]
    fn thrown_error_is_reported() {
        let plugin = test_plugin(
            r#"
            globalThis.__openusage_plugin = {
                probe() { return { lines: [] }; },
                checkCredentials() { throw "keychain unavailable"; }
            };
            "#,
        );
        let result = run_credential_check(&plugin, &temp_app_dir("throw"), "0.0.0");
        assert!(!result.configured);
        assert_eq!(result.error.as_deref(), Some("keychain unavailable"));
    }

    #[test]
    fn non_boolean_configured_defaults_to_false() {
        let plugin = test_plugin(
            r#"
            globalThis.__openusage_plugin = {
                probe() { return { lines: [] }; },
                checkCredentials() { return { configured: "yes", source: "" }; }
            };
            "#,
        );
        let result = run_credential_check(&plugin, &temp_app_dir("badbool"), "0.0.0");
        assert!(!result.configured);
        assert!(result.source.is_none(), "empty source should be dropped");
        assert!(result.error.is_none());
    }

    #[test]
    fn check_times_out_cpu_bound_script() {
        let plugin = test_plugin(
            r#"
            globalThis.__openusage_plugin = {
                probe() { return { lines: [] }; },
                checkCredentials() { while (true) {} }
            };
            "#,
        );
        let result = run_credential_check_with_timeout(
            &plugin,
            &temp_app_dir("timeout"),
            "0.0.0",
            Duration::from_millis(5),
        );
        assert!(!result.configured);
        assert_eq!(
            result.error.as_deref(),
            Some("credential check timed out after 0s")
        );
    }
}
