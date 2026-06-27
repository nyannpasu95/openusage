(function () {
  const BALANCE_URL = "https://api.deepseek.com/user/balance"

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

    return { lines }
  }

  globalThis.__openusage_plugin = { id: "deepseek", probe }
})()
