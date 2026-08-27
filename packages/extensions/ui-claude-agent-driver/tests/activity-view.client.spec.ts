import {
  AgentDriverActivationId, AgentDriverActivityId, AgentDriverId, Session, SessionId,
} from '@deepseek-ai/dsh-session'
import {
  ConversationNodeAssembler,
} from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it } from 'vitest'
import {
  driverActivityDefinition, driverActivityViewDefinition, DriverActivitySnapshotBuilder,
} from '../src/client/activity-view.ts'

describe('Claude Driver Activity read-only projection', () => {
  it('projects generic activity facts and folds repeated identities to the latest snapshot', () => {
    const session = Session.create(SessionId('activity-session'))
    const activityId = AgentDriverActivityId('activity-1')
    const firstData = { kind: 'tool', phase: 'started', title: 'Bash' }
    session.append('agent-driver/activity', {
      owner: AgentDriverId('claude'),
      activationId: AgentDriverActivationId('activation-1'),
      activityId,
      kind: 'tool',
      phase: 'started',
      title: 'Bash',
      data: { storage: 'inline', bytes: new TextEncoder().encode(JSON.stringify(firstData)).byteLength, data: firstData },
    })
    const secondData = {
      kind: 'tool',
      phase: 'completed',
      title: 'Bash',
      summary: 'Native execution remains owned by Claude Code.',
    }
    session.append('agent-driver/activity', {
      owner: AgentDriverId('claude'),
      activationId: AgentDriverActivationId('activation-1'),
      activityId,
      kind: 'tool',
      phase: 'completed',
      title: 'Bash',
      summary: 'Native execution remains owned by Claude Code.',
      data: { storage: 'inline', bytes: new TextEncoder().encode(JSON.stringify(secondData)).byteLength, data: secondData },
    })

    const assembler = new ConversationNodeAssembler(
      { entries: () => [driverActivityDefinition], fallbackEntry: () => undefined },
      { entries: () => [driverActivityViewDefinition] },
    )
    assembler.replaceWindow(session.events.map(event => ({ event, view: undefined })), false)
    assembler.flush()
    const snapshot = assembler.get('driver-activity')
    expect(snapshot?.activities).toHaveLength(1)
    expect(snapshot?.activities[0]?.data).toMatchObject({ phase: 'completed', summary: 'Native execution remains owned by Claude Code.' })
  })

  it('keeps the empty snapshot stable before any activity arrives', () => {
    const builder = new DriverActivitySnapshotBuilder()
    expect(builder.empty.activities).toEqual([])
    expect(builder.replace({ nodes: [] }).activities).toEqual([])
  })
})
