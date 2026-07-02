use super::*;

pub(crate) const CCUSAGE_VERSION: &str = "20.0.2";
pub(crate) const CCUSAGE_PACKAGE_NAME: &str = "ccusage";
pub(crate) const CCUSAGE_BIN_NAME: &str = "ccusage";
pub(crate) const CCUSAGE_LEGACY_VERSION: &str = "18.0.11";
pub(crate) const CCUSAGE_LEGACY_CLAUDE_PACKAGE_NAME: &str = "ccusage";
pub(crate) const CCUSAGE_LEGACY_CODEX_PACKAGE_NAME: &str = "@ccusage/codex";
pub(crate) const CCUSAGE_LEGACY_CODEX_BIN_NAME: &str = "ccusage-codex";
pub(crate) const CCUSAGE_TIMEOUT_SECS: u64 = 15;
pub(crate) const CCUSAGE_POLL_INTERVAL_MS: u64 = 100;

#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CcusageQueryOpts {
    provider: Option<String>,
    since: Option<String>,
    until: Option<String>,
    home_path: Option<String>,
    claude_path: Option<String>,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, Hash)]
pub(crate) enum CcusageProvider {
    Claude,
    Codex,
}

pub(crate) static CCUSAGE_ACTIVE_PROVIDERS: OnceLock<Mutex<HashSet<CcusageProvider>>> = OnceLock::new();

pub(crate) struct CcusageQueryGuard {
    provider: CcusageProvider,
}

