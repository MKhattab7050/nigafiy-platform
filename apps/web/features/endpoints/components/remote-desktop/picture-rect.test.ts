// Where the remote picture sits inside a full-screen canvas. Run with `pnpm --filter @nigafiy/web test:unit`.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pictureBox } from './picture-rect.ts';

describe('pictureBox', () => {
  it('is the element itself when the element has the picture shape', () => {
    assert.deepEqual(pictureBox({ left: 10, top: 20, width: 960, height: 540 }, 1920, 1080), { left: 10, top: 20, width: 960, height: 540 });
  });

  it('leaves bars left and right on a screen wider than the picture (phone in landscape)', () => {
    // 2340x1080 phone, 1920x1080 picture: drawn 1920 wide, 210 px bars each side.
    assert.deepEqual(pictureBox({ left: 0, top: 0, width: 2340, height: 1080 }, 1920, 1080), { left: 210, top: 0, width: 1920, height: 1080 });
  });

  it('leaves bars above and below on a screen taller than the picture', () => {
    assert.deepEqual(pictureBox({ left: 0, top: 0, width: 1080, height: 2340 }, 1920, 1080), { left: 0, top: 866.25, width: 1080, height: 607.5 });
  });

  it('is the element when the picture size is not known yet', () => {
    assert.deepEqual(pictureBox({ left: 1, top: 2, width: 3, height: 4 }, 0, 0), { left: 1, top: 2, width: 3, height: 4 });
  });
});
