// --- TinyVG at any zoom ---
// Renders a part of a TinyVG picture (src/tvg.js) as SVG, at any scale.
// Browsers draw SVG in single precision, and even double precision runs out
// around 10^13× zoom, so here all geometry is exact integer arithmetic
// (BigInt) in screen coordinates with 16 fraction bits:
// - every coordinate in the file is a dyadic rational, and so is every double
//   (arcs become cubic Béziers, computed once in doubles), so moving to the
//   view (center stored exactly, scale 2^z) loses nothing
// - curves are cut in halves (exact: de Casteljau at 1/2) until flat on screen
//   or clear of it
// - lines are outlined here, not stroked by the browser: round caps and joins
//   as circles (points of a rational parametrization, exact) and the pieces
//   between them (one square root, in integers)
// - everything is clipped to a box just around the view
// So the SVG only holds screen-sized numbers, and a picture has no limit to
// how far it can be zoomed into. Rendering follows src/tvg.js: even-odd fills,
// round caps, lines at least a pixel wide, gradients in linear light.
const { arcCenter, hex, GAMMA } = require('./tvg');

const G = 16;                     // fraction bits of screen coordinates
const ONE = 1n << BigInt(G);      // a pixel
const TOL = ONE / 10n;            // flatness, 0.1 px
const MARGIN = 2n * ONE;          // clip box margin around the view
const MAX_DEPTH = 6000;

const big = BigInt;
const shl = (v, k) => (k >= 0 ? v << big(k) : v >> big(-k));
const abs = v => (v < 0n ? -v : v);
const bitLength = v => (v === 0n ? 0 : abs(v).toString(16).length * 4);

// x = m · 2^e exactly
const f64 = new DataView(new ArrayBuffer(8));
function dyadic(x) {
    if (x === 0 || !Number.isFinite(x)) return { m: 0n, e: 0 };
    f64.setFloat64(0, x);
    const hi = f64.getUint32(0), lo = f64.getUint32(4);
    const exp = (hi >>> 20) & 0x7ff;
    let m = (big(hi & 0xfffff) << 32n) | big(lo);
    let e;
    if (exp) { m |= 1n << 52n; e = exp - 1075; } else e = -1074;
    while (m && !(m & 1n)) { m >>= 1n; e++; }
    return { m: hi >>> 31 ? -m : m, e };
}

function isqrt(n) {
    if (n < 2n) return n < 0n ? 0n : n;
    let x = 1n << big((bitLength(n) >> 1) + 1);
    for (;;) {
        const y = (x + n / x) >> 1n;
        if (y >= x) return x;
        x = y;
    }
}

// a / b as a double, for BigInts of any size
function ratio(a, b) {
    const k = Math.max(bitLength(a), bitLength(b)) - 1000;
    return k > 0 ? Number(a >> big(k)) / Number(b >> big(k)) : Number(a) / Number(b);
}

const px = v => {
    const n = Number(v) / 65536;
    return String(Math.round(n * 1000) / 1000);
};

// --- The picture in document space ---
// Items: { fill, rings } and { line, lines }; a ring or line is
// { start: [x, y], segs: [{ ctrl: [[x, y], …] (the last is the end), w0, w1 }] }
// (1 point: straight, 2: quadratic, 3: cubic; w0/w1 the line width at its ends)

