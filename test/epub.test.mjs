import test from 'node:test';
import assert from 'node:assert/strict';
import { openZip } from '../src/zip.js';
import { openEpub, htmlToText, decodeEntities, findTags } from '../src/epub.js';

// ---------------------------------------------------------------------------
// Fabrication d'archives de test. Écrire un ZIP est bien plus court que le
// lire, et cela évite de faire dépendre les tests d'un fichier binaire figé.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * @param {Record<string,string|Uint8Array>} files
 * @param {{compress?: boolean, method?: number}} opts
 */
async function makeZip(files, opts = {}) {
  const { compress = true, method } = opts;
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const raw = typeof content === 'string' ? encoder.encode(content) : content;
    const nameBytes = encoder.encode(name);
    const useDeflate = method === undefined ? compress : method === 8;
    const stored = method !== undefined ? method : (useDeflate ? 8 : 0);
    const body = stored === 8 ? await deflateRaw(raw) : raw;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x800, true);
    lv.setUint16(8, stored, true);
    lv.setUint32(14, crc32(raw), true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);

    const entry = new Uint8Array(46 + nameBytes.length);
    const ev = new DataView(entry.buffer);
    ev.setUint32(0, 0x02014b50, true);
    ev.setUint16(4, 20, true);
    ev.setUint16(6, 20, true);
    ev.setUint16(8, 0x800, true);
    ev.setUint16(10, stored, true);
    ev.setUint32(16, crc32(raw), true);
    ev.setUint32(20, body.length, true);
    ev.setUint32(24, raw.length, true);
    ev.setUint16(28, nameBytes.length, true);
    ev.setUint32(42, offset, true);
    entry.set(nameBytes, 46);
    central.push(entry);

    chunks.push(local, body);
    offset += local.length + body.length;
  }

  const centralSize = central.reduce((a, e) => a + e.length, 0);
  const eocd = new Uint8Array(22);
  const dv = new DataView(eocd.buffer);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(8, central.length, true);
  dv.setUint16(10, central.length, true);
  dv.setUint32(12, centralSize, true);
  dv.setUint32(16, offset, true);

  const total = offset + centralSize + 22;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of [...chunks, ...central, eocd]) { out.set(c, p); p += c.length; }
  return out;
}

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/livre.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const OPF = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Le Rivage des Syrtes</dc:title>
    <dc:creator>Julien Gracq</dc:creator>
    <dc:language>fr</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="texte/chap1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="texte/chap2.xhtml" media-type="application/xhtml+xml"/>
    <item id="pub" href="texte/pub.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="pub" linear="no"/>
  </spine>
</package>`;

const NAV = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<body><nav epub:type="toc"><ol>
  <li><a href="texte/chap1.xhtml">L&#8217;attente</a></li>
  <li><a href="texte/chap2.xhtml">La chambre des cartes</a></li>
</ol></nav></body></html>`;

const CHAP1 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>ignoré</title>
<style>p { color: red }</style></head>
<body>
  <h1>L&#8217;attente</h1>
  <p>J&#8217;appartiens &#224; l&#8217;une des plus vieilles familles d&#8217;Orsenna.</p>
  <p>Le soir tombait.<br/>La mer &#233;tait calme.</p>
  <script>console.log('rien')</script>
