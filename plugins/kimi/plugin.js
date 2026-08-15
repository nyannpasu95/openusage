(function () {
  const CRED_PATH = "~/.kimi-code/credentials/kimi-code.json"
  const USAGE_URL = "https://api.kimi.com/coding/v1/usages"
  const REFRESH_URL = "https://auth.kimi.com/api/oauth/token"
  const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098"
  const REFRESH_BUFFER_SEC = 5 * 60
  const FIXED_POINT_CENTS = 1e6
  const MONTHLY_OVERRIDE_PATH = "~/.openusage/kimi-monthly.json"

  function readNumber(value) {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }

  function titleCaseWords(value) {
    return String(value)
      .trim()
      .toLowerCase()
      .replace(/\b[a-z]/g, function (c) {
        return c.toUpperCase()
      })
  }

  function parsePlanLabel(data) {
    const level =
      data &&
      data.user &&
      data.user.membership &&
      typeof data.user.membership.level === "string"
        ? data.user.membership.level
        : null
    if (!level) return null

    const cleaned = level.replace(/^LEVEL_/, "").replace(/_/g, " ")
    const label = titleCaseWords(cleaned)
    return label || null
  }

  function loadCredentials(ctx) {
    if (!ctx.host.fs.exists(CRED_PATH)) {
      ctx.host.log.warn("credentials file not found: " + CRED_PATH)
      return null
    }

    try {
      const text = ctx.host.fs.readText(CRED_PATH)
      const parsed = ctx.util.tryParseJson(text)
      if (!parsed || typeof parsed !== "object") {
        ctx.host.log.warn("credentials file is not valid json")
        return null
      }
      if (!parsed.access_token && !parsed.refresh_token) {
        ctx.host.log.warn("credentials missing access_token and refresh_token")
        return null
      }
      return parsed
    } catch (e) {
      ctx.host.log.warn("credentials read failed: " + String(e))
      return null
    }
  }

  function saveCredentials(ctx, creds) {
    try {
      ctx.host.fs.writeText(CRED_PATH, JSON.stringify(creds))
    } catch (e) {
      ctx.host.log.warn("failed to persist credentials: " + String(e))
    }
  }

  function needsRefresh(creds, nowSec) {
    if (!creds.access_token) return true
    const expiresAt = readNumber(creds.expires_at)
    if (expiresAt === null) return true
    return nowSec + REFRESH_BUFFER_SEC >= expiresAt
  }

  function refreshToken(ctx, creds) {
    if (!creds.refresh_token) {
      ctx.host.log.warn("refresh skipped: no refresh token")
      return null
    }

    ctx.host.log.info("attempting token refresh")
    let resp
    try {
      resp = ctx.util.request({
        method: "POST",
        url: REFRESH_URL,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        bodyText:
          "client_id=" +
          encodeURIComponent(CLIENT_ID) +
          "&grant_type=refresh_token" +
          "&refresh_token=" +
          encodeURIComponent(creds.refresh_token),
        timeoutMs: 15000,
      })
    } catch (e) {
      ctx.host.log.error("refresh exception: " + String(e))
      return null
    }

    if (ctx.util.isAuthStatus(resp.status)) {
      throw "Session expired. Run `kimi login` to authenticate."
    }

    if (resp.status < 200 || resp.status >= 300) {
      ctx.host.log.warn("refresh returned unexpected status: " + resp.status)
      return null
    }

    const body = ctx.util.tryParseJson(resp.bodyText)
    if (!body || !body.access_token) {
      ctx.host.log.warn("refresh response missing access_token")
      return null
    }

    creds.access_token = body.access_token
    if (body.refresh_token) creds.refresh_token = body.refresh_token
    if (typeof body.expires_in === "number") {
      creds.expires_at = Date.now() / 1000 + body.expires_in
    }
    if (typeof body.scope === "string") creds.scope = body.scope
    if (typeof body.token_type === "string") creds.token_type = body.token_type

    saveCredentials(ctx, creds)
    return creds.access_token
  }

  function fetchUsage(ctx, accessToken) {
    return ctx.util.request({
      method: "GET",
      url: USAGE_URL,
      headers: {
        Authorization: "Bearer " + accessToken,
        Accept: "application/json",
        "User-Agent": "OhMyUsage",
      },
      timeoutMs: 10000,
    })
  }

  function parseWindowPeriodMs(window) {
    if (!window || typeof window !== "object") return null
    const duration = readNumber(window.duration)
    if (duration === null || duration <= 0) return null

    const unit = String(window.timeUnit || window.time_unit || "").toUpperCase()
    if (unit.indexOf("MINUTE") !== -1) return duration * 60 * 1000
    if (unit.indexOf("HOUR") !== -1) return duration * 60 * 60 * 1000
    if (unit.indexOf("DAY") !== -1) return duration * 24 * 60 * 60 * 1000
    if (unit.indexOf("SECOND") !== -1) return duration * 1000
    return null
  }

  function parseQuota(row, ctx) {
    if (!row || typeof row !== "object") return null

    const limit = readNumber(row.limit)
    if (limit === null || limit <= 0) return null

    let used = readNumber(row.used)
    if (used === null) {
      const remaining = readNumber(row.remaining)
      if (remaining !== null) {
        used = limit - remaining
      }
    }
    if (used === null) return null

    return {
      used,
      limit,
      resetsAt: ctx.util.toIso(row.resetTime || row.reset_at || row.resetAt || row.reset_time),
    }
  }

  function parseBoosterMonthlyCap(data) {
    const wallet = data && typeof data.boosterWallet === "object" ? data.boosterWallet : null
    if (!wallet || wallet.monthlyChargeLimitEnabled !== true) return null

    const limitMoney = wallet.monthlyChargeLimit
    const limit = limitMoney ? readNumber(limitMoney.priceInCents) : null
    if (limit === null || limit <= 0) return null

    const usedMoney = wallet.monthlyUsed
    const used = (usedMoney && readNumber(usedMoney.priceInCents)) || 0

    return { used, limit, resetsAt: null }
  }

  function parseBoosterBalance(data) {
    const wallet = data && typeof data.boosterWallet === "object" ? data.boosterWallet : null
    if (!wallet) return null

    const balance = wallet.balance && typeof wallet.balance === "object" ? wallet.balance : null
    if (!balance || balance.type !== "BOOSTER") return null

    const amount = readNumber(balance.amount)
    if (amount === null || amount <= 0) return null

    const amountLeft = readNumber(balance.amountLeft)
    const cents = amountLeft === null ? 0 : Math.round(amountLeft / FIXED_POINT_CENTS)

    const limitMoney = wallet.monthlyChargeLimit
    const usedMoney = wallet.monthlyUsed
    const currency =
      (limitMoney && typeof limitMoney.currency === "string" && limitMoney.currency) ||
      (usedMoney && typeof usedMoney.currency === "string" && usedMoney.currency) ||
      "USD"

    return { cents, currency }
  }

  function formatMoney(cents, currency) {
    const upper = String(currency || "").toUpperCase()
    const symbol = upper === "CNY" ? "¥" : upper === "USD" ? "$" : ""
    const formatted = (cents / 100).toFixed(2)
    return symbol ? symbol + formatted : formatted + " " + String(currency || "")
  }

  // TEMPORARY manual fill: /usages never populates totalQuota today (see
  // docs/providers/kimi.md), so the monthly total can be supplied via a local
  // JSON file. API data wins when present. Remove once totalQuota goes live.
  function loadMonthlyOverride(ctx) {
    if (!ctx.host.fs.exists(MONTHLY_OVERRIDE_PATH)) return null

    const parsed = ctx.util.tryParseJson(ctx.host.fs.readText(MONTHLY_OVERRIDE_PATH))
    if (!parsed || typeof parsed !== "object") {
      ctx.host.log.warn("monthly override is not valid json")
      return null
    }

    const used = readNumber(parsed.usedPercent)
    if (used === null || used < 0 || used > 100) {
      ctx.host.log.warn("monthly override needs usedPercent between 0 and 100")
      return null
    }

    return {
      used: Math.round(used * 10) / 10,
      limit: 100,
      resetsAt: ctx.util.toIso(parsed.resetsAt) || undefined,
    }
  }

  function toPercentUsage(quota) {
    if (!quota || quota.limit <= 0) return null
    const usedPercent = (quota.used / quota.limit) * 100
    if (!Number.isFinite(usedPercent)) return null
    return {
      used: Math.round(Math.max(0, usedPercent) * 10) / 10,
      limit: 100,
      resetsAt: quota.resetsAt,
    }
  }

  function collectLimitCandidates(ctx, data) {
    const limits = Array.isArray(data && data.limits) ? data.limits : []
    const out = []

    for (let i = 0; i < limits.length; i += 1) {
      const item = limits[i]
      const detail = item && typeof item.detail === "object" ? item.detail : item
      const quota = parseQuota(detail, ctx)
      if (!quota) continue

      const periodMs = parseWindowPeriodMs(item && item.window)
      out.push({ quota, periodMs })
    }

    return out
  }

  function pickSessionCandidate(candidates) {
    if (!candidates.length) return null
    const sorted = candidates.slice().sort(function (a, b) {
      const aKnown = typeof a.periodMs === "number"
      const bKnown = typeof b.periodMs === "number"
      if (aKnown && bKnown) return a.periodMs - b.periodMs
      if (aKnown) return -1
      if (bKnown) return 1
      return 0
    })
    return sorted[0]
  }

  function pickLargestByPeriod(candidates) {
    if (!candidates.length) return null
    let best = candidates[0]
    for (let i = 1; i < candidates.length; i += 1) {
      const cur = candidates[i]
      const curMs = typeof cur.periodMs === "number" ? cur.periodMs : -1
      const bestMs = typeof best.periodMs === "number" ? best.periodMs : -1
      if (curMs > bestMs) best = cur
    }
    return best
  }

  function sameQuota(a, b) {
    if (!a || !b) return false
    return (
      a.quota.used === b.quota.used &&
      a.quota.limit === b.quota.limit &&
      (a.quota.resetsAt || null) === (b.quota.resetsAt || null)
    )
  }

  function probe(ctx) {
    const creds = loadCredentials(ctx)
    if (!creds) {
      throw "Not logged in. Run `kimi login` to authenticate."
    }

    const nowSec = Date.now() / 1000
    let accessToken = creds.access_token || ""

    if (needsRefresh(creds, nowSec)) {
      const refreshed = refreshToken(ctx, creds)
      if (refreshed) {
        accessToken = refreshed
      } else if (!accessToken) {
        throw "Not logged in. Run `kimi login` to authenticate."
      }
    }

    let didRefresh = false
    let resp
    try {
      resp = ctx.util.retryOnceOnAuth({
        request: function (token) {
          return fetchUsage(ctx, token || accessToken)
        },
        refresh: function () {
          didRefresh = true
          const refreshed = refreshToken(ctx, creds)
          if (refreshed) accessToken = refreshed
          return refreshed
        },
      })
    } catch (e) {
      if (typeof e === "string") throw e
      if (didRefresh) {
        throw "Usage request failed after refresh. Try again."
      }
      throw "Usage request failed. Check your connection."
    }

    if (ctx.util.isAuthStatus(resp.status)) {
      throw "Token expired. Run `kimi login` to authenticate."
    }
    if (resp.status < 200 || resp.status >= 300) {
      throw "Usage request failed (HTTP " + String(resp.status) + "). Try again later."
    }

    const data = ctx.util.tryParseJson(resp.bodyText)
    if (!data || typeof data !== "object") {
      throw "Usage response invalid. Try again later."
    }

    const lines = []
    const candidates = collectLimitCandidates(ctx, data)
    const sessionCandidate = pickSessionCandidate(candidates)

    let weeklyCandidate = null
    const usageQuota = parseQuota(data.usage, ctx)
    if (usageQuota) {
      weeklyCandidate = { quota: usageQuota, periodMs: null }
    } else {
      const withoutSession = candidates.filter(function (candidate) {
        return candidate !== sessionCandidate
      })
      weeklyCandidate = pickLargestByPeriod(withoutSession)
    }

    if (sessionCandidate) {
      const sessionPercent = toPercentUsage(sessionCandidate.quota)
      if (sessionPercent) {
        lines.push(
          ctx.line.progress({
            label: "Session",
            used: sessionPercent.used,
            limit: sessionPercent.limit,
            format: { kind: "percent" },
            resetsAt: sessionPercent.resetsAt || undefined,
            periodDurationMs:
              typeof sessionCandidate.periodMs === "number"
                ? sessionCandidate.periodMs
                : undefined,
          })
        )
      }
    }

    if (weeklyCandidate && !sameQuota(weeklyCandidate, sessionCandidate)) {
      const weeklyPercent = toPercentUsage(weeklyCandidate.quota)
      if (weeklyPercent) {
        lines.push(
          ctx.line.progress({
            label: "Weekly",
            used: weeklyPercent.used,
            limit: weeklyPercent.limit,
            format: { kind: "percent" },
            resetsAt: weeklyPercent.resetsAt || undefined,
            periodDurationMs:
              typeof weeklyCandidate.periodMs === "number"
                ? weeklyCandidate.periodMs
                : undefined,
          })
        )
      }
    }

    const monthlyPercent =
      toPercentUsage(parseQuota(data.totalQuota, ctx)) || loadMonthlyOverride(ctx)
    if (monthlyPercent) {
      lines.push(
        ctx.line.progress({
          label: "Monthly",
          used: monthlyPercent.used,
          limit: monthlyPercent.limit,
          format: { kind: "percent" },
          resetsAt: monthlyPercent.resetsAt || undefined,
        })
      )
    }

    const boosterPercent = toPercentUsage(parseBoosterMonthlyCap(data))
    if (boosterPercent) {
      lines.push(
        ctx.line.progress({
          label: "Extra Usage",
          used: boosterPercent.used,
          limit: boosterPercent.limit,
          format: { kind: "percent" },
        })
      )
    }

    const boosterBalance = parseBoosterBalance(data)
    if (boosterBalance) {
      lines.push(
        ctx.line.text({
          label: "Balance",
          value: formatMoney(boosterBalance.cents, boosterBalance.currency),
        })
      )
    }

    if (lines.length === 0) {
      lines.push(ctx.line.badge({ label: "Status", text: "No usage data", color: "#a3a3a3" }))
    }

    return {
      plan: parsePlanLabel(data),
      lines,
    }
  }

  globalThis.__openusage_plugin = { id: "kimi", probe }
})()
