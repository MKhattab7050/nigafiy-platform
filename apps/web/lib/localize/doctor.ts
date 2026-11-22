import type { Diagnosis, EvidenceItem } from '@lan-detective/shared-types';
import type { Locale } from '@/lib/i18n';
import { ltr } from './bidi';

function localizeSource(source: string): string {
  const mCheck = source.match(/^(ICMP|TCP|DNS|HTTP|HTTPS|SNMP) check from the site collector$/i);
  if (mCheck) return `فحص ${ltr(mCheck[1]!.toUpperCase())} من مجمِّع الموقع`;
  if (source === 'TLS certificate check from the site collector') return 'فحص شهادة TLS من مجمِّع الموقع';
  const mWifi = source.match(/^Wi-Fi adapter of collector "(.+)"$/);
  if (mWifi) return `محوّل Wi-Fi على المجمِّع «${mWifi[1]}»`;
  const exact: Record<string, string> = {
    'Collector heartbeat': 'نبض اتصال المجمِّع',
    'Discovery sweeps': 'مسح اكتشاف الشبكة',
    'Discovery (ICMP + neighbour table)': 'الاكتشاف (ICMP + جدول الجيران)',
    'Discovery sweeps and path checks': 'مسح الاكتشاف وفحوصات المسار',
    'Event timeline (2 hours before now)': 'الخط الزمني للأحداث (آخر ساعتين)',
    'Collector spool, uploaded after reconnect': 'ذاكرة المجمِّع المؤقتة (رُفعت بعد عودة الاتصال)',
    'Presence of buffered samples': 'وجود قياسات مخزّنة مؤقتًا',
    'Telemetry received after reconnect': 'بيانات القياس الواردة بعد عودة الاتصال',
    'DHCPOFFER in reply to the collector’s DHCPDISCOVER probe': 'عرض DHCPOFFER ردًا على فحص DHCPDISCOVER من المجمِّع',
    'Clients’ DHCPREQUEST overheard by the collector': 'طلبات DHCPREQUEST من الأجهزة رصدها المجمِّع',
    'Collector DHCPDISCOVER probe (no lease is ever requested or accepted)': 'فحص DHCPDISCOVER من المجمِّع (بدون طلب أو حجز عنوان)',
    'Collector DHCP probe': 'فحص DHCP من المجمِّع',
    'Nearby networks in the collector’s Wi-Fi scan': 'الشبكات المجاورة في مسح Wi-Fi للمجمِّع',
    'Collector Wi-Fi scan': 'مسح Wi-Fi من المجمِّع',
  };
  return exact[source] ?? source;
}

function localizeLabel(label: string): string {
  if (label === 'Collectors reporting') return 'المجمِّعات التي ترسل تقارير';
  if (label === 'Recent change') return 'تغيير حديث';
  if (label === 'Devices that stopped responding in the last 30 min') return 'الأجهزة التي توقفت عن الاستجابة خلال آخر 30 دقيقة';
  if (label === 'Rest of the network') return 'باقي الشبكة';
  if (label === 'Buffered measurements from the gap') return 'القياسات المخزّنة خلال فترة الانقطاع';
  if (label === 'Collector host') return 'جهاز المجمِّع';
  if (label === 'Site internet') return 'إنترنت الموقع';
  if (label === 'DHCP probes') return 'فحوصات DHCP';
  if (label === 'Collector listening') return 'استماع المجمِّع';
  if (label === 'Link rate') return 'سرعة الربط اللاسلكي';
  if (label === 'Certificate') return 'الشهادة';
  if (label === 'HTTP response') return 'استجابة HTTP';
  const mOid = label.match(/^OID (.+)$/);
  if (mOid) return `المعرّف ${ltr(`OID ${mOid[1]}`)}`;

  const mHost = label.match(/^Host (.+)$/);
  if (mHost) return `الجهاز ${ltr(mHost[1]!)}`;
  const mCol = label.match(/^Collector "(.+)"$/);
  if (mCol) return `المجمِّع «${mCol[1]}»`;
  const mDhcp = label.match(/^DHCP server (.+)$/);
  if (mDhcp) return `خادم DHCP ${ltr(mDhcp[1]!)}`;
  const mSig = label.match(/^Signal from (.+) \(([^)]+)\)$/);
  if (mSig) return `قوة إشارة ${mSig[1] === '(hidden network)' ? '(شبكة مخفية)' : mSig[1]} (${ltr(mSig[2]!)})`;
  const mChan = label.match(/^Channel (\d+) occupancy$/);
  if (mChan) return `ازدحام القناة ${ltr(mChan[1]!)}`;
  if (label.startsWith('(hidden network)')) return label.replace('(hidden network)', '(شبكة مخفية)');
  return label;
}

