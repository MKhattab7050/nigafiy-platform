'use client';

import { Bell, CalendarClock, Workflow } from 'lucide-react';
import { Card, PageHeader } from '@/components/ui';
import { useApp } from '@/lib/app';
import { useI18n } from '@/lib/i18n';
import { Automation } from '../components/automation';
import { MaintenanceWindows } from '../components/maintenance-windows';
import { Notifications } from '../components/notifications';

// Sub-features spec §5 assigns to a program other than Hub. Each page renders the same component
// Settings used to show (no second implementation); Settings keeps a "Moved into the programs" card.

/** Watch, Notifications: e-mail and webhook channels (admins only, as in Settings before). */
export function NotificationsScreen() {
  const { t } = useI18n();
  const { can } = useApp();
  return (
    <>
      <PageHeader icon={<Bell className="size-[18px]" aria-hidden />} title={t('settings.notifications')} description={t('platform.notifications.intro')} />
      {can('admin') ? (
        <Notifications />
      ) : (
        <Card>
          <p className="text-[13px] text-muted">{t('settings.adminOnly')}</p>
        </Card>
      )}
    </>
  );
}

/** Watch, Maintenance windows: everyone reads, technicians and up schedule (the component's own checks). */
export function MaintenanceScreen() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader icon={<CalendarClock className="size-[18px]" aria-hidden />} title={t('platform.nav.maintenance')} description={t('platform.maintenance.intro')} />
      <MaintenanceWindows />
    </>
  );
}

/** Mind, Automation: everyone reads, administrators change (the component's own checks). */
export function AutomationScreen() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader icon={<Workflow className="size-[18px]" aria-hidden />} title={t('platform.nav.automation')} description={t('platform.automation.intro')} />
      <Automation />
    </>
  );
}
