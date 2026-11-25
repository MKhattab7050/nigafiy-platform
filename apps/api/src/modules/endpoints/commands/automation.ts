import type { EndpointPlatform } from '@nigafiy/shared-types';
import { AppError, notFound } from '../../../common/http.ts';
import type { Db } from '../../../infrastructure/db.ts';
import { emitEvent } from '../../events/index.ts';
import { notifyRealtime } from '../../realtime/index.ts';
import { ONLINE_WITHIN_MS, payloadForAudit } from '../repo.ts';
import { validateCommandForPlatform } from './guards.ts';
import { type CommandInput, commandInputSchema } from './schema.ts';

// Queue an agent command from another module (playbooks), inside the caller's tenant transaction.
// Same validation as POST /endpoints/:id/commands (commandInputSchema + validateCommandForPlatform,
// online check) but restricted to the kinds below: no file operations, no remote-desktop frames or
// input, no process kill by PID, no software changes. The caller audits; the endpoint_command event
// on the timeline names who requested it, like the route.

export const AUTOMATABLE_COMMAND_KINDS = ['refresh_inventory', 'notify_user', 'service_action', 'power_action', 'fetch_logs', 'diagnostic_command'] as const;
export type AutomatableCommandKind = (typeof AUTOMATABLE_COMMAND_KINDS)[number];

/** Parse an automatable command; throws a 400 with the endpoint module's own validation messages. */
export function parseAutomatableCommand(raw: unknown): CommandInput {
  const parsed = commandInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(400, 'validation_error', 'The endpoint command is invalid', parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  if (!(AUTOMATABLE_COMMAND_KINDS as readonly string[]).includes(parsed.data.kind)) {
    throw new AppError(400, 'command_not_allowed', `"${parsed.data.kind}" cannot be used in automation; allowed: ${AUTOMATABLE_COMMAND_KINDS.join(', ')}`);
  }
  return parsed.data;
}

export interface CommandRequester {
  /** The person who approved or started the action; null when Nigafiy acts on its own. */
  userId: string | null;
  /** Shown as the requester (e-mail of the person, or e.g. 'Playbook "Server offline"'). */
  label: string;
  /** Role used for the endpoint module's role rules (restart/shutdown need an administrator). */
  role: string;
}

export async function queueEndpointCommandFor(
  db: Db,
  organizationId: string,
  endpointId: string,
  command: CommandInput,
  requester: CommandRequester,
): Promise<{ command_id: string; endpoint_name: string; kind: string }> {
  if (!(AUTOMATABLE_COMMAND_KINDS as readonly string[]).includes(command.kind)) {
    throw new AppError(400, 'command_not_allowed', `"${command.kind}" cannot be used in automation`);
  }
  const ep = (
    await db.query<{ id: string; site_id: string; device_id: string | null; name: string; platform: EndpointPlatform; status: string; last_heartbeat_at: Date | null }>(
      // Quick Support computers are attended only: automation never reaches them (SEC-02).
      `SELECT id, site_id, device_id, name, platform, status, last_heartbeat_at FROM endpoints WHERE id = $1 AND kind = 'agent'`,
      [endpointId],
    )
  ).rows[0];
  if (!ep) throw notFound('Endpoint');
  validateCommandForPlatform(ep.platform, command, requester.role);
  if (ep.status !== 'active' || !ep.last_heartbeat_at || ep.last_heartbeat_at.getTime() < Date.now() - ONLINE_WITHIN_MS) {
    throw new AppError(409, 'endpoint_offline', 'This endpoint is not currently online');
  }
  const { kind, ...rawPayload } = command;
  const payload: Record<string, unknown> = { ...rawPayload };
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO endpoint_commands (organization_id, endpoint_id, kind, payload, created_by, created_by_name) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [organizationId, ep.id, kind, JSON.stringify(payload), requester.userId, requester.label],
  );
  const commandId = inserted.rows[0]!.id;
  if (kind !== 'refresh_inventory') {
    const recorded = payloadForAudit(kind, payload);
    await emitEvent(db, organizationId, {
      siteId: ep.site_id,
      deviceId: ep.device_id,
      type: 'endpoint_command',
      severity: command.kind === 'power_action' && (command.action === 'restart' || command.action === 'shutdown') ? 'warning' : 'info',
      title: `Remote action "${kind}" sent to "${ep.name}" by ${requester.label}`,
      details: { endpoint_id: ep.id, endpoint_name: ep.name, command_id: commandId, kind, ...recorded, requested_by: requester.label },
      source: 'platform',
      occurredAt: new Date(),
    });
  }
  await notifyRealtime(db, organizationId, 'devices');
  return { command_id: commandId, endpoint_name: ep.name, kind };
}

/** State of an endpoint command (pending / delivered / completed / failed / expired) with its result. */
export async function endpointCommandState(db: Db, commandId: string): Promise<{ status: string; output: string | null; error: string | null; completed_at: Date | null } | null> {
  return (
    (await db.query<{ status: string; output: string | null; error: string | null; completed_at: Date | null }>(`SELECT status, output, error, completed_at FROM endpoint_commands WHERE id = $1`, [commandId]))
      .rows[0] ?? null
  );
}
