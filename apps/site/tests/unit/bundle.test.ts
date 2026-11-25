// The "Build your bundle" picker: the PROGRAMS value and the exact installer commands.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BUNDLE_PROGRAMS, bundleCommands, parseProgramsValue, programsValue } from '../../lib/bundle.ts';

const REPO = path.resolve(import.meta.dirname, '../../../..');

describe('bundle picker', () => {
  it('every program ticked is "all", as the installer page writes it', () => {
    assert.equal(programsValue(BUNDLE_PROGRAMS), 'all');
  });

  it('a subset is hub plus the programs in installer order, whatever order they were ticked in', () => {
    assert.equal(programsValue(['watch', 'radar']), 'hub,radar,watch');
    assert.equal(programsValue(['toolbox', 'fleet', 'guard']), 'hub,guard,fleet,toolbox');
  });

  it('nothing ticked is Hub alone', () => {
    assert.equal(programsValue([]), 'hub');
  });

  it('ignores names that are not programs', () => {
    assert.equal(programsValue(['radar', 'agent', 'hub', 'x']), 'hub,radar');
  });

  it('round-trips through the installer value', () => {
    for (const choice of [[], ['radar'], ['radar', 'mind'], [...BUNDLE_PROGRAMS]]) {
      assert.deepEqual(parseProgramsValue(programsValue(choice)), BUNDLE_PROGRAMS.filter((p) => choice.includes(p)));
    }
    assert.equal(parseProgramsValue('hub,agent'), null);
  });

  it('builds the NSIS and MSI commands documented in installers.md', () => {
    const c = bundleCommands(['radar', 'watch'], '1.2.3');
    assert.equal(c.nsis, '"Nigafiy Setup 1.2.3.exe" /S /currentuser /PROGRAMS=hub,radar,watch');
    assert.equal(c.msi, 'msiexec /i "Nigafiy 1.2.3.msi" /qn PROGRAMS=hub,radar,watch');
  });

  it('uses only program names the NSIS installer accepts (apps/desktop/installer/nigafiy.nsh)', () => {
    const nsh = readFileSync(path.join(REPO, 'apps', 'desktop', 'installer', 'nigafiy.nsh'), 'utf8');
    for (const p of ['hub', ...BUNDLE_PROGRAMS]) assert.match(nsh, new RegExp(`\\$R1 != "${p}"`), p);
    assert.match(nsh, /GetOptions\} \$R0 "\/PROGRAMS="/);
  });

  it('the MSI really has the PROGRAMS property (apps/desktop/scripts/msi-programs.cjs)', () => {
    const msi = readFileSync(path.join(REPO, 'apps', 'desktop', 'scripts', 'msi-programs.cjs'), 'utf8');
    assert.match(msi, /<Property Id="PROGRAMS" Secure="yes"\/>/);
  });
});
