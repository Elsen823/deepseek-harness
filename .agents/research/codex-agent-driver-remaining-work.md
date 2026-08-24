# Resident Codex Agent Driver：未完成工作

更新时间：2026-08-24

## 当前目标

把 Codex CLI `0.149.1` 作为与内置 `dsh` 并列的、按 Session 不可变绑定的一等 Agent Driver 交付到当前 DSH Web，并完成持久化迁移、真实 GUI 验证和 GIF 证据。

## 当前状态

实现主体已完成，但尚未达到可切换生产状态。核心实现位于独立 worktree：

- Worktree：`/home/elsen_xu/worktrees/dsh-codex-agent-driver`
- 分支：`local/codex-agent-driver`
- 基线：`aaf6e59ec6678f3f57f8d250099175000ef4b81e`
- 外部 Bundle：`/home/elsen_xu/dsh-plugins/dsh-codex-agent-driver`
- Bundle 包名：`@dsh-external/dsh-codex-agent-driver`

当前核心 worktree 和外部 Bundle 都有未提交变更。不要把当前工作树当作已通过最终门禁的提交。

## 已完成且已有证据的部分

### DSH 核心

- Session header 必须持久化 `driverId`；旧日志缺失该字段时拒绝读取。
- `AgentDriverId`、Driver 注册表、默认 Driver、按 Session 不可变绑定和 Driver 切换 fork 已实现。
- Driver 注册采用 generation drain；最新修复会动态等待 drain 期间新增的 pending/live 生命周期。
- Driver prepare 在取消后晚到的返回值会等待其异步 disposer 完成。
- persistence resume 在 Driver 选择或 owner 活性检查失败时会释放已拥有的 `SessionPreparation`。
- `SessionRuntimeStatus` 已加入 cold／activating／available／unavailable、二进制 activity、approval/user-input attention 和开放 Driver detail。
- 持久化但未激活的 Session 会物化 `cold` runtime，而不是省略 runtime。
- Goal、自动 Goal round、Plan Mode、permission presets 和 `todo_write` 只拥有内置 `dsh` Driver。
- 跨 Driver fork 会移除 `goal/change`、`plan/mode`、permission/sandbox/approval、`todo/write`、Objective、Proposed Plan，以及 `/plan` 的 `command/run`／`command/done` 生命周期。
- `agent-driver/model-request.retryPolicy` 在源码中已改为必填。
- TypeScript SDK 对 `session/runtime` 做完整 wire 校验；非法 availability、attention、operation、revision 和 timestamp 会被拒绝。
- Python SDK 的 Driver/runtime 投影测试此前为 30/30 通过。
- legacy Session migration 支持 dry-run manifest、脚本 SHA 绑定、全日志验证、zstd frame 保留、hard-link backup、fsync、atomic rename 和 journal。
- migration CLI 已移除机器专属 Session id；非 quiesced dry-run 必须显式提供 `--skip-session-id`，完全 quiesced dry-run 必须提供 `--confirm-quiesced`。
- migration 对 rename 已发布但后续 fsync/校验失败使用 `replacement-published-unverified`，不会误报为“未修改”。

最新核心 focused 证据（在最后一轮 Thread continuity WIP 之前）：

```text
pnpm exec tsc -p tsconfig.host.json --pretty false
9 test files passed
134 tests passed
```

覆盖 migration、Driver lifecycle、Session Driver events、fork、TS SDK、SDK server、todo ownership 和 permission ownership。

### 外部 Codex Bundle

- 精确支持 `codex-cli 0.149.1`。
- 精确 schema SHA-256：`9b3de71a5a2ffc980b792a18aa8f8dec3f85f48829560222a0264fe494b679a9`。
- 要求配置 CLI 相邻存在可执行 `codex-code-mode-host`。
- load-time admission 会校验 CLI、sidecar、schema、运行中 daemon descriptor、managed CLI、managed sidecar 和 socket。
- 每个 Session Activation 会重新核验已准入的 executable identity。
- 当前真实 daemon 精确证据：

