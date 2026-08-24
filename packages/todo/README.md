# todo/ — Checklist capability family

English | [中文](README.zh.md)

Portable Checklist projection and its optional model-facing Consumer. Core Session owns `TodoItem` and `todo/write`; this group owns the read-side projection provider and the tool that produces validated whole-list writes.

| Package | Role | ctx key |
|---|---|---|
| [`todo/`](todo/README.md) | Service Provider for the `todos` SessionProjection; no tool or mutation controller. | (registers on `ctx.sessionProjections`) |
| [`tool-todo/`](tool-todo/README.md) | Consumer, validator, and executor for model-facing `todo_write`. | (registers on `ctx.tools`) |

Compose the provider exactly once per SessionProjection registry. The Consumer is optional and may be scoped independently. The event payload is documented on [docs/subsystems/session.md](../../docs/subsystems/session.md).
