use super::*;

pub(crate) static CCUSAGE_ACTIVE_PROVIDERS: OnceLock<Mutex<HashSet<CcusageProvider>>> =
    OnceLock::new();

pub(crate) struct CcusageQueryGuard {
    provider: CcusageProvider,
}

impl CcusageQueryGuard {
    pub(crate) fn acquire(provider: CcusageProvider) -> Option<Self> {
        let active = CCUSAGE_ACTIVE_PROVIDERS.get_or_init(|| Mutex::new(HashSet::new()));
        let mut active = active.lock().unwrap_or_else(|err| err.into_inner());
        if !active.insert(provider) {
            return None;
        }
        Some(Self { provider })
    }
}

impl Drop for CcusageQueryGuard {
    fn drop(&mut self) {
        let active = CCUSAGE_ACTIVE_PROVIDERS.get_or_init(|| Mutex::new(HashSet::new()));
        let mut active = active.lock().unwrap_or_else(|err| err.into_inner());
        active.remove(&self.provider);
    }
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum CcusageRunnerResult {
    Success(String),
    Failed,
    TimedOut,
}

#[cfg(unix)]
pub(crate) fn kill_ccusage_process_group(child_id: u32) -> std::io::Result<()> {
    let pgid = i32::try_from(child_id)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid child pid"))?;
    let rc = unsafe { libc::kill(-pgid, libc::SIGKILL) };
    if rc == 0 {
        return Ok(());
    }

    let err = std::io::Error::last_os_error();
    if err.raw_os_error() == Some(libc::ESRCH) {
        return Ok(());
    }
    Err(err)
}

pub(crate) fn kill_ccusage_on_timeout(child: &mut std::process::Child) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        kill_ccusage_process_group(child.id())
    }

    #[cfg(not(unix))]
    {
        child.kill()
    }
}

pub(crate) fn format_ccusage_timeout(timeout: std::time::Duration) -> String {
    if timeout.subsec_millis() == 0 {
        return format!("{}s", timeout.as_secs());
    }
    if timeout.as_secs() == 0 {
        return format!("{}ms", timeout.as_millis());
    }
    format!("{:.3}s", timeout.as_secs_f64())
}

#[cfg(test)]
pub(crate) fn run_ccusage_with_runner(
    kind: CcusageRunnerKind,
    program: &str,
    opts: &CcusageQueryOpts,
    provider: CcusageProvider,
    plugin_id: &str,
) -> CcusageRunnerResult {
    run_ccusage_with_runner_deadline(
        kind,
        program,
        opts,
        provider,
        plugin_id,
        ProbeDeadline::none(),
    )
}

pub(crate) fn run_ccusage_with_runner_deadline(
    kind: CcusageRunnerKind,
    program: &str,
    opts: &CcusageQueryOpts,
    provider: CcusageProvider,
    plugin_id: &str,
    deadline: ProbeDeadline,
) -> CcusageRunnerResult {
    if deadline.has_elapsed() {
        log::warn!("[plugin:{}] ccusage skipped: probe timed out", plugin_id);
        return CcusageRunnerResult::TimedOut;
    }

    let Some(current_timeout) = deadline.clamp_duration(Duration::from_secs(CCUSAGE_TIMEOUT_SECS))
    else {
        log_probe_deadline_skip(plugin_id, "ccusage");
        return CcusageRunnerResult::TimedOut;
    };

    let current = run_ccusage_with_runner_timeout(
        kind,
        program,
        opts,
        provider,
        plugin_id,
        CcusageCommandFlavor::Current,
        current_timeout,
    );
    match current {
        CcusageRunnerResult::Failed if deadline.has_elapsed() => CcusageRunnerResult::TimedOut,
        CcusageRunnerResult::Failed => {
            let Some(legacy_timeout) =
                deadline.clamp_duration(Duration::from_secs(CCUSAGE_TIMEOUT_SECS))
            else {
                log_probe_deadline_skip(plugin_id, "ccusage legacy fallback");
                return CcusageRunnerResult::TimedOut;
            };
            run_ccusage_with_runner_timeout(
                kind,
                program,
                opts,
                provider,
                plugin_id,
                CcusageCommandFlavor::Legacy,
                legacy_timeout,
            )
        }
        other => other,
    }
}

