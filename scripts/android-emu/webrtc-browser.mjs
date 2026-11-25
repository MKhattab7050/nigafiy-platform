#!/usr/bin/env node
// WebRTC remote desktop in a real browser on this PC (docs/features/webrtc-networking.md).
// Opens Fleet's endpoint page for a Windows endpoint enrolled with the real agent, starts a remote
// desktop session through the web UI, and reports what the browser measured:
//   - the transport the console shows (WebRTC video or Compatibility mode), and the fallback reason;
//   - getStats(): inbound-rtp video framesDecoded / frameWidth / frameHeight / codec, and the ICE
//     candidate pair in use (candidate types, protocol, addresses);
//   - input: moves the pointer over the picture and reads where Windows put the cursor.
// Loopback only (127.0.0.1). Signed in with the session that fleet.mjs keeps in its state file; the
// endpoint must be in an unattended Fleet group (no consent dialog to answer on this screen).
//   node scripts/android-emu/webrtc-browser.mjs --endpoint <id> [--state f] [--web 3272]
//        [--channel chromium|msedge|chrome] [--out dir] [--expect webrtc|jpeg] [--steps n] [--no-input]
// The pointer test moves the real mouse of this PC (to two points of display 0); nothing is clicked
// or typed.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const stateFile = opt('--state', path.join(os.tmpdir(), 'nigafiy-emu-fleet.json'));
const web = `http://127.0.0.1:${opt('--web', '3272')}`;
const channel = opt('--channel', 'chromium');
const outDir = opt('--out', path.join(os.tmpdir(), 'nigafiy-webrtc-run'));
const expectMode = opt('--expect', 'webrtc');
const state = JSON.parse(readFileSync(stateFile, 'utf8'));
const endpointId = opt('--endpoint', state.endpointId);
mkdirSync(outDir, { recursive: true });

const require = createRequire(path.resolve(import.meta.dirname, '..', '..', 'apps', 'web', 'package.json'));
const { chromium } = require('@playwright/test');

/** Where Windows has the cursor now (GetCursorPos through PowerShell; reads only). */
function cursor() {
  const ps =
    'Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; "$($p.X),$($p.Y),$($b.Width),$($b.Height)"';
  const [x, y, w, h] = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim().split(',').map(Number);
  return { x, y, w, h };
}

