import test from 'node:test';
import assert from 'node:assert/strict';
import { rogner, fondre, mettreEnForme } from '../src/silence.js';

const SR = 22050;

/** Construit un signal à partir d'une suite de [type, durée en secondes]. */
function signal(parties, sampleRate = SR) {
  const total = parties.reduce((n, [, d]) => n + Math.round(d * sampleRate), 0);
  const out = new Float32Array(total);
  let i = 0;
  for (const [type, duree] of parties) {
    const n = Math.round(duree * sampleRate);
    if (type === 'son') {
      for (let k = 0; k < n; k++) out[i + k] = 0.3 * Math.sin((2 * Math.PI * 220 * k) / sampleRate);
    }
    i += n;
  }
  return out;
}

const secondes = (pcm, sampleRate = SR) => pcm.length / sampleRate;

// ---------------------------------------------------------------------------

test('le silence de tête et de queue disparaît', () => {
  const avant = signal([['vide', 0.2], ['son', 0.5], ['vide', 0.25]]);
  const apres = rogner(avant, { sampleRate: SR });

  // Il reste la voix plus la garde de 20 ms de chaque côté.
  assert.ok(Math.abs(secondes(apres) - 0.54) < 0.02,
    `${secondes(apres).toFixed(3)} s au lieu de 0,54`);
});

test('un tampon entièrement silencieux ressort intact', () => {
  // C'est un silence voulu — une phrase que le moteur a refusé de dire —
  // et non un emballage : le rogner ferait disparaître la phrase.
  const vide = new Float32Array(SR);
  assert.equal(rogner(vide, { sampleRate: SR }).length, SR);
});

test('un signal sans silence n’est pas touché', () => {
  const plein = signal([['son', 0.4]]);
  assert.equal(rogner(plein, { sampleRate: SR }), plein);
});

test('le rognage ne mord pas sur la voix', () => {
  const avant = signal([['vide', 0.2], ['son', 0.5], ['vide', 0.2]]);
  const apres = rogner(avant, { sampleRate: SR });
  const crete = apres.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(crete > 0.29, `crête ${crete} : de la voix a été perdue`);
});

test('le rognage ne touche pas aux silences internes', () => {
  // Ils portent la ponctuation de la phrase ; leur longueur se décide sur le
  // texte, dans prosody.js, et surtout pas à l'oreille dans le signal.
  const avant = signal([['son', 0.3], ['vide', 0.25], ['son', 0.3]]);
  const apres = rogner(avant, { sampleRate: SR });
  assert.ok(Math.abs(secondes(apres) - secondes(avant)) < 1e-9);
});

test('un son très faible n’est pas pris pour du silence', () => {
  // À -45 dBFS on coupait la détente des consonnes finales ; le seuil est
  // à -60 dBFS. Un signal à -50 dBFS doit donc survivre.
  const n = Math.round(0.3 * SR);
  const faible = new Float32Array(n);
  for (let k = 0; k < n; k++) faible[k] = 10 ** (-50 / 20) * Math.sin((2 * Math.PI * 220 * k) / SR);
  const avant = signal([['vide', 0.2]]);
  const total = new Float32Array(avant.length + n);
  total.set(faible, avant.length);

  const apres = rogner(total, { sampleRate: SR });
  assert.ok(secondes(apres) > 0.28, `${secondes(apres).toFixed(3)} s : le son faible a été rogné`);
});

// ---------------------------------------------------------------------------

test('le fondu éteint les extrémités sans toucher au milieu', () => {
  const plein = signal([['son', 0.3]]);
  const fondu = fondre(plein, { sampleRate: SR, fondu: 0.006 });
  // Math.abs plutôt qu'une égalité stricte : un échantillon négatif multiplié
  // par zéro donne -0, que Object.is distingue de 0.
  assert.ok(Math.abs(fondu[0]) === 0);
  assert.ok(Math.abs(fondu[fondu.length - 1]) === 0);
  const milieu = Math.floor(fondu.length / 2);
  assert.ok(Math.abs(fondu[milieu] - plein[milieu]) < 1e-6);
});

test('le fondu ne modifie pas le tampon d’origine', () => {
  // Le son mis en forme est mis en cache : l'abîmer sur place se verrait
  // à la relecture.
  const plein = signal([['son', 0.1]]);
  const copie = Float32Array.from(plein);
  fondre(plein, { sampleRate: SR });
  assert.deepEqual(plein, copie);
});

test('la chaîne complète encaisse les cas vides', () => {
  assert.equal(mettreEnForme(new Float32Array(0)).length, 0);
  assert.equal(mettreEnForme(null).length, 0);
});

test('la chaîne complète raccourcit sans jamais rallonger', () => {
  const avant = signal([['vide', 0.2], ['son', 0.4], ['vide', 0.2], ['son', 0.4], ['vide', 0.2]]);
  const apres = mettreEnForme(avant, { sampleRate: SR });

  assert.ok(secondes(apres) < secondes(avant), 'les bords doivent être rognés');
  // Le creux du milieu reste tel quel : on n'ajoute plus rien dans la phrase.
  assert.ok(secondes(apres) > secondes(avant) - 0.4);
  assert.ok(Math.abs(apres[0]) === 0, 'les bords doivent être fondus');
});
