import type { EndpointAndroidState, EndpointPlatform } from '@nigafiy/shared-types';
import { AppError } from '../../../common/http.ts';
import { assertFileOperationAllowed } from '../file-manager/guards.ts';
import type { CommandInput } from './schema.ts';

/**
 * Role and platform rules for a command, checked before it is queued. Each rule concerns one
 * command kind, so the rules are independent of each other's order.
 */
export function validateCommandForPlatform(platform: EndpointPlatform, body: CommandInput, userRole: string, android?: EndpointAndroidState | null): void {
  const isAdmin = userRole === 'admin' || userRole === 'owner';

  // Role checks for high-impact / destructive commands
  if (body.kind === 'power_action' && (body.action === 'restart' || body.action === 'shutdown') && !isAdmin) {
    throw new AppError(403, 'forbidden', 'Restarting or shutting down a machine requires admin privileges');
  }
  if (body.kind === 'software_action' && !isAdmin) {
    throw new AppError(403, 'forbidden', 'Installing or removing software packages requires admin privileges');
  }
  if (body.kind === 'fs_op') assertFileOperationAllowed(body, isAdmin);

  // Android (agents/android-agent): inventory refresh, and the phone controls the app reports
  // (docs/features/android.md §12): the screen of a session the person accepted, its input (taps,
  // swipes, Back / Home / Recents), the shared-storage file manager and messages. The Device Owner
  // actions go through POST /endpoints/:id/android/actions (MFA step-up, approvals).
  if (platform === 'android') assertAndroidCommand(body, android ?? null);

  // Refuse up front what the agent cannot do on this platform, instead of queueing a command that fails.
  // (Sign-out works on all three: shutdown /l, loginctl terminate-session, System Events log out.)
  if (body.kind === 'diagnostic_command' && body.tool === 'gpresult' && platform !== 'windows') {
    throw new AppError(409, 'unsupported_by_platform', 'gpresult is only available on Windows');
  }
}

const ANDROID_FEATURE: Partial<Record<CommandInput['kind'], 'screen' | 'files' | 'message'>> = {
  rd_capture: 'screen',
  rd_input: 'screen',
  fs_op: 'files',
  notify_user: 'message',
};
/** A phone has taps, swipes and Back / Home / Recents; no mouse moves, wheel, keys or typing. */
export const ANDROID_INPUT_KINDS = new Set(['mouse_click', 'swipe', 'nav']);

export function assertAndroidCommand(body: CommandInput, android: EndpointAndroidState | null): void {
  if (body.kind === 'refresh_inventory') return;
  const feature = ANDROID_FEATURE[body.kind];
  if (!feature) throw new AppError(409, 'unsupported_by_platform', 'Android phones take inventory refreshes and the phone controls here; use the Android actions for the rest');
  if (!android?.features?.includes(feature)) {
    throw new AppError(409, 'android_feature_missing', 'The Nigafiy app on this phone does not offer this yet: update the app on the phone');
  }
  if (body.kind === 'rd_input' && !ANDROID_INPUT_KINDS.has(body.event_kind)) {
    throw new AppError(409, 'unsupported_by_platform', 'A phone takes taps, swipes and Back / Home / Recents only');
  }
  if (body.kind === 'rd_input' && body.event_kind !== 'mouse_click' && !android.features.includes('control')) {
    throw new AppError(409, 'android_feature_missing', 'The Nigafiy app on this phone does not offer remote control yet');
  }
  if (body.kind === 'rd_input' && android.accessibility_enabled === false) {
    throw new AppError(409, 'android_control_not_enabled', 'Remote control is not turned on on the phone (Settings → Accessibility → Nigafiy)');
  }
  if (body.kind === 'fs_op' && android.all_files_access === false) {
    throw new AppError(409, 'android_files_not_allowed', 'All files access is not allowed on the phone yet: the person allows it in the Nigafiy app');
  }
}
