/**
 * sw.js — le service worker : ce qui rend l'application utilisable en avion.
 *
 * Trois régimes, volontairement séparés, parce qu'ils n'ont pas du tout le
 * même poids ni la même durée de vie :
 *
 *  - la COQUILLE (HTML, CSS, JS) est petite et change à chaque mise à jour :
 *    on la précharge à l'installation et on la sert depuis le cache, tout en
 *    la rafraîchissant en arrière-plan ;
 *  - le MOTEUR — ONNX Runtime et le lexique de prononciation — pèse une
 *    quinzaine de mégaoctets et ne bouge qu'à de rares occasions. Il a donc
 *    sa propre version : corriger une faute de frappe dans l'interface ne
 *    doit pas coûter un nouveau téléchargement de 13 Mo ;
 *  - les MODÈLES de voix pèsent des dizaines de mégaoctets et ne changent
 *    jamais ; ils vivent dans un cache géré par engines/index.js, et ce
 *    fichier n'y touche pas.
 *
 * La règle qui découle de tout ça : en modifiant les listes ci-dessous,
 * ne bougez VERSION_MOTEUR que si son contenu a réellement changé.
 */

const VERSION_COQUILLE = 'v2';
const VERSION_MOTEUR = 'ort1.27.0-lex1';

const CACHE_COQUILLE = `voxlire-coquille-${VERSION_COQUILLE}`;
const CACHE_MOTEUR = `voxlire-moteur-${VERSION_MOTEUR}`;

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
  './src/engines/catalogue.js',
  './src/engines/piper.js',
  './src/engines/phonemes.js',
  './src/engines/regles.js',
  './src/engines/nombres.js',
  './src/engines/lexique.js',
  './assets/icone.svg',
  './assets/icone-192.png',
  './assets/icone-512.png',
];

/** Gros fichiers immuables, à ne retélécharger que sur changement de version. */
const MOTEUR = [
  './src/engines/lexique-data.js',
  './src/vendor/ort/ort.wasm.bundle.min.mjs',
  './src/vendor/ort/ort-wasm-simd-threaded.wasm',
];

/** Une ressource appartient-elle au moteur ? */
function estMoteur(url) {
  return url.pathname.includes('/src/vendor/')
    || url.pathname.endsWith('/src/engines/lexique-data.js');
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    // Une ressource manquante ne doit pas faire échouer toute l'installation :
    // l'application doit pouvoir démarrer, quitte à télécharger le reste plus
    // tard. C'est particulièrement vrai du moteur, qui est gros.
    const coquille = await caches.open(CACHE_COQUILLE);
    await Promise.all(COQUILLE.map((url) =>
      coquille.add(new Request(url, { cache: 'reload' })).catch(() => {})));

    const moteur = await caches.open(CACHE_MOTEUR);
    await Promise.all(MOTEUR.map(async (url) => {
      if (await moteur.match(url)) return;
      await moteur.add(new Request(url, { cache: 'reload' })).catch(() => {});
    }));

    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const noms = await caches.keys();
    await Promise.all(noms
      .filter((n) => (n.startsWith('voxlire-coquille-') && n !== CACHE_COQUILLE)
        || (n.startsWith('voxlire-moteur-') && n !== CACHE_MOTEUR))
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

  // Moteur : strictement le cache d'abord, sans rafraîchissement en fond.
  // Ces fichiers sont immuables à version donnée, et retélécharger 13 Mo
  // « au cas où » à chaque chargement de page serait absurde.
  if (estMoteur(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_MOTEUR);
      const enCache = await cache.match(request);
      if (enCache) return enCache;
      try {
        const reponse = await fetch(request);
        if (reponse.ok) cache.put(request, reponse.clone());
        return reponse;
      } catch {
        return new Response('Moteur indisponible hors connexion.', { status: 503 });
      }
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
