import { Router } from 'express';
import { defineModule } from '../../infrastructure/module.ts';
import { onNotification, startListening, stopListening } from '../../infrastructure/pg-listen.ts';
import { agentGatewayRouter } from './agent/routes.ts';
import { commandsRouter } from './commands/routes.ts';
import { enrollmentRouter } from './enrollment/routes.ts';
import { fleetRouter } from './fleet/routes.ts';
import { fleetPolicyRouter } from './fleet-policy/routes.ts';
import { fleetAndroidRouter } from './fleet-android/routes.ts';
import { fleetReachRouter } from './fleet-reach/routes.ts';
import { fleetJobsRouter } from './fleet-jobs/routes.ts';
import { runJobScheduler } from './fleet-jobs/jobs.ts';
import { fleetShellRouter } from './fleet-shell/routes.ts';
import { fleetMonitoringRouter } from './fleet-monitoring/routes.ts';
import { fleetPatchesRouter } from './fleet-patches/routes.ts';
import { runPatchScheduler } from './fleet-patches/service.ts';
import { recordingLinksRouter } from './fleet-user/recordings.ts';
import { shellHub } from './fleet-shell/hub.ts';
import { runShellSweep } from './fleet-shell/shells.ts';
import { runQuickSupportSweep } from './fleet-reach/quick-support.ts';
import { runRestartTimeouts } from './fleet-reach/restarts.ts';
import { policyRouter } from './policy/routes.ts';
import { remoteDesktopRouter } from './remote-desktop/routes.ts';
import { runApkFileSweep } from './fleet-android/apks.ts';
import { runRecordingRetention } from './remote-desktop/recording.ts';
import { COMMAND_DONE_CHANNEL, signalCommandDone } from './repo.ts';
import { RD_FRAME_CHANNEL, onFrameNotification } from './remote-desktop/frames.ts';
import { AGENT_WAKE_CHANNEL, onAgentWakeNotification } from './agent/wake.ts';
import { streamHub } from './remote-desktop/stream-hub.ts';

/**
 * Endpoint management (Windows, Linux, macOS agents; Android phones).
 *
 *   agent/           credential-authenticated agent gateway (/api/v1/agent): enroll, heartbeat, poll, results, inventory
 *   fleet/           fleet & inventory reads
 *   enrollment/      register endpoints, re-issue enrollment tokens, revoke
 *   policy/          per-endpoint policy (compliance is evaluated in capabilities.ts)
 *   fleet-android/   Android phones: Device Owner actions (policy, MFA, approvals), APKs to push, provisioning QR
 *   fleet-policy/    Fleet permission profiles, groups, per-group access policy, MFA step-up, approvals
 *   fleet-reach/     address book, connect by name/ID/code, Request help, restart and reconnect, Quick Support
 *   fleet-shell/     remote shell (admins; group switch): agent/operator sockets, encrypted transcript
 *   fleet-jobs/      scripts library (typed parameters, versions) and jobs (now, scheduled, per-computer results)
 *   fleet-patches/   missing updates per computer, approvals, patch policies, installs in windows, restarts
 *   fleet-user/      the person's side: past recordings from the tray (token links, public player API)
 *   fleet-monitoring/ CPU, memory, disk, service and event-log rules evaluated on each heartbeat (Watch events)
 *   fleet-inventory/ hardware and licence inventory reported by the agent
 *   remote-desktop/  live remote desktop sessions: fleet_sessions history, consent, the live
 *                    WebSocket stream hub (stream-hub.ts) and the HTTP command fallback
 *   file-manager/    remote file operations (travel as fs_op commands)
 *   commands/        every remote action queued for an agent
 */
const endpointsApi: Router = Router();
endpointsApi.use(fleetRouter, enrollmentRouter, policyRouter, fleetPolicyRouter, fleetAndroidRouter, fleetReachRouter, fleetShellRouter, fleetJobsRouter, fleetMonitoringRouter, fleetPatchesRouter, remoteDesktopRouter, commandsRouter);

let unsubscribeCommandDone: (() => void) | null = null;
let unsubscribeFrames: (() => void) | null = null;
let unsubscribeWake: (() => void) | null = null;

export const endpointsModule = defineModule({
  name: 'endpoints',
  api: endpointsApi,
  gateway: { path: '/api/v1/agent', rateLimitPerMinute: 360, router: agentGatewayRouter },
  // The player page of a "Past recordings…" link from the tray (token only, no session).
  publicApi: { path: '/recording-links', router: recordingLinksRouter },
  // Session recordings past their group's retention: the file goes, the row stays (marked deleted).
  jobs: [
    { name: 'fleet-recording-retention', everyMs: 3_600_000, lockKey: 727170, run: async () => void (await runRecordingRetention()) },
    // Restart and reconnect past its timeout (safe boot is then cleared when the agent returns);
    // Quick Support codes that expired or whose session ended (their credential is revoked).
    {
      name: 'fleet-reach-sweep',
      everyMs: 30_000,
      lockKey: 727171,
      run: async () => {
        await runRestartTimeouts();
        await runQuickSupportSweep();
      },
    },
    // Jobs: due runs, then results handed to computers that are online (offline ones wait until the
    // run expires); shells the agent never opened or that went idle on no instance's watch.
    {
      name: 'fleet-jobs-scheduler',
      everyMs: 15_000,
      lockKey: 727172,
      run: async () => {
        await runJobScheduler();
        await runShellSweep();
      },
    },
    // Patches: approved updates installed in open windows, then restart questions and deadlines.
    { name: 'fleet-patch-scheduler', everyMs: 30_000, lockKey: 727173, run: async () => void (await runPatchScheduler()) },
    // APK files no row references and leftovers of interrupted uploads (first run right after start).
    { name: 'fleet-apk-file-sweep', everyMs: 6 * 3_600_000, lockKey: 727174, run: async () => void (await runApkFileSweep()) },
  ],
  lifecycle: {
    // Results uploaded to another API instance wake this instance's waiters (interactive commands).
    start: async () => {
      unsubscribeCommandDone ??= onNotification(COMMAND_DONE_CHANNEL, (id) => id && signalCommandDone(id));
      // Remote desktop frames uploaded to another instance (transient: remote-desktop/frames.ts).
      unsubscribeFrames ??= onNotification(RD_FRAME_CHANNEL, onFrameNotification);
      // A command queued on any instance wakes the agent's long poll held here (agent/wake.ts).
      unsubscribeWake ??= onNotification(AGENT_WAKE_CHANNEL, onAgentWakeNotification);
      // Live remote desktop streams: session state and socket routing between instances.
      streamHub().start();
      // Remote shells: sockets and transcripts (fleet-shell/hub.ts).
      shellHub().start();
      await startListening();
    },
    stop: async () => {
      unsubscribeCommandDone?.();
      unsubscribeCommandDone = null;
      unsubscribeFrames?.();
      unsubscribeFrames = null;
      unsubscribeWake?.();
      unsubscribeWake = null;
      await streamHub().stop();
      await shellHub().stop();
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
