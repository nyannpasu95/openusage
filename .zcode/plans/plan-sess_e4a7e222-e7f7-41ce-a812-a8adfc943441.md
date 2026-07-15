## Plan: Manual Refresh Button + New Auto-Refresh Intervals

### Decisions (confirmed)
- **Button location:** Panel footer (dedicated icon button next to the countdown)
- **Intervals:** Full range — `1, 2, 5, 10, 15, 30, 60, 120` minutes
- **Cooldown:** Keep the existing 5-min per-plugin cooldown; show disabled/hourglass state when on cooldown

### Part 1 — New auto-refresh interval options

The interval type, validation, and UI all derive from one array. Currently `[5, 15, 30, 60]`.

**`src/lib/settings.ts`** (3 edits):
1. Type (line 13): `5 | 15 | 30 | 60` → `1 | 2 | 5 | 10 | 15 | 30 | 60 | 120`
2. `AUTO_UPDATE_INTERVALS` (line 53): `[5, 15, 30, 60]` → `[1, 2, 5, 10, 15, 30, 60, 120]`
3. `AUTO_UPDATE_OPTIONS` label mapper (lines 72-76): generalize the hour label so both `60` ("1 hour") and `120` ("2 hours") render correctly, plus `${value} min` for the rest.

The validator (`isAutoUpdateInterval`), default (15), loader, saver, and the Zustand store field all derive from the type/array — no other changes. The settings page radio-group (line 341) iterates `AUTO_UPDATE_OPTIONS` automatically.

**Layout fix** — `src/pages/settings.tsx` (line 340): the radio buttons use `flex-1` in a single row. 8 buttons in one row will be too cramped in the ~280px panel. Change the container from a single `flex` row to a `grid grid-cols-4` so the 8 options wrap into 2 clean rows of 4.

### Part 2 — Dedicated manual refresh button in the footer

`handleRefreshAll` already exists (`use-probe-refresh-actions.ts:57`) and is wired through `App.tsx → AppShell → PanelFooter`. Today the only refresh affordance is the countdown text itself, which disappears when `autoUpdateNextAt === null`. I'll add a dedicated, always-visible icon button.

**`src/components/panel-footer.tsx`:**
- Add a new optional prop `isRefreshing: boolean` and `isRefreshOnCooldown: boolean` (derived in App.tsx from `pluginStates`).
- Render a `<Button variant="ghost" size="icon-xs">` with a `RefreshCw` icon (from `lucide-react`, per AGENTS.md) to the left of the countdown.
  - When `isRefreshing`: icon spins (`animate-spin`), button disabled — mirrors the existing `provider-card.tsx` pattern (line 146).
  - When `isRefreshOnCooldown`: button disabled, icon becomes `Hourglass` with tooltip "Refresh again in Xm" — mirrors provider-card cooldown (line 161).
  - Otherwise: clickable, calls `onRefreshAll()`, tooltip "Refresh Now".
- Keep the existing countdown-text-as-button behavior (it still works), so the dedicated button is additive.

**State derivation** — `src/App.tsx`:
- Derive `isAnyPluginLoading` and `isRefreshOnCooldown` from `pluginStates` (already destructured at line 89):
  - `isRefreshing = Object.values(pluginStates).some((s) => s.loading)`
  - `isRefreshOnCooldown = enabledPluginIds.every((id) => pluginStates[id]?.lastManualRefreshAt && now - lastManualRefreshAt < REFRESH_COOLDOWN_MS)` — i.e. no plugin is eligible yet.
- Pass both into `<AppShell>` → `<PanelFooter>`. This requires threading the two new booleans through `AppShellProps` (add fields) and `PanelFooterProps`.

**Threading** — `src/components/app/app-shell.tsx`: add `isRefreshing` and `isRefreshOnCooldown` to the type and forward to `<PanelFooter>`.

### Part 3 — Tests

- **`src/lib/settings.test.ts`**: add cases asserting `1`, `2`, `10`, `120` are valid intervals and that `AUTO_UPDATE_OPTIONS` produces correct labels (`1 min`, `2 min`, `1 hour`, `2 hours`).
- **`src/components/panel-footer.test.tsx`**: add cases — refresh button renders with `RefreshCw`, calls `onRefreshAll` on click, shows spinning icon when `isRefreshing`, disabled+hourglass when on cooldown.
- **`src/hooks/app/use-settings-system-actions.test.ts`**: existing tests pass through unchanged (they use `30`), no edits needed.

### Files changed (summary)
| File | Change |
|---|---|
| `src/lib/settings.ts` | Extend interval type + array + label mapper |
| `src/pages/settings.tsx` | Radio layout → `grid grid-cols-4` |
| `src/components/panel-footer.tsx` | Add dedicated refresh icon button + cooldown/loading states |
| `src/components/app/app-shell.tsx` | Thread `isRefreshing` + `isRefreshOnCooldown` props |
| `src/App.tsx` | Derive loading/cooldown booleans from `pluginStates`, pass down |
| `src/lib/settings.test.ts` | Tests for new intervals + labels |
| `src/components/panel-footer.test.tsx` | Tests for refresh button states |

### Verification
- `bun run test` (frontend + plugin tests)
- `bun run test:coverage` (must stay ≥86% branches)
- `bun run build` (type-check passes)

No Rust changes, no new dependencies, no docs changes needed (the settings UI is self-describing). The refresh button reuses the existing `handleRefreshAll` → `start_probe_batch` pipeline that's already battle-tested.