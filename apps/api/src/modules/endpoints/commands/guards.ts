import type { EndpointPlatform } from '@lan-detective/shared-types';
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

  // Refuse up front what the agent cannot do on this platform, instead of queueing a command that fails.
  if (body.kind === 'power_action' && body.action === 'logoff' && platform !== 'windows') {
    throw new AppError(409, 'unsupported_by_platform', 'Signing the user out is only supported on Windows');
  }
  if (body.kind === 'diagnostic_command' && body.tool === 'gpresult' && platform !== 'windows') {
    throw new AppError(409, 'unsupported_by_platform', 'gpresult is only available on Windows');
  }
  if (body.kind === 'rd_input' && platform === 'macos') {
    throw new AppError(409, 'unsupported_by_platform', 'Remote mouse and keyboard control is not implemented on macOS; the session is view-only');
  }
}
