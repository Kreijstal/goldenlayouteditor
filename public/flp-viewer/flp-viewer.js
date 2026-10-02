// FL Studio project viewer/editor, loaded on demand by src/flp-plugin.js.
// Reads and writes the .flp with @holzchopf/flp-file (from esm.sh) through
// flp-model.js, and shows the project in tabs: project info, channels,
// patterns (with a piano roll), playlist, mixer and the raw events.
import { FlpProject, colorCss, delphiDate, versionAtLeast } from './flp-model.js';

const FLP_FILE_URL = 'https://esm.sh/@holzchopf/flp-file@1.1.0?bundle';
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const PALETTE = ['#e8453c', '#2f6fde', '#1e9e5a', '#a347d1', '#e08a00', '#00a3b4', '#c2185b', '#5d7d2b'];
const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_HEX = 4096;

let _libPromise = null;
function loadLib() {
    if (!_libPromise) _libPromise = import(FLP_FILE_URL).catch(err => { _libPromise = null; throw err; });
    return _libPromise;
}

function installStyles() {
    if (document.getElementById('flp-viewer-style')) return;
    const style = document.createElement('style');
    style.id = 'flp-viewer-style';
    style.textContent = `
.flpv{height:100%;display:flex;flex-direction:column;background:#fff;color:#222;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:0}
.flpv-tabs{display:flex;gap:2px;padding:4px 8px 0;background:#f2f2f2;border-bottom:1px solid #ddd;flex-wrap:wrap}
.flpv-tabs button{border:1px solid transparent;border-bottom:none;background:none;padding:5px 12px;font:inherit;color:#555;cursor:pointer;border-radius:4px 4px 0 0}
.flpv-tabs button:hover{background:#e6e6e6}
.flpv-tabs button.active{background:#fff;border-color:#ddd;color:#111;font-weight:600;margin-bottom:-1px}
.flpv-body{flex:1;min-height:0;overflow:auto;padding:10px 12px}
.flpv h3{margin:14px 0 6px;font-size:13px;color:#444}
.flpv h3:first-child{margin-top:0}
.flpv-form{display:grid;grid-template-columns:max-content minmax(0,520px);gap:6px 12px;align-items:center}
.flpv-form label{color:#666}
.flpv-form input,.flpv-form textarea{font:inherit;padding:3px 6px;border:1px solid #ccc;border-radius:3px;width:100%;box-sizing:border-box}
.flpv-form textarea{min-height:70px;resize:vertical}
.flpv input.bad{border-color:#d33;background:#fff4f4}
.flpv input.edited,.flpv textarea.edited{background:#fffbe6}
.flpv-ro{color:#222}
.flpv table{border-collapse:collapse;font-size:12px}
.flpv th,.flpv td{padding:3px 8px;text-align:left;white-space:nowrap;border-bottom:1px solid #eee;vertical-align:middle}
.flpv th{font-weight:600;color:#666;background:#f6f6f6;position:sticky;top:0;z-index:1}
.flpv td.num{text-align:right;font-variant-numeric:tabular-nums}
.flpv td input{font:inherit;padding:1px 4px;border:1px solid #ccc;border-radius:3px;width:16em}
.flpv tr.sel{background:#dde8f8}
.flpv tr.click{cursor:pointer}
.flpv tr.click:hover{background:#eef3fb}
.flpv tr.click.sel:hover{background:#d3e1f6}
.flpv-sw{display:inline-block;width:12px;height:12px;border-radius:2px;vertical-align:-2px;border:1px solid rgba(0,0,0,.15)}
.flpv-muted{color:#999}
.flpv-path{max-width:28em;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left}
.flpv-roll{margin-top:10px;border:1px solid #ddd;overflow:auto;max-height:420px;background:#fbfbfb}
.flpv-roll svg,.flpv-tl svg{display:block}
.flpv-legend{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:6px;font-size:12px;color:#555}
.flpv-tl{border:1px solid #ddd;overflow:auto;max-height:calc(100% - 40px);background:#fbfbfb}
.flpv-mixer{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:8px}
.flpv-ins{border:1px solid #ddd;border-radius:4px;padding:6px 8px;border-top-width:4px;background:#fcfcfc}
.flpv-ins .head{display:flex;gap:6px;align-items:center;margin-bottom:4px}
.flpv-ins .head b{white-space:nowrap}
.flpv-ins .head input{flex:1;min-width:0;font:inherit;padding:1px 4px;border:1px solid #ccc;border-radius:3px}
.flpv-ins .row{color:#555;font-size:12px;margin:2px 0}
.flpv-ins ol{margin:4px 0 0;padding-left:0;list-style:none;font-size:12px}
.flpv-ins li{padding:1px 0}
.flpv-ins li .slot{display:inline-block;width:1.6em;color:#999;text-align:right;margin-right:6px}
.flpv-bar{display:flex;gap:10px;align-items:center;margin-bottom:8px;flex-wrap:wrap}
.flpv-bar input[type=search]{font:inherit;padding:3px 6px;border:1px solid #ccc;border-radius:3px;width:18em}
.flpv-bar select{font:inherit}
.flpv-events{display:flex;gap:10px;min-height:0;height:calc(100% - 36px)}
.flpv-events .list{flex:1 1 60%;overflow:auto;min-width:0;border:1px solid #eee}
.flpv-events .detail{flex:1 1 40%;overflow:auto;min-width:0;border:1px solid #eee;padding:6px 8px;font-size:12px}
.flpv-events td.val{max-width:28em;overflow:hidden;text-overflow:ellipsis}
.flpv pre.hex{font:11px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;margin:6px 0 0;white-space:pre}
.flpv-note{color:#777;font-size:12px;margin:6px 0}
.flpv-status{padding:20px;color:#555}
.flpv-status.error{color:#a33}
`;
    document.head.appendChild(style);
}

