import { buildPdf } from './pdf.js';
import { isConvex } from './scan.js';
import { isPdf, openPdf, renderPage, buildMixedPdf } from './pdfdoc.js';
import { drawMarks, rotateMarks, rotateCanvas } from './marks.js';
import { createMarkup, createSigner } from './markup.js';

const $ = (s) => document.querySelector(s);

const SRC_MAX = 2400;      // longest side kept from the camera photo
const OUT_MAX = 2200;      // longest side of the flattened page
const DETECT_MAX = 360;    // detection runs on a small copy
const QUALITY = {
  small: { max: 1240, q: 0.6, ratio: 0.22 },
  balanced: { max: 1700, q: 0.78, ratio: 0.5 },
  high: { max: OUT_MAX, q: 0.9, ratio: 1 },
};
const LOOKS = [['enhance', 'Enhance'], ['original', 'Original'], ['gray', 'Grayscale'], ['bw', 'B&W']];
const LOOK_NAME = Object.fromEntries(LOOKS);

const touch = matchMedia('(pointer: coarse)').matches;
document.documentElement.classList.toggle('touch', touch);

const pages = [];
let seq = 0;
let docName = defaultName();

// ---------- worker ----------

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const pending = new Map();
let rpcId = 0;
worker.onmessage = ({ data }) => {
  const job = pending.get(data.id);
  if (!job) return;
  pending.delete(data.id);
  data.error ? job.reject(new Error(data.error)) : job.resolve(data);
};
worker.onerror = (e) => {
  for (const job of pending.values()) job.reject(new Error(e.message || 'Worker failed'));
  pending.clear();
};
const call = (msg, transfer = []) => new Promise((resolve, reject) => {
  const id = ++rpcId;
  pending.set(id, { resolve, reject });
  worker.postMessage({ ...msg, id }, transfer);
});

// ---------- canvas helpers ----------

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function scaled(src, max) {
  const s = Math.min(1, max / Math.max(src.width, src.height));
  const c = canvas(Math.max(1, Math.round(src.width * s)), Math.max(1, Math.round(src.height * s)));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

function pixels(c) {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  return { data: d.data, width: d.width, height: d.height };
}

const jpeg = (c, q) => new Promise((resolve, reject) =>
  c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), 'image/jpeg', q));

const fullQuad = (w, h) => [[0, 0], [w, 0], [w, h], [0, h]];
const copyQuad = (q) => q.map((p) => [...p]);
const sameQuad = (a, b) => a.every((p, i) => p[0] === b[i][0] && p[1] === b[i][1]);

// ---------- pages ----------

const isImage = (f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif|avif|bmp|gif)$/i.test(f.name);

async function addFiles(fileList) {
  const all = [...fileList];
  const files = all.filter(isImage);
  const pdfs = all.filter(isPdf);
  if (!files.length && !pdfs.length) return toast('Choose photos or PDF files.');
  for (const file of pdfs) await addPdf(file);
  if (!files.length) return;
  const fresh = files.map((file) => ({ id: ++seq, kind: 'scan', file, filter: 'enhance', rotation: 0, marks: [], busy: true }));
  pages.push(...fresh);
  render();
  for (const page of fresh) {
    try {
      await ingest(page);
    } catch (err) {
      console.error(err);
      removePage(page, false);
      toast(/heic|heif/i.test(page.file.name) ? 'This browser can’t open HEIC photos. Try JPEG.' : `Couldn’t read ${page.file.name}.`);
    } finally {
      delete page.file;
    }
  }
}

// Each page of the PDF becomes a card. Pages stay vector until a look other
// than Original is chosen for them.
async function addPdf(file) {
  let src;
  try {
    src = await openPdf(file, (retry) => prompt(retry ? `Wrong password for ${file.name}. Try again:` : `${file.name} is password-protected. Password:`));
  } catch (err) {
    console.error(err);
    return toast(`Couldn’t open ${file.name}.`);
  }
  if (!src) return;
  if (!pages.length) docName = src.name || docName;
  const fresh = Array.from({ length: src.pageCount }, (_, index) =>
    ({ id: ++seq, kind: 'pdf', src, index, filter: 'original', rotation: 0, marks: [], busy: true }));
  pages.push(...fresh);
  render();
  for (const page of fresh) await drawPdfThumb(page);
}

