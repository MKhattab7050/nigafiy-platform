'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePrograms, selectedIds, parseRegQuery, makeReader, readInstallSettings, writePrograms, NSIS_GUID, MSI_UPGRADE_CODE_PACKED, CHOICES } = require('../src/install-settings.cjs');
const { addProgramsProperty, COMPONENT_GUID } = require('../scripts/msi-programs.cjs');

test('normalizePrograms matches the engine: all, or hub first without repeats', () => {
  assert.equal(normalizePrograms(''), 'all');
  assert.equal(normalizePrograms('ALL'), 'all');
  assert.equal(normalizePrograms('watch, radar,watch'), 'hub,watch,radar');
  assert.equal(normalizePrograms(['hub', 'radar']), 'hub,radar');
  assert.equal(normalizePrograms([]), 'all');
  assert.equal(normalizePrograms(CHOICES.map((c) => c.id)), 'all');
  assert.throws(() => normalizePrograms('radar,evil'), /unknown program/);
  assert.throws(() => normalizePrograms('radar;reg delete'), /unknown program/);
  assert.deepEqual(selectedIds('all'), ['radar', 'watch', 'guard', 'fleet', 'mind', 'toolbox']);
  assert.deepEqual(selectedIds('hub,fleet'), ['fleet']);
});

test('every choice has EN and AR text that says Nigafiy', () => {
  for (const c of CHOICES) {
    assert.match(c.en, /^Nigafiy /);
    assert.match(c.ar, /^Nigafiy /);
    assert.match(c.ar, /[\u0600-\u06ff]/);
  }
});

test('parseRegQuery reads reg.exe output', () => {
  const out = '\r\nHKEY_CURRENT_USER\\Software\\Nigafiy\\Hub\r\n    Programs    REG_SZ    hub,radar\r\n\r\n';
  assert.equal(parseRegQuery(out, 'Programs'), 'hub,radar');
  assert.equal(parseRegQuery(out, 'Other'), null);
});

/** A fake reg.exe over a map of "ROOT\\key" → { name: value }. */
function fakeReg(tree, calls = []) {
  return async (args) => {
    calls.push(args);
    const [verb, key, , name] = args;
    const values = tree[key.toLowerCase()];
    if (verb === 'add') {
      tree[key.toLowerCase()] = { ...(values ?? {}), [args[3]]: args[7] };
      return { code: 0, stdout: '' };
    }
    if (!values) return { code: 1, stdout: '' };
    if (!name || args[2] !== '/v') return { code: 0, stdout: `\r\n${key}\r\n` };
    if (!(name in values)) return { code: 1, stdout: '' };
    return { code: 0, stdout: `\r\n${key}\r\n    ${name}    REG_SZ    ${values[name]}\r\n` };
  };
}

const DIR = 'C:\\Users\\me\\AppData\\Local\\Programs\\Nigafiy';

test('a per-user install reads and writes HKCU', async () => {
  const tree = {
    [`hkcu\\software\\${NSIS_GUID}`]: { InstallLocation: DIR.toUpperCase() + '\\' },
    'hkcu\\software\\nigafiy\\hub': { Programs: 'hub,radar,watch' },
  };
  const s = await readInstallSettings({ installDir: DIR, reader: makeReader(fakeReg(tree)) });
  assert.deepEqual(s, { scope: 'user', programs: 'hub,radar,watch', raw: 'hub,radar,watch', writable: true });
  const calls = [];
  let elevated = 0;
  const r = await writePrograms({ scope: 'user', ids: ['fleet', 'guard'], run: fakeReg(tree, calls), runElevated: async () => (elevated++, { code: 0, stdout: '' }) });
  assert.deepEqual(r, { ok: true, programs: 'hub,fleet,guard' });
  assert.equal(elevated, 0);
  assert.deepEqual(calls[0], ['add', 'HKCU\\Software\\Nigafiy\\Hub', '/v', 'Programs', '/t', 'REG_SZ', '/d', 'hub,fleet,guard', '/f', '/reg:64']);
});

