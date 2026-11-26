// Buttons a notification can carry (UX review 2026-11-26 items 9–12). Channels render them as links or buttons;
// pressing one calls POST /api/v1/notification-actions/:token (single-use, expires), handled by the notifications module.
export type NotificationActionKind = 'allow_device' | 'pause_device' | 'open';
export interface NotificationAction {
  readonly kind: NotificationActionKind;
  readonly label: { readonly en: string; readonly ar: string };
  /** Single-use signed token for POST /api/v1/notification-actions/:token; absent for kind 'open'. */
  readonly token?: string;
  /** For 'open': the web app path to open. */
  readonly path?: string;
}
