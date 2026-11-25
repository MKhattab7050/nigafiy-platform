'use client';

import { useMemo } from 'react';
import { encodeQr, qrSvgPath } from './qr';

/**
 * A QR code drawn as one SVG path. Always dark modules on white with the 4-module quiet zone, in
 * both themes: phone cameras read dark-on-light codes most reliably.
 */
export function QrCode({ value, label, size = 220 }: { value: string; label: string; size?: number }) {
  const { path, dim } = useMemo(() => {
    const qr = encodeQr(value, 'M');
    return { path: qrSvgPath(qr), dim: qr.size + 8 };
  }, [value]);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${dim} ${dim}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className="block rounded-[var(--radius-control)] border border-line"
      style={{ background: '#ffffff' }}
    >
      <path d={path} fill="#000000" />
    </svg>
  );
}
