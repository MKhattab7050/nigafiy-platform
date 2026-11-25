'use client';
import { useEffect, useState } from 'react';

export const THEME_KEY = 'nigafiy-site-theme';
type Choice = 'system' | 'light' | 'dark';

/** Runs before the page paints (inline in <head>), so a stored choice never flashes the other theme. */
export const THEME_SCRIPT = `try{var t=localStorage.getItem('${THEME_KEY}');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;

function read(): Choice {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

/** System / Light / Dark. The choice is kept in this browser only (localStorage), never sent anywhere. */
export function ThemeSwitch({ labels }: { labels: { group: string; system: string; light: string; dark: string } }) {
  const [choice, setChoice] = useState<Choice>('system');
  useEffect(() => {
    const c = read();
    setChoice(c);
    // THEME_SCRIPT set this before paint; set it again in case React re-rendered <html> since
    // (a hydration error makes React rebuild the page and drop attributes it doesn't own).
    if (c !== 'system') document.documentElement.setAttribute('data-theme', c);
  }, []);
  const apply = (c: Choice) => {
    setChoice(c);
    const root = document.documentElement;
    try {
      if (c === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, c);
    } catch {
      // storage blocked: the choice lasts for this page only
    }
    if (c === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', c);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of toggle buttons, not a form fieldset
    <div className="theme-switch" role="group" aria-label={labels.group}>
      {(['system', 'light', 'dark'] as const).map((c) => (
        <button key={c} type="button" aria-pressed={choice === c} onClick={() => apply(c)} data-theme-choice={c}>
          {labels[c]}
        </button>
      ))}
    </div>
  );
}
