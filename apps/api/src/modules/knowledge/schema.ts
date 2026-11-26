import { z } from 'zod';
import { INCIDENT_KINDS } from '../incidents/kinds.ts';

const label = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\u0000-\u001f<>]+$/, 'Letters, digits and punctuation only (no angle brackets)');

const list = (max: number, len: number) =>
  z
    .array(label(len))
    .max(max)
    .transform((xs) => [...new Map(xs.map((x) => [x.toLowerCase(), x])).values()]);

/** Tags are stored lower-case so filters and matching do not depend on how someone typed them. */
const tags = z
  .array(label(40))
  .max(20)
  .transform((xs) => [...new Set(xs.map((x) => x.toLowerCase()))]);

const ruleIds = z
  .array(z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'A Network Doctor rule id, e.g. gateway-down'))
  .max(20)
  .transform((xs) => [...new Set(xs)]);

const eventTypes = z
  .array(z.string().trim().regex(/^[a-z0-9_]{1,64}$/, 'An event type, e.g. device_offline'))
  .max(30)
  .transform((xs) => [...new Set(xs)]);

export const entryFields = {
  kind: z.enum(['article', 'runbook']),
  title: z.string().trim().min(3, 'Give the article a title (at least 3 characters)').max(200),
  symptoms: z.string().max(8000),
  cause: z.string().max(8000),
  fix_steps: z.string().max(20000),
  tags,
  rule_ids: ruleIds,
  incident_kinds: z.array(z.enum(INCIDENT_KINDS)).max(INCIDENT_KINDS.length).transform((xs) => [...new Set(xs)]),
  event_types: eventTypes,
  device_types: list(20, 40),
  vendors: list(20, 80),
  site_id: z.uuid().nullable(),
  device_id: z.uuid().nullable(),
  check_id: z.uuid().nullable(),
};

export const createSchema = z
  .object({
    ...entryFields,
    kind: entryFields.kind.default('article'),
    symptoms: entryFields.symptoms.default(''),
    cause: entryFields.cause.default(''),
    fix_steps: entryFields.fix_steps.default(''),
    tags: entryFields.tags.default([]),
    rule_ids: entryFields.rule_ids.default([]),
    incident_kinds: entryFields.incident_kinds.default([]),
    event_types: entryFields.event_types.default([]),
    device_types: entryFields.device_types.default([]),
    vendors: entryFields.vendors.default([]),
    site_id: entryFields.site_id.default(null),
    device_id: entryFields.device_id.default(null),
    check_id: entryFields.check_id.default(null),
    /** Admins may publish in the same step; technicians always create a draft. */
    publish: z.boolean().default(false),
  })
  .strict();
export type KnowledgeCreate = z.infer<typeof createSchema>;

export const patchSchema = z
  .object({
    ...entryFields,
    /** The revision the editor started from; a newer revision on the server means someone else saved first. */
    expected_revision: z.number().int().min(1),
    /** A person checked the Network Doctor's inferred cause: it is no longer labelled as inferred. */
    confirm_cause: z.literal(true),
  })
  .partial()
  .required({ expected_revision: true })
  .strict();
export type KnowledgePatch = z.infer<typeof patchSchema>;

export const listQuery = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(['candidate', 'draft', 'published', 'discarded', 'all']).default('all'),
  kind: z.enum(['article', 'runbook']).optional(),
  tag: z.string().trim().max(40).optional(),
  rule: z.string().trim().max(64).optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
});

export const suggestQuery = z
  .object({
    incident_id: z.uuid().optional(),
    device_id: z.uuid().optional(),
    rule: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).optional(),
    site_id: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(20).default(5),
  })
  .refine((q) => q.incident_id || q.device_id || q.rule, { message: 'Give incident_id, device_id or rule' });

export const voteSchema = z.object({ helpful: z.boolean() }).strict();
export const useSchema = z.object({ incident_id: z.uuid() }).strict();
export const useParams = z.object({ id: z.uuid(), incidentId: z.uuid() });
