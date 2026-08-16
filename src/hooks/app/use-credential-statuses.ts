import { useCallback, useEffect, useRef } from "react"
import { invoke, isTauri } from "@tauri-apps/api/core"
import type { CredentialStatus } from "@/lib/plugin-types"
import type { PluginState } from "@/hooks/app/types"

type UseCredentialStatusesArgs = {
  pluginStates: Record<string, PluginState>
  setCredentialStatuses: (value: Record<string, CredentialStatus>) => void
  setLoadingForPlugins: (ids: string[]) => void
  setErrorForPlugins: (ids: string[], error: string) => void
  startBatch: (pluginIds?: string[]) => Promise<string[] | undefined>
}

/**
 * Loads per-plugin credential statuses and provides set/clear actions.
 * After a credential changes, statuses are refreshed and the plugin is
 * re-probed so its card picks up the new credential immediately.
 */
export function useCredentialStatuses({
  pluginStates,
  setCredentialStatuses,
  setLoadingForPlugins,
  setErrorForPlugins,
  startBatch,
}: UseCredentialStatusesArgs) {
  const latestStatuses = useRef<Record<string, CredentialStatus>>({})

  const refreshCredentialStatuses = useCallback(async () => {
    if (!isTauri()) return
    try {
      const statuses = await invoke<CredentialStatus[]>("get_credential_statuses")
      const byPlugin: Record<string, CredentialStatus> = {}
      for (const status of statuses) {
        byPlugin[status.pluginId] = status
      }
      latestStatuses.current = byPlugin
      setCredentialStatuses(byPlugin)
    } catch (error) {
      console.error("Failed to load credential statuses:", error)
    }
  }, [setCredentialStatuses])

  // Load once on mount alongside the rest of the bootstrap.
  useEffect(() => {
    void refreshCredentialStatuses()
  }, [refreshCredentialStatuses])

  // A successful probe proves the credential works; flip stale "not set"
  // statuses (e.g. the user logged in via a CLI outside the app). A failed
  // probe may mean an external credential was removed, so re-fetch the backend
  // statuses to demote stale "set" rows instead of keeping them forever.
  useEffect(() => {
    const updates: Record<string, CredentialStatus> = {}
    let shouldRefresh = false
    for (const [pluginId, state] of Object.entries(pluginStates)) {
      const status = latestStatuses.current[pluginId]
      if (!status || state.loading) continue
      if (state.data && !state.error) {
        if (!status.configured) updates[pluginId] = { ...status, configured: true }
      } else if (state.error && status.configured) {
        shouldRefresh = true
      }
    }
    if (shouldRefresh) void refreshCredentialStatuses()
    if (Object.keys(updates).length === 0) return
    latestStatuses.current = { ...latestStatuses.current, ...updates }
    setCredentialStatuses(latestStatuses.current)
  }, [pluginStates, setCredentialStatuses, refreshCredentialStatuses])

  const reprobePlugin = useCallback(
    (pluginId: string) => {
      setLoadingForPlugins([pluginId])
      startBatch([pluginId]).catch((error) => {
        console.error("Failed to start probe after credential change:", error)
        setErrorForPlugins([pluginId], "Failed to start probe")
      })
    },
    [setErrorForPlugins, setLoadingForPlugins, startBatch]
  )

  const handleSetCredential = useCallback(
    async (pluginId: string, value: string) => {
      await invoke("set_plugin_credential", { pluginId, value })
      await refreshCredentialStatuses()
      reprobePlugin(pluginId)
    },
    [refreshCredentialStatuses, reprobePlugin]
  )

  const handleClearCredential = useCallback(
    async (pluginId: string) => {
      await invoke("clear_plugin_credential", { pluginId })
      await refreshCredentialStatuses()
      reprobePlugin(pluginId)
    },
    [refreshCredentialStatuses, reprobePlugin]
  )

  return {
    refreshCredentialStatuses,
    handleSetCredential,
    handleClearCredential,
  }
}
