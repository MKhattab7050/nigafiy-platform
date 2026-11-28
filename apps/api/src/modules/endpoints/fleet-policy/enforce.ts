import type { FleetAccessPolicy, FleetPermissionKey, FleetPermissions, RemoteDesktopSession, Role } from '@nigafiy/shared-types';
import type { Db } from '../../../infrastructure/db.ts';
import { participantAccess } from '../remote-desktop/session-tools.ts';
import { REFUSAL_MESSAGES, effectivePolicy, ipAllowed, withinHours } from './policy.ts';
import { permissionsOf, profileById, sessionPermissions } from './profiles.ts';

// What a session's permission profile refuses, at the API (commands, the live stream hub). The
// agent checks the same flags again on its side (defence in depth). Inside a session the profile
// limits the operator who holds it. Outside a session the file manager, power actions and script
// jobs go through the computer's group policy too (toolRefusal): role, address, hours and the most
// the group's maximum profile allows (audit item 4, 2026-11-27).

export type ProfileRefusalCode =
  | 'profile_forbids_view'
  | 'profile_forbids_control'
  | 'profile_forbids_clipboard_in'
  | 'profile_forbids_clipboard_out'
  | 'profile_forbids_files'
  | 'profile_forbids_restart'
  | 'profile_forbids_privacy_screen'
  | 'profile_forbids_block_input'
  | 'profile_forbids_audio'
  | 'profile_forbids_record'
  | 'profile_forbids_shell';

export const PROFILE_REFUSAL_MESSAGES: Record<ProfileRefusalCode, string> = {
  profile_forbids_view: 'The permission profile of this session does not allow seeing the screen',
  profile_forbids_control: 'The permission profile of this session is view only: no mouse or keyboard',
  profile_forbids_clipboard_in: 'The permission profile of this session does not allow sending the clipboard to the computer',
  profile_forbids_clipboard_out: 'The permission profile of this session does not allow taking the clipboard from the computer',
  profile_forbids_files: 'The permission profile of your session on this computer does not allow file transfer',
  profile_forbids_restart: 'The permission profile of your session on this computer does not allow restart, shutdown or sign-out',
  profile_forbids_privacy_screen: 'The permission profile of this session does not allow the privacy screen',
  profile_forbids_block_input: 'The permission profile of this session does not allow blocking the local keyboard and mouse',
  profile_forbids_audio: 'The permission profile of this session does not allow listening to the computer’s sound',
  profile_forbids_record: 'The permission profile of this session does not allow recording',
  profile_forbids_shell: 'The access policy of this computer does not allow scripts or a remote shell',
};

const NEEDS: Record<ProfileRefusalCode, FleetPermissionKey> = {
  profile_forbids_view: 'view',
  profile_forbids_control: 'control',
  profile_forbids_clipboard_in: 'clipboard_in',
  profile_forbids_clipboard_out: 'clipboard_out',
  profile_forbids_files: 'files',
  profile_forbids_restart: 'restart',
  profile_forbids_privacy_screen: 'privacy_screen',
  profile_forbids_block_input: 'block_input',
  profile_forbids_audio: 'audio',
  profile_forbids_record: 'record',
  profile_forbids_shell: 'shell',
};

export const refusalFlag = (code: ProfileRefusalCode): FleetPermissionKey => NEEDS[code];

/**
 * The refusal for a command under an open session, or null. `holder`: the requesting operator holds
 * the session (file and power tools are limited only for them; frames and input always).
 */
export function commandRefusal(
  body: { kind: string; action?: string },
  perms: FleetPermissions,
  holder: boolean,
): ProfileRefusalCode | null {
  if (body.kind === 'rd_capture' && !perms.view) return 'profile_forbids_view';
  if (body.kind === 'rd_input' && !perms.control) return 'profile_forbids_control';
  if (holder && body.kind === 'fs_op' && !perms.files) return 'profile_forbids_files';
  if (holder && body.kind === 'power_action' && body.action !== 'lock' && !perms.restart) return 'profile_forbids_restart';
  return null;
}

