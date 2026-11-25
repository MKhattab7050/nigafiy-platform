import type {
  EndpointCapabilityItem,
  EndpointComplianceCheck,
  EndpointComplianceItem,
  EndpointComplianceStatus,
  EndpointPlatform,
  EndpointSecurityEvidence,
  EndpointSecurityPosture,
} from '@nigafiy/shared-types';

export function inferPlatformFromOs(osRaw?: string | null, current?: EndpointPlatform): EndpointPlatform {
  const s = (osRaw ?? '').toLowerCase();
  if (s.includes('android')) return 'android';
  // darwin before win: 'darwin' contains 'win'.
  if (s.includes('darwin') || s.includes('mac')) return 'macos';
  if (s.includes('win')) return 'windows';
  if (s.includes('linux') || s.includes('ubuntu') || s.includes('debian') || s.includes('rhel') || s.includes('centos')) return 'linux';
  return current ?? 'windows';
}

// ── Evidence-only compliance ────────────────────────────────────────────────────────────────
// Every item a platform needs is judged from the agent's evidence (command, value, time). An item
// with no measurement is "unknown" with the reason, and an endpoint is "compliant" only when every
// required item was measured and passed. Order of severity: non_compliant > attention > unknown > compliant.

interface CheckDef {
  label_en: string;
  label_ar: string;
  /** What a failed measurement of this item means for the endpoint. */
  failVerdict: 'attention' | 'non_compliant';
}

export const COMPLIANCE_CHECKS: Record<EndpointComplianceCheck, CheckDef> = {
  firewall: { label_en: 'Host firewall', label_ar: 'جدار الحماية على الجهاز', failVerdict: 'attention' },
  antivirus: { label_en: 'Antivirus protection', label_ar: 'الحماية من الفيروسات', failVerdict: 'non_compliant' },
  disk_encryption: { label_en: 'Disk encryption', label_ar: 'تشفير القرص', failVerdict: 'attention' },
  os_updates: { label_en: 'OS / security updates', label_ar: 'تحديثات النظام والأمان', failVerdict: 'attention' },
  sip: { label_en: 'System Integrity Protection', label_ar: 'حماية سلامة النظام (SIP)', failVerdict: 'non_compliant' },
  gatekeeper: { label_en: 'Gatekeeper', label_ar: 'التحقق من التطبيقات (Gatekeeper)', failVerdict: 'attention' },
  disk_space: { label_en: 'Free disk space', label_ar: 'المساحة الحرة على القرص', failVerdict: 'attention' },
  local_admins: { label_en: 'Local administrators', label_ar: 'المسؤولون المحليون', failVerdict: 'attention' },
  // Android (docs/features/android.md §1): measured by the Android agent with framework APIs.
  screen_lock: { label_en: 'Screen lock', label_ar: 'قفل الشاشة', failVerdict: 'non_compliant' },
  developer_options: { label_en: 'Developer options', label_ar: 'خيارات المطوّر', failVerdict: 'attention' },
  usb_debugging: { label_en: 'USB debugging', label_ar: 'تصحيح أخطاء USB', failVerdict: 'attention' },
  unknown_sources: { label_en: 'Install unknown apps', label_ar: 'تثبيت التطبيقات غير المعروفة', failVerdict: 'attention' },
};

/** The items an endpoint of each platform must pass to be called compliant. */
export const REQUIRED_CHECKS: Record<EndpointPlatform, EndpointComplianceCheck[]> = {
  windows: ['firewall', 'antivirus', 'disk_encryption', 'os_updates', 'disk_space'],
  linux: ['firewall', 'disk_encryption', 'os_updates', 'disk_space'],
  macos: ['firewall', 'disk_encryption', 'os_updates', 'sip', 'gatekeeper', 'disk_space'],
  android: ['screen_lock', 'disk_encryption', 'os_updates', 'developer_options', 'usb_debugging', 'unknown_sources', 'disk_space'],
};

const RANK: Record<EndpointComplianceStatus, number> = { compliant: 0, unknown: 1, attention: 2, non_compliant: 3 };
const LEGACY_SOURCE = 'agent posture field (no per-item evidence)';
// First-strong isolates keep Windows volume names, paths and profile names readable inside Arabic text.
const iso = (s: string) => `⁨${s}⁩`;

