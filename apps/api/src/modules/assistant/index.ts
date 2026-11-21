import { defineModule } from '../../infrastructure/module.ts';
import { assistantRouter } from './routes.ts';

/**
 * Optional AI assistant (Phase 6) on top of the deterministic engine. OFF by default.
 *
 *   schema.ts    limits, models, request validation
 *   settings.ts  per-organization settings; the Anthropic API key sealed at rest and write-only
 *   client.ts    Messages API over built-in fetch (base URL from ANTHROPIC_BASE_URL for tests)
 *   read-api.ts  in-process, GET-only access to other modules' handlers as the signed-in user
 *   tools.ts     the read-only lookups the model may call, with citations
 *   sanitize.ts  secret removal, <device_supplied> wrapping of untrusted text, size limits
 *   prompts.ts   system prompts (chat, "explain this")
 *   service.ts   the tool-use loop, explain, budget / rate limit, audit per turn, sealed transcripts
 *
 * The assistant never acts: it reads, explains and links to the page where a person acts.
 * The Network Doctor's rule engine stays the source of truth; "explain" only rephrases and ranks it.
 */
export const assistantModule = defineModule({ name: 'assistant', api: assistantRouter });
