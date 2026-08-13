import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayer } from '../src/player.js';
import { segment } from '../src/prosody.js';
import { breathDuration } from '../src/breath.js';

const SR = 22050;

/** Carte son factice, avec une horloge qu'on fait avancer à la main. */
function fakeSink(sampleRate = SR) {
  let t = 0;
  let suspended = false;
  return {
    sampleRate,
    played: [],
    stops: 0,
    now: () => t,
    play(pcm, at) { this.played.push({ at, seconds: pcm.length / sampleRate, length: pcm.length }); },
    stopAll() { this.stops++; this.played.length = 0; },
    resume() { suspended = false; },
    suspend() { suspended = true; },
    advance(dt) { if (!suspended) t += dt; },
    get suspended() { return suspended; },
  };
}

/** Moteur factice : une durée proportionnelle au texte, et un journal des appels. */
function fakeEngine(opts = {}) {
  const { charsPerSecond = 14.5, fail = () => false, sampleRate = SR } = opts;
  return {
    sampleRate,
    calls: [],
    async synthesize(text, o) {
      this.calls.push({ text, ...o });
      if (fail(text, o)) throw new Error('synthèse impossible');
      return new Float32Array(Math.round((text.length / charsPerSecond) * sampleRate));
    },
  };
}

/** Minuterie manuelle : c'est le test qui décide quand l'ordonnanceur bat. */
function fakeTimer() {
  return {
    fn: null,
    start(fn) { this.fn = fn; return 1; },
    stop() { this.fn = null; },
    get running() { return this.fn !== null; },
  };
}

function setup(text, playerOpts = {}, engineOpts = {}) {
  const sink = fakeSink();
  const engine = fakeEngine(engineOpts);
  const timer = fakeTimer();
  const player = createPlayer({ engine, sink, timer, options: playerOpts });
  player.load(segment(text, playerOpts.segmentOptions));
  return { sink, engine, timer, player };
}

const PHRASES = 'Première phrase du livre. Deuxième phrase du livre. Troisième phrase du livre.';

/**
 * Écoute jusqu'au bout : le lecteur ne planifie que quelques secondes
 * d'avance, il faut donc faire tourner l'horloge pour obtenir la suite.
 */
async function ecouterJusquAuBout(sink, player, { pas = 1, max = 300 } = {}) {
  for (let n = 0; n < max && player.state === 'playing'; n++) {
    await player._pump();
    sink.advance(pas);
  }
  await player._pump();
}

test('la lecture pose les phrases dans l’ordre, sans chevauchement', async () => {
  const { sink, player } = setup(PHRASES);
  player.play();
  await ecouterJusquAuBout(sink, player);

  assert.ok(sink.played.length >= 3, `${sink.played.length} tampons joués`);
  for (let i = 1; i < sink.played.length; i++) {
    const prev = sink.played[i - 1];
    assert.ok(sink.played[i].at >= prev.at + prev.seconds - 1e-9,
      `chevauchement entre ${i - 1} et ${i}`);
  }
});

test('le premier son n’est pas collé à l’instant zéro', async () => {
  const { sink, player } = setup(PHRASES, { leadIn: 0.2 });
  player.play();
  await player._pump();
  assert.ok(sink.played[0].at >= 0.2 - 1e-9);
});

test('le silence entre deux phrases vaut celui du découpage', async () => {
  const { sink, player } = setup('Bonjour. Comment vas-tu ?', { breathGain: 0 });
  const attendu = player.segments[0].pauseAfter / 1000;
  player.play();
  await player._pump();

  const [a, b] = sink.played;
  const observe = b.at - (a.at + a.seconds);
  assert.ok(Math.abs(observe - attendu) < 1e-6, `silence ${observe}s au lieu de ${attendu}s`);
});

