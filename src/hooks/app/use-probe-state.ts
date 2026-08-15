import { useCallback, useEffect, useRef, useState } from "react"
import type { PluginOutput } from "@/lib/plugin-types"
import type { PluginState, ProbeResultUpdate } from "@/hooks/app/types"

type UseProbeStateArgs = {
  onProbeResult?: (update: ProbeResultUpdate) => void
}

export function useProbeState({ onProbeResult }: UseProbeStateArgs) {
  const [pluginStates, setPluginStates] = useState<Record<string, PluginState>>({})

  const pluginStatesRef = useRef(pluginStates)
  useEffect(() => {
    pluginStatesRef.current = pluginStates
  }, [pluginStates])

  const manualRefreshIdsRef = useRef<Set<string>>(new Set())

  const updatePluginStates = useCallback(
    (
      updater: (
        previousStates: Record<string, PluginState>
      ) => Record<string, PluginState>
    ) => {
      const nextStates = updater(pluginStatesRef.current)
      pluginStatesRef.current = nextStates
      setPluginStates(nextStates)
    },
    []
  )

  const getErrorMessage = useCallback((output: PluginOutput) => {
    if (output.lines.length !== 1) return null
    const line = output.lines[0]
    if (line.type === "badge" && line.label === "Error") {
      return line.text || "Couldn't update data. Try again?"
    }
    return null
  }, [])

  const setLoadingForPlugins = useCallback((ids: string[]) => {
    updatePluginStates((prev) => {
      const next = { ...prev }
      for (const id of ids) {
        const existing = prev[id]
        next[id] = {
          data: existing?.data ?? null,
          loading: true,
          error: null,
          lastManualRefreshAt: existing?.lastManualRefreshAt ?? null,
          lastUpdatedAt: existing?.lastUpdatedAt ?? null,
        }
      }
      return next
    })
  }, [updatePluginStates])

  const setErrorForPlugins = useCallback((ids: string[], error: string) => {
    updatePluginStates((prev) => {
      const next = { ...prev }
      for (const id of ids) {
        const existing = prev[id]
        next[id] = {
          data: existing?.data ?? null,
          loading: false,
          error,
          lastManualRefreshAt: existing?.lastManualRefreshAt ?? null,
          lastUpdatedAt: existing?.lastUpdatedAt ?? null,
        }
      }
      return next
    })
  }, [updatePluginStates])

  const markResultsLost = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return
      console.error(`Probe results lost in transit for plugins: ${ids.join(", ")}`)
      for (const id of ids) {
        manualRefreshIdsRef.current.delete(id)
      }
      setErrorForPlugins(ids, "Couldn't update data. Retrying automatically.")
    },
    [setErrorForPlugins]
  )

  const handleProbeResult = useCallback(
    (output: PluginOutput, batchId: string) => {
      const errorMessage = getErrorMessage(output)
      const isManual = manualRefreshIdsRef.current.has(output.providerId)
      if (isManual) {
        manualRefreshIdsRef.current.delete(output.providerId)
      }

      const now = Date.now()
      let previousData: PluginOutput | null = null
      updatePluginStates((prev) => {
        const existing = prev[output.providerId]
        previousData = existing?.data ?? null
        return {
          ...prev,
          [output.providerId]: {
            data: errorMessage ? (existing?.data ?? null) : output,
            loading: false,
            error: errorMessage,
            lastManualRefreshAt: !errorMessage && isManual
              ? now
              : existing?.lastManualRefreshAt ?? null,
            lastUpdatedAt: errorMessage ? (existing?.lastUpdatedAt ?? null) : now,
          },
        }
      })

      onProbeResult?.({
        batchId,
        output,
        previousData,
        successful: errorMessage === null,
      })
    },
    [getErrorMessage, onProbeResult, updatePluginStates]
  )

  return {
    pluginStates,
    pluginStatesRef,
    manualRefreshIdsRef,
    setLoadingForPlugins,
    setErrorForPlugins,
    markResultsLost,
    handleProbeResult,
  }
}
