# AGENTS.md

Version: 0.40 (2026-07-10)

> OhMyUsage is a Tauri desktop app for tracking AI provider usage across plugins. This is a community fork of OpenUsage, maintained independently on the `tikuwa` branch.

## Repo & branch model

- This repo is a **fork** of [robinebers/openusage](https://github.com/robinebers/openusage).
- The only maintained branch is **`tikuwa`**. It is the source of truth for the OhMyUsage app.
- `main` and `stable-0.6.28` are inherited from upstream and are **not maintained here**. Do not cut releases or run automation against them.
- The upstream `swift` rewrite and its release lane are **out of scope**. OhMyUsage is a single Tauri edition.
- Do not sync or merge with upstream unless explicitly asked. Pull specific commits by cherry-pick if needed.

## Identity & compatibility

- Product name: **OhMyUsage** (`productName` in `tauri.conf.json`).
- Bundle identifier: **`com.sunstory.openusage`** — intentionally kept from the original app so a fork install **replaces** OpenUsage and inherits its local data (`~/.openusage`, Keychain entries, settings). Changing it would strand existing user config and credentials.
- Keychain service strings (`OpenUsage-copilot`, `gh:github.com`, `Claude Code-credentials`, etc.) and the `__openusage_*` / `__openusage_ctx` internal JS symbols are **compatibility names**. Do not rename them blindly — they let a fork install read data written by the original app. Rename only behind an explicit migration.

## Releases

- Releases are cut from a `tikuwa` commit by pushing a `vX.Y.Z` tag, which triggers `.github/workflows/publish.yml`.
- Update endpoints point at this fork's GitHub releases: `https://github.com/nyannpasu95/openusage/releases/latest/download/latest.json`.
- Builds are **ad-hoc signed** (no Apple Developer certificate on this fork). The first-launch README note tells users to clear the quarantine attribute.
- Keep the version consistent across `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`. The publish workflow validates all three against the tag.
- Use the **release-tauri** skill to cut a release (it handles the version bump, changelog, and asset verification). Never leave a release in Draft.

## Documentation

- Logic changes must update any docs in `docs/` that describe the affected behavior.
- Plans must list the doc files that need updating as part of the work.
- Exclude design from docs, and keep them simple, less-technical, easy to skim.

## Guardrails

- Use `trash` for deletes.
- Use `mv` / `cp` to move and copy files.
- Bugs: add a regression test when it fits.
- Keep files <~500 LOC; split/refactor as needed.
- Before writing code, strictly follow the below research rules.

## Research

- Check for and prefer available skills over web research.
- Prefer researched knowledge over your own knowledge when skills are unavailable.
- Research: Exa to general search, Context7 for official docs, GitHits for open source examples.
- Best results: Quote exact errors; prefer late-2025/2026+ sources.

## Error Handling

Always fail loudly into error logging (e.g., Sentry) and but show friendly errors to the user. Do not add silent fallbacks that hide real problems.

## UI

Always use titlecase any hardcoded copy for titles.

Strictly use `lucide-react` for icons. Nothing else. Pattern: `<FooIcon className="size-4" />`. (Upstream mandates `@hugeicons-pro/core-solid-rounded`, but that package requires a paid license token to install; this fork standardizes on lucide-react instead.)

## Automated Testing

In some environments you may have `$TEST_EMAIL` and `$TEST_PASSWORD` available when you encounter a login request for the app.

## Agent Guidance

When you have enough information to act, act. Do not re-derive facts already established in the conversation, re-litigate a decision the user has already made, or narrate options you will not pursue in user-facing messages. If you are weighing a choice, give a recommendation, not an exhaustive survey. This does not apply to thinking blocks.

Don't add features, refactor, or introduce abstractions beyond what the task requires. A bug fix doesn't need surrounding cleanup and a one-shot operation usually doesn't need a helper. Don't design for hypothetical future requirements: do the simplest thing that works well. Avoid premature abstraction and half-finished implementations. Don't add error handling, fallbacks, or validation for scenarios that cannot happen. Trust internal code and framework guarantees. Only validate at system boundaries (user input, external APIs). Don't use feature flags or backwards-compatibility shims when you can just change the code.

Lead with the outcome. Your first sentence after finishing should answer "what happened" or "what did you find". Supporting detail and reasoning come after.

Pause for the user only when the work genuinely requires them: a destructive or irreversible action, a real scope change, or input that only they can provide.

Before reporting progress, audit each claim against a tool result from this session. Report outcomes faithfully: if tests fail, say so with the output; if a step was skipped, say that; when something is done and verified, state it plainly.

## Before Creating Pull Request

- Before creating a PR or pushing to main, ensure that `README.md` is updated with what plugins are supported.
- On any plugin change/new plugin, audit plugin-exposed request/response fields against `src-tauri/src/plugin_engine/host_api/redact.rs` redaction lists and add/update tests for gaps. Compare with existing plugins for patterns.
- In `plugin.json`, set `brandColor` to the provider's real brand color.
- Plugin SVG logos must use `currentColor` so icon theming works correctly.
- If the PR includes visual changes, refuse to create it without providing before/after screenshots.

## Project Memories

Use below list to store and recall user notes when asked to do so. Keep each list item concise.

- Tauri IPC: JS must use camelCase (`{ batchId, pluginIds }`), Tauri auto-converts to Rust's snake_case. Never send snake_case from JS—params silently won't match.
- tauri-action `latest.json`: Parallel matrix builds are safe—action fetches existing `latest.json`, merges platform entries, re-uploads. No `max-parallel: 1` needed.
