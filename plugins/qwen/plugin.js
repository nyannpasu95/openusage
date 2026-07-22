(function () {
  const HOME_BASE = "https://platform-home.qianwenai.com"
  const USER_INFO_URL = HOME_BASE + "/tool/user/info.json"
  const CS_DATA_API_URL = "https://cs-data.qianwenai.com/data/api.json"
  const HOME_API_URL = HOME_BASE + "/data/api.json"
  const CONSOLE_ORIGIN = "https://platform.qianwenai.com"
  const CONSOLE_PAGE = CONSOLE_ORIGIN + "/home/billing/subscription/token-plan-individual"
  const USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
  const COOKIE_ENV_VAR = "QWEN_COOKIE"
  const ENVELOPE_PRODUCT = "sfm_bailian"
  const ENVELOPE_ACTION = "BroadScopeAspnGateway"
  const SOLO_COMMODITY_CODE = "sfm_tokenplansolo_public_cn"
  const API_SUBSCRIPTION = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription"
  const API_USAGE = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage"
  const API_QUOTA_CONFIG = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/quota-config"
  const CORNERSTONE_PARAM = {
    domain: "platform.qianwenai.com",
    consoleSite: "QIANWENAI",
    console: "ONE_CONSOLE",
    xsp_lang: "zh-CN",
    protocol: "V2",
    productCode: "p_efm",
  }
  const FR_COMMODITY_CODES = [
    { key: "teams", code: "sfm_tokenplanteams_dp_cn", pageSize: "10" },
    { key: "solo", code: SOLO_COMMODITY_CODE, pageSize: "10" },
    { key: "personal", code: "sfm_tokenplanpersonal_dp_cn", pageSize: "10" },
    { key: "addon", code: "sfm_tokenplanteamsaddon_dp_cn", pageSize: "100" },
  ]
  const SPEC_LABELS = { lite: "Lite", standard: "Standard", pro: "Pro" }

  function loginError() {
    return (
      "Qianwen console session expired. Copy a fresh Cookie header from " +
      "platform.qianwenai.com, then run: pbpaste > " +
      COOKIE_FILE +
      "."
    )
  }

  function readString(value) {
    if (typeof value !== "string") return null
    const trimmed = value.trim()
    return trimmed ? trimmed : null
  }

  function readNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null
    if (typeof value !== "string") return null
    const cleaned = value.replace(/,/g, "").trim()
    if (!cleaned) return null
    const n = Number(cleaned)
    return Number.isFinite(n) ? n : null
  }

  function readRatio(value) {
    const n = readNumber(value)
    if (n === null) return null
    if (n < 0) return 0
    if (n > 1) return 1
    return n
  }

  function formatCount(n) {
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  }

  // The console renders naive datetimes as local (China) time; epoch values
  // are absolute and need no such treatment.
  function parseResetTime(ctx, value) {
    if (typeof value === "string") {
      const m = value.trim().match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?$/)
      if (m) {
        return ctx.util.toIso(m[1] + "T" + m[2] + (m[3] || ":00") + "+08:00")
      }
    }
    return ctx.util.toIso(value)
  }

  const COOKIE_FILE = "~/.openusage/qwen-cookie.txt"

  function loadCookie(ctx) {
    let value = null
    try {
      value = ctx.host.env.get(COOKIE_ENV_VAR)
    } catch (e) {
      ctx.host.log.warn("env read failed for " + COOKIE_ENV_VAR + ": " + String(e))
    }
    const fromEnv = readString(value)
    if (fromEnv) return fromEnv

    try {
      if (ctx.host.fs.exists(COOKIE_FILE)) {
        return readString(ctx.host.fs.readText(COOKIE_FILE))
      }
    } catch (e) {
      ctx.host.log.warn("cookie file read failed (" + COOKIE_FILE + "): " + String(e))
    }
    return null
  }

  function isLoginProblem(code, message) {
    const combined = (String(code || "") + " " + String(message || "")).toLowerCase()
    return (
      combined.indexOf("needlogin") !== -1 ||
      combined.indexOf("login") !== -1 ||
      combined.indexOf("unauthor") !== -1 ||
      combined.indexOf("登录") !== -1 ||
      combined.indexOf("登陆") !== -1
    )
  }

  function checkStatus(ctx, resp) {
    if (ctx.util.isAuthStatus(resp.status)) {
      throw loginError()
    }
    // A 3xx here is either a stale-session login redirect or the anti-bot
    // gateway rejecting the request; both surface as a session problem.
    if (resp.status >= 300 && resp.status < 400) {
      throw loginError()
    }
    if (resp.status < 200 || resp.status >= 300) {
      throw "Token Plan request failed (HTTP " + String(resp.status) + "). Try again later."
    }
  }

  function parseConsoleJson(ctx, resp) {
    const payload = ctx.util.tryParseJson(resp.bodyText)
    if (!payload || typeof payload !== "object") {
      const body = typeof resp.bodyText === "string" ? resp.bodyText.toLowerCase() : ""
      if (body.indexOf("<html") !== -1 && body.indexOf("login") !== -1) {
        throw loginError()
      }
      throw "Token Plan response invalid. Try again later."
    }
    return payload
  }

  function throwIfConsoleError(payload) {
    if (payload.successResponse === false || payload.successResponse === "false") {
      const code = readString(payload.code)
      const message = readString(payload.message)
      if (isLoginProblem(code, message)) {
        throw loginError()
      }
      throw message
        ? "Token Plan API error: " + message
        : "Token Plan API error (code " + String(code) + ")."
    }
  }

  function postForm(ctx, url, cookie, form, fullBrowserHeaders) {
    const headers = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json, text/plain, */*",
      Cookie: cookie,
      "User-Agent": USER_AGENT,
      Origin: CONSOLE_ORIGIN,
      Referer: CONSOLE_PAGE,
    }
    if (fullBrowserHeaders) {
      // cs-data sits behind an anti-bot gateway that rejects requests lacking
      // the standard Chromium header set (observed: 302 to err.taobao.com).
      headers["Accept-Language"] = "zh-CN,zh;q=0.9,en;q=0.8"
      headers["sec-ch-ua"] = '"Not;A=Brand";v="8", "Chromium";v="150"'
      headers["sec-ch-ua-mobile"] = "?0"
      headers["sec-ch-ua-platform"] = '"macOS"'
      headers["Sec-Fetch-Dest"] = "empty"
      headers["Sec-Fetch-Mode"] = "cors"
      headers["Sec-Fetch-Site"] = "same-site"
    }
    let resp
    try {
      resp = ctx.util.request({
        method: "POST",
        url: url,
        headers: headers,
        bodyText: form,
        timeoutMs: 15000,
      })
    } catch (e) {
      ctx.host.log.error("console gateway exception: " + String(e))
      throw "Token Plan request failed. Check your connection."
    }
    checkStatus(ctx, resp)
    const payload = parseConsoleJson(ctx, resp)
    throwIfConsoleError(payload)
    return payload
  }

  // Validates the session and resolves sec_token (console falls back to "0").
  function fetchSecToken(ctx, cookie) {
    let resp
    try {
      resp = ctx.util.request({
        method: "GET",
        url: USER_INFO_URL,
        headers: {
          Accept: "application/json, text/plain, */*",
          Cookie: cookie,
          "User-Agent": USER_AGENT,
          Referer: CONSOLE_ORIGIN + "/",
        },
        timeoutMs: 15000,
      })
    } catch (e) {
      ctx.host.log.error("user info request exception: " + String(e))
      throw "Token Plan request failed. Check your connection."
    }
    checkStatus(ctx, resp)
    const payload = parseConsoleJson(ctx, resp)
    throwIfConsoleError(payload)
    const data = payload.data
    if (data && typeof data === "object") {
      const token = readString(data.secToken) || readString(data.sec_token)
      if (token) return token
    }
    return "0"
  }

  // Personal endpoints on cs-data: response payload lives at
  // data.DataV2.data.data, with data.DataV2.ret[0] = "SUCCESS::...".
  function fetchPersonal(ctx, cookie, secToken, api, dataFields) {
    const dataObj = {}
    const keys = Object.keys(dataFields || {})
    for (let i = 0; i < keys.length; i += 1) {
      dataObj[keys[i]] = dataFields[keys[i]]
    }
    dataObj.cornerstoneParam = CORNERSTONE_PARAM

    const form =
      "product=" +
      encodeURIComponent(ENVELOPE_PRODUCT) +
      "&action=" +
      encodeURIComponent(ENVELOPE_ACTION) +
      "&sec_token=" +
      encodeURIComponent(secToken) +
      "&region=" +
      encodeURIComponent("cn-beijing") +
      "&params=" +
      encodeURIComponent(
        JSON.stringify({ Api: api, Data: dataObj, V: "1.0" })
      )

    const payload = postForm(
      ctx,
      CS_DATA_API_URL +
        "?product=" +
        encodeURIComponent(ENVELOPE_PRODUCT) +
        "&action=" +
        encodeURIComponent(ENVELOPE_ACTION) +
        "&api=" +
        encodeURIComponent(api),
      cookie,
      form,
      true
    )

    const data = payload.data
    const dataV2 = data && typeof data === "object" ? data.DataV2 : null
    if (!dataV2 || typeof dataV2 !== "object") {
      throw "Token Plan response invalid. Try again later."
    }
    const ret = Array.isArray(dataV2.ret) ? String(dataV2.ret[0] || "") : ""
    const sep = ret.indexOf("::")
    const retCode = sep >= 0 ? ret.slice(0, sep) : ret
    const retMessage = sep >= 0 ? ret.slice(sep + 2) : ""
    if (retCode !== "SUCCESS") {
      if (isLoginProblem(retCode, retMessage)) {
        throw loginError()
      }
      throw "Token Plan API error: " + (retMessage || retCode || "unknown")
    }
    const inner = dataV2.data && typeof dataV2.data === "object" ? dataV2.data : null
    if (!inner) {
      throw "Token Plan response invalid. Try again later."
    }
    if (inner.success === false) {
      const message =
        readString(inner.errorMsg) || readString(inner.msg) || readString(inner.message)
      const code = readString(inner.errorCode) || readString(inner.code)
      if (isLoginProblem(code, message)) {
        throw loginError()
      }
      throw "Token Plan API error: " + (message || code || "unknown")
    }
    return inner.data === undefined ? null : inner.data
  }

  // Teams endpoints on platform-home: response payload at data.Data.
  function fetchFrInstances(ctx, cookie, secToken, commodityCode, pageSize) {
    const form =
      "product=" +
      encodeURIComponent("BssOpenAPI-V3") +
      "&action=" +
      encodeURIComponent("DescribeFrInstances") +
      "&sec_token=" +
      encodeURIComponent(secToken) +
      "&region=" +
      encodeURIComponent("cn-hangzhou") +
      "&language=" +
      encodeURIComponent("zh-CN") +
      "&params=" +
      encodeURIComponent(
        JSON.stringify({
          Group: "tokenPlan",
          CommodityCode: commodityCode,
          PageNum: "1",
          PageSize: pageSize,
        })
      )

    const payload = postForm(
      ctx,
      HOME_API_URL +
        "?product=" +
        encodeURIComponent("BssOpenAPI-V3") +
        "&action=" +
        encodeURIComponent("DescribeFrInstances"),
      cookie,
      form,
      false
    )
    const data = payload.data
    if (!data || typeof data !== "object" || !Array.isArray(data.Data)) {
      return []
    }
    return data.Data
  }

  function statusCodeOf(instance) {
    const status = instance && instance.Status
    if (status && typeof status === "object") return readString(status.Code)
    return readString(status)
  }

  function isValid(instance) {
    const code = statusCodeOf(instance)
    return code !== null && code.toLowerCase() === "valid"
  }

  function windowLine(ctx, label, usedRatio, total, resetRaw) {
    const resetsAt = parseResetTime(ctx, resetRaw)
    const opts = { label: label }
    if (total !== null && total > 0) {
      opts.used = Math.round(total * usedRatio)
      opts.limit = Math.round(total)
      opts.format = { kind: "count", suffix: "credits" }
    } else {
      opts.used = Math.round(usedRatio * 1000) / 10
      opts.limit = 100
      opts.format = { kind: "percent" }
    }
    if (resetsAt) opts.resetsAt = resetsAt
    return ctx.line.progress(opts)
  }

  function probeIndividual(ctx, cookie, secToken) {
    let subscription
    try {
      subscription = fetchPersonal(ctx, cookie, secToken, API_SUBSCRIPTION, {
        commodityCode: SOLO_COMMODITY_CODE,
      })
    } catch (e) {
      ctx.host.log.warn("personal subscription query failed: " + String(e))
      return { error: e }
    }
    if (!subscription || typeof subscription !== "object" || !readString(subscription.instanceCode)) {
      return null
    }

    const usage = fetchPersonal(ctx, cookie, secToken, API_USAGE, {})
    if (!usage || typeof usage !== "object") {
      throw "Could not parse Token Plan usage data."
    }
    let quotaConfig = null
    try {
      quotaConfig = fetchPersonal(ctx, cookie, secToken, API_QUOTA_CONFIG, {})
    } catch (e) {
      ctx.host.log.warn("personal quota-config query failed: " + String(e))
    }

    const specCode = readString(subscription.specCode)
    const quota =
      specCode && quotaConfig && typeof quotaConfig === "object" ? quotaConfig[specCode] : null
    const fiveHourTotal = quota && typeof quota === "object" ? readNumber(quota.five_hour) : null
    const weeklyTotal = quota && typeof quota === "object" ? readNumber(quota.weekly) : null

    const fiveHourRatio = readRatio(usage.per5HourPercentage)
    const weeklyRatio = readRatio(usage.per1WeekPercentage)
    if (fiveHourRatio === null && weeklyRatio === null) {
      throw "Could not parse Token Plan usage data."
    }

    const lines = []
    if (fiveHourRatio !== null) {
      lines.push(windowLine(ctx, "Session", fiveHourRatio, fiveHourTotal, usage.per5HourResetTime))
    }
    if (weeklyRatio !== null) {
      lines.push(windowLine(ctx, "Weekly", weeklyRatio, weeklyTotal, usage.per1WeekResetTime))
    }

    const expiresAt = parseResetTime(ctx, subscription.endTime)
    if (expiresAt) {
      const expireMs = ctx.util.parseDateMs(expiresAt)
      if (expireMs !== null) {
        lines.push(ctx.line.text({ label: "Expires", value: ctx.fmt.date(expireMs) }))
      }
    }

    const planLabel =
      (specCode && SPEC_LABELS[specCode]) ||
      (specCode ? ctx.fmt.planLabel(specCode) : "Individual")
    return { lines: lines, plan: planLabel }
  }

  function probeTeams(ctx, cookie, secToken) {
    const results = {}
    let lastError = null
    let planError = null
    for (let i = 0; i < FR_COMMODITY_CODES.length; i += 1) {
      const entry = FR_COMMODITY_CODES[i]
      try {
        results[entry.key] = fetchFrInstances(ctx, cookie, secToken, entry.code, entry.pageSize)
      } catch (e) {
        lastError = e
        if (entry.key !== "addon") planError = e
        ctx.host.log.warn("DescribeFrInstances failed for " + entry.code + ": " + String(e))
      }
    }
    if (!results.teams && !results.solo && !results.personal && !results.addon) {
      return { error: lastError || "Token Plan request failed. Try again later." }
    }

    const planInstances = (results.teams || [])
      .concat(results.solo || [])
      .concat(results.personal || [])
    let chosen = null
    for (let i = 0; i < planInstances.length; i += 1) {
      if (isValid(planInstances[i])) {
        chosen = planInstances[i]
        break
      }
    }

    let addonRemaining = 0
    const addons = results.addon || []
    for (let i = 0; i < addons.length; i += 1) {
      if (isValid(addons[i])) {
        addonRemaining += readNumber(addons[i].CurrCapacityBaseValue) || 0
      }
    }

    if (!chosen) {
      if (planError) return { error: planError }
      if (addonRemaining > 0) {
        return {
          lines: [
            ctx.line.text({ label: "Add-on", value: formatCount(addonRemaining) + " credits" }),
          ],
          plan: "Token Plan",
        }
      }
      return null
    }

    const total = readNumber(chosen.InitCapacityBaseValue)
    if (total === null || total <= 0) {
      throw "Could not parse Token Plan data."
    }
    let remaining
    if (chosen.CapacityTypeCode === "periodMonthlyShift") {
      remaining = readNumber(chosen.periodCapacityBaseValue)
      if (remaining === null) remaining = readNumber(chosen.CurrCapacityBaseValue)
    } else {
      remaining = readNumber(chosen.CurrCapacityBaseValue)
    }
    if (remaining === null) {
      throw "Could not parse Token Plan data."
    }

    let used = total - remaining
    if (used < 0) used = 0
    if (used > total) used = total

    const resetsAt = chosen.EndTime ? ctx.util.toIso(Number(chosen.EndTime)) : null
    const planName = readString(chosen.TemplateName) || readString(chosen.CommodityName)

    const progress = {
      label: "Credits",
      used: Math.round(used),
      limit: Math.round(total),
      format: { kind: "count", suffix: "credits" },
    }
    if (resetsAt) progress.resetsAt = resetsAt

    const lines = [
      ctx.line.progress(progress),
      ctx.line.text({ label: "Remaining", value: formatCount(remaining) + " credits" }),
    ]
    if (addonRemaining > 0) {
      lines.push(ctx.line.text({ label: "Add-on", value: formatCount(addonRemaining) + " credits" }))
    }
    if (resetsAt) {
      const resetMs = ctx.util.parseDateMs(resetsAt)
      if (resetMs !== null) {
        lines.push(ctx.line.text({ label: "Expires", value: ctx.fmt.date(resetMs) }))
      }
    }

    const result = { lines: lines }
    if (planName) result.plan = planName
    return result
  }

  function probe(ctx) {
    const cookie = loadCookie(ctx)
    if (!cookie) {
      throw (
        "Qianwen console cookie missing. Copy the Cookie header from " +
        "platform.qianwenai.com, then run: pbpaste > " +
        COOKIE_FILE +
        " (or set " +
        COOKIE_ENV_VAR +
        ")."
      )
    }

    const secToken = fetchSecToken(ctx, cookie)

    // Individual (个人版) plan first: it lives on the personal cs-data APIs.
    const individual = probeIndividual(ctx, cookie, secToken)
    if (individual && individual.lines) return individual

    // Teams / legacy plans: DescribeFrInstances on the platform-home gateway.
    const teams = probeTeams(ctx, cookie, secToken)
    if (teams && teams.lines) return teams

    const individualError = individual && individual.error
    const teamsError = teams && teams.error
    if (teamsError) throw teamsError
    if (individualError) throw individualError
    throw "No active Token Plan subscription found for this account."
  }

  globalThis.__openusage_plugin = { id: "qwen", probe }
})()
