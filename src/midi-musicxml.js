// MIDI -> MusicXML, for the MIDI editor's sheet view (OpenSheetMusicDisplay
// engraves the result). A transcription, not an exact copy: onsets and
// lengths are rounded to a grid (16ths by default), each staff is one voice,
// so a note still sounding when the next chord starts is cut short there, and
// drum tracks are left out. Piano-like tracks spanning both hands get a grand
// staff, split at middle C.

const STEPS_SHARP = [['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0]];
const STEPS_FLAT = [['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0]];
const MAJOR_FIFTHS = { C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, 'C#': 7, F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6, Cb: -7 };
const MINOR_FIFTHS = { A: 0, E: 1, B: 2, 'F#': 3, 'C#': 4, 'G#': 5, 'D#': 6, 'A#': 7, D: -1, G: -2, C: -3, F: -4, Bb: -5, Eb: -6, Ab: -7 };

function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fifthsOf(ks) {
    if (!ks) return 0;
    const table = ks.scale === 'minor' ? MINOR_FIFTHS : MAJOR_FIFTHS;
    return table[ks.key] !== undefined ? table[ks.key] : 0;
}

// Note values a length (in grid units) is written with, dotted ones included,
// for a grid of `perQuarter` units to the quarter
function noteValues(perQuarter) {
    const out = [];
    for (const [q, type] of [[4, 'whole'], [2, 'half'], [1, 'quarter'], [1 / 2, 'eighth'], [1 / 4, '16th'], [1 / 8, '32nd'], [1 / 16, '64th']]) {
        const len = q * perQuarter;
        if (Number.isInteger(len * 1.5) && len * 1.5 >= 1) out.push([len * 1.5, type, true]);
        if (Number.isInteger(len) && len >= 1) out.push([len, type, false]);
    }
    return out.sort((a, b) => b[0] - a[0]);
}

// { midi: { header: {ppq, timeSignatures, keySignatures, tempos, name}, tracks: [{name, notes, instrument}] },
//   grid: units per quarter (4 = 16ths) }
function midiToMusicXML(midi, opts = {}) {
    const perQuarter = opts.grid || 4;
    const header = midi.header;
    const unit = header.ppq / perQuarter;
    const q = t => Math.round(t / unit);
    const values = noteValues(perQuarter);
    const fifths = fifthsOf((header.keySignatures || [])[0]);
    const spell = fifths < 0 ? STEPS_FLAT : STEPS_SHARP;

    const tracks = midi.tracks.filter(t => t.notes.length && !(t.instrument && t.instrument.percussion));
    // An empty file still gets a staff, of rests
    if (!tracks.length) tracks.push({ name: (midi.tracks[0] && midi.tracks[0].name) || 'Piano', notes: [] });
    let end = 0;
    for (const t of tracks) for (const n of t.notes) end = Math.max(end, q(n.ticks + n.durationTicks), q(n.ticks) + 1);

    // Measures from the time signatures
    const sigs = (header.timeSignatures && header.timeSignatures.length ? header.timeSignatures : [{ ticks: 0, timeSignature: [4, 4] }])
        .map(s => ({ at: q(s.ticks), beats: s.timeSignature[0], beatType: s.timeSignature[1] }))
        .sort((a, b) => a.at - b.at);
    const measures = [];
    for (let start = 0; start < Math.max(end, 1);) {
        let sig = sigs[0];
        for (const s of sigs) if (s.at <= start) sig = s;
        const len = Math.max(1, Math.round(sig.beats * perQuarter * 4 / sig.beatType));
        measures.push({ start, len, sig });
        start += len;
    }
    const total = measures[measures.length - 1].start + measures[measures.length - 1].len;

    const tempo = header.tempos && header.tempos.length ? Math.round(header.tempos[0].bpm) : 120;
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0">\n';
    const title = opts.title || header.name;
    if (title) xml += `<work><work-title>${esc(title)}</work-title></work>\n`;
    xml += '<part-list>\n';
    tracks.forEach((t, i) => {
        const name = t.name || (t.instrument && t.instrument.name) || `Track ${i + 1}`;
        xml += `<score-part id="P${i + 1}"><part-name>${esc(name)}</part-name></score-part>\n`;
    });
    xml += '</part-list>\n';

    tracks.forEach((t, ti) => {
        // The clef (or treble and bass) that needs the fewest ledger lines: how
        // far, on average, notes fall outside the staff (E4-F5 treble, G2-A3 bass)
        const out = (p, lo, hi) => (p < lo ? lo - p : p > hi ? p - hi : 0);
        const avg = f => t.notes.reduce((a, n) => a + f(n.midi), 0) / (t.notes.length || 1);
        const treble = avg(p => out(p, 64, 77)), bass = avg(p => out(p, 43, 57));
        const split = avg(p => (p >= 60 ? out(p, 64, 77) : out(p, 43, 57)));
        const lowShare = t.notes.filter(n => n.midi < 60).length / (t.notes.length || 1);
        const grand = split + 2 < Math.min(treble, bass) && lowShare > 0.05 && lowShare < 0.95;
        const staves = grand
            ? [{ clef: ['G', 2], notes: t.notes.filter(n => n.midi >= 60) }, { clef: ['F', 4], notes: t.notes.filter(n => n.midi < 60) }]
            : [{ clef: bass < treble ? ['F', 4] : ['G', 2], notes: t.notes }];
        // Each staff as a run of chords and rests
        const runs = staves.map(st => {
            const byOnset = new Map();
            for (const n of st.notes) {
                const on = q(n.ticks);
                const e = Math.max(on + 1, q(n.ticks + n.durationTicks));
                const c = byOnset.get(on) || { on, end: on, pitches: new Set() };
                c.end = Math.max(c.end, e);
                c.pitches.add(n.midi);
                byOnset.set(on, c);
            }
            const chords = [...byOnset.values()].sort((a, b) => a.on - b.on);
            const run = [];
            let cursor = 0;
            chords.forEach((c, i) => {
                if (c.on > cursor) run.push({ on: cursor, end: c.on, pitches: null });
                const next = chords[i + 1];
                const e = next ? Math.min(c.end, next.on) : c.end;
                run.push({ on: c.on, end: e, pitches: [...c.pitches].sort((a, b) => a - b) });
                cursor = e;
            });
            if (cursor < total) run.push({ on: cursor, end: total, pitches: null });
            return run;
        });

        xml += `<part id="P${ti + 1}">\n`;
        measures.forEach((m, mi) => {
            xml += `<measure number="${mi + 1}">\n`;
            const prev = measures[mi - 1];
            if (mi === 0 || prev.sig !== m.sig) {
                xml += `<attributes>`;
                if (mi === 0) xml += `<divisions>${perQuarter}</divisions><key><fifths>${fifths}</fifths></key>`;
                xml += `<time><beats>${m.sig.beats}</beats><beat-type>${m.sig.beatType}</beat-type></time>`;
                if (mi === 0) {
                    if (staves.length > 1) xml += `<staves>${staves.length}</staves>`;
                    staves.forEach((st, si) => { xml += `<clef number="${si + 1}"><sign>${st.clef[0]}</sign><line>${st.clef[1]}</line></clef>`; });
                }
                xml += `</attributes>\n`;
            }
            if (mi === 0 && ti === 0) {
                xml += `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${tempo}</per-minute></metronome></direction-type><sound tempo="${tempo}"/></direction>\n`;
            }
            runs.forEach((run, si) => {
                if (si > 0) xml += `<backup><duration>${m.len}</duration></backup>\n`;
                const staff = staves.length > 1 ? `<staff>${si + 1}</staff>` : '';
                const voice = si * 4 + 1;
                const mEnd = m.start + m.len;
                for (const ev of run) {
                    const a = Math.max(ev.on, m.start), b = Math.min(ev.end, mEnd);
                    if (a >= b) continue;
                    if (!ev.pitches && a === m.start && b === mEnd) {
                        xml += `<note><rest measure="yes"/><duration>${m.len}</duration><voice>${voice}</voice>${staff}</note>\n`;
                        continue;
                    }
                    // Split into writable values, tied
                    let pos = a;
                    while (pos < b) {
                        const [len, type, dot] = values.find(v => v[0] <= b - pos) || [b - pos, '16th', false];
                        const tieStop = ev.pitches && pos > ev.on;
                        const tieStart = ev.pitches && pos + len < ev.end;
                        const tail = `<voice>${voice}</voice><type>${type}</type>${dot ? '<dot/>' : ''}`;
                        if (!ev.pitches) {
                            xml += `<note><rest/><duration>${len}</duration>${tail}${staff}</note>\n`;
                        } else {
                            ev.pitches.forEach((p, k) => {
                                const [step, alter] = spell[p % 12];
                                const ties = (tieStop ? '<tie type="stop"/>' : '') + (tieStart ? '<tie type="start"/>' : '');
                                const tied = (tieStop ? '<tied type="stop"/>' : '') + (tieStart ? '<tied type="start"/>' : '');
                                xml += `<note>${k ? '<chord/>' : ''}<pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${Math.floor(p / 12) - 1}</octave></pitch>`
                                    + `<duration>${len}</duration>${ties}${tail}${staff}${tied ? `<notations>${tied}</notations>` : ''}</note>\n`;
                            });
                        }
                        pos += len;
                    }
                }
            });
            xml += `</measure>\n`;
        });
        xml += `</part>\n`;
    });
    xml += '</score-partwise>\n';
    return xml;
}

module.exports = { midiToMusicXML };
