/** Claude Code as a first-class per-Session DeepSeek Harness Agent Driver. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-session-runtime'
import { ClaudeAgentDriver, CLAUDE_AGENT_DRIVER_ID, type ClaudeDriverConfig } from './driver.ts'

export {
  CLAUDE_AGENT_DRIVER_ID,
  ClaudeAgent,
  ClaudeAgentDriver,
  ClaudeModelRouteMapper,
  ClaudeModelSelectionError,
} from './driver.ts'
export type {
  ClaudeDriverConfig,
  ClaudeNativeEffort,
  ClaudeNativeModelSelection,
  ClaudeQueryFactory,
  ClaudeSessionObservation,
} from './driver.ts'
export { observeClaudeSession } from './observation.ts'

/** Loader name for the Claude Agent Driver package. */
export const name = 'claude-agent-driver'
/** Host services required by the Driver registration. */
export const inject = ['agents']

/** Deployment-owned Claude CLI and DSH route settings. */
export interface Config {
  /** DSH provider id represented by Claude Code. */
  provider?: string
  /** Default Claude model used for a blank Session. */
  model?: string
  /** DSH model ids mapped to native Claude model ids. */
  modelAliases?: Record<string, string>
  /** Optional exact allowlist; omission accepts documented Claude aliases and ids. */
  supportedModels?: string[]
  /** Native Claude effort levels accepted by this deployment. */
  supportedEfforts?: string[]
  /** Permission mode supplied to Claude Code; DSH does not rewrite native policy. */
  permissionMode?: ClaudeDriverConfig['permissionMode']
  /** Explicit Claude Code executable, when the bundled executable is not desired. */
  cliPath?: string
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  provider: z.string().default('anthropic'),
  model: z.string().default('claude-sonnet-4-6'),
  modelAliases: z.dict(z.string()).default({}),
  supportedModels: z.array(z.string()).default([]),
  supportedEfforts: z.array(z.string()).default(['low', 'medium', 'high', 'xhigh', 'max']),
  permissionMode: z.union([
    z.const('default'),
    z.const('acceptEdits'),
    z.const('bypassPermissions'),
    z.const('plan'),
    z.const('dontAsk'),
    z.const('auto'),
  ]).default('dontAsk'),
  cliPath: z.string(),
})

/** Register the Driver and its opaque management contribution. */
export function apply(ctx: Context, config: Config): void {
  const driverConfig: ClaudeDriverConfig = {
    provider: config.provider ?? 'anthropic',
    model: config.model ?? 'claude-sonnet-4-6',
    aliases: Object.freeze({ ...(config.modelAliases ?? {}) }),
    supportedModels: Object.freeze([...(config.supportedModels ?? [])]),
    supportedEfforts: Object.freeze([...(config.supportedEfforts ?? ['low', 'medium', 'high', 'xhigh', 'max'])]),
    permissionMode: config.permissionMode ?? 'dontAsk',
    ...config.cliPath === undefined ? {} : { cliPath: config.cliPath },
  }
  const driver = new ClaudeAgentDriver(ctx, driverConfig)
  ctx.agents.registerDriver(driver)
  ctx.agents.registerDriverContribution({
    id: 'claude-code-settings',
    driverId: CLAUDE_AGENT_DRIVER_ID,
    kind: 'settings',
    value: Object.freeze({
      provider: driverConfig.provider,
      model: driverConfig.model,
      native: 'claude-code',
      nativeInstructions: true,
      nativeSkills: true,
      nativeTools: true,
      nativeHooks: true,
      nativeApprovals: true,
    }),
  })
}
