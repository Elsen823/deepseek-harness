# Handoff：Resident Codex Agent Driver

更新时间：2026-08-24

## 任务

继续完成 Codex CLI `0.149.1` 一等 Agent Driver 的实现、合并、Session migration、真实 DSH Web 验证和 GIF 证据。

完整未完成事项见：[`codex-agent-driver-remaining-work.md`](./codex-agent-driver-remaining-work.md)。

## 工作位置

```text
Core worktree: /home/elsen_xu/worktrees/dsh-codex-agent-driver
Core branch:   local/codex-agent-driver
Core base:     aaf6e59ec6678f3f57f8d250099175000ef4b81e
Live checkout: /home/elsen_xu/deepseek-harness
Bundle:        /home/elsen_xu/dsh-plugins/dsh-codex-agent-driver
GUI:           http://127.0.0.1:3081
```

Durable goal：

```text
goal-d8db20fc-d8d1-48b0-b6f8-beeef0ca1c8e
revision 1
maxGoalRounds 96
```

## 重要状态

- Core worktree 未提交。
- External Bundle 不是 Git repository。
- Live checkout 有不能覆盖的 request-service-tier 和 `CONTEXT.md` 变更。
- 当前 DSH Web 仍从 live checkout 运行旧 core。
- Resident Codex app-server 必须保持运行。
- Bundle 当前在 super-injector registry 中，但旧 core 上 reload precheck 会失败；这不是最终安装状态。
- 现有 tgz 是旧产物，禁止作为最终包使用。

## 交接时的代码状态

最后一次核心 focused 验证在 native Thread continuity WIP 之前通过：

```text
9 test files passed
134 tests passed
host tsc passed
```

External：

```text
68 non-package tests passed in the last full run
package freshness tests fixed and then passed 2/2
real Codex 0.149.1 daemon/CLI/sidecar attestation passed
```

交接时正在修改、尚未重新 typecheck 的文件：

```text
/home/elsen_xu/dsh-plugins/dsh-codex-agent-driver/src/driver/codex-driver.ts
/home/elsen_xu/dsh-plugins/dsh-codex-agent-driver/src/driver/codex-agent.ts
/home/elsen_xu/dsh-plugins/dsh-codex-agent-driver/src/driver/projection.ts
/home/elsen_xu/dsh-plugins/dsh-codex-agent-driver/tests/driver/codex-driver.spec.ts
/home/elsen_xu/dsh-plugins/dsh-codex-agent-driver/tests/driver/codex-agent.spec.ts
```

这些文件正在增加 native route/turn continuity certification。当前中间状态可能不能编译，必须先完成再跑测试。

## 第一批动作

### 1. 完成 continuity WIP

在 `tests/driver/codex-driver.spec.ts` 的 same-version resume fixture 中追加 certified `agent-driver/checkpoint`，并让 fake `thread/read` 返回：

```text
id
cliVersion: 0.149.1
cwd
turns[]
last turn status
last item id
```

确认以下行为：

- 完全匹配：resume。
- certification 缺失：reconstruct。
- turn count／last turn／last item／cwd／route 任一不匹配：reconstruct。

然后运行：

```bash
cd /home/elsen_xu/dsh-plugins/dsh-codex-agent-driver
DSH_CHECKOUT=/home/elsen_xu/worktrees/dsh-codex-agent-driver bash scripts/build.sh
npm run typecheck
node node_modules/vitest/vitest.mjs run tests/driver/codex-driver.spec.ts tests/driver/codex-agent.spec.ts
```

### 2. 修复未知语义 notification

在 `src/codex/codex-host-client.ts`：

- 非 allowlist 的 `item/*`、`turn/*`、`thread/*` 不能进入 fallback。
- 它们必须调用 owning-Turn fatal path。
- 纯信息性未知 namespace 才允许 bounded fallback。

更新：

```text
tests/codex-client/codex-host-client.test.ts
```

当前测试仍把 `item/futureNotification` 当 fallback，必须改为 fail-closed 断言。

### 3. 修复 teardown fail-fast

在 `src/driver/codex-driver.ts`：

