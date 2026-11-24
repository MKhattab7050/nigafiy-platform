import type { FleetPermissionKey, FleetPermissions, RemoteDesktopSession } from '@nigafiy/shared-types';
import type { Db } from '../../../infrastructure/db.ts';
import { sessionPermissions } from './profiles.ts';

// What a session's permission profile refuses, at the API (commands, the live stream hub). The
// agent checks the same flags again on its side (defence in depth). Tools used outside a session
// (file manager, power, processes) stay governed by roles; inside a session the profile also limits
// the operator who holds it.

export type ProfileRefusalCode =
  | 'profile_forbids_view'
  | 'profile_forbids_control'
  | 'profile_forbids_clipboard_in'
  | 'profile_forbids_clipboard_out'
  | 'profile_forbids_files'
  | 'profile_forbids_restart';

export const PROFILE_REFUSAL_MESSAGES: Record<ProfileRefusalCode, string> = {
  profile_forbids_view: 'The permission profile of this session does not allow seeing the screen',
  profile_forbids_control: 'The permission profile of this session is view only: no mouse or keyboard',
  profile_forbids_clipboard_in: 'The permission profile of this session does not allow sending the clipboard to the computer',
  profile_forbids_clipboard_out: 'The permission profile of this session does not allow taking the clipboard from the computer',
  profile_forbids_files: 'The permission profile of your session on this computer does not allow file transfer',
  profile_forbids_restart: 'The permission profile of your session on this computer does not allow restart, shutdown or sign-out',
};

const NEEDS: Record<ProfileRefusalCode, FleetPermissionKey> = {
  profile_forbids_view: 'view',
  profile_forbids_control: 'control',
  profile_forbids_clipboard_in: 'clipboard_in',
  profile_forbids_clipboard_out: 'clipboard_out',
  profile_forbids_files: 'files',
  profile_forbids_restart: 'restart',
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
export async function openSessionFor(db: Db, endpointId: string, userId: string): Promise<{ perms: FleetPermissions; holder: boolean; sessionId: string } | null> {
  const r = await db.query<{ rd_session: (RemoteDesktopSession & { operator_user_id?: string }) | null }>(`SELECT rd_session FROM endpoints WHERE id = $1`, [endpointId]);
  const s = r.rows[0]?.rd_session;
  if (!s) return null;
  return { perms: sessionPermissions(s), holder: s.operator_user_id === userId, sessionId: s.id };
}