pub(crate) fn run_ccusage_with_runner_timeout(
    kind: CcusageRunnerKind,
    program: &str,
    opts: &CcusageQueryOpts,
    provider: CcusageProvider,
    plugin_id: &str,
    flavor: CcusageCommandFlavor,
    timeout: std::time::Duration,
) -> CcusageRunnerResult {
    let args = ccusage_runner_args(kind, opts, provider, flavor);
    let enriched_path = ccusage_enriched_path();
    let mut command = std::process::Command::new(program);
    configure_ccusage_command(&mut command, &args, enriched_path.as_deref());

    if let Some(home_path) = ccusage_home_override(opts, provider) {
        let config = ccusage_provider_config(provider);
        command.env(config.home_env_var, expand_path(home_path));
    }

    let redacted_program = redact_log_message(program);

    log::info!(
        "[plugin:{}] ccusage query via {} {:?} ({})",
        plugin_id,
        ccusage_runner_label(kind),
        flavor,
        redacted_program
    );

    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(e) => {
            log::warn!(
                "[plugin:{}] ccusage spawn failed for {}: {}",
                plugin_id,
                ccusage_runner_label(kind),
                e
            );
            return CcusageRunnerResult::Failed;
        }
    };

    // Drain pipes concurrently while the process is running so the child cannot block on full
    // stdout/stderr buffers before exit.
    let mut stdout_reader = child.stdout.take().map(|mut stdout| {
        std::thread::spawn(move || {
            let mut v = Vec::new();
            let _ = std::io::Read::read_to_end(&mut stdout, &mut v);
            v
        })
    });
    let mut stderr_reader = child.stderr.take().map(|mut stderr| {
        std::thread::spawn(move || {
            let mut v = Vec::new();
            let _ = std::io::Read::read_to_end(&mut stderr, &mut v);
            v
        })
    });

    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = stdout_reader
                    .take()
                    .and_then(|reader| reader.join().ok())
                    .unwrap_or_default();
                let stderr = stderr_reader
                    .take()
                    .and_then(|reader| reader.join().ok())
                    .unwrap_or_default();

                if status.success() {
                    let out = String::from_utf8_lossy(&stdout);
                    if let Some(normalized_json) = normalize_ccusage_output(&out) {
                        return CcusageRunnerResult::Success(normalized_json);
                    }
                    log::warn!(
                        "[plugin:{}] ccusage output parse failed for {}",
                        plugin_id,
                        ccusage_runner_label(kind)
                    );
                    return CcusageRunnerResult::Failed;
                }

                let err = String::from_utf8_lossy(&stderr);
                log::warn!(
                    "[plugin:{}] ccusage failed for {}: {}",
                    plugin_id,
                    ccusage_runner_label(kind),
                    err.trim()
                );
                return CcusageRunnerResult::Failed;
            }
            Ok(None) => {
                if start.elapsed() > timeout {
                    if let Err(e) = kill_ccusage_on_timeout(&mut child) {
                        log::warn!(
                            "[plugin:{}] ccusage process group kill failed for {}: {}",
                            plugin_id,
                            ccusage_runner_label(kind),
                            e
                        );
                        let _ = child.kill();
                    }
                    let _ = child.wait();
                    let _ = stdout_reader.take().and_then(|reader| reader.join().ok());
                    let _ = stderr_reader.take().and_then(|reader| reader.join().ok());
                    log::warn!(
                        "[plugin:{}] ccusage timed out after {} for {}",
                        plugin_id,
                        format_ccusage_timeout(timeout),
                        ccusage_runner_label(kind)
                    );
                    return CcusageRunnerResult::TimedOut;
                }
                std::thread::sleep(std::time::Duration::from_millis(CCUSAGE_POLL_INTERVAL_MS));
            }
            Err(e) => {
                log::warn!(
                    "[plugin:{}] ccusage wait failed for {}: {}",
                    plugin_id,
                    ccusage_runner_label(kind),
                    e
                );
                return CcusageRunnerResult::Failed;
            }
        }
    }
}

