/**
 * epub.js — ouverture d'un livre numérique, sans dépendance.
 *
 * Un EPUB, c'est une archive ZIP contenant : un pointeur vers un fichier OPF,
 * un OPF qui déclare les fichiers du livre et l'ordre de lecture, et des
 * chapitres en XHTML.
 *
 * On analyse ces XML avec un scanner de balises maison plutôt qu'avec
 * DOMParser, pour deux raisons : le même code tourne dans le navigateur et
 * sous Node (donc il est testable), et un EPUB mal formé — il y en a
 * beaucoup — ne fait pas tout échouer d'un coup.
 */

import { openZip } from './zip.js';

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', laquo: '«', raquo: '»', hellip: '…',
  mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', eacute: 'é', egrave: 'è', ecirc: 'ê',
  agrave: 'à', ccedil: 'ç', ugrave: 'ù', ocirc: 'ô', icirc: 'î',
  euml: 'ë', iuml: 'ï', uuml: 'ü', deg: '°', laquo_: '«',
};

/** Remplace les entités XML/HTML par les caractères correspondants. */
export function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    const named = ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

/** Attributs d'une balise ouvrante, en minuscules. */
function parseAttributes(raw) {
  const attrs = {};
  const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(raw))) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
  }
  return attrs;
}

/**
 * Trouve toutes les occurrences d'une balise, avec ses attributs et son
 * contenu. Ignore les espaces de noms (`opf:item` répond à `item`).
 *
 * @returns {{attrs: Record<string,string>, inner: string}[]}
 */
export function findTags(xml, tag) {
  const out = [];
  const open = new RegExp(`<(?:[\\w.-]+:)?${tag}(\\s[^>]*?|)(/?)>`, 'gi');
  let m;
  while ((m = open.exec(xml))) {
    const attrs = parseAttributes(m[1]);
    if (m[2] === '/') { out.push({ attrs, inner: '' }); continue; }

    // Cherche la fermeture correspondante en tenant compte des imbrications.
    const nested = new RegExp(`<(/?)(?:[\\w.-]+:)?${tag}(?:\\s[^>]*?|)(/?)>`, 'gi');
    nested.lastIndex = open.lastIndex;
    let depth = 1;
    let end = -1;
    let n;
    while ((n = nested.exec(xml))) {
      if (n[2] === '/') continue;          // balise auto-fermante
      if (n[1] === '/') { depth--; if (depth === 0) { end = n.index; break; } }
      else depth++;
    }
    if (end < 0) { out.push({ attrs, inner: xml.slice(open.lastIndex) }); break; }
    out.push({ attrs, inner: xml.slice(open.lastIndex, end) });
    open.lastIndex = nested.lastIndex;
  }
  return out;
}

/** Contenu textuel de la première occurrence d'une balise. */
function firstText(xml, tag) {
  const found = findTags(xml, tag);
  if (!found.length) return '';
  return decodeEntities(found[0].inner.replace(/<[^>]*>/g, '')).trim();
}

const BLOCK_TAGS = 'p|div|section|article|blockquote|h[1-6]|li|tr|td|th|dd|dt|pre|figcaption|aside|header|footer|main|nav';

/**
 * Transforme du XHTML de chapitre en texte prêt à être lu.
 *
 * Les frontières de blocs deviennent des lignes vides : c'est ce que
 * prosody.js lit comme des changements de paragraphe, donc comme les
 * silences les plus longs. Perdre cette information donnerait un livre
 * lu d'une seule traite.
 */