/** Evidence for one item: the agent's checks, or (older agents) its yes/no summary fields. */
function evidenceFor(key: EndpointComplianceCheck, sec: EndpointSecurityPosture, diskUsedPct: number | null | undefined): EndpointSecurityEvidence[] {
  const measuredAt = sec.measured_at ?? '';
  if (key === 'disk_space') {
    if (typeof diskUsedPct !== 'number') return [];
    return [
      {
        check: 'disk_space',
        subject: 'Fullest volume',
        state: diskUsedPct >= 92 ? 'fail' : 'pass',
        value: `${diskUsedPct.toFixed(1)}% used`,
        source: 'agent disk telemetry',
        measured_at: measuredAt,
        ...(diskUsedPct >= 92 ? { reason: 'at or above the 92% threshold' } : {}),
      },
    ];
  }
  const fromChecks = (sec.checks ?? []).filter((e) => e.check === key);
  if (fromChecks.length > 0) return fromChecks;
  const legacy = (field: string, value: boolean): EndpointSecurityEvidence => ({
    check: key,
    subject: 'Agent report',
    state: value ? 'pass' : 'fail',
    value: `${field}=${value}`,
    source: LEGACY_SOURCE,
    measured_at: measuredAt,
  });
  switch (key) {
    case 'firewall':
      return typeof sec.firewall_enabled === 'boolean' ? [legacy('firewall_enabled', sec.firewall_enabled)] : [];
    case 'antivirus':
      return typeof sec.antivirus_enabled === 'boolean' ? [legacy('antivirus_enabled', sec.antivirus_enabled)] : [];
    case 'disk_encryption':
      return typeof sec.disk_encrypted === 'boolean' ? [legacy('disk_encrypted', sec.disk_encrypted)] : [];
    case 'os_updates':
      if (typeof sec.pending_updates !== 'number') return [];
      return [
        {
          check: 'os_updates',
          subject: 'Agent report',
          state: sec.pending_updates > 0 ? 'fail' : 'pass',
          value: `pending_updates=${sec.pending_updates}`,
          source: LEGACY_SOURCE,
          measured_at: measuredAt,
          count: sec.pending_updates,
        },
      ];
    default:
      return [];
  }
}

function subjects(list: EndpointSecurityEvidence[]): string {
  return [...new Set(list.map((e) => e.subject))].join(', ');
}

function judgeItem(key: EndpointComplianceCheck, evidence: EndpointSecurityEvidence[]): EndpointComplianceItem {
  const def = COMPLIANCE_CHECKS[key];
  const base = { key, label_en: def.label_en, label_ar: def.label_ar, evidence };
  const by = (s: EndpointSecurityEvidence['state']) => evidence.filter((e) => e.state === s);
  const fails = by('fail');
  const warns = by('warn');
  const unknowns = by('unknown');
  const passes = by('pass');
  const legacyOnly = (list: EndpointSecurityEvidence[]) => list.every((e) => e.source === LEGACY_SOURCE);

  if (fails.length > 0) {
    const s = subjects(fails);
    let en = `${def.label_en} failed: ${s}`;
    let ar = `${def.label_ar}: فشل التحقق (${iso(s)})`;
    switch (key) {
      case 'firewall':
        [en, ar] = legacyOnly(fails) ? ['Host firewall is reported off', 'جدار الحماية على الجهاز متوقف'] : [`Host firewall is off: ${s}`, `جدار الحماية متوقف: ${iso(s)}`];
        break;
      case 'antivirus':
        [en, ar] = legacyOnly(fails)
          ? ['Antivirus protection is reported disabled', 'مكافح الفيروسات معطّل']
          : [`No active antivirus protection: ${s}`, `لا توجد حماية فعّالة من الفيروسات: ${iso(s)}`];
        break;
      case 'disk_encryption':
        [en, ar] = [`Disk encryption is off: ${s}`, `تشفير القرص غير مفعّل: ${iso(s)}`];
        break;
      case 'os_updates': {
        const patch = fails.find((e) => e.source === 'Build.VERSION.SECURITY_PATCH');
        if (patch) {
          [en, ar] = [`Android security patch is too old: ${patch.value}`, `تصحيح أمان Android قديم جداً: ${iso(patch.value)}`];
          break;
        }
        const n = fails.reduce((sum, e) => sum + (e.count ?? 0), 0);
        [en, ar] = [`${n} OS/security update(s) pending`, `توجد ${iso(String(n))} تحديثات نظام/أمان معلّقة`];
        break;
      }
      case 'sip':
        [en, ar] = ['System Integrity Protection is disabled', 'حماية سلامة النظام (SIP) معطّلة'];
        break;
      case 'gatekeeper':
        [en, ar] = ['Gatekeeper is disabled', 'التحقق من التطبيقات (Gatekeeper) معطّل'];
        break;
      case 'screen_lock':
        [en, ar] = ['No screen lock (PIN, pattern or password) protects the phone', 'لا يحمي الهاتف أي قفل شاشة (رمز أو نمط أو كلمة مرور)'];
        break;
      case 'developer_options':
        [en, ar] = ['Developer options are switched on', 'خيارات المطوّر مفعّلة'];
        break;
      case 'usb_debugging':
        [en, ar] = ['USB debugging (adb) is switched on', 'تصحيح أخطاء USB (adb) مفعّل'];
        break;
      case 'unknown_sources': {
        const apps = fails.map((e) => e.value).join(', ');
        [en, ar] = [`Apps allowed to install unknown apps: ${apps}`, `تطبيقات مسموح لها بتثبيت تطبيقات غير معروفة: ${iso(apps)}`];
        break;
      }
      case 'disk_space': {
        const pct = fails[0]!.value.replace(/ used$/, '');
        [en, ar] = [`Disk usage is critically high (${pct})`, `امتلاء القرص وصل لمستوى حرج (${iso(pct)})`];
        break;
      }
    }
    return { ...base, verdict: def.failVerdict, reason_en: en, reason_ar: ar };
  }
  if (warns.length > 0) {
    const s = subjects(warns);
    return { ...base, verdict: 'attention', reason_en: `${def.label_en} needs attention: ${s}`, reason_ar: `${def.label_ar} يحتاج إلى متابعة: ${iso(s)}` };
  }
  if (unknowns.length > 0 || passes.length === 0) {
    const why = unknowns[0]?.reason?.trim() || (evidence.length === 0 ? 'not reported by the agent' : 'no judging measurement');
    return {
      ...base,
      verdict: 'unknown',
      reason_en: `${def.label_en} not measured: ${why}`,
      reason_ar: `لم يتم قياس ${def.label_ar}: ${iso(why)}`,
    };
  }
  const s = subjects(passes);
  return { ...base, verdict: 'compliant', reason_en: `${def.label_en} verified: ${s}`, reason_ar: `${def.label_ar}: تم التحقق (${iso(s)})` };
}