test('une question laisse un silence plus long qu’un point', async () => {
  const point = setup('Un texte simple. Suite du texte.', { breathGain: 0 });
  const question = setup('Un texte simple ? Suite du texte.', { breathGain: 0 });
  for (const s of [point, question]) { s.player.play(); await s.player._pump(); }

  const gap = ({ sink }) => sink.played[1].at - (sink.played[0].at + sink.played[0].seconds);
  assert.ok(gap(question) > gap(point));
});

test('une respiration s’insère juste avant la phrase concernée', async () => {
  const long = 'Cette phrase a une longueur tout à fait ordinaire pour un livre. ';
  // La respiration est coupée par défaut : un test qui la vérifie l'allume.
  const { sink, player } = setup(long.repeat(12), {
    breathGain: 1,
    segmentOptions: { breathEvery: 8 },
  });
  player.play();
  await ecouterJusquAuBout(sink, player);

  const respirants = player.segments.filter((s) => s.breathBefore);
  assert.ok(respirants.length > 0, 'le découpage devrait prévoir des respirations');

  // Une respiration est un tampon court, de la durée exacte du profil.
  const durees = new Set(['short', 'normal', 'deep'].map(breathDuration));
  const souffles = sink.played.filter((p) => [...durees].some((d) => Math.abs(p.seconds - d) < 0.01));
  assert.ok(souffles.length > 0, 'aucun souffle planifié');

  // Chaque souffle est immédiatement suivi d’une phrase, sans silence entre les deux.
  for (const souffle of souffles) {
    const suivant = sink.played.find((p) => p.at > souffle.at);
    assert.ok(suivant, 'un souffle en fin de file');
    assert.ok(Math.abs(suivant.at - (souffle.at + souffle.seconds)) < 1e-6,
      'le souffle doit être collé à la phrase qui suit');
  }
});

test('on coupe les respirations sans toucher au reste', async () => {
  const long = 'Cette phrase a une longueur tout à fait ordinaire pour un livre. ';
  const { sink, player } = setup(long.repeat(12), { breathGain: 0, segmentOptions: { breathEvery: 8 } });
  player.play();
  await ecouterJusquAuBout(sink, player);

  const durees = ['short', 'normal', 'deep'].map(breathDuration);
  const souffles = sink.played.filter((p) => durees.some((d) => Math.abs(p.seconds - d) < 0.01));
  assert.equal(souffles.length, 0);
});

test('on ne planifie que l’horizon demandé, pas le livre entier', async () => {
  const { sink, player } = setup('Une phrase de longueur normale ici. '.repeat(60), { lookahead: 2.5 });
  player.play();
  await player._pump();

  assert.ok(player.segments.length > 40);
  assert.ok(sink.played.length < 10, `${sink.played.length} tampons planifiés d’un coup`);
});

test('l’avance se reconstitue au fil de l’écoute', async () => {
  const { sink, player } = setup('Une phrase de longueur normale ici. '.repeat(60));
  player.play();
  await player._pump();
  const premier = sink.played.length;

  sink.advance(10);
  await player._pump();
  assert.ok(sink.played.length > premier, 'rien n’a été planifié après avoir avancé');
});

test('la phrase en cours est signalée quand elle commence, et une seule fois', async () => {
  const { sink, player } = setup(PHRASES);
  const vus = [];
  player.on('segment', (e) => vus.push(e.index));

  player.play();
  await player._pump();
  assert.deepEqual(vus, [], 'rien ne doit être signalé avant le premier son');

  sink.advance(0.5);
  await player._pump();
  assert.deepEqual(vus, [0]);

  sink.advance(0.5);
  await player._pump();
  assert.deepEqual(vus, [0]);

  await ecouterJusquAuBout(sink, player);
  assert.deepEqual(vus, [0, 1, 2]);
});

test('chaque phrase n’est synthétisée qu’une fois', async () => {
  const { sink, engine, player } = setup(PHRASES);
  player.play();
  await player._pump();
  sink.advance(3);
  await player._pump();
  sink.advance(3);
  await player._pump();

  const textes = engine.calls.map((c) => c.text);
  assert.equal(new Set(textes).size, textes.length, `doublons : ${textes.join(' | ')}`);
});