export function htmlToText(html) {
  let text = html;

  text = text.replace(/<\?[\s\S]*?\?>/g, '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<!DOCTYPE[^>]*>/gi, '');
  text = text.replace(/<head\b[\s\S]*?<\/head>/gi, '');
  text = text.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');

  // Les titres méritent leur propre respiration : une ligne vide de chaque côté.
  text = text.replace(/<\/h[1-6]\s*>/gi, '\n\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(new RegExp(`</(?:${BLOCK_TAGS})\\s*>`, 'gi'), '\n\n');
  text = text.replace(new RegExp(`<(?:${BLOCK_TAGS})(?:\\s[^>]*)?>`, 'gi'), '\n');

  text = text.replace(/<[^>]*>/g, '');
  text = decodeEntities(text);

  // Remise au propre : espaces en fin de ligne, lignes vides en série.
  text = text.replace(/\r\n?/g, '\n');
  text = text.replace(/[ \t ]+/g, ' ');
  text = text.replace(/ *\n */g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

/** Résout un chemin relatif à l'intérieur de l'archive (pas d'URL, pas de base). */
function resolvePath(base, href) {
  const target = href.split('#')[0];
  if (!target) return '';
  if (target.startsWith('/')) return target.slice(1);
  const parts = base ? base.split('/') : [];
  for (const piece of target.split('/')) {
    if (piece === '.' || piece === '') continue;
    if (piece === '..') parts.pop();
    else parts.push(piece);
  }
  return parts.join('/');
}

/** Répertoire contenant un fichier de l'archive. */
function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/**
 * Ouvre un EPUB.
 *
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {Promise<{title:string, author:string, language:string,
 *   chapters:{index:number,title:string,href:string}[],
 *   readChapter(index:number):Promise<string>,
 *   readAll(onProgress?:(done:number,total:number)=>void):Promise<string>}>}
 */
export async function openEpub(data) {
  const zip = openZip(data);

  // 1. Le conteneur désigne le fichier OPF, où qu'il se trouve.
  if (!zip.has('META-INF/container.xml')) {
    throw new Error("Ce fichier n'est pas un EPUB : META-INF/container.xml manquant.");
  }
  const container = await zip.readText('META-INF/container.xml');
  const rootfile = findTags(container, 'rootfile')[0];
  const opfPath = rootfile?.attrs['full-path'];
  if (!opfPath || !zip.has(opfPath)) {
    throw new Error('EPUB illisible : le fichier OPF est introuvable.');
  }

  // 2. L'OPF déclare les métadonnées, les fichiers et l'ordre de lecture.
  const opf = await zip.readText(opfPath);
  const base = dirOf(opfPath);

  const metadata = findTags(opf, 'metadata')[0]?.inner || opf;
  const title = firstText(metadata, 'title') || 'Sans titre';
  const author = firstText(metadata, 'creator') || '';
  const language = firstText(metadata, 'language') || 'fr';

  const manifestInner = findTags(opf, 'manifest')[0]?.inner || '';
  const manifest = new Map();
  for (const item of findTags(manifestInner, 'item')) {
    const { id, href, 'media-type': type, properties } = item.attrs;
    if (id && href) manifest.set(id, { href: resolvePath(base, href), type, properties });
  }

  const spineTag = findTags(opf, 'spine')[0];
  const spineInner = spineTag?.inner || '';
  const order = findTags(spineInner, 'itemref')
    .filter((r) => r.attrs.linear !== 'no')
    .map((r) => manifest.get(r.attrs.idref))
    .filter((item) => item && zip.has(item.href));

  // 3. Les titres de chapitres viennent de la table des matières, quand
  //    elle existe : EPUB 3 (nav.xhtml) ou EPUB 2 (toc.ncx).
  const titles = new Map();

  const navItem = [...manifest.values()].find((i) => (i.properties || '').includes('nav'));
  if (navItem && zip.has(navItem.href)) {
    const nav = await zip.readText(navItem.href);
    for (const a of findTags(nav, 'a')) {
      const href = a.attrs.href && resolvePath(dirOf(navItem.href), a.attrs.href);
      const label = decodeEntities(a.inner.replace(/<[^>]*>/g, '')).trim();
      if (href && label && !titles.has(href)) titles.set(href, label);
    }
  }

  const ncxId = spineTag?.attrs.toc;
  const ncxItem = (ncxId && manifest.get(ncxId)) ||
    [...manifest.values()].find((i) => i.type === 'application/x-dtbncx+xml');
  if (ncxItem && zip.has(ncxItem.href)) {
    const ncx = await zip.readText(ncxItem.href);
    for (const point of findTags(ncx, 'navPoint')) {
      const label = firstText(point.inner, 'text');
      const src = findTags(point.inner, 'content')[0]?.attrs.src;
      const href = src && resolvePath(dirOf(ncxItem.href), src);
      if (href && label && !titles.has(href)) titles.set(href, label);
    }
  }

  const chapters = order.map((item, index) => ({
    index,
    href: item.href,
    title: titles.get(item.href) || '',
  }));

  async function readChapter(index) {
    const chapter = chapters[index];
    if (!chapter) throw new Error(`Chapitre ${index} inexistant.`);
    return htmlToText(await zip.readText(chapter.href));
  }

  // Un titre par défaut ne peut être déduit qu'après lecture : on le fait
  // à la demande, pour ne pas décompresser tout le livre à l'ouverture.
  async function titleOf(index) {
    if (chapters[index].title) return chapters[index].title;
    const text = await readChapter(index);
    const firstLine = text.split('\n').find((l) => l.trim());
    chapters[index].title = firstLine && firstLine.length <= 90
      ? firstLine.trim()
      : `Chapitre ${index + 1}`;
    return chapters[index].title;
  }

  async function readAll(onProgress) {
    const parts = [];
    for (let i = 0; i < chapters.length; i++) {
      parts.push(await readChapter(i));
      if (onProgress) onProgress(i + 1, chapters.length);
    }
    return parts.filter((p) => p.trim()).join('\n\n');
  }

  return { title, author, language, chapters, readChapter, titleOf, readAll };
}
