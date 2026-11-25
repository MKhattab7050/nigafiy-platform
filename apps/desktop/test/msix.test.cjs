'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const msix = require('../scripts/msix.cjs');
const { parseArgs } = require('../scripts/build-msix.cjs');

const ENV = {
  NIGAFIY_STORE_DESKTOP_IDENTITY_NAME: 'Example.Nigafiy',
  NIGAFIY_STORE_QUICK_SUPPORT_IDENTITY_NAME: 'Example.NigafiyQuickSupport',
  NIGAFIY_STORE_PUBLISHER: 'CN=11111111-2222-3333-4444-555555555555',
  NIGAFIY_STORE_PUBLISHER_DISPLAY_NAME: 'Nigafiy',
};

test('a Store build refuses to run without the Partner Center identity', () => {
  assert.throws(() => msix.resolveIdentity({ product: 'desktop', env: {} }), /Store identity not configured.*NIGAFIY_STORE_DESKTOP_IDENTITY_NAME.*NIGAFIY_STORE_PUBLISHER.*--local-test/s);
  assert.throws(() => msix.resolveIdentity({ product: 'desktop', env: { ...ENV, NIGAFIY_STORE_PUBLISHER: 'Nigafiy' } }), /CN=/);
  assert.throws(() => msix.resolveIdentity({ product: 'desktop', env: { ...ENV, NIGAFIY_STORE_DESKTOP_IDENTITY_NAME: 'Nigafiy.LocalTest.Hub' } }), /local test identity/);
  assert.throws(() => msix.resolveIdentity({ product: 'desktop', env: { ...ENV, NIGAFIY_STORE_DESKTOP_IDENTITY_NAME: 'a b' } }), /3–50/);
  assert.throws(() => msix.resolveIdentity({ product: 'nope', env: ENV }), /unknown product/);
});

test('identity from the environment, or from identity.json (the environment wins)', () => {
  assert.deepEqual(msix.resolveIdentity({ product: 'desktop', env: ENV }), { name: 'Example.Nigafiy', publisher: ENV.NIGAFIY_STORE_PUBLISHER, publisherDisplayName: 'Nigafiy', localTest: false });
  const json = { publisher: 'CN=AAAA', publisherDisplayName: 'Nigafiy', desktop: { identityName: 'Json.Nigafiy' }, quickSupport: { identityName: 'Json.QuickSupport' } };
  assert.equal(msix.resolveIdentity({ product: 'quick-support', env: {}, json }).name, 'Json.QuickSupport');
  assert.equal(msix.resolveIdentity({ product: 'desktop', env: { NIGAFIY_STORE_DESKTOP_IDENTITY_NAME: 'Env.Nigafiy' }, json }).name, 'Env.Nigafiy');
});

test('the local test identity says so and uses the test certificate subject', () => {
  const id = msix.resolveIdentity({ product: 'desktop', localTest: { publisher: 'CN=Nigafiy Test I1' } });
  assert.deepEqual(id, { name: 'Nigafiy.LocalTest.Hub', publisher: 'CN=Nigafiy Test I1', publisherDisplayName: 'Nigafiy (local test)', localTest: true });
  assert.throws(() => msix.resolveIdentity({ product: 'desktop', localTest: { publisher: 'Nigafiy' } }), /CN=/);
  assert.equal(msix.outputName({ product: 'desktop', version: '0.1.0', localTest: true }), 'Nigafiy-0.1.0-x64-local-test.msix');
  assert.equal(msix.outputName({ product: 'quick-support', version: '1.2.0', localTest: false }), 'Nigafiy-Quick-Support-1.2.0-x64.msix');
});

test('Store versions: four numbers, the last 0, the first not 0', () => {
  assert.equal(msix.storeVersion('1.2.3'), '1.2.3.0');
  assert.throws(() => msix.storeVersion('0.1.0'), /first number of 0/);
  assert.throws(() => msix.storeVersion('1.2'), /x\.y\.z/);
  assert.throws(() => msix.storeVersion('1.70000.0'), /65535/);
  assert.equal(msix.localTestVersion('0.1.0'), '0.1.0.0');
  assert.equal(msix.localTestVersion('0.1.0-dev'), '0.1.0.0');
});

