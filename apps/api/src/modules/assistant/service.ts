import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import type { DoctorReport, IncidentDetail, Site } from '@lan-detective/shared-types';
import { audit } from '../../common/audit.ts';
import { decryptSecret, encryptSecret } from '../../common/crypto.ts';
import { AppError, type AuthContext, notFound } from '../../common/http.ts';
import { type Db, withTenant } from '../../infrastructure/db.ts';
import { incidentsModule } from '../incidents/index.ts';
import { sitesModule } from '../sites/index.ts';
import {
  type ContentBlock,
  type MessageParam,
  type ToolResultBlock,
  type Usage,
  AssistantUpstreamError,
  createMessage,
  echoContent,
  isText,
  isToolUse,
} from './client.ts';
import { ASK_SYSTEM, EXPLAIN_SYSTEM, LINKABLE_PAGES, askContext, explainContext } from './prompts.ts';
import { readApi } from './read-api.ts';
import { toToolContent, sanitize } from './sanitize.ts';
import {
  type AskInput,
  type ExplainInput,
  MAX_API_CALLS_PER_TURN,
  MAX_OUTPUT_TOKENS,
  MAX_TESTS_PER_HOUR,
  MAX_TOOL_CALLS_PER_TURN,
  TURN_TIMEOUT_MS,
} from './schema.ts';
import { type SettingsRow, isAvailable, loadSettings, openApiKey, recordTest } from './settings.ts';
import { type Entity, type Lookup, type ToolContext, TOOL_DEFINITIONS, diagnosisForModel, runTool } from './tools.ts';

type Kind = 'ask' | 'explain_incident' | 'explain_doctor';

export interface Citation {
  marker: string;
  kind: string;
  id: string;
  label: string;
  href: string;
}

export interface AssistantAnswer {
  conversation_id: string;
  kind: Kind;
  /** May contain [[device:id]] / [[incident:id]] / [[endpoint:id]] / [[page:/path]] markers; every marker left in is valid. */
  text: string;
  /** Records the answer cites, in order of first mention. */
  citations: Citation[];
  /** Every record the lookups read (the "facts used"). */
  sources: Citation[];
  /** What was looked up, in order. */
  lookups: Lookup[];
  model: string;
  usage: { input_tokens: number; output_tokens: number; api_calls: number; tool_calls: number };
  stop_reason: string | null;
  refused: boolean;
  truncated: boolean;
  transcript_stored: boolean;
  ai_generated: true;
  generated_at: string;
}

// ── status shown to every member ──

export async function assistantStatus(ctx: AuthContext) {
  return withTenant(ctx.organizationId, async (db) => {
    const s = await loadSettings(db);
    const usage = (
      await db.query<{ org_requests: number; user_requests: number; input_tokens: number; output_tokens: number; my_input: number; my_output: number }>(
        `SELECT count(*) FILTER (WHERE kind <> 'test' AND created_at > now() - interval '24 hours')::int AS org_requests,
                count(*) FILTER (WHERE kind <> 'test' AND user_id = $1 AND created_at > now() - interval '1 hour')::int AS user_requests,
                coalesce(sum(input_tokens) FILTER (WHERE created_at > now() - interval '24 hours'), 0)::int AS input_tokens,
                coalesce(sum(output_tokens) FILTER (WHERE created_at > now() - interval '24 hours'), 0)::int AS output_tokens,
                coalesce(sum(input_tokens) FILTER (WHERE user_id = $1 AND created_at > now() - interval '24 hours'), 0)::int AS my_input,
                coalesce(sum(output_tokens) FILTER (WHERE user_id = $1 AND created_at > now() - interval '24 hours'), 0)::int AS my_output
           FROM assistant_usage WHERE created_at > now() - interval '24 hours'`,
        [ctx.userId],
      )
    ).rows[0]!;
    return {
      available: isAvailable(s),
      model: s.model,
      keep_transcripts: s.keep_transcripts,
      configured: s.api_key_sealed !== null,
      budget: { used: usage.org_requests, limit: s.daily_request_budget, window_hours: 24 },
      rate: { used: usage.user_requests, limit: s.user_requests_per_hour, window_minutes: 60 },
      tokens_24h: { input: usage.input_tokens, output: usage.output_tokens },
      my_tokens_24h: { input: usage.my_input, output: usage.my_output },
    };
  });
}

// ── budget, rate limit and usage records ──

