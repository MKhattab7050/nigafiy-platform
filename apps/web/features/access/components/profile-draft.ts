import type { ScheduleWindow } from '@lan-detective/shared-types';

export type Draft = { id?: string; name: string; blocked_categories: string[]; blocked_domains: string; allowed_domains: string; schedule: ScheduleWindow[] };

export const TEMPLATES: Record<string, Omit<Draft, 'name'>> = {
  kids: { blocked_categories: ['adult', 'gambling', 'ads_malware'], blocked_domains: '', allowed_domains: '', schedule: [{ days: [0, 1, 2, 3, 4], from: '22:00', to: '07:00' }, { days: [5, 6], from: '23:30', to: '08:00' }] },
  guests: { blocked_categories: ['adult', 'gambling', 'ads_malware'], blocked_domains: '', allowed_domains: '', schedule: [] },
  focus: { blocked_categories: ['social', 'video', 'games'], blocked_domains: '', allowed_domains: '', schedule: [] },
  blank: { blocked_categories: [], blocked_domains: '', allowed_domains: '', schedule: [] },
};
