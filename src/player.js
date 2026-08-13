/**
 * player.js — l'enchaînement.
 *
 * Le découpage (prosody.js) dit QUOI lire et combien de silence laisser ;
 * le moteur de voix dit à QUOI ça ressemble. Il reste le plus délicat :
 * enchaîner sans trou. Une synthèse neuronale met 200 ms à 2 s à produire
 * une phrase ; si on attend qu'elle finisse pour lancer la suivante, on
 * entend le moteur réfléchir entre chaque phrase, et l'illusion tombe.
 *
 * On tient donc une longueur d'avance : les phrases suivantes se fabriquent
 * pendant que la précédente se joue, et tout est posé sur l'horloge audio à
 * des instants absolus. Le son est calé à l'échantillon près, indépendamment
 * des soubresauts du fil d'exécution JavaScript.
 *
 * Rien ici ne touche au navigateur : `sink` et `engine` sont injectés, ce qui
 * rend l'enchaînement testable sans carte son.
 */

import { makeBreathPCM } from './breath.js';
import { mettreEnForme } from './silence.js';

const DEFAULTS = {
  lookahead: 2.5,   // secondes d'audio d'avance à garder planifiées
  prefetch: 3,      // phrases à synthétiser d'avance
  // Battement de l'ordonnanceur. C'est aussi la précision du suivi du texte :
  // au-delà d'une centaine de millisecondes, l'œil voit le surlignage
  // décrocher de la voix.
  tickMs: 80,
  leadIn: 0.12,     // marge avant le tout premier son, pour ne pas le tronquer
  /**
   * Respiration coupée par défaut : le souffle synthétisé s'entend comme un
   * bruit et non comme une inspiration. Le découpage continue de marquer les
   * endroits où respirer — il suffit de remonter ce gain pour les entendre.
   */
  breathGain: 0,
  rate: 1,
  voice: null,
};

const defaultTimer = {
  start: (fn, ms) => setInterval(fn, ms),
  stop: (id) => clearInterval(id),
};

/**
 * @param {object} deps
 * @param {{sampleRate:number, synthesize(text:string, opts:object):Promise<Float32Array>}} deps.engine
 * @param {{sampleRate:number, now():number, play(pcm:Float32Array, at:number):any,
 *          stopAll():void, resume():void, suspend():void}} deps.sink
 *        `now()` doit se figer quand le son est en pause : c'est ce que fait
 *        l'horloge d'un AudioContext suspendu, et tout le calage en dépend.
 */
