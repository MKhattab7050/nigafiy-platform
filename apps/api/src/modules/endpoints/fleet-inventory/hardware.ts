import { z } from 'zod';
import { withTenant } from '../../../infrastructure/db.ts';
import { notifyRealtime } from '../../realtime/index.ts';
import type { EndpointContext } from '../schema.ts';

// Hardware and licence inventory (Fleet Pro, migration 043): what the agent measured about CPU,
// memory modules, system / board / BIOS, licences, physical disks and batteries, and why it could
// not measure the rest. Stored as reported (validated strictly); never a product key — the schema
// has no field that could carry one, and unknown fields are refused.

// eslint-disable-next-line no-control-regex
const text = (max: number) => z.string().max(max).regex(/^[^\u0000-\u001f\u007f]*$/, 'control characters are not allowed');
const opt = (max: number) => text(max).optional();
const nonNeg = z.number().int().min(0).max(2_000_000_000);
const big = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const agentHardwareSchema = z
  .object({
    collected_at: z.iso.datetime({ offset: true }),
    cpus: z
      .array(z.object({ name: text(160), manufacturer: opt(120), cores: nonNeg.optional(), threads: nonNeg.optional(), max_mhz: nonNeg.optional(), socket: opt(60) }).strict())
      .max(16),
    memory_modules: z
      .array(z.object({ slot: opt(60), capacity_mb: nonNeg, speed_mhz: nonNeg.optional(), type: opt(20), manufacturer: opt(120), part_number: opt(80) }).strict())
      .max(64),
    system: z.object({ manufacturer: opt(120), model: opt(120), serial: opt(120), sku: opt(120) }).strict(),
    board: z.object({ manufacturer: opt(120), product: opt(120), version: opt(60), serial: opt(120) }).strict(),
    bios: z.object({ vendor: opt(120), version: opt(120), release_date: opt(20) }).strict(),
    licences: z
      .array(
        z
          .object({
            kind: z.enum(['windows', 'office']),
            product: text(200),
            status: z.enum(['licensed', 'unlicensed', 'grace', 'notification', 'not_genuine', 'unknown']),
            detail: opt(300),
            source: text(200),
          })
          .strict(),
      )
      .max(32),
    physical_disks: z
      .array(
        z
          .object({
            name: text(160),
            model: opt(160),
            serial: opt(120),
            media_type: opt(20),
            bus: opt(40),
            size_gb: z.number().min(0).max(10_000_000).optional(),
            health: z.enum(['healthy', 'warning', 'unhealthy', 'unknown']).optional(),
            operational: opt(120),
            temperature_c: z.number().int().min(-50).max(200).optional(),
            wear_pct: z.number().int().min(0).max(1000).optional(),
            power_on_hours: nonNeg.optional(),
            read_errors_uncorrected: big.optional(),
            write_errors_uncorrected: big.optional(),
            reliability_note: opt(300),
            source: text(200),
          })
          .strict(),
      )
      .max(64),
    batteries: z
      .array(
        z
          .object({
            name: text(120),
            design_capacity_mwh: nonNeg.optional(),
            full_charge_capacity_mwh: nonNeg.optional(),
            health_pct: z.number().min(0).max(200).optional(),
            cycle_count: nonNeg.optional(),
            charge_pct: z.number().int().min(0).max(100).optional(),
            status: opt(60),
            source: text(200),
          })
          .strict(),
      )
      .max(8),
    unmeasured: z.record(z.string().regex(/^[a-z_]{1,40}$/), text(300)).refine((r) => Object.keys(r).length <= 32, 'too many entries'),
  })
  .strict();
export type AgentHardware = z.infer<typeof agentHardwareSchema>;

export async function recordHardware(ep: EndpointContext, body: AgentHardware): Promise<void> {
  await withTenant(ep.organizationId, async (db) => {
    await db.query(`UPDATE endpoints SET hardware = $2, hardware_updated_at = now() WHERE id = $1`, [ep.id, JSON.stringify(body)]);
    await notifyRealtime(db, ep.organizationId, 'devices');
  });
}