function prepare(doc) {
    const items = [];
    const P = p => [p.x, p.y];
    const poly = (points, close, w) => {
        const pts = close ? [...points, points[0]] : points;
        return { start: P(pts[0]), segs: pts.slice(1).map(p => ({ ctrl: [P(p)], w0: w, w1: w })) };
    };
    const rect = (r, w) => poly([{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }], true, w);
    const path = (seg, width) => {
        const out = { start: P(seg.start), segs: [] };
        let prev = seg.start, last = width;
        for (const n of seg.nodes) {
            const w = n.lineWidth === null ? last : n.lineWidth;
            const add = (ctrl, w0, w1) => out.segs.push({ ctrl, w0, w1 });
            switch (n.type) {
                case 0: add([P(n.p)], last, w); prev = n.p; break;
                case 1: prev = { x: n.x, y: prev.y }; add([P(prev)], last, w); break;
                case 2: prev = { x: prev.x, y: n.y }; add([P(prev)], last, w); break;
                case 3: add([P(n.c0), P(n.c1), P(n.p)], last, w); prev = n.p; break;
                case 7: add([P(n.c), P(n.p)], last, w); prev = n.p; break;
                case 4: case 5: {
                    const a = arcCenter(prev, n);
                    if (!a) { add([P(n.p)], last, w); prev = n.p; break; }
                    // Cubic Béziers of at most 45° each
                    const pieces = Math.max(1, Math.ceil(Math.abs(a.dt) / (Math.PI / 4)));
                    const d = a.dt / pieces;
                    const k = (4 / 3) * Math.tan(d / 4);
                    const at = t => {
                        const ex = a.rx * Math.cos(t), ey = a.ry * Math.sin(t);
                        const dx = -a.rx * Math.sin(t), dy = a.ry * Math.cos(t);
                        return {
                            p: [a.cos * ex - a.sin * ey + a.cx, a.sin * ex + a.cos * ey + a.cy],
                            v: [a.cos * dx - a.sin * dy, a.sin * dx + a.cos * dy],
                        };
                    };
                    for (let i = 0; i < pieces; i++) {
                        const s = at(a.t0 + d * i), e = at(a.t0 + d * (i + 1));
                        const end = i === pieces - 1 ? P(n.p) : e.p;
                        add([[s.p[0] + k * s.v[0], s.p[1] + k * s.v[1]], [e.p[0] - k * e.v[0], e.p[1] - k * e.v[1]], end],
                            last + (w - last) * i / pieces, last + (w - last) * (i + 1) / pieces);
                    }
                    prev = n.p;
                    break;
                }
                case 6: add([P(seg.start)], last, w); prev = seg.start; break;
            }
            last = w;
        }
        return out;
    };

    // The picture's area, under everything (shown as a checkerboard)
    items.push({ canvas: true, rings: [rect({ x: 0, y: 0, w: doc.width, h: doc.height }, 0)] });
    for (const c of doc.commands) {
        const w = c.lineWidth;
        switch (c.type) {
            case 'fill_polygon': items.push({ fill: c.fill, rings: [poly(c.points, true)] }); break;
            case 'fill_rectangles': items.push({ fill: c.fill, rings: c.rects.map(r => rect(r)) }); break;
            case 'fill_path': items.push({ fill: c.fill, rings: c.path.map(s => path(s, 0)) }); break;
            case 'draw_lines': items.push({ line: c.line, lines: c.lines.map(l => poly(l, false, w)) }); break;
            case 'draw_line_loop': items.push({ line: c.line, lines: [poly(c.points, true, w)] }); break;
            case 'draw_line_strip': items.push({ line: c.line, lines: [poly(c.points, false, w)] }); break;
            case 'draw_line_path': items.push({ line: c.line, lines: c.path.map(s => path(s, w)) }); break;
            case 'outline_fill_polygon':
                items.push({ fill: c.fill, rings: [poly(c.points, true)] }, { line: c.line, lines: [poly(c.points, true, w)] });
                break;
            case 'outline_fill_rectangles':
                items.push({ fill: c.fill, rings: c.rects.map(r => rect(r)) }, { line: c.line, lines: c.rects.map(r => rect(r, w)) });
                break;
            case 'outline_fill_path':
                items.push({ fill: c.fill, rings: c.path.map(s => path(s, 0)) }, { line: c.line, lines: c.path.map(s => path(s, w)) });
                break;
            case 'text_hint': items.push({ text: c }); break;
        }
    }

    // Fraction bits needed to hold every coordinate exactly
    let frac = 0;
    const note = v => { const { e } = dyadic(v); if (-e > frac) frac = -e; };
    const notePoint = p => { note(p[0]); note(p[1]); };
    for (const it of items) {
        for (const r of [...(it.rings || []), ...(it.lines || [])]) {
            notePoint(r.start);
            for (const s of r.segs) { s.ctrl.forEach(notePoint); note(s.w0 || 0); note(s.w1 || 0); }
        }
        for (const st of [it.fill, it.line]) if (st && st.kind !== 'flat') { notePoint(P(st.p0)); notePoint(P(st.p1)); }
        if (it.text) { notePoint(P(it.text.center)); note(it.text.height); }
    }
    return { doc, items, frac };
}

// --- Geometry in screen space (BigInt, 1 px = 2^16) ---

