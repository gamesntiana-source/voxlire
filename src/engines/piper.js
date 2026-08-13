/**
 * piper.js — la voix elle-même.
 *
 * Un modèle Piper est un VITS exporté en ONNX. Il ne connaît ni les lettres
 * ni les mots : il attend une suite d'identifiants de phonèmes, et rend des
 * échantillons. Tout ce fichier tient entre ces deux bouts.
 *
 * Le format d'entrée n'est pas documenté ailleurs que dans le code de piper,
 * et il a une particularité qu'on ne devine pas : un identifiant de
 * remplissage est inséré ENTRE chaque phonème, ainsi qu'après le marqueur de
 * début. Sans ces intercalaires, le modèle produit du bruit — pas une erreur,
 * du bruit, ce qui est bien plus long à diagnostiquer.
 */

import { phonemiser } from './phonemes.js';

/** Chargé une seule fois pour toute l'application. */
let ort = null;

/**
 * Charge ONNX Runtime depuis les fichiers vendorisés.
 *
 * Les fils d'exécution WebAssembly exigent que la page soit « isolée »
 * (en-têtes COOP/COEP). GitHub Pages ne permet pas de les poser : on se
 * rabat alors sur un seul fil, plus lent mais qui fonctionne partout.
 */
async function chargerOrt() {
  if (ort) return ort;

  const module = await import('../vendor/ort/ort.wasm.bundle.min.mjs');
  // Le paquet expose ses classes en exports nommés ET en export par défaut,
  // et les deux ne portent pas toujours les mêmes propriétés selon la
  // variante. On retient celui qui a vraiment ce qu'on va utiliser.
  ort = module.InferenceSession ? module : (module.default ?? module);
  if (!ort?.InferenceSession) throw new Error('ONNX Runtime absent : lancez « npm run vendor »');

  ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
  const coeurs = navigator.hardwareConcurrency || 2;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, coeurs) : 1;
  ort.env.wasm.simd = true;
  ort.env.logLevel = 'error';
  return ort;
}

/** Marqueurs du vocabulaire piper, communs à tous les modèles. */
const DEBUT = '^';
const FIN = '$';
const REMPLISSAGE = '_';

/**
 * Traduit des phonèmes en identifiants attendus par le modèle.
 *
 * @param {string[]} phonemes points de code IPA
 * @param {Record<string, number[]>} table `phoneme_id_map` du fichier de config
 * @returns {{ids: BigInt64Array, inconnus: string[]}}
 */
export function phonemesEnIds(phonemes, table) {
  const ids = [];
  const inconnus = [];

  const pousser = (p) => { const v = table[p]; if (v) ids.push(...v); };

  pousser(DEBUT);
  pousser(REMPLISSAGE);
  for (const p of phonemes) {
    if (!table[p]) { inconnus.push(p); continue; }
    ids.push(...table[p]);
    pousser(REMPLISSAGE);
  }
  pousser(FIN);

  return { ids: BigInt64Array.from(ids, BigInt), inconnus };
}

const decodeurUtf8 = new TextDecoder();

/**
 * Ouvre un modèle de voix.
 *
 * @param {{model: ArrayBuffer, config: ArrayBuffer}} fichiers
 * @returns {Promise<{sampleRate:number, synthesize:Function, dispose:Function}>}
 */
export async function createPiperEngine(fichiers) {
  const config = JSON.parse(decodeurUtf8.decode(fichiers.config));
  const table = config.phoneme_id_map;
  if (!table) throw new Error('configuration sans table de phonèmes');

  const sampleRate = config.audio?.sample_rate || 22050;
  const nbLocuteurs = config.num_speakers || 1;
  const inference = config.inference || {};
  const bruit = inference.noise_scale ?? 0.667;
  const bruitW = inference.noise_w ?? 0.8;
  const longueurBase = inference.length_scale ?? 1;

  const runtime = await chargerOrt();
  const session = await runtime.InferenceSession.create(fichiers.model, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });

  // Les synthèses s'exécutent l'une après l'autre : une session ONNX n'est
  // pas réentrante, et le lecteur en lance volontiers trois d'avance.
  let file = Promise.resolve();

  /** Phonèmes déjà signalés comme absents, pour ne pas inonder la console. */
  const dejaSignales = new Set();

  async function inferer(texte, { rate = 1, speaker = null } = {}) {
    const phonemes = phonemiser(texte);
    const { ids, inconnus } = phonemesEnIds(phonemes, table);

    for (const p of inconnus) {
      if (dejaSignales.has(p)) continue;
      dejaSignales.add(p);
      console.warn(`Voxlire : phonème « ${p} » absent de ce modèle, ignoré.`);
    }

    // Deux marqueurs et un remplissage : rien à dire.
    if (ids.length <= 3) return new Float32Array(0);

    // Le débit est l'inverse de l'échelle de durée : parler plus vite, c'est
    // raccourcir chaque phonème.
    const echelleLongueur = longueurBase / Math.max(0.1, rate);

    const entrees = {
      input: new runtime.Tensor('int64', ids, [1, ids.length]),
      input_lengths: new runtime.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
      scales: new runtime.Tensor('float32', Float32Array.from([bruit, echelleLongueur, bruitW]), [3]),
    };
    if (nbLocuteurs > 1) {
      entrees.sid = new runtime.Tensor('int64', BigInt64Array.from([BigInt(speaker ?? 0)]), [1]);
    }

    const sortie = await session.run(entrees);
    const premier = sortie[session.outputNames[0]];
    const pcm = premier.data;

    // Le modèle rend [1, 1, échantillons] ; on n'a besoin que du dernier axe.
    return pcm instanceof Float32Array ? pcm : Float32Array.from(pcm);
  }

  return {
    sampleRate,

    /**
     * @param {string} texte une phrase, déjà découpée par prosody.js
     * @param {{rate?:number, speaker?:number|null}} options
     * @returns {Promise<Float32Array>} mono, à `sampleRate`
     */
    synthesize(texte, options) {
      const suivant = file.then(() => inferer(texte, options));
      // La file ne doit pas se rompre sur un échec : on la relance quoi qu'il
      // arrive, sinon une phrase fautive gèlerait tout le livre.
      file = suivant.catch(() => {});
      return suivant;
    },

    async dispose() {
      try { await session.release(); } catch { /* déjà libérée */ }
    },
  };
}
