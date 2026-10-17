// Opening and re-saving existing PDFs. pdf.js draws the pages, pdf-lib copies
// them into the new file. Both are bundled in vendor/ and load on first use,
// so scanning alone never downloads them.

import { placement } from './pdf.js';

const here = (path) => new URL(path, import.meta.url).href;

let pdfjsLoad, pdflibLoad;
const pdfjs = () => (pdfjsLoad ||= import('./vendor/pdfjs/pdf.min.js').then((lib) => {
  lib.GlobalWorkerOptions.workerSrc = here('./vendor/pdfjs/pdf.worker.min.js');
  return lib;
}));
const pdflib = () => (pdflibLoad ||= import('./vendor/pdf-lib/pdf-lib.esm.min.js'));

export const isPdf = (file) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);

// askPassword(retry) returns the password, or null to give up.
export async function openPdf(file, askPassword) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const lib = await pdfjs();
  const task = lib.getDocument({
    data: bytes.slice(), // pdf.js hands this buffer to its worker
    isEvalSupported: false,
    cMapUrl: here('./vendor/pdfjs/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: here('./vendor/pdfjs/standard_fonts/'),
  });
  let cancelled = false;
  task.onPassword = (update, reason) => {
    const pw = askPassword(reason === lib.PasswordResponses.INCORRECT_PASSWORD);
    if (pw == null) { cancelled = true; task.destroy(); } else update(pw);
  };
  try {
    const doc = await task.promise;
    return { bytes, doc, pageCount: doc.numPages, name: file.name.replace(/\.pdf$/i, '') };
  } catch (err) {
    if (cancelled) return null;
    throw err;
  }
}

// Draws one page onto a white canvas, its longest side at most maxSide px.
// `turns` adds quarter turns on top of the page's own rotation.
export async function renderPage(src, index, maxSide, turns = 0) {
  const page = await src.doc.getPage(index + 1);
  const rotation = (page.rotate + turns * 90) % 360;
  const base = page.getViewport({ scale: 1, rotation });
  const scale = Math.min(maxSide / Math.max(base.width, base.height), 6);
  const viewport = page.getViewport({ scale, rotation });
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(viewport.width));
  c.height = Math.max(1, Math.round(viewport.height));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  page.cleanup();
  return c;
}

// items: { pdf: { src, index, turns, fallback } } keeps a page from an opened
// PDF as it is (text stays selectable); { jpeg } adds an image page.
// fallback() supplies JPEG bytes when the source can't be copied (encrypted).
export async function buildMixedPdf(items, { size = 'a4', title = 'Scan' } = {}) {
  const { PDFDocument, BlendMode, degrees } = await pdflib();
  const out = await PDFDocument.create();

  // Copy each source's pages in one call so shared fonts are copied once.
  const copied = new Map();
  for (const src of new Set(items.filter((i) => i.pdf).map((i) => i.pdf.src))) {
    let doc = null;
    try { doc = await PDFDocument.load(src.bytes, { updateMetadata: false }); } catch { /* encrypted or damaged */ }
    if (!doc) continue;
    const indices = items.filter((i) => i.pdf?.src === src).map((i) => i.pdf.index);
    const pages = await out.copyPages(doc, indices);
    indices.forEach((n, k) => copied.set(key(src, n), pages[k]));
  }

  for (const item of items) {
    if (item.pdf) {
      const page = copied.get(key(item.pdf.src, item.pdf.index));
      if (page) {
        page.setRotation(degrees((page.getRotation().angle + item.pdf.turns * 90) % 360));
        out.addPage(page);
        if (item.pdf.overlay) {
          // Marks go on top as one image; multiply keeps highlighter see-through.
          const box = page.getCropBox();
          const angle = ((page.getRotation().angle % 360) + 360) % 360;
          const img = await out.embedPng(await item.pdf.overlay(angle, box.width, box.height));
          page.drawImage(img, { x: box.x, y: box.y, width: box.width, height: box.height, blendMode: BlendMode.Multiply });
        }
        continue;
      }
      item.jpeg = await item.pdf.fallback();
    }
    const img = await out.embedJpg(item.jpeg);
    const [pw, ph, x, y, w, h] = placement(img.width, img.height, size);
    out.addPage([pw, ph]).drawImage(img, { x, y, width: w, height: h });
  }

  out.setTitle(title);
  out.setProducer('Flatbed');
  out.setCreator('Flatbed');
  return out.save();
}

const ids = new WeakMap();
let nextId = 0;
function key(src, index) {
  if (!ids.has(src)) ids.set(src, ++nextId);
  return `${ids.get(src)}:${index}`;
}
