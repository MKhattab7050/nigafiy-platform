import type {
  EndpointCapabilityItem,
  EndpointComplianceStatus,
  EndpointManagementMode,
  EndpointPlatform,
  EndpointPolicy,
  EndpointSecurityPosture,
} from '@lan-detective/shared-types';

export function inferPlatformFromOs(osRaw?: string | null, current?: EndpointPlatform): EndpointPlatform {
  const s = (osRaw ?? '').toLowerCase();
  if (s.includes('win')) return 'windows';
  if (s.includes('darwin') || s.includes('mac')) return 'macos';
  if (s.includes('android')) return 'android';
  if (s.includes('ios') || s.includes('ipad') || s.includes('iphone')) return 'ios';
  if (s.includes('linux') || s.includes('ubuntu') || s.includes('debian') || s.includes('rhel') || s.includes('centos')) return 'linux';
  return current ?? 'windows';
}

export function evaluateCompliance(params: {
  platform: EndpointPlatform;
  diskUsedPct?: number | null;
  security?: EndpointSecurityPosture | null;
  policy?: EndpointPolicy | null;
}): { status: EndpointComplianceStatus; reasons: string[] } {
  const reasons: string[] = [];
  let nonCompliant = false;
  let attention = false;
  const sec = params.security ?? {};
  const pol = params.policy ?? {};

  if (sec.rooted_or_jailbroken) {
    nonCompliant = true;
    reasons.push('Device is rooted or jailbroken');
  }
  if (pol.passcode_required && sec.passcode_compliant === false) {
    nonCompliant = true;
    reasons.push('Passcode policy is not satisfied');
  }
  if ((params.platform === 'windows' || params.platform === 'linux' || params.platform === 'macos') && sec.firewall_enabled === false) {
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
  return { status: 'compliant', reasons: [] };
}

export function buildCapabilities(
  platform: EndpointPlatform,
  mode: EndpointManagementMode,
  security?: EndpointSecurityPosture | null,
): EndpointCapabilityItem[] {
  const sec = security ?? {};

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
        state: 'tested',
        enabled: true,
        reason_en: 'Full process list with PID, RAM/CPU usage and remote taskkill.',
        reason_ar: 'قائمة العمليات الكاملة مع استهلاك الرام والمعالج وإمكانية إنهاء أي عملية.',
      },
      {
        key: 'services_control',
        category: 'remote_control',
        label_en: 'Windows Service Management (Start / Stop / Restart)',
        label_ar: 'إدارة خدمات النظام (تشغيل / إيقاف / إعادة تشغيل)',
        state: 'tested',
        enabled: true,
        reason_en: 'Reads service states and executes validated Start/Stop/Restart commands.',
        reason_ar: 'قراءة حالة جميع خدمات Windows والتحكم بها عن بُعد.',
      },
      {
        key: 'network_connections',
        category: 'inventory',
        label_en: 'Active TCP/UDP Connections & Listening Ports',
        label_ar: 'الاتصالات الشبكية النشطة والمنافذ المفتوحة',
        state: 'tested',
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
        state: 'tested',
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
        state: 'tested',
        enabled: true,
        reason_en: 'Runs approved diagnostic tools (ipconfig, route, arp, netstat, systeminfo, gpresult) and fetches Windows Event Logs.',
        reason_ar: 'تشغيل أدوات تشخيص الشبكة والنظام المعتمدة وجلب سجلات أحداث Windows.',
      },
      {
        key: 'power_session',
        category: 'remote_control',
        label_en: 'Power & Session Controls (Lock, Logoff, Restart, Shutdown, Notice)',
        label_ar: 'التحكم بالطاقة والجلسة (قفل، خروج، إعادة تشغيل، إيقاف، رسائل)',
        state: 'tested',
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
        state: 'tested',
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
        reason_en: 'Requires an active X11/Wayland desktop session with scrot/gnome-screenshot and xdotool installed.',
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
        state: sec.screen_recording_granted ? 'implemented' : 'requires_permissions',
        enabled: true,
        reason_en: 'Requires macOS TCC Full Disk Access for user-protected folders; /System and Keychains are blocked.',
        reason_ar: 'يتطلب صلاحية Full Disk Access في macOS للوصول للمجلدات المحمية.',
      },
      {
        key: 'remote_desktop',
        category: 'remote_control',
        label_en: 'Remote Screen Viewing (macOS TCC)',
        label_ar: 'عرض الشاشة عن بُعد لـ macOS',
        state: 'requires_permissions',
        enabled: true,
        reason_en: 'Requires macOS TCC Screen Recording and Accessibility permissions granted to the agent.',
        reason_ar: 'يتطلب منح صلاحيات تسجيل الشاشة وإمكانية الوصول (TCC) على جهاز الماك.',
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

  if (platform === 'android') {
    const isDeviceOwner = mode === 'android_device_owner';
    const isEnterprise = isDeviceOwner || mode === 'android_work_profile';
    return [
      {
        key: 'telemetry_inventory',
        category: 'inventory',
        label_en: 'Device Info, Battery, Storage, Patch Level & Network',
        label_ar: 'معلومات الجهاز والبطارية والتخزين ومستوى التحديث الأمني',
        state: 'implemented',
        enabled: true,
        reason_en: 'Reported by the Android Enterprise agent / Device Policy Controller.',
        reason_ar: 'يتم إرسالها من وكيل إدارة Android Enterprise.',
      },
      {
        key: 'software_management',
        category: 'software',
        label_en: 'Managed Application Inventory, Deployment & Removal',
        label_ar: 'جرد وتثبيت وحذف التطبيقات المُدارة',
        state: isEnterprise ? 'implemented' : 'requires_enterprise_enrollment',
        enabled: isEnterprise,
        reason_en: isEnterprise
          ? 'Supported via Android Enterprise Device Owner / Work Profile policy.'
          : 'Silent app installation and removal require Android Enterprise Device Owner or Work Profile enrollment.',
        reason_ar: isEnterprise
          ? 'مدعوم عبر صلاحيات Android Enterprise.'
          : 'التثبيت والحذف الصامت للتطبيقات يتطلب تسجيل الجهاز في وضع Device Owner أو Work Profile.',
      },
      {
        key: 'security_policy',
        category: 'security_policy',
        label_en: 'Device Lock, Wi-Fi/VPN Policy, Camera/USB Restrictions & Wipe',
        label_ar: 'قفل الجهاز وسياسات Wi-Fi/VPN وقيود الكاميرا والمسح المؤسسي',
        state: isEnterprise ? 'implemented' : 'requires_enterprise_enrollment',
        enabled: isEnterprise,
        reason_en: isEnterprise
          ? 'Enforced through DevicePolicyManager.'
          : 'Requires Android Enterprise Device Owner or Work Profile provisioning.',
        reason_ar: isEnterprise
          ? 'يتم تطبيقها عبر DevicePolicyManager.'
          : 'يتطلب تفعيل وضع Device Owner أو Work Profile.',
      },
      {
        key: 'remote_desktop',
        category: 'remote_control',
        label_en: 'User-Assisted Remote Screen View & Accessibility Control',
        label_ar: 'عرض الشاشة والدعم الفني التفاعلي بموافقة المستخدم',
        state: 'requires_permissions',
        enabled: true,
        reason_en: 'Requires user MediaProjection consent for screen sharing and AccessibilityService permission for touch injection.',
        reason_ar: 'يتطلب موافقة المستخدم على مشاركة الشاشة (MediaProjection) وتفعيل خدمة Accessibility للتحكم باللمس.',
      },
      {
        key: 'remote_file_manager',
        category: 'file_management',
        label_en: 'Scoped Managed File Transfer',
        label_ar: 'نقل الملفات ضمن المساحات المسموحة',
        state: sec.accessibility_granted || isDeviceOwner ? 'partially_supported' : 'requires_permissions',
        enabled: isDeviceOwner,
        reason_en: 'Scoped to managed storage directories; Android blocks arbitrary access to other apps’ private sandboxes.',
        reason_ar: 'مقتصر على مجلدات التخزين المُدارة؛ نظام أندرويد يمنع الوصول لمساحات التطبيقات الخاصة.',
      },
      {
        key: 'processes_control',
        category: 'remote_control',
        label_en: 'Arbitrary System Process & Service Control',
        label_ar: 'التحكم المباشر بعمليات وخدمات النظام الداخلية',
        state: 'unsupported_by_os',
        enabled: false,
        reason_en: 'Android SELinux and application sandboxing prohibit third-party inspection or killing of arbitrary OS processes.',
        reason_ar: 'حماية SELinux في أندرويد تمنع التحكم المباشر بعمليات النظام.',
      },
    ];
  }

  // iOS / iPadOS
  const isSupervised = mode === 'ios_supervised_mdm' || Boolean(sec.supervised);
  return [
    {
      key: 'telemetry_inventory',
      category: 'inventory',
      label_en: 'Apple MDM Device, Hardware & Compliance Inventory',
      label_ar: 'جرد معلومات الجهاز والامتثال عبر Apple MDM',
      state: 'implemented',
      enabled: true,
      reason_en: 'Collected via Apple MDM DeviceInformation and SecurityInfo queries.',
      reason_ar: 'يتم جمعها عبر بروتوكول Apple MDM الرسمي.',
    },
    {
      key: 'software_management',
      category: 'software',
      label_en: 'Managed App Deployment & Installed App List (MDM)',
      label_ar: 'نشر التطبيقات المُدارة وجردها عبر MDM',
      state: 'implemented',
      enabled: true,
      reason_en: 'Uses Apple MDM InstallApplication / InstalledApplicationList commands.',
      reason_ar: 'يستخدم أوامر Apple MDM لتثبيت وجرد التطبيقات المُدارة.',
    },
    {
      key: 'security_policy',
      category: 'security_policy',
      label_en: 'Configuration Profiles (Wi-Fi, VPN, Passcode, Restrictions)',
      label_ar: 'ملفات تعريف الإعدادات (Wi-Fi، VPN، رمز القفل، القيود)',
      state: 'implemented',
      enabled: true,
      reason_en: 'Generates and queues signed/enrollable .mobileconfig profiles.',
      reason_ar: 'إنشاء وإرسال ملفات تعريف .mobileconfig الرسمية.',
    },
    {
      key: 'ios_lock_wipe',
      category: 'remote_control',
      label_en: 'Remote Device Lock & Enterprise Erase (MDM)',
      label_ar: 'قفل الجهاز عن بُعد والمسح المؤسسي عبر MDM',
      state: 'requires_external_config',
      enabled: true,
      reason_en: 'Queues MDM DeviceLock and EraseDevice commands (live push wakeups require an Apple APNs MDM certificate).',
      reason_ar: 'إرسال أوامر DeviceLock و EraseDevice (التنبيه الفوري يتطلب شهادة Apple APNs MDM).',
    },
    {
      key: 'ios_supervised_lost_mode',
      category: 'remote_control',
      label_en: 'Managed Lost Mode & Remote Restart (Supervised Only)',
      label_ar: 'وضع الفقدان المُدار وإعادة التشغيل (للأجهزة المُشرف عليها Supervised فقط)',
      state: isSupervised ? 'implemented' : 'requires_enterprise_enrollment',
      enabled: isSupervised,
      reason_en: isSupervised
        ? 'Device is Supervised; EnableLostMode and RestartDevice MDM commands are available.'
        : 'Apple restricts Managed Lost Mode and remote restart to Supervised devices enrolled via Apple Business Manager / Apple Configurator.',
      reason_ar: isSupervised
        ? 'الجهاز في وضع الإشراف (Supervised)؛ أوامر وضع الفقدان وإعادة التشغيل متاحة.'
        : 'تقيّد شركة Apple وضع الفقدان وإعادة التشغيل بالأجهزة المُشرف عليها (Supervised) فقط.',
    },
    {
      key: 'remote_desktop',
      category: 'remote_control',
      label_en: 'Unattended Remote Desktop & Mouse/Keyboard Control',
      label_ar: 'سطح المكتب البعيد والتحكم باللمس/الماوس دون تدخل',
      state: 'unsupported_by_os',
      enabled: false,
      reason_en: 'Apple iOS/iPadOS operating system security prohibits unattended remote screen control or touch injection.',
      reason_ar: 'قيود الأمان في نظام iOS/iPadOS من Apple تمنع التحكم عن بُعد بشاشة الآيفون أو الآيباد.',
    },
    {
      key: 'remote_file_manager',
      category: 'file_management',
      label_en: 'Arbitrary Filesystem Browsing',
      label_ar: 'تصفح ملفات النظام الكامل',
      state: 'unsupported_by_os',
      enabled: false,
      reason_en: 'Apple iOS/iPadOS enforces strict per-app sandboxing and does not expose raw filesystem access to MDM servers.',
      reason_ar: 'نظام iOS يعزل كل تطبيق في Sandbox مستقل ولا يسمح بتصفح ملفات الجهاز عبر MDM.',
    },
    {
      key: 'processes_control',
      category: 'remote_control',
      label_en: 'Running Process & Daemon Control',
      label_ar: 'مراقبة وإنهاء العمليات الجارية',
      state: 'unsupported_by_os',
      enabled: false,
      reason_en: 'Apple iOS/iPadOS does not permit third-party or MDM enumeration/termination of kernel or user processes.',
      reason_ar: 'لا يسمح نظام iOS بعرض أو إنهاء العمليات الجارية.',
    },
  ];
}

export function buildAndroidProvisioningBundle(params: {
  serverUrl: string;
  enrollmentToken: string;
  endpointName: string;
  managementMode: EndpointManagementMode;
  wifiSsid?: string;
}): Record<string, unknown> {
  return {
    'android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME':
      'com.landetective.enterprise/.DeviceAdminReceiver',
    'android.app.extra.PROVISIONING_SKIP_ENCRYPTION': false,
    'android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED': true,
    ...(params.wifiSsid ? { 'android.app.extra.PROVISIONING_WIFI_SSID': params.wifiSsid } : {}),
    'android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE': {
      server_url: params.serverUrl,
      enrollment_token: params.enrollmentToken,
      endpoint_name: params.endpointName,
      management_mode: params.managementMode,
    },
  };
}

export function buildAppleMdmMobileconfig(params: {
  organizationName: string;
  endpointId: string;
  endpointName: string;
  enrollmentToken: string;
  serverUrl: string;
  policy?: EndpointPolicy;
}): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const checkinUrl = `${params.serverUrl.replace(/\/$/, '')}/api/v1/agent/mdm/checkin?token=${encodeURIComponent(params.enrollmentToken)}`;
  const serverEndpointUrl = `${params.serverUrl.replace(/\/$/, '')}/api/v1/agent/mdm/connect?token=${encodeURIComponent(params.enrollmentToken)}`;
  const pol = params.policy ?? {};

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadDisplayName</key>
  <string>${esc(params.organizationName)} — LAN Detective Enterprise Management (${esc(params.endpointName)})</string>
  <key>PayloadDescription</key>
  <string>Enrolls this Apple device into ${esc(params.organizationName)} IT Operations for inventory, compliance, and authorized management.</string>
  <key>PayloadIdentifier</key>
  <string>com.landetective.mdm.profile.${esc(params.endpointId)}</string>
  <key>PayloadOrganization</key>
  <string>${esc(params.organizationName)}</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${esc(params.endpointId)}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key>
      <string>com.apple.security.passcode</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>PayloadIdentifier</key>
      <string>com.landetective.mdm.passcode.${esc(params.endpointId)}</string>
      <key>PayloadUUID</key>
      <string>00000000-0000-4000-8000-${esc(params.endpointId.slice(-12))}</string>
      <key>PayloadDisplayName</key>
      <string>Enterprise Passcode Policy</string>
      <key>forcePIN</key>
      <${pol.passcode_required !== false ? 'true' : 'false'}/>
      <key>minLength</key>
      <integer>${pol.min_passcode_length ?? 6}</integer>
    </dict>
    <dict>
      <key>PayloadType</key>
      <string>com.apple.applicationaccess</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>PayloadIdentifier</key>
      <string>com.landetective.mdm.restrictions.${esc(params.endpointId)}</string>
      <key>PayloadUUID</key>
      <string>11111111-1111-4000-8000-${esc(params.endpointId.slice(-12))}</string>
      <key>PayloadDisplayName</key>
      <string>Enterprise Device Restrictions</string>
      <key>allowCamera</key>
      <${pol.camera_disabled ? 'false' : 'true'}/>
      <key>CheckInURL</key>
      <string>${esc(checkinUrl)}</string>
      <key>ServerURL</key>
      <string>${esc(serverEndpointUrl)}</string>
    </dict>
  </array>
</dict>
</plist>`;
}

