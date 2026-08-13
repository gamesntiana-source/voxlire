import test from 'node:test';
import assert from 'node:assert/strict';
import { rogner, etirerCreux, fondre, mettreEnForme } from '../src/silence.js';

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

  // Il reste la voix plus la garde de 15 ms de chaque côté.
  assert.ok(Math.abs(secondes(apres) - (0.5 + 0.03)) < 0.02,
    `${secondes(apres).toFixed(3)} s au lieu de 0,53`);
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

// ---------------------------------------------------------------------------

test('un creux de virgule est rallongé jusqu’à la durée visée', () => {
  const avant = signal([['son', 0.4], ['vide', 0.18], ['son', 0.4]]);
  const apres = etirerCreux(avant, { sampleRate: SR, creuxVise: 0.42 });
  // Le creux de 180 ms doit atteindre 420 ms : 240 ms de plus.
  assert.ok(Math.abs(secondes(apres) - (secondes(avant) + 0.24)) < 0.02,
    `${secondes(apres).toFixed(3)} s au lieu de ${(secondes(avant) + 0.24).toFixed(3)}`);
});

test('une occlusive n’est pas prise pour une pause', () => {
  // La fermeture d'un p, d'un t ou d'un k dure moins de 130 ms. L'allonger
  // transformerait « porte » en « por…te ».
  const avant = signal([['son', 0.3], ['vide', 0.07], ['son', 0.3]]);
  assert.equal(etirerCreux(avant, { sampleRate: SR, creuxVise: 0.42 }), avant);
});

test('l’étirement respecte le plafond', () => {
  const avant = signal([['son', 0.3], ['vide', 0.5], ['son', 0.3]]);
  const apres = etirerCreux(avant, { sampleRate: SR, creuxVise: 2, creuxMaximum: 0.9 });
  assert.ok(Math.abs(secondes(apres) - (secondes(avant) + 0.4)) < 0.02);
});

test('les silences de bord ne sont pas étirés', () => {
  // Ils relèvent du rognage ; les toucher ici les compterait deux fois.
  const avant = signal([['vide', 0.3], ['son', 0.3], ['vide', 0.3]]);
  assert.equal(etirerCreux(avant, { sampleRate: SR, creuxVise: 0.42 }), avant);
});

test('plusieurs creux sont traités d’un coup', () => {
  const avant = signal([['son', 0.3], ['vide', 0.2], ['son', 0.3], ['vide', 0.2], ['son', 0.3]]);
  const apres = etirerCreux(avant, { sampleRate: SR, creuxVise: 0.42 });
  assert.ok(Math.abs(secondes(apres) - (secondes(avant) + 0.44)) < 0.03);
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

test('la chaîne complète raccourcit les bords et rallonge le milieu', () => {
  const avant = signal([['vide', 0.2], ['son', 0.4], ['vide', 0.2], ['son', 0.4], ['vide', 0.2]]);
  const apres = mettreEnForme(avant, { sampleRate: SR, creuxVise: 0.42 });

  // 0,4 s de silence de bord retirés (garde comprise), 0,22 s ajoutés au milieu.
  assert.ok(secondes(apres) > secondes(avant) - 0.4);
  assert.ok(secondes(apres) < secondes(avant));
  assert.ok(Math.abs(apres[0]) === 0, 'les bords doivent être fondus');
});
