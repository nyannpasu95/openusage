import { useCallback, useEffect, useRef, useState } from "react"
import { invoke, isTauri } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { getCurrentWindow, PhysicalSize, currentMonitor } from "@tauri-apps/api/window"
import type { ActiveView } from "@/components/side-nav"
import type { DisplayPluginState } from "@/hooks/app/use-app-plugin-views"

const PANEL_WIDTH = 400
const PANEL_HEIGHT = 500
const MAX_HEIGHT_FALLBACK_PX = 600
const MAX_HEIGHT_FRACTION_OF_MONITOR = 0.8

type UsePanelArgs = {
  activeView: ActiveView
  setActiveView: (view: ActiveView) => void
  showAbout: boolean
  setShowAbout: (value: boolean) => void
  displayPlugins: DisplayPluginState[]
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false

  if (target.isContentEditable) return true
  if (target.closest("input, textarea, select, [contenteditable='true'], [role='textbox']")) {
    return true
  }

  return false
}

export function usePanel({
  activeView,
  setActiveView,
  showAbout,
  setShowAbout,
  displayPlugins,
}: UsePanelArgs) {
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [canScrollDown, setCanScrollDown] = useState(false)
  const [panelHeightPx, setPanelHeightPx] = useState(PANEL_HEIGHT)
  const panelHeightPxRef = useRef(PANEL_HEIGHT)
  const focusContainer = useCallback(() => {
    window.requestAnimationFrame(() => {
      containerRef.current?.focus({ preventScroll: true })
    })
  }, [])

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        focusContainer()
      }
    }

    window.addEventListener("focus", focusContainer)
    document.addEventListener("visibilitychange", handleVisibilityChange)

    return () => {
      window.removeEventListener("focus", focusContainer)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    }
  }, [focusContainer])

  useEffect(() => {
    if (!isTauri()) return
    invoke("init_panel").catch(console.error)
  }, [])

  useEffect(() => {
    if (!isTauri()) return
    if (showAbout) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        invoke("hide_panel")
      }
    }

    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [showAbout])

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    const unlisteners: (() => void)[] = []

    async function setup() {
      const u1 = await listen<string>("tray:navigate", (event) => {
        setActiveView(event.payload as ActiveView)
        focusContainer()
      })
      if (cancelled) {
        u1()
        return
      }
      unlisteners.push(u1)

      const u2 = await listen("tray:show-about", () => {
        setShowAbout(true)
        focusContainer()
      })
      if (cancelled) {
        u2()
        return
      }
      unlisteners.push(u2)
    }

    void setup()

    return () => {
      cancelled = true
      for (const fn of unlisteners) fn()
    }
  }, [focusContainer, setActiveView, setShowAbout])

  useEffect(() => {
    if (showAbout) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
      if (isEditableTarget(event.target)) return

      const views: ActiveView[] = ["home", ...displayPlugins.map((plugin) => plugin.meta.id)]
      if (views.length === 0) return

      let nextView: ActiveView | undefined

      if (activeView === "settings") {
        nextView = event.key === "ArrowUp" ? views[views.length - 1] : views[0]
      } else {
        const currentIndex = views.indexOf(activeView)
        if (currentIndex === -1) return
        const offset = event.key === "ArrowUp" ? -1 : 1
        nextView = views[(currentIndex + offset + views.length) % views.length]
      }

      if (!nextView || nextView === activeView) return

      event.preventDefault()
      setActiveView(nextView)
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [activeView, displayPlugins, setActiveView, showAbout])

  // biome-ignore lint/correctness/useExhaustiveDependencies: Active view changes must reset the shared scroll container.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    el.scrollTop = 0
  }, [activeView])

  // biome-ignore lint/correctness/useExhaustiveDependencies: View and plugin changes can reposition the panel and must recheck the monitor cap.
  useEffect(() => {
    if (!isTauri()) return

    const resizeWindow = async () => {
      const factor = window.devicePixelRatio
      const width = Math.ceil(PANEL_WIDTH * factor)

      let maxHeightPhysical: number | null = null
      let maxHeightLogical: number | null = null

      try {
        const monitor = await currentMonitor()
        if (monitor) {
          maxHeightPhysical = Math.floor(monitor.size.height * MAX_HEIGHT_FRACTION_OF_MONITOR)
          maxHeightLogical = Math.floor(maxHeightPhysical / factor)
        }
      } catch {
        // fall through to fallback
      }

      if (maxHeightLogical === null) {
        const screenAvailHeight = Number(window.screen?.availHeight) || MAX_HEIGHT_FALLBACK_PX
        maxHeightLogical = Math.floor(screenAvailHeight * MAX_HEIGHT_FRACTION_OF_MONITOR)
        maxHeightPhysical = Math.floor(maxHeightLogical * factor)
      }

      const stableHeightLogical = Math.min(PANEL_HEIGHT, maxHeightLogical)
      if (panelHeightPxRef.current !== stableHeightLogical) {
        panelHeightPxRef.current = stableHeightLogical
        setPanelHeightPx(stableHeightLogical)
      }

      const height = Math.ceil(Math.min(stableHeightLogical * factor, maxHeightPhysical!))

      try {
        const currentWindow = getCurrentWindow()
        await currentWindow.setSize(new PhysicalSize(width, height))
      } catch (e) {
        console.error("Failed to resize window:", e)
      }
    }

    resizeWindow()
  }, [activeView, displayPlugins])

  // biome-ignore lint/correctness/useExhaustiveDependencies: View changes replace scroll content and must refresh the observer state.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const check = () => {
      setCanScrollDown(el.scrollHeight - el.scrollTop - el.clientHeight > 1)
    }

    check()
    el.addEventListener("scroll", check, { passive: true })

    const ro = new ResizeObserver(check)
    ro.observe(el)

    const mo = new MutationObserver(check)
    mo.observe(el, { childList: true, subtree: true })

    return () => {
      el.removeEventListener("scroll", check)
      ro.disconnect()
      mo.disconnect()
    }
  }, [activeView])

  return {
    containerRef,
    scrollRef,
    canScrollDown,
    panelHeightPx,
  }
}
