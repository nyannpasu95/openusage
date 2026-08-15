import * as React from "react"

import { cn } from "@/lib/utils"

interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number
  indicatorColor?: string
  markerValue?: number
  refreshing?: boolean
}

const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(
  ({ className, value = 0, indicatorColor, markerValue, refreshing, ...props }, ref) => {
    const clamped = Math.min(100, Math.max(0, value))
    const clampedMarker =
      typeof markerValue === "number" && Number.isFinite(markerValue)
        ? Math.min(100, Math.max(0, markerValue))
        : null
    const showMarker = clampedMarker !== null && clamped > 0 && clamped < 100
    const indicatorStyle = indicatorColor ? { color: indicatorColor } : undefined
    const markerTransform =
      clampedMarker === null
        ? undefined
        : clampedMarker <= 0
          ? "translateX(0)"
          : clampedMarker >= 100
            ? "translateX(-100%)"
            : "translateX(-50%)"
    const markerStyle = showMarker
      ? {
          left: `${clampedMarker}%`,
          transform: markerTransform,
        }
      : undefined

    return (
      <div
        ref={ref}
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        className={cn("usage-track relative h-2.5 w-full overflow-hidden", className)}
        {...props}
      >
        <div
          data-slot="progress-indicator"
          className="usage-track-indicator h-full transition-[width] duration-300"
          style={{ width: `${clamped}%`, ...indicatorStyle }}
        />
        {showMarker && (
          <div
            data-slot="progress-marker"
            aria-hidden="true"
            className="absolute bottom-0 top-0 z-10 w-px bg-foreground ring-1 ring-background/70 pointer-events-none"
            style={markerStyle}
          />
        )}
        {refreshing && (
          <div
            data-slot="progress-refreshing"
            aria-hidden="true"
            className="usage-refresh-pattern absolute inset-0 overflow-hidden"
          >
            <div className="usage-refresh-sweep h-full w-1/3" />
          </div>
        )}
      </div>
    )
  }
)
Progress.displayName = "Progress"

export { Progress }