```text
CLI SHA-256:                 73dc5888888f411c1f0fa7b81d866e721dcc86b527ce8e3b2cf4708661e823ba
Resident CLI SHA-256:        73dc5888888f411c1f0fa7b81d866e721dcc86b527ce8e3b2cf4708661e823ba
Sidecar SHA-256:             48f3a0d48033039cc7caccd209edb0ee350b81f82ca851a7b129e146e4bec6fb
Resident sidecar SHA-256:    48f3a0d48033039cc7caccd209edb0ee350b81f82ca851a7b129e146e4bec6fb
Socket: /home/elsen_xu/.codex/app-server-control/app-server-control.sock
```

- Code Mode 缺 sidecar 的原始故障已修复；真实 smoke 已成功返回 `437`，没有 missing-host 错误。
- Responses Bridge 使用 authenticated loopback `/v1/responses` 和 `ctx.llm.prepareCall(...).stream(...)`。
- Codex provider retry 固定为 0，DSH retry policy 是唯一重试权威。
- failed-attempt partial output 不会进入 Codex。
- raw/encrypted reasoning 不进入 DSH activity 或最终输出。
- Objective、Checklist、Proposed Plan、activity、approvals、questions 和 checkpoints 已实现。
- unknown notification 已改为 exact first-class allowlist，但“语义 namespace 下未知通知必须 fail closed”的最后修复尚未完成，见下文。
- JSON-RPC request timeout/abort 会使 peer fatal，避免晚到 mutating response 继续复用连接。
- peer disposal 在 inbound request handler 未 quiesce 时会显式失败。
- `prepack` 会重建 host、client 并 typecheck；dry-run pack freshness test 已通过。
- 最新 package freshness test：2/2 通过。
- 最后一次完整外部 suite 中，除 package test 的旧解析问题外其余 68 项通过；该 package test 随后单独修复并 2/2 通过。最终仍需再跑一次完整 suite。

### 最新 migration dry-run

当前 DSH 仍在写日志，因此只运行了显式跳过当前活动 Session 的安全 dry-run：

```text
Manifest: /tmp/dsh-session-driver-id-dry-run-20260824-hardening-final.json
Plan ID: 51520901-e441-47d4-84be-130de6888a6b
eligible: 744
skipped-active: 1
skipped-unsupported-event: 3
replacement-published-unverified: 0
error: 0
```

3 个 unsupported 日志包含尚未合并进隔离 worktree 的 `llm/service-tier` 事件。合并 live checkout 的 request-service-tier 变更并重新生成 known-event catalog 后，它们应变为 eligible。日志数量会继续增长，最终 cutover 必须重新 dry-run，不能使用以上 manifest apply。

## 当前正在编辑但尚未验证的代码

外部 Bundle 正在补齐同版本 native Thread continuity certification。当前工作树已开始以下改动，但还没有完成编译／测试闭环：

- `src/driver/codex-driver.ts`
  - 新增 durable native route certification。
  - 新增 turn count、last turn id/status、last item id continuity snapshot。
  - `thread/read` 计划同时核验 `cliVersion`、cwd、provider/model/policy/sandbox 和最后 native Turn 位置。
  - mismatch 应走现有 fresh Thread reconstruction。
- `src/driver/codex-agent.ts`
  - 新增 native route 和 native Turn count 状态。
  - checkpoint payload 正在改为携带 route + continuity。
- `src/driver/projection.ts`
  - `completedTurn()` 正在增加 `lastItemId`。
- `tests/driver/codex-driver.spec.ts`
  - 还需要为 resume fixture 添加 certified checkpoint 和完整 `thread/read` 返回值。
- `tests/driver/codex-agent.spec.ts`
  - 已补 route fixture，但需要随新 checkpoint assertions 验证。

下一位执行者必须先完成这组 WIP，再运行 external typecheck/tests；不要直接提交当前中间状态。

## 尚未完成的阻塞项

### 1. 完成 native Thread continuity certification

目标：同版本 resume 不能只比较 `thread.id`。

必须完成：

- 在每个 activation checkpoint 和 turn checkpoint 记录：
  - effective provider
  - effective model
  - cwd
  - approval policy
  - sandbox
  - native turn count
  - last native turn id
  - last native turn status
  - last native item id
- `thread/read(includeTurns:true)` 必须核验：
  - `thread.id`
  - `thread.cliVersion === 0.149.1`
  - cwd
  - durable route settings
  - turn count
  - last turn id/status
  - last item id
