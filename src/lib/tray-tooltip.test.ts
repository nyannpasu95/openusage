import { describe, expect, it } from "vitest"
import { formatTrayMetricText, formatTrayPercentText, formatTrayTooltip } from "./tray-tooltip"
import type { PluginMeta } from "./plugin-types"
import type { TrayPrimaryBar } from "./tray-primary-progress"

describe("tray-tooltip", () => {
  describe("formatTrayPercentText", () => {
    it("should format valid fractions", () => {
      expect(formatTrayPercentText(0.45)).toBe("45%")
      expect(formatTrayPercentText(0)).toBe("0%")
      expect(formatTrayPercentText(1)).toBe("100%")
    })

    it("should round fractions", () => {
      expect(formatTrayPercentText(0.456)).toBe("46%")
      expect(formatTrayPercentText(0.454)).toBe("45%")
    })

    it("should clamp fractions", () => {
      expect(formatTrayPercentText(-0.1)).toBe("0%")
      expect(formatTrayPercentText(1.1)).toBe("100%")
    })

    it("should handle undefined and NaN", () => {
      expect(formatTrayPercentText(undefined)).toBe("--%")
      expect(formatTrayPercentText(NaN)).toBe("--%")
    })
  })

  describe("formatTrayMetricText", () => {
    it("uses display text before percentage text", () => {
      expect(formatTrayMetricText({ id: "p1", displayText: "¥53.73 CNY" })).toBe("¥53.73 CNY")
      expect(formatTrayMetricText({ id: "p1", fraction: 0.45 })).toBe("45%")
    })
  })

  describe("formatTrayTooltip", () => {
    const mockMeta: PluginMeta[] = [
      { id: "p1", name: "Plugin 1", iconUrl: "", lines: [], links: [], primaryCandidates: [] },
      { id: "p2", name: "Plugin 2", iconUrl: "", lines: [], links: [], primaryCandidates: [] },
    ]

    it("should show app name when no bars", () => {
      expect(formatTrayTooltip([], mockMeta)).toBe("OhMyUsage")
    })

    it("should list enabled plugins with percentages (default left mode)", () => {
      const bars: TrayPrimaryBar[] = [
        { id: "p1", fraction: 0.45 },
        { id: "p2", fraction: 0.12 },
      ]
      const tooltip = formatTrayTooltip(bars, mockMeta)
      expect(tooltip).toBe("OhMyUsage\nPlugin 1: 45% left\nPlugin 2: 12% left")
    })

    it("suffixes percentages with 'used' in used mode", () => {
      const bars: TrayPrimaryBar[] = [
        { id: "p1", fraction: 0.45 },
        { id: "p2", fraction: 0.12 },
      ]
      const tooltip = formatTrayTooltip(bars, mockMeta, false, "used")
      expect(tooltip).toBe("OhMyUsage\nPlugin 1: 45% used\nPlugin 2: 12% used")
    })

    it("should handle missing plugin metadata gracefully", () => {
      const bars: TrayPrimaryBar[] = [
        { id: "p1", fraction: 0.45 },
        { id: "unknown", fraction: 0.5 },
      ]
      const tooltip = formatTrayTooltip(bars, mockMeta)
      expect(tooltip).toBe("OhMyUsage\nPlugin 1: 45% left")
    })

    it("should show a bare --% for missing fractions", () => {
      const bars: TrayPrimaryBar[] = [
        { id: "p1", fraction: undefined },
      ]
      const tooltip = formatTrayTooltip(bars, mockMeta)
      expect(tooltip).toBe("OhMyUsage\nPlugin 1: --%")
    })

    it("uses bare display text for non-percentage metrics", () => {
      const bars: TrayPrimaryBar[] = [
        { id: "p1", displayText: "¥53.73 CNY", label: "Balance" },
      ]
      const tooltip = formatTrayTooltip(bars, mockMeta)
      expect(tooltip).toBe("OhMyUsage\nPlugin 1: ¥53.73 CNY")
    })

    it("omits tags in weekly mode when every line is weekly", () => {
      const bars: TrayPrimaryBar[] = [
        { id: "p1", fraction: 0.42, label: "Weekly", weekly: true },
        { id: "p2", fraction: 0.6, label: "Weekly", weekly: true },
      ]
      const tooltip = formatTrayTooltip(bars, mockMeta, true)
      expect(tooltip).toBe("OhMyUsage\nPlugin 1: 42% left\nPlugin 2: 60% left")
    })

    it("tags every line in weekly mode when the list is mixed", () => {
      const bars: TrayPrimaryBar[] = [
        { id: "p1", fraction: 0.42, label: "Weekly", weekly: true },
        { id: "p2", fraction: 0.3, label: "Premium" },
      ]
      const tooltip = formatTrayTooltip(bars, mockMeta, true)
      expect(tooltip).toBe("OhMyUsage\nPlugin 1: 42% left · Weekly\nPlugin 2: 30% left · Premium")
    })

    it("does not tag lines when weekly mode is off", () => {
      const bars: TrayPrimaryBar[] = [
        { id: "p1", fraction: 0.42, label: "Weekly", weekly: true },
        { id: "p2", fraction: 0.3, label: "Premium" },
      ]
      const tooltip = formatTrayTooltip(bars, mockMeta, false)
      expect(tooltip).toBe("OhMyUsage\nPlugin 1: 42% left\nPlugin 2: 30% left")
    })
  })
})
