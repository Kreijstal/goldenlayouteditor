// --- GPX Plugin ---
// Shows GPS Exchange Format files (.gpx) on an OpenStreetMap map with Leaflet
// (from esm.sh): tracks and routes as lines, waypoints as dots with their
// names. Below the map, each track and route with its length, climb and
// descent, and, when the points carry times, start, duration and moving
// speed; and the selected one's elevation profile, which moves a marker
// along the line on the map when hovered. The GPX is read with DOMParser.
const { registerPlugin } = require('./plugins');
const { resolveFileUrl } = require('./archive-fallback');

const LEAFLET_VERSION = '1.9.4';
const LEAFLET_URL = `https://esm.sh/leaflet@${LEAFLET_VERSION}`;
const LEAFLET_CSS_URL = `https://esm.sh/leaflet@${LEAFLET_VERSION}/dist/leaflet.css`;
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const GPX_RE = /\.gpx$/i;
const COLORS = ['#e8453c', '#2f6fde', '#1e9e5a', '#a347d1', '#e08a00', '#00a3b4'];
const EARTH_RADIUS_M = 6371008.8;
// Elevation changes smaller than this are taken as GPS noise when adding up climb
const CLIMB_THRESHOLD_M = 3;
// Gaps between points longer than this don't count as moving time
const PAUSE_S = 120;
let _ctx = null;

let _leafletPromise = null;
function ensureLeafletLoaded() {
    if (!_leafletPromise) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = LEAFLET_CSS_URL;
        document.head.appendChild(link);
        _leafletPromise = import(LEAFLET_URL).then(mod => mod.default || mod).catch(err => {
            _leafletPromise = null;
            throw err;
        });
    }
    return _leafletPromise;
}

function installStyles() {
    if (document.getElementById('gpx-viewer-style')) return;
    const style = document.createElement('style');
    style.id = 'gpx-viewer-style';
    style.textContent = `
.gpx-viewer-root{height:100%;display:flex;flex-direction:column;background:#fff;color:#222;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.gpx-map{flex:1 1 60%;min-height:120px}
.gpx-panel{flex:0 0 auto;max-height:45%;overflow:auto;border-top:1px solid #ddd;background:#fafafa}
.gpx-head{padding:6px 10px;color:#555;border-bottom:1px solid #eee}
.gpx-head b{color:#222}
.gpx-items{width:100%;border-collapse:collapse}
.gpx-items th,.gpx-items td{padding:4px 10px;text-align:left;white-space:nowrap;border-bottom:1px solid #eee}
.gpx-items th{font-weight:600;color:#666;background:#f2f2f2;position:sticky;top:0}
.gpx-items td.num{text-align:right;font-variant-numeric:tabular-nums}
.gpx-items tr.gpx-item{cursor:pointer}
.gpx-items tr.gpx-item:hover{background:#eef3fb}
.gpx-items tr.gpx-item.selected{background:#dde8f8}
.gpx-swatch{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.gpx-profile{position:relative;height:130px;padding:4px 10px 6px}
.gpx-profile svg{display:block}
.gpx-profile .gpx-tip{position:absolute;top:6px;pointer-events:none;background:rgba(255,255,255,.92);border:1px solid #ccc;border-radius:3px;padding:2px 5px;font-size:12px;white-space:nowrap}
.gpx-profile-none{padding:8px 10px;color:#888}
.gpx-wpt-label{background:rgba(255,255,255,.85);border:none;box-shadow:none;padding:0 3px;font-size:11px}
.gpx-status{padding:20px;color:#555}
.gpx-status.error{color:#a33}
`;
    document.head.appendChild(style);
}

// --- Reading the GPX ---

// Child elements by local name (GPX 1.0 and 1.1 use different namespaces)
function kids(el, name) {
    return [...el.children].filter(c => c.localName === name);
}

function childText(el, name) {
    const c = kids(el, name)[0];
    return c ? c.textContent.trim() : '';
}

function readPoint(el) {
    const lat = parseFloat(el.getAttribute('lat'));
    const lon = parseFloat(el.getAttribute('lon'));
    if (!isFinite(lat) || !isFinite(lon)) return null;
    const ele = parseFloat(childText(el, 'ele'));
    const t = Date.parse(childText(el, 'time'));
    return { lat, lon, ele: isFinite(ele) ? ele : null, time: isFinite(t) ? t : null, name: childText(el, 'name') };
}

