import type { Request } from 'express';
import type { Confidence, EndpointEnrollmentSuggestion, EndpointPlatform } from '@lan-detective/shared-types';
import { type AuthContext, notFound, publicServerUrl } from '../../../common/http.ts';
import { withTenant } from '../../../infrastructure/db.ts';

// Device → endpoint enrollment helper: what to pre-fill when the user enrolls a discovered device.
// Enrolling stays the explicit POST /endpoints (admin); this only proposes values, labelled by origin.

export interface PlatformFacts {
  device_type: string;
  type_source: 'none' | 'inferred' | 'manual';
  type_confidence: Confidence | null;
  type_evidence: string | null;
  fingerprint: { hints?: Record<string, string>; ssdp?: { server?: string } } | null;
}

export interface PlatformGuess {
  platform: EndpointPlatform;
  source: 'inferred' | 'default';
  confidence: Confidence | null;
  evidence: string[];
}

const BY_TYPE: Record<string, EndpointPlatform> = { windows_computer: 'windows', linux_computer: 'linux', apple_computer: 'macos' };
const OS_TEXT: [RegExp, EndpointPlatform][] = [
  [/\bwindows\b/i, 'windows'],
  [/\b(mac ?os|darwin|os x)\b/i, 'macos'],
  [/\blinux\b|ubuntu|debian|red ?hat|centos|fedora/i, 'linux'],
];

/** Pure: the agent platform a device most likely needs, from its classification; windows only as a stated default. */
export function guessPlatform(d: PlatformFacts): PlatformGuess {
  const byType = BY_TYPE[d.device_type];
  if (byType && d.type_source !== 'none') {
    const how = d.type_source === 'manual' ? 'set by you' : `inferred, ${d.type_confidence ?? 'low'} confidence`;
    return {
      platform: byType,
      source: 'inferred',
      confidence: d.type_source === 'manual' ? 'high' : (d.type_confidence ?? 'low'),
      evidence: [`Device type is ${d.device_type.replace('_', ' ')} (${how})`, ...(d.type_source === 'inferred' && d.type_evidence ? [d.type_evidence] : [])],
    };
  }
  // A weaker sign: the operating system named in what the device announced (e.g. a UPnP server string).
  const texts = [d.fingerprint?.hints?.os, d.fingerprint?.ssdp?.server].filter((t): t is string => Boolean(t));
  for (const text of texts) {
    for (const [re, platform] of OS_TEXT) {
      if (re.test(text)) return { platform, source: 'inferred', confidence: 'low', evidence: [`The device announced "${text.slice(0, 80)}"`] };
    }
  }
  return {
    platform: 'windows',
    source: 'default',
    confidence: null,
    evidence: ['The operating system of this device is not known; Windows is the default — change it if needed'],
  };
}

export function enrollmentSuggestion(req: Request, ctx: AuthContext, deviceId: string): Promise<EndpointEnrollmentSuggestion> {
  return withTenant(ctx.organizationId, async (db) => {
    const d = (
      await db.query<PlatformFacts & { id: string; site_id: string; name: string }>(
        `SELECT id, site_id, coalesce(display_name, hostname, host(current_ip), primary_mac::text, 'Endpoint') AS name,
                device_type, type_source, type_confidence, type_evidence, fingerprint
           FROM devices WHERE id = $1`,
        [deviceId],
      )
    ).rows[0];
    if (!d) throw notFound('Device');
    const existing = (
      await db.query<{ id: string }>(`SELECT id FROM endpoints WHERE device_id = $1 AND status <> 'revoked' ORDER BY created_at DESC LIMIT 1`, [deviceId])
    ).rows[0];
    const guess = guessPlatform(d);
    return {
      device_id: d.id,
      site_id: d.site_id,
      suggested_name: d.name.slice(0, 80),
      suggested_platform: guess.platform,
      platform_source: guess.source,
      platform_confidence: guess.confidence,
      platform_evidence: guess.evidence,
      existing_endpoint_id: existing?.id ?? null,
      ...publicServerUrl(req),
    };
  });
}