// Thumbnail (and the editor's preview, if open) of a page kept as vector.
async function drawPdfThumb(page) {
  const token = (page.token || 0) + 1;
  page.token = token;
  page.busy = true;
  updateCard(page);
  page.job = (async () => {
    const c = await renderPage(page.src, page.index, 520, page.rotation);
    const blob = await jpeg(c, 0.82);
    if (token !== page.token || !pages.includes(page)) return;
    if (page.thumbUrl !== page.srcUrl) revoke(page.thumbUrl);
    page.thumbUrl = URL.createObjectURL(blob);
    page.thumbBlob = blob;
    revoke(page.viewUrl);
    page.viewUrl = null;
    page.busy = false;
    updateCard(page);
    composeThumb(page);
    if (ed && ed.page === page) refreshEditor();
  })().catch((err) => {
    if (token !== page.token) return;
    console.error(err);
    page.busy = false;
    updateCard(page);
    toast(`Couldn’t draw page ${page.index + 1} of the PDF.`);
  });
  return page.job;
}

// Larger render of a vector page for the editor.
async function ensureView(page) {
  if (page.viewUrl || page.viewing) return;
  page.viewing = true;
  try {
    const blob = await jpeg(await renderPage(page.src, page.index, 1600, page.rotation), 0.88);
    page.viewUrl = URL.createObjectURL(blob);
  } finally {
    page.viewing = false;
  }
  if (ed && ed.page === page) refreshEditor();
}

// Turns a PDF page into a photo-like source so the scan looks can apply.
// Rendered at the page's own rotation; extra turns are applied by process().
async function ensureRaster(page) {
  if (page.srcBlob) return;
  const c = await renderPage(page.src, page.index, OUT_MAX, 0);
  page.srcW = c.width;
  page.srcH = c.height;
  page.srcBlob = await jpeg(c, 0.92);
  page.srcUrl = URL.createObjectURL(page.srcBlob);
  page.quad = page.autoQuad = fullQuad(c.width, c.height);
}

const isVector = (page) => page.kind === 'pdf' && page.filter === 'original';

async function setLook(page, filter) {
  if (page.filter === filter) return;
  page.filter = filter;
  if (isVector(page)) return drawPdfThumb(page);
  if (page.kind === 'pdf' && !page.srcBlob) {
    page.busy = true;
    updateCard(page);
    try {
      await ensureRaster(page);
    } catch (err) {
      console.error(err);
      page.filter = 'original';
      return drawPdfThumb(page);
    }
    if (page.filter !== filter) return;
  }
  return process(page);
}

function rotatePage(page) {
  page.rotation = (page.rotation + 1) % 4;
  rotateMarks(page.marks);
  return isVector(page) ? drawPdfThumb(page) : process(page);
}

async function ingest(page) {
  const bmp = await createImageBitmap(page.file);
  const c = scaled(bmp, SRC_MAX);
  bmp.close();
  page.srcW = c.width;
  page.srcH = c.height;
  page.srcBlob = await jpeg(c, 0.92);
  page.srcUrl = URL.createObjectURL(page.srcBlob);
  page.thumbUrl = page.srcUrl;
  updateCard(page);

  const small = scaled(c, DETECT_MAX);
  const { quad } = await call({ type: 'detect', img: pixels(small) });
  const sx = c.width / small.width, sy = c.height / small.height;
  page.autoQuad = quad ? quad.map(([x, y]) => [x * sx, y * sy]) : fullQuad(c.width, c.height);
  page.detected = !!quad;
  page.quad = copyQuad(page.autoQuad);
  await process(page);
}

// Flattens and cleans the page in the worker. Later calls supersede earlier ones.
function process(page) {
  const token = (page.token || 0) + 1;
  page.token = token;
  page.busy = true;
  updateCard(page);
  page.job = (async () => {
    const bmp = await createImageBitmap(page.srcBlob);
    const c = canvas(bmp.width, bmp.height);
    c.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close();
    const img = pixels(c);
    const res = await call({
      type: 'render', img, quad: page.quad, filter: page.filter, rotation: page.rotation, maxSide: OUT_MAX,
    }, [img.data.buffer]);
    if (token !== page.token || !pages.includes(page)) return;

    const out = canvas(res.img.width, res.img.height);
    out.getContext('2d').putImageData(new ImageData(res.img.data, res.img.width, res.img.height), 0, 0);
    const [outBlob, thumbBlob] = await Promise.all([jpeg(out, 0.9), jpeg(scaled(out, 520), 0.82)]);
    if (token !== page.token || !pages.includes(page)) return;

    revoke(page.outUrl);
    if (page.thumbUrl !== page.srcUrl) revoke(page.thumbUrl);
    page.outBlob = outBlob;
    page.outUrl = URL.createObjectURL(outBlob);
    page.thumbUrl = URL.createObjectURL(thumbBlob);
    page.thumbBlob = thumbBlob;
    page.busy = false;
    updateCard(page);
    composeThumb(page);
    if (ed && ed.page === page) refreshEditor();
  })().catch((err) => {
    if (token !== page.token) return;
    console.error(err);
    page.busy = false;
    updateCard(page);
    toast('Couldn’t process that page.');
  });
  return page.job;
}

