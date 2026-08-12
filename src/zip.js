/**
 * zip.js — lecteur d'archives ZIP, sans dépendance.
 *
 * Un EPUB est un ZIP. Plutôt que d'embarquer une bibliothèque de 100 ko
 * pour l'ouvrir, on lit nous-mêmes le catalogue de l'archive et on confie
 * la décompression à `DecompressionStream`, présent nativement dans les
 * navigateurs modernes comme dans Node.
 *
 * On ne gère que ce qu'un EPUB contient réellement : entrées « stockées »
 * (méthode 0) et « dégonflées » (méthode 8). Tout le reste est signalé
 * clairement plutôt que silencieusement mal lu.
 */

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** Fin du catalogue : signature à chercher à rebours, le commentaire final
 *  pouvant faire jusqu'à 64 ko. */
function findEndOfCentralDirectory(view) {
  const maxComment = 0xffff;
  const start = Math.max(0, view.byteLength - maxComment - 22);
  for (let i = view.byteLength - 22; i >= start; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) return i;
  }
  return -1;
}

function decodeName(bytes, utf8Flag) {
  // Le drapeau bit 11 annonce de l'UTF-8. Sinon la spec dit CP437, mais en
  // pratique les noms d'un EPUB sont en ASCII : l'UTF-8 fait aussi bien.
  return new TextDecoder(utf8Flag ? 'utf-8' : 'utf-8').decode(bytes);
}

/**
 * Ouvre une archive et renvoie son catalogue. Rien n'est décompressé à ce
 * stade : sur un livre illustré de 40 Mo, on ne paie que ce qu'on lit.
 *
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {{names: string[], has(name:string):boolean,
 *            read(name:string):Promise<Uint8Array>,
 *            readText(name:string):Promise<string>}}
 */
export function openZip(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) throw new Error('Archive illisible : fin de catalogue introuvable.');

  let entryCount = view.getUint16(eocd + 10, true);
  let centralOffset = view.getUint32(eocd + 16, true);

  // ZIP64 : les champs de 32 bits sont saturés et la vraie valeur est ailleurs.
  if (centralOffset === 0xffffffff || entryCount === 0xffff) {
    const locator = eocd - 20;
    if (locator < 0 || view.getUint32(locator, true) !== SIG_EOCD64_LOCATOR) {
      throw new Error('Archive ZIP64 malformée.');
    }
    const eocd64 = Number(view.getBigUint64(locator + 8, true));
    entryCount = Number(view.getBigUint64(eocd64 + 32, true));
    centralOffset = Number(view.getBigUint64(eocd64 + 48, true));
  }

  const entries = new Map();
  let p = centralOffset;
  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(p, true) !== SIG_CENTRAL) {
      throw new Error(`Catalogue corrompu à l'entrée ${i}.`);
    }
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const uncompressedSize = view.getUint32(p + 24, true);
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = decodeName(bytes.subarray(p + 46, p + 46 + nameLength), flags & 0x800);

    entries.set(name, { name, method, compressedSize, uncompressedSize, localOffset });
    p += 46 + nameLength + extraLength + commentLength;
  }

  async function inflate(raw) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('Ce navigateur ne sait pas décompresser (DecompressionStream manquant).');
    }
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
  }

  return {
    get names() { return [...entries.keys()]; },

    has(name) { return entries.has(name); },

    /** Contenu brut d'un fichier de l'archive. */
    async read(name) {
      const entry = entries.get(name);
      if (!entry) throw new Error(`Fichier absent de l'archive : ${name}`);

      // L'en-tête local redonne les longueurs de nom et d'extra, qui peuvent
      // différer de celles du catalogue : c'est lui qui fait foi ici.
      const head = entry.localOffset;
      if (view.getUint32(head, true) !== SIG_LOCAL) {
        throw new Error(`En-tête local invalide pour ${name}.`);
      }
      const nameLength = view.getUint16(head + 26, true);
      const extraLength = view.getUint16(head + 28, true);
      const start = head + 30 + nameLength + extraLength;
      const raw = bytes.subarray(start, start + entry.compressedSize);

      if (entry.method === METHOD_STORE) return raw;
      if (entry.method === METHOD_DEFLATE) return inflate(raw);
      throw new Error(`Compression non gérée (méthode ${entry.method}) pour ${name}.`);
    },

    async readText(name) {
      return new TextDecoder('utf-8').decode(await this.read(name));
    },
  };
}