// Small DOM builder: h('td', { class: 'num' }, 'text', child, ...)
function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style') el.style.cssText = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k in el && typeof v !== 'string') el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
        if (c === null || c === undefined || c === false) continue;
        el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
    }
    return el;
}

function svg(tag, attrs, text) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    if (text !== undefined) el.textContent = text;
    return el;
}

function swatch(color) {
    const css = colorCss(color);
    return css ? h('span', { class: 'flpv-sw', style: `background:${css}`, title: css }) : '';
}

function pct(v, signed) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    const p = Math.round(v * 100);
    if (!signed) return p + '%';
    return p === 0 ? 'C' : (p < 0 ? `${-p}% L` : `${p}% R`);
}

function noteName(key) {
    return NOTE_NAMES[key % 12] + Math.floor(key / 12);
}

function hexDump(bytes, limit) {
    const n = Math.min(bytes.length, limit);
    const lines = [];
    for (let o = 0; o < n; o += 16) {
        const row = bytes.subarray(o, Math.min(o + 16, n));
        const hex = [...row].map(b => b.toString(16).padStart(2, '0')).join(' ');
        const asc = [...row].map(b => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
        lines.push(o.toString(16).padStart(6, '0') + '  ' + hex.padEnd(48) + ' ' + asc);
    }
    if (bytes.length > n) lines.push(`… ${bytes.length - n} more bytes`);
    return lines.join('\n');
}

function hexShort(bytes, n) {
    const s = [...bytes.subarray(0, n)].map(b => b.toString(16).padStart(2, '0')).join(' ');
    return bytes.length > n ? s + ' …' : s;
}

function formatDuration(days) {
    if (!isFinite(days) || days <= 0) return null;
    const mins = Math.round(days * 24 * 60);
    return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

class FlpViewer {
    constructor(root, project, opts) {
        this.root = root;
        this.p = project;
        this.readOnly = !!opts.readOnly;
        this.onChange = opts.onChange || (() => {});
        this.tab = 'project';
        this.selPattern = null;
        this.selArrangement = 0;
        this.selEvent = null;
        this.showAllInserts = false;
        this.eventFilter = '';

        root.textContent = '';
        root.classList.add('flpv');
        this.tabsEl = h('div', { class: 'flpv-tabs' });
        this.body = h('div', { class: 'flpv-body' });
        root.append(this.tabsEl, this.body);
        this.render();
    }

    _changed() {
        this.onChange();
    }

    render() {
        const p = this.p;
        const tabs = [
            ['project', 'Project'],
            ['channels', `Channels (${p.channels.length})`],
            ['patterns', `Patterns (${p.patterns.length})`],
            ['playlist', 'Playlist'],
            ['mixer', `Mixer (${this._inserts().length})`],
            ['events', `Events (${p.events.length})`],
        ];
        this.tabsEl.textContent = '';
        for (const [id, label] of tabs) {
            this.tabsEl.appendChild(h('button', { type: 'button', class: id === this.tab ? 'active' : '', 'data-tab': id,
                onclick: () => { this.tab = id; this.render(); } }, label));
        }
        const scroll = this.body.scrollTop;
        this.body.textContent = '';
        this['_render_' + this.tab](this.body);
        this.body.scrollTop = scroll;
    }

    // --- Project ---

    _render_project(el) {
        const p = this.p;
        const i = p.info;
        const form = h('div', { class: 'flpv-form' });
        const field = (label, input) => form.append(h('label', {}, label), input);
        const ro = (label, value) => { if (value !== null && value !== undefined && value !== '') field(label, h('div', { class: 'flpv-ro' }, String(value))); };
        const text = (label, key, multi) => {
            const input = h(multi ? 'textarea' : 'input', { type: multi ? null : 'text', 'data-field': key, disabled: this.readOnly });
            input.value = i[key] || '';
            input.addEventListener('input', () => {
                p.setProjectText(key, input.value);
                input.classList.add('edited');
                this._changed();
            });
            field(label, input);
        };
        el.appendChild(h('h3', {}, 'Project info'));
        text('Title', 'title');
        text('Author', 'author');
        text('Genre', 'genre');
        const tempo = h('input', { type: 'number', step: '0.001', min: '10', max: '999', 'data-field': 'tempo', disabled: this.readOnly || i.tempo === null });
        tempo.value = i.tempo === null ? '' : String(+i.tempo.toFixed(3));
        tempo.addEventListener('input', () => {
            try {
                p.setTempo(parseFloat(tempo.value));
                tempo.classList.remove('bad');
                tempo.classList.add('edited');
                this._changed();
            } catch (_) {
                tempo.classList.add('bad');
            }
        });
        field('Tempo (BPM)', tempo);
        text('Comments', 'comments', true);
        text('URL', 'url');
        el.appendChild(form);
        if (i.commentsRtf) {
            el.appendChild(h('details', {}, h('summary', { class: 'flpv-note' }, 'Comments as RTF (as older FL Studio versions keep them)'),
                h('pre', { class: 'hex', style: 'white-space:pre-wrap' }, i.commentsRtf)));
        }

        el.appendChild(h('h3', {}, 'File'));
        const f2 = h('div', { class: 'flpv-form' });
        el.appendChild(f2);
        const ro2 = (label, value) => { if (value !== null && value !== undefined && value !== '') f2.append(h('label', {}, label), h('div', { class: 'flpv-ro' }, String(value))); };
        ro2('FL Studio version', p.versionString + (i.build && !p.versionString.endsWith('.' + i.build) ? ` (build ${i.build})` : ''));
        ro2('File type', p.formatName);
        ro2('PPQ', p.ppq);
        ro2('Time signature', i.tsNum ? `${i.tsNum}/${i.tsDen}` : null);
        const created = delphiDate(i.created);
        ro2('Created', created ? created.toLocaleString() : null);
        ro2('Time spent', formatDuration(i.timeSpent));
        ro2('Data folder', i.dataPath);
        ro2('Channels', `${p.channels.length}${p.file.header.channelCnt !== p.channels.length ? ` (header says ${p.file.header.channelCnt})` : ''}`);
        ro2('Patterns', p.patterns.length);
        ro2('Mixer inserts', p.inserts.length);
        ro2('Channel groups', p.groups.join(', '));
        ro2('Events', p.events.length);
        void ro;
    }

    // --- Channels ---

    _render_channels(el) {
        const p = this.p;
        if (!p.channels.length) { el.appendChild(h('div', { class: 'flpv-note' }, 'No channels.')); return; }
        const table = h('table', {}, h('thead', {}, h('tr', {},
            ['#', '', 'Name', 'Type', 'Plugin', 'Sample', 'Volume', 'Pan', 'Insert', 'On'].map(t => h('th', {}, t)))));
        const tbody = h('tbody');
        for (const ch of p.channels) {
            const name = h('input', { type: 'text', 'data-channel': ch.iid, disabled: this.readOnly });
            name.value = ch.name;
            name.addEventListener('input', () => {
                p.setChannelName(ch.iid, name.value);
                name.classList.add('edited');
                this._changed();
            });
            const auto = ch.type === 5;
            tbody.appendChild(h('tr', {},
                h('td', { class: 'num' }, ch.iid),
                h('td', {}, swatch(ch.color)),
                h('td', {}, name),
                h('td', {}, ch.typeName),
                h('td', {}, ch.internalName || h('span', { class: 'flpv-muted' }, '—')),
                h('td', { class: 'flpv-path', title: ch.samplePath || '' }, ch.samplePath ? ch.samplePath : h('span', { class: 'flpv-muted' }, '—')),
                h('td', { class: 'num' }, auto ? '' : pct(ch.volume)),
                h('td', { class: 'num' }, auto ? '' : pct(ch.pan, true)),
                h('td', { class: 'num' }, ch.insert === null || ch.insert < 0 ? '—' : this._insertLabel(ch.insert)),
                h('td', {}, ch.enabled ? '✓' : h('span', { class: 'flpv-muted' }, 'off'))));
        }
        table.appendChild(tbody);
        el.appendChild(table);
    }

    // --- Patterns ---

    _patternLength(pat) {
        const bar = this.p.ppq * 4;
        return Math.max(pat.length || 0, Math.ceil(pat.noteEnd / bar) * bar, pat.notes.length ? bar : 0);
    }

    _ticks(t) {
        const ppq = this.p.ppq;
        const i = this.p.info;
        const beatsPerBar = (i.tsNum || 4) * 4 / (i.tsDen || 4);
        const beats = t / ppq;
        const bars = Math.floor(beats / beatsPerBar);
        const rest = +(beats - bars * beatsPerBar).toFixed(2);
        const barText = `${bars} bar${bars === 1 ? '' : 's'}`;
        return rest ? `${bars ? barText + ' ' : ''}${rest} beat${rest === 1 ? '' : 's'}` : barText;
    }

    _render_patterns(el) {
        const p = this.p;
        if (!p.patterns.length) { el.appendChild(h('div', { class: 'flpv-note' }, 'No patterns.')); return; }
        if (this.selPattern === null || !p.patterns.some(x => x.num === this.selPattern)) {
            this.selPattern = (p.patterns.find(x => x.notes.length) || p.patterns[0]).num;
        }
        const table = h('table', {}, h('thead', {}, h('tr', {}, ['#', '', 'Name', 'Length', 'Notes', 'Channels'].map(t => h('th', {}, t)))));
        const tbody = h('tbody');
        for (const pat of p.patterns) {
            const name = h('input', { type: 'text', 'data-pattern': pat.num, disabled: this.readOnly, placeholder: `Pattern ${pat.num}` });
            name.value = pat.name;
            name.addEventListener('click', e => e.stopPropagation());
            name.addEventListener('input', () => {
                p.setPatternName(pat.num, name.value);
                name.classList.add('edited');
                this._changed();
            });
            const chans = [...new Set(pat.notes.map(n => n.channel))];
            const tr = h('tr', { class: 'click' + (pat.num === this.selPattern ? ' sel' : ''), onclick: () => { this.selPattern = pat.num; this.render(); } },
                h('td', { class: 'num' }, pat.num),
                h('td', {}, swatch(pat.color)),
                h('td', {}, name),
                h('td', { class: 'num' }, this._ticks(this._patternLength(pat))),
                h('td', { class: 'num' }, pat.notes.length),
                h('td', {}, chans.map(c => (p.channelById.get(c) || {}).name || `#${c}`).join(', ')));
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        el.appendChild(table);
        const pat = p.patterns.find(x => x.num === this.selPattern);
        el.appendChild(h('h3', {}, `Piano roll: ${pat.name || 'Pattern ' + pat.num}`));
        this._pianoRoll(el, pat);
    }

    _channelColor(iid, index) {
        const ch = this.p.channelById.get(iid);
        const css = ch && colorCss(ch.color);
        // FL's default channel colours are all grey; tell channels apart by palette then
        return css && !/^#(5c656a|485156|414548|614f51|636c71)$/.test(css) ? css : PALETTE[index % PALETTE.length];
    }

    _pianoRoll(el, pat) {
        if (!pat.notes.length) { el.appendChild(h('div', { class: 'flpv-note' }, 'This pattern has no notes.')); return; }
        const ppq = this.p.ppq;
        const len = this._patternLength(pat);
        const keys = pat.notes.map(n => n.key);
        const lo = Math.max(0, Math.min(...keys) - 2), hi = Math.min(131, Math.max(...keys) + 2);
        const rowH = 9, gutter = 40, pxBeat = 40;
        const W = gutter + len / ppq * pxBeat, H = (hi - lo + 1) * rowH;
        const s = svg('svg', { width: W, height: H, class: 'flpv-roll-svg' });
        for (let k = lo; k <= hi; k++) {
            const y = (hi - k) * rowH;
            const black = [1, 3, 6, 8, 10].includes(k % 12);
            s.appendChild(svg('rect', { x: gutter, y, width: W - gutter, height: rowH, fill: black ? '#eef0f3' : '#fafbfc' }));
            if (k % 12 === 0) {
                s.appendChild(svg('line', { x1: 0, x2: W, y1: y + rowH, y2: y + rowH, stroke: '#cdd3da' }));
                s.appendChild(svg('text', { x: 4, y: y + rowH - 1, 'font-size': 9, fill: '#666' }, noteName(k)));
            }
        }
        const beatsPerBar = (this.p.info.tsNum || 4) * 4 / (this.p.info.tsDen || 4);
        for (let b = 0; b * ppq <= len; b++) {
            const x = gutter + b * pxBeat;
            const bar = b % beatsPerBar === 0;
            s.appendChild(svg('line', { x1: x, x2: x, y1: 0, y2: H, stroke: bar ? '#9aa3ad' : '#dde1e6' }));
        }
        const chans = [...new Set(pat.notes.map(n => n.channel))];
        for (const n of pat.notes) {
            const color = this._channelColor(n.channel, chans.indexOf(n.channel));
            const ch = this.p.channelById.get(n.channel);
            const r = svg('rect', { x: gutter + n.pos / ppq * pxBeat, y: (hi - n.key) * rowH + 1, width: Math.max(2, n.length / ppq * pxBeat - 1), height: rowH - 2,
                rx: 1.5, fill: color, 'fill-opacity': 0.45 + 0.55 * Math.min(1, n.velocity / 128), stroke: 'rgba(0,0,0,.35)', 'stroke-width': 0.5, class: 'flpv-note-rect' });
            r.appendChild(svg('title', {}, `${noteName(n.key)}  ${(ch && ch.name) || '#' + n.channel}\nat ${this._ticks(n.pos)}  length ${n.length} ticks  velocity ${n.velocity}`));
            s.appendChild(r);
        }
        el.appendChild(h('div', { class: 'flpv-roll' }, s));
        el.appendChild(h('div', { class: 'flpv-legend' }, chans.map((c, i) => h('span', {},
            h('span', { class: 'flpv-sw', style: `background:${this._channelColor(c, i)}` }), ' ', (this.p.channelById.get(c) || {}).name || `#${c}`))));
    }

    // --- Playlist ---

    _render_playlist(el) {
        const p = this.p;
        const arrs = p.arrangements;
        if (!arrs.length) { el.appendChild(h('div', { class: 'flpv-note' }, 'No playlist.')); return; }
        if (this.selArrangement >= arrs.length) this.selArrangement = 0;
        const a = arrs[this.selArrangement];
        const bar = h('div', { class: 'flpv-bar' });
        if (arrs.length > 1) {
            const sel = h('select', { onchange: e => { this.selArrangement = +e.target.value; this.render(); } },
                arrs.map((x, i) => h('option', { value: i, selected: i === this.selArrangement }, x.name || `Arrangement ${i + 1}`)));
            bar.append('Arrangement ', sel);
        } else if (a.name) {
            bar.append(h('b', {}, a.name));
        }
        bar.append(h('span', { class: 'flpv-muted' }, `${a.items.length} clip${a.items.length === 1 ? '' : 's'}` +
            (a.markers.length ? `, ${a.markers.length} time marker${a.markers.length === 1 ? '' : 's'}` : '') +
            (a.hidden ? `, ${a.hidden} not shown` : '')));
        el.appendChild(bar);
        if (!a.items.length && !a.markers.length) { el.appendChild(h('div', { class: 'flpv-note' }, 'The playlist is empty.')); return; }

        const ppq = p.ppq;
        const barTicks = ppq * (p.info.tsNum || 4) * 4 / (p.info.tsDen || 4);
        const end = Math.max(barTicks * 4, ...a.items.map(it => it.pos + it.length), ...a.markers.map(m => m.pos));
        const bars = Math.ceil(end / barTicks) + 1;
        const pxBar = Math.max(14, Math.min(60, 1100 / bars));
        const labelW = 150, rowH = 22, rulerH = 18, markerH = a.markers.length ? 16 : 0;
        // Rows: FL 9's pattern rows first, then the tracks with clips, in order
        const rowKey = it => (it.patternRow ? 'p' : 't') + it.track;
        const used = [...new Set(a.items.map(rowKey))].sort((x, y) => (x[0] === y[0] ? x.slice(1) - y.slice(1) : x[0] === 'p' ? -1 : 1));
        const W = labelW + bars * pxBar, H = rulerH + markerH + used.length * rowH;
        const s = svg('svg', { width: W, height: H, class: 'flpv-tl-svg' });
        const x0 = labelW;
        for (let b = 0; b <= bars; b++) {
            const x = x0 + b * pxBar;
            s.appendChild(svg('line', { x1: x, x2: x, y1: rulerH - 4, y2: H, stroke: b % 4 === 0 ? '#c3c9d0' : '#e4e7eb' }));
            if (b < bars && (pxBar >= 24 || b % 4 === 0)) s.appendChild(svg('text', { x: x + 2, y: rulerH - 6, 'font-size': 10, fill: '#666' }, b + 1));
        }
        for (const m of a.markers) {
            const x = x0 + m.pos / barTicks * pxBar;
            const label = m.name || (m.kind === 8 && m.num ? `${m.num}/${m.den}` : '');
            s.appendChild(svg('line', { x1: x, x2: x, y1: rulerH, y2: H, stroke: '#e08a00', 'stroke-dasharray': '3 2' }));
            s.appendChild(svg('text', { x: x + 2, y: rulerH + 12, 'font-size': 10, fill: '#a35f00' }, label));
        }
        used.forEach((key, row) => {
            const y = rulerH + markerH + row * rowH;
            const t = +key.slice(1);
            const pat = key[0] === 'p' && p.patterns.find(x2 => x2.num === t);
            const tr = key[0] === 't' ? (a.tracks || [])[t] : { name: pat ? pat.name || `Pattern ${t}` : `Pattern ${t}` };
            s.appendChild(svg('rect', { x: 0, y, width: labelW, height: rowH, fill: row % 2 ? '#f1f2f4' : '#f7f8f9' }));
            s.appendChild(svg('line', { x1: 0, x2: W, y1: y + rowH, y2: y + rowH, stroke: '#e4e7eb' }));
            s.appendChild(svg('text', { x: 6, y: y + 15, 'font-size': 11, fill: '#333' }, (tr && tr.name) || `Track ${t + 1}`));
        });
        for (const it of a.items) {
            const row = used.indexOf(rowKey(it));
            const y = rulerH + markerH + row * rowH + 2;
            const x = x0 + it.pos / barTicks * pxBar;
            const w = Math.max(3, it.length / barTicks * pxBar - 1);
            let label, color;
            if (it.pattern !== null) {
                const pat = p.patterns.find(x2 => x2.num === it.pattern);
                label = (pat && pat.name) || `Pattern ${it.pattern}`;
                color = pat && colorCss(pat.color);
            } else {
                const ch = p.channelById.get(it.channel);
                label = (ch && ch.name) || `Channel ${it.channel}`;
                color = ch && colorCss(ch.color);
            }
            if (!color || /^#(485156|5c656a|636c71)$/.test(color)) color = it.pattern !== null ? '#6c8ebf' : '#5aa36b';
            const g = svg('g', { class: 'flpv-clip' });
            g.appendChild(svg('rect', { x, y, width: w, height: rowH - 4, rx: 2, fill: color, 'fill-opacity': 0.85, stroke: 'rgba(0,0,0,.3)' }));
            if (w > 20) {
                const clip = 'c' + Math.random().toString(36).slice(2);
                const cp = svg('clipPath', { id: clip });
                cp.appendChild(svg('rect', { x, y, width: w - 2, height: rowH - 4 }));
                g.appendChild(cp);
                g.appendChild(svg('text', { x: x + 3, y: y + 13, 'font-size': 10, fill: '#fff', 'clip-path': `url(#${clip})` }, label));
            }
            g.appendChild(svg('title', {}, `${label}\nbar ${(it.pos / barTicks + 1).toFixed(2)}, ${(it.length / barTicks).toFixed(2)} bars`));
            s.appendChild(g);
        }
        el.appendChild(h('div', { class: 'flpv-tl' }, s));
    }

    // --- Mixer ---

    _insertLabel(i) {
        if (i === 0) return 'Master';
        // FL 9-11: 99 inserts and then the 4 send tracks
        if (!versionAtLeast(this.p.version, 12) && i >= 100 && i <= 103) return `Send ${i - 99}`;
        return `Insert ${i}`;
    }

    _inserts() {
        const p = this.p;
        const fed = new Set(p.channels.map(c => c.insert));
        return p.inserts.filter(x => x.index === 0 || x.name || x.slots.length || fed.has(x.index)
            || p.inserts.some(o => o !== x && o.routes.includes(x.index) && o.routes.length && (o.name || o.slots.length)));
    }

    _render_mixer(el) {
        const p = this.p;
        const list = this.showAllInserts ? p.inserts : this._inserts();
        const toggle = h('input', { type: 'checkbox', checked: this.showAllInserts, onchange: e => { this.showAllInserts = e.target.checked; this.render(); } });
        el.appendChild(h('div', { class: 'flpv-bar' }, h('label', {}, toggle, ` Show all ${p.inserts.length} inserts`),
            h('span', { class: 'flpv-muted' }, this.showAllInserts ? '' : 'Showing the master and inserts that are named, have effects or get audio')));
        const grid = h('div', { class: 'flpv-mixer' });
        for (const ins of list) {
            const name = h('input', { type: 'text', 'data-insert': ins.index, disabled: this.readOnly, placeholder: this._insertLabel(ins.index) });
            name.value = ins.name;
            name.addEventListener('input', () => {
                p.setInsertName(ins.index, name.value);
                name.classList.add('edited');
                this._changed();
            });
            const css = colorCss(ins.color);
            const from = p.channels.filter(c => c.insert === ins.index);
            const routes = ins.routes.filter(r => r !== ins.index);
            const card = h('div', { class: 'flpv-ins', style: css ? `border-top-color:${css}` : '' },
                h('div', { class: 'head' }, h('b', {}, this._insertLabel(ins.index)), name),
                (ins.volume !== undefined || ins.pan !== undefined) ? h('div', { class: 'row' }, `Volume ${pct(ins.volume)} · Pan ${pct(ins.pan, true)}`) : null,
                ins.index !== 0 ? h('div', { class: 'row' }, 'Sends to: ', routes.length ? routes.map(r => this._insertLabel(r)).join(', ') : h('span', { class: 'flpv-muted' }, 'nothing')) : null,
                from.length ? h('div', { class: 'row' }, 'From: ', from.map(c => c.name || `#${c.iid}`).join(', ')) : null,
                ins.slots.length ? h('ol', {}, ins.slots.map(s => h('li', {}, h('span', { class: 'slot' }, s.slot + 1),
                    s.name || s.internalName,
                    s.name && s.internalName && s.name !== s.internalName ? h('span', { class: 'flpv-muted' }, ` (${s.internalName})`) : null,
                    s.enabled === false ? h('span', { class: 'flpv-muted' }, ' · off') : null)))
                    : h('div', { class: 'row flpv-muted' }, 'No effects'));
            grid.appendChild(card);
        }
        el.appendChild(grid);
    }

    // --- Raw events ---

    _render_events(el) {
        const rows = this.p.rawEvents();
        const filter = h('input', { type: 'search', placeholder: 'Filter by id, name or text', value: this.eventFilter });
        const count = h('span', { class: 'flpv-muted' });
        el.appendChild(h('div', { class: 'flpv-bar' }, filter, count));
        const wrap = h('div', { class: 'flpv-events' });
        const list = h('div', { class: 'list' });
        const detail = h('div', { class: 'detail' }, h('div', { class: 'flpv-muted' }, 'Select an event to see its bytes.'));
        wrap.append(list, detail);
        el.appendChild(wrap);

        const showDetail = row => {
            detail.textContent = '';
            detail.append(h('div', {}, h('b', {}, `#${row.index} ${row.name !== 'unknown' ? row.name : 'id ' + row.id}`)),
                h('div', { class: 'flpv-muted' }, `id ${row.id} · offset 0x${row.offset.toString(16)} · ${row.size} byte${row.size === 1 ? '' : 's'}`));
            if (row.kind === 'text') detail.append(h('pre', { class: 'hex', style: 'white-space:pre-wrap' }, JSON.stringify(row.value)));
            if (row.kind === 'number') detail.append(h('div', {}, `Value ${row.value} (0x${row.value.toString(16)})`));
            detail.append(h('pre', { class: 'hex' }, hexDump(row.bytes, MAX_HEX)));
        };
        const draw = () => {
            const q = this.eventFilter.trim().toLowerCase();
            const shown = q ? rows.filter(r => String(r.id) === q || r.name.toLowerCase().includes(q) || (r.kind === 'text' && r.value.toLowerCase().includes(q))) : rows;
            count.textContent = `${shown.length} of ${rows.length} events`;
            const table = h('table', {}, h('thead', {}, h('tr', {}, ['#', 'Offset', 'Id', 'Name', 'Size', 'Value'].map(t => h('th', {}, t)))));
            const tbody = h('tbody');
            for (const r of shown) {
                const val = r.kind === 'text' ? JSON.stringify(r.value) : r.kind === 'number' ? String(r.value) : hexShort(r.bytes, 16);
                tbody.appendChild(h('tr', { class: 'click' + (r.index === this.selEvent ? ' sel' : ''), 'data-index': r.index, onclick: e => {
                    this.selEvent = r.index;
                    list.querySelectorAll('tr.sel').forEach(x => x.classList.remove('sel'));
                    e.currentTarget.classList.add('sel');
                    showDetail(r);
                } },
                h('td', { class: 'num' }, r.index),
                h('td', { class: 'num' }, '0x' + r.offset.toString(16)),
                h('td', { class: 'num' }, r.id),
                h('td', {}, r.name === 'unknown' ? h('span', { class: 'flpv-muted' }, '?') : r.name),
                h('td', { class: 'num' }, r.size),
                h('td', { class: 'val', title: r.kind === 'text' ? r.value : '' }, val)));
            }
            table.appendChild(tbody);
            list.textContent = '';
            list.appendChild(table);
        };
        filter.addEventListener('input', () => { this.eventFilter = filter.value; draw(); });
        draw();
        if (this.selEvent !== null && rows[this.selEvent]) showDetail(rows[this.selEvent]);
    }
}

// Opens the project in `root`. Returns { project, getBytes(), destroy() }.
async function mountFlpViewer(root, { bytes, readOnly, onChange }) {
    installStyles();
    const lib = await loadLib();
    const project = new FlpProject(lib, bytes);
    const viewer = new FlpViewer(root, project, { readOnly, onChange });
    return {
        project,
        viewer,
        getBytes: () => project.toBytes(),
        destroy: () => { root.textContent = ''; },
    };
}

export { mountFlpViewer, loadLib, FLP_FILE_URL };
