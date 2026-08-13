/**
 * nombres.js — tout ce qui s'écrit en chiffres et se lit en lettres.
 *
 * Le découpage de prosody.js laisse le texte tel quel : « 1789 » y reste
 * « 1789 ». Un phonémiseur, lui, ne sait rien faire d'un chiffre. Ce module
 * comble le trou, juste avant la phonémisation.
 *
 * L'orthographe compte ici plus qu'on ne croit : « quatre-vingts » et
 * « quatre-vingt » ne se prononcent pas différemment, mais « deux cents »
 * et « deux cent mille » passent par le même code, et une règle fausse
 * finirait par s'entendre ailleurs. On applique donc les vraies règles
 * d'accord de « vingt » et « cent » plutôt que de s'en remettre au hasard.
 */

const UNITES = [
  'zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit',
  'neuf', 'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize',
];

const DIZAINES = {
  2: 'vingt', 3: 'trente', 4: 'quarante', 5: 'cinquante',
  6: 'soixante', 7: 'soixante', 8: 'quatre-vingt', 9: 'quatre-vingt',
};

/** Échelles longues, au singulier et au pluriel. */
const ECHELLES = [
  null,
  ['mille', 'mille'],            // invariable
  ['million', 'millions'],
  ['milliard', 'milliards'],
  ['billion', 'billions'],
  ['billiard', 'billiards'],
  ['trillion', 'trillions'],
];

/**
 * 0 à 99.
 * @param {boolean} final « vingt » et « cent » ne prennent leur s que s'ils
 *        terminent le nombre : « quatre-vingts » mais « quatre-vingt mille ».
 */
function sousCent(n, final) {
  if (n < 17) return UNITES[n];
  if (n < 20) return `dix-${UNITES[n - 10]}`;

  const d = Math.floor(n / 10);
  const u = n % 10;

  // 70-79 et 90-99 se construisent sur les nombres de 10 à 19.
  if (d === 7 || d === 9) {
    const base = d === 7 ? 'soixante' : 'quatre-vingt';
    const reste = n - (d === 7 ? 60 : 80);
    // « soixante et onze », mais « quatre-vingt-onze » sans « et ».
    if (d === 7 && reste === 11) return 'soixante et onze';
    return `${base}-${sousCent(reste, final)}`;
  }

  if (u === 0) return DIZAINES[d] + (d === 8 && final ? 's' : '');
  // « vingt et un » … « soixante et un », mais « quatre-vingt-un ».
  if (u === 1 && d !== 8) return `${DIZAINES[d]} et un`;
  return `${DIZAINES[d]}-${UNITES[u]}`;
}

/** 0 à 999. */
function centaines(n, final) {
  if (n < 100) return sousCent(n, final);

  const c = Math.floor(n / 100);
  const reste = n % 100;

  if (reste === 0) {
    if (c === 1) return 'cent';
    return `${UNITES[c]} cent${final ? 's' : ''}`;
  }
  const tete = c === 1 ? 'cent' : `${UNITES[c]} cent`;
  return `${tete} ${sousCent(reste, final)}`;
}

/**
 * Écrit un entier en toutes lettres.
 * @param {number|bigint} valeur
 */
export function enLettres(valeur) {
  let n = typeof valeur === 'bigint' ? valeur : BigInt(Math.trunc(Number(valeur)));
  if (n === 0n) return 'zéro';

  const signe = n < 0n ? 'moins ' : '';
  if (n < 0n) n = -n;

  // Tranches de trois chiffres, des unités vers les grands nombres.
  const tranches = [];
  while (n > 0n) { tranches.push(Number(n % 1000n)); n /= 1000n; }

  if (tranches.length > ECHELLES.length) return signe + chiffreAChiffre(String(valeur));

  const morceaux = [];
  for (let i = tranches.length - 1; i >= 0; i--) {
    const groupe = tranches[i];
    if (groupe === 0) continue;

    if (i === 0) {
      morceaux.push(centaines(groupe, true));
    } else if (i === 1) {
      // « mille » ne se multiplie pas au pluriel, et ne prend jamais de s.
      morceaux.push(groupe === 1 ? 'mille' : `${centaines(groupe, false)} mille`);
    } else {
      const [sing, plur] = ECHELLES[i];
      // Ici l'échelle est un nom : « deux cents millions » garde son s.
      morceaux.push(groupe === 1 ? `un ${sing}` : `${centaines(groupe, true)} ${plur}`);
    }
  }
  return signe + morceaux.join(' ');
}

