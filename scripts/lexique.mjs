/**
 * lexique.mjs — fabrique le dictionnaire de prononciation.
 *
 * Le principe tient en une phrase : on demande à eSpeak NG — le phonémiseur
 * avec lequel les modèles Piper ont été entraînés — comment il prononce tout
 * le vocabulaire français, on confronte ses réponses à nos règles, et on ne
 * garde que les mots où les deux diffèrent.
 *
 * Le lexique livré n'est donc pas un dictionnaire : c'est la liste des
 * exceptions à nos propres règles. Cela le fait passer de 7,5 Mo à 1,5 Mo,
 * sans rien perdre : un mot absent du fichier est un mot que les règles
 * prononcent déjà juste.
 *
 * eSpeak NG n'est nécessaire QU'ICI. L'application livrée n'en dépend pas.
 *
 * Usage : npm run lexique
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prononcer } from '../src/engines/regles.js';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(RACINE, '.cache');
const SORTIE = join(RACINE, 'src', 'engines', 'lexique-data.js');

const SOURCES = {
  // Dictionnaire : la langue écrite, conjugaisons comprises.
  'dictionnaire.json': 'https://raw.githubusercontent.com/words/an-array-of-french-words/master/index.json',
  // Fréquences : ce qui s'écrit vraiment, noms propres et mots récents inclus.
  'frequences.txt': 'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/fr/fr_full.txt',
};

/** Seuil au-delà duquel un mot absent du dictionnaire mérite sa place. */
const FREQUENCE_MINIMALE = 200;

/** Mots retenus : lettres, avec apostrophes et traits d'union internes. */
const ACCEPTE = /^[a-zà-öø-ÿœæ]+(?:['’-][a-zà-öø-ÿœæ]+)*$/;

const LOT = 20000;

// ---------------------------------------------------------------------------

async function telecharger(nom, url) {
  const chemin = join(CACHE, nom);
  if (existsSync(chemin)) return chemin;
  process.stdout.write(`téléchargement de ${nom}… `);
  const reponse = await fetch(url);
  if (!reponse.ok) throw new Error(`${reponse.status} sur ${url}`);
  writeFileSync(chemin, Buffer.from(await reponse.arrayBuffer()));
  console.log('fait');
  return chemin;
}

/** Construit la liste de mots à phonémiser. */
function vocabulaire(cheminDico, cheminFreq) {
  const dico = JSON.parse(readFileSync(cheminDico, 'utf8'));

  const frequences = new Map();
  for (const ligne of readFileSync(cheminFreq, 'utf8').split('\n')) {
    const [mot, n] = ligne.split(' ');
    if (mot) frequences.set(mot, Number(n) || 0);
  }

  const retenus = new Set();
  for (const mot of dico) {
    const m = mot.toLowerCase();
    if (ACCEPTE.test(m)) retenus.add(m);
  }
  for (const [mot, n] of frequences) {
    if (n >= FREQUENCE_MINIMALE && ACCEPTE.test(mot)) retenus.add(mot);
  }
  return [...retenus].sort();
}

/**
 * Phonémise tout le vocabulaire avec eSpeak NG.
 *
 * Chaque mot est suivi d'un point : eSpeak replie les lignes en paragraphes,
 * et sans cette ponctuation il rendrait un pavé de phonèmes impossible à
 * réaligner sur les mots d'entrée.
 */
async function phonemiserTout(mots, chemin) {
  if (existsSync(chemin)) return chemin;

  const { default: ESpeakNg } = await import('espeak-ng');
  writeFileSync(chemin, '');
  const debut = Date.now();

  for (let i = 0; i < mots.length; i += LOT) {
    const lot = mots.slice(i, i + LOT);
    const module = await ESpeakNg({
      arguments: ['-q', '-v', 'fr', '--ipa', '--phonout', '/out.txt', '-f', '/in.txt'],
      print: () => {}, printErr: () => {},
      preRun: [(mod) => { mod.FS.writeFile('/in.txt', `${lot.map((m) => `${m}.`).join('\n')}\n`); }],
    });
    const lignes = module.FS.readFile('/out.txt', { encoding: 'utf8' }).split('\n');

    // Un décalage d'une seule ligne fausserait tout le fichier en silence.
    if (lignes.length - 1 !== lot.length) {
      throw new Error(`désalignement au lot ${i} : ${lignes.length - 1} lignes pour ${lot.length} mots`);
    }
    appendFileSync(chemin, `${lot.map((m, k) => `${m}\t${lignes[k]}`).join('\n')}\n`);
    console.log(`  ${i + lot.length}/${mots.length}`);
  }
  console.log(`phonémisation terminée en ${Math.round((Date.now() - debut) / 1000)} s`);
  return chemin;
}

/**
 * Nettoie une transcription eSpeak.
 * L'accent tonique est retiré : il se replace au moment de la lecture, sur le
 * groupe de souffle, et non sur le mot isolé. Les drapeaux de langue sont
 * retirés eux aussi — piper en fait autant.
 */
function nettoyer(ipa) {
  return ipa.replace(/\([a-z-]+\)/g, '').replace(/[ˈˌ]/g, '').trim();
}

// ---------------------------------------------------------------------------

mkdirSync(CACHE, { recursive: true });

const chemins = {};
for (const [nom, url] of Object.entries(SOURCES)) chemins[nom] = await telecharger(nom, url);

const mots = vocabulaire(chemins['dictionnaire.json'], chemins['frequences.txt']);
console.log(`vocabulaire : ${mots.length} mots`);

const verite = await phonemiserTout(mots, join(CACHE, 'verite.tsv'));

let total = 0;
let accord = 0;
const exceptions = [];

for (const ligne of readFileSync(verite, 'utf8').split('\n')) {
  if (!ligne) continue;
  const [mot, brut] = ligne.split('\t');
  if (!mot || brut === undefined) continue;

  const attendu = nettoyer(brut);
  if (!attendu) continue;

  total++;
  if (prononcer(mot) === attendu) accord++;
  else exceptions.push(`${mot} ${attendu}`);
}

const taux = ((accord / total) * 100).toFixed(2);
console.log(`règles justes sur ${taux} % du vocabulaire`);
console.log(`exceptions retenues : ${exceptions.length}`);

const donnees = exceptions.join('\n');
const entete = `/**
 * lexique-data.js — FICHIER ENGENDRÉ, ne pas modifier à la main.
 *
 * Produit par « npm run lexique » à partir d'eSpeak NG.
 * ${total} mots examinés, ${taux} % déjà justes par les règles,
 * ${exceptions.length} exceptions conservées.
 *
 * Format : une ligne par mot, « mot phonèmes », trié pour la dichotomie.
 * L'accent tonique n'y figure pas : il se pose à la lecture, sur le groupe.
 */

export const DONNEES = ${JSON.stringify(donnees)};
`;

writeFileSync(SORTIE, entete);
console.log(`écrit : ${SORTIE} (${(Buffer.byteLength(entete) / 1024).toFixed(0)} ko)`);
