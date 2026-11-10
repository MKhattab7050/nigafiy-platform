import { afterAll, describe, expect, it } from 'vitest';
import { closePools } from '../src/infrastructure/db.ts';
import { type ClassifyFacts, bestName, classify, mergeFingerprint } from '../src/modules/devices/classify.ts';
import { CSRF, addScope, heartbeat, newAccount, newCollector, sweep, telemetry } from './helpers.ts';

afterAll(closePools);

const facts = (over: Partial<ClassifyFacts> = {}): ClassifyFacts => ({ fingerprint: {}, hostname: null, vendor: null, macRandomized: false, gatewayOf: null, ...over });

describe('device classification rules', () => {
  it('classifies from what devices announce, with graded confidence', () => {
    expect(classify(facts({ fingerprint: { services: ['_ipp._tcp', '_http._tcp'], hints: { product: 'HP LaserJet M404' } } }))).toMatchObject({ type: 'printer', confidence: 'high' });
    expect(classify(facts({ fingerprint: { services: ['_googlecast._tcp'], hints: { model: 'Chromecast' } } }))).toMatchObject({ type: 'media_player', confidence: 'high' });
    expect(classify(facts({ fingerprint: { ssdp: { device_types: ['MediaRenderer'], friendly_name: 'Living Room' } } }))).toMatchObject({ type: 'media_player', confidence: 'medium' });
    expect(classify(facts({ fingerprint: { ssdp: { device_types: ['InternetGatewayDevice'] } }, gatewayOf: 'edge' }))).toMatchObject({ type: 'router', confidence: 'high' });
    expect(classify(facts({ gatewayOf: 'edge' }))).toMatchObject({ type: 'router', confidence: 'medium' });
    expect(classify(facts({ fingerprint: { names: [{ source: 'mdns', name: 'iPhone-de-Ali' }] }, macRandomized: true }))).toMatchObject({ type: 'mobile', confidence: 'high' });
    expect(classify(facts({ fingerprint: { names: [{ source: 'mdns', name: 'Galaxy-S23' }] } }))).toMatchObject({ type: 'mobile', confidence: 'high' });
    expect(classify(facts({ fingerprint: { names: [{ source: 'netbios', name: 'OFFICE-PC' }] } }))).toMatchObject({ type: 'windows_computer', confidence: 'medium' });
    expect(classify(facts({ fingerprint: { services: ['_smb._tcp', '_device-info._tcp'], hints: { model: 'MacBookPro18,3' } } }))).toMatchObject({ type: 'apple_computer', confidence: 'high' });
    expect(classify(facts({ fingerprint: { services: ['_ssh._tcp', '_sftp-ssh._tcp'] } }))).toMatchObject({ type: 'linux_computer', confidence: 'medium' });
    expect(classify(facts({ fingerprint: { services: ['_smb._tcp'], names: [{ source: 'mdns', name: 'DiskStation' }] } }))).toMatchObject({ type: 'nas', confidence: 'high' });
    expect(classify(facts({ fingerprint: { services: ['_hap._tcp'] } }))).toMatchObject({ type: 'iot', confidence: 'high' });
    expect(classify(facts({ fingerprint: { services: ['_companion-link._tcp'] }, macRandomized: true }))).toMatchObject({ type: 'mobile', confidence: 'medium' });
    // DHCP: what the device broadcast when it joined.
    expect(classify(facts({ fingerprint: { hints: { dhcp_vendor_class: 'android-dhcp-14' } }, macRandomized: true }))).toMatchObject({ type: 'mobile', confidence: 'high' });
    expect(classify(facts({ fingerprint: { names: [{ source: 'dhcp', name: 'Monas-iPhone' }] }, macRandomized: true }))).toMatchObject({ type: 'mobile', confidence: 'high' });
    expect(classify(facts({ fingerprint: { hints: { dhcp_vendor_class: 'MSFT 5.0' } } }))).toMatchObject({ type: 'windows_computer', confidence: 'medium' });
    expect(bestName({ names: [{ source: 'netbios', name: 'PC' }, { source: 'dhcp', name: 'Galaxy-A52' }] })).toEqual({ name: 'Galaxy-A52', source: 'dhcp' });
  });

  it('is honest about weak or missing evidence', () => {
    // Nothing known → not classified at all.
    expect(classify(facts())).toBeNull();
    expect(classify(facts({ vendor: 'Intel Corporate' }))).toBeNull();
    // Randomized MAC alone is only a low-confidence hint, and the evidence says why.
    const hint = classify(facts({ macRandomized: true }))!;
    expect(hint).toMatchObject({ type: 'mobile', confidence: 'low' });
    expect(hint.evidence.join(' ')).toContain('some laptops do too');
    // Every result explains itself.
    for (const fp of [{ services: ['_ipp._tcp'] }, { names: [{ source: 'netbios', name: 'PC' }] }]) expect(classify(facts({ fingerprint: fp }))!.evidence.length).toBeGreaterThan(0);
  });

  it('merges clues across sweeps and picks the best name', () => {
    const merged = mergeFingerprint({ services: ['_ipp._tcp'], names: [{ source: 'mdns', name: 'printer-7' }] }, { services: ['_http._tcp'], names: [{ source: 'mdns', name: 'PRINTER-7' }], hints: { model: 'M404' } });
    expect(merged.services).toEqual(['_http._tcp', '_ipp._tcp']);
    expect(merged.names).toHaveLength(1);
    expect(merged.hints).toEqual({ model: 'M404' });
    expect(mergeFingerprint({ services: ['_ipp._tcp'] }, {})).toEqual({ services: ['_ipp._tcp'] }); // a silent sweep loses nothing
    expect(bestName({ names: [{ source: 'ssdp', name: 'TV' }, { source: 'netbios', name: 'PC' }] })).toEqual({ name: 'PC', source: 'netbios' });
    expect(bestName({})).toBeNull();
  });
});

