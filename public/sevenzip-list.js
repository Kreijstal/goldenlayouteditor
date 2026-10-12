(function (root) {
    function parseSevenZipList(text) {
        return text.split(/\r?\n\r?\n/).map(block => Object.fromEntries(block.split(/\r?\n/).map(line => {
            const p = line.indexOf(' = '); return p < 0 ? [] : [line.slice(0, p), line.slice(p + 3)];
        }).filter(pair => pair.length))).filter(e => e.Path && e.Folder !== '+' && !/^D/.test(e.Attributes || '') && !e['Symbolic Link'] && !e['Hard Link']).map(e => {
            const size = Number(e.Size);
            if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid 7z entry size.');
            return { path: e.Path, size, encrypted: e.Encrypted === '+' };
        });
    }
    if (typeof module !== 'undefined' && module.exports) module.exports = { parseSevenZipList };
    else root.parseSevenZipList = parseSevenZipList;
})(typeof self !== 'undefined' ? self : globalThis);
