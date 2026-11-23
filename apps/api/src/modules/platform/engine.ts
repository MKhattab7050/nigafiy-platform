import type { EngineChild, EngineChildState, PlatformEngineResponse } from '@nigafiy/shared-types/programs';
import { env } from '../../config/env.ts';

const STATES: readonly EngineChildState[] = ['stopped', 'starting', 'running', 'backoff', 'failed'];
// Windows takes about 2 s to report a refused connection to a closed loopback port.
const TIMEOUT_MS = 3500;

/**
 * Read-only view of the local engine (nigafiy-engine `GET /v1/status`). Only fields known to carry
 * no secrets are passed on; the data directory path and the stack URLs are left out on purpose.
 */
export async function engineStatus(controlUrl: string = env.ENGINE_CONTROL_URL): Promise<PlatformEngineResponse> {
  if (controlUrl === 'off') return { reachable: false, reason: 'not_running' };
  let res: Response;
  try {
    res = await fetch(`${controlUrl}/v1/status`, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
  } catch (err) {
    const cause = (err as { cause?: { code?: string; errors?: Array<{ code?: string }> } }).cause;
    const code = cause?.code ?? cause?.errors?.[0]?.code;
    return { reachable: false, reason: code === 'ECONNREFUSED' ? 'not_running' : 'unreachable' };
  }
  if (!res.ok) return { reachable: false, reason: 'bad_response' };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { reachable: false, reason: 'bad_response' };
  }
  return parseStatus(body) ?? { reachable: false, reason: 'bad_response' };
}

const str = (v: unknown, max = 500): string | null => (typeof v === 'string' ? v.slice(0, max) : null);

function parseStatus(body: unknown): PlatformEngineResponse | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const version = str(b.version, 64);
  const startedAt = str(b.started_at, 64);
  const mode = b.mode === 'service' || b.mode === 'foreground' ? b.mode : null;
  if (!version || !startedAt || !mode || !Array.isArray(b.children)) return null;
  const children: EngineChild[] = [];
  for (const raw of b.children.slice(0, 16)) {
    if (!raw || typeof raw !== 'object') return null;
    const c = raw as Record<string, unknown>;
    const name = str(c.name, 32);
    const state = STATES.find((s) => s === c.state);
    if (!name || !state) return null;
    children.push({
      name,
      state,
      pid: typeof c.pid === 'number' && Number.isInteger(c.pid) && c.pid > 0 ? c.pid : null,
      restarts: typeof c.restarts === 'number' && Number.isInteger(c.restarts) && c.restarts >= 0 ? c.restarts : 0,
      last_error: str(c.last_error),
      started_at: str(c.started_at, 64),
      health: c.health === 'ok' || c.health === 'failing' ? c.health : null,
      health_error: str(c.health_error),
      waiting_for: str(c.waiting_for, 32),
    });
  }
  return { reachable: true, version, mode, started_at: startedAt, children };
}
