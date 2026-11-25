/** UI strings owned by this module. The i18n core merges every module's `en` and `ar` into one typed dictionary. */
export const en = {
  'ipam.attn.conflicts': 'one: {count} address in {cidr} needs checking. | other: {count} addresses in {cidr} need checking.',
  'ipam.attn.full': 'Subnet {cidr} is nearly full ({free} free).',
  'ipam.attn.check': 'Open the subnet',
} as const;

export const ar: Record<keyof typeof en, string> = {
  'ipam.attn.conflicts': 'zero: {count} من العناوين في {cidr} تحتاج إلى مراجعة. | one: عنوان واحد في {cidr} يحتاج إلى مراجعة. | two: عنوانان في {cidr} يحتاجان إلى مراجعة. | few: {count} من العناوين في {cidr} تحتاج إلى مراجعة. | many: {count} من العناوين في {cidr} تحتاج إلى مراجعة. | other: {count} من العناوين في {cidr} تحتاج إلى مراجعة.',
  'ipam.attn.full': 'الشبكة الفرعية {cidr} شبه ممتلئة ({free} متاح).',
  'ipam.attn.check': 'افتح الشبكة الفرعية',
};