function removePage(page, undoable = true) {
  const i = pages.indexOf(page);
  if (i < 0) return;
  pages.splice(i, 1);
  render();
  if (!undoable) return releasePage(page);
  toast('Page deleted.', 'Undo', () => {
    clearTimeout(page.releaseTimer);
    pages.splice(Math.min(i, pages.length), 0, page);
    render();
  });
  page.releaseTimer = setTimeout(() => { if (!pages.includes(page)) releasePage(page); }, 8000);
}

function releasePage(page) {
  revoke(page.markThumbUrl);
  revoke(page.viewUrl);
  revoke(page.srcUrl);
  revoke(page.outUrl);
  revoke(page.thumbUrl);
}

function revoke(url) { if (url) URL.revokeObjectURL(url); }

function movePage(page, delta) {
  const i = pages.indexOf(page), j = i + delta;
  if (j < 0 || j >= pages.length) return;
  pages.splice(i, 1);
  pages.splice(j, 0, page);
  render();
}

// ---------- page grid ----------

const list = $('#pages');
const cards = new Map();

function render() {
  const has = pages.length > 0;
  $('#hero').hidden = has;
  $('#workspace').hidden = !has;
  $('#dock').hidden = !has;
  $('#docName').textContent = docName;
  $('#docMeta').textContent = `${pages.length} page${pages.length === 1 ? '' : 's'}`;

  for (const [id, li] of cards) if (!pages.some((p) => p.id === id)) { li.remove(); cards.delete(id); }
  pages.forEach((page, i) => {
    let li = cards.get(page.id);
    if (!li) { li = makeCard(page); cards.set(page.id, li); }
    if (list.children[i] !== li) list.insertBefore(li, list.children[i] || null);
    updateCard(page);
  });
  list.append(addTile);
}

function makeCard(page) {
  const li = document.createElement('li');
  li.className = 'page';
  li.draggable = !touch;
  li.innerHTML = `
    <button class="thumb"><img alt="" draggable="false"><div class="beam-wrap"><div class="beam"></div></div></button>
    <div class="page-meta"><b></b><span></span></div>`;
  li.querySelector('.thumb').addEventListener('click', () => { if (!page.busy || page.outBlob) openEditor(page); });

  li.addEventListener('dragstart', (e) => {
    dragged = page;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(page.id));
  });
  li.addEventListener('dragend', () => { dragged = null; li.classList.remove('dragging'); clearOver(); });
  li.addEventListener('dragover', (e) => {
    if (!dragged || dragged === page) return;
    e.preventDefault();
    clearOver();
    li.classList.add('over');
  });
  li.addEventListener('drop', (e) => {
    if (!dragged || dragged === page) return;
    e.preventDefault();
    e.stopPropagation();
    // The dragged page takes the target's slot.
    const to = pages.indexOf(page);
    pages.splice(pages.indexOf(dragged), 1);
    pages.splice(to, 0, dragged);
    clearOver();
    render();
  });
  return li;
}

let dragged = null;
const clearOver = () => list.querySelectorAll('.over').forEach((el) => el.classList.remove('over'));

function updateCard(page) {
  const li = cards.get(page.id);
  if (!li) return;
  const n = pages.indexOf(page) + 1;
  li.classList.toggle('busy', !!page.busy);
  const img = li.querySelector('img');
  const thumb = page.markThumbUrl || page.thumbUrl;
  if (thumb && img.getAttribute('src') !== thumb) img.src = thumb;
  li.querySelector('.thumb').setAttribute('aria-label', `Edit page ${n}`);
  li.querySelector('b').textContent = n;
  li.querySelector('span').textContent = page.busy ? (isVector(page) ? 'Loading…' : 'Scanning…')
    : isVector(page) ? 'PDF page' : LOOK_NAME[page.filter];
}