</body></html>`;

const CHAP2 = '<html><body><p>Second chapitre, plus court.</p></body></html>';
const PUB = '<html><body><p>Publicité que personne ne veut entendre.</p></body></html>';

const makeEpub = (over = {}) => makeZip({
  'mimetype': 'application/epub+zip',
  'META-INF/container.xml': CONTAINER,
  'OEBPS/livre.opf': OPF,
  'OEBPS/nav.xhtml': NAV,
  'OEBPS/texte/chap1.xhtml': CHAP1,
  'OEBPS/texte/chap2.xhtml': CHAP2,
  'OEBPS/texte/pub.xhtml': PUB,
  'OEBPS/style.css': 'p { margin: 0 }',
  ...over,
});

// ---------------------------------------------------------------------------
// Lecture d'archive
// ---------------------------------------------------------------------------

test('zip : relit un contenu stocké tel quel', async () => {
  const zip = openZip(await makeZip({ 'a.txt': 'Bonjour' }, { compress: false }));
  assert.equal(await zip.readText('a.txt'), 'Bonjour');
});

test('zip : décompresse un contenu dégonflé', async () => {
  const long = 'Il faisait un temps splendide. '.repeat(200);
  const zip = openZip(await makeZip({ 'a.txt': long }, { compress: true }));
  assert.equal(await zip.readText('a.txt'), long);
});

test('zip : liste les fichiers, y compris dans les sous-dossiers', async () => {
  const zip = openZip(await makeEpub());
  assert.ok(zip.names.includes('OEBPS/texte/chap1.xhtml'));
  assert.ok(zip.has('META-INF/container.xml'));
  assert.ok(!zip.has('absent.txt'));
});

test('zip : les noms accentués survivent', async () => {
  const zip = openZip(await makeZip({ 'préface été.txt': 'ok' }));
  assert.ok(zip.names.includes('préface été.txt'));
  assert.equal(await zip.readText('préface été.txt'), 'ok');
});

test('zip : un fichier absent donne une erreur explicite', async () => {
  const zip = openZip(await makeZip({ 'a.txt': 'x' }));
  await assert.rejects(() => zip.read('b.txt'), /absent de l'archive/);
});

test('zip : une archive tronquée est signalée, pas devinée', () => {
  assert.throws(() => openZip(new Uint8Array(50)), /fin de catalogue introuvable/);
});

test('zip : une compression exotique est refusée clairement', async () => {
  const data = await makeZip({ 'a.txt': 'x' }, { method: 0 });
  // On maquille la méthode en 12 (bzip2) dans le catalogue.
  const view = new DataView(data.buffer);
  for (let i = 0; i < data.length - 4; i++) {
    if (view.getUint32(i, true) === 0x02014b50) { view.setUint16(i + 10, 12, true); break; }
  }
  const zip = openZip(data);
  await assert.rejects(() => zip.read('a.txt'), /méthode 12/);
});

// ---------------------------------------------------------------------------
// Conversion du XHTML en texte
// ---------------------------------------------------------------------------

test('html : les paragraphes deviennent des lignes vides', () => {
  const text = htmlToText('<p>Premier.</p><p>Second.</p>');
  assert.equal(text, 'Premier.\n\nSecond.');
});

test('html : un saut de ligne reste un simple saut de ligne', () => {
  assert.equal(htmlToText('<p>Un vers<br/>Un autre</p>'), 'Un vers\nUn autre');
});

test('html : les scripts, styles et en-têtes ne sont pas lus', () => {
  const text = htmlToText(CHAP1);
  assert.doesNotMatch(text, /console\.log|color: red|ignoré/);
});

test('html : les entités redeviennent des caractères', () => {
  const text = htmlToText('<p>J&#8217;appartiens &#224; l&#8217;une des &laquo;&nbsp;familles&nbsp;&raquo;.</p>');
  assert.equal(text, 'J’appartiens à l’une des « familles ».');
});

test('html : les entités inconnues sont laissées telles quelles', () => {
  assert.equal(decodeEntities('a &inconnue; b'), 'a &inconnue; b');
});

test('html : un titre est isolé du texte qui suit', () => {
  const text = htmlToText('<h1>Chapitre premier</h1><p>Il était une fois.</p>');
  assert.equal(text, 'Chapitre premier\n\nIl était une fois.');
});

test('html : les balises en ligne ne coupent pas la phrase', () => {
  const text = htmlToText('<p>Un mot <em>souligné</em> au milieu.</p>');
  assert.equal(text, 'Un mot souligné au milieu.');
});

test('html : le texte sans balise passe intact', () => {
  assert.equal(htmlToText('Juste du texte.'), 'Juste du texte.');
});

test('findTags : lit les attributs, y compris auto-fermants', () => {
  const tags = findTags('<item id="a" href="x.html"/><item id="b" href="y.html"/>', 'item');
  assert.equal(tags.length, 2);
  assert.equal(tags[0].attrs.href, 'x.html');
  assert.equal(tags[1].attrs.id, 'b');
});

test('findTags : ignore les espaces de noms', () => {
  const tags = findTags('<dc:title>Titre</dc:title>', 'title');
  assert.equal(tags[0].inner, 'Titre');
});

test('findTags : gère les imbrications', () => {
  const tags = findTags('<navPoint a="1"><navPoint a="2"></navPoint></navPoint>', 'navPoint');
  assert.equal(tags.length, 1);
  assert.equal(tags[0].attrs.a, '1');
  assert.match(tags[0].inner, /a="2"/);
});

test('findTags : ne confond pas une balise avec une autre commençant pareil', () => {
  assert.equal(findTags('<article>x</article>', 'a').length, 0);
});

// ---------------------------------------------------------------------------
// Livre complet
// ---------------------------------------------------------------------------

test('epub : lit le titre, l’auteur et la langue', async () => {
  const livre = await openEpub(await makeEpub());
  assert.equal(livre.title, 'Le Rivage des Syrtes');
  assert.equal(livre.author, 'Julien Gracq');
  assert.equal(livre.language, 'fr');
});

test('epub : suit l’ordre de lecture et écarte le hors-texte', async () => {
  const livre = await openEpub(await makeEpub());
  assert.equal(livre.chapters.length, 2, 'le linear="no" ne doit pas être lu');
  assert.equal(livre.chapters[0].href, 'OEBPS/texte/chap1.xhtml');
  assert.equal(livre.chapters[1].href, 'OEBPS/texte/chap2.xhtml');
});

test('epub : reprend les titres de la table des matières', async () => {
  const livre = await openEpub(await makeEpub());
  assert.equal(livre.chapters[0].title, 'L’attente');
  assert.equal(livre.chapters[1].title, 'La chambre des cartes');
});

test('epub : rend le texte d’un chapitre, prêt à être lu', async () => {
  const livre = await openEpub(await makeEpub());
  const texte = await livre.readChapter(0);
  assert.match(texte, /^L’attente\n\nJ’appartiens à l’une des plus vieilles familles d’Orsenna\./);
  assert.match(texte, /Le soir tombait\.\nLa mer était calme\./);
});

test('epub : réunit tout le livre dans l’ordre', async () => {
  const livre = await openEpub(await makeEpub());
  const suivi = [];
  const tout = await livre.readAll((fait, total) => suivi.push(`${fait}/${total}`));
  assert.deepEqual(suivi, ['1/2', '2/2']);
  assert.ok(tout.indexOf('L’attente') < tout.indexOf('Second chapitre'));
  assert.doesNotMatch(tout, /Publicité/);
});

test('epub : sans table des matières, un titre est déduit du chapitre', async () => {
  const sansNav = await makeEpub({
    'OEBPS/livre.opf': OPF.replace(/<item id="nav"[^>]*>/, ''),
    'OEBPS/nav.xhtml': '<html><body></body></html>',
  });
  const livre = await openEpub(sansNav);
  assert.equal(await livre.titleOf(1), 'Second chapitre, plus court.');
});

test('epub : une table des matières EPUB 2 (NCX) fait aussi l’affaire', async () => {
  const ncx = `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/">
    <navMap>
      <navPoint id="n1"><navLabel><text>Ouverture</text></navLabel><content src="texte/chap1.xhtml"/></navPoint>
      <navPoint id="n2"><navLabel><text>Fermeture</text></navLabel><content src="texte/chap2.xhtml"/></navPoint>
    </navMap></ncx>`;
  const opf2 = OPF
    .replace(/<item id="nav"[^>]*>/, '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>')
    .replace('<spine>', '<spine toc="ncx">');
  const livre = await openEpub(await makeEpub({ 'OEBPS/livre.opf': opf2, 'OEBPS/toc.ncx': ncx }));
  assert.equal(livre.chapters[0].title, 'Ouverture');
  assert.equal(livre.chapters[1].title, 'Fermeture');
});

test('epub : un fichier qui n’en est pas un est refusé clairement', async () => {
  const pasUnLivre = await makeZip({ 'lisezmoi.txt': 'bonjour' });
  await assert.rejects(() => openEpub(pasUnLivre), /n'est pas un EPUB/);
});

test('epub : un OPF introuvable est signalé', async () => {
  const casse = await makeEpub({
    'META-INF/container.xml': CONTAINER.replace('OEBPS/livre.opf', 'OEBPS/absent.opf'),
  });
  await assert.rejects(() => openEpub(casse), /OPF est introuvable/);
});

test('epub : un chapitre déclaré mais absent de l’archive est ignoré', async () => {
  const opf3 = OPF.replace('<itemref idref="ch2"/>', '<itemref idref="ch2"/><itemref idref="fantome"/>')
    .replace('</manifest>', '<item id="fantome" href="texte/absent.xhtml" media-type="application/xhtml+xml"/></manifest>');
  const livre = await openEpub(await makeEpub({ 'OEBPS/livre.opf': opf3 }));
  assert.equal(livre.chapters.length, 2);
});
