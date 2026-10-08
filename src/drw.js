// --- Micrografx Draw (a .drw that starts 01 FF 02 04 03) to SVG ---
// The vector format of Micrografx Designer and Windows Draw (Micrografx Draw
// 1.x to 3.x, the .drw of countless clip art CDs; the "Drawn File" Wikipedia
// lists). No browser shows it; here it becomes SVG, which any <img> shows. It
// follows Scribus's importer (scribus/plugins/import/drw/importdrw.cpp, Franz
// Schmid's reading of the format, which has no public documentation):
// - records of a length (one byte, or 0xFF and two), a command and data in
//   which 0xFF, count, value runs are expanded (not for commands 96 to 160)
// - a symbol record (7) is an object: polygons, polylines, Bézier and
//   quadratic splines (their points in the polygon record, 6, after them),
//   rectangles (rounded too), ellipses, arcs, parabolic arcs, lines, text,
//   rich text (31, 34), bitmaps (their rows in band records, 32, an 8-bit
//   one's colors in 35), groups and complex objects (one path of its parts,
//   holes and all, filled even-odd); coordinates are units of the resolution
//   record (25), 72/resolution points each
// - fills are solid, a gradient (30; linear or radial) or an 8×8 pattern (28)
// - line styles: solid, dashed, dotted, dash-dot, none
// Where Scribus guesses, so does this: a part whose "scale" is set is fitted
// to its bounding box, as complex objects' parts always are. Unlike Scribus,
// an object's points are taken from its origin (the first coordinate), not
// its bounding box's corner, which holds half the line's width too (a turned
// or scaled one's box is still where it goes), a fitted part's line keeps its
// width (Scribus divides it by the scale), and pie wedges (9; laid out as
// arcs) are drawn. Bitmaps (22) are read as Scribus reads them, unseen in
// any sample here. .drw is also Pro/ENGINEER's,
// Caddie's and PWDraw's: only a file that starts 01 FF 02 04 03 is one.

const { createLogger } = require('./debug');
const { rgbaToPng } = require('./fits');

const log = createLogger('DRW');
const DRW_RE = /\.drw$/i;
const MAGIC = [0x01, 0xff, 0x02, 0x04, 0x03];

// Whether the name is one a Micrografx drawing goes by (it is one only once
// its bytes say so, see isDrw)
function isDrwName(name) {
    return DRW_RE.test(name || '');
}

// Bytes that start a Micrografx drawing: the start-of-file record, then the version record's
function isDrw(bytes) {
    return bytes.length >= MAGIC.length && MAGIC.every((b, i) => bytes[i] === b);
}

// Whether the file at url is a Micrografx drawing (not one of the other .drw formats)
async function isDrwUrl(url) {
    const resp = await fetch(url);
    if (!resp.ok || !resp.body) return false;
    // the first chunk is enough
    const reader = resp.body.getReader();
    const { value } = await reader.read();
    reader.cancel().catch(() => {});
    return !!value && isDrw(value);
}

// --- geometry: paths are arrays of ['M', x, y], ['L', x, y], ['C', x1, y1, x2, y2, x, y], ['Z'] ---

// [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f
const multiply = (m, n) => [ // m after n
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const translation = (x, y) => [1, 0, 0, 1, x, y];
const scaling = (sx, sy) => [sx, 0, 0, sy, 0, 0];
// Qt's QTransform::rotate: clockwise on screen (y down) for positive degrees
const rotation = deg => {
    const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
    return [c, s, -s, c, 0, 0];
};

function mapPath(path, m) {
    return path.map(([op, ...v]) => {
        const out = [op];
        for (let i = 0; i < v.length; i += 2) out.push(m[0] * v[i] + m[2] * v[i + 1] + m[4], m[1] * v[i] + m[3] * v[i + 1] + m[5]);
        return out;
    });
}

// The rectangle of all points, control points too (Qt's controlPointRect)
function pathRect(path) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [, ...v] of path) {
        for (let i = 0; i < v.length; i += 2) {
            x0 = Math.min(x0, v[i]); x1 = Math.max(x1, v[i]);
            y0 = Math.min(y0, v[i + 1]); y1 = Math.max(y1, v[i + 1]);
        }
    }
    return x0 <= x1 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

