// Annotations ("marks") on a page: text, pen ink, highlighter and signatures.
// Positions are fractions of the page's width and height as displayed. Sizes
// are fractions of its shorter side, so marks survive rotation and re-rendering.

export const FONT = '"Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", "Nirmala UI", sans-serif';
export const LINE = 1.25;

const images = new Map();
export function signatureImage(src) {
  let p = images.get(src);
  if (!p) {
    const img = new Image();
    img.src = src;
    p = img.decode().then(() => img);
    images.set(src, p);
  }
  return p;
}

// Highlights under pen under text and signatures, matching the editor's layers.
const layer = (m) => (m.type === 'ink' ? (m.highlight ? 0 : 1) : 2);

export async function drawMarks(ctx, marks, W, H) {
  const unit = Math.min(W, H);
  const sigs = new Map(await Promise.all(
    marks.filter((m) => m.type === 'sign').map(async (m) => [m, await signatureImage(m.src)])));
  for (const m of [...marks].sort((a, b) => layer(a) - layer(b))) {
    ctx.save();
    if (m.type === 'ink') drawInk(ctx, m, W, H);
    else {
      ctx.translate(m.x * W, m.y * H);
      ctx.rotate((m.turn * Math.PI) / 2);
      if (m.type === 'text') drawText(ctx, m, unit);
      else {
        const img = sigs.get(m);
        const w = m.size * unit, h = (w * img.naturalHeight) / img.naturalWidth;
        ctx.drawImage(img, -w / 2, -h / 2, w, h);
      }
    }
    ctx.restore();
  }
}

export function drawInk(ctx, m, W, H) {
  ctx.save();
  ctx.lineCap = ctx.lineJoin = 'round';
  ctx.strokeStyle = m.color;
  ctx.lineWidth = m.size * Math.min(W, H);
  if (m.highlight) {
    ctx.globalAlpha = 0.4;
    ctx.globalCompositeOperation = 'multiply';
  }
  ctx.beginPath();
  m.points.forEach(([x, y], i) => (i ? ctx.lineTo(x * W, y * H) : ctx.moveTo(x * W, y * H)));
  if (m.points.length === 1) ctx.lineTo(m.points[0][0] * W + 0.01, m.points[0][1] * H);
  ctx.stroke();
  ctx.restore();
}

function drawText(ctx, m, unit) {
  const size = m.size * unit;
  ctx.font = `500 ${size}px ${FONT}`;
  ctx.fillStyle = m.color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = m.text.split('\n');
  lines.forEach((line, k) => ctx.fillText(line, 0, (k - (lines.length - 1) / 2) * size * LINE));
}

// Quarter turn clockwise, to follow the page when it is rotated.
export function rotateMarks(marks) {
  for (const m of marks) {
    if (m.type === 'ink') m.points = m.points.map(([x, y]) => [1 - y, x]);
    else {
      [m.x, m.y] = [1 - m.y, m.x];
      m.turn = (m.turn + 1) % 4;
    }
  }
}

// Index of the topmost ink stroke within reach of (x, y), in pixels of a W×H page.
export function inkAt(marks, x, y, W, H) {
  for (let i = marks.length - 1; i >= 0; i--) {
    const m = marks[i];
    if (m.type !== 'ink') continue;
    const reach = Math.max(12, (m.size * Math.min(W, H)) / 2 + 4);
    const pts = m.points.map(([px, py]) => [px * W, py * H]);
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k], b = pts[k + 1] || a;
      if (segmentDistance(x, y, a, b) <= reach) return i;
    }
  }
  return -1;
}

function segmentDistance(x, y, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len)) : 0;
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

// Draws `src` rotated clockwise by `turns` quarter turns onto a new canvas.
export function rotateCanvas(src, turns) {
  const k = ((turns % 4) + 4) % 4;
  if (!k) return src;
  const c = document.createElement('canvas');
  c.width = k % 2 ? src.height : src.width;
  c.height = k % 2 ? src.width : src.height;
  const ctx = c.getContext('2d');
  if (k === 1) { ctx.translate(c.width, 0); ctx.rotate(Math.PI / 2); }
  else if (k === 2) { ctx.translate(c.width, c.height); ctx.rotate(Math.PI); }
  else { ctx.translate(0, c.height); ctx.rotate(-Math.PI / 2); }
  ctx.drawImage(src, 0, 0);
  return c;
}
