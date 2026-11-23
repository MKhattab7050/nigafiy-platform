import { beforeEach, describe, expect, it } from 'vitest';
import { LEGACY_ENV, readEnv, resetEnvWarnings, withNewNames } from '../src/config/env-compat.ts';

describe('environment variables after the rename (LD_* → NIGAFIY_*)', () => {
  beforeEach(() => resetEnvWarnings());

  it('readEnv prefers the new name, falls back to the legacy one, and warns once', () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    expect(readEnv('NIGAFIY_DATA_DIR', { LD_DATA_DIR: 'a' }, warn)).toBe('a');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('LD_DATA_DIR');
    expect(warnings[0]).toContain('NIGAFIY_DATA_DIR');
    // Once per name per process.
    expect(readEnv('NIGAFIY_DATA_DIR', { LD_DATA_DIR: 'a' }, warn)).toBe('a');
    expect(warnings).toHaveLength(1);

    expect(readEnv('NIGAFIY_BUNDLE_DIR', { NIGAFIY_BUNDLE_DIR: 'new', LD_BUNDLE_DIR: 'old' }, warn)).toBe('new');
    expect(warnings).toHaveLength(1);

    expect(readEnv('NIGAFIY_PG_DIR', {}, warn)).toBeUndefined();
    expect(readEnv('NIGAFIY_PG_DIR', { LD_PG_DIR: '' }, warn)).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it('names without a legacy twin (already new) are read as they are', () => {
    expect(readEnv('NIGAFIY_REQUIRE_SIGNING', { NIGAFIY_REQUIRE_SIGNING: '1' })).toBe('1');
    expect(readEnv('NIGAFIY_REQUIRE_SIGNING', {})).toBeUndefined();
  });

  it('every legacy name is LD_ plus the same suffix', () => {
    for (const [name, legacy] of Object.entries(LEGACY_ENV)) {
      expect(name.startsWith('NIGAFIY_')).toBe(true);
      expect(legacy).toBe(`LD_${name.slice('NIGAFIY_'.length)}`);
    }
  });

  it('withNewNames fills the new names from the old ones', () => {
    const out = withNewNames({ LD_DATA_DIR: 'd', NIGAFIY_BUNDLE_DIR: 'b', LD_BUNDLE_DIR: 'x', PATH: 'p' }, () => undefined);
    expect(out.NIGAFIY_DATA_DIR).toBe('d');
    expect(out.NIGAFIY_BUNDLE_DIR).toBe('b');
    expect(out.PATH).toBe('p');
  });
});