const browser = await chromium.launch({ ...(channel === 'chromium' ? {} : { channel }), headless: true });
const version = browser.version();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1900 } });
await ctx.addCookies(
  state.cookie.split('; ').map((c) => {
    const i = c.indexOf('=');
    return { name: c.slice(0, i), value: c.slice(i + 1), url: web };
  }),
);
// Test instrumentation only: keep a reference to every RTCPeerConnection the page creates so
// getStats() can be read from outside. The page's own code is unchanged.
await ctx.addInitScript(() => {
  const Orig = window.RTCPeerConnection;
  if (!Orig) return;
  window.__pcs = [];
  window.RTCPeerConnection = function (...a) {
    const pc = new Orig(...a);
    window.__pcs.push(pc);
    return pc;
  };
  window.RTCPeerConnection.prototype = Orig.prototype;
  Object.setPrototypeOf(window.RTCPeerConnection, Orig);
});
const page = await ctx.newPage();
const result = { browser: `${channel} ${version}`, expect: expectMode };
try {
  result.h264InBrowser = await page.evaluate(() => (RTCRtpReceiver.getCapabilities?.('video')?.codecs ?? []).some((c) => c.mimeType.toLowerCase() === 'video/h264'));
  await page.goto(`${web}/fleet/endpoints/${endpointId}?tab=desktop`, { waitUntil: 'networkidle', timeout: 180_000 });
  result.h264InBrowser = await page.evaluate(() => (RTCRtpReceiver.getCapabilities?.('video')?.codecs ?? []).some((c) => c.mimeType.toLowerCase() === 'video/h264'));
  await page.getByRole('button', { name: 'Start session' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder('e.g. Ticket 1042: printer setup').fill('WebRTC real run on 127.0.0.1');
  await dialog.getByRole('button', { name: 'Request session' }).click();
  const shown = await Promise.race([
    page.getByText('WebRTC video', { exact: true }).first().waitFor({ timeout: 60_000 }).then(() => 'webrtc'),
    page.getByText('Compatibility mode (JPEG)', { exact: true }).first().waitFor({ timeout: 60_000 }).then(() => 'jpeg'),
  ]).catch(() => 'none');
  // Let the stream settle (and a JPEG fallback reason appear, if any).
  await page.waitForTimeout(6000);
  result.consoleShows = (await page.getByText('WebRTC video', { exact: true }).count()) ? 'webrtc' : (await page.getByText('Compatibility mode (JPEG)', { exact: true }).count()) ? 'jpeg' : shown;
  result.stats = await page.evaluate(async () => {
    const out = [];
    for (const pc of window.__pcs ?? []) {
      const r = { connectionState: pc.connectionState, iceConnectionState: pc.iceConnectionState };
      const rep = await pc.getStats();
      const byId = new Map();
      for (const s of rep.values()) byId.set(s.id, s);
      rep.forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'video') {
          r.video = { framesDecoded: s.framesDecoded, framesReceived: s.framesReceived, frameWidth: s.frameWidth, frameHeight: s.frameHeight, framesPerSecond: s.framesPerSecond, bytesReceived: s.bytesReceived, packetsLost: s.packetsLost, keyFramesDecoded: s.keyFramesDecoded, decoderImplementation: s.decoderImplementation, codec: byId.get(s.codecId)?.mimeType };
        }
        if (s.type === 'candidate-pair' && (s.nominated || s.selected) && s.state === 'succeeded') {
          const l = byId.get(s.localCandidateId);
          const rc = byId.get(s.remoteCandidateId);
          r.pair = { local: `${l?.candidateType} ${l?.protocol} ${l?.address}:${l?.port}`, remote: `${rc?.candidateType} ${rc?.protocol} ${rc?.address}:${rc?.port}`, rttMs: s.currentRoundTripTime != null ? Math.round(s.currentRoundTripTime * 1000) : null };
        }
        if (s.type === 'data-channel') r.dataChannel = { label: s.label, state: s.state, messagesSent: s.messagesSent };
      });
      out.push(r);
    }
    return out;
  });
  // A second sample: frames keep coming.
  await page.waitForTimeout(3000);
  result.framesDecodedLater = await page.evaluate(async () => {
    let n = null;
    for (const pc of window.__pcs ?? []) for (const s of (await pc.getStats()).values()) if (s.type === 'inbound-rtp' && s.kind === 'video') n = s.framesDecoded;
    return n;
  });
  // Is something drawn on the console canvas (not a blank picture)?
  result.canvas = await page.evaluate(() => {
    const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    if (!c || !c.width) return null;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4 * 97) if (d[i] + d[i + 1] + d[i + 2] > 30) lit++;
    return { width: c.width, height: c.height, nonDarkSamples: lit };
  });
  await page.screenshot({ path: path.join(outDir, `console-${result.consoleShows}-${channel}.png`) });

  // Input: hover two points of the picture; Windows' cursor must land on the matching screen points.
  const canvas = page.locator('canvas[aria-label="Remote Desktop"]').first();
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  if (box && !args.includes('--no-input')) {
    const before = cursor();
    const points = [];
    for (const [fx, fy] of [
      [0.3, 0.4],
      [0.6, 0.55],
    ]) {
      await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy, { steps: Number(opt('--steps', '1')) });
      await page.waitForTimeout(800);
      const c = cursor();
      points.push({ asked: { x: Math.round(c.w * fx), y: Math.round(c.h * fy) }, cursor: { x: c.x, y: c.y } });
    }
    result.input = { before: { x: before.x, y: before.y }, points };
    result.input.dataChannelAfter = await page.evaluate(async () => {
      const out = [];
      for (const pc of window.__pcs ?? []) for (const s of (await pc.getStats()).values()) if (s.type === 'data-channel') out.push({ state: s.state, messagesSent: s.messagesSent, bytesSent: s.bytesSent });
      return out;
    });
  }
  const stop = page.getByRole('button', { name: 'End session' });
  if (await stop.count()) await stop.first().click();
  await page.waitForTimeout(1500);
} catch (e) {
  result.error = String(e?.message ?? e).slice(0, 500);
  await page.screenshot({ path: path.join(outDir, `error-${channel}.png`) }).catch(() => {});
} finally {
  await browser.close();
}
console.log(JSON.stringify(result, null, 2));
const decoded = result.stats?.[0]?.video?.framesDecoded ?? 0;
const ok = expectMode === 'webrtc' ? result.consoleShows === 'webrtc' && decoded > 0 : result.consoleShows === 'jpeg';
process.exit(ok ? 0 : 1);
