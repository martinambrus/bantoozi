import type { Calibration } from '../metrics/index.js';

/**
 * One reliability plot per language (spec 10 §4), as self-contained SVG text: the diagonal of
 * perfect calibration, each non-empty bin's positive fraction at its mean score (marker area by
 * count) and a count bar per bin. No external resources, scripts or fonts.
 */
const W = 360;
const H = 300;
const PAD = 40;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function reliabilitySvg(title: string, cal: Calibration): string {
  const plot = W - 2 * PAD;
  const x = (v: number) => PAD + v * plot;
  const y = (v: number) => H - PAD - v * (H - 2 * PAD);
  const maxCount = Math.max(1, ...cal.bins.map((b) => b.count));
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeXml(title)}">`,
    `<title>${escapeXml(title)}</title>`,
    `<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`,
    `<rect x="${PAD}" y="${PAD}" width="${plot}" height="${H - 2 * PAD}" fill="none" stroke="#999999"/>`,
    `<line x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(1)}" stroke="#bbbbbb" stroke-dasharray="4 3"/>`,
  );
  for (const bin of cal.bins) {
    const h = (bin.count / maxCount) * 0.15 * (H - 2 * PAD);
    parts.push(
      `<rect x="${x(bin.lo).toFixed(1)}" y="${(y(0) - h).toFixed(1)}" width="${((bin.hi - bin.lo) * plot - 1).toFixed(1)}" height="${h.toFixed(1)}" fill="#d0d7e2"/>`,
    );
  }
  const points = cal.bins.filter((b) => b.meanScore !== null && b.positiveFraction !== null);
  if (points.length > 1) {
    const path = points
      .map(
        (b, i) =>
          `${i === 0 ? 'M' : 'L'}${x(b.meanScore ?? 0).toFixed(1)},${y(b.positiveFraction ?? 0).toFixed(1)}`,
      )
      .join(' ');
    parts.push(`<path d="${path}" fill="none" stroke="#2b5797" stroke-width="1.5"/>`);
  }
  for (const b of points) {
    const r = 2 + 4 * Math.sqrt(b.count / maxCount);
    parts.push(
      `<circle cx="${x(b.meanScore ?? 0).toFixed(1)}" cy="${y(b.positiveFraction ?? 0).toFixed(1)}" r="${r.toFixed(1)}" fill="#2b5797"><title>${b.lo.toFixed(1)}–${b.hi.toFixed(1)}: n=${b.count}</title></circle>`,
    );
  }
  for (const v of [0, 0.5, 1]) {
    parts.push(
      `<text x="${x(v)}" y="${H - PAD + 14}" font-size="10" text-anchor="middle" fill="#333333">${v}</text>`,
      `<text x="${PAD - 6}" y="${y(v) + 3}" font-size="10" text-anchor="end" fill="#333333">${v}</text>`,
    );
  }
  parts.push(
    `<text x="${W / 2}" y="${H - 8}" font-size="11" text-anchor="middle" fill="#333333">mean card score</text>`,
    `<text x="12" y="${H / 2}" font-size="11" text-anchor="middle" fill="#333333" transform="rotate(-90 12 ${H / 2})">like-rate</text>`,
    `<text x="${W / 2}" y="18" font-size="12" text-anchor="middle" fill="#111111">${escapeXml(title)} (ECE ${cal.ece === null ? '—' : cal.ece.toFixed(3)}, n=${cal.n})</text>`,
    '</svg>',
  );
  return parts.join('\n');
}
