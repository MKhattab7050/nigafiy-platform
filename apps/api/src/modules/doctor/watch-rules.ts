import type { Diagnosis, EvidenceItem } from '@lan-detective/shared-types';

/**
 * Network Doctor rules for the watch checks (http / https / tls_expiry / snmp_oid). Pure functions
 * over what the collector reported (the last error, the measured value and its evidence); used by
 * diagnoseService in rules.ts before the generic service rules. Every rule says what was observed.
 */

type Core = Omit<Diagnosis, 'engine' | 'generated_at' | 'related_incidents' | 'affected'>;

export interface WatchCheckFacts {
  name: string;
  kind: string;
  target: string;
  port: number | null;
  state: string;
  last_result_at: Date | null;
  last_error: string | null;
  last_value: number | null;
  last_details: Record<string, unknown> | null;
  config: Record<string, unknown>;
}

export const WATCH_KIND_LABEL: Record<string, string> = { http: 'HTTP', https: 'HTTPS', tls_expiry: 'TLS certificate', snmp_oid: 'SNMP' };

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const fmtNum = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) < 10 ? 2 : 1));
const str = (v: unknown) => (typeof v === 'string' ? v : null);

/** The measured value of the last sample, as an evidence item (null when there is none to show). */
export function watchValueEvidence(c: WatchCheckFacts): EvidenceItem | null {
  const d = c.last_details ?? {};
  const source = `${WATCH_KIND_LABEL[c.kind] ?? c.kind.toUpperCase()} check from the site collector`;
  if ((c.kind === 'tls_expiry' || c.kind === 'https') && str(d.cert_not_after)) {
    const days = c.kind === 'tls_expiry' && c.last_value !== null ? c.last_value : (new Date(str(d.cert_not_after)!).getTime() - (c.last_result_at?.getTime() ?? Date.now())) / 86_400_000;
    const parts = [`Expires ${str(d.cert_not_after)!.slice(0, 10)} (${days < 0 ? `${fmtNum(-days)} days ago` : `in ${fmtNum(Math.round(days * 10) / 10)} days`})`];
    if (str(d.cert_issuer)) parts.push(`issuer ${str(d.cert_issuer)}`);
    if (d.verified === false) parts.push('chain does not verify for this name');
    return { label: 'Certificate', value: parts.join(' · '), basis: 'observed', source, observed_at: iso(c.last_result_at) };
  }
  if (c.kind === 'snmp_oid' && c.last_value !== null) {
    const unit = str(c.config.unit) ? ` ${str(c.config.unit)}` : '';
    return { label: `OID ${str(c.config.oid) ?? ''}`.trim(), value: `${fmtNum(c.last_value)}${unit}${str(d.raw_value) ? ` (raw ${str(d.raw_value)})` : ''}`, basis: 'observed', source, observed_at: iso(c.last_result_at) };
  }
  if ((c.kind === 'http' || c.kind === 'https') && typeof d.status_code === 'number') {
    return { label: 'HTTP response', value: `Status ${d.status_code}${str(d.final_url) ? ` from ${str(d.final_url)}` : ''}`, basis: 'observed', source, observed_at: iso(c.last_result_at) };
  }
  return null;
}

const base = (evidence: EvidenceItem[], ruledOut: EvidenceItem[]) => ({ evidence, ruled_out: ruledOut, recommendations: [] as string[], alternatives: [] as string[] });

