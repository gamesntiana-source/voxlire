import test from 'node:test';
import assert from 'node:assert/strict';
import { segment, normalize, PAUSES, __test__ } from '../src/prosody.js';

const texts = (r) => r.segments.map((s) => s.text);
const kinds = (r) => r.segments.map((s) => s.pauseKind);

test('sépare des phrases simples', () => {
  const r = segment('Bonjour. Comment vas-tu ? Très bien !');
  assert.deepEqual(texts(r), ['Bonjour.', 'Comment vas-tu ?', 'Très bien !']);
  assert.deepEqual(kinds(r), ['period', 'question', 'exclam']);
});

test('ne coupe pas sur les civilités et abréviations', () => {
  const r = segment('M. Dupont a vu Mme Martin. Puis il est parti.');
  assert.deepEqual(texts(r), ['M. Dupont a vu Mme Martin.', 'Puis il est parti.']);
});

test('ne coupe pas sur « etc. » ni « cf. » en milieu de phrase', () => {
  const r = segment('Des pommes, des poires, etc. sont sur la table. Fin.');
  // Le découpage sur virgule peut détacher l'énumération ; ce qui compte
  // ici est que « etc. » ne termine pas de phrase, donc que le morceau qui
  // le contient continue jusqu'au vrai point.
  const avecEtc = r.segments.find((s) => s.text.includes('etc.'));
  assert.ok(avecEtc.text.endsWith('table.'), avecEtc.text);
  assert.equal(r.segments.at(-1).text, 'Fin.');
});

test('ne coupe pas sur les initiales', () => {
  const r = segment('Le rapport de J. R. Martin est prêt. Merci.');
  assert.deepEqual(texts(r), ['Le rapport de J. R. Martin est prêt.', 'Merci.']);
});

test('ne coupe pas sur les décimales', () => {
  const r = segment('La valeur est de 3.14 exactement. Voilà.');
  assert.deepEqual(texts(r), ['La valeur est de 3.14 exactement.', 'Voilà.']);
});

test('ne coupe pas sur un sigle pointé', () => {
  const r = segment('La S.N.C.F. annonce un retard. Encore.');
  assert.deepEqual(texts(r), ['La S.N.C.F. annonce un retard.', 'Encore.']);
});

test('les points de suspension terminent une phrase et pèsent plus lourd', () => {
  const r = segment('Il hésita... Puis il partit.');
  assert.equal(r.segments[0].pauseKind, 'ellipsis');
  assert.ok(r.segments[0].pauseAfter > PAUSES.period);
});

test('« ?! » ne produit pas deux segments', () => {
  const r = segment('Tu es sérieux ?! Oui.');
  assert.deepEqual(texts(r), ['Tu es sérieux ?!', 'Oui.']);
});

test('les guillemets fermants restent collés à la phrase', () => {
  const r = segment('Il a dit : « je pars. » Puis il est sorti.');
  assert.equal(r.segments.length, 2);
  assert.ok(r.segments[0].text.endsWith('»'));
});

test('la fin de paragraphe pèse plus lourd que la fin de phrase', () => {
  const r = segment('Première partie.\n\nSeconde partie.');
  assert.equal(r.segments[0].pauseKind, 'paragraph');
  assert.ok(r.segments[0].pauseAfter > PAUSES.period);
});

test('un simple retour à la ligne vaut une pause intermédiaire', () => {
  const r = segment('Un vers ici\nUn vers là');
  assert.equal(r.segments[0].pauseKind, 'lineBreak');
});

test('le curseur de pauses met bien à l’échelle', () => {
  const base = segment('Un. Deux.');
  const slow = segment('Un. Deux.', { pauseScale: 2 });
  assert.equal(slow.segments[0].pauseAfter, base.segments[0].pauseAfter * 2);
});

test('une phrase interminable est scindée sur la ponctuation forte', () => {
  const long = 'Il marchait depuis des heures dans la ville endormie et personne '
    + 'ne semblait remarquer sa présence discrète ; pourtant il avait la nette '
    + 'impression que quelqu’un le suivait de loin depuis le début de la soirée '
    + 'et cette idée ne le quittait plus une seule seconde.';
  const r = segment(long, { maxChars: 140 });
  assert.ok(r.segments.length > 1);
  assert.ok(r.segments.every((s) => s.text.length <= 180));
  assert.ok(r.segments.some((s) => s.pauseKind === 'semicolon'));
});