const addTile = document.createElement('li');
addTile.className = 'page add-tile';
addTile.innerHTML = `<button class="thumb"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>Add page</span></button>`;
addTile.querySelector('button').addEventListener('click', () => addPages());

// ---------- input ----------

const cameraInput = $('#cameraInput');
const fileInput = $('#fileInput');

function pick(camera) {
  (camera ? cameraInput : fileInput).click();
}
for (const input of [cameraInput, fileInput]) {
  input.addEventListener('change', () => {
    if (input.files.length) addFiles(input.files);
    input.value = '';
  });
}

// Phones choose between the camera and files; desktops go straight to files.
const adder = $('#adder');
function addPages() {
  if (!touch) return pick(false);
  adder.showModal();
}
$('#addCamera').addEventListener('click', () => { adder.close(); pick(true); });
$('#addDevice').addEventListener('click', () => { adder.close(); pick(false); });
$('#addCancel').addEventListener('click', () => adder.close());
adder.addEventListener('click', (e) => { if (e.target === adder) adder.close(); });

$('#scanBtn').addEventListener('click', () => pick(true));
$('#importBtn').addEventListener('click', () => pick(false));
$('#addBtn').addEventListener('click', () => addPages());
if (!touch) {
  $('#scanBtn').hidden = true;
  $('#importBtn').classList.add('primary');
  $('#importBtn span').textContent = 'Choose photos or PDF';
}

const drop = $('#drop');
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; drop.hidden = false; } });
addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; drop.hidden = true; } });
addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  drop.hidden = true;
  addFiles(e.dataTransfer.files);
});
addEventListener('paste', (e) => {
  if (e.target.closest?.('input')) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) addFiles(files);
});

addEventListener('beforeunload', (e) => {
  if (pages.length) e.preventDefault();
});

// ---------- editor ----------

const editor = $('#editor');
const stage = $('#stage');
const frame = $('#frame');
const edImg = $('#edImg');
const edSvg = $('#edSvg');
const handles = [...frame.querySelectorAll('.handle')];
const loupe = $('#loupe');
let ed = null; // { page, quad, tab }

const signer = createSigner({
  dialog: $('#signer'), pad: $('#sgPad'), clear: $('#sgClear'), close: $('#sgClose'), use: $('#sgUse'),
  remember: $('#sgRemember'), saved: $('#sgSaved'), savedImg: $('#sgSavedImg'), savedUse: $('#sgSavedUse'), savedForget: $('#sgForget'),
});
const markup = createMarkup({
  frame,
  ui: {
    tools: [...editor.querySelectorAll('.tool[data-tool]')],
    colors: $('#mkColors'),
    sizes: [...editor.querySelectorAll('[data-size]')],
    undo: $('#mkUndo'), del: $('#mkDelete'), sign: $('#mkSign'), date: $('#mkDate'),
  },
  requestSignature: (color) => signer.ask(color),
});

// Card thumbnail with the page's marks drawn on.
async function composeThumb(page) {
  let url = null;
  if (page.marks.length && page.thumbBlob) {
    const bmp = await createImageBitmap(page.thumbBlob);
    const c = canvas(bmp.width, bmp.height);
    c.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close();
    await drawMarks(c.getContext('2d'), page.marks, c.width, c.height);
    url = URL.createObjectURL(await jpeg(c, 0.82));
  }
  revoke(page.markThumbUrl);
  page.markThumbUrl = url;
  updateCard(page);
}

function openEditor(page) {
  const vectorSource = page.kind === 'pdf';
  ed = { page, quad: copyQuad(page.quad || [[0, 0], [1, 0], [1, 1], [0, 1]]), tab: page.detected === false ? 'crop' : 'look' };
  editor.querySelector('[data-tab="crop"]').hidden = vectorSource;
  $('#lookHint').hidden = !vectorSource;
  editor.showModal();
  buildChips();
  setTab(ed.tab);
}

