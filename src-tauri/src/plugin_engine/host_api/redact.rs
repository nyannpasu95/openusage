use regex_lite::{Captures, Regex};
use std::sync::LazyLock;

// --- Static regexes (compiled once, reused across all redaction calls) ---

/// JWT pattern `eyJ...` shared by `redact_body` and `redact_log_message`.
static JWT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+").unwrap());

/// API-key pattern for response bodies (allows surrounding quote chars).
static API_KEY_BODY_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"["']?(sk-|pk-|api_|key_|secret_|gh[opsur]_|github_pat_)[A-Za-z0-9_-]{12,}["']?"#)
        .unwrap()
});

/// API-key pattern for log lines (no quote-boundary capture).
static API_KEY_LOG_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(sk-|pk-|api_|key_|secret_|gh[opsur]_|github_pat_)[A-Za-z0-9_-]{12,}"#).unwrap()
});

/// Devin session token, shared by body and log redaction.
static DEVIN_SESSION_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"devin-session-token\$[^\s"',}\]]+"#).unwrap());

/// `account=value` pattern in log lines.
static ACCOUNT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(account=)([^,\s]+)"#).unwrap());

/// Absolute filesystem path, shared by body and log redaction.
static PATH_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(/(?:Users|home|opt|private|var|tmp|Applications)/[^\s"')]+)"#).unwrap()
});

/// Pre-compiled per-sensitive-key JSON value matchers.
/// Each entry is `(key, regex matching "key": "value")`.
static SENSITIVE_KEY_RES: LazyLock<Vec<(&'static str, Regex)>> = LazyLock::new(|| {
    [
        "password",
        "token",
        "access_token",
        "refresh_token",
        "secret",
        "api_key",
        "apiKey",
        "authorization",
        "bearer",
        "credential",
        "session_token",
        "sessionToken",
        "auth_token",
        "authToken",
        "id_token",
        "idToken",
        "accessToken",
        "refreshToken",
        "user_id",
        "userId",
        "account_id",
        "accountId",
        "team_id",
        "teamId",
        "org_id",
        "orgId",
        "account_display_name",
        "accountDisplayName",
        "payment_id",
        "paymentId",
        "profile_arn",
        "profileArn",
        "email",
        "login",
        "analytics_tracking_id",
    ]
    .into_iter()
    .map(|key| {
        let pattern = format!(r#""{}":\s*"([^"]+)""#, key);
        (key, Regex::new(&pattern).unwrap())
    })
    .collect()
});

/// Redact sensitive value to first4...last4 format (UTF-8 safe)
pub(crate) fn redact_value(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= 12 {
        "[REDACTED]".to_string()
    } else {
        let first4: String = chars.iter().take(4).collect();
        let last4: String = chars
            .iter()
            .rev()
            .take(4)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        format!("{}...{}", first4, last4)
    }
}

/// Redact sensitive query parameters in URL
pub(crate) fn redact_url(url: &str) -> String {
    // Exact-match list (case-insensitive). Previously used substring matching
    // which caused false positives: "auth" matched "author", "key" matched "keyword".
    let sensitive_params = [
        "key",
        "api_key",
        "apikey",
        "token",
        "access_token",
        "accesstoken",
        "refresh_token",
        "refreshtoken",
        "secret",
        "client_secret",
        "clientsecret",
        "password",
        "bearer",
        "credential",
        "authorization",
        "auth",
        "oauth",
        "user",
        "user_id",
        "userid",
        "username",
        "account_id",
        "accountid",
        "profilearn",
        "profile_arn",
        "client_id",
        "clientid",
        "code",
        "state",
        "email",
        "login",
    ];

    if let Some(query_start) = url.find('?') {
        let (base, query) = url.split_at(query_start + 1);
        let redacted_params: Vec<String> = query
            .split('&')
            .map(|param| {
                if let Some(eq_pos) = param.find('=') {
                    let (name, value) = param.split_at(eq_pos);
                    let value = &value[1..]; // skip '='
                    let name_lower = name.to_lowercase();
                    if sensitive_params.iter().any(|s| name_lower == *s) && !value.is_empty() {
                        format!("{}={}", name, redact_value(value))
                    } else {
                        param.to_string()
                    }
                } else {
                    param.to_string()
                }
            })
            .collect();
        format!("{}{}", base, redacted_params.join("&"))
    } else {
        url.to_string()
    }
}

