import { closeSessionOperation } from '../../session-close.js';
import { registerResource } from '../crud.js';

registerResource({
  name: 'session',
  plural: 'sessions',
  table: 'sessions',
  description:
    'Session — the runtime unit. Maps one (agent_group, messaging_group, thread) combination to a container with its own inbound.db and outbound.db. Created automatically by the router when a message arrives.',
  idColumn: 'id',
  scopeField: 'agent_group_id',
  columns: [
    { name: 'id', type: 'string', description: 'UUID.', generated: true },
    { name: 'agent_group_id', type: 'string', description: 'Agent group this session runs.' },
    {
      name: 'messaging_group_id',
      type: 'string',
      description: 'Messaging group this session serves. Null for agent-shared sessions.',
    },
    {
      name: 'thread_id',
      type: 'string',
      description: 'Thread ID. Only set for per-thread session mode.',
    },
    {
      name: 'agent_provider',
      type: 'string',
      description: 'Provider override. Null means inherit from agent group.',
    },
    {
      name: 'status',
      type: 'string',
      description: '"active" receives messages. "closed" is archived.',
      enum: ['active', 'closed'],
    },
    {
      name: 'container_status',
      type: 'string',
      description:
        '"running" — container alive and polling. "stopped" — container exited; the sweep will restart it automatically when due messages arrive. "idle" — reserved, currently unused.',
      enum: ['running', 'idle', 'stopped'],
    },
    { name: 'last_active', type: 'string', description: 'Last message or heartbeat. Used for stale detection.' },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  // No generic `delete`: two central-DB tables carry an FK to sessions(id)
  // (pending_questions.session_id NOT NULL, pending_approvals.session_id) and
  // the connection runs `foreign_keys = ON`, so a single-table DELETE fails the
  // moment a card is outstanding. `close` is the architecture's own retirement
  // mechanism — `status = 'closed'` is already in the column's enum, every
  // session lookup filters `status = 'active'`, and host-sweep uses exactly
  // this transition to GC spent task sessions.
  operations: { list: 'open', get: 'open' },
  // Reach-in owned by the `work-subdir` skill: the operation body lives in
  // src/session-close.ts so this file keeps a two-line integration point.
  customOperations: { close: closeSessionOperation },
});
