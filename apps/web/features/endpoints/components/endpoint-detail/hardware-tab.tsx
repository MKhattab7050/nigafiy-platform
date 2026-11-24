'use client';

import type { EndpointDetail, EndpointHardware } from '@nigafiy/shared-types';
import { Badge, Card, DataTable, Fact, Notice, type Tone } from '@/components/ui';
import { absoluteTime } from '@/lib/format';
import { ltr } from '@/lib/localize/bidi';
import type { Locale } from '@/lib/i18n';

// Hardware and licence inventory measured by the agent (Fleet Pro). Every part the agent could
// not measure says "Not measured" with the agent's reason; nothing here is estimated.

const en = {
  none: 'The agent has not reported its hardware inventory yet. Agents older than this release never do; a refresh asks a current agent at once.',
  collected: 'Measured',
  system: 'System',
  manufacturer: 'Manufacturer',
  model: 'Model',
  serial: 'Serial number',
  sku: 'SKU',
  board: 'Board',
  product: 'Product',
  version: 'Version',
  bios: 'BIOS / firmware',
  releaseDate: 'Release date',
  cpus: 'Processors',
  cores: 'Cores',
  threads: 'Threads',
  maxMhz: 'Max MHz',
  socket: 'Socket',
  memory: 'Memory modules',
  slot: 'Slot',
  capacity: 'Capacity',
  speed: 'Speed',
  type: 'Type',
  part: 'Part number',
  total: 'Total',
  licences: 'Licences seen',
  licenceNote: 'Read from the operating system’s licensing service. Product keys are never read or stored.',
  status: 'Status',
  detail: 'Detail',
  source: 'Source',
  licenceStatus: { licensed: 'Licensed', unlicensed: 'Not activated', grace: 'Grace period', notification: 'Notification mode', not_genuine: 'Not genuine', unknown: 'Not measured' } as Record<string, string>,
  disks: 'Physical disks and their health',
  name: 'Name',
  media: 'Media',
  bus: 'Bus',
  size: 'Size',
  health: 'Health',
  healthName: { healthy: 'Healthy', warning: 'Warning', unhealthy: 'Unhealthy', unknown: 'Not measured' } as Record<string, string>,
  temperature: 'Temperature',
  wear: 'Wear',
  powerOn: 'Power-on hours',
  errors: 'Uncorrected errors (read / write)',
  batteries: 'Batteries',
  design: 'Design capacity',
  full: 'Full-charge capacity',
  batteryHealth: 'Health (full ÷ design)',
  cycles: 'Cycle count',
  charge: 'Charge',
  notMeasured: 'Not measured',
  unmeasuredTitle: 'Not measured on this computer',
  parts: {
    cpus: 'Processors',
    memory_modules: 'Memory modules',
    system: 'System',
    system_serial: 'System serial number',
    board: 'Board',
    bios: 'BIOS',
    licences: 'Licences',
    physical_disks: 'Physical disks',
    disk_reliability: 'Disk reliability counters',
    batteries: 'Batteries',
    battery_capacity: 'Battery capacity',
  } as Record<string, string>,
};
type Text = typeof en;
const ar: Text = {
  none: 'لم يُرسل الوكيل جرد العتاد بعد. الوكلاء الأقدم من هذا الإصدار لا يرسلونه؛ التحديث يطلبه من الوكيل الحالي فورًا.',
  collected: 'وقت القياس',
  system: 'النظام',
  manufacturer: 'الشركة المصنّعة',
  model: 'الطراز',
  serial: 'الرقم التسلسلي',
  sku: 'رمز SKU',
  board: 'اللوحة الأم',
  product: 'المنتج',
  version: 'الإصدار',
  bios: 'BIOS / البرنامج الثابت',
  releaseDate: 'تاريخ الإصدار',
  cpus: 'المعالجات',
  cores: 'الأنوية',
  threads: 'الخيوط',
  maxMhz: 'أقصى تردد (MHz)',
  socket: 'المقبس',
  memory: 'وحدات الذاكرة',
  slot: 'الفتحة',
  capacity: 'السعة',
  speed: 'السرعة',
  type: 'النوع',
  part: 'رقم القطعة',
  total: 'المجموع',
  licences: 'التراخيص المرصودة',
  licenceNote: 'تُقرأ من خدمة الترخيص في نظام التشغيل. لا تُقرأ مفاتيح المنتجات ولا تُخزَّن أبدًا.',
  status: 'الحالة',
  detail: 'التفاصيل',
  source: 'المصدر',
  licenceStatus: { licensed: 'مرخّص', unlicensed: 'غير مفعّل', grace: 'فترة سماح', notification: 'وضع الإشعار', not_genuine: 'غير أصلي', unknown: 'لم يُقَس' },
  disks: 'الأقراص الفعلية وصحتها',
  name: 'الاسم',
  media: 'الوسيط',
  bus: 'الناقل',
  size: 'الحجم',
  health: 'الصحة',
  healthName: { healthy: 'سليم', warning: 'تحذير', unhealthy: 'معطوب', unknown: 'لم يُقَس' },
  temperature: 'الحرارة',
  wear: 'الاهتراء',
  powerOn: 'ساعات التشغيل',
  errors: 'أخطاء غير مصحَّحة (قراءة / كتابة)',
  batteries: 'البطاريات',
  design: 'السعة التصميمية',
  full: 'سعة الشحن الكامل',
  batteryHealth: 'الصحة (الكاملة ÷ التصميمية)',
  cycles: 'عدد الدورات',
  charge: 'الشحن',
  notMeasured: 'لم يُقَس',
  unmeasuredTitle: 'ما لم يُقَس على هذا الحاسوب',
  parts: {
    cpus: 'المعالجات',
    memory_modules: 'وحدات الذاكرة',
    system: 'النظام',
    system_serial: 'الرقم التسلسلي للنظام',
    board: 'اللوحة الأم',
    bios: 'BIOS',
    licences: 'التراخيص',
    physical_disks: 'الأقراص الفعلية',
    disk_reliability: 'عدّادات موثوقية الأقراص',
    batteries: 'البطاريات',
    battery_capacity: 'سعة البطارية',
  },
};

