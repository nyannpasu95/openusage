import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CredentialsSection } from "@/components/credentials-section"
import type { CredentialStatus } from "@/lib/plugin-types"

function makeStatus(overrides: Partial<CredentialStatus> & { pluginId: string }): CredentialStatus {
  return {
    kind: "apiKey",
    label: `${overrides.pluginId} API Key`,
    configured: false,
    ...overrides,
  } as CredentialStatus
}

const manualRow = {
  id: "deepseek",
  name: "DeepSeek",
  status: makeStatus({
    pluginId: "deepseek",
    kind: "apiKey",
    label: "DeepSeek API Key",
    hint: "Create an API key at platform.deepseek.com.",
  }),
}

const configuredRow = {
  id: "qwen",
  name: "Qwen Token Plan",
  status: makeStatus({
    pluginId: "qwen",
    kind: "cookie",
    label: "Qianwen Console Cookie",
    configured: true,
    source: "Settings",
  }),
}

const detectedRow = {
  id: "copilot",
  name: "Copilot",
  status: makeStatus({
    pluginId: "copilot",
    kind: "detected",
    label: "GitHub Login",
    hint: "Log in with the GitHub CLI: run `gh auth login`.",
  }),
}

const externalConfiguredRow = {
  id: "zai",
  name: "Z.ai",
  status: makeStatus({
    pluginId: "zai",
    kind: "apiKey",
    label: "Z.ai API Key",
    configured: true,
    source: "Env",
  }),
}

const checkFailedRow = {
  id: "grok",
  name: "Grok",
  status: makeStatus({
    pluginId: "grok",
    kind: "detected",
    label: "Grok Login",
    hint: "Run `grok login`.",
    configured: false,
    error: "checkCredentials() threw: boom",
  }),
}

afterEach(() => {
  cleanup()
})

