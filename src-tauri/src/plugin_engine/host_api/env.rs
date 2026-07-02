use super::*;

pub(crate) const WHITELISTED_ENV_VARS: [&str; 17] = [
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "USER_TYPE",
    "USE_STAGING_OAUTH",
    "USE_LOCAL_OAUTH",
    "CLAUDE_CODE_CUSTOM_OAUTH_URL",
    "CLAUDE_CODE_OAUTH_CLIENT_ID",
    "CLAUDE_LOCAL_OAUTH_API_BASE",
    "ZAI_API_KEY",
    "GLM_API_KEY",
    "MINIMAX_API_KEY",
    "MINIMAX_API_TOKEN",
    "MINIMAX_CN_API_KEY",
    "SYNTHETIC_API_KEY",
    "PI_CODING_AGENT_DIR",
    "DEEPSEEK_API_KEY",
];

pub(crate) fn last_non_empty_trimmed_line(text: &str) -> Option<String> {
    text.lines()
        .map(|line| line.trim())
        .rev()
        .find(|line| !line.is_empty())
        .map(|line| line.to_string())
}

pub(crate) fn sanitize_env_value(text: &str) -> Option<String> {
    let mut cleaned = if let Ok(ansi_re) = regex_lite::Regex::new(r"\x1B\[[0-?]*[ -/]*[@-~]") {
        ansi_re.replace_all(text, "").to_string()
    } else {
        text.to_string()
    };
    cleaned.retain(|ch| ch == '\n' || ch == '\r' || ch == '\t' || !ch.is_control());
    last_non_empty_trimmed_line(&cleaned)
}

pub(crate) fn extract_marked_value(text: &str, start_marker: &str, end_marker: &str) -> Option<String> {
    let start = text.find(start_marker)?;
    let after_start = &text[start + start_marker.len()..];
    let end = after_start.find(end_marker)?;
    sanitize_env_value(&after_start[..end])
}

pub(crate) fn parse_interactive_shell_env_output(
    text: &str,
    start_marker: &str,
    end_marker: &str,
) -> Option<String> {
    if let Some(marked) = extract_marked_value(text, start_marker, end_marker) {
        return Some(marked);
    }

    let has_complete_markers = text.contains(start_marker) && text.contains(end_marker);
    if has_complete_markers {
        return None;
    }

    sanitize_env_value(text)
}

pub(crate) fn read_env_from_process(name: &str) -> Option<String> {
    let value = std::env::var(name).ok()?;
    sanitize_env_value(&value)
}

