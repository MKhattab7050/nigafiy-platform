import { Router } from 'express';
import { defineModule } from '../../infrastructure/module.ts';
import { onNotification, startListening, stopListening } from '../../infrastructure/pg-listen.ts';
import { agentGatewayRouter } from './agent/routes.ts';
import { commandsRouter } from './commands/routes.ts';
import { enrollmentRouter } from './enrollment/routes.ts';
import { fleetRouter } from './fleet/routes.ts';
import { policyRouter } from './policy/routes.ts';
import { remoteDesktopRouter } from './remote-desktop/routes.ts';
import { COMMAND_DONE_CHANNEL, signalCommandDone } from './repo.ts';
import { RD_FRAME_CHANNEL, onFrameNotification } from './remote-desktop/frames.ts';

/**
 * Endpoint management (Windows, Linux, macOS agents).
 *
 *   agent/           credential-authenticated agent gateway (/api/v1/agent): enroll, heartbeat, poll, results, inventory
 *   fleet/           fleet & inventory reads
 *   enrollment/      register endpoints, re-issue enrollment tokens, revoke
 *   policy/          per-endpoint policy (compliance is evaluated in capabilities.ts)
 *   remote-desktop/  live remote desktop sessions (frames/input travel as commands)
 *   file-manager/    remote file operations (travel as fs_op commands)
 *   commands/        every remote action queued for an agent
 */
const endpointsApi: Router = Router();
endpointsApi.use(fleetRouter, enrollmentRouter, policyRouter, remoteDesktopRouter, commandsRouter);

let unsubscribeCommandDone: (() => void) | null = null;
let unsubscribeFrames: (() => void) | null = null;

export const endpointsModule = defineModule({
  name: 'endpoints',
  api: endpointsApi,
  gateway: { path: '/api/v1/agent', rateLimitPerMinute: 360, router: agentGatewayRouter },
  lifecycle: {
    // Results uploaded to another API instance wake this instance's waiters (interactive commands).
    start: async () => {
      unsubscribeCommandDone ??= onNotification(COMMAND_DONE_CHANNEL, (id) => id && signalCommandDone(id));
      // Remote desktop frames uploaded to another instance (transient: remote-desktop/frames.ts).
      unsubscribeFrames ??= onNotification(RD_FRAME_CHANNEL, onFrameNotification);
      await startListening();
    },
    stop: async () => {
      unsubscribeCommandDone?.();
      unsubscribeCommandDone = null;
      unsubscribeFrames?.();
      unsubscribeFrames = null;
      await stopListening();
    },
  },
});

export { payloadForAudit } from './repo.ts';
export { deviceEndpointControl } from './controls.ts';
export type { EndpointContext } from './schema.ts';
export {
  AUTOMATABLE_COMMAND_KINDS,
  type AutomatableCommandKind,
  type CommandRequester,
  endpointCommandState,
  parseAutomatableCommand,
  queueEndpointCommandFor,
} from './commands/automation.ts';
export type { CommandInput } from './commands/schema.ts';
