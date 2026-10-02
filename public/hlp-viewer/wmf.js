// A small Windows Metafile (WMF) player for the metafiles WinHelp files embed
// ({bmc x.wmf}): pens, brushes, fonts, lines, polygons, rectangles, ellipses,
// arcs, text and DIBs, drawn on a canvas. Regions, clipping, raster ops other
// than plain copies and RLE-compressed DIBs are not drawn. Unknown records are
// skipped and counted.
import { bitmapToRgba } from './hlp-parse.js';

const rd16 = (b, o) => b[o] | (b[o + 1] << 8);
const rds16 = (b, o) => { const v = rd16(b, o); return v & 0x8000 ? v - 0x10000 : v; };
const rd32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const colorRef = (b, o) => `rgb(${b[o]},${b[o + 1]},${b[o + 2]})`;

function decodeDib(b, at, end) {
    if (at + 40 > end) return null;
    const hdr = rd32(b, at);
    if (hdr < 40) return null;
    const w = rd32(b, at + 4) | 0, h = rd32(b, at + 8) | 0, bpp = rd16(b, at + 14), comp = rd32(b, at + 16);
    if (comp !== 0 || w <= 0 || !h || w * Math.abs(h) > 16e6 || ![1, 4, 8, 16, 24, 32].includes(bpp)) return null;
    const used = rd32(b, at + 32);
    const nc = bpp <= 8 ? (used || 1 << bpp) : 0;
    const pal = [];
    let p = at + hdr;
    for (let i = 0; i < nc; i++, p += 4) pal.push([b[p + 2], b[p + 1], b[p]]);
    const height = Math.abs(h);
    let rgba = bitmapToRgba(b.subarray(p, end), w, height, bpp, pal, false, false);
    if (h < 0) {
        // top-down: flip the rows back
        const flipped = new Uint8ClampedArray(rgba.length), row = w * 4;
        for (let y = 0; y < height; y++) flipped.set(rgba.subarray((height - 1 - y) * row, (height - y) * row), y * row);
        rgba = flipped;
    }
    return { w, h: height, rgba };
}

