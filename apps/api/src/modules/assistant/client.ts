import { AppError } from '../../common/http.ts';
import { CALL_TIMEOUT_MS } from './schema.ts';

/**
 * Minimal client for the Anthropic Messages API (POST /v1/messages) over the built-in fetch.
 * No SDK dependency: the product ships without extra npm packages.
 *
 * The API key is sent in the `x-api-key` header only. It is never logged, never put in an error
 * message and never returned to the browser. The base URL comes from the server environment
 * (ANTHROPIC_BASE_URL, used by the tests to point at a local fake server), never from a request.
 */

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';
/** Server-side refusal fallback ("default" routing by refusal category); Opus 5.5 and Sonnet 5.5 on the Claude API. */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const MODELS_WITH_FALLBACK = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

export function anthropicBaseUrl(): string {
  const raw = process.env.ANTHROPIC_BASE_URL?.trim();
  if (!raw) return DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError(500, 'assistant_misconfigured', 'ANTHROPIC_BASE_URL is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new AppError(500, 'assistant_misconfigured', 'ANTHROPIC_BASE_URL must be http(s)');
  return url.toString().replace(/\/+$/, '');
}

// ── wire types (only the parts this module reads or writes) ──

export interface TextBlock {
  type: 'text';
  text: string;
}
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
/** Thinking, fallback markers and any other block: echoed back unchanged within a turn. */
export interface OtherBlock {
  type: string;
  [key: string]: unknown;
}
export type ContentBlock = TextBlock | ToolUseBlock | OtherBlock;

export interface MessageParam {
  role: 'user' | 'assistant';
  content: string | (ContentBlock | ToolResultBlock)[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface SystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export interface MessagesRequest {
  model: string;
  max_tokens: number;
  system: SystemBlock[];
  messages: MessageParam[];
  tools?: ToolDefinition[];
  tool_choice?: { type: 'auto' | 'none' };
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export interface MessageResponse {
  id: string;
  model: string;
  content: ContentBlock[];
  stop_reason: string | null;
  usage: Usage;
}

export const isText = (b: ContentBlock): b is TextBlock => b.type === 'text' && typeof (b as TextBlock).text === 'string';
export const isToolUse = (b: ContentBlock): b is ToolUseBlock => b.type === 'tool_use';

/** Upstream failures, mapped to a code the UI can translate. Messages never contain the key. */
export class AssistantUpstreamError extends AppError {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function upstreamError(res: Response): Promise<AssistantUpstreamError> {
  let detail = '';
  try {
    const body = (await res.json()) as { error?: { type?: string; message?: string } };
    if (body?.error?.message) detail = `: ${String(body.error.message).slice(0, 240)}`;
  } catch {
    /* not JSON */
  }
  if (res.status === 401 || res.status === 403) return new AssistantUpstreamError(502, 'assistant_key_rejected', `The Anthropic API rejected the API key (${res.status})${detail}`);
  if (res.status === 429) return new AssistantUpstreamError(503, 'assistant_upstream_rate_limited', `The Anthropic API is rate limiting this key (429)${detail}`);
  if (res.status === 400 || res.status === 404 || res.status === 413) return new AssistantUpstreamError(502, 'assistant_upstream_rejected', `The Anthropic API rejected the request (${res.status})${detail}`);
  return new AssistantUpstreamError(503, 'assistant_upstream_unavailable', `The Anthropic API is unavailable (${res.status})${detail}`);
}

/**
 * One Messages API call. Thinking is adaptive (Opus/Sonnet/Haiku 5.5 accept it) with an explicit
 * effort; Opus 5.5 and Sonnet 5.5 requests opt into server-side refusal fallbacks.
 * Retries once on overload / 5xx / connection errors.
 */
export async function createMessage(apiKey: string, body: MessagesRequest, signal?: AbortSignal): Promise<MessageResponse> {
  const fallback = MODELS_WITH_FALLBACK.has(body.model);
  const payload = {
    ...body,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    ...(fallback ? { fallbacks: 'default' } : {}),
  };
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': API_VERSION,
    'x-api-key': apiKey,
    ...(fallback ? { 'anthropic-beta': FALLBACK_BETA } : {}),
  };
  const url = `${anthropicBaseUrl()}/v1/messages`;
  for (let attempt = 0; ; attempt++) {
    const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' });
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new AssistantUpstreamError(504, 'assistant_timeout', 'The Anthropic API did not answer in time');
      if (attempt === 0) {
        await sleep(500);
        continue;
      }
      throw new AssistantUpstreamError(503, 'assistant_unreachable', 'Cannot reach the Anthropic API from this server');
    }
    if (res.ok) {
      const json = (await res.json()) as MessageResponse;
      if (!json || !Array.isArray(json.content)) throw new AssistantUpstreamError(502, 'assistant_upstream_rejected', 'The Anthropic API returned an unexpected response');
      json.usage = { input_tokens: Number(json.usage?.input_tokens ?? 0), output_tokens: Number(json.usage?.output_tokens ?? 0) };
      return json;
    }
    if (attempt === 0 && (res.status >= 500 || res.status === 529)) {
      await res.body?.cancel().catch(() => undefined);
      await sleep(800);
      continue;
    }
    throw await upstreamError(res);
  }
}

/**
 * The assistant content to send back on the next call of the same turn: unchanged, except that after
 * a mid-output refusal fallback the blocks the declined model produced before the last `fallback`
 * marker (thinking, tool calls) are left out, as the API requires.
 */
export function echoContent(content: ContentBlock[]): ContentBlock[] {
  const lastFallback = content.map((b) => b.type).lastIndexOf('fallback');
  if (lastFallback < 0) return content;
  const drop = new Set(['thinking', 'redacted_thinking', 'tool_use', 'server_tool_use']);
  return content.filter((b, i) => i > lastFallback || (i < lastFallback && !drop.has(b.type)));
}
