import { useCallback } from "react"
import { Settings } from "lucide-react"
import { invoke } from "@tauri-apps/api/core"
import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu"
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { cn } from "@/lib/utils"
import { OhMyUsageLogo } from "@/components/ohmyusage-logo"

type ActiveView = "home" | "settings" | string

type PluginContextAction = "reload" | "remove"

interface NavPlugin {
  id: string
  name: string
  iconUrl: string
  brandColor?: string
}

interface SideNavProps {
  activeView: ActiveView
  onViewChange: (view: ActiveView) => void
  plugins: NavPlugin[]
  onPluginContextAction?: (pluginId: string, action: PluginContextAction) => void
  isPluginRefreshAvailable?: (pluginId: string) => boolean
  onReorder?: (orderedIds: string[]) => void
}

interface NavButtonProps {
  isActive: boolean
  onClick: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  children: React.ReactNode
  "aria-label"?: string
}

function NavButton({ isActive, onClick, onContextMenu, children, "aria-label": ariaLabel }: NavButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      aria-label={ariaLabel}
      className={cn(
        "relative mx-2 flex size-9 items-center justify-center rounded-md border border-transparent transition-colors",
        isActive
          ? "border-foreground bg-foreground text-background hover:bg-foreground/85"
          : "text-muted-foreground hover:border-border-strong hover:bg-sidebar-accent hover:text-foreground"
      )}
    >
      {children}
    </button>
  )
}

interface SortableNavPluginProps {
  plugin: NavPlugin
  isActive: boolean
  onClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
}

function SortableNavPlugin({ plugin, isActive, onClick, onContextMenu }: SortableNavPluginProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: plugin.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  }

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners} role="presentation">
      <NavButton
        isActive={isActive}
        onClick={onClick}
        onContextMenu={onContextMenu}
        aria-label={plugin.name}
      >
        <span
          role="img"
          aria-label={plugin.name}
          className="size-5 inline-block"
          style={{
            backgroundColor: "currentColor",
            WebkitMaskImage: `url(${plugin.iconUrl})`,
            WebkitMaskSize: "contain",
            WebkitMaskRepeat: "no-repeat",
            WebkitMaskPosition: "center",
            maskImage: `url(${plugin.iconUrl})`,
            maskSize: "contain",
            maskRepeat: "no-repeat",
            maskPosition: "center",
          }}
        />
      </NavButton>
    </div>
  )
}

export function SideNav({
  activeView,
  onViewChange,
  plugins,
  onPluginContextAction,
  isPluginRefreshAvailable,
  onReorder,
}: SideNavProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { delay: 300, tolerance: 5 },
    })
  )

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (!onReorder) return
      const { active, over } = event
      if (over && active.id !== over.id) {
        const oldIndex = plugins.findIndex((p) => p.id === active.id)
        const newIndex = plugins.findIndex((p) => p.id === over.id)
        if (oldIndex === -1 || newIndex === -1) return
        const next = arrayMove(plugins, oldIndex, newIndex)
        onReorder(next.map((p) => p.id))
      }
    },
    [onReorder, plugins]
  )

  const handlePluginContextMenu = useCallback(
    (e: React.MouseEvent, pluginId: string) => {
      e.preventDefault()
      if (!onPluginContextAction) return

      ;(async () => {
        const reloadItem = await MenuItem.new({
          id: `ctx-reload-${pluginId}`,
          text: "Refresh usage",
          enabled: isPluginRefreshAvailable ? isPluginRefreshAvailable(pluginId) : true,
          action: () => onPluginContextAction(pluginId, "reload"),
        })
        const removeItem = await MenuItem.new({
          id: `ctx-remove-${pluginId}`,
          text: "Disable plugin",
          action: () => onPluginContextAction(pluginId, "remove"),
        })
        const bottomSeparator = await PredefinedMenuItem.new({ item: "Separator" })
        const inspectItem = await MenuItem.new({
          id: `ctx-inspect-${pluginId}`,
          text: "Inspect Element",
          action: () => {
            invoke("open_devtools").catch(console.error)
          },
        })
        const menu = await Menu.new({
          items: [reloadItem, removeItem, bottomSeparator, inspectItem],
        })
        try {
          await menu.popup()
        } finally {
          await Promise.allSettled([
            menu.close(),
            reloadItem.close(),
            removeItem.close(),
            bottomSeparator.close(),
            inspectItem.close(),
          ])
        }
      })().catch(console.error)
    },
    [isPluginRefreshAvailable, onPluginContextAction]
  )

  return (
    <nav className="flex w-[52px] flex-col border-r bg-sidebar py-2.5">
      {/* Home */}
      <NavButton
        isActive={activeView === "home"}
        onClick={() => onViewChange("home")}
        aria-label="Home"
      >
        <OhMyUsageLogo className="size-5" />
      </NavButton>

      {/* Plugin icons */}
      <div className="flex flex-1 min-h-0 flex-col overflow-y-auto scrollbar-none">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={plugins.map((p) => p.id)}
            strategy={verticalListSortingStrategy}
          >
            {plugins.map((plugin) => (
              <SortableNavPlugin
                key={plugin.id}
                plugin={plugin}
                isActive={activeView === plugin.id}
                onClick={() => onViewChange(plugin.id)}
                onContextMenu={(e) => handlePluginContextMenu(e, plugin.id)}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>

      {/* Settings */}
      <NavButton
        isActive={activeView === "settings"}
        onClick={() => onViewChange("settings")}
        aria-label="Settings"
      >
        <Settings className="size-5" />
      </NavButton>
    </nav>
  )
}

export type { ActiveView, NavPlugin, PluginContextAction }
