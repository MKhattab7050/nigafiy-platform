import { describe, expect, it } from 'vitest';
import { normalizeConfig } from '../src/modules/configbackup/normalize.ts';
import { prepareConfig } from '../src/modules/configbackup/resanitize.ts';
import { REDACTED_MARK, sanitizeConfig } from '../src/modules/configbackup/sanitize.ts';

// Realistic configuration fragments per vendor family. Each fixture lists the secret values it holds;
// none may survive sanitization, and the non-secret structure around them must stay.

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);

interface Fixture {
  family: string;
  text: string;
  secrets: string[];
  keep: string[];
}

const FIXTURES: Fixture[] = [
  {
    family: 'Cisco IOS / IOS-XE',
    text: [
      'hostname core-sw1',
      'enable secret 9 $9$nhEmQVczB7dqsO$X.HsgL6x1il0RxkOSSvyQYwucySCt7qFm4v7pqCxkKM',
      'enable password 7 0822455D0A16',
      'username admin privilege 15 secret 5 $1$mERr$hx5rVt7rPNoS4wqbXKX7m0',
      'username ops password 7 14141B180F0B',
      'no service password-encryption',
      'aaa new-model',
      'tacacs-server host 10.1.1.10 key 7 0835495D1D',
      'radius server RAD-1',
      ' address ipv4 10.1.1.11 auth-port 1812 acct-port 1813',
      ' key RadiusShared99',
      'key chain OSPF-KEYS',
      ' key 1',
      '  key-string 7 110A1016141D',
      'interface GigabitEthernet0/1',
      ' description uplink to core',
      ' ip ospf message-digest-key 1 md5 7 094F471A1A0A',
      ' standby 1 authentication md5 key-string HsrpKey42',
      'crypto isakmp key IkePsk!2026 address 203.0.113.9',
      'crypto keyring KR',
      '  pre-shared-key address 198.51.100.7 key KeyringPsk77',
      'router bgp 65001',
      ' neighbor 10.0.0.2 password BgpNbrPass1',
      'snmp-server community s3cr3t RO',
      'snmp-server community Wr1te-C0mm RW 10',
      'snmp-server host 10.1.1.20 version 2c TrapComm9',
      'snmp-server user mon MONGRP v3 auth sha AuthPass11 priv aes 128 PrivPass22',
      'interface Dot11Radio0',
      ' ssid CORP',
      '  wpa-psk ascii 0 WifiPassphrase8',
      'ppp chap password 0 ChapSecret3',
      'line vty 0 4',
      ' password 7 0822455D0A16',
      'end',
    ].join('\n'),
    secrets: [
      '$9$nhEmQVczB7dqsO$X.HsgL6x1il0RxkOSSvyQYwucySCt7qFm4v7pqCxkKM', '0822455D0A16', '$1$mERr$hx5rVt7rPNoS4wqbXKX7m0', '14141B180F0B', '0835495D1D',
      'RadiusShared99', '110A1016141D', '094F471A1A0A', 'HsrpKey42', 'IkePsk!2026', 'KeyringPsk77', 'BgpNbrPass1', 's3cr3t', 'Wr1te-C0mm', 'TrapComm9',
      'AuthPass11', 'PrivPass22', 'WifiPassphrase8', 'ChapSecret3',
    ],
    keep: ['hostname core-sw1', 'no service password-encryption', ' description uplink to core', 'key chain OSPF-KEYS', ' key 1', 'snmp-server host 10.1.1.20 version 2c ', ' RO', 'end'],
  },
  {
    family: 'Cisco NX-OS / ASA',
    text: [
      'username admin password 5 $5$KLMNOP$Qrstuvwxyz0123456789abcdefghijklmnopqrstu  role network-admin',
      'tacacs-server key 7 "Tac4csKey"',
      'passwd 2KFQnbNIdI.2KYOU encrypted',
      'tunnel-group 198.51.100.1 ipsec-attributes',
      ' ikev1 pre-shared-key AsaTunnelPsk',
      ' ikev2 remote-authentication pre-shared-key AsaIkev2Remote',
      'aaa-server ISE protocol radius',
      'aaa-server ISE (inside) host 10.9.9.9',
      ' key AsaRadiusKey',
    ].join('\n'),
    secrets: ['$5$KLMNOP$Qrstuvwxyz0123456789abcdefghijklmnopqrstu', 'Tac4csKey', '2KFQnbNIdI.2KYOU', 'AsaTunnelPsk', 'AsaIkev2Remote', 'AsaRadiusKey'],
    keep: ['role network-admin', 'tunnel-group 198.51.100.1 ipsec-attributes', ' encrypted'],
  },
  {
    family: 'Aruba AOS-CX / ProCurve, Dell, Huawei VRP',
    text: [
      'user admin group administrators password ciphertext AQBapWG0ZqX5Lu0p+Dv1',
      'password manager user-name admin sha1 9A1B2C3D4E5F',
      'snmp-server community "procurvecomm" operator',
      'radius-server host 10.2.2.2 key "ArubaRadius1"',
      'local-user admin password irreversible-cipher $1a$Zm8~8\'v}w$Hk%^$',
      'snmp-agent community read cipher %^%#HuaweiCommunity%^%#',
    ].join('\n'),
    secrets: ['AQBapWG0ZqX5Lu0p+Dv1', 'procurvecomm', 'ArubaRadius1', '$1a$Zm8', 'HuaweiCommunity'],
    keep: ['user admin group administrators password ciphertext ', ' operator'],
  },
  {
    family: 'Juniper Junos (curly and set)',
    text: [
      'system {',
      '    root-authentication {',
      '        encrypted-password "$6$abc$JunosRootHash"; ## SECRET-DATA',
      '    }',
      '    login {',
      '        user ops {',
      '            authentication {',
      '                encrypted-password "$6$def$JunosOpsHash"; ## SECRET-DATA',
      '            }',
      '        }',
      '    }',
      '    radius-server {',
      '        10.3.3.3 secret "$9$RadiusNine"; ## SECRET-DATA',
      '    }',
      '}',
      'snmp {',
      '    community JunosComm {',
      '        authorization read-only;',
      '    }',
      '}',
      'security {',
      '    ike {',
      '        policy P1 {',
      '            pre-shared-key ascii-text "$9$IkeNine"; ## SECRET-DATA',
      '        }',
      '    }',
      '}',
      'set protocols ospf area 0 interface ge-0/0/0 authentication md5 1 key "$9$OspfNine"',
      'set snmp community SetComm authorization read-only',
    ].join('\n'),
    secrets: ['$6$abc$JunosRootHash', '$6$def$JunosOpsHash', '$9$RadiusNine', 'JunosComm', '$9$IkeNine', '$9$OspfNine', 'SetComm'],
    keep: ['        authorization read-only;', 'set protocols ospf area 0 interface ge-0/0/0 authentication md5 1 key "', ' ## SECRET-DATA'],
  },
  {
    family: 'MikroTik RouterOS',
    text: [
      '/interface wireless security-profiles',
      'add authentication-types=wpa2-psk mode=dynamic-keys name=corp wpa2-pre-shared-key=RosWifiKey1 supplicant-identity=MikroTik',
      '/interface wireguard',
      'add listen-port=13231 name=wg0 private-key="aGVsbG8gd29ybGQgcHJpdmF0ZSBrZXk="',
      '/ppp secret',
      'add name=remote password="Ppp Secret 2" profile=default-encryption service=l2tp',
      '/radius',
      'add address=10.4.4.4 secret=RosRadius service=login',
      '/snmp community',
      'set [ find default=yes ] name=RosCommunity',
      'add authentication-password=RosAuthPw name=v3user security=private encryption-password=RosEncPw',
      '/user',
      'add name=backup group=read',
    ].join('\n'),
    secrets: ['RosWifiKey1', 'aGVsbG8gd29ybGQgcHJpdmF0ZSBrZXk=', 'Ppp Secret 2', 'RosRadius', 'RosCommunity', 'RosAuthPw', 'RosEncPw', 'v3user'],
    keep: ['name=corp', 'name=wg0', 'name=remote', 'add name=backup group=read', 'supplicant-identity=MikroTik'],
  },
  {
    family: 'Fortinet FortiOS',
    text: [
      'config system admin',
      '    edit "admin"',
      '        set accprofile "super_admin"',
      '        set password ENC SH2nlSm9QL9tapcHPXIqAXvX7vBJuuqu06MCdbS1TF3PtEsp9N1cdCIX7mE=',
      '    next',
      'end',
      'config vpn ipsec phase1-interface',
      '    edit "to-branch"',
      '        set psksecret ENC tY8vQnOiFortiPsk==',
      '    next',
      'end',
      'config wireless-controller vap',
      '    edit "corp"',
      '        set passphrase ENC FortiWifiEnc==',
      '    next',
      'end',
      'config system snmp community',
      '    edit 1',
      '        set name "FortiCommunity"',
      '    next',
      'end',
      'config user radius',
      '    edit "rad"',
      '        set secret ENC FortiRadiusEnc',
      '    next',
      'end',
      'config vpn certificate local',
      '    edit "srv"',
      '        set private-key "-----BEGIN ENCRYPTED PRIVATE KEY-----',
      'MIIFHDBOBgkqhkiG9w0BBQ0wQTApBgkqhkiG9w0BBQwwHAQIFortiKeyMaterial',
      '-----END ENCRYPTED PRIVATE KEY-----"',
      '        set certificate "-----BEGIN CERTIFICATE-----',
      'MIIDPublicCertificateBody',
      '-----END CERTIFICATE-----"',
      '    next',
      'end',
    ].join('\n'),
    secrets: ['SH2nlSm9QL9tapcHPXIqAXvX7vBJuuqu06MCdbS1TF3PtEsp9N1cdCIX7mE=', 'tY8vQnOiFortiPsk==', 'FortiWifiEnc==', 'FortiCommunity', 'FortiRadiusEnc', 'FortiKeyMaterial'],
    keep: ['        set accprofile "super_admin"', '    edit "to-branch"', 'MIIDPublicCertificateBody', '        set password ENC '],
  },
  {
    family: 'Palo Alto PAN-OS',
    text: [
      'mgt-config {',
      '  users {',
      '    admin {',
      '      phash $5$PanosAdminHash;',
      '      permissions { role-based { superuser yes; } }',
      '    }',
      '  }',
      '}',
      'ike { gateway GW1 { authentication { pre-shared-key { key -AQ==PanosPskKey=; } } } }',
      '<entry name="admin"><phash>$5$PanosXmlHash</phash></entry>',
      '<snmp-community-string>public</snmp-community-string><community>PanXmlComm</community>',
    ].join('\n'),
    secrets: ['$5$PanosAdminHash', '-AQ==PanosPskKey=', '$5$PanosXmlHash', 'PanXmlComm'],
    keep: ['      permissions { role-based { superuser yes; } }', '<entry name="admin"><phash>'],
  },
  {
    family: 'OpenWrt UCI',
    text: [
      "package wireless",
      "config wifi-iface 'default_radio0'",
      "\toption ssid 'HomeNet'",
      "\toption encryption 'psk2'",
      "\toption key 'OpenWrtWifiKey'",
      "package network",
      "config interface 'wan'",
      "\toption proto 'pppoe'",
      "\toption username 'isp-user'",
      "\toption password 'IspPassword9'",
      "config interface 'wg0'",
      "\toption private_key 'WgPrivateKeyBase64='",
      "config wireguard_wg0",
      "\toption preshared_key 'WgPresharedKey='",
    ].join('\n'),
    secrets: ['OpenWrtWifiKey', 'IspPassword9', 'WgPrivateKeyBase64=', 'WgPresharedKey='],
    keep: ["\toption ssid 'HomeNet'", "\toption username 'isp-user'", "\toption encryption 'psk2'"],
  },
  {
    family: 'Ubiquiti EdgeOS / VyOS',
    text: [
      "set system login user vyos authentication encrypted-password '$6$VyosHash'",
      "set system login user ops authentication plaintext-password 'VyosPlain'",
      "set vpn ipsec site-to-site peer 203.0.113.5 authentication pre-shared-secret 'VyosPsk'",
      "set service snmp community VyosComm authorization ro",
      "set interfaces wireguard wg0 private-key 'VyosWgKey='",
    ].join('\n'),
    secrets: ['$6$VyosHash', 'VyosPlain', 'VyosPsk', 'VyosComm', 'VyosWgKey='],
    keep: ['set vpn ipsec site-to-site peer 203.0.113.5 authentication pre-shared-secret ', ' authorization ro'],
  },
  {
    family: 'Generic PEM private keys',
    text: ['ip ssh pubkey-chain', '-----BEGIN RSA PRIVATE KEY-----', 'MIIEpAIBAAKCAQEAPemKeyMaterialLine1', 'PemKeyMaterialLine2', '-----END RSA PRIVATE KEY-----', 'hostname after-key'].join('\n'),
    secrets: ['PemKeyMaterialLine1', 'PemKeyMaterialLine2'],
    keep: ['ip ssh pubkey-chain', 'hostname after-key'],
  },
];