impl CcusageQueryGuard {
    fn acquire(provider: CcusageProvider) -> Option<Self> {
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

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub(crate) enum CcusageRunnerKind {
    Bunx,
    PnpmDlx,
    YarnDlx,
    NpmExec,
    Npx,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub(crate) enum CcusageCommandFlavor {
    Current,
    Legacy,
}

pub(crate) fn ccusage_runner_order() -> [CcusageRunnerKind; 5] {
    [
        CcusageRunnerKind::Bunx,
        CcusageRunnerKind::PnpmDlx,
        CcusageRunnerKind::YarnDlx,
        CcusageRunnerKind::NpmExec,
        CcusageRunnerKind::Npx,
    ]
}

pub(crate) fn ccusage_runner_label(kind: CcusageRunnerKind) -> &'static str {
    match kind {
        CcusageRunnerKind::Bunx => "bunx",
        CcusageRunnerKind::PnpmDlx => "pnpm dlx",
        CcusageRunnerKind::YarnDlx => "yarn dlx",
        CcusageRunnerKind::NpmExec => "npm exec",
        CcusageRunnerKind::Npx => "npx",
    }
}

#[derive(Copy, Clone)]
pub(crate) struct CcusageProviderConfig {
    command_namespace: &'static str,
    home_env_var: &'static str,
}

pub(crate) fn parse_ccusage_provider(value: &str) -> Option<CcusageProvider> {
    match value.trim().to_ascii_lowercase().as_str() {
        "claude" => Some(CcusageProvider::Claude),
        "codex" => Some(CcusageProvider::Codex),
        _ => None,
    }
}

pub(crate) fn infer_ccusage_provider(plugin_id: &str) -> Option<CcusageProvider> {
    parse_ccusage_provider(plugin_id)
}

pub(crate) fn resolve_ccusage_provider(opts: &CcusageQueryOpts, plugin_id: &str) -> CcusageProvider {
    opts.provider
        .as_deref()
        .and_then(parse_ccusage_provider)
        .or_else(|| infer_ccusage_provider(plugin_id))
        .unwrap_or(CcusageProvider::Claude)
}

pub(crate) fn ccusage_provider_config(provider: CcusageProvider) -> CcusageProviderConfig {
    match provider {
        CcusageProvider::Claude => CcusageProviderConfig {
            command_namespace: "claude",
            home_env_var: "CLAUDE_CONFIG_DIR",
        },
        CcusageProvider::Codex => CcusageProviderConfig {
            command_namespace: "codex",
            home_env_var: "CODEX_HOME",
        },
    }
}

pub(crate) fn ccusage_package_spec() -> String {
    format!("{}@{}", CCUSAGE_PACKAGE_NAME, CCUSAGE_VERSION)
}

pub(crate) fn ccusage_legacy_package_spec(provider: CcusageProvider) -> String {
    let package_name = match provider {
        CcusageProvider::Claude => CCUSAGE_LEGACY_CLAUDE_PACKAGE_NAME,
        CcusageProvider::Codex => CCUSAGE_LEGACY_CODEX_PACKAGE_NAME,
    };
    format!("{}@{}", package_name, CCUSAGE_LEGACY_VERSION)
}

pub(crate) fn ccusage_home_override(
    opts: &CcusageQueryOpts,
    provider: CcusageProvider,
) -> Option<&str> {
    if let Some(home_path) = opts
        .home_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Some(home_path);
    }

    match provider {
        CcusageProvider::Claude => opts
            .claude_path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
        CcusageProvider::Codex => None,
    }
}

pub(crate) fn ccusage_runner_candidates(kind: CcusageRunnerKind) -> Vec<String> {
    let mut candidates: Vec<String> = Vec::new();
    match kind {
        CcusageRunnerKind::Bunx => {
            if let Some(home) = dirs::home_dir() {
                candidates.push(home.join(".bun/bin/bunx").to_string_lossy().to_string());
            }
            candidates.extend(
                ["/opt/homebrew/bin/bunx", "/usr/local/bin/bunx", "bunx"]
                    .into_iter()
                    .map(str::to_string),
            );
        }
        CcusageRunnerKind::PnpmDlx => {
            candidates.extend(
                ["/opt/homebrew/bin/pnpm", "/usr/local/bin/pnpm", "pnpm"]
                    .into_iter()
                    .map(str::to_string),
            );
        }
        CcusageRunnerKind::YarnDlx => {
            candidates.extend(
                ["/opt/homebrew/bin/yarn", "/usr/local/bin/yarn", "yarn"]
                    .into_iter()
                    .map(str::to_string),
            );
        }
        CcusageRunnerKind::NpmExec => {
            candidates.extend(
                ["/opt/homebrew/bin/npm", "/usr/local/bin/npm", "npm"]
                    .into_iter()
                    .map(str::to_string),
            );
        }
        CcusageRunnerKind::Npx => {
            candidates.extend(
                ["/opt/homebrew/bin/npx", "/usr/local/bin/npx", "npx"]
                    .into_iter()
                    .map(str::to_string),
            );
        }
    }

    let mut unique = Vec::new();
    for candidate in candidates {
        if candidate.is_empty() || unique.iter().any(|c| c == &candidate) {
            continue;
        }
        unique.push(candidate);
    }
    unique
}

pub(crate) fn nvm_default_bin_path(home: &Path) -> Option<PathBuf> {
    let alias_path = home.join(".nvm/alias/default");
    let version = std::fs::read_to_string(&alias_path).ok()?;
    let version = version.trim();
    if version.is_empty() {
        return None;
    }
    let version = if version.starts_with('v') {
        version.to_string()
    } else {
        format!("v{version}")
    };
    Some(home.join(".nvm/versions/node").join(version).join("bin"))
}

pub(crate) fn ccusage_path_entries_with(home: Option<&Path>, existing_path: Option<&OsStr>) -> Vec<PathBuf> {
    let mut entries: Vec<PathBuf> = Vec::new();

    if let Some(home) = home {
        entries.push(home.join(".bun/bin"));
        entries.push(home.join(".nvm/current/bin"));
        if let Some(nvm_bin) = nvm_default_bin_path(home) {
            entries.push(nvm_bin);
        }
        entries.push(home.join(".local/bin"));
    }

    entries.extend(
        ["/opt/homebrew/bin", "/usr/local/bin"]
            .into_iter()
            .map(PathBuf::from),
    );

    if let Some(existing_path) = existing_path {
        for path in std::env::split_paths(existing_path) {
            entries.push(path);
        }
    }

    let mut unique_entries = Vec::new();
    for entry in entries {
        if entry.as_os_str().is_empty() || unique_entries.iter().any(|path| path == &entry) {
            continue;
        }
        unique_entries.push(entry);
    }
    unique_entries
}

pub(crate) fn ccusage_enriched_path_with(
    home: Option<&Path>,
    existing_path: Option<&OsStr>,
) -> Option<OsString> {
    let entries = ccusage_path_entries_with(home, existing_path);
    if entries.is_empty() {
        return None;
    }
    std::env::join_paths(entries).ok()
}

pub(crate) fn ccusage_enriched_path() -> Option<OsString> {
    let home = dirs::home_dir();
    let existing_path = std::env::var_os("PATH");
    ccusage_enriched_path_with(home.as_deref(), existing_path.as_deref())
}

pub(crate) fn ccusage_runner_available(candidate: &str, enriched_path: Option<&OsStr>) -> bool {
    let mut command = std::process::Command::new(candidate);
    command.arg("--version");
    if let Some(path) = enriched_path {
        command.env("PATH", path);
    }
    command
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());

