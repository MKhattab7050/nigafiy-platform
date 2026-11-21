import type { AutomationItem } from '@lan-detective/shared-types';
import type { Key } from '@/lib/i18n';

type T = (key: Key) => string;

/** `incident.refresh_measurements` → `automation.incident_refresh_measurements` (the catalogue's description_key). */
export const descriptionKeyOf = (automationKey: string) => `automation.${automationKey.replaceAll('.', '_')}`;

/** t() returns the key itself when a string is missing; then fall back to what the API sent. */
const tr = (t: T, key: string, fallback: string) => {
  const text = t(key as Key);
  return text === key ? fallback : text;
};

/** Short name of an automation (also used for "System · <name>" in the audit log). */
export const automationName = (t: T, automationKey: string) => tr(t, `${descriptionKeyOf(automationKey)}.name`, automationKey);

export const automationDescription = (t: T, item: AutomationItem) => tr(t, item.description_key, item.description);

/** Label (and hint) of a config field; unknown fields show their raw name. */
export const configLabel = (t: T, field: string) => tr(t, `automation.config.${field}`, field.replaceAll('_', ' '));
export const configHint = (t: T, field: string) => {
  const key = `automation.config.${field}Hint`;
  const text = t(key as Key);
  return text === key ? undefined : text;
};