const unionRect = (a, b) => {
    if (!a) return b;
    if (!b) return a;
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

const mapRect = (r, m) => pathRect(mapPath([['M', r.x, r.y], ['L', r.x + r.w, r.y], ['L', r.x + r.w, r.y + r.h], ['L', r.x, r.y + r.h]], m));

// Where a subpath starts and ends (Qt's elementAt(0) and currentPosition)
function pathEnds(path) {
    if (!path.length) return null;
    let start = null, cur = null, first = null;
    for (const el of path) {
        if (el[0] === 'M') { start = [el[1], el[2]]; cur = start; if (!first) first = start; }
        else if (el[0] === 'Z') cur = start;
        else cur = [el[el.length - 2], el[el.length - 1]];
    }
    return { first, last: cur };
}

const nearly = (a, b) => Math.abs(a[0] - b[0]) < 1 && Math.abs(a[1] - b[1]) < 1;

// Qt's QLineF::angle: counter-clockwise on screen, 0 to 360
function lineAngle(from, to) {
    const a = Math.atan2(-(to[1] - from[1]), to[0] - from[0]) * 180 / Math.PI;
    return a < 0 ? a + 360 : a;
}

// Qt's arcMoveTo and arcTo on an ellipse's rectangle, angles counter-clockwise
// on screen in degrees: Bézier pieces of at most 90 degrees
function arcPath(rect, start, sweep, path = [], move = true) {
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2, rx = rect.w / 2, ry = rect.h / 2;
    const pt = a => [cx + rx * Math.cos(a), cy - ry * Math.sin(a)];
    let a0 = start * Math.PI / 180;
    const p0 = pt(a0);
    path.push([move ? 'M' : 'L', p0[0], p0[1]]);
    const n = Math.max(1, Math.ceil(Math.abs(sweep) / 90 - 1e-9));
    const step = sweep / n * Math.PI / 180;
    const k = 4 / 3 * Math.tan(step / 4);
    for (let i = 0; i < n; i++) {
        const a1 = a0 + step;
        const [x0, y0] = pt(a0), [x3, y3] = pt(a1);
        path.push(['C', x0 - k * rx * Math.sin(a0), y0 - k * ry * Math.cos(a0),
            x3 + k * rx * Math.sin(a1), y3 + k * ry * Math.cos(a1), x3, y3]);
        a0 = a1;
    }
    return path;
}

const ellipsePath = (w, h) => arcPath({ x: 0, y: 0, w, h }, 0, 360).concat([['Z']]);

function rectPath(w, h, r = 0) {
    r = Math.min(Math.abs(r), w / 2, h / 2);
    if (!r) return [['M', 0, 0], ['L', w, 0], ['L', w, h], ['L', 0, h], ['Z']];
    const k = r * (1 - 0.5523);
    return [['M', r, 0], ['L', w - r, 0], ['C', w - k, 0, w, k, w, r], ['L', w, h - r], ['C', w, h - k, w - k, h, w - r, h],
        ['L', r, h], ['C', k, h, 0, h - k, 0, h - r], ['L', 0, r], ['C', 0, k, k, 0, r, 0], ['Z']];
}

// --- items: { kind: 'path', path (absolute), fill, stroke, lineWidth, dash, paint }, { kind: 'text' | 'rich' | 'image', m, ... },
// { kind: 'group', items } ---

function transformItem(item, m) {
    if (item.kind === 'path') {
        item.path = mapPath(item.path, m);
        if (item.paint) item.paint.m = multiply(m, item.paint.m);
    } else if (item.kind === 'group') {
        for (const it of item.items) transformItem(it, m);
    } else {
        item.m = multiply(m, item.m);
    }
}

function itemRect(item) {
    if (item.kind === 'path') return pathRect(item.path);
    if (item.kind === 'group') return item.items.reduce((r, it) => unionRect(r, itemRect(it)), null);
    return mapRect({ x: 0, y: 0, w: item.w, h: item.h }, item.m);
}

// Fits items' rectangle onto r: { x, y, w, h }, each side scaled only if both
// are known (Scribus's scaleGroup and complex objects)
function fitMatrix(from, to) {
    const sx = from.w && to.w ? to.w / from.w : 1, sy = from.h && to.h ? to.h / from.h : 1;
    return multiply(translation(to.x, to.y), multiply(scaling(sx, sy), translation(-from.x, -from.y)));
}

const COLOR_NONE = 'none';
const css = c => `#${[c[0], c[1], c[2]].map(v => v.toString(16).padStart(2, '0')).join('')}`;

function parseDrw(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (!isDrw(bytes)) throw new Error('not a Micrografx drawing');
    const latin = new TextDecoder('windows-1252');

    let scale = 0.15; // points per unit, until the resolution record
    let page = null;
    let background = [255, 255, 255];
    const fonts = new Map(); // id -> { face, family, weight, italic }
    const gradients = new Map(); // index -> { type, xOffset, yOffset, angle }
    const patterns = new Map(); // index -> 16 bytes
    let version = '';

    const root = { items: [] };
    // Groups (2) list their parts by count; complex objects (17, 20) theirs, which become one path
    const groupStack = [{ nrOfItems: -1, counter: -1, items: root.items, x: 0, y: 0 }];
    const listStack = [{ nrOfItems: -1, counter: 0, x: 0, y: 0 }];
    const container = () => {
        // the innermost open group or complex object
        const g = groupStack[groupStack.length - 1], l = listStack[listStack.length - 1];
        return (l.depth || 0) > (g.depth || 0) ? l.items : g.items;
    };
    let depth = 0;

    // what the last symbol left for the records after it
    let pending = null; // { kind: 'points' | 'text' | 'rich' | 'image', ... }

    const finishPath = (sym, path, opts = {}) => {
        if (!path || path.length < 2) return;
        const st = sym.style;
        let m, local = path;
        // a line's end may be left of or above its start, both in its box (Scribus moves it there)
        if (opts.normalize) {
            const r = pathRect(local);
            local = mapPath(local, translation(-r.x, -r.y));
        }
        // rotated about the pivot, then back at the origin (Scribus's finishItem)
        if (sym.rotation) {
            local = mapPath(local, rotation(-sym.rotation / 10));
            const r = pathRect(local);
            local = mapPath(local, translation(-r.x, -r.y));
        }
        if (opts.fit || sym.scaleX || sym.scaleY) {
            // a scaled part's origin is elsewhere: its whole box, as Scribus takes it
            const r = pathRect(local);
            const box = sym.scaleX || sym.scaleY ? sym.box : sym.innerBox;
            const f = fitMatrix(r, { x: 0, y: 0, w: box.w, h: box.h });
            local = mapPath(local, f);
            m = translation(box.x, box.y);
        } else if (sym.rotation) {
            // turned: its corner is its box's (the origin is where it was before turning)
            m = translation(sym.innerBox.x, sym.innerBox.y);
        } else {
            m = translation(sym.origin[0], sym.origin[1]);
        }
        const item = { kind: 'path', path: mapPath(local, m), fill: opts.noFill ? COLOR_NONE : st.fill, stroke: st.stroke, lineWidth: st.lineWidth, dash: st.dash,
            paint: opts.noFill ? null : paintFor(st, sym.innerBox) };
        container().push(item);
        return item;
    };

    // A gradient or pattern fill over the object's box, or none
    const paintFor = (st, box) => {
        const p = st.patternIndex;
        if (st.fill === COLOR_NONE || !st.back) return null;
        if (p > 0x40 && p < 0x80) {
            const g = gradients.get(p - 0x40);
            if (!g) return null;
            // type 1 top to bottom, the back color at the y offset; any other round from the offsets
            // out to (the longer side, the longer side), as Scribus has it (the angle unused)
            const xo = g.xOffset > 1 ? g.xOffset - 1 : g.xOffset, yo = g.yOffset > 1 ? g.yOffset - 1 : g.yOffset;
            const cx = box.w * xo, cy = box.h * yo, M = Math.max(box.w, box.h);
            return g.type === 1
                ? { kind: 'linear', from: st.fillRgb, to: st.back, at: Math.min(yo, 0.99), x: box.w / 2, y0: 0, y1: box.h, m: translation(box.x, box.y) }
                : { kind: 'radial', from: st.fillRgb, to: st.back, cx, cy, r: Math.hypot(M - cx, M - cy) || M, m: translation(box.x, box.y) };
        }
        if ((p > 0x80 && p < 0xc0) || p > 0xc0) {
            const ind = p > 0xc0 ? p - 0xc0 : p - 0x80;
            const data = patterns.get(ind);
            if (!data) return null;
            return p > 0xc0
                ? { kind: 'pattern', w: 16, data, colors: [[255, 255, 255], st.fillRgb], wide: true, m: translation(box.x, box.y) }
                : { kind: 'pattern', w: 8, data, colors: [st.fillRgb, st.back], wide: false, m: translation(box.x, box.y) };
        }
        return null;
    };

    // Closes groups and complex objects whose parts are all read (Scribus's
    // decodeSymbol, before each symbol and at the end)
    const closeFinished = (counting) => {
        let top = groupStack[groupStack.length - 1];
        if (top.nrOfItems !== -1) {
            while (groupStack.length > 1) {
                top = groupStack[groupStack.length - 1];
                if (top.nrOfItems !== top.counter) break;
                listStack.pop();
                groupStack.pop();
                closeComplex(top);
            }
            if (counting) groupStack[groupStack.length - 1].counter++;
        }
        if (listStack.length > 1) {
            while (listStack.length > 1) {
                const l = listStack[listStack.length - 1];
                if (l.nrOfItems !== l.counter) break;
                listStack.pop();
                closeGroup(l);
            }
            if (counting) listStack[listStack.length - 1].counter++;
        }
    };

    // A complex object: its parts' paths joined into one, fitted to its box
    const closeComplex = (c) => {
        const paths = [];
        const collect = items => { for (const it of items) { if (it.kind === 'path') paths.push(it.path); else if (it.kind === 'group') collect(it.items); } };
        collect(c.items);
        let whole = [];
        for (const p of paths) {
            if (!p.length) continue;
            const pa = p.slice();
            const ends = pathEnds(pa);
            let conn = false, conn2 = false;
            if (nearly(ends.last, ends.first)) { pa.push(['Z']); conn = true; }
            if (whole.length) {
                const e2 = pathEnds(whole);
                if (nearly(e2.last, e2.first) && whole[whole.length - 1][0] !== 'Z') { whole.push(['Z']); conn2 = true; }
                else if (whole[whole.length - 1][0] === 'Z') conn2 = true;
            }
            if (!whole.length || conn || conn2) whole = whole.concat(pa);
            else whole = whole.concat([['L', pa[0][1], pa[0][2]]], pa.slice(1));
        }
        if (!whole.length) return;
        if (c.rotation) whole = mapPath(whole, rotation(-c.rotation / 10));
        const r = pathRect(whole);
        whole = mapPath(whole, fitMatrix(r, c.innerBox));
        if (c.filled && whole[whole.length - 1][0] !== 'Z') whole.push(['Z']);
        const st = c.style;
        const item = { kind: 'path', path: whole, fill: c.filled ? st.fillRgbCss : COLOR_NONE, stroke: st.stroke, lineWidth: st.lineWidth, dash: st.dash,
            paint: c.filled ? paintFor({ ...st, fill: st.fillRgbCss }, c.innerBox) : null };
        c.parent.push(item);
    };

    // A group: its parts rotated, moved to its corner and, if it says so, fitted to its box
    const closeGroup = (l) => {
        const g = { kind: 'group', items: l.items };
        if (!g.items.length) return;
        if (l.rotation) transformItem(g, rotation(-l.rotation / 10));
        const r = itemRect(g);
        if (r) {
            const to = (l.scaleX || l.scaleY) ? l.box : { x: l.box.x, y: l.box.y, w: r.w, h: r.h };
            transformItem(g, fitMatrix(r, to));
        }
        l.parent.push(g);
    };

    const records = [];
    let pos = 0;
    while (pos < bytes.length) {
        let len = bytes[pos++];
        if (len === 0xff) { len = bytes[pos] | (bytes[pos + 1] << 8); pos += 2; }
        const cmd = bytes[pos++];
        if (cmd === undefined) break;
        const data = new Uint8Array(len);
        let n = 0;
        const rle = cmd < 96 || cmd > 160;
        while (n < len && pos < bytes.length) {
            const d = bytes[pos++];
            if (rle && d === 0xff) {
                const count = bytes[pos++], val = bytes[pos++];
                for (let i = 0; i < count && n < len; i++) data[n++] = val;
            } else data[n++] = d;
        }
        records.push([cmd, data]);
        if (cmd === 254) break;
    }

    for (const [cmd, data] of records) {
        const view = new DataView(data.buffer);
        let at = 0;
        const has = n => at + n <= data.length;
        const u8 = () => (has(1) ? data[at++] : (at++, 0));
        const u16 = () => { const v = has(2) ? view.getUint16(at, true) : 0; at += 2; return v; };
        const s16 = () => { const v = has(2) ? view.getInt16(at, true) : 0; at += 2; return v; };
        const value = () => s16() * scale;
        const coord = () => [s16() * scale, s16() * scale];
        const color = () => [u8(), u8(), u8(), u8()].slice(0, 3);
        const str = (from, to) => latin.decode(data.subarray(from, to));

        switch (cmd) {
            case 1: background = color(); break;
            case 3: version = Array.from(data, b => b.toString(16).padStart(2, '0')).join(''); break;
            case 6: { // the points of the polygon, polyline or spline before
                if (!pending || pending.kind !== 'points') break;
                const pts = [];
                while (has(4)) pts.push(coord());
                const sym = pending.sym;
                const nPts = Math.min(sym.nPoints, pts.length);
                const path = [];
                if (pending.curve === 'lines') {
                    // a subpath ends where it returns to the very first point
                    let first = true, startP = null;
                    for (let i = 0; i < nPts; i++) {
                        const p = pts[i];
                        if (first) {
                            path.push(['M', p[0], p[1]]);
                            if (!startP) startP = p;
                            first = false;
                        } else if (p[0] === startP[0] && p[1] === startP[1]) {
                            path.push(['Z']);
                            first = true;
                        } else path.push(['L', p[0], p[1]]);
                    }
                } else if (pending.curve === 'bezier') {
                    if (nPts) path.push(['M', pts[0][0], pts[0][1]]);
                    for (let i = 1; i + 2 < nPts; i += 3) path.push(['C', ...pts[i], ...pts[i + 1], ...pts[i + 2]]);
                } else { // quadratic
                    if (nPts) path.push(['M', pts[0][0], pts[0][1]]);
                    for (let i = 1; i + 1 < nPts; i += 2) {
                        const [px, py] = path.length > 1 ? path[path.length - 1].slice(-2) : pts[0];
                        const [qx, qy] = pts[i], [x, y] = pts[i + 1];
                        path.push(['C', px + 2 / 3 * (qx - px), py + 2 / 3 * (qy - py), x + 2 / 3 * (qx - x), y + 2 / 3 * (qy - y), x, y]);
                    }
                }
                finishPath(sym, path, { noFill: !pending.filled });
                pending = null;
                break;
            }
            case 7: {
                closeFinished(true);
                pending = null;
                const g = groupStack[groupStack.length - 1], l = listStack[listStack.length - 1];
                const offX = (groupStack.length > 1 ? g.x : 0) + (listStack.length > 1 ? l.x : 0);
                const offY = (groupStack.length > 1 ? g.y : 0) + (listStack.length > 1 ? l.y : 0);
                const type = u8();
                const flags = u8();
                const origin0 = coord();
                const bx0 = value(), by0 = value(), bx1 = value(), by1 = value();
                const box = { x: Math.min(bx0, bx1) + offX, y: Math.min(by0, by1) + offY, w: Math.abs(bx1 - bx0), h: Math.abs(by1 - by0) };
                const rotationAngle = s16(), scaleX = s16(), scaleY = s16();
                const lineRgb = color();
                at = 34;
                const origin = [origin0[0] + offX, origin0[1] + offY];
                // the box without the line's half width around it, where the origin is that far in
                // (a few objects' origin is their middle)
                const halfLine = (data.length >= 0x3e ? Math.abs(view.getInt16(0x3c, true)) : 0) * scale / 2 + scale;
                const inset = d => (d >= 0 && d <= halfLine ? d : 0);
                const dx = Math.min(inset(origin[0] - box.x), box.w / 2), dy = Math.min(inset(origin[1] - box.y), box.h / 2);
                const innerBox = { x: box.x + dx, y: box.y + dy, w: box.w - 2 * dx, h: box.h - 2 * dy };
                const common = () => {
                    const save = at;
                    at = 0x38;
                    const back = color();
                    u8();
                    const lineWidth = value();
                    u16();
                    at = save;
                    return { back, lineWidth };
                };
                const lineStyle = flags & 0x0f;
                const style = (patternIndex, fillRgb) => {
                    const { back, lineWidth } = common();
                    return {
                        patternIndex, fillRgb, back, lineWidth,
                        fill: patternIndex ? css(fillRgb) : COLOR_NONE,
                        fillRgbCss: css(fillRgb),
                        stroke: lineStyle === 5 ? COLOR_NONE : css(lineRgb),
                        dash: lineStyle === 1 ? [4, 2] : lineStyle === 2 ? [1, 2] : lineStyle === 3 ? [4, 2, 1, 2] : null,
                    };
                };
                const sym = { type, origin, box, innerBox, rotation: rotationAngle, scaleX, scaleY };
                switch (type) {
                    case 0: case 9: case 14: { // elliptical arcs (counter-clockwise, clockwise) and pie wedges
                        const patternIndex = u8(), fill = color();
                        const start = coord(), end = coord();
                        if (start[0] === end[0] && start[1] === end[1]) break;
                        const ox0 = value(), oy0 = value(), ox1 = value(), oy1 = value();
                        const rect = { x: Math.min(ox0, ox1), y: Math.min(oy0, oy1), w: Math.abs(ox1 - ox0), h: Math.abs(oy1 - oy0) };
                        sym.style = style(patternIndex, fill);
                        const center = [rect.x + rect.w / 2, rect.y + rect.h / 2];
                        let rotS = lineAngle(center, start), rotE = lineAngle(center, end), path;
                        if (type === 14) {
                            if (rotS < rotE) rotS += 360;
                            path = arcPath(rect, rotS, -(rotS - rotE));
                        } else {
                            if (rotS > rotE) rotS -= 360;
                            if (type === 9) {
                                path = arcPath(rect, rotS, rotE - rotS, [['M', center[0], center[1]]], false);
                                path.push(['Z']);
                            } else path = arcPath(rect, rotS, rotE - rotS);
                        }
                        // Scribus fits arcs to their box; a pie wedge only fills
                        finishPath(sym, path, { fit: true, noFill: type !== 9 && !patternIndex });
                        break;
                    }
                    case 1: case 8: case 16: case 19: case 23: case 24: { // polygons, polylines, quadratic and Bézier splines
                        const patternIndex = u8(), fill = color();
                        u16();
                        sym.nPoints = u16();
                        sym.style = style(patternIndex, fill);
                        const filled = type === 1 || type === 16 || type === 24 || patternIndex !== 0;
                        pending = { kind: 'points', sym, filled, curve: type === 1 || type === 8 ? 'lines' : type === 23 || type === 24 ? 'bezier' : 'quadratic' };
                        break;
                    }
                    case 2: { // group
                        at = 0x26;
                        const count = u16();
                        if (count > 0) {
                            depth++;
                            const parent = container();
                            listStack.push({ depth, nrOfItems: count, counter: 0, items: [], parent, x: l.x * (listStack.length > 1) + (box.x - offX),
                                y: l.y * (listStack.length > 1) + (box.y - offY), box, scaleX, scaleY, rotation: rotationAngle });
                        }
                        break;
                    }
                    case 3: case 13: case 10: case 11: { // ellipses, rectangles, rounded rectangles
                        const patternIndex = u8(), fill = color();
                        const ox0 = value(), oy0 = value(), ox1 = value(), oy1 = value();
                        const radius = value();
                        sym.style = style(patternIndex, fill);
                        let w = Math.abs(ox1 - ox0), h = Math.abs(oy1 - oy0);
                        // what the box holds if the shape's own size is missing
                        if (!w || !h) { w = innerBox.w; h = innerBox.h; }
                        const path = type === 3 || type === 13 ? ellipsePath(w, h) : rectPath(w, h, type === 11 && radius > 0 ? radius : 0);
                        finishPath(sym, path, { fit: true });
                        break;
                    }
                    case 5: { // a line of text, in the text record (8) after it
                        u16();
                        const fontId = u8();
                        const chars = u16();
                        const size = u16();
                        pending = { kind: 'text', sym, fontId, chars, size, color: css(lineRgb) };
                        break;
                    }
                    case 6: { // line, as wide as its "pattern"
                        const end = coord(), start = coord();
                        if (start[0] === end[0] && start[1] === end[1]) break;
                        const width = u8();
                        sym.style = style(0, [0, 0, 0]);
                        sym.style.lineWidth = width * scale;
                        finishPath(sym, [['M', start[0], start[1]], ['L', end[0], end[1]]], { normalize: true });
                        break;
                    }
                    case 15: case 18: { // parabolic arcs, filled and not
                        const patternIndex = u8(), fill = color();
                        const start = coord(), mid = coord(), end = coord();
                        if (start[0] === end[0] && start[1] === end[1]) break;
                        sym.style = style(patternIndex, fill);
                        const path = [['M', start[0], start[1]], ['C', mid[0], mid[1], mid[0], mid[1], end[0], end[1]]];
                        if (type === 15) path.push(['Z']);
                        finishPath(sym, path, { fit: true, noFill: type === 18 && !patternIndex });
                        break;
                    }
                    case 17: case 20: { // complex objects, filled and not
                        const patternIndex = u8(), fill = color();
                        at = 0x2b;
                        const nItems = u16();
                        depth++;
                        const parent = container();
                        groupStack.push({ depth, nrOfItems: nItems, counter: 0, items: [], parent, x: box.x - (listStack.length > 1 ? l.x : 0), y: box.y - (listStack.length > 1 ? l.y : 0),
                            box, innerBox, rotation: rotationAngle, filled: type === 17, style: style(patternIndex, fill) });
                        // Scribus's list entry that never closes, so that offsets nest
                        listStack.push({ nrOfItems: 0xffff, counter: 0, x: listStack.length > 1 ? l.x : 0, y: listStack.length > 1 ? l.y : 0, items: [] });
                        break;
                    }
                    case 22: { // bitmap, its rows in band records (32)
                        u16();
                        value(); value(); value(); value();
                        const bpp = u16();
                        u16(); u16();
                        const height = u16(), width = u16();
                        u16();
                        const trans = [u8(), u8(), u8()];
                        if ((bpp === 24 || bpp === 8) && width && height) {
                            const item = { kind: 'image', width, height, rgba: new Uint8ClampedArray(width * height * 4), indexed: bpp === 8 ? new Uint8Array(width * height) : null,
                                bpp, rows: 0, trans, w: innerBox.w, h: innerBox.h, m: translation(innerBox.x, innerBox.y) };
                            container().push(item);
                            pending = { kind: 'image', item };
                        }
                        break;
                    }
                    case 25: { // rich text: a header (31) and paragraphs (34) after it
                        const item = { kind: 'rich', w: box.w, h: box.h, m: translation(box.x, box.y), color: css(lineRgb), paragraphs: [] };
                        container().push(item);
                        pending = { kind: 'rich', item };
                        break;
                    }
                    default: break;
                }
                break;
            }
            case 8: { // the text of the text symbol before
                if (!pending || pending.kind !== 'text') break;
                const { sym, fontId, chars, size, color: textColor } = pending;
                const lines = str(0, Math.min(chars, data.length)).split('\r').map(s => s.replace(/\n/g, '').trim());
                const item = { kind: 'text', lines, font: fonts.get(fontId) || null, size: size * 0.8 * scale, color: textColor, w: sym.box.w, h: sym.box.h,
                    m: translation(sym.box.x, sym.box.y) };
                if (sym.rotation) {
                    const cx = sym.box.w / 2, cy = sym.box.h / 2;
                    item.m = multiply(item.m, multiply(translation(cx, cy), multiply(rotation(-sym.rotation / 10), translation(-cx, -cy))));
                }
                container().push(item);
                pending = null;
                break;
            }
            case 21: { // font: much of a Windows LOGFONT
                const id = data[0];
                const weight = data.length > 10 ? view.getInt16(9, true) : 400;
                const italic = !!data[11];
                const family = data[18] >> 4;
                let end = 19;
                while (end < data.length && data[end]) end++;
                const face = str(19, end).trim().replace(/'/g, ' ');
                fonts.set(id, { face, family, weight, italic });
                break;
            }
            case 25: {
                const res = view.getUint16(0, true);
                if (res) scale = 72 / res;
                break;
            }
            case 27: page = { w: view.getInt16(0, true) * scale, h: view.getInt16(2, true) * scale }; break;
            case 28: patterns.set(data[0], data.slice(1, 17)); break;
            case 30: gradients.set(data[0], { type: data[1], xOffset: data[2] / 100, yOffset: data[3] / 100, angle: view.getUint16(4, true) / 10 }); break;
            case 31: { // rich text header
                if (!pending || pending.kind !== 'rich') break;
                at = 0;
                u8();
                pending.item.valign = u8();
                u16(); u16();
                const fontId = u8();
                pending.item.style = u8();
                u16();
                const size = u16();
                const n = u16();
                pending.item.font = fonts.get(fontId) || null;
                pending.item.size = size * scale * 0.8;
                pending.paragraphs = [];
                for (let i = 0; i < n && has(31); i++) {
                    u16(); u16(); u16();
                    const align = u8();
                    at += 18;
                    const plen = u16() - 17;
                    at += 4;
                    pending.paragraphs.push({ align, length: plen });
                }
                pending.next = 0;
                break;
            }
            case 34: { // rich text paragraph
                if (!pending || pending.kind !== 'rich' || !pending.paragraphs) break;
                const para = pending.paragraphs[pending.next++];
                if (!para || para.length <= 0) break;
                const text = str(0x11, Math.min(data.length, 0x11 + para.length)).replace(/\0.*$/s, '');
                pending.item.paragraphs.push({ align: para.align, text });
                break;
            }
            case 32: { // bitmap rows
                if (!pending || pending.kind !== 'image') break;
                const img = pending.item;
                at = 0;
                u16();
                const yoff = u16(), stride = u16(), count = u16();
                for (let y = 0; y < count && img.rows < img.height; y++) {
                    const row = yoff + y, base = 8 + y * stride;
                    if (base >= data.length) break;
                    if (row < img.height) {
                        for (let x = 0; x < img.width; x++) {
                            const o = (row * img.width + x) * 4;
                            if (img.bpp === 24) {
                                const s = base + x * 3;
                                img.rgba[o] = data[s]; img.rgba[o + 1] = data[s + 1]; img.rgba[o + 2] = data[s + 2]; img.rgba[o + 3] = 255;
                            } else {
                                const v = data[base + x];
                                img.indexed[row * img.width + x] = v;
                                img.rgba[o] = img.rgba[o + 1] = img.rgba[o + 2] = v; img.rgba[o + 3] = 255;
                            }
                        }
                    }
                    img.rows++;
                }
                if (img.rows >= img.height && img.bpp === 24) pending = null;
                break;
            }
            case 35: { // an 8-bit bitmap's colors (red, green, blue, unused), its transparent color the background's
                if (!pending || pending.kind !== 'image' || pending.item.bpp !== 8) break;
                const img = pending.item;
                for (let i = 0; i < img.width * img.height; i++) {
                    const c = img.indexed[i] * 4, o = i * 4;
                    if (c + 2 >= data.length) continue;
                    const r = data[c], g = data[c + 1], b = data[c + 2];
                    img.rgba[o] = r; img.rgba[o + 1] = g; img.rgba[o + 2] = b;
                    img.rgba[o + 3] = r === img.trans[0] && g === img.trans[1] && b === img.trans[2] ? 0 : 255;
                }
                pending = null;
                break;
            }
            case 254:
                // the last parts close what is open
                for (let i = 0; i < 64 && (groupStack.length > 1 || listStack.length > 1); i++) {
                    const before = groupStack.length + listStack.length;
                    closeFinished(false);
                    if (groupStack.length + listStack.length === before) break;
                }
                break;
            default: break;
        }
    }
    // whatever never got all its parts
    while (groupStack.length > 1 || listStack.length > 1) {
        const g = groupStack[groupStack.length - 1], l = listStack[listStack.length - 1];
        if (groupStack.length > 1 && (g.depth || 0) >= (l.depth || 0)) { groupStack.pop(); listStack.pop(); closeComplex(g); }
        else { listStack.pop(); if (l.parent) closeGroup(l); }
    }
    return { page, background, version, scale, items: root.items };
}

const fmt = v => (Math.abs(v) < 1e-9 ? '0' : String(+v.toFixed(3)));
const pathData = path => path.map(([op, ...v]) => op + v.map(fmt).join(' ')).join('');
const matrix = m => `matrix(${m.map(fmt).join(' ')})`;
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const GENERIC = ['sans-serif', 'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy'];
function fontCss(font) {
    if (!font) return 'font-family:Arial,Helvetica,sans-serif';
    const generic = GENERIC[font.family] || 'sans-serif';
    return `font-family:'${font.face.replace(/[\\']/g, '')}',${generic};font-weight:${font.weight >= 600 ? 'bold' : 'normal'}${font.italic ? ';font-style:italic' : ''}`;
}

// The drawing as SVG; imageHref(item) gives a bitmap's data: URL (the
// browser's PNG, see drwImage)
function drawingToSvg(drawing, imageHref = () => null) {
    const defs = [];
    const body = [];
    let ids = 0;
    const paintRef = (paint) => {
        const id = `p${ids++}`;
        if (paint.kind === 'linear') {
            defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${fmt(paint.x)}" y1="${fmt(paint.y0)}" x2="${fmt(paint.x)}" y2="${fmt(paint.y1)}" gradientTransform="${matrix(paint.m)}">`
                + `<stop offset="0" stop-color="${css(paint.from)}"/><stop offset="${fmt(paint.at)}" stop-color="${css(paint.to)}"/><stop offset="1" stop-color="${css(paint.from)}"/></linearGradient>`);
        } else if (paint.kind === 'radial') {
            defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${fmt(paint.cx)}" cy="${fmt(paint.cy)}" r="${fmt(paint.r)}" gradientTransform="${matrix(paint.m)}">`
                + `<stop offset="0" stop-color="${css(paint.from)}"/><stop offset="1" stop-color="${css(paint.to)}"/></radialGradient>`);
        } else {
            // 1 bits the second color; the tile 8 points a side, as Scribus scales it
            const rects = [];
            for (let y = 0; y < 8; y++) {
                for (let x = 0; x < paint.w; x++) {
                    const byte = paint.wide ? paint.data[y * 2 + (x >> 3)] : paint.data[y * 2];
                    if (byte & (0x80 >> (x & 7))) rects.push(`M${x} ${y}h1v1h-1z`);
                }
            }
            defs.push(`<pattern id="${id}" patternUnits="userSpaceOnUse" width="${paint.w}" height="8" patternTransform="${matrix(paint.m)}">`
                + `<rect width="${paint.w}" height="8" fill="${css(paint.colors[0])}"/><path d="${rects.join('')}" fill="${css(paint.colors[1])}"/></pattern>`);
        }
        return `url(#${id})`;
    };
    const emit = (item, out) => {
        if (item.kind === 'group') {
            const inner = [];
            for (const it of item.items) emit(it, inner);
            if (inner.length) out.push(`<g>${inner.join('')}</g>`);
        } else if (item.kind === 'path') {
            if (!item.path.length) return;
            const fill = item.fill === COLOR_NONE ? 'none' : item.paint ? paintRef(item.paint) : item.fill;
            const w = item.lineWidth;
            let stroke = '';
            if (item.stroke !== COLOR_NONE) {
                // a width of 0 is Windows's one pixel
                stroke = w > 0 ? ` stroke="${item.stroke}" stroke-width="${fmt(w)}"` : ` stroke="${item.stroke}" stroke-width="1" vector-effect="non-scaling-stroke"`;
                if (item.dash) stroke += ` stroke-dasharray="${item.dash.map(d => fmt(d * Math.max(w, 1))).join(' ')}"`;
            }
            out.push(`<path d="${pathData(item.path)}" fill="${fill}" fill-rule="evenodd"${stroke}/>`);
        } else if (item.kind === 'text') {
            const lines = item.lines.filter((s, i, a) => s || i < a.length - 1);
            if (!lines.some(s => s)) return;
            // the box the lines fill, line by line; one line stretched to the box's width
            const lh = lines.length ? item.h / lines.length : item.h;
            const size = Math.min(item.size || lh * 0.8, lh) || lh * 0.8;
            const tspans = lines.map((s, i) => `<tspan x="0" y="${fmt(i * lh + lh * 0.78)}"${lines.length === 1 && s.length > 1 ? ` textLength="${fmt(item.w)}" lengthAdjust="spacingAndGlyphs"` : ''}>${esc(s)}</tspan>`);
            out.push(`<text transform="${matrix(item.m)}" style="${fontCss(item.font)};font-size:${fmt(size)}px" fill="${item.color}" xml:space="preserve">${tspans.join('')}</text>`);
        } else if (item.kind === 'rich') {
            if (!item.paragraphs.length) return;
            const align = ['left', 'center', 'right', 'justify'];
            const paras = item.paragraphs.map(p => `<p style="margin:0;text-align:${align[p.align] || 'left'}">${esc(p.text) || '&#160;'}</p>`).join('');
            const valign = ['flex-start', 'center', 'flex-end'][item.valign] || 'flex-start';
            out.push(`<foreignObject transform="${matrix(item.m)}" width="${fmt(item.w)}" height="${fmt(item.h)}"><div xmlns="http://www.w3.org/1999/xhtml" `
                + `style="${fontCss(item.font)};font-size:${fmt(item.size || 10)}px;line-height:1.15;color:${item.color};width:100%;height:100%;display:flex;flex-direction:column;justify-content:${valign};overflow:visible">`
                + `<div>${paras}</div></div></foreignObject>`);
        } else if (item.kind === 'image') {
            const href = imageHref(item);
            if (!href) return;
            out.push(`<image transform="${matrix(item.m)}" width="${fmt(item.w)}" height="${fmt(item.h)}" preserveAspectRatio="none" href="${href}"/>`);
        }
    };
    for (const it of drawing.items) emit(it, body);
    // the page, and whatever lies off it
    let view = drawing.page && drawing.page.w > 0 && drawing.page.h > 0 ? { x: 0, y: 0, w: drawing.page.w, h: drawing.page.h } : null;
    for (const it of drawing.items) view = unionRect(view, itemRect(it));
    if (!view) view = { x: 0, y: 0, w: 100, h: 100 };
    const W = Math.max(1, Math.ceil(view.w)), H = Math.max(1, Math.ceil(view.h));
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="${fmt(view.x)} ${fmt(view.y)} ${fmt(view.w)} ${fmt(view.h)}">`
        + `<rect x="${fmt(view.x)}" y="${fmt(view.y)}" width="${fmt(view.w)}" height="${fmt(view.h)}" fill="${css(drawing.background)}"/>`
        + (defs.length ? `<defs>${defs.join('')}</defs>` : '') + body.join('') + '</svg>';
}

const drawn = new Map(); // source URL -> Promise<{ url, width, height, label }>

const blobDataUrl = blob => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
});

// The drawing at url as SVG: { url (a blob: URL), width, height (points), label }
function drwImage(url) {
    let p = drawn.get(url);
    if (!p) {
        p = (async () => {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const drawing = parseDrw(new Uint8Array(await resp.arrayBuffer()));
            // bitmaps as PNGs inside the SVG (an <img> loads nothing else)
            const hrefs = new Map();
            const images = [];
            const collect = items => { for (const it of items) { if (it.kind === 'group') collect(it.items); else if (it.kind === 'image') images.push(it); } };
            collect(drawing.items);
            for (const it of images) hrefs.set(it, await blobDataUrl(await rgbaToPng(it.rgba, it.width, it.height)));
            const svg = drawingToSvg(drawing, it => hrefs.get(it));
            const [, width, height] = svg.match(/width="(\d+)" height="(\d+)"/);
            let count = 0;
            const countItems = items => { for (const it of items) { if (it.kind === 'group') countItems(it.items); else count++; } };
            countItems(drawing.items);
            const label = `Micrografx Draw drawing, ${count} object${count === 1 ? '' : 's'}`
                + (drawing.page ? `, page ${Math.round(drawing.page.w)}×${Math.round(drawing.page.h)} pt` : '');
            return { url: URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })), width: +width, height: +height, label };
        })();
        drawn.set(url, p);
        p.catch(err => { drawn.delete(url); log.warn('Micrografx Draw decode failed:', err); });
        // as many as a folder's thumbnails (an evicted one's blob: URL is revoked)
        if (drawn.size > 64) {
            const [oldKey, old] = drawn.entries().next().value;
            drawn.delete(oldKey);
            old.then(d => URL.revokeObjectURL(d.url)).catch(() => {});
        }
    }
    return p;
}

module.exports = { isDrwName, isDrw, isDrwUrl, parseDrw, drawingToSvg, drwImage };
