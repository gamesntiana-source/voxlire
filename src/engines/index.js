/**
 * engines/index.js — le magasin de voix.
 *
 * Une voix neuronale, c'est un ou deux fichiers de plusieurs dizaines de
 * mégaoctets. On les télécharge une fois, on les range dans un cache à part,
 * et on ne les redemande plus jamais. Tout ce module tourne autour de cette
 * idée : rendre le téléchargement visible et unique.
 *
 * Le cache utilisé n'est PAS celui du service worker : une mise à jour de
 * l'application ne doit pas coûter un nouveau téléchargement des voix.
 */

import { CATALOGUE, VOIX_PAR_DEFAUT } from './catalogue.js';

const CACHE_VOIX = 'voxlire-voix-v1';

/**
 * Moteurs déjà ouverts, indexés par PAQUET et non par voix : ouvrir une
 * session ONNX coûte plusieurs secondes, et deux voix d'un même fichier
 * (Jessica et Pierre) doivent la partager. Le locuteur, lui, se choisit à
 * chaque synthèse : c'est un simple numéro passé au modèle.
 */
const moteurs = new Map();

/** Façades par voix : elles partagent la session du paquet, avec leur locuteur. */
const facades = new Map();

function definition(id) {
  const voix = CATALOGUE.find((v) => v.id === id);
  if (!voix) throw new Error(`Voix inconnue : ${id}`);
  return voix;
}

/**
 * Clé de cache : construite sur le paquet, pas sur la voix. Installer
 * Jessica installe Pierre, et le fichier de 73 Mo n'est téléchargé qu'une fois.
 */
function cle(pack, role) {
  return `/voxlire-voix/${pack}/${role}`;
}

async function cache() {
  return caches.open(CACHE_VOIX);
}

/** Une voix est installée quand tous ses fichiers sont dans le cache. */
export async function voiceStatus(id) {
  const voix = definition(id);
  const c = await cache();
  const presents = await Promise.all(
    voix.files.map(async (f) => !!(await c.match(cle(voix.pack, f.role)))),
  );
  return {
    id,
    pack: voix.pack,
    installed: presents.every(Boolean),
    partial: presents.some(Boolean) && !presents.every(Boolean),
    bytes: voix.files.reduce((a, f) => a + f.bytes, 0),
  };
}

export async function listVoices() {
  return Promise.all(CATALOGUE.map(async (voix) => ({
    ...voix,
    bytes: voix.files.reduce((a, f) => a + f.bytes, 0),
    ...(await voiceStatus(voix.id)),
    /** Autres voix livrées dans le même téléchargement. */
    compagnes: CATALOGUE.filter((v) => v.pack === voix.pack && v.id !== voix.id)
      .map((v) => v.label),
  })));
}

/**
 * Télécharge un fichier en rapportant l'avancement.
 *
 * On lit le flux morceau par morceau plutôt que d'attendre `response.blob()` :
 * sur 60 Mo en 4G, une barre qui bouge fait toute la différence entre
 * « ça charge » et « c'est planté ».
 */
async function telecharger(url, attendu, onChunk) {
  const reponse = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!reponse.ok) throw new Error(`${reponse.status} sur ${url}`);

  const annonce = Number(reponse.headers.get('content-length')) || attendu || 0;
  const morceaux = [];
  let recu = 0;

  const lecteur = reponse.body?.getReader();
  if (!lecteur) {
    // Navigateur sans flux lisible : on prend tout d'un coup, sans progression.
    const buffer = await reponse.arrayBuffer();
    onChunk(buffer.byteLength, annonce);
    return new Uint8Array(buffer);
  }

  for (;;) {
    const { done, value } = await lecteur.read();
    if (done) break;
    morceaux.push(value);
    recu += value.length;
    onChunk(recu, annonce);
  }

  const total = new Uint8Array(recu);
  let p = 0;
  for (const m of morceaux) { total.set(m, p); p += m.length; }
  return total;
}

/**
 * Téléchargements en cours, indexés par paquet.
 *
 * Sans cette table, appuyer sur Lire pendant que le téléchargement de fond
 * tourne lancerait une SECONDE descente des mêmes 63 Mo. Les deux
 * aboutiraient, la dernière écraserait la première, et l'utilisateur aurait
 * payé deux fois. Un paquet ne se télécharge qu'une fois : les appels
 * suivants se greffent sur celui qui est déjà en vol et en suivent la
 * progression.
 */
