const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseVolumeHeader, isVolumeHeader, volumeValues } = require('../../src/volume-data');
const { isVariantText, parseVariants, summarizeJson } = require('../../src/shared-preview-data');

function header({ le = true, magic = 'ni1\0', datatype = 4, bitpix = 16, dims = [2, 2, 2], offset = 0 } = {}) {
    const bytes = new Uint8Array(348), v = new DataView(bytes.buffer);
    v.setInt32(0, 348, le); v.setInt16(40, dims.length, le);
    dims.forEach((n, i) => { v.setInt16(42 + i * 2, n, le); v.setFloat32(80 + i * 4, i + 1, le); });
    v.setInt16(70, datatype, le); v.setInt16(72, bitpix, le); v.setFloat32(108, offset, le);
    bytes.set(new TextEncoder().encode(magic), 344);
    return bytes;
}

test('NIfTI and ANALYZE detection rejects reused HDR suffix content', () => {
    assert.equal(isVolumeHeader(new TextEncoder().encode('#?RADIANCE\nFORMAT=32-bit_rle_rgbe')), false);
    assert.equal(isVolumeHeader(new Uint8Array(348)), false);
    assert.equal(isVolumeHeader(header({ dims: [0, 2, 3] })), false);
    assert.equal(isVolumeHeader(header({ bitpix: 32 })), false);
    assert.equal(isVolumeHeader(header({ magic: 'n+1\0' })), false);
    assert.equal(parseVolumeHeader(header({ magic: '\0\0\0\0' })).format, 'ANALYZE 7.5');
    assert.equal(parseVolumeHeader(header()).format, 'NIfTI-1');
});

test('paired volumes honor endianness, byte offsets and NIfTI scaling', () => {
    for (const le of [true, false]) {
        const bytes = header({ le, dims: [2, 1, 1], offset: 4 });
        const v = new DataView(bytes.buffer);
        v.setFloat32(112, 2, le); v.setFloat32(116, -3, le);
        const h = parseVolumeHeader(bytes);
        const image = new Uint8Array(8), data = new DataView(image.buffer);
        data.setInt16(4, -10, le); data.setInt16(6, 12, le);
        const values = volumeValues(h, image);
        assert.equal(values.get(0), -23); assert.equal(values.get(1), 21);
        assert.throws(() => volumeValues(h, image.subarray(0, 7)), /truncated/);
    }
});

test('single-file volume offset and unsupported voxel types have explicit limits', () => {
    const bytes = header({ magic: 'n+1\0', offset: 352 });
    assert.equal(parseVolumeHeader(bytes).single, true);
    const h = parseVolumeHeader(header({ datatype: 128, bitpix: 24 }));
    assert.throws(() => volumeValues(h, new Uint8Array(24)), /does not support voxel datatype 128/);
});

test('genomic VCF is distinguished from vCard and validates sample columns', () => {
    assert.equal(isVariantText('BEGIN:VCARD\nVERSION:3.0'), false);
    const text = '##fileformat=VCFv4.3\n##source=fixture\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE\n1\t100\trs1\tA\tC\t50\tPASS\tDP=20\tGT\t0/1\n';
    const result = parseVariants(text);
    assert.equal(result.total, 1); assert.deepEqual(result.samples, ['SAMPLE']);
    assert.deepEqual(result.chromosomes, { '1': 1 });
    assert.throws(() => parseVariants(text.replace('\t100\t', '\tzero\t')), /Invalid variant record/);
    assert.throws(() => parseVariants('##fileformat=VCFv4.3\n'), /column header/);
});

test('JSON summaries require recognizable structure and preserve generic fallback', () => {
    assert.equal(summarizeJson({ title: 'ordinary' }).schema, 'JSON object');
    assert.equal(summarizeJson([{ a: 1 }]).entries, 1);
    assert.equal(summarizeJson({ type: 'FeatureCollection', features: [{ geometry: { type: 'Point' } }] }).features, 1);
    assert.equal(summarizeJson({ openapi: '3.1.0', info: { title: 'API' }, paths: { '/foo': {} } }).paths, 1);
    assert.equal(summarizeJson({ $schema: 'https://json-schema.org/draft/2020-12/schema', properties: { name: {} } }).schema, 'JSON Schema');
    assert.equal(summarizeJson({ name: 'demo', version: '1.0' }, 'package.json').schema, 'npm package');
    assert.equal(summarizeJson({ log: { entries: [{}, {}] } }).requests, 2);
});

module.exports = { header };
