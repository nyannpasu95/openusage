use super::*;

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

#[cfg(test)]
mod tests {
    use super::*;

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
}
