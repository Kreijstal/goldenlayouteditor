const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isOasisFile, flattenLayout } = require('../../src/oasis-layout');

test('OASIS suffixes use the SEMI header, rejecting text with shared names', () => {
    assert.equal(isOasisFile({ name: 'layout.oasis', bytes: new TextEncoder().encode('%SEMI-OASIS\r\n') }), true);
    assert.equal(isOasisFile({ name: 'api.oas', content: 'openapi: 3.1.0' }), false);
    assert.equal(isOasisFile({ name: 'layout.txt', content: '%SEMI-OASIS\r\n' }), false);
});

test('cell hierarchy applies translation, reflection, rotation, magnification and arrays', () => {
    const layout = { cells: [
        { name: 'LEAF', shapes: [{ kind: 'polygon', layer: '1/0', x: 0, y: 0, points: [[10, 20]], repetition: [[0, 0], [5, 0]] }], placements: [] },
        { name: 'TOP', shapes: [], placements: [{ cell: 'LEAF', x: 100, y: 200, angle: 90, scale: 2, flip: true, repetition: [[0, 0], [50, 0]] }] },
    ] };
    const out = flattenLayout(layout, 'TOP');
    assert.equal(out.shapes.length, 4);
    assert.ok(Math.abs(out.shapes[0].points[0][0] - 140) < 1e-10);
    assert.ok(Math.abs(out.shapes[0].points[0][1] - 220) < 1e-10);
    assert.ok(Math.abs(out.shapes[2].points[0][0] - 190) < 1e-10);
});

test('cyclic and oversized hierarchies stop with visible warnings', () => {
    const cell = { name: 'LOOP', shapes: [], placements: [{ cell: 'LOOP', x: 0, y: 0, angle: 0, scale: 1, flip: false }] };
    assert.match(flattenLayout({ cells: [cell] }, 'LOOP').warnings.join(), /Cyclic/);
    const many = { name: 'MANY', placements: [], shapes: [{ points: [[0, 0]], x: 0, y: 0, repetition: [[0, 0], [1, 0], [2, 0]] }] };
    const out = flattenLayout({ cells: [many] }, 'MANY', 2);
    assert.equal(out.shapes.length, 2);
    assert.match(out.warnings.join(), /limited/);
});
