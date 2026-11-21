import type { EndpointPlatform } from '@lan-detective/shared-types';
import type { Db } from '../../infrastructure/db.ts';
import { buildCapabilities } from './capabilities.ts';

const COMPUTER_TYPES: Record<string, EndpointPlatform> = { windows_computer: 'windows', linux_computer: 'linux', server: 'linux', apple_computer: 'macos' };

/**
 * The endpoint agent linked to a device (GET /devices/:id/controls), with what it can do; or, for a
 * computer without an agent, a suggestion to enroll one. The device link is inferred (the agent's
 * reported MAC / IP matched the discovered device).
 */
export async function deviceEndpointControl(db: Db, device: { id: string; device_type: string | null }) {
  const ep = (
    await db.query<{ id: string; name: string; platform: EndpointPlatform; status: string; connection_state: string; last_heartbeat_at: Date | null; compliance_status: string | null; agent_version: string | null }>(
      `SELECT id, name, platform, status, connection_state, last_heartbeat_at, compliance_status, agent_version
         FROM endpoints WHERE device_id = $1 AND status <> 'revoked' ORDER BY last_heartbeat_at DESC NULLS LAST LIMIT 1`,
      [device.id],
    )
  ).rows[0];
  if (ep) {
    return {
      linked: true,
      link: 'inferred' as const,
      link_evidence: 'the agent reported this device’s MAC or IP address',
      endpoint: ep,
      href: `/endpoints/${ep.id}`,
      capabilities: buildCapabilities(ep.platform),
    };
  }
  const platform = device.device_type ? COMPUTER_TYPES[device.device_type] : undefined;
  return {
    linked: false,
    suggestion: platform
      ? { action: 'enroll_agent', platform, href: '/endpoints', reason: 'This looks like a computer; an endpoint agent adds inventory and remote administration.' }
      : null,
  };
}
