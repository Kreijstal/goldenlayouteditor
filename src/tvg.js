// --- TinyVG (.tvg) to SVG ---
// TinyVG (tinyvg.tech) is a binary vector format: a color table, then drawing
// commands (fill/outline polygons, rectangles and paths, lines). Browsers don't
// know it, so it is converted to SVG, which any <img> shows. Follows the 1.0
// specification and the reference SDK's renderer (github.com/TinyVG/sdk,
// src/lib/parsing.zig and rendering.zig):
// - fills use the even-odd rule, over all segments of a path at once
// - lines have round caps; a line width of 0 is still one display pixel wide
// - path nodes can change the line width, which then varies along the node
// - gradients interpolate in linear light (gamma 2.2)

const COMMANDS = [
    'end_of_document', 'fill_polygon', 'fill_rectangles', 'fill_path',
    'draw_lines', 'draw_line_loop', 'draw_line_strip', 'draw_line_path',
    'outline_fill_polygon', 'outline_fill_rectangles', 'outline_fill_path', 'text_hint',
];
const RANGES = ['default', 'reduced', 'enhanced'];
const ENCODINGS = ['RGBA 8888', 'RGB 565', 'RGBA f32', 'custom'];
const GAMMA = 2.2;
// Pieces a curve of a changing-width line is cut into: about one per 3 units
// of its length, within these bounds
const MIN_STEPS = 16;
const MAX_STEPS = 2048;
const stepsFor = length => Math.min(MAX_STEPS, Math.max(MIN_STEPS, Math.ceil(length / 3)));

function isTvg(bytes) {
    return bytes.length >= 3 && bytes[0] === 0x72 && bytes[1] === 0x56;
}

