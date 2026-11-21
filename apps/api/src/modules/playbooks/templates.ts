import type { StepInput, Trigger } from './schema.ts';

/**
 * Built-in templates: one click creates an ordinary (disabled) playbook from them, which is then
 * edited like any other. Every step uses a real action of the catalogue; disruptive steps keep the
 * default "always ask" approval.
 */
export interface PlaybookTemplate {
  key: string;
  name: string;
  description: string;
  trigger: Trigger;
  steps: StepInput[];
}

export const TEMPLATES: readonly PlaybookTemplate[] = [
  {
    key: 'unknown_device_joined',
    name: 'Unknown device joined',
    description:
      'When a device nobody has reviewed joins the network: notify, then ask an administrator whether to block it on the router and pause its internet through the DNS filter. Each of the two needs an approval; rejecting one keeps the other.',
    trigger: { kind: 'event', event_types: ['device_discovered'], filters: { device_trust: ['unreviewed'] } },
    steps: [
      { key: 'notify', action: 'notify', params: { title: 'Unknown device joined: {device}', message: 'IP {ip}, MAC {mac} at {site}. Approve or reject the block in LAN Detective → Playbooks → Approvals.', severity: 'warning', attach: 'trigger' } },
      { key: 'block', action: 'router_block', on_error: 'continue', params: { router_id: null, device_id: null } },
      { key: 'pause', action: 'dns_pause', on_error: 'continue', params: { minutes: 24 * 60, device_id: null } },
    ],
  },
  {
    key: 'critical_server_offline',
    name: 'Critical server offline',
    description:
      'When a device marked critical stops responding: ping it from the collector, send a Wake-on-LAN packet, wait two minutes, ping again, and notify only if it is still not answering.',
    trigger: { kind: 'event', event_types: ['device_offline'], filters: { critical_only: true } },
    steps: [
      { key: 'ping1', action: 'run_tool', params: { tool: 'ping', target: 'trigger_device' } },
      { key: 'wake', action: 'wake_device', on_error: 'continue', params: { device_id: null } },
      { key: 'wait', action: 'wait', params: { seconds: 120 } },
      { key: 'ping2', action: 'run_tool', params: { tool: 'ping', target: 'trigger_device' } },
      { key: 'still_down', action: 'condition', params: { test: 'last_probe_failed', if_true: 'continue' } },
      { key: 'notify', action: 'notify', params: { title: 'Still offline after Wake-on-LAN: {device}', message: 'The device did not answer a ping 2 minutes after the wake packet.', severity: 'critical', attach: 'previous_output' } },
    ],
  },
  {
    key: 'service_check_failed',
    name: 'Service check failed',
    description: 'When a service check goes down: run a traceroute to the check’s target from the collector and attach the result to the incident as a comment.',
    trigger: { kind: 'event', event_types: ['check_down'], filters: { check_roles: ['service'] } },
    steps: [
      { key: 'trace', action: 'run_tool', params: { tool: 'traceroute', target: 'trigger_check' } },
      { key: 'comment', action: 'incident_comment', params: { body: 'Traceroute from the collector when "{title}" was detected:', include_previous_output: true } },
    ],
  },
  {
    key: 'unwanted_device_online',
    name: 'Unwanted device online',
    description: 'When a device you marked unwanted comes back: ask an administrator to block it on the site’s router.',
    trigger: { kind: 'event', event_types: ['unwanted_device_online'], filters: {} },
    steps: [{ key: 'block', action: 'router_block', params: { router_id: null, device_id: null } }],
  },
  {
    key: 'nightly_discovery',
    name: 'Nightly discovery and summary',
    description: 'Every night at 02:00 (site time): run discovery now on the online collectors, wait for them to finish, then send a summary of the inventory and open incidents.',
    trigger: { kind: 'schedule', daily_at: '02:00' },
    steps: [
      { key: 'discover', action: 'run_discovery', params: {} },
      { key: 'summary', action: 'notify', params: { title: 'Nightly network summary', message: 'Discovery finished.', severity: 'info', attach: 'site_summary' } },
    ],
  },
];

export const templateByKey = (key: string): PlaybookTemplate | undefined => TEMPLATES.find((t) => t.key === key);
