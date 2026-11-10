// Test du bouton « Garder seul » de la vérification : il retire d'un coup les autres masques de l'image affichée, sans jamais
// toucher à un suivi absent de cette image, ni à un suivi qui passe sur le visage gardé à un moment de la vidéo, ni à un
// masque remis à la main.
// Usage : python test/make-test-video.py (une fois), node outils/dev-server.mjs (dans un autre terminal), puis node test/test-garder-seul.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9335;
const SITE = 'http://localhost:5173/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'vesky-'))}`,
  '--autoplay-policy=no-user-gesture-required', '--window-size=420,900', '--no-first-run', 'about:blank',
], { stdio: 'ignore' });

let page;
for (let i = 0; i < 50 && !page; i++) {
  await sleep(200);
  try { page = (await (await fetch(`http://localhost:${PORT}/json`)).json()).find((t) => t.type === 'page'); } catch { /* pas encore prêt */ }
}
if (!page) { console.error('Chrome injoignable sur le port ' + PORT); chrome.kill(); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let nextId = 1;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const id = nextId++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const run = async (expression) => {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception || r.result.exceptionDetails));
  return r.result.result.value;
};

await send('Page.enable');
await send('Page.navigate', { url: SITE });
await sleep(1000);
await run(`while (!window.vesky || document.getElementById('file').disabled) await new Promise(r => setTimeout(r, 100));`);
await run(`const b = await (await fetch('test/test2.mp4')).blob(); const dt = new DataTransfer(); dt.items.add(new File([b], 'test2.mp4', { type: 'video/mp4' }));
  const inp = document.getElementById('file'); inp.files = dt.files; inp.dispatchEvent(new Event('change'));`);
await run(`while (document.getElementById('s-review').hidden && document.getElementById('fatal').hidden) await new Promise(r => setTimeout(r, 100));`);

// Outils dans la page : toucher un point de l'image (comme un doigt), lire l'état des masques de l'image affichée.
const TOOLS = `const S = window.vesky.S, $ = (id) => document.getElementById(id), view = $('view');
  const J = () => window.vesky.frameIndex(S.t);
  const isOff = (tr, j) => { let off = false; for (const e of tr.off) if (e.from <= j) off = e.off; return off; };
  const tap = (x, y) => { const r = view.getBoundingClientRect(), k = Math.min(r.width / S.W, r.height / S.H);
    view.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: r.left + (r.width - S.W * k) / 2 + x * k, clientY: r.top + (r.height - S.H * k) / 2 + y * k })); };
  const here = () => [...new Set((S.frames[J()] || []).map((b) => b.track))];
  const on = () => here().filter((t) => !isOff(t, J())).map((t) => t.id).sort((a, b) => a - b);
  const wait = () => new Promise((r) => setTimeout(r, 300));`;

const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); };

// Au milieu de la vidéo, les 4 visages de test2.mp4 sont masqués. On ajoute trois suivis fabriqués : un empilé sur le
// visage moyen (même endroit, plus grand), un qui n'existe que 20 images plus loin, et un qui est loin du visage moyen
// sur cette image mais posé dessus 10 images plus tard.
const debut = await run(`${TOOLS} $('time').value = 2.5; $('time').dispatchEvent(new Event('input')); await wait(); await wait();
  const j = J(), mid = (S.frames[j] || []).find((b) => 124 >= b.x && 124 <= b.x + b.w && 869 >= b.y && 869 <= b.y + b.h);
  if (!mid) return { erreur: 'visage moyen non masqué' };
  const pile = { id: 9001, dets: new Map([[j, mid]]), off: [] }, tard = { id: 9002, dets: new Map([[j + 20, mid]]), off: [] };
  const passe = { id: 9004, dets: new Map([[j, mid]]), off: [] }, mid10 = S.frames[j + 10].find((b) => b.track === mid.track);
  if (!mid10) return { erreur: 'visage moyen non masqué 10 images plus loin' };
  S.tracks.push(pile, tard, passe);
  S.frames[j].push({ x: 10, y: 300, w: 30, h: 30, track: passe });
  S.frames[j + 10].push({ x: mid10.x, y: mid10.y, w: mid10.w, h: mid10.h, track: passe });
  S.frames[j].push({ x: mid.x - 20, y: mid.y - 20, w: mid.w + 40, h: mid.h + 40, track: pile });
  S.frames[j + 20].push({ x: 300, y: 300, w: 60, h: 60, track: tard });
  return { j, milieu: mid.track.id, masques: on() };`);
