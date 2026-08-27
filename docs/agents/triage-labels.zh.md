# 分流标签

[English](triage-labels.md) | 中文

Matt engineering skills 使用这些确切的本地工单状态。

| Skill 角色 | 本地状态 | 含义 |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | 维护者必须评估请求。 |
| `needs-info` | `needs-info` | 工单正在等待必需的信息。 |
| `ready-for-agent` | `ready-for-agent` | 工单已完整说明且尚未认领。 |
| `ready-for-human` | `ready-for-human` | 工作需要人工负责人。 |
| `wontfix` | `wontfix` | 不会实现该请求。 |

当 skill 指定一个分流角色时，在工单的 `Status:` 行写入对应值。
