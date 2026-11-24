// Unit tests of the transfer queue's SHA-256 and its resume rules against node:crypto. Run with
// `pnpm --filter @nigafiy/web test:unit`.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { Sha256 } from './sha256.ts';
import { classifyTransferError, uploadResumePoint } from './transfer-rules.ts';

const ref = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('Sha256', () => {
  it('matches node:crypto for every length around the block edges, fed in odd pieces', () => {
    for (const n of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 70_001]) {
      const data = new Uint8Array(randomBytes(n));
      const s = new Sha256();
      for (let i = 0; i < n; ) {
        const step = 1 + ((i * 7) % 97);
        s.update(data.subarray(i, i + step));
        i += step;
      }
      assert.equal(s.hex(), ref(data), `length ${n}`);
    }
    assert.equal(new Sha256().update(new TextEncoder().encode('abc')).hex(), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('transfer rules', () => {
  it('resumes an upload only where the agent says its own upload stopped', () => {
    assert.deepEqual(uploadResumePoint(1000, { total_size: 400, upload_next: 400 }), { kind: 'resume', offset: 400 });
    // Not one this agent can continue (restarted, or another file): start again, which replaces it.
    assert.deepEqual(uploadResumePoint(1000, { total_size: 400 }), { kind: 'restart' });
    // Larger than the file being sent: never continue into it.
    assert.deepEqual(uploadResumePoint(1000, { total_size: 4000, upload_next: 4000 }), { kind: 'restart' });
    assert.deepEqual(uploadResumePoint(1000, null), { kind: 'restart' });
  });
  it('keeps a transfer for resuming after a lost connection, fails it on an agent refusal', () => {
    assert.equal(classifyTransferError({ status: 504, code: 'timeout' }), 'interrupted');
    assert.equal(classifyTransferError({ status: 0, code: 'network_error' }), 'interrupted');
    assert.equal(classifyTransferError({ status: 409, code: 'endpoint_offline' }), 'interrupted');
    assert.equal(classifyTransferError({ status: 422, code: 'fs_op_failed', message: 'path is outside the allowed roots' }), 'failed');
    assert.equal(classifyTransferError({ status: 403, code: 'forbidden' }), 'failed');
    assert.equal(classifyTransferError({ status: 499, code: 'cancelled' }), 'cancelled');
  });
});
