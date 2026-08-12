/**
 * breath.js — fabrication du bruit d'inspiration.
 *
 * Un moteur TTS ne respire pas : il produit des phrases, puis se tait.
 * Le silence seul ne suffit pas à faire croire à un lecteur humain, parce
 * qu'un humain, dans ce silence, reprend son souffle — et on l'entend.
 *
 * On synthétise donc ce souffle plutôt que d'embarquer des échantillons :
 * du bruit blanc passé dans un filtre passe-bande dont la fréquence monte
 * pendant l'inspiration, sous une enveloppe qui culmine aux deux tiers.
 * Coût : zéro octet à télécharger, et une respiration jamais deux fois
 * identique.
 */

/** Réglages par profondeur. Durées en secondes, fréquences en hertz. */
export const BREATH_PRESETS = {
  short: { duration: 0.20, gain: 0.040, from: 640, to: 1180, q: 1.70, curve: 1.15 },
  normal: { duration: 0.33, gain: 0.060, from: 520, to: 1260, q: 1.50, curve: 1.25 },
  deep: { duration: 0.52, gain: 0.085, from: 430, to: 1420, q: 1.35, curve: 1.40 },
};

/**
 * Enveloppe d'amplitude d'une inspiration : montée progressive, sommet aux
 * deux tiers, chute plus franche. Une expiration ferait l'inverse.
 */
function envelopeAt(t, curve) {
  const shaped = Math.pow(t, curve);
  return Math.pow(Math.sin(Math.PI * Math.min(1, shaped)), 1.25);
}

/**
 * Rend une inspiration sous forme de PCM mono dans [-1, 1].
 *
 * @param {'short'|'normal'|'deep'} depth
 * @param {{sampleRate?: number, rand?: () => number, gain?: number}} opts
 *        `rand` permet de rendre la respiration reproductible en test.
 * @returns {Float32Array}
 */
export function makeBreathPCM(depth = 'normal', opts = {}) {
  const { sampleRate = 22050, rand = Math.random, gain = 1 } = opts;
  const preset = BREATH_PRESETS[depth] || BREATH_PRESETS.normal;
  const length = Math.max(2, Math.round(preset.duration * sampleRate));
  const out = new Float32Array(length);

  // Filtre à variable d'état (Chamberlin) : deux intégrateurs, une sortie
  // passe-bande, et une fréquence de coupure qu'on peut bouger à chaque
  // échantillon — ce que ne permet pas un biquad à coefficients figés.
  // Deux cellules en cascade : une seule laisse passer trop d'aigus et le
  // souffle sonne alors comme un « chhh » de radio mal réglée.
  let low1 = 0, band1 = 0;
  let low2 = 0, band2 = 0;
  const damping = 1 / preset.q;

  // La glotte ne s'ouvre pas d'un coup : le débit d'air ondule un peu.
  let turbulence = 0;

  let peak = 0;

  for (let i = 0; i < length; i++) {
    const t = i / (length - 1);

    const cutoff = preset.from + (preset.to - preset.from) * t;
    // Approximation de Chamberlin, stable tant que cutoff < sampleRate / 6.
    const f = 2 * Math.sin(Math.PI * Math.min(cutoff, sampleRate / 6) / sampleRate);

    const white = rand() * 2 - 1;
    turbulence += (white - turbulence) * 0.02; // composante lente
    const input = white * (0.82 + 0.18 * turbulence);

    const high1 = input - low1 - damping * band1;
    band1 += f * high1;
    low1 += f * band1;

    const high2 = band1 - low2 - damping * band2;
    band2 += f * high2;
    low2 += f * band2;

    const value = band2 * envelopeAt(t, preset.curve);
    out[i] = value;
    const abs = value < 0 ? -value : value;
    if (abs > peak) peak = abs;
  }

  // Normalise au niveau visé : le gain du filtre dépend du Q, donc mesurer
  // le pic est plus fiable que de faire confiance au calcul.
  const target = preset.gain * gain;
  if (peak > 0) {
    const scale = target / peak;
    for (let i = 0; i < length; i++) out[i] *= scale;
  }

  // Fond au silence sur 3 ms de chaque côté : sans ça, le raccord claque.
  const fade = Math.min(Math.round(sampleRate * 0.003), Math.floor(length / 2));
  for (let i = 0; i < fade; i++) {
    const k = i / fade;
    out[i] *= k;
    out[length - 1 - i] *= k;
  }

  return out;
}

/** Durée d'une respiration, en secondes, sans avoir à la synthétiser. */
export function breathDuration(depth = 'normal') {
  return (BREATH_PRESETS[depth] || BREATH_PRESETS.normal).duration;
}
