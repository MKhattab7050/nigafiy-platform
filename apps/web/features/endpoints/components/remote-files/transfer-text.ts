import type { JobState } from './transfer-engine';

// Words of the file manager and the transfer center, English and Arabic.

const en = {
  center: 'Transfers',
  open: 'Show transfers',
  hide: 'Hide',
  active: (n: number) => `${n} copying`,
  allDone: 'All transfers finished',
  resumeAll: 'Resume all',
  clear: 'Clear finished',
  pause: 'Pause',
  resume: 'Resume',
  retry: 'Start again',
  cancel: 'Cancel',
  cancelAll: 'Cancel all',
  files: (done: number, total: number) => `${done} of ${total} files`,
  left: (s: string) => `${s} left`,
  speed: (s: string) => `${s}/s`,
  retryIn: (s: number, n: number) => `Connection lost: trying again in ${s} s (attempt ${n}). Nothing is lost; it continues from the last byte.`,
  waitingNow: 'Trying again…',
  reload: 'The page was closed while copying. Press Resume to continue.',
  permission: 'The browser needs your permission again for the folder on this computer. Press Resume.',
  verified: {
    full: 'SHA-256 verified (whole file, both sides)',
    receiver: 'SHA-256 verified by the receiving device',
    chunks: 'Verified chunk by chunk (SHA-256), source unchanged',
  },
  states: {
    queued: 'Waiting its turn',
    running: 'Copying',
    waiting: 'Waiting for the connection',
    paused: 'Paused',
    interrupted: 'Stopped',
    verifying: 'Checking',
    done: 'Done',
    failed: 'Failed',
    cancelled: 'Cancelled',
    skipped: 'Skipped (kept the existing file)',
  } satisfies Record<JobState, string>,
  errors: {
    source_changed: 'The file changed on the device while it was being copied. Start again to copy the new version.',
    checksum: 'The checksum did not match. Start again.',
    checksum_mismatch: 'The checksum did not match. Start again.',
    lost_local_file: 'The file on this computer is no longer available (the page was reloaded). Add it again.',
    chunk_order: 'The device answered out of order. Start again.',
  } as Record<string, string>,
  overwriteTitle: 'Replace an existing file?',
  overwriteBody: (name: string, device: string) => `${name} already exists on ${device}. Replacing it is permanent and is recorded in the audit log.`,
  restartTitle: 'Start this upload again?',
  restartBody: (name: string) => `${name}: the device cannot continue this upload where it stopped (its agent is older or was reinstalled). Start again and replace the partial file?`,
  replace: 'Replace',
  keep: 'Keep the existing file',
  startAgain: 'Start again',
  applyAll: 'Do the same for the rest of this transfer',
  leaveWarn: 'Transfers are running. Leaving stops them (uploads and copies continue when you come back).',
  memoryWarn: 'This browser keeps the download in memory until it finishes. For files over 1.5 GB use Chrome or Edge, which write straight to disk.',
  truncated: 'The folder has more than 10 000 entries: only the first 10 000 are copied. Copy its subfolders one by one.',
  walking: 'Reading the folder…',
  queuedN: (n: number, size: string) => `${n} file(s), ${size}, added to Transfers`,
};

export type TransferText = typeof en;

