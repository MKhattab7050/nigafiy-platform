// "Build your bundle": which Hub installer option installs a chosen set of programs.
//
// What the installers really support (docs/operations/installers.md, "Choose programs"):
//   - one NSIS installer, `Nigafiy Setup <v>.exe`, with a "Choose programs" page and, for silent
//     installs, `/PROGRAMS=<list>` (apps/desktop/installer/nigafiy.nsh: `all` or a comma list of
//     hub, radar, watch, guard, fleet, mind, toolbox; an invalid list ends with exit code 2);
//   - one per-machine MSI, `Nigafiy <v>.msi`, with the `PROGRAMS` property
//     (apps/desktop/scripts/msi-programs.cjs).
// Hub is always installed. The installer's own page writes "hub,radar,watch", or "all" when every
// program is ticked; this module produces the same value. No installer is built per choice.

export const BUNDLE_PROGRAMS = ['radar', 'watch', 'guard', 'fleet', 'mind', 'toolbox'] as const;
export type BundleProgram = (typeof BUNDLE_PROGRAMS)[number];

export function isBundleProgram(v: string): v is BundleProgram {
  return (BUNDLE_PROGRAMS as readonly string[]).includes(v);
}

/** The PROGRAMS value for a choice: "all", or "hub" followed by the chosen programs in installer order. */
export function programsValue(chosen: Iterable<string>): string {
  const set = new Set(chosen);
  const picked = BUNDLE_PROGRAMS.filter((p) => set.has(p));
  if (picked.length === BUNDLE_PROGRAMS.length) return 'all';
  return ['hub', ...picked].join(',');
}

/** Parses a PROGRAMS value back into the chosen programs; null when the installer would refuse it. */
export function parseProgramsValue(value: string): BundleProgram[] | null {
  if (value === 'all') return [...BUNDLE_PROGRAMS];
  const parts = value.split(',');
  if (parts.some((p) => p !== 'hub' && !isBundleProgram(p))) return null;
  return BUNDLE_PROGRAMS.filter((p) => parts.includes(p));
}

export interface BundleCommands {
  programs: string;
  /** NSIS, silent, current user. */
  nsis: string;
  /** MSI, silent, per machine. */
  msi: string;
}

/** The exact commands for a choice. `version` is the released version, or a visible placeholder. */
export function bundleCommands(chosen: Iterable<string>, version: string): BundleCommands {
  const programs = programsValue(chosen);
  return {
    programs,
    nsis: `"Nigafiy Setup ${version}.exe" /S /currentuser /PROGRAMS=${programs}`,
    msi: `msiexec /i "Nigafiy ${version}.msi" /qn PROGRAMS=${programs}`,
  };
}
