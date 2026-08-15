import { useCallback, useEffect, useRef } from "react"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { invoke } from "@tauri-apps/api/core"
import type { PluginOutput } from "@/lib/plugin-types"

// Mirrors PROBE_TIMEOUT_SECS / MAX_CONCURRENT_PROBES in
// src-tauri/src/plugin_engine/runtime.rs and src-tauri/src/lib.rs: the Rust
// side can never take longer than ceil(n / workers) probe timeouts, so a
// watchdog slightly beyond that bound means the batch-complete event was lost.
const PROBE_TIMEOUT_MS = 30_000
const MAX_CONCURRENT_PROBES = 4
const BATCH_WATCHDOG_SLACK_MS = 30_000

function batchWatchdogMs(pluginCount: number): number {
  const rounds = Math.ceil(pluginCount / Math.min(pluginCount, MAX_CONCURRENT_PROBES))
  return rounds * PROBE_TIMEOUT_MS + BATCH_WATCHDOG_SLACK_MS
}

type ProbeResult = {
  batchId: string
  output: PluginOutput
}

type ProbeBatchComplete = {
  batchId: string
}

type ProbeBatchStarted = {
  batchId: string
  pluginIds: string[]
}

type UseProbeEventsOptions = {
  onResult: (output: PluginOutput, batchId: string) => void
  onBatchComplete: (batchId: string, lostPluginIds: string[]) => void
}

export function useProbeEvents({ onResult, onBatchComplete }: UseProbeEventsOptions) {
  const activeBatchIds = useRef<Set<string>>(new Set())
  const pendingPluginsByBatch = useRef<Map<string, Set<string>>>(new Map())
  const watchdogsByBatch = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const unlisteners = useRef<UnlistenFn[]>([])
  const listenersReadyRef = useRef<Promise<void> | null>(null)
  const listenersReadyResolveRef = useRef<(() => void) | null>(null)
  const onBatchCompleteRef = useRef(onBatchComplete)

  useEffect(() => {
    onBatchCompleteRef.current = onBatchComplete
  }, [onBatchComplete])

  const finishBatch = useCallback((batchId: string): string[] => {
    const timer = watchdogsByBatch.current.get(batchId)
    if (timer) {
      clearTimeout(timer)
      watchdogsByBatch.current.delete(batchId)
    }
    const pending = pendingPluginsByBatch.current.get(batchId)
    pendingPluginsByBatch.current.delete(batchId)
    return pending ? [...pending] : []
  }, [])

  useEffect(() => {
    let cancelled = false

    // Create the promise that will resolve when listeners are ready
    listenersReadyRef.current = new Promise<void>((resolve) => {
      listenersReadyResolveRef.current = resolve
    })

    const setup = async () => {
      const resultUnlisten = await listen<ProbeResult>("probe:result", (event) => {
        if (activeBatchIds.current.has(event.payload.batchId)) {
          pendingPluginsByBatch.current
            .get(event.payload.batchId)
            ?.delete(event.payload.output.providerId)
          onResult(event.payload.output, event.payload.batchId)
        }
      })

      if (cancelled) {
        resultUnlisten()
        return
      }

      const completeUnlisten = await listen<ProbeBatchComplete>(
        "probe:batch-complete",
        (event) => {
          if (activeBatchIds.current.delete(event.payload.batchId)) {
            const lostPluginIds = finishBatch(event.payload.batchId)
            onBatchCompleteRef.current(event.payload.batchId, lostPluginIds)
          }
        }
      )

      if (cancelled) {
        resultUnlisten()
        completeUnlisten()
        return
      }

      unlisteners.current.push(resultUnlisten, completeUnlisten)

      // Signal that listeners are ready
      listenersReadyResolveRef.current?.()
    }

    void setup()

    return () => {
      cancelled = true
      unlisteners.current.forEach((unlisten) => unlisten())
      unlisteners.current = []
      listenersReadyRef.current = null
      listenersReadyResolveRef.current = null
      for (const timer of watchdogsByBatch.current.values()) {
        clearTimeout(timer)
      }
      watchdogsByBatch.current.clear()
    }
  }, [finishBatch, onResult])

  const startBatch = useCallback(async (pluginIds?: string[]) => {
    // Wait for listeners to be ready before starting the batch
    if (listenersReadyRef.current) {
      await listenersReadyRef.current
    }

    const batchId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `batch-${Date.now()}-${Math.random().toString(16).slice(2)}`

    activeBatchIds.current.add(batchId)
    // Track per-plugin results so a batch-complete can report which results
    // were lost in transit (Rust emitted them, the webview never ran them).
    // Batches without explicit ids probe the full Rust registry and are not
    // reconciled.
    if (pluginIds && pluginIds.length > 0) {
      pendingPluginsByBatch.current.set(batchId, new Set(pluginIds))
      watchdogsByBatch.current.set(
        batchId,
        setTimeout(() => {
          watchdogsByBatch.current.delete(batchId)
          const pending = pendingPluginsByBatch.current.get(batchId)
          if (!pending) return
          // Keep the batch active: if this fired early while Rust is still
          // working, late results and the real batch-complete still land.
          onBatchCompleteRef.current(batchId, finishBatch(batchId))
        }, batchWatchdogMs(pluginIds.length))
      )
    }
    const args = pluginIds
      ? { batchId, pluginIds }
      : { batchId }
    try {
      const result = await invoke<ProbeBatchStarted>("start_probe_batch", args)
      return result.pluginIds
    } catch (error) {
      activeBatchIds.current.delete(batchId)
      finishBatch(batchId)
      throw error
    }
  }, [finishBatch])

  return { startBatch }
}
