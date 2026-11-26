import { describe, expect, it } from 'vitest';
import { ROUTER_VENDORS } from '../src/modules/routers/schema.ts';
import { detectRouterModel, driverMaturity, driverTable } from '../src/modules/routers/assistant.ts';
import { systemPool } from '../src/infrastructure/db.ts';
import { CSRF, addScope, heartbeat, newAccount, newCollector, sweep, telemetry } from './helpers.ts';

// Router connection assistant (UX review 2026-11-26, item 13).

describe('router model detection (pure)', () => {
  it('names an exact model only when an observation names it, with the observation as evidence', () => {
    const zte = detectRouterModel({ http_title: 'ZXHN H188A' });
    expect(zte).toMatchObject({ guide: 'zte_h188a', vendor: 'zte', model: 'ZTE ZXHN H188A', confidence: 'high' });
    expect(zte.evidence).toEqual([{ source: 'web_page', field: 'page title', value: 'ZXHN H188A', matched: 'H188A' }]);

    expect(detectRouterModel({ ssdp_model: 'DG8045' })).toMatchObject({ guide: 'huawei_dg8045', vendor: 'huawei', confidence: 'high' });
    expect(detectRouterModel({ driver_identity: { vendor: 'Zyxel', model: 'VMG3625-T50B' } })).toMatchObject({ guide: 'zyxel', model: 'Zyxel VMG3625-T50B', confidence: 'high' });
    expect(detectRouterModel({ driver_identity: { model: 'VMG3625-T50B' } }).evidence[0]?.source).toBe('driver');
  });

  it('a vendor word without a model is medium, and keeps the model unknown', () => {
    expect(detectRouterModel({ http_server: 'ZTE web server 1.0' })).toMatchObject({ vendor: 'zte', model: null, guide: 'other', confidence: 'medium' });
    expect(detectRouterModel({ tls_subject: 'CN=Huawei Home Gateway' })).toMatchObject({ vendor: 'huawei', confidence: 'medium' });
    expect(detectRouterModel({ http_title: 'Zyxel VMG8825' })).toMatchObject({ vendor: 'zyxel', guide: 'zyxel', confidence: 'medium' });
  });

  it('the MAC vendor alone is only a low-confidence hint', () => {
    expect(detectRouterModel({ mac_vendor: 'zte corporation' })).toMatchObject({ vendor: 'zte', model: null, confidence: 'low' });
    expect(detectRouterModel({ mac_vendor: 'Huawei Technologies Co.,Ltd' }).evidence[0]).toMatchObject({ source: 'mac_vendor' });
  });

  it('nothing observed, or nothing that names a product: no conclusion', () => {
    expect(detectRouterModel({})).toEqual({ guide: 'other', vendor: null, model: null, confidence: 'none', evidence: [] });
    expect(detectRouterModel({ http_server: 'nginx', mac_vendor: 'Intel Corporate' })).toMatchObject({ vendor: null, confidence: 'none' });
  });

  it('a page title naming the model wins over a MAC vendor that says otherwise', () => {
    expect(detectRouterModel({ http_title: 'DG8045', mac_vendor: 'ZTE Corporation' })).toMatchObject({ vendor: 'huawei', confidence: 'high' });
  });
});

describe('driver maturity', () => {
  it('only the Zyxel driver on the VMG3625-T50B is tested; every other driver is beta', () => {
    for (const v of ROUTER_VENDORS) expect(driverMaturity(v)).toBe(v === 'zyxel' ? 'tested' : 'beta');
    expect(driverMaturity('zyxel', 'VMG3625-T50B')).toBe('tested');
    expect(driverMaturity('zyxel', 'VMG8825-T50')).toBe('beta');
    expect(driverMaturity('zte', 'ZXHN H188A')).toBe('beta');
    expect(driverTable().map((d) => d.vendor)).toEqual([...ROUTER_VENDORS]);
  });
});

describe('GET /router-assistant', () => {
  it('describes the gateway the Sensor reported, from the observations stored for it', async () => {
    const a = await newAccount('router-assist');
    const scopeId = await addScope(a, '192.168.1.0/24');
    const c = await newCollector(a);
    expect((await heartbeat(c, { gateway_ip: '192.168.1.1' })).status).toBe(200);
    await telemetry(c, [sweep(scopeId, [{ ip: '192.168.1.1', mac: '00:11:22:33:44:01', hostname: 'gateway' }])]);
    await systemPool.query(
      `UPDATE devices SET vendor = 'zte corporation', fingerprint = '{"hints":{"http_title":"ZXHN H188A"}}'
        WHERE organization_id = $1 AND current_ip = '192.168.1.1'`,
      [a.organizationId],
    );

    const res = await a.agent.get(`/api/v1/router-assistant?site_id=${a.siteId}`);
    expect(res.status).toBe(200);
    expect(res.body.gateways).toHaveLength(1);
    const g = res.body.gateways[0];
    expect(g.address).toBe('192.168.1.1');
    expect(g.device).toMatchObject({ mac: '00:11:22:33:44:01', vendor: 'zte corporation' });
    expect(g.router).toBeNull();
    expect(g.detection).toMatchObject({ guide: 'zte_h188a', vendor: 'zte', confidence: 'high' });
    expect(g.maturity).toBe('beta');
    expect(res.body.drivers.find((d: { vendor: string }) => d.vendor === 'zyxel')).toMatchObject({ maturity: 'tested', tested_models: ['VMG3625-T50B'] });
  });

  it('no gateway reported: an empty list, not a guess', async () => {
    const a = await newAccount('router-assist-empty');
    await newCollector(a);
    const res = await a.agent.get(`/api/v1/router-assistant?site_id=${a.siteId}`);
    expect(res.status).toBe(200);
    expect(res.body.gateways).toEqual([]);
  });

  it('another organization’s site shows nothing', async () => {
    const a = await newAccount('router-assist-a');
    const c = await newCollector(a);
    await heartbeat(c, { gateway_ip: '10.0.0.1' });
    const b = await newAccount('router-assist-b');
    const res = await b.agent.get(`/api/v1/router-assistant?site_id=${a.siteId}`);
    expect(res.status).toBe(200);
    expect(res.body.gateways).toEqual([]);
  });

  it('refuses a missing or malformed site id', async () => {
    const a = await newAccount('router-assist-bad');
    expect((await a.agent.get('/api/v1/router-assistant')).status).toBe(400);
    expect((await a.agent.get('/api/v1/router-assistant?site_id=nope').set(CSRF)).status).toBe(400);
  });
});
