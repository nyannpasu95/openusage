(function () {
  const BASE_URL = "https://api.z.ai"
  const SUBSCRIPTION_URL = BASE_URL + "/api/biz/subscription/list"
  const QUOTA_URL = BASE_URL + "/api/monitor/usage/quota/limit"
  const PERIOD_MS = 5 * 60 * 60 * 1000
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000
  const MONTH_MS = 30 * 24 * 60 * 60 * 1000
  const KEYCHAIN_SERVICE = "OpenUsage-zai-credential"

  function readStoredCredential(ctx) {
    if (!ctx.host.keychain || typeof ctx.host.keychain.readGenericPassword !== "function") {
      return null
    }
    try {
      const stored = ctx.host.keychain.readGenericPassword(KEYCHAIN_SERVICE)
      if (typeof stored === "string" && stored.trim()) return stored.trim()
    } catch (e) {
      if (String(e).indexOf("item not found") === -1) {
        ctx.host.log.warn("keychain read failed for stored credential: " + String(e))
      }
    }
    return null
  }

  function loadApiKeyWithSource(ctx) {
    const stored = readStoredCredential(ctx)
    if (stored) return { value: stored, source: "Settings" }

    const zai = ctx.host.env.get("ZAI_API_KEY")
    if (typeof zai === "string" && zai.trim()) return { value: zai.trim(), source: "Env" }

    const glm = ctx.host.env.get("GLM_API_KEY")
    if (typeof glm === "string" && glm.trim()) return { value: glm.trim(), source: "Env" }

    return null
  }

  function loadApiKey(ctx) {
    const loaded = loadApiKeyWithSource(ctx)
    return loaded ? loaded.value : null
  }

  function readNumber(value) {
    if (typeof value === "string" && !value.trim()) return null
    const n = typeof value === "string" ? Number(value) : value
    return typeof n === "number" && Number.isFinite(n) ? n : null
  }

  function fetchSubscription(ctx, apiKey) {
    try {
      const resp = ctx.util.request({
        method: "GET",
        url: SUBSCRIPTION_URL,
        headers: {
          Authorization: "Bearer " + apiKey,
          Accept: "application/json",
        },
        timeoutMs: 10000,
      })
      if (resp.status < 200 || resp.status >= 300) {
        ctx.host.log.warn("subscription request failed: HTTP " + resp.status)
        return null
      }
      const data = ctx.util.tryParseJson(resp.bodyText)
      if (!data) return null
      const list = data.data
      if (!Array.isArray(list) || list.length === 0) return null
      return {
        productName: list[0].productName || null,
        nextRenewTime: list[0].nextRenewTime || null,
      }
    } catch (e) {
      ctx.host.log.warn("subscription request exception: " + String(e))
      return null
    }
  }

  function fetchQuota(ctx, apiKey) {
    let resp
    try {
      resp = ctx.util.request({
        method: "GET",
        url: QUOTA_URL,
        headers: {
          Authorization: "Bearer " + apiKey,
          Accept: "application/json",
        },
        timeoutMs: 10000,
      })
    } catch (e) {
      ctx.host.log.error("usage request exception: " + String(e))
      throw "Usage request failed. Check your connection."
    }

    if (ctx.util.isAuthStatus(resp.status)) {
      throw "API key invalid. Check your Z.ai API key."
    }

    if (resp.status < 200 || resp.status >= 300) {
      throw "Usage request failed (HTTP " + String(resp.status) + "). Try again later."
    }

    const data = ctx.util.tryParseJson(resp.bodyText)
    if (!data) {
      throw "Usage response invalid. Try again later."
    }

    return data
  }

  function findLimit(limits, type, unit) {
    let fallback = null
    for (let i = 0; i < limits.length; i++) {
      const item = limits[i]
      if (item.type === type || item.name === type) {
        if (unit === undefined) {
          return item
        }
        if (item.unit === unit) {
          return item
        }
        // Store first entry without unit as fallback
        if (fallback === null && item.unit === undefined) {
          fallback = item
        }
      }
    }
    return fallback
  }

  function probe(ctx) {
    const apiKey = loadApiKey(ctx)
    if (!apiKey) {
      throw "No Z.ai API key found. Set it in Settings → Credentials, or the ZAI_API_KEY / GLM_API_KEY env vars."
    }

    const sub = fetchSubscription(ctx, apiKey)
    const plan = sub && sub.productName ? ctx.fmt.planLabel(sub.productName) : null

    const quota = fetchQuota(ctx, apiKey)
    const lines = []

    const container = quota.data || quota
    const limits = container.limits || container
    if (!Array.isArray(limits) || limits.length === 0) {
      lines.push(ctx.line.badge({ label: "Session", text: "No usage data", color: "#a3a3a3" }))
      return { plan, lines }
    }

    const tokenLimit = findLimit(limits, "TOKENS_LIMIT", 3)
    const used = tokenLimit ? readNumber(tokenLimit.percentage) : null

    if (used === null) {
      lines.push(ctx.line.badge({ label: "Session", text: "No usage data", color: "#a3a3a3" }))
      return { plan, lines }
    }

    const resetsAt = tokenLimit.nextResetTime ? ctx.util.toIso(tokenLimit.nextResetTime) : undefined

    const progressOpts = {
      label: "Session",
      used,
      limit: 100,
      format: { kind: "percent" },
      periodDurationMs: PERIOD_MS,
    }
    if (resetsAt) {
      progressOpts.resetsAt = resetsAt
    }
    lines.push(ctx.line.progress(progressOpts))

    const weeklyTokenLimit = findLimit(limits, "TOKENS_LIMIT", 6)
    const weeklyUsed = weeklyTokenLimit ? readNumber(weeklyTokenLimit.percentage) : null
    if (weeklyUsed !== null) {
      const weeklyResetsAt = weeklyTokenLimit.nextResetTime ? ctx.util.toIso(weeklyTokenLimit.nextResetTime) : undefined

      const weeklyOpts = {
        label: "Weekly",
        used: weeklyUsed,
        limit: 100,
        format: { kind: "percent" },
        periodDurationMs: WEEK_MS,
      }
      if (weeklyResetsAt) {
        weeklyOpts.resetsAt = weeklyResetsAt
      }
      lines.push(ctx.line.progress(weeklyOpts))
    }

    const timeLimit = findLimit(limits, "TIME_LIMIT")

    if (timeLimit) {
      const webUsed = readNumber(timeLimit.currentValue)
      const webTotal = readNumber(timeLimit.usage)
      if (webUsed !== null && webTotal !== null && webTotal > 0) {
        const now = new Date()
        const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
        const webResetsAt = timeLimit.nextResetTime
          ? ctx.util.toIso(timeLimit.nextResetTime)
          : nextMonth.toISOString()

        const webOpts = {
          label: "Web Searches",
          used: webUsed,
          limit: webTotal,
          format: { kind: "count", suffix: "/ " + webTotal },
          periodDurationMs: MONTH_MS,
        }
        if (webResetsAt) {
          webOpts.resetsAt = webResetsAt
        }
        lines.push(ctx.line.progress(webOpts))
      }
    }

    return { plan, lines }
  }

  function checkCredentials(ctx) {
    const loaded = loadApiKeyWithSource(ctx)
    return loaded ? { configured: true, source: loaded.source } : { configured: false }
  }

  globalThis.__openusage_plugin = { id: "zai", probe, checkCredentials }
})()
