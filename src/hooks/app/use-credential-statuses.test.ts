import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { invokeMock, isTauriMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  isTauriMock: vi.fn(() => true),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  isTauri: isTauriMock,
}))

import { useCredentialStatuses } from "@/hooks/app/use-credential-statuses"
import type { CredentialStatus } from "@/lib/plugin-types"
import type { PluginState } from "@/hooks/app/types"

const STATUS: CredentialStatus = {
  pluginId: "deepseek",
  kind: "apiKey",
  label: "DeepSeek API Key",
  configured: false,
}

function makeArgs(overrides: { pluginStates?: Record<string, PluginState> } = {}) {
  return {
    pluginStates: overrides.pluginStates ?? {},
    setCredentialStatuses: vi.fn(),
    setLoadingForPlugins: vi.fn(),
    setErrorForPlugins: vi.fn(),
    startBatch: vi.fn().mockResolvedValue(undefined),
  }
}

describe("useCredentialStatuses", () => {
  beforeEach(() => {
    invokeMock.mockReset()
    isTauriMock.mockReset()
    isTauriMock.mockReturnValue(true)
    invokeMock.mockResolvedValue([])
  })

  it("loads statuses on mount into a plugin-id keyed record", async () => {
    invokeMock.mockResolvedValue([
      STATUS,
      { ...STATUS, pluginId: "qwen", kind: "cookie" as const, label: "Qianwen Console Cookie", configured: true, source: "Settings" },
    ])
    const args = makeArgs()

    renderHook(() => useCredentialStatuses(args))

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_credential_statuses")
    })
    await waitFor(() => {
      expect(args.setCredentialStatuses).toHaveBeenCalledWith(
        expect.objectContaining({
          deepseek: expect.objectContaining({ configured: false }),
          qwen: expect.objectContaining({ configured: true, source: "Settings" }),
        })
      )
    })
  })

  it("skips loading outside Tauri", async () => {
    isTauriMock.mockReturnValue(false)
    const args = makeArgs()

    renderHook(() => useCredentialStatuses(args))

    await act(async () => {
      await Promise.resolve()
    })
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("sets a credential, refreshes statuses, and re-probes the plugin", async () => {
    invokeMock.mockResolvedValue([{ ...STATUS, configured: true, source: "Settings" }])
    const args = makeArgs()

    const { result } = renderHook(() => useCredentialStatuses(args))
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_credential_statuses")
    })

    await act(async () => {
      await result.current.handleSetCredential("deepseek", "sk-key")
    })

    expect(invokeMock).toHaveBeenCalledWith("set_plugin_credential", {
      pluginId: "deepseek",
      value: "sk-key",
    })
    // mount load + set + refresh
    expect(invokeMock).toHaveBeenCalledTimes(3)
    expect(args.setLoadingForPlugins).toHaveBeenCalledWith(["deepseek"])
    expect(args.startBatch).toHaveBeenCalledWith(["deepseek"])
  })

  it("clears a credential, refreshes statuses, and re-probes the plugin", async () => {
    invokeMock.mockResolvedValue([STATUS])
    const args = makeArgs()

    const { result } = renderHook(() => useCredentialStatuses(args))
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_credential_statuses")
    })

    await act(async () => {
      await result.current.handleClearCredential("deepseek")
    })

    expect(invokeMock).toHaveBeenCalledWith("clear_plugin_credential", { pluginId: "deepseek" })
    // mount load + clear + refresh
    expect(invokeMock).toHaveBeenCalledTimes(3)
    expect(args.startBatch).toHaveBeenCalledWith(["deepseek"])
  })

  it("propagates set failures to the caller", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "set_plugin_credential") {
        return Promise.reject(new Error("keychain locked"))
      }
      return Promise.resolve([])
    })
    const args = makeArgs()

    const { result } = renderHook(() => useCredentialStatuses(args))
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalled()
    })

    await expect(
      result.current.handleSetCredential("deepseek", "sk-key")
    ).rejects.toThrow("keychain locked")
  })

  it("refetches statuses when a probe fails for a configured plugin", async () => {
    invokeMock.mockResolvedValue([{ ...STATUS, configured: true, source: "Env" }])
    const setCredentialStatuses = vi.fn()
    const initialArgs = {
      ...makeArgs(),
      setCredentialStatuses,
    }
    const { result, rerender } = renderHook(
      (args: typeof initialArgs) => useCredentialStatuses(args),
      { initialProps: initialArgs }
    )
    void result

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledTimes(1)
    })

    // A settled failed probe may mean the external credential was removed;
    // backend statuses are re-fetched so a stale "Set" can demote.
    act(() => {
      rerender({
        ...initialArgs,
        pluginStates: {
          deepseek: {
            data: null,
            loading: false,
            error: "login expired",
            lastManualRefreshAt: null,
            lastUpdatedAt: Date.now(),
          },
        },
      })
    })

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledTimes(2)
    })
    expect(invokeMock).toHaveBeenLastCalledWith("get_credential_statuses")
  })

  it("marks a not-configured plugin as configured after a successful probe", async () => {
    invokeMock.mockResolvedValue([STATUS])
    const setCredentialStatuses = vi.fn()
    const initialArgs = {
      pluginStates: {} as Record<string, PluginState>,
      setCredentialStatuses,
      setLoadingForPlugins: vi.fn(),
      setErrorForPlugins: vi.fn(),
      startBatch: vi.fn().mockResolvedValue(undefined),
    }

    const { result, rerender } = renderHook(
      (args: typeof initialArgs) => useCredentialStatuses(args),
      { initialProps: initialArgs }
    )
    void result

    await waitFor(() => {
      expect(setCredentialStatuses).toHaveBeenCalledWith(expect.objectContaining({ deepseek: STATUS }))
    })

    // Simulate a successful probe arriving for the plugin.
    act(() => {
      rerender({
        ...initialArgs,
        pluginStates: {
          deepseek: {
            data: {
              providerId: "deepseek",
              displayName: "DeepSeek",
              lines: [],
              iconUrl: "icon",
            },
            loading: false,
            error: null,
            lastManualRefreshAt: null,
            lastUpdatedAt: Date.now(),
          },
        },
      })
    })

    await waitFor(() => {
      expect(setCredentialStatuses).toHaveBeenLastCalledWith(
        expect.objectContaining({
          deepseek: expect.objectContaining({ configured: true }),
        })
      )
    })
  })
})
