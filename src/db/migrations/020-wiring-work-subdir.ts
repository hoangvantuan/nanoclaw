import type { Migration } from './index.js';

/**
 * Per-wiring working-subdirectory override on `messaging_group_agents`.
 *
 * NULL = the session works in `/workspace/agent` (the shared group dir), the
 * pre-migration behavior — nothing changes for existing rows. A non-null,
 * relative path (validated at the CLI: relative, no `..`, never
 * `session_mode='agent-shared'`) makes the session's container cwd
 * `/workspace/agent/<work_subdir>` instead, giving that wiring an isolated
 * project directory that still inherits the group's global MCP/skill config.
 * Deliberately no backfill: existing wirings stay NULL and keep using the
 * shared group dir.
 */
export const migration020: Migration = {
  version: 20,
  name: 'wiring-work-subdir',
  up(db) {
    db.exec(`ALTER TABLE messaging_group_agents ADD COLUMN work_subdir TEXT;`);
  },
};
