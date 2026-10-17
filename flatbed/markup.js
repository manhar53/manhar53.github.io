// The editor's "Mark up" layer: places, moves and edits marks on the page
// preview, and the signature pad. Marks are stored on page.marks (see marks.js).

import { drawInk, inkAt } from './marks.js';

export const PEN = ['#16140f', '#1d4ed8', '#c81e1e', '#15803d'];
export const HIGHLIGHT = ['#ffd400', '#7be37b', '#ff8ac4', '#73c7ff'];
const SIZES = {
  text: { s: 0.03, m: 0.045, l: 0.07 },
  pen: { s: 0.004, m: 0.007, l: 0.012 },
  highlight: { s: 0.025, m: 0.035, l: 0.05 },
  sign: { s: 0.22, m: 0.35, l: 0.5 },
};
const kindOf = (m) => (m.type === 'ink' ? (m.highlight ? 'highlight' : 'pen') : m.type);
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// ui: { tools, colors, sizes, undo, del, sign, date } — tools are buttons with data-tool,
// sizes are buttons with data-size. requestSignature(color) resolves to a PNG data URL.
export function createMarkup({ frame, ui, onChange, requestSignature }) {
  const layer = document.createElement('div');
  layer.className = 'marks';
  layer.hidden = true;
  const canvas = document.createElement('canvas');
  layer.append(canvas);
  frame.append(layer);
  const ctx = canvas.getContext('2d');

  let page = null;
  let tool = 'select', size = 'm', penColor = PEN[0], hlColor = HIGHLIGHT[0];
  let selected = null, stroke = null, history = [], changed = false;
  const els = new Map();
  const fresh = new WeakSet();

  const rect = () => layer.getBoundingClientRect();
  const point = (e) => {
    const r = rect();
    return [clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height)];
  };
  const snapshot = () => {
    history.push(JSON.stringify(page.marks));
    if (history.length > 60) history.shift();
  };
  const commit = () => {
    changed = true;
    render();
    sync();
    onChange?.(page);
  };
  const add = (m) => {
    snapshot();
    page.marks.push(m);
    setTool('select');
    commit();
    select(m);
  };

  // ---------- rendering ----------

  function render() {
    if (!page) return;
    const live = new Set(page.marks);
    for (const [m, el] of els) if (!live.has(m)) { el.remove(); els.delete(m); }
    for (const m of page.marks) if (m.type !== 'ink') place(m, elementFor(m));
    draw();
  }

  function place(m, el) {
    const r = rect(), unit = Math.min(r.width, r.height);
    el.style.left = `${m.x * 100}%`;
    el.style.top = `${m.y * 100}%`;
    el.style.transform = `translate(-50%, -50%) rotate(${m.turn * 90}deg)`;
    if (m.type === 'text') {
      el.style.fontSize = `${m.size * unit}px`;
      el.style.color = m.color;
      if (document.activeElement !== el && el.innerText !== m.text) el.textContent = m.text;
    } else {
      el.style.width = `${m.size * unit}px`;
    }
    el.classList.toggle('selected', m === selected);
  }

  function draw() {
    const r = rect(), dpr = devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    ctx.clearRect(0, 0, w, h);
    const inks = page.marks.filter((m) => m.type === 'ink');
    for (const m of [...inks.filter((m) => m.highlight), ...inks.filter((m) => !m.highlight)]) drawInk(ctx, m, w, h);
    if (stroke) drawInk(ctx, stroke, w, h);
    if (selected?.type === 'ink') {
      const xs = selected.points.map((p) => p[0] * w), ys = selected.points.map((p) => p[1] * h);
      const pad = (selected.size * Math.min(w, h)) / 2 + 6 * dpr;
      ctx.save();
      ctx.setLineDash([6 * dpr, 4 * dpr]);
      ctx.strokeStyle = '#19c784';
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeRect(Math.min(...xs) - pad, Math.min(...ys) - pad,
        Math.max(...xs) - Math.min(...xs) + pad * 2, Math.max(...ys) - Math.min(...ys) + pad * 2);
      ctx.restore();
    }
  }

  // ---------- text and signature elements ----------

  function elementFor(m) {
    let el = els.get(m);
    if (el) return el;
    if (m.type === 'text') {
      el = document.createElement('div');
      el.className = 'mark text';
      try { el.contentEditable = 'plaintext-only'; } catch { el.contentEditable = 'true'; }
      el.spellcheck = false;
      el.textContent = m.text;
      let before = null, startText = '';
      el.addEventListener('focus', () => { before = JSON.stringify(page.marks); startText = m.text; select(m); });
      el.addEventListener('input', () => { m.text = el.innerText.replace(/\n+$/, ''); changed = true; });
      el.addEventListener('blur', () => {
        if (!page || !page.marks.includes(m)) return;
        m.text = el.innerText.replace(/\n+$/, '');
        const empty = !m.text.trim();
        if (empty) page.marks.splice(page.marks.indexOf(m), 1);
        // A new box already has its undo step from being created.
        if (fresh.has(m)) { if (empty) history.pop(); }
        else if (m.text !== startText) history.push(before);
        fresh.delete(m);
        if (empty && selected === m) selected = null;
        commit();
      });
    } else {
      el = document.createElement('img');
      el.className = 'mark sign';
      el.src = m.src;
      el.alt = 'Signature';
      el.draggable = false;
    }
    el.addEventListener('pointerdown', (e) => grab(e, m, el));
    els.set(m, el);
    layer.append(el);
    return el;
  }

  // Drag to move; a tap on text starts editing it.
  function grab(e, m, el) {
    if (tool === 'pen' || tool === 'highlight' || document.activeElement === el) return;
    e.preventDefault();
    e.stopPropagation();
    if (document.activeElement?.classList?.contains('mark')) document.activeElement.blur();
    select(m);
    el.setPointerCapture(e.pointerId);
    const r = rect(), start = point(e), origin = [m.x, m.y], before = JSON.stringify(page.marks);
    let moved = false;
    const move = (ev) => {
      const p = point(ev);
      if (!moved && Math.hypot((p[0] - start[0]) * r.width, (p[1] - start[1]) * r.height) < 5) return;
      if (!moved) { moved = true; history.push(before); }
      m.x = clamp01(origin[0] + p[0] - start[0]);
      m.y = clamp01(origin[1] + p[1] - start[1]);
      place(m, el);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (moved) commit();
      else if (m.type === 'text') edit(el);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  function edit(el) {
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // ---------- drawing and placing ----------

  layer.addEventListener('pointerdown', (e) => {
    if (!page || e.button > 0) return;
    const p = point(e);
    if (document.activeElement?.classList?.contains('mark')) document.activeElement.blur();
    if (tool === 'pen' || tool === 'highlight') {
      e.preventDefault();
      layer.setPointerCapture(e.pointerId);
      const hl = tool === 'highlight';
      stroke = { type: 'ink', highlight: hl, color: hl ? hlColor : penColor, size: SIZES[tool][size], points: [p] };
      select(null);
      draw();
    } else if (tool === 'text') {
      e.preventDefault();
      const m = { type: 'text', text: '', x: p[0], y: p[1], size: SIZES.text[size], color: penColor, turn: 0 };
      snapshot();
      fresh.add(m);
      page.marks.push(m);
      setTool('select');
      render();
      edit(elementFor(m));
    } else {
      const r = rect();
      const i = inkAt(page.marks, p[0] * r.width, p[1] * r.height, r.width, r.height);
      select(i >= 0 ? page.marks[i] : null);
    }
  });
  layer.addEventListener('pointermove', (e) => {
    if (!stroke) return;
    const r = rect();
    for (const ev of coalesced(e)) {
      const p = point(ev), last = stroke.points[stroke.points.length - 1];
      if (Math.hypot((p[0] - last[0]) * r.width, (p[1] - last[1]) * r.height) >= 1.5) stroke.points.push(p);
    }
    draw();
  });
  const endStroke = () => {
    if (!stroke) return;
    const s = stroke;
    stroke = null;
    snapshot();
    page.marks.push(s);
    commit();
  };
  layer.addEventListener('pointerup', endStroke);
  layer.addEventListener('pointercancel', endStroke);

  // ---------- toolbar ----------

  function select(m) {
    selected = m;
    for (const [mark, el] of els) el.classList.toggle('selected', mark === m);
    draw();
    sync();
  }

  function setTool(t) {
    tool = t;
    layer.dataset.tool = t;
    sync();
  }

  function sync() {
    for (const b of ui.tools) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
    const hl = selected ? selected.highlight : tool === 'highlight';
    const palette = hl ? HIGHLIGHT : PEN;
    const current = selected?.color || (hl ? hlColor : penColor);
    // Rebuild only when the palette changes: a rebuild mid-click would swallow the click.
    if (ui.colors.dataset.palette !== String(hl)) {
      ui.colors.dataset.palette = String(hl);
      ui.colors.replaceChildren(...palette.map((c, i) => {
        const b = document.createElement('button');
        b.className = 'swatch';
        b.dataset.c = c;
        b.style.setProperty('--c', c);
        b.setAttribute('aria-label', `${hl ? 'Highlighter' : 'Ink'} colour ${i + 1}`);
        b.addEventListener('click', () => setColor(c, hl));
        return b;
      }));
    }
    for (const b of ui.colors.children) {
      b.setAttribute('aria-pressed', String(b.dataset.c === current));
      b.disabled = selected?.type === 'sign';
    }
    const active = selected
      ? Object.entries(SIZES[kindOf(selected)]).reduce((a, b) => (Math.abs(b[1] - selected.size) < Math.abs(a[1] - selected.size) ? b : a))[0]
      : size;
    for (const b of ui.sizes) b.setAttribute('aria-selected', String(b.dataset.size === active));
    ui.del.disabled = !selected;
    ui.undo.disabled = !history.length;
  }

  function setColor(c, hl) {
    if (hl) hlColor = c; else penColor = c;
    if (selected && selected.type !== 'sign') {
      snapshot();
      selected.color = c;
      commit();
    } else sync();
  }

  for (const b of ui.tools) b.addEventListener('click', () => { setTool(b.dataset.tool); select(null); });
  for (const b of ui.sizes) b.addEventListener('click', () => {
    size = b.dataset.size;
    if (selected) {
      snapshot();
      selected.size = SIZES[kindOf(selected)][size];
      commit();
    } else sync();
  });
  ui.undo.addEventListener('click', () => {
    if (!history.length) return;
    page.marks = JSON.parse(history.pop());
    for (const el of els.values()) el.remove();
    els.clear();
    selected = null;
    commit();
  });
  ui.del.addEventListener('click', removeSelected);
  ui.date.addEventListener('click', () => add({
    type: 'text', text: new Date().toLocaleDateString(), x: 0.5, y: 0.5, size: SIZES.text[size], color: penColor, turn: 0,
  }));
  ui.sign.addEventListener('click', async () => {
    const src = await requestSignature(penColor === PEN[1] ? PEN[1] : PEN[0]);
    if (src && page) add({ type: 'sign', src, x: 0.7, y: 0.84, size: SIZES.sign[size], turn: 0 });
  });
  addEventListener('keydown', (e) => {
    if (!page || layer.hidden || !selected || document.activeElement?.isContentEditable) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSelected(); }
  });

  function removeSelected() {
    if (!selected) return;
    snapshot();
    page.marks.splice(page.marks.indexOf(selected), 1);
    selected = null;
    commit();
  }

  return {
    open(p) {
      page = p;
      page.marks ||= [];
      history = [];
      changed = false;
      selected = null;
      layer.hidden = false;
      setTool('select');
      render();
    },
    // Returns whether the marks changed while open.
    close() {
      if (!page) return false;
      if (document.activeElement?.classList?.contains('mark')) document.activeElement.blur();
      for (const el of els.values()) el.remove();
      els.clear();
      layer.hidden = true;
      stroke = null;
      page = null;
      return changed;
    },
    layout() { if (page) render(); },
  };
}

// Signature pad. ask(color) resolves to a trimmed PNG data URL, or null.
export function createSigner(ui) {
  const KEY = 'flatbed.signature';
  const ctx = ui.pad.getContext('2d');
  let resolve = null, last = null, color = PEN[0];

  const stored = () => { try { return localStorage.getItem(KEY); } catch { return null; } };

  function reset() {
    const r = ui.pad.getBoundingClientRect(), d = devicePixelRatio || 1;
    ui.pad.width = Math.round(r.width * d);
    ui.pad.height = Math.round(r.height * d);
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.lineWidth = 2.8;
    ctx.strokeStyle = color;
    ui.use.disabled = true;
  }

  function at(e) {
    const r = ui.pad.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  ui.pad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    ui.pad.setPointerCapture(e.pointerId);
    last = at(e);
    ctx.beginPath();
    ctx.arc(last[0], last[1], 1.4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ui.use.disabled = false;
  });
  ui.pad.addEventListener('pointermove', (e) => {
    if (!last) return;
    for (const ev of coalesced(e)) {
      const p = at(ev);
      ctx.beginPath();
      ctx.moveTo(last[0], last[1]);
      ctx.lineTo(p[0], p[1]);
      ctx.stroke();
      last = p;
    }
  });
  const lift = () => { last = null; };
  ui.pad.addEventListener('pointerup', lift);
  ui.pad.addEventListener('pointercancel', lift);

  // Crops to the ink so the signature can be placed and sized cleanly.
  function trimmed() {
    const { width: w, height: h } = ui.pad;
    const data = ctx.getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return null;
    const pad = 6;
    const c = document.createElement('canvas');
    c.width = x1 - x0 + 1 + pad * 2;
    c.height = y1 - y0 + 1 + pad * 2;
    c.getContext('2d').drawImage(ui.pad, x0 - pad, y0 - pad, c.width, c.height, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  }

  function finish(value) {
    if (ui.dialog.open) ui.dialog.close();
    const r = resolve;
    resolve = null;
    r?.(value);
  }

  ui.clear.addEventListener('click', reset);
  ui.close.addEventListener('click', () => finish(null));
  ui.dialog.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); });
  ui.use.addEventListener('click', () => {
    const src = trimmed();
    if (!src) return;
    if (ui.remember.checked) { try { localStorage.setItem(KEY, src); } catch { /* storage unavailable */ } }
    finish(src);
  });
  ui.savedUse.addEventListener('click', () => finish(stored()));
  ui.savedForget.addEventListener('click', () => {
    try { localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
    ui.saved.hidden = true;
  });

  return {
    ask(c) {
      color = c;
      const saved = stored();
      ui.saved.hidden = !saved;
      if (saved) ui.savedImg.src = saved;
      ui.remember.checked = false;
      ui.dialog.showModal();
      requestAnimationFrame(reset);
      return new Promise((r) => { resolve = r; });
    },
  };
}

// In-between pointer positions for smooth lines; some browsers return none.
function coalesced(e) {
  const list = e.getCoalescedEvents?.();
  return list?.length ? list : [e];
}
