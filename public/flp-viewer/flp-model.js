// FL Studio project model on top of @holzchopf/flp-file (passed in as `lib`,
// so the same code runs in the browser and in Node tests). flp-file reads and
// writes the file as a list of events; this module reads the project out of
// those events (info, channels, patterns, playlist, mixer) and edits them in
// place, so a save changes only the events that were edited.
//
// Strings are kept as raw bytes: flp-file decodes every text event as UTF-16,
// but FL Studio before 11.5 wrote them as ANSI, and decoding and re-encoding
// would change the bytes. Here they are decoded for display by FL version, and
// only re-encoded when edited.

// Text events: 192-207, plus the newer ones above 208
const TEXT_IDS = new Set([192, 193, 194, 195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 231, 239, 241]);

// FL Studio's ids (names from flp-file where it has them)
const ID = {
    channelType: 21, targetInsert: 22, volByte: 2, panByte: 3, enabled: 0,
    newChan: 64, newPat: 65, tempoCoarse: 66, tempoFine: 93, currentSlot: 98, newArrangement: 99,
    color: 128, insertOut: 147, timeMarker: 148, insertColor: 149, patternColor: 150, insertIn: 154,
    fineTempo: 156, build: 159, patternLength: 164,
    chanName: 192, patName: 193, title: 194, comment: 195, sampleFile: 196, url: 197, commentRtf: 198,
    version: 199, regName: 200, defPluginName: 201, dataPath: 202, pluginName: 203, insertName: 204,
    timeMarkerName: 205, genre: 206, author: 207,
    newPlugin: 212, pluginParams: 213, levels: 219, notes: 224, mixerParams: 225, chanGroupName: 231,
    playlistItems: 233, insertRoutes: 235, insertFlags: 236, timestamp: 237, newTrack: 238, trackName: 239,
    arrangementName: 241,
};

// Events that only occur in the mixer; the first one starts it
const MIXER_IDS = new Set([ID.insertOut, ID.insertColor, ID.insertIn, ID.insertName, ID.insertRoutes, ID.insertFlags, ID.currentSlot]);

const CHANNEL_TYPES = { 0: 'Sampler', 2: 'Generator', 3: 'Layer', 4: 'Audio clip', 5: 'Automation clip' };

// Project text fields that can be edited
const PROJECT_TEXT = { title: ID.title, author: ID.author, genre: ID.genre, comments: ID.comment, url: ID.url };

// Make flp-file keep text (and events it doesn't know) as bytes; idempotent
function prepareLib(lib) {
    if (lib.__flpModelPrepared) return lib;
    const types = lib.FLPEventValueDataType;
    for (const id of TEXT_IDS) {
        const name = lib.FLPEventType.name(id);
        if (name !== 'unknown') types[name] = 'binary';
    }
    // 208/209 are named Text* but hold binary data
    for (const id of [208, 209, 230]) {
        const name = lib.FLPEventType.name(id);
        if (name !== 'unknown') types[name] = 'binary';
    }
    // Ids flp-file has no name for all look up 'unknown'; their bytes are kept as read
    types.unknown = 'binary';
    try { Object.defineProperty(lib, '__flpModelPrepared', { value: true }); } catch (_) { /* frozen namespace */ }
    return lib;
}

function toArrayBuffer(bytes) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function eventBytes(ev) {
    return new Uint8Array(ev.getBinary());
}

// An event's number, also for ids flp-file has no type for (kept as bytes)
function num(ev) {
    if (typeof ev.value === 'number') return ev.value;
    const b = eventBytes(ev);
    let v = 0;
    for (let i = b.length - 1; i >= 0; i--) v = v * 256 + b[i];
    return v;
}

function parseVersion(str) {
    const parts = String(str || '').split('.').map(n => parseInt(n, 10) || 0);
    while (parts.length < 4) parts.push(0);
    return parts;
}

function versionAtLeast(v, ...want) {
    for (let i = 0; i < want.length; i++) {
        if ((v[i] || 0) !== want[i]) return (v[i] || 0) > want[i];
    }
    return true;
}

