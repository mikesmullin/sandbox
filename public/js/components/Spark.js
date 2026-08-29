// Mars-style 1px bar charts (see /workspace/tmp/gemma-mjs-test/mars.html debug overlay).

// ~1 minute at the 1 Hz scrape. New samples enter on the right; the left
// edge truncates once the window is full. Bars span the canvas so a full
// window uses the whole chart (the old 1px × 120 layout only filled half).
export const SPARK_N = 60;

export function coldHot(t) {
  t = Math.max(0, Math.min(1, t));
  let r, g, b;
  if (t < 0.5) {
    const s = t * 2;
    r = 0.20 + 0.75 * s;
    g = 0.45 + 0.40 * s;
    b = 0.95 - 0.70 * s;
  } else {
    const s = (t - 0.5) * 2;
    r = 0.95;
    g = 0.85 - 0.60 * s;
    b = 0.25 - 0.05 * s;
  }
  return `rgb(${(r * 255) | 0},${(g * 255) | 0},${(b * 255) | 0})`;
}

export function drawGauge(canvas, pct) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2 + 4;
  const r = Math.min(w, h) / 2 - 10;
  const start = Math.PI * 0.75;
  const sweep = Math.PI * 1.5;
  const t = Math.max(0, Math.min(1, (Number(pct) || 0) / 100));
  ctx.clearRect(0, 0, w, h);
  ctx.lineWidth = Math.max(8, Math.round(r * 0.18));
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.beginPath();
  ctx.arc(cx, cy, r, start, start + sweep);
  ctx.stroke();
  if (t > 0) {
    ctx.strokeStyle = coldHot(t);
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, start + sweep * t);
    ctx.stroke();
  }
}

// Map a pointer x to the visual slot (0..SPARK_N-1). Empty pad on the
// left is still a slot; sparkIndexAt turns that into a series index.
export function sparkSlotAt(canvas, clientX) {
  if (!canvas) return -1;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width || canvas.clientWidth || 1;
  const x = clientX - rect.left;
  if (x < 0 || x >= w) return -1;
  return Math.min(SPARK_N - 1, Math.max(0, Math.floor((x / w) * SPARK_N)));
}

export function sparkIndexAt(slot, n) {
  const len = Number(n) || 0;
  if (slot < 0 || slot >= SPARK_N || len <= 0) return -1;
  const i = slot - (SPARK_N - len);
  return (i >= 0 && i < len) ? i : -1;
}

export function drawSpark(canvas, a, b, opts = {}) {
  if (!canvas) return;
  const cssW = Math.max(1, Math.round(canvas.clientWidth || canvas.width || 1));
  if (canvas.width !== cssW) canvas.width = cssW;
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  const seriesA = (a || []).slice(-SPARK_N);
  const seriesB = (b || []).slice(-SPARK_N);
  const n = Math.max(seriesA.length, seriesB.length);
  if (!n) return;
  const dual = Array.isArray(b);
  let maxV = opts.max || 0;
  if (!maxV) {
    for (let i = 0; i < seriesA.length; i++) maxV = Math.max(maxV, seriesA[i] || 0);
    for (let i = 0; i < seriesB.length; i++) maxV = Math.max(maxV, seriesB[i] || 0);
    maxV = Math.max(opts.floor || 1, maxV * 1.1);
  }
  const barW = w / SPARK_N;
  const pad = SPARK_N - n;
  for (let i = 0; i < n; i++) {
    const x = (pad + i) * barW;
    const va = seriesA[i] || 0;
    const vb = dual ? (seriesB[i] || 0) : 0;
    const bw = Math.max(1, Math.ceil(barW));
    if (dual) {
      if (va > 0) {
        const bh = Math.max(1, Math.round(h * Math.min(1, va / maxV)));
        ctx.fillStyle = 'rgba(130,230,130,.95)';
        ctx.fillRect(x, h - bh, bw, bh);
      }
      if (vb > 0) {
        const bh = Math.max(1, Math.round(h * Math.min(1, vb / maxV)));
        ctx.fillStyle = 'rgba(130,190,255,.95)';
        ctx.fillRect(x, h - bh, Math.max(1, bw - 1), bh);
      }
    } else if (va > 0) {
      const t = Math.min(1, va / maxV);
      ctx.fillStyle = coldHot(t);
      const bh = Math.max(1, Math.round(h * t));
      ctx.fillRect(x, h - bh, bw, bh);
    }
  }
  if (opts.hoverSlot != null) {
    const slot = opts.hoverSlot;
    if (slot >= pad && slot < SPARK_N) {
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      ctx.fillRect(slot * barW, 0, Math.max(1, Math.ceil(barW)), h);
    }
  }
}

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1099511627776) return `${(v / 1099511627776).toFixed(2)} TB`;
  if (v >= 1073741824) return `${(v / 1073741824).toFixed(2)} GB`;
  if (v >= 1048576) return `${(v / 1048576).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(0)} KB`;
  return `${Math.round(v)} B`;
}

export function formatBps(n) {
  const v = Number(n) || 0;
  if (v >= 1073741824) return `${(v / 1073741824).toFixed(2)} GB/s`;
  if (v >= 1048576) return `${(v / 1048576).toFixed(1)} MB/s`;
  if (v >= 1024) return `${(v / 1024).toFixed(0)} KB/s`;
  return `${Math.round(v)} B/s`;
}
