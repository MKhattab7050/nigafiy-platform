import { systemPool } from '../../infrastructure/db.ts';
import { logger } from '../../infrastructure/logger.ts';
import { sendAccountEmail } from '../notifications/index.ts';

// Telling the approvers. Every approval request is (1) an event on the timeline, which the
// organization's notification channels (webhook / e-mail) receive like any other warning, and
// (2) an e-mail to each administrator and owner through the organization's account e-mail channel,
// when one is configured. Sent after the transaction committed; a failed e-mail never fails the run.

export interface ApprovalAlert {
  organizationId: string;
  runId: string;
  playbookName: string;
  what: string;
  expiresAt: Date;
  startedBy: string | null;
}

/** Administrators and owners of the organization (the people who may approve). */
export async function approverAccounts(organizationId: string): Promise<{ id: string; email: string; role: string }[]> {
  return (
    await systemPool.query<{ id: string; email: string; role: string }>(
      `SELECT u.id, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = $1 AND m.role IN ('admin', 'owner') ORDER BY u.email`,
      [organizationId],
    )
  ).rows;
}

export async function sendApprovalEmails(alerts: ApprovalAlert[]): Promise<void> {
  for (const a of alerts) {
    try {
      const approvers = await approverAccounts(a.organizationId);
      for (const person of approvers) {
        const outcome = await sendAccountEmail(a.organizationId, person.email, {
          subject: `LAN Detective: approval needed for playbook "${a.playbookName}"`,
          text:
            `The playbook "${a.playbookName}" is waiting for an administrator before it will ${a.what}.\n\n` +
            `Approve or reject it in LAN Detective → Playbooks → Approvals (run ${a.runId}).\n` +
            `If nobody decides by ${a.expiresAt.toISOString()} the step expires and is not carried out.\n`,
        });
        if (outcome === 'not_configured') break; // no account e-mail channel: the timeline event and channels still carry it
      }
    } catch (err) {
      logger.warn({ err, run_id: a.runId }, 'playbook approval e-mail failed');
    }
  }
}