const ar: TransferText = {
  center: 'عمليات النقل',
  open: 'عرض عمليات النقل',
  hide: 'إخفاء',
  active: (n) => `${n} قيد النسخ`,
  allDone: 'انتهت كل عمليات النقل',
  resumeAll: 'استئناف الكل',
  clear: 'مسح المنتهية',
  pause: 'إيقاف مؤقت',
  resume: 'استئناف',
  retry: 'البدء من جديد',
  cancel: 'إلغاء',
  cancelAll: 'إلغاء الكل',
  files: (done, total) => `${done} من ${total} ملف`,
  left: (s) => `متبقٍ ${s}`,
  speed: (s) => `${s}/ث`,
  retryIn: (s, n) => `انقطع الاتصال: إعادة المحاولة بعد ${s} ث (المحاولة ${n}). لن يضيع شيء؛ سيكمل من آخر بايت وصل.`,
  waitingNow: 'جارٍ إعادة المحاولة…',
  reload: 'أُغلقت الصفحة أثناء النسخ. اضغط استئناف للمتابعة.',
  permission: 'يحتاج المتصفح إذنك مرة أخرى للوصول إلى المجلد على هذا الحاسوب. اضغط استئناف.',
  verified: {
    full: 'تم التحقق بـ SHA-256 (الملف كاملًا، من الجهتين)',
    receiver: 'تحقّق الجهاز المستقبِل بـ SHA-256',
    chunks: 'تم التحقق جزءًا جزءًا (SHA-256) والمصدر لم يتغير',
  },
  states: {
    queued: 'في الانتظار',
    running: 'جارٍ النسخ',
    waiting: 'بانتظار الاتصال',
    paused: 'متوقف مؤقتًا',
    interrupted: 'متوقف',
    verifying: 'جارٍ التحقق',
    done: 'اكتمل',
    failed: 'فشل',
    cancelled: 'أُلغي',
    skipped: 'تُرك (بقي الملف الموجود)',
  },
  errors: {
    source_changed: 'تغيّر الملف على الجهاز أثناء نسخه. ابدأ من جديد لنسخ النسخة الجديدة.',
    checksum: 'لم يتطابق المجموع الاختباري. ابدأ من جديد.',
    checksum_mismatch: 'لم يتطابق المجموع الاختباري. ابدأ من جديد.',
    lost_local_file: 'لم يعد الملف على هذا الحاسوب متاحًا (أُعيد تحميل الصفحة). أضفه مرة أخرى.',
    chunk_order: 'أجاب الجهاز بترتيب خاطئ. ابدأ من جديد.',
  },
  overwriteTitle: 'استبدال ملف موجود؟',
  overwriteBody: (name, device) => `يوجد ${name} بالفعل على ${device}. الاستبدال نهائي ويُسجَّل في سجل التدقيق.`,
  restartTitle: 'بدء هذا الرفع من جديد؟',
  restartBody: (name) => `${name}: لا يستطيع الجهاز متابعة هذا الرفع من حيث توقف (وكيله أقدم أو أُعيد تثبيته). البدء من جديد واستبدال الملف الجزئي؟`,
  replace: 'استبدال',
  keep: 'الإبقاء على الملف الموجود',
  startAgain: 'البدء من جديد',
  applyAll: 'افعل الشيء نفسه لباقي هذا النقل',
  leaveWarn: 'توجد عمليات نقل جارية. المغادرة توقفها (الرفع والنسخ بين الأجهزة يكملان عند عودتك).',
  memoryWarn: 'هذا المتصفح يحتفظ بالتنزيل في الذاكرة حتى ينتهي. للملفات الأكبر من 1.5 جيجابايت استخدم Chrome أو Edge، فهما يكتبان على القرص مباشرة.',
  truncated: 'يحتوي المجلد على أكثر من 10 000 عنصر: تُنسخ أول 10 000 فقط. انسخ مجلداته الفرعية واحدًا تلو الآخر.',
  walking: 'جارٍ قراءة المجلد…',
  queuedN: (n, size) => `أُضيف ${n} ملف (${size}) إلى عمليات النقل`,
};

export const transferText = (isAr: boolean): TransferText => (isAr ? ar : en);

export function friendlyError(t: TransferText, raw?: string): string {
  if (!raw) return '';
  return t.errors[raw] ?? raw;
}

export function formatDuration(sec: number, isAr: boolean): string {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (isAr) return h ? `${h} س ${m} د` : m ? `${m} د ${s} ث` : `${s} ث`;
  return h ? `${h} h ${m} min` : m ? `${m} min ${s} s` : `${s} s`;
}
