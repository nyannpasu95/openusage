(function () {
  const BALANCE_URL = "https://api.deepseek.com/user/balance"
  const SPENT_STATE_FILE = "spent-today.json"

  function loadApiKey(ctx) {
    let value = null
    try {
      value = ctx.host.env.get("DEEPSEEK_API_KEY")
    } catch (e) {
      ctx.host.log.warn("env read failed for DEEPSEEK_API_KEY: " + String(e))
    }
    if (typeof value === "string" && value.trim()) return value.trim()
    return null
  }

  function fetchBalance(ctx, apiKey) {
    let resp
    try {
      resp = ctx.util.request({
        method: "GET",
        url: BALANCE_URL,
        headers: {
          Authorization: "Bearer " + apiKey,
          Accept: "application/json",
        },
        timeoutMs: 10000,
      })
    } catch (e) {
      ctx.host.log.error("balance request exception: " + String(e))
      throw "Balance request failed. Check your connection."
    }

    if (ctx.util.isAuthStatus(resp.status)) {
      throw "API key invalid. Check your DeepSeek API key."
    }

    if (resp.status < 200 || resp.status >= 300) {
      throw "Balance request failed (HTTP " + String(resp.status) + "). Try again later."
    }

    const data = ctx.util.tryParseJson(resp.bodyText)
    if (!data) {
      throw "Balance response invalid. Try again later."
    }

    return data
  }

  function currencySymbol(currency) {
    if (currency === "CNY") return "¥"
    if (currency === "USD") return "$"
    return ""
  }

  function formatAmount(balance, currency) {
    const symbol = currencySymbol(currency)
    const suffix = currency ? " " + currency : ""
    return symbol + String(balance) + suffix
  }

  function hasNonZeroAmount(balance) {
    const amount = Number.parseFloat(String(balance))
    return Number.isFinite(amount) && amount !== 0
  }

  function balanceInfos(data) {
    const infos = data && data.balance_infos
    if (!Array.isArray(infos) || infos.length === 0) return null
    const validInfos = infos.filter((info) => info && typeof info === "object")
    return validInfos.length > 0 ? validInfos : null
  }

  function formatBalanceList(infos, fieldName) {
    const entries = infos.map((info) => {
      const currency = typeof info.currency === "string" ? info.currency : ""
      const balance = typeof info[fieldName] === "string" ? info[fieldName] : "0"
      return { balance, currency }
    })
    const nonZeroEntries = entries.filter((entry) => hasNonZeroAmount(entry.balance))
    const visibleEntries = nonZeroEntries.length > 0 ? nonZeroEntries : entries
    return visibleEntries
      .map((entry) => formatAmount(entry.balance, entry.currency))
      .join(" + ")
  }

  // --- Spent Today (approximate, via balance delta) ---
  // DeepSeek's API exposes only a point-in-time balance snapshot, no per-day
  // usage. We approximate "spent today" by remembering the first balance seen
  // for the local day and subtracting the current balance. See
  // docs/providers/deepseek.md for the limitations of this approach.

  function dayKeyFromDate(date) {
    const year = date.getFullYear()
    const month = date.getMonth() + 1
    const day = date.getDate()
    return year + "-" + (month < 10 ? "0" : "") + month + "-" + (day < 10 ? "0" : "") + day
  }

  function balanceByCurrency(infos, fieldName) {
    const out = {}
    for (const info of infos) {
      const currency = typeof info.currency === "string" ? info.currency : ""
      const raw = info[fieldName]
      const num = Number.parseFloat(String(raw))
      out[currency] = Number.isFinite(num) ? num : 0
    }
    return out
  }

  function spentStatePath(ctx) {
    return ctx.app.pluginDataDir + "/" + SPENT_STATE_FILE
  }

  function readSpentState(ctx) {
    const path = spentStatePath(ctx)
    try {
      if (!ctx.host.fs.exists(path)) return null
      const data = ctx.util.tryParseJson(ctx.host.fs.readText(path))
      if (!data || typeof data !== "object") return null
      return data
    } catch (e) {
      ctx.host.log.warn("spent-today state read failed: " + String(e))
      return null
    }
  }

  function writeSpentState(ctx, state) {
    try {
      ctx.host.fs.writeText(spentStatePath(ctx), JSON.stringify(state))
    } catch (e) {
      ctx.host.log.warn("spent-today state write failed: " + String(e))
    }
  }

  // Returns { pending: true } when no baseline exists yet for today, otherwise
  // { pending: false, value: "<formatted multi-currency spend>" }.
  function computeSpentToday(ctx, infos) {
    const todayKey = dayKeyFromDate(new Date())
    const totalNow = balanceByCurrency(infos, "total_balance")
    const toppedUpNow = balanceByCurrency(infos, "topped_up_balance")
    const state = readSpentState(ctx)

    const isToday = state && state.day === todayKey && state.baseline && state.lastToppedUp

    if (!isToday) {
      // First probe of the day (or first ever): record baseline, no spend yet.
      writeSpentState(ctx, {
        day: todayKey,
        baseline: totalNow,
        lastToppedUp: toppedUpNow,
      })
      return { pending: true }
    }

    // Compensate top-ups within the same day: a rising topped_up_balance means
    // the user added funds, which must not count as negative spend. Raise the
    // baseline by the same delta so spend stays accurate.
    const baseline = Object.assign({}, state.baseline)
    const lastToppedUp = Object.assign({}, state.lastToppedUp)
    for (const currency of Object.keys(toppedUpNow)) {
      const prev = Number(lastToppedUp[currency]) || 0
      const now = toppedUpNow[currency]
      if (now > prev) {
        baseline[currency] = (Number(baseline[currency]) || 0) + (now - prev)
        lastToppedUp[currency] = now
      }
    }

    const entries = infos
      .map((info) => {
        const currency = typeof info.currency === "string" ? info.currency : ""
        const base = Number(baseline[currency])
        const now = Number(totalNow[currency])
        if (!Number.isFinite(base) || !Number.isFinite(now)) return null
        let spent = base - now
        if (spent < 0) spent = 0 // clamp small noise / untracked movements
        return { spent: spent.toFixed(2), currency }
      })
      .filter((entry) => entry !== null)

    const nonZero = entries.filter((entry) => hasNonZeroAmount(entry.spent))
    const visible = nonZero.length > 0 ? nonZero : entries
    const value =
      visible.length > 0
        ? visible.map((entry) => formatAmount(entry.spent, entry.currency)).join(" + ")
        : "—"

    writeSpentState(ctx, {
      day: todayKey,
      baseline,
      lastToppedUp,
    })

    return { pending: false, value }
  }

  function probe(ctx) {
    const apiKey = loadApiKey(ctx)
    if (!apiKey) {
      throw "DeepSeek API key missing. Set DEEPSEEK_API_KEY."
    }

    const data = fetchBalance(ctx, apiKey)
    const infos = balanceInfos(data)
    if (!infos) {
      throw "Could not parse balance data."
    }

    const isAvailable = data.is_available === true

    const lines = []
    lines.push(
      ctx.line.badge({
        label: "Status",
        text: isAvailable ? "Available" : "Insufficient",
        color: isAvailable ? "#22c55e" : "#ef4444",
      })
    )
    lines.push(ctx.line.text({ label: "Balance", value: formatBalanceList(infos, "total_balance") }))
    lines.push(ctx.line.text({ label: "Granted", value: formatBalanceList(infos, "granted_balance") }))
    lines.push(ctx.line.text({ label: "Topped Up", value: formatBalanceList(infos, "topped_up_balance") }))

    const spent = computeSpentToday(ctx, infos)
    if (!spent.pending) {
      lines.push(ctx.line.text({ label: "Spent Today", value: spent.value }))
    }

    return { lines }
  }

  globalThis.__openusage_plugin = { id: "deepseek", probe }
})()