- 缺少 certification 的旧 checkpoint 必须 reconstruct，不得 resume。
- mismatch、missing、remote read/resume error 使用 fresh Thread，并以净化后的 DSH 对话历史恢复。
- 增加测试：
  - exact continuity resume
  - shortened turns reconstruct
  - same last turn id but changed last item reconstruct
  - route/cwd mismatch reconstruct
  - legacy checkpoint without certification reconstruct

### 2. 未知语义通知必须 fail closed

当前 exact notification map 已存在，但不在 map 中的所有通知仍统一进入 bounded fallback。需要区分：

- 未知 `item/*`、`turn/*`、`thread/*`，以及会影响 model/tool/plan/diff/goal 生命周期的未知语义 namespace：fail owning Turn，不能降级为 fallback。
- 纯信息性新 namespace（例如未知 account/app/fs/project 状态）可以进入 bounded fallback activity。
- 更新 `tests/codex-client/codex-host-client.test.ts`：`item/futureNotification` 应触发 fatal-to-turn error，不能出现在 fallback list。

### 3. teardown 必须继续清理所有资源

`PreparedAgentDriver.dispose()` 当前仍按顺序 fail-fast：

```text
bridge -> agent -> client -> credential -> stopped event -> runtime -> scope
```

`client.dispose()` 现在可能因 inbound handler 未 quiesce 而拒绝。该拒绝不能跳过后续资源清理。需要：

- 使用 `Promise.allSettled` 或显式聚合 cleanup failures。
- 无论任何一步失败，都必须尝试：
  - credential deletion
  - runtime contribution disposal
  - Agent scope disposal
  - durable terminal activation/failure fact
- 最后抛出聚合后的首个／`AggregateError`，不能静默吞掉。
- activation prepare catch 也要采用同样的 best-effort cleanup。
- 增加 client-dispose rejection 测试，断言 token、runtime、scope 都已清理。

### 4. 重建核心 artifact plane

`AgentDriverModelRequestSnapshot.retryPolicy` 源码已必填，但当前 built declaration 和 Cordis API catalog 仍可能是旧的 optional 版本。必须按顺序运行：

```bash
cd /home/elsen_xu/worktrees/dsh-codex-agent-driver
pnpm run build
pnpm run gen-cordis-catalog
pnpm run gen-config-catalog
pnpm run gen-persistence-catalog
pnpm run gen-doc-graphs
```

然后确认：

```bash
grep -n "retryPolicy" packages/core/session/lib/types/types.d.ts
```

结果必须没有 `retryPolicy?`。

### 5. 最终 external tgz

现有 `/home/elsen_xu/dsh-plugins/dsh-codex-agent-driver/dsh-external-dsh-codex-agent-driver-0.0.1.tgz` 仍是旧产物，不能发布或安装为最终包。

完成代码和核心 integration 后运行：

```text
dev_build_plugin(dir=/home/elsen_xu/dsh-plugins/dsh-codex-agent-driver)
```

然后比较 tgz 与当前 `lib/**`，确认没有 stale artifact。

### 6. 最终门禁

核心至少需要：

```bash
CI=true pnpm run lint
pnpm run build
CI=true pnpm run doc-sync
pnpm exec vitest run <所有相关 focused tests>
git diff --check
```

还需要：

- Python SDK：`PYTHONPATH=python/sdk/src tmp/py-sdk-venv/bin/pytest python/sdk/tests/test_client.py -q`
- keyless snapshots：此前 126 passed / 2 skipped；核心 artifact 更新后再跑相关 snapshot。
- external：build、build:client、typecheck、69-test suite、assembled integration、wizard `bash -n`、real compatibility attestation、`npm pack --dry-run --json`。
- 最终两轴 Standards／Spec review；Code Review Graph 对这个 worktree 当前无 coverage，必须注明 direct-source fallback。

## 尚未开始的生产集成

### 合并到 live checkout

Live checkout：`/home/elsen_xu/deepseek-harness`，当前包含不能覆盖的 request-service-tier 相关 tracked/untracked 变更和 `CONTEXT.md`。

安全顺序：

