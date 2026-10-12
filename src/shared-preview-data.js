function isVariantText(text) {
    return /^\uFEFF?##fileformat=VCFv\d+\.\d+(?:\r?\n|$)/.test(text || '');
}

function parseVariants(text) {
    text = text.replace(/^\uFEFF/, '');
    if (!isVariantText(text)) throw new Error('Not a genomic Variant Call Format file.');
    const meta = [], rows = [];
    let columns, total = 0;
    const chromosomes = new Map(), filters = new Map();
    for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        if (line.startsWith('##')) { meta.push(line.slice(2)); continue; }
        if (line.startsWith('#CHROM\t')) {
            if (columns) throw new Error('Duplicate VCF column header.');
            columns = line.slice(1).split('\t');
            if (columns.slice(0, 8).join('\t') !== 'CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO') throw new Error('Invalid VCF columns.');
            if (columns.length > 8 && columns[8] !== 'FORMAT') throw new Error('VCF sample columns require FORMAT.');
            continue;
        }
        if (line.startsWith('#')) continue;
        if (!columns) throw new Error('Missing #CHROM column header.');
        const row = line.split('\t');
        if (row.length !== columns.length || !/^\d+$/.test(row[1]) || +row[1] < 1) throw new Error(`Invalid variant record ${total + 1}.`);
        total++;
        chromosomes.set(row[0], (chromosomes.get(row[0]) || 0) + 1);
        filters.set(row[6], (filters.get(row[6]) || 0) + 1);
        if (rows.length < 5000) rows.push(row);
    }
    if (!columns) throw new Error('Missing #CHROM column header.');
    return { meta, columns, rows, total, chromosomes: Object.fromEntries(chromosomes), filters: Object.fromEntries(filters), samples: columns.slice(9) };
}

function summarizeJson(value, name = '') {
    if (!value || typeof value !== 'object') return { schema: 'JSON value', type: value === null ? 'null' : typeof value, value };
    if (Array.isArray(value)) return { schema: 'JSON array', entries: value.length };
    if (value.type === 'FeatureCollection' && Array.isArray(value.features)) return { schema: 'GeoJSON', features: value.features.length, geometryTypes: [...new Set(value.features.map(f => f && f.geometry && f.geometry.type).filter(Boolean))] };
    if (value.type === 'Feature' && value.geometry) return { schema: 'GeoJSON feature', geometry: value.geometry.type, properties: Object.keys(value.properties || {}) };
    if (typeof value.openapi === 'string' || typeof value.swagger === 'string') return { schema: 'OpenAPI', version: value.openapi || value.swagger, title: value.info && value.info.title, paths: Object.keys(value.paths || {}).length, servers: value.servers || [] };
    if (value.$schema || value.properties || value.$defs) return { schema: 'JSON Schema', dialect: value.$schema, title: value.title, type: value.type, properties: Object.keys(value.properties || {}), required: value.required || [], definitions: Object.keys(value.$defs || value.definitions || {}) };
    if (/^package(?:-lock)?\.json$/i.test(name) || (typeof value.name === 'string' && value.dependencies)) return { schema: 'npm package', name: value.name, version: value.version, scripts: value.scripts || {}, dependencies: value.dependencies || {}, devDependencies: value.devDependencies || {} };
    if (value.cells && value.nbformat) return { schema: 'Jupyter notebook', version: value.nbformat, cells: value.cells.length, kernel: value.metadata && value.metadata.kernelspec };
    if (value.log && Array.isArray(value.log.entries)) return { schema: 'HTTP Archive', requests: value.log.entries.length, pages: (value.log.pages || []).length, creator: value.log.creator };
    return { schema: 'JSON object', keys: Object.keys(value), declaredSchema: value.$schema || null };
}

function parseXml(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('Not well-formed XML: ' + doc.querySelector('parsererror').textContent.slice(0, 250));
    return doc;
}

function summarizeXml(doc) {
    const root = doc.documentElement;
    const elements = [...doc.getElementsByTagName('*')];
    const count = name => elements.filter(e => e.localName === name).length;
    const text = name => (elements.find(e => e.localName === name) || {}).textContent || '';
    const base = { root: root.localName, namespace: root.namespaceURI || '', elements: elements.length };
    switch (root.localName) {
    case 'rss': return { schema: 'RSS feed', ...base, title: text('title'), items: count('item') };
    case 'feed': return { schema: 'Atom feed', ...base, title: text('title'), entries: count('entry') };
    case 'svg': return { schema: 'SVG', ...base, viewBox: root.getAttribute('viewBox'), paths: count('path'), images: count('image') };
    case 'kml': return { schema: 'KML', ...base, placemarks: count('Placemark'), models: count('Model'), networkLinks: count('NetworkLink') };
    case 'gpx': return { schema: 'GPX', ...base, tracks: count('trk'), routes: count('rte'), waypoints: count('wpt') };
    case 'project': return { schema: root.namespaceURI === 'http://maven.apache.org/POM/4.0.0' ? 'Maven POM' : 'XML project', ...base, artifact: text('artifactId'), version: text('version'), dependencies: count('dependency') };
    case 'testsuites': case 'testsuite': return { schema: 'JUnit test report', ...base, suites: count('testsuite'), tests: count('testcase'), failures: count('failure'), errors: count('error'), skipped: count('skipped') };
    case 'urlset': case 'sitemapindex': return { schema: 'Sitemap', ...base, locations: count('loc') };
    default: return { schema: 'XML document', ...base, children: [...new Set([...root.children].map(e => e.localName))] };
    }
}

module.exports = { isVariantText, parseVariants, summarizeJson, parseXml, summarizeXml };
