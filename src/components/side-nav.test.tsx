import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { SideNav } from "@/components/side-nav"

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}))

describe("SideNav", () => {
  it("calls onViewChange for Home and Settings", async () => {
    const onViewChange = vi.fn()
    render(<SideNav activeView="home" onViewChange={onViewChange} plugins={[]} />)

    await userEvent.click(screen.getByRole("button", { name: "Settings" }))
    expect(onViewChange).toHaveBeenCalledWith("settings")

    await userEvent.click(screen.getByRole("button", { name: "Home" }))
    expect(onViewChange).toHaveBeenCalledWith("home")
  })

  it("renders plugin icons in the monochrome navigation color", () => {
    const onViewChange = vi.fn()
    render(
      <SideNav
        activeView="home"
        onViewChange={onViewChange}
        plugins={[
          { id: "p1", name: "Plugin 1", iconUrl: "icon.svg", brandColor: "#ff0000" },
        ]}
      />
    )

    const btn = screen.getByRole("button", { name: "Plugin 1" })
    expect(btn).toBeInTheDocument()

    const icon = screen.getByRole("img", { name: "Plugin 1" })
    expect(icon.getAttribute("style") ?? "").toMatch(/background-color:\s*currentcolor/i)
  })

  it("does not reintroduce provider brand colors", () => {
    const onViewChange = vi.fn()
    render(
      <SideNav
        activeView="home"
        onViewChange={onViewChange}
        plugins={[
          { id: "p1", name: "P1", iconUrl: "icon.svg", brandColor: "#00ff00" },
          { id: "p2", name: "P2", iconUrl: "icon.svg", brandColor: "#ff0000" },
        ]}
      />
    )

    for (const name of ["P1", "P2"]) {
      const style = screen.getByRole("img", { name }).getAttribute("style") ?? ""
      expect(style).toMatch(/background-color:\s*currentcolor/i)
      expect(style).not.toMatch(/00ff00|ff0000/i)
    }
  })

  it("does not render the removed Help shortcut", () => {
    const onViewChange = vi.fn()
    render(<SideNav activeView="home" onViewChange={onViewChange} plugins={[]} />)

    expect(screen.queryByRole("button", { name: "Help" })).not.toBeInTheDocument()
  })
})
