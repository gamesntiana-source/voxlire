/**
 * regles.js — la prononciation du français, écrite en règles.
 *
 * Ce module ne sert PAS à prononcer les mots courants : ceux-là sont dans le
 * lexique (lexique.js), transcrits par eSpeak NG lui-même, donc justes par
 * construction. Les règles ci-dessous servent à tout le reste — noms propres,
 * mots inventés, coquilles, néologismes — c'est-à-dire à ne jamais rester
 * muet devant un mot inconnu.
 *
 * Le mécanisme est un réécriveur gauche-droite : à chaque position du mot on
 * essaie les règles dans l'ordre, la première qui accroche gagne, et on avance
 * de ce qu'elle a consommé. L'ordre du tableau est donc la logique du module :
 * du plus spécifique au plus général.
 *
 * Deux conventions rendent les règles lisibles :
 *  - le mot est encadré de « # », ce qui permet d'écrire « en fin de mot »
 *    comme un simple « (?=#) » ;
 *  - le contexte droit s'exprime en anticipation, jamais en consommant.
 */

const VOY = 'aâàäeéèêëiîïoôöuùûüyœæ';
const V = `[${VOY}]`;
const C = '[bcçdfghjklmnpqrstvwxz]';

/** Consonnes finales qui se prononcent vraiment : « avec », « pour », « chef ». */
const FIN_SONORE = '[cfklqr]';

/**
 * Une voyelle se nasalise quand le n ou le m qui la suit ne repart pas sur
 * une voyelle et n'est pas doublé : « pain » se nasalise, « peine » non,
 * « comme » non plus.
 */
const NAS = `(?!${V}|[nm])`;

/**
 * @type {Array<[string, string]>} [motif, phonèmes]
 * Le motif est inséré tel quel dans une expression régulière ancrée.
 */
