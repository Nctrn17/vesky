// Détection des visages avec deux modèles libres, exécutés dans le navigateur par ONNX Runtime : YuNet pour les petits
// visages, sur l'image entière, et CenterFace pour les autres, sur l'image réduite (voir judge dans app.js).
// Tous les fichiers sont servis par le site lui-même : aucune requête vers l'extérieur.
import * as ort from './vendor/ort/ort.wasm.min.mjs';

const STRIDES = [8, 16, 32];
const NMS_IOU = 0.3;
// Nuit : en dessous de cette luminosité moyenne (sur 255), chaque valeur v devient 255 * racine(v / 255).
const DARK = 40;
const NIGHT_LUT = Float32Array.from({ length: 256 }, (_, v) => Math.floor(Math.sqrt(v / 255) * 255));

function overlap(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

// CenterFace (le modèle de deface, https://github.com/ORB-HD/deface) regarde l'image ramenée à CENTER_SIDE pixels de plus
// grand côté : à cette taille il ne voit pas les visages minuscules, mais une passe coûte moitié moins que celle de YuNet
// sur l'image entière. Ses cadres sont marqués { cf: true } et gardés à partir de CENTER_KEEP ; ceux de YuNet sur une
// image très sombre sont marqués { dk: true }. Le partage entre les deux se fait dans judge (app.js).
// `small` : passer aussi YuNet sur cette image (app.js ne le demande pas à chaque image d'une vidéo, voir YUNET_EVERY).
export const CENTER_SIDE = 640, CENTER_KEEP = 0.1;
// À augmenter quand ce que renvoie detectBoth change : app.js refuse une autre version que la sienne (voir DETECTOR là-bas).
export const DETECTOR = 2;
export async function detectBoth(detect, source, sw, sh, maxSide, minScore, small) {
  const center = (await detect.center(source, sw, sh, CENTER_SIDE, CENTER_KEEP)).map((b) => ({ ...b, cf: true }));
  if (!small) return center;
  const boxes = await detect(source, sw, sh, maxSide, minScore);
  return center.concat(boxes.map((b) => (boxes.dark ? { ...b, dk: true } : b)));
}

export async function createDetector(base) {
  ort.env.wasm.wasmPaths = base + 'vendor/ort/';
  ort.env.wasm.numThreads = 1;
  const session = await ort.InferenceSession.create(base + 'models/yunet.onnx', { executionProviders: ['wasm'] });
  const centerSession = await ort.InferenceSession.create(base + 'models/centerface.onnx', { executionProviders: ['wasm'] });

  // Une toile et un tampon par taille d'image : les deux passes alternent deux tailles, et tout recréer à chaque image
  // (plusieurs dizaines de Mo) coûtait presque autant que la détection elle-même. On ne garde que les deux
  // dernières tailles servies : d'un fichier à l'autre, les anciennes partent, sinon la mémoire ne fait que grossir.
  const sizes = new Map();
  const space = (pw, ph) => {
    const key = pw + 'x' + ph;
    let sp = sizes.get(key);
    if (sp) sizes.delete(key);
    else {
      const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(pw, ph) : Object.assign(document.createElement('canvas'), { width: pw, height: ph });
      sp = { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }), buffer: new Float32Array(3 * pw * ph) };
    }
    sizes.set(key, sp);
    for (const [k, old] of sizes) {
      if (sizes.size <= 2) break;
      old.canvas.width = old.canvas.height = 0;   // rend tout de suite la mémoire de la toile
      sizes.delete(k);
    }
    return sp;
  };

  const dedupe = (found) => {
    found.sort((a, b) => b.s - a.s);
    const kept = [];
    for (const b of found) if (!kept.some((k) => overlap(k, b) > NMS_IOU)) kept.push(b);
    return kept;
  };

  // CenterFace sur l'image étirée à des dimensions multiples de 32, en rouge, vert, bleu de 0 à 255. Le décodage des
  // sorties (carte de chaleur, taille, décalage, pas de 4) suit deface/centerface.py. Image très sombre : deux passes,
  // telle quelle et éclaircie, comme pour YuNet.
  async function center(source, sw, sh, maxSide, minScore) {
    const scale = Math.min(1, maxSide / Math.max(sw, sh));
    const pw = Math.ceil(Math.max(1, Math.round(sw * scale)) / 32) * 32, ph = Math.ceil(Math.max(1, Math.round(sh * scale)) / 32) * 32;
    const { ctx, buffer } = space(pw, ph);
    ctx.drawImage(source, 0, 0, pw, ph);
    const rgba = ctx.getImageData(0, 0, pw, ph).data;
    const n = pw * ph, cols = pw / 4, rows = ph / 4, cells = cols * rows;
    const kx = sw / pw, ky = sh / ph;
    let sum = 0;
    for (let p = 0; p < 4 * n; p += 4) sum += rgba[p] + rgba[p + 1] + rgba[p + 2];
    const found = [];
    for (const lut of sum / (3 * n) < DARK ? [null, NIGHT_LUT] : [null]) {
      for (let i = 0, p = 0; i < n; i++, p += 4) {
        buffer[i] = lut ? lut[rgba[p]] : rgba[p];
        buffer[n + i] = lut ? lut[rgba[p + 1]] : rgba[p + 1];
        buffer[2 * n + i] = lut ? lut[rgba[p + 2]] : rgba[p + 2];
      }
      const out = await centerSession.run({ 'input.1': new ort.Tensor('float32', buffer, [1, 3, ph, pw]) }, ['537', '538', '539']);
      const heat = out['537'].data, size = out['538'].data, shift = out['539'].data;
      for (let i = 0; i < cells; i++) {
        if (heat[i] <= minScore) continue;
        const h = Math.exp(size[i]) * 4, w = Math.exp(size[cells + i]) * 4;
        const x = Math.min(Math.max(0, ((i % cols) + shift[cells + i] + 0.5) * 4 - w / 2), pw);
        const y = Math.min(Math.max(0, (Math.floor(i / cols) + shift[i] + 0.5) * 4 - h / 2), ph);
        const bw = Math.min(x + w, pw) - x, bh = Math.min(y + h, ph) - y;
        if (bw > 0 && bh > 0) found.push({ x: x * kx, y: y * ky, w: bw * kx, h: bh * ky, s: heat[i] });
      }
    }
    return dedupe(found);
  }

  // source : image de sw x sh pixels. Renvoie les visages [{x, y, w, h, s}] en pixels de la source, et dit dans
  // .dark si l'image est très sombre.
  async function detect(source, sw, sh, maxSide, minScore) {
    const scale = Math.min(1, maxSide / Math.max(sw, sh));
    const dw = Math.max(1, Math.round(sw * scale)), dh = Math.max(1, Math.round(sh * scale));
    // Le modèle veut des dimensions multiples de 32 : on complète avec du noir.
    const pw = Math.ceil(dw / 32) * 32, ph = Math.ceil(dh / 32) * 32;
    const { ctx, buffer } = space(pw, ph);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, pw, ph);
    ctx.drawImage(source, 0, 0, dw, dh);
    const rgba = ctx.getImageData(0, 0, pw, ph).data;
    const n = pw * ph;
    // Image très sombre (luminosité moyenne sous DARK) : le modèle voit mal dans le noir. On l'analyse deux fois,
    // telle quelle et éclaircie, et on réunit les visages trouvés : l'éclaircie révèle les visages noyés dans le noir,
    // l'originale garde les tout petits que l'éclaircissement noie dans le bruit. Mesuré sur 6 000 photos de nuit
    // annotées (DARK FACE) : visages ratés divisés par plus de 3, sans effet sur les photos de jour (entrainement/eval-nuit.py).
    let sum = 0;
    for (let y = 0; y < dh; y++) for (let x = 0, p = y * pw * 4; x < dw; x++, p += 4) sum += rgba[p] + rgba[p + 1] + rgba[p + 2];
    const dark = sum / (3 * dw * dh) < DARK;
    const passes = dark ? [null, NIGHT_LUT] : [null];
    const found = [];
    for (const lut of passes) {
      for (let i = 0, p = 0; i < n; i++, p += 4) {   // ordre bleu, vert, rouge, comme à l'entraînement du modèle
        buffer[i] = lut ? lut[rgba[p + 2]] : rgba[p + 2];
        buffer[n + i] = lut ? lut[rgba[p + 1]] : rgba[p + 1];
        buffer[2 * n + i] = lut ? lut[rgba[p]] : rgba[p];
      }
      const out = await session.run({ input: new ort.Tensor('float32', buffer, [1, 3, ph, pw]) });
      for (const st of STRIDES) {
        const cols = pw / st;
        const cls = out['cls_' + st].data, obj = out['obj_' + st].data, box = out['bbox_' + st].data;
        for (let i = 0; i < cls.length; i++) {
          const s = Math.sqrt(Math.min(1, Math.max(0, cls[i])) * Math.min(1, Math.max(0, obj[i])));
          if (s < minScore) continue;
          const w = Math.exp(box[i * 4 + 2]) * st, h = Math.exp(box[i * 4 + 3]) * st;
          const cx = ((i % cols) + box[i * 4]) * st, cy = (Math.floor(i / cols) + box[i * 4 + 1]) * st;
          found.push({ x: (cx - w / 2) / scale, y: (cy - h / 2) / scale, w: w / scale, h: h / scale, s });
        }
      }
    }
    // Un même visage sort plusieurs fois : on garde le cadre le plus sûr.
    const kept = dedupe(found);
    kept.dark = dark;
    return kept;
  }
  detect.center = center;
  return detect;
}
