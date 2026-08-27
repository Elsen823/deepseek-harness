import type { AgentDriverActivitySnapshot } from '@deepseek-ai/dsh-session'
import type {
  ConversationMatch, ConversationNodeDefinition, ConversationViewBuilder,
  ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import { EMPTY_DRIVER_ACTIVITY, type DriverActivitySnapshot, type DriverActivityViewNode } from './activity-contract.ts'


/** Read one activity payload after the event type guard has narrowed it. */
function activityOf(match: ConversationMatch): AgentDriverActivitySnapshot {
  if (match.event.type !== 'agent-driver/activity') {
    throw new Error('driver activity Definition received a non-activity event')
  }
  return match.event.data
}

/** One activity event becomes one Context; the builder folds repeated ids to their latest value. */
export const driverActivityDefinition: ConversationNodeDefinition<AgentDriverActivitySnapshot> = {
  kind: 'agent-driver/activity',
  target: 'driver-activity',
  match(event) {
    if (event.type !== 'agent-driver/activity') return null
    return { id: `${String(event.data.activityId)}:${event.seq}`, role: 'start' }
  },
  start(_context, match) {
    return activityOf(match)
  },
  update(_context, match) {
    return activityOf(match)
  },
  buildViewNode(context) {
    const start = context.start
    const state = context.state
    if (start === undefined || state === undefined) return null
    return {
      key: context.key,
      kind: 'agent-driver/activity',
      id: String(state.activityId),
      target: 'driver-activity',
      anchorSeq: start.event.seq,
      location: start.location,
      data: state,
    }
  },
}

/** Stable per-Session Activity target builder. */
export class DriverActivitySnapshotBuilder implements ConversationViewBuilder<
  DriverActivityViewNode,
  DriverActivitySnapshot
> {
  private readonly nodes = new Map<string, DriverActivityViewNode>()
  readonly empty = EMPTY_DRIVER_ACTIVITY

  replace(input: { readonly nodes: readonly DriverActivityViewNode[] }): DriverActivitySnapshot {
    this.nodes.clear()
    for (const node of input.nodes) this.nodes.set(node.key, node)
    return this.snapshot()
  }

  apply(input: { readonly upserts: readonly DriverActivityViewNode[] }): DriverActivitySnapshot {
    for (const node of input.upserts) this.nodes.set(node.key, node)
    return this.snapshot()
  }

  private snapshot(): DriverActivitySnapshot {
    const latestByActivity = new Map<string, DriverActivityViewNode>()
    for (const node of this.nodes.values()) {
      const previous = latestByActivity.get(node.id)
      if (previous === undefined || previous.anchorSeq < node.anchorSeq) latestByActivity.set(node.id, node)
    }
    return {
      activities: [...latestByActivity.values()].sort((left, right) =>
        left.anchorSeq - right.anchorSeq || left.key.localeCompare(right.key)),
    }
  }
}

/** Activity target registration consumed by the optional read-only surface. */
export const driverActivityViewDefinition: ConversationViewDefinition<
  DriverActivityViewNode,
  DriverActivitySnapshot
> = {
  target: 'driver-activity',
  create: () => new DriverActivitySnapshotBuilder(),
}

/**
 * Register the neutral activity Definition and its per-Session builder.
 * @param ctx - client registries that own the activity definition and builder.
 */
export function registerDriverActivityView(ctx: {
  conversationEvents: { register(definition: ConversationNodeDefinition): () => void }
  conversationViews: { register(definition: ConversationViewDefinition): () => void }
}): void {
  ctx.conversationEvents.register(driverActivityDefinition)
  ctx.conversationViews.register(driverActivityViewDefinition)
}
