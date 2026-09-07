---
name: code-review
description: 代码评审。当用户想评审一个分支/PR/工作区改动,或说"review 一下/review since X/代码评审/审查改动"时使用。对 diff 做双轴并行评审:Standards(编码规范+坏味道基线)与 Spec(是否忠实实现需求)。被 implement 调用。
argument-hint: "[fixed-point-ref]"
---

# Code Review(代码评审)

对自某个固定点以来的 diff 做评审。评审分两条**互不污染**的轴,各自独立给出发现:

- **Standards(规范轴)**——diff 是否遵循仓库的编码规范?外加一个 Fowler 坏味道基线(长方法、重复、巨类、神秘命名、过深嵌套等)。
- **Spec(需求轴)**——diff 是否忠实实现了它的来源需求(originating issue / PRD / feature 设计块)?

两轴并行(各自独立 sub-agent 或独立遍历)。

## 工作流

1. **钉住固定点。** 确认 ref(commit / branch / tag)有效、`git diff <fixed-point>...HEAD` 非空。在并行前就失败,别等评审跑完才发现没 diff。完成判据:fixed-point ref 有效且 git diff 非空。
2. **识别 spec 来源。** 从 commit message 找 issue 引用、从 `docs/` 找 PRD / feature 设计块。若无 spec 来源,明确告知需求轴将"无 spec 可比对",只评 Standards。完成判据:已定位 spec 来源,或已明确告知“无 spec 可比对”。
3. **双轴并行评审。**
   - Standards:读仓库的编码规范文件(如 `CODING_STANDARDS.md` / `.editorconfig` / lint 配置,有则用,无则用语言通用规范),逐文件评 diff;叠加 Fowler 坏味道基线。
   - Spec:对照 spec 来源,逐条核对 diff 是否覆盖、是否偏离、是否越界实现 spec 之外的东西。完成判据:每个改动文件均已逐条评 Standards + Spec。
4. **并排报告,不合并不重排。** 输出 `## Standards` 与 `## Spec` 两节,各自列 finding(文件:行 + 问题 + 建议)。末行汇总每轴 finding 数 + 最严重项。**不要把两轴发现合并成一个列表**,也不要重排顺序——保持双轴分离是本 skill 的核心价值。完成判据:## Standards 与 ## Spec 两节各列齐 finding,末行汇总每轴 finding 数 + 最严重项。

## 纪律

- **只评审 diff,不评审全仓。** 固定点之外的代码不在范围内。
- **发现要可行动。** 每条 finding 指明文件:行 + 问题 + 具体建议,不写"建议优化"这类空话。
- **不替作者改代码。** 评审产出报告,不直接修改;改不改由作者决定。

## 与其他 skill 的关系

- `implement`:构建/修复完成后调用,双轴确认是否符合规范且未越界。