async function lockOrg(db: Db, organizationId: string) {
  // Serialises the budget check of concurrent requests of one organization (transaction-scoped).
  await db.query(`SELECT pg_advisory_xact_lock(hashtext('assistant:' || $1::text))`, [organizationId]);
}

async function reserve(ctx: AuthContext, s: SettingsRow, kind: Kind, conversationId: string): Promise<string> {
  return withTenant(ctx.organizationId, async (db) => {
    await lockOrg(db, ctx.organizationId);
    const counts = (
      await db.query<{ org: number; mine: number }>(
        `SELECT count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS org,
                count(*) FILTER (WHERE user_id = $1 AND created_at > now() - interval '1 hour')::int AS mine
           FROM assistant_usage WHERE kind <> 'test' AND created_at > now() - interval '24 hours'`,
        [ctx.userId],
      )
    ).rows[0]!;
    if (counts.org >= s.daily_request_budget) {
      throw new AppError(429, 'assistant_budget_exhausted', `The organization's assistant budget of ${s.daily_request_budget} requests per 24 hours is used up`, {
        limit: s.daily_request_budget,
      });
    }
    if (counts.mine >= s.user_requests_per_hour) {
      throw new AppError(429, 'assistant_rate_limited', `You can ask the assistant ${s.user_requests_per_hour} times per hour; try again later`, { limit: s.user_requests_per_hour });
    }
    const row = await db.query<{ id: string }>(
      `INSERT INTO assistant_usage (organization_id, user_id, conversation_id, kind, model) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [ctx.organizationId, ctx.userId, conversationId, kind, s.model],
    );
    return row.rows[0]!.id;
  });
}

interface TurnOutcome {
  status: 'ok' | 'refused' | 'error';
  usage: Usage;
  apiCalls: number;
  toolNames: string[];
  errorCode?: string;
  stopReason?: string | null;
  transcriptStored?: boolean;
}

async function finish(req: Request, ctx: AuthContext, usageId: string, kind: Kind, model: string, conversationId: string, o: TurnOutcome, transcript?: (db: Db) => Promise<void>) {
  await withTenant(ctx.organizationId, async (db) => {
    await db.query(
      `UPDATE assistant_usage SET status = $2, input_tokens = $3, output_tokens = $4, api_calls = $5, tool_calls = $6, error_code = $7, completed_at = now() WHERE id = $1`,
      [usageId, o.status, o.usage.input_tokens, o.usage.output_tokens, o.apiCalls, o.toolNames.length, o.errorCode ?? null],
    );
    if (transcript) await transcript(db);
    // One audit entry per turn: who, which model, which lookups, how many tokens. Never the question or the answer.
    await audit(db, req, 'assistant.turn', { type: 'assistant_conversation', id: conversationId }, {
      kind,
      model,
      status: o.status,
      tools: [...new Set(o.toolNames)],
      tool_calls: o.toolNames.length,
      api_calls: o.apiCalls,
      input_tokens: o.usage.input_tokens,
      output_tokens: o.usage.output_tokens,
      stop_reason: o.stopReason ?? null,
      ...(o.errorCode ? { error_code: o.errorCode } : {}),
      transcript_stored: Boolean(o.transcriptStored),
    });
  });
}

// ── answer post-processing ──

const MARKER = /\[\[(device|incident|endpoint|site|page):([^\]\s]{1,100})\]\]/g;
const hrefOf = (kind: string, id: string) => (kind === 'device' ? `/devices/${id}` : kind === 'incident' ? `/incidents/${id}` : kind === 'endpoint' ? `/endpoints/${id}` : `/doctor`);

function toCitation(e: Entity): Citation {
  return { marker: `[[${e.kind}:${e.id}]]`, kind: e.kind, id: e.id, label: e.label, href: hrefOf(e.kind, e.id) };
}

/** Keep only markers for records that were actually looked up (and pages on the allow-list). */
export function processAnswer(text: string, entities: Map<string, Entity>): { text: string; citations: Citation[] } {
  const cited: Citation[] = [];
  const seen = new Set<string>();
  const out = text
    .replace(MARKER, (m, kind: string, id: string) => {
      if (kind === 'page') return (LINKABLE_PAGES as readonly string[]).includes(id) ? m : '';
      const e = entities.get(`${kind}:${id}`);
      if (!e) return '';
      if (!seen.has(m)) {
        seen.add(m);
        cited.push(toCitation(e));
      }
      return m;
    })
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  return { text: out, citations: cited };
}

const addUsage = (a: Usage, b: Usage): Usage => ({ input_tokens: a.input_tokens + b.input_tokens, output_tokens: a.output_tokens + b.output_tokens });
const ZERO: Usage = { input_tokens: 0, output_tokens: 0 };

// ── transcripts (only while the organization keeps them; sealed; owner-only) ──

interface StoredMessage {
  role: 'user' | 'assistant';
  text: string;
  citations?: Citation[];
  lookups?: Lookup[];
  created_at?: string;
}

function unseal<T>(sealed: string): T | null {
  try {
    return JSON.parse(decryptSecret(sealed)) as T;
  } catch {
    return null;
  }
}

async function ownedConversation(db: Db, ctx: AuthContext, id: string): Promise<'mine' | 'absent'> {
  const row = (await db.query<{ user_id: string }>(`SELECT user_id FROM assistant_conversations WHERE id = $1`, [id])).rows[0];
  if (!row) return 'absent';
  if (row.user_id !== ctx.userId) throw notFound('Conversation');
  return 'mine';
}

async function storedHistory(db: Db, id: string): Promise<{ role: 'user' | 'assistant'; text: string }[]> {
  const rows = await db.query<{ role: 'user' | 'assistant'; content_sealed: string }>(
    `SELECT role, content_sealed FROM (SELECT role, content_sealed, created_at, id FROM assistant_messages WHERE conversation_id = $1 ORDER BY created_at DESC, id DESC LIMIT 20) m ORDER BY created_at, id`,
    [id],
  );
  return rows.rows.flatMap((r) => {
    const m = unseal<StoredMessage>(r.content_sealed);
    return m ? [{ role: r.role, text: m.text }] : [];
  });
}

export async function listConversations(ctx: AuthContext) {
  return withTenant(ctx.organizationId, async (db) => {
    const s = await loadSettings(db);
    const rows = await db.query<{ id: string; title_sealed: string; created_at: Date; updated_at: Date; messages: number }>(
      `SELECT c.id, c.title_sealed, c.created_at, c.updated_at, (SELECT count(*) FROM assistant_messages m WHERE m.conversation_id = c.id)::int AS messages
         FROM assistant_conversations c WHERE c.user_id = $1 ORDER BY c.updated_at DESC LIMIT 50`,
      [ctx.userId],
    );
    return {
      keep_transcripts: s.keep_transcripts,
      items: rows.rows.map((r) => ({ id: r.id, title: unseal<string>(r.title_sealed) ?? '', created_at: r.created_at, updated_at: r.updated_at, messages: r.messages })),
    };
  });
}

export async function getConversation(ctx: AuthContext, id: string) {
  return withTenant(ctx.organizationId, async (db) => {
    // Only the person who asked can read a conversation, whatever their role.
    const c = (await db.query<{ id: string; title_sealed: string; created_at: Date }>(`SELECT id, title_sealed, created_at FROM assistant_conversations WHERE id = $1 AND user_id = $2`, [id, ctx.userId])).rows[0];
    if (!c) throw notFound('Conversation');
    const rows = await db.query<{ id: string; role: 'user' | 'assistant'; content_sealed: string; created_at: Date }>(
      `SELECT id, role, content_sealed, created_at FROM assistant_messages WHERE conversation_id = $1 ORDER BY created_at, id`,
      [id],
    );
    return {
      id: c.id,
      title: unseal<string>(c.title_sealed) ?? '',
      created_at: c.created_at,
      messages: rows.rows.map((r) => {
        const m = unseal<StoredMessage>(r.content_sealed);
        return { id: r.id, role: r.role, text: m?.text ?? '', citations: m?.citations ?? [], lookups: m?.lookups ?? [], created_at: r.created_at };
      }),
    };
  });
}

export async function deleteConversation(req: Request, ctx: AuthContext, id: string) {
  await withTenant(ctx.organizationId, async (db) => {
    const deleted = await db.query(`DELETE FROM assistant_conversations WHERE id = $1 AND user_id = $2`, [id, ctx.userId]);
    if (!deleted.rowCount) throw notFound('Conversation');
    await audit(db, req, 'assistant.conversation_deleted', { type: 'assistant_conversation', id });
  });
}

// ── history from the client (transcripts off): text only, alternating, bounded ──

function normalizeHistory(history: { role: 'user' | 'assistant'; text: string }[]): MessageParam[] {
  const out: MessageParam[] = [];
  for (const h of history) {
    const text = h.text.trim();
    if (!text) continue;
    const last = out.at(-1);
    if (last && last.role === h.role) last.content = `${last.content as string}\n\n${text}`;
    else out.push({ role: h.role, content: text });
  }
  while (out.length && out[0]!.role !== 'user') out.shift();
  // The new question follows: the history must end with an answer.
  while (out.length && out.at(-1)!.role !== 'assistant') out.pop();
  return out;
}

// ── the chat turn ──

export async function ask(req: Request, ctx: AuthContext, input: AskInput): Promise<AssistantAnswer> {
  const prep = await withTenant(ctx.organizationId, async (db) => {
    const s = await loadSettings(db);
    if (!isAvailable(s)) throw new AppError(409, 'assistant_disabled', 'The AI assistant is turned off for this organization');
    const conversationId = input.conversation_id ?? randomUUID();
    let history: { role: 'user' | 'assistant'; text: string }[] = input.history;
    let existing = false;
    if (s.keep_transcripts && input.conversation_id) {
      existing = (await ownedConversation(db, ctx, input.conversation_id)) === 'mine';
      if (existing) history = await storedHistory(db, input.conversation_id);
    }
    return { s, conversationId, history, existing };
  });
  const { s, conversationId, existing } = prep;
  const apiKey = openApiKey(s);

  let siteName: string | null = null;
  if (input.site_id) {
    const sites = await readApi<{ items: Site[] }>(sitesModule.api!, ctx, '/sites').catch(() => ({ items: [] as Site[] }));
    siteName = sites.items.find((x) => x.id === input.site_id)?.name ?? null;
  }

  const usageId = await reserve(ctx, s, 'ask', conversationId);
  const tctx: ToolContext = { auth: ctx, entities: new Map() };
  const lookups: Lookup[] = [];
  const toolNames: string[] = [];
  let usage = ZERO;
  let apiCalls = 0;

  const messages: MessageParam[] = [...normalizeHistory(prep.history), { role: 'user', content: input.question }];
  const system = [
    { type: 'text' as const, text: ASK_SYSTEM, cache_control: { type: 'ephemeral' as const } },
    {
      type: 'text' as const,
      text:
        askContext({ locale: input.locale, role: ctx.role, siteName, page: input.page ?? null, now: new Date() }) +
        (input.site_id ? `\nThe site id of that site is ${input.site_id}; pass it as site_id when the question is about the current site.` : ''),
    },
  ];
  const deadline = AbortSignal.timeout(TURN_TIMEOUT_MS);

  try {
    let final: { content: ContentBlock[]; stop_reason: string | null; model: string } | null = null;
    while (apiCalls < MAX_API_CALLS_PER_TURN) {
      const lastCall = apiCalls === MAX_API_CALLS_PER_TURN - 1 || toolNames.length >= MAX_TOOL_CALLS_PER_TURN;
      const res = await createMessage(
        apiKey,
        { model: s.model, max_tokens: MAX_OUTPUT_TOKENS, system, messages, tools: TOOL_DEFINITIONS, tool_choice: { type: lastCall ? 'none' : 'auto' } },
        deadline,
      );
      apiCalls++;
      usage = addUsage(usage, res.usage);
      const content = echoContent(res.content);
      const toolUses = content.filter(isToolUse);
      if (res.stop_reason === 'tool_use' && toolUses.length && !lastCall) {
        messages.push({ role: 'assistant', content });
        const results: ToolResultBlock[] = [];
        for (const use of toolUses) {
          if (toolNames.length >= MAX_TOOL_CALLS_PER_TURN) {
            results.push({ type: 'tool_result', tool_use_id: use.id, content: 'Lookup limit for this question reached. Answer with what you have.', is_error: true });
            continue;
          }
          toolNames.push(use.name);
          const r = await runTool(tctx, use.name, use.input);
          lookups.push(r.lookup);
          results.push({ type: 'tool_result', tool_use_id: use.id, content: toToolContent(use.name, r.data), ...(r.ok ? {} : { is_error: true }) });
        }
        // All results of one assistant message go back together, in one user message.
        messages.push({ role: 'user', content: results });
        continue;
      }
      final = { content, stop_reason: res.stop_reason, model: res.model };
      break;
    }
    if (!final) throw new AssistantUpstreamError(502, 'assistant_no_answer', 'The assistant did not produce an answer');

    const refused = final.stop_reason === 'refusal';
    const rawText = refused ? '' : final.content.filter(isText).map((b) => b.text).join('\n\n');
    const { text, citations } = processAnswer(rawText, tctx.entities);
    const sources = [...tctx.entities.values()].slice(0, 25).map(toCitation);
    const transcriptStored = s.keep_transcripts && !refused && text.length > 0;
    const answer: AssistantAnswer = {
      conversation_id: conversationId,
      kind: 'ask',
      text,
      citations,
      sources,
      lookups,
      model: final.model || s.model,
      usage: { ...usage, api_calls: apiCalls, tool_calls: toolNames.length },
      stop_reason: final.stop_reason,
      refused,
      truncated: final.stop_reason === 'max_tokens',
      transcript_stored: transcriptStored,
      ai_generated: true,
      generated_at: new Date().toISOString(),
    };
    await finish(
      req,
      ctx,
      usageId,
      'ask',
      answer.model,
      conversationId,
      { status: refused ? 'refused' : 'ok', usage, apiCalls, toolNames, stopReason: final.stop_reason, transcriptStored },
      transcriptStored
        ? async (db) => {
            if (!existing) {
              await db.query(`INSERT INTO assistant_conversations (id, organization_id, user_id, title_sealed) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`, [
                conversationId,
                ctx.organizationId,
                ctx.userId,
                encryptSecret(JSON.stringify(input.question.slice(0, 120))),
              ]);
            }
            await db.query(`UPDATE assistant_conversations SET updated_at = now() WHERE id = $1 AND user_id = $2`, [conversationId, ctx.userId]);
            const seal = (m: StoredMessage) => encryptSecret(JSON.stringify(m));
            await db.query(`INSERT INTO assistant_messages (organization_id, conversation_id, role, content_sealed, created_at) VALUES ($1,$2,'user',$3, now() - interval '1 millisecond'), ($1,$2,'assistant',$4, now())`, [
              ctx.organizationId,
              conversationId,
              seal({ role: 'user', text: input.question }),
              seal({ role: 'assistant', text, citations, lookups }),
            ]);
          }
        : undefined,
    );
    return answer;
  } catch (err) {
    const code = err instanceof AppError ? err.code : 'internal_error';
    await finish(req, ctx, usageId, 'ask', s.model, conversationId, { status: 'error', usage, apiCalls, toolNames, errorCode: code }).catch(() => undefined);
    throw err;
  }
}

// ── "Explain this": rephrase and rank the deterministic diagnosis ──

export async function explain(req: Request, ctx: AuthContext, input: ExplainInput): Promise<AssistantAnswer> {
  const s = await withTenant(ctx.organizationId, (db) => loadSettings(db));
  if (!isAvailable(s)) throw new AppError(409, 'assistant_disabled', 'The AI assistant is turned off for this organization');
  const apiKey = openApiKey(s);
  const kind: Kind = input.subject === 'incident' ? 'explain_incident' : 'explain_doctor';

  // Read the diagnosis exactly as the UI shows it, as this user (tenant + role).
  const router = incidentsModule.api!;
  let subject: Record<string, unknown>;
  let sources: Citation[];
  if (input.subject === 'incident') {
    const inc = await readApi<IncidentDetail>(router, ctx, `/incidents/${input.incident_id}`);
    if (!inc.diagnosis) throw new AppError(409, 'assistant_no_diagnosis', 'This incident has no Network Doctor diagnosis to explain');
    subject = {
      incident: { number: inc.number, title: inc.title, kind: inc.kind, status: inc.status, severity: inc.severity, site_name: inc.site_name, opened_at: inc.opened_at, resolved_at: inc.resolved_at },
      diagnosis: diagnosisForModel(inc.diagnosis),
    };
    sources = [{ marker: `[[incident:${inc.id}]]`, kind: 'incident', id: inc.id, label: `INC-${inc.number} ${inc.title}`.slice(0, 80), href: `/incidents/${inc.id}` }];
  } else {
    const res = await readApi<{ items: DoctorReport[] }>(router, ctx, '/doctor', { site_id: input.site_id });
    const report = res.items.find((r) => r.site_id === input.site_id);
    if (!report) throw notFound('Site');
    subject = { site_name: report.site_name, collectors_online: report.collectors_online, diagnosis: diagnosisForModel(report.diagnosis) };
    sources = [{ marker: `[[page:/doctor]]`, kind: 'page', id: '/doctor', label: report.site_name.slice(0, 80), href: '/doctor' }];
  }

  const conversationId = randomUUID();
  const usageId = await reserve(ctx, s, kind, conversationId);
  let usage = ZERO;
  let apiCalls = 0;
  try {
    const res = await createMessage(
      apiKey,
      {
        model: s.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: [
          { type: 'text', text: EXPLAIN_SYSTEM, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: explainContext(input.locale, new Date()) },
        ],
        messages: [
          {
            role: 'user',
            content: `Explain this diagnosis.\n<diagnosis_data>\n${JSON.stringify(sanitize(subject))}\n</diagnosis_data>`,
          },
        ],
      },
      AbortSignal.timeout(TURN_TIMEOUT_MS),
    );
    apiCalls = 1;
    usage = res.usage;
    const refused = res.stop_reason === 'refusal';
    // No lookups ran, so no record markers are valid; page markers are dropped too (the explanation is self-contained).
    const text = refused ? '' : processAnswer(res.content.filter(isText).map((b) => b.text).join('\n\n'), new Map()).text.replace(/\[\[page:[^\]]+\]\]/g, '').trim();
    const answer: AssistantAnswer = {
      conversation_id: conversationId,
      kind,
      text,
      citations: [],
      sources,
      lookups: [{ tool: input.subject === 'incident' ? 'get_incident' : 'get_network_diagnosis', input: input.subject === 'incident' ? { incident_id: input.incident_id } : { site_id: input.site_id }, ok: true, count: null }],
      model: res.model || s.model,
      usage: { ...usage, api_calls: 1, tool_calls: 0 },
      stop_reason: res.stop_reason,
      refused,
      truncated: res.stop_reason === 'max_tokens',
      transcript_stored: false,
      ai_generated: true,
      generated_at: new Date().toISOString(),
    };
    await finish(req, ctx, usageId, kind, answer.model, conversationId, { status: refused ? 'refused' : 'ok', usage, apiCalls, toolNames: [], stopReason: res.stop_reason });
    return answer;
  } catch (err) {
    const code = err instanceof AppError ? err.code : 'internal_error';
    await finish(req, ctx, usageId, kind, s.model, conversationId, { status: 'error', usage, apiCalls, toolNames: [], errorCode: code }).catch(() => undefined);
    throw err;
  }
}

// ── test connection ──

export async function testKey(req: Request, ctx: AuthContext, candidate: { api_key?: string; model?: string }) {
  const s = await withTenant(ctx.organizationId, async (db) => {
    const settings = await loadSettings(db);
    await lockOrg(db, ctx.organizationId);
    const recent = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM assistant_usage WHERE kind = 'test' AND created_at > now() - interval '1 hour'`)).rows[0]!.n;
    if (recent >= MAX_TESTS_PER_HOUR) throw new AppError(429, 'assistant_rate_limited', `At most ${MAX_TESTS_PER_HOUR} key tests per hour`);
    return settings;
  });
  const apiKey = candidate.api_key ?? (s.api_key_sealed ? openApiKey(s) : null);
  if (!apiKey) throw new AppError(409, 'assistant_key_required', 'Enter an API key to test');
  const model = candidate.model ?? s.model;
  const usageId = await withTenant(ctx.organizationId, async (db) =>
    (
      await db.query<{ id: string }>(`INSERT INTO assistant_usage (organization_id, user_id, kind, model) VALUES ($1,$2,'test',$3) RETURNING id`, [ctx.organizationId, ctx.userId, model])
    ).rows[0]!.id,
  );
  const started = performance.now();
  let ok = false;
  let error: string | null = null;
  let errorCode: string | null = null;
  let usage = ZERO;
  try {
    const res = await createMessage(apiKey, { model, max_tokens: 256, system: [{ type: 'text', text: 'Connection test.' }], messages: [{ role: 'user', content: 'Reply with the single word OK.' }] });
    usage = res.usage;
    ok = true;
  } catch (err) {
    errorCode = err instanceof AppError ? err.code : 'internal_error';
    error = err instanceof AppError ? err.message : 'The test failed';
  }
  const latencyMs = Math.round(performance.now() - started);
  await withTenant(ctx.organizationId, async (db) => {
    await db.query(`UPDATE assistant_usage SET status = $2, input_tokens = $3, output_tokens = $4, api_calls = 1, error_code = $5, completed_at = now() WHERE id = $1`, [
      usageId,
      ok ? 'ok' : 'error',
      usage.input_tokens,
      usage.output_tokens,
      errorCode,
    ]);
    if (!candidate.api_key) await recordTest(db, ok, error);
    await audit(db, req, 'assistant.key_tested', { type: 'assistant_settings', id: ctx.organizationId }, { ok, model, candidate_key: Boolean(candidate.api_key), ...(errorCode ? { error_code: errorCode } : {}) });
  });
  return { ok, model, latency_ms: latencyMs, error, error_code: errorCode, usage };
}