function setTab(tab) {
  ed.tab = tab;
  for (const b of editor.querySelectorAll('[role="tab"]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const t of editor.querySelectorAll('.tools')) t.hidden = t.dataset.for !== tab;
  if (tab !== 'crop' && ed.page.quad && !sameQuad(ed.quad, ed.page.quad)) commitQuad();
  frame.classList.toggle('marking', tab === 'mark');
  if (tab === 'mark') markup.open(ed.page);
  else if (markup.close()) composeThumb(ed.page);
  refreshEditor();
}

function refreshEditor() {
  if (!ed) return;
  const { page } = ed;
  const n = pages.indexOf(page);
  $('#edTitle').textContent = `Page ${n + 1} of ${pages.length}`;
  $('#edLeft').disabled = n <= 0;
  $('#edRight').disabled = n >= pages.length - 1;
  frame.classList.toggle('look', ed.tab !== 'crop');
  frame.classList.toggle('busy', ed.tab !== 'crop' && !!page.busy);

  let url = ed.tab !== 'crop' && page.outUrl ? page.outUrl : page.srcUrl;
  if (isVector(page)) {
    url = page.viewUrl || page.thumbUrl;
    if (!page.viewUrl && !page.busy) ensureView(page).catch(console.error);
  }
  if (url && edImg.getAttribute('src') !== url) {
    edImg.src = url;
    edImg.decode().then(fit, fit);
  } else fit();
  for (const chip of $('#chips').children) chip.setAttribute('aria-checked', String(chip.dataset.f === page.filter));
  if (ed.tab === 'crop') drawQuad();
}

// Sizes the image to fit the stage, since percentage heights don't resolve there.
function fit() {
  if (!ed || !edImg.naturalWidth) return;
  const cs = getComputedStyle(stage);
  const aw = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const ah = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const s = Math.min(aw / edImg.naturalWidth, ah / edImg.naturalHeight);
  edImg.style.width = `${Math.floor(edImg.naturalWidth * s)}px`;
  edImg.style.height = `${Math.floor(edImg.naturalHeight * s)}px`;
  markup.layout();
}
new ResizeObserver(fit).observe(stage);

function drawQuad() {
  const { page, quad } = ed;
  const w = page.srcW, h = page.srcH;
  edSvg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const pts = quad.map(([x, y]) => `${x},${y}`).join(' ');
  edSvg.querySelector('.edge').setAttribute('points', pts);
  edSvg.querySelector('.shade').setAttribute('d', `M0 0H${w}V${h}H0Z M${quad.map(([x, y]) => `${x} ${y}`).join(' L')}Z`);
  handles.forEach((el, i) => {
    el.style.left = `${(quad[i][0] / w) * 100}%`;
    el.style.top = `${(quad[i][1] / h) * 100}%`;
  });
  frame.classList.toggle('invalid', !isConvex(quad));
}

handles.forEach((el, i) => {
  let grab = null;
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add('active');
    const r = edImg.getBoundingClientRect();
    const [qx, qy] = ed.quad[i];
    // Keep the offset between finger and corner so the corner doesn't jump.
    grab = { dx: (qx / ed.page.srcW) * r.width + r.left - e.clientX, dy: (qy / ed.page.srcH) * r.height + r.top - e.clientY };
    moveCorner(e);
  });
  el.addEventListener('pointermove', (e) => { if (grab) moveCorner(e); });
  const end = () => { grab = null; el.classList.remove('active'); loupe.hidden = true; };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 20 : 4;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    const r = edImg.getBoundingClientRect();
    const q = ed.quad[i];
    q[0] = clamp(q[0] + (d[0] * ed.page.srcW) / r.width, 0, ed.page.srcW);
    q[1] = clamp(q[1] + (d[1] * ed.page.srcH) / r.height, 0, ed.page.srcH);
    drawQuad();
  });

  function moveCorner(e) {
    const r = edImg.getBoundingClientRect();
    const px = clamp(e.clientX + grab.dx - r.left, 0, r.width);
    const py = clamp(e.clientY + grab.dy - r.top, 0, r.height);
    ed.quad[i] = [(px / r.width) * ed.page.srcW, (py / r.height) * ed.page.srcH];
    drawQuad();
    showLoupe(px, py, r);
  }
});

