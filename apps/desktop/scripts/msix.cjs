'use strict';
// MSIX packages for the Microsoft Store (docs/operations/microsoft-store.md): the package identity,
// the AppxManifest.xml, the localized strings and the MakeAppx mapping file. Pure functions; the
// command line (scripts/build-msix.cjs) runs the Windows SDK tools.
//
// The identity values come from Partner Center (Product management → Product identity) and are read
// from the environment or from .data/store/identity.json. Nothing here invents a Store identity: a
// build without them stops, unless it is an explicit local test build (--local-test), whose identity
// says "LocalTest" and whose publisher is the subject of the local test certificate.
const path = require('node:path');

/** The two Store products. */
const PRODUCTS = {
  desktop: {
    envName: 'NIGAFIY_STORE_DESKTOP_IDENTITY_NAME',
    jsonKey: 'desktop',
    localTestName: 'Nigafiy.LocalTest.Hub',
    applicationId: 'Nigafiy',
    executable: 'app\\Nigafiy.exe',
    protocol: 'nigafiy',
    icon: 'app-icon.svg',
    strings: {
      'en-US': {
        AppDisplayName: 'Nigafiy',
        AppDescription: 'Nigafiy: see every device on your network, monitor it, protect it and support your company computers.',
        ProtocolName: 'Nigafiy link',
      },
      'ar-SA': {
        // The brand name stays in Latin letters in Arabic text too (docs/architecture/naming.md).
        AppDisplayName: 'Nigafiy',
        AppDescription: 'Nigafiy: رؤية كل جهاز على شبكتك ومراقبته وحمايته ودعم أجهزة شركتك.',
        ProtocolName: 'رابط Nigafiy',
      },
    },
    // MNDP (receive-only, UDP 5678) and the DNS filter (53, off until the owner turns it on) listen on
    // the LAN; domain and private networks only, never public ones. The Sensor is the engine
    // executable run as `nigafiy-engine sensor` (docs/architecture/engine-sensor.md).
    firewall: {
      executable: 'app\\resources\\engine\\nigafiy-engine.exe',
      rules: [
        { protocol: 'UDP', port: 5678 },
        { protocol: 'UDP', port: 53 },
        { protocol: 'TCP', port: 53 },
      ],
    },
  },
  'quick-support': {
    envName: 'NIGAFIY_STORE_QUICK_SUPPORT_IDENTITY_NAME',
    jsonKey: 'quickSupport',
    localTestName: 'Nigafiy.LocalTest.QuickSupport',
    applicationId: 'NigafiyQuickSupport',
    executable: 'nigafiy-support.exe',
    protocol: 'nigafiy-support',
    icon: 'programs/fleet.svg',
    strings: {
      'en-US': {
        AppDisplayName: 'Nigafiy Quick Support',
        AppDescription: 'Nigafiy Quick Support: let your IT contact help you on this computer, once, after you accept.',
        ProtocolName: 'Nigafiy Quick Support link',
      },
      'ar-SA': {
        AppDisplayName: 'Nigafiy الدعم السريع',
        AppDescription: 'Nigafiy الدعم السريع: دع فريق تقنية المعلومات يساعدك على هذا الحاسوب مرة واحدة بعد موافقتك.',
        ProtocolName: 'رابط Nigafiy الدعم السريع',
      },
    },
    firewall: null,
  },
};

const LANGUAGES = ['en-US', 'ar-SA'];
const NAME_RE = /^[A-Za-z0-9.-]{3,50}$/;
const LOCAL_TEST_RE = /localtest/i;

/** "0.1.0" → "0.1.0.0" (the fourth number belongs to the Store and must be 0; the first cannot be 0). */
function storeVersion(version) {
  const m = String(version).match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!m) throw new Error(`version "${version}" is not x.y.z`);
  const parts = m.slice(1, 4).map(Number);
  if (parts.some((n) => n > 65535)) throw new Error(`version "${version}": every number must be at most 65535`);
  if (parts[0] === 0) throw new Error(`version "${version}": the Store does not accept a first number of 0; bump the major version before a Store build`);
  return `${parts.join('.')}.0`;
}

