// --- PaintTool SAI's file system (.sai) ---
// A .sai is 4096-byte pages, each enciphered: a table page every 512 pages (0,
// 512, 1024...) and data pages. A table page's words are each XORed with the one
// before (the first with the page's index) and with the sum of the four key words
// its bytes pick, then turned by 16 bits; it holds, for itself and the 511 pages
// after it, a checksum (the next word of the page, the chain's start, for a data
// page) and the next page of the file the page is in (0: the last). A data page's
// words have that sum, XORed with the word before (the first: the page's
// checksum), taken off. A checksum is each word XORed into a sum turned one bit
// left, the low bit set; a table's skips its own first word. Pages 2... hold the
// root folder: 64-byte entries (flags, a 32-byte name, type 0x10 folder or 0x80
// file, first page, size, a FILETIME), 64 a page, more in the next page.
// Written from Wunkolo's libsai and its notes ("Cracking PaintTool Sai
// documents"), whose key (UserKey) this is.
// Loaded by the page and the server through require() (telling a .sai by its first page) and by
// the SAI viewer's worker (public/sai-worker.js) with importScripts().
(function (root) {
    const PAGE = 4096;
    const SPAN = 512; // pages a table page describes, itself included
    const KEY = new Uint32Array([
        0x9913D29E, 0x83F58D3D, 0xD0BE1526, 0x86442EB7, 0x7EC69BFB, 0x89D75F64, 0xFB51B239, 0xFF097C56,
        0xA206EF1E, 0x973D668D, 0xC383770D, 0x1CB4CCEB, 0x36F7108B, 0x40336BCD, 0x84D123BD, 0xAFEF5DF3,
        0x90326747, 0xCBFFA8DD, 0x25B94703, 0xD7C5A4BA, 0xE40A17A0, 0xEADAE6F2, 0x6B738250, 0x76ECF24A,
        0x6F2746CC, 0x9BF95E24, 0x1ECA68C5, 0xE71C5929, 0x7817E56C, 0x2F99C471, 0x395A32B9, 0x61438343,
        0x5E3E4F88, 0x80A9332C, 0x1879C69F, 0x7A03D354, 0x12E89720, 0xF980448E, 0x03643576, 0x963C1D7B,
        0xBBED01D6, 0xC512A6B1, 0x51CB492B, 0x44BADEC9, 0xB2D54BC1, 0x4E7C2893, 0x1531C9A3, 0x43A32CA5,
        0x55B25A87, 0x70D9FA79, 0xEF5B4AE3, 0x8AE7F495, 0x923A8505, 0x1D92650C, 0xC94A9A5C, 0x27D4BB14,
        0x1372A9F7, 0x0C19A7FE, 0x64FA1A53, 0xF1A2EB6D, 0x9FEB910F, 0x4CE10C4E, 0x20825601, 0x7DFC98C4,
        0xA046C808, 0x8E90E7BE, 0x601DE357, 0xF360F37C, 0x00CD6F77, 0xCC6AB9D4, 0x24CC4E78, 0xAB1E0BFC,
        0x6A8BC585, 0xFD70ABF0, 0xD4A75261, 0x1ABF5834, 0x45DCFE17, 0x5F67E136, 0x948FD915, 0x65AD9EF5,
        0x81AB20E9, 0xD36EAF42, 0x0F7F45C7, 0x1BAE72D9, 0xBE116AC6, 0xDF58B4D5, 0x3F0B960E, 0xC2613F98,
        0xB065F8B0, 0x6259F975, 0xC49AEE84, 0x29718963, 0x0B6D991D, 0x09CF7A37, 0x692A6DF8, 0x67B68B02,
        0x2E10DBC2, 0x6C34E93C, 0xA84B50A1, 0xAC6FC0BB, 0x5CA6184C, 0x34E46183, 0x42B379A9, 0x79883AB6,
        0x08750921, 0x35AF2B19, 0xF7AA886A, 0x49F281D3, 0xA1768059, 0x14568CFD, 0x8B3625F6, 0x3E1B2D9D,
        0xF60E14CE, 0x1157270A, 0xDB5C7EB3, 0x738A0AFA, 0x19C248E5, 0x590CBD62, 0x7B37C312, 0xFC00B148,
        0xD808CF07, 0xD6BD1C82, 0xBD50F1D8, 0x91DEA3B8, 0xFA86B340, 0xF5DF2A80, 0x9A7BEA6E, 0x1720B8F1,
        0xED94A56B, 0xBF02BE28, 0x0D419FA8, 0x073B4DBC, 0x829E3144, 0x029F43E1, 0x71E6D51F, 0xA9381F09,
        0x583075E0, 0xE398D789, 0xF0E31106, 0x75073EB5, 0x5704863E, 0x6EF1043B, 0xBC407F33, 0x8DBCFB25,
        0x886C8F22, 0x5AF4DD7A, 0x2CEACA35, 0x8FC969DC, 0x9DB8D6B4, 0xC65EDC2F, 0xE60F9316, 0x0A84519A,
        0x3A294011, 0xDCF3063F, 0x41621623, 0x228CB75B, 0x28E9D166, 0xAE631B7F, 0x06D8C267, 0xDA693C94,
        0x54A5E860, 0x7C2170F4, 0xF2E294CB, 0x5B77A0F9, 0xB91522A6, 0xEC549500, 0x10DD78A7, 0x3823E458,
        0x77D3635A, 0x018E3069, 0xE039D055, 0xD5C341BF, 0x9C2400EA, 0x85C0A1D1, 0x66059C86, 0x0416FF1A,
        0xE27E05C8, 0xB19C4C2D, 0xFE4DF58F, 0xD2F0CE2A, 0x32E013C0, 0xEED637D7, 0xE9FEC1E8, 0xA4890DCA,
        0xF4180313, 0x7291738C, 0xE1B053A2, 0x9801267E, 0x2DA15BDB, 0xADC4DA4F, 0xCF95D474, 0xC0265781,
        0x1F226CED, 0xA7472952, 0x3C5F0273, 0xC152BA68, 0xDD66F09B, 0x93C7EDCF, 0x4F147404, 0x3193425D,
        0x26B5768A, 0x0E683B2E, 0x952FDF30, 0x2A6BAE46, 0xA3559270, 0xB781D897, 0xEB4ECB51, 0xDE49394D,
        0x483F629C, 0x2153845E, 0xB40D64E2, 0x47DB0ED0, 0x302D8E4B, 0x4BF8125F, 0x2BD2B0AC, 0x3DC836EC,
        0xC7871965, 0xB64C5CDE, 0x9EA8BC27, 0xD1853490, 0x3B42EC6F, 0x63A4FD91, 0xAA289D18, 0x4D2B1E49,
        0xB8A060AD, 0xB5F6C799, 0x6D1F7D1C, 0xBA8DAAE6, 0xE51A0FC3, 0xD94890E7, 0x167DF6D2, 0x879BCD41,
        0x5096AC1B, 0x05ACB5DA, 0x375D24EE, 0x7F2EB6AA, 0xA535F738, 0xCAD0AD10, 0xF8456E3A, 0x23FD5492,
        0xB3745532, 0x53C1A272, 0x469DFCDF, 0xE897BF7D, 0xA6BBE2AE, 0x68CE38AF, 0x5D783D0B, 0x524F21E4,
        0x4A257B31, 0xCE7A07B2, 0x562CE045, 0x33B708A4, 0x8CEE8AEF, 0xC8FB71FF, 0x74E52FAB, 0xCDB18796,
    ]);

    const keySum = (v) => (KEY[v & 255] + KEY[(v >>> 8) & 255] + KEY[(v >>> 16) & 255] + KEY[v >>> 24]) >>> 0;
    const words = (bytes) => new Uint32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + PAGE));

    // A table page (index: its page number), deciphered: [checksum, next page] × 512
    // (bytes may be only the page's start: as many words as there are)
    function decryptTable(index, bytes) {
        const u = bytes.length >= PAGE ? words(bytes) : new Uint32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + (bytes.length & ~3)));
        let prev = index >>> 0;
        for (let i = 0; i < u.length; i++) {
            const c = u[i];
            const x = (prev ^ c ^ keySum(prev)) >>> 0;
            u[i] = ((x << 16) | (x >>> 16)) >>> 0;
            prev = c;
        }
        return u;
    }

    function decryptData(sum, bytes) {
        const u = words(bytes);
        let prev = sum >>> 0;
        for (let i = 0; i < 1024; i++) {
            const c = u[i];
            u[i] = (c - ((prev ^ keySum(prev)) >>> 0)) >>> 0;
            prev = c;
        }
        return u;
    }

    function checksum(u, from = 0) {
        let s = 0;
        for (let i = from; i < 1024; i++) s = (((s << 1) | (s >>> 31)) ^ u[i]) >>> 0;
        return (s | 1) >>> 0;
    }

    // Whether bytes (the file's start) are a .sai: the first table page's own checksum
    // is odd and its next page 4096 (as in every .sai there is), and if the whole page
    // is there, the checksum holds up
    function isSai(bytes) {
        if (!bytes || bytes.length < 8) return false;
        const t = decryptTable(0, bytes.subarray(0, Math.min(PAGE, bytes.length)));
        if (!(t[0] & 1) || t[1] !== PAGE) return false;
        return t.length < 1024 || checksum(t, 1) === t[0];
    }

    // The file system over pageAt(i) (the i-th page's 4096 bytes, as stored)
    function openVfs(pageAt, pageCount) {
        const tables = new Map();
        function table(i) {
            const t = i - (i % SPAN);
            let u = tables.get(t);
            if (!u) {
                if (t >= pageCount) throw new Error(`page ${i} is past the end of the file`);
                u = decryptTable(t, pageAt(t));
                tables.set(t, u);
            }
            return u;
        }
        function page(i) {
            if (i % SPAN === 0 || i >= pageCount) throw new Error(`no data page ${i}`);
            const t = table(i), sum = t[(i % SPAN) * 2];
            const u = decryptData(sum, pageAt(i));
            if (checksum(u) !== sum) throw new Error(`page ${i} is damaged (its checksum doesn't hold)`);
            return new Uint8Array(u.buffer);
        }
        const next = (i) => table(i)[(i % SPAN) * 2 + 1];
        // A folder's entries (start: its first page)
        function list(start) {
            const out = [];
            const seen = new Set();
            for (let p = start; p && !seen.has(p) && seen.size < 4096; p = next(p)) {
                seen.add(p);
                const b = page(p), dv = new DataView(b.buffer);
                for (let o = 0; o < PAGE; o += 64) {
                    if (!dv.getUint32(o, true)) return out;
                    let n = 0;
                    while (n < 32 && b[o + 4 + n]) n++;
                    out.push({
                        name: String.fromCharCode(...b.subarray(o + 4, o + 4 + n)),
                        folder: b[o + 38] === 0x10,
                        page: dv.getUint32(o + 40, true),
                        size: dv.getUint32(o + 44, true),
                        // FILETIME: 100 ns since 1601
                        time: (dv.getUint32(o + 52, true) * 4294967296 + dv.getUint32(o + 48, true)) / 1e4 - 11644473600000,
                    });
                }
            }
            return out;
        }
        function entry(path) {
            let e = { folder: true, page: 2 };
            for (const part of path.split('/').filter(Boolean)) {
                if (!e.folder) return null;
                e = list(e.page).find(c => c.name === part);
                if (!e) return null;
            }
            return e;
        }
        // A file's bytes (its pages, following the chain)
        function read(e) {
            const out = new Uint8Array(e.size);
            let p = e.page;
            for (let o = 0; o < e.size; o += PAGE) {
                if (!p) throw new Error(`${e.name} ends early`);
                out.set(page(p).subarray(0, Math.min(PAGE, e.size - o)), o);
                p = next(p);
            }
            return out;
        }
        return { list, entry, read, root: () => list(2) };
    }

    const api = { PAGE, SPAN, decryptTable, decryptData, checksum, isSai, openVfs };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.SaiVfs = api;
})(typeof self !== 'undefined' ? self : this);