function showLoupe(px, py, r) {
  const Z = 2.6, S = 120;
  loupe.hidden = false;
  loupe.style.backgroundImage = `url("${ed.page.srcUrl}")`;
  loupe.style.backgroundSize = `${r.width * Z}px ${r.height * Z}px`;
  loupe.style.backgroundPosition = `${S / 2 - px * Z}px ${S / 2 - py * Z}px`;
  // Float above the finger, or below it near the top edge.
  const above = py - S - 40 > -r.top + 60;
  loupe.style.left = `${clamp(px - S / 2, -20, r.width - S + 20)}px`;
  loupe.style.top = `${above ? py - S - 40 : py + 40}px`;
}

function commitQuad() {
  if (!isConvex(ed.quad)) {
    ed.quad = copyQuad(ed.page.quad);
    toast('Those corners cross, so they were reset.');
    return;
  }
  ed.page.quad = copyQuad(ed.quad);
  process(ed.page);
}

function closeEditor() {
  if (!ed) return;
  if (ed.tab === 'crop' && ed.page.quad && !sameQuad(ed.quad, ed.page.quad)) {
    if (!isConvex(ed.quad)) return toast('Fix the crossed corners first.');
    commitQuad();
  }
  if (markup.close()) composeThumb(ed.page);
  frame.classList.remove('marking');
  ed = null;
  loupe.hidden = true;
  editor.close();
}

function buildChips() {
  const chips = $('#chips');
  if (chips.children.length) return;
  for (const [f, label] of LOOKS) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.f = f;
    b.setAttribute('role', 'radio');
    b.innerHTML = `<i></i><span>${label}</span>`;
    b.addEventListener('click', () => {
      setLook(ed.page, f);
      refreshEditor();
    });
    chips.append(b);
  }
}

for (const b of editor.querySelectorAll('[role="tab"]')) b.addEventListener('click', () => setTab(b.dataset.tab));
$('#edDone').addEventListener('click', closeEditor);
editor.addEventListener('cancel', (e) => { e.preventDefault(); closeEditor(); });
$('#edAuto').addEventListener('click', () => {
  ed.quad = copyQuad(ed.page.autoQuad);
  drawQuad();
  if (!ed.page.detected) toast('No clear page edges found. Drag the corners.');
});
$('#edFull').addEventListener('click', () => { ed.quad = fullQuad(ed.page.srcW, ed.page.srcH); drawQuad(); });
$('#edRotate').addEventListener('click', () => {
  rotatePage(ed.page);
  refreshEditor();
});
$('#edLeft').addEventListener('click', () => { movePage(ed.page, -1); refreshEditor(); });
$('#edRight').addEventListener('click', () => { movePage(ed.page, 1); refreshEditor(); });
$('#edDelete').addEventListener('click', () => {
  const page = ed.page;
  markup.close();
  frame.classList.remove('marking');
  ed = null;
  editor.close();
  removePage(page);
});

// ---------- export ----------

const exporter = $('#exporter');
const exName = $('#exName');
const exDownload = $('#exDownload');
const exShare = $('#exShare');
const choice = (name) => exporter.querySelector(`input[name="${name}"]:checked`).value;

$('#exportBtn').addEventListener('click', () => {
  exName.value = docName;
  exShare.hidden = !canShareFiles();
  updateEstimate();
  exporter.showModal();
});
$('#exClose').addEventListener('click', () => exporter.close());
exporter.addEventListener('change', updateEstimate);
exName.addEventListener('input', () => {
  docName = exName.value.trim() || defaultName();
  $('#docName').textContent = docName;
});
exName.addEventListener('keydown', (e) => { if (e.key === 'Enter') exName.blur(); });
exDownload.addEventListener('click', () => makePdf(false));
exShare.addEventListener('click', () => makePdf(true));

function updateEstimate() {
  const busy = pages.some((p) => p.busy);
  const scanned = pages.reduce((s, p) => s + (isVector(p) ? 0 : p.outBlob?.size || 0), 0) * QUALITY[choice('quality')].ratio;
  const kept = pages.reduce((s, p) => s + (isVector(p) ? p.src.bytes.length / p.src.pageCount : 0), 0);
  $('#exEstimate').textContent = busy
    ? 'Finishing the last pages…'
    : `${pages.length} page${pages.length === 1 ? '' : 's'} · about ${formatBytes(scanned + kept)}` +
      (kept ? ' · PDF pages keep their own size' : '');
}

