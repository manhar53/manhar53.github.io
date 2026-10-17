# Flatbed

Offline PDF scanner that runs entirely in the browser. Photograph or import pages;
Flatbed finds the page, flattens the perspective, whitens the paper and builds a PDF —
all on the device. Existing PDFs can be opened too: reorder, rotate, delete, merge,
add scanned pages, or give a page a scan look. Any page can be marked up with text,
pen, highlighter, a drawn signature (optionally remembered in `localStorage`) and
the date.

- **0 permissions** — on phones the camera opens through a file input
  (`capture="environment"`), so the browser never asks for camera access.
- **0 network** — CSP `connect-src 'self'` (pdf.js loads its bundled fonts from the
  app itself); nothing goes to any other origin and there is no server code. Pages
  live in memory and are gone when the tab closes.
- **Offline** — `sw.js` caches the app on first visit; installable as a PWA.
- **No build step** — plain ES modules. Image processing is in `scan.js` (runs in
  `worker.js`); scans-only PDFs are written by `pdf.js` (own tiny writer).
- **PDF editing** — `pdfdoc.js` uses vendored [pdf.js](https://github.com/mozilla/pdf.js)
  4.10.38 (legacy build, Apache-2.0) to draw pages and [pdf-lib](https://github.com/Hopding/pdf-lib)
  1.17.1 (MIT) to copy them. Both load only when a PDF is opened or kept. Untouched PDF
  pages are copied as-is, so text stays selectable; encrypted PDFs fall back to images.

## Run

```sh
python -m http.server 5173     # or: npm run serve
npm test                       # node --test, no installs needed
```

Service workers need `https` or `localhost`.

## Deploy

Any static host works. For GitHub Pages, copy the folder (minus `tests/`) into the
Pages repo, e.g. `manhar53.github.io/flatbed/`. **Bump `VERSION` in `sw.js` on every
release**, or returning visitors keep the cached copy.

## How it works

| Step | Where | Method |
| --- | --- | --- |
| Detect page | `detectQuad` | Otsu threshold on a 360px copy → largest bright blob → diagonal extremes as corners |
| Flatten | `warp` + `trueAspect` | Homography with bilinear sampling; real aspect ratio from camera geometry (Zhang & He 2004) |
| Clean | `applyFilter` | Per-block paper brightness, dilated and smoothed, divided out; one global white balance |
| PDF | `buildPdf` | JPEGs embedded byte-for-byte (`DCTDecode`), A4/Letter/fit, landscape-aware |
| Mark up | `marks.js`, `markup.js` | Marks stored as fractions of the displayed page; one renderer for editor, thumbnails and export. Scans: burned into the JPEG. Kept PDF pages: a transparent PNG overlay (multiply blend), turned back into the page's unrotated space, so the original text stays selectable |
| Edit PDF | `pdfdoc.js` | pdf.js thumbnails; pdf-lib `copyPages` + `setRotation`; other looks rasterise the page into the scan pipeline |
