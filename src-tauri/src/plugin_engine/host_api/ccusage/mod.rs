use super::*;

mod args;
mod config;
mod process;
mod runners;

pub(crate) use args::*;
pub(crate) use config::*;
pub(crate) use process::*;
pub(crate) use runners::*;

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
