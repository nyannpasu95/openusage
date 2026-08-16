import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const BALANCE_URL = "https://api.deepseek.com/user/balance"

const loadPlugin = async () => {
  await import("./plugin.js")
  return globalThis.__openusage_plugin
}

function setEnv(ctx, envValues) {
  ctx.host.env.get.mockImplementation((name) =>
    Object.prototype.hasOwnProperty.call(envValues, name) ? envValues[name] : null
  )
}

function balancePayload(overrides) {
  const base = {
    is_available: true,
    balance_infos: [
      {
        currency: "CNY",
        total_balance: "8.66",
        granted_balance: "0.00",
        topped_up_balance: "8.66",
      },
    ],
  }
  if (!overrides) return base
  const result = Object.assign({}, base)
  if (overrides.is_available !== undefined) {
    result.is_available = overrides.is_available
  }
  if (overrides.balance_infos) {
    result.balance_infos = overrides.balance_infos
  } else {
    result.balance_infos = [Object.assign({}, base.balance_infos[0], overrides)]
    // is_available belongs at top level, not inside the balance_info entry
    delete result.balance_infos[0].is_available
  }
  return result
}

function findLine(lines, label) {
  return lines.find((l) => l.label === label)
}

describe("deepseek plugin", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("registers with id matching manifest", async () => {
    const plugin = await loadPlugin()
    expect(plugin.id).toBe("deepseek")
    expect(typeof plugin.probe).toBe("function")
    expect(typeof plugin.checkCredentials).toBe("function")
  })

  it("throws when API key is missing", async () => {
    const ctx = makeCtx()
    setEnv(ctx, {})
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow(
      "DeepSeek API key missing. Set it in Settings → Credentials, or the DEEPSEEK_API_KEY env var."
    )
  })

  it("prefers the credential stored in keychain over env", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_API_KEY: "env-key" })
    ctx.host.keychain.readGenericPassword.mockReturnValue("  stored-key  ")
    ctx.host.http.request.mockReturnValue({
      status: 200,
      headers: {},
      bodyText: JSON.stringify(balancePayload()),
    })
    const plugin = await loadPlugin()
    plugin.probe(ctx)
    expect(ctx.host.keychain.readGenericPassword).toHaveBeenCalledWith("OpenUsage-deepseek-credential")
    const call = ctx.host.http.request.mock.calls[0][0]
    expect(call.headers.Authorization).toBe("Bearer stored-key")
  })

  it("falls back to env when keychain has no stored credential", async () => {
    const ctx = makeCtx()
    ctx.host.keychain.readGenericPassword.mockImplementation(() => {
      throw new Error("keychain item not found: could not be found")
    })
    setEnv(ctx, { DEEPSEEK_API_KEY: "env-key" })
    ctx.host.http.request.mockReturnValue({
      status: 200,
      headers: {},
      bodyText: JSON.stringify(balancePayload()),
    })
    const plugin = await loadPlugin()
    plugin.probe(ctx)
    const call = ctx.host.http.request.mock.calls[0][0]
    expect(call.headers.Authorization).toBe("Bearer env-key")
  })

  it("checkCredentials reports configured with source Settings", async () => {
    const ctx = makeCtx()
    ctx.host.keychain.readGenericPassword.mockReturnValue("stored-key")
    const plugin = await loadPlugin()
    expect(plugin.checkCredentials(ctx)).toEqual({ configured: true, source: "Settings" })
  })

  it("checkCredentials reports configured with source Env", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_API_KEY: "env-key" })
    const plugin = await loadPlugin()
    expect(plugin.checkCredentials(ctx)).toEqual({ configured: true, source: "Env" })
  })

  it("checkCredentials reports not configured when no source has a key", async () => {
    const ctx = makeCtx()
    setEnv(ctx, {})
    const plugin = await loadPlugin()
    expect(plugin.checkCredentials(ctx)).toEqual({ configured: false })
  })

  it("trims whitespace from API key before using it", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_API_KEY: "  ds-key  " })
    ctx.host.http.request.mockReturnValue({
      status: 200,
      headers: {},
      bodyText: JSON.stringify(balancePayload()),
    })
    const plugin = await loadPlugin()
    plugin.probe(ctx)
    const call = ctx.host.http.request.mock.calls[0][0]
    expect(call.headers.Authorization).toBe("Bearer ds-key")
  })

  it("sends Bearer auth and GET to the balance endpoint", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_API_KEY: "ds-key" })
    ctx.host.http.request.mockReturnValue({
      status: 200,
      headers: {},
      bodyText: JSON.stringify(balancePayload()),
    })
    const plugin = await loadPlugin()
    plugin.probe(ctx)
    const call = ctx.host.http.request.mock.calls[0][0]
    expect(call.method).toBe("GET")
    expect(call.url).toBe(BALANCE_URL)
    expect(call.headers.Authorization).toBe("Bearer ds-key")
    expect(call.headers.Accept).toBe("application/json")
  })

  it("formats CNY balance with yen symbol and currency suffix", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_API_KEY: "ds-key" })
    ctx.host.http.request.mockReturnValue({
      status: 200,
      headers: {},
      bodyText: JSON.stringify(balancePayload()),
    })
    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(findLine(result.lines, "Balance").value).toBe("¥8.66 CNY")
    expect(findLine(result.lines, "Granted").value).toBe("¥0.00 CNY")
    expect(findLine(result.lines, "Topped Up").value).toBe("¥8.66 CNY")
  })

  it("formats USD balance with dollar symbol", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_API_KEY: "ds-key" })
    ctx.host.http.request.mockReturnValue({
      status: 200,
      headers: {},
      bodyText: JSON.stringify(
        balancePayload({ currency: "USD", total_balance: "12.34", granted_balance: "1.00", topped_up_balance: "11.34" })
      ),
    })
    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(findLine(result.lines, "Balance").value).toBe("$12.34 USD")
  })

  it("shows Available badge when is_available is true", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_API_KEY: "ds-key" })
    ctx.host.http.request.mockReturnValue({
      status: 200,
      headers: {},
      bodyText: JSON.stringify(balancePayload({ is_available: true })),
    })
    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    const badge = findLine(result.lines, "Status")
    expect(badge.type).toBe("badge")
    expect(badge.text).toBe("Available")
    expect(badge.color).toBe("#22c55e")
  })

  it("shows Insufficient badge when is_available is false", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_API_KEY: "ds-key" })
    ctx.host.http.request.mockReturnValue({
      status: 200,
      headers: {},
      bodyText: JSON.stringify(balancePayload({ is_available: false })),
    })
    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    const badge = findLine(result.lines, "Status")
    expect(badge.text).toBe("Insufficient")
    expect(badge.color).toBe("#ef4444")
  })

  it("prefers non-zero CNY balance when USD is zero", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_API_KEY: "ds-key" })
    ctx.host.http.request.mockReturnValue({
      status: 200,
      headers: {},
      bodyText: JSON.stringify({
        is_available: true,
        balance_infos: [
          { currency: "USD", total_balance: "0.00", granted_balance: "0.00", topped_up_balance: "0.00" },
          { currency: "CNY", total_balance: "53.73", granted_balance: "0.00", topped_up_balance: "53.73" },
        ],
      }),
    })
    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(findLine(result.lines, "Balance").value).toBe("¥53.73 CNY")
    expect(findLine(result.lines, "Granted").value).toBe("$0.00 USD + ¥0.00 CNY")
    expect(findLine(result.lines, "Topped Up").value).toBe("¥53.73 CNY")
  })

  it("joins multiple non-zero currency balances", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_API_KEY: "ds-key" })
    ctx.host.http.request.mockReturnValue({
      status: 200,
      headers: {},
      bodyText: JSON.stringify({
        is_available: true,
        balance_infos: [
          { currency: "USD", total_balance: "5.00", granted_balance: "1.00", topped_up_balance: "4.00" },
          { currency: "CNY", total_balance: "9.99", granted_balance: "0.00", topped_up_balance: "9.99" },
        ],
      }),
    })
    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(findLine(result.lines, "Balance").value).toBe("$5.00 USD + ¥9.99 CNY")
    expect(findLine(result.lines, "Granted").value).toBe("$1.00 USD")
    expect(findLine(result.lines, "Topped Up").value).toBe("$4.00 USD + ¥9.99 CNY")
  })

  it("throws on HTTP 401", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_API_KEY: "ds-key" })
    ctx.host.http.request.mockReturnValue({ status: 401, headers: {}, bodyText: "" })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("API key invalid. Check your DeepSeek API key.")
  })

  it("throws on HTTP 403", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_API_KEY: "ds-key" })
    ctx.host.http.request.mockReturnValue({ status: 403, headers: {}, bodyText: "" })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("API key invalid. Check your DeepSeek API key.")
  })

  it("throws on other non-2xx HTTP status", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_API_KEY: "ds-key" })
    ctx.host.http.request.mockReturnValue({ status: 500, headers: {}, bodyText: "{}" })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Balance request failed (HTTP 500). Try again later.")
  })

  it("throws on network exception", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_API_KEY: "ds-key" })
    ctx.host.http.request.mockImplementation(() => {
      throw new Error("ECONNRESET")
    })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Balance request failed. Check your connection.")
  })

  it("throws on invalid JSON body", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_API_KEY: "ds-key" })
    ctx.host.http.request.mockReturnValue({ status: 200, headers: {}, bodyText: "not-json" })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Balance response invalid. Try again later.")
  })

  it("throws when balance_infos is empty", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_API_KEY: "ds-key" })
    ctx.host.http.request.mockReturnValue({
      status: 200,
      headers: {},
      bodyText: JSON.stringify({ is_available: true, balance_infos: [] }),
    })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Could not parse balance data.")
  })

  it("continues when env getter throws and surfaces missing-key error", async () => {
    const ctx = makeCtx()
    ctx.host.env.get.mockImplementation(() => {
      throw new Error("env unavailable")
    })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow(
      "DeepSeek API key missing. Set it in Settings → Credentials, or the DEEPSEEK_API_KEY env var."
    )
  })

  describe("Spent Today", () => {
    const TODAY = new Date(2026, 1, 2, 10, 0, 0) // local 2026-02-02

    function mockBalance(ctx, infos, isAvailable = true) {
      ctx.host.http.request.mockReturnValue({
        status: 200,
        headers: {},
        bodyText: JSON.stringify({ is_available: isAvailable, balance_infos: infos }),
      })
    }

    function cny(total, granted = "0.00", toppedUp = total) {
      return { currency: "CNY", total_balance: String(total), granted_balance: String(granted), topped_up_balance: String(toppedUp) }
    }

    function usd(total, granted = "0.00", toppedUp = total) {
      return { currency: "USD", total_balance: String(total), granted_balance: String(granted), topped_up_balance: String(toppedUp) }
    }

    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(TODAY)
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it("omits Spent Today line on the first probe of the day and records baseline", async () => {
      const ctx = makeCtx()
      setEnv(ctx, { DEEPSEEK_API_KEY: "ds-key" })
      mockBalance(ctx, [cny("8.66")])
      const plugin = await loadPlugin()
      const result = plugin.probe(ctx)
      expect(findLine(result.lines, "Spent Today")).toBeUndefined()
      // baseline written for today
      const state = JSON.parse(ctx.host.fs.readText(ctx.app.pluginDataDir + "/spent-today.json"))
      expect(state.day).toBe("2026-02-02")
      expect(state.baseline.CNY).toBeCloseTo(8.66)
    })

    it("shows the balance delta on a later same-day probe", async () => {
      const ctx = makeCtx()
      setEnv(ctx, { DEEPSEEK_API_KEY: "ds-key" })
      const plugin = await loadPlugin()
      // first probe records baseline
      mockBalance(ctx, [cny("8.66")])
      plugin.probe(ctx)
      // second probe: balance dropped by 1.20
      mockBalance(ctx, [cny("7.46")])
      const result = plugin.probe(ctx)
      expect(findLine(result.lines, "Spent Today").value).toBe("¥1.20 CNY")
    })

    it("joins multiple currencies in the spend line", async () => {
      const ctx = makeCtx()
      setEnv(ctx, { DEEPSEEK_API_KEY: "ds-key" })
      const plugin = await loadPlugin()
      mockBalance(ctx, [usd("5.00"), cny("9.99")])
      plugin.probe(ctx)
      mockBalance(ctx, [usd("4.50"), cny("8.79")])
      const result = plugin.probe(ctx)
      expect(findLine(result.lines, "Spent Today").value).toBe("$0.50 USD + ¥1.20 CNY")
    })

    it("shows ¥0.00 when balance has not moved", async () => {
      const ctx = makeCtx()
      setEnv(ctx, { DEEPSEEK_API_KEY: "ds-key" })
      const plugin = await loadPlugin()
      mockBalance(ctx, [cny("8.66")])
      plugin.probe(ctx)
      mockBalance(ctx, [cny("8.66")])
      const result = plugin.probe(ctx)
      expect(findLine(result.lines, "Spent Today").value).toBe("¥0.00 CNY")
    })

    it("resets across days: second day's first probe has no Spent Today line", async () => {
      const ctx = makeCtx()
      setEnv(ctx, { DEEPSEEK_API_KEY: "ds-key" })
      const plugin = await loadPlugin()
      mockBalance(ctx, [cny("8.66")])
      plugin.probe(ctx)
      vi.setSystemTime(new Date(2026, 1, 3, 10, 0, 0)) // next day
      mockBalance(ctx, [cny("5.00")])
      const result = plugin.probe(ctx)
      expect(findLine(result.lines, "Spent Today")).toBeUndefined()
      const state = JSON.parse(ctx.host.fs.readText(ctx.app.pluginDataDir + "/spent-today.json"))
      expect(state.day).toBe("2026-02-03")
    })

    it("compensates a same-day top-up so it is not counted as negative spend", async () => {
      const ctx = makeCtx()
      setEnv(ctx, { DEEPSEEK_API_KEY: "ds-key" })
      const plugin = await loadPlugin()
      mockBalance(ctx, [cny("8.66", "0.00", "8.66")])
      plugin.probe(ctx)
      // user tops up 10.00 (topped_up 8.66 -> 18.66) and spends 1.00 of it
      // in the same window: total_balance is 17.66, not 18.66.
      mockBalance(ctx, [cny("17.66", "0.00", "18.66")])
      const result = plugin.probe(ctx)
      expect(findLine(result.lines, "Spent Today").value).toBe("¥1.00 CNY")
    })

    it("accumulates spend across multiple same-day probes after a top-up", async () => {
      const ctx = makeCtx()
      setEnv(ctx, { DEEPSEEK_API_KEY: "ds-key" })
      const plugin = await loadPlugin()
      mockBalance(ctx, [cny("8.66", "0.00", "8.66")])
      plugin.probe(ctx)
      mockBalance(ctx, [cny("17.66", "0.00", "18.66")])
      plugin.probe(ctx)
      // spend another 1.00
      mockBalance(ctx, [cny("16.66", "0.00", "18.66")])
      const result = plugin.probe(ctx)
      expect(findLine(result.lines, "Spent Today").value).toBe("¥2.00 CNY")
    })

    it("detects a top-up after the topped-up balance previously decreased", async () => {
      const ctx = makeCtx()
      setEnv(ctx, { DEEPSEEK_API_KEY: "ds-key" })
      const plugin = await loadPlugin()
      mockBalance(ctx, [cny("100.00", "0.00", "100.00")])
      plugin.probe(ctx)

      // Spending lowers both total and topped-up balances.
      mockBalance(ctx, [cny("90.00", "0.00", "90.00")])
      plugin.probe(ctx)

      // A later 5.00 top-up should preserve the already observed 10.00 spend.
      mockBalance(ctx, [cny("95.00", "0.00", "95.00")])
      const result = plugin.probe(ctx)
      expect(findLine(result.lines, "Spent Today").value).toBe("¥10.00 CNY")
    })

    it("clamps small upward noise to zero instead of showing negative", async () => {
      const ctx = makeCtx()
      setEnv(ctx, { DEEPSEEK_API_KEY: "ds-key" })
      const plugin = await loadPlugin()
      mockBalance(ctx, [cny("8.66", "0.00", "8.66")])
      plugin.probe(ctx)
      // balance drifts up slightly without a top-up (e.g. granted expiry edge)
      mockBalance(ctx, [cny("8.70", "0.00", "8.66")])
      const result = plugin.probe(ctx)
      expect(findLine(result.lines, "Spent Today").value).toBe("¥0.00 CNY")
    })

    it("omits a currency that appeared after the baseline was recorded", async () => {
      const ctx = makeCtx()
      setEnv(ctx, { DEEPSEEK_API_KEY: "ds-key" })
      const plugin = await loadPlugin()
      mockBalance(ctx, [cny("8.66")])
      plugin.probe(ctx)
      // USD appears for the first time on the second probe — no baseline exists for it
      mockBalance(ctx, [cny("7.46"), usd("5.00")])
      const result = plugin.probe(ctx)
      expect(findLine(result.lines, "Spent Today").value).toBe("¥1.20 CNY")
    })

    it("handles a currency disappearing between probes", async () => {
      const ctx = makeCtx()
      setEnv(ctx, { DEEPSEEK_API_KEY: "ds-key" })
      const plugin = await loadPlugin()
      mockBalance(ctx, [usd("5.00"), cny("9.99")])
      plugin.probe(ctx)
      // USD entry vanishes on the second probe
      mockBalance(ctx, [cny("8.79")])
      const result = plugin.probe(ctx)
      expect(findLine(result.lines, "Spent Today").value).toBe("¥1.20 CNY")
    })

    it("recovers gracefully from a corrupt state file", async () => {
      const ctx = makeCtx()
      setEnv(ctx, { DEEPSEEK_API_KEY: "ds-key" })
      const plugin = await loadPlugin()
      ctx.host.fs.writeText(ctx.app.pluginDataDir + "/spent-today.json", "not-json")
      mockBalance(ctx, [cny("8.66")])
      const result = plugin.probe(ctx)
      expect(findLine(result.lines, "Spent Today")).toBeUndefined()
      // baseline rebuilt
      const state = JSON.parse(ctx.host.fs.readText(ctx.app.pluginDataDir + "/spent-today.json"))
      expect(state.day).toBe("2026-02-02")
    })

    it("still returns the four balance lines when state write fails", async () => {
      const ctx = makeCtx()
      setEnv(ctx, { DEEPSEEK_API_KEY: "ds-key" })
      ctx.host.fs.writeText = vi.fn(() => {
        throw new Error("disk full")
      })
      mockBalance(ctx, [cny("8.66")])
      const plugin = await loadPlugin()
      const result = plugin.probe(ctx)
      expect(findLine(result.lines, "Balance")).toBeDefined()
      expect(findLine(result.lines, "Granted")).toBeDefined()
      expect(findLine(result.lines, "Topped Up")).toBeDefined()
      expect(findLine(result.lines, "Spent Today")).toBeUndefined()
    })
  })
})
