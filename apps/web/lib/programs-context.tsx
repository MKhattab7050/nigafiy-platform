'use client';

import type { PlatformProgram, PlatformProgramsResponse, ProgramId } from '@nigafiy/shared-types/programs';
import { programForPath } from '@nigafiy/shared-types/routes';
import { usePathname } from 'next/navigation';
import { createContext, useContext, useMemo } from 'react';
import { useQuery } from './app';

/** The program whose shell is showing (from the URL). */
export function useProgramId(): ProgramId {
  return programForPath(usePathname() ?? '/');
}

interface ProgramsState {
  /** null while the first answer is loading or when it failed (then every program counts as installed, as bundled installs are today). */
  data: readonly PlatformProgram[] | null;
  installed: (id: ProgramId) => boolean;
}

const ProgramsCtx = createContext<ProgramsState>({ data: null, installed: () => true });

/**
 * Which programs this install offers (GET /platform/programs), read once for the whole shell.
 * Until the answer arrives nothing is shown as "not installed": a missing program is only ever
 * stated from the server's answer.
 */
export function ProgramsProvider({ children }: { children: React.ReactNode }) {
  const query = useQuery<PlatformProgramsResponse>('/platform/programs', [], 300_000);
  const value = useMemo<ProgramsState>(() => {
    const items = query.data?.items ?? null;
    return { data: items, installed: (id) => id === 'hub' || !items || items.some((p) => p.id === id && p.installed) };
  }, [query.data]);
  return <ProgramsCtx.Provider value={value}>{children}</ProgramsCtx.Provider>;
}

export function usePrograms(): ProgramsState {
  return useContext(ProgramsCtx);
}