test('la pause fige l’horloge et arrête l’ordonnanceur', async () => {
  const { sink, timer, player } = setup(PHRASES);
  player.play();
  await player._pump();
  assert.ok(timer.running);

  player.pause();
  assert.equal(player.state, 'paused');
  assert.ok(!timer.running);
  assert.ok(sink.suspended);

  const avant = sink.now();
  sink.advance(5);
  assert.equal(sink.now(), avant, 'l’horloge ne doit pas avancer en pause');
});

test('la reprise repart sans tout replanifier', async () => {
  const { sink, engine, player } = setup(PHRASES);
  player.play();
  await player._pump();
  const appels = engine.calls.length;
  const coupures = sink.stops; // load() en a déjà provoqué une : on part de là

  player.pause();
  player.play();
  await player._pump();

  assert.equal(player.state, 'playing');
  assert.equal(engine.calls.length, appels, 'la reprise ne doit rien resynthétiser');
  assert.equal(sink.stops, coupures, 'la reprise ne doit pas vider la file audio');
});

test('un saut vide la file et repart à la bonne phrase', async () => {
  const { sink, player } = setup(PHRASES);
  player.play();
  await player._pump();

  player.seek(2);
  assert.ok(sink.stops > 0, 'le son en cours doit être coupé');
  await player._pump();

  const vus = [];
  player.on('segment', (e) => vus.push(e.index));
  sink.advance(1);
  await player._pump();
  assert.deepEqual(vus, [2]);
});

test('changer de voix relance la phrase en cours avec la nouvelle', async () => {
  const { sink, engine, player } = setup(PHRASES, { voice: 'gilles' });
  player.play();
  await player._pump();
  sink.advance(0.5);
  await player._pump();
  assert.equal(player.current, 0);

  player.setVoice('siwis');
  await player._pump();

  const reprise = engine.calls.filter((c) => c.voice === 'siwis');
  assert.ok(reprise.length > 0, 'rien n’a été resynthétisé avec la nouvelle voix');
  assert.equal(reprise[0].text, player.segments[0].text, 'la phrase en cours doit être reprise');
  assert.ok(engine.calls.filter((c) => c.voice === 'gilles').length > 0, 'la voix d’avant doit avoir servi');
});

test('une phrase qui ne se synthétise pas est signalée puis sautée', async () => {
  const { sink, player } = setup(PHRASES, {}, { fail: (t) => t.startsWith('Deuxième') });
  const erreurs = [];
  player.on('error', (e) => erreurs.push(e.index));

  player.play();
  await player._pump();
  sink.advance(10);
  await player._pump();

  assert.deepEqual(erreurs, [1]);
  const vus = [];
  player.on('segment', (e) => vus.push(e.index));
  sink.advance(10);
  await player._pump();
  assert.ok(player.current >= 2, 'la lecture doit avoir dépassé la phrase fautive');
});

test('la fin du texte est annoncée une fois le dernier son écoulé', async () => {
  const { sink, player } = setup(PHRASES);
  let fini = 0;
  player.on('end', () => fini++);

  player.play();
  await player._pump();
  assert.equal(fini, 0);

  await ecouterJusquAuBout(sink, player);
  assert.equal(fini, 1);
  assert.equal(player.state, 'ended');

  // Une fois arrivé au bout, on n’annonce pas la fin en boucle.
  await player._pump();
  assert.equal(fini, 1);
});

test('l’avancement est rapporté en proportion', async () => {
  const { sink, player } = setup(PHRASES);
  const ratios = [];
  player.on('progress', (e) => ratios.push(e.ratio));
  player.play();
  await ecouterJusquAuBout(sink, player);
  assert.ok(ratios.length >= 1);
  assert.equal(ratios[ratios.length - 1], 1);
});

