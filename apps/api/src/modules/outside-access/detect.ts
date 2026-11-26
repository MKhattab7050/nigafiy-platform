import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Finds Tailscale and cloudflared on THIS computer (the one running the API, which on an installed
 * copy is the user's PC) and reads their state. Nothing is downloaded or installed: when a tool is
 * missing the app links to its official download page and the user installs it.
 *
 * Every command runs with a fixed argument list (no shell) and a short timeout.
 */

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CliRunner = (file: string, args: readonly string[], timeoutMs: number) => Promise<CliResult>;

const realRunner: CliRunner = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(file, [...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? Number((err as { code: number }).code) : -1) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? (err ? err.message : '')) });
    });
  });

let runner: CliRunner = realRunner;
/** Tests replace the command runner; `null` puts the real one back. */
export function setCliRunner(r: CliRunner | null): void {
  runner = r ?? realRunner;
}

/** Where the official Windows installers put the tools; otherwise the bare name is looked up on PATH. */
function candidates(tool: 'tailscale' | 'cloudflared'): string[] {
  if (process.platform !== 'win32') return [tool];
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const known =
    tool === 'tailscale'
      ? [path.join(pf, 'Tailscale', 'tailscale.exe')]
      : [path.join(pf86, 'cloudflared', 'cloudflared.exe'), path.join(pf, 'cloudflared', 'cloudflared.exe')];
  return [...known.filter((p) => existsSync(p)), `${tool}.exe`];
}

async function run(tool: 'tailscale' | 'cloudflared', args: readonly string[], timeoutMs = 5000): Promise<CliResult | null> {
  for (const file of runner === realRunner ? candidates(tool) : [tool]) {
    const r = await runner(file, args, timeoutMs);
    // -1 with no output: the program was not found (ENOENT) or could not start; try the next place.
    if (r.code === -1 && !r.stdout) continue;
    return r;
  }
  return null;
}

export interface TailscaleState {
  installed: boolean;
  version: string | null;
  /** Tailscale's BackendState: Running, NeedsLogin, Stopped, NeedsMachineAuth, Starting… */
  state: string | null;
  /** This PC's MagicDNS name without the trailing dot, e.g. office-pc.tail1234.ts.net. */
  dns_name: string | null;
  ips: string[];
  /** The https origin Tailscale Serve gives this PC, when it has a MagicDNS name. */
  origin: string | null;
  /** Tailscale Serve already forwards https://<dns_name> to the web app's local port. */
  serving: boolean;
  /** Where Serve's "/" goes now, when it is set (maybe something else than this app). */
  serve_target: string | null;
}

const TS_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.ts\.net$/;

export function parseTailscaleStatus(json: string): Pick<TailscaleState, 'state' | 'dns_name' | 'ips' | 'origin'> {
  try {
    const s = JSON.parse(json) as { BackendState?: string; Self?: { DNSName?: string; TailscaleIPs?: string[] } };
    const name = (s.Self?.DNSName ?? '').toLowerCase().replace(/\.$/, '');
    const dns = TS_NAME.test(name) ? name : null;
    return {
      state: typeof s.BackendState === 'string' ? s.BackendState : null,
      dns_name: dns,
      ips: Array.isArray(s.Self?.TailscaleIPs) ? s.Self.TailscaleIPs.filter((x) => typeof x === 'string').slice(0, 4) : [],
      origin: dns ? `https://${dns}` : null,
    };
  } catch {
    return { state: null, dns_name: null, ips: [], origin: null };
  }
}

/** `tailscale serve status --json`: {Web: {"<name>:443": {Handlers: {"/": {Proxy: "http://127.0.0.1:47130"}}}}}. */
export function parseServeStatus(json: string, dnsName: string | null, webPort: number): { serving: boolean; serve_target: string | null } {
  if (!dnsName) return { serving: false, serve_target: null };
  try {
    const s = JSON.parse(json) as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> };
    const web = s.Web?.[`${dnsName}:443`];
    const target = web?.Handlers?.['/']?.Proxy ?? null;
    if (!target) return { serving: false, serve_target: null };
    let ok = false;
    try {
      const u = new URL(/^https?:\/\//.test(target) ? target : `http://${target}`);
      ok = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && Number(u.port || 80) === webPort;
    } catch {
      ok = /^\d+$/.test(target) && Number(target) === webPort;
    }
    return { serving: ok, serve_target: target };
  } catch {
    return { serving: false, serve_target: null };
  }
}

export async function tailscaleState(webPort: number): Promise<TailscaleState> {
  const empty: TailscaleState = { installed: false, version: null, state: null, dns_name: null, ips: [], origin: null, serving: false, serve_target: null };
  const ver = await run('tailscale', ['version']);
  if (!ver) return empty;
  const version = ver.stdout.split(/\r?\n/)[0]?.trim().slice(0, 40) || null;
  const status = await run('tailscale', ['status', '--json']);
  const parsed = status?.stdout ? parseTailscaleStatus(status.stdout) : { state: null, dns_name: null, ips: [], origin: null };
  let serve = { serving: false, serve_target: null as string | null };
  if (parsed.dns_name && parsed.state === 'Running') {
    const st = await run('tailscale', ['serve', 'status', '--json']);
    if (st?.code === 0) serve = parseServeStatus(st.stdout || '{}', parsed.dns_name, webPort);
  }
  return { installed: true, version, ...parsed, ...serve };
}

export interface CloudflaredState {
  installed: boolean;
  version: string | null;
}

export async function cloudflaredState(): Promise<CloudflaredState> {
  const r = await run('cloudflared', ['--version']);
  if (!r) return { installed: false, version: null };
  const m = /(\d{4}\.\d+\.\d+|\d+\.\d+\.\d+)/.exec(`${r.stdout} ${r.stderr}`);
  return { installed: true, version: m?.[1] ?? null };
}

/** The Tailscale Serve command that publishes the web app to the owner's tailnet only (not Funnel: never the internet). */
export function serveArgs(webPort: number): string[] {
  return ['serve', '--bg', '--https=443', `http://127.0.0.1:${webPort}`];
}
export const serveOffArgs = ['serve', '--https=443', 'off'];

/** Runs Tailscale Serve on or off; returns the CLI's output so the page can show why it failed. */
export async function tailscaleServe(on: boolean, webPort: number): Promise<{ ok: boolean; output: string }> {
  const r = await run('tailscale', on ? serveArgs(webPort) : serveOffArgs, 20_000);
  if (!r) return { ok: false, output: 'tailscale was not found on this computer' };
  return { ok: r.code === 0, output: `${r.stdout}\n${r.stderr}`.trim().slice(0, 1500) };
}
