import { Fragment, useMemo } from "react"
import { AlertCircle, ExternalLink, Hourglass, KeyRound, RefreshCw } from "lucide-react"
import { openUrl } from "@tauri-apps/plugin-opener"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { SkeletonLines } from "@/components/skeleton-lines"
import { PluginError } from "@/components/plugin-error"
import { MetricLineRenderer } from "@/components/provider-card-metric-line"
import { useNowTicker } from "@/hooks/use-now-ticker"
import { REFRESH_COOLDOWN_MS, type DisplayMode, type ResetTimerDisplayMode, type TimeFormatMode } from "@/lib/settings"
import type { CredentialStatus, ManifestLine, MetricLine, PluginLink } from "@/lib/plugin-types"
import { groupLinesByType } from "@/lib/group-lines-by-type"
import { cn } from "@/lib/utils"

interface ProviderCardProps {
  name: string
  plan?: string
  links?: PluginLink[]
  loading?: boolean
  error?: string | null
  lines?: MetricLine[]
  skeletonLines?: ManifestLine[]
  lastManualRefreshAt?: number | null
  lastUpdatedAt?: number | null
  onRetry?: () => void
  scopeFilter?: "overview" | "all"
  displayMode: DisplayMode
  resetTimerDisplayMode?: ResetTimerDisplayMode
  timeFormatMode?: TimeFormatMode
  onResetTimerDisplayModeToggle?: () => void
  credentialStatus?: CredentialStatus
  onSetUpCredentials?: () => void
}