const REGLES = [
  // --- terminaisons verbales, avant tout le reste -------------------------
  // « ils abaissèrent » ne se nasalise pas : cette règle DOIT passer avant
  // celles des voyelles nasales, qui sinon avalent le « en » de « -ent ».
  // L'adverbe en « -ment », lui, se nasalise bel et bien.
  // « ils abaisseraient » : ici le e suit une voyelle, donc la condition
  // « après consonne » ne s'applique pas — d'où une règle à part.
  ['aient(?=#)', 'ɛ'],
  ['ment(?=s?#)', 'mɑ̃'],
  ['ent(?=#)', '', 'apresConsonne'],

  // --- suites figées, avant toute autre analyse --------------------------
  // Le n doublé rend sa voyelle à « -tionn- » : afɛksjɔna, pas afɛksjɔ̃na.
  ['tionn', 'sjɔn'],
  // Après un s, le t reste un t : « attestions » et « autogestion ».
  ['(?<=s)tion', 'tjɔ̃'],
  ['tion', 'sjɔ̃'],
  // « exact », « exemple » : le x se sonorise devant une voyelle, mais
  // seulement en tête de mot — « apoplexie » garde son ks.
  [`(?<=#)ex(?=${V})`, 'ɛɡz'],
  ['(?<=#)ex', 'ɛks'],
  ['tiel', 'sjɛl'],
  ['tien(?=t|n)', 'tjɛ̃'],
  ['sch', 'ʃ'],
  // Le ch d'origine grecque sonne k : « chrome », « technique », « chlore ».
  ['ch(?=[rl])', 'k'],
  ['ch', 'ʃ'],
  // « emmener », « emmaillotage » : le m doublé n'empêche pas la nasale.
  ['emm', 'ɑ̃m'],
  ['ph', 'f'],
  ['th', 't'],
  ['gn', 'ɲ'],

  // --- voyelles nasales ---------------------------------------------------
  [`oin${NAS}`, 'wɛ̃'],
  [`ain${NAS}`, 'ɛ̃'],
  [`aim${NAS}`, 'ɛ̃'],
  [`ein${NAS}`, 'ɛ̃'],
  [`eim${NAS}`, 'ɛ̃'],
  [`ien${NAS}`, 'jɛ̃'],
  [`yen${NAS}`, 'jɛ̃'],
  [`éen${NAS}`, 'eɛ̃'],
  [`oen${NAS}`, 'wɛ̃'],
  [`an${NAS}`, 'ɑ̃'],
  [`am${NAS}`, 'ɑ̃'],
  [`en${NAS}`, 'ɑ̃'],
  [`em${NAS}`, 'ɑ̃'],
  [`in${NAS}`, 'ɛ̃'],
  [`im${NAS}`, 'ɛ̃'],
  [`ïn${NAS}`, 'ɛ̃'],
  [`yn${NAS}`, 'ɛ̃'],
  [`ym${NAS}`, 'ɛ̃'],
  // « album », « forum » : le latinisme final se dénasalise.
  ['um(?=#)', 'ɔm'],
  [`un${NAS}`, 'œ̃'],
  [`um${NAS}`, 'œ̃'],
  [`on${NAS}`, 'ɔ̃'],
  [`om${NAS}`, 'ɔ̃'],

  // --- digrammes vocaliques ----------------------------------------------
  ['eau', 'o'],
  ['œu', 'œ'],
  ['oeu', 'œ'],
  ['aou', 'u'],
  ['aoû', 'u'],

  // « eu » s'ouvre ou se ferme selon que la syllabe se ferme après lui.
  [`eu(?=${C}e#)`, 'œ'],
  [`eu(?=${FIN_SONORE}#)`, 'œ'],
  [`eu(?=${C}${C})`, 'œ'],
  ['eu', 'ø'],

  ['au', 'o'],
  ['ou', 'u'],
  ['oû', 'u'],
  ['oi', 'wa'],
  ['oî', 'wa'],
  ['oy', 'waj'],
  // « j'aborderai » se ferme en e, « il aborderait » reste ouvert en ɛ :
  // c'est tout l'écart entre le futur et le conditionnel.
  ['ai(?=#)', 'e'],
  ['ai', 'ɛ'],
  ['aî', 'ɛ'],
  ['ay', 'ɛj'],
  ['ei', 'ɛ'],
  ['ey', 'ɛj'],
  ['uy', 'ɥij'],
  ['ui', 'ɥi'],

  // --- semi-voyelles et mouillures ---------------------------------------
  ['ill', 'ij'],
  ['ail(?=s?#)', 'aj'],
  ['eil(?=s?#)', 'ɛj'],
  ['euil(?=s?#)', 'œj'],
  ['ueil(?=s?#)', 'œj'],
  ['ouil(?=s?#)', 'uj'],
  // « afféteries », « acidifie » : en fin de mot le i garde sa valeur de
  // voyelle, et le e qui le suit est muet.
  ['ie(?=s?#)', 'i'],
  // Après un groupe consonantique, le i ne se réduit pas en yod : on dit
  // abatʁiɔ̃ et non abatʁjɔ̃, faute de quoi la syllabe serait imprononçable.
  [`(?<=[pbtdkgfv][rl])i(?=${V})`, 'i'],
  // Verbes en -ier : « acidifierai » se dit asidifiʁe, le i restant voyelle.
  // « bière » et « pierre » y échappent, l'un par son accent, l'autre par
  // son r doublé.
  [`ie(?=r${V})`, 'i'],
  [`i(?=${V})`, 'j'],
  [`y(?=${V})`, 'j'],

  // --- consonnes à double valeur -----------------------------------------
  ['qu', 'k'],
  ['gu(?=[eéèêiîy])', 'ɡ'],
  ['ge(?=[aou])', 'ʒ'],
  ['c(?=[eéèêiîyœæ])', 's'],
  ['ç', 's'],
  ['cc(?=[eéèêiîy])', 'ks'],
  ['cu(?=eil)', 'k'],
  ['g(?=[eéèêiîy])', 'ʒ'],
  [`ss`, 's'],
  // Un s seul entre deux voyelles sonne z : « rose », « maison ».
  [`s(?=${V})`, 'z', 'entreVoyelles'],
  ['x(?=#)', ''],
  ['x', 'ks'],

  // --- e, la voyelle la plus capricieuse ----------------------------------
  ['er(?=#)', 'e'],
  ['ez(?=#)', 'e'],
  ['es(?=#)', ''],
  ['e(?=#)', ''],
  // En tête de mot, une consonne doublée ne ferme pas la voyelle :
  // « effacer » se dit efase, « effraction » efʁaksjɔ̃.
  ['(?<=#)e(?=([bcdfglmnpstz])\\1)', 'e'],
  // Le préfixe « re- » garde son e caduc même devant une consonne doublée :
  // « ressembler » se dit ʁəsɑ̃ble, quand « restaurer » se dit ʁɛstoʁe.
  ['(?<=#r)e(?=([bcdfglmnpstz])\\1)', 'ə'],
  // Devant une attaque possible — occlusive puis liquide — la syllabe reste
  // ouverte : « retrace » se dit ʁətʁas, quand « restaure » se dit ʁɛstoʁ.
  ['e(?=[pbtdcgkfv][rl])', 'ə'],
  [`e(?=${C}${C})`, 'ɛ'],
  [`e(?=${FIN_SONORE}#)`, 'ɛ'],
  ['é', 'e'],
  ['è', 'ɛ'],
  ['ê', 'ɛ'],
  ['ë', 'ɛ'],
  ['e', 'ə'],

  // --- voyelles simples ---------------------------------------------------
  // Le circonflexe allonge : eSpeak transcrit « abritât » abʁitaː.
  ['â', 'aː'],
  ['à', 'a'],
  ['a', 'a'],
  ['î', 'i'],
  ['ï', 'i'],
  ['i', 'i'],
  ['ô', 'o'],
  // Le o se ferme en syllabe ouverte (« poli ») et s'ouvre en syllabe
  // fermée (« porte », « sol »). Une consonne finale muette ne ferme rien.
  [`o(?=${C}${V})`, 'o'],
  ['o(?=[bdgmnpstxz]?s?#)', 'o'],
  ['o', 'ɔ'],
  ['û', 'y'],
  ['ù', 'y'],
  ['ü', 'y'],
  ['u', 'y'],
  ['y', 'i'],
  ['œ', 'œ'],
  ['æ', 'e'],

  // --- consonnes doubles, qui ne se prononcent qu'une fois -----------------
  ['bb', 'b'], ['cc', 'k'], ['dd', 'd'], ['ff', 'f'], ['gg', 'ɡ'],
  ['ll', 'l'], ['mm', 'm'], ['nn', 'n'], ['pp', 'p'], ['rr', 'ʁ'],
  ['tt', 't'], ['zz', 'z'],

  // --- consonnes finales muettes ------------------------------------------
  // Le français ne prononce pas ses fins de mot, à quelques exceptions près.
  // Le s du pluriel n'y change rien : « abaissants » se dit abɛsɑ̃, donc la
  // consonne qui précède ce s final se tait elle aussi.
  ['[bdgmnpstxz](?=s?#)', ''],

  // --- consonnes simples --------------------------------------------------
  ['b', 'b'], ['c', 'k'], ['d', 'd'], ['f', 'f'], ['g', 'ɡ'],
  ['h', ''], ['j', 'ʒ'], ['k', 'k'], ['l', 'l'], ['m', 'm'],
  ['n', 'n'], ['p', 'p'], ['q', 'k'], ['r', 'ʁ'], ['s', 's'],
  ['t', 't'], ['v', 'v'], ['w', 'w'], ['z', 'z'],
];