/** The account part of a member name ("PC\\alice" → "alice"), lower case. */
const accountName = (s: string) => s.trim().toLowerCase().split('\\').pop()!;

/**
 * Local administrators (names only). With an allowed list in the endpoint policy, every member not
 * on it is a warning; without one the members are shown and not judged (judged: false), so the
 * endpoint's verdict never depends on a list nobody set. A list the agent could not read is
 * "not measured", judged or not.
 */
function judgeLocalAdmins(evidence: EndpointSecurityEvidence[], allowed: string[] | undefined): EndpointComplianceItem {
  const def = COMPLIANCE_CHECKS.local_admins;
  const base = { key: 'local_admins' as const, label_en: def.label_en, label_ar: def.label_ar };
  const judged = Boolean(allowed && allowed.length > 0);
  const unknowns = evidence.filter((e) => e.state === 'unknown');
  const members = evidence.filter((e) => e.state === 'info' && e.value !== 'no members');
  if (evidence.length === 0 || (unknowns.length > 0 && members.length === 0)) {
    const why = unknowns[0]?.reason?.trim() || 'not reported by the agent';
    return { ...base, evidence, judged, verdict: 'unknown', reason_en: `${def.label_en} not measured: ${why}`, reason_ar: `لم يتم قياس ${def.label_ar}: ${iso(why)}` };
  }
  const names = members.map((e) => e.subject);
  if (!judged) {
    const list = names.join(', ') || 'none';
    return {
      ...base,
      evidence,
      judged: false,
      verdict: unknowns.length > 0 ? 'unknown' : 'compliant',
      reason_en: `${def.label_en}: ${list} (shown only: no allowed list is set in the policy)`,
      reason_ar: `${def.label_ar}: ${iso(list)} (للعرض فقط: لم تُحدَّد قائمة مسموح بها في السياسة)`,
    };
  }
  // "DOMAIN\\name" must match exactly; a bare "name" matches that account on any domain or computer.
  const full = new Set(allowed!.map((a) => a.trim().toLowerCase()));
  const bare = new Set(allowed!.filter((a) => !a.includes('\\')).map((a) => a.trim().toLowerCase()));
  const allowedMember = (m: string) => full.has(m.trim().toLowerCase()) || bare.has(accountName(m));
  const judgedEvidence = evidence.map((e) =>
    e.state === 'info' && e.value !== 'no members'
      ? allowedMember(e.subject)
        ? { ...e, state: 'pass' as const }
        : { ...e, state: 'warn' as const, reason: 'not on the allowed list of local administrators' }
      : e,
  );
  const extra = judgedEvidence.filter((e) => e.state === 'warn').map((e) => e.subject);
  if (extra.length > 0) {
    const s = extra.join(', ');
    return { ...base, evidence: judgedEvidence, judged: true, verdict: def.failVerdict, reason_en: `Unexpected local administrators: ${s}`, reason_ar: `مسؤولون محليون غير متوقَّعين: ${iso(s)}` };
  }
  if (unknowns.length > 0) {
    const why = unknowns[0]!.reason ?? 'part of the list was not reported';
    return { ...base, evidence: judgedEvidence, judged: true, verdict: 'unknown', reason_en: `${def.label_en} not fully measured: ${why}`, reason_ar: `لم يتم قياس ${def.label_ar} بالكامل: ${iso(why)}` };
  }
  const s = names.join(', ') || 'none';
  return { ...base, evidence: judgedEvidence, judged: true, verdict: 'compliant', reason_en: `${def.label_en} verified: ${s}`, reason_ar: `${def.label_ar}: تم التحقق (${iso(s)})` };
}

