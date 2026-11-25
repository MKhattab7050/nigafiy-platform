#!/usr/bin/env node
// Drives Fleet's real API the way the web does (session cookie, CSRF header, MFA step-up) for the
// emulator real run (docs/features/android.md §11). Talks to 127.0.0.1 only.
//   node scripts/android-emu/fleet.mjs setup [--platform android|windows] [--name Emu-Phone]
//        registers a throw-away account, turns on MFA, creates an endpoint and prints its enrollment
//   node scripts/android-emu/fleet.mjs show                      the endpoint as the web sees it
//   node scripts/android-emu/fleet.mjs act '{"action":"lock"}'   an Android action (step-up added when needed)
//   node scripts/android-emu/fleet.mjs upload <file.apk> <name>  uploads an APK to Fleet, prints its id
//   node scripts/android-emu/fleet.mjs get <path>                any GET under /api/v1 (JSON)
//   node scripts/android-emu/fleet.mjs post <path> '<json>'      any POST under /api/v1 ({ep} = the endpoint id)
// State (cookie, TOTP secret of the throw-away account, endpoint id) is kept in --state
// (default <tmp>/nigafiy-emu-fleet.json). The account exists only in the throw-away database.
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : def;
};
const API = `http://127.0.0.1:${opt('--api', '3271')}`;
const stateFile = opt('--state', path.join(os.tmpdir(), 'nigafiy-emu-fleet.json'));
const platform = opt('--platform', 'android');
const name = opt('--name', platform === 'android' ? 'Emu-Phone' : 'Emu-PC');
const [cmd, ...rest] = args;
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2));

async function call(method, p, body, headers = {}) {
  const h = { 'X-LD-CSRF': '1', ...headers };
  if (state.cookie) h.Cookie = state.cookie;
  let payload;
  if (Buffer.isBuffer(body)) payload = body;
  else if (body !== undefined) {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${API}/api/v1${p}`, { method, headers: h, body: payload });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) state.cookie = set.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, body: json };
}

function base32Decode(s) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) bits += alpha.indexOf(c).toString(2).padStart(5, '0');
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function totp(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = mac[mac.length - 1] & 0xf;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
/** A code is accepted once: wait for a 30 s step that was not used yet. */
async function freshCode() {
  let step = Math.floor(Date.now() / 30_000);
  while (state.lastStep !== undefined && step <= state.lastStep) {
    await new Promise((r) => setTimeout(r, 1000));
    step = Math.floor(Date.now() / 30_000);
  }
  state.lastStep = step;
  save();
  return totp(state.secret, step);
}

const need = (r, what, ok = [200, 201, 202]) => {
  if (!ok.includes(r.status)) throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 500)}`);
  return r.body;
};

if (cmd === 'setup') {
  for (const k of Object.keys(state)) delete state[k];
  const email = `emu-${randomUUID().slice(0, 8)}@example.test`;
  need(await call('POST', '/auth/register', { email, password: `emu ${randomUUID()}`, display_name: 'Emulator run', organization_name: 'Emulator run', site_name: 'HQ' }), 'register');
  state.email = email;
  const sites = need(await call('GET', '/sites'), 'sites');
  state.siteId = sites.items[0].id;
  const setup = need(await call('POST', '/auth/mfa/setup', {}), 'mfa setup');
  state.secret = setup.secret;
  save();
  need(await call('POST', '/auth/mfa/confirm', { code: await freshCode() }), 'mfa confirm');
  const ep = need(await call('POST', '/endpoints', { site_id: state.siteId, name, platform }), 'endpoint');
  state.endpointId = ep.endpoint.id;
  save();
  console.log(JSON.stringify({ email, endpoint_id: ep.endpoint.id, enrollment_token: ep.enrollment_token }, null, 2));
  if (platform === 'android') {
    // The phone reaches the API through `adb reverse tcp:<port> tcp:<port>` at its own 127.0.0.1.
    console.log(`nigafiy://enroll?server=${encodeURIComponent(API)}&token=${encodeURIComponent(ep.enrollment_token)}`);
  }
} else if (cmd === 'show') {
  const d = need(await call('GET', `/endpoints/${state.endpointId}`), 'endpoint');
  console.log(JSON.stringify(d, null, 2));
} else if (cmd === 'get') {
  console.log(JSON.stringify(need(await call('GET', rest[0]), rest[0]), null, 2));
} else if (cmd === 'post') {
  // Any POST under /api/v1; "{ep}" in the path is the endpoint id.
  const r = await call('POST', rest[0].replace('{ep}', state.endpointId), JSON.parse(rest[1] ?? '{}'));
  console.log(r.status, JSON.stringify(r.body, null, 2));
} else if (cmd === 'act') {
  const body = JSON.parse(rest[0]);
  if (['wipe', 'release'].includes(body.action) && !body.step_up_token) {
    const su = need(await call('POST', '/fleet/step-up', { code: await freshCode() }), 'step-up');
    body.step_up_token = su.step_up_token;
  }
  const r = await call('POST', `/endpoints/${state.endpointId}/android/actions`, body);
  console.log(r.status, JSON.stringify(r.body, null, 2));
} else if (cmd === 'upload') {
  const [file, label] = rest;
  const q = new URLSearchParams({ name: label ?? 'Emulator test app', file_name: path.basename(file) });
  const r = await call('POST', `/fleet/android/apks?${q}`, readFileSync(file), { 'Content-Type': 'application/vnd.android.package-archive' });
  console.log(r.status, JSON.stringify(r.body, null, 2));
} else {
  console.error('usage: fleet.mjs setup|show|get|act|upload (see the header)');
  process.exit(2);
}
save();
