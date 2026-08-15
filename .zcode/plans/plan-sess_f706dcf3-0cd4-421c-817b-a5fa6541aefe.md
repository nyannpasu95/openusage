# 统一命名为 OhMyUsage 并反映到 GitHub

## 背景

代码层面在 v0.6.29 已完成大改（productName、package.json、Cargo.toml、UI 文案均已叫 OhMyUsage）。剩余工作集中在两点：**GitHub 仓库本身还叫 `nyannpasu95/openusage`**，以及**代码/文档中指向该仓库的 11 处 URL**。

## 改动内容

### 1. GitHub 仓库重命名（核心诉求）

- `gh repo rename ohmyusage --repo nyannpasu95/openusage`
- 更新本地 remote：`git remote set-url origin https://github.com/nyannpasu95/ohmyusage.git`
- GitHub 会为旧 URL 自动设置重定向（含 release 资产下载），因此已发布的 v0.6.29 用户的自动更新不受影响

### 2. 更新代码/文档中的仓库 URL（`nyannpasu95/openusage` → `nyannpasu95/ohmyusage`，共 10 个被跟踪文件）

| 文件 | 内容 |
|---|---|
| `src-tauri/tauri.conf.json` | updater endpoint（L66） |
| `src/hooks/use-changelog.ts` + `.test.tsx` | GitHub Releases API 地址 |
| `src/components/changelog-dialog.tsx` + `.test.tsx` | PR/commit/releases 链接 |
| `src/components/about-dialog.tsx` | About 对话框 GitHub 链接（L118） |
| `README.md` | 下载链接、issues 链接、star-history badge |
| `SECURITY.md` / `CONTRIBUTING.md` | 安全报告、issue 链接 |
| `AGENTS.md` | updater endpoint 说明（L24） |

另两个顺手修正：
- `.codex/environments/environment.toml`：`name = "openusage"` → `ohmyusage`
- `.agents/skills/release-tauri/SKILL.md:4`：过时文案 "Tauri edition of OpenUsage (main branch)" → OhMyUsage (tikuwa branch)
- `.claude/settings.local.json`（未被 git 跟踪，仅本地）：curl 白名单里的旧 release URL 同步更新

### 3. 明确不动的（兼容性名称，AGENTS.md 规定）

- bundle identifier `com.sunstory.openusage`（改了会丢用户本地数据和钥匙串凭证）
- Keychain 服务字符串（`OpenUsage-copilot`、`gh:github.com`、`Claude Code-credentials`、兜底账户 `openusage-user`）
- JS 内部符号 `__openusage_*` / `__openusage_ctx`
- 数据目录 `~/.openusage`
- CHANGELOG 历史条目中的上游 PR 链接、指向 `robinebers/openusage` 的 fork 出处声明
- 测试临时目录前缀等不可见内部字符串（改动无收益，按最小改动原则跳过）

### 4. 验证与收尾

1. 全局 grep 确认无遗漏的 `nyannpasu95/openusage`；剩余 "openusage" 命中应仅为兼容名称和历史记录
2. 跑受影响的前端测试（use-changelog / changelog-dialog / about-dialog）+ lint + build（无 Rust 改动，跳过 cargo）
3. 仅提交本次改名涉及的文件（你手头 kimi/probe 相关未提交改动不受影响），推送到 `tikuwa`
4. 重命名仓库后验证：旧 endpoint 302 重定向正常、新 `latest.json` 可访问、`gh release list` 正常

## 不在本次范围（说明）

- 本地目录 `/Users/suyuhang/openusage` 不重命名（会打断当前会话；GitHub 展示与它无关，你之后可自行 `mv` 并重开终端）
- GitHub 页面上 "forked from robinebers/openusage" 标签会保留（fork 关系保留才能继续 cherry-pick 上游；若想摘除需联系 GitHub 支持，不可逆，不建议）
- 不发新版本：endpoint 变更随下次 release 生效，旧地址在此期间靠重定向继续工作