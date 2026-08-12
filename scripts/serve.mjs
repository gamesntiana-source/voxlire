/**
 * serve.mjs — petit serveur de développement.
 *
 * Une PWA ne peut pas être testée depuis file:// : les modules ES, le
 * service worker et IndexedDB exigent une vraie origine HTTP. Ce serveur
 * n'a pas d'autre ambition ; il sert le dossier du projet, avec les bons
 * types MIME et sans cache, pour que F5 montre vraiment le dernier code.
 *
 * Usage : node scripts/serve.mjs [port]
 *         node scripts/serve.mjs 8080 --isolation
 *
 * L'option --isolation ajoute les en-têtes COOP/COEP, qui débloquent les
 * fils d'exécution WebAssembly. C'est utile pour mesurer le gain en local —
 * mais GitHub Pages ne permet pas de définir ces en-têtes, donc ce qui
 * marche ici ne marchera pas forcément en ligne. À utiliser pour comparer,
 * pas pour valider.
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');

const port = Number(process.argv[2]) || 8000;
const isolation = process.argv.includes('--isolation');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.epub': 'application/epub+zip',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

const serveur = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  // normalize() écrase les « .. » : on ne sort pas du dossier du projet.
  let chemin = join(RACINE, normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, ''));

  try {
    let infos = await stat(chemin);
    if (infos.isDirectory()) {
      chemin = join(chemin, 'index.html');
      infos = await stat(chemin);
    }

    const entetes = {
      'Content-Type': TYPES[extname(chemin).toLowerCase()] || 'application/octet-stream',
      'Content-Length': infos.size,
      'Cache-Control': 'no-store',
      // Le service worker doit pouvoir prendre la main sur tout le site.
      'Service-Worker-Allowed': '/',
    };
    if (isolation) {
      entetes['Cross-Origin-Opener-Policy'] = 'same-origin';
      entetes['Cross-Origin-Embedder-Policy'] = 'require-corp';
      entetes['Cross-Origin-Resource-Policy'] = 'cross-origin';
    }

    res.writeHead(200, entetes);
    createReadStream(chemin).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Introuvable\n');
  }
});

serveur.listen(port, () => {
  const adresses = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);

  console.log(`Voxlire sert ${RACINE}`);
  console.log(`  → http://localhost:${port}`);
  for (const a of adresses) console.log(`  → http://${a}:${port}   (depuis le téléphone, même wifi)`);
  if (isolation) console.log('  en-têtes COOP/COEP actives (fils WebAssembly débloqués)');
});
