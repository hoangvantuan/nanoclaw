import { describe, it, expect } from 'vitest';

import { validateWorkSubdir } from './work-subdir.js';

describe('validateWorkSubdir', () => {
  it('accepts a simple relative subdir', () => {
    expect(validateWorkSubdir('projects/alpha')).toBe('projects/alpha');
  });

  it('normalizes leading ./, doubled slashes, and trailing slash', () => {
    expect(validateWorkSubdir('./projects//alpha/')).toBe('projects/alpha');
  });

  it('trims surrounding whitespace', () => {
    expect(validateWorkSubdir('  work/dir  ')).toBe('work/dir');
  });

  it('rejects a non-string', () => {
    expect(() => validateWorkSubdir(42)).toThrow(/must be a string/);
    expect(() => validateWorkSubdir(undefined)).toThrow(/must be a string/);
  });

  it('rejects empty / whitespace-only', () => {
    expect(() => validateWorkSubdir('')).toThrow(/must not be empty/);
    expect(() => validateWorkSubdir('   ')).toThrow(/must not be empty/);
  });

  it('rejects absolute paths', () => {
    expect(() => validateWorkSubdir('/etc/passwd')).toThrow(/relative/);
    expect(() => validateWorkSubdir('/workspace/agent/x')).toThrow(/relative/);
  });

  it('rejects the workspace root itself', () => {
    expect(() => validateWorkSubdir('.')).toThrow(/subdirectory/);
    expect(() => validateWorkSubdir('./')).toThrow(/subdirectory/);
  });

  it('rejects .. escapes, including interior ones', () => {
    expect(() => validateWorkSubdir('..')).toThrow(/\.\./);
    expect(() => validateWorkSubdir('../secrets')).toThrow(/\.\./);
    expect(() => validateWorkSubdir('a/../../etc')).toThrow(/\.\./);
  });
});
