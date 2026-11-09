// Service worker : garde une copie des fichiers du site sur le téléphone, pour que vesky marche sans réseau.
// Avec du réseau, c'est la version en ligne qui est servie (et la copie est mise à jour).
// Sans réseau, ou si le site ne répond pas en 3 secondes (réseau saturé), c'est la copie.
// Aucune requête ne part vers un autre site.
const CACHE = 'vesky';
// Réseau saturé : sans ce délai, chaque fichier attendait le site pendant de longues secondes alors que tout est déjà
// sur le téléphone. La demande est abandonnée, pas laissée en route. Seule peut rester en route la vérification de
// sw.js que le navigateur fait de lui-même. Un chargement servi par la copie ne la met pas à jour : ce sera au suivant.
// Après un premier délai dépassé, la copie sert d'office pendant une minute : les fichiers se chargent en chaîne,
// on n'attend donc qu'une fois.
const WAIT = 3000, SLOW_FOR = 60000;
let slowUntil = 0;
const FILES = [
  './',
  'style.css',
  'app.js',
  'detector.js',
  'detect-worker.js',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'models/yunet.onnx',
  'vendor/fonts/fonts.css',
  'vendor/fonts/archivo-latin.woff2',
  'vendor/fonts/archivo-latin-ext.woff2',
  'vendor/fonts/jetbrains-mono-latin.woff2',
  'vendor/fonts/jetbrains-mono-latin-ext.woff2',
  'vendor/ort/ort.wasm.min.mjs',
  'vendor/ort/ort-wasm-simd-threaded.mjs',
  'vendor/ort/ort-wasm-simd-threaded.wasm',
  'vendor/mediabunny/mediabunny.min.mjs',
];
const KNOWN = new Set(FILES.map((f) => new URL(f, self.registration.scope).href));

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

// Partage depuis la galerie (Android) : le téléphone remet le fichier ici. Il est gardé en mémoire, jamais
// écrit ni envoyé ailleurs, puis donné à la page quand elle le demande.
const SHARE = new URL('share', self.registration.scope).href;
let shared = null;

self.addEventListener('message', (e) => {
  if (!e.data || e.data.type !== 'partage' || !e.ports[0]) return;
  e.ports[0].postMessage(shared);
  shared = null;
});

self.addEventListener('fetch', (e) => {
  if (e.request.method === 'POST' && e.request.url.split('?')[0] === SHARE) {
    e.respondWith((async () => {
      try {
        const file = (await e.request.formData()).get('file');
        shared = file instanceof File ? file : null;
      } catch {
        shared = null;
      }
      return Response.redirect('./?partage', 303);
    })());
    return;
  }
  const url = new URL(e.request.url);
  url.search = '';
  url.hash = '';
  if (url.pathname.endsWith('/index.html')) url.pathname = url.pathname.slice(0, -10);
  if (e.request.method !== 'GET' || !KNOWN.has(url.href)) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const kept = await cache.match(url.href);
    if (kept && Date.now() < slowUntil) return kept;
    // Sans copie, on attend le site aussi longtemps qu'il faut. Le délai ne court que jusqu'au début de la réponse.
    const stop = new AbortController();
    const timer = kept ? setTimeout(() => stop.abort(), WAIT) : 0;
    try {
      const fresh = await fetch(e.request, { signal: stop.signal });
      if (fresh.ok) cache.put(url.href, fresh.clone());
      return fresh;
    } catch (err) {
      if (stop.signal.aborted) slowUntil = Date.now() + SLOW_FOR;
      if (kept) return kept;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  })());
});
