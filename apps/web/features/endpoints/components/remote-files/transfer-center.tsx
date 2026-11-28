'use client';

import clsx from 'clsx';
import { AlertTriangle, ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, CheckCircle2, ChevronDown, ChevronUp, Pause, Play, RotateCcw, X } from 'lucide-react';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Badge, Button, Modal } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { ltr } from '@/lib/localize/bidi';
import { formatBytes } from './file-utils';
import { type Job, type JobState, transfers } from './transfer-engine';
import { formatDuration, friendlyError, transferText } from './transfer-text';

const ACTIVE: JobState[] = ['queued', 'running', 'waiting', 'verifying'];
const tone: Record<JobState, 'ok' | 'warn' | 'crit' | 'idle' | 'info'> = {
  queued: 'idle',
  running: 'info',
  waiting: 'warn',
  paused: 'idle',
  interrupted: 'warn',
  verifying: 'info',
  done: 'ok',
  failed: 'crit',
  cancelled: 'idle',
  skipped: 'idle',
};

export function useTransfers() {
  return useSyncExternalStore(transfers.subscribe, transfers.getSnapshot, transfers.getSnapshot);
}

/** One second ticks while something waits for a retry (the countdown). */
function useNow(on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    // Start from the real time (a stale value showed "retry in 362 s" for a 1 s wait), and catch up
    // when the tab comes back: a background tab runs this timer rarely.
    const tick = () => setNow(Date.now());
    tick();
    const t = setInterval(tick, 1000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [on]);
  return now;
}

interface Group {
  id: string;
  label: string;
  jobs: Job[];
  size: number;
  done: number;
  speed: number;
}

/**
 * The transfer center: always on screen while something copies (every page of the console), with
 * each transfer's progress, speed, time left, retries and checks; the questions a transfer asks
 * (replace an existing file?) open from here too.
 */
export function TransferCenter({ userId }: { userId: string }) {
  const { locale } = useI18n();
  const isAr = locale === 'ar';
  const t = transferText(isAr);
  const { jobs, prompts } = useTransfers();
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<Set<string>>(new Set());
  const waiting = jobs.some((j) => j.state === 'waiting');
  const now = useNow(waiting);

  useEffect(() => {
    void transfers.setOwner(userId);
  }, [userId]);

  const groups = useMemo(() => {
    const m = new Map<string, Group>();
    for (const j of jobs) {
      const g = m.get(j.group) ?? { id: j.group, label: j.groupLabel, jobs: [], size: 0, done: 0, speed: 0 };
      g.jobs.push(j);
      g.size += j.size;
      g.done += j.state === 'done' || j.state === 'skipped' ? j.size : j.done;
      if (j.state === 'running') g.speed += j.bytesPerSec ?? 0;
      m.set(j.group, g);
    }
    return [...m.values()].reverse();
  }, [jobs]);

  const active = jobs.filter((j) => ACTIVE.includes(j.state)).length;
  const needsHand = jobs.some((j) => j.state === 'interrupted' || j.state === 'paused');
  const total = jobs.reduce((n, j) => n + j.size, 0);
  const done = jobs.reduce((n, j) => n + (j.state === 'done' || j.state === 'skipped' ? j.size : j.done), 0);
  const pct = total > 0 ? Math.round((done * 100) / total) : active ? 0 : 100;

  // A new transfer opens the panel once.
  const count = jobs.length;
  useEffect(() => {
    if (count > 0) setOpen(true);
  }, [count]);

  const prompt = prompts[0];
  if (jobs.length === 0 && !prompt) return null;

  return (
    <>
      {prompt && <PromptDialog key={prompt.id} isAr={isAr} />}
      <div className="fixed bottom-20 end-3 z-40 w-[min(26rem,calc(100vw-1.5rem))] lg:bottom-4">
        {!open ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="ms-auto flex items-center gap-2 rounded-full border border-line-strong bg-surface px-3 py-2 text-xs font-medium text-fg shadow-[var(--shadow-overlay)] hover:border-accent"
            aria-label={t.open}
          >
            <ArrowLeftRight className="size-4 text-accent" aria-hidden />
            {active ? t.active(active) : needsHand ? t.states.interrupted : t.allDone}
            <span className="mono text-muted">{pct}%</span>
          </button>
        ) : (
          <section aria-label={t.center} className="max-h-[70vh] overflow-hidden rounded-[10px] border border-line-strong bg-surface shadow-[var(--shadow-overlay)]">
            <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
              <h2 className="text-[13px] font-semibold text-fg">
                {t.center} <span className="mono text-xs text-muted">{pct}%</span>
              </h2>
              <div className="flex items-center gap-1">
                {needsHand && (
                  <Button size="sm" variant="primary" onClick={() => transfers.resumeAll()}>
                    <Play className="size-3.5" aria-hidden />
                    {t.resumeAll}
                  </Button>
                )}
                {jobs.some((j) => ['done', 'cancelled', 'skipped', 'failed'].includes(j.state)) && (
                  <Button size="sm" onClick={() => transfers.clearFinished()}>
                    {t.clear}
                  </Button>
                )}
                <Button size="sm" onClick={() => setOpen(false)} title={t.hide} aria-label={t.hide}>
                  <ChevronDown className="size-3.5" aria-hidden />
                </Button>
              </div>
            </header>
            <ul className="max-h-[calc(70vh-3rem)] divide-y divide-line overflow-y-auto text-xs">
              {groups.map((g) => (
                <GroupRow
                  key={g.id}
                  g={g}
                  isAr={isAr}
                  now={now}
                  expanded={shown.has(g.id)}
                  onToggle={() =>
                    setShown((s) => {
                      const n = new Set(s);
                      if (n.has(g.id)) n.delete(g.id);
                      else n.add(g.id);
                      return n;
                    })
                  }
                />
              ))}
            </ul>
          </section>
        )}
      </div>
    </>
  );
}

