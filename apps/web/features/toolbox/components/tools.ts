import type { ToolKind, ToolRun } from '@lan-detective/shared-types';
import type { Tone } from '@/components/ui';

export const TOOLS: ToolKind[] = ['ping', 'tcp', 'ports', 'dns', 'rdns', 'traceroute'];
export const COMMON_PORTS: { port: number; label: string }[] = [
  { port: 22, label: '22 SSH' },
  { port: 53, label: '53 DNS' },
  { port: 80, label: '80 HTTP' },
  { port: 443, label: '443 HTTPS' },
  { port: 445, label: '445 SMB' },
  { port: 3389, label: '3389 RDP' },
  { port: 8080, label: '8080 Alt-HTTP' },
];

export function runTone(run: ToolRun): Tone {
  if (run.status === 'pending') return 'info';
  if (run.status === 'failed' || run.status === 'expired') return 'crit';
  const out = run.output ?? {};
  if (run.tool === 'ping') return out.replied === true ? 'ok' : 'crit';
  if (run.tool === 'tcp') return out.open === true ? 'ok' : 'crit';
  if (run.tool === 'ports') return 'ok';
  if (run.tool === 'dns' || run.tool === 'rdns') return out.found === true ? 'ok' : 'warn';
  if (run.tool === 'traceroute') return out.reached === true ? 'ok' : 'warn';
  return 'ok';
}