test('un texte vide ne fait rien planter', async () => {
  const { sink, player } = setup('   ');
  player.play();
  await player._pump();
  assert.equal(sink.played.length, 0);
  assert.equal(player.state, 'idle');
});

test('l’arrêt remet au début', async () => {
  const { sink, player } = setup(PHRASES);
  player.play();
  await player._pump();
  sink.advance(2);
  await player._pump();

  player.stop();
  assert.equal(player.state, 'idle');
  assert.equal(player.index, 0);
  assert.equal(player.current, -1);
});

test('les auditeurs peuvent se désabonner', async () => {
  const { sink, player } = setup(PHRASES);
  const vus = [];
  const off = player.on('segment', (e) => vus.push(e.index));
  player.play();
  await player._pump();
  sink.advance(0.5);
  await player._pump();
  assert.deepEqual(vus, [0]);

  off();
  sink.advance(10);
  await player._pump();
  assert.deepEqual(vus, [0]);
});

test('un auditeur qui plante n’interrompt pas la lecture', async () => {
  const { sink, player } = setup(PHRASES);
  player.on('segment', () => { throw new Error('auditeur fautif'); });
  player.play();
  await player._pump();
  sink.advance(10);
  await player._pump();
  assert.ok(player.current >= 1);
});

test('le suivi du texte continue pendant une synthèse longue', async () => {
  // Le défaut corrigé : `announce` vivait DANS `pump`, lequel rend la main
  // aussitôt si une synthèse est déjà en vol. Pendant les deux secondes que
  // peut durer une phrase, le surlignage restait donc figé, puis rattrapait
  // d'un bond. Il était en retard sur la voix à chaque phrase.
  let debloquer;
  const bloquee = new Promise((r) => { debloquer = r; });
  let appels = 0;

  const sink = fakeSink();
  const timer = fakeTimer();
  const engine = {
    sampleRate: SR,
    async synthesize(text) {
      appels += 1;
      if (appels === 2) await bloquee;      // la deuxième phrase traîne
      return new Float32Array(Math.round((text.length / 14.5) * SR));
    },
  };

  const player = createPlayer({ engine, sink, timer, options: { breathGain: 0 } });
  player.load(segment(PHRASES));

  const vus = [];
  player.on('segment', ({ index }) => vus.push(index));

  player.play();
  await new Promise((r) => { setTimeout(r, 0); });   // laisse la 1re se poser

  assert.ok(sink.played.length >= 1, 'la première phrase devrait être planifiée');
  assert.deepEqual(vus, [], 'rien ne peut encore être entendu à l’instant zéro');

  // L'horloge avance alors que la synthèse de la deuxième est toujours en vol.
  sink.advance(1);
  timer.fn();

  assert.deepEqual(vus, [0], 'la phrase en cours doit être signalée malgré la synthèse');
  debloquer();
});

test('le suivi du texte tient compte de la latence de sortie', async () => {
  // Le son programmé à un instant n'atteint le haut-parleur qu'après la
  // latence : suivre l'horloge brute ferait surligner avant qu'on entende.
  const sink = { ...fakeSink(), latency: 0.25 };
  const timer = fakeTimer();
  const player = createPlayer({
    engine: fakeEngine(), sink, timer, options: { breathGain: 0 },
  });
  player.load(segment(PHRASES));

  const vus = [];
  player.on('segment', ({ index }) => vus.push(index));
  player.play();
  await player._pump();

  // La première phrase démarre à 0,12 s : à 0,20 s d'horloge, l'oreille n'en
  // est encore qu'à -0,05 s. Rien ne doit être signalé.
  sink.advance(0.2);
  timer.fn();
  assert.deepEqual(vus, [], 'signalé trop tôt : la latence n’est pas retirée');

  sink.advance(0.4);
  timer.fn();
  assert.deepEqual(vus, [0]);
});