test('a per-machine install writes HKLM only through the elevated (UAC) path, and reports a cancel', async () => {
  const tree = { [`hklm\\software\\${NSIS_GUID}`]: { InstallLocation: DIR } };
  const s = await readInstallSettings({ installDir: DIR, reader: makeReader(fakeReg(tree)) });
  assert.equal(s.scope, 'machine');
  assert.equal(s.programs, 'all');
  let plain = 0;
  const seen = [];
  const ok = await writePrograms({ scope: 'machine', ids: ['radar'], run: async () => (plain++, { code: 0, stdout: '' }), runElevated: async (a) => (seen.push(a), { code: 0, stdout: '' }) });
  assert.deepEqual(ok, { ok: true, programs: 'hub,radar' });
  assert.equal(plain, 0);
  assert.equal(seen[0][1], 'HKLM\\Software\\Nigafiy\\Hub');
  const cancel = await writePrograms({ scope: 'machine', ids: ['radar'], runElevated: async () => ({ code: 1223, stdout: '' }) });
  assert.deepEqual(cancel, { ok: false, error: 'cancelled' });
});

test('an MSI install is read-only, an unknown one too, and a bad id is never written', async () => {
  const tree = { [`hklm\\software\\classes\\installer\\upgradecodes\\${MSI_UPGRADE_CODE_PACKED}`.toLowerCase()]: {}, 'hklm\\software\\nigafiy\\hub': { Programs: 'hub,watch' } };
  const s = await readInstallSettings({ installDir: 'C:\\Program Files\\Nigafiy', reader: makeReader(fakeReg(tree)) });
  assert.deepEqual(s, { scope: 'msi', programs: 'hub,watch', raw: 'hub,watch', writable: false });
  const never = async () => assert.fail('nothing may be written');
  assert.deepEqual(await writePrograms({ scope: 'msi', ids: ['radar'], run: never, runElevated: never }), { ok: false, error: 'msi' });
  assert.deepEqual(await writePrograms({ scope: 'unknown', ids: ['radar'], run: never, runElevated: never }), { ok: false, error: 'unknown install' });
  assert.equal((await writePrograms({ scope: 'user', ids: ['radar', '" /f & calc'], run: never })).ok, false);
  const bad = await readInstallSettings({ installDir: 'D:\\x', reader: makeReader(fakeReg({ 'hkcu\\software\\nigafiy\\hub': { Programs: 'nope' } })) });
  assert.deepEqual(bad, { scope: 'unknown', programs: 'all', raw: 'nope', writable: false });
});

const WXS = `<?xml version="1.0"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="*" UpgradeCode="{6DA7D862-27E7-4AC8-809D-89B4128FB3AE}">
    <Directory Id="TARGETDIR"/>
    <ComponentGroup Id="ProductComponents" Directory="APPLICATIONFOLDER">
      <Component><File Source="Nigafiy.exe"/></Component>
    </ComponentGroup>
  </Product>
</Wix>`;

test('the MSI hook adds the PROGRAMS property and its HKLM component inside the product, once', () => {
  const out = addProgramsProperty(WXS);
  const group = out.slice(out.indexOf('<ComponentGroup'), out.indexOf('</ComponentGroup>'));
  assert.match(group, new RegExp(`<Component Id="NigafiyProgramsSetting" Guid="\\${COMPONENT_GUID.replace('}', '\\}')}">`));
  assert.match(group, /<RegistryValue Root="HKLM" Key="Software\\Nigafiy\\Hub" Name="Programs" Type="string" Value="\[PROGRAMS\]" KeyPath="yes"\/>/);
  const product = out.slice(out.indexOf('</ComponentGroup>'), out.indexOf('</Product>'));
  assert.match(product, /<Property Id="PROGRAMS" Secure="yes"\/>/);
  assert.match(product, /<RegistrySearch Id="NigafiyProgramsSaved" Root="HKLM"/);
  assert.match(product, /Action="NigafiyProgramsDefault" Value="all"/);
  assert.equal(addProgramsProperty(out), out);
  assert.throws(() => addProgramsProperty('<Wix/>'), /changed its template/);
});
