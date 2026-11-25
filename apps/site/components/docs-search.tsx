'use client';
import { useEffect, useRef, useState } from 'react';
import type { SearchEntry } from '../lib/docs.ts';
import type { Lang } from '../lib/i18n.ts';
import { type SearchHit, searchDocs } from '../lib/search.ts';

/** Searches the build-time index (/<lang>/docs/search-index.json) in the browser; nothing is sent anywhere. */
export function DocsSearch({ lang, text }: { lang: Lang; text: { label: string; hint: string; none: string; results: string; englishOnly: string } }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const loading = useRef<Promise<SearchEntry[]> | null>(null);

  useEffect(() => {
    let live = true;
    const q = query.trim();
    if (q.length < 2) {
      setHits(null);
      return;
    }
    if (!loading.current) loading.current = fetch(`/${lang}/docs/search-index.json`).then((r) => r.json() as Promise<SearchEntry[]>);
    loading.current.then((entries) => {
      if (live) setHits(searchDocs(entries, q));
    });
    return () => {
      live = false;
    };
  }, [query, lang]);

  return (
    <form className="search" role="search" onSubmit={(e) => e.preventDefault()}>
      <label htmlFor="docs-q">{text.label}</label>
      <input id="docs-q" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={text.hint} autoComplete="off" />
      <div aria-live="polite">
        {hits === null ? null : hits.length === 0 ? (
          <p className="muted">{text.none}</p>
        ) : (
          <>
            <p className="muted small">
              {hits.length} {text.results}
            </p>
            <ul className="search-results" data-testid="search-results">
              {hits.map((h) => (
                <li key={h.href} lang={h.lang} dir={h.lang === 'ar' ? 'rtl' : 'ltr'}>
                  <a href={h.href}>
                    {h.title}
                    {h.heading ? ` › ${h.heading}` : ''}
                  </a>
                  {h.lang !== lang ? (
                    <span className="badge badge-unknown" lang={lang} style={{ marginInlineStart: 8 }}>
                      {text.englishOnly}
                    </span>
                  ) : null}
                  {h.snippet ? <p className="snip">{h.snippet}</p> : null}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </form>
  );
}