const RE_VOY = new RegExp(V);
const RE_CONS = new RegExp(C);

/** Conditions de contexte gauche, que l'anticipation ne sait pas exprimer. */
const CONDITIONS = {
  entreVoyelles: (mot, i) => RE_VOY.test(mot[i - 1]),
  apresConsonne: (mot, i) => RE_CONS.test(mot[i - 1]),
};

/** Compilation unique : une expression ancrée par règle. */
const COMPILEES = REGLES.map(([motif, sortie, condition]) => ({
  re: new RegExp(motif, 'y'),
  sortie,
  condition: condition ? CONDITIONS[condition] : null,
}));

const VOY_IPA = '[aɑeɛioɔuyøœæ][̃ː]?';
// Les semi-voyelles comptent ici comme des consonnes : « accastillera »
// perd son e caduc — akastijʁa — exactement comme « abandonnera ».
const CONS_IPA = '[bdfɡklmnpstvzʃʒɲŋʁjwɥ]?';

/**
 * Chute du e caduc, dite loi des trois consonnes.
 *
 * « abandonnera » perd son e — abɑ̃dɔnʁa — parce qu'il ne reste qu'une
 * consonne autour. « aborderai » le garde — abɔʁdəʁe — parce que le supprimer
 * imposerait trois consonnes d'affilée, que le français refuse de prononcer.
 */
const RE_SCHWA = new RegExp(`(${VOY_IPA}${CONS_IPA})ə(?=[ʁm]${VOY_IPA})`, 'g');

/**
 * Prononce un mot inconnu du lexique.
 *
 * @param {string} mot en minuscules, sans ponctuation
 * @returns {string} phonèmes IPA, sans marque d'accent tonique
 */
export function prononcer(mot) {
  const encadre = `#${mot}#`;
  let out = '';
  let i = 1;

  while (i < encadre.length - 1) {
    let avance = false;

    for (const { re, sortie, condition } of COMPILEES) {
      re.lastIndex = i;
      const m = re.exec(encadre);
      if (!m) continue;
      if (condition && !condition(encadre, i)) continue;

      out += sortie;
      i += m[0].length;
      avance = true;
      break;
    }

    // Caractère qu'aucune règle ne connaît : on le saute plutôt que de
    // boucler indéfiniment dessus.
    if (!avance) i++;
  }

  return out.replace(RE_SCHWA, '$1');
}

export const __test__ = { REGLES, VOY, C };
