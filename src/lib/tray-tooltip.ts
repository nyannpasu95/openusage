import type { PluginMeta } from "@/lib/plugin-types"
import type { TrayPrimaryBar } from "@/lib/tray-primary-progress"
import { DEFAULT_DISPLAY_MODE, type DisplayMode } from "@/lib/settings"

/**
 * Formats a fraction (0.0 - 1.0) into a percentage string (0% - 100%).
 */
export function formatTrayPercentText(fraction: number | undefined): string {
  if (typeof fraction !== "number" || !Number.isFinite(fraction)) return "--%"
  const clampedFraction = Math.max(0, Math.min(1, fraction))
  return `${Math.round(clampedFraction * 100)}%`
}

export function formatTrayMetricText(bar: TrayPrimaryBar | undefined): string {
  if (bar?.displayText) return bar.displayText
  return formatTrayPercentText(bar?.fraction)
}

/**
 * Suffix that disambiguates a percentage metric as remaining vs consumed, so a
 * bare "53%" in the tooltip can't be misread (the same word the cards show).
 * Only percentage bars get it — balance/display-text and "--%" placeholders
 * stay bare.
 */
function metricModeSuffix(bar: TrayPrimaryBar, displayMode: DisplayMode): string {
  if (bar.displayText) return ""
  if (typeof bar.fraction !== "number" || !Number.isFinite(bar.fraction)) return ""
  return displayMode === "left" ? " left" : " used"
}

/**
 * Creates a multi-line tooltip string for the tray icon.
 * Lists the app name followed by enabled plugins and their menubar metrics.
 *
 * Percentages are suffixed with "left" or "used" to match the cards and the
 * configured display mode, so a bare number is never ambiguous.
 *
 * In weekly mode, lines are tagged with their metric label only when the list
 * is mixed (at least one provider fell back from weekly). When every provider
 * is showing weekly, the tags are redundant and omitted.
 */
export function formatTrayTooltip(
  bars: TrayPrimaryBar[],
  pluginsMeta: PluginMeta[],
  weeklyMode = false,
  displayMode: DisplayMode = DEFAULT_DISPLAY_MODE
): string {
  const lines = ["OhMyUsage"]
  if (bars.length === 0) return lines[0]!

  const resolved = bars.filter((bar) => bar.label !== undefined)
  const hasFallback = resolved.some((bar) => !bar.weekly)
  const showTags = weeklyMode && resolved.length > 0 && hasFallback

  const metaById = new Map(pluginsMeta.map((p) => [p.id, p]))
  for (const bar of bars) {
    const meta = metaById.get(bar.id)
    if (!meta) continue
    const metric = `${formatTrayMetricText(bar)}${metricModeSuffix(bar, displayMode)}`
    if (showTags && bar.label) {
      lines.push(`${meta.name}: ${metric} · ${bar.label}`)
    } else {
      lines.push(`${meta.name}: ${metric}`)
    }
  }
  return lines.join("\n")
}
