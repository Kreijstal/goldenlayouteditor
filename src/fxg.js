// --- FXG (Flash XML Graphics) to SVG ---
// FXG 1.0/2.0 (Flex 4, Illustrator, Fireworks, Flash Catalyst) is XML whose
// model is close to SVG's: Groups with transforms, Rect/Ellipse/Line/Path,
// solid, gradient and bitmap fills and strokes, filters, masks, blend modes
// and rich text. Each element becomes its SVG counterpart; gradients are
// placed as Flex places them (the 1638.4-unit gradient box mapped onto the
// shape's bounds), text becomes HTML in a <foreignObject> so it wraps and
// aligns as FXG lays it out. Bitmaps are referenced by their @Embed source,
// which the caller resolves (fxgImageSources lists them).

const FXG_NS = 'http://ns.adobe.com/fxg/2008';
const XHTML_NS = 'http://www.w3.org/1999/xhtml';
// Flash's gradient box: -819.2 … 819.2 in each direction
const GRADIENT_DIMENSION = 1638.4;
const BLEND_MODES = {
    multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten',
    difference: 'difference', hardlight: 'hard-light', softlight: 'soft-light', colordodge: 'color-dodge',
    colorburn: 'color-burn', exclusion: 'exclusion', hue: 'hue', saturation: 'saturation', color: 'color',
    luminosity: 'luminosity', add: 'plus-lighter',
};
const SHAPES = new Set(['Rect', 'Ellipse', 'Line', 'Path']);
const TEXT_ELEMENTS = new Set(['RichText', 'TextGraphic']);

let conversions = 0;

const fmt = n => String(+(+n).toFixed(4));

function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// FXG elements are in its namespace (FXG 1.0 files sometimes have none);
// anything else (ai:, d:, flm: private data) is ignored
function isFxg(el) {
    return el.nodeType === 1 && (el.namespaceURI === FXG_NS || el.namespaceURI === null);
}

function kids(el) {
    return [...el.childNodes].filter(isFxg);
}

function kid(el, name) {
    return kids(el).find(c => c.localName === name) || null;
}

function attr(el, name) {
    const v = el.getAttributeNS(null, name);
    return v === null || v === '' ? null : v;
}

function num(el, name, dflt) {
    const v = attr(el, name);
    if (v === null) return dflt;
    // FXG allows percentages for a few attributes (lineHeight); callers that accept them read them as text
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : dflt;
}

function bool(el, name, dflt) {
    const v = attr(el, name);
    return v === null ? dflt : v === 'true';
}

// #RRGGBB, #RGB, 0xRRGGBB or a number
function color(v, dflt = '#000000') {
    if (v === null || v === undefined) return dflt;
    v = String(v).trim();
    let m = /^#([0-9a-f]{6})$/i.exec(v) || /^0x([0-9a-f]{1,6})$/i.exec(v);
    if (m) return '#' + m[1].padStart(6, '0').toLowerCase();
    m = /^#([0-9a-f]{3})$/i.exec(v);
    if (m) return '#' + m[1].split('').map(c => c + c).join('').toLowerCase();
    if (/^\d+$/.test(v)) return '#' + (+v & 0xffffff).toString(16).padStart(6, '0');
    return dflt;
}

// A 2D affine matrix [a, b, c, d, tx, ty] (x' = a·x + c·y + tx, y' = b·x + d·y + ty)
const IDENTITY = [1, 0, 0, 1, 0, 0];

function multiply(m, n) { // m ∘ n: n first, then m
    return [
        m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
    ];
}

function matrixString(m) {
    return `matrix(${m.map(fmt).join(' ')})`;
}

function readMatrix(el) {
    return [num(el, 'a', 1), num(el, 'b', 0), num(el, 'c', 0), num(el, 'd', 1), num(el, 'tx', 0), num(el, 'ty', 0)];
}

// An element's own transform: a <transform><Transform><matrix><Matrix/> child,
// or x, y, scaleX, scaleY, rotation about (transformX, transformY), as Flex's
// MatrixUtil.composeMatrix builds it
function elementMatrix(el, extra = {}) {
    const t = kid(el, 'transform');
    const tr = t && kid(t, 'Transform');
    const mWrap = tr && kid(tr, 'matrix');
    const mEl = mWrap && kid(mWrap, 'Matrix');
    if (mEl) return readMatrix(mEl);
    const x = num(el, 'x', 0) + (extra.x || 0), y = num(el, 'y', 0) + (extra.y || 0);
    const sx = num(el, 'scaleX', 1), sy = num(el, 'scaleY', 1), rot = num(el, 'rotation', 0);
    const tX = num(el, 'transformX', 0), tY = num(el, 'transformY', 0);
    if (sx === 1 && sy === 1 && !rot) return [1, 0, 0, 1, x, y];
    const r = rot * Math.PI / 180, cos = Math.cos(r), sin = Math.sin(r);
    let m = [1, 0, 0, 1, -tX, -tY];
    m = multiply([sx, 0, 0, sy, 0, 0], m);
    m = multiply([cos, sin, -sin, cos, 0, 0], m);
    return multiply([1, 0, 0, 1, x + tX, y + tY], m);
}

