import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { accountLoginLimiter } from '../src/modules/auth/routes.ts';

// EXT-1: failed sign-ins are also counted per account, whichever address they come from.
describe('per-account sign-in throttle', () => {
  it('counts only failures, per email (case-insensitive), across client addresses', async () => {
    const app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.post('/login', accountLoginLimiter(3), (req, res) => {
      if (req.body.password === 'right') res.json({ ok: true });
      else res.status(401).json({ error: { code: 'invalid_credentials' } });
    });
    const attempt = (email: string, password: string, ip: string) => request(app).post('/login').set('X-Forwarded-For', ip).send({ email, password });

    // Successes never count.
    for (let i = 0; i < 5; i++) expect((await attempt('a@x.example', 'right', '10.0.0.1')).status).toBe(200);
    // Three failures from three different addresses use up the account's budget...
    expect((await attempt('victim@x.example', 'w1', '10.0.0.1')).status).toBe(401);
    expect((await attempt('VICTIM@x.example', 'w2', '10.0.0.2')).status).toBe(401);
    expect((await attempt(' victim@x.example', 'w3', '10.0.0.3')).status).toBe(401);
    const blocked = await attempt('victim@x.example', 'w4', '10.0.0.4');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('rate_limited');
    // ...without touching another account.
    expect((await attempt('other@x.example', 'w', '10.0.0.4')).status).toBe(401);
  });
});
