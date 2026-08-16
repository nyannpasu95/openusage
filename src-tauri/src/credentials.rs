//! Tauri commands for plugin credential status, storage, and removal.
//!
//! Manually-entered credentials live in the macOS Keychain under the service
//! `OpenUsage-{pluginId}-credential` (service-only, no account), which plugins
//! read from their sandbox via `host.keychain.readGenericPassword`. Existing
//! compatibility service names owned by other tools are never touched here.

use crate::AppState;
use crate::plugin_engine::credential_check;
use crate::plugin_engine::host_api;
use serde::Serialize;
use std::process::Command;
use std::sync::Mutex;
use tauri::State;

const MANUAL_ENTRY_KINDS: &[&str] = &["apiKey", "cookie"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatusDto {
    pub plugin_id: String,
    pub kind: String,
    pub label: String,
    pub hint: Option<String>,
    pub configured: bool,
    pub source: Option<String>,
    pub error: Option<String>,
}

pub fn credential_service_name(plugin_id: &str) -> String {
    format!("OpenUsage-{}-credential", plugin_id)
}

fn run_security(args: Vec<std::ffi::OsString>) -> Result<(), String> {
    let output = Command::new("security")
        .args(&args)
        .output()
        .map_err(|e| format!("keychain operation failed: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let first_line = stderr.lines().next().unwrap_or("").trim();
        return Err(format!("keychain operation failed: {}", first_line));
    }
    Ok(())
}

#[tauri::command]
pub fn get_credential_statuses(state: State<'_, Mutex<AppState>>) -> Vec<CredentialStatusDto> {
    let (plugins, app_data_dir, app_version) = {
        let locked = state.lock().unwrap_or_else(|e| e.into_inner());
        (
            locked.plugins.clone(),
            locked.app_data_dir.clone(),
            locked.app_version.clone(),
        )
    };

    let mut statuses = Vec::new();
    for plugin in &plugins {
        let Some(credential) = plugin.manifest.credential.as_ref() else {
            continue;
        };
        let result = credential_check::run_credential_check(plugin, &app_data_dir, &app_version);
        if let Some(error) = result.error.as_ref() {
            log::warn!(
                "[plugin:{}] credential check failed: {}",
                plugin.manifest.id,
                error
            );
        }
        statuses.push(CredentialStatusDto {
            plugin_id: plugin.manifest.id.clone(),
            kind: credential.kind.clone(),
            label: credential.label.clone(),
            hint: credential.hint.clone(),
            configured: result.configured,
            source: result.source,
            error: result.error,
        });
    }
    statuses
}

#[tauri::command]
pub fn set_plugin_credential(
    state: State<'_, Mutex<AppState>>,
    plugin_id: String,
    value: String,
) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("Credential storage is only supported on macOS.".to_string());
    }

    let value = value.trim().to_string();
    if value.is_empty() {
        return Err("Credential value cannot be empty.".to_string());
    }

    let plugins = {
        let locked = state.lock().map_err(|e| e.to_string())?;
        locked.plugins.clone()
    };
    let plugin = plugins
        .iter()
        .find(|plugin| plugin.manifest.id == plugin_id)
        .ok_or_else(|| format!("Unknown plugin: {}", plugin_id))?;
    let credential = plugin.manifest.credential.as_ref().ok_or_else(|| {
        format!(
            "Plugin {} does not use a configurable credential.",
            plugin_id
        )
    })?;
    if !MANUAL_ENTRY_KINDS.contains(&credential.kind.as_str()) {
        return Err(format!(
            "Plugin {} credentials are detected automatically and cannot be set manually.",
            plugin_id
        ));
    }

    let service = credential_service_name(&plugin_id);
    let args = host_api::keychain_add_generic_password_args(&service, &value);
    if let Err(err) = run_security(args) {
        log::error!("[plugin:{}] failed to store credential: {}", plugin_id, err);
        return Err("Could not save the credential. Try again.".to_string());
    }
    log::info!(
        "[plugin:{}] credential stored in keychain: service={}",
        plugin_id,
        service
    );
    Ok(())
}

#[tauri::command]
pub fn clear_plugin_credential(
    state: State<'_, Mutex<AppState>>,
    plugin_id: String,
) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("Credential storage is only supported on macOS.".to_string());
    }

    let plugins = {
        let locked = state.lock().map_err(|e| e.to_string())?;
        locked.plugins.clone()
    };
    if !plugins.iter().any(|plugin| plugin.manifest.id == plugin_id) {
        return Err(format!("Unknown plugin: {}", plugin_id));
    }

    let service = credential_service_name(&plugin_id);
    let args = host_api::keychain_delete_generic_password_args(&service);
    match run_security(args) {
        Ok(()) => {
            log::info!(
                "[plugin:{}] credential cleared from keychain: service={}",
                plugin_id,
                service
            );
            Ok(())
        }
        Err(err) => {
            // A missing item is a benign no-op, matching the sandbox keychain API.
            if err.contains("could not be found") {
                log::info!(
                    "[plugin:{}] credential already absent: service={}",
                    plugin_id,
                    service
                );
                return Ok(());
            }
            log::error!("[plugin:{}] failed to clear credential: {}", plugin_id, err);
            Err("Could not clear the credential. Try again.".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_service_name_uses_plugin_scoped_convention() {
        assert_eq!(
            credential_service_name("deepseek"),
            "OpenUsage-deepseek-credential"
        );
        assert_eq!(
            credential_service_name("jetbrains-ai-assistant"),
            "OpenUsage-jetbrains-ai-assistant-credential"
        );
    }

    #[test]
    fn manual_entry_kinds_exclude_detected() {
        assert!(MANUAL_ENTRY_KINDS.contains(&"apiKey"));
        assert!(MANUAL_ENTRY_KINDS.contains(&"cookie"));
        assert!(!MANUAL_ENTRY_KINDS.contains(&"detected"));
    }

    #[test]
    fn credential_status_dto_serializes_camel_case() {
        let dto = CredentialStatusDto {
            plugin_id: "deepseek".to_string(),
            kind: "apiKey".to_string(),
            label: "DeepSeek API Key".to_string(),
            hint: Some("Create one at platform.deepseek.com.".to_string()),
            configured: true,
            source: Some("Keychain".to_string()),
            error: None,
        };
        let json = serde_json::to_value(&dto).expect("serialize");
        assert!(json.get("pluginId").is_some());
        assert!(json.get("configured").is_some());
        assert!(json.get("plugin_id").is_none());
    }
}
