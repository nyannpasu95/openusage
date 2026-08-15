import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { UsageSparkline } from "@/components/usage-sparkline"
import type { DisplayMode, ResetTimerDisplayMode, TimeFormatMode } from "@/lib/settings"
import type { MetricLine } from "@/lib/plugin-types"
import { clamp01, formatCountNumber, formatFixedPrecisionNumber } from "@/lib/utils"
import { calculateDeficit, calculatePaceStatus, type PaceStatus } from "@/lib/pace-status"
import { buildPaceDetailText, formatDeficitText, formatRunsOutText, getPaceStatusText } from "@/lib/pace-tooltip"
import { formatResetAbsoluteLabel, formatResetRelativeLabel, formatResetTooltipText } from "@/lib/reset-tooltip"
import { cn } from "@/lib/utils"

function PaceIndicator({
  status,
  detailText,
  isLimitReached,
}: {
  status: PaceStatus
  detailText?: string | null
  isLimitReached?: boolean
}) {
  const statusText = getPaceStatusText(status)
  const visibleText = isLimitReached ? "Limit" : statusText

  return (
    <Tooltip>
      <TooltipTrigger
        render={(props) => (
          <span
            {...props}
            className={cn(
              "inline-flex h-4 items-center rounded-full border px-1.5 font-mono text-[7px] font-semibold uppercase leading-none tracking-[0.08em]",
              status === "on-track" && !isLimitReached && "bg-foreground text-background",
              (status === "behind" || isLimitReached) && "border-dashed"
            )}
            aria-label={isLimitReached ? "Limit reached" : statusText}
          >
            {visibleText}
          </span>
        )}
      />
      <TooltipContent side="top" className="text-xs text-center">
        {isLimitReached ? (
          "Limit reached"
        ) : (
          <>
            <div>{statusText}</div>
            {detailText && <div className="text-[10px] opacity-60">{detailText}</div>}
          </>
        )}
      </TooltipContent>
    </Tooltip>
  )
}

