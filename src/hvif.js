// --- Haiku Vector Icon Format (.hvif) to SVG ---
// Haiku's icons (Icon-O-Matic's "HVIF" export; what Haiku keeps in a file's
// BEOS:ICON attribute) are a small binary vector format: "ncif", then styles
// (colors, gradients), paths and shapes, 64×64 units. No browser shows it;
// here it becomes SVG, which any <img> shows. It is read and drawn by
// haikon-js (github.com/alwinb/haikon-js, Alwin Blok), loaded from esm.sh
// when one is opened. Its limits are this viewer's: conic and diamond
// gradients are drawn as radial ones, a shape keeps only its last stroke or
// contour, and level-of-detail ranges are ignored (every shape is drawn).
// Icon-O-Matic's own documents (.iom) are flattened messages, not HVIF.
const { createLogger } = require('./debug');

const log = createLogger('HVIF');
const HAIKON = 'https://esm.sh/haikon-js@1.0.0-beta';
const HVIF_RE = /\.hvif$/i;
const MAGIC = [0x6e, 0x63, 0x69, 0x66]; // "ncif"
// the SVG's size in an <img>: Haiku draws icons at 16 to 64 pixels and more
const SIZE = 256;

let haikonPromise = null;
const converted = new Map(); // source URL -> Promise<{ url, label }>

function isHvifName(name) {
    return HVIF_RE.test(name || '');
}

function isHvif(bytes) {
    return bytes.length >= 4 && MAGIC.every((b, i) => bytes[i] === b);
}

function haikon() {
    if (!haikonPromise) {
        haikonPromise = import(HAIKON).then(m => m.default || m);
        haikonPromise.catch(() => { haikonPromise = null; });
    }
    return haikonPromise;
}

// The icon's SVG (a string) and what it holds
async function hvifToSvg(bytes) {
    if (!isHvif(bytes)) throw new Error('Not a Haiku vector icon (no "ncif" magic)');
    const { hvif, svg } = await haikon();
    const icon = hvif.parse(bytes);
    // haikon-js's own elements (it renders for inline use: a <span> around an <svg> sized 2em)
    const root = svg.renderIcon(icon, 'hvif').children[0];
    root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    root.setAttribute('width', SIZE);
    root.setAttribute('height', SIZE);
    delete root.attributes.style;
    const label = `Haiku vector icon: ${icon.shapes.length} shapes, ${icon.paths.length} paths, ${icon.styles.length} styles`;
    return { svg: root.toSVGString(), label };
}

// { url: blob URL of the SVG, label }
function hvifImage(url) {
    let p = converted.get(url);
    if (!p) {
        p = (async () => {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const { svg, label } = await hvifToSvg(new Uint8Array(await resp.arrayBuffer()));
            return { url: URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })), label };
        })();
        converted.set(url, p);
        p.catch(err => { converted.delete(url); log.warn('HVIF decode failed:', err); });
        if (converted.size > 64) {
            const [oldUrl, old] = converted.entries().next().value;
            converted.delete(oldUrl);
            old.then(d => URL.revokeObjectURL(d.url)).catch(() => {});
        }
    }
    return p;
}

module.exports = { isHvifName, isHvif, hvifToSvg, hvifImage };