async function makePdf(share) {
  const buttons = [exDownload, exShare];
  buttons.forEach((b) => (b.disabled = true));
  const label = exDownload.querySelector('span');
  try {
    await Promise.all(pages.map((p) => p.job));
    const ready = pages.filter((p) => p.outBlob || isVector(p));
    if (!ready.length) return toast('No pages are ready yet.');
    const { max, q } = QUALITY[choice('quality')];
    const items = [];
    for (const [i, page] of ready.entries()) {
      label.textContent = `Building ${i + 1}/${ready.length}…`;
      if (isVector(page)) {
        const fallback = async () => {
          const c = await renderPage(page.src, page.index, max, page.rotation);
          await drawMarks(c.getContext('2d'), page.marks, c.width, c.height);
          return bytes(await jpeg(c, q));
        };
        const overlay = page.marks.length ? (angle, w, h) => overlayPng(page, angle, w, h) : null;
        items.push({ pdf: { src: page.src, index: page.index, turns: page.rotation, fallback, overlay } });
        continue;
      }
      let blob = page.outBlob;
      if (q < QUALITY.high.q || page.marks.length) {
        const bmp = await createImageBitmap(blob);
        const c = scaled(bmp, max);
        bmp.close();
        await drawMarks(c.getContext('2d'), page.marks, c.width, c.height);
        blob = await jpeg(c, q);
      }
      items.push({ jpeg: await bytes(blob) });
    }
    const opts = { size: choice('size'), title: docName };
    // The bundled writer covers pure scans; pdf-lib loads only when PDF pages are kept.
    const data = items.some((i) => i.pdf) ? [await buildMixedPdf(items, opts)] : buildPdf(items, opts);
    const pdf = new Blob(data, { type: 'application/pdf' });
    const filename = `${docName.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 120) || 'Scan'}.pdf`;

    if (share) {
      try {
        await navigator.share({ files: [new File([pdf], filename, { type: 'application/pdf' })], title: docName });
      } catch (err) {
        if (err.name !== 'AbortError') throw err;
        return;
      }
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(pdf);
      a.download = filename;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    }
    exporter.close();
    toast(`${filename} · ${formatBytes(pdf.size)}`);
  } catch (err) {
    console.error(err);
    toast('Couldn’t build the PDF.');
  } finally {
    label.textContent = 'Download PDF';
    buttons.forEach((b) => (b.disabled = false));
  }
}

const bytes = async (blob) => new Uint8Array(await blob.arrayBuffer());

// Marks for a page kept as vector, as a transparent PNG laid over it. pdf-lib
// draws in the page's unrotated space, so the drawing is turned back by `angle`.
async function overlayPng(page, angle, w, h) {
  const [dw, dh] = angle % 180 ? [h, w] : [w, h];
  const s = 2400 / Math.max(dw, dh);
  const c = canvas(Math.round(dw * s), Math.round(dh * s));
  await drawMarks(c.getContext('2d'), page.marks, c.width, c.height);
  const upright = rotateCanvas(c, (4 - angle / 90) % 4);
  const blob = await new Promise((resolve) => upright.toBlob(resolve, 'image/png'));
  return bytes(blob);
}

function canShareFiles() {
  try {
    return !!navigator.canShare?.({ files: [new File([new Uint8Array(1)], 'x.pdf', { type: 'application/pdf' })] });
  } catch { return false; }
}

// ---------- chrome ----------

const toasts = $('#toasts');
function toast(text, action, onAction) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action;
    b.addEventListener('click', () => { onAction(); el.remove(); });
    el.append(b);
  }
  toasts.append(el);
  setTimeout(() => el.remove(), action ? 7000 : 3600);
}

const status = $('#status');
function setStatus() {
  const ready = !!navigator.serviceWorker?.controller;
  status.classList.toggle('ready', ready || !navigator.onLine);
  status.querySelector('span').textContent = !navigator.onLine ? 'Offline · still working' : ready ? 'Works offline' : 'Private';
  status.title = 'Your pages are processed on this device and never uploaded.';
}
addEventListener('online', setStatus);
addEventListener('offline', setStatus);
setStatus();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', setStatus);
  navigator.serviceWorker.ready.then(setStatus);
}

let installEvent = null;
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  $('#installBtn').hidden = false;
});
$('#installBtn').addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null;
  $('#installBtn').hidden = true;
});

function defaultName() {
  const d = new Date();
  const month = d.toLocaleString('en', { month: 'short' });
  return `Scan ${d.getDate()} ${month} ${d.getFullYear()}`;
}

function formatBytes(n) {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

render();
