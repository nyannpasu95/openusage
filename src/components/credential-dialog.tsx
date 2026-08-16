import { useEffect, useRef, useState } from "react"
import { KeyRound } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { CredentialStatus } from "@/lib/plugin-types"

type CredentialDialogProps = {
  status: CredentialStatus | null
  busy: boolean
  error: string | null
  onClose: () => void
  onSave: (value: string) => void
}

/**
 * Overlay dialog for entering a plugin credential (API key or cookie).
 * The value is masked and never rendered again after save.
 */
export function CredentialDialog({
  status,
  busy,
  error,
  onClose,
  onSave,
}: CredentialDialogProps) {
  const [value, setValue] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!status) return
    setValue("")
    inputRef.current?.focus()
  }, [status])

  useEffect(() => {
    if (!status) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        onClose()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [busy, onClose, status])

  if (!status) return null

  const trimmed = value.trim()
  const canSave = trimmed.length > 0 && !busy

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes the dialog for keyboard users; the backdrop is not a focus target.
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm rounded-xl"
      onClick={() => {
        if (!busy) onClose()
      }}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: This wrapper only stops propagation and performs no user action. */}
      <div
        className="bg-card rounded-lg border shadow-xl p-4 max-w-xs w-full mx-4 animate-in fade-in zoom-in-95 duration-200"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-1">
          <KeyRound className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{status.label}</h2>
        </div>
        {status.hint ? (
          <p className="text-xs text-muted-foreground mb-3">{status.hint}</p>
        ) : (
          <div className="mb-3" />
        )}
        <input
          ref={inputRef}
          type="password"
          value={value}
          disabled={busy}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && canSave) {
              onSave(trimmed)
            }
          }}
          autoComplete="off"
          spellCheck={false}
          aria-label={status.label}
          className="h-8 w-full rounded-md border border-border bg-input px-2 text-sm outline-none focus-visible:border-muted-foreground disabled:opacity-50"
        />
        {error ? (
          <p className="mt-2 text-xs text-red-600 dark:text-red-400 break-words">{error}</p>
        ) : null}
        <div className="mt-3 flex justify-end gap-2">
          <Button size="xs" variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="xs"
            disabled={!canSave}
            onClick={() => {
              if (canSave) onSave(trimmed)
            }}
          >
            {busy ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>
    </div>
  )
}