// Sutherland–Hodgman: a closed polygon clipped to the box
function clipPolygon(pts, box) {
    const edges = [
        [p => p[0] >= box.x0, (a, b) => cutX(a, b, box.x0)],
        [p => p[0] <= box.x1, (a, b) => cutX(a, b, box.x1)],
        [p => p[1] >= box.y0, (a, b) => cutY(a, b, box.y0)],
        [p => p[1] <= box.y1, (a, b) => cutY(a, b, box.y1)],
    ];
    let out = pts;
    for (const [inside, cut] of edges) {
        const input = out;
        out = [];
        for (let i = 0; i < input.length; i++) {
            const a = input[(i + input.length - 1) % input.length], b = input[i];
            const ia = inside(a), ib = inside(b);
            if (ib) { if (!ia) out.push(cut(a, b)); out.push(b); } else if (ia) out.push(cut(a, b));
        }
        if (!out.length) break;
    }
    return out;
}
const cutX = (a, b, x) => [x, a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0])];
const cutY = (a, b, y) => [a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]), y];

const outside = (pts, box, pad) => {
    let x0 = pts[0][0], x1 = x0, y0 = pts[0][1], y1 = y0;
    for (const p of pts) {
        if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
    }
    return x1 + pad < box.x0 || x0 - pad > box.x1 || y1 + pad < box.y0 || y0 - pad > box.y1;
};

// Whether the inner control points are within TOL of the chord
function flat(c) {
    const a = c[0], b = c[c.length - 1];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    for (let i = 1; i < c.length - 1; i++) {
        const px_ = c[i][0] - a[0], py_ = c[i][1] - a[1];
        if (len2 === 0n) { if (px_ * px_ + py_ * py_ > TOL * TOL) return false; continue; }
        const cross = px_ * dy - py_ * dx;
        if (cross * cross > TOL * TOL * len2) return false;
    }
    return true;
}

// A curve's points (with widths) near the box: halves until flat or clear
// of the box (then its chord, which stays inside its control polygon)
function flattenCurve(c, w0, w1, box, pad, out, depth = 0) {
    const r = w0 > w1 ? w0 : w1;
    if (c.length === 2 || depth > MAX_DEPTH || outside(c, box, pad(r)) || flat(c)) {
        out.push([c[c.length - 1], w1]);
        return;
    }
    const left = [c[0]], right = [c[c.length - 1]];
    let q = c;
    while (q.length > 1) {
        q = q.slice(1).map((p, i) => [(q[i][0] + p[0]) >> 1n, (q[i][1] + p[1]) >> 1n]);
        left.push(q[0]);
        right.unshift(q[q.length - 1]);
    }
    const wm = (w0 + w1) >> 1n;
    flattenCurve(left, w0, wm, box, pad, out, depth + 1);
    flattenCurve(right, wm, w1, box, pad, out, depth + 1);
}

// A circle near the box as a polygon (positively wound): points
// c + r·((1 − t²)/(1 + t²), 2t/(1 + t²)) for dyadic t, exact
function circlePolygon(c, r, box) {
    const corners = [[box.x0, box.y0], [box.x1, box.y0], [box.x1, box.y1], [box.x0, box.y1]];
    const r2 = r * r;
    if (corners.every(p => (p[0] - c[0]) ** 2n + (p[1] - c[1]) ** 2n <= r2)) return corners;
    if (outside([c], box, r)) return null;
    // Two half circles: angles −90°…90° and (rotated by 180°) the rest
    const pts = [];
    for (const sign of [1n, -1n]) {
        // t = a / 2^k
        const point = (a, k) => {
            const q = 1n << big(2 * k), a2 = a * a, den = q + a2;
            return [c[0] + sign * r * (q - a2) / den, c[1] + sign * r * 2n * a * (1n << big(k)) / den];
        };
        const walk = (a0, a1, k, p0, p1, depth) => {
            const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
            const len2 = dx * dx + dy * dy;
            // An arc of at most 90° lies within its chord's box grown by a quarter of the chord
            const reach = isqrt(len2) / 4n + 1n;
            if (depth > MAX_DEPTH || outside([p0, p1], box, reach) || len2 <= 8n * r * TOL) { pts.push(p1); return; }
            const m = point(a0 + a1, k + 1);
            walk(2n * a0, a0 + a1, k + 1, p0, m, depth + 1);
            walk(a0 + a1, 2n * a1, k + 1, m, p1, depth + 1);
        };
        const pm = point(-1n, 0), p0 = point(0n, 0), p1 = point(1n, 0);
        pts.push(pm);
        walk(-1n, 0n, 0, pm, p0, 0);
        walk(0n, 1n, 0, p0, p1, 0);
    }
    return pts;
}

