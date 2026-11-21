'use strict';
/* global desktop */

const TEXT = {
  en: {
    title: 'Collector on this computer',
    subtitle: 'Discovers and monitors the network this computer is connected to, and reports to your LAN Detective server.',
    status: 'Status',
    binaryMissing: 'The collector program is missing from this installation. Reinstall LAN Detective.',
    start: 'Start collector',
    stop: 'Stop collector',
    openDashboard: 'Open dashboard',
    server: 'Server',
    serverUrl: 'LAN Detective server address',
    cidrs: 'Networks this computer may probe (optional)',
    cidrsHint: 'A local safety limit: even if the server asks for more, the collector only probes ranges listed here. Leave empty to accept any authorized private range.',
    autoStart: 'Start the collector when LAN Detective opens',
    save: 'Save',
    saved: 'Saved.',
    switchedToRemote: 'Saved. Switched from local mode to remote server mode — enroll this computer below using a token from your remote dashboard.',
    localTitle: 'Local mode',
    localBadge: 'Running on this computer',
    localDesc: 'LAN Detective is running locally on this computer. To switch to a remote server, enter its https:// address below and save.',
    localStarting: 'Starting local LAN Detective server…',
    localDashboard: 'Dashboard',
    localApi: 'API',
    localScanDeclined: 'The first-run home-network scan was skipped.',
    localScanBtn: 'Scan home network',
    localResetPromptBtn: 'Ask again on next launch',
    localPromptReset: 'Home-network scan prompt will appear on next launch.',
    enroll: 'Enroll this computer',
    enrollHint: 'In the dashboard open Discovery & Collectors, add a collector, and paste its one-time enrollment token here.',
    token: 'Enrollment token',
    enrollStart: 'Enroll and start',
    identity: 'Collector identity',
    identityHint: 'This computer is enrolled. Remove the identity only if the collector was revoked or you are moving to another server.',
    reset: 'Remove identity',
    resetConfirm: 'Remove this computer’s collector identity? You will need a new enrollment token to connect again.',
    activity: 'Activity',
    noActivity: 'No activity yet.',
    st_stopped: 'Stopped',
    st_starting: 'Starting…',
    st_running: 'Running',
    st_error: 'Stopped with an error',
    notEnrolled: 'Not enrolled',
    connOk: 'Connected to server',
    connLost: 'Server unreachable — buffering',
    lastSweep: 'Last discovery sweep',
    found: 'devices found of',
    probed: 'addresses probed',
    other: 'العربية',
  },
  ar: {
    title: 'المجمِّع على هذا الحاسوب',
    subtitle: 'يكتشف ويراقب الشبكة المتصل بها هذا الحاسوب، ويرسل النتائج إلى خادم LAN Detective.',
    status: 'الحالة',
    binaryMissing: 'برنامج المجمِّع غير موجود في هذا التثبيت. أعد تثبيت LAN Detective.',
    start: 'تشغيل المجمِّع',
    stop: 'إيقاف المجمِّع',
    openDashboard: 'فتح لوحة التحكم',
    server: 'الخادم',
    serverUrl: 'عنوان خادم LAN Detective',
    cidrs: 'الشبكات المسموح لهذا الحاسوب بفحصها (اختياري)',
    cidrsHint: 'حد أمان محلي: حتى لو طلب الخادم أكثر، لا يفحص المجمِّع إلا النطاقات المذكورة هنا. اتركه فارغًا لقبول أي نطاق خاص مصرَّح به.',
    autoStart: 'تشغيل المجمِّع عند فتح LAN Detective',
    save: 'حفظ',
    saved: 'تم الحفظ.',
    switchedToRemote: 'تم الحفظ. تم التبديل من الوضع المحلي إلى الخادم البعيد — سجّل هذا الحاسوب أدناه باستخدام رمز من لوحة التحكم البعيدة.',
    localTitle: 'الوضع المحلي',
    localBadge: 'يعمل على هذا الحاسوب',
    localDesc: 'يعمل LAN Detective محليًا على هذا الحاسوب. للانتقال إلى خادم بعيد، أدخل عنوانه الذي يبدأ بـ https:// أدناه ثم احفظ.',
    localStarting: 'جارٍ تشغيل خادم LAN Detective المحلي…',
    localDashboard: 'لوحة التحكم',
    localApi: 'واجهة API',
    localScanDeclined: 'تم تخطي فحص الشبكة المنزلية عند بدء التشغيل.',
    localScanBtn: 'فحص الشبكة المنزلية',
    localResetPromptBtn: 'اسأل مجددًا عند التشغيل التالي',
    localPromptReset: 'سيظهر سؤال فحص الشبكة عند التشغيل التالي.',
    enroll: 'تسجيل هذا الحاسوب',
    enrollHint: 'من لوحة التحكم افتح «الاكتشاف والمجمِّعات»، أضف مجمِّعًا، ثم الصق رمز التسجيل (يُستخدم مرة واحدة) هنا.',
    token: 'رمز التسجيل',
    enrollStart: 'تسجيل وتشغيل',
    identity: 'هوية المجمِّع',
    identityHint: 'هذا الحاسوب مسجَّل. احذف الهوية فقط إذا أُلغي اعتماد المجمِّع أو كنت تنتقل إلى خادم آخر.',
    reset: 'حذف الهوية',
    resetConfirm: 'حذف هوية المجمِّع من هذا الحاسوب؟ ستحتاج إلى رمز تسجيل جديد للاتصال مرة أخرى.',
    activity: 'النشاط',
    noActivity: 'لا يوجد نشاط بعد.',
    st_stopped: 'متوقف',
    st_starting: 'جارٍ التشغيل…',
    st_running: 'يعمل',
    st_error: 'توقف بسبب خطأ',
    notEnrolled: 'غير مسجَّل',
    connOk: 'متصل بالخادم',
    connLost: 'تعذّر الوصول للخادم — يُخزَّن مؤقتًا',
    lastSweep: 'آخر عملية اكتشاف',
    found: 'جهاز من أصل',
    probed: 'عنوانًا تم فحصه',
    other: 'English',
  },
};