/** Same as storeVersion but allows 0.x for a local test package (never uploaded). */
function localTestVersion(version) {
  const m = String(version).match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new Error(`version "${version}" is not x.y.z`);
  return `${m[1]}.${m[2]}.${m[3]}.0`;
}

/**
 * The identity of one product, from the environment or the JSON file (environment wins).
 * @param {{ product: keyof PRODUCTS, env?: Record<string,string|undefined>, json?: any, localTest?: { publisher: string } | null }} o
 * @returns {{ name: string, publisher: string, publisherDisplayName: string, localTest: boolean }}
 */
function resolveIdentity({ product, env = process.env, json = null, localTest = null }) {
  const p = PRODUCTS[product];
  if (!p) throw new Error(`unknown product "${product}" (desktop or quick-support)`);
  if (localTest) {
    if (!/^CN=/.test(localTest.publisher)) throw new Error('the local test certificate subject must start with CN=');
    return { name: p.localTestName, publisher: localTest.publisher, publisherDisplayName: 'Nigafiy (local test)', localTest: true };
  }
  const fromJson = json?.[p.jsonKey] || {};
  const name = (env[p.envName] || fromJson.identityName || '').trim();
  const publisher = (env.NIGAFIY_STORE_PUBLISHER || fromJson.publisher || json?.publisher || '').trim();
  const publisherDisplayName = (env.NIGAFIY_STORE_PUBLISHER_DISPLAY_NAME || fromJson.publisherDisplayName || json?.publisherDisplayName || '').trim();
  const missing = [];
  if (!name) missing.push(`${p.envName} (Package/Identity/Name)`);
  if (!publisher) missing.push('NIGAFIY_STORE_PUBLISHER (Package/Identity/Publisher, "CN=...")');
  if (!publisherDisplayName) missing.push('NIGAFIY_STORE_PUBLISHER_DISPLAY_NAME (Package/Properties/PublisherDisplayName)');
  if (missing.length) {
    throw new Error(
      `Store identity not configured: ${missing.join(', ')}. Copy them from Partner Center → the product → Product management → Product identity into the environment or .data/store/identity.json (docs/operations/microsoft-store.md). For a package to try on this computer only, use --local-test.`,
    );
  }
  if (!NAME_RE.test(name)) throw new Error(`Package/Identity/Name "${name}" must be 3–50 letters, digits, dots or dashes`);
  if (LOCAL_TEST_RE.test(name)) throw new Error(`Package/Identity/Name "${name}" is the local test identity, not a Partner Center one`);
  if (!/^CN=/.test(publisher) || publisher.length > 8192) throw new Error(`Publisher "${publisher}" must be the "CN=..." value from Partner Center`);
  return { name, publisher, publisherDisplayName, localTest: false };
}

/** XML text escaping (attribute-safe). */
function xml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * AppxManifest.xml for one product.
 * @param {{ product: keyof PRODUCTS, identity: ReturnType<typeof resolveIdentity>, version: string, arch?: string }} o
 */
