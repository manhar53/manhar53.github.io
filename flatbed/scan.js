// Pure image processing on {data, width, height} RGBA buffers.
// No DOM, so it runs in the worker and in Node tests alike.

const lumaOf = (d, p) => 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];

// ---------- document detection ----------

// Finds the page as the largest bright blob and returns its corners
// [tl, tr, br, bl] as [x, y] pairs, or null when nothing page-like is found.
export function detectQuad(img) {
  const { data, width: w, height: h } = img;
  const n = w * h;
  const lum = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) lum[i] = lumaOf(data, p);
  boxBlur(lum, w, h, 2);
  boxBlur(lum, w, h, 2);

  const t = otsu(lum);
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = lum[i] > t ? 1 : 0;

  const { labels, best, size } = largestComponent(mask, w, h);
  if (best < 0 || size < n * 0.12) return null;

  // Extreme points along the diagonals are the page corners.
  let tl = 0, tr = 0, br = 0, bl = 0;
  let sMin = Infinity, sMax = -Infinity, dMin = Infinity, dMax = -Infinity;
  for (let i = 0; i < n; i++) {
    if (labels[i] !== best) continue;
    const x = i % w, y = (i / w) | 0;
    const s = x + y, d = x - y;
    if (s < sMin) { sMin = s; tl = i; }
    if (s > sMax) { sMax = s; br = i; }
    if (d > dMax) { dMax = d; tr = i; }
    if (d < dMin) { dMin = d; bl = i; }
  }
  // Pull each corner one pixel toward the centre so the blurred edge of the
  // desk doesn't creep in as a dark rim.
  const pts = [tl, tr, br, bl].map((i) => [(i % w) + 0.5, ((i / w) | 0) + 0.5]);
  const mx = pts.reduce((s, p) => s + p[0], 0) / 4, my = pts.reduce((s, p) => s + p[1], 0) / 4;
  const quad = pts.map(([x, y]) => {
    const d = Math.hypot(mx - x, my - y) || 1;
    return [x + (mx - x) / d, y + (my - y) / d];
  });

  const area = polygonArea(quad);
  if (area < n * 0.15 || area > n * 0.97 || !isConvex(quad)) return null;
  return quad;
}

function boxBlur(a, w, h, r) {
  const tmp = new Float32Array(a.length);
  const win = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += a[row + clamp(k, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / win;
      sum += a[row + Math.min(x + r + 1, w - 1)] - a[row + Math.max(x - r, 0)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[clamp(k, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      a[y * w + x] = sum / win;
      sum += tmp[Math.min(y + r + 1, h - 1) * w + x] - tmp[Math.max(y - r, 0) * w + x];
    }
  }
}

function otsu(lum) {
  const hist = new Float64Array(256);
  for (let i = 0; i < lum.length; i++) hist[clamp(lum[i] | 0, 0, 255)]++;
  const total = lum.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let sumB = 0, wB = 0, bestVar = -1, best = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const v = wB * wF * (mB - mF) ** 2;
    if (v > bestVar) { bestVar = v; best = t; }
  }
  return best;
}

function largestComponent(mask, w, h) {
  const labels = new Int32Array(mask.length).fill(-1);
  const stack = new Int32Array(mask.length);
  let best = -1, size = 0, label = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start] !== -1) continue;
    let top = 0, count = 0;
    stack[top++] = start;
    labels[start] = label;
    while (top) {
      const i = stack[--top];
      count++;
      const x = i % w;
      if (x > 0 && mask[i - 1] && labels[i - 1] === -1) { labels[i - 1] = label; stack[top++] = i - 1; }
      if (x < w - 1 && mask[i + 1] && labels[i + 1] === -1) { labels[i + 1] = label; stack[top++] = i + 1; }
      if (i >= w && mask[i - w] && labels[i - w] === -1) { labels[i - w] = label; stack[top++] = i - w; }
      if (i < mask.length - w && mask[i + w] && labels[i + w] === -1) { labels[i + w] = label; stack[top++] = i + w; }
    }
    if (count > size) { size = count; best = label; }
    label++;
  }
  return { labels, best, size };
}

export function polygonArea(q) {
  let a = 0;
  for (let i = 0; i < q.length; i++) {
    const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % q.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

export function isConvex(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i], [bx, by] = q[(i + 1) % 4], [cx, cy] = q[(i + 2) % 4];
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(cross) < 1e-9) return false;
    if (!sign) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

// ---------- perspective correction ----------

// 3x3 homography (as 8 coefficients, h33 = 1) mapping each `from` point onto `to`.
export function homography(from, to) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i], [u, v] = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  return solve(A, b);
}

