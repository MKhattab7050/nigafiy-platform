// The guide content in every language. Loaded by the guide pages, and lazily by the global search.
import type { Locale } from '@/lib/i18n';
import type { GuideContent } from '../types';
import { GUIDE_AR } from './ar';
import { GUIDE_EN } from './en';

export const GUIDE_CONTENT: Record<Locale, GuideContent> = { en: GUIDE_EN, ar: GUIDE_AR };
