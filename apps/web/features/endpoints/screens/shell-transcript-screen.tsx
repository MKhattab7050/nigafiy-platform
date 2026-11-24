'use client';

import type { Terminal } from '@xterm/xterm';
import { ScrollText } from 'lucide-react';
import { useCallback } from 'react';
import type { FleetShellSession, FleetShellTranscriptChunk } from '@nigafiy/shared-types';
import { Async, Badge, Card, Notice, PageHeader } from '@/components/ui';
import { useApp, useQuery } from '@/lib/app';
import { absoluteTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { ltr } from '@/lib/localize/bidi';
import { jobsText } from '../components/fleet-jobs/jobs-text';
import { XtermView } from '../components/fleet-shell/xterm-view';

interface Transcript {
  shell: FleetShellSession;
  chunks: FleetShellTranscriptChunk[];
  unreadable: number;
}

/**
 * One remote shell's transcript (admins; opening it is audited): the output replayed in a
 * read-only terminal, and every input with its time.
 */
export function ShellTranscriptScreen({ endpointId, shellId }: { endpointId: string; shellId: string }) {
  const { locale } = useI18n();
  const tx = jobsText(locale);
  const { can } = useApp();
  const q = useQuery<Transcript>(can('admin') ? `/endpoints/${endpointId}/shell/${shellId}/transcript` : null, []);
  if (!can('admin')) return <p className="text-sm text-muted">{tx.shellAdminOnly}</p>;
  return (
    <Async query={q}>
      {(t) => <TranscriptView t={t} />}
    </Async>
  );
}

function TranscriptView({ t }: { t: Transcript }) {
  const { locale } = useI18n();
  const tx = jobsText(locale);
  const s = t.shell;
  const output = t.chunks.filter((c) => c.direction === 'o').map((c) => c.text).join('');
  const replay = useCallback(
    (term: Terminal) => {
      term.write(output);
    },
    [output],
  );
  return (
    <div className="space-y-5">
      <PageHeader title={tx.transcriptTitle} description={`${s.endpoint_name ?? ''} · ${tx.shellBy(s.operator_email, absoluteTime(s.created_at, locale))}`} icon={<ScrollText className="size-5" aria-hidden />} />
      <Notice>{tx.transcriptViewed}</Notice>
      <Card>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted">{tx.shellReason}</dt>
            <dd dir="auto">{s.reason}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{tx.shellState[s.state]}</dt>
            <dd>
              {s.end_reason ? <Badge tone="idle">{tx.endReason[s.end_reason]}</Badge> : <Badge tone="ok">{tx.shellState[s.state]}</Badge>}
              {s.exit_code !== null && <span className="mono ms-2 text-xs">{tx.exited(s.exit_code)}</span>}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{tx.shellProfile}</dt>
            <dd>
              {s.profile_name ?? '—'} {s.shell && <span className="mono text-xs text-faint">{ltr(s.shell)}</span>}
            </dd>
          </div>
        </dl>
        {t.unreadable > 0 && <p className="mt-2 text-xs text-crit">{tx.transcriptUnreadable(t.unreadable)}</p>}
      </Card>
      <Card title={tx.stdout}>
        <XtermView onReady={replay} readOnly label={tx.transcriptTitle} />
      </Card>
      <Card title={tx.transcript} padded={false}>
        <ol className="divide-y divide-line">
          {t.chunks
            .filter((c) => c.direction !== 'o')
            .map((c) => (
              <li key={c.seq} className="flex gap-3 px-4 py-1.5 text-xs">
                <span className="w-40 shrink-0 text-faint">{absoluteTime(c.at, locale)}</span>
                <span className={c.direction === 'e' ? 'text-muted italic' : 'mono'} dir="ltr">
                  {c.direction === 'i' ? JSON.stringify(c.text) : c.text}
                </span>
              </li>
            ))}
        </ol>
      </Card>
    </div>
  );
}
