import { z } from 'zod';
import { fsOpCommandSchema } from '../file-manager/schema.ts';
import { rdCaptureCommandSchema, rdInputCommandSchema } from '../remote-desktop/schema.ts';

/** POST /endpoints/:id/commands — every remote action an operator can queue for an endpoint agent. */
export const commandInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('refresh_inventory') }).strict(),
  z.object({
    kind: z.literal('kill_process'),
    pid: z.number().int().min(1).max(2_147_483_647),
    name: z.string().trim().min(1).max(160).optional(),
  }).strict(),
  z.object({
    kind: z.literal('service_action'),
    service: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.@-]*$/, 'Service name must start with a letter or digit and contain only letters, digits, _ . @ -'),
    action: z.enum(['start', 'stop', 'restart']),
  }).strict(),
  z.object({
    kind: z.literal('power_action'),
    action: z.enum(['restart', 'shutdown', 'lock', 'logoff']),
    reason: z.string().trim().max(240).optional(),
  }).strict(),
  z.object({
    kind: z.literal('notify_user'),
    title: z.string().trim().min(1).max(120),
    message: z.string().trim().min(1).max(600),
  }).strict(),
  fsOpCommandSchema,
  rdCaptureCommandSchema,
  rdInputCommandSchema,
  z.object({
    kind: z.literal('software_action'),
    action: z.enum(['install', 'upgrade', 'uninstall']),
    package_id: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:+-]*$/, 'Package identifier must start with a letter or digit'),
  }).strict(),
  z.object({
    kind: z.literal('fetch_logs'),
    source: z.enum(['system', 'application', 'security']).default('system'),
    lines: z.number().int().min(10).max(200).default(60),
  }).strict(),
  z.object({
    kind: z.literal('diagnostic_command'),
    tool: z.enum(['ipconfig', 'route', 'arp', 'nslookup', 'whoami', 'systeminfo', 'netstat', 'gpresult', 'df', 'uptime']),
    target: z.string().trim().max(180).regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/, 'Target must be a host name or IP address').optional(),
  }).strict(),
]);

export type CommandInput = z.infer<typeof commandInputSchema>;

/** `?wait_ms=` lets an interactive caller wait (at most 6 s) for the agent's result instead of polling. */
export function parseWaitMs(raw: unknown): number {
  return Math.min(6000, Math.max(0, Number.parseInt(String(raw ?? '0'), 10) || 0));
}
