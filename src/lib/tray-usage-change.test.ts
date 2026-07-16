import { describe, expect, it } from "vitest"
import type { MetricLine, PluginMeta, PluginOutput } from "@/lib/plugin-types"
import {
  getTrayUsageIncrease,
  pickLargestTrayUsageIncrease,
} from "@/lib/tray-usage-change"

const meta: PluginMeta = {
  id: "codex",
  name: "Codex",
  iconUrl: "",
  lines: [],
  primaryCandidates: ["Session", "Fallback"],
  weeklyCandidate: "Weekly",
}

function progress(label: string, used: number, limit = 100): MetricLine {
  return {
    type: "progress",
    label,
    used,
    limit,
    format: { kind: "percent" },
  }
}

function output(lines: MetricLine[], overrides: Partial<PluginOutput> = {}): PluginOutput {
  return {
    providerId: "codex",
    displayName: "Codex",
    plan: "Plus",
    iconUrl: "",
    lines,
    ...overrides,
  }
}

describe("getTrayUsageIncrease", () => {
  it("treats the first successful result as a baseline", () => {
    expect(getTrayUsageIncrease({
      meta,
      previousData: null,
      nextData: output([progress("Session", 10)]),
    })).toBeNull()
  })

  it("returns the normalized increase for the selected primary metric", () => {
    expect(getTrayUsageIncrease({
      meta,
      previousData: output([progress("Session", 20, 200)]),
      nextData: output([progress("Session", 50, 200)]),
    })).toEqual({ providerId: "codex", fractionIncrease: 0.15 })
  })

  it.each([
    ["unchanged", 20],
    ["decreased or reset", 5],
  ])("ignores %s usage", (_label, nextUsed) => {
    expect(getTrayUsageIncrease({
      meta,
      previousData: output([progress("Session", 20)]),
      nextData: output([progress("Session", nextUsed)]),
    })).toBeNull()
  })

  it("ignores provider, plan, and selected-metric changes", () => {
    const previousData = output([progress("Session", 10)])

    expect(getTrayUsageIncrease({
      meta,
      previousData,
      nextData: output([progress("Session", 20)], { providerId: "claude" }),
    })).toBeNull()
    expect(getTrayUsageIncrease({
      meta,
      previousData,
      nextData: output([progress("Session", 20)], { plan: "Team" }),
    })).toBeNull()
    expect(getTrayUsageIncrease({
      meta,
      previousData,
      nextData: output([progress("Fallback", 20)]),
    })).toBeNull()
  })

  it("uses the weekly metric when preferred", () => {
    const previousData = output([
      progress("Session", 10),
      progress("Weekly", 30),
    ])

    expect(getTrayUsageIncrease({
      meta,
      previousData,
      nextData: output([progress("Session", 40), progress("Weekly", 30)]),
      preferWeekly: true,
    })).toBeNull()
    expect(getTrayUsageIncrease({
      meta,
      previousData,
      nextData: output([progress("Session", 40), progress("Weekly", 35)]),
      preferWeekly: true,
    })).toEqual({ providerId: "codex", fractionIncrease: 0.05 })
  })

  it("falls back to the primary metric when weekly data is absent", () => {
    expect(getTrayUsageIncrease({
      meta,
      previousData: output([progress("Session", 10)]),
      nextData: output([progress("Session", 25)]),
      preferWeekly: true,
    })).toEqual({ providerId: "codex", fractionIncrease: 0.15 })
  })

  it("ignores non-positive and non-finite limits", () => {
    expect(getTrayUsageIncrease({
      meta,
      previousData: output([progress("Session", 10, 0)]),
      nextData: output([progress("Session", 20, 0)]),
    })).toBeNull()
    expect(getTrayUsageIncrease({
      meta,
      previousData: output([progress("Session", 10)]),
      nextData: output([progress("Session", 20, Number.POSITIVE_INFINITY)]),
    })).toBeNull()
  })
})

describe("pickLargestTrayUsageIncrease", () => {
  it("selects the largest increase regardless of result order", () => {
    expect(pickLargestTrayUsageIncrease([
      { providerId: "b", fractionIncrease: 0.1 },
      { providerId: "a", fractionIncrease: 0.2 },
    ], ["a", "b"])).toEqual({ providerId: "a", fractionIncrease: 0.2 })
  })

  it("uses provider order to break equal-increase ties", () => {
    expect(pickLargestTrayUsageIncrease([
      { providerId: "b", fractionIncrease: 0.1 },
      { providerId: "a", fractionIncrease: 0.1 },
    ], ["a", "b"])).toEqual({ providerId: "a", fractionIncrease: 0.1 })
  })
})