1. 在隔离 worktree 完成并提交核心实现。
2. 在 live checkout stash tracked + untracked 变更。
3. cherry-pick 隔离提交。
4. pop stash。
5. 手动合并重叠：
   - `packages/core/session/src/types.ts`
   - `packages/core/session/src/known-event-types.ts`
   - persistence/session docs 和 i18n records
   - generated API/config/persistence catalogs
   - `.agents/research/`
6. 保留 request-service-tier 的 `llm/service-tier` event 声明和 known-event catalog。
7. 从 live checkout 重建 core/Web artifact。

### quiesced migration 与重启

当前 DSH Web 进程必须在最终 cutover 时停止；Codex daemon 必须保持运行。

停止所有可能追加 Session log 的 DSH writers 后，从合并后的 live checkout 运行全量 dry-run：

```bash
pnpm exec tsx scripts/migrate-legacy-session-driver-id.ts \
  --root /home/elsen_xu/.dsh/sessions \
  --manifest /tmp/dsh-session-driver-id-quiesced-final-dry-run.json \
  --confirm-quiesced
```

预期：

- `skipped-active: 0`
- `skipped-unsupported-event: 0`
- `skipped-malformed: 0`
- `skipped-changing: 0`
- `replacement-published-unverified: 0`
- `error: 0`

数量必须以当时 catalog 为准，不能沿用 744／748 等旧计数。

审查 manifest 后 apply：

```bash
pnpm exec tsx scripts/migrate-legacy-session-driver-id.ts \
  --apply \
  --confirm-quiesced \
  --from-dry-run /tmp/dsh-session-driver-id-quiesced-final-dry-run.json \
  --manifest /tmp/dsh-session-driver-id-quiesced-final-apply.json
```

如果出现 `replacement-published-unverified`，停止，不得自动重跑；先检查 live file、backup 和 journal。

重启 DSH 的 exact 命令：

```bash
cd /home/elsen_xu/deepseek-harness
node --import tsx/esm apps/cli/src/bin.ts web --no-open
```

不要停止 resident Codex app-server。

### Bundle 安装

当前 Bundle 只是 super-injector registry 中的 injected package，旧 core 上的 watch precheck 会失败。核心重启后：

- 验证 super-injector 是否自动重新注入新 generation。
- 使用 `dev_install_package` 将 Bundle 持久安装到 `web` profile。
- 验证 `ctx.agents` Driver catalog 同时有 `dsh` 和 `codex`。
- 验证 source artifact 和 client bundle 都来自最终 tgz／lib。

### 真实 GUI 与 GIF

必须在真实 `http://127.0.0.1:3081` 上验证并录 GIF：

- 空白 Session 首次 prompt 前可选择 Driver。
- 空白切换创建全新空 Session。
- 非空切换创建 fork，原 Session header 不变。
- Codex runtime cold／activating／available／unavailable 正确。
- Activity timeline 显示 command、tool、diff、plan、hook、MCP、warning、status、usage 和 fallback。
- approvals 和 questions 可交互；first response wins。
- Objective、Checklist、Proposed Plan 分离显示。
- Codex Session 不显示／不允许 DSH Goal、Plan Mode、permission preset、`todo_write` 控制。
- same-version resume 和 continuity mismatch reconstruction 都能在真实 GUI 中观察。
- Code Mode 不再出现 missing `codex-code-mode-host`。

录制前必须加载 `record-browser-gif` skill，并从真实 server/state-based capture 生成 GIF。

## 不可违反的约束

- 不覆盖 live checkout 中无关 request-service-tier 变更。
- 不启动替代 Web server；现有 GUI 只由 DSH Web 进程和 `window.__DSH_BOOT__` 驱动。
- 没有 `pnpm run dev:web` watcher 时，不承诺 shell/core 改动 HMR。
- 不停止 resident Codex app-server；它是共享长期服务。
- 单一完全互信域：Activation credential 只做 attribution/cancellation/audit，不做租户隔离。
- 一个 DSH-owned Thread 只有一个 owner/subscriber；observer 使用只读 API。
- raw chain-of-thought 永远不可暴露。
- model-visible 内容必须可从 DSH durable log 重建。
- Codex retry 必须保持 0；DSH retry policy 是唯一权威。
- Driver binding 永不原地修改；切换必须新建或 fork。
