function sevenZipMagic(bytes) { return [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c].every((b, i) => bytes[i] === b); }
class SevenZipArchive {
    constructor() {
        this.pending = new Map(); this.nextId = 1;
        this.worker = new Worker(new URL('sevenzip-worker.js', document.baseURI), { type: 'module' });
        this.worker.onmessage = ({ data }) => {
            const p = this.pending.get(data.id);
            if (!p) return;
            this.pending.delete(data.id); clearTimeout(p.timer);
            if (data.error) p.reject(new Error(data.error)); else p.resolve(data);
        };
        this.worker.onerror = e => this.close(e.message || '7-Zip worker failed.');
    }
    request(op, fields, transfer = []) {
        if (this.closed) return Promise.reject(new Error('Archive closed.'));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => this.close('7-Zip operation timed out after 120 seconds.'), 120000);
            this.pending.set(id, { resolve, reject, timer });
            this.worker.postMessage({ id, op, ...fields }, transfer);
        });
    }
    async open(bytes, password) {
        if (!sevenZipMagic(bytes)) throw new Error('Not a 7z archive.');
        const buffer = bytes.slice().buffer;
        const { entries } = await this.request('open', { bytes: buffer, password }, [buffer]);
        return entries.map(entry => ({ ...entry, extract: async () => {
            const result = await this.request('extract', { path: entry.path });
            return new File([result.bytes], entry.path.split('/').pop());
        } }));
    }
    close(message = 'Archive closed.') {
        this.closed = true;
        this.worker.terminate();
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); }
        this.pending.clear();
    }
}
module.exports = { SevenZipArchive, sevenZipMagic };
