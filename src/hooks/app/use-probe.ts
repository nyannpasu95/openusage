import { useCallback } from "react"
import { useProbeEvents } from "@/hooks/use-probe-events"
import {
  type AutoUpdateIntervalMinutes,
  type PluginSettings,
} from "@/lib/settings"
import { useProbeAutoUpdate } from "@/hooks/app/use-probe-auto-update"
import { useProbeRefreshActions } from "@/hooks/app/use-probe-refresh-actions"
import { useProbeState } from "@/hooks/app/use-probe-state"
import type { ProbeResultUpdate } from "@/hooks/app/types"

type UseProbeArgs = {
  pluginSettings: PluginSettings | null
  autoUpdateInterval: AutoUpdateIntervalMinutes
  onProbeResult?: (update: ProbeResultUpdate) => void
  onProbeBatchComplete?: (batchId: string) => void
}

export function useProbe({
  pluginSettings,
  autoUpdateInterval,
  onProbeResult,
  onProbeBatchComplete,
}: UseProbeArgs) {
  const {
    pluginStates,
    pluginStatesRef,
    manualRefreshIdsRef,
    setLoadingForPlugins,
    setErrorForPlugins,
    handleProbeResult,
  } = useProbeState({ onProbeResult })

  const handleBatchComplete = useCallback((batchId: string) => {
    onProbeBatchComplete?.(batchId)
  }, [onProbeBatchComplete])

  const { startBatch } = useProbeEvents({
    onResult: handleProbeResult,
    onBatchComplete: handleBatchComplete,
  })

  const isPluginLoading = useCallback(
    (id: string) => Boolean(pluginStatesRef.current[id]?.loading),
    [pluginStatesRef]
  )

  const {
    autoUpdateNextAt,
    setAutoUpdateNextAt,
    resetAutoUpdateSchedule,
  } = useProbeAutoUpdate({
    pluginSettings,
    autoUpdateInterval,
    setLoadingForPlugins,
    setErrorForPlugins,
    isPluginLoading,
    startBatch,
  })

  const { handleRetryPlugin, handleRefreshAll } = useProbeRefreshActions({
    pluginSettings,
    pluginStatesRef,
    manualRefreshIdsRef,
    resetAutoUpdateSchedule,
    setLoadingForPlugins,
    setErrorForPlugins,
    startBatch,
  })

  return {
    pluginStates,
    setLoadingForPlugins,
    setErrorForPlugins,
    startBatch,
    autoUpdateNextAt,
    setAutoUpdateNextAt,
    handleRetryPlugin,
    handleRefreshAll,
  }
}
