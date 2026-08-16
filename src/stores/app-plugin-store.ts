import { create } from "zustand"
import type { CredentialStatus, PluginMeta } from "@/lib/plugin-types"
import type { PluginSettings } from "@/lib/settings"

type AppPluginStore = {
  pluginsMeta: PluginMeta[]
  pluginSettings: PluginSettings | null
  credentialStatuses: Record<string, CredentialStatus>
  setPluginsMeta: (value: PluginMeta[]) => void
  setPluginSettings: (value: PluginSettings | null) => void
  setCredentialStatuses: (value: Record<string, CredentialStatus>) => void
  resetState: () => void
}

const initialState = {
  pluginsMeta: [] as PluginMeta[],
  pluginSettings: null as PluginSettings | null,
  credentialStatuses: {} as Record<string, CredentialStatus>,
}

export const useAppPluginStore = create<AppPluginStore>((set) => ({
  ...initialState,
  setPluginsMeta: (value) => set({ pluginsMeta: value }),
  setPluginSettings: (value) => set({ pluginSettings: value }),
  setCredentialStatuses: (value) => set({ credentialStatuses: value }),
  resetState: () => set(initialState),
}))
