import test from 'node:test';
import assert from 'node:assert/strict';
import { enLettres, ordinal, valeurRomaine, developper } from '../src/engines/nombres.js';

test('les petits nombres, y compris les seize irréguliers', () => {
  const attendus = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept',
    'huit', 'neuf', 'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize',
    'dix-sept', 'dix-huit', 'dix-neuf', 'vingt'];
  attendus.forEach((mot, n) => assert.equal(enLettres(n), mot, String(n)));
});

test('les dizaines françaises et leurs pièges', () => {
  const cas = {
    21: 'vingt et un',
    22: 'vingt-deux',
    31: 'trente et un',
    61: 'soixante et un',
    70: 'soixante-dix',
    71: 'soixante et onze',
    72: 'soixante-douze',
    77: 'soixante-dix-sept',
    80: 'quatre-vingts',
    81: 'quatre-vingt-un',
    90: 'quatre-vingt-dix',
    91: 'quatre-vingt-onze',
    99: 'quatre-vingt-dix-neuf',
  };
  for (const [n, mot] of Object.entries(cas)) assert.equal(enLettres(Number(n)), mot, n);
});

test('« vingt » et « cent » ne prennent leur s qu’en fin de nombre', () => {
  assert.equal(enLettres(80), 'quatre-vingts');
  assert.equal(enLettres(80000), 'quatre-vingt mille');
  assert.equal(enLettres(200), 'deux cents');
  assert.equal(enLettres(201), 'deux cent un');
  assert.equal(enLettres(200000), 'deux cent mille');
  // Devant un nom d'échelle, en revanche, l'accord revient.
  assert.equal(enLettres(200000000), 'deux cents millions');
});

test('« mille » reste invariable et ne se multiplie pas par un', () => {
  assert.equal(enLettres(1000), 'mille');
  assert.equal(enLettres(2000), 'deux mille');
  assert.equal(enLettres(1000000), 'un million');
  assert.equal(enLettres(2000000), 'deux millions');
});

test('les grands nombres et les négatifs', () => {
  assert.equal(enLettres(1789), 'mille sept cent quatre-vingt-neuf');
  assert.equal(enLettres(1515), 'mille cinq cent quinze');
  assert.equal(enLettres(1234567), 'un million deux cent trente-quatre mille cinq cent soixante-sept');
  assert.equal(enLettres(-42), 'moins quarante-deux');
  assert.equal(enLettres(1000000000), 'un milliard');
});

test('les rangs, avec leurs irrégularités', () => {
  const cas = {
    1: 'premier', 2: 'deuxième', 4: 'quatrième', 5: 'cinquième',
    9: 'neuvième', 11: 'onzième', 21: 'vingt et unième', 80: 'quatre-vingtième',
    100: 'centième', 1000: 'millième',
  };
  for (const [n, mot] of Object.entries(cas)) assert.equal(ordinal(Number(n)), mot, n);
  assert.equal(ordinal(1, true), 'première');
});

test('les chiffres romains, valides et invalides', () => {
  assert.equal(valeurRomaine('XIV'), 14);
  assert.equal(valeurRomaine('MCMLXXXIV'), 1984);
  assert.equal(valeurRomaine('IX'), 9);
  assert.equal(valeurRomaine('IIII'), null, 'forme non canonique');
  assert.equal(valeurRomaine('BANANE'), null);
  assert.equal(valeurRomaine(''), null);
});

// ---------------------------------------------------------------------------

test('les nombres du texte deviennent des mots', () => {
  assert.equal(developper('En 1789, tout a changé.'),
    'En mille sept cent quatre-vingt-neuf, tout a changé.');
  assert.equal(developper('Il a 3 chats.'), 'Il a trois chats.');
});

test('les décimales se lisent à la française', () => {
  assert.equal(developper('3,14'), 'trois virgule quatorze');
  assert.equal(developper('2,5 litres'), 'deux virgule cinq litres');
  // Au-delà de deux chiffres, on épelle plutôt que d'inventer un nombre.
  assert.equal(developper('3,1415'), 'trois virgule un quatre un cinq');
});

test('les unités s’accordent au nombre qui les précède', () => {
  assert.equal(developper('1 km'), 'un kilomètre');
  assert.equal(developper('5 km'), 'cinq kilomètres');
  assert.equal(developper('20 °C'), 'vingt degrés Celsius');
  assert.equal(developper('30 min'), 'trente minutes');
});

test('monnaies et pourcentages', () => {
  assert.equal(developper('12 €'), 'douze euros');
  assert.equal(developper('1 €'), 'un euro');
  assert.equal(developper('50 %'), 'cinquante pour cent');
  assert.equal(developper('$30'), 'trente dollars');
});

test('les heures', () => {
  assert.equal(developper('14 h 30'), 'quatorze heures trente');
  assert.equal(developper('14h30'), 'quatorze heures trente');
  assert.equal(developper('1 h 00'), 'une heure'.replace('une', 'un'));
});

test('les rangs écrits en chiffres', () => {
  assert.equal(developper('le 1er jour'), 'le premier jour');
  assert.equal(developper('la 1re fois'), 'la première fois');
  assert.equal(developper('le 21e étage'), 'le vingt et unième étage');
});

test('les chiffres romains annoncés par un mot déclencheur', () => {
  assert.equal(developper('Chapitre XII'), 'Chapitre douze');
  assert.equal(developper('Louis XIV'), 'Louis quatorze');
  assert.equal(developper('le XXe siècle'), 'le vingtième siècle');
});

test('les sigles qui ressemblent à des romains restent des sigles', () => {
  // MM vaut 2000, CD vaut 400, XL vaut 40 : aucun ne doit devenir un nombre.
  assert.equal(developper('une taille XL'), 'une taille XL');
  assert.equal(developper('un CD rayé'), 'un CD rayé');
  assert.equal(developper('Il a vu X partir'), 'Il a vu X partir');
});

test('les civilités exigent la majuscule', () => {
  assert.equal(developper('M. Dupont'), 'monsieur Dupont');
  assert.equal(developper('Mme Curie'), 'madame Curie');
  // « me » minuscule est un pronom, pas un titre.
  assert.equal(developper('il me dit'), 'il me dit');
  assert.equal(developper('Me Dupont'), 'maître Dupont');
});

test('un zéro en tête annonce un code, pas une quantité', () => {
  assert.equal(developper('06'), 'zéro six');
  assert.equal(developper('007'), 'zéro zéro sept');
});

test('le texte sans chiffre ni abréviation ressort intact', () => {
  const texte = 'Le vent se lève, il faut tenter de vivre.';
  assert.equal(developper(texte), texte);
});
