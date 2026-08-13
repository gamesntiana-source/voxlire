/**
 * lexique.js — le dictionnaire de prononciation.
 *
 * Les règles de regles.js savent lire un mot inconnu ; ce module sait lire
 * les mots que le français prononce mal. « Femme », « monsieur », « second »,
 * « oignon », « fils », « est », toutes les conjugaisons en « -ent » : aucune
 * règle ne les attrape, et ce sont précisément les mots qu'on lit sans arrêt.
 *
 * Le contenu vient d'eSpeak NG lui-même (voir scripts/lexique.mjs), c'est-à-dire
 * du phonémiseur avec lequel les modèles Piper ont été entraînés. Ce n'est donc
 * pas « une » prononciation, c'est celle que le modèle attend.
 *
 * Le fichier est livré tel quel, trié, et consulté par dichotomie directement
 * dans la chaîne. Le découper en Map coûterait une bonne seconde au démarrage
 * et plusieurs dizaines de mégaoctets de mémoire, pour rien : on cherche
 * quelques milliers de mots par livre, pas trois cent mille.
 */

import { DONNEES } from './lexique-data.js';

/** Début de la ligne qui contient l'index `i`. */
function debutDeLigne(i) {
  const n = DONNEES.lastIndexOf('\n', i);
  return n + 1;
}

/**
 * Cherche un mot dans le lexique.
 *
 * @param {string} mot en minuscules, normalisé NFC
 * @returns {string|null} les phonèmes, sans marque d'accent tonique
 */
export function chercher(mot) {
  // `bas` est toujours un début de ligne ; `haut` une borne exclusive.
  let bas = 0;
  let haut = DONNEES.length;

  while (bas < haut) {
    const milieu = (bas + haut) >> 1;
    const debut = debutDeLigne(milieu);

    const saut = DONNEES.indexOf('\n', debut);
    const fin = saut < 0 ? DONNEES.length : saut;
    const separateur = DONNEES.indexOf(' ', debut);
    const coupe = separateur < 0 || separateur > fin ? fin : separateur;
    const cle = DONNEES.slice(debut, coupe);

    if (cle === mot) return coupe === fin ? '' : DONNEES.slice(coupe + 1, fin);

    if (cle < mot) {
      // Après la ligne courante : `fin + 1` dépasse toujours `bas`, donc
      // l'intervalle se réduit vraiment à chaque tour.
      bas = fin + 1;
    } else {
      // La ligne examinée est déjà trop loin. Si c'est la première du
      // domaine, le mot n'y est pas — sans ce test, chercher un mot situé
      // sur la seconde ligne d'un domaine de deux ne le trouverait jamais.
      if (debut <= bas) return null;
      haut = debut;
    }
  }
  return null;
}

/** Nombre d'entrées — sert aux tests et au diagnostic. */
export function taille() {
  let n = 0;
  for (let i = 0; i < DONNEES.length; i++) if (DONNEES.charCodeAt(i) === 10) n++;
  return DONNEES.endsWith('\n') ? n : n + 1;
}