/** Judges every compliance item of the platform (plus any extra item the agent measured). */
export function evaluateComplianceItems(params: {
  platform: EndpointPlatform;
  diskUsedPct?: number | null;
  security?: EndpointSecurityPosture | null;
  allowedLocalAdmins?: string[] | undefined;
}): EndpointComplianceItem[] {
  const sec = params.security ?? {};
  const keys = new Set<EndpointComplianceCheck>(REQUIRED_CHECKS[params.platform] ?? []);
  for (const e of sec.checks ?? []) if (e.check in COMPLIANCE_CHECKS) keys.add(e.check);
  // An allowed list makes local administrators a required item ("not measured" when the agent cannot).
  if (params.allowedLocalAdmins && params.allowedLocalAdmins.length > 0) keys.add('local_admins');
  return [...keys].map((key) =>
    key === 'local_admins'
      ? judgeLocalAdmins((sec.checks ?? []).filter((e) => e.check === 'local_admins'), params.allowedLocalAdmins)
      : judgeItem(key, evidenceFor(key, sec, params.diskUsedPct)),
  );
}

export function evaluateCompliance(params: {
  platform: EndpointPlatform;
  diskUsedPct?: number | null;
  security?: EndpointSecurityPosture | null;
  allowedLocalAdmins?: string[] | undefined;
}): { status: EndpointComplianceStatus; reasons: string[]; items: EndpointComplianceItem[] } {
  const items = evaluateComplianceItems(params);
  let status: EndpointComplianceStatus = 'compliant';
  for (const item of items) if (item.judged !== false && RANK[item.verdict] > RANK[status]) status = item.verdict;
  // Never "compliant" without a single measurement (e.g. a platform with no required items).
  if (items.length === 0) status = 'unknown';
  const reasons = items
    .filter((i) => i.verdict !== 'compliant' && i.judged !== false)
    .sort((a, b) => RANK[b.verdict] - RANK[a.verdict])
    .map((i) => i.reason_en);
  return { status, reasons, items };
}

/**
 * What the agent can do on each platform, stated as plainly as the agent code supports it.
 * "tested" is reserved for what tests/real-windows-agent.test.ts runs against the real agent binary.
 */