function direction(j: Job) {
  if (j.src.kind === 'remote' && j.dst.kind === 'remote') return <ArrowLeftRight className="size-3.5 shrink-0 text-accent" aria-hidden />;
  if (j.src.kind === 'remote') return <ArrowDownToLine className="size-3.5 shrink-0 text-accent" aria-hidden />;
  return <ArrowUpFromLine className="size-3.5 shrink-0 text-accent" aria-hidden />;
}

function route(j: Job): string {
  const where = (p: Job['src']) =>
    p.kind === 'remote' ? `${p.device}: ${p.path}` : p.kind === 'disk' ? `${p.dirLabel}/${p.rel}` : p.kind === 'save' ? p.handle.name : p.kind === 'local' ? (p.file?.name ?? p.handle?.name ?? '') : '';
  return `${where(j.src)}  →  ${where(j.dst) || '⬇'}`;
}

function GroupRow({ g, isAr, now, expanded, onToggle }: { g: Group; isAr: boolean; now: number; expanded: boolean; onToggle: () => void }) {
  const t = transferText(isAr);
  const single = g.jobs.length === 1 ? g.jobs[0]! : null;
  const finished = g.jobs.filter((j) => ['done', 'skipped'].includes(j.state)).length;
  const failed = g.jobs.filter((j) => j.state === 'failed');
  const activeJobs = g.jobs.filter((j) => ACTIVE.includes(j.state));
  const stopped = g.jobs.some((j) => ['paused', 'interrupted', 'waiting'].includes(j.state));
  const state: JobState = single
    ? single.state
    : activeJobs.some((j) => j.state === 'running' || j.state === 'verifying')
      ? 'running'
      : activeJobs.some((j) => j.state === 'waiting')
        ? 'waiting'
        : activeJobs.length
          ? 'queued'
          : failed.length
            ? 'failed'
            : g.jobs.some((j) => j.state === 'interrupted')
              ? 'interrupted'
              : g.jobs.some((j) => j.state === 'paused')
                ? 'paused'
                : finished === g.jobs.length
                  ? 'done'
                  : 'cancelled';
  const pct = g.size > 0 ? Math.min(100, Math.round((g.done * 100) / g.size)) : state === 'done' ? 100 : 0;
  const eta = g.speed > 0 ? (g.size - g.done) / g.speed : 0;
  const waitingJob = g.jobs.find((j) => j.state === 'waiting');
  const first = single ?? g.jobs[0]!;

  return (
    <li className="space-y-1.5 px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            {direction(first)}
            <span className="truncate font-medium text-fg" title={single ? single.name : g.label}>
              {ltr(single ? single.name : g.label)}
            </span>
          </div>
          <div className="truncate text-[11px] text-faint" dir="ltr" title={route(first)}>
            {single ? route(single) : t.files(finished, g.jobs.length)}
          </div>
        </div>
        <span className="flex shrink-0 items-center gap-1">
          <Badge tone={tone[state]}>{t.states[state]}</Badge>
          {activeJobs.length > 0 && (
            <Button size="sm" onClick={() => transfers.pauseGroup(g.id)} title={t.pause} aria-label={t.pause}>
              <Pause className="size-3.5" aria-hidden />
            </Button>
          )}
          {(stopped || failed.length > 0) && (
            <Button size="sm" variant="primary" onClick={() => transfers.resumeGroup(g.id)} title={failed.length && !stopped ? t.retry : t.resume} aria-label={t.resume}>
              {failed.length && !stopped ? <RotateCcw className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
            </Button>
          )}
          {state !== 'done' && state !== 'cancelled' && (
            <Button size="sm" variant="danger" onClick={() => transfers.cancelGroup(g.id)} title={t.cancelAll} aria-label={t.cancel}>
              <X className="size-3.5" aria-hidden />
            </Button>
          )}
          {!single && (
            <Button size="sm" onClick={onToggle} aria-expanded={expanded} aria-label={g.label}>
              {expanded ? <ChevronUp className="size-3.5" aria-hidden /> : <ChevronDown className="size-3.5" aria-hidden />}
            </Button>
          )}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className={clsx('h-full transition-all', state === 'failed' ? 'bg-crit' : state === 'waiting' ? 'bg-warn' : 'bg-accent')} style={{ width: `${pct}%` }} />
        </div>
        <span className="mono shrink-0 text-muted">{pct}%</span>
      </div>
      <div className="flex flex-wrap justify-between gap-x-3 text-[11px] text-muted">
        <span className="mono">{ltr(`${formatBytes(g.done)} / ${formatBytes(g.size)}`)}</span>
        {state === 'running' && g.speed > 0 && (
          <span>
            {ltr(t.speed(formatBytes(g.speed)))}
            {eta > 0 && ` · ${t.left(formatDuration(eta, isAr))}`}
          </span>
        )}
      </div>
      {waitingJob && (
        <p className="flex items-start gap-1.5 text-[11px] text-warn">
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          {waitingJob.retryAt && waitingJob.retryAt > now ? t.retryIn(Math.ceil((waitingJob.retryAt - now) / 1000), waitingJob.attempts) : t.waitingNow}
        </p>
      )}
      {g.jobs.some((j) => j.state === 'interrupted') && <p className="text-[11px] text-warn">{g.jobs.find((j) => j.note === 'permission') ? t.permission : t.reload}</p>}
      {single?.state === 'done' && single.verified && (
        <p className="flex items-center gap-1 text-[11px] text-ok">
          <CheckCircle2 className="size-3.5" aria-hidden />
          {t.verified[single.verified]}
          {single.sha256 && <span className="mono text-faint">{ltr(` ${single.sha256.slice(0, 12)}…`)}</span>}
        </p>
      )}
      {single?.state === 'done' && single.url && (
        <a href={single.url} download={single.name} className="text-[11px] text-accent hover:underline">
          {isAr ? 'حفظ مرة أخرى' : 'Save again'}
        </a>
      )}
      {failed.slice(0, expanded || single ? 20 : 2).map((j) => (
        <p key={j.id} className="text-[11px] text-crit">
          {!single && <span className="mono">{ltr(j.name)}: </span>}
          {friendlyError(t, j.error)}
        </p>
      ))}
      {expanded && !single && (
        <ul className="max-h-48 space-y-0.5 overflow-y-auto rounded-md border border-line p-1.5">
          {g.jobs.map((j) => (
            <li key={j.id} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate" dir="ltr" title={route(j)}>
                {j.name}
              </span>
              <span className="flex shrink-0 items-center gap-1.5 text-faint">
                <span className="mono">{j.size > 0 ? `${Math.min(100, Math.round(((j.state === 'done' ? j.size : j.done) * 100) / j.size))}%` : ''}</span>
                <Badge tone={tone[j.state]}>{t.states[j.state]}</Badge>
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function PromptDialog({ isAr }: { isAr: boolean }) {
  const t = transferText(isAr);
  const { prompts } = useTransfers();
  const p = prompts[0];
  const [all, setAll] = useState(false);
  if (!p) return null;
  const dst = p.job.dst.kind === 'remote' ? p.job.dst : null;
  const restart = p.kind === 'restart';
  return (
    <Modal title={restart ? t.restartTitle : t.overwriteTitle} onClose={() => transfers.answer(p.id, false, false)}>
      <div className="space-y-3 text-[13px]">
        <p className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
          <span>{restart ? t.restartBody(p.job.name) : t.overwriteBody(p.job.name, dst?.device ?? '')}</span>
        </p>
        {dst && (
          <p className="mono break-all rounded-md border border-line bg-raised p-2 text-xs" dir="ltr">
            {dst.path} · {formatBytes(p.job.size)}
          </p>
        )}
        {!restart && (
          <label className="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            {t.applyAll}
          </label>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={() => transfers.answer(p.id, false, all)}>{restart ? t.cancel : t.keep}</Button>
          <Button variant="danger" onClick={() => transfers.answer(p.id, true, all)}>
            {restart ? t.startAgain : t.replace}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
