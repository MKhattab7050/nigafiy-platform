/** UI strings owned by this module. The i18n core merges every module's `en` and `ar` into one typed dictionary. */
export const en = {
  'ipam.attn.conflicts': '{count} addresses in {cidr} need checking.',
  'ipam.attn.full': 'Subnet {cidr} is nearly full ({free} free).',
  'ipam.attn.check': 'Open the subnet',
} as const;

export const ar: Record<keyof typeof en, string> = {
  'ipam.attn.conflicts': '{count} من العناوين في {cidr} تحتاج إلى مراجعة.',
  'ipam.attn.full': 'الشبكة الفرعية {cidr} شبه ممتلئة ({free} متاح).',
  'ipam.attn.check': 'افتح الشبكة الفرعية',
};
