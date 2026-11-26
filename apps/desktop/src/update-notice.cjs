'use strict';
// What the tray says about updates (UX review 2026-11-26, item 14), from GET /api/v1/platform/updates
// (PlatformUpdatesResponse). Pure functions so they can be tested without Electron.
//
//  - an update is available  → a clickable tray line that opens the dashboard (where the update is
//    downloaded and installed), and ONE Windows notice per new version;
//  - update checks are off   → a disabled tray line that says so plainly, never "up to date";
//  - managed (MSI / Store)   → who updates this copy;
//  - the check failed        → "could not check", never "up to date".

const CHECK_EVERY_MS = 6 * 3600_000;

const TEXT = {
  en: {
    available: 'Update available: version {v}',
    upToDate: 'Up to date (version {v})',
    off: 'Updates are off: this copy does not check for new versions',
    msi: 'Updates come from your administrator',
    store: 'Updates come from the Microsoft Store',
    failed: 'Could not check for updates',
    noticeTitle: 'Nigafiy {v} is available',
    noticeBody: 'Open Nigafiy to download and install it. Your data stays as it is.',
  },
  ar: {
    available: 'يتوفر تحديث: الإصدار {v}',
    upToDate: 'محدّث (الإصدار {v})',
    off: 'التحديثات متوقفة: هذه النسخة لا تبحث عن إصدارات جديدة',
    msi: 'التحديثات تأتي من مسؤول الأجهزة',
    store: 'التحديثات تأتي من Microsoft Store',
    failed: 'تعذّر التحقق من التحديثات',
    noticeTitle: 'Nigafiy {v} متاح',
    noticeBody: 'افتح Nigafiy لتنزيله وتثبيته. بياناتك تبقى كما هي.',
  },
};

const fill = (s, v) => s.replace('{v}', v);
const langOf = (locale) => (String(locale ?? '').toLowerCase().startsWith('ar') ? 'ar' : 'en');

/**
 * The tray line for an update status, or null when there is nothing to say yet (not checked).
 * @returns {{ label: string, enabled: boolean, opens: boolean } | null}
 */
function trayLine(status, locale) {
  if (!status || typeof status !== 'object') return null;
  const t = TEXT[langOf(locale)];
  if (status.configured === false) {
    if (status.reason === 'msi_managed') return { label: t.msi, enabled: false, opens: false };
    if (status.reason === 'store_managed') return { label: t.store, enabled: false, opens: false };
    return { label: t.off, enabled: false, opens: false };
  }
  if (status.ok === false) return { label: t.failed, enabled: false, opens: false };
  if (status.update_available) return { label: fill(t.available, status.latest_version), enabled: true, opens: true };
  return { label: fill(t.upToDate, status.current_version), enabled: false, opens: false };
}

/** The Windows notice to show, once per version: null when nothing new (or already shown for this version). */
function noticeFor(status, lastNotifiedVersion, locale) {
  if (!status || status.configured !== true || status.ok !== true || !status.update_available) return null;
  if (status.latest_version === lastNotifiedVersion) return null;
  const t = TEXT[langOf(locale)];
  return { version: status.latest_version, title: fill(t.noticeTitle, status.latest_version), body: t.noticeBody };
}

module.exports = { trayLine, noticeFor, CHECK_EVERY_MS, TEXT };
