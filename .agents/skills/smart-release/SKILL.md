---
name: smart-release
description: 从 git 提交同步到 CHANGELOG.md,可选版本 bump 与发布。
disable-model-invocation: true
argument-hint: "[--release] [patch|minor|major|vX.Y.Z]"
---

# Smart Release(智能发布)

从 git 提交同步到 CHANGELOG.md,可选版本 bump 与发布(release)。

## Usage Patterns

### Pattern 1: Sync Only (Daily Updates)

**触发**: "更新 changelog" / "同步 changelog" / "生成 release notes"

**流程**:
1. Read CHANGELOG.md → find last synced commit
2. `git log <last-commit>..HEAD` → get new commits
3. Categorize and append to [Unreleased]
4. Update sync marker
5. Commit and push

### Pattern 2: Version Release

**触发**: "发布新版本" / "发布一个 patch 版本" / "打 tag 发布" / `--release [type]`

**流程**:
1. Calculate/confirm version number
2. Ask which steps to execute
3. Perform selected operations

---

## Release Step Selection

When releasing, ask the user to select steps:

```
📊 Release Options

Select steps to execute:

[1] ✅ Update CHANGELOG.md (required)
[2] ⬜ Sync version to project files
[3] ⬜ Create Git Tag
[4] ⬜ Push commits and tags
[5] ⬜ Create GitHub Release
[6] ⬜ Update documentation (README, docs/, etc.)

Enter options (e.g., 1,2,3,4,5,6 or all):
```

### Smart Defaults

If user intent is clear, skip selection:

| User Says / Arguments | Steps |
|----------------------|-------|
| "更新 changelog" | 1,4 |
| "更新版本号" | 1,2,4 |
| "打 tag 发布" | 1,2,3,4 |
| "完整发布" | 1,2,3,4,5,6 |
| `--release` (no type) | Ask selection |
| `--release patch/minor/major` | Ask selection |

---

## Core Workflows

### Step 1: Version Confirmation (Required for Version Sync)

```
1. Detect current version
2. Calculate new version (patch/minor/major or specific)
3. ⚠️ ASK USER: "Confirm release version X.Y.Z?"
   - Confirmed → Continue
   - Rejected → Ask for specific version or abort
```

**完成判据**: 用户已确认发布版本号(或已明确中止)。

### Step 2: Monorepo Detection (For Version Sync)

**Detection Indicators:**
- `pnpm-workspace.yaml`
- `lerna.json` / `lerna-lite.json`
- `nx.json`
- `turbo.json`
- `packages/` directory
- `workspaces` field in package.json

**Version Strategy Selection:**
```
Monorepo detected. Select version update strategy:

1. Unified version - All packages to same version
2. Independent version - Only changed packages
3. Selective update - Manually select packages
4. Root only - Only update root package.json

Select [1-4]:
```

**完成判据**: 已判定是否 monorepo;若是,已选定版本策略;若无 monorepo,跳过本步。

### Step 3: Version Sync

**Standard Files:**
- `package.json` → version
- `VERSION` file
- `pyproject.toml` → project.version
- `Cargo.toml` → package.version

**Monorepo Additional:**
- `packages/*/package.json`
- `apps/*/package.json`
- `libs/*/package.json`
- `lerna.json`

**完成判据**: 所有目标文件的 version 字段已更新到新版本号。

### Step 4: Update CHANGELOG

1. Move [Unreleased] content to new version section
2. Add release date
3. Clean empty categories
4. Ensure proper formatting

**完成判据**: [Unreleased] 内容已移入新版本段;新版本段含日期;空分类已清;格式符合 CHANGELOG.md Format 规则。

### Step 5: Update Documentation

**Files to Check:**
- `README.md` - installation instructions, version badges
- `docs/` directory - API docs, examples
- `CONTRIBUTING.md`

**Ask User:**
```
These documentation files may contain outdated version info:
- README.md
- docs/api.md

Update version references? [Yes/No/Select]
```

**完成判据**: 已识别含过期版本信息的文档;用户已决定是否更新;若更新则版本引用已同步。

### Step 6: Git Operations

```bash
git add .
git commit -m "chore: release v{version}

- Update version to {version}
- Update CHANGELOG.md
- Update documentation"

git tag v{version}
git push origin <branch>
git push origin v{version}
```

**完成判据**: release commit 已创建;tag v{version} 已打;commits 与 tags 已推送(或推送失败已告知用户)。

### Step 7: GitHub Release

```bash
gh release create v{version} \
  --title "v{version}" \
  --notes "## What's Changed

### Added
- ...

### Fixed
- ..."
```

If `gh` CLI unavailable, provide manual instructions.

**完成判据**: GitHub Release 已创建(或 gh 不可用时已提供手动指引)。

---

## Commit Categories

| Prefix | Category |
|--------|----------|
| `feat:`, `feature:` | Added |
| `fix:`, `bugfix:` | Fixed |
| `refactor:`, `change:` | Changed |
| `docs:` | Documentation |
| `perf:` | Performance |
| `test:`, `chore:`, `ci:` | Skip |

---

## CHANGELOG.md Format

```markdown
# Changelog

## [Unreleased]

### Added
- New feature

### Fixed
- Bug fix

---

## [1.0.0] - 2026-03-15

### Added
- Feature A

### Fixed
- Bug C

---

## [0.9.0] - 2026-03-10
...
```

**Format Rules:**
- `[Unreleased]` at top
- `---` between versions
- Categories: Added, Fixed, Changed, Documentation, Performance
- Version format: `[X.Y.Z] - YYYY-MM-DD`
- Sync marker: `<!-- last-sync: <commit-hash> -->`

---

## Version Detection Priority

1. `package.json` → version
2. `VERSION` file
3. `pyproject.toml` → project.version
4. `Cargo.toml` → package.version
5. Git tag (`git describe --tags --abbrev=0`)

> 本表是版本检测的**唯一源**;`issue-manager` 等其他 skill 需要版本检测时引用此处,不重复。

---

## Error Handling

| Scenario | Handling |
|----------|----------|
| No CHANGELOG.md | Create from template |
| No new commits | Inform user, no changes |
| User rejects version | Ask for specific version or abort |
| Unclean working directory | Ask before continuing |
| Push failed | Tag created locally, inform user |
| `gh` CLI unavailable | Provide manual release instructions |
| Monorepo detection failed | Default to single package |

---

## Integration

- **feature-manager** - 引用 feature ID
- **issue-manager** - 关联已修复的 issue
- (git 提交 / tag / 推送与文档更新是本 skill 的内部 Step 5/6,不另设独立 skill)