if (debut.erreur) { console.error('ÉCHEC\n- ' + debut.erreur); ws.close(); chrome.kill(); process.exit(1); }
check(debut.masques.length >= 7, 'moins de 7 masques au départ : ' + debut.masques.join(', '));

// 1. Toucher le visage moyen, puis « Garder seul » : restent lui, le suivi empilé et celui qui passe sur lui plus tard ;
// les autres partent ; le suivi absent de l'image n'est pas touché.
const seul = await run(`${TOOLS} tap(124, 869); await wait();
  const choisi = S.sel && S.sel.track && S.sel.track.id, visible = !$('mOnly').hidden && $('mOnly').offsetWidth > 0;
  $('mOnly').click(); await wait();
  return { choisi, visible, masques: on(), tard: S.tracks.find((t) => t.id === 9002).off.length, bouton: !$('mOnly').hidden, remettre: $('restoreAll').hidden ? '' : $('restoreAll').textContent };`);
check(seul.choisi === debut.milieu, 'le toucher ne sélectionne pas le visage moyen');
check(seul.visible, 'bouton « Garder seul » absent après sélection');
check(JSON.stringify(seul.masques) === JSON.stringify([debut.milieu, 9001, 9004].sort((a, b) => a - b)), 'masques restants après « Garder seul » : ' + seul.masques.join(', '));
check(seul.tard === 0, 'un suivi absent de l\'image a été retiré');
check(!seul.bouton, 'bouton « Garder seul » encore proposé alors qu\'il n\'y a plus rien à retirer');
check(/Remettre les \d+ masques retirés/.test(seul.remettre), 'bouton « Remettre » : ' + seul.remettre);

// 2. Remettre à la main le grand visage et un petit, puis « Garder seul » sur le petit : rien de ce qui a été gardé ou remis
// ne part, suivi empilé compris.
const garde = await run(`${TOOLS} const j = J(), t = (j + 0.5) / S.fps;
  const big = [60 + 280 * Math.abs(Math.sin(t * 2.5)) + 120, 120 + 200 * Math.abs(Math.cos(t * 1.7)) + 135];
  tap(big[0], big[1]); await wait(); const grand = S.sel.track.id; $('mDelete').click(); await wait();
  tap(632, 1195); await wait(); const petit = S.sel.track.id; $('mDelete').click(); await wait();
  S.tracks.push({ id: 9003, dets: new Map([[j, null]]), off: [] });   // un nouveau masque à tort, loin de tout
  S.frames[j].push({ x: 10, y: 10, w: 30, h: 30, track: S.tracks[S.tracks.length - 1] });
  tap(632, 1195); await wait();
  const avant = on(), visible = !$('mOnly').hidden; $('mOnly').click(); await wait();
  return { grand, petit, avant, visible, masques: on() };`);
check(garde.visible && garde.avant.includes(9003), 'second « Garder seul » non proposé');
check(garde.avant.includes(garde.grand) && garde.avant.includes(garde.petit), 'masques remis à la main : ' + garde.avant.join(', '));
check(garde.masques.includes(garde.grand) && garde.masques.includes(garde.petit), 'un masque remis à la main a été retiré : ' + garde.masques.join(', '));
check([debut.milieu, 9001, 9004].every((t) => garde.masques.includes(t)), 'le visage gardé en premier ou un suivi qui passe sur lui a été retiré : ' + garde.masques.join(', '));
check(garde.masques.length === 5, 'masques restants après le second « Garder seul » : ' + garde.masques.join(', '));

// 3. « Remettre les masques retirés » annule tout.
const fin = await run(`${TOOLS} $('restoreAll').click(); await wait(); return { masques: on(), retires: S.tracks.filter((t) => t.off.length || t.keep).length };`);
check(JSON.stringify(fin.masques) === JSON.stringify(debut.masques.concat(9003).sort((a, b) => a - b)), 'masques après « Remettre » : ' + fin.masques.join(', '));
check(fin.retires === 0, 'il reste des retraits après « Remettre »');

console.log(JSON.stringify({ debut, seul, garde, fin }, null, 2));
ws.close();
chrome.kill();
if (fails.length) { console.error('ÉCHEC\n- ' + fails.join('\n- ')); process.exit(1); }
console.log('OK');