/** Écrit un rang : premier, deuxième, vingt et unième… */
export function ordinal(n, feminin = false) {
  if (n === 1) return feminin ? 'première' : 'premier';

  let base = enLettres(n);
  base = base.replace(/s$/, '');            // quatre-vingts -> quatre-vingtième
  if (base.endsWith('e')) base = base.slice(0, -1);   // quatre -> quatrième
  else if (base.endsWith('q')) base += 'u';           // cinq   -> cinquième
  else if (base.endsWith('f')) base = `${base.slice(0, -1)}v`; // neuf -> neuvième
  return `${base}ième`;
}

/** Lit une suite de chiffres un par un : matricules, numéros interminables. */
function chiffreAChiffre(chaine) {
  return [...chaine].map((c) => (c >= '0' && c <= '9' ? UNITES[Number(c)] : c)).join(' ').trim();
}

// ---------------------------------------------------------------------------
// Chiffres romains
// ---------------------------------------------------------------------------

const ROMAINS = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
const RE_ROMAIN = /^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;

/** @returns {number|null} la valeur, ou null si ce n'est pas un romain valide. */
export function valeurRomaine(mot) {
  if (!mot || !RE_ROMAIN.test(mot)) return null;
  let total = 0;
  for (let i = 0; i < mot.length; i++) {
    const v = ROMAINS[mot[i]];
    const suivant = ROMAINS[mot[i + 1]];
    total += suivant > v ? -v : v;
  }
  return total || null;
}

/**
 * Mots après lesquels un chiffre romain isolé est certain — sans quoi
 * « J'ai vu X » ferait dire « dix » à la lettre X, et « Ce livre I » au
 * pronom. On exige donc soit deux lettres, soit un mot déclencheur avant.
 */
const AVANT_ROMAIN = new Set([
  'chapitre', 'chapitres', 'livre', 'livres', 'tome', 'tomes', 'partie',
  'parties', 'acte', 'actes', 'scène', 'scènes', 'section', 'sections',
  'titre', 'titres', 'volume', 'volumes', 'annexe', 'annexes', 'article',
  'articles', 'siècle', 'siècles', 'guerre', 'régiment', 'arrondissement',
  'louis', 'charles', 'henri', 'philippe', 'napoléon', 'françois', 'jean',
  'pie', 'benoît', 'paul', 'georges', 'édouard', 'élisabeth', 'catherine',
  'pierre', 'nicolas', 'alexandre', 'frédéric', 'guillaume', 'richard',
]);

/**
 * Sigles courants qui sont, par malchance, des chiffres romains valides.
 * « MM » vaut 2000, « CD » vaut 400, « CM » 900, « XL » 40 : sans cette
 * liste, « les MM. Dupont » et « une taille XL » deviendraient des nombres.
 */
const FAUX_ROMAINS = new Set([
  'MM', 'CD', 'CM', 'CV', 'XL', 'DC', 'MD', 'MC', 'IV', 'ID', 'DI', 'LI',
  'CI', 'MI', 'LC', 'DL', 'CL', 'VI', 'IL', 'LM', 'XI', 'MIX', 'DIX', 'CIL',
  'VIC', 'MIL', 'LIV', 'DVD', 'MMS', 'CDI', 'CDD', 'CDC', 'LCD', 'LID',
]);

// ---------------------------------------------------------------------------
// Unités, monnaies, abréviations
// ---------------------------------------------------------------------------

/** [singulier, pluriel] — le pluriel sert dès que le nombre dépasse 1. */
const UNITES_MESURE = {
  km: ['kilomètre', 'kilomètres'],
  m: ['mètre', 'mètres'],
  cm: ['centimètre', 'centimètres'],
  mm: ['millimètre', 'millimètres'],
  kg: ['kilogramme', 'kilogrammes'],
  g: ['gramme', 'grammes'],
  mg: ['milligramme', 'milligrammes'],
  t: ['tonne', 'tonnes'],
  l: ['litre', 'litres'],
  ml: ['millilitre', 'millilitres'],
  cl: ['centilitre', 'centilitres'],
  h: ['heure', 'heures'],
  min: ['minute', 'minutes'],
  s: ['seconde', 'secondes'],
  ms: ['milliseconde', 'millisecondes'],
  'km/h': ['kilomètre-heure', 'kilomètres-heure'],
  'm²': ['mètre carré', 'mètres carrés'],
  'km²': ['kilomètre carré', 'kilomètres carrés'],
  'm³': ['mètre cube', 'mètres cubes'],
  '°': ['degré', 'degrés'],
  '°c': ['degré Celsius', 'degrés Celsius'],
  '°f': ['degré Fahrenheit', 'degrés Fahrenheit'],
  ko: ['kilooctet', 'kilooctets'],
  mo: ['mégaoctet', 'mégaoctets'],
  go: ['gigaoctet', 'gigaoctets'],
  to: ['téraoctet', 'téraoctets'],
};

