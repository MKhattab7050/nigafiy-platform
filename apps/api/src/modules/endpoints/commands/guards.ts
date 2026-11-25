import type { EndpointPlatform } from '@nigafiy/shared-types';
import { AppError } from '../../../common/http.ts';
import { assertFileOperationAllowed } from '../file-manager/guards.ts';
import type { CommandInput } from './schema.ts';

/**
 * Role and platform rules for a command, checked before it is queued. Each rule concerns one
 * command kind, so the rules are independent of each other's order.
 */
export function validateCommandForPlatform(platform: EndpointPlatform, body: CommandInput, userRole: string): void {
  const isAdmin = userRole === 'admin' || userRole === 'owner';

  // Role checks for high-impact / destructive commands
  if (body.kind === 'power_action' && (body.action === 'restart' || body.action === 'shutdown') && !isAdmin) {
    throw new AppError(403, 'forbidden', 'Restarting or shutting down a machine requires admin privileges');
  }
  if (body.kind === 'software_action' && !isAdmin) {
    throw new AppError(403, 'forbidden', 'Installing or removing software packages requires admin privileges');
  }
  if (body.kind === 'fs_op') assertFileOperationAllowed(body, isAdmin);

  // Android (agents/android-agent): inventory refresh here; everything else goes through
  // POST /endpoints/:id/android/actions (Device Owner rules, MFA step-up, approvals).
  if (platform === 'android' && body.kind !== 'refresh_inventory') {
    throw new AppError(409, 'unsupported_by_platform', 'Android phones take inventory refreshes here; use the Android actions for the rest');
  }

  // Refuse up front what the agent cannot do on this platform, instead of queueing a command that fails.
  // (Sign-out works on all three: shutdown /l, loginctl terminate-session, System Events log out.)
  if (body.kind === 'diagnostic_command' && body.tool === 'gpresult' && platform !== 'windows') {
    throw new AppError(409, 'unsupported_by_platform', 'gpresult is only available on Windows');
  }
}