describe('configuration secret sanitization', () => {
  for (const f of FIXTURES) {
    it(`redacts every secret of ${f.family} and keeps the rest`, () => {
      const r = sanitizeConfig(f.text, KEY);
      for (const s of f.secrets) expect(r.text, `${f.family}: "${s}" leaked`).not.toContain(s);
      for (const k of f.keep) expect(r.text, `${f.family}: "${k}" lost`).toContain(k);
      expect(r.total).toBeGreaterThanOrEqual(f.secrets.length - 1);
      // Idempotent: sanitizing the sanitized text changes nothing.
      expect(sanitizeConfig(r.text, KEY).text).toBe(r.text);
      // Deterministic for one key; a different key gives different fingerprints.
      expect(sanitizeConfig(f.text, KEY).text).toBe(r.text);
      expect(sanitizeConfig(f.text, OTHER_KEY).text).not.toBe(r.text);
    });
  }

  it('shows a changed secret as a changed fingerprint and keeps the hash of an unchanged one', () => {
    const v1 = normalizeConfig('hostname r1\nsnmp-server community alpha RO\nenable secret 5 $1$aa$bb\n');
    const v2 = normalizeConfig('hostname r1\nsnmp-server community bravo RO\nenable secret 5 $1$aa$bb\n');
    const p1 = prepareConfig(v1.text, KEY);
    const p1again = prepareConfig(v1.text, KEY);
    const p2 = prepareConfig(v2.text, KEY);
    expect(p1again.sha256).toBe(p1.sha256);
    expect(p2.sha256).not.toBe(p1.sha256);
    const l1 = p1.text.split('\n');
    const l2 = p2.text.split('\n');
    expect(l1[1]).toMatch(/^snmp-server community <nigafiy-redacted:hmac=[0-9a-f]{12}> RO$/);
    expect(l1[1]).not.toBe(l2[1]);
    expect(l1[2]).toBe(l2[2]);
    expect(p1.redactions).toMatchObject({ snmp_community: 1, enable_secret: 1 });
    expect(p1.text).toContain(REDACTED_MARK);
  });

  it('redacts the rest of the text when a private key block is not terminated', () => {
    const r = sanitizeConfig('hostname x\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\nmore', KEY);
    expect(r.text).not.toContain('b3BlbnNzaC1rZXktdjEAAAA');
    expect(r.text).toContain('hostname x');
  });
});