pub(crate) fn run_ccusage_query_with_runners<F>(
    runners: Vec<(CcusageRunnerKind, String)>,
    opts: &CcusageQueryOpts,
    provider: CcusageProvider,
    plugin_id: &str,
    mut run: F,
) -> String
where
    F: FnMut(
        CcusageRunnerKind,
        &str,
        &CcusageQueryOpts,
        CcusageProvider,
        &str,
    ) -> CcusageRunnerResult,
{
    if runners.is_empty() {
        log::warn!(
            "[plugin:{}] no package runner found for ccusage query",
            plugin_id
        );
        return serde_json::json!({ "status": "no_runner" }).to_string();
    }

    for (kind, program) in runners {
        match run(kind, &program, opts, provider, plugin_id) {
            CcusageRunnerResult::Success(result) => {
                let data: serde_json::Value = match serde_json::from_str(&result) {
                    Ok(v) => v,
                    Err(e) => {
                        log::warn!(
                            "[plugin:{}] ccusage normalized payload parse failed: {}",
                            plugin_id,
                            e
                        );
                        continue;
                    }
                };
                return serde_json::json!({ "status": "ok", "data": data }).to_string();
            }
            CcusageRunnerResult::Failed => {}
            CcusageRunnerResult::TimedOut => {
                log::warn!(
                    "[plugin:{}] ccusage query timed out; skipping fallback runners",
                    plugin_id
                );
                return serde_json::json!({ "status": "runner_failed" }).to_string();
            }
        }
    }

    log::warn!(
        "[plugin:{}] ccusage query failed with all available runners",
        plugin_id
    );
    serde_json::json!({ "status": "runner_failed" }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ccusage_query_guard_blocks_overlapping_provider_query() {
        let first = CcusageQueryGuard::acquire(CcusageProvider::Codex)
            .expect("first query should acquire guard");
        assert!(
            CcusageQueryGuard::acquire(CcusageProvider::Codex).is_none(),
            "second query for same provider should be blocked"
        );
        assert!(
            CcusageQueryGuard::acquire(CcusageProvider::Claude).is_some(),
            "different provider should have its own guard"
        );
        drop(first);
        assert!(
            CcusageQueryGuard::acquire(CcusageProvider::Codex).is_some(),
            "guard should release on drop"
        );
    }

    #[test]
    fn ccusage_timeout_stops_runner_fallback() {
        let opts = CcusageQueryOpts::default();
        let runners = vec![
            (CcusageRunnerKind::Bunx, "bunx".to_string()),
            (CcusageRunnerKind::Npx, "npx".to_string()),
        ];
        let mut calls = Vec::new();

        let result = run_ccusage_query_with_runners(
            runners,
            &opts,
            CcusageProvider::Codex,
            "codex",
            |kind, _, _, _, _| {
                calls.push(kind);
                CcusageRunnerResult::TimedOut
            },
        );

        let value: serde_json::Value = serde_json::from_str(&result).expect("valid status json");
        assert_eq!(value["status"], "runner_failed");
        assert_eq!(calls, vec![CcusageRunnerKind::Bunx]);
    }

    #[cfg(unix)]
    #[test]
    fn ccusage_runner_retries_legacy_package_when_current_package_fails() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;

        let test_id = format!(
            "openusage-ccusage-legacy-fallback-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time")
                .as_nanos()
        );
        let dir = std::env::temp_dir().join(test_id);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let script_path = dir.join("fake-bunx.sh");
        let args_path = dir.join("args.log");

        let mut script = std::fs::File::create(&script_path).expect("create script");
        let script_body = format!(
            r#"#!/bin/sh
echo "$*" >> "{}"
case "$*" in
  *"@ccusage/codex@18.0.11"*)
    printf '{{"daily":[]}}\n'
    exit 0
    ;;
  *)
    echo "blocked current package" >&2
    exit 1
    ;;
