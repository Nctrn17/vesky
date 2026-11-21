# Mesure sur photos la règle du site à deux détecteurs (judge dans app.js) : CenterFace sur l'image réduite, et YuNet
# pour les seuls petits visages. Mêmes banques annotées que entrainement/eval-faces.py (WIDER FACE, DARK FACE), qui
# fournit les détections de YuNet et mesure l'ancienne règle (YuNet seul).
# Usage : python entrainement/eval-centerface.py <dossier des banques>
# (besoin : pip install onnxruntime opencv-python numpy)
# Les détections de CenterFace sont gardées en cache (detections-cf640-*.json), à côté de celles de YuNet.
# DARK FACE a servi à réentraîner YuNet, sauf les 1 000 photos de darkface-split.json : elles sont mesurées à part.
import importlib.util
import json
import math
import os
import sys

import cv2
import numpy as np
import onnxruntime as ort

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = sys.argv[1] if len(sys.argv) > 1 else 'D:/datasets/vesky-eval'
sys.argv = [sys.argv[0], DATA]
spec = importlib.util.spec_from_file_location('ev', os.path.join(HERE, 'eval-faces.py'))
ev = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ev)

# Comme detector.js et app.js.
CENTER_SIDE, CENTER_KEEP, CENTER_SCORE = 640, 0.1, 0.2
FROM, DARK_FROM = 0.045, 0.06   # taille (part du petit côté) sous laquelle YuNet garde la main ; sur image très sombre
TINY_FROM, TINY_SCORE = 0.03, 0.25   # un tout petit cadre de CenterFace ne compte qu'à partir de ce score
cf = ort.InferenceSession(os.path.join(HERE, '..', 'models', 'centerface.onnx'), providers=['CPUExecutionProvider'])


def centerface(img, lut=None):
    """Une passe sur l'image étirée à des dimensions multiples de 32. Décodage repris de deface/centerface.py."""
    h, w = img.shape[:2]
    k = min(1.0, CENTER_SIDE / max(w, h))
    iw, ih = math.ceil(max(1, round(w * k)) / 32) * 32, math.ceil(max(1, round(h * k)) / 32) * 32
    rgb = cv2.cvtColor(img if lut is None else cv2.LUT(img, lut), cv2.COLOR_BGR2RGB)
    blob = np.ascontiguousarray(cv2.resize(rgb, (iw, ih), interpolation=cv2.INTER_LINEAR).transpose(2, 0, 1)[None].astype(np.float32))
    heat, scale, offset = cf.run(['537', '538', '539'], {'input.1': blob})
    heat = heat[0, 0]
    sx, sy = w / iw, h / ih
    found = []
    for y, x in zip(*np.where(heat > CENTER_KEEP)):
        s0, s1 = math.exp(scale[0, 0, y, x]) * 4, math.exp(scale[0, 1, y, x]) * 4
        x1 = min(max(0, (x + offset[0, 1, y, x] + 0.5) * 4 - s1 / 2), iw)
        y1 = min(max(0, (y + offset[0, 0, y, x] + 0.5) * 4 - s0 / 2), ih)
        found.append([x1 * sx, y1 * sy, (min(x1 + s1, iw) - x1) * sx, (min(y1 + s0, ih) - y1) * sy, float(heat[y, x])])
    return found


def nms(found):
    kept = []
    for b in sorted(found, key=lambda d: -d[4]):
        if b[2] > 0 and b[3] > 0 and all(ev.iou(k, b) <= ev.NMS_IOU for k in kept):
            kept.append(b)
    return [[round(float(v), 1) for v in d[:4]] + [round(float(d[4]), 3)] for d in kept]


def collect(name, rows):
    """Par image : 'n' = détections sur l'image telle quelle ; 'e' = avec en plus l'image éclaircie, si elle est très sombre."""
    cache = os.path.join(DATA, f'detections-cf{CENTER_SIDE}-{name}.json')
    if os.path.exists(cache):
        return json.load(open(cache))
    paths = {os.path.basename(p): p for _, p, _ in (ev.wider() if name == 'wider' else ev.darkface())}
    out = {}
    for k, r in enumerate(rows):
        img = cv2.imread(paths[r['p']])
        plain = centerface(img)
        out[r['p']] = {'n': nms(plain), 'e': nms(plain + centerface(img, ev.NIGHT_LUT)) if img.mean() < ev.DARK else None}
        if k % 500 == 0:
            print(f'  centerface {name} : {k}/{len(rows)} images', flush=True)
    json.dump(out, open(cache, 'w'))
    return out


def masks_site(r, cfd):
    """La règle de app.js : CenterFace à partir de 0,2, plus les petits cadres de YuNet qui ne le doublent pas."""
    side = min(r['W'], r['H'])
    d = cfd[r['p']]
    dark = d['e'] is not None
    center = [b for b in (d['e'] if dark else d['n']) if b[4] >= CENTER_SCORE and (b[2] / side >= TINY_FROM or b[4] >= TINY_SCORE)]
    small = [b for b in r['dets'] if b[2] / side < (DARK_FROM if dark else FROM) and b[4] >= ev.SMALL_SCORE and not any(ev.iou(b, c) > 0.3 for c in center)]
    return [ev.grow(b) for b in center + small]


if __name__ == '__main__':
    held_out = set(json.load(open(os.path.join(HERE, 'darkface-split.json')))['test'])
    for name in ('wider', 'darkface'):
        rows = ev.collect(name, ev.wider() if name == 'wider' else ev.darkface())
        if not rows:
            continue
        cfd = collect(name, rows)
        parts = [(name, rows)] + ([('darkface, 1 000 photos jamais vues à l\'entraînement', [r for r in rows if r['p'][:-4] in held_out])] if name == 'darkface' else [])
        for title, part in parts:
            print(f'\n===== {title} : {len(part)} images, {sum(len(r["faces"]) for r in part)} visages repérés')
            print("  visages non couverts, par taille (part du petit côté de l'image) · grands masques sans visage")
            for rname, fn in (('YuNet seul (ancienne règle)', ev.masks_app), ('CenterFace + petits de YuNet', lambda r: masks_site(r, cfd))):
                missed, total, false_big = ev.evaluate(part, fn)
                bands = '  '.join(f'{int(b[0] * 100)}-{int(min(b[1], 1) * 100)} % : {missed[b]}/{total[b]}' for b in total)
                print(f'    {rname:30s} {bands}  ·  {false_big}', flush=True)
