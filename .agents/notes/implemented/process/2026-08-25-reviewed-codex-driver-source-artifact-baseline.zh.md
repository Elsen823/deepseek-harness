# Agent Note: Codex Agent Driver 的已审查源码到产物基线

Status: implemented

[English](2026-08-25-reviewed-codex-driver-source-artifact-baseline.md) | 中文

## 问题

Codex Agent Driver 源码位于 DeepSeek Harness Git checkout 之外，而运行中的 Web profile 消费 npm archive。源码目录、残留的 `lib/` 文件或旧 archive 本身都不能证明已审查源码树生成了已安装包，也不能证明 profile 解析到了预期产物。

常驻 app-server 运行在 Web service 的私有 `/tmp` 挂载中。实时 assembled test 如果在 Host `/tmp` 下创建 activation token，会让 daemon 得到不可读的路径，并把本来有效的模型请求变成无效的 activation credential。

## 决策

基线使用 `/home/elsen_xu/deepseek-harness/.agents/research/codex-agent-driver-source-manifest.json` 记录外部包已审查源码根目录（`src/`、`tests/` 和 `scripts/`）以及 package 和文档输入的 SHA-256 与字节数。`scripts/verify-baseline.mjs` 要求该 manifest 匹配，按源码 package 选择检查 package payload，核验 archive 哈希与 profile 依赖，将全新安装与 archive 逐字节比较，并检查已安装包中的 Host、Chat、原生 skills、身份、只读 TUI 与限制说明标记。

外部构建在使用显式 `DSH_CHECKOUT` 编译前删除生成的 `lib/`；`prepack` 重新构建 Host 与 client 产物并运行 typecheck。每次 cutover 都在新的版本化 `dist/` 目录创建 archive，并在隔离 profile 中安装后核验。

package 中的 Codex 版本与 schema digest 只是构建来源记录，不是运行时最低版本。运行时准入会发现已安装的 executable 与相邻 sidecar、验证当前 schema、重新执行 `initialize`／`initialized` 握手与行为探针，并在缓存 attestation 前再次核验 executable、sidecar 与 resident identity。因此，外部更新 Codex 后只需受控重启 app-server 并重新准入，不需要修改 Driver package 版本。

常驻 assembled fixture 在 `XDG_RUNTIME_DIR` 下创建根目录；该变量缺失时使用用户 home cache，从而让 daemon 与测试进程共享 workspace 和 activation-token 路径。这是测试环境要求；生产 token 位置仍由显式配置的 DSH token directory 决定。

package README 保留有意限制：Bridge 不支持原生 `web_search`，浏览器 TUI 只读，不投影原生协作控制，Grok 是预留的空白 adapter。Verifier 不会写入运行中的 profile 或 service，也不会重启 Web 或共享 Codex app-server。

## 考虑过的替代方案

**信任已安装 archive 或残留的 `lib/` 树。** 不采用，因为二者都不能标识已审查的外部源码，也不能证明 profile 解析到了当前构建产生的 archive。

**在 Host `/tmp` 下创建常驻 fixture。** 不采用，因为 `PrivateTmp=yes` 会让共享 daemon 看不到该路径，并使命令驱动的 activation credential 无效。

**在基线核验期间替换运行中的 profile。** 不采用，因为可复现基线可以使用隔离安装，同时保留常驻 service、共享 app-server 和无关的 live Agent。

## 后果

外部源码仍位于 Git 之外；每次源码、package、脚本、test 或 README 变更后都必须重新审查并生成 manifest。每次核验都使用新的版本化 archive 目录与隔离 profile；安装到实时 profile 仍需单独授权。基线证明源码、archive、安装结果与 profile 身份一致，但不声称验证实时 Web 行为，也不声称支持可写 TUI 输入、原生 web search、协作模式 UI 或 Grok。

## 验证

已审查 manifest 覆盖 62 个文件，tree SHA-256 为 `17d61bb5ad7d31459922797ce8fffdadd9038e65e599063ba275c7a4ec85f1b8`。`DSH_CHECKOUT=/home/elsen_xu/deepseek-harness npm run prepack` 通过，完整外部 test suite 报告 23 个文件、143 个测试通过、2 个测试跳过。隔离的 `r22` archive 位于 `dist/cutover-20260826-r22/dsh-external-dsh-codex-agent-driver-0.0.1.tgz`，SHA-256 为 `89d6bbbd0a0fab4693e822477003113611e307e9455ba58353a8236ad2ab2f9f`；`verify-baseline.mjs` 对隔离 profile 核验通过，installed-tree SHA-256 为 `1781707e2fbd909974eccc2fc6aee8ba7635dbad4f87fcf8fc688257023875c9`。隔离 runtime 没有 Codex daemon socket 时，专用 resident assembled 命令会自行跳过，因此实时安装与行为仍是单独的验证项。