const LIC_TONE: Record<string, Tone> = { licensed: 'ok', unlicensed: 'crit', grace: 'warn', notification: 'warn', not_genuine: 'crit', unknown: 'idle' };
const HEALTH_TONE: Record<string, Tone> = { healthy: 'ok', warning: 'warn', unhealthy: 'crit', unknown: 'idle' };

function NotMeasured({ t }: { t: Text }) {
  return <span className="text-muted">{t.notMeasured}</span>;
}

/** A value, or "Not measured". Technical values are isolated so Arabic text never reverses them. */
function V({ v, t, unit }: { v: string | number | undefined | null; t: Text; unit?: string }) {
  if (v === undefined || v === null || v === '') return <NotMeasured t={t} />;
  return <span className="mono">{ltr(unit ? `${v} ${unit}` : String(v))}</span>;
}

export function HardwareTab({ ep, locale }: { ep: EndpointDetail; locale: Locale }) {
  const t = locale === 'ar' ? ar : en;
  const hw: EndpointHardware | null = ep.hardware;
  if (!hw) return <Notice>{t.none}</Notice>;
  const totalMb = hw.memory_modules.reduce((s, m) => s + m.capacity_mb, 0);
  const unmeasured = Object.entries(hw.unmeasured ?? {});
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted">
        {t.collected}: {absoluteTime(hw.collected_at, locale)}
      </p>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title={t.system}>
          <dl>
            <Fact label={t.manufacturer}><V v={hw.system.manufacturer} t={t} /></Fact>
            <Fact label={t.model}><V v={hw.system.model} t={t} /></Fact>
            <Fact label={t.serial}><V v={hw.system.serial} t={t} /></Fact>
            {hw.system.sku && <Fact label={t.sku}><V v={hw.system.sku} t={t} /></Fact>}
          </dl>
        </Card>
        <Card title={t.board}>
          <dl>
            <Fact label={t.manufacturer}><V v={hw.board.manufacturer} t={t} /></Fact>
            <Fact label={t.product}><V v={hw.board.product} t={t} /></Fact>
            <Fact label={t.version}><V v={hw.board.version} t={t} /></Fact>
            <Fact label={t.serial}><V v={hw.board.serial} t={t} /></Fact>
          </dl>
        </Card>
        <Card title={t.bios}>
          <dl>
            <Fact label={t.manufacturer}><V v={hw.bios.vendor} t={t} /></Fact>
            <Fact label={t.version}><V v={hw.bios.version} t={t} /></Fact>
            <Fact label={t.releaseDate}><V v={hw.bios.release_date} t={t} /></Fact>
          </dl>
        </Card>
      </div>

      <Card title={t.cpus} padded={false}>
        <DataTable minWidth={560}>
          <thead>
            <tr><th>{t.name}</th><th>{t.cores}</th><th>{t.threads}</th><th>{t.maxMhz}</th><th>{t.socket}</th></tr>
          </thead>
          <tbody>
            {hw.cpus.map((c, i) => (
              <tr key={`${c.name}-${i}`}>
                <td className="mono" dir="ltr">{c.name}</td>
                <td><V v={c.cores} t={t} /></td>
                <td><V v={c.threads} t={t} /></td>
                <td><V v={c.max_mhz} t={t} /></td>
                <td><V v={c.socket} t={t} /></td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </Card>

      <Card title={`${t.memory}${totalMb ? ` · ${t.total} ${ltr(`${(totalMb / 1024).toFixed(1)} GB`)}` : ''}`} padded={false}>
        {hw.memory_modules.length === 0 ? (
          <p className="px-4 py-3 text-xs text-muted">{t.notMeasured}: {hw.unmeasured.memory_modules ?? '—'}</p>
        ) : (
          <DataTable minWidth={640}>
            <thead>
              <tr><th>{t.slot}</th><th>{t.capacity}</th><th>{t.speed}</th><th>{t.type}</th><th>{t.manufacturer}</th><th>{t.part}</th></tr>
            </thead>
            <tbody>
              {hw.memory_modules.map((m, i) => (
                <tr key={`${m.slot}-${i}`}>
                  <td><V v={m.slot} t={t} /></td>
                  <td><V v={m.capacity_mb >= 1024 ? (m.capacity_mb / 1024).toFixed(1) : m.capacity_mb} unit={m.capacity_mb >= 1024 ? 'GB' : 'MB'} t={t} /></td>
                  <td><V v={m.speed_mhz} unit="MHz" t={t} /></td>
                  <td><V v={m.type} t={t} /></td>
                  <td><V v={m.manufacturer} t={t} /></td>
                  <td><V v={m.part_number} t={t} /></td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </Card>

      <Card title={t.licences} description={t.licenceNote} padded={false}>
        {hw.licences.length === 0 ? (
          <p className="px-4 py-3 text-xs text-muted">{t.notMeasured}: {hw.unmeasured.licences ?? '—'}</p>
        ) : (
          <DataTable minWidth={640}>
            <thead>
              <tr><th>{t.product}</th><th>{t.status}</th><th>{t.detail}</th><th>{t.source}</th></tr>
            </thead>
            <tbody>
              {hw.licences.map((l, i) => (
                <tr key={`${l.product}-${i}`}>
                  <td className="mono" dir="ltr">{l.product}</td>
                  <td><Badge tone={LIC_TONE[l.status] ?? 'idle'}>{t.licenceStatus[l.status] ?? l.status}</Badge></td>
                  <td className="text-muted" dir="ltr">{l.detail ?? '—'}</td>
                  <td className="mono text-muted" dir="ltr">{l.source}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </Card>

      <Card title={t.disks} padded={false}>
        {hw.physical_disks.length === 0 ? (
          <p className="px-4 py-3 text-xs text-muted">{t.notMeasured}: {hw.unmeasured.physical_disks ?? '—'}</p>
        ) : (
          <DataTable minWidth={900}>
            <thead>
              <tr><th>{t.name}</th><th>{t.media}</th><th>{t.size}</th><th>{t.health}</th><th>{t.temperature}</th><th>{t.wear}</th><th>{t.powerOn}</th><th>{t.errors}</th></tr>
            </thead>
            <tbody>
              {hw.physical_disks.map((d, i) => (
                <tr key={`${d.name}-${i}`} className="align-top">
                  <td>
                    <span className="mono" dir="ltr">{d.name}</span>
                    {d.serial && <span className="mono block text-[11px] text-muted">{ltr(d.serial)}</span>}
                    {d.reliability_note && <span className="block text-[11px] text-muted" dir="ltr">{d.reliability_note}</span>}
                  </td>
                  <td><V v={[d.media_type, d.bus].filter(Boolean).join(' · ')} t={t} /></td>
                  <td><V v={d.size_gb} unit="GB" t={t} /></td>
                  <td><Badge tone={HEALTH_TONE[d.health ?? 'unknown'] ?? 'idle'}>{t.healthName[d.health ?? 'unknown']}</Badge></td>
                  <td><V v={d.temperature_c} unit="°C" t={t} /></td>
                  <td><V v={d.wear_pct} unit="%" t={t} /></td>
                  <td><V v={d.power_on_hours} t={t} /></td>
                  <td>
                    {d.read_errors_uncorrected === undefined && d.write_errors_uncorrected === undefined ? (
                      <NotMeasured t={t} />
                    ) : (
                      <span className="mono">{ltr(`${d.read_errors_uncorrected ?? '—'} / ${d.write_errors_uncorrected ?? '—'}`)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </Card>

      <Card title={t.batteries} padded={false}>
        {hw.batteries.length === 0 ? (
          <p className="px-4 py-3 text-xs text-muted">{hw.unmeasured.batteries ?? t.notMeasured}</p>
        ) : (
          <DataTable minWidth={760}>
            <thead>
              <tr><th>{t.name}</th><th>{t.design}</th><th>{t.full}</th><th>{t.batteryHealth}</th><th>{t.cycles}</th><th>{t.charge}</th><th>{t.status}</th></tr>
            </thead>
            <tbody>
              {hw.batteries.map((b, i) => (
                <tr key={`${b.name}-${i}`}>
                  <td className="mono" dir="ltr">{b.name}</td>
                  <td><V v={b.design_capacity_mwh} unit="mWh" t={t} /></td>
                  <td><V v={b.full_charge_capacity_mwh} unit="mWh" t={t} /></td>
                  <td><V v={b.health_pct} unit="%" t={t} /></td>
                  <td><V v={b.cycle_count} t={t} /></td>
                  <td><V v={b.charge_pct} unit="%" t={t} /></td>
                  <td>{b.status ? <span dir="ltr">{b.status}</span> : <NotMeasured t={t} />}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </Card>

      {unmeasured.length > 0 && (
        <Card title={t.unmeasuredTitle}>
          <dl>
            {unmeasured.map(([part, why]) => (
              <Fact key={part} label={t.parts[part] ?? part}>
                <span className="text-muted" dir="ltr">{why}</span>
              </Fact>
            ))}
          </dl>
        </Card>
      )}
    </div>
  );
}