function parseGpx(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const err = doc.getElementsByTagName('parsererror')[0];
    if (err) throw new Error('not well-formed XML: ' + err.textContent.trim().split('\n')[0]);
    const gpx = doc.documentElement;
    if (gpx.localName !== 'gpx') throw new Error(`the root element is <${gpx.localName}>, not <gpx>`);
    const meta = kids(gpx, 'metadata')[0];
    const items = [];
    // A track is one line per segment; its stats run over all segments
    for (const trk of kids(gpx, 'trk')) {
        const segments = kids(trk, 'trkseg').map(seg => kids(seg, 'trkpt').map(readPoint).filter(Boolean)).filter(s => s.length);
        items.push({ kind: 'track', name: childText(trk, 'name'), type: childText(trk, 'type'), segments });
    }
    for (const rte of kids(gpx, 'rte')) {
        const pts = kids(rte, 'rtept').map(readPoint).filter(Boolean);
        items.push({ kind: 'route', name: childText(rte, 'name'), type: childText(rte, 'type'), segments: pts.length ? [pts] : [] });
    }
    const waypoints = kids(gpx, 'wpt').map(el => {
        const p = readPoint(el);
        if (p) p.desc = childText(el, 'desc') || childText(el, 'cmt');
        return p;
    }).filter(Boolean);
    return {
        name: (meta && childText(meta, 'name')) || childText(gpx, 'name'),
        creator: gpx.getAttribute('creator') || '',
        items,
        waypoints,
    };
}

// --- Track info ---