function formatRelativeTime(diffMs: number): string {
  const seconds = Math.floor(Math.max(0, diffMs) / 1000)
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function ProviderCard({
  name,
  plan,
  links = [],
  loading = false,
  error = null,
  lines = [],
  skeletonLines = [],
  lastManualRefreshAt,
  lastUpdatedAt,
  onRetry,
  scopeFilter = "all",
  displayMode,
  resetTimerDisplayMode = "relative",
  timeFormatMode = "auto",
  onResetTimerDisplayModeToggle,
  credentialStatus,
  onSetUpCredentials,
}: ProviderCardProps) {
  const cooldownRemainingMs = useMemo(() => {
    if (!lastManualRefreshAt) return 0
    const remaining = REFRESH_COOLDOWN_MS - (Date.now() - lastManualRefreshAt)
    return remaining > 0 ? remaining : 0
  }, [lastManualRefreshAt])

  // Filter lines based on scope - match by label since runtime lines can differ from manifest
  const overviewLabels = new Set(
    skeletonLines
      .filter(line => line.scope === "overview")
      .map(line => line.label)
  )
  const filteredSkeletonLines = scopeFilter === "all"
    ? skeletonLines
    : skeletonLines.filter(line => line.scope === "overview")
  const filteredLines = scopeFilter === "all"
    ? lines
    : lines.filter(line => overviewLabels.has(line.label))

  const hasResetCountdown = filteredLines.some(
    (line) => line.type === "progress" && Boolean(line.resetsAt)
  )

  // "has ever loaded" — true if either we have a prior success timestamp,
  // or the parent is passing lines directly (tests + legacy state paths).
  const hasStaleData = lastUpdatedAt != null || filteredLines.length > 0
  const isRefreshingWithData = loading && hasStaleData
  const highestUsageRatio = filteredLines.reduce((highest, line) => {
    if (line.type !== "progress" || !Number.isFinite(line.limit) || line.limit <= 0) {
      return highest
    }
    return Math.max(highest, line.used / line.limit)
  }, 0)
  const stateLabel = isRefreshingWithData
    ? "Refreshing"
    : error && hasStaleData
      ? "Data Stale"
      : highestUsageRatio >= 0.9
        ? "Near Limit"
        : highestUsageRatio > 0
          ? "On Track"
          : null

  // Missing manual credential (API key/cookie): replace the raw probe error
  // with an actionable setup prompt. Detected-kind plugins keep their error
  // text, which already explains how to log in.
  const showCredentialSetup =
    credentialStatus != null &&
    !credentialStatus.configured &&
    (credentialStatus.kind === "apiKey" || credentialStatus.kind === "cookie") &&
    !hasStaleData &&
    !loading

  const tickerIntervalMs = cooldownRemainingMs > 0 ? 1000 : 30_000

  const now = useNowTicker({
    enabled: cooldownRemainingMs > 0 || hasResetCountdown,
    intervalMs: tickerIntervalMs,
    stopAfterMs: cooldownRemainingMs > 0 && !hasResetCountdown ? cooldownRemainingMs : null,
  })

  const inCooldown = lastManualRefreshAt
    ? now - lastManualRefreshAt < REFRESH_COOLDOWN_MS
    : false

  const visibleLinks = useMemo(
    () =>
      links
        .map((link) => ({
          label: link.label.trim(),
          url: link.url.trim(),
        }))
        .filter(
          (link) =>
            link.label.length > 0 &&
            link.url.length > 0 &&
            (link.url.startsWith("https://") || link.url.startsWith("http://"))
        ),
    [links]
  )

  // Format remaining cooldown time as "Xm Ys"
  const formatRemainingTime = () => {
    if (!lastManualRefreshAt) return ""
    const remainingMs = REFRESH_COOLDOWN_MS - (now - lastManualRefreshAt)
    if (remainingMs <= 0) return ""
    const totalSeconds = Math.ceil(remainingMs / 1000)
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    if (minutes > 0) {
      return `Available in ${minutes}m ${seconds}s`
    }
    return `Available in ${seconds}s`
  }

  return (
    <div>
      <div className="rounded-md border border-border-strong/60 bg-card px-3.5 py-3.5">
        <div className="mb-3 flex items-start justify-between gap-2.5">
          <div className="relative flex items-center min-w-0">
            <div className="min-w-0">
              <h2 className="truncate text-sm font-bold uppercase leading-none tracking-[-0.02em]" style={{ transform: "translateZ(0)" }}>{name}</h2>
              {plan ? (
                <p className="mt-1 truncate font-mono text-[9px] leading-none text-muted-foreground" title={plan}>
                  {plan}
                </p>
              ) : null}
            </div>
            {onRetry && (
              loading ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="ml-1 pointer-events-none opacity-50"
                  style={{ transform: "translateZ(0)", backfaceVisibility: "hidden" }}
                  tabIndex={-1}
                >
                  <RefreshCw className="h-3 w-3 animate-spin" />
                </Button>
              ) : inCooldown ? (
                <Tooltip>
                  <TooltipTrigger
                    className="ml-1"
                    render={(props) => (
                      <span {...props} className={props.className}>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="pointer-events-none opacity-50"
                          style={{ transform: "translateZ(0)", backfaceVisibility: "hidden" }}
                          tabIndex={-1}
                        >
                          <Hourglass className="h-3 w-3" />
                        </Button>
                      </span>
                    )}
                  />
                  <TooltipContent side="top">
                    {formatRemainingTime()}
                  </TooltipContent>
                </Tooltip>
              ) : (
                <Tooltip>
                  <TooltipTrigger
                    className="ml-1"
                    render={(props) => (
                      <Button
                        {...props}
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Retry"
                        onClick={(e) => {
                          e.currentTarget.blur()
                          onRetry()
                        }}
                        className="opacity-0 hover:opacity-100 focus-visible:opacity-100"
                        style={{ transform: "translateZ(0)", backfaceVisibility: "hidden" }}
                      >
                        <RefreshCw className="h-3 w-3" />
                      </Button>
                    )}
                  />
                  {lastUpdatedAt != null && (
                    <TooltipContent side="top">
                      Updated {formatRelativeTime(Date.now() - lastUpdatedAt)}
                    </TooltipContent>
                  )}
                </Tooltip>
              )
            )}
          </div>
          {stateLabel ? (
            <Badge
              variant="outline"
              className={cn(
                "h-5 shrink-0 rounded-full px-2 font-mono text-[8px] font-semibold uppercase tracking-[0.08em]",
                stateLabel === "Data Stale" && "border-dashed",
                stateLabel === "Refreshing" && "usage-refresh-pattern"
              )}
            >
              {stateLabel}
            </Badge>
          ) : null}
        </div>
        {visibleLinks.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5 border-t pt-2">
            {visibleLinks.map((link) => (
              <Button
                key={`${link.label}-${link.url}`}
                variant="outline"
                size="xs"
                className="h-6 max-w-full text-[11px]"
                onClick={() => {
                  openUrl(link.url).catch(console.error)
                }}
              >
                <span className="truncate">{link.label}</span>
                <ExternalLink className="size-3 opacity-70" />
              </Button>
            ))}
          </div>
        )}
        {showCredentialSetup ? (
          <div className="mb-2 flex items-center justify-between gap-2 border border-dashed px-2 py-1.5 text-xs text-foreground">
            <span className="flex items-center gap-1.5 truncate">
              <KeyRound className="h-3 w-3 flex-shrink-0" />
              Credentials Not Set
            </span>
            {onSetUpCredentials && (
              <Button variant="outline" size="xs" className="h-6 text-[11px]" onClick={onSetUpCredentials}>
                Set Up
              </Button>
            )}
          </div>
        ) : (
          error && !hasStaleData && <PluginError message={error} />
        )}

        {error && hasStaleData && !showCredentialSetup && (
          <Tooltip>
            <TooltipTrigger
              render={(props) => (
                <div
                  {...props}
                  className="mb-2 flex items-center gap-1.5 border border-dashed px-2 py-1.5 text-xs text-foreground"
                >
                  <AlertCircle className="h-3 w-3 flex-shrink-0" />
                  <span className="truncate">{error}</span>
                </div>
              )}
            />
            <TooltipContent side="top" className="max-w-xs break-words text-xs">
              {error}
            </TooltipContent>
          </Tooltip>
        )}

        {loading && !hasStaleData && !error && (
          <SkeletonLines lines={filteredSkeletonLines} />
        )}

        {hasStaleData && (
          <div className="space-y-4">
            {groupLinesByType(filteredLines).map((group, gi) =>
              group.kind === "text" ? (
                <div key={gi} className="space-y-1">
                  {group.lines.map((line, li) => (
                    <MetricLineRenderer
                      key={`${line.label}-${gi}-${li}`}
                      line={line}
                      displayMode={displayMode}
                      resetTimerDisplayMode={resetTimerDisplayMode}
                      timeFormatMode={timeFormatMode}
                      onResetTimerDisplayModeToggle={onResetTimerDisplayModeToggle}
                      now={now}
                      refreshing={isRefreshingWithData}
                    />
                  ))}
                </div>
              ) : (
                <Fragment key={gi}>
                  {group.lines.map((line, li) => (
                    <MetricLineRenderer
                      key={`${line.label}-${gi}-${li}`}
                      line={line}
                      displayMode={displayMode}
                      resetTimerDisplayMode={resetTimerDisplayMode}
                      timeFormatMode={timeFormatMode}
                      onResetTimerDisplayModeToggle={onResetTimerDisplayModeToggle}
                      now={now}
                      refreshing={isRefreshingWithData}
                    />
                  ))}
                </Fragment>
              )
            )}
          </div>
        )}

      </div>
    </div>
  )
}
