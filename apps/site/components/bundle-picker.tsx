'use client';
import { useState } from 'react';
import { BUNDLE_PROGRAMS, type BundleProgram, bundleCommands } from '../lib/bundle.ts';

export interface PickerProgram {
  id: BundleProgram;
  name: string;
  accent: string;
}

export interface PickerText {
  legend: string;
  hubName: string;
  hubAccent: string;
  always: string;
  interactive: string;
  interactiveText: string;
  silent: string;
  msi: string;
  all: string;
  hubOnly: string;
  copy: string;
  copied: string;
  get: string;
  notReleased: string;
  notReleasedShort: string;
  later: string;
}

function CopyLine({ id, text, copy, copied }: { id: string; text: string; copy: string; copied: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="cmd">
      <pre id={id}>
        <code>{text}</code>
      </pre>
      <button
        type="button"
        aria-describedby={id}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setDone(true);
            setTimeout(() => setDone(false), 2000);
          } catch {
            // clipboard refused (permissions): the command stays selectable on the page
          }
        }}
      >
        <span aria-live="polite">{done ? copied : copy}</span>
      </button>
    </div>
  );
}

/** Tick programs → the exact Hub installer option (PROGRAMS) that installs them. */
export function BundlePicker({ programs, text, version, installerUrl }: { programs: PickerProgram[]; text: PickerText; version: string | null; installerUrl: string | null }) {
  const [chosen, setChosen] = useState<Set<BundleProgram>>(() => new Set(BUNDLE_PROGRAMS));
  const cmds = bundleCommands(chosen, version ?? '<version>');
  const names = programs.filter((p) => chosen.has(p.id)).map((p) => p.name);
  const toggle = (id: BundleProgram, on: boolean) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  return (
    <form className="picker" onSubmit={(e) => e.preventDefault()} data-testid="bundle-picker">
      <fieldset>
        <legend>{text.legend}</legend>
        <label className="pick">
          <input type="checkbox" checked disabled aria-describedby="hub-always" />
          <span className="dot" style={{ background: text.hubAccent }} aria-hidden="true" />
          <span className="name">{text.hubName}</span>
          <span className="muted small" id="hub-always">
            {text.always}
          </span>
        </label>
        {programs.map((p) => (
          <label className="pick" key={p.id}>
            <input type="checkbox" name="program" value={p.id} checked={chosen.has(p.id)} onChange={(e) => toggle(p.id, e.target.checked)} />
            <span className="dot" style={{ background: p.accent }} aria-hidden="true" />
            <span className="name">{p.name}</span>
          </label>
        ))}
      </fieldset>
      <div aria-live="polite">
        <h3>{text.interactive}</h3>
        <p className="small" style={{ margin: 0 }} data-testid="bundle-choice">
          {text.interactiveText} {names.length === BUNDLE_PROGRAMS.length ? text.all : names.length ? names.join(', ') : text.hubOnly}
        </p>
      </div>
      <h3>{text.silent}</h3>
      <CopyLine id="cmd-nsis" text={cmds.nsis} copy={text.copy} copied={text.copied} />
      <h3>{text.msi}</h3>
      <CopyLine id="cmd-msi" text={cmds.msi} copy={text.copy} copied={text.copied} />
      {installerUrl ? (
        <a href={installerUrl} className="btn btn-primary btn-small" style={{ alignSelf: 'flex-start', marginTop: 8 }}>
          {text.get}
        </a>
      ) : (
        <p className="small" style={{ margin: '8px 0 0' }}>
          <span className="badge badge-unknown">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
              <path d="M12 6v6l4 2" />
              <circle cx="12" cy="12" r="9" />
            </svg>
            {text.notReleasedShort}
          </span>{' '}
          {text.notReleased}
        </p>
      )}
      <p className="muted small" style={{ margin: '8px 0 0' }}>
        {text.later}
      </p>
    </form>
  );
}