    command.status().map(|s| s.success()).unwrap_or(false)
}

pub(crate) fn configure_ccusage_command(
    command: &mut std::process::Command,
    args: &[String],
    enriched_path: Option<&OsStr>,
) {
    command.args(args);
    if let Some(path) = enriched_path {
        command.env("PATH", path);
    }
    command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
}

pub(crate) fn resolve_ccusage_runner_binary(kind: CcusageRunnerKind) -> Option<String> {
    let path = ccusage_enriched_path();
    ccusage_runner_candidates(kind)
        .into_iter()
        .find(|candidate| ccusage_runner_available(candidate, path.as_deref()))
}

pub(crate) fn collect_ccusage_runners_with<F>(mut resolver: F) -> Vec<(CcusageRunnerKind, String)>
where
    F: FnMut(CcusageRunnerKind) -> Option<String>,
{
    let mut runners = Vec::new();
    for kind in ccusage_runner_order() {
        if let Some(program) = resolver(kind) {
            runners.push((kind, program));
        }
    }
    runners
}

pub(crate) fn collect_ccusage_runners() -> Vec<(CcusageRunnerKind, String)> {
    collect_ccusage_runners_with(resolve_ccusage_runner_binary)
}

pub(crate) fn append_ccusage_common_args(
    args: &mut Vec<String>,
    opts: &CcusageQueryOpts,
    provider: CcusageProvider,
    flavor: CcusageCommandFlavor,
) {
    let config = ccusage_provider_config(provider);
    if flavor == CcusageCommandFlavor::Current {
        args.push(config.command_namespace.to_string());
    }
    args.extend([
        "daily".to_string(),
        "--json".to_string(),
        "--order".to_string(),
        "desc".to_string(),
    ]);

    if let Some(since) = opts
        .since
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        args.push("--since".to_string());
        args.push(since.to_string());
    }

    if let Some(until) = opts
        .until
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        args.push("--until".to_string());
        args.push(until.to_string());
    }
}

pub(crate) fn ccusage_runner_args(
    kind: CcusageRunnerKind,
    opts: &CcusageQueryOpts,
    provider: CcusageProvider,
    flavor: CcusageCommandFlavor,
) -> Vec<String> {
    let package_spec = match flavor {
        CcusageCommandFlavor::Current => ccusage_package_spec(),
        CcusageCommandFlavor::Legacy => ccusage_legacy_package_spec(provider),
    };
    let npm_exec_bin = match (flavor, provider) {
        (CcusageCommandFlavor::Current, _) => CCUSAGE_BIN_NAME,
        (CcusageCommandFlavor::Legacy, CcusageProvider::Claude) => CCUSAGE_BIN_NAME,
        (CcusageCommandFlavor::Legacy, CcusageProvider::Codex) => CCUSAGE_LEGACY_CODEX_BIN_NAME,
    };
    let mut args: Vec<String> = match kind {
        CcusageRunnerKind::Bunx => vec!["--silent".to_string(), package_spec.clone()],
        CcusageRunnerKind::PnpmDlx => {
            vec!["-s".to_string(), "dlx".to_string(), package_spec.clone()]
        }
        CcusageRunnerKind::YarnDlx => {
            vec!["dlx".to_string(), "-q".to_string(), package_spec.clone()]
        }
        CcusageRunnerKind::NpmExec => vec![
            "exec".to_string(),
            "--yes".to_string(),
            format!("--package={package_spec}"),
            "--".to_string(),
            npm_exec_bin.to_string(),
        ],
        CcusageRunnerKind::Npx => vec!["--yes".to_string(), package_spec],
    };

    append_ccusage_common_args(&mut args, opts, provider, flavor);
    args
}

