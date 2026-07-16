import { useCallback, useEffect } from "react"
import { invoke, isTauri } from "@tauri-apps/api/core"
import {
  disable as disableAutostart,
  enable as enableAutostart,
  isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart"
import type { PluginMeta } from "@/lib/plugin-types"
import {
  arePluginSettingsEqual,
  DEFAULT_AUTO_UPDATE_INTERVAL,
  DEFAULT_DISPLAY_MODE,
  DEFAULT_GLOBAL_SHORTCUT,
  DEFAULT_LOW_USAGE_ALERTS,
  DEFAULT_MENUBAR_ICON_STYLE,
  DEFAULT_MENUBAR_METRIC,
  DEFAULT_RESET_TIMER_DISPLAY_MODE,
  DEFAULT_START_ON_LOGIN,
  DEFAULT_THEME_MODE,
  DEFAULT_TIME_FORMAT_MODE,
  getEnabledPluginIds,
  loadAutoUpdateInterval,
  loadDisplayMode,
  loadGlobalShortcut,
  loadLowUsageAlerts,
  loadMenubarIconStyle,
  loadMenubarMetric,
  migrateLegacyTraySettings,
  migrateWindsurfToDevin,
  loadPluginSettings,
  loadResetTimerDisplayMode,
  loadStartOnLogin,
  loadThemeMode,
  loadTimeFormatMode,
  normalizePluginSettings,
  savePluginSettings,
  type AutoUpdateIntervalMinutes,
  type DisplayMode,
  type GlobalShortcut,
  type MenubarIconStyle,
  type MenubarMetric,
  type PluginSettings,
  type ResetTimerDisplayMode,
  type ThemeMode,
  type TimeFormatMode,
} from "@/lib/settings"

type UseSettingsBootstrapArgs = {
  setPluginSettings: (value: PluginSettings | null) => void
  setPluginsMeta: (value: PluginMeta[]) => void
  setAutoUpdateInterval: (value: AutoUpdateIntervalMinutes) => void
  setThemeMode: (value: ThemeMode) => void
  setDisplayMode: (value: DisplayMode) => void
  setResetTimerDisplayMode: (value: ResetTimerDisplayMode) => void
  setTimeFormatMode: (value: TimeFormatMode) => void
  setGlobalShortcut: (value: GlobalShortcut) => void
  setStartOnLogin: (value: boolean) => void
  setLowUsageAlerts: (value: boolean) => void
  setMenubarIconStyle: (value: MenubarIconStyle) => void
  setMenubarMetric: (value: MenubarMetric) => void
  setLoadingForPlugins: (ids: string[]) => void
  setErrorForPlugins: (ids: string[], error: string) => void
  startBatch: (pluginIds?: string[]) => Promise<string[] | undefined>
}

async function loadSetting<T>(
  loader: () => Promise<T>,
  fallback: T,
  label: string,
): Promise<T> {
  try {
    return await loader()
  } catch (error) {
    console.error(`Failed to load ${label}:`, error)
    return fallback
  }
}

export function useSettingsBootstrap({
  setPluginSettings,
  setPluginsMeta,
  setAutoUpdateInterval,
  setThemeMode,
  setDisplayMode,
  setResetTimerDisplayMode,
  setTimeFormatMode,
  setGlobalShortcut,
  setStartOnLogin,
  setLowUsageAlerts,
  setMenubarIconStyle,
  setMenubarMetric,
  setLoadingForPlugins,
  setErrorForPlugins,
  startBatch,
}: UseSettingsBootstrapArgs) {
  const applyStartOnLogin = useCallback(async (value: boolean) => {
    if (!isTauri()) return
    const currentlyEnabled = await isAutostartEnabled()
    if (currentlyEnabled === value) return

    if (value) {
      await enableAutostart()
      return
    }

    await disableAutostart()
  }, [])

  useEffect(() => {
    let isMounted = true

    const loadSettings = async () => {
      try {
        const [
          availablePlugins,
          storedSettings,
          storedInterval,
          storedThemeMode,
          storedDisplayMode,
          storedResetTimerDisplayMode,
          storedTimeFormatMode,
          storedGlobalShortcut,
          storedStartOnLogin,
          storedLowUsageAlerts,
        ] = await Promise.all([
          invoke<PluginMeta[]>("list_plugins"),
          loadPluginSettings(),
          loadSetting(loadAutoUpdateInterval, DEFAULT_AUTO_UPDATE_INTERVAL, "auto-update interval"),
          loadSetting(loadThemeMode, DEFAULT_THEME_MODE, "theme mode"),
          loadSetting(loadDisplayMode, DEFAULT_DISPLAY_MODE, "display mode"),
          loadSetting(
            loadResetTimerDisplayMode,
            DEFAULT_RESET_TIMER_DISPLAY_MODE,
            "reset timer display mode",
          ),
          loadSetting(loadTimeFormatMode, DEFAULT_TIME_FORMAT_MODE, "time format mode"),
          loadSetting(loadGlobalShortcut, DEFAULT_GLOBAL_SHORTCUT, "global shortcut"),
          loadSetting(loadStartOnLogin, DEFAULT_START_ON_LOGIN, "start on login"),
          loadSetting(loadLowUsageAlerts, DEFAULT_LOW_USAGE_ALERTS, "low usage alerts"),
        ])

        if (!isMounted) return
        setPluginsMeta(availablePlugins)

        const migratedSettings = migrateWindsurfToDevin(storedSettings)
        const normalized = normalizePluginSettings(migratedSettings, availablePlugins)
        if (!arePluginSettingsEqual(storedSettings, normalized)) {
          await savePluginSettings(normalized)
        }

        try {
          await applyStartOnLogin(storedStartOnLogin)
        } catch (error) {
          console.error("Failed to apply start on login setting:", error)
        }
        try {
          await migrateLegacyTraySettings()
        } catch (error) {
          console.error("Failed to migrate legacy tray settings:", error)
        }

        const [storedMenubarIconStyle, storedMenubarMetric] = await Promise.all([
          loadSetting(loadMenubarIconStyle, DEFAULT_MENUBAR_ICON_STYLE, "menubar icon style"),
          loadSetting(loadMenubarMetric, DEFAULT_MENUBAR_METRIC, "menubar metric"),
        ])

        if (isMounted) {
          setPluginSettings(normalized)
          setAutoUpdateInterval(storedInterval)
          setThemeMode(storedThemeMode)
          setDisplayMode(storedDisplayMode)
          setResetTimerDisplayMode(storedResetTimerDisplayMode)
          setTimeFormatMode(storedTimeFormatMode)
          setGlobalShortcut(storedGlobalShortcut)
          setStartOnLogin(storedStartOnLogin)
          setLowUsageAlerts(storedLowUsageAlerts)
          setMenubarIconStyle(storedMenubarIconStyle)
          setMenubarMetric(storedMenubarMetric)

          const enabledIds = getEnabledPluginIds(normalized)
          setLoadingForPlugins(enabledIds)
          try {
            await startBatch(enabledIds)
          } catch (error) {
            console.error("Failed to start probe batch:", error)
            if (isMounted) {
              setErrorForPlugins(enabledIds, "Failed to start probe")
            }
          }
        }
      } catch (e) {
        console.error("Failed to load plugin settings:", e)
      }
    }

    loadSettings()

    return () => {
      isMounted = false
    }
  }, [
    applyStartOnLogin,
    setAutoUpdateInterval,
    setDisplayMode,
    setErrorForPlugins,
    setGlobalShortcut,
    setLoadingForPlugins,
    setMenubarIconStyle,
    setMenubarMetric,
    setPluginSettings,
    setPluginsMeta,
    setResetTimerDisplayMode,
    setStartOnLogin,
    setLowUsageAlerts,
    setThemeMode,
    setTimeFormatMode,
    startBatch,
  ])

  return {
    applyStartOnLogin,
  }
}