/** A watch-specific diagnosis, or null to fall through to the generic service rules. */
export function diagnoseWatch(c: WatchCheckFacts, evidence: EvidenceItem[], hostUp: EvidenceItem[]): Core | null {
  if (!(c.kind in WATCH_KIND_LABEL)) return null;
  const error = c.last_error ?? '';
  const value = watchValueEvidence(c);
  const ev = value ? [...evidence, value] : evidence;

  if (error.startsWith('refused:')) {
    return {
      rule: 'watch-target-refused',
      fault_domain: 'service',
      title: `${c.name}: target not allowed`,
      summary: `The collector refused to connect (${error.slice(9).trim()}). Nothing was sent to the target.`,
      probable_cause: 'The target, an address its name resolves to, or a redirect points outside the authorized scopes of the site, or to a public host while the check does not allow public hosts.',
      confidence: 'high',
      confidence_reason: 'The refusal is the collector’s own safety rule, recorded before any connection attempt.',
      ...base(ev, []),
      investigation_steps: [
        'Check which address the name resolves to from the collector host',
        'Add the target’s network as an authorized scope if it belongs to this site',
        'For an internet service, turn on "allow public host" for this check',
      ],
    };
  }

  if (c.kind === 'tls_expiry' && !c.last_error && c.last_value !== null && (c.state === 'down' || c.state === 'degraded')) {
    const expired = c.last_value < 0;
    return {
      rule: expired ? 'watch-certificate-expired' : 'watch-certificate-expiring',
      fault_domain: 'service',
      title: expired ? `${c.name}: certificate expired` : `${c.name}: certificate expires in ${Math.max(0, Math.floor(c.last_value))} days`,
      summary: expired
        ? `The certificate presented at ${c.target}:${c.port} expired ${fmtNum(-c.last_value)} days ago. Browsers and clients that verify certificates refuse the connection.`
        : `The certificate presented at ${c.target}:${c.port} expires in ${fmtNum(c.last_value)} days (warning at ${c.config.warn_days ?? 30}, critical at ${c.config.critical_days ?? 7} days).`,
      probable_cause: expired ? 'The certificate was not renewed in time, or renewal failed.' : 'The certificate is approaching its expiry date and has not been renewed yet.',
      confidence: 'high',
      confidence_reason: 'The expiry date is read directly from the certificate the server presented.',
      ...base(ev, hostUp),
      investigation_steps: ['Renew the certificate (or check why automatic renewal did not run)', 'Install the renewed certificate on every server or device that serves this name'],
    };
  }

  if (/does not match the pinned SHA-256/.test(error)) {
    return {
      rule: 'watch-certificate-pin-mismatch',
      fault_domain: 'service',
      title: `${c.name}: unexpected certificate`,
      summary: 'The server presented a different certificate than the one pinned for this check.',
      probable_cause: 'The certificate was renewed or replaced (update the pin), or something between the collector and the server answers with its own certificate.',
      confidence: 'medium',
      confidence_reason: 'A changed fingerprint is certain; whether the change was planned is not.',
      ...base(ev, hostUp),
      alternatives: ['A TLS-intercepting proxy or a different server is answering on this address'],
      investigation_steps: ['Compare the fingerprint in the evidence with the certificate installed on the server', 'Update the pin after a planned renewal'],
    };
  }

  if (/^certificate not trusted/.test(error)) {
    return {
      rule: 'watch-certificate-untrusted',
      fault_domain: 'service',
      title: `${c.name}: certificate not trusted`,
      summary: `The TLS handshake failed verification: ${error.replace(/^certificate not trusted:\s*/, '')}.`,
      probable_cause: 'A self-signed or private-CA certificate, a certificate issued for a different name, an incomplete chain, or an expired certificate.',
      confidence: 'high',
      confidence_reason: 'The verification error comes from the handshake itself; the server is reachable.',
      ...base(ev, hostUp),
      investigation_steps: ['Check the names and the chain of the installed certificate', 'For an internal service with a private CA, pin the certificate instead of turning verification off'],
    };
  }

  const status = error.match(/^unexpected HTTP status (\d{3})/);
  if (status) {
    const code = Number(status[1]);
    const server = code >= 500;
    return {
      rule: 'watch-http-status',
      fault_domain: 'service',
      title: `${c.name}: HTTP ${code}`,
      summary: `The web server is reachable and answered, but with status ${code} instead of the expected ${(c.config.expect_status as { min?: number; max?: number } | undefined)?.min ?? 200}-${(c.config.expect_status as { min?: number; max?: number } | undefined)?.max ?? 299}.`,
      probable_cause: server
        ? 'The application behind the web server failed (5xx): a crashed backend, an overloaded server or a failing dependency.'
        : code >= 400
          ? 'The request was refused or not found (4xx): the path changed, authentication is now required, or access is denied.'
          : 'The server redirects (3xx) and the check does not follow redirects, or a status outside the expected range is now normal.',
      confidence: 'high',
      confidence_reason: 'An HTTP status can only come from a server that accepted the connection and answered.',
      ...base(ev, hostUp),
      investigation_steps: server ? ['Read the web server and application logs around the time of the first failure'] : ['Open the URL from the evidence and compare it with what the check expects'],
    };
  }

  if (/^the response body/.test(error)) {
    return {
      rule: 'watch-http-content',
      fault_domain: 'service',
      title: `${c.name}: unexpected page content`,
      summary: `The server answered with an accepted status, but ${error.replace(/^the /, 'the ')}.`,
      probable_cause: 'The page changed: an error page served with a success status, a maintenance page, or a login page.',
      confidence: 'medium',
      confidence_reason: 'The status was accepted; only the content assertion failed (the first 256 KiB of the body were read).',
      ...base(ev, hostUp),
      investigation_steps: ['Open the URL and look for the expected text', 'Adjust the assertion if the page was redesigned on purpose'],
    };
  }

  if (c.kind === 'snmp_oid') {
    if (!c.last_error && c.last_value !== null && (c.state === 'down' || c.state === 'degraded')) {
      return {
        rule: 'watch-snmp-threshold',
        fault_domain: 'service',
        title: `${c.name}: ${c.state === 'down' ? 'critical' : 'warning'} threshold crossed`,
        summary: `The device reports ${fmtNum(c.last_value)}${str(c.config.unit) ? ` ${str(c.config.unit)}` : ''} for ${str(c.config.oid) ?? 'the OID'}, beyond the ${c.state === 'down' ? 'critical' : 'warning'} threshold set for this check.`,
        probable_cause:
          c.config.preset === 'link_status'
            ? 'The interface is not up: cable unplugged, the far end is off, or the port was shut down.'
            : c.config.preset === 'temperature'
              ? 'The device runs hot: blocked airflow, a failed fan or a hot room.'
              : 'The measured resource is under pressure on the device.',
        confidence: 'high',
        confidence_reason: 'The value was read from the device itself over SNMP.',
        ...base(ev, []),
        investigation_steps: c.config.preset === 'link_status' ? ['Check the cable and the device on the other end of this interface (Port Detective shows the port)'] : ['Look at the device’s own status page for the same metric', 'Compare with the chart of this check to see when it started'],
      };
    }
    if (/does not implement OID/.test(error)) {
      return {
        rule: 'watch-snmp-oid-missing',
        fault_domain: 'service',
        title: `${c.name}: the device does not have this OID`,
        summary: `The device answers SNMP but has no value at ${str(c.config.oid) ?? 'the configured OID'}.`,
        probable_cause: 'The vendor does not implement this MIB object, or the index (processor, storage, sensor or interface number) differs on this device.',
        confidence: 'high',
        confidence_reason: 'The device answered the request and reported the object as missing.',
        ...base(ev, []),
        investigation_steps: ['Walk the table of this MIB on the device to find the right index', 'See the vendor notes of the preset in the check form'],
      };
    }
    if (/no answer|rejected the SNMPv3|credentials have not been received|SNMP request failed/.test(error)) {
      return {
        rule: 'watch-snmp-unreadable',
        fault_domain: 'service',
        title: `${c.name}: the device does not answer SNMP`,
        summary: `Reading ${c.target} over SNMP failed: ${error}.`,
        probable_cause: 'Wrong or changed SNMP credentials, SNMP disabled on the device, an access list that does not include the collector, or the device is down.',
        confidence: 'medium',
        confidence_reason: 'SNMP gives no reason for silence; the device itself may still be up.',
        ...base(ev, hostUp),
        investigation_steps: ['Check that Port Detective can read the same device', 'Check the SNMP settings and access list on the device'],
      };
    }
  }
  return null;
}
