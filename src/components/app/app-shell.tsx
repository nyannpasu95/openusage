import { useShallow } from "zustand/react/shallow"
import { AppContent, type AppContentActionProps } from "@/components/app/app-content"
import { PanelFooter } from "@/components/panel-footer"
import { SideNav, type NavPlugin, type PluginContextAction } from "@/components/side-nav"
import type { DisplayPluginState } from "@/hooks/app/use-app-plugin-views"
import type { SettingsPluginState } from "@/hooks/app/use-settings-plugin-list"
import { usePanel } from "@/hooks/app/use-panel"
import { useAppUpdate } from "@/hooks/use-app-update"
import { useAppUiStore } from "@/stores/app-ui-store"

type AppShellProps = {
  onRefreshAll: () => void
  navPlugins: NavPlugin[]
  displayPlugins: DisplayPluginState[]
  settingsPlugins: SettingsPluginState[]
  autoUpdateNextAt: number | null
  isRefreshing: boolean
  refreshCooldownEndsAt: number | null
  lastUpdatedAt: number | null
  selectedPlugin: DisplayPluginState | null
  onPluginContextAction: (pluginId: string, action: PluginContextAction) => void
  isPluginRefreshAvailable: (pluginId: string) => boolean
  onNavReorder: (orderedIds: string[]) => void
  appContentProps: AppContentActionProps
}

export function AppShell({
  onRefreshAll,
  navPlugins,
  displayPlugins,
  settingsPlugins,
  autoUpdateNextAt,
  isRefreshing,
  refreshCooldownEndsAt,
  lastUpdatedAt,
  selectedPlugin,
  onPluginContextAction,
  isPluginRefreshAvailable,
  onNavReorder,
  appContentProps,
}: AppShellProps) {
  const {
    activeView,
    setActiveView,
    showAbout,
    setShowAbout,
  } = useAppUiStore(
    useShallow((state) => ({
      activeView: state.activeView,
      setActiveView: state.setActiveView,
      showAbout: state.showAbout,
      setShowAbout: state.setShowAbout,
    }))
  )

  const {
    containerRef,
    scrollRef,
    canScrollDown,
    panelHeightPx,
  } = usePanel({
    activeView,
    setActiveView,
    showAbout,
    setShowAbout,
    displayPlugins,
  })

  const { updateStatus, triggerInstall, checkForUpdates } = useAppUpdate()

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className="flex flex-col items-center bg-transparent px-3 pb-3 pt-1.5 outline-none"
      style={{ height: `${panelHeightPx}px` }}
    >
      <div className="tray-arrow" />
      <div
        className="relative flex min-h-0 w-full flex-1 select-none flex-col overflow-hidden rounded-lg border bg-card shadow-lg"
      >
        <div className="flex flex-1 min-h-0 flex-row">
          <SideNav
            activeView={activeView}
            onViewChange={setActiveView}
            plugins={navPlugins}
            onPluginContextAction={onPluginContextAction}
            isPluginRefreshAvailable={isPluginRefreshAvailable}
            onReorder={onNavReorder}
          />
          <div className="flex min-w-0 flex-1 flex-col bg-card px-3.5 pb-2 pt-3">
            <div className="relative flex-1 min-h-0">
              <div ref={scrollRef} className="h-full overflow-y-auto scrollbar-none">
                <AppContent
                  {...appContentProps}
                  displayPlugins={displayPlugins}
                  settingsPlugins={settingsPlugins}
                  selectedPlugin={selectedPlugin}
                />
              </div>
              <div
                className={`pointer-events-none absolute inset-x-0 bottom-0 h-px bg-border-strong transition-opacity duration-200 ${canScrollDown ? "opacity-100" : "opacity-0"}`}
              />
            </div>
            <PanelFooter
              autoUpdateNextAt={autoUpdateNextAt}
              updateStatus={updateStatus}
              onUpdateInstall={triggerInstall}
              onUpdateCheck={checkForUpdates}
              onRefreshAll={onRefreshAll}
              isRefreshing={isRefreshing}
              refreshCooldownEndsAt={refreshCooldownEndsAt}
              lastUpdatedAt={lastUpdatedAt}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
