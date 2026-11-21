import { z } from 'zod';

/** Models an administrator can pick. The first one is the default. */
export const ASSISTANT_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const;
export type AssistantModel = (typeof ASSISTANT_MODELS)[number];
export const DEFAULT_MODEL: AssistantModel = 'claude-opus-5-5';

/**
 * Version of the "what leaves your network" disclosure the administrator confirms (its wording lives
 * in the web app, features/assistant/strings.ts). Changing what is sent requires a new version, which
 * switches the assistant off until an administrator confirms again.
 */
export const DISCLOSURE_VERSION = 'v1';

export const DEFAULT_DAILY_BUDGET = 200;
export const DEFAULT_USER_PER_HOUR = 30;
/** Key tests per organization and hour (they reach the provider but do not count against the budget). */
export const MAX_TESTS_PER_HOUR = 10;

/** One chat turn may call the Messages API at most this often (tool rounds + the final answer). */
export const MAX_API_CALLS_PER_TURN = 7;
/** And run at most this many lookups. */
export const MAX_TOOL_CALLS_PER_TURN = 16;
/** Per Messages API call, and for the whole turn. */
export const CALL_TIMEOUT_MS = 60_000;
export const TURN_TIMEOUT_MS = 150_000;
export const MAX_OUTPUT_TOKENS = 8000;

export const MAX_QUESTION_CHARS = 4000;
export const MAX_HISTORY_MESSAGES = 20;
export const MAX_HISTORY_CHARS = 8000;

const apiKey = z
  .string()
  .trim()
  .min(20, 'This does not look like an Anthropic API key')
  .max(300)
  .regex(/^[\x21-\x7e]+$/, 'The key contains characters an API key never has');

export const settingsPatchSchema = z
  .object({
    enabled: z.boolean(),
    // Write-only. null removes the stored key (and switches the assistant off).
    api_key: apiKey.nullable(),
    model: z.enum(ASSISTANT_MODELS),
    daily_request_budget: z.number().int().min(1).max(10_000),
    user_requests_per_hour: z.number().int().min(1).max(600),
    keep_transcripts: z.boolean(),
    // Must be exactly true: the administrator confirms the current disclosure version.
    disclosure_accepted: z.literal(true),
  })
  .partial()
  .strict();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export const testKeySchema = z
  .object({
    // Optional: test a key before saving it. Without it, the stored key is tested.
    api_key: apiKey.optional(),
    model: z.enum(ASSISTANT_MODELS).optional(),
  })
  .strict();

export const LOCALES = ['en', 'ar'] as const;
export type AssistantLocale = (typeof LOCALES)[number];

const historyItem = z
  .object({
    role: z.enum(['user', 'assistant']),
    text: z.string().max(MAX_HISTORY_CHARS),
  })
  .strict();

export const askSchema = z
  .object({
    question: z.string().trim().min(1).max(MAX_QUESTION_CHARS),
    locale: z.enum(LOCALES).default('en'),
    conversation_id: z.uuid().optional(),
    // Earlier turns of this conversation (text only), used when transcripts are not kept on the server.
    history: z.array(historyItem).max(MAX_HISTORY_MESSAGES).default([]),
    site_id: z.uuid().nullable().optional(),
    // The page the user is on, so "this device" can be understood. Only paths, never full URLs.
    page: z
      .string()
      .max(200)
      .regex(/^\/[\w\-/]*$/)
      .optional(),
  })
  .strict();
export type AskInput = z.infer<typeof askSchema>;

export const explainSchema = z.discriminatedUnion('subject', [
  z.object({ subject: z.literal('incident'), incident_id: z.uuid(), locale: z.enum(LOCALES).default('en') }).strict(),
  z.object({ subject: z.literal('doctor'), site_id: z.uuid(), locale: z.enum(LOCALES).default('en') }).strict(),
]);
export type ExplainInput = z.infer<typeof explainSchema>;
