'use client';

import { Pause, Play } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button, Card } from '@/components/ui';
import { absoluteTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { ltr } from '@/lib/localize/bidi';
import { drawFrame, parsePacket } from '../components/remote-desktop/rd-stream';
import { type RecordItem, parseSegment } from './recording-player-screen';

// The page a "Past recordings…" link from the Nigafiy tray opens: one recording of the person's own
// computer, read through the link's token only (no sign-in). The link opens for 15 minutes and
// plays for 4 hours; the API checks the group still allows it on every request and audits the
// first opening.

interface LinkDetail {
  recording: { id: string; state: string; started_at: string; ended_at: string | null; operator: string | null; reason: string | null; endpoint_name: string };
  segments: Array<{ name: string; bytes: number; started_at: string }>;
}

const en = {
  title: 'Recording of a remote support session',
  intro: 'This is what IT saw and did on your computer during this session, recorded by Nigafiy. Only you have this link; it expires.',
  computer: 'Computer',
  operator: 'IT person',
  reason: 'Reason',
  started: 'Started',
  play: 'Play',
  pause: 'Pause',
  loading: 'Loading…',
  noParts: 'Nothing of this recording is kept any more.',
  expired: 'This link has expired or is no longer allowed. Open “Past recordings…” from the Nigafiy icon again.',
  failed: 'The recording could not be loaded.',
  inputs: (n: number) => `${n} input events by IT`,
};
type Text = typeof en;
const ar: Text = {
  title: 'تسجيل جلسة دعم عن بُعد',
  intro: 'هذا ما رآه فريق تقنية المعلومات وفعله على حاسوبك خلال هذه الجلسة، كما سجّله Nigafiy. هذا الرابط لك وحدك، وتنتهي صلاحيته.',
  computer: 'الحاسوب',
  operator: 'موظف تقنية المعلومات',
  reason: 'السبب',
  started: 'البداية',
  play: 'تشغيل',
  pause: 'إيقاف مؤقت',
  loading: 'جارٍ التحميل…',
  noParts: 'لم يعد أي جزء من هذا التسجيل محفوظًا.',
  expired: 'انتهت صلاحية هذا الرابط أو لم يعد مسموحًا. افتح «التسجيلات السابقة…» من أيقونة Nigafiy مجددًا.',
  failed: 'تعذّر تحميل التسجيل.',
  inputs: (n: number) => `${n} حدث إدخال من فريق تقنية المعلومات`,
};

async function getJson<T>(url: string): Promise<{ ok: true; data: T } | { ok: false; status: number }> {
  const res = await fetch(url, { cache: 'no-store', credentials: 'omit' });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, data: (await res.json()) as T };
}

export function UserRecordingScreen({ token }: { token: string }) {
  const { locale } = useI18n();
  const t = locale === 'ar' ? ar : en;
  const [detail, setDetail] = useState<LinkDetail | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [inputs, setInputs] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null);
  const run = useRef(0);
  const base = `/api/v1/recording-links/${encodeURIComponent(token)}`;

  useEffect(() => {
    void getJson<LinkDetail>(base).then((r) => {
      if (r.ok) setDetail(r.data);
      else setProblem(r.status === 410 || r.status === 403 || r.status === 404 ? 'expired' : 'failed');
    });
  }, [base]);

  useEffect(() => {
    if (!playing || !detail) return;
    const me = ++run.current;
    const alive = () => run.current === me;
    (async () => {
      for (const seg of detail.segments) {
        if (!alive()) return;
        const res = await fetch(`${base}/segments/${seg.name}`, { cache: 'no-store', credentials: 'omit' });
        if (!res.ok) {
          setProblem(res.status === 410 || res.status === 403 ? 'expired' : 'failed');
          setPlaying(false);
          return;
        }
        const items: RecordItem[] = parseSegment(await res.arrayBuffer());
        const wallStart = performance.now();
        const segStart = items[0]?.ms ?? 0;
        for (const it of items) {
          if (!alive()) return;
          const wait = it.ms - segStart - (performance.now() - wallStart);
          if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, 10_000)));
          if (it.type === 1) {
            const pkt = parsePacket(it.payload.slice().buffer);
            if (pkt && canvas.current) await drawFrame(canvas.current, pkt.header, pkt.tiles);
          } else if (it.type === 2) {
            setInputs((n) => n + 1);
          }
        }
      }
      if (alive()) setPlaying(false);
    })();
    return () => {
      run.current++;
    };
  }, [playing, detail, base]);

  return (
    <main className="mx-auto max-w-5xl space-y-4 p-4 sm:p-8">
      <h1 className="text-xl font-semibold">{t.title}</h1>
      <p className="text-sm text-muted">{t.intro}</p>
      {problem && (
        <p role="alert" className="rounded-md border border-crit/30 bg-crit/[0.07] px-3 py-2 text-sm">
          {problem === 'expired' ? t.expired : t.failed}
        </p>
      )}
      {!detail && !problem && <p className="text-sm text-muted">{t.loading}</p>}
      {detail && (
        <Card>
          <dl className="grid gap-2 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted">{t.computer}</dt>
              <dd dir="auto">{detail.recording.endpoint_name}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{t.operator}</dt>
              <dd>{detail.recording.operator ? ltr(detail.recording.operator) : '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{t.reason}</dt>
              <dd dir="auto">{detail.recording.reason ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{t.started}</dt>
              <dd>{absoluteTime(detail.recording.started_at, locale)}</dd>
            </div>
          </dl>
          <div className="mt-4 space-y-3">
            {detail.segments.length === 0 ? (
              <p className="text-sm text-muted">{t.noParts}</p>
            ) : (
              <>
                <Button variant="primary" size="sm" onClick={() => setPlaying((p) => !p)}>
                  {playing ? <Pause className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
                  {playing ? t.pause : t.play}
                </Button>
                <canvas ref={canvas} className="max-h-[70vh] max-w-full rounded border border-line bg-black object-contain" aria-label={t.title} />
                <p className="text-xs text-muted">{t.inputs(inputs)}</p>
              </>
            )}
          </div>
        </Card>
      )}
    </main>
  );
}