function parseTvg(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pos = 0;
    const need = n => { if (pos + n > bytes.length) throw new Error('TinyVG: unexpected end of file'); };
    const u8 = () => { need(1); return bytes[pos++]; };
    const u16 = () => { need(2); pos += 2; return view.getUint16(pos - 2, true); };
    const u32 = () => { need(4); pos += 4; return view.getUint32(pos - 4, true); };
    const f32 = () => { need(4); pos += 4; return view.getFloat32(pos - 4, true); };
    const varUInt = () => {
        let v = 0;
        for (let i = 0; ; i++) {
            const b = u8();
            if (i === 4 && (b & 0xf0)) throw new Error('TinyVG: VarUInt out of range');
            v += (b & 0x7f) * 2 ** (7 * i);
            if (!(b & 0x80)) return v;
        }
    };

    if (!isTvg(bytes)) throw new Error('not a TinyVG file');
    pos = 2;
    const version = u8();
    if (version !== 1) throw new Error(`TinyVG version ${version} is not supported`);
    const flags = u8();
    const scale = flags & 0x0f;
    const encoding = (flags >> 4) & 3;
    const range = (flags >> 6) & 3;
    if (range === 3) throw new Error('TinyVG: invalid coordinate range');
    if (encoding === 3) throw new Error('TinyVG: custom color encoding is not supported');
    // Sizes are unsigned; 0 stands for the largest value plus one
    const size = () => {
        const v = range === 1 ? u8() : range === 0 ? u16() : u32();
        return v || (range === 1 ? 256 : range === 0 ? 65536 : 2 ** 32);
    };
    const width = size(), height = size();
    const div = 2 ** scale;
    const unit = range === 1 ? () => { need(1); return view.getInt8(pos++) / div; }
        : range === 0 ? () => { need(2); pos += 2; return view.getInt16(pos - 2, true) / div; }
            : () => { need(4); pos += 4; return view.getInt32(pos - 4, true) / div; };
    const point = () => { const x = unit(); return { x, y: unit() }; };

    const colors = [];
    const colorCount = varUInt();
    for (let i = 0; i < colorCount; i++) {
        if (encoding === 0) colors.push({ r: u8() / 255, g: u8() / 255, b: u8() / 255, a: u8() / 255 });
        else if (encoding === 1) {
            const v = u16();
            colors.push({ r: (v & 0x1f) / 31, g: ((v >> 5) & 0x3f) / 63, b: (v >> 11) / 31, a: 1 });
        } else colors.push({ r: f32(), g: f32(), b: f32(), a: f32() });
    }

    const style = kind => {
        if (kind === 0) return { kind: 'flat', color: varUInt() };
        if (kind === 3) throw new Error('TinyVG: invalid style kind');
        const p0 = point(), p1 = point();
        return { kind: kind === 1 ? 'linear' : 'radial', p0, p1, c0: varUInt(), c1: varUInt() };
    };
    const rect = () => ({ x: unit(), y: unit(), w: unit(), h: unit() });
    const path = count => {
        const lengths = [];
        for (let i = 0; i < count; i++) lengths.push(varUInt() + 1);
        return lengths.map(len => {
            const start = point();
            const nodes = [];
            for (let i = 0; i < len; i++) {
                const tag = u8();
                const node = { type: tag & 7, lineWidth: tag & 0x10 ? unit() : null };
                switch (node.type) {
                    case 0: node.p = point(); break;                                  // line
                    case 1: node.x = unit(); break;                                   // horizontal
                    case 2: node.y = unit(); break;                                   // vertical
                    case 3: node.c0 = point(); node.c1 = point(); node.p = point(); break; // cubic bezier
                    case 4: {                                                         // circle arc
                        const f = u8();
                        node.large = !!(f & 1); node.sweep = !!(f & 2);
                        node.rx = node.ry = unit(); node.rotation = 0; node.p = point();
                        break;
                    }
                    case 5: {                                                         // ellipse arc
                        const f = u8();
                        node.large = !!(f & 1); node.sweep = !!(f & 2);
                        node.rx = unit(); node.ry = unit(); node.rotation = unit(); node.p = point();
                        break;
                    }
                    case 6: break;                                                    // close
                    case 7: node.c = point(); node.p = point(); break;                // quadratic bezier
                }
                nodes.push(node);
            }
            return { start, nodes };
        });
    };
    const repeat = (n, f) => Array.from({ length: n }, f);

    const commands = [];
    for (;;) {
        const b = u8();
        const index = b & 0x3f;
        const kind = b >> 6;
        const name = COMMANDS[index];
        if (!name) throw new Error(`TinyVG: unknown command ${index} at byte ${pos - 1}`);
        if (index === 0) break;
        const cmd = { type: name };
        if (index >= 1 && index <= 3) {                 // fills
            const n = varUInt() + 1;
            cmd.fill = style(kind);
            if (index === 1) cmd.points = repeat(n, point);
            else if (index === 2) cmd.rects = repeat(n, rect);
            else cmd.path = path(n);
        } else if (index >= 4 && index <= 7) {          // lines
            const n = varUInt() + 1;
            cmd.line = style(kind);
            cmd.lineWidth = unit();
            if (index === 4) cmd.lines = repeat(n, () => [point(), point()]);
            else if (index === 7) cmd.path = path(n);
            else cmd.points = repeat(n, point);
        } else if (index >= 8 && index <= 10) {         // outline fills: count and line style kind in one byte
            const h = u8();
            const n = (h & 0x3f) + 1;
            cmd.fill = style(kind);
            cmd.line = style(h >> 6);
            cmd.lineWidth = unit();
            if (index === 8) cmd.points = repeat(n, point);
            else if (index === 9) cmd.rects = repeat(n, rect);
            else cmd.path = path(n);
        } else {                                        // text hint: metadata only
            cmd.center = point();
            cmd.rotation = unit();
            cmd.height = unit();
            const len = varUInt();
            need(len);
            cmd.text = new TextDecoder().decode(bytes.subarray(pos, pos + len));
            pos += len;
            cmd.glyphs = repeat(varUInt(), () => [unit(), unit()]);
        }
        commands.push(cmd);
    }
    return {
        version, scale, width, height, colors, commands,
        colorEncoding: ENCODINGS[encoding], coordinateRange: RANGES[range], size: bytes.length,
    };
}

// --- SVG ---