// The region between two circles on a line piece: the quadrilateral between
// their outer tangents (positively wound), or null when one circle holds the other
function tangentQuad(a, ra, b, rb) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const dr = ra - rb;
    if (len2 <= dr * dr) return null;
    // Unit tangent normals m = (n·Q + d·dr) / len², n = (−dy, dx), Q = √(len² − dr²),
    // Q with K extra bits so that r·m is exact to a unit
    const rmax = ra > rb ? ra : rb;
    const K = Math.max(0, bitLength(rmax) - (bitLength(len2) >> 1) + 8);
    const Q = isqrt((len2 - dr * dr) << big(2 * K));
    const D = len2 << big(K);
    const drK = dr << big(K);
    const off = (r, sq) => [r * (-dy * sq + dx * drK) / D, r * (dx * sq + dy * drK) / D];
    const o1a = off(ra, Q), o1b = off(rb, Q), o2a = off(ra, -Q), o2b = off(rb, -Q);
    let quad = [
        [a[0] + o1a[0], a[1] + o1a[1]], [b[0] + o1b[0], b[1] + o1b[1]],
        [b[0] + o2b[0], b[1] + o2b[1]], [a[0] + o2a[0], a[1] + o2a[1]],
    ];
    let area = 0n;
    for (let i = 0; i < 4; i++) { const p = quad[i], q = quad[(i + 1) % 4]; area += p[0] * q[1] - q[0] * p[1]; }
    if (area < 0n) quad = quad.reverse();
    return quad;
}

// --- Rendering ---

