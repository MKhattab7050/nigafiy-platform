import type { messages } from './messages-en';

/**
 * Every feature keeps its `t(key)` strings in its own `strings.ts` (a leaf module with no imports);
 * `messages-en.ts` and `messages-ar.ts` merge them, one file per language. Only the server imports
 * them (lib/i18n/server.ts): the root layout hands the active language to the client as a prop, so
 * no dictionary is in the client JavaScript. Keys are namespaced by feature, so they never collide.
 */
export type Key = keyof typeof messages;
export type Locale = 'en' | 'ar';
export type Messages = Record<Key, string>;