const enVol = new Map();

/**
 * Installe une voix : tous ses fichiers, avec une progression d'ensemble.
 *
 * @param {string} id
 * @param {(p:{recu:number,total:number,fichier:string})=>void} [onProgress]
 */
export async function installVoice(id, onProgress = () => {}) {
  const voix = definition(id);

  const dejaEnVol = enVol.get(voix.pack);
  if (dejaEnVol) {
    dejaEnVol.ecouteurs.add(onProgress);
    // On rejoue la dernière progression connue : sans elle, une barre qui
    // vient de s'afficher resterait à zéro jusqu'au prochain morceau reçu.
    if (dejaEnVol.dernier) onProgress(dejaEnVol.dernier);
    try { await dejaEnVol.promesse; } finally { dejaEnVol.ecouteurs.delete(onProgress); }
    return voiceStatus(id);
  }

  const suivi = { ecouteurs: new Set([onProgress]), dernier: null, promesse: null };
  suivi.promesse = telechargerPaquet(voix, (p) => {
    suivi.dernier = p;
    for (const ecouteur of suivi.ecouteurs) {
      try { ecouteur(p); } catch { /* un auditeur fautif n'arrête pas le téléchargement */ }
    }
  });
  enVol.set(voix.pack, suivi);

  try { await suivi.promesse; } finally { enVol.delete(voix.pack); }
  return voiceStatus(id);
}

/** Le téléchargement proprement dit, un paquet à la fois. */
async function telechargerPaquet(voix, onProgress) {
  const c = await cache();
  const totalAttendu = voix.files.reduce((a, f) => a + f.bytes, 0);
  let dejaFait = 0;

  for (const fichier of voix.files) {
    const clef = cle(voix.pack, fichier.role);
    if (await c.match(clef)) { dejaFait += fichier.bytes; continue; }

    let dernier = 0;
    const sources = [fichier.url, ...(fichier.mirrors || [])];
    let octets = null;
    let derniereErreur = null;

    for (const source of sources) {
      try {
        octets = await telecharger(source, fichier.bytes, (recu) => {
          dernier = recu;
          onProgress({ recu: dejaFait + recu, total: totalAttendu, fichier: fichier.role });
        });
        break;
      } catch (err) {
        derniereErreur = err;
        dernier = 0;
      }
    }
    if (!octets) throw new Error(`téléchargement impossible (${derniereErreur?.message})`);

    // Un fichier tronqué qui finit en cache est pire qu'un échec : la voix
    // paraîtrait installée et planterait à la première phrase.
    if (fichier.bytes && Math.abs(octets.length - fichier.bytes) > fichier.bytes * 0.05) {
      throw new Error(`fichier ${fichier.role} incomplet (${octets.length} octets reçus)`);
    }

    await c.put(clef, new Response(octets, {
      headers: {
        'Content-Type': fichier.type || 'application/octet-stream',
        'Content-Length': String(octets.length),
      },
    }));
    dejaFait += dernier || fichier.bytes;
  }

  onProgress({ recu: totalAttendu, total: totalAttendu, fichier: 'fin' });
}

/**
 * Installe toutes les voix du catalogue, l'une après l'autre.
 *
 * Dans l'ordre : la voix par défaut d'abord, pour qu'on puisse lire au plus
 * vite, puis les autres de la plus légère à la plus lourde. Un paquet déjà
 * présent est sauté sans un octet de réseau.
 *
 * Une seule à la fois, jamais en parallèle : trois téléchargements de 60 Mo
 * simultanés se volent la bande passante et retardent celui dont on a
 * réellement besoin, le premier.
 *
 * @param {(p:{label:string, rang:number, nombre:number, recu:number,
 *            octets:number, part:number})=>void} [onProgress]
 * @returns {Promise<{installes:number, echecs:string[]}>}
 */
