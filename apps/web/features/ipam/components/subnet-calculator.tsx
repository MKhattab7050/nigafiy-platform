'use client';

import clsx from 'clsx';
import { useMemo, useState } from 'react';
import { Fact, Field, Input, Select } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { ipamText } from '../text';
import { formatCount, formatIp, parseSubnet, splitSubnet, type Subnet } from '../subnet-calc';

// ── subnet calculator (works offline, nothing is sent anywhere) ─────────────

export function SubnetCalculator({ initial }: { initial?: string }) {
  const { locale } = useI18n();
  const tx = ipamText(locale).calc;
  const [text, setText] = useState(initial ?? '192.168.1.0/24');
  const s = useMemo(() => parseSubnet(text), [text]);
  const [splitTo, setSplitTo] = useState<number | null>(null);
  const newPrefix = s ? Math.min(s.bits, Math.max(s.prefix + 1, splitTo ?? s.prefix + 1)) : 0;
  const split = s && s.prefix < s.bits ? splitSubnet(s, newPrefix, 64) : null;
  const num = (n: bigint) => {
    const c = formatCount(n);
    return c.power === null ? c.digits : `${c.digits} (${tx.powerOf.replace('{n}', String(c.power))})`;
  };
  const ip = (n: bigint, x: Subnet) => formatIp(n, x.family);
  const range = (x: Subnet) => (x.usable === 1n ? ip(x.first, x) : `${ip(x.first, x)} – ${ip(x.last, x)}`);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="rounded-lg border border-line bg-surface p-4">
        <Field label={tx.input} hint={tx.hint} error={text.trim() && !s ? tx.invalid : undefined}>
          {(id) => <Input id={id} dir="ltr" className="mono" value={text} onChange={(e) => setText(e.target.value)} maxLength={64} spellCheck={false} autoComplete="off" />}
        </Field>
        {s && (
          <>
            <div className="mt-4" dir="ltr" aria-hidden>
              <div className={clsx('flex', s.family === 4 && 'gap-px')}>
                {Array.from({ length: s.bits }, (_, i) => (
                  <span
                    key={i}
                    className={clsx('h-3 flex-1', s.family === 4 && 'rounded-[2px]', i < s.prefix ? 'bg-accent' : 'bg-ok/60', i > 0 && i % (s.family === 4 ? 8 : 16) === 0 && 'ms-1')}
                  />
                ))}
              </div>
            </div>
            <p className="mt-1.5 text-xs text-muted">
              {tx.bits}: <span className="text-accent-hover">{s.prefix} {tx.networkBits}</span> · <span className="text-ok">{s.bits - s.prefix} {tx.hostBits}</span>
            </p>
            <dl className="mt-3">
              <Fact label={tx.network}>
                <span className="mono break-all">
                  {ip(s.network, s)}/{s.prefix}
                </span>
              </Fact>
              <Fact label={tx.netmask}>
                <span className="mono break-all">{s.netmask}</span>
              </Fact>
              {s.wildcard !== null && (
                <Fact label={tx.wildcard}>
                  <span className="mono">{s.wildcard}</span>
                </Fact>
              )}
              <Fact label={tx.range}>
                <span className="mono break-all">{range(s)}</span>
              </Fact>
              <Fact label={tx.broadcast}>
                {s.family === 6 ? <span className="text-muted">{ipamText(locale).noBroadcast}</span> : <span className="mono">{s.broadcast === null ? '—' : ip(s.broadcast, s)}</span>}
              </Fact>
              <Fact label={s.family === 6 && s.prefix < 127 ? tx.usableV6 : tx.usable}>
                <span className="tnum">{num(s.usable)}</span>
              </Fact>
              <Fact label={tx.total}>
                <span className="tnum">{num(s.total)}</span>
              </Fact>
              <Fact label={tx.kind}>{tx.kinds[s.kind]}</Fact>
            </dl>
          </>
        )}
      </section>
      {s && split && (
        <section className="rounded-lg border border-line bg-surface p-4">
          <h2 className="mb-3 text-[13px] font-semibold">{tx.split}</h2>
          <div className="max-w-40">
            <Field label={tx.splitInto}>
              {(id) => (
                <Select id={id} dir="ltr" value={newPrefix} onChange={(e) => setSplitTo(Number(e.target.value))}>
                  {Array.from({ length: s.bits - s.prefix }, (_, i) => s.prefix + 1 + i).map((p) => (
                    <option key={p} value={p}>
                      /{p}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <p className="mt-3 text-xs text-muted tnum">
            {num(split.count)} {tx.splitCount} · {num(split.items[0]!.usable)} {tx.hostsEach}
            {split.count > BigInt(split.items.length) && ` · ${split.items.length} ${tx.splitShown}`}
          </p>
          <ul dir="ltr" className="mt-2 max-h-96 divide-y divide-line overflow-y-auto text-xs">
            {split.items.map((x) => (
              <li key={x.network.toString()} className="flex flex-wrap justify-between gap-x-4 gap-y-0.5 py-1.5">
                <span className="mono font-medium break-all">
                  {ip(x.network, x)}/{x.prefix}
                </span>
                <span className="mono break-all text-muted">{range(x)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