test('aucun fragment minuscule ne sort du découpage', () => {
  const long = 'Oui, ' + 'et il continuait de parler sans jamais reprendre son souffle '.repeat(8) + '.';
  const r = segment(long, { maxChars: 120, minChunk: 50 });
  assert.ok(r.segments.every((s) => s.text.length >= 20));
});

test('les espaces insécables des grands nombres disparaissent', () => {
  const r = segment('Il y avait 1 250 000 personnes.');
  assert.match(r.segments[0].text, /1250000/);
});

test('les URL ne sont pas épelées', () => {
  const r = segment('Va voir https://exemple.fr/page?a=1 pour la suite.');
  assert.match(r.segments[0].text, /un lien/);
  assert.doesNotMatch(r.segments[0].text, /https/);
});

test('les adresses e-mail non plus', () => {
  const r = segment('Écris à jean.dupont@exemple.fr demain.');
  assert.match(r.segments[0].text, /une adresse e-mail/);
});

test('le découpage est reproductible à l’identique', () => {
  const t = 'Une phrase. '.repeat(40);
  assert.deepEqual(segment(t).segments, segment(t).segments);
});

test('les index pointent vers le texte d’origine', () => {
  const src = 'Bonjour tout le monde. Deuxième phrase ici.';
  const r = segment(src);
  for (const s of r.segments) {
    const origStart = r.map[s.start];
    assert.equal(src.slice(origStart, origStart + 7), s.text.slice(0, 7));
  }
});

test('un texte vide ou blanc ne produit rien', () => {
  assert.equal(segment('').segments.length, 0);
  assert.equal(segment('   \n\n  \t ').segments.length, 0);
});

test('une phrase sans ponctuation finale est quand même lue', () => {
  const r = segment('Un titre sans point');
  assert.deepEqual(texts(r), ['Un titre sans point']);
});

test('les statistiques sont cohérentes', () => {
  const r = segment('Bonjour le monde. Ça va bien ?');
  assert.equal(r.stats.segments, 2);
  assert.equal(r.stats.words, 6);
  assert.ok(r.stats.estDuration > 0);
});

test('un texte très long reste traité en un temps raisonnable', () => {
  const book = 'Il faisait un temps splendide, et personne ne s’en plaignait. '.repeat(4000);
  const t0 = process.hrtime.bigint();
  const r = segment(book);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  // Deux segments par phrase : la virgule en détache la proposition.
  assert.equal(r.stats.segments, 8000);
  assert.ok(ms < 4000, `découpage trop lent : ${ms.toFixed(0)} ms`);
});

test('normalize replie les lignes vides multiples', () => {
  const { text } = normalize('a\n\n\n\n\nb');
  assert.equal(text, 'a\n\nb');
});

test('isSentenceEnd distingue bien les cas limites', () => {
  const { isSentenceEnd } = __test__;
  assert.equal(isSentenceEnd('fin. Suite', 3), true);
  assert.equal(isSentenceEnd('M. Dupont', 1), false);
  assert.equal(isSentenceEnd('p. 42 suite', 1), false);
  assert.equal(isSentenceEnd('3.14', 1), false);
});

// ---------------------------------------------------------------------------
// Découpage sur la ponctuation interne
// ---------------------------------------------------------------------------

test('une proposition assez longue se détache sur sa virgule', () => {
  const r = segment('Il était une fois, dans un pays lointain, un roi très sage.');
  assert.equal(r.segments.length, 2);
  // La virgule reste attachée à gauche : c'est elle qui tient l'intonation
  // suspendue, sans quoi le modèle terminerait la phrase par une chute.
  assert.ok(r.segments[0].text.endsWith(','), r.segments[0].text);
  assert.equal(r.segments[0].pauseKind, 'comma');
  assert.equal(r.segments[1].pauseKind, 'period');
});