const num = v => String(Math.round(v * 1e4) / 1e4);
const xml = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clamp01 = v => Math.min(1, Math.max(0, v));
const hex = c => '#' + [c.r, c.g, c.b].map(v => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')).join('');

// Endpoint arc to its center form (SVG implementation notes, F.6.5), radii
// grown uniformly when they can't reach. TinyVG's sweep 1 turns left, which
// in y-down coordinates is SVG's sweep 0.
function arcCenter(p0, n) {
    const phi = n.rotation * Math.PI / 180;
    const cos = Math.cos(phi), sin = Math.sin(phi);
    const dx = (p0.x - n.p.x) / 2, dy = (p0.y - n.p.y) / 2;
    const x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;
    let rx = Math.abs(n.rx), ry = Math.abs(n.ry);
    if (!rx || !ry) return null;
    const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if (lambda > 1) { rx *= Math.sqrt(lambda); ry *= Math.sqrt(lambda); }
    const svgSweep = !n.sweep;
    const sq = Math.max(0, (rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1) / (rx * rx * y1 * y1 + ry * ry * x1 * x1));
    const k = (n.large === svgSweep ? -1 : 1) * Math.sqrt(sq);
    const cx1 = k * rx * y1 / ry, cy1 = -k * ry * x1 / rx;
    const cx = cos * cx1 - sin * cy1 + (p0.x + n.p.x) / 2;
    const cy = sin * cx1 + cos * cy1 + (p0.y + n.p.y) / 2;
    const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const t0 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
    let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
    if (!svgSweep && dt > 0) dt -= 2 * Math.PI;
    if (svgSweep && dt < 0) dt += 2 * Math.PI;
    return { cx, cy, rx, ry, cos, sin, t0, dt };
}

// A segment as SVG path data
function segmentData(seg) {
    let d = `M${num(seg.start.x)},${num(seg.start.y)}`;
    for (const n of seg.nodes) {
        switch (n.type) {
            case 0: d += `L${num(n.p.x)},${num(n.p.y)}`; break;
            case 1: d += `H${num(n.x)}`; break;
            case 2: d += `V${num(n.y)}`; break;
            case 3: d += `C${num(n.c0.x)},${num(n.c0.y)},${num(n.c1.x)},${num(n.c1.y)},${num(n.p.x)},${num(n.p.y)}`; break;
            case 4: case 5:
                d += `A${num(Math.abs(n.rx))},${num(Math.abs(n.ry))},${num(n.rotation)},${n.large ? 1 : 0},${n.sweep ? 0 : 1},${num(n.p.x)},${num(n.p.y)}`;
                break;
            case 6: d += 'Z'; break;
            case 7: d += `Q${num(n.c.x)},${num(n.c.y)},${num(n.p.x)},${num(n.p.y)}`; break;
        }
    }
    return d;
}

// A segment as points with a line width at each (as the reference renderer
// sees it: a node's width applies at its end, growing linearly along it)
function flatten(seg, width) {
    const pts = [{ x: seg.start.x, y: seg.start.y, w: width }];
    let last = width;
    for (const n of seg.nodes) {
        const prev = pts[pts.length - 1];
        const w = n.lineWidth === null ? last : n.lineWidth;
        const at = f => last + (w - last) * f;
        switch (n.type) {
            case 0: pts.push({ ...n.p, w }); break;
            case 1: pts.push({ x: n.x, y: prev.y, w }); break;
            case 2: pts.push({ x: prev.x, y: n.y, w }); break;
            case 3: case 7: {
                const c = n.type === 3 ? [prev, n.c0, n.c1, n.p] : [prev, n.c, n.p];
                const steps = stepsFor(c.slice(1).reduce((len, p, i) => len + Math.hypot(p.x - c[i].x, p.y - c[i].y), 0));
                for (let i = 1; i <= steps; i++) {
                    const f = i / steps;
                    let q = c;
                    while (q.length > 1) q = q.slice(1).map((p, j) => ({ x: q[j].x + (p.x - q[j].x) * f, y: q[j].y + (p.y - q[j].y) * f }));
                    pts.push({ ...q[0], w: at(f) });
                }
                break;
            }
            case 4: case 5: {
                const a = arcCenter(prev, n);
                if (!a) { pts.push({ ...n.p, w }); break; }
                const steps = stepsFor(Math.abs(a.dt) * Math.max(a.rx, a.ry));
                for (let i = 1; i < steps; i++) {
                    const t = a.t0 + a.dt * i / steps;
                    const ex = a.rx * Math.cos(t), ey = a.ry * Math.sin(t);
                    pts.push({ x: a.cos * ex - a.sin * ey + a.cx, y: a.sin * ex + a.cos * ey + a.cy, w: at(i / steps) });
                }
                pts.push({ ...n.p, w });
                break;
            }
            case 6: pts.push({ ...seg.start, w }); break;
        }
        last = w;
    }
    return pts;
}

// Path data for a line of changing width: round-capped pieces between
// consecutive points (the convex hull of two circles), all wound the same way
// so the nonzero rule unites them
function taperedData(pts) {
    const circle = (p, r) => `M${num(p.x + r)},${num(p.y)}A${num(r)},${num(r)},0,1,1,${num(p.x - r)},${num(p.y)}A${num(r)},${num(r)},0,1,1,${num(p.x + r)},${num(p.y)}Z`;
    let d = '';
    pts.forEach((p, i) => {
        const r = Math.max(p.w, 0) / 2;
        if (r > 0) d += circle(p, r);
        if (i === 0) return;
        const q = pts[i - 1], rq = Math.max(q.w, 0) / 2;
        if (!r && !rq) return;
        const dx = p.x - q.x, dy = p.y - q.y, len = Math.hypot(dx, dy);
        if (len <= Math.abs(r - rq)) return;
        const ux = dx / len, uy = dy / len, s = (rq - r) / len, c = Math.sqrt(1 - s * s);
        const m1 = { x: -uy * c + ux * s, y: ux * c + uy * s }, m2 = { x: uy * c + ux * s, y: -ux * c + uy * s };
        let quad = [
            { x: q.x + rq * m1.x, y: q.y + rq * m1.y }, { x: p.x + r * m1.x, y: p.y + r * m1.y },
            { x: p.x + r * m2.x, y: p.y + r * m2.y }, { x: q.x + rq * m2.x, y: q.y + rq * m2.y },
        ];
        const area = quad.reduce((a, v, j) => { const w = quad[(j + 1) % 4]; return a + v.x * w.y - w.x * v.y; }, 0);
        if (area < 0) quad = quad.reverse();
        d += 'M' + quad.map(v => `${num(v.x)},${num(v.y)}`).join('L') + 'Z';
    });
    return d;
}

function tvgToSvg(input) {
    const doc = input.commands ? input : parseTvg(input);
    const { colors } = doc;
    const defs = [];
    const body = [];
    const color = i => {
        const c = colors[i];
        if (!c) throw new Error(`TinyVG: color index ${i} out of range`);
        return c;
    };
    // fill="…" / stroke="…" attributes for a style, adding gradients to defs
    const paint = (s, prop) => {
        if (s.kind === 'flat') {
            const c = color(s.color);
            return `${prop}="${hex(c)}"` + (c.a < 1 ? ` ${prop}-opacity="${num(clamp01(c.a))}"` : '');
        }
        const a = color(s.c0), b = color(s.c1);
        const id = `g${defs.length}`;
        // Stops along the way, as the interpolation is in linear light
        const stops = [];
        for (let i = 0; i <= 16; i++) {
            const f = i / 16;
            const ch = k => Math.pow(clamp01(a[k]) ** GAMMA * (1 - f) + clamp01(b[k]) ** GAMMA * f, 1 / GAMMA);
            const alpha = clamp01(a.a + (b.a - a.a) * f);
            stops.push(`<stop offset="${num(f)}" stop-color="${hex({ r: ch('r'), g: ch('g'), b: ch('b') })}"${alpha < 1 ? ` stop-opacity="${num(alpha)}"` : ''}/>`);
        }
        defs.push(s.kind === 'linear'
            ? `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${num(s.p0.x)}" y1="${num(s.p0.y)}" x2="${num(s.p1.x)}" y2="${num(s.p1.y)}">${stops.join('')}</linearGradient>`
            : `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${num(s.p0.x)}" cy="${num(s.p0.y)}" r="${num(Math.hypot(s.p1.x - s.p0.x, s.p1.y - s.p0.y))}">${stops.join('')}</radialGradient>`);
        return `${prop}="url(#${id})"`;
    };
    const fillAttrs = s => `${paint(s, 'fill')} fill-rule="evenodd"`;
    // Round caps and joins; width 0 is one display pixel whatever the scale
    const strokeAttrs = (s, w) => `fill="none" ${paint(s, 'stroke')} stroke-linecap="round" stroke-linejoin="round" `
        + (w > 0 ? `stroke-width="${num(w)}"` : 'stroke-width="1" vector-effect="non-scaling-stroke"');
    const polyData = (pts, close) => 'M' + pts.map(p => `${num(p.x)},${num(p.y)}`).join('L') + (close ? 'Z' : '');
    const rectData = r => `M${num(r.x)},${num(r.y)}h${num(r.w)}v${num(r.h)}h${num(-r.w)}Z`;
    const strokePath = (segs, s, width) => {
        const varying = segs.some(seg => seg.nodes.some(n => n.lineWidth !== null && n.lineWidth !== width));
        if (!varying) return `<path d="${segs.map(segmentData).join('')}" ${strokeAttrs(s, width)}/>`;
        const lines = segs.map(seg => flatten(seg, width));
        const d = lines.map(taperedData).join('');
        // Under a line that gets thinner than a unit, a hairline, so no part
        // of it is less than a display pixel wide
        const thin = lines.some(pts => pts.some(pt => pt.w < 1));
        return (thin ? `<path d="${segs.map(segmentData).join('')}" ${strokeAttrs(s, 0)}/>` : '')
            + (d ? `<path d="${d}" ${paint(s, 'fill')}/>` : '');
    };

    for (const c of doc.commands) {
        switch (c.type) {
            case 'fill_polygon': body.push(`<path d="${polyData(c.points, true)}" ${fillAttrs(c.fill)}/>`); break;
            case 'fill_rectangles': body.push(`<path d="${c.rects.map(rectData).join('')}" ${paint(c.fill, 'fill')}/>`); break;
            case 'fill_path': body.push(`<path d="${c.path.map(segmentData).join('')}" ${fillAttrs(c.fill)}/>`); break;
            case 'draw_lines': body.push(`<path d="${c.lines.map(l => polyData(l, false)).join('')}" ${strokeAttrs(c.line, c.lineWidth)}/>`); break;
            case 'draw_line_loop': body.push(`<path d="${polyData(c.points, true)}" ${strokeAttrs(c.line, c.lineWidth)}/>`); break;
            case 'draw_line_strip': body.push(`<path d="${polyData(c.points, false)}" ${strokeAttrs(c.line, c.lineWidth)}/>`); break;
            case 'draw_line_path': body.push(strokePath(c.path, c.line, c.lineWidth)); break;
            case 'outline_fill_polygon':
                body.push(`<path d="${polyData(c.points, true)}" ${fillAttrs(c.fill)}/>`);
                body.push(`<path d="${polyData(c.points, true)}" ${strokeAttrs(c.line, c.lineWidth)}/>`);
                break;
            case 'outline_fill_rectangles':
                body.push(`<path d="${c.rects.map(rectData).join('')}" ${paint(c.fill, 'fill')}/>`);
                body.push(`<path d="${c.rects.map(rectData).join('')}" ${strokeAttrs(c.line, c.lineWidth)}/>`);
                break;
            case 'outline_fill_path':
                body.push(`<path d="${c.path.map(segmentData).join('')}" ${fillAttrs(c.fill)}/>`);
                body.push(strokePath(c.path, c.line, c.lineWidth));
                break;
            case 'text_hint': {
                // Invisible: it only says where text is, for selection and screen readers
                const rot = c.rotation ? ` transform="rotate(${num(c.rotation)} ${num(c.center.x)} ${num(c.center.y)})"` : '';
                body.push(`<text x="${num(c.center.x)}" y="${num(c.center.y)}" font-size="${num(c.height)}" text-anchor="middle" fill-opacity="0"${rot}>${xml(c.text)}</text>`);
                break;
            }
        }
    }
    const { width, height } = doc;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
        + (defs.length ? `<defs>${defs.join('')}</defs>` : '') + body.join('') + '</svg>';
}

module.exports = { isTvg, parseTvg, tvgToSvg, arcCenter, hex, GAMMA };
