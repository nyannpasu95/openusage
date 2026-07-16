use super::*;

// --- Language Server Discovery ---

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LsDiscoverOpts {
    process_name: String,
    markers: Vec<String>,
    csrf_flag: String,
    port_flag: Option<String>,
    extra_flags: Option<Vec<String>>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LsDiscoverResult {
    pid: i32,
    csrf: String,
    ports: Vec<i32>,
    extra: std::collections::HashMap<String, String>,
    extension_port: Option<i32>,
}

pub(crate) fn inject_ls<'js>(
    ctx: &Ctx<'js>,
    host: &Object<'js>,
    plugin_id: &str,
) -> rquickjs::Result<()> {
    let ls_obj = Object::new(ctx.clone())?;
    let pid = plugin_id.to_string();

    ls_obj.set(
        "_discoverRaw",
        Function::new(
            ctx.clone(),
            move |ctx_inner: Ctx<'_>, opts_json: String| -> rquickjs::Result<String> {
                let opts: LsDiscoverOpts = serde_json::from_str(&opts_json).map_err(|e| {
                    Exception::throw_message(&ctx_inner, &format!("invalid discover opts: {}", e))
                })?;

                log::info!(
                    "[plugin:{}] LS discover: processName={}, markers={:?}",
                    pid,
                    opts.process_name,
                    opts.markers
                );

                let ps_output = match std::process::Command::new("/bin/ps")
                    .args(["-ax", "-o", "pid=,command="])
                    .output()
                {
                    Ok(o) => o,
                    Err(e) => {
                        log::warn!("[plugin:{}] ps failed: {}", pid, e);
                        return Ok("null".to_string());
                    }
                };

                if !ps_output.status.success() {
                    log::warn!("[plugin:{}] ps returned non-zero", pid);
                    return Ok("null".to_string());
                }

                let ps_stdout = String::from_utf8_lossy(&ps_output.stdout);
                let process_name_lower = opts.process_name.to_lowercase();
                let markers_lower: Vec<String> = opts
                    .markers
                    .iter()
                    .map(|m| m.trim().to_lowercase())
                    .filter(|m| !m.is_empty())
                    .collect();

                // Find the target process. Marker patterns are Codeium-derived.
                // Matching priority:
                //   1. Exact --ide_name / --app_data_dir flag value (prevents
                //      "windsurf" matching "windsurf-next")
                //   2. Path substring (/<marker>/) as fallback when no flags found
                let mut candidates: Vec<(u8, i32, String)> = Vec::new();

                for line in ps_stdout.lines() {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }

                    let mut parts = trimmed.splitn(2, char::is_whitespace);
                    let pid_str = match parts.next() {
                        Some(s) => s.trim(),
                        None => continue,
                    };
                    let command = match parts.next() {
                        Some(s) => s.trim(),
                        None => continue,
                    };

                    if !ls_command_matches_process(command, &process_name_lower) {
                        continue;
                    }

                    let Some(marker_rank) = ls_marker_rank(command, &markers_lower) else {
                        continue;
                    };

                    if let Ok(p) = pid_str.parse::<i32>() {
                        candidates.push((marker_rank, p, command.to_string()));
                    }
                }

                if candidates.is_empty() {
                    log::info!("[plugin:{}] LS process not found", pid);
                    return Ok("null".to_string());
                }

                let lsof_path = ["/usr/sbin/lsof", "/usr/bin/lsof"]
                    .iter()
                    .find(|p| std::path::Path::new(p).exists())
                    .copied();

                candidates.sort_by_key(|(marker_rank, _, _)| *marker_rank);
                for (_, process_pid, command) in candidates {
                    let csrf = if opts.csrf_flag.trim().is_empty() {
                        String::new()
                    } else {
                        match ls_extract_flag(&command, &opts.csrf_flag) {
                            Some(c) => c,
                            None => {
                                log::warn!("[plugin:{}] CSRF token not found in process args", pid);
                                continue;
                            }
                        }
                    };

                    let extension_port = opts.port_flag.as_ref().and_then(|flag| {
                        ls_extract_flag(&command, flag).and_then(|v| v.parse::<i32>().ok())
                    });

                    let mut extra = std::collections::HashMap::new();
                    if let Some(ref flags) = opts.extra_flags {
                        for flag in flags {
                            if let Some(val) = ls_extract_flag(&command, flag) {
                                let key = flag.trim_start_matches('-').to_string();
                                extra.insert(key, val);
                            }
                        }
                    }

                    let ports = if let Some(lsof) = lsof_path {
                        match std::process::Command::new(lsof)
                            .args([
                                "-nP",
                                "-iTCP",
                                "-sTCP:LISTEN",
                                "-a",
                                "-p",
                                &process_pid.to_string(),
                            ])
                            .output()
                        {
                            Ok(o) if o.status.success() => {
                                ls_parse_listening_ports(&String::from_utf8_lossy(&o.stdout))
                            }
                            Ok(_) => {
                                log::warn!("[plugin:{}] lsof returned non-zero", pid);
                                Vec::new()
                            }
                            Err(e) => {
                                log::warn!("[plugin:{}] lsof failed: {}", pid, e);
                                Vec::new()
                            }
                        }
                    } else {
                        log::warn!("[plugin:{}] lsof not found", pid);
                        Vec::new()
                    };

                    if ports.is_empty() && extension_port.is_none() {
                        log::warn!(
                            "[plugin:{}] no listening ports found for pid {}",
                            pid,
                            process_pid
                        );
                        continue;
                    }

                    log::info!(
                        "[plugin:{}] LS found: pid={}, ports={:?}, csrf=[REDACTED]",
                        pid,
                        process_pid,
                        ports
                    );

                    let result = LsDiscoverResult {
                        pid: process_pid,
                        csrf,
                        ports,
                        extra,
                        extension_port,
                    };

                    return serde_json::to_string(&result).map_err(|e| {
                        Exception::throw_message(&ctx_inner, &format!("serialize failed: {}", e))
                    });
                }

                Ok("null".to_string())
            },
        )?,
    )?;

    host.set("ls", ls_obj)?;
    Ok(())
}

