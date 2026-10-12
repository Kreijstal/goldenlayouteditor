const MAGIC = '%SEMI-OASIS\r\n';
function isOasisFile(file) {
    const bytes = file.head || file.bytes;
    const text = bytes ? new TextDecoder().decode(bytes.subarray(0, MAGIC.length)) : typeof file.content === 'string' ? file.content.slice(0, MAGIC.length) : '';
    return /\.(oas|oasis)$/i.test(file.name) && (!text || text === MAGIC);
}

function transformPoint(m, point) {
    return [m[0] * point[0] + m[2] * point[1] + m[4], m[1] * point[0] + m[3] * point[1] + m[5]];
}
function multiply(a, b) {
    return [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
}

function flattenLayout(layout, selected, limit = 25000) {
    const cells = new Map(layout.cells.map(c => [c.name, c]));
    const shapes = [], warnings = new Set(layout.warnings || []);
    let visits = 0;
    const walk = (name, matrix, ancestors) => {
        if (++visits > limit || shapes.length >= limit) { warnings.add('Preview limited to 25,000 shapes / cell instances.'); return; }
        if (ancestors.includes(name) || ancestors.length >= 64) { warnings.add(`Cyclic or deep hierarchy stopped at ${name}.`); return; }
        const cell = cells.get(name);
        if (!cell) { warnings.add(`Missing referenced cell ${name}.`); return; }
        for (const shape of cell.shapes) {
            for (const [dx, dy] of shape.repetition || [[0, 0]]) {
                if (shapes.length >= limit) { warnings.add('Preview limited to 25,000 shapes / cell instances.'); break; }
                const points = shape.points.map(([x, y]) => transformPoint(matrix, [x + shape.x + dx, y + shape.y + dy]));
                shapes.push({ ...shape, points, width: (shape.width || 0) * Math.hypot(matrix[0], matrix[1]) });
            }
        }
        for (const p of cell.placements) {
            const angle = p.angle * Math.PI / 180, c = Math.cos(angle) * p.scale, s = Math.sin(angle) * p.scale, flip = p.flip ? -1 : 1;
            for (const [dx, dy] of p.repetition || [[0, 0]]) {
                if (visits >= limit || shapes.length >= limit) { warnings.add('Preview limited to 25,000 shapes / cell instances.'); break; }
                walk(p.cell, multiply(matrix, [c, s, -s * flip, c * flip, p.x + dx, p.y + dy]), [...ancestors, name]);
            }
        }
    };
    walk(selected, [1, 0, 0, 1, 0, 0], []);
    return { shapes, warnings: [...warnings] };
}
module.exports = { isOasisFile, transformPoint, multiply, flattenLayout };
