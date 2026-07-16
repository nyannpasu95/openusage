import { isTauri } from "@tauri-apps/api/core"
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification"
import type { MetricLine, PluginOutput } from "@/lib/plugin-types"

export const LOW_USAGE_ALERT_THRESHOLD_PERCENT = 10

type ProgressLine = Extract<MetricLine, { type: "progress" }>

export type LowUsageAlert = {
  providerId: string
  providerName: string
  metricLabel: string
  remainingPercent: number
}

function isEligibleProgressLine(line: MetricLine): line is ProgressLine {
  return (
    line.type === "progress" &&
    Number.isFinite(line.used) &&
    Number.isFinite(line.limit) &&
    line.limit > 0
  )
}

function getRemainingPercent(line: ProgressLine): number {
  return Math.max(0, Math.min(100, ((line.limit - line.used) / line.limit) * 100))
}

export function getLowUsageAlert(
  previousData: PluginOutput,
  nextData: PluginOutput,
): LowUsageAlert | null {
  if (previousData.providerId !== nextData.providerId) return null

  const previousByLabel = new Map(
    previousData.lines
      .filter(isEligibleProgressLine)
      .map((line) => [line.label, line]),
  )

  let selected: LowUsageAlert | null = null
  for (const nextLine of nextData.lines) {
    if (!isEligibleProgressLine(nextLine)) continue
    const previousLine = previousByLabel.get(nextLine.label)
    if (!previousLine) continue

    const previousRemaining = getRemainingPercent(previousLine)
    const nextRemaining = getRemainingPercent(nextLine)
    if (
      previousRemaining <= LOW_USAGE_ALERT_THRESHOLD_PERCENT ||
      nextRemaining > LOW_USAGE_ALERT_THRESHOLD_PERCENT
    ) {
      continue
    }

    const candidate = {
      providerId: nextData.providerId,
      providerName: nextData.displayName,
      metricLabel: nextLine.label,
      remainingPercent: Math.round(nextRemaining),
    }
    if (!selected || candidate.remainingPercent < selected.remainingPercent) {
      selected = candidate
    }
  }

  return selected
}

export async function requestLowUsageAlertPermission(): Promise<boolean> {
  if (!isTauri()) return true
  if (await isPermissionGranted()) return true
  return (await requestPermission()) === "granted"
}

export async function sendLowUsageAlert(alert: LowUsageAlert): Promise<void> {
  if (!isTauri()) return
  if (!(await isPermissionGranted())) {
    throw new Error("System notification permission is not granted")
  }

  sendNotification({
    title: "Low Usage Alert",
    body: `${alert.providerName} · ${alert.metricLabel} has ${alert.remainingPercent}% left.`,
  })
}