export function buildCapabilities(platform: EndpointPlatform): EndpointCapabilityItem[] {
  if (platform === 'windows') {
    return [
      {
        key: 'telemetry_inventory',
        category: 'inventory',
        label_en: 'Hardware, CPU/RAM/Disk & Network Telemetry',
        label_ar: 'مراقبة العتاد والمعالج والرام والأقراص والشبكة',
        state: 'tested',
        enabled: true,
        reason_en: 'Collected natively by the Go Endpoint Agent via Win32 / CIM.',
        reason_ar: 'يتم جمعها مباشرة عبر وكيل Go باستخدام واجهات Win32 / CIM.',
      },
      {
        key: 'processes_control',
        category: 'remote_control',
        label_en: 'Process Monitoring & Remote Termination',
        label_ar: 'مراقبة العمليات وإنهاؤها عن بُعد',
        state: 'implemented',
        enabled: true,
        reason_en: 'Full process list with PID, RAM/CPU usage and remote taskkill.',
        reason_ar: 'قائمة العمليات الكاملة مع استهلاك الرام والمعالج وإمكانية إنهاء أي عملية.',
      },
      {
        key: 'services_control',
        category: 'remote_control',
        label_en: 'Windows Service Management (Start / Stop / Restart)',
        label_ar: 'إدارة خدمات النظام (تشغيل / إيقاف / إعادة تشغيل)',
        state: 'implemented',
        enabled: true,
        reason_en: 'Reads service states and executes validated Start/Stop/Restart commands.',
        reason_ar: 'قراءة حالة جميع خدمات Windows والتحكم بها عن بُعد.',
      },
      {
        key: 'network_connections',
        category: 'inventory',
        label_en: 'Active TCP/UDP Connections & Listening Ports',
        label_ar: 'الاتصالات الشبكية النشطة والمنافذ المفتوحة',
        state: 'implemented',
        enabled: true,
        reason_en: 'Maps active sockets to owning PID and process name.',
        reason_ar: 'ربط كافة الاتصالات المفتوحة برقم واسم العملية.',
      },
      {
        key: 'remote_file_manager',
        category: 'file_management',
        label_en: 'Enterprise Remote File Manager',
        label_ar: 'مدير الملفات عن بُعد',
        state: 'tested',
        enabled: true,
        reason_en: 'Browse drives, search, upload/download with SHA-256 verification, rename, copy, move and delete with protected-path guards.',
        reason_ar: 'تصفح الأقراص والمجلدات، رفع وتحميل الملفات مع التحقق من البصمة، النسخ والنقل والحذف المحمي.',
      },
      {
        key: 'remote_desktop',
        category: 'remote_control',
        label_en: 'Live Remote Desktop & Mouse/Keyboard Control',
        label_ar: 'سطح المكتب البعيد والتحكم بالماوس ولوحة المفاتيح',
        state: 'implemented',
        enabled: true,
        reason_en: 'Captures live display frames via Win32 GDI and injects mouse/keyboard events.',
        reason_ar: 'بث مباشر للشاشة عبر Win32 GDI مع تحكم تفاعلي بالماوس ولوحة المفاتيح.',
      },
      {
        key: 'software_management',
        category: 'software',
        label_en: 'Software Inventory & Winget Package Management',
        label_ar: 'جرد البرامج وتثبيت/إزالة الحزم عبر Winget',
        state: 'implemented',
        enabled: true,
        reason_en: 'Reads installed registry packages and runs approved winget install/upgrade/uninstall workflows.',
        reason_ar: 'جرد البرامج المثبتة وتنفيذ أوامر التثبيت والتحديث والحذف المعتمدة.',
      },
      {
        key: 'diagnostics_logs',
        category: 'remote_control',
        label_en: 'Authorized Diagnostic Terminal & Windows Event Logs',
        label_ar: 'طرفية التشخيص المعتمدة وسجلات أحداث النظام',
        state: 'implemented',
        enabled: true,
        reason_en: 'Runs approved diagnostic tools (ipconfig, route, arp, netstat, systeminfo, gpresult) and fetches Windows Event Logs.',
        reason_ar: 'تشغيل أدوات تشخيص الشبكة والنظام المعتمدة وجلب سجلات أحداث Windows.',
      },
      {
        key: 'power_session',
        category: 'remote_control',
        label_en: 'Power & Session Controls (Lock, Logoff, Restart, Shutdown, Notice)',
        label_ar: 'التحكم بالطاقة والجلسة (قفل، خروج، إعادة تشغيل، إيقاف، رسائل)',
        state: 'implemented',
        enabled: true,
        reason_en: 'Supported on enrolled Windows workstations and servers with role-based checks.',
        reason_ar: 'مدعوم بالكامل مع التحقق من صلاحيات المشرف.',
      },
      {
        key: 'security_compliance',
        category: 'inventory',
        label_en: 'Security Compliance Evidence (Firewall profiles, Antivirus, BitLocker, Windows Update)',
        label_ar: 'أدلة الامتثال الأمني (ملفات جدار الحماية، مكافحة الفيروسات، BitLocker، تحديثات Windows)',
        state: 'implemented',
        enabled: true,
        reason_en:
          'Reads all three firewall profiles (Get-NetFirewallProfile, registry fallback), every antivirus registered in Security Center plus Defender status, BitLocker per fixed volume (needs the agent to run elevated, otherwise unknown) and the Windows Update pending count.',
        reason_ar:
          'يقرأ ملفات جدار الحماية الثلاثة، وكل برامج مكافحة الفيروسات المسجلة وحالة Defender، وحالة BitLocker لكل قرص ثابت (يتطلب صلاحيات المسؤول) وعدد تحديثات Windows المعلّقة.',
      },
    ];
  }

  if (platform === 'linux') {
    return [
      {
        key: 'telemetry_inventory',
        category: 'inventory',
        label_en: 'Hardware, /proc CPU/RAM/Disk & Network Telemetry',
        label_ar: 'مراقبة العتاد والمعالج والرام والأقراص والشبكة',
        state: 'implemented',
        enabled: true,
        reason_en: 'Collected from /proc/meminfo, /proc/uptime, df and net.Interfaces.',
        reason_ar: 'يتم جمعها من ملفات النظام /proc وأدوات الشبكة في Linux.',
      },
      {
        key: 'processes_control',
        category: 'remote_control',
        label_en: 'Process Monitoring & Remote Kill',
        label_ar: 'مراقبة العمليات وإنهاؤها عن بُعد',
        state: 'implemented',
        enabled: true,
        reason_en: 'Collects processes via ps and terminates via kill.',
        reason_ar: 'عرض العمليات الجارية وإنهاؤها عن بُعد.',
      },
      {
        key: 'services_control',
        category: 'remote_control',
        label_en: 'Systemd Service Management',
        label_ar: 'إدارة خدمات Systemd',
        state: 'implemented',
        enabled: true,
        reason_en: 'Lists systemd service units and executes systemctl start/stop/restart.',
        reason_ar: 'قراءة والتحكم بخدمات systemd عن بُعد.',
      },
      {
        key: 'network_connections',
        category: 'inventory',
        label_en: 'Active TCP/UDP Connections',
        label_ar: 'الاتصالات الشبكية النشطة',
        state: 'implemented',
        enabled: true,
        reason_en: 'Parses active sockets and maps to process IDs.',
        reason_ar: 'عرض المنافذ والاتصالات النشطة.',
      },
      {
        key: 'remote_file_manager',
        category: 'file_management',
        label_en: 'Enterprise Remote File Manager',
        label_ar: 'مدير الملفات عن بُعد',
        state: 'implemented',
        enabled: true,
        reason_en: 'Full POSIX filesystem browsing, transfers and protected-path guards (/etc/shadow, /proc, /boot).',
        reason_ar: 'تصفح ونقل الملفات مع حماية مسارات النظام الحساسة.',
      },
      {
        key: 'remote_desktop',
        category: 'remote_control',
        label_en: 'Remote Desktop (X11 and Wayland)',
        label_ar: 'سطح المكتب البعيد لـ Linux',
        state: 'requires_permissions',
        enabled: true,
        reason_en: 'X11: scrot, gnome-screenshot or ImageMagick for capture and xdotool for input. Wayland: the desktop portal (xdg-desktop-portal), which asks the signed-in user to allow screenshots and remote interaction.',
        reason_ar: 'في X11 يتطلب scrot أو gnome-screenshot و xdotool. في Wayland يمر الالتقاط والتحكم عبر بوابة سطح المكتب (xdg-desktop-portal) التي تطلب موافقة المستخدم.',
      },
      {
        key: 'software_management',
        category: 'software',
        label_en: 'Package Inventory (dpkg/rpm) & APT / DNF / YUM / zypper Management',
        label_ar: 'جرد وإدارة حزم البرامج (dpkg / rpm / apt / dnf / yum / zypper)',
        state: 'implemented',
        enabled: true,
        reason_en: 'Queries dpkg-query or rpm; detects apt-get, dnf, zypper or yum and runs approved install/upgrade/remove actions with the package name after "--".',
        reason_ar: 'جرد الحزم المثبتة، واكتشاف مدير الحزم (apt-get أو dnf أو zypper أو yum) وتنفيذ التثبيت أو التحديث أو الحذف المعتمد.',
      },
      {
        key: 'diagnostics_logs',
        category: 'remote_control',
        label_en: 'Authorized Diagnostics & Systemd Journal Logs',
        label_ar: 'التشخيص المعتمد وسجلات Journalctl',
        state: 'implemented',
        enabled: true,
        reason_en: 'Runs ip addr, ip route, arp, uname, df, uptime and fetches journalctl logs.',
        reason_ar: 'تشغيل أدوات تشخيص الشبكة وجلب سجلات journalctl.',
      },
      {
        key: 'power_session',
        category: 'remote_control',
        label_en: 'Power & Session Controls (Lock, Sign out, Restart, Shutdown, Notice)',
        label_ar: 'التحكم بالطاقة والجلسة (قفل، خروج، إعادة تشغيل، إيقاف، رسائل)',
        state: 'requires_permissions',
        enabled: true,
        reason_en:
          'Lock and sign-out use loginctl lock-session / terminate-session on the active graphical session (the desktop environment performs the lock). Notices use notify-send in the user\'s session and fall back to wall, saying which was used. Needs the agent to run as root.',
        reason_ar:
          'القفل وتسجيل الخروج عبر loginctl على جلسة سطح المكتب النشطة. الرسائل تظهر عبر notify-send في جلسة المستخدم، ومع تعذّرها تُرسل عبر wall مع ذكر الطريقة المستخدمة. يتطلب تشغيل الوكيل بصلاحية root.',
      },
      {
        key: 'security_compliance',
        category: 'inventory',
        label_en: 'Security Compliance Evidence (ufw / firewalld / nftables, LUKS, security updates)',
        label_ar: 'أدلة الامتثال الأمني (جدار الحماية، تشفير LUKS، تحديثات الأمان)',
        state: 'requires_permissions',
        enabled: true,
        reason_en:
          'Reads ufw status, firewall-cmd --state and nft list ruleset, lsblk (dm-crypt under each mount) and apt-get -s upgrade / dnf or yum updateinfo / zypper list-patches. ufw and nft need root; anything unreadable is reported as unknown with the reason.',
        reason_ar:
          'يقرأ حالة ufw و firewalld و nftables، وطبقة dm-crypt تحت كل نقطة تحميل، وتحديثات الأمان المعلّقة. بعض الأوامر تتطلب root؛ وما يتعذّر قراءته يُعرض كغير معروف مع السبب.',
      },
    ];
  }

  if (platform === 'android') return androidCapabilities();
  if (platform === 'macos') {
    return [
      {
        key: 'telemetry_inventory',
        category: 'inventory',
        label_en: 'macOS Hardware & Resource Telemetry',
        label_ar: 'مراقبة موارد وعتاد macOS',
        state: 'implemented',
        enabled: true,
        reason_en: 'Collected via Go Endpoint Agent on macOS.',
        reason_ar: 'يتم جمعها عبر وكيل Go على أجهزة macOS.',
      },
      {
        key: 'processes_control',
        category: 'remote_control',
        label_en: 'Process Monitoring & Termination',
        label_ar: 'مراقبة العمليات وإنهاؤها',
        state: 'implemented',
        enabled: true,
        reason_en: 'Lists processes via ps and terminates authorized PIDs.',
        reason_ar: 'عرض العمليات الجارية وإنهاؤها عن بُعد.',
      },
      {
        key: 'services_control',
        category: 'remote_control',
        label_en: 'Launchd Service Management',
        label_ar: 'إدارة خدمات Launchd',
        state: 'implemented',
        enabled: true,
        reason_en: 'Reads launchctl services and runs launchctl start/stop/kickstart.',
        reason_ar: 'قراءة وإدارة خدمات launchctl في macOS.',
      },
      {
        key: 'remote_file_manager',
        category: 'file_management',
        label_en: 'Remote File Manager (TCC Scoped)',
        label_ar: 'مدير الملفات عن بُعد (ضمن صلاحيات TCC)',
        state: 'requires_permissions',
        enabled: true,
        reason_en: 'Folders protected by macOS privacy controls need Full Disk Access granted to the agent; /System and Keychains are blocked.',
        reason_ar: 'يتطلب صلاحية Full Disk Access في macOS للوصول للمجلدات المحمية.',
      },
      {
        key: 'remote_desktop',
        category: 'remote_control',
        label_en: 'Remote Desktop (screen and input)',
        label_ar: 'سطح المكتب البعيد لـ macOS (الشاشة والتحكم)',
        state: 'requires_permissions',
        enabled: true,
        reason_en: 'Screen viewing needs the Screen Recording permission granted to the agent; mouse and keyboard control needs the Accessibility permission (the console shows both).',
        reason_ar: 'عرض الشاشة يتطلب صلاحية تسجيل الشاشة، والتحكم بالماوس ولوحة المفاتيح يتطلب صلاحية تسهيلات الاستخدام (تظهر الحالتان في وحدة التحكم).',
      },
      {
        key: 'software_management',
        category: 'software',
        label_en: 'Application Bundles (/Applications) & Homebrew',
        label_ar: 'جرد التطبيقات وإدارة حزم Homebrew',
        state: 'implemented',
        enabled: true,
        reason_en: 'Inventories /Applications/*.app and Homebrew packages.',
        reason_ar: 'جرد تطبيقات macOS وحزم Homebrew.',
      },
      {
        key: 'diagnostics_logs',
        category: 'remote_control',
        label_en: 'Authorized Diagnostics & Unified Log',
        label_ar: 'التشخيص وسجل النظام الموحد',
        state: 'implemented',
        enabled: true,
        reason_en: 'Runs ifconfig, netstat -rn, arp, uname and fetches macOS unified logs.',
        reason_ar: 'تشغيل أوامر فحص الشبكة وجلب سجلات macOS.',
      },
      {
        key: 'power_session',
        category: 'remote_control',
        label_en: 'Lock, Sign out, Restart, Shutdown & Notices',
        label_ar: 'القفل وتسجيل الخروج وإعادة التشغيل والإيقاف والرسائل',
        state: 'partially_supported',
        enabled: true,
        reason_en:
          'Runs in the console user\'s session (launchctl asuser). Lock uses CGSession -suspend where macOS still ships it, otherwise starts the screen saver, which locks only if "Require password immediately" is set. Sign-out asks System Events to log out (the user confirms; apps can cancel; macOS may ask once to allow automation). Notices use osascript display notification, falling back to a dialog.',
        reason_ar:
          'يعمل داخل جلسة المستخدم الحالي. القفل عبر CGSession إن وُجد، وإلا بتشغيل شاشة التوقف التي تقفل فقط إذا كانت كلمة المرور مطلوبة فوراً. تسجيل الخروج عبر System Events (يؤكده المستخدم). الرسائل عبر إشعارات osascript أو نافذة حوار.',
      },
      {
        key: 'security_compliance',
        category: 'inventory',
        label_en: 'Security Compliance Evidence (Firewall, FileVault, SIP, Gatekeeper, Updates)',
        label_ar: 'أدلة الامتثال الأمني (جدار الحماية، FileVault، SIP، Gatekeeper، التحديثات)',
        state: 'implemented',
        enabled: true,
        reason_en:
          'Reads socketfilterfw --getglobalstate (pf via pfctl -s info as context, needs root), fdesetup status, csrutil status, spctl --status and softwareupdate -l.',
        reason_ar: 'يقرأ حالة جدار حماية التطبيقات و FileVault و SIP و Gatekeeper والتحديثات المتاحة عبر أوامر النظام.',
      },
    ];
  }

  return [];
}

