'use client';

import { ArrowLeft, CircleDot, Pause, Play, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { FleetRecording, FleetRecordingTimelineItem } from '@nigafiy/shared-types';
import { Async, Badge, Button, Card, ErrorNote, Notice, PageHeader, Select } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { absoluteTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { ltr } from '@/lib/localize/bidi';
import { bytes } from '../components/remote-desktop/rd-text';
import { drawFrame, parsePacket } from '../components/remote-desktop/rd-stream';
import { toolsText } from '../components/remote-desktop/tools-text';

interface Detail {
  recording: FleetRecording;
  segments: Array<{ name: string; bytes: number; started_at: string }>;
  timeline: FleetRecordingTimelineItem[];
}
interface RecordItem {
  type: number;
  ms: number;
  payload: Uint8Array;
}

/** A decrypted segment from the API: [u32 BE length][u8 type][u64 BE ms][payload] repeated. */
function parseSegment(buf: ArrayBuffer): RecordItem[] {
  const v = new DataView(buf);
  const out: RecordItem[] = [];
  let off = 0;
  while (off + 4 <= buf.byteLength) {
    const n = v.getUint32(off);
    off += 4;
    if (n < 9 || off + n > buf.byteLength) break;
    const ms = Number(v.getBigUint64(off + 1));
    out.push({ type: v.getUint8(off), ms, payload: new Uint8Array(buf, off + 9, n - 9) });
    off += n;
  }
  return out;
}

async function fetchSegment(id: string, name: string): Promise<{ items: RecordItem[]; error: string | null }> {
  const res = await fetch(`/api/v1/fleet/recordings/${id}/segments/${name}`, { credentials: 'same-origin', headers: { 'X-LD-CSRF': '1' }, cache: 'no-store' });
  if (!res.ok) {
    const j = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
    throw new ApiError(res.status, j?.error?.code ?? 'http_error', j?.error?.message ?? `Request failed (${res.status})`);
  }
  return { items: parseSegment(await res.arrayBuffer()), error: res.headers.get('X-Nigafiy-Segment-Error') };
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Playback of an encrypted session recording: the API decrypts one part at a time for an
 * authorized viewer (and audits the viewing); frames are drawn exactly as they were streamed.
 */
export function RecordingPlayerScreen({ id }: { id: string }) {
  const { locale } = useI18n();
  const tx = toolsText(locale);
  const px = tx.player;
  const { can } = useApp();
  const router = useRouter();
  const query = useQuery<Detail>(`/fleet/recordings/${id}`, [], 0);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [segIndex, setSegIndex] = useState(0);
  const [pos, setPos] = useState(0);
  const [inputs, setInputs] = useState<number[]>([]);
  const [segError, setSegError] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useRef(0);
  const origin = useRef<number | null>(null);

  const detail = query.data;
  useEffect(() => {
    if (!playing || !detail) return;
    const token = ++run.current;
    const alive = () => run.current === token;
    (async () => {
      for (let i = segIndex; i < detail.segments.length && alive(); i++) {
        setSegIndex(i);
        let seg: Awaited<ReturnType<typeof fetchSegment>>;
        try {
          seg = await fetchSegment(id, detail.segments[i]!.name);
        } catch (err) {
          setError(err instanceof ApiError ? err : new ApiError(0, 'error', String(err)));
          setPlaying(false);
          return;
        }
        setSegError(seg.error);
        if (origin.current === null && seg.items[0]) origin.current = seg.items[0].ms;
        const wallStart = performance.now();
        const segStart = seg.items[0]?.ms ?? 0;
        for (const it of seg.items) {
          if (!alive()) return;
          const wait = (it.ms - segStart) / speed - (performance.now() - wallStart);
          if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, 10_000)));
          if (!alive()) return;
          setPos(it.ms - (origin.current ?? it.ms));
          if (it.type === 1) {
            const buf = it.payload.slice().buffer;
            const pkt = parsePacket(buf);
            if (pkt && canvas.current) await drawFrame(canvas.current, pkt.header, pkt.tiles);
          } else if (it.type === 2) {
            setInputs((x) => [...x.slice(-199), it.ms - (origin.current ?? it.ms)]);
          }
        }
      }
      if (alive()) {
        setPlaying(false);
        setSegIndex(0);
      }
    })();
    return () => {
      run.current++;
    };
  }, [playing, segIndex, speed, id, detail]);

  async function remove() {
    if (!window.confirm(px.deleteConfirm)) return;
    setBusy(true);
    try {
      await api(`/fleet/recordings/${id}`, { method: 'DELETE' });
      router.push('/fleet/sessions');
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'error', String(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Link href="/fleet/sessions" className="inline-flex items-center gap-1.5 rounded text-xs font-medium text-muted hover:text-fg">
        <ArrowLeft className="size-3.5 rtl:-scale-x-100" aria-hidden />
        {px.back}
      </Link>
      <Async query={query}>
        {({ recording: r, segments, timeline }) => (
          <>
            <PageHeader
              icon={<CircleDot className="size-[18px] text-crit" aria-hidden />}
              title={`${px.title} · ${r.endpoint_name ?? ''}`}
              description={`${absoluteTime(r.started_at, locale)} · ${r.started_by_email ? ltr(r.started_by_email) : '—'} · ${ltr(r.session_public_id)}`}
            />
            {error && <ErrorNote error={error} />}
            <Notice>{px.viewedNote}</Notice>
            <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
              <Card
                title={
                  <span className="flex items-center gap-2">
                    {px.title}
                    <Badge tone={r.state === 'complete' ? 'ok' : r.state === 'recording' ? 'warn' : 'crit'}>{px.stateNames[r.state]}</Badge>
                  </span>
                }
                action={
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="primary" disabled={segments.length === 0} onClick={() => setPlaying((p) => !p)}>
                      {playing ? <Pause className="size-3.5" aria-hidden /> : <Play className="size-3.5 rtl:-scale-x-100" aria-hidden />}
                      {playing ? px.pause : px.play}
                    </Button>
                    <Select value={String(speed)} onChange={(e) => setSpeed(Number(e.target.value))} aria-label={px.speed}>
                      {[1, 2, 4, 8].map((s) => (
                        <option key={s} value={s}>{`${px.speed} ${ltr(`${s}×`)}`}</option>
                      ))}
                    </Select>
                    {segments.length > 1 && (
                      <Select value={String(segIndex)} onChange={(e) => setSegIndex(Number(e.target.value))} aria-label={px.segment}>
                        {segments.map((s, i) => (
                          <option key={s.name} value={i}>{`${px.segment} ${ltr(i + 1)} · ${absoluteTime(s.started_at, locale)}`}</option>
                        ))}
                      </Select>
                    )}
                    {can('admin') && r.state !== 'deleted' && (
                      <Button size="sm" variant="danger" busy={busy} onClick={() => void remove()}>
                        <Trash2 className="size-3.5" aria-hidden />
                        {px.deleteRec}
                      </Button>
                    )}
                  </div>
                }
              >
                <div className="space-y-2">
                  {segments.length === 0 && <p className="text-sm text-muted">{r.state === 'deleted' && r.deleted_by_email ? px.deleted(ltr(r.deleted_by_email)) : px.noSegments}</p>}
                  <div className="flex min-h-[320px] items-center justify-center overflow-hidden rounded-lg border border-line-strong bg-black">
                    <canvas ref={canvas} className="max-h-[70vh] max-w-full object-contain" aria-label={px.title} />
                  </div>
                  <div className="flex flex-wrap gap-x-3 text-[11px] text-muted mono">
                    <span>{px.position(ltr(clock(pos)))}</span>
                    <span>{px.facts(r.frames, r.input_events, bytes(r.bytes))}</span>
                    <span>{px.retention(absoluteTime(r.retention_until, locale))}</span>
                  </div>
                  {segError && <Notice className="border-warn/30 bg-warn/[0.08]">{`${px.segmentError} ${segError}`}</Notice>}
                  {r.error && <Notice className="border-warn/30 bg-warn/[0.08]">{r.error}</Notice>}
                </div>
              </Card>
              <div className="space-y-4">
                <Card title={px.inputs} description={px.inputsHint}>
                  <p className="mono text-xs text-muted">{inputs.length ? inputs.slice(-12).map((ms) => ltr(clock(ms))).join(' · ') : '—'}</p>
                </Card>
                <Card title={px.timeline}>
                  <ol className="max-h-[60vh] space-y-1.5 overflow-y-auto text-xs">
                    {timeline.map((e) => (
                      <li key={`${e.at}-${e.action}`} className="border-b border-line pb-1.5">
                        <span className="mono text-muted">{absoluteTime(e.at, locale)}</span>
                        <span className="block mono">{ltr(e.action)}</span>
                        {e.user_email && <span className="text-faint">{ltr(e.user_email)}</span>}
                      </li>
                    ))}
                  </ol>
                </Card>
              </div>
            </div>
          </>
        )}
      </Async>
    </div>
  );
}
