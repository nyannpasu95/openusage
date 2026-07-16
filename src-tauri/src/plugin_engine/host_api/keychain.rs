use super::*;

pub(crate) fn current_macos_keychain_account_from_user_env(user_env: Option<String>) -> String {
    user_env
        .and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        })
        .or_else(|| read_env_value_via_command("id", &["-un"]))
        .unwrap_or_else(|| "openusage-user".to_string())
}

pub(crate) fn current_macos_keychain_account() -> String {
    current_macos_keychain_account_from_user_env(read_env_from_process("USER"))
}

pub(crate) fn keychain_find_generic_password_args(service: &str) -> Vec<OsString> {
    vec![
        OsString::from("find-generic-password"),
        OsString::from("-s"),
        OsString::from(service),
        OsString::from("-w"),
    ]
}

pub(crate) fn keychain_find_generic_password_args_for_account(
    service: &str,
    account: &str,
) -> Vec<OsString> {
    vec![
        OsString::from("find-generic-password"),
        OsString::from("-a"),
        OsString::from(account),
        OsString::from("-s"),
        OsString::from(service),
        OsString::from("-w"),
    ]
}

pub(crate) fn keychain_add_generic_password_args(service: &str, value: &str) -> Vec<OsString> {
    vec![
        OsString::from("add-generic-password"),
        OsString::from("-U"),
        OsString::from("-s"),
        OsString::from(service),
        OsString::from("-w"),
        OsString::from(value),
    ]
}

pub(crate) fn keychain_add_generic_password_args_for_account(
    service: &str,
    account: &str,
    value: &str,
) -> Vec<OsString> {
    vec![
        OsString::from("add-generic-password"),
        OsString::from("-U"),
        OsString::from("-a"),
        OsString::from(account),
        OsString::from("-s"),
        OsString::from(service),
        OsString::from("-w"),
        OsString::from(value),
    ]
}

pub(crate) fn keychain_delete_generic_password_args(service: &str) -> Vec<OsString> {
    vec![
        OsString::from("delete-generic-password"),
        OsString::from("-s"),
        OsString::from(service),
    ]
}

pub(crate) fn keychain_delete_generic_password_args_for_account(
    service: &str,
    account: &str,
) -> Vec<OsString> {
    vec![
        OsString::from("delete-generic-password"),
        OsString::from("-a"),
        OsString::from(account),
        OsString::from("-s"),
        OsString::from(service),
    ]
}

