/**
 * main.js — le chef d'orchestre de l'interface.
 *
 * Il ne contient aucune logique de lecture : le découpage vient de
 * prosody.js, l'enchaînement de player.js, le son de audio.js, les voix des
 * moteurs. Ici on ne fait que relier tout ça à des boutons, et afficher le
 * texte de façon qu'on sache toujours où en est la voix.
 */

import { segment } from '../prosody.js';
import { createPlayer } from '../player.js';
import { createAudioSink, audioSupported } from '../audio.js';
import { openEpub } from '../epub.js';
import {
  loadSettings, saveSettings, library, bookId, storageEstimate, requestPersistence,
} from '../store.js';
import { listVoices, loadVoice, installVoice, removeVoice, voiceStatus } from '../engines/index.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const etat = {
  reglages: loadSettings(),
  livre: null,          // { id, title, author, text }
  decoupage: null,      // retour de segment()
  cumul: [],            // durée estimée cumulée, pour l'affichage du temps
  player: null,
  sink: null,
  moteur: null,
  spans: [],
  veille: null,         // WakeLockSentinel
};

// ---------------------------------------------------------------------------
// Petits utilitaires d'affichage
// ---------------------------------------------------------------------------

function duree(secondes) {
  const s = Math.max(0, Math.round(secondes));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`;
}

/** « 1× », « 1,15× », « 0,7× » : sans zéro inutile, avec la virgule française. */
function formatVitesse(rate) {
  return `${String(Number(rate.toFixed(2))).replace('.', ',')}×`;
}

function poids(octets) {
  if (octets >= 1e9) return `${(octets / 1e9).toFixed(1)} Go`;
  if (octets >= 1e6) return `${Math.round(octets / 1e6)} Mo`;
  return `${Math.round(octets / 1e3)} ko`;
}

let messageTimer = null;
function dire(texte, ms = 3200) {
  const boite = $('#message');
  boite.textContent = texte;
  boite.hidden = false;
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => { boite.hidden = true; }, ms);
}

// ---------------------------------------------------------------------------
// Réglages
// ---------------------------------------------------------------------------

function appliquerReglages() {
  const r = etat.reglages;
  document.body.classList.toggle('clair', r.theme === 'clair');
  document.documentElement.style.setProperty('--taille-texte', `${r.fontSize}px`);

  $('#curseur-debit').value = r.rate;
  $('#curseur-pauses').value = r.pauseScale;
  $('#curseur-souffle').value = r.breathGain;
  $('#curseur-volume').value = r.volume;
  $('#curseur-taille').value = r.fontSize;

  $('#valeur-debit').textContent = `${r.rate.toFixed(2).replace('.', ',')}×`;

  // Le bouton du lecteur affiche la vitesse, et se teinte dès qu'elle
  // s'écarte de la normale : on doit pouvoir s'en apercevoir sans ouvrir
  // le menu, sinon on cherche longtemps pourquoi la voix court.
  const boutonVitesse = $('#bouton-vitesse');
  boutonVitesse.textContent = formatVitesse(r.rate);
  boutonVitesse.dataset.modifiee = Math.abs(r.rate - 1) < 0.001 ? 'non' : 'oui';
  $$('#vitesses .vitesse').forEach((b) => {
    const active = Math.abs(Number(b.dataset.vitesse) - r.rate) < 0.001;
    b.setAttribute('aria-pressed', String(active));
  });
  $('#valeur-pauses').textContent = `${r.pauseScale.toFixed(2).replace('.', ',')}×`;
  $('#valeur-souffle').textContent = `${r.breathGain.toFixed(2).replace('.', ',')}×`;
  $('#valeur-volume').textContent = `${Math.round(r.volume * 100)} %`;
  $('#valeur-taille').textContent = `${r.fontSize} px`;

  etat.sink?.setVolume(r.volume);
  saveSettings(r);
}

// ---------------------------------------------------------------------------
// Bibliothèque
// ---------------------------------------------------------------------------

async function afficherBibliotheque() {
  const livres = await library.list();
  const liste = $('#liste-livres');
  liste.innerHTML = '';
  $('#bibliotheque-vide').hidden = livres.length > 0;

  for (const livre of livres) {
    const li = document.createElement('li');
    li.className = 'livre';

    const corps = document.createElement('div');
    corps.className = 'livre-corps';

    const titre = document.createElement('button');
    titre.className = 'livre-titre';
    titre.textContent = livre.title;
    titre.addEventListener('click', () => ouvrirLivre(livre.id));

    const detail = document.createElement('div');
    detail.className = 'livre-detail';
    const parts = [];
    if (livre.author) parts.push(livre.author);
    parts.push(`${Math.round(livre.chars / 1000)} k signes`);
    if (livre.segments) parts.push(`${Math.round((livre.position / livre.segments) * 100)} % lu`);
    detail.textContent = parts.join(' · ');

    corps.append(titre, detail);

    if (livre.segments) {
      const jauge = document.createElement('div');
      jauge.className = 'livre-jauge';
      const remplie = document.createElement('span');
      remplie.style.width = `${Math.min(100, (livre.position / livre.segments) * 100)}%`;
      jauge.append(remplie);
      corps.append(jauge);
    }

    const supprimer = document.createElement('button');
    supprimer.className = 'bouton-icone';
    supprimer.setAttribute('aria-label', `Supprimer ${livre.title}`);
    supprimer.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    supprimer.addEventListener('click', async () => {
      await library.remove(livre.id);
      afficherBibliotheque();
    });

    li.append(corps, supprimer);
    liste.append(li);
  }
}

async function importerTexte(titre, texte, extra = {}) {
  const propre = texte.replace(/\r\n?/g, '\n').trim();
  if (!propre) { dire('Ce texte est vide.'); return null; }

  const id = bookId(titre, propre);
  const existant = await library.get(id);
  const livre = await library.put({
    id,
    title: titre || 'Sans titre',
    text: propre,
    ...extra,
    ...(existant ? { addedAt: existant.addedAt, position: existant.position } : {}),
    openedAt: Date.now(),
  });
  return livre;
}

// ---------------------------------------------------------------------------
// Affichage du texte : une phrase = un élément cliquable
// ---------------------------------------------------------------------------

function afficherTexte(decoupage) {
  const zone = $('#texte');
  zone.innerHTML = '';
  etat.spans = [];

  let paragraphe = document.createElement('p');

  decoupage.segments.forEach((seg, i) => {
    const span = document.createElement('span');
    span.className = 'phrase';
    span.dataset.index = String(i);
    span.textContent = seg.text;
    span.addEventListener('click', () => {
      etat.player.seek(i);
      if (etat.player.state !== 'playing') marquerCourante(i);
    });

    paragraphe.append(span);
    etat.spans[i] = span;

    if (seg.pauseKind === 'paragraph') {
      zone.append(paragraphe);
      paragraphe = document.createElement('p');
    } else if (seg.pauseKind === 'lineBreak') {
      paragraphe.append(document.createElement('br'));
    } else {
      paragraphe.append(document.createTextNode(' '));
    }
  });

  if (paragraphe.childNodes.length) zone.append(paragraphe);
}

let derniereCourante = -1;
function marquerCourante(index) {
  if (derniereCourante === index) return;
  if (derniereCourante >= 0) {
    const avant = etat.spans[derniereCourante];
    avant?.classList.remove('courante');
    avant?.classList.add('lue');
  }
  const span = etat.spans[index];
  if (span) {
    span.classList.add('courante');
    span.classList.remove('lue');
    span.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  derniereCourante = index;
  majProgression(index);
}

function majProgression(index) {
  const total = etat.decoupage?.stats.estDuration || 0;
  const lu = etat.cumul[index] || 0;
  $('#temps-lu').textContent = duree(lu);
  $('#temps-total').textContent = duree(total);
  const part = total ? Math.min(1, lu / total) : 0;
  $('#barre-progression .barre-remplie').style.width = `${part * 100}%`;
}

// ---------------------------------------------------------------------------
// Ouverture d'un livre et mise en place du lecteur
// ---------------------------------------------------------------------------

async function ouvrirLivre(id) {
  const livre = await library.get(id);
  if (!livre) { dire('Ce livre a disparu.'); return; }

  etat.livre = livre;
  etat.reglages.lastBook = id;
  saveSettings(etat.reglages);

  $('#titre-lecture').textContent = livre.title;
  $('#chapitre-lecture').textContent = livre.author || '';

  decouper();
  document.body.dataset.vue = 'lecture';

  await library.touch(id, { openedAt: Date.now(), segments: etat.decoupage.segments.length });

  const depart = Math.min(livre.position || 0, etat.decoupage.segments.length - 1);
  etat.player.seek(depart);
  marquerCourante(depart);
  majProgression(depart);
}

/** (Re)découpe le texte courant et recharge le lecteur, réglages compris. */
function decouper() {
  const { pauseScale } = etat.reglages;
  etat.decoupage = segment(etat.livre.text, { pauseScale });

  let somme = 0;
  etat.cumul = etat.decoupage.segments.map((s) => {
    const avant = somme;
    somme += s.estDuration + s.pauseAfter / 1000;
    return avant;
  });

  afficherTexte(etat.decoupage);
  derniereCourante = -1;
  etat.player.load(etat.decoupage);
  majProgression(0);
}

// ---------------------------------------------------------------------------
// Voix
// ---------------------------------------------------------------------------

async function remplirChoixVoix() {
  const voix = await listVoices();
  const select = $('#choix-voix');
  select.innerHTML = '';

  const installees = voix.filter((v) => v.installed);
  const liste = installees.length ? installees : voix;

  for (const v of liste) {
    const option = document.createElement('option');
    option.value = v.id;
    option.textContent = `${v.label} · ${v.gender === 'homme' ? 'homme' : 'femme'}`
      + (v.installed ? '' : ` · à télécharger (${poids(v.bytes)})`);
    select.append(option);
  }

  if (etat.reglages.voice && liste.some((v) => v.id === etat.reglages.voice)) {
    select.value = etat.reglages.voice;
  } else if (liste.length) {
    etat.reglages.voice = liste[0].id;
    select.value = liste[0].id;
  }

  $('#etat-voix').textContent = installees.length
    ? `${installees.length} voix disponible${installees.length > 1 ? 's' : ''} hors connexion.`
    : 'Aucune voix installée : ouvrez « Gérer les voix » pour en télécharger une.';
}

async function afficherPanneauVoix() {
  const voix = await listVoices();
  const liste = $('#liste-voix');
  liste.innerHTML = '';

  for (const v of voix) {
    const li = document.createElement('li');
    li.className = 'voix';
    li.dataset.id = v.id;

    const corps = document.createElement('div');
    corps.className = 'voix-corps';
    corps.innerHTML = `
      <div class="voix-nom">${v.label}</div>
      <div class="voix-detail">${v.gender} · ${v.quality} · ${poids(v.bytes)}${v.note ? ` · ${v.note}` : ''}</div>
      <div class="voix-jauge"><span></span></div>`;

    const action = document.createElement('button');
    action.className = v.installed ? 'bouton-icone' : 'bouton-secondaire';
    if (v.installed) {
      action.setAttribute('aria-label', `Supprimer ${v.label}`);
      action.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      action.addEventListener('click', async () => {
        // Deux voix d'un même paquet sont un seul fichier : on ne peut pas
        // en retirer une sans l'autre, et l'annoncer après coup serait
        // désagréable.
        if (v.compagnes.length
          && !confirm(`${v.label} et ${v.compagnes.join(', ')} sont le même téléchargement. Les supprimer toutes ?`)) return;

        await removeVoice(v.id);
        dire(v.compagnes.length
          ? `${[v.label, ...v.compagnes].join(' et ')} supprimées.`
          : `${v.label} supprimée.`);
        afficherPanneauVoix();
        remplirChoixVoix();
      });
    } else {
      action.textContent = 'Installer';
      action.addEventListener('click', async () => {
        action.disabled = true;
        li.classList.add('telecharge');
        const jauge = li.querySelector('.voix-jauge span');
        try {
          await installVoice(v.id, ({ recu, total }) => {
            jauge.style.width = total ? `${(recu / total) * 100}%` : '100%';
          });
          dire(v.compagnes.length
            ? `${[v.label, ...v.compagnes].join(' et ')} sont prêtes, hors connexion.`
            : `${v.label} est prête, hors connexion.`);
          afficherPanneauVoix();
          remplirChoixVoix();
        } catch (err) {
          dire(`Échec du téléchargement : ${err.message}`, 5000);
          action.disabled = false;
          li.classList.remove('telecharge');
        }
      });
    }

    li.append(corps, action);
    liste.append(li);
  }

  const place = await storageEstimate();
  if (place) {
    $('#place-disque').textContent =
      `Espace utilisé : ${poids(place.usage)} sur ${poids(place.quota)} disponibles.`;
  }
}

/** Charge la voix choisie, en affichant l'attente s'il faut la télécharger. */
async function preparerVoix() {
  const id = etat.reglages.voice;
  if (!id) { dire('Choisissez une voix dans les réglages.'); return false; }

  const statut = await voiceStatus(id);
  if (!statut.installed) {
    dire(`Téléchargement de la voix (${poids(statut.bytes)})…`, 60000);
    try {
      await installVoice(id, ({ recu, total }) => {
        if (total) dire(`Téléchargement de la voix : ${Math.round((recu / total) * 100)} %`, 60000);
      });
    } catch (err) {
      dire(`Voix indisponible : ${err.message}`, 6000);
      return false;
    }
  }

  try {
    etat.moteur = await loadVoice(id);
    dire('');
    $('#message').hidden = true;
    return true;
  } catch (err) {
    dire(`Le moteur de voix refuse de démarrer : ${err.message}`, 6000);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

async function basculerLecture() {
  if (!etat.livre) return;

  if (etat.player.state === 'playing') {
    etat.player.pause();
    return;
  }

  if (!etat.moteur) {
    $('#bouton-lecture').disabled = true;
    const prete = await preparerVoix();
    $('#bouton-lecture').disabled = false;
    if (!prete) return;
    construirePlayer();
  }

  await etat.sink.resume();
  etat.player.play();
  garderEcranActif();
}

/** Le lecteur dépend du moteur (fréquence d'échantillonnage) : on le rebâtit. */
function construirePlayer() {
  const index = etat.player ? Math.max(0, etat.player.current) : 0;
  const r = etat.reglages;

  etat.sink = etat.sink || createAudioSink({ sampleRate: etat.moteur.sampleRate, volume: r.volume });
  etat.player = createPlayer({
    engine: etat.moteur,
    sink: etat.sink,
    options: { voice: r.voice, rate: r.rate, breathGain: r.breathGain },
  });

  brancherPlayer();
  if (etat.decoupage) {
    etat.player.load(etat.decoupage);
    etat.player.seek(index);
  }
}

function brancherPlayer() {
  etat.player.on('segment', ({ index }) => {
    marquerCourante(index);
    if (etat.livre) library.touch(etat.livre.id, { position: index });
  });

  etat.player.on('state', (state) => {
    document.body.classList.toggle('joue', state === 'playing');
    $('#bouton-lecture').setAttribute('aria-label', state === 'playing' ? 'Pause' : 'Lire');
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = state === 'playing' ? 'playing' : 'paused';
    }
    if (state !== 'playing') relacherEcran();
  });

  etat.player.on('end', () => {
    dire('Fin du texte.');
    relacherEcran();
  });

  etat.player.on('error', ({ index, error }) => {
    console.warn('phrase', index, error);
  });
}

// ---------------------------------------------------------------------------
// Écran et commandes du système
// ---------------------------------------------------------------------------

async function garderEcranActif() {
  if (!('wakeLock' in navigator) || etat.veille) return;
  try {
    etat.veille = await navigator.wakeLock.request('screen');
    etat.veille.addEventListener('release', () => { etat.veille = null; });
  } catch { /* refusé : ce n'est pas bloquant */ }
}

function relacherEcran() {
  etat.veille?.release().catch(() => {});
  etat.veille = null;
}

function brancherCommandesSysteme() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => basculerLecture());
  ms.setActionHandler('pause', () => etat.player?.pause());
  ms.setActionHandler('previoustrack', () => etat.player?.previous());
  ms.setActionHandler('nexttrack', () => etat.player?.next());
}

function majMetadonnees() {
  if (!('mediaSession' in navigator) || !etat.livre) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: etat.livre.title,
    artist: etat.livre.author || 'Voxlire',
    album: 'Voxlire',
    artwork: [{ src: './assets/icone-512.png', sizes: '512x512', type: 'image/png' }],
  });
}

// ---------------------------------------------------------------------------
// Import de fichiers
// ---------------------------------------------------------------------------

async function ouvrirFichier(fichier) {
  const nom = fichier.name.replace(/\.[^.]+$/, '');
  try {
    if (/\.epub$/i.test(fichier.name)) {
      dire('Ouverture du livre…', 20000);
      const livre = await openEpub(await fichier.arrayBuffer());
      const texte = await livre.readAll((fait, total) => {
        dire(`Lecture du livre : chapitre ${fait} sur ${total}`, 20000);
      });
      const enregistre = await importerTexte(livre.title || nom, texte, { author: livre.author });
      $('#message').hidden = true;
      if (enregistre) ouvrirLivre(enregistre.id);
      return;
    }

    const texte = await fichier.text();
    const enregistre = await importerTexte(nom, texte);
    if (enregistre) ouvrirLivre(enregistre.id);
  } catch (err) {
    dire(`Impossible d'ouvrir ce fichier : ${err.message}`, 6000);
  }
}