const latin1 = typeof TextDecoder !== 'undefined' ? new TextDecoder('windows-1252') : null;
const utf16 = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-16le') : null;

class FlpProject {
    constructor(lib, bytes) {
        this.lib = prepareLib(lib);
        this.file = new lib.FLPFile();
        this.file.setBinary(toArrayBuffer(bytes));
        if (this.file.header.format === -1) throw new Error('not an FL Studio file (no FLhd chunk)');
        this.events = this.file.data.events;
        this.read();
    }

    // --- Strings ---

    // FL Studio 11.5 and later write strings as UTF-16LE, older ones as ANSI
    get utf16() {
        return versionAtLeast(this.version, 11, 5);
    }

    isText(ev) {
        return TEXT_IDS.has(ev.type);
    }

    decodeText(ev) {
        const bytes = eventBytes(ev);
        // The version string is always ASCII; the newer ids always UTF-16
        const wide = ev.type !== ID.version && (this.utf16 || ev.type === ID.chanGroupName || ev.type === ID.trackName || ev.type === ID.arrangementName);
        let s = wide ? utf16.decode(bytes.length % 2 ? bytes.subarray(0, bytes.length - 1) : bytes) : latin1.decode(bytes);
        return s.replace(/\0+$/, '');
    }

    encodeText(type, str) {
        const wide = type !== ID.version && (this.utf16 || type === ID.chanGroupName || type === ID.trackName || type === ID.arrangementName);
        const s = String(str) + '\0';
        if (wide) {
            const out = new Uint8Array(s.length * 2);
            for (let i = 0; i < s.length; i++) {
                const c = s.charCodeAt(i);
                out[i * 2] = c & 255;
                out[i * 2 + 1] = c >> 8;
            }
            return out;
        }
        // ANSI: Latin-1 range as is, anything else as '?'
        const out = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            out[i] = c < 256 ? c : 63;
        }
        return out;
    }

    // --- Reading ---

    read() {
        const events = this.events;
        const versionEv = events.find(e => e.type === ID.version);
        this.versionString = versionEv ? this.decodeText(versionEv) : '';
        this.version = parseVersion(this.versionString);

        const info = { refs: {} };
        const channels = [];
        const chanById = new Map();
        const patterns = new Map();
        const arrangements = [];
        const inserts = [];
        const groups = [];
        let channel = null, pattern = null, arrangement = null, insert = null;
        let inMixer = false, plugin = null;
        let mixerParams = null;
        const pat = num => {
            if (!patterns.has(num)) patterns.set(num, { num, name: '', color: null, length: 0, notes: [], markers: [], refs: {}, newEvents: [] });
            return patterns.get(num);
        };
        const arr = () => {
            if (!arrangement) {
                arrangement = { id: arrangements.length, name: '', items: [], tracks: [], markers: [], refs: {} };
                arrangements.push(arrangement);
            }
            return arrangement;
        };

        events.forEach((ev, idx) => {
            const t = ev.type;
            if (!inMixer && MIXER_IDS.has(t)) inMixer = true;

            // Project-wide
            switch (t) {
                case ID.title: case ID.comment: case ID.url: case ID.genre: case ID.author:
                case ID.commentRtf: case ID.dataPath: case ID.regName:
                    info.refs[t] = ev;
                    return;
                case ID.fineTempo: info.refs.fineTempo = ev; return;
                case ID.tempoCoarse: info.refs.tempoCoarse = ev; return;
                case ID.tempoFine: info.refs.tempoFine = ev; return;
                case 17: info.tsNum = ev.value; return;
                case 18: info.tsDen = ev.value; return;
                case ID.build: info.build = ev.value; return;
                case 28: info.registered = ev.value; return;
                case 80: info.mainPitch = ev.value << 16 >> 16; return;
                case 11: info.shuffle = ev.value; return;
                case ID.timestamp: {
                    const b = eventBytes(ev);
                    if (b.length >= 16) {
                        const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
                        info.created = dv.getFloat64(0, true);
                        info.timeSpent = dv.getFloat64(8, true);
                    }
                    return;
                }
                case ID.chanGroupName: groups.push(this.decodeText(ev)); return;
                case ID.mixerParams: mixerParams = eventBytes(ev); return;
            }

            // Channels
            if (t === ID.newChan) {
                channel = { iid: ev.value, index: channels.length, type: null, name: '', internalName: '', samplePath: '', color: null,
                    volume: null, pan: null, insert: null, enabled: true, startIndex: idx, nameEvents: [], refs: { new: ev } };
                channels.push(channel);
                chanById.set(channel.iid, channel);
                pattern = null;
                return;
            }
            // Patterns: a pattern's notes and its name/color come in separate runs, each after a NewPat
            if (t === ID.newPat) {
                pattern = pat(ev.value);
                pattern.newEvents.push(ev);
                channel = null;
                return;
            }
            if (t === ID.newArrangement) {
                arrangement = null;
                arr().iidValue = ev.value;
                arrangement.refs.new = ev;
                pattern = null;
                channel = null;
                return;
            }

            if (inMixer) {
                if (!insert) {
                    insert = { index: inserts.length, name: '', color: null, slots: [], routes: [], flags: null, input: null, output: null, refs: {}, firstEvent: ev };
                    plugin = null;
                }
                switch (t) {
                    case ID.insertName: insert.name = this.decodeText(ev); insert.refs.name = ev; break;
                    case ID.insertColor: insert.color = ev.value; break;
                    case ID.insertFlags: {
                        const b = eventBytes(ev);
                        if (b.length >= 8) insert.flags = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(4, true);
                        insert.refs.flags = ev;
                        break;
                    }
                    case ID.insertRoutes: insert.routes = [...eventBytes(ev)].map((v, i) => v ? i : -1).filter(i => i >= 0); break;
                    case ID.insertIn: insert.input = ev.value | 0; break;
                    case ID.defPluginName:
                        plugin = { internalName: this.decodeText(ev), name: '', paramsSize: 0, slot: null };
                        insert.slots.push(plugin);
                        break;
                    case ID.pluginName: if (plugin) plugin.name = this.decodeText(ev); break;
                    case ID.pluginParams: if (plugin) plugin.paramsSize = eventBytes(ev).length; break;
                    case ID.currentSlot:
                        // The low byte is the slot; FL sets higher bits on some (0x100)
                        if (plugin && plugin.slot === null) plugin.slot = ev.value & 0xFF;
                        plugin = null;
                        break;
                    case ID.insertOut:
                        insert.output = ev.value | 0;
                        // FL 9 has no slot index events: the plugins are in slot order
                        insert.slots.forEach((p, i) => { if (p.slot === null) p.slot = i; });
                        inserts.push(insert);
                        insert = null;
                        plugin = null;
                        break;
                }
                return;
            }

            if (t === ID.timeMarker || t === 33 || t === 34 || t === ID.timeMarkerName) {
                const owner = arrangement || pattern;
                if (!owner) return;
                if (t === ID.timeMarker) owner.markers.push({ pos: ev.value & 0xFFFFFF, kind: ev.value >>> 24, name: '', num: null, den: null });
                const m = owner.markers[owner.markers.length - 1];
                if (!m) return;
                if (t === 33) m.num = ev.value;
                else if (t === 34) m.den = ev.value;
                else if (t === ID.timeMarkerName) m.name = this.decodeText(ev);
                return;
            }

            if (pattern) {
                switch (t) {
                    case ID.patName: pattern.name = this.decodeText(ev); pattern.refs.name = ev; return;
                    case ID.patternColor: pattern.color = ev.value; return;
                    case ID.patternLength: pattern.length = num(ev); return;
                    case ID.notes: {
                        const b = eventBytes(ev);
                        const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
                        for (let o = 0; o + 24 <= b.length; o += 24) {
                            pattern.notes.push({
                                pos: dv.getUint32(o, true), flags: dv.getUint16(o + 4, true), channel: dv.getUint16(o + 6, true),
                                length: dv.getUint32(o + 8, true), key: dv.getUint16(o + 12, true), fine: b[o + 16],
                                release: b[o + 18], pan: b[o + 20], velocity: b[o + 21],
                            });
                        }
                        return;
                    }
                }
            }

            if (channel) {
                switch (t) {
                    case ID.channelType: channel.type = ev.value; return;
                    case ID.defPluginName: channel.internalName = this.decodeText(ev); channel.refs.defPluginName = ev; return;
                    case ID.newPlugin: channel.refs.newPlugin = ev; return;
                    case ID.pluginName: case ID.chanName:
                        channel.name = channel.name || this.decodeText(ev);
                        if (t === ID.pluginName) channel.name = this.decodeText(ev);
                        channel.nameEvents.push(ev);
                        return;
                    case ID.sampleFile: channel.samplePath = this.decodeText(ev); return;
                    case ID.color: channel.color = ev.value; return;
                    case ID.targetInsert: channel.insert = ev.value << 24 >> 24; return;
                    case ID.enabled: channel.enabled = !!ev.value; return;
                    case ID.levels: {
                        const b = eventBytes(ev);
                        if (b.length >= 8) {
                            const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
                            // 0-12800 with the centre at 6400
                            channel.pan = (dv.getInt32(0, true) - 6400) / 6400;
                            channel.volume = dv.getUint32(4, true) / 12800;
                        }
                        return;
                    }
                    case ID.volByte: if (channel.volume === null) channel.volume = ev.value / 128; return;
                    case ID.panByte: if (channel.pan === null) channel.pan = (ev.value - 64) / 64; return;
                }
            }

            // Playlist
            if (t === ID.arrangementName) { arr().name = this.decodeText(ev); arr().refs.name = ev; return; }
            if (t === ID.playlistItems) {
                const a = arr();
                const b = eventBytes(ev);
                const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
                // 32-byte items, 60 since FL 21
                let size = versionAtLeast(this.version, 21) ? 60 : 32;
                if (b.length % size) size = size === 60 ? 32 : 60;
                const maxTrack = versionAtLeast(this.version, 12, 9, 1) ? 499 : 198;
                for (let o = 0; o + size <= b.length; o += size) {
                    const base = dv.getUint16(o + 4, true);
                    const item = dv.getUint16(o + 6, true);
                    const rv = dv.getUint16(o + 12, true);
                    // Pattern clips count from the base (20480); below it, audio/automation clips by channel
                    const isPattern = base > 0 && item > base;
                    // FL 9 and older: pattern blocks on the pattern's own row, the pattern counted down from 999
                    if (base === 0 && rv > maxTrack && rv < 1000) {
                        a.items.push({ pos: dv.getUint32(o, true), length: dv.getUint32(o + 8, true), track: 999 - rv, patternRow: true, pattern: 999 - rv, channel: null, flags: 0 });
                        continue;
                    }
                    if (rv > maxTrack) { a.hidden = (a.hidden || 0) + 1; continue; }
                    a.items.push({
                        pos: dv.getUint32(o, true), length: dv.getUint32(o + 8, true),
                        track: maxTrack - rv,
                        pattern: isPattern ? item - base : null,
                        channel: isPattern ? null : item,
                        flags: dv.getUint16(o + 18, true),
                        startOffset: dv.getFloat32(o + 24, true), endOffset: dv.getFloat32(o + 28, true),
                    });
                }
                return;
            }
            if (t === ID.newTrack) {
                const a = arr();
                const b = eventBytes(ev);
                const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
                a.tracks.push({
                    index: a.tracks.length, name: '',
                    iid: b.length >= 4 ? dv.getUint32(0, true) : a.tracks.length + 1,
                    color: b.length >= 8 ? dv.getUint32(4, true) : null,
                    enabled: b.length >= 13 ? !!b[12] : true,
                });
                return;
            }
            if (t === ID.trackName) {
                const a = arr();
                const tr = a.tracks[a.tracks.length - 1];
                if (tr) { tr.name = this.decodeText(ev); tr.nameRef = ev; }
                return;
            }
        });
        if (insert && (insert.name || insert.slots.length)) inserts.push(insert);

        // Mixer volume and pan: 12-byte items, (insert, slot) packed in one word
        if (mixerParams) {
            const dv = new DataView(mixerParams.buffer, mixerParams.byteOffset, mixerParams.byteLength);
            for (let o = 0; o + 12 <= mixerParams.length; o += 12) {
                const id = mixerParams[o + 4];
                const cd = dv.getUint16(o + 6, true);
                const msg = dv.getInt32(o + 8, true);
                const ins = inserts[(cd >> 6) & 0x7F];
                if (!ins) continue;
                if (id === 192) ins.volume = msg / 12800;
                else if (id === 193) ins.pan = msg / 6400;
                else if (id === 0) {
                    const slot = ins.slots.find(s => s.slot === (cd & 0x3F));
                    if (slot) slot.enabled = !!msg;
                }
            }
        }

        for (const ch of channels) {
            ch.typeName = ch.type === null ? '' : (CHANNEL_TYPES[ch.type] || `Type ${ch.type}`);
            if (ch.type === 4 && !ch.samplePath && ch.internalName) ch.typeName = 'Generator';
        }

        info.tempo = this._tempo(info.refs);
        info.title = this._refText(info.refs[ID.title]);
        info.author = this._refText(info.refs[ID.author]);
        info.genre = this._refText(info.refs[ID.genre]);
        info.comments = this._refText(info.refs[ID.comment]);
        info.commentsRtf = this._refText(info.refs[ID.commentRtf]);
        info.url = this._refText(info.refs[ID.url]);
        info.dataPath = this._refText(info.refs[ID.dataPath]);
        this.info = info;
        this.channels = channels;
        this.channelById = chanById;
        this.patterns = [...patterns.values()].sort((a, b) => a.num - b.num);
        for (const p of this.patterns) {
            p.noteEnd = p.notes.reduce((m, n) => Math.max(m, n.pos + n.length), 0);
        }
        this.arrangements = arrangements;
        this.inserts = inserts;
        this.groups = groups;
    }

    _refText(ev) {
        return ev ? this.decodeText(ev) : null;
    }

    _tempo(refs) {
        if (refs.fineTempo) return refs.fineTempo.value / 1000;
        if (refs.tempoCoarse) return refs.tempoCoarse.value + (refs.tempoFine ? refs.tempoFine.value / 1000 : 0);
        return null;
    }

    get ppq() { return this.file.header.ppq; }
    get formatName() { return this.file.header.formatName; }

    // --- Editing ---

    _newEvent(type, value) {
        const ev = new this.lib.FLPEvent(type);
        ev.value = value;
        return ev;
    }

    _setText(ev, str) {
        ev.value = toArrayBuffer(this.encodeText(ev.type, str));
    }

    // A text event, edited in place or made after `after` (or before the first channel)
    _putText(existing, type, str, after) {
        if (existing) {
            if (this.decodeText(existing) === str) return existing;
            this._setText(existing, str);
            return existing;
        }
        const ev = this._newEvent(type, new ArrayBuffer(0));
        this._setText(ev, str);
        let at;
        if (after) at = this.events.indexOf(after) + 1;
        if (!at) {
            // Project info goes with the other project events, before the first channel group or channel
            at = this.events.findIndex(e => e.type === ID.chanGroupName || e.type === ID.newChan || e.type === ID.newPat || e.type === 146);
            if (at < 0) at = this.events.length;
        }
        this.events.splice(at, 0, ev);
        return ev;
    }

    setProjectText(field, str) {
        const type = PROJECT_TEXT[field];
        if (!type) throw new Error('unknown field ' + field);
        // FL Studio ends comment lines with a bare CR
        if (field === 'comments') str = String(str).replace(/\r\n|\n/g, '\r');
        // Kept next to the version/tempo events when the file had none
        const anchor = this.info.refs.fineTempo || this.info.refs.tempoCoarse || this.events.find(e => e.type === ID.version);
        this.info.refs[type] = this._putText(this.info.refs[type], type, str, this.info.refs[type] ? null : anchor);
        this.info[field] = str;
    }

    setTempo(bpm) {
        bpm = Number(bpm);
        if (!isFinite(bpm) || bpm < 10 || bpm > 999) throw new Error('tempo must be between 10 and 999 BPM');
        const refs = this.info.refs;
        if (refs.fineTempo) {
            refs.fineTempo.value = Math.round(bpm * 1000);
        } else if (refs.tempoCoarse) {
            refs.tempoCoarse.value = Math.floor(bpm);
            if (refs.tempoFine) refs.tempoFine.value = Math.round((bpm - Math.floor(bpm)) * 1000);
        } else {
            const ev = this._newEvent(ID.fineTempo, Math.round(bpm * 1000));
            const v = this.events.findIndex(e => e.type === ID.version);
            this.events.splice(v + 1, 0, ev);
            refs.fineTempo = ev;
        }
        this.info.tempo = this._tempo(refs);
    }

    setChannelName(iid, str) {
        const ch = this.channelById.get(iid);
        if (!ch) throw new Error('no channel ' + iid);
        if (ch.nameEvents.length) {
            for (const ev of ch.nameEvents) this._putText(ev, ev.type, str);
        } else {
            const type = versionAtLeast(this.version, 12) ? ID.pluginName : ID.chanName;
            const after = ch.refs.newPlugin || ch.refs.defPluginName || ch.refs.new;
            ch.nameEvents.push(this._putText(null, type, str, after));
        }
        ch.name = str;
    }

    setPatternName(num, str) {
        const p = this.patterns.find(x => x.num === num);
        if (!p) throw new Error('no pattern ' + num);
        // A new name goes after the pattern's last NewPat, where FL keeps its name and color
        p.refs.name = this._putText(p.refs.name, ID.patName, str, p.newEvents[p.newEvents.length - 1]);
        p.name = str;
    }

    setInsertName(index, str) {
        const ins = this.inserts[index];
        if (!ins) throw new Error('no insert ' + index);
        if (ins.refs.name) {
            this._putText(ins.refs.name, ID.insertName, str);
        } else {
            // Before the insert's flags, where FL writes the name
            const ev = this._newEvent(ID.insertName, new ArrayBuffer(0));
            this._setText(ev, str);
            const at = this.events.indexOf(ins.refs.flags || ins.firstEvent);
            this.events.splice(at < 0 ? this.events.length : at, 0, ev);
            ins.refs.name = ev;
        }
        ins.name = str;
    }

    toBytes() {
        return new Uint8Array(this.file.getBinary());
    }

    // --- Raw events ---

    // { index, offset, id, name, size, kind, value, bytes } per event
    rawEvents() {
        let offset = 22; // FLhd chunk (14 bytes) + FLdt header (8)
        return this.events.map((ev, index) => {
            const bytes = eventBytes(ev);
            const fixed = ev.maxByteLength;
            let headerSize = 1;
            if (!fixed) {
                let n = bytes.length;
                do { headerSize++; n >>>= 7; } while (n);
            }
            const row = { index, offset, id: ev.type, name: ev.typeName, size: bytes.length, bytes };
            if (this.isText(ev)) { row.kind = 'text'; row.value = this.decodeText(ev); }
            else if (fixed) { row.kind = 'number'; row.value = bytes.reduce((v, b, i) => v + b * 2 ** (8 * i), 0); }
            else { row.kind = 'binary'; row.value = null; }
            offset += headerSize + bytes.length;
            return row;
        });
    }
}

// FL colors are stored as 0x00BBGGRR
function colorCss(v) {
    if (v === null || v === undefined) return null;
    const r = v & 255, g = (v >> 8) & 255, b = (v >> 16) & 255;
    return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}

// FL's dates are days since 30 Dec 1899 (Delphi's TDateTime)
function delphiDate(days) {
    if (!isFinite(days) || days <= 0) return null;
    return new Date(Math.round((days - 25569) * 86400000));
}

export { FlpProject, prepareLib, colorCss, delphiDate, versionAtLeast, PROJECT_TEXT, CHANNEL_TYPES, TEXT_IDS };
