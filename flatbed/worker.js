import { detectQuad, warp, applyFilter, rotate } from './scan.js';

self.onmessage = ({ data: msg }) => {
  try {
    if (msg.type === 'detect') {
      self.postMessage({ id: msg.id, quad: detectQuad(msg.img) });
    } else if (msg.type === 'render') {
      let img = warp(msg.img, msg.quad, msg.maxSide);
      img = applyFilter(img, msg.filter);
      img = rotate(img, msg.rotation);
      self.postMessage({ id: msg.id, img }, [img.data.buffer]);
    }
  } catch (err) {
    self.postMessage({ id: msg.id, error: String(err && err.message || err) });
  }
};