pub(crate) fn inject_keychain<'js>(
    ctx: &Ctx<'js>,
    host: &Object<'js>,
    plugin_id: &str,
) -> rquickjs::Result<()> {
    let keychain_obj = Object::new(ctx.clone())?;
    let pid_read = plugin_id.to_string();

    keychain_obj.set(
        "readGenericPassword",
        Function::new(
            ctx.clone(),
            move |ctx_inner: Ctx<'_>,
                  service: String,
                  account_args: Rest<Option<String>>|
                  -> rquickjs::Result<String> {
                if !cfg!(target_os = "macos") {
                    return Err(Exception::throw_message(
                        &ctx_inner,
                        "keychain API is only supported on macOS",
                    ));
                }
                let account = account_args
                    .0
                    .into_iter()
                    .next()
                    .flatten()
                    .and_then(|value| {
                        let trimmed = value.trim();
                        if trimmed.is_empty() {
                            None
                        } else {
                            Some(trimmed.to_string())
                        }
                    });
                let redacted_account = account.as_ref().map(|value| redact_value(value));
                if let Some(ref redacted) = redacted_account {
                    log::info!(
                        "[plugin:{}] keychain read: service={}, account={}",
                        pid_read,
                        service,
                        redacted
                    );
                } else {
                    log::info!("[plugin:{}] keychain read: service={}", pid_read, service);
                }
                let args = if let Some(ref account) = account {
                    keychain_find_generic_password_args_for_account(&service, account)
                } else {
                    keychain_find_generic_password_args(&service)
                };
                let output = std::process::Command::new("security")
                    .args(args)
                    .output()
                    .map_err(|e| {
                        Exception::throw_message(
                            &ctx_inner,
                            &format!("keychain read failed: {}", e),
                        )
                    })?;

                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    let first_line = stderr.lines().next().unwrap_or("").trim();
                    if let Some(ref redacted) = redacted_account {
                        log::warn!(
                            "[plugin:{}] keychain read miss: service={}, account={}, error={}",
                            pid_read,
                            service,
                            redacted,
                            first_line
                        );
                    } else {
                        log::warn!(
                            "[plugin:{}] keychain read miss: service={}, error={}",
                            pid_read,
                            service,
                            first_line
                        );
                    }
                    return Err(Exception::throw_message(
                        &ctx_inner,
                        &format!("keychain item not found: {}", first_line),
                    ));
                }

                if let Some(ref redacted) = redacted_account {
                    log::info!(
                        "[plugin:{}] keychain read hit: service={}, account={}",
                        pid_read,
                        service,
                        redacted
                    );
                } else {
                    log::info!(
                        "[plugin:{}] keychain read hit: service={}",
                        pid_read,
                        service
                    );
                }
                Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
            },
        )?,
    )?;

    let pid_read_current_user = plugin_id.to_string();
    keychain_obj.set(
        "readGenericPasswordForCurrentUser",
        Function::new(
            ctx.clone(),
            move |ctx_inner: Ctx<'_>, service: String| -> rquickjs::Result<String> {
                if !cfg!(target_os = "macos") {
                    return Err(Exception::throw_message(
                        &ctx_inner,
                        "keychain API is only supported on macOS",
                    ));
                }
                let account = current_macos_keychain_account();
                let args = keychain_find_generic_password_args_for_account(&service, &account);
                let redacted_account = redact_value(&account);
                log::info!(
                    "[plugin:{}] keychain read: service={}, account={}",
                    pid_read_current_user,
                    service,
                    redacted_account
                );
                let output = std::process::Command::new("security")
                    .args(&args)
                    .output()
                    .map_err(|e| {
                        Exception::throw_message(
                            &ctx_inner,
                            &format!("keychain read failed: {}", e),
                        )
                    })?;

                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    let first_line = stderr.lines().next().unwrap_or("").trim();
                    log::warn!(
                        "[plugin:{}] keychain read miss: service={}, account={}, error={}",
                        pid_read_current_user,
                        service,
                        redacted_account,
                        first_line
                    );
                    return Err(Exception::throw_message(
                        &ctx_inner,
                        &format!("keychain item not found: {}", first_line),
                    ));
                }

                log::info!(
                    "[plugin:{}] keychain read hit: service={}, account={}",
                    pid_read_current_user,
                    service,
                    redacted_account
                );
                Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
            },
        )?,
    )?;

    let pid_write = plugin_id.to_string();
    keychain_obj.set(
        "writeGenericPassword",
        Function::new(
            ctx.clone(),
            move |ctx_inner: Ctx<'_>, service: String, value: String| -> rquickjs::Result<()> {
                if !cfg!(target_os = "macos") {
                    return Err(Exception::throw_message(
                        &ctx_inner,
                        "keychain API is only supported on macOS",
                    ));
                }
                log::info!("[plugin:{}] keychain write: service={}", pid_write, service);

                let mut account_arg: Option<String> = None;
                let find_output = std::process::Command::new("security")
                    .args(["find-generic-password", "-s", &service])
                    .output();

                if let Ok(output) = find_output
                    && output.status.success()
                {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    for line in stdout.lines() {
                        if let Some(start) = line.find("\"acct\"<blob>=\"") {
                            let rest = &line[start + 14..];
                            if let Some(end) = rest.find('"') {
                                account_arg = Some(rest[..end].to_string());
                                break;
                            }
                        }
                    }
                }

                let output = if let Some(ref acct) = account_arg {
                    std::process::Command::new("security")
                        .args(keychain_add_generic_password_args_for_account(
                            &service, acct, &value,
                        ))
                        .output()
                } else {
                    std::process::Command::new("security")
                        .args(keychain_add_generic_password_args(&service, &value))
                        .output()
                }
                .map_err(|e| {
                    Exception::throw_message(&ctx_inner, &format!("keychain write failed: {}", e))
                })?;

                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    let first_line = stderr.lines().next().unwrap_or("").trim();
                    log::warn!(
                        "[plugin:{}] keychain write failed: service={}, error={}",
                        pid_write,
                        service,
                        first_line
                    );
                    return Err(Exception::throw_message(
                        &ctx_inner,
                        &format!("keychain write failed: {}", first_line),
                    ));
                }

                log::info!(
                    "[plugin:{}] keychain write succeeded: service={}",
                    pid_write,
                    service
                );
                Ok(())
            },
        )?,
    )?;

    let pid_write_current_user = plugin_id.to_string();
    keychain_obj.set(
        "writeGenericPasswordForCurrentUser",
        Function::new(
            ctx.clone(),
            move |ctx_inner: Ctx<'_>, service: String, value: String| -> rquickjs::Result<()> {
                if !cfg!(target_os = "macos") {
                    return Err(Exception::throw_message(
                        &ctx_inner,
                        "keychain API is only supported on macOS",
                    ));
                }
                let account = current_macos_keychain_account();
                let args =
                    keychain_add_generic_password_args_for_account(&service, &account, &value);
                let redacted_account = redact_value(&account);
                log::info!(
                    "[plugin:{}] keychain write: service={}, account={}",
                    pid_write_current_user,
                    service,
                    redacted_account
                );
                let output = std::process::Command::new("security")
                    .args(&args)
                    .output()
                    .map_err(|e| {
                        Exception::throw_message(
                            &ctx_inner,
                            &format!("keychain write failed: {}", e),
                        )
                    })?;

                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    let first_line = stderr.lines().next().unwrap_or("").trim();
                    log::warn!(
                        "[plugin:{}] keychain write failed: service={}, account={}, error={}",
                        pid_write_current_user,
                        service,
                        redacted_account,
                        first_line
                    );
                    return Err(Exception::throw_message(
                        &ctx_inner,
                        &format!("keychain write failed: {}", first_line),
                    ));
                }

                log::info!(
                    "[plugin:{}] keychain write succeeded: service={}, account={}",
                    pid_write_current_user,
                    service,
                    redacted_account
                );
                Ok(())
            },
        )?,
    )?;

    let pid_delete = plugin_id.to_string();
    keychain_obj.set(
        "deleteGenericPassword",
        Function::new(
            ctx.clone(),
            move |ctx_inner: Ctx<'_>,
                  service: String,
                  account_args: Rest<Option<String>>|
                  -> rquickjs::Result<()> {
                if !cfg!(target_os = "macos") {
                    return Err(Exception::throw_message(
                        &ctx_inner,
                        "keychain API is only supported on macOS",
                    ));
                }
                let account = account_args
                    .0
                    .into_iter()
                    .next()
                    .flatten()
                    .and_then(|value| {
                        let trimmed = value.trim();
                        if trimmed.is_empty() {
                            None
                        } else {
                            Some(trimmed.to_string())
                        }
                    });
                let redacted_account = account.as_ref().map(|value| redact_value(value));
                if let Some(ref redacted) = redacted_account {
                    log::info!(
                        "[plugin:{}] keychain delete: service={}, account={}",
                        pid_delete,
                        service,
                        redacted
                    );
                } else {
                    log::info!(
                        "[plugin:{}] keychain delete: service={}",
                        pid_delete,
                        service
                    );
                }
                let args = if let Some(ref account) = account {
                    keychain_delete_generic_password_args_for_account(&service, account)
                } else {
                    keychain_delete_generic_password_args(&service)
                };
                let output = std::process::Command::new("security")
                    .args(args)
                    .output()
                    .map_err(|e| {
                        Exception::throw_message(
                            &ctx_inner,
                            &format!("keychain delete failed: {}", e),
                        )
                    })?;

                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    let first_line = stderr.lines().next().unwrap_or("").trim();
                    // A missing item is a common, benign outcome when clearing a
                    // cached credential that was never stored; treat it as success.
                    let not_found = first_line.contains("could not be found");
                    if let Some(ref redacted) = redacted_account {
                        if not_found {
                            log::info!(
                                "[plugin:{}] keychain delete miss (no-op): service={}, account={}",
                                pid_delete,
                                service,
                                redacted
                            );
                        } else {
                            log::warn!(
                                "[plugin:{}] keychain delete failed: service={}, account={}, error={}",
                                pid_delete,
                                service,
                                redacted,
                                first_line
                            );
                        }
                    } else if not_found {
                        log::info!(
                            "[plugin:{}] keychain delete miss (no-op): service={}",
                            pid_delete,
                            service
                        );
                    } else {
                        log::warn!(
                            "[plugin:{}] keychain delete failed: service={}, error={}",
                            pid_delete,
                            service,
                            first_line
                        );
                    }
                    if !not_found {
                        return Err(Exception::throw_message(
                            &ctx_inner,
                            &format!("keychain delete failed: {}", first_line),
                        ));
                    }
                    return Ok(());
                }

                if let Some(ref redacted) = redacted_account {
                    log::info!(
                        "[plugin:{}] keychain delete succeeded: service={}, account={}",
                        pid_delete,
                        service,
                        redacted
                    );
                } else {
                    log::info!(
                        "[plugin:{}] keychain delete succeeded: service={}",
                        pid_delete,
                        service
                    );
                }
                Ok(())
            },
        )?,
    )?;

    host.set("keychain", keychain_obj)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rquickjs::{Context, Runtime};

    #[test]
    fn keychain_api_exposes_read_write_and_delete_variants() {
        let rt = Runtime::new().expect("runtime");
        let ctx = Context::full(&rt).expect("context");
        ctx.with(|ctx| {
            let app_data = std::env::temp_dir();
            inject_host_api(&ctx, "test", &app_data, "0.0.0").expect("inject host api");
            let globals = ctx.globals();
            let probe_ctx: Object = globals.get("__openusage_ctx").expect("probe ctx");
            let host: Object = probe_ctx.get("host").expect("host");
            let keychain: Object = host.get("keychain").expect("keychain");
            let _read: Function = keychain
                .get("readGenericPassword")
                .expect("readGenericPassword");
            let _read_current_user: Function = keychain
                .get("readGenericPasswordForCurrentUser")
                .expect("readGenericPasswordForCurrentUser");
            let _write: Function = keychain
                .get("writeGenericPassword")
                .expect("writeGenericPassword");
            let _write_current_user: Function = keychain
                .get("writeGenericPasswordForCurrentUser")
                .expect("writeGenericPasswordForCurrentUser");
            let _delete: Function = keychain
                .get("deleteGenericPassword")
                .expect("deleteGenericPassword");
        });
    }

    #[test]
    fn keychain_read_generic_password_accepts_optional_account_arg_from_js() {
        let rt = Runtime::new().expect("runtime");
        let ctx = Context::full(&rt).expect("context");
        ctx.with(|ctx| {
            let app_data = std::env::temp_dir();
            inject_host_api(&ctx, "test", &app_data, "0.0.0").expect("inject host api");

            let message: String = ctx
                .eval(
                    r#"
                    try {
                        __openusage_ctx.host.keychain.readGenericPassword("__openusage_missing_service__");
                        "ok";
                    } catch (e) {
                        String(e);
                    }
                    "#,
                )
                .expect("js eval");

            assert!(
                !message.contains("2 where expected"),
                "single-arg call should reach the keychain implementation, got: {}",
                message
            );
        });
    }

    #[test]
    fn current_macos_keychain_account_prefers_explicit_user_value() {
        assert_eq!(
            current_macos_keychain_account_from_user_env(Some("openusage-test-user".to_string())),
            "openusage-test-user"
        );
    }

    #[test]
    fn keychain_find_generic_password_args_include_service_only_lookup() {
        let args = keychain_find_generic_password_args("Claude Code-credentials");
        let rendered: Vec<String> = args
            .into_iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect();

        assert_eq!(
            rendered,
            vec![
                "find-generic-password",
                "-s",
                "Claude Code-credentials",
                "-w",
            ]
        );
    }

    #[test]
    fn keychain_find_generic_password_args_for_account_include_account_and_service() {
        let args = keychain_find_generic_password_args_for_account(
            "Claude Code-credentials",
            "openusage-test-user",
        );
        let rendered: Vec<String> = args
            .into_iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect();

        assert_eq!(
            rendered,
            vec![
                "find-generic-password",
                "-a",
                "openusage-test-user",
                "-s",
                "Claude Code-credentials",
                "-w",
            ]
        );
    }

    #[test]
    fn keychain_add_generic_password_args_include_service_only_write() {
        let args = keychain_add_generic_password_args("Claude Code-credentials", "secret-value");
        let rendered: Vec<String> = args
            .into_iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect();

        assert_eq!(
            rendered,
            vec![
                "add-generic-password",
                "-U",
                "-s",
                "Claude Code-credentials",
                "-w",
                "secret-value",
            ]
        );
    }

    #[test]
    fn keychain_delete_generic_password_args_include_service_only_delete() {
        let args = keychain_delete_generic_password_args("Claude Code-credentials");
        let rendered: Vec<String> = args
            .into_iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect();

        assert_eq!(
            rendered,
            vec!["delete-generic-password", "-s", "Claude Code-credentials",]
        );
    }

    #[test]
    fn keychain_delete_generic_password_args_for_account_include_account_and_service() {
        let args = keychain_delete_generic_password_args_for_account(
            "Claude Code-credentials",
            "openusage-test-user",
        );
        let rendered: Vec<String> = args
            .into_iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect();

        assert_eq!(
            rendered,
            vec![
                "delete-generic-password",
                "-a",
                "openusage-test-user",
                "-s",
                "Claude Code-credentials",
            ]
        );
    }

    #[test]
    fn keychain_add_generic_password_args_for_account_include_update_account_service_and_value() {
        let args = keychain_add_generic_password_args_for_account(
            "Claude Code-credentials",
            "openusage-test-user",
            "secret-value",
        );
        let rendered: Vec<String> = args
            .into_iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect();

        assert_eq!(
            rendered,
            vec![
                "add-generic-password",
                "-U",
                "-a",
                "openusage-test-user",
                "-s",
                "Claude Code-credentials",
                "-w",
                "secret-value",
            ]
        );
    }
}
