/**
 * prosody.js — découpage du texte et placement des silences / respirations.
 *
 * Principe : l'unité de synthèse est la PHRASE, jamais le fragment.
 * Le moteur neuronal gère déjà l'intonation interne (virgules, questions) ;
 * le découper plus finement casserait la mélodie et donnerait un débit haché.
 * Ce module s'occupe donc de ce que le moteur ne sait pas faire :
 *   - reconnaître les vraies fins de phrase (et pas « M. Dupont »),
 *   - doser le silence qui suit selon la ponctuation,
 *   - décider où le lecteur reprend son souffle.
 */

const NBSP = /[    ⁠]/;

// Expressions ancrées (drapeau y) : on les positionne sur `lastIndex` au lieu
// de recopier tout le texte restant à chaque caractère. Sur un livre entier,
// c'est la différence entre quelques millisecondes et trois minutes.
const RE_URL = /(?:https?:\/\/|www\.)[^\s<>"')]+/iy;
const RE_MAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/y;
const RE_GROUPED_NUM = /\d{1,3}(?:[    ]\d{3})+/y;
const RE_GROUP_SEP = /[    ]/g;
const RE_DOTS = /\.{3,}/y;
const RE_BLANKS = /[ \t]+/y;

const RE_DIGIT = /\d/;
const RE_SPACE = /\s/;
const RE_LOWER = /[a-zà-öø-ÿ]/;
const RE_UPPER = /\p{Lu}/u;
const RE_WORD_CHAR = /[\p{L}\p{N}]/u;

/** Applique une expression ancrée à la position `i`, sans copier le texte. */
function matchAt(re, text, i) {
  re.lastIndex = i;
  return re.exec(text);
}

// Abréviations après lesquelles un point ne termine pas une phrase.
const ABBREV = new Set([
  // civilités
  'm', 'mm', 'mme', 'mmes', 'mlle', 'mlles', 'mgr', 'me', 'mes', 'dr', 'drs', 'pr',
  'st', 'ste', 'sts', 'stes',
  // adresses
  'av', 'bd', 'bld', 'fg', 'sq', 'pl', 'rte', 'imp', 'app', 'appt',
  // références et renvois
  'cf', 'ex', 'env', 'etc', 'id', 'ibid', 'op', 'cit', 'al', 'vs', 'ca',
  'art', 'chap', 'fig', 'vol', 'ed', 'éd', 'coll', 'trad', 'dir', 'rééd',
  'pp', 'no', 'nos', 'tab', 'ann', 'suppl',
  // sigles courants
  'tel', 'tél', 'fax', 'ref', 'réf', 'doc', 'inf', 'sup', 'min', 'max', 'moy',
  'sté', 'cie', 'sarl', 'sas', 'sasu', 'eurl', 'jc',
  // mois
  'janv', 'févr', 'fév', 'avr', 'juil', 'sept', 'oct', 'nov', 'déc',
  // jours
  'lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim',
]);

// Abréviations d'une seule lettre : ambiguës, donc admises seulement
// si un chiffre suit (« p. 42 », « n. 3 »).
const ABBREV_1_CHAR = new Set(['p', 'n', 'v', 'l', 'f', 't', 's']);

/**
 * Durées de silence de référence, en millisecondes, avant mise à l'échelle.
 *
 * Ces valeurs sont le silence RÉELLEMENT entendu : le lecteur rogne d'abord
 * l'emballage de silence que le modèle ajoute à chaque phrase (voir
 * silence.js), sans quoi on obtiendrait ces durées plus 270 ms imprévisibles.
 *
 * Elles suivent ce qu'on mesure chez les locuteurs : une virgule tient entre
 * 380 et 670 ms, un point entre 810 et 1240, soit un rapport d'environ un à
 * deux ; 600 ms est la durée jugée la plus naturelle à l'écoute. Au-delà
 * d'une seconde, en revanche, un silence cesse d'être entendu comme une
 * pause et commence à passer pour une hésitation — d'où le plafond posé sur
 * la fin de paragraphe.
 */
export const PAUSES = {
  paragraph: 1000,  // ligne vide : on change de sujet, sans dépasser le plafond
  lineBreak: 620,   // simple retour à la ligne
  ellipsis: 800,    // points de suspension : le silence porte le sens
  question: 700,
  exclam: 680,
  period: 680,
  colon: 520,       // annonce ce qui suit, donc suspend
  semicolon: 500,
  dash: 420,
  comma: 420,
  soft: 90,         // coupure sans ponctuation : elle doit s'entendre le moins possible
  none: 0,
};

/**
 * Une pause s'allonge avec ce qui la précède : après une longue phrase, le
 * lecteur prend davantage de temps qu'après trois mots. C'est ce qui évite
 * le rythme au métronome — la variation vient de la structure du texte, pas
 * d'un tirage au sort.
 */
function facteurLongueur(caracteres) {
  return 0.90 + 0.25 * Math.min(1, caracteres / 180);
}

const DEFAULTS = {
  // Scinder une phrase coûte cher : chaque coupure est un trou dans la
  // mélodie. On repousse donc le seuil aussi loin que la latence le permet,
  // le lecteur synthétisant de toute façon plusieurs phrases d'avance.
  maxChars: 500,
  minChunk: 80,         // en dessous, un fragment isolé sonne bancal
  /**
   * Longueur minimale d'une proposition pour qu'on la détache sur sa
   * virgule. En dessous, la couper coûterait plus qu'elle ne rapporte.
   */
  minClause: 24,
  pauseScale: 1,        // curseur « longueur des pauses » de l'interface
  breaths: true,
  breathEvery: 9.5,     // secondes de parole avant de reprendre son souffle
  breathJitter: 3.5,    // variation, pour ne pas respirer au métronome
  charsPerSecond: 14.5, // débit moyen en français, sert à estimer les durées
  simplifyUrls: true,
  seed: 1,
};

/** Générateur pseudo-aléatoire déterministe : mêmes respirations à chaque lecture. */
function makeRandom(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/**
 * Nettoie le texte sans en changer le sens.
 * Renvoie le texte normalisé ET la table de correspondance vers les index
 * du texte d'origine, pour pouvoir surligner la phrase lue à l'écran.
 */
export function normalize(text, opts = {}) {
  const { simplifyUrls } = { ...DEFAULTS, ...opts };
  let out = '';
  const map = []; // map[i] = index dans le texte d'origine

  const push = (str, srcIndex) => {
    for (let k = 0; k < str.length; k++) { out += str[k]; map.push(srcIndex); }
  };

  const src = text.replace(/\r\n?/g, '\n');
  let i = 0;

  while (i < src.length) {
    // Une URL lue caractère par caractère est insupportable : on la résume.
    if (simplifyUrls) {
      const url = matchAt(RE_URL, src, i);
      if (url) { push('un lien', i); i += url[0].length; continue; }
      const mail = matchAt(RE_MAIL, src, i);
      if (mail) { push('une adresse e-mail', i); i += mail[0].length; continue; }
    }

    const ch = src[i];

    // « 1 000 000 » doit se lire comme un nombre, pas comme trois nombres.
    if (RE_DIGIT.test(ch)) {
      const num = matchAt(RE_GROUPED_NUM, src, i);
      if (num) { push(num[0].replace(RE_GROUP_SEP, ''), i); i += num[0].length; continue; }
    }

    // Trois points saisis à la main -> vrai caractère de suspension.
    if (ch === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      const run = matchAt(RE_DOTS, src, i)[0];
      push('…', i); i += run.length; continue;
    }

    if (NBSP.test(ch)) { push(' ', i); i++; continue; }

    // Espaces multiples, mais on préserve les sauts de ligne : ils portent la structure.
    if (ch === ' ' || ch === '\t') {
      push(' ', i); i += matchAt(RE_BLANKS, src, i)[0].length; continue;
    }

    push(ch, i);
    i++;
  }

  // Trois sauts de ligne ou plus valent une seule ligne vide.
  const collapsed = out.replace(/\n{3,}/g, '\n\n');
  if (collapsed !== out) {
    // Recalcule la table après repli (rare, coût négligeable).
    let o2 = '', m2 = [];
    for (let k = 0; k < out.length; k++) {
      if (out[k] === '\n') {
        let run = 0;
        while (out[k + run] === '\n') run++;
        const keep = Math.min(run, 2);
        for (let z = 0; z < keep; z++) { o2 += '\n'; m2.push(map[k]); }
        k += run - 1;
      } else { o2 += out[k]; m2.push(map[k]); }
    }
    return { text: o2, map: m2 };
  }

  return { text: out, map };
}

/** Le point à l'index `i` termine-t-il réellement une phrase ? */
function isSentenceEnd(text, i) {
  const ch = text[i];
  if (ch === '!' || ch === '?' || ch === '…') return true;
  if (ch !== '.') return false;

  // Premier caractère non blanc qui suit, trouvé sans recopier la suite du livre.
  let j = i + 1;
  while (j < text.length && RE_SPACE.test(text[j])) j++;
  const nextChar = j < text.length ? text[j] : null;

  // « 3.14 », « 1.2.3 »
  if (nextChar && RE_DIGIT.test(nextChar) && !RE_SPACE.test(text[i + 1] || '')) return false;

  // Un mot en minuscule ne commence pas une phrase.
  if (nextChar && RE_LOWER.test(nextChar)) return false;

  // Le mot qui précède le point, lu à rebours caractère par caractère.
  let k = i;
  while (k > 0 && RE_WORD_CHAR.test(text[k - 1])) k--;
  if (k < i) {
    const word = text.slice(k, i);
    const lower = word.toLowerCase();

    // « A. Dupont », « J.-C. »
    if (word.length === 1 && RE_UPPER.test(word)) return false;

    // « S.N.C.F. » : lettre isolée précédée d'un point.
    if (word.length === 1 && text[i - 2] === '.') return false;

    if (word.length === 1 && ABBREV_1_CHAR.has(lower)) {
      return !(nextChar && RE_DIGIT.test(nextChar));
    }
    if (ABBREV.has(lower)) return false;
  }

  // Soit une phrase commence après, soit il ne reste que du blanc : fin dans les deux cas.
  return true;
}

/** Type de pause associé au signe de ponctuation qui clôt une phrase. */
function pauseKindFor(mark) {
  if (mark.includes('…')) return 'ellipsis';
  if (mark.includes('?')) return 'question';
  if (mark.includes('!')) return 'exclam';
  return 'period';
}

/** Type de pause associé à une ponctuation interne. */
const PONCTUATION_INTERNE = {
  ',': 'comma', ';': 'semicolon', ':': 'colon', '—': 'dash', '–': 'dash',
};

/**
 * Scinde une phrase à ses ponctuations internes.
 *
 * On pourrait laisser faire le modèle : il marque bien une pause aux
 * virgules. Mais elle dure de 150 à 350 ms selon son humeur, là où une voix
 * humaine en prend 400, et surtout elle est irrégulière — quatre virgules
 * identiques ont donné 115, 249, 165 et 75 ms. En découpant ici, le silence
 * se décide dans PAUSES et devient régulier.
 *
 * L'intonation ne souffre pas de la coupure : la virgule reste attachée au
 * morceau de gauche, si bien que le modèle continue de produire une mélodie
 * suspendue, et non une fin de phrase.
 *
 * On ne coupe que si les deux côtés ont de quoi tenir debout. « Un, deux,
 * trois, partez ! » doit rester d'un seul tenant : quatre fragments d'un mot
 * sonneraient bien plus mécaniques que la pause imparfaite du modèle.
 */
function scinderSurPonctuation(phrase, offset, minClause) {
  const minReste = Math.round(minClause * 0.6);
  const parts = [];
  const re = /\s*([;:,—–])\s+/g;
  let debut = 0;
  let m;

  while ((m = re.exec(phrase))) {
    const coupe = m.index + m[0].length;
    if (coupe - debut < minClause) continue;
    if (phrase.length - coupe < minReste) continue;

    parts.push({
      text: phrase.slice(debut, coupe).trimEnd(),
      start: offset + debut,
      breakKind: PONCTUATION_INTERNE[m[1]],
    });
    debut = coupe;
  }

  parts.push({ text: phrase.slice(debut), start: offset + debut, breakKind: null });
  return parts;
}

/**
 * Scinde une phrase trop longue en s'appuyant sur la ponctuation forte
 * la plus proche du milieu, pour que la coupure s'entende le moins possible.
 */
function splitLong(sentence, offset, maxChars, minChunk) {
  if (sentence.length <= maxChars) {
    return [{ text: sentence, start: offset, breakKind: null }];
  }

  const candidates = [];
  const re = /\s*([;:—–]|,|\)|»)\s+/g;
  let m;
  while ((m = re.exec(sentence))) {
    const cut = m.index + m[0].length;
    if (cut < minChunk || sentence.length - cut < minChunk) continue;
    const sign = m[1];
    const kind = sign === ';' ? 'semicolon'
      : sign === ':' ? 'colon'
      : (sign === '—' || sign === '–') ? 'dash'
      : sign === ',' ? 'comma' : 'dash';
    // Une ponctuation forte prime, puis la proximité du milieu.
    const rank = { colon: 0, semicolon: 0, dash: 1, comma: 2 }[kind];
    candidates.push({ cut, kind, rank, dist: Math.abs(cut - sentence.length / 2) });
  }

  let chosen = null;
  if (candidates.length) {
    candidates.sort((a, b) => (a.rank - b.rank) || (a.dist - b.dist));
    chosen = candidates[0];
  } else {
    // Aucune ponctuation exploitable : on coupe sur un espace, à contrecœur.
    const mid = Math.floor(sentence.length / 2);
    let cut = sentence.lastIndexOf(' ', mid);
    if (cut < minChunk) cut = sentence.indexOf(' ', mid);
    if (cut > minChunk && sentence.length - cut > minChunk) {
      chosen = { cut: cut + 1, kind: 'soft' };
    }
  }

  if (!chosen) return [{ text: sentence, start: offset, breakKind: null }];

  const left = sentence.slice(0, chosen.cut).trimEnd();
  const right = sentence.slice(chosen.cut);
  return [
    ...splitLong(left, offset, maxChars, minChunk).map((p, idx, arr) =>
      idx === arr.length - 1 ? { ...p, breakKind: chosen.kind } : p),
    ...splitLong(right, offset + chosen.cut, maxChars, minChunk),
  ];
}

/** Ponctuations qui laissent la phrase ouverte : la suite en fait partie. */
const CONTINUE = new Set(['soft', 'comma', 'dash', 'semicolon', 'colon']);

/** Réglages de la ligne mélodique, en demi-tons. */
const MELODIE = {
  attaque: 1.9,        // hauteur au début d'un paragraphe
  fond: -1.3,          // hauteur atteinte après quelques phrases
  installation: 4,     // nombre de phrases pour descendre de l'une à l'autre
  suite: -0.35,        // chaque proposition d'une même phrase descend un peu
  question: 0.8,       // une question remonte
  exclamation: 0.5,
  jeu: 0.35,           // variation résiduelle, pour ne pas chanter juste
  /**
   * Garde-fou. La transposition se fait par rééchantillonnage, qui déplace
   * aussi les formants : au-delà de deux demi-tons on ne transpose plus la
   * voix, on en change. Deux demi-tons suffisent largement à sortir du
   * monocorde sans que le lecteur ait l'air de muer.
   */
  limite: 2.0,
  ralenti: 0.94,       // débit de la dernière phrase d'un paragraphe
  jeuDebit: 0.04,
};

/**
 * Attribue à chaque segment sa hauteur (en demi-tons) et son débit relatif.
 * Les deux sont déterministes : deux lectures du même livre sonnent pareil.
 */
function placerLaMelodie(segments, rand) {
  let rang = 0;             // rang de la phrase dans son paragraphe
  let hauteurPhrase = 0;

  segments.forEach((seg, i) => {
    const prec = segments[i - 1];
    const suite = prec && CONTINUE.has(prec.pauseKind);

    if (suite) {
      // Même phrase : on poursuit la descente au lieu de repartir en haut.
      hauteurPhrase += MELODIE.suite;
    } else {
      if (!prec || prec.pauseKind === 'paragraph' || prec.pauseKind === 'lineBreak') rang = 0;
      else rang++;

      const avancement = Math.min(1, rang / MELODIE.installation);
      hauteurPhrase = MELODIE.attaque + (MELODIE.fond - MELODIE.attaque) * avancement;

      if (seg.pauseKind === 'question') hauteurPhrase += MELODIE.question;
      else if (seg.pauseKind === 'exclam') hauteurPhrase += MELODIE.exclamation;
    }

    const brute = hauteurPhrase + (rand() * 2 - 1) * MELODIE.jeu;
    const bornee = Math.max(-MELODIE.limite, Math.min(MELODIE.limite, brute));
    seg.pitch = Math.round(bornee * 100) / 100;

    // La dernière phrase d'un paragraphe se pose : c'est un signal fort.
    const finDeParagraphe = seg.pauseKind === 'paragraph';
    const debit = (finDeParagraphe ? MELODIE.ralenti : 1)
      + (rand() * 2 - 1) * MELODIE.jeuDebit;
    seg.tempo = Math.round(debit * 100) / 100;
  });
}

/**
 * Découpe un texte en segments prêts à être synthétisés.
 *
 * Chaque segment : { index, text, pauseAfter, pauseKind, breathBefore,
 *                    breathDepth, estDuration, start, end, pitch, tempo }
 * `pitch` est une transposition en demi-tons et `tempo` un facteur de débit :
 * ensemble ils dessinent la ligne mélodique du paragraphe.
 * `start`/`end` pointent dans le texte NORMALISÉ ; utilise `map` pour
 * remonter au texte d'origine.
 */
export function segment(rawText, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const { text, map } = normalize(rawText, opts);
  const rand = makeRandom(opts.seed);
  const segments = [];

  const paragraphs = [];
  {
    let start = 0;
    const re = /\n{2,}|\n/g;
    let m;
    while ((m = re.exec(text))) {
      paragraphs.push({
        text: text.slice(start, m.index),
        start,
        after: m[0].length >= 2 ? 'paragraph' : 'lineBreak',
      });
      start = m.index + m[0].length;
    }
    paragraphs.push({ text: text.slice(start), start, after: 'none' });
  }

  for (const para of paragraphs) {
    if (!para.text.trim()) continue;

    // 1. Frontières de phrases.
    const sentences = [];
    let cursor = 0;
    for (let i = 0; i < para.text.length; i++) {
      const ch = para.text[i];
      if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== '…') continue;
      if (!isSentenceEnd(para.text, i)) continue;

      // Absorbe « ?! », « ... » et les guillemets/parenthèses fermants.
      let end = i;
      while (end + 1 < para.text.length && /[.!?…]/.test(para.text[end + 1])) end++;
      while (end + 1 < para.text.length && /[»"'”’)\]]/.test(para.text[end + 1])) end++;

      // En typographie française, le guillemet fermant est précédé d'une espace.
      // Il clôt la citation : il appartient à la phrase qu'on vient de lire,
      // pas à la suivante. On ne le rattrape que si une citation est ouverte.
      let look = end + 1;
      while (look < para.text.length && para.text[look] === ' ') look++;
      if (look < para.text.length && (para.text[look] === '»' || para.text[look] === '\u201d')) {
        const quoted = para.text.slice(cursor, look + 1);
        const opened = (quoted.match(/[«\u201c]/g) || []).length;
        const closed = (quoted.match(/[»\u201d]/g) || []).length;
        if (opened >= closed) end = look;
      }

      const chunk = para.text.slice(cursor, end + 1);
      if (chunk.trim()) {
        sentences.push({
          text: chunk.trim(),
          start: para.start + cursor + (chunk.length - chunk.trimStart().length),
          kind: pauseKindFor(para.text.slice(i, end + 1)),
        });
      }
      cursor = end + 1;
      i = end;
    }
    const tail = para.text.slice(cursor);
    if (tail.trim()) {
      sentences.push({
        text: tail.trim(),
        start: para.start + cursor + (tail.length - tail.trimStart().length),
        kind: null, // pas de ponctuation finale : phrase suspendue
      });
    }

    // 2. Phrases trop longues -> morceaux bornés.
    for (let s = 0; s < sentences.length; s++) {
      const sent = sentences[s];

      // D'abord les propositions, ensuite seulement la longueur : une
      // coupure sur une virgule s'entend bien mieux qu'une coupure arbitraire.
      const parts = scinderSurPonctuation(sent.text, sent.start, opts.minClause)
        .flatMap((clause) => {
          const morceaux = splitLong(clause.text, clause.start, opts.maxChars, opts.minChunk);
          // La ponctuation qui ferme la proposition revient à son dernier morceau.
          morceaux[morceaux.length - 1].breakKind = clause.breakKind;
          return morceaux;
        });

      const lastSentence = s === sentences.length - 1;

      parts.forEach((part, pIdx) => {
        const lastPart = pIdx === parts.length - 1;
        let kind;
        if (!lastPart) kind = part.breakKind || 'soft';
        else if (lastSentence) kind = para.after !== 'none' ? para.after : (sent.kind || 'period');
        else kind = sent.kind || 'period';

        // La longueur s'applique avant le curseur, et le résultat est arrondi
        // à ce stade : le curseur reste ainsi un multiplicateur exact.
        const base = Math.round(PAUSES[kind] * facteurLongueur(part.text.length));

        segments.push({
          index: segments.length,
          text: part.text,
          pauseKind: kind,
          pauseAfter: Math.round(base * opts.pauseScale),
          breathBefore: false,
          breathDepth: 'normal',
          estDuration: part.text.length / opts.charsPerSecond,
          start: part.start,
          end: part.start + part.text.length,
        });
      });
    }
  }

  // 3. Respirations : là où un lecteur humain en aurait besoin.
  if (opts.breaths) {
    let sinceBreath = 0;
    let target = opts.breathEvery;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const prev = segments[i - 1];
      const newParagraph = prev && (prev.pauseKind === 'paragraph');

      // On ne respire jamais au milieu d'une phrase coupée : ce serait faux.
      const midSentence = prev && ['soft', 'comma', 'dash'].includes(prev.pauseKind);

      if (i > 0 && !midSentence && (newParagraph || sinceBreath >= target)) {
        seg.breathBefore = true;
        seg.breathDepth = newParagraph && sinceBreath > opts.breathEvery ? 'deep'
          : sinceBreath < opts.breathEvery * 0.6 ? 'short' : 'normal';
        sinceBreath = 0;
        target = opts.breathEvery + (rand() * 2 - 1) * opts.breathJitter;
      }
      sinceBreath += seg.estDuration + seg.pauseAfter / 1000;
    }
  }

  // 4. Ligne mélodique.
  //
  // Un modèle Piper ne sait rien du contexte : chaque phrase lui est donnée
  // seule, et il la rend donc invariablement dans le même registre. Mesuré,
  // l'écart de hauteur moyenne d'une phrase à l'autre ne dépassait pas un
  // demi-ton — d'où l'impression de voix monocorde, alors même que l'étendue
  // mélodique À L'INTÉRIEUR d'une phrase est correcte.
  //
  // C'est donc à nous de porter la ligne du paragraphe : un lecteur l'attaque
  // haut, redescend à mesure qu'il avance, repart haut au paragraphe suivant,
  // et ralentit sur sa dernière phrase. Le lecteur transpose ensuite chaque
  // segment de la hauteur demandée.
  placerLaMelodie(segments, rand);

  const totalSpeech = segments.reduce((a, s) => a + s.estDuration, 0);
  const totalPause = segments.reduce((a, s) => a + s.pauseAfter / 1000, 0);

  return {
    segments,
    map,
    normalized: text,
    stats: {
      segments: segments.length,
      chars: text.length,
      words: (text.match(/[\p{L}\p{N}'’-]+/gu) || []).length,
      breaths: segments.filter((s) => s.breathBefore).length,
      estDuration: totalSpeech + totalPause,
    },
  };
}

export const __test__ = { isSentenceEnd, splitLong, makeRandom };
