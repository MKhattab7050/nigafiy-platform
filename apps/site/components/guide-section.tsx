import type { GuideSection } from '../lib/guide.ts';
import { TickText } from './brand.tsx';

/** One section of the in-app user guide, rendered from its blocks (React escapes all text). */
export function GuideBody({ section, inAppLabel }: { section: GuideSection; inAppLabel: string }) {
  return (
    <div className="prose">
      {section.blocks.map((b, i) => {
        const key = `${b.kind}-${i}`;
        switch (b.kind) {
          case 'h':
            return (
              <h2 key={key} id={b.id}>
                <TickText text={b.text} />
              </h2>
            );
          case 'p':
            return (
              <p key={key}>
                <TickText text={b.text} />
              </p>
            );
          case 'steps':
            return (
              <ol key={key}>
                {b.items.map((it) => (
                  <li key={it}>
                    <TickText text={it} />
                  </li>
                ))}
              </ol>
            );
          case 'list':
            return (
              <ul key={key}>
                {b.items.map((it) => (
                  <li key={it}>
                    <TickText text={it} />
                  </li>
                ))}
              </ul>
            );
          case 'note':
            return (
              <div key={key} className={b.tone === 'warn' ? 'guide-note warn' : 'guide-note'}>
                <TickText text={b.text} />
              </div>
            );
          case 'table':
            return (
              <div key={key} className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      {b.head.map((h) => (
                        <th key={h} scope="col">
                          <TickText text={h} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r) => (
                      <tr key={r.join('|')}>
                        {r.map((c, j) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: cells of a fixed table row
                          <td key={j}>
                            <TickText text={c} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          default:
            return null;
        }
      })}
      {section.links?.length ? (
        // The guide links to pages of the running program, which this site does not have: listed as text.
        <p className="muted small">
          {inAppLabel} {section.links.map((l) => l.label).join(' · ')}
        </p>
      ) : null}
    </div>
  );
}