/** For commands/service.ts: the open session's permissions and whether `userId` holds it. */
export async function openSessionFor(
  db: Db,
  endpointId: string,
  userId: string,
): Promise<{ perms: FleetPermissions; holder: boolean; participant: boolean; sessionId: string } | null> {
  const r = await db.query<{ rd_session: (RemoteDesktopSession & { operator_user_id?: string }) | null }>(`SELECT rd_session FROM endpoints WHERE id = $1`, [endpointId]);
  const s = r.rows[0]?.rd_session;
  if (!s) return null;
  // Several operators (migration 036): a joined colleague acts with their own, narrower permissions.
  const mine = await participantAccess(db, s, userId);
  return { perms: mine ?? sessionPermissions(s), holder: s.operator_user_id === userId, participant: mine !== null, sessionId: s.id };
}

/** What a tool used outside a session needs from the group's maximum profile. */
export type ToolNeed = 'files' | 'restart' | 'shell';

export const TOOL_REFUSAL_CODE: Record<ToolNeed, ProfileRefusalCode> = {
  files: 'profile_forbids_files',
  restart: 'profile_forbids_restart',
  shell: 'profile_forbids_shell',
};

const TOOL_MESSAGES: Record<ToolNeed, string> = {
  files: 'The access policy of this computer does not allow file transfer',
  restart: 'The access policy of this computer does not allow restart, shutdown or sign-out',
  shell: PROFILE_REFUSAL_MESSAGES.profile_forbids_shell,
};

export interface ToolCheck {
  policy: Pick<FleetAccessPolicy, 'allowed_roles' | 'ip_allowlist' | 'allowed_hours'>;
  timezone: string;
  max: FleetPermissions;
  /** The flag of the maximum profile the tool needs (undefined: only role, address and hours). */
  need?: ToolNeed;
  role: Role | string;
  /** The operator's address; undefined skips the address check (a job the scheduler sends). */
  requestIp?: string | null;
  /** undefined skips the hours check (jobs keep their own maintenance windows). */
  now?: Date;
}

/** Pure: why the group policy refuses a tool outside a session, or null. */
export function toolPolicyRefusal(c: ToolCheck): { code: string; message: string } | null {
  if (c.role === 'viewer' || !c.policy.allowed_roles.includes(c.role as FleetAccessPolicy['allowed_roles'][number])) {
    return { code: 'policy_role_not_allowed', message: REFUSAL_MESSAGES.policy_role_not_allowed };
  }
  if (c.requestIp !== undefined && !ipAllowed(c.policy.ip_allowlist, c.requestIp)) {
    return { code: 'policy_ip_not_allowed', message: REFUSAL_MESSAGES.policy_ip_not_allowed };
  }
  if (c.now && !withinHours(c.policy, c.now, c.timezone)) {
    return { code: 'policy_outside_hours', message: 'The access policy of this computer does not allow this at this time' };
  }
  if (c.need && !permissionsOf(c.max)[c.need]) return { code: TOOL_REFUSAL_CODE[c.need], message: TOOL_MESSAGES[c.need] };
  return null;
}

/** The group policy check for one endpoint (null: allowed, or the endpoint is not in this organization). */
export async function toolRefusal(db: Db, orgId: string, endpointId: string, check: Omit<ToolCheck, 'policy' | 'timezone' | 'max'>): Promise<{ code: string; message: string } | null> {
  const eff = await effectivePolicy(db, orgId, endpointId);
  if (!eff) return null;
  const max = await profileById(db, eff.policy.max_profile_id);
  if (!max) return { code: 'policy_role_not_allowed', message: 'The access policy of this computer could not be read' };
  return toolPolicyRefusal({ ...check, policy: eff.policy, timezone: eff.timezone, max });
}

/** The tool a command needs from the policy outside a session (null: not governed here). */
export function toolNeedOf(body: { kind: string; action?: string }): ToolNeed | null {
  if (body.kind === 'fs_op') return 'files';
  if (body.kind === 'power_action' && body.action !== 'lock') return 'restart';
  return null;
}
