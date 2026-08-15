import { useCallback, useEffect, useRef, useState } from "react"
import {
  getEnabledPluginIds,
  type AutoUpdateIntervalMinutes,
  type PluginSettings,
} from "@/lib/settings"

// setInterval pauses while the system sleeps and fires late when the webview
// is throttled, so a short catch-up check bounds staleness after a wake.
const CATCH_UP_CHECK_MS = 15_000

type UseProbeAutoUpdateArgs = {
  pluginSettings: PluginSettings | null
  autoUpdateInterval: AutoUpdateIntervalMinutes
  setLoadingForPlugins: (ids: string[]) => void
  setErrorForPlugins: (ids: string[], error: string) => void
  isPluginLoading: (id: string) => boolean
  startBatch: (pluginIds?: string[]) => Promise<string[] | undefined>
}

export function useProbeAutoUpdate({
  pluginSettings,
  autoUpdateInterval,
  setLoadingForPlugins,
  setErrorForPlugins,
  isPluginLoading,
  startBatch,
}: UseProbeAutoUpdateArgs) {
  const [autoUpdateNextAt, setAutoUpdateNextAtState] = useState<number | null>(null)
  const [autoUpdateResetToken, setAutoUpdateResetToken] = useState(0)
  const nextAtRef = useRef<number | null>(null)

  // Mirror every schedule write into a ref so the catch-up interval sees the
  // latest next-at without depending on the state value.
  const setAutoUpdateNextAt = useCallback((value: number | null) => {
    nextAtRef.current = value
    setAutoUpdateNextAtState(value)
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: The reset token intentionally restarts the interval without being read inside the effect.
  useEffect(() => {
    if (!pluginSettings) {
      setAutoUpdateNextAt(null)
      return
    }

    const enabledIds = getEnabledPluginIds(pluginSettings)
    if (enabledIds.length === 0) {
      setAutoUpdateNextAt(null)
      return
    }

    const intervalMs = autoUpdateInterval * 60_000
    const scheduleNext = () => setAutoUpdateNextAt(Date.now() + intervalMs)
    scheduleNext()

    const runTick = () => {
      const idleIds = enabledIds.filter((id) => !isPluginLoading(id))
      if (idleIds.length === 0) {
        scheduleNext()
        return
      }

      setLoadingForPlugins(idleIds)
      startBatch(idleIds).catch((error) => {
        console.error("Failed to start auto-update batch:", error)
        setErrorForPlugins(idleIds, "Failed to start probe")
      })
      scheduleNext()
    }

    const interval = setInterval(runTick, intervalMs)
    const catchUpInterval = setInterval(() => {
      const nextAt = nextAtRef.current
      if (nextAt !== null && Date.now() >= nextAt) {
        runTick()
      }
    }, CATCH_UP_CHECK_MS)

    return () => {
      clearInterval(interval)
      clearInterval(catchUpInterval)
    }
  }, [
    autoUpdateInterval,
    autoUpdateResetToken,
    pluginSettings,
    isPluginLoading,
    setLoadingForPlugins,
    setErrorForPlugins,
    setAutoUpdateNextAt,
    startBatch,
  ])

  const resetAutoUpdateSchedule = useCallback(() => {
    if (!pluginSettings) return
    const enabledIds = getEnabledPluginIds(pluginSettings)
    /* v8 ignore start */
    if (enabledIds.length === 0) {
      setAutoUpdateNextAt(null)
      return
    }
    /* v8 ignore stop */

    setAutoUpdateNextAt(Date.now() + autoUpdateInterval * 60_000)
    setAutoUpdateResetToken((value) => value + 1)
  }, [autoUpdateInterval, pluginSettings, setAutoUpdateNextAt])

  return {
    autoUpdateNextAt,
    setAutoUpdateNextAt,
    resetAutoUpdateSchedule,
  }
}
