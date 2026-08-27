/** Localized copy for the Claude Agent Driver management entry. */

/** Locale keys rendered by the Claude Driver settings page. */
export type ClaudeDriverLocaleKey =
  | 'nav' | 'title' | 'loading' | 'error' | 'retry' | 'missing'
  | 'active' | 'inactive' | 'nativeOwnership' | 'nativeOwnershipDetail'
  | 'unsupported' | 'unsupportedDetail' | 'grokReserved' | 'capabilities'
  | 'activityTitle' | 'activityReadOnly' | 'activitySession' | 'activityDriver'
  | 'activityNativeConversation' | 'activityStatus' | 'activityHeading'
  | 'activityEmpty' | 'activityUnknown'

/** English copy. */
export const en: Record<ClaudeDriverLocaleKey, string> = {
  nav: 'Claude Code',
  title: 'Claude Code Agent Driver',
  loading: 'Loading Driver status…',
  error: 'Could not load Agent Drivers.',
  retry: 'Retry',
  missing: 'The Claude Driver is not active in this Host.',
  active: 'Available for new Sessions',
  inactive: 'Unavailable',
  nativeOwnership: 'Native ownership',
  nativeOwnershipDetail: 'Instructions, skills, tools, hooks, approvals, and execution remain owned by Claude Code.',
  unsupported: 'Explicit incompatibility',
  unsupportedDetail: 'Provider, model, and effort selections that Claude cannot represent are rejected before the turn.',
  grokReserved: 'Grok remains a reserved blank adapter.',
  capabilities: 'Native capabilities',
  activityTitle: 'Driver Activity',
  activityReadOnly: 'Read-only native input, output, and activity. Send messages from Chat.',
  activitySession: 'DSH Session',
  activityDriver: 'Agent Driver',
  activityNativeConversation: 'Native conversation',
  activityStatus: 'Status',
  activityHeading: 'Native activity',
  activityEmpty: 'No native activity recorded.',
  activityUnknown: 'Unknown',
}

/** Simplified Chinese copy. */
export const zh: Record<ClaudeDriverLocaleKey, string> = {
  nav: 'Claude Code',
  title: 'Claude Code Agent Driver',
  loading: '正在加载 Driver 状态…',
  error: '无法加载 Agent Driver。',
  retry: '重试',
  missing: '此 Host 未启用 Claude Driver。',
  active: '可用于新建 Session',
  inactive: '不可用',
  nativeOwnership: '原生所有权',
  nativeOwnershipDetail: 'Instructions、skills、tools、hooks、approvals 与执行仍由 Claude Code 负责。',
  unsupported: '明确的不兼容',
  unsupportedDetail: 'Claude 无法表示的 provider、model 与 effort 会在 turn 开始前被拒绝。',
  grokReserved: 'Grok 仍是预留的空白适配器。',
  capabilities: '原生能力',
  activityTitle: 'Driver Activity',
  activityReadOnly: '只读的原生输入、输出与 activity。请在 Chat 中发送消息。',
  activitySession: 'DSH Session',
  activityDriver: 'Agent Driver',
  activityNativeConversation: '原生 conversation',
  activityStatus: '状态',
  activityHeading: '原生 activity',
  activityEmpty: '没有记录原生 activity。',
  activityUnknown: '未知',
}
