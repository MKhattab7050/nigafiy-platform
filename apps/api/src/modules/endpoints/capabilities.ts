import type {
  EndpointCapabilityItem,
  EndpointComplianceStatus,
  EndpointPlatform,
  EndpointSecurityPosture,
} from '@lan-detective/shared-types';

export function inferPlatformFromOs(osRaw?: string | null, current?: EndpointPlatform): EndpointPlatform {
  const s = (osRaw ?? '').toLowerCase();
  if (s.includes('win')) return 'windows';
  if (s.includes('darwin') || s.includes('mac')) return 'macos';
  if (s.includes('linux') || s.includes('ubuntu') || s.includes('debian') || s.includes('rhel') || s.includes('centos')) return 'linux';
  return current ?? 'windows';
}

export function evaluateCompliance(params: {
  platform: EndpointPlatform;
  diskUsedPct?: number | null;
  security?: EndpointSecurityPosture | null;
}): { status: EndpointComplianceStatus; reasons: string[] } {
  const reasons: string[] = [];
  let nonCompliant = false;
  let attention = false;
  const sec = params.security ?? {};

  if (sec.firewall_enabled === false) {
    attention = true;
    reasons.push('Host firewall is reported off');
  }
  if (params.platform === 'windows' && sec.antivirus_enabled === false) {
    nonCompliant = true;
    reasons.push('Antivirus protection is reported disabled');
  }
  if (typeof params.diskUsedPct === 'number' && params.diskUsedPct >= 92) {
    attention = true;
    reasons.push(`Disk usage is critically high (${params.diskUsedPct.toFixed(1)}%)`);
  }
  if (typeof sec.pending_updates === 'number' && sec.pending_updates > 0) {
    attention = true;
    reasons.push(`${sec.pending_updates} OS/security update(s) pending`);
  }

  if (nonCompliant) return { status: 'non_compliant', reasons };
  if (attention) return { status: 'attention', reasons };
  // Nothing reported, nothing to judge: "compliant" would be a claim without evidence.
  const reported = Object.values(sec).some((v) => v !== undefined && v !== null) || typeof params.diskUsedPct === 'number';
  if (!reported) return { status: 'unknown', reasons: [] };
  return { status: 'compliant', reasons: [] };
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
        label_en: 'Remote Desktop Capture & X11 Input',
        label_ar: 'سطح المكتب البعيد لـ Linux',
        state: 'requires_permissions',
        enabled: true,
        reason_en: 'Requires an X11 desktop session with scrot, gnome-screenshot or ImageMagick for capture and xdotool for input (Wayland input is not supported).',
        reason_ar: 'يتطلب جلسة سطح مكتب رسومية مع وجود scrot أو gnome-screenshot و xdotool.',
      },
      {
        key: 'software_management',
        category: 'software',
        label_en: 'Package Inventory (dpkg/rpm) & APT Management',
        label_ar: 'جرد وإدارة حزم البرامج (dpkg / rpm / apt)',
        state: 'implemented',
        enabled: true,
        reason_en: 'Queries dpkg-query or rpm and runs approved apt-get package actions.',
        reason_ar: 'جرد الحزم المثبتة وتنفيذ التثبيت أو الحذف المعتمد.',
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
        label_en: 'Power & Session Controls (Lock, Restart, Shutdown)',
        label_ar: 'التحكم بالطاقة والجلسة',
        state: 'partially_supported',
        enabled: true,
        reason_en: 'Lock (loginctl), restart and shutdown are supported; interactive logoff is Windows-only.',
        reason_ar: 'قفل الجلسة وإعادة التشغيل والإيقاف مدعومة.',
      },
    ];
  }

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
        label_en: 'Remote Screen Viewing (view only)',
        label_ar: 'عرض الشاشة عن بُعد لـ macOS (عرض فقط)',
        state: 'partially_supported',
        enabled: true,
        reason_en: 'Screen viewing needs the Screen Recording permission granted to the agent. Mouse and keyboard control is not implemented on macOS.',
        reason_ar: 'عرض الشاشة يتطلب منح الوكيل صلاحية تسجيل الشاشة. التحكم بالماوس ولوحة المفاتيح غير مُنفّذ على macOS.',
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
        label_en: 'Display Lock, Restart & Shutdown',
        label_ar: 'قفل الشاشة وإعادة التشغيل والإيقاف',
        state: 'partially_supported',
        enabled: true,
        reason_en: 'Uses pmset displaysleepnow and shutdown -r/-h.',
        reason_ar: 'يدعم قفل الشاشة وإعادة التشغيل وإيقاف التشغيل.',
      },
    ];
  }

  return [];
}