export async function installAllVoices(onProgress = () => {}) {
  const paquets = new Map();
  for (const voix of CATALOGUE) {
    if (!paquets.has(voix.pack)) paquets.set(voix.pack, voix);
  }

  const parDefaut = definition(VOIX_PAR_DEFAUT).pack;
  const ordre = [...paquets.values()].sort((a, b) => {
    if (a.pack === parDefaut) return -1;
    if (b.pack === parDefaut) return 1;
    return a.files.reduce((n, f) => n + f.bytes, 0) - b.files.reduce((n, f) => n + f.bytes, 0);
  });

  const aFaire = [];
  for (const voix of ordre) {
    if (!(await voiceStatus(voix.id)).installed) aFaire.push(voix);
  }

  const echecs = [];
  let installes = 0;

  for (const [i, voix] of aFaire.entries()) {
    const octets = voix.files.reduce((n, f) => n + f.bytes, 0);
    try {
      await installVoice(voix.id, ({ recu }) => onProgress({
        label: voix.label,
        rang: i + 1,
        nombre: aFaire.length,
        recu,
        octets,
        part: octets ? Math.min(1, recu / octets) : 0,
      }));
      installes++;
    } catch (err) {
      // Une voix qui échoue ne doit pas empêcher les suivantes : on note et
      // on continue, l'utilisateur pourra toujours réessayer à la main.
      echecs.push(`${voix.label} (${err.message})`);
    }
  }

  return { installes, echecs };
}

/**
 * Désinstalle une voix — c'est-à-dire son PAQUET. Supprimer Jessica supprime
 * donc aussi Pierre : ils sont le même fichier. L'interface le dit avant.
 */
export async function removeVoice(id) {
  const voix = definition(id);
  const c = await cache();
  await Promise.all(voix.files.map((f) => c.delete(cle(voix.pack, f.role))));
  await fermerPaquet(voix.pack);
  return voiceStatus(id);
}

/** Ferme la session d'un paquet et oublie les façades qui s'appuyaient dessus. */
async function fermerPaquet(pack) {
  const ouverture = moteurs.get(pack);
  moteurs.delete(pack);
  for (const voix of CATALOGUE) if (voix.pack === pack) facades.delete(voix.id);
  if (!ouverture) return;
  try { (await ouverture).dispose?.(); } catch { /* n'avait jamais démarré */ }
}

/** Récupère les octets d'un fichier installé. */
async function lireFichier(pack, role) {
  const c = await cache();
  const reponse = await c.match(cle(pack, role));
  if (!reponse) throw new Error(`fichier « ${role} » absent du cache`);
  return reponse.arrayBuffer();
}

/**
 * Charge le moteur d'une voix. La voix doit être installée : c'est à
 * l'appelant de le vérifier, pour pouvoir afficher une barre de progression
 * plutôt qu'une erreur.
 */
export async function loadVoice(id) {
  const voix = definition(id);
  if (facades.has(id)) return facades.get(id);

  const statut = await voiceStatus(id);
  if (!statut.installed) throw new Error('voix non installée');

  // Une seule session par paquet, même si deux voix la demandent.
  let ouverture = moteurs.get(voix.pack);
  if (!ouverture) {
    ouverture = (async () => {
      const fichiers = {};
      for (const f of voix.files) fichiers[f.role] = await lireFichier(voix.pack, f.role);
      if (voix.engine !== 'piper') throw new Error(`moteur inconnu : ${voix.engine}`);
      const { createPiperEngine } = await import('./piper.js');
      return createPiperEngine(fichiers);
    })();
    // Une session qui échoue ne doit pas rester en cache : le prochain essai
    // repartirait sur la même promesse rejetée, indéfiniment.
    ouverture.catch(() => moteurs.delete(voix.pack));
    moteurs.set(voix.pack, ouverture);
  }
  const moteur = await ouverture;

  /**
   * Façade propre à la voix : elle fixe le locuteur, que le paquet en
   * contienne un ou plusieurs, et laisse le reste au moteur partagé.
   */
  const facade = {
    id,
    get sampleRate() { return moteur.sampleRate; },
    synthesize(texte, options = {}) {
      return moteur.synthesize(texte, { ...options, speaker: voix.speaker });
    },
  };
  facades.set(id, facade);
  return facade;
}

/** Libère la mémoire des moteurs chargés (changement de voix, page cachée). */
export async function unloadVoices() {
  await Promise.all([...moteurs.keys()].map(fermerPaquet));
}

export { CATALOGUE, VOIX_PAR_DEFAUT };