describe("CredentialsSection", () => {
  it("renders nothing when no plugins have credentials", () => {
    const { container } = render(
      <CredentialsSection rows={[]} onSetCredential={vi.fn()} onClearCredential={vi.fn()} />
    )
    expect(container.querySelector("section")).toBeNull()
  })

  it("shows set and not-set states with sources and hints", () => {
    render(
      <CredentialsSection
        rows={[manualRow, configuredRow, detectedRow]}
        onSetCredential={vi.fn()}
        onClearCredential={vi.fn()}
      />
    )
    expect(screen.getByText("DeepSeek")).toBeInTheDocument()
    expect(screen.getAllByText("Not Set").length).toBe(2)
    expect(screen.getByText(/Create an API key at platform.deepseek.com/)).toBeInTheDocument()

    expect(screen.getByText("Set · Settings")).toBeInTheDocument()

    expect(screen.getByText(/run `gh auth login`/)).toBeInTheDocument()
  })

  it("only offers set and clear buttons for manual-entry kinds", () => {
    render(
      <CredentialsSection
        rows={[configuredRow, detectedRow]}
        onSetCredential={vi.fn()}
        onClearCredential={vi.fn()}
      />
    )
    // configured manual row gets Update + Clear
    expect(screen.getByRole("button", { name: "Update" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument()
    // detected row gets no credential actions
    expect(screen.queryByRole("button", { name: "Set" })).not.toBeInTheDocument()
  })

  it("opens the dialog, saves the value, and closes on success", async () => {
    const onSetCredential = vi.fn().mockResolvedValue(undefined)
    render(
      <CredentialsSection rows={[manualRow]} onSetCredential={onSetCredential} onClearCredential={vi.fn()} />
    )

    await userEvent.click(screen.getByRole("button", { name: "Set" }))
    const input = screen.getByLabelText("DeepSeek API Key")
    await userEvent.type(input, "sk-test-key")
    await userEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => {
      expect(onSetCredential).toHaveBeenCalledWith("deepseek", "sk-test-key")
    })
    await waitFor(() => {
      expect(screen.queryByLabelText("DeepSeek API Key")).not.toBeInTheDocument()
    })
  })

  it("keeps the dialog open and shows the error when saving fails", async () => {
    const onSetCredential = vi.fn().mockRejectedValue(new Error("Keychain locked"))
    render(
      <CredentialsSection rows={[manualRow]} onSetCredential={onSetCredential} onClearCredential={vi.fn()} />
    )

    await userEvent.click(screen.getByRole("button", { name: "Set" }))
    await userEvent.type(screen.getByLabelText("DeepSeek API Key"), "sk-test-key")
    await userEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => {
      expect(screen.getByText("Keychain locked")).toBeInTheDocument()
    })
    expect(screen.getByLabelText("DeepSeek API Key")).toBeInTheDocument()
  })

  it("clears a configured credential", async () => {
    const onClearCredential = vi.fn().mockResolvedValue(undefined)
    render(
      <CredentialsSection rows={[configuredRow]} onSetCredential={vi.fn()} onClearCredential={onClearCredential} />
    )

    await userEvent.click(screen.getByRole("button", { name: "Clear" }))
    await waitFor(() => {
      expect(onClearCredential).toHaveBeenCalledWith("qwen")
    })
  })

  it("shows a clear failure inline on the row", async () => {
    const onClearCredential = vi.fn().mockRejectedValue(new Error("Could not clear"))
    render(
      <CredentialsSection rows={[configuredRow]} onSetCredential={vi.fn()} onClearCredential={onClearCredential} />
    )

    await userEvent.click(screen.getByRole("button", { name: "Clear" }))
    await waitFor(() => {
      expect(screen.getByText("Could not clear")).toBeInTheDocument()
    })
  })

  it("disables saving while the value is empty", async () => {
    render(
      <CredentialsSection rows={[manualRow]} onSetCredential={vi.fn()} onClearCredential={vi.fn()} />
    )

    await userEvent.click(screen.getByRole("button", { name: "Set" }))
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()

    await userEvent.type(screen.getByLabelText("DeepSeek API Key"), "  ")
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
  })

  it("closes the dialog on Escape and backdrop click", async () => {
    render(
      <CredentialsSection rows={[manualRow]} onSetCredential={vi.fn()} onClearCredential={vi.fn()} />
    )

    await userEvent.click(screen.getByRole("button", { name: "Set" }))
    const input = screen.getByLabelText("DeepSeek API Key")
    await userEvent.type(input, "sk-key{Escape}")
    expect(screen.queryByLabelText("DeepSeek API Key")).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Set" }))
    fireEvent.click(screen.getByLabelText("DeepSeek API Key").parentElement!.parentElement!)
    expect(screen.queryByLabelText("DeepSeek API Key")).not.toBeInTheDocument()
  })

  it("hides Clear for credentials configured from external sources", () => {
    render(
      <CredentialsSection
        rows={[externalConfiguredRow]}
        onSetCredential={vi.fn()}
        onClearCredential={vi.fn()}
      />
    )
    // External credentials can still be overridden via Settings, but there is
    // nothing app-stored to clear.
    expect(screen.getByRole("button", { name: "Update" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Clear" })).not.toBeInTheDocument()
  })

  it("shows backend check errors instead of a misleading Not Set", () => {
    render(
      <CredentialsSection rows={[checkFailedRow]} onSetCredential={vi.fn()} onClearCredential={vi.fn()} />
    )
    expect(screen.getByText("Check Failed")).toBeInTheDocument()
    expect(screen.getByText("checkCredentials() threw: boom")).toBeInTheDocument()
    expect(screen.queryByText("Not Set")).not.toBeInTheDocument()
    // The hint is suppressed while the check failure is shown.
    expect(screen.queryByText(/Run `grok login`/)).not.toBeInTheDocument()
  })

  it("submits the value with Enter and cancels with the Cancel button", async () => {
    const onSetCredential = vi.fn().mockResolvedValue(undefined)
    render(
      <CredentialsSection rows={[manualRow]} onSetCredential={onSetCredential} onClearCredential={vi.fn()} />
    )

    await userEvent.click(screen.getByRole("button", { name: "Set" }))
    await userEvent.type(screen.getByLabelText("DeepSeek API Key"), "sk-key{Enter}")
    await waitFor(() => {
      expect(onSetCredential).toHaveBeenCalledWith("deepseek", "sk-key")
    })

    await userEvent.click(screen.getByRole("button", { name: "Set" }))
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.queryByLabelText("DeepSeek API Key")).not.toBeInTheDocument()
  })
})
