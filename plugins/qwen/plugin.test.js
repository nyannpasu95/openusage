import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const COOKIE = "cna=abc; login_qianwenai_ticket=ticket-1; other=1"

const SUBSCRIPTION = {
  instanceCode: "sfm_tokenplansolo_public_cn-zh74vndib0g",
  specCode: "standard",
  remainingDays: 29,
  startTime: 1784530628000,
  endTime: 1787241600000, // 2026-08-21T00:00:00.000Z
  autoRenewFlag: false,
  status: "VALID",
}

const USAGE = {
  per5HourPercentage: 0.037,
  per5HourResetTime: 1785149940000, // 2026-07-27T11:59:00.000Z
  per1WeekPercentage: 0.04973174724,
  per1WeekResetTime: 1785149940000,
}

const QUOTA_CONFIG = {
  lite: { five_hour: 700, weekly: 2500 },
  standard: { five_hour: 3000, weekly: 10000 },
  pro: { five_hour: 12000, weekly: 40000 },
}

// cs-data envelope: payload at data.DataV2.data.data.
const personalEnvelope = (data) => ({
  status: 200,
  headers: {},
  bodyText: JSON.stringify({
    code: "200",
    successResponse: true,
    data: {
      DataV2: {
        ret: ["SUCCESS::接口调用成功"],
        data: { msg: "Success.", code: "SUCCESS", data, requestId: "req-1", success: true },
      },
      success: true,
      httpStatus: 200,
      errorCode: "",
      errorMsg: "",
    },
  }),
})

const frEnvelope = (instances) => ({
  status: 200,
  headers: {},
  bodyText: JSON.stringify({
    code: "200",
    successResponse: true,
    data: { TotalCount: instances.length, Data: instances },
  }),
})

const userInfoOk = {
  status: 200,
  headers: {},
  bodyText: JSON.stringify({ successResponse: true, data: { secToken: "sec-123" } }),
}

const makeFrInstance = (overrides = {}) => ({
  InstanceId: "inst-1",
  CommodityCode: "sfm_tokenplanteams_dp_cn",
  CommodityName: "Token Plan Teams",
  Status: { Code: "valid" },
  InitCapacityBaseValue: "25000",
  CurrCapacityBaseValue: "12345",
  EndTime: 1787529600000,
  ...overrides,
})

const loadPlugin = async () => {
  await import("./plugin.js")
  return globalThis.__openusage_plugin
}

// Routing table. Keys: "userInfo" | "subscription" | "usage" | "quotaConfig" |
// "fr:<commodityCode>". Missing keys default to: personal → empty data;
// fr → empty list.
const ctxWithRoutes = (routes = {}, cookie = COOKIE) => {
  const ctx = makeCtx()
  ctx.host.env.get.mockImplementation((name) => (name === "QWEN_COOKIE" ? cookie : null))
  const respond = (r, fallback) => {
    if (typeof r === "function") return r()
    return r === undefined ? fallback : r
  }
  ctx.host.http.request.mockImplementation((opts) => {
    if (opts.url.startsWith("https://platform-home.qianwenai.com/tool/user/info.json")) {
      return respond(routes.userInfo, userInfoOk)
    }
    if (opts.url.startsWith("https://cs-data.qianwenai.com/data/api.json")) {
      const api = new URLSearchParams(opts.url.split("?")[1]).get("api")
      if (api.endsWith("/subscription")) return respond(routes.subscription, personalEnvelope({}))
      if (api.endsWith("/usage")) return respond(routes.usage, personalEnvelope({}))
      if (api.endsWith("/quota-config")) return respond(routes.quotaConfig, personalEnvelope({}))
      throw new Error("unexpected api " + api)
    }
    if (opts.url.startsWith("https://platform-home.qianwenai.com/data/api.json")) {
      const params = JSON.parse(new URLSearchParams(opts.bodyText).get("params"))
      return respond(routes["fr:" + params.CommodityCode], frEnvelope([]))
    }
    throw new Error("unexpected url " + opts.url)
  })
  return ctx
}

const ctxIndividual = (overrides = {}) =>
  ctxWithRoutes({
    subscription: personalEnvelope(SUBSCRIPTION),
    usage: personalEnvelope(USAGE),
    quotaConfig: personalEnvelope(QUOTA_CONFIG),
    ...overrides,
  })

beforeEach(() => {
  delete globalThis.__openusage_plugin
  vi.resetModules()
})