function localizeValue(value: string): string {
  // Check status evidence from rules.ts
  const windowSuffix = (s: string) =>
    s.replace(
      / · last 15 min: (\d+)\/(\d+) samples succeeded/,
      (_, ok: string, total: string) => ` · آخر 15 دقيقة: نجح ${ltr(`${ok}/${total}`)} عينة`,
    );

  const mDown = value.match(/^Not responding \(([^)]+)\)(.*)$/);
  if (mDown) {
    const errText = mDown[1] === 'no reply' ? 'لا يوجد رد' : ltr(mDown[1]!);
    return `لا يستجيب (${errText})${windowSuffix(mDown[2]!)}`;
  }
  const mDeg = value.match(/^Responding but degraded: latency ([^,]+)(?:, loss ([^,·]+))?(?:, 7-day baseline ([^·]+))?(.*)$/);
  if (mDeg) {
    const parts = [`زمن الاستجابة ${ltr(mDeg[1]!.trim())}`];
    if (mDeg[2]) parts.push(`فقد الحزم ${ltr(mDeg[2].trim())}`);
    if (mDeg[3]) parts.push(`المتوسط المرجعي لـ 7 أيام ${ltr(mDeg[3].trim())}`);
    return `يستجيب مع تراجع: ${parts.join('، ')}${windowSuffix(mDeg[4]!)}`;
  }
  const mOk = value.match(/^Healthy: latency ([^,·]+)(?:, loss ([^·]+))?(.*)$/);
  if (mOk) {
    const parts = [`زمن الاستجابة ${ltr(mOk[1]!.trim())}`];
    if (mOk[2]) parts.push(`فقد الحزم ${ltr(mOk[2].trim())}`);
    return `سليم: ${parts.join('، ')}${windowSuffix(mOk[3]!)}`;
  }
  if (value === 'No measurements yet') return 'لا توجد قياسات بعد';

  const mOf = value.match(/^(\d+) of (\d+)$/);
  if (mOf) return `${ltr(mOf[1]!)} من ${ltr(mOf[2]!)}`;

  if (value === 'Offline in discovery sweeps') return 'غير متصل في مسح الاكتشاف';
  if (value === 'Online in discovery sweeps') return 'متصل في مسح الاكتشاف';
  if (value === 'Reporting again') return 'عاد لإرسال التقارير';
  if (value === 'No heartbeat') return 'لا يوجد نبض اتصال';
  if (value === 'Was running and measuring throughout') return 'كان يعمل ويقيس طوال فترة الانقطاع';
  if (value === 'Working during the gap') return 'كان يعمل خلال فترة الانقطاع';
  if (value === 'Not reported') return 'غير مُبلَّغ عنه';
  if (value === 'The DHCP client port was open, so replies would have been received') {
    return 'كان منفذ عميل DHCP مفتوحًا، لذا كانت الردود ستُستقبَل لو وُجدت';
  }

  const mMissed = value.match(/^No ICMP reply and no reachable neighbour entry in (\d+) consecutive sweeps$/);
  if (mMissed) return `لم يرد على ICMP ولم يظهر في جدول الجيران خلال ${ltr(mMissed[1]!)} عمليات مسح متتالية`;

  const mRest = value.match(/^(\d+) of (\d+) devices online; gateway\/internet healthy$/);
  if (mRest) return `${ltr(mRest[1]!)} من ${ltr(mRest[2]!)} جهازًا متصل؛ البوابة والإنترنت سليمان`;

  const mBuf = value.match(/^(\d+) samples; internet failures (\d+), gateway failures (\d+)$/);
  if (mBuf) return `${ltr(mBuf[1]!)} عينة؛ إخفاقات الإنترنت ${ltr(mBuf[2]!)}، إخفاقات البوابة ${ltr(mBuf[3]!)}`;

  const mProbes = value.match(/^(\d+) probe\(s\) so far, (\d+) interface\(s\) in authorized ranges probed last time(?:; (\d+) consecutive probe\(s\) without any offer)?$/);
  if (mProbes) {
    const extra = mProbes[3] ? `؛ ${ltr(mProbes[3])} فحوصات متتالية بدون أي عرض` : '';
    return `${ltr(mProbes[1]!)} فحص حتى الآن، فُحصت ${ltr(mProbes[2]!)} واجهة ضمن النطاقات المصرَّح بها آخر مرة${extra}`;
  }

  if (value.startsWith('Expected — ') || value.startsWith('Not expected')) {
    return value
      .replace('Expected — approved by an administrator', 'متوقَّع — معتمد من المسؤول')
      .replace("Expected — it is the site's gateway", 'متوقَّع — هو بوابة الموقع الافتراضية')
      .replace('Expected — the only DHCP server when monitoring began (not confirmed yet)', 'متوقَّع — خادم DHCP الوحيد عند بدء المراقبة (غير مؤكد بعد)')
      .replace('Not expected', 'غير متوقَّع')
      .replace(/offered ([0-9.]+)/g, (_, ip: string) => `عرض العنوان ${ltr(ip)}`)
      .replace(/gateway ([0-9., ]+)/g, (_, g: string) => `البوابة ${ltr(g.trim())}`)
      .replace(/DNS ([0-9., ]+)/g, (_, d: string) => `DNS ${ltr(d.trim())}`)
      .replace(/lease (\d+) min/g, (_, m: string) => `مدة الإيجار ${ltr(m)} د`)
      .replace(/(\d+) client\(s\) overheard requesting a lease from it/g, (_, n: string) => `رُصد ${ltr(n)} جهازًا يطلب عنوانًا منه`);
  }

  const mQual = value.match(/^(\d+)% quality \(≈ (-?\d+) dBm\)$/);
  if (mQual) return `جودة ${ltr(`${mQual[1]}%`)} (تقريبًا ${ltr(`${mQual[2]} dBm`)})`;

  const mRate = value.match(/^([^ ]+) Mbps receive \/ ([^ ]+) Mbps transmit(?: on ([0-9.]+) GHz channel ([^ ]+))?$/);
  if (mRate) {
    const band = mRate[3] ? ` على تردد ${ltr(`${mRate[3]} GHz`)} القناة ${ltr(mRate[4]!)}` : '';
    return `استقبال ${ltr(`${mRate[1]} Mbps`)} / إرسال ${ltr(`${mRate[2]} Mbps`)}${band}`;
  }

  const mInterf = value.match(/^Interference score (\d+) \((low|medium|high)\) from (\d+) other network\(s\)$/);
  if (mInterf) {
    const lvl = mInterf[2] === 'high' ? 'مرتفع' : mInterf[2] === 'medium' ? 'متوسط' : 'منخفض';
    return `درجة التداخل ${ltr(mInterf[1]!)} (${lvl}) من ${ltr(mInterf[3]!)} شبكة مجاورة`;
  }

  // Watch-check evidence (doctor/watch-rules.ts)
  const mCert = value.match(/^Expires (\d{4}-\d{2}-\d{2}) \((?:in ([0-9.]+) days|([0-9.]+) days ago)\)(?: · issuer (.+?))?( · chain does not verify for this name)?$/);
  if (mCert) {
    const when = mCert[2] !== undefined ? `بعد ${ltr(mCert[2])} يوم` : `منذ ${ltr(mCert[3]!)} يوم`;
    const parts = [`تنتهي في ${ltr(mCert[1]!)} (${when})`];
    if (mCert[4]) parts.push(`الجهة المُصدِرة ${ltr(mCert[4])}`);
    if (mCert[5]) parts.push('سلسلة الشهادة لا تتحقق لهذا الاسم');
    return parts.join(' · ');
  }
  const mStatus = value.match(/^Status (\d{3})(?: from (.+))?$/);
  if (mStatus) return `الحالة ${ltr(mStatus[1]!)}${mStatus[2] ? ` من ${ltr(mStatus[2])}` : ''}`;
  const mRaw = value.match(/^(.+) \(raw (.+)\)$/);
  if (mRaw) return `${ltr(mRaw[1]!)} (القيمة الخام ${ltr(mRaw[2]!)})`;

  const mContrib = value.match(/^Channel (\d+), signal (\d+)% → weight (\d+)$/);
  if (mContrib) return `القناة ${ltr(mContrib[1]!)}، الإشارة ${ltr(`${mContrib[2]}%`)} ← الوزن ${ltr(mContrib[3]!)}`;

  return value;
}

function localizeEvidence(items: EvidenceItem[]): EvidenceItem[] {
  return items.map((e) => ({
    ...e,
    label: localizeLabel(e.label),
    value: localizeValue(e.value),
    source: localizeSource(e.source),
  }));
}

/**
 * Translates deterministic Network Doctor diagnoses (`rules.ts` + `smart-rules.ts`) into native Arabic
 * when `locale === 'ar'`, preserving every measured number, IP, check name, and technical identifier.
 */
