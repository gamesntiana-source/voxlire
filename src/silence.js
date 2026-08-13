/**
 * silence.js — mise en forme des silences, avant de poser le son sur l'horloge.
 *
 * Un modèle VITS ne rend pas une phrase nue : il l'emballe dans du silence,
 * et pas toujours la même quantité. Mesuré sur le modèle siwis : 133 ms en
 * moyenne avant la voix, 137 ms après, mais avec des écarts de 25 à 190 ms
 * d'une phrase à l'autre. Ce silence-là s'ajoute au nôtre, si bien que la
 * pause réellement entendue n'est jamais celle qu'on a décidée, et qu'elle
 * varie d'une phrase à l'autre sans que rien dans le texte ne le justifie.
 * C'est exactement ce qui fait « robot » : un rythme irrégulier sans raison.
 *
 * On rogne donc ce silence pour reprendre la main, puis on rallonge les
 * creux internes — ceux des virgules, que le modèle expédie en 150 ms là où
 * une voix humaine en prend 400. Allonger un silence est acoustiquement
 * gratuit : on insère des zéros, il n'y a rien à raccorder.
 *
 * Ce module ne connaît ni le lecteur ni le moteur : il ne voit que des
 * échantillons, ce qui le rend testable sans carte son.
 */

/** Seuil de silence. -45 dBFS laisse passer les fins de phrase soufflées. */
const SEUIL = 10 ** (-45 / 20);

/** Fenêtre d'analyse : assez courte pour un plosif, assez longue pour être stable. */
const FENETRE = 0.005;

const DEFAUTS = {
  sampleRate: 22050,
  /** Silence conservé de part et d'autre, pour ne pas attaquer sec. */
  garde: 0.015,
  /** Fondu aux extrémités : sans lui, la coupe claque. */
  fondu: 0.006,
  /** Creux à partir duquel on considère une vraie pause, pas une occlusive. */
  creuxMinimum: 0.13,
  /** Durée visée pour un creux interne. 0 désactive l'étirement. */
  creuxVise: 0.42,
  /** Plafond : au-delà d'une seconde, une pause cesse d'être entendue comme telle. */
  creuxMaximum: 0.9,
};

/**
 * Énergie par fenêtre. Renvoie un tableau de RMS et la taille de fenêtre
 * effectivement utilisée, en échantillons.
 */
function energie(pcm, sampleRate) {
  const pas = Math.max(1, Math.round(FENETRE * sampleRate));
  const n = Math.floor(pcm.length / pas);
  const rms = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let somme = 0;
    const base = f * pas;
    for (let k = 0; k < pas; k++) somme += pcm[base + k] * pcm[base + k];
    rms[f] = Math.sqrt(somme / pas);
  }
  return { rms, pas };
}

/**
 * Retire le silence de tête et de queue.
 *
 * Un tampon entièrement silencieux ressort intact : c'est du silence voulu
 * (une phrase que le moteur a refusé de dire, un blanc délibéré), pas un
 * emballage à retirer. Le supprimer ferait disparaître la phrase.
 */
export function rogner(pcm, options = {}) {
  const { sampleRate, garde } = { ...DEFAUTS, ...options };
  if (!pcm.length) return pcm;

  const { rms, pas } = energie(pcm, sampleRate);

  let premier = 0;
  while (premier < rms.length && rms[premier] < SEUIL) premier++;
  if (premier >= rms.length) return pcm;            // que du silence : on n'y touche pas

  let dernier = rms.length - 1;
  while (dernier > premier && rms[dernier] < SEUIL) dernier--;

  const marge = Math.round(garde * sampleRate);
  const debut = Math.max(0, premier * pas - marge);
  const fin = Math.min(pcm.length, (dernier + 1) * pas + marge);

  return debut === 0 && fin === pcm.length ? pcm : pcm.subarray(debut, fin);
}

/**
 * Rallonge les creux internes jusqu'à la durée visée.
 *
 * Seuls les creux d'au moins `creuxMinimum` sont touchés : en dessous, on
 * tomberait sur la fermeture d'un p, d'un t ou d'un k, et allonger celle-là
 * transformerait « porte » en « por…te ».
 */
export function etirerCreux(pcm, options = {}) {
  const opts = { ...DEFAUTS, ...options };
  const { sampleRate, creuxMinimum, creuxVise, creuxMaximum } = opts;
  if (!pcm.length || creuxVise <= 0) return pcm;

  const { rms, pas } = energie(pcm, sampleRate);

  // Bornes de la voix : on ne touche pas aux extrémités, qui relèvent du rognage.
  let premier = 0;
  while (premier < rms.length && rms[premier] < SEUIL) premier++;
  if (premier >= rms.length) return pcm;
  let dernier = rms.length - 1;
  while (dernier > premier && rms[dernier] < SEUIL) dernier--;

  const creux = [];
  let debut = -1;
  for (let f = premier; f <= dernier; f++) {
    if (rms[f] < SEUIL) { if (debut < 0) debut = f; continue; }
    if (debut < 0) continue;
    const duree = ((f - debut) * pas) / sampleRate;
    if (duree >= creuxMinimum) {
      const vise = Math.min(Math.max(duree, creuxVise), creuxMaximum);
      const ajout = Math.round((vise - duree) * sampleRate);
      if (ajout > 0) creux.push({ a: debut * pas, ajout });
    }
    debut = -1;
  }
  if (!creux.length) return pcm;

  const total = creux.reduce((s, c) => s + c.ajout, 0);
  const out = new Float32Array(pcm.length + total);
  let lu = 0;
  let ecrit = 0;
  for (const { a, ajout } of creux) {
    out.set(pcm.subarray(lu, a), ecrit);
    ecrit += a - lu;
    ecrit += ajout;                                  // des zéros, déjà en place
    lu = a;
  }
  out.set(pcm.subarray(lu), ecrit);
  return out;
}

/** Fond les extrémités, pour que le raccord ne claque pas. */
export function fondre(pcm, options = {}) {
  const { sampleRate, fondu } = { ...DEFAUTS, ...options };
  const n = Math.min(Math.round(fondu * sampleRate), Math.floor(pcm.length / 2));
  if (n <= 0) return pcm;

  // On copie : le tampon peut être une vue sur le tableau rendu par le moteur,
  // et le modifier sur place abîmerait la version en cache.
  const out = Float32Array.from(pcm);
  for (let i = 0; i < n; i++) {
    const k = i / n;
    out[i] *= k;
    out[out.length - 1 - i] *= k;
  }
  return out;
}

/**
 * Chaîne complète : rogner, étirer, fondre.
 * @param {Float32Array} pcm
 * @param {object} options voir DEFAUTS
 * @returns {Float32Array}
 */
export function mettreEnForme(pcm, options = {}) {
  if (!pcm || !pcm.length) return pcm || new Float32Array(0);
  return fondre(etirerCreux(rogner(pcm, options), options), options);
}

export const __test__ = { SEUIL, FENETRE, DEFAUTS };
