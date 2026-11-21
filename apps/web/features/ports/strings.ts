/** UI strings owned by this module. The i18n core merges every module's `en` and `ar` into one typed dictionary. */
export const en = {
  'ports.attn.error': 'Switch "{name}" is not answering.',
  'ports.attn.check': 'Open the switch',
  'ports.cand.title': 'Probable switches',
  'ports.cand.intro': 'Devices on this site that look like switches but are not read yet. Choosing one fills in its address; the SNMP credentials are always typed by you.',
  'ports.cand.choose': 'Use this address',
  'ports.cand.chosen': 'Chosen',
  'ports.cand.outOfScope': 'Outside the authorized ranges, so it cannot be added yet.',
  'ports.cand.manualType': 'Type set by you',
} as const;

export const ar: Record<keyof typeof en, string> = {
  'ports.attn.error': 'المحوِّل "{name}" لا يستجيب.',
  'ports.attn.check': 'افتح المحوِّل',
  'ports.cand.title': 'سويتشات محتمَلة',
  'ports.cand.intro': 'أجهزة في هذا الموقع تبدو سويتشات لكنها لم تُقرأ بعد. اختيار أحدها يملأ عنوانه؛ بيانات SNMP تكتبها أنت دائمًا.',
  'ports.cand.choose': 'استخدم هذا العنوان',
  'ports.cand.chosen': 'مُختار',
  'ports.cand.outOfScope': 'خارج النطاقات المصرَّح بها، لذلك لا يمكن إضافته بعد.',
  'ports.cand.manualType': 'نوع حدّدته أنت',
};