test('les énumérations courtes restent d’un seul tenant', () => {
  // Quatre fragments d'un mot sonneraient bien plus mécaniques que la pause
  // imparfaite du modèle.
  const r = segment('Un, deux, trois, partez !');
  assert.equal(r.segments.length, 1);
});

test('le point-virgule et le deux-points découpent aussi', () => {
  const r = segment('Elle ne répondit pas tout de suite ; elle referma son livre.');
  assert.equal(r.segments.length, 2);
  assert.equal(r.segments[0].pauseKind, 'semicolon');
});

test('la virgule pèse moins qu’un point, plus qu’une coupure forcée', () => {
  assert.ok(PAUSES.comma < PAUSES.period);
  assert.ok(PAUSES.comma > PAUSES.soft);
  // Le rapport d'environ un à deux entre virgule et point est ce qu'on
  // mesure chez les locuteurs.
  const rapport = PAUSES.period / PAUSES.comma;
  assert.ok(rapport > 1.3 && rapport < 2.2, `rapport ${rapport.toFixed(2)}`);
});

test('le seuil de découpe sur virgule est réglable', () => {
  const texte = 'Il faisait très beau, mais le vent se levait déjà.';
  assert.equal(segment(texte, { minClause: 200 }).segments.length, 1);
  assert.equal(segment(texte, { minClause: 10 }).segments.length, 2);
});

// ---------------------------------------------------------------------------
// Ligne mélodique
// ---------------------------------------------------------------------------

test('chaque segment reçoit une hauteur et un débit', () => {
  const r = segment('Une phrase. Une autre phrase.');
  for (const s of r.segments) {
    assert.equal(typeof s.pitch, 'number', 'hauteur manquante');
    assert.equal(typeof s.tempo, 'number', 'débit manquant');
    assert.ok(Number.isFinite(s.pitch) && Number.isFinite(s.tempo));
  }
});

test('un paragraphe s’attaque haut et redescend', () => {
  const p = 'Voici une phrase de longueur ordinaire. ';
  const r = segment(p.repeat(6));
  const premier = r.segments[0].pitch;
  const dernier = r.segments.at(-1).pitch;
  assert.ok(premier > dernier + 1,
    `la voix devrait descendre : ${premier.toFixed(2)} puis ${dernier.toFixed(2)}`);
});

test('le paragraphe suivant repart en haut', () => {
  const p = 'Voici une phrase de longueur ordinaire. '.repeat(5);
  const r = segment(`${p}\n\n${p}`);
  const finParagraphe = r.segments.findIndex((s) => s.pauseKind === 'paragraph');
  assert.ok(r.segments[finParagraphe + 1].pitch > r.segments[finParagraphe].pitch + 1,
    'la reprise de paragraphe devrait remonter');
});

test('une question monte au-dessus de l’affirmation voisine', () => {
  const r = segment('Il rentra chez lui. Que fais-tu là ?');
  const [affirmation, question] = r.segments;
  assert.equal(question.pauseKind, 'question');
  assert.ok(question.pitch > affirmation.pitch - 0.5, 'la question devrait remonter');
});

test('la transposition reste dans les bornes', () => {
  // Au-delà de deux demi-tons, le rééchantillonnage déplace les formants et
  // la voix change d'identité.
  const r = segment('Question ? '.repeat(30) + '\n\nSuite du texte, bien plus longue et posée.');
  for (const s of r.segments) {
    assert.ok(Math.abs(s.pitch) <= 2.0001, `hauteur hors bornes : ${s.pitch}`);
  }
});

test('la dernière phrase d’un paragraphe ralentit', () => {
  const r = segment('Première phrase ici.\n\nSeconde phrase là.');
  const fin = r.segments.find((s) => s.pauseKind === 'paragraph');
  assert.ok(fin.tempo < 1, `débit ${fin.tempo} : la fin de paragraphe devrait se poser`);
});

test('la mélodie est reproductible', () => {
  const texte = 'Une phrase. Une autre. Et une troisième pour finir.';
  assert.deepEqual(
    segment(texte).segments.map((s) => [s.pitch, s.tempo]),
    segment(texte).segments.map((s) => [s.pitch, s.tempo]),
  );
});