// Draws the metafile bytes on a new canvas of width × height CSS pixels
export function renderWmf(data, width, height) {
    const canvas = document.createElement('canvas');
    const ratio = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    const ctx = canvas.getContext('2d');
    const stats = { records: 0, skipped: 0 };
    let p = 0;
    // A placeable header (0x9AC6CDD7) may precede the standard one
    if (rd32(data, 0) === 0x9AC6CDD7) p = 22;
    if (p + 18 > data.length) throw new Error('metafile too short');
    const headerWords = rd16(data, p + 2);
    p += headerWords * 2;

    const W = canvas.width, H = canvas.height;
    let st = {
        wox: 0, woy: 0, wex: 0, wey: 0, x: 0, y: 0,
        pen: { style: 0, width: 1, color: 'rgb(0,0,0)' }, brush: { style: 0, color: 'rgb(255,255,255)' },
        font: { height: 12, weight: 400, italic: false, underline: false, face: 'Arial', escapement: 0 },
        textColor: 'rgb(0,0,0)', bkColor: 'rgb(255,255,255)', bkMode: 2, textAlign: 0, fill: 'evenodd',
    };
    const stack = [];
    const objects = [];
    // Without a window extent, the picture's extent is guessed from the first coordinates seen
    const sx = () => (st.wex ? W / st.wex : ratio);
    const sy = () => (st.wey ? H / st.wey : ratio);
    const X = x => (x - st.wox) * sx();
    const Y = y => (y - st.woy) * sy();
    const addObject = obj => { let i = objects.indexOf(undefined); if (i < 0) i = objects.length; objects[i] = obj; };
    const strokeOn = () => st.pen.style !== 5;
    const fillOn = () => st.brush.style !== 1;
    const applyPen = () => {
        ctx.strokeStyle = st.pen.color;
        ctx.lineWidth = Math.max(ratio, Math.abs(st.pen.width * sx()));
        ctx.setLineDash(st.pen.style === 1 ? [6 * ratio, 3 * ratio] : st.pen.style === 2 ? [ratio, 2 * ratio] : []);
    };
    const paint = () => {
        if (fillOn()) { ctx.fillStyle = st.brush.color; ctx.fill(st.fill); }
        if (strokeOn()) { applyPen(); ctx.stroke(); }
    };
    const points = (q, n) => { ctx.beginPath(); for (let i = 0; i < n; i++) { const x = X(rds16(data, q + i * 4)), y = Y(rds16(data, q + i * 4 + 2)); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } };
    const text = (str, x, y) => {
        const f = st.font;
        const size = Math.max(1, Math.abs(f.height * sy()) || 12 * ratio);
        ctx.font = `${f.italic ? 'italic ' : ''}${f.weight >= 600 ? 'bold ' : ''}${size}px "${f.face}", Arial, sans-serif`;
        ctx.fillStyle = st.textColor;
        const align = st.textAlign;
        ctx.textAlign = (align & 6) === 6 ? 'center' : (align & 2) ? 'right' : 'left';
        ctx.textBaseline = (align & 24) === 24 ? 'alphabetic' : (align & 8) ? 'bottom' : 'top';
        const px = X(x), py = Y(y);
        if (st.bkMode === 2) {
            const m = ctx.measureText(str);
            const left = ctx.textAlign === 'center' ? px - m.width / 2 : ctx.textAlign === 'right' ? px - m.width : px;
            const top = ctx.textBaseline === 'top' ? py : ctx.textBaseline === 'bottom' ? py - size : py - size * 0.8;
            ctx.save(); ctx.fillStyle = st.bkColor; ctx.fillRect(left, top, m.width, size); ctx.restore();
        }
        ctx.save();
        if (f.escapement) { ctx.translate(px, py); ctx.rotate(-f.escapement * Math.PI / 1800); ctx.fillText(str, 0, 0); } else ctx.fillText(str, px, py);
        ctx.restore();
    };
    const decodeStr = bytes => { try { return new TextDecoder('windows-1252').decode(bytes); } catch { return String.fromCharCode(...bytes); } };
    const blit = (dib, dx, dy, dw, dh) => {
        if (!dib) return;
        const tmp = document.createElement('canvas');
        tmp.width = dib.w; tmp.height = dib.h;
        tmp.getContext('2d').putImageData(new ImageData(dib.rgba, dib.w, dib.h), 0, 0);
        const x1 = X(dx), y1 = Y(dy), x2 = X(dx + dw), y2 = Y(dy + dh);
        ctx.drawImage(tmp, Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    };

    for (let guard = 0; p + 6 <= data.length && guard < 200000; guard++) {
        const size = rd32(data, p) * 2;
        const fn = rd16(data, p + 4);
        if (size < 6 || p + size > data.length) break;
        const a = p + 6, end = p + size;
        const w = i => rds16(data, a + i * 2);
        stats.records++;
        switch (fn) {
        case 0x0000: p = data.length; continue;
        case 0x020B: st.woy = w(0); st.wox = w(1); break; // SetWindowOrg
        case 0x020C: st.wey = w(0); st.wex = w(1); break; // SetWindowExt
        case 0x0102: st.bkMode = w(0); break;
        case 0x0201: st.bkColor = colorRef(data, a); break;
        case 0x0209: st.textColor = colorRef(data, a); break;
        case 0x012E: st.textAlign = rd16(data, a); break;
        case 0x0106: st.fill = w(0) === 2 ? 'nonzero' : 'evenodd'; break;
        case 0x02FA: addObject({ kind: 'pen', style: rd16(data, a) & 0xF, width: w(1), color: colorRef(data, a + 6) }); break;
        case 0x02FC: addObject({ kind: 'brush', style: rd16(data, a), color: colorRef(data, a + 2) }); break;
        case 0x0142: case 0x01F9: addObject({ kind: 'brush', style: 0, color: 'rgb(192,192,192)' }); break;
        case 0x02FB: {
            const nameEnd = Math.min(end, a + 18 + 32);
            let e = a + 18;
            while (e < nameEnd && data[e]) e++;
            addObject({ kind: 'font', height: w(0), escapement: w(2), weight: w(4), italic: !!data[a + 10], underline: !!data[a + 11], face: decodeStr(data.subarray(a + 18, e)) || 'Arial' });
            break;
        }
        case 0x00F7: case 0x06FF: addObject({ kind: 'other' }); break;
        case 0x012D: { // SelectObject
            const obj = objects[rd16(data, a)];
            if (obj && obj.kind === 'pen') st.pen = obj;
            else if (obj && obj.kind === 'brush') st.brush = obj;
            else if (obj && obj.kind === 'font') st.font = obj;
            break;
        }
        case 0x01F0: objects[rd16(data, a)] = undefined; break;
        case 0x001E: stack.push({ ...st }); break;
        case 0x0127: if (stack.length) st = stack.pop(); break;
        case 0x0214: st.y = w(0); st.x = w(1); break; // MoveTo
        case 0x0213: { // LineTo
            const y = w(0), x = w(1);
            if (strokeOn()) { ctx.beginPath(); ctx.moveTo(X(st.x), Y(st.y)); ctx.lineTo(X(x), Y(y)); applyPen(); ctx.stroke(); }
            st.x = x; st.y = y;
            break;
        }
        case 0x0325: points(a + 2, rd16(data, a)); if (strokeOn()) { applyPen(); ctx.stroke(); } break; // Polyline
        case 0x0324: points(a + 2, rd16(data, a)); ctx.closePath(); paint(); break; // Polygon
        case 0x0538: { // PolyPolygon
            const n = rd16(data, a);
            let q = a + 2 + n * 2;
            ctx.beginPath();
            for (let i = 0; i < n; i++) {
                const k = rd16(data, a + 2 + i * 2);
                for (let j = 0; j < k; j++, q += 4) { const x = X(rds16(data, q)), y = Y(rds16(data, q + 2)); j ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
                ctx.closePath();
            }
            paint();
            break;
        }
        case 0x041B: case 0x061C: { // Rectangle, RoundRect
            const o = fn === 0x061C ? 2 : 0;
            const b = w(o), r = w(o + 1), t = w(o + 2), l = w(o + 3);
            ctx.beginPath();
            ctx.rect(Math.min(X(l), X(r)), Math.min(Y(t), Y(b)), Math.abs(X(r) - X(l)), Math.abs(Y(b) - Y(t)));
            paint();
            break;
        }
        case 0x0418: { // Ellipse
            const b = w(0), r = w(1), t = w(2), l = w(3);
            ctx.beginPath();
            ctx.ellipse((X(l) + X(r)) / 2, (Y(t) + Y(b)) / 2, Math.abs(X(r) - X(l)) / 2, Math.abs(Y(b) - Y(t)) / 2, 0, 0, Math.PI * 2);
            paint();
            break;
        }
        case 0x0817: case 0x081A: case 0x0830: { // Arc, Pie, Chord
            const ye = w(0), xe = w(1), ys = w(2), xs = w(3), b = w(4), r = w(5), t = w(6), l = w(7);
            const cx = (X(l) + X(r)) / 2, cy = (Y(t) + Y(b)) / 2, rx = Math.abs(X(r) - X(l)) / 2, ry = Math.abs(Y(b) - Y(t)) / 2;
            if (!rx || !ry) break;
            const ang = (x, y) => Math.atan2((Y(y) - cy) / ry, (X(x) - cx) / rx);
            ctx.beginPath();
            if (fn === 0x081A) ctx.moveTo(cx, cy);
            ctx.ellipse(cx, cy, rx, ry, 0, ang(xs, ys), ang(xe, ye), true);
            if (fn === 0x0817) { if (strokeOn()) { applyPen(); ctx.stroke(); } } else { ctx.closePath(); paint(); }
            break;
        }
        case 0x0521: { // TextOut
            const n = rd16(data, a);
            const sb = a + 2 + ((n + 1) & ~1);
            text(decodeStr(data.subarray(a + 2, a + 2 + n)), rds16(data, sb + 2), rds16(data, sb));
            break;
        }
        case 0x0A32: { // ExtTextOut
            const y = w(0), x = w(1), n = rd16(data, a + 4), opts = rd16(data, a + 6);
            const s = a + 8 + (opts & 6 ? 8 : 0);
            if (opts & 2 && st.bkMode) { // ETO_OPAQUE: fill the rectangle
                const l = w(4), t = w(5), r = w(6), b = w(7);
                ctx.fillStyle = st.bkColor;
                ctx.fillRect(Math.min(X(l), X(r)), Math.min(Y(t), Y(b)), Math.abs(X(r) - X(l)), Math.abs(Y(b) - Y(t)));
            }
            text(decodeStr(data.subarray(s, Math.min(end, s + n))), x, y);
            break;
        }
        case 0x0F43: blit(decodeDib(data, a + 22, end), w(10), w(9), w(8), w(7)); break; // StretchDIBits
        case 0x0B41: blit(decodeDib(data, a + 20, end), w(9), w(8), w(7), w(6)); break; // DibStretchBlt
        case 0x0940: blit(decodeDib(data, a + 16, end), w(7), w(6), w(5), w(4)); break; // DibBitBlt
        case 0x061D: { // PatBlt
            const hh = w(2), ww = w(3), y = w(4), x = w(5);
            ctx.fillStyle = st.brush.color;
            ctx.fillRect(Math.min(X(x), X(x + ww)), Math.min(Y(y), Y(y + hh)), Math.abs(X(x + ww) - X(x)), Math.abs(Y(y + hh) - Y(y)));
            break;
        }
        case 0x0103: case 0x020E: case 0x020F: case 0x0104: case 0x0107: case 0x0234: case 0x0035: case 0x0037: case 0x0231: case 0x0108:
            break; // mapping mode, viewport, ROP2, stretch mode, palettes: nothing to do here
        default: stats.skipped++;
        }
        p += size;
    }
    canvas._wmfStats = stats;
    return canvas;
}
