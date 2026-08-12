import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBreathPCM, breathDuration, BREATH_PRESETS } from '../src/breath.js';

/** Générateur reproductible, pour comparer deux respirations à l'identique. */
function seeded(seed = 7) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const peakOf = (pcm) => pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

test('la durée correspond au profil demandé', () => {
  const sr = 22050;
  for (const [depth, preset] of Object.entries(BREATH_PRESETS)) {
    const pcm = makeBreathPCM(depth, { sampleRate: sr, rand: seeded() });
    assert.equal(pcm.length, Math.round(preset.duration * sr), depth);
    assert.equal(breathDuration(depth), preset.duration);
  }
});

test('le signal reste dans les clous et sans valeur aberrante', () => {
  const pcm = makeBreathPCM('deep', { rand: seeded() });
  assert.ok(pcm.every(Number.isFinite), 'valeur non finie');
  assert.ok(peakOf(pcm) <= 1);
});

test('le niveau atteint la cible du profil', () => {
  for (const [depth, preset] of Object.entries(BREATH_PRESETS)) {
    const peak = peakOf(makeBreathPCM(depth, { rand: seeded() }));
    assert.ok(Math.abs(peak - preset.gain) < 1e-6, `${depth} : pic ${peak}`);
  }
});

test('le gain global met le souffle à l’échelle', () => {
  const normal = peakOf(makeBreathPCM('normal', { rand: seeded() }));
  const doubled = peakOf(makeBreathPCM('normal', { rand: seeded(), gain: 2 }));
  assert.ok(Math.abs(doubled - normal * 2) < 1e-6);
});

test('une inspiration profonde dure plus longtemps et s’entend davantage', () => {
  const short = makeBreathPCM('short', { rand: seeded() });
  const deep = makeBreathPCM('deep', { rand: seeded() });
  assert.ok(deep.length > short.length);
  assert.ok(peakOf(deep) > peakOf(short));
});

test('le souffle part et revient au silence, pour ne pas claquer', () => {
  const pcm = makeBreathPCM('normal', { rand: seeded() });
  assert.ok(Math.abs(pcm[0]) < 1e-4);
  assert.ok(Math.abs(pcm[pcm.length - 1]) < 1e-4);
});

test('l’enveloppe culmine vers les deux tiers, comme une inspiration', () => {
  const pcm = makeBreathPCM('normal', { rand: seeded() });
  // Énergie par tiers : la fin doit être plus fournie que le début.
  const third = Math.floor(pcm.length / 3);
  const energy = (a, b) => {
    let sum = 0;
    for (let i = a; i < b; i++) sum += pcm[i] * pcm[i];
    return sum;
  };
  const first = energy(0, third);
  const middle = energy(third, 2 * third);
  const last = energy(2 * third, pcm.length);
  assert.ok(middle > first, 'le milieu doit dominer le début');
  assert.ok(middle > last, 'le milieu doit dominer la fin');
  assert.ok(last > first * 0.5, 'la chute ne doit pas être brutale');
});

test('le bruit est bien filtré dans la bande d’un souffle', () => {
  const sr = 22050;
  const pcm = makeBreathPCM('normal', { sampleRate: sr, rand: seeded() });
  // Le taux de passages par zéro estime la fréquence dominante :
  // fréquence ≈ passages / 2 / durée. Du bruit blanc non filtré donnerait
  // plusieurs kilohertz ; on attend ici la bande 400-1500 Hz du preset.
  let crossings = 0;
  for (let i = 1; i < pcm.length; i++) {
    if ((pcm[i - 1] < 0) !== (pcm[i] < 0)) crossings++;
  }
  const dominant = crossings / 2 / (pcm.length / sr);
  assert.ok(dominant > 350 && dominant < 1800, `fréquence dominante : ${dominant.toFixed(0)} Hz`);
});

test('à graine égale, la respiration est identique', () => {
  const a = makeBreathPCM('normal', { rand: seeded(42) });
  const b = makeBreathPCM('normal', { rand: seeded(42) });
  assert.deepEqual(a, b);
});

test('à graine différente, la respiration change', () => {
  const a = makeBreathPCM('normal', { rand: seeded(1) });
  const b = makeBreathPCM('normal', { rand: seeded(2) });
  assert.notDeepEqual(a, b);
});

test('une profondeur inconnue retombe sur le profil normal', () => {
  const a = makeBreathPCM('n’importe quoi', { rand: seeded(3) });
  const b = makeBreathPCM('normal', { rand: seeded(3) });
  assert.deepEqual(a, b);
});

test('le filtre reste stable même à faible fréquence d’échantillonnage', () => {
  const pcm = makeBreathPCM('deep', { sampleRate: 8000, rand: seeded() });
  assert.ok(pcm.every(Number.isFinite));
  assert.ok(peakOf(pcm) <= 1);
});