export function createPlayer({ engine, sink, timer = defaultTimer, options = {} }) {
  const opts = { ...DEFAULTS, ...options };

  const listeners = new Map();
  const cache = new Map();     // index -> Promise<Float32Array>
  let scheduled = [];          // {index, at, end} des phrases posées sur l'horloge

  let segments = [];
  let stats = null;
  let index = 0;               // prochaine phrase à planifier
  let announced = -1;          // dernière phrase signalée comme « en cours »
  let cursor = 0;              // instant absolu où insérer la suite
  let state = 'idle';          // idle | playing | paused | ended
  let tickId = null;
  let pumping = false;
  let pumpPromise = Promise.resolve();
  let generation = 0;          // incrémenté à chaque saut : périme les synthèses en vol

  let voice = opts.voice;
  let rate = opts.rate;
  let breathGain = opts.breathGain;
  let finVoix = 0;             // instant où la dernière phrase s'est tue

  function emit(name, payload) {
    const set = listeners.get(name);
    if (!set) return;
    for (const fn of set) {
      try { fn(payload); } catch { /* un auditeur fautif ne casse pas la lecture */ }
    }
  }

  function on(name, fn) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(fn);
    return () => listeners.get(name).delete(fn);
  }

  /** Synthèse d'une phrase, mise en cache pour ne jamais la refaire deux fois. */
  function pcmFor(i) {
    if (cache.has(i)) return cache.get(i);
    const seg = segments[i];
    const gen = generation;
    const promise = Promise.resolve()
      .then(() => engine.synthesize(seg.text, {
        voice,
        rate,
        index: i,
        // La ligne mélodique du paragraphe, décidée au découpage.
        pitch: seg.pitch ?? 0,
        tempo: seg.tempo ?? 1,
      }))
      .then((pcm) => (pcm instanceof Float32Array ? pcm : Float32Array.from(pcm || [])))
      // Le moteur emballe chaque phrase dans une quantité de silence qui lui
      // appartient et qui varie sans raison. On la retire pour que les
      // durées décidées par le découpage soient celles qu'on entend.
      .then((pcm) => mettreEnForme(pcm, { sampleRate: sink.sampleRate }))
      .catch((error) => {
        // Une phrase qui refuse de se synthétiser ne doit pas arrêter le livre :
        // on la saute en silence et on le signale.
        if (gen === generation) emit('error', { index: i, error });
        return new Float32Array(0);
      });
    cache.set(i, promise);
    return promise;
  }

  /** Signale les phrases dont la lecture vient de commencer. */
  function announce() {
    // Ce que l'auditeur entend maintenant a été programmé une latence plus
    // tôt : on suit l'oreille, pas l'horloge.
    const now = sink.now() - (sink.latency || 0);
    let changed = false;
    for (const item of scheduled) {
      if (item.at <= now && item.index > announced) {
        announced = item.index;
        changed = true;
      }
    }
    if (changed) {
      const seg = segments[announced];
      emit('segment', { index: announced, segment: seg, total: segments.length });
      emit('progress', {
        index: announced,
        total: segments.length,
        ratio: segments.length ? (announced + 1) / segments.length : 0,
      });
    }
    // Purge ce qui est déjà passé, pour que la liste ne grossisse pas sur un livre.
    scheduled = scheduled.filter((item) => item.end > now - 1);
  }

  function finish() {
    state = 'ended';
    stopTicking();
    emit('state', state);
    emit('end', { total: segments.length });
  }

  /**
   * Un seul tour d'ordonnanceur à la fois : s'il y en a déjà un en vol, on
   * rend sa promesse plutôt que d'en lancer un second, qui planifierait les
   * mêmes phrases en double. Rendre la promesse — et non `undefined` — permet
   * aussi d'attendre la fin d'un tour, ce dont les tests ont besoin.
   */
  function pump() {
    if (state !== 'playing') return Promise.resolve();
    if (pumping) return pumpPromise;
    pumping = true;
    pumpPromise = runPump().finally(() => { pumping = false; });
    return pumpPromise;
  }

  async function runPump() {
    const gen = generation;
    try {
      announce();

      // Lance en avance les synthèses à venir, sans les attendre.
      for (let k = index; k < Math.min(index + opts.prefetch, segments.length); k++) pcmFor(k);

      while (
        state === 'playing' && gen === generation &&
        index < segments.length &&
        cursor - sink.now() < opts.lookahead
      ) {
        const i = index;
        const seg = segments[i];
        const pcm = await pcmFor(i);
        if (gen !== generation || state !== 'playing') break;

        // Jamais dans le passé : après une longue synthèse, l'horloge a avancé.
        let at = Math.max(cursor, sink.now() + opts.leadIn);

        if (seg.breathBefore && breathGain > 0) {
          const breath = makeBreathPCM(seg.breathDepth, {
            sampleRate: sink.sampleRate,
            gain: breathGain,
          });
          const souffle = breath.length / sink.sampleRate;

          // Un lecteur reprend son souffle PENDANT le silence, pas en plus de
          // lui : ajouter la respiration à la pause donnait des trous de plus
          // d'une seconde et demie entre deux paragraphes. On la cale donc
          // pour qu'elle s'achève quand la voix reprend, et on ne repousse la
          // voix que si la pause est trop courte pour l'accueillir.
          const debut = Math.max(finVoix, at - souffle, sink.now());
          if (debut + souffle > at) at = debut + souffle;
          sink.play(breath, at - souffle);
        }

        const speechStart = at;
        if (pcm.length) sink.play(pcm, at);
        at += pcm.length / sink.sampleRate;
        finVoix = at;

        scheduled.push({ index: i, at: speechStart, end: at });

        cursor = at + seg.pauseAfter / 1000;
        index = i + 1;

        // On garde une phrase derrière soi (retour arrière immédiat), pas plus :
        // un livre entier en mémoire, c'est plusieurs centaines de mégaoctets.
        cache.delete(i - 2);
      }

      if (index >= segments.length && state === 'playing' && sink.now() >= cursor) finish();
    } catch (error) {
      emit('error', { index, error });
    }
  }

  function startTicking() {
    if (tickId !== null) return;
    // `announce` AVANT `pump`, et surtout en dehors de lui : `pump` rend la
    // main aussitôt quand une synthèse est déjà en vol, et celle-ci peut
    // durer deux secondes. Tant que le suivi du texte vivait à l'intérieur,
    // il restait figé pendant ce temps puis rattrapait d'un bond — le
    // surlignage était en retard sur la voix à chaque phrase.
    tickId = timer.start(() => { announce(); pump(); }, opts.tickMs);
  }

  function stopTicking() {
    if (tickId === null) return;
    timer.stop(tickId);
    tickId = null;
  }

  function resetTo(i) {
    generation++;
    sink.stopAll();
    scheduled = [];
    cache.clear();
    index = Math.max(0, Math.min(i, segments.length));
    announced = index - 1;
    cursor = sink.now() + opts.leadIn;
    finVoix = sink.now();
  }

  return {
    on,

    /** Charge un texte et le découpe. Renvoie les statistiques du découpage. */
    load(result) {
      // Accepte le retour brut de prosody.segment().
      segments = result.segments || [];
      stats = result.stats || null;
      sink.stopAll();
      stopTicking();
      generation++;
      cache.clear();
      scheduled = [];
      index = 0;
      announced = -1;
      cursor = 0;
      finVoix = 0;
      state = 'idle';
      emit('state', state);
      return stats;
    },

    play() {
      if (!segments.length || state === 'playing') return;
      if (state === 'paused') {
        sink.resume();
      } else {
        // Départ, ou relecture après la fin.
        if (state === 'ended') resetTo(0);
        else {
          sink.resume();
          cursor = sink.now() + opts.leadIn;
        }
      }
      state = 'playing';
      emit('state', state);
      startTicking();
      pump();
    },

    pause() {
      if (state !== 'playing') return;
      state = 'paused';
      stopTicking();
      sink.suspend();
      emit('state', state);
    },

    stop() {
      stopTicking();
      resetTo(0);
      state = 'idle';
      emit('state', state);
    },

    /** Saute à une phrase. Reprend la lecture immédiatement si elle était en cours. */
    seek(i) {
      const wasPlaying = state === 'playing';
      resetTo(i);
      emit('seek', { index: this.index });
      if (wasPlaying) pump();
      else if (state === 'ended') { state = 'idle'; emit('state', state); }
    },

    next() { this.seek(index); },
    previous() { this.seek(Math.max(0, (announced >= 0 ? announced : index) - 1)); },

    /**
     * Change de voix ou de débit. La phrase en cours est relancée avec le
     * nouveau réglage : l'entendre changer tout de suite vaut mieux que
     * d'attendre la fin d'un paragraphe pour savoir si ça sonne mieux.
     */
    setVoice(v) {
      if (v === voice) return;
      voice = v;
      const from = announced >= 0 ? announced : index;
      const wasPlaying = state === 'playing';
      resetTo(from);
      if (wasPlaying) pump();
    },

    setRate(r) {
      if (r === rate) return;
      rate = r;
      const from = announced >= 0 ? announced : index;
      const wasPlaying = state === 'playing';
      resetTo(from);
      if (wasPlaying) pump();
    },

    setBreathGain(g) { breathGain = g; },

    get state() { return state; },
    get index() { return index; },
    get current() { return announced; },
    get segments() { return segments; },
    get stats() { return stats; },
    get voice() { return voice; },
    get rate() { return rate; },

    /** Exposé pour les tests : fait tourner l'ordonnanceur d'un cran. */
    async _pump() { await pump(); },
  };
}
