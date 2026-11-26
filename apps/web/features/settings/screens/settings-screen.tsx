'use client';

import { Settings } from 'lucide-react';
import { Card, Fact, PageHeader, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { useApp } from '@/lib/app';
import { LanTlsCard } from '@/features/discovery/components/lan-tls-card';
import { UpdatesCard } from '@/features/platform';
import { type Key, useI18n } from '@/lib/i18n';
import { AccountSecurity } from '../components/account-security';
import { AuditLog } from '../components/audit-log';
import { BackupsCard } from '../components/backups';
import { MovedCard } from '../components/moved-card';
import { OutsideAccessCard } from '../components/outside-access';
import { SsoProviders } from '../components/sso-providers';
import { SystemHealth } from '../components/system-health';
import { TeamManagement } from '../components/team-management';

export function SettingsScreen() {
  const { t, locale, setLocale } = useI18n();
  const { me, can } = useApp();
  return (
    <>
      <PageHeader icon={<Settings className="size-[18px]" aria-hidden />} title={t('settings.title')} />
      <div className="space-y-4">
        <Card title={t('settings.organization')}>
          <dl>
            <Fact label={t('settings.organization')}>{me.organization.name}</Fact>
            <Fact label={t('auth.email')}>
              <span className="mono">{me.user.email}</span>
            </Fact>
            <Fact label={t('settings.role')}>{t(('control.role.' + me.role) as Key)}</Fact>
            <Fact label={t('settings.language')}>
              <Select
                value={locale}
                aria-label={t('settings.language')}
                className="w-40"
                onChange={(e) => {
                  const next = e.target.value as 'en' | 'ar';
                  setLocale(next);
                  void api('/auth/me', { method: 'PATCH', body: { locale: next } }).catch(() => undefined);
                }}
              >
                <option value="en">English</option>
                <option value="ar">العربية</option>
              </Select>
            </Fact>
          </dl>
        </Card>
        <AccountSecurity />
        <div id="system" className="scroll-mt-20">
          <SystemHealth />
        </div>
        <div id="updates" className="scroll-mt-20">
          <UpdatesCard />
        </div>
        {can('owner') && (
          <div id="backups" className="scroll-mt-20">
            <BackupsCard />
          </div>
        )}
        <div id="tls" className="scroll-mt-20">
          <LanTlsCard />
        </div>
        <MovedCard />
        {can('admin') ? (
          <>
            <TeamManagement />
            <div id="outside" className="scroll-mt-20">
              <OutsideAccessCard />
            </div>
            <div id="sso" className="scroll-mt-20">
              <SsoProviders />
            </div>
            <AuditLog />
          </>
        ) : (
          <Card>
            <p className="text-[13px] text-muted">{t('settings.adminOnly')}</p>
          </Card>
        )}
      </div>
    </>
  );
}