const $ = (id) => document.getElementById(id);
let lang = localStorage.getItem('ld_lang') === 'ar' ? 'ar' : 'en';
let state = null;
let formDirty = false;
const t = (key) => TEXT[lang][key] ?? TEXT.en[key] ?? key;

function applyLanguage() {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  $('lang').textContent = t('other');
  if (state) render(state);
}

function render(next) {
  state = next;
  const running = next.status === 'running' || next.status === 'starting';
  const run = $('badge-run');
  run.textContent = !next.enrolled && !running ? t('notEnrolled') : t(`st_${next.status}`);
  run.className = `badge ${next.status === 'running' ? 'ok' : next.status === 'error' ? 'crit' : next.status === 'starting' ? 'warn' : 'idle'}`;

  const conn = $('badge-conn');
  conn.hidden = next.connected === null;
  conn.textContent = next.connected ? t('connOk') : t('connLost');
  conn.className = `badge ${next.connected ? 'ok' : 'warn'}`;

  $('error').hidden = !next.lastError;
  $('error').textContent = next.lastError ?? '';
  $('missing').hidden = next.binaryAvailable;
  $('sweep').textContent = next.lastSweep
    ? `${t('lastSweep')}: ${next.lastSweep.cidr} — ${next.lastSweep.found} ${t('found')} ${next.lastSweep.probed} ${t('probed')} · ${new Date(next.lastSweep.at).toLocaleTimeString()}`
    : '';

  $('local-card').hidden = !next.localMode;
  if (next.localMode) {
    $('local-urls').textContent = next.localWebUrl
      ? `${t('localDashboard')}: ${next.localWebUrl} · ${t('localApi')}: ${next.localApiUrl}`
      : t('localStarting');
    const showScanBox = !next.enrolled && (next.localCanScan || next.scanDeclined);
    $('local-scan-box').hidden = !showScanBox;
    $('local-scan-declined').hidden = !next.scanDeclined;
    $('local-scan').hidden = !next.localCanScan;
    $('local-reset-prompt').hidden = !next.scanDeclined;
    if (next.enrolled || next.scanDeclined) $('local-msg').hidden = true;
  } else {
    $('local-msg').hidden = true;
  }

  const effectiveServerUrl = next.settings.serverUrl || (next.localMode ? next.localApiUrl ?? '' : '');
  const ready = next.binaryAvailable && Boolean(effectiveServerUrl);
  const hasDashboard = Boolean(next.settings.serverUrl || (next.localMode && next.localWebUrl));
  $('start').disabled = running || !ready || !next.enrolled;
  $('stop').disabled = !running;
  $('dashboard').disabled = !hasDashboard;
  $('enroll-card').hidden = next.enrolled;
  $('identity-card').hidden = !next.enrolled;
  for (const el of $('enroll').elements) el.disabled = !ready || running;

  if (!formDirty) {
    $('serverUrl').value = effectiveServerUrl;
    $('cidrs').value = next.settings.allowedCidrs.join(', ');
    $('autoStart').checked = next.settings.autoStart;
  }

  const list = $('logs');
  const stick = list.scrollTop + list.clientHeight >= list.scrollHeight - 8;
  list.replaceChildren(
    ...next.logs.map((entry) => {
      const li = document.createElement('li');
      const time = document.createElement('time');
      time.textContent = new Date(entry.at).toLocaleTimeString([], { hour12: false });
      const lvl = document.createElement('span');
      const validLevel = ['info', 'warn', 'error', 'debug'].includes(entry.level) ? entry.level : 'info';
      lvl.className = `lvl ${validLevel}`;
      lvl.textContent = validLevel;
      const msg = document.createElement('span');
      msg.textContent = entry.message; // textContent only: log text is never interpreted as HTML
      if (entry.extra) {
        const extra = document.createElement('span');
        extra.className = 'extra';
        extra.textContent = ` — ${entry.extra}`;
        msg.append(extra);
      }
      li.append(time, lvl, msg);
      return li;
    }),
  );
  $('logs-empty').hidden = next.logs.length > 0;
  if (stick) list.scrollTop = list.scrollHeight;
}