// view: { z (log2 of pixels per unit), cx, cy ({ m, f }: m / 2^f), width, height }
function renderView(prepared, view) {
    const { doc, items } = prepared;
    const e = Math.floor(view.z);
    const sm = big(Math.round(2 ** (view.z - e) * 2 ** 52));
    const se = e - 52;
    const CF = Math.max(prepared.frac, view.cx.f, view.cy.f);
    const cx = shl(view.cx.m, CF - view.cx.f), cy = shl(view.cy.m, CF - view.cy.f);
    const hw = big(Math.round(view.width / 2 * 65536)), hh = big(Math.round(view.height / 2 * 65536));
    const coord = (v, c, h) => { const d = dyadic(v); return shl((shl(d.m, d.e + CF) - c) * sm, se + G - CF) + h; };
    const T = p => [coord(p[0], cx, hw), coord(p[1], cy, hh)];
    const len = v => { const d = dyadic(v); return shl(d.m * sm, d.e + se + G); };
    // Line radius: half the width, at least half a pixel
    const radius = w => { const l = len(w || 0); return (l > ONE ? l : ONE) >> 1n; };
    const box = { x0: -MARGIN, y0: -MARGIN, x1: 2n * hw + MARGIN, y1: 2n * hh + MARGIN };

    const defs = [], body = [];
    const colors = doc.colors;
    const colorAt = (s, t) => {
        const a = colors[s.c0], b = colors[s.c1];
        if (!a || !b) throw new Error('TinyVG: color index out of range');
        t = Math.min(1, Math.max(0, t));
        const ch = k => Math.pow(Math.max(0, a[k]) ** GAMMA * (1 - t) + Math.max(0, b[k]) ** GAMMA * t, 1 / GAMMA);
        return { r: ch('r'), g: ch('g'), b: ch('b'), a: Math.min(1, Math.max(0, a.a + (b.a - a.a) * t)) };
    };
    const solid = c => `fill="${hex(c)}"` + (c.a < 1 ? ` fill-opacity="${Math.round(c.a * 1e4) / 1e4}"` : '');
    // Stops for t running from t0 to t1 along the gradient: where it changes,
    // between t = 0 and 1 (beyond, the end colors carry on)
    const stops = (s, t0, t1) => {
        const a = Math.max(0, t0), b = Math.min(1, t1);
        let out = '';
        for (let i = 0; i <= 16; i++) {
            const t = a + (b - a) * i / 16;
            const c = colorAt(s, t);
            out += `<stop offset="${(t - t0) / (t1 - t0)}" stop-color="${hex(c)}"${c.a < 1 ? ` stop-opacity="${Math.round(c.a * 1e4) / 1e4}"` : ''}/>`;
        }
        return out;
    };
    const center = [hw, hh];
    const linear = (s, t0, t1, from, to) => {
        const id = `g${defs.length}`;
        defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${px(from[0])}" y1="${px(from[1])}" x2="${px(to[0])}" y2="${px(to[1])}">${stops(s, t0, t1)}</linearGradient>`);
        return `fill="url(#${id})"`;
    };
    // fill="…" for a style, as seen in the view: gradients re-expressed over
    // the box, in screen-sized numbers
    const paint = s => {
        if (s.kind === 'flat') {
            const c = colors[s.color];
            if (!c) throw new Error(`TinyVG: color index ${s.color} out of range`);
            return solid(c);
        }
        const p0 = T([s.p0.x, s.p0.y]), p1 = T([s.p1.x, s.p1.y]);
        if (s.kind === 'linear') {
            const d = [p1[0] - p0[0], p1[1] - p0[1]];
            const dd = d[0] * d[0] + d[1] * d[1];
            if (dd === 0n) return solid(colorAt(s, 1));
            const tc = ratio((center[0] - p0[0]) * d[0] + (center[1] - p0[1]) * d[1], dd);
            // Half the box's extent along the gradient, in t and in pixels
            const reach = abs(hw + MARGIN) * abs(d[0]) + abs(hh + MARGIN) * abs(d[1]);
            const dt = ratio(reach, dd);
            if (tc + dt <= 0 || tc - dt >= 1 || dt < 1e-5) return solid(colorAt(s, tc));
            const dl = isqrt(dd);
            const h = reach / dl; // pixels (fixed point) from the center to the box's ends along d
            const u = [ratio(d[0] * h, dl), ratio(d[1] * h, dl)].map(v => big(Math.round(v)));
            return linear(s, tc - dt, tc + dt, [center[0] - u[0], center[1] - u[1]], [center[0] + u[0], center[1] + u[1]]);
        }
        // Radial: t is the distance from p0 over the radius
        const dx0 = p1[0] - p0[0], dy0 = p1[1] - p0[1];
        const R = isqrt(dx0 * dx0 + dy0 * dy0);
        if (R === 0n) return solid(colorAt(s, 1));
        const nearX = p0[0] < box.x0 ? box.x0 : p0[0] > box.x1 ? box.x1 : p0[0];
        const nearY = p0[1] < box.y0 ? box.y0 : p0[1] > box.y1 ? box.y1 : p0[1];
        const dmin = isqrt((nearX - p0[0]) ** 2n + (nearY - p0[1]) ** 2n);
        const farX = abs(box.x0 - p0[0]) > abs(box.x1 - p0[0]) ? box.x0 : box.x1;
        const farY = abs(box.y0 - p0[1]) > abs(box.y1 - p0[1]) ? box.y0 : box.y1;
        const dmax = isqrt((farX - p0[0]) ** 2n + (farY - p0[1]) ** 2n);
        const tmin = ratio(dmin, R), tmax = ratio(dmax, R);
        if (tmin >= 1 || tmax - tmin < 1e-5) return solid(colorAt(s, tmin));
        const toC = [p0[0] - center[0], p0[1] - center[1]];
        const dc = isqrt(toC[0] * toC[0] + toC[1] * toC[1]);
        if (dc < 10000000n * ONE) {
            // Center near: a radial gradient out to the farthest corner
            const id = `g${defs.length}`;
            defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${px(p0[0])}" cy="${px(p0[1])}" r="${px(dmax)}">${stops(s, 0, tmax)}</radialGradient>`);
            return `fill="url(#${id})"`;
        }
        // Center far away: over the box, its circles are straight to well
        // under a pixel, so a linear gradient away from the center
        const h = abs(hw + MARGIN) + abs(hh + MARGIN);
        const u = [-ratio(toC[0] * h, dc), -ratio(toC[1] * h, dc)].map(v => big(Math.round(v)));
        const tc = ratio(dc, R), dt = ratio(h, R);
        return linear(s, tc - dt, tc + dt, [center[0] - u[0], center[1] - u[1]], [center[0] + u[0], center[1] + u[1]]);
    };

    const ringData = pts => {
        const clipped = clipPolygon(pts, box);
        return clipped.length < 3 ? '' : 'M' + clipped.map(p => px(p[0]) + ',' + px(p[1])).join('L') + 'Z';
    };
    const flatten = (r, withWidth, pad) => {
        const out = [[T(r.start), withWidth ? radius(r.segs.length ? r.segs[0].w0 : 0) : 0n]];
        for (const s of r.segs) {
            const prev = out[out.length - 1][0];
            flattenCurve([prev, ...s.ctrl.map(T)], out[out.length - 1][1], withWidth ? radius(s.w1) : 0n, box, pad, out);
        }
        return out;
    };

    for (const it of items) {
        if (it.text) {
            const c = T([it.text.center.x, it.text.center.y]);
            const h = len(it.text.height);
            if (c[0] < box.x0 || c[0] > box.x1 || c[1] < box.y0 || c[1] > box.y1 || h > 100000n * ONE) continue;
            const rot = it.text.rotation ? ` transform="rotate(${it.text.rotation} ${px(c[0])} ${px(c[1])})"` : '';
            const text = it.text.text.replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
            body.push(`<text x="${px(c[0])}" y="${px(c[1])}" font-size="${px(h)}" text-anchor="middle" fill-opacity="0"${rot}>${text}</text>`);
            continue;
        }
        if (it.rings) {
            const d = it.rings.map(r => ringData(flatten(r, false, () => 0n).map(p => p[0]))).join('');
            if (d) body.push(`<path d="${d}" fill-rule="evenodd" ${it.canvas ? 'fill="url(#checker)"' : paint(it.fill)}/>`);
            continue;
        }
        // Lines: circles at the points, the pieces between them, all wound
        // alike so the nonzero rule unites them
        let d = '';
        for (const r of it.lines) {
            const pts = flatten(r, true, rad => rad);
            pts.forEach(([p, rad], i) => {
                const circle = circlePolygon(p, rad, box);
                if (circle) d += ringData(circle);
                if (i === 0) return;
                const [q, rq] = pts[i - 1];
                if (outside([p, q], box, rad > rq ? rad : rq)) return;
                const quad = tangentQuad(q, rq, p, rad);
                if (quad) d += ringData(quad);
            });
        }
        if (d) body.push(`<path d="${d}" ${paint(it.line)}/>`);
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${view.width}" height="${view.height}" viewBox="0 0 ${view.width} ${view.height}">`
        + `<defs><pattern id="checker" width="16" height="16" patternUnits="userSpaceOnUse"><rect width="16" height="16" fill="#3a3f46"/><path d="M0 0h8v8H0zM8 8h8v8H8z" fill="#2a2e34"/></pattern>${defs.join('')}</defs>`
        + body.join('') + '</svg>';
}

// --- The view ---

// A view of the whole picture, fitting width × height
function fitView(doc, width, height) {
    const scale = Math.min(width / doc.width, height / doc.height) * 0.95;
    return { z: Math.log2(scale), cx: fromDouble(doc.width / 2), cy: fromDouble(doc.height / 2), width, height };
}

const fromDouble = v => { const d = dyadic(v); return d.e >= 0 ? { m: d.m << big(d.e), f: 0 } : { m: d.m, f: -d.e }; };

// The view moved by (dx, dy) pixels: the picture follows the pointer
function panView(view, dx, dy) {
    const e = Math.floor(view.z);
    const sm = Math.round(2 ** (view.z - e) * 2 ** 52), se = e - 52;
    // Keep as many fraction bits as a pixel at this scale needs (a pixel is
    // 2^−z units), and 64 more
    const keep = Math.max(0, e + G + 64);
    const move = (c, dpx) => {
        if (!dpx) return c;
        const q = dyadic(dpx / sm);
        const qe = q.e - se;
        const f = Math.max(c.f, -qe);
        let m = shl(c.m, f - c.f) - shl(q.m, qe + f);
        return f > keep ? { m: m >> big(f - keep), f: keep } : { m, f };
    };
    return { ...view, cx: move(view.cx, dx), cy: move(view.cy, dy) };
}

// The view zoomed by 2^dz around the point (x, y) of it
function zoomView(view, dz, x, y) {
    const ox = x - view.width / 2, oy = y - view.height / 2;
    const v = panView(view, -ox, -oy);
    return panView({ ...v, z: v.z + dz }, ox, oy);
}

// The document point at (x, y) of the view, as doubles
function viewPoint(view, x, y) {
    const toNum = c => { const k = Math.max(0, bitLength(c.m) - 60); return Number(c.m >> big(k)) * 2 ** (k - c.f); };
    const s = 2 ** view.z;
    return { x: toNum(view.cx) + (x - view.width / 2) / s, y: toNum(view.cy) + (y - view.height / 2) / s };
}

module.exports = { prepare, renderView, fitView, panView, zoomView, viewPoint, dyadic, isqrt };