export function localizeDiagnosis(d: Diagnosis, locale: Locale): Diagnosis {
  if (locale !== 'ar') return d;

  const evidence = localizeEvidence(d.evidence);
  const ruled_out = localizeEvidence(d.ruled_out);

  const out: Diagnosis = { ...d, evidence, ruled_out };

  switch (d.rule) {
    case 'no-observer':
      return {
        ...out,
        title: 'لا يوجد مجمِّع يرسل تقارير من هذا الموقع',
        summary: 'لا يمكن تشخيص الشبكة حاليًا لأنه لا يوجد مجمِّع في هذا الموقع على اتصال بالمنصة. حالات الفحوصات المعروضة هي آخر ما تم استلامه.',
        probable_cause: 'غير معروف — لا توجد قياسات حالية.',
        confidence_reason: 'بدون مجمِّع نشط لا تتوفر قياسات حالية.',
        alternatives: ['فقد الموقع اتصاله بالإنترنت', 'الجهاز الذي يشغّل المجمِّع مطفأ أو توقفت خدمة المجمِّع'],
        investigation_steps: ['تأكد مما إذا كان الموقع متصلًا بالإنترنت', 'تأكد أن جهاز المجمِّع يعمل وأن خدمة المجمِّع قيد التشغيل'],
        recommendations: ['عند عودة المجمِّع للاتصال سيرفع القياسات التي جمعها أثناء الانقطاع؛ أعد تشغيل التشخيص حينها.'],
      };

    case 'missing-path-checks': {
      const m = d.confidence_reason.match(/(\d+) gateway check\(s\), (\d+) internet check\(s\)/);
      return {
        ...out,
        title: 'القياسات غير كافية للتشخيص',
        summary: 'تحديد موقع العطل يتطلب وجود فحص واحد على الأقل للبوابة الافتراضية وفحص واحد للإنترنت بنتائج مسجّلة.',
        probable_cause: 'غير معروف.',
        confidence_reason: m
          ? `النتائج المتاحة: ${ltr(m[1]!)} فحص للبوابة، و${ltr(m[2]!)} فحص للإنترنت.`
          : d.confidence_reason,
        investigation_steps: ['تأكد من تسجيل وتشغيل مجمِّع متصل في هذا الموقع', 'أبقِ فحوصات البوابة والإنترنت الافتراضية مفعّلة ضمن المراقبة المباشرة'],
        recommendations: [],
      };
    }

    case 'gateway-down-and-devices-lost': {
      const mLost = d.summary.match(/and (\d+) devices stopped/);
      const lostN = mLost ? mLost[1]! : String(d.affected.devices_offline);
      return {
        ...out,
        title: 'عطل في جزء من الشبكة المحلية',
        summary: `لا يستطيع المجمِّع الوصول إلى البوابة الافتراضية، وتوقف ${ltr(lostN)} جهازًا عن الاستجابة في نفس الوقت تقريبًا. العطل داخل الشبكة المحلية وليس عند مزوّد الخدمة.`,
        probable_cause: 'سويتش أو وصلة ربط (Uplink) أو الجزء من الشبكة المحلية المتصل به المجمِّع تعطّل أو انقطعت عنه الكهرباء.',
        confidence_reason: d.confidence === 'high'
          ? 'فشلت البوابة وكل أهداف الإنترنت معًا، وهو ما ينتج عن عطل محلي.'
          : 'البوابة لا ترد لكن أهداف الإنترنت لا تزال ترد — ربما البوابة تمنع ICMP فقط.',
        alternatives: ['البوابة نفسها تعطّلت وهي تعمل كسويتش أيضًا (راوتر مدمج)'],
        investigation_steps: [
          'تأكد أن الراوتر/جدار الحماية يعمل وأن مؤشرات منافذ LAN مضاءة',
          'من جهاز آخر على نفس الشبكة جرّب ping لعنوان البوابة',
          'تحقق من منفذ السويتش والكابل المتصل بجهاز المجمِّع',
          'تحقق من الكهرباء ووصلة الربط (Uplink) للسويتش الذي تتشارك فيه الأجهزة المتأثرة',
        ],
        recommendations: [
          'لا تتواصل مع مزوّد الخدمة بعد: العطل يقع قبل وصلة الإنترنت (WAN).',
          'إذا تم إعادة تشغيل الراوتر أو تحديثه للتو، انتظر اكتمال إقلاعه وراقب التعافي.',
        ],
      };
    }

    case 'gateway-down':
      return {
        ...out,
        title: 'البوابة الافتراضية لا تستجيب',
        summary: 'لا يستطيع المجمِّع الوصول إلى البوابة الافتراضية. فشل الإنترنت وDNS نتيجة تبعية لذلك — العطل داخل الشبكة المحلية وليس عند مزوّد الخدمة.',
        probable_cause: 'الراوتر أو جدار الحماية الذي يعمل كبوابة افتراضية متوقف أو يُعيد التشغيل أو لا يمكن الوصول إليه من المجمِّع.',
        confidence_reason: d.confidence === 'high'
          ? 'فشلت البوابة وكل أهداف الإنترنت معًا، وهو ما ينتج عن عطل محلي.'
          : 'البوابة لا ترد بينما أهداف الإنترنت لا تزال ترد — قد تكون البوابة تمنع رسائل ICMP فقط.',
        alternatives: [
          'كابل المجمِّع أو منفذ السويتش أو اتصال Wi-Fi الخاص به فقط هو المنقطع',
          ...(d.alternatives.length > 1 ? ['البوابة تتجاهل طلبات ICMP (في هذه الحالة يُفضَّل تحويل الفحص إلى TCP)'] : []),
        ],
        investigation_steps: [
          'تأكد أن الراوتر/جدار الحماية يعمل وأن مؤشرات منافذ LAN مضاءة',
          'من جهاز آخر على نفس الشبكة جرّب ping لعنوان البوابة',
          'تحقق من منفذ السويتش والكابل المتصل بجهاز المجمِّع',
        ],
        recommendations: [
          'لا تتواصل مع مزوّد الخدمة بعد: العطل يقع قبل وصلة الإنترنت (WAN).',
          'إذا تم إعادة تشغيل الراوتر أو تحديثه للتو، انتظر اكتمال إقلاعه وراقب التعافي.',
        ],
      };

    case 'gateway-ok-internet-down': {
      const mCnt = d.summary.match(/all (\d+) independent internet targets/);
      const mLat = d.confidence_reason.match(/responds \(([^)]+)\)/);
      return {
        ...out,
        title: 'انقطاع الاتصال بالإنترنت (WAN / مزوّد الخدمة)',
        summary: mCnt
          ? `البوابة المحلية ترد بشكل طبيعي، لكن جميع أهداف الإنترنت المستقلة (${ltr(mCnt[1]!)}) لا تستجيب. الشبكة المحلية سليمة والعطل على جانب WAN.`
          : 'البوابة المحلية ترد بشكل طبيعي، لكن هدف الإنترنت لا يستجيب. الشبكة المحلية سليمة والعطل على جانب WAN.',
        probable_cause: 'وصلة WAN أو مزوّد الخدمة (ISP) أو واجهة WAN / المودم في الراوتر متوقفة.',
        confidence_reason: mCnt
          ? `فشلت ${ltr(mCnt[1]!)} أهداف إنترنت مستقلة بينما البوابة تستجيب (${ltr(mLat?.[1] ?? '—')}).`
          : 'يوجد هدف إنترنت واحد فقط مُعدّ؛ ولا يكفي وحده للتمييز بين انقطاع مزوّد الخدمة وتعطّل هذا الهدف فقط.',
        alternatives: [
          'قاعدة جدار حماية جديدة تمنع ICMP الصادر',
          ...(!mCnt ? ['هدف الإنترنت الوحيد نفسه غير متاح حاليًا'] : []),
        ],
        investigation_steps: [
          'تحقق من مؤشر WAN / الإنترنت على الراوتر والمودم (ONT)',
          'افتح صفحة حالة الراوتر وتأكد مما إذا كانت واجهة WAN تملك عنوان IP',
          'تحقق مع مزوّد الخدمة من وجود عطل مُبلَّغ عنه في المنطقة',
          'راجع أي تعديلات حديثة على قواعد جدار الحماية',
        ],
        recommendations: [
          'أعد تشغيل المودم (ONT) ثم الراوتر إذا كانت واجهة WAN بلا اتصال.',
          'تواصل مع مزوّد الخدمة مع تزويده بوقت بدء الانقطاع الظاهر في الخط الزمني للحادثة.',
        ],
      };
    }

    case 'partial-internet': {
      const m = d.summary.match(/^(\d+) of (\d+)/);
      return {
        ...out,
        title: 'وجهة إنترنت واحدة لا تستجيب',
        summary: m
          ? `${ltr(m[1]!)} من ${ltr(m[2]!)} أهداف إنترنت لا تستجيب بينما البقية تعمل. الاتصال العام بالإنترنت سليم.`
          : 'بعض أهداف الإنترنت لا تستجيب بينما البقية تعمل بشكل طبيعي.',
        probable_cause: 'مشكلة في الوجهة المحددة أو المسار إليها؛ العطل خارج الشبكة المحلية.',
        confidence_reason: 'أهداف إنترنت أخرى تعمل عبر نفس البوابة ووصلة WAN.',
        alternatives: ['قاعدة جدار حماية تحجب هذه الوجهة فقط', 'مشكلة توجيه لدى مزوّد الخدمة تؤثر على بعض الشبكات فقط'],
        investigation_steps: [
          'تحقق مما إذا كان المستخدمون يواجهون مشكلة فعلية — قد يقتصر الأمر على الهدف المُراقَب فقط',
          'شغّل traceroute نحو الوجهة المتعطلة لمعرفة نقطة التوقف',
        ],
        recommendations: ['إذا استمرت المشكلة دون تأثّر أي خدمة أخرى، استبدل هذا الهدف بعنوان معروف آخر.'],
      };
    }

    case 'dns-down':
    case 'dns-slow': {
      const isDown = d.rule === 'dns-down';
      return {
        ...out,
        title: isDown ? 'فشل ترجمة الأسماء (DNS)' : 'بطء في ترجمة الأسماء (DNS)',
        summary: `البوابة وأهداف الإنترنت تستجيب طبيعيًا عبر عنوان IP، لكن ترجمة الأسماء ${isDown ? 'تفشل' : 'أبطأ من الحد المقبول'}. يشعر المستخدمون بأن «الإنترنت مقطوع/بطيء» رغم سلامة الاتصال.`,
        probable_cause: d.probable_cause.includes('forwarder/upstream DNS is misconfigured')
          ? 'خادم DNS يرد لكنه يعجز عن ترجمة الاسم — خادم DNS العلوي (Upstream/Forwarder) غير مضبوط أو غير متاح.'
          : 'خادم DNS المستخدم في الشبكة لا يرد أو تحت ضغط عالٍ أو خادمه العلوي غير متاح.',
        confidence_reason: d.confidence === 'high'
          ? 'الوصول المباشر لعناوين الإنترنت يعمل في نفس وقت فشل ترجمة الأسماء.'
          : 'أهداف الإنترنت نفسها متراجعة، ما قد يسبب بطء DNS.',
        alternatives: ['تم حظر منفذ DNS الصادر (53) بسبب تغيير في جدار الحماية'],
        investigation_steps: [
          'تحقق من خادم DNS الذي توزّعه الشبكة عبر DHCP — الفحص يستخدم خادم DNS المضبوط على جهاز المجمِّع',
          'استعلم من هذا الخادم مباشرة وقارنه بخادم عام (مثل 1.1.1.1)',
          'تحقق من إعدادات التوجيه (Forwarder) في خادم DNS وتأكد أن الخدمة تعمل',
        ],
        recommendations: ['إذا كان خادم DNS الداخلي متوقفًا، أعد تشغيل خدمته أو وجّه DHCP مؤقتًا لخادم DNS عامل.'],
      };
    }

    case 'gateway-degraded': {
      const mLoss = d.summary.match(/shows (\d+%) packet loss/);
      const mLat = d.summary.match(/high latency \(([^)]+)\)/);
      const metric = mLoss ? `فقد حزم بنسبة ${ltr(mLoss[1]!)}` : mLat ? `زمن استجابة مرتفع (${ltr(mLat[1]!)})` : 'تراجع في الأداء';
      return {
        ...out,
        title: 'تراجع جودة المسار في الشبكة المحلية',
        summary: `تُظهر الحركة بين المجمِّع والبوابة الافتراضية ${metric}. هذه القفزة بالكامل داخل الشبكة المحلية، لذا فإن البطء الذي يراه المستخدمون يبدأ من هنا.`,
        probable_cause: 'مشكلة محلية: كابل أو منفذ سويتش تالف، تداخل Wi-Fi إن كان الاتصال لاسلكيًا، حلقة شبكية (Loop/Broadcast Storm)، أو حمل مرتفع على الراوتر.',
        confidence_reason: 'البوابة على بُعد قفزة محلية واحدة؛ الفقد أو التأخير هنا لا يمكن أن يكون من مزوّد الخدمة.',
        alternatives: ['البوابة تخفّض أولوية ICMP عند ارتفاع حمل المعالج (وقد تكون الحركة الفعلية أقل تأثرًا)'],
        investigation_steps: [
          'تحقق من استهلاك المعالج والحمل على الراوتر أو جدار الحماية',
          'افحص كابل ومنفذ السويتش الخاص بجهاز المجمِّع وعدادات الأخطاء على المنفذ',
          'ابحث عن جهاز يولّد حركة شبكية كثيفة غير معتادة',
        ],
        recommendations: ['إذا كان المجمِّع متصلًا عبر Wi-Fi، وصّله بكابل شبكة لقياس الشبكة السلكية بدقة.'],
      };
    }

    case 'internet-degraded': {
      const m = d.summary.match(/normally \(([^)]+)\) but (\d+) of (\d+)/);
      const mBase = d.summary.match(/\(now ([^,]+), 7-day baseline ([^)]+)\)/);
      const baseNote = mBase ? ` (الآن ${ltr(mBase[1]!)} مقابل متوسط 7 أيام ${ltr(mBase[2]!)})` : '';
      return {
        ...out,
        title: 'اتصال الإنترنت بطيء أو يفقد حزمًا',
        summary: m
          ? `البوابة المحلية ترد طبيعيًا (${ltr(m[1]!)}) لكن ${ltr(m[2]!)} من ${ltr(m[3]!)} أهداف إنترنت تتجاوز حدود التأخير أو الفقد${baseNote}.`
          : `البوابة المحلية سليمة لكن أهداف الإنترنت تُظهر تأخيرًا أو فقدًا مرتفعًا${baseNote}.`,
        probable_cause: 'وصلة WAN مزدحمة أو متأثرة: إما أن خط الرفع/التنزيل ممتلئ بحركة محلية أو توجد مشكلة جودة لدى مزوّد الخدمة.',
        confidence_reason: d.confidence === 'medium'
          ? 'تأثرت جميع أهداف الإنترنت بينما القفزة المحلية سليمة؛ ويبدو امتلاء الخط ومشكلة مزوّد الخدمة متشابهَين دون بيانات استهلاك السرعة.'
          : 'تأثرت بعض الأهداف فقط؛ وقد تكون المشكلة خاصة بتلك الوجهات.',
        alternatives: ['عملية رفع أو تنزيل أو نسخ احتياطي كبيرة تستهلك كامل الخط', 'ازدحام لدى مزوّد الخدمة في أوقات الذروة'],
        investigation_steps: [
          'راجع استهلاك WAN على الراوتر للتحقق من وجود جهاز أو نقل ملفات يملأ الخط',
          'قارن مع نفس الساعة في الأيام السابقة عبر سجل القياسات',
          'أجرِ اختبار سرعة من حاسوب متصل بكابل',
        ],
        recommendations: ['إذا تكررت المشكلة في نفس الساعات، افتح بلاغًا لدى مزوّد الخدمة مرفقًا بالرسوم البيانية كدليل.'],
      };
    }

    case 'all-healthy': {
      const mAll = d.confidence_reason.match(/All (\d+) path checks/);
      return {
        ...out,
        title: 'لا توجد مشكلة في مسار الشبكة',
        summary: 'البوابة الافتراضية وأهداف الإنترنت وترجمة الأسماء (DNS) تعمل جميعها ضمن الحدود الطبيعية.',
        probable_cause: 'لا يوجد — القياسات طبيعية.',
        confidence_reason: mAll ? `جميع فحوصات المسار (${ltr(mAll[1]!)}) سليمة.` : 'جميع فحوصات المسار سليمة.',
        investigation_steps: ['إذا استمر المستخدمون في الإبلاغ عن مشكلة، فالغالب أنها تخص جهازًا أو تطبيقًا أو منطقة Wi-Fi معينة — افحص ذلك الجهاز من صفحة الأجهزة.'],
        recommendations: [],
      };
    }

    case 'service-during-network-fault': {
      const name = d.title.split(':')[0] ?? d.title;
      return {
        ...out,
        title: `${name}: غير متاح أثناء عطل أوسع في الشبكة`,
        summary: 'فحص هذه الخدمة يفشل بالتزامن مع وجود عطل في مسار الشبكة بالموقع. قد تكون الخدمة نفسها سليمة.',
        probable_cause: 'غالبًا نتيجة لعطل الشبكة العام وليس عطلًا في الخدمة ذاتها.',
        confidence_reason: 'يوجد عطل شبكي منفصل نشط؛ ولا يمكن الفصل بينهما حتى يُحل.',
        alternatives: ['تعطّلت الخدمة بشكل مستقل في نفس الوقت'],
        investigation_steps: ['عالج حادثة الشبكة أولًا ثم تحقق مما إذا كان هذا الفحص سيتعافى تلقائيًا'],
      };
    }

    case 'service-host-offline': {
      const name = d.title.split(':')[0] ?? d.title;
      const m = d.summary.match(/device at ([^ ]+) \(([^)]+)\)/);
      return {
        ...out,
        title: `${name}: الجهاز المضيف غير متصل`,
        summary: m
          ? `توقف الجهاز ${m[2]} على العنوان ${ltr(m[1]!)} عن الاستجابة لمسح الاكتشاف أيضًا، لذا فالجهاز بالكامل غير متاح وليس هذه الخدمة فقط.`
          : 'توقف الجهاز المضيف عن الاستجابة لمسح الاكتشاف أيضًا، لذا فالجهاز بالكامل غير متاح.',
        probable_cause: 'الخادم أو الجهاز مطفأ أو توقّف عن العمل أو فُصل عن الشبكة.',
        confidence_reason: 'ملاحظتان مستقلتان متفقتان: فحص الخدمة يفشل والاكتشاف لم يعد يرى الجهاز.',
        investigation_steps: ['تحقق من الطاقة وكابل الشبكة للجهاز', 'افحص شاشة الجهاز أو الخادم الافتراضي للتأكد من عدم توقفه أو إعادة تشغيله'],
      };
    }

    case 'service-port-refused': {
      const name = d.title.split(':')[0] ?? d.title;
      const mPort = d.summary.match(/port (\d+)/);
      return {
        ...out,
        title: `${name}: الخدمة لا تستمع على المنفذ`,
        summary: `رفض الجهاز محاولة الاتصال بالمنفذ ${ltr(mPort?.[1] ?? '—')}. الجهاز يعمل ومتصل بالشبكة، لكن لا توجد خدمة تقبل الاتصالات على هذا المنفذ.`,
        probable_cause: 'توقفت عملية الخدمة أو تعطلت (أو تستمع على منفذ أو واجهة مختلفة).',
        confidence_reason: 'الرفض النشط (TCP RST) لا يصدر إلا من جهاز متصل لا يوجد عليه مستمع على هذا المنفذ.',
        alternatives: ['جدار الحماية على الجهاز مضبوط لرفض (Reject) الاتصال بدل إسقاطه'],
        investigation_steps: ['تحقق من حالة الخدمة وسجلاتها على الجهاز', 'تأكد من المنفذ والعنوان الذي تستمع عليه الخدمة'],
        recommendations: ['أعد تشغيل الخدمة بعد قراءة سجلاتها لمعرفة سبب توقفها.'],
      };
    }

    case 'service-name-unresolved': {
      const name = d.title.split(':')[0] ?? d.title;
      const mTarget = d.summary.match(/The name ([^ ]+) could not/);
      return {
        ...out,
        title: `${name}: تعذّر ترجمة اسم الهدف`,
        summary: `لم يتمكن خادم DNS على جهاز المجمِّع من ترجمة الاسم ${ltr(mTarget?.[1] ?? '—')}، فلم تُجرَ أي محاولة اتصال بالخدمة.`,
        probable_cause: 'سجل DNS مفقود أو خاطئ لهذا الاسم، أو مشكلة في خادم DNS الداخلي.',
        confidence_reason: 'حدث الفشل في مرحلة ترجمة الاسم قبل محاولة الاتصال.',
        investigation_steps: ['تحقق من سجل DNS لهذا الاسم على خادم DNS الداخلي'],
      };
    }

    case 'service-unresponsive': {
      const name = d.title.split(':')[0] ?? d.title;
      const mTarget = d.summary.match(/Connections to ([^ ]+) get/);
      const hostSeen = d.summary.includes('host itself is still seen');
      return {
        ...out,
        title: `${name}: لا يستجيب`,
        summary: `الاتصالات إلى ${ltr(mTarget?.[1] ?? '—')} لا تلقى ردًا${hostSeen ? '، رغم أن الجهاز نفسه لا يزال مرئيًا على الشبكة' : ''}.`,
        probable_cause: hostSeen ? 'جدار حماية يُسقط الاتصال، أو الخدمة متجمدة عن الاستجابة.' : 'الجهاز متوقف أو غير متاح، أو جدار حماية يُسقط الاتصال.',
        confidence_reason: hostSeen
          ? 'الجهاز متصل في مسح الاكتشاف، ما يحصر السبب في الخدمة أو جدار الحماية.'
          : 'الهدف ليس ضمن قائمة الأجهزة المكتشفة، لذا فحالة الجهاز غير معروفة.',
        alternatives: hostSeen ? [] : ['الجهاز مطفأ'],
        investigation_steps: [
          'تحقق من حالة الخدمة على الجهاز',
          'راجع قواعد جدار الحماية على الجهاز والشبكة لهذا المنفذ',
          ...(hostSeen ? [] : ['أضف شبكة هذا الجهاز كنطاق مصرَّح به لمتابعة توفره']),
        ],
      };
    }

    case 'device-during-wider-fault': {
      const name = d.title.replace(/ is offline.*$/, '');
      const mWide = d.summary.match(/^(\d+) of (\d+) devices/);
      return {
        ...out,
        title: `${name} غير متصل — ضمن مشكلة أوسع`,
        summary: mWide
          ? `توقف ${ltr(mWide[1]!)} من ${ltr(mWide[2]!)} جهازًا عن الاستجابة في نفس الوقت تقريبًا.`
          : 'يوجد أيضًا عطل نشط في مسار الشبكة بالموقع.',
        probable_cause: 'سبب مشترك (سويتش أو كهرباء أو مسار الشبكة) وليس هذا الجهاز وحده.',
        confidence_reason: 'توقفت عدة عناصر معًا في الوقت نفسه.',
        investigation_steps: ['ابحث عن القاسم المشترك بين الأجهزة المتأثرة: السويتش، خط الكهرباء، أو الغرفة'],
      };
    }

    case 'device-alone-offline': {
      const name = d.title.replace(/ is offline$/, '');
      return {
        ...out,
        title: `${name} غير متصل`,
        summary: 'توقف هذا الجهاز المهم عن الاستجابة بينما باقي الشبكة تعمل بشكل سليم.',
        probable_cause: 'مشكلة في الجهاز نفسه: الكهرباء أو توقف النظام أو الكابل أو منفذ السويتش.',
        confidence_reason: 'باقي الأجهزة ومسار الشبكة يعملان بشكل طبيعي، ما يحصر العطل في هذا الجهاز أو وصلته. (الجهاز الذي يحظر ICMP وARP معًا سيظهر بنفس الشكل.)',
        alternatives: ['غيّر الجهاز عنوان IP ولم يمكن تتبّعه لعدم ظهور عنوان MAC'],
        investigation_steps: ['تحقق من الطاقة ومؤشرات الشبكة على الجهاز', 'افحص منفذ السويتش والكابل', 'افحص شاشة الجهاز للتأكد من عدم تعطله أو دخوله في حلقة إعادة تشغيل'],
      };
    }

    case 'collector-gap-explained': {
      const gwLost = d.title.includes('local gateway');
      const m = d.summary.match(/internet checks failed (\d+) times(?: and gateway checks (\d+) times)?/);
      return {
        ...out,
        title: gwLost ? 'فقد الموقع بوابته المحلية — فانقطع اتصال المجمِّع' : 'فقد الموقع اتصاله بالإنترنت — فانقطع اتصال المجمِّع',
        summary: m
          ? `واصل المجمِّع القياس أثناء تعذّر وصوله للمنصة ثم رفع النتائج لاحقًا: فشلت فحوصات الإنترنت ${ltr(m[1]!)} مرة${m[2] ? ` وفحوصات البوابة ${ltr(m[2])} مرة` : ' بينما استمرت البوابة في الاستجابة'}.`
          : 'واصل المجمِّع القياس أثناء انقطاع الاتصال ورفع النتائج بعد عودته.',
        probable_cause: gwLost ? 'كانت البوابة المحلية متوقفة، ما قطع المجمِّع عن المنصة أيضًا.' : 'انقطاع في وصلة WAN أو لدى مزوّد الخدمة بالموقع.',
        confidence_reason: 'استنادًا إلى القياسات المخزّنة محليًا في المجمِّع خلال فترة الانقطاع.',
        investigation_steps: ['راجع حادثة الشبكة في نفس الفترة للاطلاع على التشخيص التفصيلي للمسار'],
      };
    }

    case 'collector-gap-cloud-only': {
      const m = d.summary.match(/\((\d+) samples\)/);
      return {
        ...out,
        title: 'تعذّر وصول المجمِّع للمنصة رغم توفر الإنترنت بالموقع',
        summary: `خلال فترة الانقطاع استمرت فحوصات الإنترنت من المجمِّع في النجاح (${ltr(m?.[1] ?? '—')} عينة)، لذا كان الموقع متصلًا بالإنترنت؛ وفشل الاتصال بمنصة Nigafiy فقط.`,
        probable_cause: 'تم حظر أو فشل اتصال HTTPS الصادر نحو الخادم (تغيير في جدار الحماية/البروكسي، فحص TLS، أو مشكلة DNS لاسم الخادم).',
        confidence_reason: 'القياسات المخزّنة تثبت عمل الإنترنت خلال فترة الانقطاع.',
        alternatives: ['عطل مؤقت في خادم المنصة'],
        investigation_steps: ['تحقق من قواعد جدار الحماية أو البروكسي لاتصالات HTTPS الصادرة من جهاز المجمِّع'],
      };
    }

    case 'collector-not-measuring': {
      const m = d.title.match(/^Collector "(.+)"/);
      return {
        ...out,
        title: `المجمِّع «${m?.[1] ?? '—'}» لم يكن يعمل`,
        summary: 'عاد المجمِّع للاتصال دون رفع أي قياسات من فترة الانقطاع. المجمِّع العامل يستمر في القياس وتخزين النتائج، لذا لم يكن قيد التشغيل خلال تلك الفترة.',
        probable_cause: 'جهاز المجمِّع كان مطفأً أو يُعيد التشغيل، أو توقفت خدمة المجمِّع.',
        confidence_reason: 'عدم وجود قياسات مخزّنة لفترة الانقطاع (قد يظهر نفس الأمر إذا مُسح مجلد التخزين المؤقت).',
        alternatives: ['تم حذف مجلد حالة المجمِّع (التخزين المؤقت)'],
        investigation_steps: ['تحقق من مدة تشغيل جهاز المجمِّع وسجلات الخدمة وقت الانقطاع'],
        recommendations: ['شغّل المجمِّع كخدمة نظام مع إعادة تشغيل تلقائية (systemd أو خدمة Windows أو سياسة إعادة تشغيل Docker).'],
      };
    }

    case 'collector-silent': {
      const m = d.title.match(/^Collector "(.+)"/);
      return {
        ...out,
        title: `فقد المجمِّع «${m?.[1] ?? '—'}» الاتصال`,
        summary: 'توقفت المنصة عن استلام نبضات الاتصال من هذا المجمِّع. لا يمكن التمييز بين الأسباب المحتملة من خارج الموقع؛ وتظهر حالات الأجهزة كـ«غير معروف» بدلًا من «غير متصل».',
        probable_cause: 'غير محدد حتى يعود المجمِّع للاتصال.',
        confidence_reason: 'لا توجد قياسات من داخل الموقع حاليًا.',
        alternatives: ['فقد الموقع اتصاله بالإنترنت', 'جهاز المجمِّع مطفأ أو يُعيد التشغيل', 'توقفت خدمة المجمِّع', 'اتصال HTTPS الصادر من المجمِّع محجوب'],
        investigation_steps: ['اسأل أحد الموجودين في الموقع إن كان الإنترنت يعمل', 'تأكد أن جهاز المجمِّع يعمل وأن الخدمة قيد التشغيل'],
        recommendations: ['عند عودة المجمِّع سيرفع قياساته المخزّنة ويُحدَّث هذا التشخيص تلقائيًا.'],
      };
    }

    case 'dhcp-rogue-server': {
      const mOne = d.title.match(/^Unexpected DHCP server (.+)$/);
      const mMany = d.title.match(/^(\d+) unexpected DHCP servers$/);
      const hijack = d.summary.includes('different gateway or DNS');
      const taking = d.summary.includes('clients are taking leases');
      return {
        ...out,
        title: mOne ? `خادم DHCP غير متوقَّع ${ltr(mOne[1]!)}` : mMany ? `${ltr(mMany[1]!)} خوادم DHCP غير متوقَّعة` : 'خادم DHCP غير متوقَّع',
        summary: `استجاب خادم DHCP غير متوقَّع لفحص المجمِّع${taking ? ' وتأخذ منه الأجهزة عناوين بالفعل' : ''}. الأجهزة التي تقبل عرضه تحصل على ${hijack ? 'بوابة أو خادم DNS مختلف — ما قد يقطع حركتها أو يعترضها' : 'عناوين قد تتعارض مع خادم DHCP الحقيقي'}.`,
        probable_cause: 'وجود خادم DHCP ثانٍ على الشبكة: راوتر منزلي أو نقطة وصول موصولة من منفذ LAN، نقطة اتصال هاتف، آلة افتراضية بوضع Bridge، خادم غير مضبوط — أو هجوم متعمد.',
        confidence_reason: d.confidence === 'high'
          ? 'استجاب الخادم لأكثر من فحص، أو رُصدت أجهزة تطلب منه عناوين.'
          : 'رُصد في فحص واحد حتى الآن؛ وسيؤكده الفحص القادم.',
        alternatives: ['خادم DHCP ثانٍ شرعي (مثل خادم احتياطي أو راوتر شبكة ضيوف) — يمكنك تعليمه كمتوقَّع'],
        investigation_steps: [
          'ابحث عن عنوان MAC للخادم في كاشف منافذ السويتش لتحديد المنفذ المتصل به',
          'تحقق من البوابة وخوادم DNS التي يعرضها: أي عنوان خارج شبكتك علامة خطر',
          'افصل الجهاز أو أعد ضبطه (أوقف خادم DHCP عليه أو وصّله من منفذ WAN)',
        ],
        recommendations: ['فعّل DHCP Snooping على السويتشات المُدارة ليقتصر الرد على المنافذ الموثوقة', 'إذا كان الخادم شرعيًا، علّمه كمتوقَّع حتى لا يُبلَّغ عنه مجددًا'],
      };
    }

    case 'dhcp-no-offer': {
      const m = d.summary.match(/last (\d+) DHCP probes/);
      return {
        ...out,
        title: 'لا يوجد خادم DHCP يستجيب',
        summary: `لم تحصل آخر ${ltr(m?.[1] ?? '—')} فحوصات DHCP من المجمِّع على أي عرض. الأجهزة التي تنضم أو تجدد عنوانها الآن لن تحصل على IP.`,
        probable_cause: 'خادم DHCP (غالبًا الراوتر) متوقف أو توقفت خدمته، أو نفد نطاق العناوين المتاحة، أو تعطل مرحّل DHCP بين الشبكات الافتراضية (VLANs).',
        confidence_reason: `استطاع المجمِّع الاستماع للردود ولم يصل أي رد خلال ${ltr(m?.[1] ?? '—')} فحوصات متتالية.`,
        alternatives: ['خادم DHCP يتجاهل الأجهزة التي رآها سابقًا (أمر نادر)', 'جدار الحماية على جهاز المجمِّع يُسقط ردود DHCP الواردة'],
        investigation_steps: ['تحقق من خدمة DHCP على الراوتر أو الخادم', 'تحقق من نسبة امتلاء نطاق العناوين في IPAM', 'إن كانت الشبكة مقسمة إلى VLANs فتحقق من مرحّل DHCP (ip helper-address)'],
      };
    }

    case 'dhcp-not-measured': {
      const listenErr = d.title.includes('could not listen');
      return {
        ...out,
        title: listenErr ? 'تعذّر على المجمِّع الاستماع لردود DHCP' : 'لم يُفحص DHCP بعد',
        summary: listenErr
          ? `لم يتمكن المجمِّع من فتح منفذ عميل DHCP: ${ltr(d.summary.replace(/^The collector could not open the DHCP client port: /, '').replace(/\.$/, ''))}.`
          : 'يفحص المجمِّع خدمة DHCP كل 15 دقيقة على الشبكات ضمن النطاقات المصرَّح بها.',
        probable_cause: 'غير معروف.',
        confidence_reason: 'لم يُرصَد أي رد DHCP بعد.',
        investigation_steps: listenErr
          ? ['على Linux امنح المجمِّع صلاحية CAP_NET_BIND_SERVICE (وCAP_NET_RAW للربط بواجهة محددة)', 'على Windows اسمح بمنفذ UDP 68 الوارد للمجمِّع في جدار الحماية']
          : ['تأكد أن شبكة جهاز المجمِّع نفسها ضمن نطاق مصرَّح به'],
      };
    }

    case 'dhcp-healthy':
      return {
        ...out,
        title: 'خدمة DHCP سليمة',
        summary: d.summary.includes('Only the expected') ? 'خادم DHCP المتوقَّع فقط هو الذي استجاب.' : 'استجابت خدمة DHCP بشكل سليم.',
        probable_cause: 'لا يوجد عطل.',
        confidence_reason: 'استنادًا إلى أحدث فحص DHCP.',
        recommendations: d.recommendations.length ? ['أكّد خادم DHCP الذي افتُرض أنه المتوقَّع عند بدء المراقبة.'] : [],
      };

    case 'wifi-weak-signal': {
      const mCol = d.title.match(/collector "(.+)"$/);
      const mSum = d.summary.match(/receives "(.+)" at (-?\d+) dBm\. Below about (-?\d+) dBm/);
      return {
        ...out,
        title: `إشارة Wi-Fi ضعيفة عند المجمِّع «${mCol?.[1] ?? '—'}»`,
        summary: mSum
          ? `يستقبل المجمِّع شبكة «${mSum[1]}» بقوة ${ltr(`${mSum[2]} dBm`)}. تحت ${ltr(`${mSum[3]} dBm`)} تنخفض السرعة ويصبح الاتصال غير مستقر.`
          : 'قوة إشارة Wi-Fi منخفضة عند موقع المجمِّع، ما يضعف السرعة والاستقرار.',
        probable_cause: 'مسافة كبيرة أو جدران كثيرة بين هذا الموقع ونقطة الوصول، أو انخفاض قدرة البث.',
        confidence_reason: d.confidence === 'high' ? 'قوة الإشارة مقاسة مباشرة بوحدة dBm من محوّل الشبكة.' : 'مقدَّرة من نسبة جودة الإشارة في المحوّل وهي قيمة تقريبية.',
        alternatives: ['هوائي المحوّل ضعيف أو محجوب (مثل قطعة USB خلف الحاسوب)'],
        investigation_steps: ['قرّب نقطة الوصول أو أضف نقطة وصول/عقدة Mesh قرب هذا المكان', 'تأكد أن نقطة الوصول ليست مخبأة داخل خزانة أو خلف معدن', 'يُفضَّل استخدام كابل للأجهزة الثابتة'],
      };
    }

    case 'wifi-congested-channel': {
      const mTitle = d.title.match(/channel (\d+) is congested(?: — channel (\d+) is clearer)?/);
      const mSum = d.summary.match(/^(\d+) other network\(s\).*channel (\d+)/);
      const mRec = d.summary.match(/Channel (\d+) scores (\d+) against (\d+)/);
      return {
        ...out,
        title: mTitle?.[2]
          ? `قناة Wi-Fi رقم ${ltr(mTitle[1]!)} مزدحمة — القناة ${ltr(mTitle[2])} أصفى`
          : `قناة Wi-Fi رقم ${ltr(mTitle?.[1] ?? '—')} مزدحمة`,
        summary: `${ltr(mSum?.[1] ?? '—')} شبكة مجاورة تعمل على القناة ${ltr(mSum?.[2] ?? '—')} أو تتداخل معها عند موقع المجمِّع.${mRec ? ` درجة التداخل على القناة ${ltr(mRec[1]!)} هي ${ltr(mRec[2]!)} مقابل ${ltr(mRec[3]!)} حاليًا.` : ' لم يُعثَر على قناة قياسية أفضل بوضوح.'}`,
        probable_cause: 'الشبكات المجاورة تتقاسم زمن البث على نفس القناة، فتنتظر كل الأجهزة وقتًا أطول للإرسال.',
        confidence_reason: 'بناءً على الشبكات المسموعة عند موقع المجمِّع فقط؛ وقد تختلف الشبكات المجاورة في أماكن أخرى من الموقع.',
        alternatives: ['التداخل غير اللاسلكي (الميكروويف، البلوتوث، الهواتف اللاسلكية) على 2.4 GHz لا يظهر في مسح Wi-Fi'],
        investigation_steps: mTitle?.[2]
          ? [`اضبط نقطة الوصول على القناة ${ltr(mTitle[2])} في إعدادات Wi-Fi وقارن الأداء`]
          : ['فضّل تردد 5 GHz للأجهزة الداعمة له'],
        recommendations: d.recommendations.length ? ['استخدم عرض قناة 20 MHz على تردد 2.4 GHz واختر فقط القناة 1 أو 6 أو 11'] : [],
      };
    }

    case 'wifi-low-phy-rate': {
      const mTitle = d.title.match(/collector "(.+)" \((\d+) Mbps\)$/);
      return {
        ...out,
        title: `سرعة ربط Wi-Fi منخفضة عند المجمِّع «${mTitle?.[1] ?? '—'}» (${ltr(`${mTitle?.[2] ?? '—'} Mbps`)})`,
        summary: `تفاوض المحوّل على سرعة ${ltr(`${mTitle?.[2] ?? '—'} Mbps`)} فقط رغم أن قوة الإشارة ${d.summary.includes('not reported') ? 'غير مُبلَّغ عنها' : 'كافية'}.`,
        probable_cause: d.probable_cause.includes('Channel congestion')
          ? 'ازدحام القناة يفرض سرعات ربط أقل.'
          : 'معيار Wi-Fi قديم أو قناة ضيقة أو وضع التوافق القديم على نقطة الوصول أو تداخل.',
        confidence_reason: 'سرعة الربط تتغير من لحظة لأخرى وهذه عينة واحدة.',
        alternatives: ['كان المحوّل خاملًا وخفّض سرعته لتوفير الطاقة'],
        investigation_steps: ['تأكد أن نقطة الوصول تتيح سرعات Wi-Fi 5/6 وليست على وضع b/g القديم فقط', 'تحقق من إعداد عرض القناة (Channel Width)'],
      };
    }

    case 'wifi-healthy': {
      const mCol = d.title.match(/collector "(.+)"/);
      const mNet = d.summary.match(/of "(.+)" are within/);
      return {
        ...out,
        title: `اتصال Wi-Fi عند المجمِّع «${mCol?.[1] ?? '—'}» سليم`,
        summary: `قوة الإشارة وازدحام القناة وسرعة الربط لشبكة «${mNet?.[1] ?? '—'}» ضمن الحدود الطبيعية.`,
        probable_cause: 'لا يوجد عطل.',
        confidence_reason: 'مقاسة عند موقع المجمِّع فقط.',
      };
    }

    case 'watch-target-refused': {
      const name = d.title.split(':')[0] ?? d.title;
      const reason = d.summary.match(/^The collector refused to connect \((.+)\)\. Nothing/)?.[1];
      return {
        ...out,
        title: `${name}: الهدف غير مسموح به`,
        summary: `رفض المجمِّع الاتصال${reason ? ` (${ltr(reason)})` : ''}. لم يُرسَل أي شيء إلى الهدف.`,
        probable_cause: 'الهدف، أو عنوان يُترجَم إليه اسمه، أو إعادة توجيه، يشير إلى خارج النطاقات المصرَّح بها للموقع، أو إلى مضيف عام بينما لا يسمح الفحص بالمضيفات العامة.',
        confidence_reason: 'الرفض هو قاعدة الأمان الخاصة بالمجمِّع، ويُسجَّل قبل أي محاولة اتصال.',
        investigation_steps: [
          'تحقق من العنوان الذي يُترجَم إليه الاسم من جهاز المجمِّع',
          'أضف شبكة الهدف كنطاق مصرَّح به إذا كانت تتبع هذا الموقع',
          'لخدمة على الإنترنت، فعّل خيار «السماح بمضيف عام» لهذا الفحص',
        ],
      };
    }

    case 'watch-certificate-expired':
    case 'watch-certificate-expiring': {
      const name = d.title.split(':')[0] ?? d.title;
      const expired = d.rule === 'watch-certificate-expired';
      const mWhere = d.summary.match(/presented at (\S+?) (?:expired|expires)/);
      const mDays = expired ? d.summary.match(/expired ([0-9.]+) days ago/) : d.summary.match(/expires in ([0-9.]+) days \(warning at (\d+), critical at (\d+) days\)/);
      const mTitleDays = d.title.match(/expires in (\d+) days/);
      return {
        ...out,
        title: expired ? `${name}: انتهت صلاحية الشهادة` : `${name}: تنتهي صلاحية الشهادة بعد ${ltr(mTitleDays?.[1] ?? '—')} يوم`,
        summary: expired
          ? `الشهادة المقدَّمة على ${ltr(mWhere?.[1] ?? '—')} انتهت صلاحيتها منذ ${ltr(mDays?.[1] ?? '—')} يوم. المتصفحات والعملاء الذين يتحققون من الشهادات يرفضون الاتصال.`
          : `الشهادة المقدَّمة على ${ltr(mWhere?.[1] ?? '—')} تنتهي صلاحيتها بعد ${ltr(mDays?.[1] ?? '—')} يوم (تحذير عند ${ltr(mDays?.[2] ?? '30')}، وحرج عند ${ltr(mDays?.[3] ?? '7')} يوم).`,
        probable_cause: expired ? 'لم تُجدَّد الشهادة في الوقت المناسب، أو فشل التجديد.' : 'الشهادة تقترب من تاريخ انتهائها ولم تُجدَّد بعد.',
        confidence_reason: 'تاريخ الانتهاء مقروء مباشرة من الشهادة التي قدّمها الخادم.',
        investigation_steps: ['جدّد الشهادة (أو تحقق من سبب عدم تشغيل التجديد التلقائي)', 'ثبّت الشهادة المجدَّدة على كل خادم أو جهاز يخدم هذا الاسم'],
      };
    }

    case 'watch-certificate-pin-mismatch': {
      const name = d.title.split(':')[0] ?? d.title;
      return {
        ...out,
        title: `${name}: شهادة غير متوقعة`,
        summary: 'قدّم الخادم شهادة مختلفة عن الشهادة المثبَّتة (Pin) لهذا الفحص.',
        probable_cause: 'جُدِّدت الشهادة أو استُبدلت (حدّث البصمة المثبَّتة)، أو أن شيئًا بين المجمِّع والخادم يرد بشهادته الخاصة.',
        confidence_reason: 'تغيّر البصمة أمر مؤكد؛ أما كون التغيير مخططًا له فغير معروف.',
        alternatives: ['وسيط (Proxy) يعترض اتصالات TLS، أو خادم آخر يرد على هذا العنوان'],
        investigation_steps: ['قارن البصمة في الأدلة بالشهادة المثبَّتة على الخادم', 'حدّث البصمة المثبَّتة بعد التجديد المخطط له'],
      };
    }

    case 'watch-certificate-untrusted': {
      const name = d.title.split(':')[0] ?? d.title;
      const reason = d.summary.replace(/^The TLS handshake failed verification: /, '').replace(/\.$/, '');
      return {
        ...out,
        title: `${name}: الشهادة غير موثوقة`,
        summary: `فشل التحقق أثناء مصافحة TLS: ${ltr(reason)}.`,
        probable_cause: 'شهادة موقَّعة ذاتيًا أو من جهة إصدار خاصة، أو شهادة صادرة لاسم مختلف، أو سلسلة غير مكتملة، أو شهادة منتهية الصلاحية.',
        confidence_reason: 'خطأ التحقق صادر من المصافحة نفسها؛ والخادم متاح.',
        investigation_steps: ['تحقق من الأسماء والسلسلة في الشهادة المثبَّتة على الخادم', 'لخدمة داخلية بجهة إصدار خاصة، ثبّت بصمة الشهادة بدل إيقاف التحقق'],
      };
    }

    case 'watch-http-status': {
      const name = d.title.split(':')[0] ?? d.title;
      const mCode = d.title.match(/HTTP (\d{3})$/);
      const mExp = d.summary.match(/expected (\d+-\d+)/);
      const code = Number(mCode?.[1] ?? 0);
      return {
        ...out,
        title: `${name}: ${ltr(`HTTP ${mCode?.[1] ?? '—'}`)}`,
        summary: `خادم الويب متاح وأجاب، لكن بالحالة ${ltr(mCode?.[1] ?? '—')} بدلًا من المتوقَّع ${ltr(mExp?.[1] ?? '200-299')}.`,
        probable_cause:
          code >= 500
            ? 'فشل التطبيق خلف خادم الويب (5xx): خادم خلفي متوقف أو خادم محمَّل فوق طاقته أو اعتمادية فاشلة.'
            : code >= 400
              ? 'رُفض الطلب أو لم يُعثر على الصفحة (4xx): تغيّر المسار أو أصبح تسجيل الدخول مطلوبًا أو الوصول مرفوض.'
              : 'الخادم يعيد التوجيه (3xx) والفحص لا يتبع إعادة التوجيه، أو أن حالة خارج النطاق المتوقَّع أصبحت طبيعية الآن.',
        confidence_reason: 'حالة HTTP لا يمكن أن تصدر إلا عن خادم قبِل الاتصال وأجاب.',
        investigation_steps: code >= 500 ? ['اقرأ سجلات خادم الويب والتطبيق حول وقت أول فشل'] : ['افتح العنوان الموجود في الأدلة وقارنه بما يتوقعه الفحص'],
      };
    }

    case 'watch-http-content': {
      const name = d.title.split(':')[0] ?? d.title;
      const forbidden = d.summary.includes('contains the forbidden');
      return {
        ...out,
        title: `${name}: محتوى صفحة غير متوقع`,
        summary: forbidden
          ? 'أجاب الخادم بحالة مقبولة، لكن نص الاستجابة (أول 256 كيلوبايت) يحتوي على النص أو النمط الممنوع.'
          : 'أجاب الخادم بحالة مقبولة، لكن نص الاستجابة (أول 256 كيلوبايت) لا يحتوي على النص أو النمط المتوقَّع.',
        probable_cause: 'تغيّرت الصفحة: صفحة خطأ تُقدَّم بحالة نجاح، أو صفحة صيانة، أو صفحة تسجيل دخول.',
        confidence_reason: 'قُبلت الحالة؛ وفشل فقط شرط المحتوى (قُرئ أول 256 كيلوبايت من الاستجابة).',
        investigation_steps: ['افتح العنوان وابحث عن النص المتوقَّع', 'عدّل الشرط إذا أُعيد تصميم الصفحة عمدًا'],
      };
    }

    case 'watch-snmp-threshold': {
      const name = d.title.split(':')[0] ?? d.title;
      const critical = d.title.endsWith('critical threshold crossed');
      const mVal = d.summary.match(/^The device reports (.+) for (.+), beyond/);
      const preset = d.investigation_steps[0]?.startsWith('Check the cable') ? 'link_status' : d.probable_cause.includes('runs hot') ? 'temperature' : 'other';
      return {
        ...out,
        title: `${name}: تجاوز حد ${critical ? 'الخطورة' : 'التحذير'}`,
        summary: `يُبلغ الجهاز عن القيمة ${ltr(mVal?.[1] ?? '—')} للمعرّف ${ltr(mVal?.[2] ?? '—')}، متجاوزةً حد ${critical ? 'الخطورة' : 'التحذير'} المضبوط لهذا الفحص.`,
        probable_cause:
          preset === 'link_status'
            ? 'الواجهة لا تعمل: كابل مفصول أو الطرف الآخر مطفأ أو المنفذ معطَّل.'
            : preset === 'temperature'
              ? 'الجهاز يسخن: تهوية مسدودة أو مروحة معطلة أو غرفة حارة.'
              : 'المورد المقاس تحت ضغط على الجهاز.',
        confidence_reason: 'القيمة مقروءة من الجهاز نفسه عبر SNMP.',
        investigation_steps:
          preset === 'link_status'
            ? ['تحقق من الكابل والجهاز على الطرف الآخر لهذه الواجهة (محقق المنافذ يعرض المنفذ)']
            : ['راجع صفحة حالة الجهاز نفسه للمقياس ذاته', 'قارن بالرسم البياني لهذا الفحص لمعرفة متى بدأ ذلك'],
      };
    }

    case 'watch-snmp-oid-missing': {
      const name = d.title.split(':')[0] ?? d.title;
      const mOid = d.summary.match(/no value at (.+)\.$/);
      return {
        ...out,
        title: `${name}: الجهاز لا يحتوي على هذا المعرّف`,
        summary: `الجهاز يجيب على SNMP لكن لا توجد قيمة عند ${ltr(mOid?.[1] ?? 'OID')}.`,
        probable_cause: 'الشركة المصنّعة لا تدعم كائن MIB هذا، أو أن الفهرس (رقم المعالج أو التخزين أو المستشعر أو الواجهة) مختلف على هذا الجهاز.',
        confidence_reason: 'أجاب الجهاز على الطلب وأفاد بأن الكائن غير موجود.',
        investigation_steps: ['استعرض جدول هذا الـ MIB على الجهاز لإيجاد الفهرس الصحيح', 'راجع ملاحظات الشركات المصنّعة للإعداد المسبق في نموذج الفحص'],
      };
    }

    case 'watch-snmp-unreadable': {
      const name = d.title.split(':')[0] ?? d.title;
      const m = d.summary.match(/^Reading (\S+) over SNMP failed: (.+)\.$/);
      return {
        ...out,
        title: `${name}: الجهاز لا يجيب على SNMP`,
        summary: `فشلت قراءة ${ltr(m?.[1] ?? '—')} عبر SNMP: ${ltr(m?.[2] ?? '—')}.`,
        probable_cause: 'بيانات اعتماد SNMP خاطئة أو تغيّرت، أو SNMP معطَّل على الجهاز، أو قائمة وصول لا تتضمن المجمِّع، أو الجهاز متوقف.',
        confidence_reason: 'لا يقدّم SNMP سببًا للصمت؛ وقد يكون الجهاز نفسه يعمل.',
        investigation_steps: ['تحقق من أن محقق المنافذ يستطيع قراءة الجهاز نفسه', 'تحقق من إعدادات SNMP وقائمة الوصول على الجهاز'],
      };
    }

    default:
      return out;
  }
}
