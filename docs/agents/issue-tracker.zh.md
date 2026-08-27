# Issue tracker：Local Markdown

[English](issue-tracker.md) | 中文

本仓库的工程规格和工单位于 `.scratch/` 下。

## 约定

- 为每项功能建立一个 `.scratch/<feature-slug>/` 目录。
- 可选的功能规格存放在 `spec.md` 中，每个实现工单作为 `issues/` 下单独的编号文件存放。
- 按依赖顺序从 `01` 开始编号，将阻塞项放在其所阻塞的工单之前。
- 在 `Status:` 行记录工作流状态，并在 `Blocked by:` 行记录依赖边。
- 在 `## Comments` 下追加后续讨论，而不是改写已接受的工单。

## Skill 操作

- 发布会创建一个新的工单文件；不会改写无关工单。
- 获取会完整读取所引用的工单文件。
- 认领会在实现开始前将 `Status: ready-for-agent` 改为 `Status: claimed`。
- 解决会检查每项验收标准，记录结果，并将状态改为 `resolved`。