/// Redact sensitive patterns in response body for logging
pub(crate) fn redact_body(body: &str) -> String {
    let mut result = body.to_string();

    result = JWT_RE
        .replace_all(&result, |caps: &Captures| redact_value(&caps[0]))
        .to_string();

    result = API_KEY_BODY_RE
        .replace_all(&result, |caps: &Captures| {
            let key = caps[0].trim_matches(|c| c == '"' || c == '\'');
            redact_value(key)
        })
        .to_string();

    result = DEVIN_SESSION_RE
        .replace_all(&result, |caps: &Captures| redact_value(&caps[0]))
        .to_string();

    for (key, re) in SENSITIVE_KEY_RES.iter() {
        result = re
            .replace_all(&result, |caps: &Captures| {
                format!("\"{}\": \"{}\"", key, redact_value(&caps[1]))
            })
            .to_string();
    }

    result = PATH_RE.replace_all(&result, "[PATH]").to_string();

    result
}

/// Lightweight redaction for log messages.
pub(crate) fn redact_log_message(msg: &str) -> String {
    let mut result = msg.to_string();

    result = JWT_RE
        .replace_all(&result, |caps: &Captures| redact_value(&caps[0]))
        .to_string();

    result = API_KEY_LOG_RE
        .replace_all(&result, |caps: &Captures| redact_value(&caps[0]))
        .to_string();

    result = DEVIN_SESSION_RE
        .replace_all(&result, |caps: &Captures| redact_value(&caps[0]))
        .to_string();

    result = ACCOUNT_RE
        .replace_all(&result, |caps: &Captures| {
            format!("{}{}", &caps[1], redact_value(&caps[2]))
        })
        .to_string();

    result = PATH_RE.replace_all(&result, "[PATH]").to_string();

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_value_shows_first_and_last_four() {
        assert_eq!(redact_value("sk-1234567890abcdef"), "sk-1...cdef");
        assert_eq!(redact_value("short"), "[REDACTED]");
    }

    #[test]
    fn redact_url_redacts_api_key_param() {
        let url = "https://api.example.com/v1?api_key=sk-1234567890abcdef&other=value";
        let redacted = redact_url(url);
        assert!(redacted.contains("api_key=sk-1...cdef"));
        assert!(redacted.contains("other=value"));
    }

    #[test]
    fn redact_url_redacts_user_query_param() {
        let url = "https://cursor.com/api/usage?user=user_abcdefghijklmnopqrstuvwxyz&limit=10";
        let redacted = redact_url(url);
        assert!(
            redacted.contains("user=user...wxyz"),
            "user query param should be redacted, got: {}",
            redacted
        );
        assert!(
            redacted.contains("limit=10"),
            "non-sensitive params should be preserved, got: {}",
            redacted
        );
    }

    #[test]
    fn redact_url_preserves_non_sensitive_params() {
        let url = "https://api.example.com/v1?limit=10&offset=20";
        assert_eq!(redact_url(url), url);
    }

    #[test]
    fn redact_url_does_not_false_positive_author() {
        let url = "https://api.example.com/v1?author=robin&authority=admin";
        let redacted = redact_url(url);
        assert!(
            redacted.contains("author=robin"),
            "author should NOT be redacted (not sensitive), got: {}",
            redacted
        );
        assert!(
            redacted.contains("authority=admin"),
            "authority should NOT be redacted, got: {}",
            redacted
        );
    }

    #[test]
    fn redact_url_redacts_oauth_params() {
        let url = "https://api.example.com/oauth/callback?client_id=abc123&code=AUTH_CODE_xyz&state=xyz123";
        let redacted = redact_url(url);
        assert!(
            !redacted.contains("abc123"),
            "client_id should be redacted, got: {}",
            redacted
        );
        assert!(
            !redacted.contains("AUTH_CODE_xyz"),
            "code should be redacted, got: {}",
            redacted
        );
        assert!(
            !redacted.contains("state=xyz123"),
            "state should be redacted, got: {}",
            redacted
        );
    }

    #[test]
    fn redact_url_redacts_profile_arn_query_param() {
        let url = "https://q.us-east-1.amazonaws.com/getUsageLimits?profileArn=arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK&origin=AI_EDITOR";
        let redacted = redact_url(url);
        assert!(
            !redacted.contains("699475941385"),
            "profileArn should be redacted, got: {}",
            redacted
        );
        assert!(
            redacted.contains("origin=AI_EDITOR"),
            "non-sensitive params should remain visible, got: {}",
            redacted
        );
    }

    #[test]
    fn redact_body_redacts_jwt() {
        let body = r#"{"token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"}"#;
        let redacted = redact_body(body);
        // JWT gets redacted to first4...last4 format
        assert!(
            !redacted.contains("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"),
            "full JWT should be redacted, got: {}",
            redacted
        );
    }

    #[test]
    fn redact_body_redacts_api_keys() {
        let body = r#"{"key": "sk-1234567890abcdefghij"}"#;
        let redacted = redact_body(body);
        assert!(redacted.contains("sk-1...ghij"));
    }

    #[test]
    fn redact_body_redacts_github_tokens() {
        // "value"/"note" are not sensitive keys, so only the prefix regex catches these.
        let body = r#"{"value": "gho_16C7e42F292c6912E7710c838347Ae178B4a", "note": "github_pat_11ABCDEFG0j1ZvFWAy0E_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghij"}"#;
        let redacted = redact_body(body);
        assert!(
            !redacted.contains("gho_16C7e42F292c6912E7710c838347Ae178B4a"),
            "gho_ token should be redacted, got: {}",
            redacted
        );
        assert!(
            redacted.contains("gho_...8B4a"),
            "gho_ token should use first4...last4 redaction, got: {}",
            redacted
        );
        assert!(
            !redacted.contains("github_pat_11ABCDEFG0j1ZvFWAy0E_"),
            "github_pat_ token should be redacted, got: {}",
            redacted
        );
    }

    #[test]
    fn redact_body_redacts_devin_session_token() {
        let body = r#"metadata apiKey=devin-session-token$abcdefghijklmnopqrstuvwxyz123456"#;
        let redacted = redact_body(body);
        assert!(
            !redacted.contains("devin-session-token$abcdefghijklmnopqrstuvwxyz123456"),
            "Devin session token should be redacted, got: {}",
            redacted
        );
        assert!(
            redacted.contains("devi...3456"),
            "Devin session token should use first4...last4 redaction, got: {}",
            redacted
        );
    }

    #[test]
    fn redact_body_redacts_json_password_field() {
        let body = r#"{"password": "supersecretpassword123"}"#;
        let redacted = redact_body(body);
        assert!(
            !redacted.contains("supersecretpassword123"),
            "password should be redacted, got: {}",
            redacted
        );
    }

    #[test]
    fn redact_body_redacts_user_id_and_email() {
        let body = r#"{"user_id": "user-iupzZ7KFykMLrnzpkHSq7wjo", "email": "rob@sunstory.com"}"#;
        let redacted = redact_body(body);
        assert!(
            !redacted.contains("user-iupzZ7KFykMLrnzpkHSq7wjo"),
            "user_id should be redacted, got: {}",
            redacted
        );
        assert!(
            !redacted.contains("rob@sunstory.com"),
            "email should be redacted, got: {}",
            redacted
        );
        // Should show first4...last4
        assert!(
            redacted.contains("user...7wjo"),
            "user_id should show first4...last4, got: {}",
            redacted
        );
        assert!(
            redacted.contains("rob@....com"),
            "email should show first4...last4, got: {}",
            redacted
        );
    }

    #[test]
    fn redact_body_redacts_camel_case_user_and_account_ids() {
        let body = r#"{"userId": "user_abcdefghijklmnopqrstuvwxyz", "accountId": "acct_1234567890abcdef"}"#;
        let redacted = redact_body(body);
        assert!(
            !redacted.contains("user_abcdefghijklmnopqrstuvwxyz"),
            "userId should be redacted, got: {}",
            redacted
        );
        assert!(
            !redacted.contains("acct_1234567890abcdef"),
            "accountId should be redacted, got: {}",
            redacted
        );
        assert!(
            redacted.contains("user...wxyz"),
            "userId should show first4...last4, got: {}",
            redacted
        );
        assert!(
            redacted.contains("acct...cdef"),
            "accountId should show first4...last4, got: {}",
            redacted
        );
    }

    #[test]
    fn redact_body_redacts_devin_org_and_account_display_name() {
        let body = r#"{"orgId":"org-6b6e9de248db472bb25b296599ea3dc0","accountDisplayName":"rob@sunstory.com","devinInfo":{"org_id":"org-abcdef1234567890","account_display_name":"team@example.com"}}"#;
        let redacted = redact_body(body);
        assert!(
            !redacted.contains("org-6b6e9de248db472bb25b296599ea3dc0"),
            "orgId should be redacted, got: {}",
            redacted
        );
        assert!(
            !redacted.contains("rob@sunstory.com"),
            "accountDisplayName should be redacted, got: {}",
            redacted
        );
        assert!(
            !redacted.contains("org-abcdef1234567890"),
            "org_id should be redacted, got: {}",
            redacted
        );
        assert!(
            !redacted.contains("team@example.com"),
            "account_display_name should be redacted, got: {}",
            redacted
        );
        assert!(
            redacted.contains("org-...3dc0"),
            "orgId should show first4...last4, got: {}",
            redacted
        );
        assert!(
            redacted.contains("rob@....com"),
            "accountDisplayName should show first4...last4, got: {}",
            redacted
        );
    }

    #[test]
    fn redact_body_redacts_team_id_payment_id_and_paths() {
        let body = r#"{"teamId":"cc1ac023-9ff5-4c1f-a5a4-ae2a82df4243","paymentId":"cus_S5m1PGxjLWoc1c","binaryPath":"/opt/homebrew/bin/bunx","homePath":"/Users/rebers/.claude"}"#;
        let redacted = redact_body(body);
        assert!(
            !redacted.contains("cc1ac023-9ff5-4c1f-a5a4-ae2a82df4243"),
            "teamId should be redacted, got: {}",
            redacted
        );
        assert!(
            !redacted.contains("cus_S5m1PGxjLWoc1c"),
            "paymentId should be redacted, got: {}",
            redacted
        );
        assert!(
            !redacted.contains("/opt/homebrew/bin/bunx"),
            "path should be redacted, got: {}",
            redacted
        );
        assert!(
            !redacted.contains("/Users/rebers/.claude"),
            "path should be redacted, got: {}",
            redacted
        );
        assert!(
            redacted.contains("[PATH]"),
            "expected path marker, got: {}",
            redacted
        );
    }

    #[test]
    fn redact_body_redacts_profile_arn_fields() {
        let body = r#"{"profileArn":"arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK","profile_arn":"arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK"}"#;
        let redacted = redact_body(body);
        assert!(
            !redacted.contains("699475941385"),
            "profile arn should be redacted, got: {}",
            redacted
        );
        assert!(
            redacted.contains("arn:...QMUK"),
            "profile arn should use first4...last4 redaction, got: {}",
            redacted
        );
    }

    #[test]
    fn redact_log_message_redacts_jwt_and_api_key() {
        let msg = "token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U key=sk-1234567890abcdef";
        let redacted = redact_log_message(msg);
        assert!(
            !redacted.contains("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"),
            "JWT should be redacted"
        );
        assert!(
            !redacted.contains("sk-1234567890abcdef"),
            "API key should be redacted"
        );
    }

    #[test]
    fn redact_log_message_redacts_devin_session_token() {
        let msg = "auth=devin-session-token$abcdefghijklmnopqrstuvwxyz123456";
        let redacted = redact_log_message(msg);
        assert!(
            !redacted.contains("devin-session-token$abcdefghijklmnopqrstuvwxyz123456"),
            "Devin session token should be redacted, got: {}",
            redacted
        );
        assert!(
            redacted.contains("devi...3456"),
            "Devin session token should use first4...last4 redaction, got: {}",
            redacted
        );
    }

    #[test]
    fn redact_log_message_redacts_github_tokens() {
        let msg =
            "HTTP GET https://api.github.com/user auth=ghp_16C7e42F292c6912E7710c838347Ae178B4a";
        let redacted = redact_log_message(msg);
        assert!(
            !redacted.contains("ghp_16C7e42F292c6912E7710c838347Ae178B4a"),
            "ghp_ token should be redacted, got: {}",
            redacted
        );
        assert!(
            redacted.contains("ghp_...8B4a"),
            "ghp_ token should use first4...last4 redaction, got: {}",
            redacted
        );
    }

    #[test]
    fn redact_log_message_redacts_account_and_paths() {
        let msg = "keychain read: service=Claude Code-credentials, account=rebers path=/opt/homebrew/bin/bunx home=/Users/rebers/.claude";
        let redacted = redact_log_message(msg);
        assert!(
            !redacted.contains("account=rebers"),
            "account should be redacted, got: {}",
            redacted
        );
        assert!(
            !redacted.contains("/opt/homebrew/bin/bunx"),
            "path should be redacted, got: {}",
            redacted
        );
        assert!(
            !redacted.contains("/Users/rebers/.claude"),
            "path should be redacted, got: {}",
            redacted
        );
        assert!(
            redacted.contains("account=[REDACTED]"),
            "expected redacted account, got: {}",
            redacted
        );
        assert!(
            redacted.contains("[PATH]"),
            "expected redacted path, got: {}",
            redacted
        );
    }

    #[test]
    fn redact_body_redacts_login_and_analytics_tracking_id() {
        let body =
            r#"{"login":"robinebers","analytics_tracking_id":"c9df3f012bb8c2eb7aae6868ee8da6cf"}"#;
        let redacted = redact_body(body);
        assert!(
            !redacted.contains("robinebers"),
            "login should be redacted, got: {}",
            redacted
        );
        assert!(
            !redacted.contains("c9df3f012bb8c2eb7aae6868ee8da6cf"),
            "analytics_tracking_id should be redacted, got: {}",
            redacted
        );
        // login is short (<=12 chars) so becomes [REDACTED]; analytics_tracking_id is long so first4...last4
        assert!(
            redacted.contains("[REDACTED]"),
            "login should be redacted, got: {}",
            redacted
        );
        assert!(
            redacted.contains("c9df...a6cf"),
            "analytics_tracking_id should show first4...last4, got: {}",
            redacted
        );
    }

    #[test]
    fn redact_body_preserves_name_field_but_redacts_email() {
        let body =
            r#"{"userStatus":{"name":"Robin Ebers","email":"rob@sunstory.com","planStatus":{}}}"#;
        let redacted = redact_body(body);
        assert!(
            redacted.contains("Robin Ebers"),
            "name should NOT be redacted (not sensitive), got: {}",
            redacted
        );
        assert!(
            !redacted.contains("rob@sunstory.com"),
            "email should still be redacted, got: {}",
            redacted
        );
    }
}