pub(crate) fn extract_last_json_value(stdout: &str) -> Option<String> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return None;
    }

    if serde_json::from_str::<serde_json::Value>(trimmed).is_ok() {
        return Some(trimmed.to_string());
    }

    let mut starts: Vec<usize> = trimmed
        .char_indices()
        .filter(|(_, c)| *c == '{' || *c == '[')
        .map(|(idx, _)| idx)
        .collect();
    starts.reverse();

    for start in starts {
        let candidate = trimmed[start..].trim();
        if serde_json::from_str::<serde_json::Value>(candidate).is_ok() {
            return Some(candidate.to_string());
        }
    }

    None
}

pub(crate) fn normalize_ccusage_output(stdout: &str) -> Option<String> {
    let json_value = extract_last_json_value(stdout)?;
    let parsed: serde_json::Value = serde_json::from_str(&json_value).ok()?;

    let normalized = match parsed {
        serde_json::Value::Array(daily) => serde_json::json!({ "daily": daily }),
        serde_json::Value::Object(map) => {
            let daily = map.get("daily")?;
            if !daily.is_array() {
                return None;
            }
            serde_json::Value::Object(map)
        }
        _ => return None,
    };

    serde_json::to_string(&normalized).ok()
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

pub(crate) fn inject_ccusage<'js>(
    ctx: &Ctx<'js>,
    host: &Object<'js>,
    plugin_id: &str,
    deadline: ProbeDeadline,
) -> rquickjs::Result<()> {
    let ccusage_obj = Object::new(ctx.clone())?;
    let pid = plugin_id.to_string();

    ccusage_obj.set(
        "_queryRaw",
        Function::new(
            ctx.clone(),
            move |_ctx_inner: Ctx<'_>, opts_json: String| -> rquickjs::Result<String> {
                let opts: CcusageQueryOpts = match serde_json::from_str(&opts_json) {
                    Ok(v) => v,
                    Err(e) => {
                        log::warn!("[plugin:{}] invalid ccusage opts JSON: {}", pid, e);
                        CcusageQueryOpts::default()
                    }
                };
                let provider = resolve_ccusage_provider(&opts, &pid);
                let Some(_active_query) = CcusageQueryGuard::acquire(provider) else {
                    log::warn!("[plugin:{}] ccusage query already running", pid);
                    return Ok(serde_json::json!({ "status": "runner_failed" }).to_string());
                };
                let runners = collect_ccusage_runners();
                Ok(run_ccusage_query_with_runners(
                    runners,
                    &opts,
                    provider,
                    &pid,
                    |kind, program, opts, provider, plugin_id| {
                        run_ccusage_with_runner_deadline(
                            kind, program, opts, provider, plugin_id, deadline,
                        )
                    },
                ))
            },
        )?,
    )?;

    host.set("ccusage", ccusage_obj)?;
    Ok(())
}

