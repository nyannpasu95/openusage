use aes_gcm::{
    AesGcm, Nonce,
    aead::{Aead, KeyInit, OsRng, generic_array::typenum::U16, rand_core::RngCore},
    aes::Aes256,
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use rquickjs::{Ctx, Exception, Function, Object, function::Rest};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

mod ccusage;
mod crypto;
mod env;
mod http;
mod keychain;
mod ls;
mod redact;
mod sqlite;
mod utils;

pub(crate) use ccusage::*;
pub(crate) use crypto::*;
pub(crate) use env::*;
pub(crate) use http::*;
pub(crate) use keychain::*;
pub(crate) use ls::*;
pub(crate) use redact::*;
pub(crate) use sqlite::*;
pub(crate) use utils::*;

const MIN_BLOCKING_TIMEOUT: Duration = Duration::from_millis(1);

#[derive(Clone, Copy, Debug)]
pub(crate) struct ProbeDeadline {
    expires_at: Option<Instant>,
}

impl ProbeDeadline {
    #[cfg(test)]
    pub(crate) fn none() -> Self {
        Self { expires_at: None }
    }

    pub(crate) fn at(expires_at: Instant) -> Self {
        Self {
            expires_at: Some(expires_at),
        }
    }

    pub(crate) fn has_elapsed(self) -> bool {
        self.expires_at
            .map(|expires_at| Instant::now() >= expires_at)
            .unwrap_or(false)
    }

    fn clamp_duration(self, requested: Duration) -> Option<Duration> {
        let Some(expires_at) = self.expires_at else {
            return Some(requested);
        };
        let remaining = expires_at
            .checked_duration_since(Instant::now())
            .filter(|remaining| *remaining >= MIN_BLOCKING_TIMEOUT)?;
        Some(requested.min(remaining))
    }
}

fn log_probe_deadline_skip(plugin_id: &str, operation: &str) {
    log::warn!(
        "[plugin:{}] {} skipped: probe timed out",
        plugin_id,
        operation
    );
}

fn probe_timeout_error<'js>(ctx: &Ctx<'js>) -> rquickjs::Error {
    Exception::throw_message(ctx, "probe timed out")
}

#[cfg(test)]
pub(crate) fn inject_host_api<'js>(
    ctx: &Ctx<'js>,
    plugin_id: &str,
    app_data_dir: &Path,
    app_version: &str,
) -> rquickjs::Result<()> {
    inject_host_api_with_deadline(
        ctx,
        plugin_id,
        app_data_dir,
        app_version,
        ProbeDeadline::none(),
    )
}

pub(crate) fn inject_host_api_with_deadline<'js>(
    ctx: &Ctx<'js>,
    plugin_id: &str,
    app_data_dir: &Path,
    app_version: &str,
    deadline: ProbeDeadline,
) -> rquickjs::Result<()> {
    let globals = ctx.globals();
    let probe_ctx = Object::new(ctx.clone())?;

    probe_ctx.set("nowIso", iso_now())?;

    let app_obj = Object::new(ctx.clone())?;
    app_obj.set("version", app_version)?;
    app_obj.set("platform", std::env::consts::OS)?;
    app_obj.set("appDataDir", app_data_dir.to_string_lossy().to_string())?;
    let plugin_data_dir = app_data_dir.join("plugins_data").join(plugin_id);
    if let Err(err) = std::fs::create_dir_all(&plugin_data_dir) {
        log::warn!(
            "[plugin:{}] failed to create plugin data dir: {}",
            plugin_id,
            err
        );
    }
    app_obj.set(
        "pluginDataDir",
        plugin_data_dir.to_string_lossy().to_string(),
    )?;
    probe_ctx.set("app", app_obj)?;

    let host = Object::new(ctx.clone())?;
    inject_log(ctx, &host, plugin_id)?;
    inject_fs(ctx, &host)?;
    inject_crypto(ctx, &host)?;
    inject_env(ctx, &host, plugin_id)?;
    inject_http(ctx, &host, plugin_id, deadline)?;
    inject_keychain(ctx, &host, plugin_id)?;
    inject_sqlite(ctx, &host)?;
    inject_ls(ctx, &host, plugin_id)?;
    inject_ccusage(ctx, &host, plugin_id, deadline)?;

    probe_ctx.set("host", host)?;
    globals.set("__openusage_ctx", probe_ctx)?;

    Ok(())
}