function solve(A, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    [b[c], b[piv]] = [b[piv], b[c]];
    if (Math.abs(A[c][c]) < 1e-12) throw new Error('Corners are degenerate');
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  return x;
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Real width/height ratio of the photographed rectangle, recovered from the
// camera geometry (Zhang & He, "Whiteboard scanning", 2004). Assumes the lens
// centre is the image centre. Returns null when the estimate isn't reliable,
// e.g. a nearly straight-on shot where the focal length can't be solved.
export function trueAspect(quad, imgW, imgH) {
  const cx = imgW / 2, cy = imgH / 2;
  const v = ([x, y]) => [x - cx, y - cy, 1];
  const m1 = v(quad[0]), m2 = v(quad[1]), m4 = v(quad[2]), m3 = v(quad[3]);
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const k2 = dot(cross(m1, m4), m3) / dot(cross(m2, m4), m3);
  const k3 = dot(cross(m1, m4), m2) / dot(cross(m3, m4), m2);
  const n2 = m2.map((c, i) => k2 * c - m1[i]);
  const n3 = m3.map((c, i) => k3 * c - m1[i]);
  if (Math.abs(n2[2]) < 1e-4 || Math.abs(n3[2]) < 1e-4) return null;
  const f2 = -(n2[0] * n3[0] + n2[1] * n3[1]) / (n2[2] * n3[2]);
  // Plausible phone focal lengths are roughly 0.5x to 3x the image diagonal.
  const diag = Math.hypot(imgW, imgH);
  if (!(f2 > (diag * 0.5) ** 2 && f2 < (diag * 3) ** 2)) return null;
  const ratio = Math.sqrt((n2[0] ** 2 + n2[1] ** 2) / f2 + n2[2] ** 2) / Math.sqrt((n3[0] ** 2 + n3[1] ** 2) / f2 + n3[2] ** 2);
  return ratio > 0.2 && ratio < 5 ? ratio : null;
}

// Flattens the quad [tl, tr, br, bl] of `src` into an upright rectangle.
export function warp(src, quad, maxSide = 2200) {
  const [tl, tr, br, bl] = quad;
  let W = Math.max(dist(tl, tr), dist(bl, br));
  let H = Math.max(dist(tl, bl), dist(tr, br));
  const ratio = trueAspect(quad, src.width, src.height);
  if (ratio) H = W / ratio;
  const s = Math.min(1, maxSide / Math.max(W, H));
  W = Math.max(1, Math.round(W * s));
  H = Math.max(1, Math.round(H * s));

  const m = homography([[0, 0], [W, 0], [W, H], [0, H]], quad);
  const { data: sd, width: sw, height: sh } = src;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const py = y + 0.5;
    for (let x = 0; x < W; x++) {
      const px = x + 0.5;
      const den = m[6] * px + m[7] * py + 1;
      const u = clamp((m[0] * px + m[1] * py + m[2]) / den - 0.5, 0, sw - 1);
      const v = clamp((m[3] * px + m[4] * py + m[5]) / den - 0.5, 0, sh - 1);
      const x0 = u | 0, y0 = v | 0;
      const x1 = Math.min(x0 + 1, sw - 1), y1 = Math.min(y0 + 1, sh - 1);
      const fx = u - x0, fy = v - y0;
      const p00 = (y0 * sw + x0) * 4, p10 = (y0 * sw + x1) * 4;
      const p01 = (y1 * sw + x0) * 4, p11 = (y1 * sw + x1) * 4;
      const o = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        const top = sd[p00 + c] + (sd[p10 + c] - sd[p00 + c]) * fx;
        const bot = sd[p01 + c] + (sd[p11 + c] - sd[p01 + c]) * fx;
        out[o + c] = top + (bot - top) * fy;
      }
      out[o + 3] = 255;
    }
  }
  return { data: out, width: W, height: H };
}

// ---------- looks ----------

export const FILTERS = ['enhance', 'original', 'gray', 'bw'];

