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
  })

  it("throws when API key is missing", async () => {
    const ctx = makeCtx()
    setEnv(ctx, {})
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow(
      "DeepSeek API key missing. Set DEEPSEEK_API_KEY."
    )
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
      "DeepSeek API key missing. Set DEEPSEEK_API_KEY."
    )
  })
})