test('desktop manifest: full trust, nigafiy:// link, sensor firewall rules on private networks only, EN + AR', () => {
  const m = msix.renderManifest({ product: 'desktop', identity: msix.resolveIdentity({ product: 'desktop', env: ENV }), version: '1.2.3.0' });
  assert.match(m, /<Identity Name="Example\.Nigafiy" Publisher="CN=11111111-2222-3333-4444-555555555555" Version="1\.2\.3\.0" ProcessorArchitecture="x64"\/>/);
  assert.match(m, /<PublisherDisplayName>Nigafiy<\/PublisherDisplayName>/);
  assert.match(m, /Executable="app\\Nigafiy\.exe" EntryPoint="Windows\.FullTrustApplication"/);
  assert.match(m, /<rescap:Capability Name="runFullTrust"\/>/);
  assert.match(m, /<uap3:Protocol Name="nigafiy" Parameters="&quot;%1&quot;">/);
  assert.match(m, /<Resource Language="en-US"\/>\s*<Resource Language="ar-SA"\/>/);
  assert.match(m, /FirewallRules Executable="app\\resources\\collector\\nigafiy-sensor\.exe"/);
  const rules = m.match(/<desktop2:Rule [^>]*\/>/g);
  assert.equal(rules.length, 3);
  for (const r of rules) assert.match(r, /Direction="in".*Profile="domainAndPrivate"/);
  // nothing that would need a service, elevation or unvirtualized AppData
  assert.doesNotMatch(m, /packagedServices|localSystemServices|allowElevation|unvirtualizedResources|windows\.service|StartupTask/);
});

test('Quick Support manifest: its own exe and link, no firewall rules', () => {
  const m = msix.renderManifest({ product: 'quick-support', identity: msix.resolveIdentity({ product: 'quick-support', env: ENV }), version: '1.0.0.0' });
  assert.match(m, /Executable="nigafiy-support\.exe"/);
  assert.match(m, /<uap3:Protocol Name="nigafiy-support"/);
  assert.doesNotMatch(m, /firewallRules/);
});

test('XML is escaped and the strings exist in both languages', () => {
  const m = msix.renderManifest({ product: 'desktop', identity: { name: 'A.B', publisher: 'CN=A & "B"', publisherDisplayName: '<N>', localTest: false }, version: '1.0.0.0' });
  assert.match(m, /Publisher="CN=A &amp; &quot;B&quot;"/);
  assert.match(m, /&lt;N&gt;/);
  for (const product of Object.keys(msix.PRODUCTS)) {
    for (const lang of msix.LANGUAGES) {
      const resw = msix.renderResw(product, lang);
      for (const key of ['AppDisplayName', 'AppDescription', 'ProtocolName']) assert.match(resw, new RegExp(`<data name="${key}"`));
    }
  }
  assert.match(msix.renderResw('quick-support', 'ar-SA'), /الدعم السريع/);
});

test('mapping file: quoted source and package paths; refuses a quote in a path', () => {
  const files = msix.appFiles('C:\\b\\win-unpacked', ['Nigafiy.exe', 'resources\\app.asar'], 'app');
  assert.deepEqual(files, [
    { source: 'C:\\b\\win-unpacked\\Nigafiy.exe', target: 'app\\Nigafiy.exe' },
    { source: 'C:\\b\\win-unpacked\\resources\\app.asar', target: 'app\\resources\\app.asar' },
  ]);
  assert.equal(msix.renderMapping({ files }), '[Files]\r\n"C:\\b\\win-unpacked\\Nigafiy.exe" "app\\Nigafiy.exe"\r\n"C:\\b\\win-unpacked\\resources\\app.asar" "app\\resources\\app.asar"\r\n');
  assert.throws(() => msix.renderMapping({ files: [{ source: 'a"b', target: 'x' }] }), /quote/);
});

test('command line', () => {
  assert.equal(parseArgs(['desktop', '--local-test']).localTest, true);
  assert.equal(parseArgs(['quick-support', '--version', '0.1.0']).version, '0.1.0');
  assert.throws(() => parseArgs(['other']), /usage/);
  assert.throws(() => parseArgs(['desktop', '--bogus']), /unknown option/);
  assert.throws(() => parseArgs(['desktop', '--version']), /needs a value/);
});