// Divides out the paper's lighting (shadows, tint, falloff) so the page reads
// as white, then applies the chosen look. `original` returns the input.
export function applyFilter(img, mode) {
  if (mode === 'original') return img;
  const { data, width: w, height: h } = img;
  const { grid, gw, gh, B } = illumination(img);
  const bgAt = (x, y) => {
    const gx = clamp((x + 0.5) / B - 0.5, 0, gw - 1), gy = clamp((y + 0.5) / B - 0.5, 0, gh - 1);
    const x0 = gx | 0, y0 = gy | 0, x1 = Math.min(x0 + 1, gw - 1), y1 = Math.min(y0 + 1, gh - 1);
    const fx = gx - x0, fy = gy - y0;
    const top = grid[y0 * gw + x0] + (grid[y0 * gw + x1] - grid[y0 * gw + x0]) * fx;
    const bot = grid[y1 * gw + x0] + (grid[y1 * gw + x1] - grid[y1 * gw + x0]) * fx;
    return Math.max(8, top + (bot - top) * fy);
  };

  // One white balance for the whole page, taken from pixels that are bare paper.
  // Per-block colour would amplify JPEG colour fringing around text into blotches.
  let sr = 0, sg = 0, sb = 0, sl = 0;
  for (let y = 0; y < h; y += 5) for (let x = 0; x < w; x += 5) {
    const p = (y * w + x) * 4, l = lumaOf(data, p);
    if (l < 0.9 * bgAt(x, y)) continue;
    sr += data[p]; sg += data[p + 1]; sb += data[p + 2]; sl += l;
  }
  const wb = sl ? [sr / sl, sg / sl, sb / sl] : [1, 1, 1];

  const out = new Uint8ClampedArray(data.length);
  const n = new Float32Array(3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4, bg = bgAt(x, y);
      for (let c = 0; c < 3; c++) n[c] = Math.min(1.2, data[p + c] / (bg * wb[c]));
      if (mode === 'bw') {
        const l = 0.299 * n[0] + 0.587 * n[1] + 0.114 * n[2];
        out[p] = out[p + 1] = out[p + 2] = smoothstep(0.55, 0.72, l) * 255;
      } else if (mode === 'gray') {
        out[p] = out[p + 1] = out[p + 2] = contrast(0.299 * n[0] + 0.587 * n[1] + 0.114 * n[2]) * 255;
      } else {
        out[p] = contrast(n[0]) * 255; out[p + 1] = contrast(n[1]) * 255; out[p + 2] = contrast(n[2]) * 255;
      }
      out[p + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

const contrast = (v) => Math.pow(clamp((v - 0.12) / 0.8, 0, 1), 1.15);
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// Coarse estimate of the bare paper's brightness, one value per block.
function illumination({ data, width: w, height: h }) {
  const B = Math.max(8, Math.round(Math.max(w, h) / 48));
  const gw = Math.ceil(w / B), gh = Math.ceil(h / B);
  let grid = new Float32Array(gw * gh);
  for (let by = 0; by < gh; by++) {
    for (let bx = 0; bx < gw; bx++) {
      let m = 0;
      for (let y = by * B; y < Math.min(h, (by + 1) * B); y += 2) {
        for (let x = bx * B; x < Math.min(w, (bx + 1) * B); x += 2) {
          const l = lumaOf(data, (y * w + x) * 4);
          if (l > m) m = l;
        }
      }
      grid[by * gw + bx] = m;
    }
  }
  // Spread paper into text-dense blocks, then soften the steps.
  const mean = (v) => v.reduce((a, b) => a + b) / v.length;
  grid = gridFilter(grid, gw, gh, (v) => Math.max(...v));
  grid = gridFilter(grid, gw, gh, mean);
  grid = gridFilter(grid, gw, gh, mean);

  // Blocks far darker than the paper are photos, not shadows: don't flatten them.
  const sorted = [...grid].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.95)] * 0.55;
  for (let i = 0; i < grid.length; i++) grid[i] = Math.max(grid[i], floor);
  return { grid, gw, gh, B };
}

function gridFilter(grid, gw, gh, fn) {
  const out = new Float32Array(grid.length);
  const v = new Array(9);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      let k = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        v[k++] = grid[clamp(y + dy, 0, gh - 1) * gw + clamp(x + dx, 0, gw - 1)];
      }
      out[y * gw + x] = fn(v);
    }
  }
  return out;
}

// ---------- rotation ----------

// Rotates clockwise by `turns` quarter turns.
export function rotate(img, turns) {
  const k = ((turns % 4) + 4) % 4;
  if (!k) return img;
  const { data, width: w, height: h } = img;
  const W = k === 2 ? w : h, H = k === 2 ? h : w;
  const out = new Uint32Array(W * H);
  const src = new Uint32Array(data.buffer, data.byteOffset, w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx, ny;
      if (k === 1) { nx = h - 1 - y; ny = x; }
      else if (k === 2) { nx = w - 1 - x; ny = h - 1 - y; }
      else { nx = y; ny = w - 1 - x; }
      out[ny * W + nx] = src[y * w + x];
    }
  }
  return { data: new Uint8ClampedArray(out.buffer), width: W, height: H };
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