pub fn patch_ls_wrapper(ctx: &rquickjs::Ctx<'_>) -> rquickjs::Result<()> {
    ctx.eval::<(), _>(
        r#"
        (function() {
            var rawFn = __openusage_ctx.host.ls._discoverRaw;
            __openusage_ctx.host.ls.discover = function(opts) {
                var optsJson;
                try { optsJson = JSON.stringify(opts); } catch (e) { return null; }
                var json = rawFn(optsJson);
                if (json === "null") return null;
                return JSON.parse(json);
            };
        })();
        "#
        .as_bytes(),
    )
}

/// Extract value of a CLI flag from a command string.
/// Handles both `--flag value` and `--flag=value` forms.
pub(crate) fn ls_extract_flag(command: &str, flag: &str) -> Option<String> {
    let parts: Vec<&str> = command.split_whitespace().collect();
    let flag_eq = format!("{}=", flag);
    for (i, part) in parts.iter().enumerate() {
        if *part == flag {
            if i + 1 < parts.len() {
                return Some(parts[i + 1].to_string());
            }
        } else if part.starts_with(&flag_eq) {
            return Some(part[flag_eq.len()..].to_string());
        }
    }
    None
}

pub(crate) fn ls_marker_rank(command: &str, markers_lower: &[String]) -> Option<u8> {
    if markers_lower.is_empty() {
        return Some(0);
    }

    let ide_name = ls_extract_flag(command, "--ide_name").map(|v| v.to_lowercase());
    let app_data = ls_extract_flag(command, "--app_data_dir").map(|v| v.to_lowercase());
    if ide_name.is_some() || app_data.is_some() {
        return markers_lower
            .iter()
            .any(|m| {
                ide_name.as_ref().is_some_and(|name| name == m)
                    || app_data.as_ref().is_some_and(|dir| dir == m)
            })
            .then_some(0);
    }

    let command_lower = command.to_lowercase();
    markers_lower
        .iter()
        .any(|m| command_lower.contains(&format!("/{}/", m)))
        .then_some(1)
}

