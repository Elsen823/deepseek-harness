# @deepseek-ai/dsh-plan-proposal

English | [中文](README.zh.md)

Function plugin registering the `proposedPlan` SessionProjection. It folds `agent-driver/proposed-plan` as a whole durable document with branded id, owner, title, markdown content, lifecycle (`proposed`, `accepted`, `rejected`, or `superseded`), and optional relation/routing data, or as `null` when the owner clears its current document.

Proposed Plan is independent of Plan Mode and Checklist state: Plan Mode controls collaboration guidance, Checklist reports current work, and this package exposes a completed document for review or later implementation.

## Composition

```yaml
- id: plan-proposal
  name: '@deepseek-ai/dsh-plan-proposal'
```

The plugin injects `sessionProjections`. Its `./types` and `./client` exports are type-only faces for Host and Client projection consumers. Unloading the plugin removes only the projection registration; the statically known durable document event remains readable.

## Model Experience

None, as the package provides no plan controller, prompt guidance, review tool, or model-facing message.

#### KV Cache effect

None; it never assembles or sends a model request.

## Known Limitations and Deferred Work

- Lifecycle policy is owner-specific. The portable projection records whole snapshots and does not impose a common transition controller.
- The package exposes only the latest document snapshot; historical lifecycle facts remain in the Session log.
