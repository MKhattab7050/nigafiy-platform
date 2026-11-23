import type { Role } from '@nigafiy/shared-types';

/**
 * One action as GET /devices/:id/controls describes it: whether it is possible now, and if not why;
 * the minimum role; and the exact request that performs it. The UI never invents an action: it shows
 * what the API returns, disabled with its reason when it is not possible.
 */
export interface ControlAction {
  possible: boolean;
  reason?: string;
  /** Extra explanation from the API (the router driver's note, a guard's message). */
  note?: string;
  min_role?: Role;
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  href?: string;
  body?: Record<string, unknown>;
  values?: string[];
  field?: string;
}

/** A section of the consolidated controls: computed on its own, so one failing section never hides the others. */
export type ControlSection<T> = ({ available: true } & T) | { available: false; error: { code: string; message: string } };

/** The API returns absolute API paths (`/api/v1/...`); `api()` takes them without the prefix. */
export const apiPath = (href: string): string => href.replace(/^\/api\/v1/, '');