// ---------------------------------------------------------------------------
// Branchements
// ---------------------------------------------------------------------------

function ouvrirPanneau(id) {
  $$('.panneau').forEach((p) => { p.hidden = p.id !== id; });
  $('#voile').hidden = false;
}

function fermerPanneaux() {
  $$('.panneau').forEach((p) => { p.hidden = true; });
  $('#voile').hidden = true;
}

function brancherInterface() {
  document.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;

    if (action === 'ouvrir-reglages') { remplirChoixVoix(); ouvrirPanneau('panneau-reglages'); }
    if (action === 'gerer-voix') { afficherPanneauVoix(); ouvrirPanneau('panneau-voix'); }
    if (action === 'vitesse') ouvrirPanneau('panneau-vitesse');
    if (action === 'fermer-panneau') fermerPanneaux();
    if (action === 'retour') { etat.player?.pause(); document.body.dataset.vue = 'bibliotheque'; afficherBibliotheque(); }
    if (action === 'lecture') basculerLecture();
    if (action === 'precedent') etat.player?.previous();
    if (action === 'suivant') etat.player?.next();
    if (action === 'coller') $('#boite-collage').showModal();
    if (action === 'ouvrir-fichier') $('#champ-fichier').click();
  });

  $('#voile').addEventListener('click', fermerPanneaux);

  $('#vitesses').addEventListener('click', (e) => {
    const choix = e.target.closest('[data-vitesse]');
    if (!choix) return;
    etat.reglages.rate = Number(choix.dataset.vitesse);
    appliquerReglages();
    // Le lecteur relance la phrase en cours : on entend la nouvelle vitesse
    // tout de suite, sans attendre la fin du paragraphe.
    etat.player?.setRate(etat.reglages.rate);
  });

  $('#champ-fichier').addEventListener('change', (e) => {
    const fichier = e.target.files?.[0];
    e.target.value = '';
    if (fichier) ouvrirFichier(fichier);
  });

  $('#boite-collage').addEventListener('close', async (e) => {
    const boite = e.target;
    if (boite.returnValue !== 'lire') return;
    const texte = $('#champ-texte').value;
    const titre = $('#champ-titre').value.trim()
      || texte.trim().split('\n')[0].slice(0, 60)
      || 'Texte collé';
    const livre = await importerTexte(titre, texte);
    $('#champ-texte').value = '';
    $('#champ-titre').value = '';
    if (livre) ouvrirLivre(livre.id);
  });

  // Barre de progression : on saute à l'endroit touché.
  $('#barre-progression').addEventListener('click', (e) => {
    if (!etat.decoupage) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const part = (e.clientX - rect.left) / rect.width;
    const cible = etat.decoupage.stats.estDuration * part;
    let index = etat.cumul.findIndex((t) => t > cible);
    if (index < 0) index = etat.decoupage.segments.length - 1;
    etat.player.seek(Math.max(0, index - 1));
    marquerCourante(Math.max(0, index - 1));
  });

  const surCurseur = (selecteur, cle, apres) => {
    $(selecteur).addEventListener('input', (e) => {
      etat.reglages[cle] = Number(e.target.value);
      appliquerReglages();
      apres?.(etat.reglages[cle]);
    });
  };

  surCurseur('#curseur-debit', 'rate', (v) => etat.player?.setRate(v));
  surCurseur('#curseur-volume', 'volume');
  surCurseur('#curseur-taille', 'fontSize');
  surCurseur('#curseur-souffle', 'breathGain', (v) => etat.player?.setBreathGain(v));
  surCurseur('#curseur-pauses', 'pauseScale', () => {
    // Les silences sont calculés au découpage — virgules comprises, depuis
    // qu'elles ont leur propre segment : il faut donc le refaire.
    if (etat.livre) {
      const index = Math.max(0, etat.player.current);
      decouper();
      etat.player.seek(index);
      marquerCourante(index);
    }
  });

  $('#choix-voix').addEventListener('change', async (e) => {
    etat.reglages.voice = e.target.value;
    saveSettings(etat.reglages);
    etat.moteur = null;
    if (etat.player?.state === 'playing') {
      etat.player.pause();
      await basculerLecture();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    if (e.code === 'Space') { e.preventDefault(); basculerLecture(); }
    if (e.code === 'ArrowRight') etat.player?.next();
    if (e.code === 'ArrowLeft') etat.player?.previous();
    if (e.code === 'Escape') fermerPanneaux();
  });
}

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------