const MONNAIES = {
  '€': ['euro', 'euros'],
  $: ['dollar', 'dollars'],
  '£': ['livre sterling', 'livres sterling'],
  '¥': ['yen', 'yens'],
  '₽': ['rouble', 'roubles'],
  '₹': ['roupie', 'roupies'],
  '₩': ['won', 'wons'],
};

/**
 * Titres de civilité. Ils s'écrivent TOUJOURS avec une majuscule, et c'est
 * heureux : « Me » est maître, mais « me » est un pronom qu'on rencontre
 * dix fois par page. On exige donc la majuscule, sans quoi « il me dit »
 * deviendrait « il maître dit ».
 */
const CIVILITES = {
  'M.': 'monsieur',
  MM: 'messieurs',
  'MM.': 'messieurs',
  Mme: 'madame',
  Mmes: 'mesdames',
  Mlle: 'mademoiselle',
  Mlles: 'mesdemoiselles',
  Dr: 'docteur',
  'Dr.': 'docteur',
  Pr: 'professeur',
  'Pr.': 'professeur',
  Me: 'maître',
  Mgr: 'monseigneur',
  St: 'saint',
  Ste: 'sainte',
  Sts: 'saints',
  Stes: 'saintes',
};

/** Abréviations sans ambiguïté : la casse n'y change rien. */
const ABREVIATIONS = {
  'n°': 'numéro',
  'nº': 'numéro',
  etc: 'et cetera',
  'etc.': 'et cetera',
  'cf.': 'confer',
  'pp.': 'pages',
  'av.': 'avenue',
  'bd.': 'boulevard',
  'ex.': 'exemple',
  'art.': 'article',
  'chap.': 'chapitre',
  'vol.': 'volume',
  'éd.': 'édition',
  'trad.': 'traduction',
  'env.': 'environ',
  'tél.': 'téléphone',
  'j.-c.': 'Jésus-Christ',
};

/** Symboles isolés qui se lisent, quand ils tiennent lieu de mot. */
const SYMBOLES = {
  '&': 'et',
  '%': 'pour cent',
  '‰': 'pour mille',
  '+': 'plus',
  '=': 'égale',
  '±': 'plus ou moins',
  '×': 'fois',
  '÷': 'divisé par',
  '<': 'inférieur à',
  '>': 'supérieur à',
  '©': 'copyright',
  '®': 'marque déposée',
  '§': 'paragraphe',
  '†': 'mort en',
  '@': 'arobase',
};

// ---------------------------------------------------------------------------
// Développement du texte
// ---------------------------------------------------------------------------

// Les séparateurs de milliers admis sont l'espace insécable et l'espace fine :
// surtout pas l'espace ordinaire, qui avalerait le mot suivant.
const RE_NOMBRE = /\d+(?:[  ]\d{3})*(?:[.,]\d+)?/;

/** Suffixes de rang qui réclament le féminin : « 1re », « 2de », « Ire ». */
const FEMININS = new Set(['re', 'res', 'ère', 'ères', 'de', 'des']);

/**
 * Échappe pour une expression régulière. En mode Unicode, échapper un
 * caractère qui n'a rien de spécial — « ° », « ² » — est une erreur de
 * syntaxe : on s'en tient donc strictement aux métacaractères.
 */
function echapper(chaine) {
  return chaine.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}

/** Lit la partie décimale : « 3,5 » -> « trois virgule cinq ». */
function decimales(chiffres) {
  // Deux chiffres se lisent comme un nombre (« virgule vingt-cinq »),
  // au-delà on épelle : « virgule un quatre un cinq » reste intelligible.
  if (chiffres.length <= 2 && chiffres[0] !== '0') return enLettres(Number(chiffres));
  return chiffreAChiffre(chiffres);
}

/** Nombre écrit en chiffres -> nombre écrit en lettres. */
function lireNombre(brut) {
  const nettoye = brut.replace(/[  ]/g, '');
  const [entier, frac] = nettoye.split(/[.,]/);

  // Un zéro en tête n'est pas une quantité : c'est un matricule, une heure,
  // un code. On l'épelle plutôt que d'en faire un nombre.
  if (entier.length > 1 && entier[0] === '0') return chiffreAChiffre(nettoye.replace(/[.,]/g, ' virgule '));
  if (entier.length > 21) return chiffreAChiffre(entier);

  const tete = enLettres(BigInt(entier));
  return frac ? `${tete} virgule ${decimales(frac)}` : tete;
}

/** Accorde l'unité au nombre qui la précède. */
function accorder(paire, valeurBrute) {
  const n = Math.abs(parseFloat(String(valeurBrute).replace(/[  ]/g, '').replace(',', '.')));
  return n >= 2 ? paire[1] : paire[0];
}

/**
 * Développe tout ce qui ne se lit pas tel quel : nombres, unités, monnaies,
 * chiffres romains, abréviations, symboles.
 *
 * @param {string} texte
 * @returns {string} le même texte, prêt à être phonémisé
 */
