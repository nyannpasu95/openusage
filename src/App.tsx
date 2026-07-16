import { useCallback, useEffect, useMemo, useRef } from "react"
import { useShallow } from "zustand/react/shallow"
import { AppShell } from "@/components/app/app-shell"
import { useAppPluginViews } from "@/hooks/app/use-app-plugin-views"
import { useProbe } from "@/hooks/app/use-probe"
import { useSettingsBootstrap } from "@/hooks/app/use-settings-bootstrap"
import { useSettingsDisplayActions } from "@/hooks/app/use-settings-display-actions"
import { useSettingsPluginActions } from "@/hooks/app/use-settings-plugin-actions"
import { useSettingsPluginList } from "@/hooks/app/use-settings-plugin-list"
import { useSettingsSystemActions } from "@/hooks/app/use-settings-system-actions"
import { useSettingsTheme } from "@/hooks/app/use-settings-theme"
import { useTrayIcon } from "@/hooks/app/use-tray-icon"
import { REFRESH_COOLDOWN_MS, getEnabledPluginIds, savePluginSettings } from "@/lib/settings"
import { getLowUsageAlert, sendLowUsageAlert } from "@/lib/low-usage-alerts"
import {
  getTrayUsageIncrease,
  pickLargestTrayUsageIncrease,
  type TrayUsageIncrease,
} from "@/lib/tray-usage-change"
import { type PluginContextAction } from "@/components/side-nav"
import type { ProbeResultUpdate } from "@/hooks/app/types"
import { useAppPluginStore } from "@/stores/app-plugin-store"
import { useAppPreferencesStore } from "@/stores/app-preferences-store"
import { useAppUiStore } from "@/stores/app-ui-store"

const TRAY_PROBE_DEBOUNCE_MS = 500
const TRAY_SETTINGS_DEBOUNCE_MS = 2000