function renderManifest({ product, identity, version, arch = 'x64' }) {
  const p = PRODUCTS[product];
  const firewall = p.firewall
    ? `
  <Extensions>
    <desktop2:Extension Category="windows.firewallRules">
      <desktop2:FirewallRules Executable="${xml(p.firewall.executable)}">
${p.firewall.rules.map((r) => `        <desktop2:Rule Direction="in" IPProtocol="${r.protocol}" LocalPortMin="${r.port}" LocalPortMax="${r.port}" Profile="domainAndPrivate"/>`).join('\n')}
      </desktop2:FirewallRules>
    </desktop2:Extension>
  </Extensions>`
    : '';
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by apps/desktop/scripts/build-msix.cjs (docs/operations/microsoft-store.md). -->
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:uap3="http://schemas.microsoft.com/appx/manifest/uap/windows10/3"
  xmlns:desktop="http://schemas.microsoft.com/appx/manifest/desktop/windows10"
  xmlns:desktop2="http://schemas.microsoft.com/appx/manifest/desktop/windows10/2"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap uap3 desktop desktop2 rescap">
  <Identity Name="${xml(identity.name)}" Publisher="${xml(identity.publisher)}" Version="${xml(version)}" ProcessorArchitecture="${xml(arch)}"/>
  <Properties>
    <DisplayName>ms-resource:AppDisplayName</DisplayName>
    <PublisherDisplayName>${xml(identity.publisherDisplayName)}</PublisherDisplayName>
    <Logo>Assets\\StoreLogo.png</Logo>
    <Description>ms-resource:AppDescription</Description>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26100.0"/>
  </Dependencies>
  <Resources>
${LANGUAGES.map((l) => `    <Resource Language="${l}"/>`).join('\n')}
  </Resources>
  <Applications>
    <Application Id="${xml(p.applicationId)}" Executable="${xml(p.executable)}" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="ms-resource:AppDisplayName" Description="ms-resource:AppDescription" BackgroundColor="transparent" Square150x150Logo="Assets\\Square150x150Logo.png" Square44x44Logo="Assets\\Square44x44Logo.png">
        <uap:DefaultTile Wide310x150Logo="Assets\\Wide310x150Logo.png"/>
      </uap:VisualElements>
      <Extensions>
        <uap3:Extension Category="windows.protocol">
          <uap3:Protocol Name="${xml(p.protocol)}" Parameters="&quot;%1&quot;">
            <uap:DisplayName>ms-resource:ProtocolName</uap:DisplayName>
          </uap3:Protocol>
        </uap3:Extension>
      </Extensions>
    </Application>
  </Applications>${firewall}
  <Capabilities>
    <rescap:Capability Name="runFullTrust"/>
  </Capabilities>
</Package>
`;
}

/** One Resources.resw (UTF-8) with the product's strings in a language. */
function renderResw(product, language) {
  const strings = PRODUCTS[product].strings[language];
  const data = Object.entries(strings)
    .map(([k, v]) => `  <data name="${xml(k)}" xml:space="preserve">\n    <value>${xml(v)}</value>\n  </data>`)
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<root>
  <resheader name="resmimetype"><value>text/microsoft-resx</value></resheader>
  <resheader name="version"><value>2.0</value></resheader>
  <resheader name="reader"><value>System.Resources.ResXResourceReader, System.Windows.Forms, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089</value></resheader>
  <resheader name="writer"><value>System.Resources.ResXResourceWriter, System.Windows.Forms, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089</value></resheader>
${data}
</root>
`;
}

/** The Store's logo sizes (scale 100). */
const ASSETS = [
  { file: 'StoreLogo.png', width: 50, height: 50 },
  { file: 'Square44x44Logo.png', width: 44, height: 44 },
  { file: 'Square150x150Logo.png', width: 150, height: 150 },
  { file: 'Wide310x150Logo.png', width: 310, height: 150 },
];

/**
 * MakeAppx's mapping file: every file of the app folder under `prefix` (desktop: "app"), plus the
 * staged manifest, resources.pri and assets.
 * @param {{ files: { source: string, target: string }[] }} o
 */
function renderMapping({ files }) {
  const lines = ['[Files]'];
  for (const f of files) {
    if (f.source.includes('"') || f.target.includes('"')) throw new Error(`a path contains a quote: ${f.source}`);
    lines.push(`"${f.source}" "${f.target}"`);
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** Package files of an app folder: `<dir>\x\y` → `<prefix>\x\y`. */
function appFiles(dir, relFiles, prefix) {
  return relFiles.map((rel) => ({ source: path.win32.join(dir, rel), target: prefix ? path.win32.join(prefix, rel) : rel }));
}

/** The output file name: the local test build says so. */
function outputName({ product, version, localTest }) {
  const base = product === 'desktop' ? 'Nigafiy' : 'Nigafiy-Quick-Support';
  return `${base}-${version}-x64${localTest ? '-local-test' : ''}.msix`;
}

module.exports = { PRODUCTS, LANGUAGES, ASSETS, storeVersion, localTestVersion, resolveIdentity, renderManifest, renderResw, renderMapping, appFiles, outputName, xml };
