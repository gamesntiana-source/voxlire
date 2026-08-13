import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { phonemiser, motEnPhonemes, __test__ } from '../src/engines/phonemes.js';
import { chercher, taille } from '../src/engines/lexique.js';
import { prononcer } from '../src/engines/regles.js';
import { phonemesEnIds } from '../src/engines/piper.js';

const ICI = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Le lexique
// ---------------------------------------------------------------------------

test('la dichotomie retrouve les mots qu’elle contient', () => {
  assert.equal(chercher('femme'), 'fam');
  assert.equal(chercher('monsieur'), 'məsjø');
  assert.equal(chercher('est'), 'ɛ');
  assert.equal(chercher('cent'), 'sɑ̃');
  assert.equal(chercher('vingt'), 'vɛ̃');
});

test('la dichotomie répond null sans se perdre', () => {
  // Avant la première entrée, après la dernière, et au milieu de nulle part.
  assert.equal(chercher(''), null);
  assert.equal(chercher('zzzzzzz'), null);
  assert.equal(chercher('xyzzyplugh'), null);
});

test('toute entrée du lexique est retrouvable', async () => {
  const { DONNEES } = await import('../src/engines/lexique-data.js');
  const lignes = DONNEES.split('\n');
  let manquants = 0;
  for (const ligne of lignes) {
    const i = ligne.indexOf(' ');
    if (chercher(ligne.slice(0, i)) !== ligne.slice(i + 1)) manquants++;
  }
  assert.equal(manquants, 0, `${manquants} entrées introuvables`);
  assert.equal(taille(), lignes.length);
});

// ---------------------------------------------------------------------------
// Les règles
// ---------------------------------------------------------------------------

test('les consonnes finales se taisent, le pluriel n’y change rien', () => {
  assert.equal(prononcer('abaissants'), 'abɛsɑ̃');
  assert.equal(prononcer('abattant'), 'abatɑ̃');
});

test('la terminaison verbale -ent est muette, l’adverbe en -ment ne l’est pas', () => {
  assert.equal(prononcer('abaissèrent'), 'abɛsɛʁ');
  assert.equal(prononcer('abaisseraient'), 'abɛsʁɛ');
  assert.ok(prononcer('follement').endsWith('mɑ̃'));
});

test('le e caduc tombe quand il ne crée pas trois consonnes', () => {
  // Une seule consonne devant : le e disparaît.
  assert.equal(prononcer('abandonnera'), 'abɑ̃dɔnʁa');
  // Deux consonnes devant : il reste, sans quoi le mot serait imprononçable.
  assert.equal(prononcer('aborderai'), 'abɔʁdəʁe');
});

test('les voyelles nasales, et ce qui les empêche', () => {
  assert.equal(prononcer('pain'), 'pɛ̃');
  assert.equal(prononcer('pont'), 'pɔ̃');
  assert.equal(prononcer('brun'), 'bʁœ̃');
  // Une voyelle ou un doublement derrière le n annule la nasale.
  assert.equal(prononcer('peine'), 'pɛn');
  assert.equal(prononcer('comme'), 'kɔm');
});

test('un mot inconnu ne laisse jamais le lecteur muet', () => {
  for (const invente of ['zorglub', 'kravitchoune', 'plimdaquer', 'xyzzy']) {
    assert.ok(prononcer(invente).length > 0, invente);
  }
});

// ---------------------------------------------------------------------------
// Confrontation à eSpeak NG (échantillon figé)
// ---------------------------------------------------------------------------

test('la prononciation reproduit eSpeak sur l’échantillon de référence', () => {
  const fixture = readFileSync(join(ICI, 'fixtures', 'prononciation.tsv'), 'utf8');
  const ecarts = [];

  for (const ligne of fixture.split('\n')) {
    if (!ligne) continue;
    const [mot, attendu] = ligne.split('\t');
    const obtenu = motEnPhonemes(mot);
    if (obtenu !== attendu) ecarts.push(`${mot} : ${attendu} attendu, ${obtenu} obtenu`);
  }

  assert.deepEqual(ecarts, [], `${ecarts.length} écarts\n${ecarts.slice(0, 12).join('\n')}`);
});

// ---------------------------------------------------------------------------
// Élision, accent, ponctuation
// ---------------------------------------------------------------------------

test('l’élision colle le clitique au mot suivant', () => {
  assert.equal(motEnPhonemes("c'est"), 'sɛ');
  assert.equal(motEnPhonemes("l'homme"), 'lɔm');
  assert.equal(motEnPhonemes("qu'il"), 'kil');
});

