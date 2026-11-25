import type { Locale, Messages } from './dictionary';
import { messages as ar } from './messages-ar';
import { messages as en } from './messages-en';

/** The dictionary for one language. Import only from Server Components (the root layout), never from client code. */
export function getMessages(locale: Locale): Messages {
  return locale === 'ar' ? ar : en;
}
