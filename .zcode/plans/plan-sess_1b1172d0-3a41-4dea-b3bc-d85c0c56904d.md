# 凭证状态显示与设置功能（Credential Status & Setup）

## 概述

为每个插件（"plan"）增加凭证状态概念：
- **API Key / Cookie 类插件**（DeepSeek、Qwen、GLM/ZAI、MiniMax、Synthetic）：显示状态 + 在设置页手动输入凭证（存入 macOS Keychain）。
- **OAuth/CLI 登录类插件**（Claude、Codex、Copilot、Cursor、Antigravity、Factory、Grok、Kimi、Devin）：仅显示"已设置/未设置"状态 + 指引文案（如 "Run `gh auth login`"）。
- 无凭证概念的插件（amp、jetbrains、kiro、opencode-go、perplexity、mock）：不显示。
- Overview 卡片上：凭证未设置时显示 "Credentials Not Set" 状态和 "Set Up" 按钮（跳转设置页），替代原始报错文案。

## 一、后端（Rust）

### 1. Manifest 增加 `credential` 可选字段 — `src-tauri/src/plugin_engine/manifest.rs`
```rust
pub struct ManifestCredential {
    kind: String,          // "apiKey" | "cookie" | "detected"
    label: String,         // 设置页显示的 Titlecase 标签，如 "DeepSeek API Key"
    hint: Option<String>,  // 未设置时的指引文案
}
```
`PluginManifest` 加 `credential: Option<ManifestCredential>`（serde camelCase，缺省 None，向后兼容）。

### 2. 沙箱内运行 `checkCredentials` — 新文件 `src-tauri/src/plugin_engine/credential_check.rs`
仿照 `runtime.rs` 的 `run_probe_with_timeout`：同样的 QuickJS 沙箱 + host API 注入（复用 `host_api::inject_host_api_with_deadline`），加载插件脚本后调用可选导出 `checkCredentials(ctx)`（支持 Promise），解析返回值 `{ configured: boolean, source?: string }`（source 如 "Keychain" / "Env" / "Claude Code"）。超时 10s。runtime.rs 已超 500 行，故放新文件。

### 3. 新 Tauri 命令 — 新模块 `src-tauri/src/credentials.rs`，在 `lib.rs` 的 `generate_handler!` 注册
- `get_credential_statuses() -> Vec<CredentialStatusDto>`：对每个有 `credential` block 的插件运行 `checkCredentials`，返回 `{ pluginId, kind, label, hint?, configured, source? }`（camelCase DTO）。
- `set_plugin_credential(pluginId, value)`：校验插件存在且 kind 为 apiKey/cookie，写 Keychain。**绝不把凭证值返回给前端，日志中不得输出该值。**
- `clear_plugin_credential(pluginId)`：删除 Keychain 条目（条目不存在视为成功，与现有 deleteGenericPassword 行为一致）。

Keychain 服务名约定：`OpenUsage-{pluginId}-credential`（如 `OpenUsage-deepseek-credential`），service-only 读写删，复用 `host_api/keychain.rs` 的 `pub(crate)` args 构造函数和 `security` 调用逻辑。**不改动任何现有兼容服务名**（`OpenUsage-copilot`、`Claude Code-credentials` 等）。非 macOS 平台命令返回明确错误（keychain 仅支持 macOS）。

### 4. `list_plugins` 的 `PluginMeta` DTO 增加 `credential: Option<{ kind, label, hint? }>`，供前端决定渲染方式。

## 二、插件改造（plugins/*/）

### 手动输入类（5 个）——凭证解析顺序改为：App Keychain → 现有来源（env/文件），并新增 `checkCredentials` 导出和 `plugin.json` credential block：
1. **deepseek**：`loadApiKey` 先读 keychain，再 `DEEPSEEK_API_KEY` env。kind: apiKey。
2. **zai**：先 keychain，再 `ZAI_API_KEY`/`GLM_API_KEY`。kind: apiKey。
3. **minimax**：先 keychain，再各 env 变量（实现时确认其多 env 解析逻辑的接入点）。kind: apiKey。
4. **synthetic**：先 keychain，再 `SYNTHETIC_API_KEY`。kind: apiKey。
5. **qwen**：先 keychain，再 `QWEN_COOKIE` env，再 `~/.openusage/qwen-cookie.txt`（保留文件回退，兼容老用户）。kind: cookie。

