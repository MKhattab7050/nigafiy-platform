import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NO_MODS, SENTINEL, diffTyped, stepEvent } from './touch-keys.ts';

describe('phone keyboard typing', () => {
  it('new letters are typed', () => {
    assert.deepEqual(diffTyped(SENTINEL, `${SENTINEL}hi`), [{ kind: 'text', text: 'hi' }]);
  });

  it('a deleted letter, or a Backspace on an empty box, is a Backspace', () => {
    assert.deepEqual(diffTyped(`${SENTINEL}hi`, `${SENTINEL}h`), [{ kind: 'key', key: 'Backspace' }]);
    assert.deepEqual(diffTyped(SENTINEL, SENTINEL.slice(1)), [{ kind: 'key', key: 'Backspace' }]);
  });

  it('a word the keyboard corrected is erased and typed again from where it differs', () => {
    assert.deepEqual(diffTyped(`${SENTINEL}teh`, `${SENTINEL}the `), [
      { kind: 'key', key: 'Backspace' },
      { kind: 'key', key: 'Backspace' },
      { kind: 'text', text: 'he ' },
    ]);
  });

  it('a new line is Enter', () => {
    assert.deepEqual(diffTyped(`${SENTINEL}ok`, `${SENTINEL}ok\n`), [{ kind: 'key', key: 'Enter' }]);
    assert.deepEqual(diffTyped(SENTINEL, `${SENTINEL}a\nb`), [
      { kind: 'text', text: 'a' },
      { kind: 'key', key: 'Enter' },
      { kind: 'text', text: 'b' },
    ]);
  });

  it('Arabic is typed as it is', () => {
    assert.deepEqual(diffTyped(SENTINEL, `${SENTINEL}سلام`), [{ kind: 'text', text: 'سلام' }]);
  });
});

describe('held Ctrl / Alt / Win', () => {
  it('Ctrl then c is Ctrl+C, the rest is typed', () => {
    const m = { ...NO_MODS, ctrl: true };
    assert.deepEqual(stepEvent({ kind: 'text', text: 'C' }, m), [{ kind: 'key_combo', keys: ['Ctrl', 'c'] }]);
    assert.deepEqual(stepEvent({ kind: 'text', text: 'ab' }, m), [
      { kind: 'key_combo', keys: ['Ctrl', 'a'] },
      { kind: 'text', text: 'b' },
    ]);
  });

  it('without modifiers keys and text go as they are', () => {
    assert.deepEqual(stepEvent({ kind: 'key', key: 'Enter' }, NO_MODS), [{ kind: 'key_press', key: 'Enter' }]);
    assert.deepEqual(stepEvent({ kind: 'key', key: 'Backspace' }, { ...NO_MODS, ctrl: true }), [{ kind: 'key_combo', keys: ['Ctrl', 'Backspace'] }]);
  });
});
