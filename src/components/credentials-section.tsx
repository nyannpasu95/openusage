import { useState } from "react"
import { CircleAlert, CircleCheck, LoaderCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { CredentialDialog } from "@/components/credential-dialog"
import type { CredentialStatus } from "@/lib/plugin-types"
import { cn } from "@/lib/utils"

type CredentialPluginRow = {
  id: string
  name: string
  status: CredentialStatus
}

type CredentialsSectionProps = {
  rows: CredentialPluginRow[]
  onSetCredential: (pluginId: string, value: string) => Promise<void>
  onClearCredential: (pluginId: string) => Promise<void>
}

/**
 * Settings section listing each credential-bearing plugin with its
 * configured status. API-key/cookie plugins can be set or cleared here;
 * detected plugins only show where their login comes from.
 */
export function CredentialsSection({
  rows,
  onSetCredential,
  onClearCredential,
}: CredentialsSectionProps) {
  const [dialogStatus, setDialogStatus] = useState<CredentialStatus | null>(null)
  const [saving, setSaving] = useState(false)
  const [clearingId, setClearingId] = useState<string | null>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})

  if (rows.length === 0) return null

  const handleSave = async (pluginId: string, value: string) => {
    setSaving(true)
    setDialogError(null)
    try {
      await onSetCredential(pluginId, value)
      setDialogStatus(null)
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const handleClear = async (pluginId: string) => {
    setClearingId(pluginId)
    setRowErrors((prev) => ({ ...prev, [pluginId]: "" }))
    try {
      await onClearCredential(pluginId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setRowErrors((prev) => ({ ...prev, [pluginId]: message }))
    } finally {
      setClearingId(null)
    }
  }

  return (
    <section>
      <h3 className="text-lg font-semibold mb-0">Credentials</h3>
      <p className="text-sm text-muted-foreground mb-2">
        Check provider logins and manage API keys
      </p>
      <div className="bg-muted/50 rounded-lg p-3 space-y-2 text-sm">
        {rows.map(({ id, name, status }) => {
          const manualEntry = status.kind === "apiKey" || status.kind === "cookie"
          const checkFailed = !status.configured && Boolean(status.error)
          const rowError = rowErrors[id]
          return (
            <div key={id} className="rounded-md bg-card px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="flex-1 truncate">{name}</span>
                <span
                  className={cn(
                    "flex items-center gap-1 text-xs",
                    status.configured
                      ? "text-muted-foreground"
                      : "font-medium text-foreground"
                  )}
                >
                  {status.configured ? (
                    <CircleCheck className="size-3.5 text-green-600 dark:text-green-500" />
                  ) : checkFailed ? (
                    <CircleAlert className="size-3.5 text-red-600 dark:text-red-500" />
                  ) : (
                    <CircleAlert className="size-3.5 text-muted-foreground" />
                  )}
                  {status.configured
                    ? `Set${status.source ? ` · ${status.source}` : ""}`
                    : checkFailed
                      ? "Check Failed"
                      : "Not Set"}
                </span>
                {manualEntry && (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      setDialogError(null)
                      setDialogStatus(status)
                    }}
                  >
                    {status.configured ? "Update" : "Set"}
                  </Button>
                )}
                {manualEntry && status.configured && status.source === "Settings" && (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={clearingId === id}
                    onClick={() => {
                      void handleClear(id)
                    }}
                  >
                    {clearingId === id ? (
                      <LoaderCircle className="size-3 animate-spin" />
                    ) : (
                      "Clear"
                    )}
                  </Button>
                )}
              </div>
              {checkFailed ? (
                <p className="mt-1 text-xs text-red-600 dark:text-red-400 break-words">
                  {status.error}
                </p>
              ) : null}
              {!status.configured && !checkFailed && status.hint ? (
                <p className="mt-1 text-xs text-muted-foreground">{status.hint}</p>
              ) : null}
              {rowError ? (
                <p className="mt-1 text-xs text-red-600 dark:text-red-400 break-words">
                  {rowError}
                </p>
              ) : null}
            </div>
          )
        })}
      </div>
      <CredentialDialog
        status={dialogStatus}
        busy={saving}
        error={dialogError}
        onClose={() => {
          if (!saving) setDialogStatus(null)
        }}
        onSave={(value) => {
          if (dialogStatus) void handleSave(dialogStatus.pluginId, value)
        }}
      />
    </section>
  )
}