describe("qwen plugin", () => {
  it("registers with id qwen", async () => {
    const plugin = await loadPlugin()
    expect(plugin.id).toBe("qwen")
    expect(typeof plugin.probe).toBe("function")
  })

  it("throws when the cookie is missing", async () => {
    const ctx = ctxWithRoutes({}, null)
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Qianwen console cookie missing")
  })

  it("reads the cookie from the cookie file when env is missing", async () => {
    const ctx = ctxIndividual()
    ctx.host.env.get.mockImplementation(() => null)
    ctx.host.fs.writeText("~/.openusage/qwen-cookie.txt", "file-cookie=xyz\n")
    const plugin = await loadPlugin()
    plugin.probe(ctx)

    const call = ctx.host.http.request.mock.calls[0][0]
    expect(call.headers.Cookie).toBe("file-cookie=xyz")
  })

  it("prefers the env cookie over the cookie file", async () => {
    const ctx = ctxIndividual()
    ctx.host.fs.writeText("~/.openusage/qwen-cookie.txt", "file-cookie=xyz")
    const plugin = await loadPlugin()
    plugin.probe(ctx)

    const call = ctx.host.http.request.mock.calls[0][0]
    expect(call.headers.Cookie).toBe(COOKIE)
  })

  it("validates the session via user info and sends the cookie everywhere", async () => {
    const ctx = ctxIndividual()
    const plugin = await loadPlugin()
    plugin.probe(ctx)

    const calls = ctx.host.http.request.mock.calls.map((c) => c[0])
    expect(calls[0].url).toBe("https://platform-home.qianwenai.com/tool/user/info.json")
    expect(calls[0].headers.Cookie).toBe(COOKIE)
    for (const call of calls.slice(1)) {
      expect(call.headers.Cookie).toBe(COOKIE)
    }
  })

  it("sends the cs-data form with api in query, cornerstoneParam and browser headers", async () => {
    const ctx = ctxIndividual()
    const plugin = await loadPlugin()
    plugin.probe(ctx)

    const call = ctx.host.http.request.mock.calls.find((c) =>
      c[0].url.startsWith("https://cs-data.qianwenai.com")
    )[0]
    expect(call.method).toBe("POST")
    const query = new URLSearchParams(call.url.split("?")[1])
    expect(query.get("product")).toBe("sfm_bailian")
    expect(query.get("action")).toBe("BroadScopeAspnGateway")
    expect(query.get("api")).toBe("zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription")

    expect(call.headers["sec-ch-ua"]).toBeDefined()
    expect(call.headers["Sec-Fetch-Site"]).toBe("same-site")
    expect(call.headers["Accept-Language"]).toBeDefined()

    const form = new URLSearchParams(call.bodyText)
    expect(form.get("sec_token")).toBe("sec-123")
    expect(form.get("region")).toBe("cn-beijing")
    const params = JSON.parse(form.get("params"))
    expect(params.Api).toBe("zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription")
    expect(params.Data.commodityCode).toBe("sfm_tokenplansolo_public_cn")
    expect(params.Data.cornerstoneParam).toEqual({
      domain: "platform.qianwenai.com",
      consoleSite: "QIANWENAI",
      console: "ONE_CONSOLE",
      xsp_lang: "zh-CN",
      protocol: "V2",
      productCode: "p_efm",
    })
    expect(params.V).toBe("1.0")
  })

  it("shows session and weekly windows for the individual plan", async () => {
    const ctx = ctxIndividual()
    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.plan).toBe("Standard")
    const session = result.lines.find((l) => l.label === "Session")
    expect(session.type).toBe("progress")
    expect(session.used).toBe(111) // 3000 * 0.037
    expect(session.limit).toBe(3000)
    expect(session.format).toEqual({ kind: "count", suffix: "credits" })
    expect(session.resetsAt).toBe("2026-07-27T10:59:00.000Z")

    const weekly = result.lines.find((l) => l.label === "Weekly")
    expect(weekly.used).toBe(497) // 10000 * 0.04973174724
    expect(weekly.limit).toBe(10000)
    expect(weekly.resetsAt).toBe("2026-07-27T10:59:00.000Z")

    const expires = result.lines.find((l) => l.label === "Expires")
    expect(expires).toBeDefined()
  })

  it("parses naive datetimes as China time (UTC+8)", async () => {
    const ctx = ctxIndividual({
      usage: personalEnvelope({
        per5HourPercentage: 0.5,
        per5HourResetTime: "2026-07-22 17:49:00",
      }),
    })
    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    const session = result.lines.find((l) => l.label === "Session")
    expect(session.resetsAt).toBe("2026-07-22T09:49:00.000Z")
  })

  it("falls back to percent mode when quota-config is unavailable", async () => {
    const ctx = ctxIndividual({
      quotaConfig: () => {
        throw new Error("boom")
      },
    })
    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    const session = result.lines.find((l) => l.label === "Session")
    expect(session.format).toEqual({ kind: "percent" })
    expect(session.used).toBe(3.7)
    expect(session.limit).toBe(100)
  })

  it("throws when usage fields are unparseable", async () => {
    const ctx = ctxIndividual({ usage: personalEnvelope({ foo: "bar" }) })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Could not parse Token Plan usage data")
  })

  it("falls back to the teams path when no individual subscription exists", async () => {
    const ctx = ctxWithRoutes({
      "fr:sfm_tokenplanteams_dp_cn": frEnvelope([makeFrInstance()]),
    })
    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.plan).toBe("Token Plan Teams")
    const progress = result.lines.find((l) => l.label === "Credits")
    expect(progress.used).toBe(12655)
    expect(progress.limit).toBe(25000)
    expect(result.lines.find((l) => l.label === "Remaining").value).toBe("12,345 credits")
  })

  it("does not display an inactive teams instance as the current plan", async () => {
    const ctx = ctxWithRoutes({
      "fr:sfm_tokenplanteams_dp_cn": frEnvelope([
        makeFrInstance({ Status: { Code: "expired" } }),
      ]),
    })
    const plugin = await loadPlugin()

    expect(() => plugin.probe(ctx)).toThrow("No active Token Plan subscription")
  })

  it("sums valid add-on instances into the Add-on line", async () => {
    const addon = (n, id) =>
      makeFrInstance({
        InstanceId: id,
        CommodityCode: "sfm_tokenplanteamsaddon_dp_cn",
        InitCapacityBaseValue: String(n),
        CurrCapacityBaseValue: String(n),
        EndTime: undefined,
      })
    const ctx = ctxWithRoutes({
      "fr:sfm_tokenplanteams_dp_cn": frEnvelope([makeFrInstance()]),
      "fr:sfm_tokenplanteamsaddon_dp_cn": frEnvelope([addon(500, "a1"), addon(300, "a2")]),
    })
    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.lines.find((l) => l.label === "Add-on").value).toBe("800 credits")
  })

  it("throws when there is no subscription at all", async () => {
    const ctx = ctxWithRoutes()
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("No active Token Plan subscription")
  })

  it("throws a session error when user info reports ConsoleNeedLogin", async () => {
    const ctx = ctxIndividual({
      userInfo: {
        status: 200,
        headers: {},
        bodyText: JSON.stringify({ code: "ConsoleNeedLogin", message: "请登录", successResponse: false }),
      },
    })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Qianwen console session expired")
    expect(ctx.host.http.request).toHaveBeenCalledTimes(1)
  })

  it("throws a session error on HTTP 401", async () => {
    const ctx = ctxIndividual({ userInfo: { status: 401, headers: {}, bodyText: "" } })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Qianwen console session expired")
  })

  it("throws a session error on a WAF redirect", async () => {
    const waf = { status: 302, headers: {}, bodyText: "" }
    const ctx = ctxWithRoutes({
      subscription: waf,
      "fr:sfm_tokenplanteams_dp_cn": waf,
      "fr:sfm_tokenplansolo_public_cn": waf,
      "fr:sfm_tokenplanpersonal_dp_cn": waf,
      "fr:sfm_tokenplanteamsaddon_dp_cn": waf,
    })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Qianwen console session expired")
  })

  it("throws an HTTP error when all calls fail with non-2xx", async () => {
    const err = { status: 500, headers: {}, bodyText: "" }
    const ctx = ctxWithRoutes({
      subscription: err,
      "fr:sfm_tokenplanteams_dp_cn": err,
      "fr:sfm_tokenplansolo_public_cn": err,
      "fr:sfm_tokenplanpersonal_dp_cn": err,
      "fr:sfm_tokenplanteamsaddon_dp_cn": err,
    })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Token Plan request failed (HTTP 500)")
  })

  it("preserves a primary plan error when the other plan queries are empty", async () => {
    const err = { status: 500, headers: {}, bodyText: "" }
    const ctx = ctxWithRoutes({
      "fr:sfm_tokenplanteams_dp_cn": err,
    })
    const plugin = await loadPlugin()

    expect(() => plugin.probe(ctx)).toThrow("Token Plan request failed (HTTP 500)")
  })

  it("throws a connection error when every call fails at network level", async () => {
    const boom = () => {
      throw new Error("socket hangup")
    }
    const ctx = ctxWithRoutes({
      subscription: boom,
      "fr:sfm_tokenplanteams_dp_cn": boom,
      "fr:sfm_tokenplansolo_public_cn": boom,
      "fr:sfm_tokenplanpersonal_dp_cn": boom,
      "fr:sfm_tokenplanteamsaddon_dp_cn": boom,
    })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Check your connection")
  })

  it("throws an API error when DataV2 ret is not SUCCESS", async () => {
    const bizFail = {
      status: 200,
      headers: {},
      bodyText: JSON.stringify({
        code: "200",
        successResponse: true,
        data: { DataV2: { ret: ["FAIL::boom"], data: {} } },
      }),
    }
    const ctx = ctxWithRoutes({
      subscription: bizFail,
      "fr:sfm_tokenplanteams_dp_cn": bizFail,
      "fr:sfm_tokenplansolo_public_cn": bizFail,
      "fr:sfm_tokenplanpersonal_dp_cn": bizFail,
      "fr:sfm_tokenplanteamsaddon_dp_cn": bizFail,
    })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Token Plan API error: boom")
  })

  it("throws on an invalid JSON response", async () => {
    const bad = { status: 200, headers: {}, bodyText: "not json" }
    const ctx = ctxWithRoutes({
      subscription: bad,
      "fr:sfm_tokenplanteams_dp_cn": bad,
      "fr:sfm_tokenplansolo_public_cn": bad,
      "fr:sfm_tokenplanpersonal_dp_cn": bad,
      "fr:sfm_tokenplanteamsaddon_dp_cn": bad,
    })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Token Plan response invalid")
  })
})
