/**
 * vendor.mjs — récupère ONNX Runtime Web.
 *
 * C'est la seule dépendance de Voxlire à l'exécution, et elle n'est pas
 * négociable : faire tourner un réseau de neurones dans un navigateur sans
 * lui, ce serait réécrire un an de travail. Elle est donc vendorisée plutôt
 * qu'installée : les fichiers atterrissent dans src/vendor/, versionnés à la
 * main, servis depuis notre propre origine. Aucun CDN n'est contacté quand
 * l'application tourne — c'est ce qui lui permet de fonctionner en avion.
 *
 * src/vendor/ est ignoré par git : le dépôt reste léger, et cette commande
 * le reconstitue à l'identique.
 *
 * Usage : npm run vendor
 */

import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const CIBLE = join(RACINE, 'src', 'vendor', 'ort');

/** Version épinglée : une montée de version se décide, elle ne se subit pas. */
const VERSION = '1.27.0';

/**
 * Les tailles attendues servent de garde-fou. Un fichier tronqué par une
 * coupure réseau donnerait une erreur WebAssembly incompréhensible six mois
 * plus tard ; mieux vaut échouer tout de suite et bruyamment.
 */
const FICHIERS = [
  // L'API, variante « bundle » : elle embarque sa colle Emscripten, ce qui
  // fait un fichier de moins à servir et une source d'erreur en moins hors
  // connexion.
  { nom: 'ort.wasm.bundle.min.mjs', octets: 72799 },
  // La colle Emscripten. Elle paraît superflue avec la variante « bundle »,
  // qui l'embarque — mais dès qu'on indique un chemin local par wasmPaths,
  // ONNX Runtime va la rechercher sur disque et échoue sans elle, avec un
  // « no available backend found » qui ne dit pas son vrai nom.
  { nom: 'ort-wasm-simd-threaded.mjs', octets: 24180 },
  // Le moteur lui-même. C'est lui qui pèse, et il ne change qu'avec la version.
  { nom: 'ort-wasm-simd-threaded.wasm', octets: 13479978 },
];

const BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${VERSION}/dist`;

const mo = (n) => `${(n / 1e6).toFixed(1)} Mo`;

mkdirSync(CIBLE, { recursive: true });

let recupere = 0;
for (const { nom, octets } of FICHIERS) {
  const chemin = join(CIBLE, nom);

  if (existsSync(chemin) && statSync(chemin).size === octets) {
    console.log(`  déjà là   ${nom}`);
    continue;
  }

  process.stdout.write(`  téléchargement ${nom} (${mo(octets)})… `);
  const reponse = await fetch(`${BASE}/${nom}`);
  if (!reponse.ok) throw new Error(`${reponse.status} sur ${BASE}/${nom}`);

  const contenu = Buffer.from(await reponse.arrayBuffer());
  if (contenu.length !== octets) {
    throw new Error(
      `${nom} fait ${contenu.length} octets, ${octets} attendus. `
      + 'Soit le téléchargement a été coupé, soit la version a bougé : '
      + 'vérifiez VERSION et les tailles dans ce script.',
    );
  }

  writeFileSync(chemin, contenu);
  recupere++;
  console.log('fait');
}

const total = FICHIERS.reduce((a, f) => a + f.octets, 0);
console.log(`\nONNX Runtime ${VERSION} prêt dans src/vendor/ort/ (${mo(total)}, ${recupere} fichier(s) récupéré(s))`);