### 状态展示类（detected，9 个）——只加 `plugin.json` block（kind: "detected" + hint）和 `checkCredentials` 导出（检测各自现有凭证来源是否存在），不改变凭证解析逻辑：
- **claude**（keychain/credentials 文件；hint: 用 Claude Code 登录）
- **codex**（`Codex Auth` keychain/auth.json）
- **copilot**（`OpenUsage-copilot` / `gh:github.com`；hint: Run `gh auth login`）
- **cursor**、**antigravity**、**factory**（各自现有 keychain/文件）
- **grok**（`~/.grok/auth.json`）、**kimi**（`~/.kimi-code/credentials/...`）、**devin**（`~/.local/share/devin/credentials.toml`）

## 三、前端（React）

### 1. 类型 — `src/lib/plugin-types.ts`
`CredentialKind`、`CredentialMeta`（PluginMeta 增加可选字段）、`CredentialStatus`。

### 2. 状态管理 — 扩展 `src/stores/app-plugin-store.ts`
`credentialStatuses: Record<string, CredentialStatus>`。新 hook `src/hooks/app/use-credential-statuses.ts`：bootstrap 时（`use-settings-bootstrap.ts` 在 `list_plugins` 之后）invoke `get_credential_statuses`；提供 `refresh`、`setCredential`（invoke set → refresh → 触发该插件 re-probe，复用 `use-settings-plugin-actions` 的 re-probe 模式）、`clearCredential`。Probe 成功时可乐观置 `configured=true`（探测成功即凭证有效）。

### 3. 设置页 — 新组件 `src/components/credentials-section.tsx`（仿 `local-api-section.tsx` 模式，settings.tsx 已超 500 行不再膨胀）
"Crendentials" section：每个有凭证的插件一行 —— 名称 + 状态徽章（"Set" / "Not Set"）+ 已配置时显示来源，未配置时显示 hint；apiKey/cookie 类有 "Set"/"Update" 和 "Clear" 按钮。输入用新手写的对话框组件 `src/components/credential-dialog.tsx`（仿 `about-dialog.tsx` overlay 模式，`<input type="password">` + Save/Cancel，Save 时调用 setCredential）。UI copy 全部英文 Titlecase，图标只用 lucide-react（如 `KeyRound`、`CircleCheck`/`CircleAlert`）。

### 4. Overview 卡片 — `src/components/provider-card.tsx` 增加可选 `credentialStatus` prop
未配置且无 stale 数据时：apiKey/cookie 类显示 "Credentials Not Set" 提示框 + "Set Up" 按钮（回调跳转设置页 `setActiveView("settings")`，替代原始错误文案）；detected 类保留现有错误显示（其报错本身已含指引）。已配置或凭证无效（配置了但 401）时维持现有错误展示不变。

## 四、文档（按 AGENTS.md 要求）
- `docs/plugins/api.md`：新增 `credential` manifest 字段、`checkCredentials` 导出、Keychain 服务名约定 `OpenUsage-{id}-credential` 的说明。
- `docs/providers/` 下 5 个手动输入类插件文档：补充"可在设置页直接填写凭证"及解析顺序。
- `README.md`：功能列表补一句凭证管理。
- 审计 `src-tauri/src/plugin_engine/host_api/redact.rs`：确认新链路（checkCredentials 返回值、set 命令）无敏感字段泄漏，必要时补充 redaction 测试。

## 五、测试
- **Rust**：manifest credential 解析测试；credential_check 沙箱测试（有/无 checkCredentials 导出，用 fixture 插件仿照现有 runtime 测试）；命令的参数构造单测（不真调 `security`，与现有 keychain 测试同策略）。
- **插件 JS**：5 个手动输入类更新现有 `plugin.test.js`（keychain 优先解析）+ 新增 checkCredentials 测试（用 `test-helpers.js` mock host）。
- **前端**（vitest，注意 90% 覆盖率阈值）：`credentials-section.test.tsx`、`credential-dialog.test.tsx`、provider-card 未设置状态测试、hook 的 invoke 调用测试。

## 六、验证
`cargo test`（src-tauri）、插件测试（按仓库现有跑法）、`npm test` / `npx vitest run`、`npm run build` + `cargo check`；手动验证路径：设置页输入 DeepSeek key → 状态变 Set → 卡片恢复数据 → Clear 后回到未设置态。

## 不做的事
- 不改名任何现有 Keychain 兼容服务；不动 OAuth 类插件的凭证解析。
- 不在前端展示/回传凭证明文；不做 Windows/Linux keychain（本 fork 仅 macOS）。
- 无凭证概念的插件不出现在该 UI 中。