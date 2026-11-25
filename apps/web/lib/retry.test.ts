import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RETRY_CAP_MS, isRetryable, retryDelayMs } from './retry.ts';

describe('retryDelayMs', () => {
  it('doubles from 2 s and stops at the cap', () => {
    const mid = () => 0.5; // no jitter
    assert.deepEqual(
      [0, 1, 2, 3, 4, 5, 6, 50].map((a) => retryDelayMs(a, mid)),
      [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000],
    );
  });
  it('keeps jitter within ±20 % and never above the cap', () => {
    assert.equal(retryDelayMs(0, () => 0), 1600);
    assert.equal(retryDelayMs(0, () => 0.999999), 2400);
    for (let a = 0; a < 40; a++) assert.ok(retryDelayMs(a, () => 0.999999) <= RETRY_CAP_MS);
  });
  it('treats negative or fractional attempts as sane', () => {
    assert.equal(retryDelayMs(-3, () => 0.5), 2000);
    assert.equal(retryDelayMs(1.7, () => 0.5), 4000);
  });
});

describe('isRetryable', () => {
  it('retries network and server errors only', () => {
    for (const s of [0, 408, 429, 500, 502, 503, 504]) assert.ok(isRetryable(s), String(s));
    for (const s of [400, 401, 403, 404, 422]) assert.ok(!isRetryable(s), String(s));
  });
});
