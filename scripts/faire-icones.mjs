/**
 * faire-icones.mjs — fabrique les icônes de l'application.
 *
 * Chrome exige des PNG de 192 et 512 pixels pour proposer l'installation.
 * Plutôt que d'ajouter une dépendance graphique pour trois formes
 * géométriques, on peint les pixels à la main et on encode le PNG avec le
 * zlib de Node : une centaine de lignes, zéro paquet installé.
 *
 * Usage : node scripts/faire-icones.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(RACINE, 'assets');

const FOND = [0x12, 0x10, 0x0e];
const OR = [0xd9, 0xa4, 0x41];

// --- Encodage PNG ----------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** @param {Uint8Array} rgba pixels RGBA, largeur × hauteur × 4 */
function encodePng(rgba, size) {
  const brut = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    brut[y * (size * 4 + 1)] = 0; // filtre « aucun »
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(brut, y * (size * 4 + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // 8 bits par canal
  ihdr[9] = 6;   // RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(brut, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Dessin ----------------------------------------------------------------

/**
 * L'icône : un fond sombre, et trois barres verticales d'un son qui monte —
 * la forme d'onde d'une voix, lisible même à 48 pixels dans une barre de
 * tâches. Le lissage se fait par sur-échantillonnage : on peint quatre fois
 * plus grand, puis on moyenne.
 */
function dessiner(size, { masquable = false } = {}) {
  const SS = 4;
  const N = size * SS;
  const grand = new Uint8Array(N * N * 4);

  // Une icône masquable doit tenir dans le cercle sûr (80 % du côté).
  const marge = masquable ? 0.26 : 0.17;
  const rayonFond = masquable ? N / 2 : N * 0.23;

  const poser = (x, y, [r, g, b], a = 255) => {
    const i = (y * N + x) * 4;
    const alpha = a / 255;
    grand[i] = grand[i] * (1 - alpha) + r * alpha;
    grand[i + 1] = grand[i + 1] * (1 - alpha) + g * alpha;
    grand[i + 2] = grand[i + 2] * (1 - alpha) + b * alpha;
    grand[i + 3] = Math.max(grand[i + 3], a);
  };

  // Fond : carré aux coins arrondis (ou plein carré si masquable).
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (masquable) { poser(x, y, FOND); continue; }
      const dx = Math.max(rayonFond - x, x - (N - 1 - rayonFond), 0);
      const dy = Math.max(rayonFond - y, y - (N - 1 - rayonFond), 0);
      if (dx * dx + dy * dy <= rayonFond * rayonFond) poser(x, y, FOND);
    }
  }

  // Cinq barres : une voix qui module, plus haute au centre.
  const hauteurs = [0.34, 0.62, 1.0, 0.72, 0.42];
  const zone = N * (1 - 2 * marge);
  const largeurBarre = zone / 9;
  const rayonBarre = largeurBarre / 2;
  const centre = N / 2;

  hauteurs.forEach((h, i) => {
    const cx = N * marge + largeurBarre / 2 + i * largeurBarre * 1.8;
    const demiHauteur = (zone / 2) * h;
    const haut = centre - demiHauteur + rayonBarre;
    const bas = centre + demiHauteur - rayonBarre;

    for (let y = Math.floor(haut - rayonBarre); y <= Math.ceil(bas + rayonBarre); y++) {
      for (let x = Math.floor(cx - rayonBarre); x <= Math.ceil(cx + rayonBarre); x++) {
        if (x < 0 || y < 0 || x >= N || y >= N) continue;
        const py = y < haut ? haut : y > bas ? bas : y;
        const d = Math.hypot(x - cx, y - py);
        if (d <= rayonBarre) poser(x, y, OR);
      }
    }
  });

  // Réduction : moyenne des SS × SS pixels d'origine.
  const petit = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * N + (x * SS + sx)) * 4;
          r += grand[i]; g += grand[i + 1]; b += grand[i + 2]; a += grand[i + 3];
        }
      }
      const n = SS * SS;
      const j = (y * size + x) * 4;
      petit[j] = r / n; petit[j + 1] = g / n; petit[j + 2] = b / n; petit[j + 3] = a / n;
    }
  }
  return petit;
}

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="118" fill="#12100e"/>
  <g fill="#d9a441">
    <rect x="87"  y="197" width="38" height="118" rx="19"/>
    <rect x="155" y="150" width="38" height="212" rx="19"/>
    <rect x="223" y="87"  width="38" height="338" rx="19"/>
    <rect x="291" y="138" width="38" height="236" rx="19"/>
    <rect x="359" y="184" width="38" height="144" rx="19"/>
  </g>
</svg>
`;

mkdirSync(ASSETS, { recursive: true });
writeFileSync(join(ASSETS, 'icone.svg'), SVG);
for (const taille of [192, 512]) {
  writeFileSync(join(ASSETS, `icone-${taille}.png`), encodePng(dessiner(taille), taille));
}
writeFileSync(
  join(ASSETS, 'icone-512-masquable.png'),
  encodePng(dessiner(512, { masquable: true }), 512),
);

console.log('Icônes écrites dans assets/ : icone.svg, icone-192.png, icone-512.png, icone-512-masquable.png');
