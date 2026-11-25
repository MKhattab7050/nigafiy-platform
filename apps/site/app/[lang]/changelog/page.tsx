import type { Metadata } from 'next';
import { Ltr } from '../../../components/brand.tsx';
import { S } from '../../../lib/content/strings.ts';
import { byDay, loadChangelog } from '../../../lib/changelog.ts';
import type { Lang } from '../../../lib/i18n.ts';

type Params = { params: Promise<{ lang: Lang }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { lang } = await params;
  return { title: S.changelogH[lang] };
}

export default async function Changelog({ params }: Params) {
  const { lang } = await params;
  const log = loadChangelog();
  const days = byDay(log.entries);
  return (
    <div className="wrap">
      <div className="page-head">
        <h1>{S.changelogH[lang]}</h1>
        <p className="lead">{S.changelogSource[lang]}</p>
        <p className="doc-meta" style={{ marginTop: 12 }}>
          <span>
            {S.changelogBranch[lang]}: <Ltr code>{`${log.source.branch} @ ${log.source.head}`}</Ltr>
          </span>
          <span>
            <Ltr>{log.entries.length}</Ltr> {S.changelogCount[lang]}
          </span>
        </p>
        {lang === 'ar' ? (
          <p className="note">
            <span className="badge badge-unknown">{S.englishOnly.ar}</span> {S.englishOnlyNote.ar}
          </p>
        ) : null}
      </div>
      <div lang="en" dir="ltr">
        {days.map((d) => (
          <section className="day" key={d.date} aria-labelledby={`d-${d.date}`}>
            <h2 id={`d-${d.date}`}>
              <time dateTime={d.date}>{d.date}</time>
            </h2>
            <ul>
              {d.items.map((e) => (
                <li key={e.hash}>
                  {e.subject} <code className="muted small">{e.hash}</code>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
