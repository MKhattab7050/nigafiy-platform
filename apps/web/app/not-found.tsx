import { FileQuestion } from 'lucide-react';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { ar, en } from '@/lib/i18n/ui-strings';

export const metadata = { title: 'Not found' };

/**
 * Unmatched URLs and notFound(). A Server Component (Next sends the root not-found with every route),
 * so it reads the locale cookie itself and ships no client JavaScript or dictionary.
 */
export default async function NotFound() {
  const s = (await cookies()).get('ld_locale')?.value === 'ar' ? ar : en;
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-md rounded-[12px] border border-line-strong bg-surface p-6 text-center shadow-[var(--shadow-overlay)]">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full border border-line bg-sunken text-faint">
          <FileQuestion className="size-6" aria-hidden />
        </div>
        <h1 className="text-[15px] font-semibold text-fg">{s['notFound.title']}</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{s['notFound.body']}</p>
        <Link href="/" className="mt-5 inline-flex h-9 items-center rounded-[var(--radius-control)] bg-accent px-4 text-[13px] font-medium border border-transparent text-on-accent hover:bg-accent-strong">
          {s['notFound.home']}
        </Link>
      </div>
    </main>
  );
}
