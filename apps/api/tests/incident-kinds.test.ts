import { describe, expect, it } from 'vitest';
import { systemPool } from '../src/infrastructure/db.ts';
import { INCIDENT_KINDS } from '../src/modules/incidents/kinds.ts';

/**
 * A kind added in the code but not in a database constraint broke the knowledge capture job on every
 * run (knowledge_entries_incident_kinds_check). The code list and both constraints must agree.
 */
async function kindsAllowedBy(table: string, constraint: string): Promise<string[]> {
  const r = await systemPool.query<{ def: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conrelid = $1::regclass AND c.conname = $2`,
    [table, constraint],
  );
  expect(r.rowCount, `${constraint} exists`).toBe(1);
  // Either ARRAY['a'::text, 'b'::text] or '{a,b}'::text[] depending on how it was written.
  const def = r.rows[0]!.def;
  const literal = /'\{([^}]*)\}'/.exec(def);
  const kinds = literal ? literal[1]!.split(',') : [...def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
  return kinds.map((k) => k.replace(/"/g, '')).sort();
}

describe('incident kinds agree everywhere', () => {
  it('code, incidents_kind_check and knowledge_entries_incident_kinds_check name the same kinds', async () => {
    const code = [...INCIDENT_KINDS].sort();
    expect(await kindsAllowedBy('incidents', 'incidents_kind_check')).toEqual(code);
    expect(await kindsAllowedBy('knowledge_entries', 'knowledge_entries_incident_kinds_check')).toEqual(code);
  });
});