- prepared dispose 和 prepare catch 都要 best-effort 清理所有资源。
- `client.dispose()` 失败不能跳过 credential、runtime、scope 和 durable terminal event。
- 增加 cleanup failure regression test。

### 4. 再跑完整 external suite

```bash
cd /home/elsen_xu/dsh-plugins/dsh-codex-agent-driver
DSH_CHECKOUT=/home/elsen_xu/worktrees/dsh-codex-agent-driver bash scripts/build.sh
npm run build:client
npm run typecheck
CI=true npm test
bash -n scripts/codex-resident-host-wizard.sh
CI=true npm run test:assembled
```

## Core artifact 注意事项

源码已把 `AgentDriverModelRequestSnapshot.retryPolicy` 改为必填，但 built declaration／Cordis catalog 必须在完整 build 后重新生成。按这个顺序：

```bash
cd /home/elsen_xu/worktrees/dsh-codex-agent-driver
pnpm run build
pnpm run gen-cordis-catalog
pnpm run gen-config-catalog
pnpm run gen-persistence-catalog
pnpm run gen-doc-graphs
```

检查：

```bash
grep -n "retryPolicy" packages/core/session/lib/types/types.d.ts
```

不得出现 `retryPolicy?`。

随后：

```bash
CI=true pnpm run lint
CI=true pnpm run doc-sync
git diff --check
```

## 最新 migration 信息

安全 dry-run：

```text
/tmp/dsh-session-driver-id-dry-run-20260824-hardening-final.json
planId 51520901-e441-47d4-84be-130de6888a6b
744 eligible
1 skipped-active
3 skipped-unsupported-event (llm/service-tier)
0 replacement-published-unverified
0 error
```

这个 manifest 只能作为诊断证据，不能 apply。最终必须在合并 live request-service-tier 变更并停止所有 DSH writers 后，使用 `--confirm-quiesced` 重新生成 manifest。

## 真实 Codex admission 证据

```text
Version: 0.149.1
Schema: 9b3de71a5a2ffc980b792a18aa8f8dec3f85f48829560222a0264fe494b679a9
CLI/resident CLI SHA: 73dc5888888f411c1f0fa7b81d866e721dcc86b527ce8e3b2cf4708661e823ba
Sidecar/resident sidecar SHA: 48f3a0d48033039cc7caccd209edb0ee350b81f82ca851a7b129e146e4bec6fb
Socket: /home/elsen_xu/.codex/app-server-control/app-server-control.sock
```

Code Mode missing-host 故障已修复；不要移除以下 sidecars：

```text
/home/elsen_xu/.local/lib/dsh/codex-0.149.1/codex-code-mode-host
/home/elsen_xu/.codex/packages/standalone/current/codex-code-mode-host
```

## 合并和 cutover 摘要

1. 完成／review／commit isolated core。
2. stash live checkout tracked + untracked 变更。
3. cherry-pick core commit。
4. pop stash，并保留 request-service-tier 的 `llm/service-tier` 声明与 catalogs。
5. 从 live checkout rebuild core/Web。
6. 用 `dev_build_plugin` 生成新 tgz。
7. 停止 DSH Web writers，不停止 Codex daemon。
8. quiesced dry-run；必须 0 active／unsupported／malformed／changing／unverified／error。
9. apply exact manifest。
10. 以原命令重启 DSH Web。
11. 持久安装 Bundle 到 `web` profile。
12. 在真实 `http://127.0.0.1:3081` 验证 Driver selector、fork、runtime、activity、native work state、approvals/questions 和权限单一所有权。
13. 加载 `record-browser-gif` skill 并录真实 GUI GIF。
14. 通过全部门禁后完成 durable goal。

## 禁止事项

- 不覆盖 live checkout 无关改动。
- 不启动替代 GUI server。
- 不停止 resident Codex app-server。
- 不使用旧 tgz。
- 不 apply 旧 migration manifest。
- 不暴露 raw chain-of-thought。
- 不让 Codex 使用 DSH `todo_write`、Goal、Plan Mode 或 permission presets。
- 不把 Activation token 当作租户隔离边界。