pub(crate) fn read_command_stdout(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

pub(crate) fn read_env_value_via_command(program: &str, args: &[&str]) -> Option<String> {
    let stdout = read_command_stdout(program, args)?;
    sanitize_env_value(&stdout)
}


pub(crate) fn terminal_env_cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn shell_from_env() -> Option<String> {
    let shell = std::env::var("SHELL").ok()?;
    let trimmed = shell.trim();
    if trimmed.is_empty() {
        return None;
    }
    let file = std::path::Path::new(trimmed).file_name()?.to_string_lossy();
    let allowed = file == "zsh" || file == "bash" || file == "fish";
    if allowed {
        Some(trimmed.to_string())
    } else {
        None
    }
}

pub(crate) fn read_env_from_interactive_shell(program: &str, name: &str) -> Option<String> {
    const START_MARKER: &str = "__OPENUSAGE_ENV_START__";
    const END_MARKER: &str = "__OPENUSAGE_ENV_END__";

    let script = format!(
        "printf '{}\\n'; printenv {}; printf '{}\\n'",
        START_MARKER, name, END_MARKER
    );
    let output = read_command_stdout(program, &["-ilc", script.as_str()])?;
    parse_interactive_shell_env_output(&output, START_MARKER, END_MARKER)
}

pub(crate) fn read_env_from_interactive_shells(name: &str) -> Option<String> {
    let mut programs: Vec<String> = Vec::new();

    if let Some(shell) = shell_from_env() {
        programs.push(shell);
    }

    for program in [
        "/bin/zsh",
        "/bin/bash",
        "/opt/homebrew/bin/fish",
        "/usr/local/bin/fish",
        "/opt/local/bin/fish",
    ] {
        if !programs.iter().any(|p| p == program) {
            programs.push(program.to_string());
        }
    }

    for program in programs {
        if let Some(value) = read_env_from_interactive_shell(program.as_str(), name) {
            return Some(value);
        }
    }

    None
}

pub(crate) fn resolve_env_value(name: &str) -> Option<String> {
    // Prefer the current process env (fast + supports launchctl/terminal-launch).
    if let Some(value) = read_env_from_process(name) {
        return Some(value);
    }

    if let Ok(cache) = terminal_env_cache().lock()
        && let Some(cached) = cache.get(name) {
            return cached.clone();
        }

    let resolved = read_env_from_interactive_shells(name);
    if let Ok(mut cache) = terminal_env_cache().lock() {
        cache.insert(name.to_string(), resolved.clone());
    }
    resolved
}

pub(crate) fn inject_env<'js>(ctx: &Ctx<'js>, host: &Object<'js>, _plugin_id: &str) -> rquickjs::Result<()> {
    let env_obj = Object::new(ctx.clone())?;
    env_obj.set(
        "get",
        Function::new(ctx.clone(), move |name: String| -> Option<String> {
            if !WHITELISTED_ENV_VARS.contains(&name.as_str()) {
                return None;
            }

            resolve_env_value(&name)
        })?,
    )?;
    host.set("env", env_obj)?;
    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;
    use rquickjs::{Context, Runtime};

    #[test]
    fn last_non_empty_trimmed_line_uses_final_value_when_stdout_is_noisy() {
        let stdout = "banner line\nanother message\n  sk-test-key-12345  \n";
        let value = last_non_empty_trimmed_line(stdout);
        assert_eq!(value.as_deref(), Some("sk-test-key-12345"));
    }

    #[test]
    fn last_non_empty_trimmed_line_returns_none_for_empty_stdout() {
        let stdout = "  \n\n\t\n";
        let value = last_non_empty_trimmed_line(stdout);
        assert!(value.is_none());
    }

    #[test]
    fn sanitize_env_value_strips_ansi_and_control_sequences() {
        let raw = "\u{1b}[?1000l\n  sk-test-key-12345\u{1b}[?2004h\r\n";
        let value = sanitize_env_value(raw);
        assert_eq!(value.as_deref(), Some("sk-test-key-12345"));
    }

    #[test]
    fn extract_marked_value_ignores_noisy_shell_output() {
        let stdout = concat!(
            "startup banner\n",
            "\u{1b}[31mplugin failed\u{1b}[0m\n",
            "__OPENUSAGE_ENV_START__\n",
            "  sk-test-key-12345  \n",
            "__OPENUSAGE_ENV_END__\n",
            "\u{1b}[32muser@host\u{1b}[0m\n"
        );
        let value =
            extract_marked_value(stdout, "__OPENUSAGE_ENV_START__", "__OPENUSAGE_ENV_END__");
        assert_eq!(value.as_deref(), Some("sk-test-key-12345"));
    }

    #[test]
    fn extract_marked_value_strips_inline_terminal_sequences_from_marked_value() {
        let stdout = concat!(
            "__OPENUSAGE_ENV_START__\n",
            "\u{1b}[?1000l\n",
            "  sk-test-key-12345\u{1b}[?2004h\r\n",
            "__OPENUSAGE_ENV_END__\n"
        );
        let value =
            extract_marked_value(stdout, "__OPENUSAGE_ENV_START__", "__OPENUSAGE_ENV_END__");
        assert_eq!(value.as_deref(), Some("sk-test-key-12345"));
    }

    #[test]
    fn extract_marked_value_returns_none_when_marked_value_is_empty() {
        let stdout = "__OPENUSAGE_ENV_START__\n  \n__OPENUSAGE_ENV_END__\n";
        let value =
            extract_marked_value(stdout, "__OPENUSAGE_ENV_START__", "__OPENUSAGE_ENV_END__");
        assert!(value.is_none());
    }

    #[test]
    fn parse_interactive_shell_env_output_does_not_fallback_to_end_marker_for_empty_value() {
        let stdout = "__OPENUSAGE_ENV_START__\n  \n__OPENUSAGE_ENV_END__\n";
        let value = parse_interactive_shell_env_output(
            stdout,
            "__OPENUSAGE_ENV_START__",
            "__OPENUSAGE_ENV_END__",
        );
        assert!(value.is_none());
    }

    #[test]
    fn parse_interactive_shell_env_output_falls_back_without_markers() {
        let stdout = "\u{1b}[?1000l\n  sk-test-key-12345\u{1b}[?2004h\r\n";
        let value = parse_interactive_shell_env_output(
            stdout,
            "__OPENUSAGE_ENV_START__",
            "__OPENUSAGE_ENV_END__",
        );
        assert_eq!(value.as_deref(), Some("sk-test-key-12345"));
    }

    #[test]
    fn env_api_respects_allowlist_in_host_and_js() {
        let claude_env_vars = [
            "CLAUDE_CONFIG_DIR",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "USER_TYPE",
            "USE_STAGING_OAUTH",
            "USE_LOCAL_OAUTH",
            "CLAUDE_CODE_CUSTOM_OAUTH_URL",
            "CLAUDE_CODE_OAUTH_CLIENT_ID",
            "CLAUDE_LOCAL_OAUTH_API_BASE",
        ];

        for name in claude_env_vars {
            assert!(
                WHITELISTED_ENV_VARS.contains(&name),
                "{name} must be whitelisted for Claude auth compatibility"
            );
        }

        assert!(
            WHITELISTED_ENV_VARS.contains(&"DEEPSEEK_API_KEY"),
            "DEEPSEEK_API_KEY must be whitelisted for the DeepSeek balance plugin"
        );

        let rt = Runtime::new().expect("runtime");
        let ctx = Context::full(&rt).expect("context");
        ctx.with(|ctx| {
            let app_data = std::env::temp_dir();
            inject_host_api(&ctx, "test", &app_data, "0.0.0").expect("inject host api");
            let globals = ctx.globals();
            let probe_ctx: Object = globals.get("__openusage_ctx").expect("probe ctx");
            let host: Object = probe_ctx.get("host").expect("host");
            let env: Object = host.get("env").expect("env");
            let get: Function = env.get("get").expect("get");

            for name in WHITELISTED_ENV_VARS {
                let expected = resolve_env_value(name);
                let value: Option<String> =
                    get.call((name.to_string(),)).expect("get whitelisted var");
                assert_eq!(value, expected, "{name} should match host env resolver");

                let js_expr = format!(r#"__openusage_ctx.host.env.get("{}")"#, name);
                let js_value: Option<String> = ctx.eval(js_expr).expect("js get whitelisted var");
                assert_eq!(
                    js_value, expected,
                    "{name} should match host env resolver from JS"
                );
            }

            let blocked: Option<String> = get
                .call(("__OPENUSAGE_TEST_NOT_WHITELISTED__".to_string(),))
                .expect("get blocked var");
            assert!(
                blocked.is_none(),
                "non-whitelisted vars must not be exposed"
            );

            let js_blocked: Option<String> = ctx
                .eval(r#"__openusage_ctx.host.env.get("__OPENUSAGE_TEST_NOT_WHITELISTED__")"#)
                .expect("js get blocked var");
            assert!(
                js_blocked.is_none(),
                "non-whitelisted vars must not be exposed from JS"
            );
        });
    }

    #[test]
    fn env_api_prefers_process_env() {
        struct RestoreEnvVar {
            name: &'static str,
            old: Option<String>,
        }

        impl Drop for RestoreEnvVar {
            fn drop(&mut self) {
                if let Some(value) = self.old.take() {
                    // SAFETY: tests serialize env changes via this guard; value is restored on drop.
                    unsafe { std::env::set_var(self.name, value) };
                } else {
                    // SAFETY: tests serialize env changes via this guard; var is restored/removed on drop.
                    unsafe { std::env::remove_var(self.name) };
                }
            }
        }

        let name = "ZAI_API_KEY";
        let old = std::env::var(name).ok();
        let _restore = RestoreEnvVar { name, old };
        // SAFETY: this test restores the previous value in `Drop`.
        unsafe { std::env::set_var(name, "sk-process-env-test-1234567890") };

        let rt = Runtime::new().expect("runtime");
        let ctx = Context::full(&rt).expect("context");
        ctx.with(|ctx| {
            let app_data = std::env::temp_dir();
            inject_host_api(&ctx, "test", &app_data, "0.0.0").expect("inject host api");
            let globals = ctx.globals();
            let probe_ctx: Object = globals.get("__openusage_ctx").expect("probe ctx");
            let host: Object = probe_ctx.get("host").expect("host");
            let env: Object = host.get("env").expect("env");
            let get: Function = env.get("get").expect("get");

            let value: Option<String> = get.call((name.to_string(),)).expect("get");
            assert_eq!(
                value.as_deref(),
                Some("sk-process-env-test-1234567890"),
                "process env should be preferred over shell lookup"
            );

            let js_value: Option<String> = ctx
                .eval(r#"__openusage_ctx.host.env.get("ZAI_API_KEY")"#)
                .expect("js get");
            assert_eq!(
                js_value.as_deref(),
                Some("sk-process-env-test-1234567890"),
                "process env should be preferred from JS"
            );
        });
    }

}
