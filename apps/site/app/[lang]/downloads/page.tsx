import { PROGRAMS_BRAND } from '@nigafiy/brand';
import type { Metadata } from 'next';
import { Ltr, ProgramIcon } from '../../../components/brand.tsx';
import { BundlePicker } from '../../../components/bundle-picker.tsx';
import { BUNDLE_PROGRAMS, bundleCommands } from '../../../lib/bundle.ts';
import { S } from '../../../lib/content/strings.ts';
import { type Lang, href } from '../../../lib/i18n.ts';
import { COMPONENTS, type ComponentGroup, type Release, componentOf, fileNameOf, formatSize, loadRelease } from '../../../lib/release.ts';

type Params = { params: Promise<{ lang: Lang }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { lang } = await params;
  return { title: S.downloadsH[lang], description: S.downloadsLead[lang] };
}

function NotReleased({ lang }: { lang: Lang }) {
  return (
    <span className="badge badge-unknown" data-testid="not-released">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
        <path d="M12 7v5l3 2" />
        <circle cx="12" cy="12" r="9" />
      </svg>
      {S.notReleased[lang]}
    </span>
  );
}

function FileTable({ lang, group, release }: { lang: Lang; group: ComponentGroup; release: Release | null }) {
  const rows = COMPONENTS.filter((c) => c.group === group);
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">{S.colFile[lang]}</th>
            <th scope="col">{S.colVersion[lang]}</th>
            <th scope="col">{S.colSize[lang]}</th>
            <th scope="col">{S.colSha[lang]}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const r = componentOf(release, c.id);
            return (
              <tr key={c.id} data-component={c.id}>
                <th scope="row" style={{ fontWeight: 400, background: 'transparent' }}>
                  <div>{c.label[lang]}</div>
                  {r ? (
                    <a href={r.url} download>
                      <Ltr>{fileNameOf(r.url)}</Ltr>
                    </a>
                  ) : null}
                </th>
                {r ? (
                  <>
                    <td>
                      <Ltr>{r.version}</Ltr>
                    </td>
                    <td>
                      <Ltr>{formatSize(r.size)}</Ltr>
                      <div className="muted small">
                        <Ltr>{r.size.toLocaleString('en')} bytes</Ltr>
                      </div>
                    </td>
                    <td>
                      <Ltr code>
                        <span className="hash">{r.sha256}</span>
                      </Ltr>
                    </td>
                  </>
                ) : (
                  <td colSpan={3}>
                    <NotReleased lang={lang} />
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default async function Downloads({ params }: Params) {
  const { lang } = await params;
  const release = loadRelease();
  const desktop = componentOf(release, 'desktop-windows-x64');
  const version = desktop?.version ?? null;
  const placeholder = '<version>';
  return (
    <>
      <div className="wrap page-head">
        <h1>{S.downloadsH[lang]}</h1>
        <p className="lead">{S.downloadsLead[lang]}</p>
        {release ? (
          <p className="doc-meta" style={{ marginTop: 12 }} data-testid="release-line">
            <span>
              {S.releaseLine[lang]} <Ltr>{release.version}</Ltr>
            </span>
            <span>
              {S.releasedAt[lang]} <Ltr>{release.released_at.slice(0, 10)}</Ltr>
            </span>
          </p>
        ) : (
          <div className="note" role="status" data-testid="no-release">
            <p style={{ margin: 0 }}>
              <NotReleased lang={lang} /> {S.notReleasedBanner[lang]}
            </p>
          </div>
        )}
      </div>

      <div className="wrap">
        <section className="dl-group" id="bundle-files" aria-labelledby="bundle-files-h">
          <h2 id="bundle-files-h">
            <ProgramIcon id="hub" size={32} />
            {S.bundleGroup[lang]}
          </h2>
          <p className="muted">{S.bundleGroupNote[lang]}</p>
          <FileTable lang={lang} group="bundle" release={release} />
        </section>

        <section className="dl-group" aria-labelledby="per-program-h">
          <h2 id="per-program-h">{S.perProgramH[lang]}</h2>
          <div className="table-wrap">
            <table>
              <tbody>
                {BUNDLE_PROGRAMS.map((id) => {
                  const cmd = bundleCommands([id], version ?? placeholder);
                  return (
                    <tr key={id} id={`program-${id}`}>
                      <th scope="row" style={{ background: 'transparent' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                          <ProgramIcon id={id} size={28} />
                          <a href={href(lang, `programs/${id}`)}>{PROGRAMS_BRAND[id].name}</a>
                        </span>
                      </th>
                      <td>
                        {S.perProgramVia[lang]}{' '}
                        <Ltr code>{`/PROGRAMS=${cmd.programs}`}</Ltr> · <Ltr code>{`PROGRAMS=${cmd.programs}`}</Ltr>
                        {desktop ? null : (
                          <>
                            {' '}
                            <NotReleased lang={lang} />
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="dl-group" id="bundle" aria-labelledby="picker-h">
          <div className="split">
            <div>
              <h2 id="picker-h">{S.pickerH[lang]}</h2>
              <p className="muted">{S.pickerLead[lang]}</p>
            </div>
            <BundlePicker
              programs={BUNDLE_PROGRAMS.map((id) => ({ id, name: PROGRAMS_BRAND[id].name, accent: PROGRAMS_BRAND[id].accent }))}
              version={version}
              installerUrl={desktop?.url ?? null}
              text={{
                legend: S.pickerLegend[lang],
                hubName: PROGRAMS_BRAND.hub.name,
                hubAccent: PROGRAMS_BRAND.hub.accent,
                always: S.alwaysIncluded[lang],
                interactive: S.pickerInteractive[lang],
                interactiveText: S.pickerInteractiveText[lang],
                silent: S.pickerSilent[lang],
                msi: S.pickerMsi[lang],
                all: S.pickerAll[lang],
                hubOnly: S.pickerHubOnly[lang],
                copy: S.pickerCopy[lang],
                copied: S.pickerCopied[lang],
                get: S.pickerGet[lang],
                notReleased: S.pickerNotReleased[lang],
                notReleasedShort: S.notReleased[lang],
                later: S.pickerLater[lang],
              }}
            />
          </div>
        </section>

        <section className="dl-group" id="agent" aria-labelledby="agent-h">
          <h2 id="agent-h">
            <ProgramIcon id="agent" size={32} />
            <a href={href(lang, 'programs/agent')}>{S.agentGroup[lang]}</a>
          </h2>
          <FileTable lang={lang} group="agent" release={release} />
        </section>

        <section className="dl-group" id="sensor" aria-labelledby="sensor-h">
          <h2 id="sensor-h">
            <ProgramIcon id="sensor" size={32} />
            <a href={href(lang, 'programs/sensor')}>{S.sensorGroup[lang]}</a>
          </h2>
          <FileTable lang={lang} group="sensor" release={release} />
        </section>

        <section className="dl-group" id="store" aria-labelledby="store-h">
          <h2 id="store-h">{S.storeH[lang]}</h2>
          <p>
            <span className="badge badge-unknown">{lang === 'ar' ? 'قريبًا' : 'Coming'}</span> {S.storeText[lang]}
          </p>
        </section>

        <section className="dl-group" aria-labelledby="verify-h">
          <h2 id="verify-h">{S.verifyH[lang]}</h2>
          <p>{S.verifyText[lang]}</p>
          <pre>
            <code>{`Get-FileHash -Algorithm SHA256 "${desktop ? fileNameOf(desktop.url) : `Nigafiy Setup ${placeholder}.exe`}"`}</code>
          </pre>
          <p className="muted small">
            <a href={href(lang, 'release-manifest')}>{S.navManifest[lang]}</a>
          </p>
        </section>
      </div>
    </>
  );
}
