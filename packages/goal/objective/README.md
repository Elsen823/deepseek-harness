# @deepseek-ai/dsh-objective

English | [中文](README.zh.md)

Function plugin registering the `objective` SessionProjection. It folds native `agent-driver/objective` whole snapshots and adapts authoritative DSH `goal/change` facts into one Driver-neutral value without emitting another event. The public snapshot has an explicit owner, normalized phase, optional budget/attention/stop facts, and opaque lossless-JSON routing data; it deliberately has no common Goal id, revision, or compare-and-set operation.

## Composition

```yaml
- id: objective
  name: '@deepseek-ai/dsh-objective'
```

The plugin injects `sessionProjections`. Its `./types` and `./client` exports are type-only faces for Host and Client projection consumers. Unloading the plugin removes only the projection registration; statically known `agent-driver/objective` events remain readable from the Session log.

## DSH Goal adaptation

A valid non-clear `goal/change` maps owner `dsh`, the Goal objective and phase, a `goal-rounds` budget (`limit = maxGoalRounds`, `consumed = roundsStarted`), blocked attention, completion stop reason, and owner routing containing the Goal id and revision. A clear tombstone maps to `null`. DSH Goal validation, revision, mutation, activation, and continuation semantics remain authoritative in `@deepseek-ai/dsh-goal`.

## Model Experience

None, as the plugin reads already-durable facts and registers no prompt section, message, model tool, or controller.

#### KV Cache effect

None; it never assembles or sends a model request.

## Known Limitations and Deferred Work

- The projection is read-only. Driver-specific control operations remain in their owning Driver integration.
- Unknown native phase detail belongs in the event's nested Driver payload; the portable phase stays within the documented normalized set.