function transformAttr(m) {
    if (m.every((v, i) => v === IDENTITY[i])) return '';
    if (m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1) return ` transform="translate(${fmt(m[4])} ${fmt(m[5])})"`;
    return ` transform="${matrixString(m)}"`;
}

// The ColorTransform child of an element's <transform>, if any
function colorTransformOf(el) {
    const t = kid(el, 'transform');
    const tr = t && kid(t, 'Transform');
    const cw = tr && kid(tr, 'colorTransform');
    return cw && kid(cw, 'ColorTransform');
}

// --- Path data ---

// Tokens of FXG path data (the SVG syntax, without arcs): commands and numbers
function pathTokens(d) {
    return d.match(/[MmLlHhVvCcSsQqTtZzAa]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || [];
}

// Bounds of path data from its points and control points, which contain the curve
function pathBounds(d) {
    const t = pathTokens(d);
    let i = 0, cmd = null, x = 0, y = 0, sx = 0, sy = 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const add = (px, py) => {
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (py < minY) minY = py; if (py > maxY) maxY = py;
    };
    const n = () => parseFloat(t[i++]);
    const ARGS = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };
    while (i < t.length) {
        if (/[a-z]/i.test(t[i])) cmd = t[i++];
        if (!cmd) { i++; continue; }
        const lc = cmd.toLowerCase(), rel = cmd !== cmd.toUpperCase();
        if (lc === 'z') { x = sx; y = sy; cmd = null; continue; }
        if (i + ARGS[lc] > t.length) break;
        const ox = rel ? x : 0, oy = rel ? y : 0;
        if (lc === 'h') { x = n() + (rel ? x : 0); add(x, y); continue; }
        if (lc === 'v') { y = n() + (rel ? y : 0); add(x, y); continue; }
        if (lc === 'a') { i += 5; x = n() + ox; y = n() + oy; add(x, y); continue; }
        const pts = [];
        for (let k = 0; k < ARGS[lc] / 2; k++) pts.push([n() + ox, n() + oy]);
        pts.forEach(p => add(p[0], p[1]));
        [x, y] = pts[pts.length - 1];
        if (lc === 'm') { sx = x; sy = y; cmd = rel ? 'l' : 'L'; }
    }
    if (minX === Infinity) return { left: 0, top: 0, width: 0, height: 0 };
    return { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
}

// A rectangle with its own radius at each corner, as a path
function roundedRectPath(w, h, r) {
    const [tl, tr, br, bl] = r.map(([rx, ry]) => [Math.min(rx, w / 2), Math.min(ry, h / 2)]);
    return `M${fmt(tl[0])} 0H${fmt(w - tr[0])}`
        + (tr[0] && tr[1] ? `A${fmt(tr[0])} ${fmt(tr[1])} 0 0 1 ${fmt(w)} ${fmt(tr[1])}` : `L${fmt(w)} 0`)
        + `V${fmt(h - br[1])}`
        + (br[0] && br[1] ? `A${fmt(br[0])} ${fmt(br[1])} 0 0 1 ${fmt(w - br[0])} ${fmt(h)}` : `L${fmt(w)} ${fmt(h)}`)
        + `H${fmt(bl[0])}`
        + (bl[0] && bl[1] ? `A${fmt(bl[0])} ${fmt(bl[1])} 0 0 1 0 ${fmt(h - bl[1])}` : `L0 ${fmt(h)}`)
        + `V${fmt(tl[1])}`
        + (tl[0] && tl[1] ? `A${fmt(tl[0])} ${fmt(tl[1])} 0 0 1 ${fmt(tl[0])} 0` : 'L0 0')
        + 'Z';
}

// --- @Embed sources ---

// 'pic.png' from "@Embed('pic.png')", "@Embed(source='pic.png')" or a plain path
function embedSource(v) {
    if (!v) return null;
    const m = /^\s*@Embed\s*\(\s*(?:source\s*=\s*)?(['"]?)(.*?)\1\s*\)\s*$/i.exec(v);
    return (m ? m[2] : v).trim() || null;
}

function parse(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const err = doc.getElementsByTagName('parsererror')[0];
    if (err) {
        // Chromium wraps the parser's message in a page of its own
        const text = (err.textContent || '').trim();
        const m = /(?:error )?on line \d+ at column \d+:[^\n]*/.exec(text);
        throw new Error('not well-formed XML: ' + (m ? m[0].replace(/^error /, '') : text.split('\n')[0]));
    }
    const root = doc.documentElement;
    if (!root || root.localName !== 'Graphic') throw new Error(`the root element is <${root ? root.localName : '?'}>, not an FXG <Graphic>`);
    return root;
}

// The bitmap sources an FXG file refers to (BitmapImage and BitmapFill), as written in it
function fxgImageSources(text) {
    const root = parse(text);
    const out = new Set();
    for (const el of root.getElementsByTagName('*')) {
        if (!isFxg(el) || (el.localName !== 'BitmapImage' && el.localName !== 'BitmapFill' && el.localName !== 'BitmapGraphic')) continue;
        const src = embedSource(attr(el, 'source'));
        if (src) out.add(src);
    }
    return [...out];
}

// --- The conversion ---

class Converter {
    constructor(root, opts) {
        this.root = root;
        this.images = opts.images || new Map(); // source -> { href, width, height }
        this.prefix = `fxg${++conversions}-`;
        this.nextId = 0;
        this.defs = [];
        this.counts = {};
        this.unsupported = new Set();
        this.missingImages = new Set();
        this.definitions = new Map();
        this.instancing = new Set();
    }

    id(kind) {
        return `${this.prefix}${kind}${++this.nextId}`;
    }

    count(name) {
        this.counts[name] = (this.counts[name] || 0) + 1;
    }

    run() {
        const root = this.root;
        const lib = kid(root, 'Library');
        if (lib) {
            for (const def of kids(lib)) {
                if (def.localName !== 'Definition') continue;
                const name = attr(def, 'name');
                const g = kid(def, 'Group');
                if (name && g) this.definitions.set(name, g);
            }
        }
        let body = this.children(root);
        // The Graphic itself may have a mask over everything
        const rootMask = this.mask(root);
        if (rootMask) body = `<g mask="url(#${rootMask})">${body}</g>`;
        const vw = num(root, 'viewWidth', null), vh = num(root, 'viewHeight', null);
        const size = vw !== null && vh !== null
            ? ` width="${fmt(vw)}" height="${fmt(vh)}" viewBox="0 0 ${fmt(vw)} ${fmt(vh)}"` : '';
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"${size} overflow="visible">`
            + (this.defs.length ? `<defs>${this.defs.join('')}</defs>` : '')
            + body + '</svg>';
        return {
            svg,
            width: vw, height: vh,
            version: attr(root, 'version'),
            counts: this.counts,
            unsupported: [...this.unsupported],
            missingImages: [...this.missingImages],
        };
    }

    children(el) {
        return kids(el).map(c => this.element(c)).join('');
    }

    element(el) {
        const name = el.localName;
        if (attr(el, 'visible') === 'false') return '';
        if (name === 'Group') return this.group(el, el);
        if (SHAPES.has(name)) return this.shape(el);
        if (name === 'BitmapImage' || name === 'BitmapGraphic') return this.bitmap(el);
        if (TEXT_ELEMENTS.has(name)) return this.text(el);
        if (this.definitions.has(name)) return this.instance(el);
        // Property elements and data that draw nothing
        if (['Library', 'Private', 'transform', 'filters', 'mask', 'fill', 'stroke', 'content', 'Definition'].includes(name)) return '';
        this.unsupported.add(`<${name}>`);
        return '';
    }

    // A placed symbol: the definition's Group under the instance's transform and effects
    instance(el) {
        const name = el.localName;
        if (this.instancing.has(name)) { this.unsupported.add(`recursive <${name}>`); return ''; }
        this.count('symbol instance');
        this.instancing.add(name);
        const inner = this.group(this.definitions.get(name), this.definitions.get(name));
        this.instancing.delete(name);
        return this.wrap(el, inner);
    }

    group(el, contentEl) {
        this.count('Group');
        return this.wrap(el, this.children(contentEl));
    }

    // An element's transform, opacity, blend mode, filters and mask around its content
    wrap(el, content, matrix = elementMatrix(el)) {
        const attrs = transformAttr(matrix) + this.effects(el);
        const mask = this.mask(el);
        if (mask) {
            // The mask is in the element's coordinates and is not affected by its filters
            return `<g${transformAttr(matrix)} mask="url(#${mask})"><g${this.effects(el)}>${content}</g></g>`;
        }
        return `<g${attrs}>${content}</g>`;
    }

    // opacity, mix-blend-mode and filter attributes
    effects(el) {
        let out = '';
        const alpha = num(el, 'alpha', 1);
        if (alpha < 1) out += ` opacity="${fmt(Math.max(0, alpha))}"`;
        const blend = (attr(el, 'blendMode') || '').toLowerCase();
        if (BLEND_MODES[blend]) out += ` style="mix-blend-mode:${BLEND_MODES[blend]}"`;
        else if (blend && !['normal', 'auto', 'layer'].includes(blend)) this.unsupported.add(`blendMode="${blend}"`);
        const filter = this.filter(el);
        if (filter) out += ` filter="url(#${filter})"`;
        return out;
    }

    mask(el) {
        const mw = kid(el, 'mask');
        const g = mw && kids(mw)[0];
        if (!g) return null;
        this.count('mask');
        const id = this.id('mask');
        const type = (attr(el, 'maskType') || 'clip').toLowerCase();
        let content = this.element(g);
        // A clip mask is the shape of its content, whatever its colors
        if (type === 'clip') content = `<g filter="url(#${this.opaqueFilter()})">${content}</g>`;
        if (type === 'luminosity' && bool(el, 'luminosityInvert', false)) this.unsupported.add('luminosityInvert');
        const maskType = type === 'luminosity' ? 'luminance' : 'alpha';
        this.defs.push(`<mask id="${id}" maskUnits="userSpaceOnUse" x="-1e6" y="-1e6" width="2e6" height="2e6" style="mask-type:${maskType}">${content}</mask>`);
        return id;
    }

    opaqueFilter() {
        if (!this._opaque) {
            this._opaque = this.id('opaque');
            this.defs.push(`<filter id="${this._opaque}"><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 1000 0"/></filter>`);
        }
        return this._opaque;
    }

    // --- Shapes ---

    shape(el) {
        const name = el.localName;
        this.count(name);
        let geom, bounds;
        if (name === 'Rect') {
            const w = num(el, 'width', 0), h = num(el, 'height', 0);
            bounds = { left: 0, top: 0, width: w, height: h };
            const rx = num(el, 'radiusX', 0), ry = num(el, 'radiusY', rx);
            const corner = c => [num(el, c + 'RadiusX', rx), num(el, c + 'RadiusY', num(el, c + 'RadiusX', ry))];
            const corners = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'].map(corner);
            if (corners.some(([cx, cy]) => cx !== rx || cy !== ry)) {
                geom = `<path d="${roundedRectPath(w, h, corners)}"`;
            } else {
                geom = `<rect width="${fmt(w)}" height="${fmt(h)}"${rx ? ` rx="${fmt(Math.min(rx, w / 2))}" ry="${fmt(Math.min(ry || rx, h / 2))}"` : ''}`;
            }
        } else if (name === 'Ellipse') {
            const w = num(el, 'width', 0), h = num(el, 'height', 0);
            bounds = { left: 0, top: 0, width: w, height: h };
            geom = `<ellipse cx="${fmt(w / 2)}" cy="${fmt(h / 2)}" rx="${fmt(w / 2)}" ry="${fmt(h / 2)}"`;
        } else if (name === 'Line') {
            const x1 = num(el, 'xFrom', 0), y1 = num(el, 'yFrom', 0), x2 = num(el, 'xTo', 0), y2 = num(el, 'yTo', 0);
            bounds = { left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
            geom = `<line x1="${fmt(x1)}" y1="${fmt(y1)}" x2="${fmt(x2)}" y2="${fmt(y2)}"`;
        } else {
            const d = attr(el, 'data') || '';
            bounds = pathBounds(d);
            geom = `<path d="${esc(d.trim())}"`;
            // FXG's default winding is even-odd, SVG's nonzero
            if ((attr(el, 'winding') || 'evenOdd') === 'evenOdd') geom += ' fill-rule="evenodd"';
        }
        const fillEl = kid(el, 'fill');
        const strokeEl = kid(el, 'stroke');
        const fill = name === 'Line' ? 'none' : this.paint(fillEl && kids(fillEl)[0], bounds);
        geom += ` fill="${fill}"` + this.stroke(strokeEl && kids(strokeEl)[0], bounds) + '/>';
        const matrix = elementMatrix(el);
        if (kid(el, 'mask')) return this.wrap(el, geom, matrix);
        return geom.replace(/\/>$/, transformAttr(matrix) + this.effects(el) + '/>');
    }

    // A fill: a color, or url(#gradient/pattern)
    paint(p, bounds) {
        if (!p) return 'none';
        const kind = p.localName;
        if (kind === 'SolidColor' || kind === 'SolidColorStroke') {
            const a = num(p, 'alpha', 1);
            return color(attr(p, 'color')) + (a < 1 ? `" fill-opacity="${fmt(a)}` : '');
        }
        if (/^(Linear|Radial)Gradient(Stroke)?$/.test(kind)) return `url(#${this.gradient(p, bounds)})`;
        if (kind === 'BitmapFill') return this.bitmapFill(p, bounds);
        this.unsupported.add(`<${kind}>`);
        return 'none';
    }

    stroke(s, bounds) {
        if (!s) return '';
        const kind = s.localName;
        let paint;
        if (kind === 'SolidColorStroke') {
            paint = ` stroke="${color(attr(s, 'color'))}"`;
            const a = num(s, 'alpha', 1);
            if (a < 1) paint += ` stroke-opacity="${fmt(a)}"`;
        } else if (/^(Linear|Radial)GradientStroke$/.test(kind)) {
            paint = ` stroke="url(#${this.gradient(s, bounds)})"`;
        } else {
            this.unsupported.add(`<${kind}>`);
            return '';
        }
        const w = num(s, 'weight', 1);
        // A weight of 0 is a hairline
        let out = paint + ` stroke-width="${fmt(w || 1)}"`;
        if (!w || (attr(s, 'scaleMode') || 'normal') !== 'normal') out += ' vector-effect="non-scaling-stroke"';
        const caps = attr(s, 'caps') || 'round';
        out += ` stroke-linecap="${caps === 'none' ? 'butt' : caps === 'square' ? 'square' : 'round'}"`;
        const joints = attr(s, 'joints') || 'round';
        out += ` stroke-linejoin="${joints === 'miter' ? 'miter' : joints === 'bevel' ? 'bevel' : 'round'}"`;
        if (joints === 'miter') out += ` stroke-miterlimit="${fmt(Math.max(1, num(s, 'miterLimit', 3)))}"`;
        return out;
    }

    // A gradient, placed as Flex's LinearGradient/RadialGradient.begin places it:
    // the gradient box (±819.2) scaled to the given (or the shape's) size, rotated,
    // and moved to the given (or the bounds' central) point, relative to the bounds
    gradient(g, bounds) {
        const radial = g.localName.startsWith('Radial');
        this.count(radial ? 'radial gradient' : 'linear gradient');
        const id = this.id('grad');
        const mWrap = kid(g, 'matrix');
        const mEl = mWrap && kid(mWrap, 'Matrix');
        let m;
        if (mEl) {
            m = multiply([1, 0, 0, 1, bounds.left, bounds.top], readMatrix(mEl));
            m = multiply(m, [1 / GRADIENT_DIMENSION, 0, 0, 1 / GRADIENT_DIMENSION, 0, 0]);
        } else {
            const w = num(g, 'scaleX', bounds.width);
            const h = radial ? num(g, 'scaleY', bounds.height) : 1;
            const tx = num(g, 'x', bounds.width / 2), ty = num(g, 'y', bounds.height / 2);
            const r = num(g, 'rotation', 0) * Math.PI / 180;
            m = [1, 0, 0, 1, tx + bounds.left, ty + bounds.top];
            m = multiply(m, [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]);
            m = multiply(m, [w / GRADIENT_DIMENSION, 0, 0, h / GRADIENT_DIMENSION, 0, 0]);
        }
        const spread = { reflect: 'reflect', repeat: 'repeat' }[attr(g, 'spreadMethod')] || 'pad';
        const entries = kids(g).filter(e => e.localName === 'GradientEntry');
        const stops = entries.map((e, i) => {
            // Entries without a ratio are spread evenly
            const ratio = num(e, 'ratio', entries.length > 1 ? i / (entries.length - 1) : 0);
            const a = num(e, 'alpha', 1);
            return `<stop offset="${fmt(Math.min(1, Math.max(0, ratio)))}" stop-color="${color(attr(e, 'color'))}"${a < 1 ? ` stop-opacity="${fmt(a)}"` : ''}/>`;
        }).join('');
        if (attr(g, 'interpolationMethod') === 'linearRGB') this.unsupported.add('linearRGB interpolation');
        const half = GRADIENT_DIMENSION / 2;
        const common = `id="${id}" gradientUnits="userSpaceOnUse" gradientTransform="${matrixString(m)}" spreadMethod="${spread}"`;
        if (radial) {
            const focal = Math.max(-1, Math.min(1, num(g, 'focalPointRatio', 0)));
            this.defs.push(`<radialGradient ${common} cx="0" cy="0" r="${half}" fx="${fmt(focal * half)}" fy="0">${stops}</radialGradient>`);
        } else {
            this.defs.push(`<linearGradient ${common} x1="${-half}" y1="0" x2="${half}" y2="0">${stops}</linearGradient>`);
        }
        return id;
    }

    // Flash draws bitmaps unsmoothed unless smooth="true"
    imageStyle(el) {
        return bool(el, 'smooth', false) ? '' : ' style="image-rendering:pixelated"';
    }

    image(source) {
        const src = embedSource(source);
        if (!src) return null;
        const img = this.images.get(src);
        if (!img) { this.missingImages.add(src); return null; }
        return img;
    }

    // A BitmapFill: by default the bitmap stretched over the shape's bounds;
    // with a transform, the bitmap at its own size moved by it, repeated or once
    bitmapFill(p, bounds) {
        this.count('bitmap fill');
        const img = this.image(attr(p, 'source'));
        if (!img) return 'none';
        const id = this.id('bmp');
        const mWrap = kid(p, 'matrix');
        const mEl = mWrap && kid(mWrap, 'Matrix');
        const placed = mEl || ['x', 'y', 'scaleX', 'scaleY', 'rotation'].some(a => attr(p, a) !== null);
        const mode = attr(p, 'fillMode') || (attr(p, 'repeat') === 'false' ? 'clip' : attr(p, 'repeat') === 'true' ? 'repeat' : 'scale');
        const href = esc(img.href), look = this.imageStyle(p);
        if (!placed && mode === 'scale') {
            this.defs.push(`<pattern id="${id}" patternUnits="userSpaceOnUse" x="${fmt(bounds.left)}" y="${fmt(bounds.top)}" width="${fmt(bounds.width)}" height="${fmt(bounds.height)}">`
                + `<image href="${href}"${look} width="${fmt(bounds.width)}" height="${fmt(bounds.height)}" preserveAspectRatio="none"/></pattern>`);
            return `url(#${id})`;
        }
        const w = img.width || bounds.width, h = img.height || bounds.height;
        let m;
        if (mEl) m = multiply([1, 0, 0, 1, bounds.left, bounds.top], readMatrix(mEl));
        else {
            const r = num(p, 'rotation', 0) * Math.PI / 180;
            m = [1, 0, 0, 1, num(p, 'x', 0) + bounds.left, num(p, 'y', 0) + bounds.top];
            m = multiply(m, [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]);
            m = multiply(m, [num(p, 'scaleX', 1), 0, 0, num(p, 'scaleY', 1), 0, 0]);
        }
        // Once: a tile far larger than the picture, so it does not come round again
        const tw = mode === 'repeat' ? w : 1e5, th = mode === 'repeat' ? h : 1e5;
        this.defs.push(`<pattern id="${id}" patternUnits="userSpaceOnUse" width="${fmt(tw)}" height="${fmt(th)}" patternTransform="${matrixString(m)}">`
            + `<image href="${href}"${look} width="${fmt(w)}" height="${fmt(h)}" preserveAspectRatio="none"/></pattern>`);
        return `url(#${id})`;
    }

    bitmap(el) {
        this.count('BitmapImage');
        const img = this.image(attr(el, 'source'));
        const matrix = elementMatrix(el);
        if (!img) {
            // Where the picture would be: an outline the size given, if any
            const w = num(el, 'width', 0), h = num(el, 'height', 0);
            if (!w || !h) return '';
            return this.wrap(el, `<rect width="${fmt(w)}" height="${fmt(h)}" fill="#8881" stroke="#888" stroke-dasharray="4 3" vector-effect="non-scaling-stroke"/>`, matrix);
        }
        const nw = img.width, nh = img.height;
        const w = num(el, 'width', nw || 0), h = num(el, 'height', nh || 0);
        const mode = attr(el, 'fillMode') || (attr(el, 'repeat') === 'true' ? 'repeat' : 'scale');
        const href = esc(img.href), look = this.imageStyle(el);
        let content;
        if (mode === 'scale' || !nw || !nh) {
            content = `<image href="${href}"${look} width="${fmt(w)}" height="${fmt(h)}" preserveAspectRatio="none"/>`;
        } else if (mode === 'repeat') {
            const id = this.id('bmp');
            this.defs.push(`<pattern id="${id}" patternUnits="userSpaceOnUse" width="${fmt(nw)}" height="${fmt(nh)}"><image href="${href}"${look} width="${fmt(nw)}" height="${fmt(nh)}"/></pattern>`);
            content = `<rect width="${fmt(w)}" height="${fmt(h)}" fill="url(#${id})"/>`;
        } else { // clip: its own size, cut to the width and height
            content = `<svg width="${fmt(w)}" height="${fmt(h)}" overflow="hidden"><image href="${href}"${look} width="${fmt(nw)}" height="${fmt(nh)}"/></svg>`;
        }
        return this.wrap(el, content, matrix);
    }

    // --- Filters ---

    filter(el) {
        const fw = kid(el, 'filters');
        const list = fw ? kids(fw) : [];
        const ct = colorTransformOf(el);
        if (!list.length && !ct) return null;
        const id = this.id('filter');
        let input = 'SourceGraphic', n = 0;
        const parts = [];
        const out = () => `f${++n}`;
        if (ct) {
            const r = out();
            const mul = c => num(ct, c + 'Multiplier', 1), off = c => num(ct, c + 'Offset', 0) / 255;
            parts.push(`<feColorMatrix in="${input}" values="${fmt(mul('red'))} 0 0 0 ${fmt(off('red'))}  0 ${fmt(mul('green'))} 0 0 ${fmt(off('green'))}  0 0 ${fmt(mul('blue'))} 0 ${fmt(off('blue'))}  0 0 0 ${fmt(mul('alpha'))} ${fmt(off('alpha'))}" result="${r}"/>`);
            input = r;
        }
        for (const f of list) {
            const kind = f.localName;
            this.count(kind);
            if (kind === 'BlurFilter') {
                const r = out();
                parts.push(`<feGaussianBlur in="${input}" stdDeviation="${this.sigma(f, 'blurX')} ${this.sigma(f, 'blurY')}" result="${r}"/>`);
                input = r;
            } else if (kind === 'DropShadowFilter' || kind === 'GlowFilter') {
                const glow = kind === 'GlowFilter';
                input = this.shadow(parts, out, input, {
                    distance: glow ? 0 : num(f, 'distance', 4), angle: num(f, 'angle', 45),
                    color: color(attr(f, 'color'), glow ? '#ff0000' : '#000000'), alpha: num(f, 'alpha', 1),
                    sx: this.sigma(f, 'blurX'), sy: this.sigma(f, 'blurY'), strength: num(f, 'strength', 1),
                    inner: bool(f, 'inner', false), knockout: bool(f, 'knockout', false),
                    hide: !glow && bool(f, 'hideObject', false),
                });
            } else if (kind === 'BevelFilter') {
                // Approximated by a shadow and a highlight on opposite sides, inside the shape
                const common = {
                    distance: num(f, 'distance', 4), sx: this.sigma(f, 'blurX'), sy: this.sigma(f, 'blurY'),
                    strength: num(f, 'strength', 1), inner: (attr(f, 'type') || 'inner') !== 'outer', knockout: bool(f, 'knockout', false),
                };
                const angle = num(f, 'angle', 45);
                input = this.shadow(parts, out, input, { ...common, angle: angle + 180, color: color(attr(f, 'highlightColor'), '#ffffff'), alpha: num(f, 'highlightAlpha', 1) });
                input = this.shadow(parts, out, input, { ...common, angle, color: color(attr(f, 'shadowColor'), '#000000'), alpha: num(f, 'shadowAlpha', 1) });
            } else if (kind === 'ColorMatrixFilter') {
                const v = (attr(f, 'matrix') || '').split(/[\s,]+/).filter(Boolean).map(Number);
                if (v.length !== 20 || v.some(x => !Number.isFinite(x))) continue;
                // Flash's offsets are in 0…255, SVG's in 0…1
                for (const k of [4, 9, 14, 19]) v[k] /= 255;
                const r = out();
                parts.push(`<feColorMatrix in="${input}" values="${v.map(fmt).join(' ')}" result="${r}"/>`);
                input = r;
            } else {
                this.unsupported.add(`<${kind}>`);
            }
        }
        if (!parts.length) return null;
        this.defs.push(`<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">${parts.join('')}</filter>`);
        return id;
    }

    // Flash blurs with `quality` box-blur passes of the given width; a Gaussian of the same spread
    sigma(f, name) {
        const b = Math.max(0, num(f, name, 4)), q = Math.max(1, Math.min(15, num(f, 'quality', 1)));
        return fmt(b * Math.sqrt(q / 12));
    }

    // A drop shadow or glow (inner or outer) of `input`, as filter primitives; returns the result's name
    shadow(parts, out, input, o) {
        const a = o.angle * Math.PI / 180;
        const dx = fmt(Math.cos(a) * o.distance), dy = fmt(Math.sin(a) * o.distance);
        const alpha = out(), color = out(), shaped = out(), result = out();
        if (o.inner) {
            // The outside of the shape, moved and blurred, kept where the shape is
            parts.push(`<feComponentTransfer in="${input}" result="${alpha}"><feFuncA type="table" tableValues="1 0"/></feComponentTransfer>`);
        } else {
            parts.push(`<feComponentTransfer in="${input}" result="${alpha}"><feFuncA type="identity"/></feComponentTransfer>`);
        }
        const moved = out();
        parts.push(`<feOffset in="${alpha}" dx="${dx}" dy="${dy}" result="${moved}"/>`);
        const blurred = out();
        parts.push(`<feGaussianBlur in="${moved}" stdDeviation="${o.sx} ${o.sy}" result="${blurred}"/>`);
        parts.push(`<feFlood flood-color="${o.color}" flood-opacity="${fmt(o.alpha)}" result="${color}"/>`);
        const strong = out();
        parts.push(`<feComponentTransfer in="${blurred}" result="${strong}"><feFuncA type="linear" slope="${fmt(o.strength)}"/></feComponentTransfer>`);
        parts.push(`<feComposite in="${color}" in2="${strong}" operator="in" result="${shaped}"/>`);
        if (o.inner) {
            const inside = out();
            parts.push(`<feComposite in="${shaped}" in2="${input}" operator="in" result="${inside}"/>`);
            if (o.knockout || o.hide) parts.push(`<feMerge result="${result}"><feMergeNode in="${inside}"/></feMerge>`);
            else parts.push(`<feMerge result="${result}"><feMergeNode in="${input}"/><feMergeNode in="${inside}"/></feMerge>`);
        } else if (o.knockout) {
            parts.push(`<feComposite in="${shaped}" in2="${input}" operator="out" result="${result}"/>`);
        } else if (o.hide) {
            parts.push(`<feMerge result="${result}"><feMergeNode in="${shaped}"/></feMerge>`);
        } else {
            parts.push(`<feMerge result="${result}"><feMergeNode in="${shaped}"/><feMergeNode in="${input}"/></feMerge>`);
        }
        return result;
    }

    // --- Text ---

    // RichText (FXG 2.0) and TextGraphic (FXG 1.0): HTML in a foreignObject, so
    // that it wraps to the given width and aligns as FXG lays out text
    text(el) {
        this.count('text');
        const w = num(el, 'width', null), h = num(el, 'height', null);
        const content = kid(el, 'content') || el;
        const box = this.textStyle(el, true);
        let html = '';
        let inline = '';
        const flush = () => { if (inline) { html += `<p xmlns="${XHTML_NS}" style="margin:0">${inline}</p>`; inline = ''; } };
        for (const node of content.childNodes) {
            if (node.nodeType === 1 && !isFxg(node)) continue;
            if (node.nodeType === 1 && (node.localName === 'p' || node.localName === 'div')) { flush(); html += this.flow(node); }
            else inline += this.flow(node);
        }
        flush();
        // Without a width the text does not wrap; with a height it may still overflow, as in Flex
        const fw = w !== null ? fmt(w) : '100000', fh = h !== null ? fmt(h) : '100000';
        const wrapStyle = w !== null ? '' : 'white-space:pre;';
        const body = `<div xmlns="${XHTML_NS}" style="${box}${wrapStyle}${w !== null ? `width:${fmt(w)}px;` : 'width:max-content;'}">${html}</div>`;
        return this.wrap(el, `<foreignObject width="${fw}" height="${fh}" overflow="visible">${body}</foreignObject>`);
    }

    // HTML for a text flow node: p, div, span, a, tcy, br, tab, img, or text
    flow(node) {
        if (node.nodeType === 3 || node.nodeType === 4) return esc(node.nodeValue);
        if (node.nodeType !== 1 || !isFxg(node)) return '';
        const name = node.localName;
        if (name === 'br') return `<br xmlns="${XHTML_NS}"/>`;
        if (name === 'tab') return '\t';
        if (name === 'img') { this.unsupported.add('inline <img> in text'); return ''; }
        const inner = [...node.childNodes].map(c => this.flow(c)).join('');
        const style = this.textStyle(node, false);
        if (name === 'p' || name === 'div') {
            return `<${name === 'p' ? 'p' : 'div'} xmlns="${XHTML_NS}" style="margin:0;${style}">${inner || '<br/>'}</${name === 'p' ? 'p' : 'div'}>`;
        }
        if (name === 'a') {
            const href = attr(node, 'href');
            return `<a xmlns="${XHTML_NS}"${href ? ` href="${esc(href)}" target="_blank"` : ''} style="${style}">${inner}</a>`;
        }
        if (name === 'span' || name === 'tcy') return `<span xmlns="${XHTML_NS}" style="${style}">${inner}</span>`;
        if (name === 'linkNormalFormat' || name === 'linkHoverFormat' || name === 'linkActiveFormat' || name === 'TextLayoutFormat') return '';
        this.unsupported.add(`<${name}> in text`);
        return inner;
    }

    // CSS for FXG's text attributes; `all` adds the defaults the outer element sets
    textStyle(el, all) {
        const css = [];
        const a = n => attr(el, n);
        const family = a('fontFamily');
        if (family || all) css.push(`font-family:${(family || 'Arial').split(',').map(f => `'${f.trim().replace(/'/g, '')}'`).join(',')},sans-serif`);
        const size = num(el, 'fontSize', all ? 12 : null);
        if (size !== null) css.push(`font-size:${fmt(size)}px`);
        if (a('color') || all) {
            const alpha = num(el, 'textAlpha', 1);
            const c = color(a('color'));
            css.push(`color:${alpha < 1 ? `rgba(${parseInt(c.slice(1, 3), 16)},${parseInt(c.slice(3, 5), 16)},${parseInt(c.slice(5, 7), 16)},${fmt(alpha)})` : c}`);
        }
        if (a('fontWeight')) css.push(`font-weight:${a('fontWeight') === 'bold' ? 'bold' : 'normal'}`);
        if (a('fontStyle')) css.push(`font-style:${a('fontStyle') === 'italic' ? 'italic' : 'normal'}`);
        const deco = [];
        if (a('textDecoration') === 'underline') deco.push('underline');
        if (a('lineThrough') === 'true') deco.push('line-through');
        if (deco.length) css.push(`text-decoration:${deco.join(' ')}`);
        const align = a('textAlign');
        if (align) css.push(`text-align:${{ start: 'start', end: 'end', left: 'left', right: 'right', center: 'center', justify: 'justify' }[align] || 'start'}`);
        const lh = a('lineHeight');
        if (lh) css.push(`line-height:${/%$/.test(lh) ? (parseFloat(lh) / 100) : fmt(parseFloat(lh)) + 'px'}`);
        else if (all) css.push('line-height:1.2');
        const tracking = num(el, 'trackingRight', num(el, 'tracking', null));
        if (tracking) css.push(`letter-spacing:${/%$/.test(a('trackingRight') || a('tracking') || '') ? fmt(tracking / 100) + 'em' : fmt(tracking) + 'px'}`);
        if (a('backgroundColor') && a('backgroundColor') !== 'transparent') {
            const bc = color(a('backgroundColor')), ba = num(el, 'backgroundAlpha', 1);
            css.push(`background:rgba(${parseInt(bc.slice(1, 3), 16)},${parseInt(bc.slice(3, 5), 16)},${parseInt(bc.slice(5, 7), 16)},${fmt(ba)})`);
        }
        const before = num(el, 'paragraphSpaceBefore', null), after = num(el, 'paragraphSpaceAfter', null);
        if (before) css.push(`margin-top:${fmt(before)}px`);
        if (after) css.push(`margin-bottom:${fmt(after)}px`);
        const indent = num(el, 'textIndent', null);
        if (indent) css.push(`text-indent:${fmt(indent)}px`);
        const startIndent = num(el, 'paragraphStartIndent', null), endIndent = num(el, 'paragraphEndIndent', null);
        if (startIndent) css.push(`padding-inline-start:${fmt(startIndent)}px`);
        if (endIndent) css.push(`padding-inline-end:${fmt(endIndent)}px`);
        const tc = a('typographicCase');
        if (tc === 'uppercase') css.push('text-transform:uppercase');
        else if (tc === 'lowercase') css.push('text-transform:lowercase');
        else if (tc === 'smallCaps' || tc === 'lowercaseToSmallCaps') css.push('font-variant:small-caps');
        const shift = a('baselineShift');
        if (shift === 'superscript') css.push('vertical-align:super');
        else if (shift === 'subscript') css.push('vertical-align:sub');
        else if (shift && Number.isFinite(parseFloat(shift))) css.push(`vertical-align:${fmt(parseFloat(shift))}px`);
        const ws = a('whiteSpaceCollapse');
        if (ws === 'preserve') css.push('white-space:pre-wrap');
        if (a('direction') === 'rtl') css.push('direction:rtl');
        return css.length ? css.join(';') + ';' : '';
    }
}

// { svg, width, height, version, counts, unsupported, missingImages } for an FXG
// document's text; opts.images maps @Embed sources to { href, width, height }
function fxgToSvg(text, opts = {}) {
    return new Converter(parse(text), opts).run();
}

module.exports = { fxgToSvg, fxgImageSources, embedSource, pathBounds };
