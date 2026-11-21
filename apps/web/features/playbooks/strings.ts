/** UI strings owned by this module. The i18n core merges every module's `en` and `ar` into one typed dictionary. */
export const en = {
  'nav.playbooks': 'Playbooks',
  'nav.pendingApprovals': 'waiting for approval',
} as const;

export const ar: Record<keyof typeof en, string> = {
  'nav.playbooks': 'كتيّبات التشغيل',
  'nav.pendingApprovals': 'بانتظار الموافقة',
};
