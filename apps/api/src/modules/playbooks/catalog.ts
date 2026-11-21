// The closed catalogue of what a playbook can listen to and do. Nothing outside these lists can be
// stored (schema.ts validates against them) or executed (actions.ts has one executor per action).

/**
 * Event types other modules emit with emitEvent() today (grep `type: '` in modules/*). Playbooks can
 * trigger on these. The playbook module's own events (playbook_*) are deliberately absent: a playbook
 * must never be triggered by a notification or approval request it produced itself.
 */
export const TRIGGER_EVENT_TYPES = [
  // discovery (modules/ingest/discovery)
  'device_discovered',
  'device_online',
  'device_offline',
  'device_ip_changed',
  'ip_mac_changed',
  'unwanted_device_online',
  'discovery_baseline',
  // checks (modules/ingest/checks.ts)
  'check_down',
  'check_degraded',
  'check_recovered',
  // collectors (modules/collectors, modules/ingest)
  'collector_offline',
  'collector_online',
  'collector_enrolled',
  // endpoints
  'endpoint_enrolled',
  'endpoint_command',
  // IPAM
  'ip_conflict',
  'ip_conflict_resolved',
  // switches (modules/ports)
  'switch_unreadable',
  'switch_readable',
  'device_port_changed',
  // routers
  'router_login_failed',
  'router_unreachable',
  'router_reachable',
  'device_blocked',
  'device_unblocked',
  // maintenance
  'maintenance_started',
  'maintenance_ended',
] as const;
export type TriggerEventType = (typeof TRIGGER_EVENT_TYPES)[number];

/** Event types whose events concern a check (check filters and "the trigger check" apply to them). */
export const CHECK_EVENT_TYPES: readonly string[] = ['check_down', 'check_degraded', 'check_recovered'];

/** Events this module emits (never triggers). */
export const PLAYBOOK_EVENT_TYPES = ['playbook_notification', 'playbook_approval_requested'] as const;

export const INCIDENT_KINDS = ['network', 'service', 'collector', 'device'] as const;

export const ACTION_KEYS = [
  'notify',
  'run_tool',
  'run_checks',
  'run_discovery',
  'wake_device',
  'set_trust',
  'dns_pause',
  'dns_resume',
  'router_block',
  'router_unblock',
  'router_rate_limit',
  'endpoint_command',
  'incident_comment',
  'incident_acknowledge',
  'wait',
  'condition',
  'approval',
] as const;
export type ActionKey = (typeof ACTION_KEYS)[number];

export type Risk = 'low' | 'disruptive';

export interface ActionInfo {
  /** Needs a device (the trigger's device, a chosen one, or a fixed device_id param). */
  needsDevice: boolean;
  /** Needs an incident (from an incident trigger, or the incident the triggering event belongs to). */
  needsIncident: boolean;
  /**
   * Disruptive steps wait for an administrator's approval unless the playbook runs automatically.
   * `alwaysApprove`: never automatic, whatever the playbook says (router changes: the routers module's
   * rule is that nothing is blocked on a router without an administrator's explicit request).
   */
  alwaysApprove: boolean;
  /** Events this action can cause (loop guard). `siteWide`: they concern the site, not one device. */
  produces: readonly string[];
  siteWide: boolean;
}

const info = (i: Partial<ActionInfo>): ActionInfo => ({ needsDevice: false, needsIncident: false, alwaysApprove: false, produces: [], siteWide: false, ...i });

export const ACTIONS: Record<ActionKey, ActionInfo> = {
  notify: info({ produces: ['playbook_notification'] }),
  run_tool: info({}),
  run_checks: info({ produces: ['check_down', 'check_degraded', 'check_recovered'], siteWide: true }),
  run_discovery: info({
    produces: ['device_discovered', 'device_online', 'device_offline', 'device_ip_changed', 'ip_mac_changed', 'unwanted_device_online', 'discovery_baseline', 'ip_conflict', 'ip_conflict_resolved'],
    siteWide: true,
  }),
  wake_device: info({ needsDevice: true, produces: ['device_online'] }),
  set_trust: info({ needsDevice: true, produces: ['unwanted_device_online'] }),
  dns_pause: info({ needsDevice: true }),
  dns_resume: info({ needsDevice: true }),
  router_block: info({ needsDevice: true, alwaysApprove: true, produces: ['device_blocked'] }),
  router_unblock: info({ needsDevice: true, alwaysApprove: true, produces: ['device_unblocked'] }),
  router_rate_limit: info({ needsDevice: true, alwaysApprove: true }),
  endpoint_command: info({ needsDevice: true, produces: ['endpoint_command'] }),
  incident_comment: info({ needsIncident: true }),
  incident_acknowledge: info({ needsIncident: true }),
  wait: info({}),
  condition: info({}),
  /** An explicit approval gate: the run pauses here until an administrator approves, whatever the approval mode. */
  approval: info({}),
};

/** Risk of one configured step. */
export function riskOf(action: ActionKey, params: Record<string, unknown>): Risk {
  switch (action) {
    case 'router_block':
    case 'router_unblock':
    case 'router_rate_limit':
    case 'dns_pause':
    case 'endpoint_command':
      return 'disruptive';
    case 'set_trust':
      return params.trust === 'unwanted' ? 'disruptive' : 'low';
    default:
      return 'low';
  }
}

/** Actions whose step can name its own device (device_id param) instead of the trigger's. */
export const DEVICE_PARAM_ACTIONS: readonly ActionKey[] = (Object.keys(ACTIONS) as ActionKey[]).filter((k) => ACTIONS[k].needsDevice);

export const CONDITION_TESTS = [
  'device_online',
  'device_offline',
  'check_state',
  'previous_failed',
  'previous_succeeded',
  'last_probe_failed',
  'last_probe_succeeded',
] as const;
export type ConditionTest = (typeof CONDITION_TESTS)[number];

/** Approval requests and the waits of async steps. */
export const LIMITS = {
  /** Event / incident lookback: what happened earlier than this when the engine looks is not matched. */
  triggerLookbackMinutes: 10,
  /** A schedule slot more than this late is skipped (the next slot will come). */
  scheduleGraceMinutes: 30,
  /** Loop guard: an action step this recent can be the cause of a triggering event. */
  loopWindowMinutes: 20,
  /** Loop guard: longest chain of playbooks triggering each other. */
  maxChainDepth: 3,
  /** How long async steps wait for the other module's record before failing. */
  toolTimeoutMinutes: 6,
  collectorCommandTimeoutMinutes: 15,
  routerRequestTimeoutMinutes: 12,
  endpointCommandTimeoutMinutes: 10,
  /** A step claimed but not finished this long ago (process restarted mid-action) is failed, never retried. */
  interruptedAfterSeconds: 120,
  pollEverySeconds: 5,
} as const;
