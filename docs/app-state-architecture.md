# App State Architecture

## Source of truth stores
- `app-ui-store`: UI view state (`activeView`, `showAbout`)
- `app-plugin-store`: plugin metadata + persisted plugin settings
- `app-preferences-store`: persisted user preferences (display/theme/tray/system)

## Derived values
- `displayPlugins` + `navPlugins` are computed by `useAppPluginViews`.
- `settingsPlugins` is computed by `useSettingsPluginList`.
- `autoUpdateNextAt` is runtime scheduling state from `useProbe`.
- `selectedPlugin` is computed by `useAppPluginViews`.
- The selected menu bar provider is runtime-only state in `useTrayIcon`. Opening a provider selects it manually; Home and Settings leave it unchanged.
- Usage-increase candidates are grouped by probe batch in `App.tsx` and discarded when that batch completes.

## Main data flow
1. `App.tsx` composes hooks and owns cross-domain orchestration.
2. Source stores are updated from bootstrap/settings/probe actions.
3. Each successful probe result includes its batch ID and the provider's previous data. `App.tsx` compares the selected menu bar metric and records real usage increases.
4. When a batch completes, the provider with the largest normalized increase becomes the menu bar provider. The panel's active page does not change.
5. Derived hooks recompute view models from source state.
6. `App.tsx` passes derived values directly to `AppShell` and `AppContent`.
7. `AppShell` and `AppContent` render from those direct props and source stores.

## Guardrails
- Keep source-of-truth state in dedicated stores (`app-ui-store`, `app-plugin-store`, `app-preferences-store`).
- Keep derived values computed in domain hooks and passed directly to composition components.
- Avoid effect-based mirroring of derived values into a separate store.
- Keep derivations pure and colocated with domain hooks.
- Treat the first successful provider result as a baseline. Only a later increase in the same plan and metric may trigger menu bar auto-follow.