esac
"#,
            args_path.display()
        );
        script
            .write_all(script_body.as_bytes())
            .expect("write script");
        let mut permissions = script.metadata().expect("script metadata").permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&script_path, permissions).expect("make script executable");

        let opts = CcusageQueryOpts {
            provider: Some("codex".to_string()),
            since: Some("20260101".to_string()),
            until: None,
            home_path: None,
            claude_path: None,
        };
        let result = run_ccusage_with_runner(
            CcusageRunnerKind::Bunx,
            script_path.to_string_lossy().as_ref(),
            &opts,
            CcusageProvider::Codex,
            "codex",
        );
        assert_eq!(
            result,
            CcusageRunnerResult::Success(r#"{"daily":[]}"#.to_string())
        );

        let calls = std::fs::read_to_string(&args_path).expect("read args log");
        assert!(calls.contains("ccusage@20.0.2 codex daily"));
        assert!(calls.contains("@ccusage/codex@18.0.11 daily"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ccusage_timeout_log_uses_actual_timeout() {
        assert_eq!(
            format_ccusage_timeout(std::time::Duration::from_millis(100)),
            "100ms"
        );
        assert_eq!(
            format_ccusage_timeout(std::time::Duration::from_secs(CCUSAGE_TIMEOUT_SECS)),
            "15s"
        );
    }

    #[cfg(unix)]
    #[test]
    fn ccusage_timeout_kills_descendant_and_closes_pipes() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        use std::path::Path;
        use std::time::{Duration, Instant};

        fn pid_exists(pid: i32) -> bool {
            unsafe { libc::kill(pid, 0) == 0 }
        }

        fn read_pid_file(path: &Path, deadline: Instant) -> i32 {
            loop {
                if let Ok(pid_text) = std::fs::read_to_string(path) {
                    let pid_text = pid_text.trim();
                    if !pid_text.is_empty() {
                        return pid_text.parse().expect("parse descendant pid");
                    }
                }
                if Instant::now() >= deadline {
                    panic!("descendant pid file was not created at {}", path.display());
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }

        let test_id = format!(
            "openusage-ccusage-timeout-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time")
                .as_nanos()
        );
        let dir = std::env::temp_dir().join(test_id);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let script_path = dir.join("fake-ccusage-runner.sh");
        let pid_path = dir.join("descendant.pid");

        let mut script = std::fs::File::create(&script_path).expect("create script");
        let script_body = format!(
            r#"#!/bin/sh
sh -c 'sleep 30' &
echo $! > "{}"
echo "started"
wait
"#,
            pid_path.display()
        );
        script
            .write_all(script_body.as_bytes())
            .expect("write script");
        let mut permissions = script.metadata().expect("script metadata").permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&script_path, permissions).expect("make script executable");

        let opts = CcusageQueryOpts::default();
        let start = Instant::now();
        let result = run_ccusage_with_runner_timeout(
            CcusageRunnerKind::Bunx,
            script_path.to_string_lossy().as_ref(),
            &opts,
            CcusageProvider::Codex,
            "codex",
            CcusageCommandFlavor::Current,
            Duration::from_secs(1),
        );

        assert_eq!(result, CcusageRunnerResult::TimedOut);
        assert!(
            start.elapsed() < Duration::from_secs(3),
            "timeout cleanup should not hang on inherited stdout/stderr pipes"
        );

        let descendant_pid = read_pid_file(&pid_path, Instant::now() + Duration::from_secs(1));

        let deadline = Instant::now() + Duration::from_secs(2);
        while pid_exists(descendant_pid) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            !pid_exists(descendant_pid),
            "descendant process should be killed with ccusage process group"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
