/**
 * Validation for per-wiring working-subdirectory paths (migration 020).
 *
 * A `work_subdir` must be a relative path that stays inside the group dir
 * (`/workspace/agent`). The host mounts the group dir RW and the container's
 * cwd becomes `/workspace/agent/<work_subdir>`, so an absolute path or a `..`
 * escape would point the agent's working dir outside the sandboxed group dir.
 * This is the single source of truth for the rule — the CLI validates on
 * create/update; the host re-resolves the stored value at spawn.
 */
import path from 'path';

/**
 * Validate and normalize a work-subdir path. Returns the normalized relative
 * path (POSIX separators, no trailing slash, no leading `./`). Throws an
 * actionable Error on anything that isn't a safe relative subpath.
 */
export function validateWorkSubdir(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('--work-subdir must be a string');
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('--work-subdir must not be empty');
  if (path.isAbsolute(trimmed) || trimmed.startsWith('/')) {
    throw new Error('--work-subdir must be a relative path, not absolute');
  }
  // Normalize with the POSIX resolver — the container path is always POSIX,
  // and this collapses `./`, `//`, and interior segments so the `..` check
  // below can't be fooled by e.g. `a/../../etc`.
  const norm = path.posix.normalize(trimmed).replace(/\/+$/, '');
  if (norm === '' || norm === '.') {
    throw new Error('--work-subdir must name a subdirectory, not the workspace root');
  }
  if (norm === '..' || norm.startsWith('../') || norm.split('/').includes('..')) {
    throw new Error('--work-subdir must not contain ".." segments (would escape the group dir)');
  }
  return norm;
}
