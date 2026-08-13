/**
 * interface.test.mjs — vérifications statiques de l'interface.
 *
 * L'interface ne se teste pas sans navigateur, mais trois erreurs parmi les
 * plus coûteuses se voient très bien en lisant les fichiers : un bouton qui
 * n'est branché à rien, un identifiant cherché qui n'existe pas, et un
 * élément qu'on croit cacher alors qu'il reste à l'écran.
 *
 * La troisième a réellement mordu : `.panneau` déclarait `display: flex` et
 * la feuille ne contenait aucune règle `[hidden]`. Les panneaux de réglages
 * ne se fermaient donc jamais — la croix éteignait le voile et laissait le
 * panneau collé à l'écran.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const lire = (p) => readFileSync(join(RACINE, p), 'utf8');

const html = lire('index.html');
const js = lire('src/ui/main.js');
const css = lire('src/ui/styles.css');

/** Attributs d'une balise, découpés grossièrement mais suffisamment. */
function balises() {
  return [...html.matchAll(/<([a-z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)]
    .map((m) => ({ nom: m[1], attrs: m[2] }));
}

// ---------------------------------------------------------------------------

test('chaque bouton est branché à un traitement', () => {
  const declarees = new Set([...html.matchAll(/data-action="([^"]+)"/g)].map((m) => m[1]));
  const traitees = new Set([...js.matchAll(/action === '([^']+)'/g)].map((m) => m[1]));

  const orphelines = [...declarees].filter((a) => !traitees.has(a));
  assert.deepEqual(orphelines, [], `boutons sans traitement : ${orphelines.join(', ')}`);

  const inutiles = [...traitees].filter((a) => !declarees.has(a));
  assert.deepEqual(inutiles, [], `traitements sans bouton : ${inutiles.join(', ')}`);
});

test('chaque identifiant cherché par le JavaScript existe dans le HTML', () => {
  const declares = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const cherches = [...new Set([...js.matchAll(/\$\$?\('#([\w-]+)/g)].map((m) => m[1]))];

  const manquants = cherches.filter((i) => !declares.has(i));
  assert.deepEqual(manquants, [], `introuvables dans index.html : ${manquants.join(', ')}`);
  assert.ok(cherches.length > 20, 'la détection des sélecteurs a dû échouer');
});

test('chaque panneau ouvert par le JavaScript existe', () => {
  const declares = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const ouverts = [...js.matchAll(/ouvrirPanneau\('([^']+)'\)/g)].map((m) => m[1]);

  assert.ok(ouverts.length >= 3, 'aucun panneau détecté');
  for (const p of ouverts) assert.ok(declares.has(p), `panneau inconnu : ${p}`);
});

test('ce que l’on cache se cache vraiment', () => {
  // `hidden` ne vaut que par la feuille du navigateur, qui perd contre toute
  // règle d'auteur. Il faut donc soit une règle [hidden] explicite, soit
  // qu'aucun élément cachable n'impose son display.
  const regleGlobale = /\[hidden\][^{]*\{[^}]*display\s*:\s*none\s*!important/.test(css);

  if (!regleGlobale) {
    const cachables = new Set();
    for (const { attrs } of balises()) {
      // « hidden » seul, pas « aria-hidden ».
      if (!/\shidden(?=[\s=>]|$)/.test(attrs)) continue;
      const id = attrs.match(/id="([^"]+)"/);
      const cls = attrs.match(/class="([^"]+)"/);
      if (id) cachables.add(`#${id[1]}`);
      if (cls) for (const c of cls[1].trim().split(/\s+/)) cachables.add(`.${c}`);
    }
    for (const id of js.matchAll(/\$\('#([\w-]+)'\)\.hidden/g)) cachables.add(`#${id[1]}`);

    const fautifs = [...cachables].filter((sel) => {
      const echappe = sel.replace(/[.#-]/g, '\\$&');
      return new RegExp(`(^|[,}\\s])${echappe}\\s*(,[^{]*)?\\{[^}]*display\\s*:`, 'm').test(css);
    });

    assert.deepEqual(fautifs, [], `imposent leur display malgré hidden : ${fautifs.join(', ')}`);
  }

  assert.ok(regleGlobale, 'la règle [hidden] { display: none !important } protège tout le reste');
});

test('le service worker précharge tous les modules du site', () => {
  const sw = lire('sw.js');
  const listes = sw.match(/const (?:COQUILLE|MOTEUR) = \[[^\]]+\]/gs).join('\n');
  const caches = new Set([...listes.matchAll(/'\.\/([^']+)'/g)].map((m) => m[1]));

  // Tout module importé par l'interface doit être dans la coquille, sinon il
  // manquera au premier démarrage hors connexion.
  const modules = ['src/ui/main.js', 'src/prosody.js', 'src/player.js',
    'src/silence.js', 'src/breath.js', 'src/audio.js', 'src/store.js',
    'src/engines/index.js', 'src/engines/phonemes.js', 'src/engines/lexique-data.js'];

  const oublies = modules.filter((m) => !caches.has(m));
  assert.deepEqual(oublies, [], `absents des listes du service worker : ${oublies.join(', ')}`);
});
