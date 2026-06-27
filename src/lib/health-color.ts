/**
 * Semantic health ramp for usage meters.
 *
 * The UX audit's core "color means something" principle: the meter fill turns
 * amber as you approach the limit and red when you're about to blow through it.
 * While healthy it keeps the provider's brand color, so the warning colors stand
 * out as a real signal. Thresholds are based on the usage *percent* (always
 * computable), not on pace projection (which needs reset/period data many
 * plugins don't provide).
 *
 * The amber/red colors are CSS `var()` references so they follow the light/dark
 * theme — `--yellow-500` / `--red-500` are re-derived per theme in index.css.
 */

export const HEALTH_THRESHOLDS = {
  /** below this stays healthy (defers to the brand color) */
  amber: 75,
  /** at/above this is critical (red) */
  red: 90,
} as const

/**
 * @param percent - usage as a percentage of the limit (0–100). Non-finite or
 *                  out-of-range values are treated as 0 (healthy).
 * @returns CSS color string for the meter fill, or `null` while healthy to defer
 *          to the caller's default (e.g. a provider brand color).
 */
export function getHealthColor(percent: number): string | null {
  const clamped =
    Number.isFinite(percent) && percent > 0
      ? Math.min(100, Math.max(0, percent))
      : 0

  if (clamped >= HEALTH_THRESHOLDS.red) return "var(--red-500)"
  if (clamped >= HEALTH_THRESHOLDS.amber) return "var(--yellow-500)"
  return null
}
