# Agent Note: next-step steering survives the idle handoff

Status: implemented

[English](2026-08-25-next-step-steering-idle-handoff.md) | 中文

## 问题

AgentLoop 可能在 `next-step` inbox 为空的检查后结束 Turn，而排队的 microtask 仍然可以提交 steering。该消息会在 running phase 发布 `idle` 之前到达，但 live phase 不会保留 wake 请求，导致持久化消息一直等待无关的后续 wake。

## 决策

`ReactLoopAgent` 在最终的 `turn/end` inbox 检查之前立即将 running phase 标记为 closing。在 closing 窗口中请求的 wake 会被锁存，并在 phase 发布 `idle` 后重放；maintenance 期间或 abort 之后提交的 wake 保持原有的重放行为，而 disposal 永远不会启动新的 Turn。非 wake 的 `inject()` 消息继续保持停放语义。

## 考虑过的替代方案

**在 phase teardown 时唤醒所有 pending inbox 消息。** 这也会运行有意提交给 idle Agent、但没有 wake 请求的 `inject()` context。wake marker 因而仍然只绑定调用方明确请求的 wake。

**依赖 `agent/turn-stopping`。** 该扩展点会在最终检查之前等待，但无法观察 handoff 期间更晚的 microtask 提交的消息。phase 所有的 closing marker 覆盖了这个时序间隙，不改变扩展 API。

## 后果

在最终 inbox 检查之间到达的 steering 与 follow-up message 会获得一次自动 continuation，不再停留。loop 继续区分会唤醒的 Chat input 与不会唤醒的 injected context，并且新增 phase bit 只存在于进程内，不改变 Session event format。

## 验证

contract-regression 测试从 `turn/end` 监听器附加的 microtask 中调度 `steer()`，随后断言第二个 request 消费它且 `next-step` inbox 为空。AgentLoop loop、cancellation、coverage-edge 与 contract-regression 测试套件均通过。
