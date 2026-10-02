// --- G-code toolpath parser ---
// Turns G-code text into line segments for the 3D viewer. Handles G0/G1 moves,
// G2/G3 arcs (I/J or R, flattened), G90/G91, M82/M83, G92, G20/G21 and G28.
// Output is in the machine frame (Z up), in millimetres.

function growFloat(arr, need) {
    if (need <= arr.length) return arr;
    const next = new Float32Array(Math.max(need, arr.length * 2));
    next.set(arr);
    return next;
}

function parseGcode(text) {
    let ext = new Float32Array(1 << 16), extN = 0;      // extrusion segments: x0,y0,z0,x1,y1,z1
    let trav = new Float32Array(1 << 14), travN = 0;    // travel segments
    const extLayer = [];                                // layer index per extrusion segment
    const layerZ = [];                                  // Z of each layer
    const travelStart = [];                             // travel segment count when each layer began
    let x = 0, y = 0, z = 0, e = 0;
    let absXYZ = true, absE = true, scale = 1;
    let lines = 0, moves = 0;
    let filament = 0;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];

    const addSeg = (extrude, x0, y0, z0, x1, y1, z1) => {
        if (extrude) {
            if (!layerZ.length || z1 > layerZ[layerZ.length - 1] + 1e-4) {
                layerZ.push(z1);
                travelStart.push(travN / 6);
            }
            ext = growFloat(ext, extN + 6);
            ext[extN++] = x0; ext[extN++] = y0; ext[extN++] = z0;
            ext[extN++] = x1; ext[extN++] = y1; ext[extN++] = z1;
            extLayer.push(layerZ.length - 1);
            if (x1 < min[0]) min[0] = x1; if (x1 > max[0]) max[0] = x1;
            if (y1 < min[1]) min[1] = y1; if (y1 > max[1]) max[1] = y1;
            if (z1 < min[2]) min[2] = z1; if (z1 > max[2]) max[2] = z1;
        } else {
            trav = growFloat(trav, travN + 6);
            trav[travN++] = x0; trav[travN++] = y0; trav[travN++] = z0;
            trav[travN++] = x1; trav[travN++] = y1; trav[travN++] = z1;
        }
    };

    let pos = 0;
    const len = text.length;
    while (pos < len) {
        let end = text.indexOf('\n', pos);
        if (end < 0) end = len;
        let line = text.slice(pos, end);
        pos = end + 1;
        lines++;
        const semi = line.indexOf(';');
        if (semi >= 0) line = line.slice(0, semi);
        line = line.replace(/\([^)]*\)/g, '').trim().toUpperCase();
        if (!line) continue;

        // Split into words like G1, X10.5, E-0.8
        const words = {};
        let cmd = null;
        const re = /([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g;
        let m;
        while ((m = re.exec(line))) {
            const letter = m[1], val = parseFloat(m[2]);
            if (letter === 'N') continue;
            if (cmd === null && (letter === 'G' || letter === 'M' || letter === 'T')) cmd = letter + val;
            else if (!(letter in words)) words[letter] = val;
        }
        if (cmd === null) continue;

        switch (cmd) {
        case 'G90': absXYZ = true; absE = true; break;
        case 'G91': absXYZ = false; absE = false; break;
        case 'M82': absE = true; break;
        case 'M83': absE = false; break;
        case 'G20': scale = 25.4; break;
        case 'G21': scale = 1; break;
        case 'G92':
            if ('X' in words) x = words.X * scale;
            if ('Y' in words) y = words.Y * scale;
            if ('Z' in words) z = words.Z * scale;
            if ('E' in words) e = words.E * scale;
            break;
        case 'G28':
            if (!('X' in words) && !('Y' in words) && !('Z' in words)) { x = 0; y = 0; z = 0; }
            else { if ('X' in words) x = 0; if ('Y' in words) y = 0; if ('Z' in words) z = 0; }
            break;
        case 'G0': case 'G1': case 'G2': case 'G3': {
            moves++;
            const nx = 'X' in words ? (absXYZ ? 0 : x) + words.X * scale : x;
            const ny = 'Y' in words ? (absXYZ ? 0 : y) + words.Y * scale : y;
            const nz = 'Z' in words ? (absXYZ ? 0 : z) + words.Z * scale : z;
            let de = 0;
            if ('E' in words) {
                const ne = absE ? words.E * scale : e + words.E * scale;
                de = ne - e;
                e = ne;
            }
            const extrude = de > 0 && (nx !== x || ny !== y);
            if (extrude) filament += de;
            if (cmd === 'G0' || cmd === 'G1') {
                if (nx !== x || ny !== y || nz !== z) addSeg(extrude, x, y, z, nx, ny, nz);
            } else {
                // Arc around centre (x+I, y+J), or from radius R
                let cx, cy;
                const cw = cmd === 'G2';
                if ('I' in words || 'J' in words) {
                    cx = x + (words.I || 0) * scale;
                    cy = y + (words.J || 0) * scale;
                } else if ('R' in words) {
                    const r = words.R * scale, dx = nx - x, dy = ny - y, d = Math.hypot(dx, dy);
                    const h = Math.sqrt(Math.max(0, r * r - d * d / 4)) * ((cw ? 1 : -1) * (r < 0 ? -1 : 1));
                    cx = x + dx / 2 - h * dy / d;
                    cy = y + dy / 2 + h * dx / d;
                } else { addSeg(extrude, x, y, z, nx, ny, nz); x = nx; y = ny; z = nz; break; }
                const r = Math.hypot(x - cx, y - cy);
                let a0 = Math.atan2(y - cy, x - cx), a1 = Math.atan2(ny - cy, nx - cx);
                let sweep = a1 - a0;
                if (cw && sweep >= 0) sweep -= 2 * Math.PI;
                if (!cw && sweep <= 0) sweep += 2 * Math.PI;
                const steps = Math.max(2, Math.min(128, Math.ceil(Math.abs(sweep) * r / 0.5)));
                let px = x, py = y, pz = z;
                for (let i = 1; i <= steps; i++) {
                    const t = i / steps, a = a0 + sweep * t;
                    const qx = i === steps ? nx : cx + r * Math.cos(a);
                    const qy = i === steps ? ny : cy + r * Math.sin(a);
                    const qz = z + (nz - z) * t;
                    addSeg(extrude, px, py, pz, qx, qy, qz);
                    px = qx; py = qy; pz = qz;
                }
            }
            x = nx; y = ny; z = nz;
            break;
        }
        }
    }

    // Layer end offsets (in segments) so the viewer can show "layers 0..k" with a draw range
    const layerEnd = new Uint32Array(layerZ.length);
    for (let i = 0; i < extLayer.length; i++) layerEnd[extLayer[i]] = i + 1;
    for (let i = 1; i < layerEnd.length; i++) if (layerEnd[i] < layerEnd[i - 1]) layerEnd[i] = layerEnd[i - 1];

    // Framing box: 2nd..98th percentile of extrusion endpoints, so a purge line
    // at the bed edge doesn't pull the camera away from the part
    let frame = null;
    if (extN) {
        const n = extN / 3, step = Math.max(1, Math.floor(n / 20000));
        const xs = [], ys = [], zs = [];
        for (let i = 0; i < n; i += step) { xs.push(ext[i * 3]); ys.push(ext[i * 3 + 1]); zs.push(ext[i * 3 + 2]); }
        const pct = (arr, q) => { arr.sort((p, q2) => p - q2); return arr[Math.min(arr.length - 1, Math.floor(q * arr.length))]; };
        frame = {
            min: [pct(xs, 0.02), pct(ys, 0.02), min[2]],
            max: [pct(xs, 0.98), pct(ys, 0.98), max[2]],
        };
    }

    // Travel shown for layers 0..k ends where layer k+1 starts
    const travelEnd = new Uint32Array(layerZ.length);
    for (let i = 0; i < layerZ.length; i++) travelEnd[i] = i + 1 < layerZ.length ? travelStart[i + 1] : travN / 6;

    return {
        frame,
        travelEnd,
        extrusion: ext.subarray(0, extN),
        travel: trav.subarray(0, travN),
        layerZ,
        layerEnd,
        bounds: extN ? { min, max } : null,
        stats: { lines, moves, filamentMm: filament },
    };
}

module.exports = { parseGcode };
