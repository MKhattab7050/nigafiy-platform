import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import type { RemoteDesktopFrame } from '@lan-detective/shared-types';
import { systemPool } from '../src/infrastructure/db.ts';
import { RD_FRAME_CHANNEL, dropFrames, latestFrame, onFrameNotification, publishFrame, publishFramesCleared } from '../src/modules/endpoints/remote-desktop/frames.ts';

// The transient remote desktop frame relay between API instances: frames go through pg_notify
// (delivered on COMMIT) in chunks, never through a table. A second LISTEN connection plays the
// other API instance.

async function listener(): Promise<{ payloads: string[]; close: () => Promise<void> }> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: 'test-listener' });
  await c.connect();
  const payloads: string[] = [];
  c.on('notification', (n) => payloads.push(n.payload ?? ''));
  await c.query(`LISTEN ${RD_FRAME_CHANNEL}`);
  return { payloads, close: () => c.end() };
}

async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
}

const frame = (image: string): RemoteDesktopFrame => ({
  display_index: 0,
  displays: [{ index: 0, name: 'Écran principal (1)', x: 0, y: 0, width: 1920, height: 1080, primary: true }],
  width: 1440,
  height: 810,
  source_width: 1920,
  source_height: 1080,
  quality: 68,
  scale: 0.75,
  capture_ms: 12,
  byte_length: image.length,
  capture_mode: 'native_gdi',
  jpeg_base64: image,
  captured_at: new Date().toISOString(),
});

describe('remote desktop frame relay between API instances', () => {
  it('delivers a frame in chunks on COMMIT and reassembles it in any order', async () => {
    const l = await listener();
    const endpointId = randomUUID();
    const commandId = randomUUID();
    const image = randomUUID().repeat(3_000); // 108 000 characters → 16 chunks
    const db = await systemPool.connect();
    try {
      await db.query('BEGIN');
      await publishFrame(db, endpointId, commandId, frame(image));
      await new Promise((r) => setTimeout(r, 100));
      expect(l.payloads).toHaveLength(0); // nothing before COMMIT
      await db.query('COMMIT');
    } finally {
      db.release();
    }
    await until(() => l.payloads.length >= 17);
    expect(l.payloads).toHaveLength(17);
    for (const p of l.payloads) expect(Buffer.byteLength(p)).toBeLessThan(8000);

    dropFrames(endpointId);
    const shuffled = [...l.payloads].reverse();
    for (const p of shuffled) onFrameNotification(p);
    const held = latestFrame(endpointId);
    expect(held?.commandId).toBe(commandId);
    expect(held?.frame.jpeg_base64).toBe(image);
    expect(held?.frame.displays[0]?.name).toBe('Écran principal (1)');
    expect(held?.frame.width).toBe(1440);

    // "Session ended" reaches every instance too.
    const tx = await systemPool.connect();
    try {
      await publishFramesCleared(tx, endpointId);
    } finally {
      tx.release();
    }
    await until(() => l.payloads.length >= 18);
    onFrameNotification(l.payloads[17]!);
    expect(latestFrame(endpointId)).toBeNull();
    await l.close();
  });

  it('sends nothing when the upload is rolled back, and ignores malformed notifications', async () => {
    const l = await listener();
    const endpointId = randomUUID();
    const db = await systemPool.connect();
    try {
      await db.query('BEGIN');
      await publishFrame(db, endpointId, randomUUID(), frame('abc'));
      await db.query('ROLLBACK');
    } finally {
      db.release();
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(l.payloads).toHaveLength(0);
    await l.close();

    for (const bad of ['', 'f|x|y|0|1|abc', `f|${randomUUID()}|${endpointId}|5|2|abc`, `f|${randomUUID()}|${endpointId}|0|1|not-base64-json`, 'x|not-a-uuid']) {
      onFrameNotification(bad);
    }
    expect(latestFrame(endpointId)).toBeNull();
  });
});
