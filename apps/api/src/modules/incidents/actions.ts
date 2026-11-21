import { AppError, notFound } from '../../common/http.ts';
import type { Db } from '../../infrastructure/db.ts';
import { addActivity } from '../correlation/index.ts';
import { notifyRealtime } from '../realtime/index.ts';

// Incident actions callable by other modules (playbooks) inside the caller's tenant transaction.
// Same effect as POST /incidents/:id/comments and POST /incidents/:id/acknowledge; the caller audits.
// `who` is the person acting, or a label such as 'Playbook "Service check failed"' for system actions.

export interface IncidentActor {
  id: string | null;
  name: string;
}

const asUser = (who: IncidentActor) => (who.id ? { id: who.id, name: who.name } : undefined);

export async function commentOnIncident(db: Db, organizationId: string, incidentId: string, body: string, who: IncidentActor): Promise<void> {
  if (!(await db.query(`SELECT 1 FROM incidents WHERE id = $1`, [incidentId])).rowCount) throw notFound('Incident');
  // A system comment carries its author in the text (incident_activity.user_id stays NULL).
  const text = who.id ? body : `${who.name}: ${body}`;
  await addActivity(db, organizationId, incidentId, 'comment', text, new Date(), asUser(who));
  await notifyRealtime(db, organizationId, 'events');
}

export async function acknowledgeIncident(db: Db, organizationId: string, incidentId: string, who: IncidentActor): Promise<{ changed: boolean; status: string }> {
  const row = (await db.query<{ status: string }>(`SELECT status FROM incidents WHERE id = $1 FOR UPDATE`, [incidentId])).rows[0];
  if (!row) throw notFound('Incident');
  if (row.status === 'acknowledged') return { changed: false, status: row.status };
  if (row.status !== 'open') throw new AppError(409, 'not_open', 'Only an open incident can be acknowledged');
  await db.query(`UPDATE incidents SET status = 'acknowledged', acknowledged_at = now() WHERE id = $1`, [incidentId]);
  await addActivity(db, organizationId, incidentId, 'acknowledged', who.id ? 'Acknowledged' : `Acknowledged by ${who.name}`, new Date(), asUser(who));
  await notifyRealtime(db, organizationId, 'events');
  return { changed: true, status: 'acknowledged' };
}
