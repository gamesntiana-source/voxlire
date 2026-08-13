/**
 * phonemes.js — du texte français aux phonèmes attendus par le modèle.
 *
 * Trois sources, dans cet ordre : le lexique (juste par construction, car
 * produit par eSpeak NG lui-même), les règles (pour tout ce que le lexique
 * ignore), et rien d'autre. Le module ajoute ce qu'un dictionnaire ne peut
 * pas contenir : l'élision, l'accent tonique, qui se décide sur le groupe et
 * non sur le mot, et la ponctuation, que le modèle entend vraiment.
 *
 * La sortie est une liste de POINTS DE CODE, pas de syllabes : c'est ainsi
 * que piper indexe son vocabulaire, et c'est pourquoi le tilde d'une voyelle
 * nasale y compte pour un symbole à part entière.
 */

import { developper } from './nombres.js';
import { prononcer } from './regles.js';
import { chercher } from './lexique.js';

/**
 * Formes élidées. Aucun dictionnaire ne les liste — ce ne sont pas des mots —
 * et pourtant « l' », « d' » et « qu' » sont parmi les plus fréquentes du
 * français. Elles se collent au mot suivant sans espace : « c'est » est un
 * seul mot pour la voix.
 */
const ELISIONS = {
  "l'": 'l', "d'": 'd', "j'": 'ʒ', "n'": 'n', "m'": 'm', "t'": 't',
  "s'": 's', "c'": 's', "qu'": 'k', "z'": 'z',
  "jusqu'": 'ʒysk', "lorsqu'": 'lɔʁsk', "puisqu'": 'pɥisk',
  "quelqu'": 'kɛlk', "presqu'": 'pʁɛsk', "aujourd'": 'oʒuʁd',
};

/**
 * Mots que le français ne accentue pas : articles, pronoms clitiques,
 * prépositions brèves. Ils s'appuient sur le mot suivant au lieu de porter
 * leur propre sommet mélodique.
 */
const ATONES = new Set([
  'le', 'la', 'les', 'de', 'du', 'des', 'un', 'une', 'à', 'au', 'aux',
  'et', 'ou', 'en', 'y', 'ne', 'se', 'me', 'te', 'ce', 'je', 'tu', 'il',
  'on', 'nous', 'vous', 'ils', 'que', 'qui', 'si', 'mon', 'ton', 'son',
  'ma', 'ta', 'sa', 'mes', 'tes', 'ses', 'nos', 'vos', 'ces', 'cet',
  'par', 'pour', 'sur', 'dans', 'sans', 'sous', 'chez', 'est', 'sont',
]);

/** Voyelles IPA. Les semi-voyelles (j, w, ɥ) n'en font pas partie. */
const VOYELLES = new Set([...'aɑeɛioɔuyøœəæɐɪʊ']);

const ACCENT = 'ˈ';

/** Ponctuation que piper transmet au modèle, et son effet sur le débit. */
const PONCTUATION = {
  ',': ', ', ':': ': ', ';': '; ', '.': '.', '?': '?', '!': '!', '…': '.',
};

const RE_MOT = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*['’]?/gu;

/**
 * Place l'accent tonique : en français il tombe sur la dernière voyelle
 * pleine du mot, jamais sur un « e » muet.
 */
function accentuer(phonemes) {
  const cars = [...phonemes];
  let cible = -1;
  for (let i = cars.length - 1; i >= 0; i--) {
    if (!VOYELLES.has(cars[i])) continue;
    if (cars[i] === 'ə' && cible >= 0) break;   // on a déjà mieux à droite
    if (cars[i] === 'ə') continue;              // le schwa ne s'accentue pas
    cible = i;
    break;
  }
  if (cible < 0) return phonemes;
  cars.splice(cible, 0, ACCENT);
  return cars.join('');
}

/** Prononce un mot simple : le lexique d'abord, les règles ensuite. */
function motSeul(mot) {
  return chercher(mot) ?? prononcer(mot);
}

/**
 * Prononce un mot du texte, élisions et traits d'union compris.
 * @returns {string} phonèmes sans accent tonique
 */
export function motEnPhonemes(brut) {
  const mot = brut.toLowerCase().normalize('NFC').replace(/’/g, "'");

  // Le lexique connaît des mots composés entiers : on lui laisse sa chance
  // avant de découper quoi que ce soit.
  const direct = chercher(mot);
  if (direct !== null) return direct;

  // Élision : « c'est » se prononce d'un seul tenant.
  const elision = mot.match(/^(.*?['])(.+)$/);
  if (elision && ELISIONS[elision[1]]) {
    return ELISIONS[elision[1]] + motEnPhonemes(elision[2]);
  }

  // Composé : ses membres se prononcent d'un seul souffle, sans coupure.
  // « quatre-vingt-dix » se dit katʁvɛ̃dis, pas katʁ vɛ̃ dis.
  if (mot.includes('-')) {
    return mot.split('-').filter(Boolean).map(motEnPhonemes).join('');
  }

  return motSeul(mot.replace(/'/g, ''));
}

/**
 * Traduit une phrase en phonèmes.
 *
 * @param {string} texte un segment issu de prosody.js
 * @returns {string[]} points de code IPA, prêts pour phonemesEnIds()
 */
export function phonemiser(texte) {
  const developpe = developper(texte);
  const morceaux = [];

  /** La ponctuation se colle au mot qui précède, sans espace avant. */
  const ponctuer = (signe) => {
    if (morceaux[morceaux.length - 1] === ' ') morceaux.pop();
    morceaux.push(signe);
  };

  let position = 0;
  RE_MOT.lastIndex = 0;
  let m;

  while ((m = RE_MOT.exec(developpe))) {
    // Ponctuation rencontrée depuis le mot précédent : le modèle l'entend.
    // C'est elle qui fait respirer la phrase de l'intérieur.
    for (const car of developpe.slice(position, m.index)) {
      const signe = PONCTUATION[car];
      if (signe && signe.endsWith(' ')) { ponctuer(signe.trim()); morceaux.push(' '); }
    }
    position = m.index + m[0].length;

    const brut = m[0];
    const phonemes = motEnPhonemes(brut);
    if (!phonemes) continue;

    const atone = ATONES.has(brut.toLowerCase().normalize('NFC'));
    morceaux.push(atone ? phonemes : accentuer(phonemes), ' ');
  }

  // Ponctuation finale : c'est elle qui donne sa courbe à la phrase. Une
  // question et une affirmation ne se terminent pas sur la même note.
  const reste = developpe.slice(position);
  const finale = [...reste].reverse().find((c) => PONCTUATION[c]);
  if (morceaux[morceaux.length - 1] === ' ') morceaux.pop();
  if (finale && morceaux.length) ponctuer(PONCTUATION[finale].trim());

  // Piper indexe son vocabulaire point de code par point de code, sur une
  // forme décomposée : le tilde d'une nasale y est un symbole distinct.
  return [...morceaux.join('').normalize('NFD')];
}

export const __test__ = { accentuer, ELISIONS, ATONES };