const message = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

async function guarded(fn) {
  try {
    render(await fn());
  } catch (err) {
    if (state) render({ ...state, lastError: message(err) });
    else {
      $('error').hidden = false;
      $('error').textContent = message(err);
    }
  }
}

$('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ar' : 'en';
  localStorage.setItem('ld_lang', lang);
  applyLanguage();
});
$('settings').addEventListener('input', () => (formDirty = true));
$('settings').addEventListener('submit', async (event) => {
  event.preventDefault();
  const note = $('settings-msg');
  note.textContent = '';
  const submitBtn = $('settings').querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try {
    const next = await desktop.saveSettings({ serverUrl: $('serverUrl').value, allowedCidrs: $('cidrs').value, autoStart: $('autoStart').checked });
    formDirty = false;
    render(next);
    note.className = 'small ok-text';
    note.textContent = next.switchedFromLocal ? t('switchedToRemote') : t('saved');
  } catch (err) {
    note.className = 'small crit-text';
    note.textContent = message(err);
  } finally {
    submitBtn.disabled = false;
  }
});
$('local-scan').addEventListener('click', async () => {
  const btn = $('local-scan');
  btn.disabled = true;
  $('local-msg').hidden = true;
  try {
    await guarded(() => desktop.setupLocalScan());
  } finally {
    btn.disabled = false;
  }
});
$('local-reset-prompt').addEventListener('click', () => {
  void guarded(async () => {
    const next = await desktop.resetScanPrompt();
    const note = $('local-msg');
    note.hidden = false;
    note.textContent = t('localPromptReset');
    return next;
  });
});
$('enroll').addEventListener('submit', (event) => {
  event.preventDefault();
  const token = $('token').value.trim();
  $('token').value = ''; // do not keep the token in the page longer than needed
  void guarded(() => desktop.start(token));
});
$('start').addEventListener('click', () => void guarded(() => desktop.start('')));
$('stop').addEventListener('click', () => void guarded(() => desktop.stop()));
$('dashboard').addEventListener('click', () => void desktop.openDashboard());
$('reset').addEventListener('click', () => {
  if (window.confirm(t('resetConfirm'))) void guarded(() => desktop.resetIdentity());
});

desktop.onState(render);
applyLanguage();
void desktop.getState().then(render);