function App() {
  const {
    activeView,
    setActiveView,
  } = useAppUiStore(
    useShallow((state) => ({
      activeView: state.activeView,
      setActiveView: state.setActiveView,
    }))
  )

  const {
    pluginsMeta,
    setPluginsMeta,
    pluginSettings,
    setPluginSettings,
  } = useAppPluginStore(
    useShallow((state) => ({
      pluginsMeta: state.pluginsMeta,
      setPluginsMeta: state.setPluginsMeta,
      pluginSettings: state.pluginSettings,
      setPluginSettings: state.setPluginSettings,
    }))
  )

  const {
    autoUpdateInterval,
    setAutoUpdateInterval,
    themeMode,
    setThemeMode,
    displayMode,
    setDisplayMode,
    menubarIconStyle,
    setMenubarIconStyle,
    menubarMetric,
    setMenubarMetric,
    resetTimerDisplayMode,
    setResetTimerDisplayMode,
    setTimeFormatMode,
    setGlobalShortcut,
    setStartOnLogin,
    lowUsageAlerts,
    setLowUsageAlerts,
  } = useAppPreferencesStore(
    useShallow((state) => ({
      autoUpdateInterval: state.autoUpdateInterval,
      setAutoUpdateInterval: state.setAutoUpdateInterval,
      themeMode: state.themeMode,
      setThemeMode: state.setThemeMode,
      displayMode: state.displayMode,
      setDisplayMode: state.setDisplayMode,
      menubarIconStyle: state.menubarIconStyle,
      setMenubarIconStyle: state.setMenubarIconStyle,
      menubarMetric: state.menubarMetric,
      setMenubarMetric: state.setMenubarMetric,
      resetTimerDisplayMode: state.resetTimerDisplayMode,
      setResetTimerDisplayMode: state.setResetTimerDisplayMode,
      setTimeFormatMode: state.setTimeFormatMode,
      setGlobalShortcut: state.setGlobalShortcut,
      setStartOnLogin: state.setStartOnLogin,
      lowUsageAlerts: state.lowUsageAlerts,
      setLowUsageAlerts: state.setLowUsageAlerts,
    }))
  )

  const probeResultHandlerRef = useRef<(update: ProbeResultUpdate) => void>(() => {})
  const probeBatchCompleteHandlerRef = useRef<(batchId: string) => void>(() => {})
  const usageCandidatesByBatchRef = useRef<Map<string, Map<string, TrayUsageIncrease>>>(new Map())
  const handleProbeResult = useCallback((update: ProbeResultUpdate) => {
    probeResultHandlerRef.current(update)
  }, [])
  const handleProbeBatchComplete = useCallback((batchId: string) => {
    probeBatchCompleteHandlerRef.current(batchId)
  }, [])

  const {
    pluginStates,
    setLoadingForPlugins,
    setErrorForPlugins,
    startBatch,
    autoUpdateNextAt,
    setAutoUpdateNextAt,
    handleRetryPlugin,
    handleRefreshAll,
  } = useProbe({
    pluginSettings,
    autoUpdateInterval,
    onProbeResult: handleProbeResult,
    onProbeBatchComplete: handleProbeBatchComplete,
  })

  const {
    scheduleTrayIconUpdate,
    selectTrayProvider,
    traySettingsPreview,
  } = useTrayIcon({
    pluginsMeta,
    pluginSettings,
    pluginStates,
    displayMode,
    menubarIconStyle,
    menubarMetric,
    activeView,
  })

  useEffect(() => {
    probeResultHandlerRef.current = (update) => {
      scheduleTrayIconUpdate("probe", TRAY_PROBE_DEBOUNCE_MS)

      if (!update.successful || !update.previousData) return
      if (lowUsageAlerts) {
        const alert = getLowUsageAlert(update.previousData, update.output)
        if (alert) {
          void sendLowUsageAlert(alert).catch((error) => {
            console.error("Failed to send low usage alert:", error)
          })
        }
      }
      const meta = pluginsMeta.find((plugin) => plugin.id === update.output.providerId)
      if (!meta) return

      const increase = getTrayUsageIncrease({
        meta,
        previousData: update.previousData,
        nextData: update.output,
        preferWeekly: menubarMetric === "weekly",
      })
      if (!increase) return

      let candidates = usageCandidatesByBatchRef.current.get(update.batchId)
      if (!candidates) {
        candidates = new Map()
        usageCandidatesByBatchRef.current.set(update.batchId, candidates)
      }
      candidates.set(increase.providerId, increase)
    }

    probeBatchCompleteHandlerRef.current = (batchId) => {
      const candidates = usageCandidatesByBatchRef.current.get(batchId)
      usageCandidatesByBatchRef.current.delete(batchId)
      if (!candidates || candidates.size === 0) return

      const selected = pickLargestTrayUsageIncrease(
        candidates.values(),
        pluginSettings?.order ?? [],
      )
      if (selected) selectTrayProvider(selected.providerId)
    }
  }, [lowUsageAlerts, menubarMetric, pluginSettings, pluginsMeta, scheduleTrayIconUpdate, selectTrayProvider])

  useEffect(() => () => {
    usageCandidatesByBatchRef.current.clear()
  }, [])

  const { applyStartOnLogin } = useSettingsBootstrap({
    setPluginSettings,
    setPluginsMeta,
    setAutoUpdateInterval,
    setThemeMode,
    setDisplayMode,
    setMenubarIconStyle,
    setMenubarMetric,
    setResetTimerDisplayMode,
    setTimeFormatMode,
    setGlobalShortcut,
    setStartOnLogin,
    setLowUsageAlerts,
    setLoadingForPlugins,
    setErrorForPlugins,
    startBatch,
  })

  useSettingsTheme(themeMode)

  const {
    handleThemeModeChange,
    handleDisplayModeChange,
    handleResetTimerDisplayModeChange,
    handleResetTimerDisplayModeToggle,
    handleTimeFormatModeChange,
    handleMenubarIconStyleChange,
    handleMenubarMetricChange,
  } = useSettingsDisplayActions({
    setThemeMode,
    setDisplayMode,
    resetTimerDisplayMode,
    setResetTimerDisplayMode,
    setTimeFormatMode,
    setMenubarIconStyle,
    setMenubarMetric,
    scheduleTrayIconUpdate,
  })

  const {
    handleAutoUpdateIntervalChange,
    handleGlobalShortcutChange,
    handleStartOnLoginChange,
    handleLowUsageAlertsChange,
  } = useSettingsSystemActions({
    pluginSettings,
    setAutoUpdateInterval,
    setAutoUpdateNextAt,
    setGlobalShortcut,
    setStartOnLogin,
    setLowUsageAlerts,
    applyStartOnLogin,
  })

  const {
    handleReorder,
    handleToggle,
  } = useSettingsPluginActions({
    pluginSettings,
    setPluginSettings,
    setLoadingForPlugins,
    setErrorForPlugins,
    startBatch,
    scheduleTrayIconUpdate,
  })

  const settingsPlugins = useSettingsPluginList({
    pluginSettings,
    pluginsMeta,
  })

  const { displayPlugins, navPlugins, selectedPlugin } = useAppPluginViews({
    activeView,
    setActiveView,
    pluginSettings,
    pluginsMeta,
    pluginStates,
  })

  const pluginSettingsRef = useRef(pluginSettings)
  useEffect(() => {
    pluginSettingsRef.current = pluginSettings
  }, [pluginSettings])

  const handlePluginContextAction = useCallback(
    (pluginId: string, action: PluginContextAction) => {
      if (action === "reload") {
        handleRetryPlugin(pluginId)
        return
      }

      const currentSettings = pluginSettingsRef.current
      if (!currentSettings) return
      const alreadyDisabled = currentSettings.disabled.includes(pluginId)
      if (alreadyDisabled) return

      const nextSettings = {
        ...currentSettings,
        disabled: [...currentSettings.disabled, pluginId],
      }
      setPluginSettings(nextSettings)
      scheduleTrayIconUpdate("settings", TRAY_SETTINGS_DEBOUNCE_MS)
      void savePluginSettings(nextSettings).catch((error) => {
        console.error("Failed to save plugin toggle:", error)
      })

      if (activeView === pluginId) {
        setActiveView("home")
      }
    },
    [activeView, handleRetryPlugin, scheduleTrayIconUpdate, setActiveView, setPluginSettings]
  )

  const isPluginRefreshAvailable = useCallback(
    (pluginId: string) => {
      const pluginState = pluginStates[pluginId]
      if (!pluginState) return true
      if (pluginState.loading) return false
      if (!pluginState.lastManualRefreshAt) return true
      return Date.now() - pluginState.lastManualRefreshAt >= REFRESH_COOLDOWN_MS
    },
    [pluginStates]
  )

  const { isRefreshing, refreshCooldownEndsAt, lastUpdatedAt } = useMemo(() => {
    if (!pluginSettings) return { isRefreshing: false, refreshCooldownEndsAt: null, lastUpdatedAt: null }
    const enabledIds = getEnabledPluginIds(pluginSettings)
    const states = enabledIds
      .map((id) => pluginStates[id])
      .filter((s): s is NonNullable<typeof s> => Boolean(s))
    const refreshing = states.some((s) => s.loading)
    // "Last updated" = the most recent successful probe across all enabled
    // plugins (auto or manual). Reflects when the displayed data was fetched.
    const latestUpdated = states.reduce<number | null>((max, s) => {
      const at = s.lastUpdatedAt
      if (at === null) return max
      return max === null || at > max ? at : max
    }, null)
    // If any enabled plugin has never been manually refreshed, the cooldown
    // does not apply (a manual refresh is always possible). Otherwise the
    // button is on cooldown until the most-recently-refreshed plugin clears it.
    const hasEligible = states.some((s) => !s.lastManualRefreshAt)
    if (hasEligible) return { isRefreshing: refreshing, refreshCooldownEndsAt: null, lastUpdatedAt: latestUpdated }
    const latestRefresh = states.reduce<number | null>((max, s) => {
      const at = s.lastManualRefreshAt ?? 0
      return max === null || at > max ? at : max
    }, null)
    const endsAt = latestRefresh === null ? null : latestRefresh + REFRESH_COOLDOWN_MS
    return { isRefreshing: refreshing, refreshCooldownEndsAt: endsAt, lastUpdatedAt: latestUpdated }
  }, [pluginSettings, pluginStates])

  return (
    <AppShell
      onRefreshAll={handleRefreshAll}
      navPlugins={navPlugins}
      displayPlugins={displayPlugins}
      settingsPlugins={settingsPlugins}
      autoUpdateNextAt={autoUpdateNextAt}
      isRefreshing={isRefreshing}
      refreshCooldownEndsAt={refreshCooldownEndsAt}
      lastUpdatedAt={lastUpdatedAt}
      selectedPlugin={selectedPlugin}
      onPluginContextAction={handlePluginContextAction}
      isPluginRefreshAvailable={isPluginRefreshAvailable}
      onNavReorder={handleReorder}
      appContentProps={{
        onRetryPlugin: handleRetryPlugin,
        onReorder: handleReorder,
        onToggle: handleToggle,
        onAutoUpdateIntervalChange: handleAutoUpdateIntervalChange,
        onThemeModeChange: handleThemeModeChange,
        onDisplayModeChange: handleDisplayModeChange,
        onResetTimerDisplayModeChange: handleResetTimerDisplayModeChange,
        onResetTimerDisplayModeToggle: handleResetTimerDisplayModeToggle,
        onTimeFormatModeChange: handleTimeFormatModeChange,
        onMenubarIconStyleChange: handleMenubarIconStyleChange,
        onMenubarMetricChange: handleMenubarMetricChange,
        traySettingsPreview,
        onGlobalShortcutChange: handleGlobalShortcutChange,
        onStartOnLoginChange: handleStartOnLoginChange,
        onLowUsageAlertsChange: handleLowUsageAlertsChange,
      }}
    />
  )
}

export { App }