fn inject_log<'js>(ctx: &Ctx<'js>, host: &Object<'js>, plugin_id: &str) -> rquickjs::Result<()> {
    let log_obj = Object::new(ctx.clone())?;

    let pid = plugin_id.to_string();
    log_obj.set(
        "info",
        Function::new(ctx.clone(), move |msg: String| {
            log::info!("[plugin:{}] {}", pid, redact_log_message(&msg));
        })?,
    )?;

    let pid = plugin_id.to_string();
    log_obj.set(
        "warn",
        Function::new(ctx.clone(), move |msg: String| {
            log::warn!("[plugin:{}] {}", pid, redact_log_message(&msg));
        })?,
    )?;

    let pid = plugin_id.to_string();
    log_obj.set(
        "error",
        Function::new(ctx.clone(), move |msg: String| {
            log::error!("[plugin:{}] {}", pid, redact_log_message(&msg));
        })?,
    )?;

    host.set("log", log_obj)?;
    Ok(())
}

fn inject_fs<'js>(ctx: &Ctx<'js>, host: &Object<'js>) -> rquickjs::Result<()> {
    let fs_obj = Object::new(ctx.clone())?;

    fs_obj.set(
        "exists",
        Function::new(ctx.clone(), move |path: String| -> bool {
            let expanded = expand_path(&path);
            std::path::Path::new(&expanded).exists()
        })?,
    )?;

    fs_obj.set(
        "readText",
        Function::new(
            ctx.clone(),
            move |ctx_inner: Ctx<'_>, path: String| -> rquickjs::Result<String> {
                let expanded = expand_path(&path);
                std::fs::read_to_string(&expanded)
                    .map_err(|e| Exception::throw_message(&ctx_inner, &e.to_string()))
            },
        )?,
    )?;

    fs_obj.set(
        "writeText",
        Function::new(
            ctx.clone(),
            move |ctx_inner: Ctx<'_>, path: String, content: String| -> rquickjs::Result<()> {
                let expanded = expand_path(&path);
                std::fs::write(&expanded, &content)
                    .map_err(|e| Exception::throw_message(&ctx_inner, &e.to_string()))
            },
        )?,
    )?;

    fs_obj.set(
        "listDir",
        Function::new(
            ctx.clone(),
            move |ctx_inner: Ctx<'_>, path: String| -> rquickjs::Result<Vec<String>> {
                let expanded = expand_path(&path);
                let entries = std::fs::read_dir(&expanded)
                    .map_err(|e| Exception::throw_message(&ctx_inner, &e.to_string()))?;

                let mut names = Vec::new();
                for entry in entries {
                    let entry = match entry {
                        Ok(entry) => entry,
                        Err(_) => continue,
                    };
                    let name_os = entry.file_name();
                    let name = name_os.to_string_lossy().to_string();
                    if !name.is_empty() {
                        names.push(name);
                    }
                }
                names.sort();
                Ok(names)
            },
        )?,
    )?;

    host.set("fs", fs_obj)?;
    Ok(())
}

fn iso_now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|err| {
            log::error!("nowIso format failed: {}", err);
            "1970-01-01T00:00:00Z".to_string()
        })
}

fn expand_path(path: &str) -> String {
    if path == "~"
        && let Some(home) = dirs::home_dir()
    {
        return home.to_string_lossy().to_string();
    }
    if path.starts_with("~/")
        && let Some(home) = dirs::home_dir()
    {
        return home.join(&path[2..]).to_string_lossy().to_string();
    }
    path.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expand_path_expands_tilde_prefix() {
        let home = dirs::home_dir().expect("home dir");
        let expected = home.join(".claude-custom").to_string_lossy().to_string();

        assert_eq!(expand_path("~/.claude-custom"), expected);
    }

    #[test]
    fn probe_deadline_clamps_host_timeout_to_remaining_budget() {
        let deadline = ProbeDeadline::at(Instant::now() + Duration::from_millis(25));
        let clamped = deadline
            .clamp_duration(Duration::from_secs(10))
            .expect("remaining budget should produce a host timeout");

        assert!(
            clamped <= Duration::from_millis(25),
            "host timeout should not exceed remaining probe budget"
        );
        assert!(
            clamped >= Duration::from_millis(1),
            "host timeout should stay non-zero for blocking clients"
        );
    }

    #[test]
    fn probe_deadline_does_not_extend_elapsed_budget() {
        let deadline = ProbeDeadline::at(Instant::now());

        assert_eq!(deadline.clamp_duration(Duration::from_secs(10)), None);
    }
}
