import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channelEnv, isPublicKey, parseChannel, resolveReleaseChannel } from './update-channel.mjs';

const KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER = Buffer.alloc(32, 9).toString('base64');
const URL_ = 'https://updates.invalid/nigafiy/manifest.json';

test('a release without a channel stops unless it says --no-updates', () => {
  const r = resolveReleaseChannel({});
  assert.equal(r.ok, false);
  assert.match(r.error, /--no-updates/);
  assert.deepEqual(resolveReleaseChannel({ noUpdates: true }), { ok: true, channel: { schema: 1, off: true } });
  assert.equal(resolveReleaseChannel({ noUpdates: true, url: URL_ }).ok, false);
});

test('command-line values win over the config file; both halves are required and checked', () => {
  const fromConfig = resolveReleaseChannel({ config: { manifest_url: URL_, public_key: KEY } });
  assert.deepEqual(fromConfig, { ok: true, channel: { schema: 1, manifest_url: URL_, public_key: KEY } });
  const override = resolveReleaseChannel({ url: 'https://other.invalid/m.json', config: { manifest_url: URL_, public_key: KEY } });
  assert.equal(override.ok && override.channel.manifest_url, 'https://other.invalid/m.json');
  assert.equal(resolveReleaseChannel({ url: URL_ }).ok, false);
  assert.equal(resolveReleaseChannel({ publicKey: KEY }).ok, false);
  assert.equal(resolveReleaseChannel({ url: 'http://plain.invalid/m.json', publicKey: KEY }).ok, false);
  assert.equal(resolveReleaseChannel({ url: 'https://u:p@x.invalid/m.json', publicKey: KEY }).ok, false);
  assert.equal(resolveReleaseChannel({ url: URL_, publicKey: 'short' }).ok, false);
});

test('the signing key of the release must be the key installs will trust', () => {
  assert.equal(resolveReleaseChannel({ url: URL_, publicKey: KEY, signingPublicKey: OTHER }).ok, false);
  assert.equal(resolveReleaseChannel({ url: URL_, publicKey: KEY, signingPublicKey: KEY }).ok, true);
});

test('parseChannel accepts only a complete, valid channel', () => {
  assert.deepEqual(parseChannel(JSON.stringify({ schema: 1, manifest_url: URL_, public_key: KEY })), { manifestUrl: URL_, publicKey: KEY });
  assert.equal(parseChannel(JSON.stringify({ schema: 1, off: true })), null);
  assert.equal(parseChannel('not json'), null);
  assert.equal(parseChannel(undefined), null);
  assert.equal(parseChannel(JSON.stringify({ schema: 2, manifest_url: URL_, public_key: KEY })), null);
  assert.equal(isPublicKey(Buffer.alloc(31).toString('base64')), false);
});

test("the data folder's .env wins over the built-in channel, an empty value included", () => {
  const ch = { manifestUrl: URL_, publicKey: KEY };
  assert.deepEqual(channelEnv(ch, {}), { NIGAFIY_UPDATE_MANIFEST_URL: URL_, NIGAFIY_UPDATE_PUBLIC_KEY: KEY });
  assert.deepEqual(channelEnv(ch, { NIGAFIY_UPDATE_MANIFEST_URL: '' }), {});
  assert.deepEqual(channelEnv(ch, { NIGAFIY_UPDATE_PUBLIC_KEY: OTHER }), { NIGAFIY_UPDATE_MANIFEST_URL: URL_ });
  assert.deepEqual(channelEnv(null, {}), {});
});