pub fn patch_ccusage_wrapper(ctx: &rquickjs::Ctx<'_>) -> rquickjs::Result<()> {
    ctx.eval::<(), _>(
        r#"
        (function() {
            var rawFn = __openusage_ctx.host.ccusage._queryRaw;
            __openusage_ctx.host.ccusage.query = function(opts) {
                var result = rawFn(JSON.stringify(opts || {}));
                try {
                    var parsed = JSON.parse(result);
                    if (parsed && typeof parsed === "object" && typeof parsed.status === "string") {
                        return parsed;
                    }
                } catch (e) {}
                return { status: "runner_failed" };
            };
        })();
        "#
        .as_bytes(),
    )
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ccusage_runner_order_matches_expected_priority() {
        assert_eq!(
            ccusage_runner_order(),
            [
                CcusageRunnerKind::Bunx,
                CcusageRunnerKind::PnpmDlx,
                CcusageRunnerKind::YarnDlx,
                CcusageRunnerKind::NpmExec,
                CcusageRunnerKind::Npx
            ]
        );
    }

    #[test]
    fn ccusage_runner_args_include_expected_non_interactive_flags() {
        let opts = CcusageQueryOpts {
            provider: None,
            since: Some("20260101".to_string()),
            until: Some("20260131".to_string()),
            home_path: None,
            claude_path: None,
        };
        let expected_ccusage_package = ccusage_package_spec();
        assert_eq!(expected_ccusage_package, "ccusage@20.0.2");
        let expected_npm_exec_package = format!("--package={expected_ccusage_package}");

        let bunx = ccusage_runner_args(
            CcusageRunnerKind::Bunx,
            &opts,
            CcusageProvider::Claude,
            CcusageCommandFlavor::Current,
        );
        assert_eq!(
            bunx,
            vec![
                "--silent",
                expected_ccusage_package.as_str(),
                "claude",
                "daily",
                "--json",
                "--order",
                "desc",
                "--since",
                "20260101",
                "--until",
                "20260131"
            ]
        );

        let pnpm = ccusage_runner_args(
            CcusageRunnerKind::PnpmDlx,
            &opts,
            CcusageProvider::Claude,
            CcusageCommandFlavor::Current,
        );
        assert_eq!(
            pnpm,
            vec![
                "-s",
                "dlx",
                expected_ccusage_package.as_str(),
                "claude",
                "daily",
                "--json",
                "--order",
                "desc",
                "--since",
                "20260101",
                "--until",
                "20260131"
            ]
        );

        let yarn = ccusage_runner_args(
            CcusageRunnerKind::YarnDlx,
            &opts,
            CcusageProvider::Claude,
            CcusageCommandFlavor::Current,
        );
        assert_eq!(
            yarn,
            vec![
                "dlx",
                "-q",
                expected_ccusage_package.as_str(),
                "claude",
                "daily",
                "--json",
                "--order",
                "desc",
                "--since",
                "20260101",
                "--until",
                "20260131"
            ]
        );

        let npm_exec = ccusage_runner_args(
            CcusageRunnerKind::NpmExec,
            &opts,
            CcusageProvider::Claude,
            CcusageCommandFlavor::Current,
        );
        assert_eq!(
            npm_exec,
            vec![
                "exec",
                "--yes",
                expected_npm_exec_package.as_str(),
                "--",
                "ccusage",
                "claude",
                "daily",
                "--json",
                "--order",
                "desc",
                "--since",
                "20260101",
                "--until",
                "20260131"
            ]
        );

        let npx = ccusage_runner_args(
            CcusageRunnerKind::Npx,
            &opts,
            CcusageProvider::Claude,
            CcusageCommandFlavor::Current,
        );
        assert_eq!(
            npx,
            vec![
                "--yes",
                expected_ccusage_package.as_str(),
                "claude",
                "daily",
                "--json",
                "--order",
                "desc",
                "--since",
                "20260101",
                "--until",
                "20260131"
            ]
        );
    }

    #[test]
    fn ccusage_runner_args_codex_use_unified_package_and_bin() {
        let opts = CcusageQueryOpts {
            provider: Some("codex".to_string()),
            since: Some("20260101".to_string()),
            until: Some("20260131".to_string()),
            home_path: None,
            claude_path: None,
        };
        let expected_ccusage_package = ccusage_package_spec();
        let expected_npm_exec_package = format!("--package={expected_ccusage_package}");

        let bunx = ccusage_runner_args(
            CcusageRunnerKind::Bunx,
            &opts,
            CcusageProvider::Codex,
            CcusageCommandFlavor::Current,
        );
        assert_eq!(
            bunx,
            vec![
                "--silent",
                expected_ccusage_package.as_str(),
                "codex",
                "daily",
                "--json",
                "--order",
                "desc",
                "--since",
                "20260101",
                "--until",
                "20260131"
            ]
        );

        let npm_exec = ccusage_runner_args(
            CcusageRunnerKind::NpmExec,
            &opts,
            CcusageProvider::Codex,
            CcusageCommandFlavor::Current,
        );
        assert_eq!(
            npm_exec,
            vec![
                "exec",
                "--yes",
                expected_npm_exec_package.as_str(),
                "--",
                "ccusage",
                "codex",
                "daily",
                "--json",
                "--order",
                "desc",
                "--since",
                "20260101",
                "--until",
                "20260131"
            ]
        );

        let npx = ccusage_runner_args(
            CcusageRunnerKind::Npx,
            &opts,
            CcusageProvider::Codex,
            CcusageCommandFlavor::Current,
        );
        assert_eq!(
            npx,
            vec![
                "--yes",
                expected_ccusage_package.as_str(),
                "codex",
                "daily",
                "--json",
                "--order",
                "desc",
                "--since",
                "20260101",
                "--until",
                "20260131"
            ]
        );
    }

    #[test]
    fn ccusage_runner_args_legacy_fallback_uses_release_age_safe_packages() {
        let opts = CcusageQueryOpts {
            provider: None,
            since: Some("20260101".to_string()),
            until: Some("20260131".to_string()),
            home_path: None,
            claude_path: None,
        };

        let claude = ccusage_runner_args(
            CcusageRunnerKind::Bunx,
            &opts,
            CcusageProvider::Claude,
            CcusageCommandFlavor::Legacy,
        );
        assert_eq!(
            claude,
            vec![
                "--silent",
                "ccusage@18.0.11",
                "daily",
                "--json",
                "--order",
                "desc",
                "--since",
                "20260101",
                "--until",
                "20260131"
            ]
        );

        let codex_npm = ccusage_runner_args(
            CcusageRunnerKind::NpmExec,
            &opts,
            CcusageProvider::Codex,
            CcusageCommandFlavor::Legacy,
        );
        assert_eq!(
            codex_npm,
            vec![
                "exec",
                "--yes",
                "--package=@ccusage/codex@18.0.11",
                "--",
                "ccusage-codex",
                "daily",
                "--json",
                "--order",
                "desc",
                "--since",
                "20260101",
                "--until",
                "20260131"
            ]
        );
    }

    #[test]
    fn ccusage_path_entries_with_home_and_existing_path_preserves_order() {
        let home = std::path::PathBuf::from("/tmp/openusage-home");
        let existing = std::env::join_paths([
            std::path::PathBuf::from("/usr/bin"),
            std::path::PathBuf::from("/bin"),
        ])
        .expect("join existing path");

        let entries = ccusage_path_entries_with(Some(home.as_path()), Some(existing.as_os_str()));
        assert_eq!(
            entries,
            vec![
                home.join(".bun/bin"),
                home.join(".nvm/current/bin"),
                home.join(".local/bin"),
                std::path::PathBuf::from("/opt/homebrew/bin"),
                std::path::PathBuf::from("/usr/local/bin"),
                std::path::PathBuf::from("/usr/bin"),
                std::path::PathBuf::from("/bin"),
            ]
        );
    }

    #[test]
    fn ccusage_path_entries_with_deduplicates_prefix_and_existing_entries() {
        let existing = std::env::join_paths([
            std::path::PathBuf::from("/usr/local/bin"),
            std::path::PathBuf::from("/custom/bin"),
            std::path::PathBuf::from("/custom/bin"),
            std::path::PathBuf::from("/opt/homebrew/bin"),
        ])
        .expect("join existing path");

        let entries = ccusage_path_entries_with(None, Some(existing.as_os_str()));
        assert_eq!(
            entries,
            vec![
                std::path::PathBuf::from("/opt/homebrew/bin"),
                std::path::PathBuf::from("/usr/local/bin"),
                std::path::PathBuf::from("/custom/bin"),
            ]
        );
    }

    #[test]
    fn ccusage_enriched_path_with_uses_defaults_without_home_or_existing_path() {
        let enriched = ccusage_enriched_path_with(None, None).expect("enriched path");
        let entries: Vec<std::path::PathBuf> =
            std::env::split_paths(enriched.as_os_str()).collect();
        assert_eq!(
            entries,
            vec![
                std::path::PathBuf::from("/opt/homebrew/bin"),
                std::path::PathBuf::from("/usr/local/bin"),
            ]
        );
    }

    #[test]
    fn ccusage_enriched_path_with_preserves_entries_after_join_and_split() {
        let home = std::path::PathBuf::from("/tmp/openusage-home");
        let existing = std::env::join_paths([
            std::path::PathBuf::from("/usr/bin"),
            std::path::PathBuf::from("/bin"),
        ])
        .expect("join existing path");

        let enriched = ccusage_enriched_path_with(Some(home.as_path()), Some(existing.as_os_str()))
            .expect("path");
        let entries: Vec<std::path::PathBuf> =
            std::env::split_paths(enriched.as_os_str()).collect();

        assert_eq!(
            entries,
            vec![
                home.join(".bun/bin"),
                home.join(".nvm/current/bin"),
                home.join(".local/bin"),
                std::path::PathBuf::from("/opt/homebrew/bin"),
                std::path::PathBuf::from("/usr/local/bin"),
                std::path::PathBuf::from("/usr/bin"),
                std::path::PathBuf::from("/bin"),
            ]
        );
    }

    #[test]
    fn nvm_default_bin_path_resolves_version_with_v_prefix() {
        let home = std::env::temp_dir().join("openusage-test-nvm-v-prefix");
        let alias_dir = home.join(".nvm/alias");
        std::fs::create_dir_all(&alias_dir).expect("create alias dir");
        std::fs::write(alias_dir.join("default"), "v22.16.0").expect("write alias");
        let result = nvm_default_bin_path(&home);
        let _ = std::fs::remove_dir_all(&home);
        assert_eq!(result, Some(home.join(".nvm/versions/node/v22.16.0/bin")));
    }

    #[test]
    fn nvm_default_bin_path_resolves_version_without_v_prefix() {
        let home = std::env::temp_dir().join("openusage-test-nvm-no-v-prefix");
        let alias_dir = home.join(".nvm/alias");
        std::fs::create_dir_all(&alias_dir).expect("create alias dir");
        std::fs::write(alias_dir.join("default"), "22.16.0").expect("write alias");
        let result = nvm_default_bin_path(&home);
        let _ = std::fs::remove_dir_all(&home);
        assert_eq!(result, Some(home.join(".nvm/versions/node/v22.16.0/bin")));
    }

    #[test]
    fn nvm_default_bin_path_returns_none_when_alias_missing() {
        let home = std::env::temp_dir().join("openusage-test-nvm-no-alias");
        let _ = std::fs::remove_dir_all(&home);
        let result = nvm_default_bin_path(&home);
        assert_eq!(result, None);
    }

    #[test]
    fn ccusage_path_entries_with_includes_nvm_default_version() {
        let home = std::env::temp_dir().join("openusage-test-nvm-entries");
        let alias_dir = home.join(".nvm/alias");
        std::fs::create_dir_all(&alias_dir).expect("create alias dir");
        std::fs::write(alias_dir.join("default"), "22.16.0").expect("write alias");
        let entries = ccusage_path_entries_with(Some(&home), None);
        let _ = std::fs::remove_dir_all(&home);
        assert!(
            entries.contains(&home.join(".nvm/versions/node/v22.16.0/bin")),
            "expected nvm default version bin in entries"
        );
    }

    #[test]
    fn configure_ccusage_command_sets_path_override() {
        let mut command = std::process::Command::new("echo");
        let args = vec!["daily".to_string(), "--json".to_string()];
        let path = std::env::join_paths([
            std::path::PathBuf::from("/tmp/bin"),
            std::path::PathBuf::from("/usr/bin"),
        ])
        .expect("join path override");

        configure_ccusage_command(&mut command, &args, Some(path.as_os_str()));

        let configured_args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();
        assert_eq!(configured_args, args);

        let configured_path = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("PATH"))
            .and_then(|(_, value)| value.map(std::borrow::ToOwned::to_owned));
        assert_eq!(configured_path.as_deref(), Some(path.as_os_str()));
    }

    #[test]
    fn configure_ccusage_command_skips_path_override_when_absent() {
        let mut command = std::process::Command::new("echo");
        let args = vec!["daily".to_string()];

        configure_ccusage_command(&mut command, &args, None);

        let has_path_override = command
            .get_envs()
            .any(|(key, _)| key == std::ffi::OsStr::new("PATH"));
        assert!(
            !has_path_override,
            "PATH should only be set when an override exists"
        );
    }

    #[test]
    fn resolve_ccusage_provider_prefers_explicit_opt_then_plugin_id() {
        let opts_explicit = CcusageQueryOpts {
            provider: Some("codex".to_string()),
            since: None,
            until: None,
            home_path: None,
            claude_path: None,
        };
        assert_eq!(
            resolve_ccusage_provider(&opts_explicit, "claude"),
            CcusageProvider::Codex
        );

        let opts_empty = CcusageQueryOpts::default();
        assert_eq!(
            resolve_ccusage_provider(&opts_empty, "codex"),
            CcusageProvider::Codex
        );
        assert_eq!(
            resolve_ccusage_provider(&opts_empty, "claude"),
            CcusageProvider::Claude
        );
        assert_eq!(
            resolve_ccusage_provider(&opts_empty, "unknown-provider"),
            CcusageProvider::Claude
        );
    }

    #[test]
    fn ccusage_home_override_supports_home_path_and_claude_compat() {
        let with_home = CcusageQueryOpts {
            provider: None,
            since: None,
            until: None,
            home_path: Some("/tmp/shared-home".to_string()),
            claude_path: Some("/tmp/claude-home".to_string()),
        };
        assert_eq!(
            ccusage_home_override(&with_home, CcusageProvider::Claude),
            Some("/tmp/shared-home")
        );
        assert_eq!(
            ccusage_home_override(&with_home, CcusageProvider::Codex),
            Some("/tmp/shared-home")
        );

        let claude_compat = CcusageQueryOpts {
            provider: None,
            since: None,
            until: None,
            home_path: None,
            claude_path: Some("/tmp/legacy-claude-path".to_string()),
        };
        assert_eq!(
            ccusage_home_override(&claude_compat, CcusageProvider::Claude),
            Some("/tmp/legacy-claude-path")
        );
        assert_eq!(
            ccusage_home_override(&claude_compat, CcusageProvider::Codex),
            None
        );
    }

    #[test]
    fn normalize_ccusage_output_converts_empty_array_to_daily_object() {
        let normalized = normalize_ccusage_output("noise\n[]\n").expect("normalized output");
        let value: serde_json::Value = serde_json::from_str(&normalized).expect("valid json");
        assert_eq!(value, serde_json::json!({ "daily": [] }));
    }

    #[test]
    fn normalize_ccusage_output_keeps_daily_object_shape() {
        let output = r#"
Saved lockfile
{
  "daily": [
    { "date": "2026-02-21", "totalTokens": 123, "totalCost": 0.5 }
  ],
  "totals": { "totalTokens": 123 }
}
"#;
        let normalized = normalize_ccusage_output(output).expect("normalized output");
        let value: serde_json::Value = serde_json::from_str(&normalized).expect("valid json");
        assert!(value.get("daily").and_then(|v| v.as_array()).is_some());
        assert!(value.get("totals").is_some());
    }

    #[test]
    fn normalize_ccusage_output_rejects_invalid_payloads() {
        assert!(normalize_ccusage_output("not-json").is_none());
        assert!(normalize_ccusage_output(r#"{"totals":{"totalTokens":1}}"#).is_none());
    }

    #[test]
    fn collect_ccusage_runners_uses_fallback_order() {
        let runners = collect_ccusage_runners_with(|kind| match kind {
            CcusageRunnerKind::Bunx => None,
            CcusageRunnerKind::PnpmDlx => Some("pnpm".to_string()),
            CcusageRunnerKind::YarnDlx => Some("yarn".to_string()),
            CcusageRunnerKind::NpmExec => Some("npm".to_string()),
            CcusageRunnerKind::Npx => Some("npx".to_string()),
        });
        assert_eq!(
            runners,
            vec![
                (CcusageRunnerKind::PnpmDlx, "pnpm".to_string()),
                (CcusageRunnerKind::YarnDlx, "yarn".to_string()),
                (CcusageRunnerKind::NpmExec, "npm".to_string()),
                (CcusageRunnerKind::Npx, "npx".to_string()),
            ]
        );
    }

    #[test]
    fn collect_ccusage_runners_returns_empty_when_none_available() {
        let runners = collect_ccusage_runners_with(|_| None);
        assert!(runners.is_empty());
    }

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