describe('identification through ingestion', () => {
  it('names and classifies devices, keeps manual choices, and never downgrades', async () => {
    const a = await newAccount('ident');
    const scopeId = await addScope(a, '192.168.1.0/24');
    const c = await newCollector(a);
    await heartbeat(c, { gateway_ip: '192.168.1.1' });
    const phone = { ip: '192.168.1.50', mac: 'da:a1:19:00:00:50' };
    const host = (h: Record<string, unknown>, sources: string[]) => ({ ...h, sources });

    const first = sweep(scopeId, [], 20);
    first.hosts = [
      host({ ip: '192.168.1.1', mac: '00:0c:29:01:00:01' }, ['icmp', 'arp_cache']),
      host(phone, ['icmp', 'arp_cache']),
      host({ ip: '192.168.1.60', mac: '00:0c:29:01:00:60', names: [{ source: 'mdns', name: 'printer-office' }], services: ['_ipp._tcp'], hints: { product: 'HP LaserJet M404' } }, ['icmp', 'arp_cache', 'mdns']),
      host({ ip: '192.168.1.70', mac: '00:0c:29:01:00:70', names: [{ source: 'netbios', name: 'RECEPTION-PC' }] }, ['icmp', 'arp_cache', 'netbios']),
      host({ ip: '192.168.1.80', names: [{ source: 'ssdp', name: 'Living Room TV' }], ssdp: { device_types: ['MediaRenderer'], manufacturer: 'Samsung', model: 'UE55' } }, ['ssdp']),
    ] as never;
    expect((await telemetry(c, [first])).body).toMatchObject({ accepted: 1, rejected: [] });

    const list = async () => (await a.agent.get('/api/v1/devices?sort=ip')).body.items as Record<string, any>[];
    let d = await list();
    expect(d.map((x) => [x.current_ip, x.device_type, x.type_confidence])).toEqual([
      ['192.168.1.1', 'router', 'medium'],
      ['192.168.1.50', 'mobile', 'low'],
      ['192.168.1.60', 'printer', 'high'],
      ['192.168.1.70', 'windows_computer', 'medium'],
      ['192.168.1.80', 'media_player', 'medium'],
    ]);
    expect(d[2]).toMatchObject({ hostname: 'printer-office', name_source: 'mdns', type_source: 'inferred' });
    expect(d[2]!.type_evidence).toContain('_ipp._tcp');
    expect(d[2]!.fingerprint.hints.product).toBe('HP LaserJet M404');
    expect(d[3]).toMatchObject({ hostname: 'RECEPTION-PC', name_source: 'netbios' });
    expect(d[4]).toMatchObject({ hostname: 'Living Room TV', name_source: 'ssdp', identity_basis: 'ip' });
    expect(d[4]!.discovery_sources).toEqual(['ssdp']); // present although it never answered ICMP

    // The phone wakes up and announces itself: the low-confidence hint becomes a high-confidence fact.
    const second = sweep(scopeId, [], 15);
    second.hosts = [host({ ...phone, names: [{ source: 'mdns', name: 'iPhone-Mona' }], services: ['_companion-link._tcp'] }, ['icmp', 'arp_cache', 'mdns']), host({ ip: '192.168.1.60', mac: '00:0c:29:01:00:60' }, ['icmp', 'arp_cache'])] as never;
    await telemetry(c, [second]);
    d = await list();
    const iphone = d.find((x) => x.current_ip === '192.168.1.50')!;
    expect(iphone).toMatchObject({ device_type: 'mobile', type_confidence: 'high', hostname: 'iPhone-Mona' });
    // The printer said nothing this time: its earlier identification is kept.
    expect(d.find((x) => x.current_ip === '192.168.1.60')).toMatchObject({ device_type: 'printer', type_confidence: 'high', hostname: 'printer-office' });

    // Later it is silent again → stays high, is not downgraded back to a guess.
    const third = sweep(scopeId, [], 10);
    third.hosts = [host(phone, ['icmp', 'arp_cache'])] as never;
    await telemetry(c, [third]);
    expect((await list()).find((x) => x.current_ip === '192.168.1.50')).toMatchObject({ type_confidence: 'high', hostname: 'iPhone-Mona' });

    // A silent phone that was overheard on DHCP gets its real name and a high-confidence type.
    const dhcpSweep = sweep(scopeId, [], 8);
    dhcpSweep.hosts = [host({ ip: '192.168.1.55', mac: 'da:a1:19:00:00:55', names: [{ source: 'dhcp', name: 'Galaxy-A52' }], hints: { dhcp_vendor_class: 'android-dhcp-14' } }, ['arp_cache', 'dhcp'])] as never;
    expect((await telemetry(c, [dhcpSweep])).body).toMatchObject({ accepted: 1, rejected: [] });
    const galaxy = (await list()).find((x) => x.current_ip === '192.168.1.55')!;
    expect(galaxy).toMatchObject({ hostname: 'Galaxy-A52', name_source: 'dhcp', device_type: 'mobile', type_confidence: 'high' });
    expect(galaxy.type_evidence).toContain('android-dhcp-14');

    // A manual classification wins over anything announced later.
    await a.agent.patch(`/api/v1/devices/${iphone.id}`).set(CSRF).send({ device_type: 'iot' });
    const fourth = sweep(scopeId, [], 5);
    fourth.hosts = [host({ ...phone, names: [{ source: 'mdns', name: 'iPhone-Mona' }] }, ['icmp', 'mdns'])] as never;
    await telemetry(c, [fourth]);
    expect((await list()).find((x) => x.current_ip === '192.168.1.50')).toMatchObject({ device_type: 'iot', type_source: 'manual', type_confidence: null });
    expect((await a.agent.get('/api/v1/devices?device_type=printer')).body.total).toBe(1);

    // Device-supplied text is validated: control characters and oversized values are rejected.
    const bad = sweep(scopeId, [], 1);
    bad.hosts = [host({ ip: '192.168.1.90', names: [{ source: 'mdns', name: 'evil\u0000name' }] }, ['mdns'])] as never;
    expect((await telemetry(c, [bad])).status).toBe(400);
    bad.hosts = [host({ ip: '192.168.1.90', names: [{ source: 'mdns', name: 'x'.repeat(500) }] }, ['mdns'])] as never;
    expect((await telemetry(c, [bad])).status).toBe(400);
  });
});
