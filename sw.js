/**
 * sw.js — le service worker : ce qui rend l'application utilisable en avion.
 *
 * Deux régimes, volontairement séparés :
 *  - la coquille (HTML, CSS, JS) est petite et change à chaque mise à jour :
 *    on la précharge à l'installation et on la sert depuis le cache, tout en
 *    la rafraîchissant en arrière-plan ;
 *  - les modèles de voix pèsent des dizaines de mégaoctets et ne changent
 *    jamais : ils vivent dans leur propre cache, géré par le moteur, et ce
 *    fichier n'y touche pas. Un mauvais réglage ici ne doit jamais provoquer
 *    le retéléchargement de 60 Mo.
 */

const VERSION = 'v1';
const CACHE_COQUILLE = `voxlire-coquille-${VERSION}`;

const COQUILLE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './src/ui/styles.css',
  './src/ui/main.js',
  './src/prosody.js',
  './src/player.js',
  './src/breath.js',
  './src/audio.js',
  './src/store.js',
  './src/epub.js',
  './src/zip.js',
  './src/engines/index.js',
  './src/engines/piper.js',
  './src/engines/phonemes.js',
  './assets/icone.svg',
  './assets/icone-192.png',
  './assets/icone-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_COQUILLE);
    // Une ressource manquante ne doit pas faire échouer toute l'installation.
    await Promise.all(COQUILLE.map((url) =>
      cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const noms = await caches.keys();
    await Promise.all(noms
      .filter((n) => n.startsWith('voxlire-coquille-') && n !== CACHE_COQUILLE)
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // modèles et CDN : pas notre affaire

  // Navigation : la coquille d'abord, pour démarrer même sans réseau.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_COQUILLE);
      const enCache = await cache.match('./index.html');
      if (enCache) {
        fetch(request).then((reponse) => {
          if (reponse.ok) cache.put('./index.html', reponse.clone());
        }).catch(() => {});
        return enCache;
      }
      try { return await fetch(request); }
      catch { return new Response('Hors connexion.', { status: 503 }); }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_COQUILLE);
    const enCache = await cache.match(request);

    const reseau = fetch(request).then((reponse) => {
      if (reponse.ok) cache.put(request, reponse.clone());
      return reponse;
    }).catch(() => null);

    return enCache || (await reseau) || new Response('Indisponible hors connexion.', { status: 503 });
  })());
});
