import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { normalizeMac } from '../../common/net.ts';

/**
 * This computer's own network adapters on the home network: one per MAC, with its IPv4 address and
 * whether it is connected now (owner, 2026-11-28: "the Ethernet and Wi-Fi IP thing must be sorted on
 * the PC and the phone").
 *
 * The server PC moves between its cable (Ethernet, .147) and Wi-Fi (.138). An adapter that is
 * unplugged has no address in os.networkInterfaces(), but Windows keeps its last DHCP lease in the
 * registry (Tcpip\Parameters\Interfaces\{guid}\DhcpIPAddress). So the address the cable will get back
 * is known while it is unplugged: the router can reserve it, and phones and agents get it in their
 * list before the cable is plugged in again.
 *
 * Connected adapters come from os.networkInterfaces() (always, fast). On Windows one PowerShell read,
 * at most every CACHE_MS and in the background, adds the unplugged ones. Skipped: loopback,
 * link-local, Tailscale / carrier NAT (100.64.0.0/10), adapters without a real MAC.
 */

export interface OwnAdapter {
  mac: string;
  ip: string;
  connected: boolean;
}

const CACHE_MS = 5 * 60_000;

/** An IPv4 an adapter can have on a home network (not loopback, link-local or Tailscale). */
export function usableIpv4(ip: string | null | undefined): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip ?? ''));
  if (!m) return false;
  const [a = -1, b = -1, c = -1, d = -1] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  if (a === 0 || a === 127 || a >= 224) return false;
  if (a === 169 && b === 254) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  return true;
}

function realMac(mac: string | null | undefined): string | null {
  const m = normalizeMac(String(mac ?? '').replace(/-/g, ':'));
  return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(m) && m !== '00:00:00:00:00:00' ? m : null;
}

/** Connected adapters, as Node sees them now. */
export function connectedAdapters(ifaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces()): OwnAdapter[] {
  const out: OwnAdapter[] = [];
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || !usableIpv4(a.address)) continue;
      const mac = realMac(a.mac);
      if (!mac || out.some((x) => x.mac === mac)) continue;
      out.push({ mac, ip: a.address, connected: true });
    }
  }
  return out;
}

/** One row of the Windows read below. */
export interface WindowsAdapterRow {
  mac?: string | null;
  up?: boolean | null;
  dhcp?: number | null;
  dhcpIp?: string | null;
  staticIp?: string | null;
}

/**
 * The Windows rows → adapters that are NOT connected now, each with the address it last had (its
 * DHCP lease, or its first fixed address). Connected ones come from Node instead.
 */
export function unpluggedFromWindows(rows: WindowsAdapterRow[]): OwnAdapter[] {
  const out: OwnAdapter[] = [];
  for (const r of rows) {
    if (r.up) continue;
    const mac = realMac(r.mac);
    const ip = (r.dhcp === 1 ? r.dhcpIp : r.staticIp)?.trim();
    if (!mac || !usableIpv4(ip) || out.some((x) => x.mac === mac)) continue;
    out.push({ mac, ip: ip!, connected: false });
  }
  return out;
}

/** Connected first (in Node's order), then the unplugged ones that are not also connected. */
export function mergeAdapters(connected: OwnAdapter[], unplugged: OwnAdapter[]): OwnAdapter[] {
  return [...connected, ...unplugged.filter((u) => !connected.some((c) => c.mac === u.mac))];
}

// Physical adapters only (no Tailscale, Hyper-V or VPN adapters). Fixed text, no input from outside.
const PS_SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue"',
  '$rows = @(Get-NetAdapter -Physical | ForEach-Object {',
  '  $r = Get-ItemProperty ("HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\" + $_.InterfaceGuid)',
  '  [pscustomobject]@{ mac = $_.MacAddress; up = ($_.Status -eq "Up"); dhcp = [int]$r.EnableDHCP; dhcpIp = [string]$r.DhcpIPAddress; staticIp = [string](@($r.IPAddress)[0]) }',
  '})',
  'ConvertTo-Json -InputObject $rows -Compress',
].join('\n');

function readWindowsRows(): Promise<WindowsAdapterRow[]> {
  const ps = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve) => {
    execFile(ps, ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT], { timeout: 20_000, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) return resolve([]);
      try {
        const v = JSON.parse(String(stdout).trim() || '[]');
        resolve(Array.isArray(v) ? v : [v]);
      } catch {
        resolve([]);
      }
    });
  });
}

let unpluggedCache: { at: number; value: OwnAdapter[] } | null = null;
let unpluggedRead: Promise<OwnAdapter[]> | null = null;

async function readUnplugged(): Promise<OwnAdapter[]> {
  if (process.platform !== 'win32') return [];
  return unpluggedFromWindows(await readWindowsRows());
}

type Source = (opts: { wait?: boolean }) => Promise<OwnAdapter[]>;

const realSource: Source = async ({ wait }) => {
  const now = Date.now();
  if (!unpluggedCache || now - unpluggedCache.at >= CACHE_MS) {
    if (!unpluggedRead) {
      unpluggedRead = readUnplugged()
        .then((value) => {
          unpluggedCache = { at: Date.now(), value };
          return value;
        })
        .finally(() => {
          unpluggedRead = null;
        });
    }
    if (wait || !unpluggedCache) await unpluggedRead.catch(() => []);
  }
  return mergeAdapters(connectedAdapters(), unpluggedCache?.value ?? []);
};

// Under the test runner the machine's real adapters are left out: a test LAN could match them.
let source: Source = process.env.VITEST ? async () => [] : realSource;

/** Tests: where this computer's adapters come from (null: none under the test runner, else the real ones). */
export function setOwnAdaptersSource(fn: (() => OwnAdapter[] | Promise<OwnAdapter[]>) | null): void {
  source = fn ? async () => fn() : process.env.VITEST ? async () => [] : realSource;
  unpluggedCache = null;
}

/** This computer's adapters on its home network, connected ones first. */
export function ownAdapters(opts: { wait?: boolean } = {}): Promise<OwnAdapter[]> {
  return source(opts);
}
