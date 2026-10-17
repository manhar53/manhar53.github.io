// Minimal PDF writer: one JPEG per page, embedded as-is (DCTDecode).
// No dependencies, no re-compression.

export const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] };

const enc = new TextEncoder();

// pages: [{ jpeg: Uint8Array }]; size: 'a4' | 'letter' | 'fit'
export function buildPdf(pages, { size = 'a4', title = 'Scan', date = new Date() } = {}) {
  const chunks = [];
  const offsets = [];
  let offset = 0;
  const push = (x) => {
    const b = typeof x === 'string' ? enc.encode(x) : x;
    chunks.push(b);
    offset += b.length;
  };
  const obj = (n, ...parts) => {
    offsets[n] = offset;
    push(`${n} 0 obj\n`);
    parts.forEach(push);
    push('\nendobj\n');
  };

  // The binary comment marks the file as binary for transfer tools.
  push('%PDF-1.4\n%âãÏÓ\n');

  const kids = pages.map((_, i) => `${4 + i * 3} 0 R`).join(' ');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  obj(3, `<< /Title ${pdfText(title)} /Producer ${pdfText('Flatbed')} /CreationDate (${pdfDate(date)}) >>`);

  pages.forEach((page, i) => {
    const info = jpegInfo(page.jpeg);
    const [pw, ph, x, y, w, h] = placement(info.width, info.height, size);
    const n = 4 + i * 3;
    obj(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(pw)} ${f(ph)}] ` +
      `/Resources << /XObject << /Im0 ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`);
    const content = `q ${f(w)} 0 0 ${f(h)} ${f(x)} ${f(y)} cm /Im0 Do Q`;
    obj(n + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    obj(n + 2,
      `<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} ` +
      `/ColorSpace /${info.components === 1 ? 'DeviceGray' : info.components === 4 ? 'DeviceCMYK' : 'DeviceRGB'} ` +
      `/BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`,
      page.jpeg,
      '\nendstream');
  });

  const count = 4 + pages.length * 3;
  const xrefAt = offset;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  return chunks;
}

// Fits the image inside the page, turning the page landscape for landscape scans.
export function placement(iw, ih, size) {
  if (size === 'fit') {
    const pw = 595.28, ph = (pw * ih) / iw;
    return [pw, ph, 0, 0, pw, ph];
  }
  let [pw, ph] = PAGE_SIZES[size] || PAGE_SIZES.a4;
  if (iw > ih) [pw, ph] = [ph, pw];
  const s = Math.min(pw / iw, ph / ih);
  const w = iw * s, h = ih * s;
  return [pw, ph, (pw - w) / 2, (ph - h) / 2, w, h];
}

// Reads size and channel count from the JPEG's start-of-frame marker.
export function jpegInfo(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error('Not a JPEG');
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { i += m === 0xff ? 1 : 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8], components: b[i + 9] };
    }
    i += 2 + len;
  }
  throw new Error('JPEG has no frame header');
}

const f = (n) => (Math.round(n * 100) / 100).toString();

// UTF-16BE hex string, so any title survives.
function pdfText(s) {
  let hex = 'FEFF';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp > 0xffff) {
      const v = cp - 0x10000;
      hex += (0xd800 + (v >> 10)).toString(16).padStart(4, '0') + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0');
    } else hex += cp.toString(16).padStart(4, '0');
  }
  return `<${hex.toUpperCase()}>`;
}

function pdfDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