async function demarrer() {
  if (!audioSupported()) {
    dire("Ce navigateur ne sait pas produire de son programmé.", 10000);
  }

  appliquerReglages();
  brancherInterface();
  brancherCommandesSysteme();

  // Un lecteur provisoire, sans moteur : il permet de naviguer dans le texte
  // avant même d'avoir téléchargé une voix.
  etat.sink = audioSupported()
    ? createAudioSink({ volume: etat.reglages.volume })
    : null;
  etat.moteur = null;
  etat.player = createPlayer({
    engine: { sampleRate: 22050, synthesize: async () => new Float32Array(0) },
    sink: etat.sink || {
      sampleRate: 22050, now: () => 0, play: () => null,
      stopAll: () => {}, resume: () => {}, suspend: () => {},
    },
    options: { voice: etat.reglages.voice, rate: etat.reglages.rate },
  });
  brancherPlayer();

  await afficherBibliotheque();
  await remplirChoixVoix();

  if (etat.reglages.lastBook) {
    const livre = await library.get(etat.reglages.lastBook);
    if (livre) { await ouvrirLivre(livre.id); majMetadonnees(); }
  }

  requestPersistence();

  surveillerLesMisesAJour();
}

/**
 * Applique les mises à jour de l'application.
 *
 * Le service worker garde une copie de tout pour fonctionner hors connexion.
 * L'effet de bord est qu'une version corrigée ne s'affiche pas : la page
 * continue de tourner sur les fichiers déjà en cache, et il faut recharger
 * deux fois pour en sortir — ce que personne ne devine.
 *
 * On recharge donc nous-mêmes dès qu'un nouveau service worker prend la main.
 * Deux précautions : ne rien faire au tout premier passage, où il n'y avait
 * pas encore de version précédente, et ne jamais recharger pendant une
 * lecture — couper quelqu'un au milieu d'un chapitre pour lui appliquer une
 * correction de CSS serait un remède pire que le mal.
 */
function surveillerLesMisesAJour() {
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.register('./sw.js').catch(() => {});

  const premiereVisite = !navigator.serviceWorker.controller;
  let dejaTraite = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (premiereVisite || dejaTraite) return;
    dejaTraite = true;

    if (etat.player?.state === 'playing') {
      dire('Nouvelle version prête. Elle s’appliquera au prochain lancement.', 6000);
      return;
    }
    location.reload();
  });
}

demarrer();
