// Embedded PNG previews only: this does not interpret Affinity document objects.
// Walk PNG chunks rather than looking for IEND bytes inside compressed pixels.
const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function extractAffinityPreviews(bytes) {
    if (bytes.length < 4 || bytes[0] !== 0 || bytes[1] !== 255 || bytes[2] !== 75 || bytes[3] !== 65) {
        throw new Error('Not an Affinity document');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const previews = [];
    for (let start = 4; start <= bytes.length - 33; start++) {
        if (!SIGNATURE.every((value, index) => bytes[start + index] === value)) continue;
        let pos = start + 8, width = 0, height = 0, pixels = false;
        while (pos <= bytes.length - 12) {
            const length = view.getUint32(pos);
            const end = pos + length + 12;
            if (end > bytes.length) break;
            const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
            if (pos === start + 8) {
                if (type !== 'IHDR' || length !== 13) break;
                width = view.getUint32(pos + 8);
                height = view.getUint32(pos + 12);
                if (!width || !height) break;
            }
            if (type === 'IDAT') pixels = true;
            if (type === 'IEND') {
                if (length === 0 && pixels) {
                    previews.push({ bytes: bytes.slice(start, end), width, height });
                    start = end - 1;
                }
                break;
            }
            pos = end;
        }
    }
    if (!previews.length) throw new Error('No embedded PNG preview found in this Affinity document');
    return previews.sort((a, b) => b.width * b.height - a.width * a.height);
}

module.exports = { extractAffinityPreviews };
