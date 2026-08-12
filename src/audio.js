/**
 * audio.js — la sortie son du navigateur.
 *
 * Implémente le contrat `sink` attendu par player.js, en s'appuyant sur
 * l'AudioContext. Deux propriétés en font tout l'intérêt :
 *
 *  - son horloge (`currentTime`) est celle de la carte son, pas celle de
 *    JavaScript : un calage posé à 3,412 s sera tenu à l'échantillon près,
 *    même si le fil principal est occupé à afficher du texte ;
 *  - suspendre le contexte fige cette horloge, ce qui met la lecture en
 *    pause sans avoir à recalculer un seul instant au redémarrage.
 */

/** @returns {boolean} le navigateur sait-il faire de l'audio programmé ? */
export function audioSupported() {
  return typeof window !== 'undefined' &&
    !!(window.AudioContext || window.webkitAudioContext);
}

/**
 * @param {{sampleRate?: number, volume?: number}} opts
 *        `sampleRate` doit être celui du moteur de voix : laisser le
 *        navigateur rééchantillonner coûte de la qualité et du calcul.
 */
export function createAudioSink(opts = {}) {
  const { sampleRate = 22050, volume = 1 } = opts;
  const Ctor = window.AudioContext || window.webkitAudioContext;

  // Certains navigateurs refusent une fréquence imposée : on retombe alors
  // sur la leur, et c'est eux qui rééchantillonnent.
  let ctx;
  try {
    ctx = new Ctor({ sampleRate, latencyHint: 'playback' });
  } catch {
    ctx = new Ctor({ latencyHint: 'playback' });
  }

  const master = ctx.createGain();
  master.gain.value = volume;
  master.connect(ctx.destination);

  /** Sources encore programmées ou en cours, pour pouvoir tout couper net. */
  let live = new Set();

  return {
    get sampleRate() { return ctx.sampleRate; },
    get context() { return ctx; },
    get state() { return ctx.state; },

    now() { return ctx.currentTime; },

    /**
     * Programme un bloc de son à un instant absolu de l'horloge audio.
     * @param {Float32Array} pcm mono, dans [-1, 1]
     * @param {number} at instant en secondes sur la même horloge que now()
     */
    play(pcm, at) {
      if (!pcm || !pcm.length) return null;
      const buffer = ctx.createBuffer(1, pcm.length, this.sampleRate);
      buffer.copyToChannel(pcm, 0);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(master);
      source.start(Math.max(at, ctx.currentTime));

      live.add(source);
      source.onended = () => live.delete(source);
      return source;
    },

    stopAll() {
      for (const source of live) {
        try { source.stop(); } catch { /* déjà terminée */ }
        source.disconnect();
      }
      live = new Set();
    },

    /** Reprend le contexte. À appeler depuis un geste de l'utilisateur. */
    resume() {
      if (ctx.state !== 'running') return ctx.resume();
      return Promise.resolve();
    },

    suspend() {
      if (ctx.state === 'running') return ctx.suspend();
      return Promise.resolve();
    },

    setVolume(v) {
      // Rampe courte : un changement instantané de gain s'entend comme un clic.
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
    },

    async close() {
      this.stopAll();
      try { await ctx.close(); } catch { /* déjà fermé */ }
    },
  };
}
