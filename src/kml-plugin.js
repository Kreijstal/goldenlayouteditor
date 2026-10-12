const { registerPlugin } = require('./plugins');
const { readViewerFile, element, table } = require('./viewer-file');
const { parseXml } = require('./shared-preview-data');
let ctx, mapModules;
const nodes = (el, name) => [...el.getElementsByTagName('*')].filter(n => n.localName === name);
const textOf = (el, name) => (nodes(el, name)[0] || {}).textContent || '';

function coordinates(text) {
    return text.trim().split(/\s+/).filter(Boolean).map(c => c.split(',').map(Number)).filter(c => c.length >= 2 && c.every(Number.isFinite) && Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90).map(c => [c[1], c[0], c[2]]);
}

function parseKml(text) {
    const doc = parseXml(text);
    if (doc.documentElement.localName !== 'kml') throw new Error('Not a KML document.');
    const items = nodes(doc.documentElement, 'Placemark').map((p, i) => {
        const shapes = [];
        for (const point of nodes(p, 'Point')) shapes.push({ type: 'Point', rings: [coordinates(textOf(point, 'coordinates'))] });
        for (const line of nodes(p, 'LineString')) shapes.push({ type: 'LineString', rings: [coordinates(textOf(line, 'coordinates'))] });
        for (const polygon of nodes(p, 'Polygon')) shapes.push({ type: 'Polygon', rings: nodes(polygon, 'LinearRing').map(r => coordinates(textOf(r, 'coordinates'))) });
        for (const track of nodes(p, 'Track')) {
            const coords = nodes(track, 'coord').map(c => coordinates(c.textContent.trim().split(/\s+/).join(','))[0]).filter(Boolean);
            shapes.push({ type: 'Track', rings: [coords] });
        }
        const models = nodes(p, 'Model').map(m => ({ href: textOf(m, 'href').trim(), latitude: textOf(m, 'latitude'), longitude: textOf(m, 'longitude'), altitude: textOf(m, 'altitude') }));
        return { name: textOf(p, 'name').trim() || `Placemark ${i + 1}`, description: textOf(p, 'description').trim(), shapes, models };
    });
    return { items, networkLinks: nodes(doc.documentElement, 'NetworkLink').length, overlays: nodes(doc.documentElement, 'GroundOverlay').length };
}

async function readKml(bytes, name) {
    if (!/\.kmz$/i.test(name)) return new TextDecoder().decode(bytes);
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('Not a ZIP/KMZ container.');
    const { unzipSync } = await import('https://esm.sh/fflate@0.8.2');
    let totalSize = 0;
    const files = unzipSync(bytes, { filter: entry => {
        if (!/\.kml$/i.test(entry.name) || totalSize + entry.originalSize > 20 * 1024 * 1024) return false;
        totalSize += entry.originalSize;
        return true;
    } });
    const names = Object.keys(files).filter(n => /\.kml$/i.test(n)).sort();
    const entry = names.find(n => /^doc\.kml$/i.test(n)) || names[0];
    if (!entry) throw new Error('KMZ contains no KML document within the 20 MB preview limit.');
    return new TextDecoder().decode(files[entry]);
}

function loadMap() {
    if (!mapModules) {
        const css = element('link', null, document.head);
        css.rel = 'stylesheet'; css.href = 'https://esm.sh/leaflet@1.9.4/dist/leaflet.css?raw';
        mapModules = import('https://esm.sh/leaflet@1.9.4').then(m => m.default || m);
        mapModules.catch(() => { mapModules = null; css.remove(); });
    }
    return mapModules;
}

class KmlViewer {
    constructor(container, state) {
        this.fileId = state.fileId;
        this.root = container.element;
        this.root.style.cssText += 'height:100%;display:flex;flex-direction:column;background:#fff;color:#222;font:13px system-ui';
        container.on('destroy', () => { this.destroyed = true; if (this.map) this.map.remove(); });
        container.on('resize', () => { if (this.map) this.map.invalidateSize(); });
        this.load();
    }
    async load() {
        this.root.textContent = 'Reading KML…';
        try {
            const file = ctx.projectFiles[this.fileId];
            const data = parseKml(await readKml(await readViewerFile(ctx, this.fileId), file.name));
            if (this.destroyed) return;
            this.root.replaceChildren();
            const bar = element('div', `${data.items.length} placemarks · ${data.networkLinks} network links · ${data.overlays} ground overlays`, this.root);
            bar.style.padding = '8px';
            const modelCount = data.items.reduce((n, p) => n + p.models.length, 0);
            if (/\.kmz$/i.test(file.name)) {
                const archive = element('button', 'Browse ZIP contents', bar);
                archive.onclick = () => { window.location.href = '?browse=' + encodeURIComponent(ctx.currentWorkspacePath + '/' + ctx.getRelativePath(this.fileId)); };
                if (modelCount) {
                    const model = element('button', 'Preview embedded COLLADA model', bar);
                    model.onclick = () => ctx.openEditorTab('model3dViewer', { fileId: this.fileId }, `${file.name} [3d]`, 'model3d-' + this.fileId);
                }
            }
            element('div', 'Points, lines, polygon rings and gx tracks are mapped. Network links and ground overlays are counted but not fetched or rendered.', bar);
            const mapHost = element('div', null, this.root);
            mapHost.style.cssText = 'flex:1;min-height:160px';
            const panel = element('div', null, this.root);
            panel.style.cssText = 'max-height:40%;overflow:auto';
            table(panel, ['Placemark', 'Geometry', 'Description / model'], data.items.map(p => [p.name, p.shapes.map(s => s.type).join(', '), [p.description, ...p.models.map(m => `${m.href} at ${m.latitude}, ${m.longitude}, ${m.altitude}`)].filter(Boolean).join('\n')]));
            const L = await loadMap();
            if (this.destroyed) return;
            this.map = L.map(mapHost);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(this.map);
            const layers = [];
            data.items.forEach(p => {
                const popup = () => element('div', [p.name, p.description].filter(Boolean).join('\n'));
                p.shapes.forEach(s => {
                    const rings = s.rings.filter(r => r.length).map(r => r.map(c => c.slice(0, 2)));
                    if (!rings.length) return;
                    if (s.type === 'Point') rings[0].forEach(c => layers.push(L.circleMarker(c).bindPopup(popup()).addTo(this.map)));
                    else layers.push((s.type === 'Polygon' ? L.polygon(rings) : L.polyline(rings)).bindPopup(popup()).addTo(this.map));
                });
                p.models.forEach(m => {
                    const lat = +m.latitude, lon = +m.longitude;
                    if (m.latitude && m.longitude && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) layers.push(L.circleMarker([lat, lon], { color: '#a40' }).bindPopup(element('div', `${p.name} · model ${m.href}`)).addTo(this.map));
                });
            });
            const bounds = L.featureGroup(layers).getBounds();
            if (bounds.isValid()) this.map.fitBounds(bounds, { padding: [20, 20], maxZoom: 16 });
            else this.map.setView([0, 0], 2);
            requestAnimationFrame(() => { if (!this.destroyed) this.map.invalidateSize(); });
        } catch (err) { if (!this.destroyed) this.root.textContent = 'Could not preview KML: ' + err.message; }
    }
}

registerPlugin({ id: 'kml', name: 'KML / KMZ map', components: { kmlViewer: KmlViewer }, init(context) { ctx = context; } });
module.exports = { parseKml, coordinates };
