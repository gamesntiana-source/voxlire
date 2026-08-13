/**
 * voix.test.mjs — le magasin de voix, sans navigateur.
 *
 * Ce qui est vérifié ici tient en une phrase : une voix ne se télécharge
 * jamais deux fois. Ni quand deux parties du programme la demandent en même
 * temps — le téléchargement de fond et l'appui sur Lire — ni au lancement
 * suivant, puisqu'elle est en cache. Sur des fichiers de 60 Mo, l'erreur se
 * paierait en forfait mobile.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// --- faux Cache Storage -----------------------------------------------------
// On ne retient que la taille : garder les octets ferait grossir le test de
// plusieurs dizaines de mégaoctets pour rien.
const stockage = new Map();
const faussesCaches = {
  async match(cle) { return stockage.has(cle) ? { taille: stockage.get(cle) } : undefined; },
  async put(cle, reponse) { stockage.set(cle, reponse); },
  async delete(cle) { return stockage.delete(cle); },
};
globalThis.caches = { open: async () => faussesCaches };

// --- faux réseau ------------------------------------------------------------
let appelsReseau = [];
globalThis.fetch = async (url) => {
  appelsReseau.push(url);
  const octets = TAILLES.get(url) ?? 4157;
  return new Response(new Uint8Array(octets), { status: 200, headers: { 'content-length': String(octets) } });
};

const { installVoice, installAllVoices, voiceStatus, CATALOGUE } =
  await import('../src/engines/index.js');

/** Tailles attendues, prises du catalogue lui-même. */
const TAILLES = new Map();
for (const voix of CATALOGUE) for (const f of voix.files) TAILLES.set(f.url, f.bytes);

/** La voix la plus légère du catalogue : 28 Mo plutôt que 77. */
const LEGERE = 'siwis-legere';

function reinitialiser() {
  stockage.clear();
  appelsReseau = [];
}

// ---------------------------------------------------------------------------

test('une voix absente se télécharge, fichier par fichier', async () => {
  reinitialiser();
  const statut = await installVoice(LEGERE);
  assert.equal(statut.installed, true);
  assert.equal(appelsReseau.length, 2, 'un modèle et sa configuration');
});

test('une voix déjà installée ne coûte pas un octet', async () => {
  reinitialiser();
  await installVoice(LEGERE);
  appelsReseau = [];

  await installVoice(LEGERE);
  assert.deepEqual(appelsReseau, [], 'le cache aurait dû suffire');
});

test('deux demandes simultanées ne téléchargent qu’une fois', async () => {
  // C'est le cas réel : le téléchargement de fond a commencé, et
  // l'utilisateur appuie sur Lire sur la même voix.
  reinitialiser();
  const vues = [[], []];
  await Promise.all([
    installVoice(LEGERE, (p) => vues[0].push(p)),
    installVoice(LEGERE, (p) => vues[1].push(p)),
  ]);

  assert.equal(appelsReseau.length, 2, `${appelsReseau.length} requêtes au lieu de 2`);
  assert.ok(vues[0].length > 0, 'le premier appelant doit être informé');
  assert.ok(vues[1].length > 0, 'le second aussi, en se greffant sur le premier');
});

test('les deux voix d’un même paquet arrivent ensemble', async () => {
  // Jessica et Pierre sont le même fichier de 77 Mo : installer l'une doit
  // installer l'autre, sans second téléchargement.
  reinitialiser();
  await installVoice('jessica');
  const avant = appelsReseau.length;

  assert.equal((await voiceStatus('pierre')).installed, true, 'Pierre devrait suivre Jessica');
  await installVoice('pierre');
  assert.equal(appelsReseau.length, avant, 'Pierre ne doit rien retélécharger');
});

test('toutes les voix s’installent, chaque paquet une seule fois', async () => {
  reinitialiser();
  const { installes, echecs } = await installAllVoices();

  const paquets = new Set(CATALOGUE.map((v) => v.pack));
  assert.deepEqual(echecs, []);
  assert.equal(installes, paquets.size, `${installes} paquets installés sur ${paquets.size}`);
  // Deux fichiers par paquet, jamais plus.
  assert.equal(appelsReseau.length, paquets.size * 2);

  for (const voix of CATALOGUE) {
    assert.equal((await voiceStatus(voix.id)).installed, true, voix.label);
  }
});

test('un second lancement ne retélécharge rien', async () => {
  reinitialiser();
  await installAllVoices();
  appelsReseau = [];

  const { installes } = await installAllVoices();
  assert.equal(installes, 0, 'rien ne restait à installer');
  assert.deepEqual(appelsReseau, [], 'aucun octet ne doit repasser par le réseau');
});

test('la progression est rapportée avec le rang et la part', async () => {
  reinitialiser();
  const vues = [];
  await installAllVoices((p) => vues.push(p));

  assert.ok(vues.length > 0);
  const paquets = new Set(CATALOGUE.map((v) => v.pack));
  assert.equal(Math.max(...vues.map((v) => v.nombre)), paquets.size);
  assert.equal(Math.max(...vues.map((v) => v.rang)), paquets.size);
  for (const v of vues) {
    assert.ok(v.part >= 0 && v.part <= 1, `part hors bornes : ${v.part}`);
    assert.ok(typeof v.label === 'string' && v.label.length > 0);
  }
});

test('la voix par défaut est installée en premier', async () => {
  // Elle seule permet de lire : les autres peuvent attendre.
  reinitialiser();
  const rangs = new Map();
  await installAllVoices((p) => { if (!rangs.has(p.label)) rangs.set(p.label, p.rang); });

  const defaut = CATALOGUE.find((v) => v.defaut);
  assert.equal(rangs.get(defaut.label), 1, `${defaut.label} devrait passer en premier`);
});
