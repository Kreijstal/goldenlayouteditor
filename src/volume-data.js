// NIfTI-1 and ANALYZE 7.5 share a 348-byte header. Image data has no magic;
// an .img is only recognized through its companion header.
const TYPES = {
    2: ['uint8', 1, 'getUint8'], 4: ['int16', 2, 'getInt16'],
    8: ['int32', 4, 'getInt32'], 16: ['float32', 4, 'getFloat32'],
    64: ['float64', 8, 'getFloat64'], 256: ['int8', 1, 'getInt8'],
    512: ['uint16', 2, 'getUint16'], 768: ['uint32', 4, 'getUint32'],
};

function parseVolumeHeader(bytes) {
    if (!bytes || bytes.length < 348) throw new Error('A volume header needs 348 bytes.');
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const le = v.getInt32(0, true) === 348;
    if (!le && v.getInt32(0, false) !== 348) throw new Error('Not a NIfTI-1 / ANALYZE header.');
    const rank = v.getInt16(40, le);
    if (rank < 1 || rank > 7) throw new Error('Invalid volume dimensions.');
    const dims = Array.from({ length: rank }, (_, i) => v.getInt16(42 + i * 2, le));
    if (dims.some(n => n <= 0)) throw new Error('Invalid volume dimensions.');
    const magic = new TextDecoder().decode(bytes.subarray(344, 348));
    const nifti = magic === 'ni1\0' || magic === 'n+1\0';
    const datatype = v.getInt16(70, le), bitpix = v.getInt16(72, le);
    if (bitpix <= 0 || bitpix > 2048) throw new Error('Invalid voxel bit depth.');
    if (TYPES[datatype] && TYPES[datatype][1] * 8 !== bitpix) throw new Error('Voxel datatype and bit depth disagree.');
    const offset = v.getFloat32(108, le);
    if (!Number.isFinite(offset) || offset < 0 || !Number.isInteger(offset)) throw new Error('Invalid voxel offset.');
    if (magic === 'n+1\0' && offset < 352) throw new Error('A single-file NIfTI volume needs a voxel offset of at least 352.');
    const slope = nifti ? v.getFloat32(112, le) : 0;
    const intercept = nifti && slope ? v.getFloat32(116, le) : 0;
    if (!Number.isFinite(slope) || !Number.isFinite(intercept)) throw new Error('Invalid voxel scaling.');
    return {
        format: nifti ? 'NIfTI-1' : 'ANALYZE 7.5', single: magic === 'n+1\0', le, dims, datatype, bitpix,
        spacing: dims.map((_, i) => v.getFloat32(80 + i * 4, le)),
        offset, slope: slope || 1, intercept,
        description: new TextDecoder().decode(bytes.subarray(148, 228)).replace(/\0.*$/s, ''),
        sform: nifti ? v.getInt16(254, le) : 0, qform: nifti ? v.getInt16(252, le) : 0,
    };
}

function isVolumeHeader(bytes) {
    try { parseVolumeHeader(bytes); return true; } catch (_) { return false; }
}

function volumeValues(header, bytes) {
    const type = TYPES[header.datatype];
    if (!type) throw new Error(`Slice rendering does not support voxel datatype ${header.datatype}; the header is available above.`);
    const count = header.dims.reduce((a, b) => a * b, 1);
    const offset = header.offset;
    if (!Number.isSafeInteger(count) || offset + count * type[1] > bytes.length) throw new Error('Image data is truncated or does not match the header.');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { count, name: type[0], get: i => view[type[2]](offset + i * type[1], header.le) * header.slope + header.intercept };
}

module.exports = { parseVolumeHeader, isVolumeHeader, volumeValues };
