import { ProviderCard } from "@/components/provider-card"
import type { CredentialStatus, MetricLine, PluginDisplayState } from "@/lib/plugin-types"
import type { DisplayMode, ResetTimerDisplayMode, TimeFormatMode } from "@/lib/settings"
import { formatResetRelativeLabel } from "@/lib/reset-tooltip"

interface OverviewPageProps {
  plugins: PluginDisplayState[]
  onRetryPlugin?: (pluginId: string) => void
  displayMode: DisplayMode
  resetTimerDisplayMode: ResetTimerDisplayMode
  timeFormatMode?: TimeFormatMode
  onResetTimerDisplayModeToggle?: () => void
  credentialStatuses?: Record<string, CredentialStatus>
  onSetUpCredentials?: () => void
}

type ProgressLine = Extract<MetricLine, { type: "progress" }>

function isFiniteProgressLine(line: MetricLine): line is ProgressLine {
  return line.type === "progress" && Number.isFinite(line.limit) && line.limit > 0
}

function buildUsageSummary(plugins: PluginDisplayState[]) {
  const now = Date.now()
  const progressLines = plugins.flatMap((plugin) =>
    (plugin.data?.lines ?? [])
      .filter(isFiniteProgressLine)
      .map((line) => ({ plugin, line }))
  )

  const highest = progressLines.reduce<(typeof progressLines)[number] | null>(
    (current, candidate) => {
      if (!current) return candidate
      return candidate.line.used / candidate.line.limit > current.line.used / current.line.limit
        ? candidate
        : current
    },
    null
  )

  const nextReset = progressLines
    .map((candidate) => ({
      ...candidate,
      resetMs: candidate.line.resetsAt ? Date.parse(candidate.line.resetsAt) : Number.NaN,
    }))
    .filter((candidate) => Number.isFinite(candidate.resetMs) && candidate.resetMs > now)
    .sort((a, b) => a.resetMs - b.resetMs)[0]

  return {
    highest: highest
      ? `${Math.round((highest.line.used / highest.line.limit) * 100)}% · ${highest.plugin.meta.name}`
      : "No Usage Data",
    nextReset: nextReset
      ? `${formatResetRelativeLabel(now, nextReset.line.resetsAt!)} · ${nextReset.plugin.meta.name}`
      : "No Reset Scheduled",
  }
}

export function OverviewPage({
  plugins,
  onRetryPlugin,
  displayMode,
  resetTimerDisplayMode,
  timeFormatMode = "auto",
  onResetTimerDisplayModeToggle,
  credentialStatuses,
  onSetUpCredentials,
}: OverviewPageProps) {
  const summary = buildUsageSummary(plugins)

  return (
    <div className="pb-2">
      <header className="mb-4 border-b">
        <div className="px-0.5 pb-3.5 pt-1">
          <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Live Quotas · {plugins.length} {plugins.length === 1 ? "Source" : "Sources"}
          </p>
          <h1 className="mt-1 text-xl font-black uppercase leading-none tracking-[-0.035em]">
            Usage Overview
          </h1>
        </div>
        {plugins.length > 0 ? (
          <div className="grid grid-cols-2 border-t">
            <div className="min-w-0 py-2.5 pr-2.5">
              <span className="block font-mono text-[8px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Highest Usage
              </span>
              <strong className="mt-0.5 block truncate text-[11px] font-semibold tabular-nums" title={summary.highest}>
                {summary.highest}
              </strong>
            </div>
            <div className="min-w-0 border-l py-2.5 pl-2.5">
              <span className="block font-mono text-[8px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Next Reset
              </span>
              <strong className="mt-0.5 block truncate text-[11px] font-semibold tabular-nums" title={summary.nextReset}>
                {summary.nextReset}
              </strong>
            </div>
          </div>
        ) : null}
      </header>
      <div className="space-y-3">
      {plugins.length === 0 ? (
        <div className="border border-dashed px-5 py-8 text-center">
          <h2 className="text-sm font-semibold">No Providers Enabled</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Enable a provider in Settings to start tracking usage.
          </p>
        </div>
      ) : (
        plugins.map((plugin) => (
          <ProviderCard
            key={plugin.meta.id}
            name={plugin.meta.name}
            plan={plugin.data?.plan}
            loading={plugin.loading}
            error={plugin.error}
            lines={plugin.data?.lines ?? []}
            skeletonLines={plugin.meta.lines}
            lastManualRefreshAt={plugin.lastManualRefreshAt}
            lastUpdatedAt={plugin.lastUpdatedAt}
            onRetry={onRetryPlugin ? () => onRetryPlugin(plugin.meta.id) : undefined}
            scopeFilter="overview"
            displayMode={displayMode}
            resetTimerDisplayMode={resetTimerDisplayMode}
            timeFormatMode={timeFormatMode}
            onResetTimerDisplayModeToggle={onResetTimerDisplayModeToggle}
            credentialStatus={credentialStatuses?.[plugin.meta.id]}
            onSetUpCredentials={onSetUpCredentials}
          />
        ))
      )}
      </div>
    </div>
  )
}