/**
 * The Android agent (agents/android-agent). Every Device Owner action needs the agent to be the
 * phone's Device Owner (adb dpm set-device-owner or QR provisioning on a factory-reset phone); a
 * regular app has inventory and checks only. Built and unit-tested here, never run on a phone.
 */
function androidCapabilities(): EndpointCapabilityItem[] {
  const owner = (key: string, label_en: string, label_ar: string, reason_en: string, reason_ar: string): EndpointCapabilityItem => ({
    key,
    category: key === 'android_apps' ? 'software' : 'remote_control',
    label_en,
    label_ar,
    state: 'requires_permissions',
    enabled: true,
    reason_en: `${reason_en} Needs the agent to be the phone's Device Owner. Not tested on a real phone.`,
    reason_ar: `${reason_ar} يتطلب أن يكون الوكيل مالك الجهاز. لم يُختبر على هاتف حقيقي.`,
  });
  return [
    {
      key: 'telemetry_inventory',
      category: 'inventory',
      label_en: 'Android inventory (model, Android version, patch level, storage, memory, battery, network, installed apps)',
      label_ar: 'جرد Android (الطراز والإصدار ومستوى التصحيح والتخزين والذاكرة والبطارية والشبكة والتطبيقات المثبتة)',
      state: 'not_tested',
      enabled: true,
      reason_en: 'Read with Build, StatFs, ActivityManager, BatteryManager, ConnectivityManager and PackageManager (QUERY_ALL_PACKAGES). CPU load is not available to Android apps and is not shown. Not tested on a real phone.',
      reason_ar: 'يُقرأ عبر واجهات Android القياسية. حمل المعالج غير متاح لتطبيقات Android ولا يُعرض. لم يُختبر على هاتف حقيقي.',
    },
    {
      key: 'security_compliance',
      category: 'inventory',
      label_en: 'Security compliance (screen lock, encryption, patch age, developer options, USB debugging, unknown sources)',
      label_ar: 'الامتثال الأمني (قفل الشاشة والتشفير وعمر التصحيح وخيارات المطوّر وتصحيح USB والمصادر غير المعروفة)',
      state: 'not_tested',
      enabled: true,
      reason_en: 'KeyguardManager.isDeviceSecure, DevicePolicyManager.getStorageEncryptionStatus, Build.VERSION.SECURITY_PATCH (fails after 90 days), Settings.Global DEVELOPMENT_SETTINGS_ENABLED and ADB_ENABLED, the "Install unknown apps" grants Android lets the agent read. Not tested on a real phone.',
      reason_ar: 'يُقاس عبر واجهات Android القياسية (يفشل التصحيح بعد 90 يوماً). لم يُختبر على هاتف حقيقي.',
    },
    owner('android_lock', 'Lock now', 'القفل الآن', 'DevicePolicyManager.lockNow.', 'عبر DevicePolicyManager.lockNow.'),
    owner('android_password_policy', 'Screen-lock requirement', 'اشتراط قفل الشاشة', 'setRequiredPasswordComplexity (Android 12+) or the password quality API before.', 'عبر setRequiredPasswordComplexity أو واجهة جودة كلمة المرور في الإصدارات الأقدم.'),
    owner('android_camera', 'Disable / enable camera', 'تعطيل الكاميرا أو تفعيلها', 'DevicePolicyManager.setCameraDisabled.', 'عبر DevicePolicyManager.setCameraDisabled.'),
    owner('android_apps', 'Install an APK from Fleet / remove an app', 'تثبيت ملف APK من Fleet أو إزالة تطبيق', 'Silent PackageInstaller sessions; the APK is checked by size and SHA-256 before installing.', 'جلسات PackageInstaller صامتة بعد التحقق من الحجم وبصمة SHA-256.'),
    owner('android_wipe', 'Erase the phone', 'مسح الهاتف', 'wipeDevice (Android 14+) or wipeData; admin only, verification code always, second admin when the group asks for approvals.', 'للمسؤول فقط، مع رمز تحقق دائماً وموافقة مسؤول ثانٍ عندما تطلب المجموعة ذلك.'),
  ];
}