test('l’accent tombe sur la dernière voyelle pleine, jamais sur un e muet', () => {
  const { accentuer } = __test__;
  assert.equal(accentuer('bɔ̃ʒuʁ'), 'bɔ̃ʒˈuʁ');
  assert.equal(accentuer('pəti'), 'pətˈi');
  // Le schwa final ne prend pas l'accent : il revient à la voyelle d'avant.
  assert.equal(accentuer('tablə'), 'tˈablə');
});

test('les mots outils ne portent pas d’accent', () => {
  const dit = phonemiser('le chat').join('');
  assert.ok(!dit.startsWith('lˈ'), dit);
  assert.ok(dit.includes('ˈ'), 'le mot plein doit rester accentué');
});

test('la ponctuation se colle au mot, sans espace parasite', () => {
  const dit = phonemiser('Bonjour, le chat.').join('');
  assert.ok(dit.includes('uʁ,'), dit);
  assert.ok(!dit.includes(' ,'), dit);
  assert.ok(dit.endsWith('.'), dit);
});

test('la ponctuation finale distingue question et affirmation', () => {
  assert.ok(phonemiser('Ça va ?').join('').endsWith('?'));
  assert.ok(phonemiser('Ça va !').join('').endsWith('!'));
  assert.ok(phonemiser('Ça va.').join('').endsWith('.'));
});

test('les nombres passent bien par le développement', () => {
  const dit = phonemiser('En 1789.').join('');
  // L'accent s'insère avant la voyelle : on le retire pour comparer.
  assert.ok(dit.replace(/[ˈˌ]/g, '').includes('sɑ̃'), dit);   // « cent »
  assert.ok(!/\d/.test(dit), 'aucun chiffre ne doit survivre');
});

test('un texte vide ne produit rien', () => {
  assert.deepEqual(phonemiser(''), []);
  assert.deepEqual(phonemiser('   '), []);
});

// ---------------------------------------------------------------------------
// Points de code et identifiants
// ---------------------------------------------------------------------------

test('une voyelle nasale compte pour deux points de code', () => {
  // C'est ainsi que piper indexe son vocabulaire : le tilde est un symbole.
  const dit = phonemiser('pont');
  assert.ok(dit.includes('ɔ'));
  assert.ok(dit.includes('̃'), 'le tilde combinant doit être séparé');
});

test('les identifiants intercalent le remplissage, comme piper', () => {
  const table = { _: [0], '^': [1], $: [2], a: [10], b: [11] };
  const { ids, inconnus } = phonemesEnIds(['a', 'b'], table);
  assert.deepEqual([...ids].map(Number), [1, 0, 10, 0, 11, 0, 2]);
  assert.deepEqual(inconnus, []);
});

test('un phonème absent du modèle est signalé, pas fatal', () => {
  const table = { _: [0], '^': [1], $: [2], a: [10] };
  const { ids, inconnus } = phonemesEnIds(['a', 'ǂ'], table);
  assert.deepEqual([...ids].map(Number), [1, 0, 10, 0, 2]);
  assert.deepEqual(inconnus, ['ǂ']);
});

test('tous les phonèmes produits existent dans un modèle réel', async () => {
  // Le vocabulaire d'un modèle Piper français, tel que livré dans son config.
  const VOCABULAIRE = new Set([
    ...'0123456789_^$ !\'(),-.:;?abcdefhijklmnopqrstuvwxyzæçðøħŋœ',
    ...'ɐɑɒɓɔɕɖɗɘəɚɛɜɞɟɠɡɢɣɤɥɦɧɨɪɫɬɭɮɯɰɱɲɳɴɵɶɸɹɺɻɽɾ',
    ...'ʀʁʂʃʄʈʉʊʋʌʍʎʏʐʑʒʔʕʘʙʛʜʝʟʡʢʲˈˌːˑ˞βθχᵻⱱ',
    '̧', '̃', '̪', '̯', '̩', 'ʰ', 'ˤ', 'ε', '↓', '#', '"', '↑',
  ]);

  const phrases = [
    'Il était une fois, dans un pays lointain, un roi très sage.',
    "Les femmes parlent à monsieur Dupont, qui n'écoute pas.",
    'En 1789, tout a changé : 80 % des privilèges ont disparu.',
    'Comment ça va ? C’est vraiment magnifique !',
    'Le vieux château de Chambord, bâti au XVIe siècle, impressionne encore.',
  ];

  const absents = new Set();
  for (const phrase of phrases) {
    for (const p of phonemiser(phrase)) if (!VOCABULAIRE.has(p)) absents.add(p);
  }
  assert.deepEqual([...absents], [], 'phonèmes hors vocabulaire du modèle');
});