pub(crate) fn ls_argv0(command: &str) -> &str {
    let trimmed = command.trim_start();
    let Some(quote) = trimmed.chars().next().filter(|c| *c == '"' || *c == '\'') else {
        return trimmed.split_whitespace().next().unwrap_or_default();
    };

    let quote_len = quote.len_utf8();
    let rest = &trimmed[quote_len..];
    match rest.find(quote) {
        Some(end) => &rest[..end],
        None => trimmed.split_whitespace().next().unwrap_or_default(),
    }
}

pub(crate) fn ls_command_matches_process(command: &str, process_name_lower: &str) -> bool {
    if process_name_lower.is_empty() {
        return false;
    }

    let argv0 = ls_argv0(command);
    let exe_name = Path::new(argv0)
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.to_lowercase())
        .unwrap_or_default();

    if exe_name == process_name_lower {
        return true;
    }

    if process_name_lower.len() >= 8 {
        exe_name.starts_with(&format!("{}_", process_name_lower))
            || command.to_lowercase().contains(process_name_lower)
    } else {
        let command_lower = command.to_lowercase();
        command_lower.ends_with(&format!("/{}", process_name_lower))
            || command_lower.contains(&format!("/{} ", process_name_lower))
            || command_lower.contains(&format!("/{}\t", process_name_lower))
    }
}

/// Parse listening port numbers from `lsof -nP -iTCP -sTCP:LISTEN` output.
pub(crate) fn ls_parse_listening_ports(output: &str) -> Vec<i32> {
    let mut ports = std::collections::BTreeSet::new();
    for line in output.lines() {
        if !line.contains("LISTEN") {
            continue;
        }
        // lsof -nP output: ... TCP 127.0.0.1:PORT (LISTEN)  or  ... TCP *:PORT
        // Scan tokens in reverse to find the address:port token.
        for token in line.split_whitespace().rev() {
            if let Some(colon_pos) = token.rfind(':') {
                let port_str = &token[colon_pos + 1..];
                if let Ok(port) = port_str.parse::<i32>()
                    && port > 0
                    && port < 65536
                {
                    ports.insert(port);
                    break;
                }
            }
        }
    }
    ports.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ls_command_matches_language_server_variants() {
        assert!(ls_command_matches_process(
            "/Applications/Antigravity IDE.app/Contents/Resources/language_server_macos_arm --app_data_dir antigravity-ide",
            "language_server"
        ));
        assert!(ls_command_matches_process(
            "/tmp/language_server --app_data_dir antigravity-ide",
            "language_server"
        ));
    }

    #[test]
    fn ls_command_matches_short_process_names_exactly() {
        assert!(ls_command_matches_process(
            "/opt/homebrew/bin/agy --some-flag",
            "agy"
        ));
        assert!(ls_command_matches_process(
            "/Applications/Antigravity IDE.app/Contents/Resources/agy --some-flag",
            "agy"
        ));
        assert!(ls_command_matches_process(
            "\"/Applications/Antigravity IDE.app/Contents/Resources/agy\" --some-flag",
            "agy"
        ));
        assert!(!ls_command_matches_process(
            "/opt/homebrew/bin/not-agy-helper --some-flag agy",
            "agy"
        ));
    }

    #[test]
    fn ls_marker_rank_prefers_exact_flags_over_path_fallback() {
        let markers = vec!["antigravity".to_string()];

        assert_eq!(
            ls_marker_rank(
                "/tmp/windsurf/language_server --ide_name antigravity",
                &markers
            ),
            Some(0)
        );
        assert_eq!(
            ls_marker_rank("/tmp/antigravity/language_server", &markers),
            Some(1)
        );
        assert_eq!(
            ls_marker_rank(
                "/tmp/antigravity/language_server --ide_name windsurf",
                &markers
            ),
            None
        );
    }
}