export function developper(texte) {
  let out = texte;

  // 1. Heures : « 14 h 30 », « 14h30 », « 9 h ».
  out = out.replace(/(\d{1,2})\s*h\s*(\d{2})\b/gi, (_, h, m) =>
    `${enLettres(Number(h))} heure${Number(h) >= 2 ? 's' : ''} ${Number(m) === 0 ? '' : enLettres(Number(m))}`.trim());

  // 2. Monnaie collée au nombre, avant ou après : « 12,50 € », « $30 ».
  const signesMonnaie = Object.keys(MONNAIES).map(echapper).join('');
  out = out.replace(new RegExp(`(${RE_NOMBRE.source})\\s*([${signesMonnaie}])`, 'g'),
    (_, n, sym) => `${lireNombre(n)} ${accorder(MONNAIES[sym], n)}`);
  out = out.replace(new RegExp(`([${signesMonnaie}])\\s*(${RE_NOMBRE.source})`, 'g'),
    (_, sym, n) => `${lireNombre(n)} ${accorder(MONNAIES[sym], n)}`);

  // 3. Pourcentages.
  out = out.replace(new RegExp(`(${RE_NOMBRE.source})\\s*%`, 'g'), (_, n) => `${lireNombre(n)} pour cent`);
  out = out.replace(new RegExp(`(${RE_NOMBRE.source})\\s*‰`, 'g'), (_, n) => `${lireNombre(n)} pour mille`);

  // 4. Rangs écrits en chiffres : « 1er », « 2e », « 3ème », « 21e ».
  out = out.replace(/(?<![\p{L}])(\d+)(ers?|ères?|res?|èmes?|emes?|es?|ds?|des?)(?![\p{L}])/gu,
    (tout, n, suffixe) => ordinal(Number(n), FEMININS.has(suffixe.toLowerCase())));

  // 5. Unités de mesure accolées à un nombre.
  const cles = Object.keys(UNITES_MESURE).sort((a, b) => b.length - a.length).map(echapper);
  out = out.replace(new RegExp(`(${RE_NOMBRE.source})\\s*(${cles.join('|')})(?![\\p{L}\\d])`, 'giu'),
    (tout, n, unite) => {
      const paire = UNITES_MESURE[unite.toLowerCase()];
      return paire ? `${lireNombre(n)} ${accorder(paire, n)}` : tout;
    });

  // 6. Chiffres romains. Le suffixe « e » en fait un rang : « XXe siècle ».
  out = out.replace(/(?<![\p{L}])([IVXLCDM]{1,15})(ers?|ères?|res?|èmes?|es?)?(?![\p{L}])/gu,
    (tout, romain, suffixe, position) => {
      const valeur = valeurRomaine(romain);
      if (!valeur) return tout;

      const declencheur = out.slice(0, position).match(/([\p{L}]+)[^\p{L}]+$/u);
      const annonce = !!declencheur && AVANT_ROMAIN.has(declencheur[1].toLowerCase());

      if (!annonce) {
        // Les sigles qui ressemblent à des romains restent des sigles.
        if (FAUX_ROMAINS.has(romain)) return tout;

        // Une lettre seule est d'abord un mot : « Le », « Ce », « De »,
        // « Me » ouvrent des phrases entières. Seuls I, V et X s'emploient
        // vraiment seuls comme nombres — et encore, jamais sans suffixe.
        if (romain.length === 1 && (!suffixe || !'IVX'.includes(romain))) return tout;
      }

      if (suffixe) return ordinal(valeur, FEMININS.has(suffixe.toLowerCase()));
      return valeur === 1 && annonce ? 'premier' : enLettres(valeur);
    });

  // 7. Nombres restants.
  out = out.replace(new RegExp(RE_NOMBRE.source, 'g'), (n) => lireNombre(n));

  // 8. Civilités : la majuscule fait foi.
  out = out.replace(/(?<![\p{L}])(M{1,2}\.|M[mgr]?[a-z]{0,3}\.?|Dr\.?|Pr\.?|Ste?s?|St)(?![\p{L}])/gu,
    (mot) => CIVILITES[mot] || mot);

  // 9. Abréviations insensibles à la casse.
  out = out.replace(/(?<![\p{L}\d])(\p{L}+\.?|n[°º])(?![\p{L}])/gu, (mot) => {
    const dev = ABREVIATIONS[mot.toLowerCase()];
    return dev || mot;
  });

  // 10. Symboles isolés, entourés d'espaces ou de bornes.
  for (const [sym, mot] of Object.entries(SYMBOLES)) {
    out = out.split(sym).join(` ${mot} `);
  }

  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

export const __test__ = { sousCent, centaines, chiffreAChiffre, lireNombre, decimales };