function haversine(a, b) {
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Distance along the item for every point, plus the totals
function measure(item) {
    const profile = [];   // { dist, ele, point } over all segments
    let dist = 0, climb = 0, descent = 0, moving = 0;
    let minEle = Infinity, maxEle = -Infinity;
    let start = null, end = null;
    for (const seg of item.segments) {
        let ref = null;   // last elevation counted for climb
        seg.forEach((p, i) => {
            if (i > 0) {
                const prev = seg[i - 1];
                dist += haversine(prev, p);
                if (prev.time !== null && p.time !== null) {
                    const dt = (p.time - prev.time) / 1000;
                    if (dt > 0 && dt <= PAUSE_S) moving += dt;
                }
            }
            if (p.time !== null) {
                if (start === null || p.time < start) start = p.time;
                if (end === null || p.time > end) end = p.time;
            }
            if (p.ele !== null) {
                minEle = Math.min(minEle, p.ele);
                maxEle = Math.max(maxEle, p.ele);
                if (ref === null) ref = p.ele;
                else if (Math.abs(p.ele - ref) >= CLIMB_THRESHOLD_M) {
                    if (p.ele > ref) climb += p.ele - ref; else descent += ref - p.ele;
                    ref = p.ele;
                }
            }
            profile.push({ dist, ele: p.ele, point: p });
        });
    }
    const points = profile.length;
    const hasEle = minEle <= maxEle;
    return {
        points, dist, profile,
        climb: hasEle ? climb : null, descent: hasEle ? descent : null,
        minEle: hasEle ? minEle : null, maxEle: hasEle ? maxEle : null,
        start, end, duration: start !== null && end > start ? (end - start) / 1000 : null,
        moving: moving > 0 ? moving : null,
    };
}

function fmtDist(m) {
    return m >= 1000 ? (m / 1000).toFixed(m >= 100000 ? 0 : 2) + ' km' : Math.round(m) + ' m';
}

function fmtEle(m) {
    return m === null ? '–' : Math.round(m) + ' m';
}

function fmtDuration(s) {
    if (s === null) return '–';
    s = Math.round(s);
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function fmtTime(t) {
    return t === null ? '–' : new Date(t).toLocaleString();
}

function fmtSpeed(dist, s) {
    return s ? (dist / s * 3.6).toFixed(1) + ' km/h' : '–';
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// --- Elevation profile ---

const PROFILE_H = 120, PAD_L = 44, PAD_B = 16, PAD_T = 6, PAD_R = 6;

function niceStep(range, count) {
    const raw = range / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    return [1, 2, 5, 10].map(f => f * mag).find(s => s >= raw) || raw;
}

// SVG of elevation against distance, drawn at the given width in pixels;
// returns { svg, x } (x: distance -> x in pixels)
function profileSvg(stats, color, width) {
    const PROFILE_W = Math.max(200, width);
    const pts = stats.profile.filter(p => p.ele !== null);
    const total = stats.dist || 1;
    let lo = stats.minEle, hi = stats.maxEle;
    if (hi - lo < 10) { lo -= 5; hi += 5; }
    const yStep = niceStep(hi - lo, 4);
    lo = Math.floor(lo / yStep) * yStep;
    hi = Math.ceil(hi / yStep) * yStep;
    const x = d => PAD_L + d / total * (PROFILE_W - PAD_L - PAD_R);
    const y = e => PAD_T + (1 - (e - lo) / (hi - lo)) * (PROFILE_H - PAD_T - PAD_B);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.dist).toFixed(1)},${y(p.ele).toFixed(1)}`).join('');
    const base = y(lo).toFixed(1);
    let grid = '';
    for (let e = lo; e <= hi + 1e-9; e += yStep) {
        grid += `<line x1="${PAD_L}" x2="${PROFILE_W - PAD_R}" y1="${y(e)}" y2="${y(e)}" stroke="#e4e4e4"/>`
            + `<text x="${PAD_L - 4}" y="${y(e) + 4}" text-anchor="end" font-size="11" fill="#777">${Math.round(e)} m</text>`;
    }
    const km = total >= 2000;
    const xStep = niceStep(km ? total / 1000 : total, Math.max(2, Math.floor(PROFILE_W / 110))) * (km ? 1000 : 1);
    for (let d = 0; d <= total + 1e-9; d += xStep) {
        grid += `<text x="${x(d)}" y="${PROFILE_H - 3}" text-anchor="middle" font-size="11" fill="#777">${km ? +(d / 1000).toFixed(1) + ' km' : Math.round(d) + ' m'}</text>`;
    }
    const svg = `<svg viewBox="0 0 ${PROFILE_W} ${PROFILE_H}" width="${PROFILE_W}" height="${PROFILE_H}">${grid}`
        + `<path d="${line}L${x(pts[pts.length - 1].dist).toFixed(1)},${base}L${x(pts[0].dist).toFixed(1)},${base}Z" fill="${color}" fill-opacity=".18"/>`
        + `<path d="${line}" fill="none" stroke="${color}" stroke-width="1.5"/>`
        + `<line class="gpx-cursor" y1="${PAD_T}" y2="${PROFILE_H - PAD_B}" stroke="#333" stroke-dasharray="3,3" visibility="hidden"/>`
        + '</svg>';
    return { svg, x };
}

class GpxViewer {
    constructor(container, state) {
        this.container = container;
        this.fileId = state && state.fileId;
        this.map = null;
        this.layers = [];
        this.selected = -1;
        installStyles();
        this.root = container.element;
        this.root.classList.add('gpx-viewer-root');
        if (container.on) {
            container.on('resize', () => {
                if (this.map) this.map.invalidateSize();
                // The profile is drawn to the panel's width
                if (this.selected >= 0) this.select(this.selected);
            });
            container.on('destroy', () => { if (this.map) this.map.remove(); this.map = null; });
        }
        this.load();
    }

    status(text, isError) {
        this.root.innerHTML = `<div class="gpx-status${isError ? ' error' : ''}"></div>`;
        this.root.firstChild.textContent = text;
    }

    async text() {
        const file = _ctx && _ctx.projectFiles[this.fileId];
        if (!file) return null;
        if (typeof file.content === 'string' && file.content.length) return file.content;
        if (!_ctx.currentWorkspacePath) return null;
        const url = await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(_ctx.currentWorkspacePath + '/' + _ctx.getRelativePath(this.fileId)));
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`could not read the file (${resp.status})`);
        return resp.text();
    }

    async load() {
        this.status('Reading the GPX file…');
        try {
            const src = await this.text();
            if (src === null) { this.status('No GPX file selected.', true); return; }
            const gpx = parseGpx(src);
            gpx.items.forEach(item => { item.stats = measure(item); });
            gpx.items = gpx.items.filter(item => item.stats.points);
            if (!gpx.items.length && !gpx.waypoints.length) { this.status('This GPX file has no tracks, routes or waypoints.', true); return; }
            this.status('Loading the map…');
            const L = await ensureLeafletLoaded();
            this.render(L, gpx);
        } catch (err) {
            this.status('Could not show this GPX file: ' + err.message, true);
        }
    }

    render(L, gpx) {
        this.gpx = gpx;
        const tracks = gpx.items.filter(i => i.kind === 'track').length;
        const routes = gpx.items.length - tracks;
        const counts = [[tracks, 'track'], [routes, 'route'], [gpx.waypoints.length, 'waypoint']]
            .filter(([n]) => n).map(([n, w]) => `${n} ${w}${n === 1 ? '' : 's'}`).join(', ');
        this.root.innerHTML = `<div class="gpx-map"></div><div class="gpx-panel">
<div class="gpx-head">${gpx.name ? `<b>${escapeHtml(gpx.name)}</b> · ` : ''}${counts}${gpx.creator ? ` · made by ${escapeHtml(gpx.creator)}` : ''}</div>
${gpx.items.length ? `<table class="gpx-items"><thead><tr><th>Name</th><th>Points</th><th>Distance</th><th>Climb</th><th>Descent</th><th>Lowest</th><th>Highest</th><th>Start</th><th>Duration</th><th>Moving</th><th>Avg speed</th></tr></thead><tbody>${
    gpx.items.map((item, i) => {
        const s = item.stats;
        const label = item.name || `${item.kind === 'track' ? 'Track' : 'Route'} ${i + 1}`;
        return `<tr class="gpx-item" data-index="${i}"><td><span class="gpx-swatch" style="background:${this.color(i)}"></span>${escapeHtml(label)} <span style="color:#888">${item.kind}${item.type ? ', ' + escapeHtml(item.type) : ''}</span></td>`
            + `<td class="num">${s.points}</td><td class="num">${fmtDist(s.dist)}</td><td class="num">${fmtEle(s.climb)}</td><td class="num">${fmtEle(s.descent)}</td>`
            + `<td class="num">${fmtEle(s.minEle)}</td><td class="num">${fmtEle(s.maxEle)}</td><td>${fmtTime(s.start)}</td>`
            + `<td class="num">${fmtDuration(s.duration)}</td><td class="num">${fmtDuration(s.moving)}</td><td class="num">${fmtSpeed(s.dist, s.moving || s.duration)}</td></tr>`;
    }).join('')}</tbody></table>` : ''}
<div class="gpx-profile-wrap"></div></div>`;

        const map = this.map = L.map(this.root.querySelector('.gpx-map'));
        L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION }).addTo(map);
        L.control.scale({ imperial: false }).addTo(map);
        const bounds = L.latLngBounds([]);
        gpx.items.forEach((item, i) => {
            const latlngs = item.segments.map(seg => seg.map(p => [p.lat, p.lon]));
            const line = L.polyline(latlngs, {
                color: this.color(i), weight: 4, opacity: 0.85,
                dashArray: item.kind === 'route' ? '8,6' : null,
            }).addTo(map);
            line.on('click', () => this.select(i));
            this.layers.push(line);
            bounds.extend(line.getBounds());
            // Start and end of the line
            const first = item.segments[0][0];
            const lastSeg = item.segments[item.segments.length - 1];
            const last = lastSeg[lastSeg.length - 1];
            L.circleMarker([first.lat, first.lon], { radius: 5, color: '#fff', weight: 2, fillColor: '#1e9e5a', fillOpacity: 1 }).bindTooltip('Start').addTo(map);
            L.circleMarker([last.lat, last.lon], { radius: 5, color: '#fff', weight: 2, fillColor: '#c62828', fillOpacity: 1 }).bindTooltip('End').addTo(map);
        });
        for (const w of gpx.waypoints) {
            const m = L.circleMarker([w.lat, w.lon], { radius: 6, color: '#333', weight: 2, fillColor: '#ffd54f', fillOpacity: 1 }).addTo(map);
            if (w.name) m.bindTooltip(escapeHtml(w.name), { permanent: true, direction: 'right', offset: [8, 0], className: 'gpx-wpt-label' });
            const lines = [w.name && `<b>${escapeHtml(w.name)}</b>`, w.desc && escapeHtml(w.desc), w.ele !== null && `Elevation ${fmtEle(w.ele)}`, w.time !== null && fmtTime(w.time)].filter(Boolean);
            if (lines.length) m.bindPopup(lines.join('<br>'));
            bounds.extend([w.lat, w.lon]);
        }
        this.cursor = L.circleMarker([0, 0], { radius: 6, color: '#fff', weight: 2, fillColor: '#222', fillOpacity: 1, interactive: false });
        if (bounds.isValid()) map.fitBounds(bounds, { padding: [20, 20], maxZoom: 16 });
        else map.setView([0, 0], 2);

        this.root.querySelectorAll('.gpx-item').forEach(tr => tr.addEventListener('click', () => this.select(+tr.dataset.index)));
        if (gpx.items.length) this.select(0);
        // The map's size is only known once the tab is laid out
        requestAnimationFrame(() => { if (this.map) this.map.invalidateSize(); });
    }

    color(i) {
        return COLORS[i % COLORS.length];
    }

    // Highlight a track or route and show its elevation profile
    select(i) {
        this.selected = i;
        this.layers.forEach((line, j) => line.setStyle({ weight: j === i ? 6 : 4, opacity: j === i ? 1 : 0.6 }));
        if (this.layers[i]) this.layers[i].bringToFront();
        this.root.querySelectorAll('.gpx-item').forEach(tr => tr.classList.toggle('selected', +tr.dataset.index === i));
        const wrap = this.root.querySelector('.gpx-profile-wrap');
        const stats = this.gpx.items[i].stats;
        // The panel's height changes with the profile, and the map's with it
        requestAnimationFrame(() => { if (this.map) this.map.invalidateSize(); });
        if (stats.minEle === null) {
            wrap.innerHTML = '<div class="gpx-profile-none">No elevation data for this one.</div>';
            return;
        }
        wrap.innerHTML = '<div class="gpx-profile"></div>';
        const box = wrap.querySelector('.gpx-profile');
        const { svg, x } = profileSvg(stats, this.color(i), box.clientWidth - 20);
        box.innerHTML = svg + '<div class="gpx-tip" hidden></div>';
        const svgEl = box.querySelector('svg');
        const cursorLine = svgEl.querySelector('.gpx-cursor');
        const tip = box.querySelector('.gpx-tip');
        const pts = stats.profile.filter(p => p.ele !== null);
        svgEl.addEventListener('mousemove', (e) => {
            const r = svgEl.getBoundingClientRect();
            const vx = e.clientX - r.left;
            // Nearest point by distance
            let best = pts[0];
            for (const p of pts) if (Math.abs(x(p.dist) - vx) < Math.abs(x(best.dist) - vx)) best = p;
            const bx = x(best.dist);
            cursorLine.setAttribute('x1', bx);
            cursorLine.setAttribute('x2', bx);
            cursorLine.setAttribute('visibility', 'visible');
            tip.hidden = false;
            tip.textContent = `${fmtDist(best.dist)} · ${fmtEle(best.ele)}${best.point.time !== null ? ' · ' + new Date(best.point.time).toLocaleTimeString() : ''}`;
            const px = bx + r.left - box.getBoundingClientRect().left;
            tip.style.left = Math.min(px + 8, box.clientWidth - tip.offsetWidth - 4) + 'px';
            this.cursor.setLatLng([best.point.lat, best.point.lon]);
            if (this.map && !this.map.hasLayer(this.cursor)) this.cursor.addTo(this.map);
        });
        svgEl.addEventListener('mouseleave', () => {
            cursorLine.setAttribute('visibility', 'hidden');
            tip.hidden = true;
            if (this.map) this.cursor.remove();
        });
    }
}

registerPlugin({
    id: 'gpx',
    name: 'GPX tracks',
    components: {
        gpxViewer: GpxViewer,
    },
    contextMenuItems: [{
        label: 'Open as GPX map',
        canHandle: (fileName) => GPX_RE.test(fileName || ''),
        action: (fileId) => {
            const file = _ctx && _ctx.projectFiles[fileId];
            if (file) _ctx.openEditorTab('gpxViewer', { fileId }, `${file.name} [map]`, 'gpx-' + fileId);
        },
    }],
    init(ctx) {
        _ctx = ctx;
    },
});
