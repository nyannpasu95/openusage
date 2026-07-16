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
    pub(crate) provider: Option<String>,
    pub(crate) since: Option<String>,
    pub(crate) until: Option<String>,
    pub(crate) home_path: Option<String>,
    pub(crate) claude_path: Option<String>,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, Hash)]
pub(crate) enum CcusageProvider {
    Claude,
    Codex,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub(crate) enum CcusageCommandFlavor {
    Current,
    Legacy,
}

#[derive(Copy, Clone)]
pub(crate) struct CcusageProviderConfig {
    pub(crate) command_namespace: &'static str,
    pub(crate) home_env_var: &'static str,
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

pub(crate) fn resolve_ccusage_provider(
    opts: &CcusageQueryOpts,
    plugin_id: &str,
) -> CcusageProvider {
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
