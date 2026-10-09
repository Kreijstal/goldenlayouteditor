// Adapted from jdeworks/file-viewer, commit f3934e9a75fe01d6fd74830e996a0111a7dc4fc2.
// Copyright (c) 2026 jdeworks. MIT; see public/licenses/imported-viewers/jdeworks-MIT.txt.
const DOMPurify = require('dompurify');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Map a binary id → data: URL from the <binary> elements.
function collectImages(doc) {
  const map = new Map();
  for (const b of doc.getElementsByTagName('binary')) {
    const id = b.getAttribute('id');
    const ct = b.getAttribute('content-type') || '';
    const data = (b.textContent || '').replace(/\s+/g, '');
    if (id && data && /^image\/(?:png|jpeg|gif|webp|avif|bmp)$/i.test(ct) && /^[A-Za-z0-9+/]*={0,2}$/.test(data)) map.set(id, 'data:' + ct + ';base64,' + data);
  }
  return map;
}

function imgHref(el) {
  return el.getAttribute('l:href') || el.getAttribute('xlink:href') || el.getAttribute('href') || '';
}

// Recursively convert an FB2 node to HTML. `depth` tracks <section> nesting for heading levels.
function convert(node, images, depth) {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === 3) { out += esc(child.nodeValue); continue; }   // text
    if (child.nodeType !== 1) continue;
    const tag = child.localName || child.nodeName;
    switch (tag) {
      case 'section': out += '<section class="fb2-section" id="' + esc(child.getAttribute('id') || '') + '">' + convert(child, images, depth + 1) + '</section>'; break;
      case 'title': { const h = Math.min(6, depth + 1); out += '<h' + h + ' class="fb2-title">' + convert(child, images, depth) + '</h' + h + '>'; break; }
      case 'subtitle': out += '<h6 class="fb2-subtitle">' + convert(child, images, depth) + '</h6>'; break;
      case 'p': out += '<p>' + convert(child, images, depth) + '</p>'; break;
      case 'empty-line': out += '<div class="fb2-empty"></div>'; break;
      case 'emphasis': out += '<em>' + convert(child, images, depth) + '</em>'; break;
      case 'strong': out += '<strong>' + convert(child, images, depth) + '</strong>'; break;
      case 'strikethrough': out += '<s>' + convert(child, images, depth) + '</s>'; break;
      case 'sub': out += '<sub>' + convert(child, images, depth) + '</sub>'; break;
      case 'sup': out += '<sup>' + convert(child, images, depth) + '</sup>'; break;
      case 'code': out += '<code>' + convert(child, images, depth) + '</code>'; break;
      case 'epigraph': out += '<blockquote class="fb2-epigraph">' + convert(child, images, depth) + '</blockquote>'; break;
      case 'cite': out += '<blockquote class="fb2-cite">' + convert(child, images, depth) + '</blockquote>'; break;
      case 'poem': out += '<div class="fb2-poem">' + convert(child, images, depth) + '</div>'; break;
      case 'stanza': out += '<div class="fb2-stanza">' + convert(child, images, depth) + '</div>'; break;
      case 'v': out += '<div class="fb2-v">' + convert(child, images, depth) + '</div>'; break;
      case 'a': { const href = imgHref(child); out += '<a' + (href.startsWith('#') ? ' href="' + esc(href) + '"' : '') + '>' + convert(child, images, depth) + '</a>'; break; }
      case 'image': { const href = imgHref(child).replace(/^#/, ''); const src = images.get(href); if (src) out += '<img class="fb2-img" src="' + src + '" alt="">'; break; }
      case 'table': out += '<table>' + convert(child, images, depth) + '</table>'; break;
      case 'tr': out += '<tr>' + convert(child, images, depth) + '</tr>'; break;
      case 'td': out += '<td>' + convert(child, images, depth) + '</td>'; break;
      case 'th': out += '<th>' + convert(child, images, depth) + '</th>'; break;
      default: out += convert(child, images, depth);   // unknown wrapper → inline its children
    }
  }
  return out;
}

function readFb2(bytes) {
  let encoding = 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  else {
    const declaration = new TextDecoder('ascii').decode(bytes.subarray(0, 200));
    const match = /<\?xml[^>]*encoding=["']([^"']+)/i.exec(declaration);
    if (match) encoding = match[1];
  }
  const doc = new DOMParser().parseFromString(new TextDecoder(encoding).decode(bytes), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length || doc.documentElement.localName !== 'FictionBook') throw new Error('Invalid FictionBook XML');
  const images = collectImages(doc);
  const bodies = doc.getElementsByTagName('body');
  if (!bodies.length) throw new Error('FictionBook has no body');
  const titleInfo = doc.getElementsByTagName('title-info')[0];
  const title = titleInfo?.getElementsByTagName('book-title')[0]?.textContent || 'FictionBook';
  const authors = titleInfo ? Array.from(titleInfo.getElementsByTagName('author')).map(author => Array.from(author.children).map(c=>c.textContent.trim()).filter(Boolean).join(' ')) : [];
  const header = '<header><h1>' + esc(title) + '</h1><p>' + esc(authors.join(', ')) + '</p></header>';
  const html = DOMPurify.sanitize(header + Array.from(bodies).map(body => convert(body,images,0)).join(''), {
    ADD_DATA_URI_TAGS:['img'], FORBID_TAGS:['script','style'], FORBID_ATTR:['onerror','onload','onclick'],
  });
  return { html, title, summary: title };
}
module.exports = { readFb2 };
