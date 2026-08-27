# Triage labels

English | [中文](triage-labels.zh.md)

Matt engineering skills use these exact local ticket states.

| Skill role | Local status | Meaning |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | A maintainer must evaluate the request. |
| `needs-info` | `needs-info` | The ticket is waiting for required information. |
| `ready-for-agent` | `ready-for-agent` | The ticket is fully specified and unclaimed. |
| `ready-for-human` | `ready-for-human` | The work requires a human owner. |
| `wontfix` | `wontfix` | The request will not be implemented. |

When a skill names a triage role, write the corresponding value in the ticket's `Status:` line.