export function MetricLineRenderer({
  line,
  displayMode,
  resetTimerDisplayMode,
  timeFormatMode,
  onResetTimerDisplayModeToggle,
  now,
  refreshing,
}: {
  line: MetricLine
  displayMode: DisplayMode
  resetTimerDisplayMode: ResetTimerDisplayMode
  timeFormatMode: TimeFormatMode
  onResetTimerDisplayModeToggle?: () => void
  now: number
  refreshing?: boolean
}) {
  if (line.type === "text") {
    return (
      <div>
        <div className="flex justify-between items-center h-[18px] gap-2">
          <span className="text-xs text-muted-foreground min-w-0 truncate" title={line.label}>
            {line.label}
          </span>
          <span
            className="text-xs text-muted-foreground truncate flex-shrink-0 max-w-[45%] text-right"
            title={line.value}
          >
            {line.value}
          </span>
        </div>
        {line.subtitle && (
          <div className="text-[10px] text-muted-foreground text-right -mt-0.5">{line.subtitle}</div>
        )}
      </div>
    )
  }

  if (line.type === "badge") {
    return (
      <div>
        <div className="flex justify-between items-center h-[22px]">
          <span className="text-sm text-muted-foreground flex-shrink-0">{line.label}</span>
          <Badge
            variant="outline"
            className="truncate min-w-0 max-w-[60%]"
            title={line.text}
          >
            {line.text}
          </Badge>
        </div>
        {line.subtitle && (
          <div className="text-xs text-muted-foreground text-right -mt-0.5">{line.subtitle}</div>
        )}
      </div>
    )
  }

  if (line.type === "barChart") {
    return (
      <UsageSparkline label={line.label} points={line.points} note={line.note} />
    )
  }

  if (line.type === "progress") {
    const resetsAtMs = line.resetsAt ? Date.parse(line.resetsAt) : Number.NaN
    const periodDurationMs = line.periodDurationMs
    const hasPaceContext = Number.isFinite(resetsAtMs) && Number.isFinite(periodDurationMs)
    const hasTimeMarkerContext = hasPaceContext && periodDurationMs! > 0
    // No usable cap → render the explicit "Unlimited" state instead of a
    // misleading 0%-or-empty bar (UX audit §08, "Limitless-50% metering").
    const isUnlimited = !Number.isFinite(line.limit) || line.limit <= 0
    const shownAmount =
      displayMode === "used"
        ? line.used
        : Math.max(0, line.limit - line.used)
    const percent = Math.round(clamp01(shownAmount / line.limit) * 10000) / 100
    const leftSuffix = displayMode === "left" ? " left" : ""

    const primaryText =
      line.format.kind === "percent"
        ? `${Math.round(shownAmount)}%${leftSuffix}`
        : line.format.kind === "dollars"
          ? `$${formatFixedPrecisionNumber(shownAmount)}${leftSuffix}`
          : `${formatCountNumber(shownAmount)} ${line.format.suffix}${leftSuffix}`

    const resetLabel = line.resetsAt
      ? resetTimerDisplayMode === "absolute"
        ? formatResetAbsoluteLabel(now, line.resetsAt, timeFormatMode)
        : formatResetRelativeLabel(now, line.resetsAt)
      : null
    const resetTooltipText = line.resetsAt
      ? formatResetTooltipText({
          nowMs: now,
          resetsAtIso: line.resetsAt,
          visibleMode: resetTimerDisplayMode,
          timeFormatMode,
        })
      : null

    const secondaryText =
      resetLabel ??
      (line.format.kind === "percent"
        ? `${line.limit}% cap`
        : line.format.kind === "dollars"
          ? `$${formatFixedPrecisionNumber(line.limit)} limit`
          : `${formatCountNumber(line.limit)} ${line.format.suffix}`)

    // Calculate pace status if we have reset time and period duration
    const paceResult = hasPaceContext
      ? calculatePaceStatus(line.used, line.limit, resetsAtMs, periodDurationMs!, now)
      : null
    const paceStatus = paceResult?.status ?? null
    const paceMarkerValue = hasTimeMarkerContext && paceStatus && paceStatus !== "on-track"
      ? (() => {
          const periodStartMs = resetsAtMs - periodDurationMs!
          const elapsedFraction = clamp01((now - periodStartMs) / periodDurationMs!)
          const elapsedPercent = elapsedFraction * 100
          return displayMode === "used" ? elapsedPercent : 100 - elapsedPercent
        })()
      : undefined
    const isLimitReached = line.used >= line.limit
    const paceDetailText =
      hasPaceContext && !isLimitReached
        ? buildPaceDetailText({
            paceResult,
            used: line.used,
            limit: line.limit,
            periodDurationMs: periodDurationMs!,
            resetsAtMs,
            nowMs: now,
            displayMode,
          })
        : null

    const deficit = hasPaceContext && !isLimitReached
      ? calculateDeficit(line.used, line.limit, resetsAtMs, periodDurationMs!, now)
      : null
    const deficitText = deficit !== null
      ? formatDeficitText(deficit, line.format, displayMode)
      : null
    const runsOutText = hasPaceContext && !isLimitReached
      ? formatRunsOutText({
          paceResult,
          used: line.used,
          limit: line.limit,
          periodDurationMs: periodDurationMs!,
          resetsAtMs,
          nowMs: now,
        })
      : null

    // Unlimited / no cap: show the used value with an "Unlimited" label instead
    // of a 0%-fill bar that reads as broken (UX audit §08).
    if (isUnlimited) {
      const unlimitedUsedText =
        line.format.kind === "percent"
          ? `${Math.round(line.used)}%`
          : line.format.kind === "dollars"
            ? `$${formatFixedPrecisionNumber(line.used)}`
            : `${formatCountNumber(line.used)} ${line.format.suffix}`
      return (
        <div>
          <div className="text-sm font-medium mb-1.5 flex items-center gap-1.5">
            {line.label}
            {paceStatus && (
              <PaceIndicator status={paceStatus} detailText={paceDetailText} isLimitReached={isLimitReached} />
            )}
          </div>
          <div className="flex justify-between items-center">
            <span className="text-xs text-muted-foreground tabular-nums">
              {unlimitedUsedText}
            </span>
            <span className="text-xs text-muted-foreground">Unlimited</span>
          </div>
        </div>
      )
    }

    return (
      <div>
        <div className="text-sm font-medium mb-1.5 flex items-center gap-1.5">
          {line.label}
          {paceStatus && (
            <PaceIndicator status={paceStatus} detailText={paceDetailText} isLimitReached={isLimitReached} />
          )}
        </div>
        <Progress
          value={percent}
          markerValue={paceMarkerValue}
          refreshing={refreshing}
        />
        <div className="flex justify-between items-center mt-1.5">
          <span className="text-xs text-muted-foreground tabular-nums">
            {primaryText}
          </span>
          {secondaryText && (
            resetTooltipText ? (
              <Tooltip>
                <TooltipTrigger
                  render={(props) =>
                    resetLabel && onResetTimerDisplayModeToggle ? (
                      <button
                        {...props}
                        type="button"
                        onClick={onResetTimerDisplayModeToggle}
                        className="text-xs text-muted-foreground tabular-nums hover:text-foreground transition-colors"
                      >
                        {secondaryText}
                      </button>
                    ) : (
                      <span {...props} className="text-xs text-muted-foreground tabular-nums">
                        {secondaryText}
                      </span>
                    )
                  }
                />
                <TooltipContent side="top">{resetTooltipText}</TooltipContent>
              </Tooltip>
            ) : resetLabel && onResetTimerDisplayModeToggle ? (
              <button
                type="button"
                onClick={onResetTimerDisplayModeToggle}
                className="text-xs text-muted-foreground tabular-nums hover:text-foreground transition-colors"
              >
                {secondaryText}
              </button>
            ) : (
              <span className="text-xs text-muted-foreground">
                {secondaryText}
              </span>
            )
          )}
        </div>
        {(deficitText || runsOutText) && (
          <div className="flex justify-between items-center mt-0.5">
            {deficitText && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {deficitText}
              </span>
            )}
            {runsOutText && (
              <span className="text-xs text-muted-foreground tabular-nums ml-auto">
                {runsOutText}
              </span>
            )}
          </div>
        )}
      </div>
    )
  }

  return null
}
