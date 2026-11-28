import os from 'node:os';
import { env } from '../../config/env.ts';
import { tailscaleState } from './detect.ts';
import { ownAdapters } from './own-adapters.ts';

/**
 * Other addresses a phone can reach this server at when it is away from home (owner, 2026-11-27:
 * "the phone app should work outside home too, through Tailscale").
 *
 * A phone talks to the HTTPS listener (HTTPS_PORT, bound to every interface by the installed app) at
 * the LAN address it was given when it connected. Away from home that address does not answer, but
 * when this PC and the phone are both on Tailscale, this PC's Tailscale IPv4 (100.64.0.0/10) reaches
 * the same listener and the same certificate, which the phone already pins. The heartbeat hands the
 * phone this list while it is at home; the phone keeps it and tries it when home does not answer.
 *
 * Read from the Tailscale CLI at most once every CACHE_MS; nothing when Tailscale is missing or not
 * running, or when there is no HTTPS listener.
 */
const CACHE_MS = 5 * 60_000;
let cache: { at: number; value: string[] } | null = null;

/** Tests: forget the cached answer. */
export function resetPhoneAddressCache(): void {
  cache = null;
  refreshing = null;
}

/** 100.64.0.0/10, the range Tailscale gives its devices. */
export function isTailscaleIpv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return false;
  const [a = -1, b = -1] = parts;
  return a === 100 && b >= 64 && b <= 127;
}

export function addressesFrom(state: { state: string | null; ips: string[] }, httpsPort: number | undefined): string[] {
  if (!httpsPort || state.state !== 'Running') return [];
  return state.ips.filter(isTailscaleIpv4).map((ip) => `https://${ip}:${httpsPort}`);
}

/** 10/8, 172.16/12, 192.168/16: the home or office network addresses (not link-local, not Tailscale). */
export function isPrivateLanIpv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const [a = -1, b = -1, c = -1, d = -1] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** This PC on its own network: its private IPv4 addresses and its computer name. */
export interface LocalAddresses {
  ips: string[];
  hostname: string;
}

// Connected adapters first, then an unplugged cable at the address it last had (own-adapters.ts): a
// phone at home learns the cable's address while the PC is on Wi-Fi, and the other way round.
async function readLocal(): Promise<LocalAddresses> {
  const ips = (await ownAdapters({ wait: true })).map((a) => a.ip);
  return { ips, hostname: os.hostname() };
}

let localSource: () => LocalAddresses | Promise<LocalAddresses> = readLocal;

/** Tests: where this PC's own addresses come from (null: the real network interfaces). */
export function setLocalAddressSource(fn: (() => LocalAddresses) | null): void {
  localSource = fn ?? readLocal;
  cache = null;
  refreshing = null;
}

/**
 * The home network addresses: each private IPv4 of this PC, then its computer name. When the router
 * gives this PC a new address, an agent that knew the old one still finds it by name (Windows
 * resolves it on the local network) and then learns the new address with its next heartbeat.
 */
export function lanAddressesFrom(local: LocalAddresses, httpsPort: number | undefined): string[] {
  if (!httpsPort) return [];
  const out = [...new Set(local.ips.filter(isPrivateLanIpv4))].map((ip) => `https://${ip}:${httpsPort}`);
  const name = local.hostname.trim();
  if (/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(name)) out.push(`https://${name}:${httpsPort}`);
  return out;
}

let refreshing: Promise<string[]> | null = null;

async function refresh(now: number): Promise<string[]> {
  let value: string[] = [];
  try {
    // The web port only matters for Tailscale Serve, which this does not look at.
    value = addressesFrom(await tailscaleState(0), env.HTTPS_PORT);
  } catch {
    value = [];
  }
  try {
    value = [...value, ...lanAddressesFrom(await localSource(), env.HTTPS_PORT)];
  } catch {
    /* no interfaces readable: Tailscale only */
  }
  cache = { at: now, value };
  return value;
}

/**
 * The addresses to hand a phone. A heartbeat never waits for the Tailscale CLI: when the cached
 * answer is old it is refreshed in the background and the old one is returned; the phone gets the
 * new list with its next heartbeat. `wait` (tests) waits for the refresh.
 *
 * null before the first answer (just after the server started): the heartbeat then leaves
 * server_addresses out, so the phone keeps the list it has. An empty list here made a phone that was
 * away from home forget this PC's Tailscale address and stay cut off (A36, 2026-11-27).
 */
export async function phoneServerAddresses(opts: { now?: number; wait?: boolean } = {}): Promise<string[] | null> {
  const now = opts.now ?? Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.value;
  if (!refreshing) refreshing = refresh(now).finally(() => { refreshing = null; });
  if (opts.wait) return refreshing;
  return cache?.value ?? null;
}
