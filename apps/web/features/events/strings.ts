/** UI strings owned by this module. The i18n core merges every module's `en` and `ar` into one typed dictionary. */
export const en = {
  'events.title': 'Event Timeline',
  'events.empty': 'No events match these filters.',
  'events.evidence': 'Evidence',
  'events.occurred': 'Occurred',
  'events.recorded': 'Recorded by cloud',
  'events.source.collector': 'Observed by Sensor',
  'events.source.platform': 'Detected by platform',
  'events.severity': 'Severity',
  'events.type': 'Event type',
  'events.inMaintenance': 'In maintenance',
  'events.widget.none': 'No events recorded yet. They appear once a Sensor reports.',
} as const;

export const ar: Record<keyof typeof en, string> = {
  'events.title': 'سجل الأحداث',
  'events.empty': 'لا توجد أحداث تطابق هذه المرشّحات.',
  'events.evidence': 'الأدلة',
  'events.occurred': 'وقت الحدوث',
  'events.recorded': 'سُجّل في السحابة',
  'events.source.collector': 'رصده المستشعر',
  'events.source.platform': 'اكتشفته المنصة',
  'events.severity': 'الخطورة',
  'events.type': 'نوع الحدث',
  'events.inMaintenance': 'أثناء الصيانة',
  'events.widget.none': 'لا توجد أحداث مسجَّلة بعد. تظهر بعد أن يرسل مستشعر البيانات.',
};
