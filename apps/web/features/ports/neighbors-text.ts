import type { NeighborProtocol } from '@lan-detective/shared-types';
import type { Locale } from '@/lib/i18n';

const en = {
  title: 'Neighbours',
  description: 'What switches report about the devices next to them (LLDP, CDP, MikroTik), and MikroTik devices heard announcing themselves to the collector.',
  protocol: { lldp: 'LLDP', cdp: 'CDP', mikrotik: 'MikroTik' } as Record<NeighborProtocol, string>,
  switchTable: 'Reported by switches',
  switchEmpty: 'No switch reports a neighbour. Neighbour tables are read with the switch (LLDP-MIB, CISCO-CDP-MIB, MIKROTIK-MIB); many small switches implement none of them.',
  colSwitchPort: 'Switch · port',
  colNeighbor: 'Neighbour',
  colRemotePort: 'Its port',
  colAddress: 'Address',
  colPlatform: 'Platform',
  mndpTitle: 'MikroTik announcements (MNDP)',
  mndpExplain:
    'The collector listens on UDP port 5678 for the announcements RouterOS devices broadcast about once a minute. It only receives: nothing is sent. Announcements from outside the authorized ranges are ignored.',
  mndpToggle: 'Listen for MikroTik announcements at this site',
  mndpOff: 'Turned off for this site. Collectors close the port within 15 seconds; stored announcements were removed.',
  mndpEmpty: 'No MikroTik device has been heard in the last 24 hours.',
  colIdentity: 'Identity',
  colBoard: 'Board · version',
  colInterface: 'Its interface',
  colHeardBy: 'Heard by',
  colSeen: 'Last heard',
  colDevice: 'Device',
  notInInventory: 'not in the inventory',
  listener: 'Listener',
  state: {
    listening: 'Listening',
    disabled: 'Off',
    bind_failed: 'Cannot open the port',
    stopped: 'Stopped',
  },
  notReported: 'Not reported (collector offline or an older version)',
  received: 'received',
  outOfScope: 'ignored (outside authorized ranges)',
  malformed: 'unreadable',
  noCollectors: 'No collector at this site.',
  firewallHint: 'Listening but nothing received: there may be no MikroTik device on this segment, discovery may be off on its interfaces, or the host firewall drops inbound UDP 5678 (Nigafiy does not change firewall rules).',
  onlyAdmins: 'Only an administrator can change this.',
};

type Dict = typeof en;

const ar: Dict = {
  title: 'الأجهزة المجاورة',
  description: 'ما تُبلغ عنه السويتشات بشأن الأجهزة المتصلة بها مباشرة (LLDP وCDP وMikroTik)، وأجهزة MikroTik التي سُمع إعلانها عن نفسها لدى المجمِّع.',
  protocol: { lldp: 'LLDP', cdp: 'CDP', mikrotik: 'MikroTik' },
  switchTable: 'ما تُبلغ عنه السويتشات',
  switchEmpty: 'لا يُبلغ أي سويتش عن جار. تُقرأ جداول الجيران مع السويتش (LLDP-MIB وCISCO-CDP-MIB وMIKROTIK-MIB)، وكثير من السويتشات الصغيرة لا يدعم أيًّا منها.',
  colSwitchPort: 'السويتش · المنفذ',
  colNeighbor: 'الجار',
  colRemotePort: 'منفذه',
  colAddress: 'العنوان',
  colPlatform: 'المنصة',
  mndpTitle: 'إعلانات MikroTik ‏(MNDP)',
  mndpExplain:
    'يستمع المجمِّع على منفذ UDP رقم 5678 للإعلانات التي تبثها أجهزة RouterOS مرة كل دقيقة تقريبًا. هو يستقبل فقط ولا يُرسل شيئًا. تُتجاهَل الإعلانات القادمة من خارج النطاقات المصرَّح بها.',
  mndpToggle: 'الاستماع لإعلانات MikroTik في هذا الموقع',
  mndpOff: 'مُعطَّل لهذا الموقع. تُغلق المجمِّعات المنفذ خلال 15 ثانية، وحُذفت الإعلانات المخزَّنة.',
  mndpEmpty: 'لم يُسمع أي جهاز MikroTik خلال آخر 24 ساعة.',
  colIdentity: 'الاسم المُعلَن',
  colBoard: 'اللوحة · الإصدار',
  colInterface: 'واجهته',
  colHeardBy: 'سمعه',
  colSeen: 'آخر سماع',
  colDevice: 'الجهاز',
  notInInventory: 'غير موجود في قائمة الأجهزة',
  listener: 'المستمع',
  state: {
    listening: 'يستمع',
    disabled: 'متوقف',
    bind_failed: 'تعذّر فتح المنفذ',
    stopped: 'متوقف عن العمل',
  },
  notReported: 'لم يُبلَّغ (المجمِّع غير متصل أو إصداره أقدم)',
  received: 'مُستقبَل',
  outOfScope: 'متجاهَل (خارج النطاقات المصرَّح بها)',
  malformed: 'غير مقروء',
  noCollectors: 'لا يوجد مجمِّع في هذا الموقع.',
  firewallHint:
    'يستمع لكن لم يستقبل شيئًا: قد لا يوجد جهاز MikroTik في هذا الجزء من الشبكة، أو أن الاكتشاف معطَّل على واجهاته، أو أن جدار حماية الجهاز يُسقط حزم UDP الواردة على المنفذ 5678 (Nigafiy لا يغيّر قواعد جدار الحماية).',
  onlyAdmins: 'التغيير متاح للمسؤول فقط.',
};

export const neighborsText = (locale: Locale): Dict => (locale === 'ar' ? ar : en);
