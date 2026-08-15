import { renderHook, act } from "@testing-library/react"
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import type { PluginOutput } from "@/lib/plugin-types"

const { listeners, invokeMock, listenMock } = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: any }) => void>(),
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}))

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}))

import { useProbeEvents } from "@/hooks/use-probe-events"

const pluginOutput = (providerId: string): PluginOutput => ({
  providerId,
  displayName: providerId.toUpperCase(),
  lines: [],
  iconUrl: "",
})

describe("useProbeEvents", () => {
  beforeEach(() => {
    listeners.clear()
    invokeMock.mockReset()
    listenMock.mockReset()
    listenMock.mockImplementation(async (event: string, cb: (event: { payload: any }) => void) => {
      listeners.set(event, cb)
      return () => listeners.delete(event)
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("starts batch and returns plugin ids", async () => {
    invokeMock.mockImplementation(async (_cmd: string, args: any) => ({
      batchId: args.batchId,
      pluginIds: args.pluginIds ?? [],
    }))
    const onResult = vi.fn()
    const onBatchComplete = vi.fn()
    const { result } = renderHook(() => useProbeEvents({ onResult, onBatchComplete }))

    const ids = await act(() => result.current.startBatch(["a", "b"]))
    expect(invokeMock).toHaveBeenCalledWith("start_probe_batch", expect.objectContaining({ pluginIds: ["a", "b"] }))
    expect(ids).toEqual(["a", "b"])
  })

  it("starts batch without plugin ids and uses fallback id", async () => {
    const originalCrypto = globalThis.crypto
    // @ts-expect-error test fallback path
    delete globalThis.crypto
    try {
      invokeMock.mockImplementation(async (_cmd: string, args: any) => ({
        batchId: args.batchId,
        pluginIds: args.pluginIds ?? [],
      }))
      const { result } = renderHook(() =>
        useProbeEvents({ onResult: vi.fn(), onBatchComplete: vi.fn() })
      )
      const ids = await act(() => result.current.startBatch())
      expect(ids).toEqual([])
      expect(invokeMock).toHaveBeenCalledWith(
        "start_probe_batch",
        expect.objectContaining({ batchId: expect.stringMatching(/^batch-/) })
      )
    } finally {
      if (originalCrypto === undefined) {
        // @ts-expect-error cleanup undefined crypto
        delete globalThis.crypto
      } else {
        globalThis.crypto = originalCrypto
      }
    }
  })

  it("uses crypto randomUUID when available", async () => {
    const originalCrypto = globalThis.crypto
    // @ts-expect-error test randomUUID path
    globalThis.crypto = { randomUUID: vi.fn(() => "uuid-123") }
    try {
      invokeMock.mockImplementation(async (_cmd: string, args: any) => ({
        batchId: args.batchId,
        pluginIds: args.pluginIds ?? [],
      }))
      const { result } = renderHook(() =>
        useProbeEvents({ onResult: vi.fn(), onBatchComplete: vi.fn() })
      )
      await act(() => result.current.startBatch())
      expect(globalThis.crypto?.randomUUID).toHaveBeenCalled()
      expect(invokeMock).toHaveBeenCalledWith(
        "start_probe_batch",
        expect.objectContaining({ batchId: "uuid-123" })
      )
    } finally {
      globalThis.crypto = originalCrypto
    }
  })

  it("starts batch after unmount without waiting for listeners", async () => {
    invokeMock.mockImplementation(async (_cmd: string, args: any) => ({
      batchId: args.batchId,
      pluginIds: args.pluginIds ?? [],
    }))
    const { result, unmount } = renderHook(() =>
      useProbeEvents({ onResult: vi.fn(), onBatchComplete: vi.fn() })
    )
    const start = result.current.startBatch
    unmount()
    const ids = await act(() => start())
    expect(ids).toEqual([])
    expect(invokeMock).toHaveBeenCalled()
  })

  it("routes probe events to active batch", async () => {
    let lastArgs: any = null
    invokeMock.mockImplementation(async (_cmd: string, args: any) => {
      lastArgs = args
      return { batchId: args.batchId, pluginIds: args.pluginIds ?? [] }
    })
    const onResult = vi.fn()
    const onBatchComplete = vi.fn()
    const { result } = renderHook(() => useProbeEvents({ onResult, onBatchComplete }))

    await act(() => result.current.startBatch(["a"]))
    const batchId = lastArgs.batchId

    const output = { providerId: "a", displayName: "A", lines: [], iconUrl: "" } satisfies PluginOutput
    const resultListener = listeners.get("probe:result")
    const completeListener = listeners.get("probe:batch-complete")
    resultListener?.({ payload: { batchId, output } })
    expect(onResult).toHaveBeenCalledWith(output, batchId)

    completeListener?.({ payload: { batchId } })
    expect(onBatchComplete).toHaveBeenCalledWith(batchId, [])

    resultListener?.({ payload: { batchId, output } })
    expect(onResult).toHaveBeenCalledTimes(1)
  })

  it("ignores events for inactive batch", async () => {
    invokeMock.mockImplementation(async (_cmd: string, args: any) => ({
      batchId: args.batchId,
      pluginIds: args.pluginIds ?? [],
    }))
    const onResult = vi.fn()
    const onBatchComplete = vi.fn()
    const { result } = renderHook(() => useProbeEvents({ onResult, onBatchComplete }))

    await act(() => result.current.startBatch(["a"]))
    const output = { providerId: "a", displayName: "A", lines: [], iconUrl: "" } satisfies PluginOutput
    const resultListener = listeners.get("probe:result")
    const completeListener = listeners.get("probe:batch-complete")
    resultListener?.({ payload: { batchId: "other", output } })
    completeListener?.({ payload: { batchId: "other" } })

    expect(onResult).not.toHaveBeenCalled()
    expect(onBatchComplete).not.toHaveBeenCalled()
  })

  it("rejects when invoke fails", async () => {
    invokeMock.mockRejectedValueOnce(new Error("boom"))
    const onBatchComplete = vi.fn()
    const { result } = renderHook(() =>
      useProbeEvents({ onResult: vi.fn(), onBatchComplete })
    )

    await expect(result.current.startBatch(["a"])).rejects.toThrow("boom")
    expect(onBatchComplete).not.toHaveBeenCalled()
  })

  it("reports plugins as lost when batch-complete arrives without their results", async () => {
    vi.useFakeTimers()
    let lastArgs: any = null
    invokeMock.mockImplementation(async (_cmd: string, args: any) => {
      lastArgs = args
      return { batchId: args.batchId, pluginIds: args.pluginIds ?? [] }
    })
    const onResult = vi.fn()
    const onBatchComplete = vi.fn()
    const { result } = renderHook(() => useProbeEvents({ onResult, onBatchComplete }))

    await act(() => result.current.startBatch(["a", "b"]))
    const batchId = lastArgs.batchId

    listeners.get("probe:result")?.({ payload: { batchId, output: pluginOutput("a") } })
    listeners.get("probe:batch-complete")?.({ payload: { batchId } })

    expect(onBatchComplete).toHaveBeenCalledWith(batchId, ["b"])

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000)
    })
    expect(onBatchComplete).toHaveBeenCalledTimes(1)
  })

  it("recovers via the watchdog when the batch-complete event is lost", async () => {
    vi.useFakeTimers()
    let lastArgs: any = null
    invokeMock.mockImplementation(async (_cmd: string, args: any) => {
      lastArgs = args
      return { batchId: args.batchId, pluginIds: args.pluginIds ?? [] }
    })
    const onResult = vi.fn()
    const onBatchComplete = vi.fn()
    const { result } = renderHook(() => useProbeEvents({ onResult, onBatchComplete }))

    await act(() => result.current.startBatch(["a", "b"]))
    const batchId = lastArgs.batchId

    listeners.get("probe:result")?.({ payload: { batchId, output: pluginOutput("a") } })

    // No batch-complete is delivered; the watchdog must fire instead.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_001)
    })
    expect(onBatchComplete).toHaveBeenCalledWith(batchId, ["b"])

    // Late delivery still works: results land and a duplicate complete does
    // not re-report the already-recovered plugin as lost.
    listeners.get("probe:result")?.({ payload: { batchId, output: pluginOutput("b") } })
    expect(onResult).toHaveBeenCalledTimes(2)
    listeners.get("probe:batch-complete")?.({ payload: { batchId } })
    expect(onBatchComplete).toHaveBeenLastCalledWith(batchId, [])
    expect(onBatchComplete).toHaveBeenCalledTimes(2)
  })

  it("does not track reconciliation for batches without explicit plugin ids", async () => {
    vi.useFakeTimers()
    let lastArgs: any = null
    invokeMock.mockImplementation(async (_cmd: string, args: any) => {
      lastArgs = args
      return { batchId: args.batchId, pluginIds: [] }
    })
    const onBatchComplete = vi.fn()
    const { result } = renderHook(() =>
      useProbeEvents({ onResult: vi.fn(), onBatchComplete })
    )

    await act(() => result.current.startBatch())
    listeners.get("probe:batch-complete")?.({ payload: { batchId: lastArgs.batchId } })
    expect(onBatchComplete).toHaveBeenCalledWith(lastArgs.batchId, [])
  })

  it("cancels before listeners are ready", async () => {
    const unlisten = vi.fn()
    const ref: { resolve: ((val: () => void) => void) | null } = { resolve: null }
    listenMock.mockImplementationOnce(() => new Promise((resolve) => {
      ref.resolve = resolve
    }))
    const { unmount } = renderHook(() =>
      useProbeEvents({ onResult: vi.fn(), onBatchComplete: vi.fn() })
    )
    unmount()
    ref.resolve?.(unlisten)
    await Promise.resolve()
    expect(unlisten).toHaveBeenCalled()
  })

  it("cancels after first listener is ready", async () => {
    const unlistenFirst = vi.fn()
    const unlistenSecond = vi.fn()
    const ref: { resolve: ((val: () => void) => void) | null } = { resolve: null }
    listenMock
      .mockImplementationOnce(async () => unlistenFirst)
      .mockImplementationOnce(() => new Promise((resolve) => {
        ref.resolve = resolve
      }))
    const { unmount } = renderHook(() =>
      useProbeEvents({ onResult: vi.fn(), onBatchComplete: vi.fn() })
    )
    await Promise.resolve()
    unmount()
    ref.resolve?.(unlistenSecond)
    await Promise.resolve()
    expect(unlistenFirst).toHaveBeenCalled()
    expect(unlistenSecond).toHaveBeenCalled()
  })
})
