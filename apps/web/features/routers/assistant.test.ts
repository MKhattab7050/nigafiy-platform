import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assistantAr, assistantEn } from './assistant-strings.ts';
import { RESET_STEPS, confidenceKey, driverMaturity, guideSteps, resetStepsVisible, stickerKey, wizardVendor } from './assistant.ts';

// Router connection assistant, UX review 2026-11-26 item 13.

const VENDORS = ['mikrotik', 'huawei', 'huawei_lte', 'zte', 'tplink_archer', 'tenda', 'dlink', 'asus', 'zyxel', 'unifi', 'omada', 'openwrt', 'opnsense', 'pfsense', 'fortigate', 'cisco_xe'];

describe('router assistant', () => {
  it('every driver except Zyxel on the VMG3625-T50B is beta', () => {
    for (const v of VENDORS) assert.equal(driverMaturity(v), v === 'zyxel' ? 'tested' : 'beta', v);
    assert.equal(driverMaturity('zyxel', 'VMG3625-T50B'), 'tested');
    assert.equal(driverMaturity('zyxel', 'VMG8825-T50'), 'beta');
    assert.equal(driverMaturity('zte', 'ZXHN H188A'), 'beta');
  });

  it('every guide has its own label sentence and ends with the add step', () => {
    for (const g of ['zte_h188a', 'huawei_dg8045', 'zyxel', 'other'] as const) {
      const steps = guideSteps(g);
      assert.equal(steps[0], stickerKey(g));
      assert.equal(steps.at(-1), 'routers.assist.step.add');
      for (const k of steps) assert.ok(k in assistantEn, k);
    }
    for (const c of ['high', 'medium', 'low', 'none'] as const) assert.ok(confidenceKey(c) in assistantEn);
  });

  it('the reset steps stay hidden until the PPPoE login is confirmed', () => {
    assert.equal(resetStepsVisible(false), false);
    assert.equal(resetStepsVisible(true), true);
    for (const k of RESET_STEPS) assert.ok(k in assistantEn, k);
  });

  it('the wizard starts with a vendor only when an observation named one', () => {
    const base = { guide: 'other' as const, model: null, evidence: [] };
    assert.equal(wizardVendor({ ...base, vendor: null, confidence: 'none' }), null);
    assert.equal(wizardVendor({ ...base, vendor: 'zte', confidence: 'low' }), 'zte');
  });

  it('every English sentence has an Arabic one', () => {
    assert.deepEqual(Object.keys(assistantAr).sort(), Object.keys(assistantEn).sort());
    for (const [k, v] of Object.entries(assistantAr)) assert.ok(v.trim().length > 0, k);
  });
});
