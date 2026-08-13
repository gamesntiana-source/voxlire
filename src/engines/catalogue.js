/**
 * catalogue.js — les voix françaises disponibles.
 *
 * Toutes les données de ce fichier ont été vérifiées le 13 août 2026 contre
 * le dépôt `rhasspy/piper-voices` : URLs testées (HTTP 200), tailles issues
 * de `voices.json` (`size_bytes`) et confirmées par l'en-tête content-length,
 * empreintes MD5 du même index. Le CDN de HuggingFace répond
 * `access-control-allow-origin: *`, donc le téléchargement depuis une page
 * web fonctionne sans passe-plat.
 *
 * Deux points méritent d'être connus avant de toucher à ce fichier :
 *
 *  - « low » ne veut pas dire « léger ». gilles-low pèse 60 Mio comme un
 *    medium ; seul siwis-low est réellement petit. On se fie aux octets,
 *    jamais au libellé.
 *  - upmc contient DEUX voix, une femme et un homme, dans un seul fichier.
 *    D'où la notion de « paquet » : plusieurs voix peuvent partager un même
 *    téléchargement, qui n'est fait qu'une fois.
 *
 * Le genre de chaque voix a été établi en croisant la documentation des
 * corpus et une mesure de fréquence fondamentale sur les échantillons
 * officiels. Pour `tom`, non documenté, seule la mesure tranche (138 Hz).
 */

const HF = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR';

/** Fabrique la paire de fichiers d'un modèle Piper. */
function fichiers(chemin, nom, octetsModele, octetsConfig) {
  return [
    {
      role: 'model',
      url: `${HF}/${chemin}/${nom}.onnx`,
      bytes: octetsModele,
      type: 'application/octet-stream',
    },
    {
      role: 'config',
      url: `${HF}/${chemin}/${nom}.onnx.json`,
      bytes: octetsConfig,
      type: 'application/json',
    },
  ];
}

export const CATALOGUE = [
  {
    id: 'siwis',
    pack: 'fr_FR-siwis-medium',
    engine: 'piper',
    label: 'Siwis',
    gender: 'femme',
    quality: 'studio · 22 kHz',
    speaker: null,
    sampleRate: 22050,
    note: 'la plus régulière sur les longs textes',
    licence: 'CC-BY 4.0',
    files: fichiers('siwis/medium', 'fr_FR-siwis-medium', 63201294, 4875),
    defaut: true,
  },
  {
    id: 'jessica',
    pack: 'fr_FR-upmc-medium',
    engine: 'piper',
    label: 'Jessica',
    gender: 'femme',
    quality: 'studio · 22 kHz',
    speaker: 0,
    sampleRate: 22050,
    note: 'téléchargée avec Pierre',
    licence: 'CC-BY-SA 4.0',
    files: fichiers('upmc/medium', 'fr_FR-upmc-medium', 76733615, 4996),
  },
  {
    id: 'pierre',
    pack: 'fr_FR-upmc-medium',
    engine: 'piper',
    label: 'Pierre',
    gender: 'homme',
    quality: 'studio · 22 kHz',
    speaker: 1,
    sampleRate: 22050,
    note: 'téléchargé avec Jessica',
    licence: 'CC-BY-SA 4.0',
    files: fichiers('upmc/medium', 'fr_FR-upmc-medium', 76733615, 4996),
  },
  {
    id: 'gilles',
    pack: 'fr_FR-gilles-low',
    engine: 'piper',
    label: 'Gilles',
    gender: 'homme',
    quality: '16 kHz',
    speaker: null,
    sampleRate: 16000,
    note: 'la voix la plus grave',
    licence: 'CC0',
    files: fichiers('gilles/low', 'fr_FR-gilles-low', 63104526, 4158),
  },
  {
    id: 'tom',
    pack: 'fr_FR-tom-medium',
    engine: 'piper',
    label: 'Tom',
    gender: 'homme',
    quality: 'haute définition · 44 kHz',
    speaker: null,
    sampleRate: 44100,
    note: 'la mieux définie, licence AGPL',
    licence: 'AGPL-3.0',
    files: fichiers('tom/medium', 'fr_FR-tom-medium', 63511038, 4959),
  },
  {
    id: 'siwis-legere',
    pack: 'fr_FR-siwis-low',
    engine: 'piper',
    label: 'Siwis (légère)',
    gender: 'femme',
    quality: '16 kHz',
    speaker: null,
    sampleRate: 16000,
    note: 'deux fois moins lourde, pour les petits forfaits',
    licence: 'CC-BY 4.0',
    files: fichiers('siwis/low', 'fr_FR-siwis-low', 28130791, 4157),
  },
];

/** Voix proposée par défaut au premier lancement. */
export const VOIX_PAR_DEFAUT = CATALOGUE.find((v) => v.defaut).id;
