import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parsePlural, selectPlural } from './plural.ts';

const EN = 'one: {n} device | other: {n} devices';
const AR = 'zero: لا أجهزة | one: جهاز واحد | two: جهازان | few: {n} أجهزة | many: {n} جهازًا | other: {n} جهاز';

describe('selectPlural', () => {
  it('picks the English form', () => {
    assert.equal(selectPlural(EN, 1, 'en'), '{n} device');
    assert.equal(selectPlural(EN, 0, 'en'), '{n} devices');
    assert.equal(selectPlural(EN, 2, 'en'), '{n} devices');
  });

  it('picks each of the six Arabic forms', () => {
    assert.equal(selectPlural(AR, 0, 'ar'), 'لا أجهزة');
    assert.equal(selectPlural(AR, 1, 'ar'), 'جهاز واحد');
    assert.equal(selectPlural(AR, 2, 'ar'), 'جهازان');
    assert.equal(selectPlural(AR, 3, 'ar'), '{n} أجهزة');
    assert.equal(selectPlural(AR, 10, 'ar'), '{n} أجهزة');
    assert.equal(selectPlural(AR, 11, 'ar'), '{n} جهازًا');
    assert.equal(selectPlural(AR, 99, 'ar'), '{n} جهازًا');
    assert.equal(selectPlural(AR, 100, 'ar'), '{n} جهاز');
    assert.equal(selectPlural(AR, 103, 'ar'), '{n} أجهزة');
  });

  it('falls back to other, and leaves ordinary sentences alone', () => {
    assert.equal(selectPlural('one: a | other: b', 5, 'ar'), 'b');
    assert.equal(selectPlural('Up to {n} times', 3, 'en'), 'Up to {n} times');
    assert.equal(parsePlural('Ratio: 1 | 2'), null);
    assert.equal(parsePlural('one: only'), null);
  });
});
