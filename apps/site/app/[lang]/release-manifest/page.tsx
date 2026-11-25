import type { Metadata } from 'next';
import { Ltr } from '../../../components/brand.tsx';
import { S } from '../../../lib/content/strings.ts';
import { type Lang, href } from '../../../lib/i18n.ts';
import { loadRelease } from '../../../lib/release.ts';

type Params = { params: Promise<{ lang: Lang }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { lang } = await params;
  return { title: S.manifestH[lang], description: S.manifestLead[lang] };
}

// The payload format of docs/operations/updates.md ("Manifest"), with placeholders in angle brackets.
const FORMAT = `{ "payload": "<base64 of the JSON below>", "signature": "<base64 Ed25519 signature of those bytes>" }

{
  "schema": 1,
  "product": "nigafiy",
  "version": "<x.y.z>",
  "released_at": "<ISO 8601 time>",
  "components": [
    { "id": "desktop-windows-x64", "version": "<x.y.z>", "url": "https://<download host>/<file>", "size": <bytes>, "sha256": "<64 hex>" },
    { "id": "endpoint-agent-windows-x64", "version": "<x.y.z>", "url": "https://<download host>/<file>", "size": <bytes>, "sha256": "<64 hex>" }
  ]
}`;

export default async function ReleaseManifest({ params }: Params) {
  const { lang } = await params;
  const release = loadRelease();
  const manifestUrl = release?.manifest_url ?? null;
  return (
    <div className="wrap">
      <div className="page-head">
        <h1>{S.manifestH[lang]}</h1>
        <p className="lead">{S.manifestLead[lang]}</p>
      </div>
      <section className="section" style={{ paddingBlock: 24 }}>
        <ol className="feature-list">
          {S.manifestSteps.map((s) => (
            <li key={s.en}>{s[lang]}</li>
          ))}
        </ol>
        <div className="note note-warn">
          <p className="note-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 3l10 18H2zM12 10v5M12 18v.01" />
            </svg>
            {S.notVerifiedH[lang]}
          </p>
          <p>{S.manifestNotVerified[lang]}</p>
        </div>
      </section>
      <section aria-labelledby="file-h">
        <h2 id="file-h" style={{ fontSize: 24 }}>
          {S.manifestFileH[lang]}
        </h2>
        {manifestUrl ? (
          <p data-testid="manifest-link">
            <a href={manifestUrl}>
              {S.manifestLink[lang]}: <Ltr>{manifestUrl}</Ltr>
            </a>
          </p>
        ) : (
          <p data-testid="manifest-none">
            <span className="badge badge-unknown">{S.notReleased[lang]}</span> {S.manifestNone[lang]}
          </p>
        )}
        <h3>{S.manifestFormatH[lang]}</h3>
        <pre>
          <code>{FORMAT}</code>
        </pre>
        <p>
          <a href={href(lang, 'docs/operations/updates')}>{S.moreDetail[lang]}</a>
          {lang === 'ar' ? <span className="muted"> ({S.englishOnly.ar})</span> : null}
        </p>
      </section>
    </div>
  );
}
