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
 * On rogne donc ce silence pour reprendre la main. Le reste — la longueur
 * des virgules — se décide dans prosody.js, sur le texte, où l'on sait
 * exactement où sont les virgules.
 *
 * Une version antérieure de ce module allongeait aussi les creux INTERNES,
 * repérés à l'oreille dans le signal. C'était une erreur, et elle s'entendait :
 * mesuré sur le modèle siwis, un creux de virgule dure 150 à 354 ms et une
 * pause inter-mot ordinaire va jusqu'à 289 ms. Les deux se recouvrent
 * entièrement, aucun seuil ne les sépare, et une phrase sans la moindre
 * virgule se retrouvait hachée par deux silences ajoutés au mauvais endroit.
 * On ne devine pas dans l'audio ce que le texte dit déjà.
 *
 * Ce module ne connaît ni le lecteur ni le moteur : il ne voit que des
 * échantillons, ce qui le rend testable sans carte son.
 */

/**
 * Seuil de silence.
 *
 * -60 dBFS et non -45 : à -45 on coupe la voix. Mesuré sur « Un matin le roi
 * la surprit », le silence final vaut 70 ms à -45 dBFS mais 30 ms à -60 —
 * les 40 ms d'écart sont la détente du t final, et la rogner faisait avaler
 * la fin du mot.
 */
const SEUIL = 10 ** (-60 / 20);

/** Fenêtre d'analyse : assez courte pour un plosif, assez longue pour être stable. */
const FENETRE = 0.005;

const DEFAUTS = {
  sampleRate: 22050,
  /** Silence conservé de part et d'autre, pour ne pas attaquer sec. */
  garde: 0.020,
  /** Fondu aux extrémités : sans lui, la coupe claque. */
  fondu: 0.006,
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
 * Chaîne complète : rogner puis fondre.
 * @param {Float32Array} pcm
 * @param {object} options voir DEFAUTS
 * @returns {Float32Array}
 */
export function mettreEnForme(pcm, options = {}) {
  if (!pcm || !pcm.length) return pcm || new Float32Array(0);
  return fondre(rogner(pcm, options), options);
}

export const __test__ = { SEUIL, FENETRE, DEFAUTS };
