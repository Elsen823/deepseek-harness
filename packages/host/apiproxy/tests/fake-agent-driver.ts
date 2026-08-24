import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentDriver, PreparedAgentDriver } from '@deepseek-ai/dsh-agent'
import { AgentDriverId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'

/** Register an effect-scoped inert Driver while preserving a suite's Agent double. */
export function registerFakeAgentDriver(
  ctx: Context,
  makeAgent: (session: Session) => Agent,
  id = AgentDriverId('dsh'),
  name = 'Test Driver',
): () => void {
  const driver: AgentDriver = {
    info: { id, name },
    prepare(session): PreparedAgentDriver {
      const agent = makeAgent(session)
      ;(agent as { ctx?: Context }).ctx = ctx.extend({ agent })
      return {
        agent,
        start() {},
        dispose: () => Promise.resolve(),
      }
    },
  }
  return ctx.agents.registerDriver(driver)
}
