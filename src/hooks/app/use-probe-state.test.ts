import { renderHook, act } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { useProbeState } from "@/hooks/app/use-probe-state"

describe("useProbeState", () => {
  it("updates pluginStatesRef synchronously when marking plugins loading", () => {
    const { result } = renderHook(() => useProbeState({}))

    let loadingImmediatelyAfterSet: boolean | undefined
    act(() => {
      result.current.setLoadingForPlugins(["codex"])
      loadingImmediatelyAfterSet =
        result.current.pluginStatesRef.current.codex?.loading
    })

    expect(loadingImmediatelyAfterSet).toBe(true)
    expect(result.current.pluginStates.codex?.loading).toBe(true)
  })

  it("reports the batch id and previous successful data with each result", () => {
    const onProbeResult = vi.fn()
    const { result } = renderHook(() => useProbeState({ onProbeResult }))
    const firstOutput = {
      providerId: "codex",
      displayName: "Codex",
      iconUrl: "",
      lines: [],
    }
    const secondOutput = {
      ...firstOutput,
      lines: [{
        type: "progress" as const,
        label: "Session",
        used: 10,
        limit: 100,
        format: { kind: "percent" as const },
      }],
    }
    const errorOutput = {
      ...firstOutput,
      lines: [{ type: "badge" as const, label: "Error", text: "Offline" }],
    }

    act(() => {
      result.current.handleProbeResult(firstOutput, "batch-1")
      result.current.handleProbeResult(secondOutput, "batch-2")
      result.current.handleProbeResult(errorOutput, "batch-3")
    })

    expect(onProbeResult).toHaveBeenNthCalledWith(1, {
      batchId: "batch-1",
      output: firstOutput,
      previousData: null,
      successful: true,
    })
    expect(onProbeResult).toHaveBeenNthCalledWith(2, {
      batchId: "batch-2",
      output: secondOutput,
      previousData: firstOutput,
      successful: true,
    })
    expect(onProbeResult).toHaveBeenNthCalledWith(3, {
      batchId: "batch-3",
      output: errorOutput,
      previousData: secondOutput,
      successful: false,
    })
  })
})
