import { z } from 'zod';

// Collector protocol v1 — Port Detective port control items (modules/ports/control). Kept in its own
// file so the shared collector-protocol.ts only gains union members. `.strict()` everywhere.
//
//  switch_vlans        the VLANs a switch defines and each port's VLAN membership (sent after every
//                      successful snmp_poll of a switch that exposes Q-BRIDGE or Cisco VLAN tables)
//  switch_port_result  the outcome of one `set_switch_port` command: values the collector read right
//                      before writing, values read back after, verified or not

const timestamp = z.iso.datetime({ offset: true });
// eslint-disable-next-line no-control-regex
const clean = (max: number) => z.string().max(max).regex(/^[^\u0000-\u001f\u007f]*$/, 'control characters are not allowed');
const vlanId = z.number().int().min(1).max(4094);
const ifIndex = z.number().int().min(1).max(2_147_483_647);

export const VLAN_SOURCES = ['qbridge', 'cisco'] as const;
export const PORT_OPS = ['admin_status', 'alias', 'access_vlan'] as const;
export const PORT_CHANGE_ERROR_KINDS = [
  'expired', 'not_configured', 'out_of_scope', 'invalid_request', 'unsupported', 'port_not_found', 'vlan_not_found',
  'not_access_port', 'self_port', 'write_rejected', 'no_answer', 'readback_failed', 'readback_mismatch', 'internal',
] as const;

export const switchVlansSchema = z
  .object({
    type: z.literal('switch_vlans'),
    ts: timestamp,
    target_id: z.uuid(),
    sys_object_id: z.string().max(120).regex(/^\.?\d+(\.\d+)*$/).optional(),
    vlans: z.array(z.object({ id: vlanId, name: clean(64).optional(), source: z.enum(VLAN_SOURCES) }).strict()).max(4094),
    ports: z
      .array(
        z
          .object({
            if_index: ifIndex,
            access_vlan: vlanId.optional(),
            mode: z.enum(['access', 'trunk', 'unknown']),
            source: z.enum(VLAN_SOURCES),
          })
          .strict(),
      )
      .max(1024),
    methods: z.array(z.enum(VLAN_SOURCES)).max(2),
  })
  .strict();

const portState = z
  .object({ admin_up: z.boolean().optional(), alias: clean(120).optional(), vlan: z.number().int().min(0).max(4094).optional() })
  .strict();

export const switchPortResultSchema = z
  .object({
    type: z.literal('switch_port_result'),
    ts: timestamp,
    request_id: z.uuid(),
    target_id: z.uuid(),
    if_index: z.number().int().min(0).max(2_147_483_647),
    op: z.string().max(40),
    ok: z.boolean(),
    verified: z.boolean(),
    duration_ms: z.number().int().min(0).max(3_600_000).optional(),
    method: z.enum(['ifmib', 'qbridge', 'cisco']).optional(),
    before: portState.optional(),
    after: portState.optional(),
    rolled_back: z.boolean().optional(),
    steps: z.array(z.string().max(200)).max(12).optional(),
    error: z.object({ kind: z.enum(PORT_CHANGE_ERROR_KINDS), message: z.string().max(400) }).strict().optional(),
  })
  .strict();

export type SwitchVlansItem = z.infer<typeof switchVlansSchema>;
export type SwitchPortResultItem = z.infer<typeof switchPortResultSchema>;
