import { z } from 'zod';

// Fleet Pro: reaching computers (migration 037). Validation of every body and query.

const tag = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(32)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u, 'A tag starts with a letter or digit and holds letters, digits, spaces, . _ -');
const ids = z.array(z.uuid()).min(1).max(500);
const reason = z.string({ error: 'Give the reason' }).trim().min(3, 'Give the reason (at least 3 characters)').max(200);

/** POST /fleet/address-book/tags (admin): add and/or remove tags on several computers. */
export const tagsBulkSchema = z
  .object({ endpoint_ids: ids, add: z.array(tag).max(10).default([]), remove: z.array(tag).max(10).default([]) })
  .strict()
  .refine((b) => b.add.length + b.remove.length > 0, { message: 'Add or remove at least one tag' });

/** POST /fleet/bulk: one action on a selection (each action keeps its own role check and audit). */
export const bulkActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('notify'), endpoint_ids: ids, title: z.string().trim().min(1).max(120), message: z.string().trim().min(1).max(600) }).strict(),
  z.object({ action: z.literal('power'), endpoint_ids: ids, power: z.enum(['restart', 'shutdown', 'lock', 'logoff']), reason }).strict(),
  z.object({ action: z.literal('wake'), endpoint_ids: ids, reason }).strict(),
  z.object({ action: z.literal('refresh_inventory'), endpoint_ids: ids }).strict(),
]);
export type BulkAction = z.infer<typeof bulkActionSchema>;

/** GET /fleet/connect/resolve?q= : a computer name, a 9-digit Nigafiy ID, or a Quick Support code. */
export const resolveQuery = z.object({ q: z.string().trim().min(1).max(120) }).strict();

/** POST /fleet/help-requests/:id/close */
export const helpCloseSchema = z.object({ note: z.string().trim().max(300).optional() }).strict();
export const helpListQuery = z.object({ state: z.enum(['open', 'in_session', 'closed', 'all']).default('open'), limit: z.coerce.number().int().min(1).max(200).default(100) }).strict();

/** POST /endpoints/:id/remote-desktop/restart: restart and reconnect (the session holder). */
export const restartSchema = z.object({ mode: z.enum(['normal', 'safe_mode']), reason, timeout_s: z.number().int().min(120).max(3600).default(600) }).strict();

/** POST /fleet/quick-support/connect: the code and the PIN the person reads out. */
export const quickConnectSchema = z
  .object({
    code: z.string().trim().transform((s) => s.replace(/[\s-]/g, '')).pipe(z.string().regex(/^[1-9][0-9]{8}$/, 'The code has 9 digits')),
    pin: z.string().trim().regex(/^[0-9]{6}$/, 'The PIN has 6 digits'),
    reason,
    profile_id: z.uuid().optional(),
    recording_enabled: z.boolean().default(false),
  })
  .strict();

/** GET /fleet/quick-support/download?site_id= */
export const quickDownloadQuery = z.object({ site_id: z.uuid() }).strict();
export const quickListQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).strict();

// ── Agent side ──────────────────────────────────────────────────────────────────────────────────
/** POST /api/v1/agent/help-request (agent credential) */
export const agentHelpRequestSchema = z.object({ note: z.string().trim().min(1).max(500), user: z.string().trim().max(120).optional() }).strict();

/** POST /api/v1/agent/quick-support/register (the signed link in nigafiy-support.exe) */
export const quickRegisterSchema = z
  .object({
    link: z.string().min(20).max(400),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
    hostname: z.string().trim().min(1).max(253),
    os: z.string().trim().min(1).max(40),
    os_version: z.string().trim().max(120).optional(),
    arch: z.string().trim().max(40).default('amd64'),
    agent_version: z.string().trim().max(40).optional(),
  })
  .strict();
