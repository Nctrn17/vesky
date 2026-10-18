// Test du nettoyage des MP4 produits (scrubMp4Dates dans app.js), sans navigateur : des fichiers sont écrits par
// Mediabunny, comme à l'export rapide, puis nettoyés. Aucune date de création ne doit rester, ni nom ou langue
// de piste repris du fichier d'origine, et le fichier doit rester lisible.
// Deux cas : une longue vidéo, dont la boîte moov dépasse 1 Mo (20 min à 60 images par seconde), et des pistes
// nommées, comme l'export rapide les recopie d'un fichier d'origine qui en a.
// Usage : node test/test-metadonnees.mjs
import { readFileSync } from 'node:fs';
import * as MB from '../vendor/mediabunny/mediabunny.min.mjs';

// La fonction est reprise telle quelle d'app.js, qui ne se charge pas hors d'une page.
const src = readFileSync(new URL('../app.js', import.meta.url), 'utf8').match(/async function scrubMp4Dates\(blob\) \{[\s\S]*?\n\}\n/)[0];
const scrubMp4Dates = new Function('return ' + src)();

// Paquets factices (Mediabunny ne les décode pas pour écrire) : une image tous les 1/fps à ±2 ms près, comme
// l'horloge irrégulière d'un téléphone, et le son AAC à 48 kHz.
async function make(seconds, fps, meta = {}) {
  const output = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new MB.BufferTarget() });
  const v = new MB.EncodedVideoPacketSource('avc'), a = new MB.EncodedAudioPacketSource('aac');
  output.addVideoTrack(v, meta);
  output.addAudioTrack(a, meta);
  await output.start();
  const sps = [0x67, 0x42, 0x00, 0x1f, 0xe9, 0x02, 0xc1, 0x2c, 0x80], pps = [0x68, 0xce, 0x3c, 0x80];
  const avcC = new Uint8Array([1, 0x42, 0x00, 0x1f, 0xff, 0xe1, 0, sps.length, ...sps, 1, 0, pps.length, ...pps]);
  let t = 0, ta = 0, n = 0, na = 0, seed = 1;
  const jitter = () => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647 - 0.5) * 0.004; };
  while (t < seconds) {
    for (; ta <= t; ta += 1024 / 48000) {
      await a.add(new MB.EncodedPacket(new Uint8Array(8), 'key', ta, 1024 / 48000),
        na++ ? undefined : { decoderConfig: { codec: 'mp4a.40.2', numberOfChannels: 2, sampleRate: 48000, description: new Uint8Array([0x11, 0x90]) } });
    }
    const d = 1 / fps + jitter();
    await v.add(new MB.EncodedPacket(new Uint8Array(8), n % (2 * fps) ? 'delta' : 'key', t, d),
      n++ ? undefined : { decoderConfig: { codec: 'avc1.42001f', codedWidth: 1920, codedHeight: 1080, description: avcC } });
    t += d;
  }
  await output.finalize();
  return new Blob([output.target.buffer], { type: 'video/mp4' });
}

// Relevé de ce qui reste dans la boîte moov : dates, langues, boîtes udta et meta, texte donné.
function inspect(bytes, text) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = (p) => String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
  const r = { moov: 0, dates: [], langues: [], boites: [] };
  const walk = (start, end) => {
    for (let p = start; p + 8 <= end;) {
      let size = dv.getUint32(p);
      if (size === 1) size = Number(dv.getBigUint64(p + 8));
      if (size < 8 || p + size > end) return;
      const t = type(p), v1 = bytes[p + 8] === 1;
      if (t === 'moov') r.moov = size;
      if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(t)) walk(p + 8, p + size);
      if (['mvhd', 'tkhd', 'mdhd'].includes(t)) {
        const c = v1 ? Number(dv.getBigUint64(p + 12)) : dv.getUint32(p + 12), m = v1 ? Number(dv.getBigUint64(p + 20)) : dv.getUint32(p + 16);
        if (c || m) r.dates.push(t + '=' + c);
      }
      if (t === 'mdhd') { const l = dv.getUint16(p + (v1 ? 40 : 28)); r.langues.push([10, 5, 0].map((s) => String.fromCharCode(((l >> s) & 31) + 0x60)).join('')); }
      if (t === 'udta' || t === 'meta') r.boites.push(t);
      p += size;
    }
  };
  walk(0, bytes.length);
  r.texte = text && Buffer.from(bytes).includes(text);
  return r;
}

// Le fichier nettoyé doit se relire comme l'original : mêmes pistes, même durée.
async function read(blob) {
  const input = new MB.Input({ source: new MB.BlobSource(blob), formats: MB.ALL_FORMATS });
  const tracks = await input.getTracks();
  const r = { pistes: tracks.length, duree: +(await input.computeDuration()).toFixed(3), noms: await Promise.all(tracks.map((t) => t.getName())) };
  input.dispose();
  return r;
}

const fails = [];
const cases = [
  ['longue vidéo (20 min, 60 images par seconde)', await make(20 * 60, 60), null],
  ['pistes nommées, langue donnée', await make(5, 30, { name: 'Core Media Video', languageCode: 'fra' }), 'Core Media Video'],
];
for (const [name, blob, text] of cases) {
  const out = await scrubMp4Dates(blob);
  const bytes = new Uint8Array(await out.arrayBuffer());
  const before = inspect(new Uint8Array(await blob.arrayBuffer()), text), after = inspect(bytes, text);
  const rb = await read(blob), ra = await read(out);
  console.log(name + ' :', JSON.stringify({ moovMo: +(before.moov / 1048576).toFixed(2), avant: { dates: before.dates.length, langues: before.langues, boites: before.boites, texte: before.texte },
    apres: { dates: after.dates, langues: after.langues, boites: after.boites, texte: after.texte }, lecture: { avant: rb, apres: ra } }));
  if (out.size !== blob.size) fails.push(name + ' : taille changée');
  if (!before.dates.length) fails.push(name + ' : aucune date dans le fichier de départ, le test ne prouve rien');
  if (after.dates.length) fails.push(name + ' : dates restantes ' + after.dates.join(', '));
  if (after.langues.some((l) => l !== 'und')) fails.push(name + ' : langue restante ' + after.langues.join(', '));
  if (after.boites.length) fails.push(name + ' : boîtes restantes ' + after.boites.join(', '));
  if (after.texte) fails.push(name + ' : nom de piste resté dans le fichier');
  if (ra.pistes !== rb.pistes || ra.duree !== rb.duree) fails.push(name + ' : le fichier nettoyé ne se relit plus pareil');
  if (ra.noms.some(Boolean)) fails.push(name + ' : nom de piste encore lu : ' + ra.noms.join(', '));
}
if (fails.length) { console.error('ÉCHEC\n- ' + fails.join('\n- ')); process.exit(1); }
console.log('OK');
