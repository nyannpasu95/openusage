import { beforeEach, describe, expect, it, vi } from "vitest"

const notificationMocks = vi.hoisted(() => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
  isTauri: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: notificationMocks.isTauri,
}))

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: notificationMocks.isPermissionGranted,
  requestPermission: notificationMocks.requestPermission,
  sendNotification: notificationMocks.sendNotification,
}))

import {
  getLowUsageAlert,
  requestLowUsageAlertPermission,
  sendLowUsageAlert,
} from "@/lib/low-usage-alerts"
import type { PluginOutput } from "@/lib/plugin-types"

function output(used: number, label = "Session", limit = 100): PluginOutput {
  return {
    providerId: "codex",
    displayName: "Codex",
    iconUrl: "codex.svg",
    lines: [
      { type: "progress", label, used, limit, format: { kind: "percent" } },
    ],
  }
}

describe("low usage alerts", () => {
  beforeEach(() => {
    notificationMocks.isTauri.mockReset()
    notificationMocks.isPermissionGranted.mockReset()
    notificationMocks.requestPermission.mockReset()
    notificationMocks.sendNotification.mockReset()
    notificationMocks.isTauri.mockReturnValue(true)
  })

  it("detects crossing from above 10% left to exactly 10% left", () => {
    expect(getLowUsageAlert(output(89), output(90))).toEqual({
      providerId: "codex",
      providerName: "Codex",
      metricLabel: "Session",
      remainingPercent: 10,
    })
  })

  it("does not repeat while usage remains at or below the threshold", () => {
    expect(getLowUsageAlert(output(90), output(95))).toBeNull()
  })

  it("does not alert on a reset or when the metric is first introduced", () => {
    expect(getLowUsageAlert(output(95), output(20))).toBeNull()
    expect(getLowUsageAlert(output(20, "Old"), output(95, "New"))).toBeNull()
  })

  it("selects the lowest newly crossed metric for one provider notification", () => {
    const previous = output(80)
    previous.lines.push({
      type: "progress",
      label: "Weekly",
      used: 85,
      limit: 100,
      format: { kind: "percent" },
    })
    const next = output(92)
    next.lines.push({
      type: "progress",
      label: "Weekly",
      used: 97,
      limit: 100,
      format: { kind: "percent" },
    })

    expect(getLowUsageAlert(previous, next)?.metricLabel).toBe("Weekly")
  })

  it("ignores unlimited and invalid progress lines", () => {
    expect(getLowUsageAlert(output(0, "Unlimited", 0), output(1, "Unlimited", 0))).toBeNull()
  })

  it("requests permission only when needed", async () => {
    notificationMocks.isPermissionGranted.mockResolvedValueOnce(false)
    notificationMocks.requestPermission.mockResolvedValueOnce("granted")
    await expect(requestLowUsageAlertPermission()).resolves.toBe(true)
    expect(notificationMocks.requestPermission).toHaveBeenCalledTimes(1)
  })

  it("sends the native notification with provider and metric context", async () => {
    notificationMocks.isPermissionGranted.mockResolvedValueOnce(true)
    await sendLowUsageAlert({
      providerId: "codex",
      providerName: "Codex",
      metricLabel: "Session",
      remainingPercent: 8,
    })
    expect(notificationMocks.sendNotification).toHaveBeenCalledWith({
      title: "Low Usage Alert",
      body: "Codex · Session has 8% left.",
    })
  })
})
