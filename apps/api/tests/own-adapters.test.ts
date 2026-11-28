import { describe, expect, it } from 'vitest';
import { connectedAdapters, mergeAdapters, unpluggedFromWindows, usableIpv4 } from '../src/modules/outside-access/own-adapters.ts';

describe('own adapters (Ethernet and Wi-Fi, plugged in or not)', () => {
  it('keeps only addresses a home network can use', () => {
    for (const ip of ['192.168.1.147', '10.0.0.5', '172.16.3.4', '203.0.113.9']) expect(usableIpv4(ip)).toBe(true);
    for (const ip of ['127.0.0.1', '169.254.10.1', '100.95.99.101', '0.0.0.0', '224.0.0.1', '999.1.1.1', '', null, 'fe80::1'])
      expect(usableIpv4(ip as string)).toBe(false);
  });

  it('reads connected adapters from Node, one per MAC, no Tailscale or loopback', () => {
    const ifaces = {
      'Wi-Fi': [
        { family: 'IPv4', internal: false, address: '192.168.1.138', mac: '38:fc:98:36:6d:43' },
        { family: 'IPv6', internal: false, address: 'fe80::1', mac: '38:fc:98:36:6d:43' },
      ],
      Tailscale: [{ family: 'IPv4', internal: false, address: '100.95.99.101', mac: '00:00:00:00:00:00' }],
      Loopback: [{ family: 'IPv4', internal: true, address: '127.0.0.1', mac: '00:00:00:00:00:00' }],
      'vEthernet (link-local)': [{ family: 'IPv4', internal: false, address: '169.254.3.3', mac: '00:15:5d:01:02:03' }],
    } as never;
    expect(connectedAdapters(ifaces)).toEqual([{ mac: '38:fc:98:36:6d:43', ip: '192.168.1.138', connected: true }]);
  });

  it('takes an unplugged cable at its last DHCP address (Windows registry)', () => {
    const rows = [
      { mac: '38-FC-98-36-6D-43', up: true, dhcp: 1, dhcpIp: '192.168.1.138', staticIp: '' },
      { mac: '00-BE-43-49-CE-88', up: false, dhcp: 1, dhcpIp: '192.168.1.147', staticIp: '' },
      { mac: '00-11-22-33-44-55', up: false, dhcp: 0, dhcpIp: '', staticIp: '10.0.0.9' },
      { mac: '00-11-22-33-44-66', up: false, dhcp: 1, dhcpIp: '0.0.0.0', staticIp: '' }, // never had a lease
      { mac: '', up: false, dhcp: 1, dhcpIp: '192.168.1.9' },
    ];
    expect(unpluggedFromWindows(rows)).toEqual([
      { mac: '00:be:43:49:ce:88', ip: '192.168.1.147', connected: false },
      { mac: '00:11:22:33:44:55', ip: '10.0.0.9', connected: false },
    ]);
  });

  it('lists connected adapters first and never the same MAC twice', () => {
    const wifi = { mac: '38:fc:98:36:6d:43', ip: '192.168.1.138', connected: true };
    const cable = { mac: '00:be:43:49:ce:88', ip: '192.168.1.147', connected: false };
    expect(mergeAdapters([wifi], [cable, { ...wifi, connected: false, ip: '192.168.1.50' }])).toEqual([wifi, cable]);
  });
});
