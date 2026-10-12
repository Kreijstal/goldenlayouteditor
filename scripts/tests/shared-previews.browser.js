// Focused browser smoke tests, including real CDN loaders and cryptography.
// Run after npm run build. Starts its own server and removes temporary fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const browserify = require('browserify');
const archiver = require('archiver');
const root = path.resolve(__dirname, '../..');
const port = process.env.PREVIEW_TEST_PORT || 3141;

async function zip(file, entries) {
    const { createWriteStream } = require('node:fs');
    const output = createWriteStream(file), archive = archiver('zip');
    const done = new Promise((resolve, reject) => { output.on('close', resolve); archive.on('error', reject); output.on('error', reject); });
    archive.pipe(output);
    Object.entries(entries).forEach(([name, content]) => archive.append(content, { name }));
    await archive.finalize(); await done;
}

function volumeHeader() {
    const header = Buffer.alloc(348);
    header.writeInt32LE(348, 0); header.writeInt16LE(3, 40);
    [2, 2, 2].forEach((d, i) => { header.writeInt16LE(d, 42 + 2 * i); header.writeFloatLE(1, 80 + 4 * i); });
    header.writeInt16LE(4, 70); header.writeInt16LE(16, 72); header.write('ni1\0', 344, 'binary');
    return header;
}

async function main() {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-preview-test-'));
    let browser, server;
    try {
        const kml = '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>Fixture point</name><description>&lt;img src=x onerror=alert(1)&gt;</description><Point><coordinates>13.4,52.5,10</coordinates></Point></Placemark><Placemark><name>Fixture polygon</name><Polygon><outerBoundaryIs><LinearRing><coordinates>13,52 14,52 14,53 13,52</coordinates></LinearRing></outerBoundaryIs><innerBoundaryIs><LinearRing><coordinates>13.1,52.1 13.2,52.1 13.2,52.2 13.1,52.1</coordinates></LinearRing></innerBoundaryIs></Polygon></Placemark></Document></kml>';
        await Promise.all([
            fs.writeFile(path.join(temp, 'readme.md'), '# Markdown fixture\n\n**Rendered text**\n\n<script>window.pwned=1</script><img src="x" onerror="window.pwned=1">'),
            fs.writeFile(path.join(temp, 'variants.vcf'), '##fileformat=VCFv4.3\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSample1\n1\t123\trsFixture\tA\tT\t42\tPASS\tDP=9\tGT\t0/1\n'),
            fs.writeFile(path.join(temp, 'contact.vcf'), 'BEGIN:VCARD\nVERSION:3.0\nFN:Contact Fixture\nEND:VCARD'),
            fs.writeFile(path.join(temp, 'volume.HDR'), volumeHeader()),
            fs.writeFile(path.join(temp, 'volume.IMG'), Buffer.from([0,0,10,0,20,0,30,0,40,0,50,0,60,0,70,0])),
            fs.writeFile(path.join(temp, 'radiance.hdr'), '#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n'),
            fs.writeFile(path.join(temp, 'api.json'), JSON.stringify({ openapi: '3.1.0', info: { title: 'Fixture API' }, paths: { '/test': {} } })),
            fs.writeFile(path.join(temp, 'feed.xml'), '<rss version="2.0"><channel><title>Fixture feed</title><item><title>Entry</title></item></channel></rss>'),
            fs.writeFile(path.join(temp, 'map.kml'), kml),
        ]);
        await zip(path.join(temp, 'map.kmz'), { 'doc.kml': kml });
        await zip(path.join(temp, 'model.kmz'), {
            'doc.kml': '<kml><Placemark><name>Embedded triangle</name><Model><Location><longitude>13.4</longitude><latitude>52.5</latitude></Location><Link><href>triangle.dae</href></Link></Model></Placemark></kml>',
            'triangle.dae': '<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1"><asset><unit meter="1" name="meter"/><up_axis>Y_UP</up_axis></asset><library_geometries><geometry id="tri"><mesh><source id="positions"><float_array id="positions-array" count="9">0 0 0 10 0 0 0 10 0</float_array><technique_common><accessor source="#positions-array" count="3" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source><vertices id="vertices"><input semantic="POSITION" source="#positions"/></vertices><triangles count="1"><input semantic="VERTEX" source="#vertices" offset="0"/><p>0 1 2</p></triangles></mesh></geometry></library_geometries><library_visual_scenes><visual_scene id="scene"><node id="node"><instance_geometry url="#tri"/></node></visual_scene></library_visual_scenes><scene><instance_visual_scene url="#scene"/></scene></COLLADA>',
        });
        await zip(path.join(temp, 'triangle.3mf'), {
            '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>',
            '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
            '3D/3dmodel.model': '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>',
        });
        const harness = path.join(temp, 'harness.js');
        await fs.writeFile(harness, `window.previewTest = {
            ...require(${JSON.stringify(path.join(root, 'src/shared-preview-data.js'))}),
            ...require(${JSON.stringify(path.join(root, 'src/pgp-inspection.js'))}),
            ...require(${JSON.stringify(path.join(root, 'src/kml-plugin.js'))}),
            vfs: require(${JSON.stringify(path.join(root, 'src/vfs.js'))}),
        };`);
        const bundle = await new Promise((resolve, reject) => browserify(harness).bundle((err, bytes) => err ? reject(err) : resolve(bytes)));
        server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
        await new Promise((resolve, reject) => {
            server.stdout.on('data', data => { if (String(data).includes('Server listening')) resolve(); });
            server.on('exit', code => reject(new Error(`Test server exited: ${code}`)));
        });
        const WebSocket = require('ws');
        const workspace = await new Promise((resolve, reject) => {
            const socket = new WebSocket(`ws://localhost:${port}/ws`);
            socket.on('open', () => socket.send(JSON.stringify({ type: 'openWorkspace', path: temp, id: 'volume-transport-test' })));
            socket.on('error', reject);
            socket.on('message', data => {
                const reply = JSON.parse(data);
                if (reply.id === 'volume-transport-test') { socket.close(); resolve(reply); }
            });
        });
        assert.equal(workspace.error, undefined);
        assert.equal(workspace.children.find(f => f.name === 'volume.HDR').head.length, 348);
        assert.equal(workspace.children.find(f => f.name === 'volume.IMG').volumeHeader.length, 348);
        assert.equal(workspace.children.find(f => f.name === 'radiance.hdr').head, undefined);
        console.log('PASS server workspace volume-header transport');
        browser = await chromium.launch({ headless: true, args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', err => errors.push(err.message));
        const origin = `http://localhost:${port}`;
        async function browse() {
            await page.goto(`${origin}/?browse=${encodeURIComponent(temp)}`, { waitUntil: 'domcontentloaded' });
            await page.locator('.bm-name').filter({ hasText: 'readme.md' }).waitFor();
        }
        async function open(name) {
            await browse();
            await page.locator('.bm-name').filter({ hasText: name }).click();
            await page.locator('.bm-viewer').waitFor();
        }
        await open('readme.md');
        await page.frameLocator('iframe[title="Rendered Markdown"]').getByRole('heading', { name: 'Markdown fixture' }).waitFor();
        assert.equal(await page.frameLocator('iframe[title="Rendered Markdown"]').locator('script,[onerror]').count(), 0);
        assert.equal(await page.locator('iframe[title="Rendered Markdown"]').getAttribute('sandbox'), '');
        console.log('PASS Markdown rendering and sandbox/sanitization');
        await open('variants.vcf');
        await page.getByText('1 variants · 1 samples', { exact: true }).waitFor();
        await page.locator('input[placeholder^="Filter chromosome"]').fill('rsFixture');
        assert.equal(await page.locator('tbody tr').count(), 1);
        await open('contact.vcf');
        assert.equal(await page.locator('input[placeholder^="Filter chromosome"]').count(), 0);
        console.log('PASS genomic VCF versus vCard routing');
        for (const file of ['volume.HDR', 'volume.IMG']) {
            await open(file);
            await page.getByText(/Slice [12]\/2 · volume 1\/1/).waitFor();
            assert.equal(await page.locator('.bm-viewer-body canvas').count(), 1);
            await page.locator('.bm-viewer-body select').selectOption('0');
            assert.match(await page.locator('.bm-viewer-body').innerText(), /NIfTI-1 volume/);
        }
        await open('radiance.hdr');
        assert.equal(await page.getByText('NIfTI-1 volume').count(), 0);
        console.log('PASS paired HDR/IMG volume slices and Radiance routing');
        await open('api.json');
        await page.locator('.bm-viewer .bm-select').first().selectOption({ label: 'structure' });
        await page.getByRole('heading', { name: 'OpenAPI', exact: true }).waitFor();
        await open('feed.xml');
        await page.locator('.bm-viewer .bm-select').first().selectOption({ label: 'structure' });
        await page.getByRole('heading', { name: 'RSS feed', exact: true }).waitFor();
        console.log('PASS JSON/XML structure previews and domain summaries');
        await open('map.kmz');
        await page.locator('.leaflet-container').waitFor();
        assert.equal(await page.locator('.leaflet-overlay-pane path').count(), 2);
        assert.equal(await page.locator('.bm-viewer-body [onerror]').count(), 0);
        await page.getByRole('button', { name: 'Browse ZIP contents', exact: true }).click();
        await page.locator('.bm-name').filter({ hasText: 'doc.kml' }).waitFor();
        console.log('PASS KMZ geographic rendering and retained ZIP browsing');
        await open('triangle.3mf');
        await page.locator('.model3d-status').filter({ hasText: /bounds/ }).waitFor({ timeout: 45000 });
        assert.equal(await page.locator('.model3d-stage canvas').count(), 1);
        assert.equal(await page.locator('.model3d-stat').filter({ hasText: 'triangles' }).locator('strong').innerText(), '1');
        console.log('PASS 3MF model rendering');
        await open('model.kmz');
        await page.getByRole('button', { name: 'Preview embedded COLLADA model', exact: true }).click();
        await page.locator('.model3d-status').filter({ hasText: /bounds/ }).waitFor({ timeout: 45000 });
        assert.equal(await page.locator('.model3d-stat').filter({ hasText: 'triangles' }).locator('strong').innerText(), '1');
        console.log('PASS KMZ embedded COLLADA model rendering');
        await page.goto(origin + '/ping');
        // The lazy runtime derives its asset base from the executing script URL.
        await page.route(origin + '/preview-test-harness.js', route => route.fulfill({
            contentType: 'application/javascript', body: bundle,
        }));
        await page.addScriptTag({ url: origin + '/preview-test-harness.js' });
        const localWorkspace = await page.evaluate(async header => {
            const { vfs } = window.previewTest;
            const dir = '/' + vfs.LocalFS.OPFS_NAME + '/shared-preview-test';
            const router = vfs.createRouter(null);
            try {
                await vfs.mkdir(dir);
                await vfs.write(dir + '/volume.HDR', new Uint8Array(header));
                await vfs.write(dir + '/volume.IMG', new Uint8Array(16));
                return await new Promise(resolve => {
                    router.addEventListener('message', event => {
                        const reply = JSON.parse(event.data);
                        if (reply.id === 'local-volume-test') resolve(reply);
                    });
                    router.send(JSON.stringify({ type: 'openWorkspace', path: dir, id: 'local-volume-test' }));
                });
            } finally { await vfs.remove(dir); }
        }, Array.from(volumeHeader()));
        assert.equal(localWorkspace.error, undefined);
        assert.equal(localWorkspace.children.find(f => f.name === 'volume.HDR').head.length, 348);
        assert.equal(localWorkspace.children.find(f => f.name === 'volume.IMG').volumeHeader.length, 348);
        console.log('PASS browser-storage workspace volume-header transport');
        const crypto = await page.evaluate(async () => {
            const pgp = await import('https://esm.sh/openpgp@6.3.2');
            const { inspectPgp, verifyPgp, parseXml, summarizeXml, parseKml } = window.previewTest;
            const generated = await pgp.generateKey({ type: 'ecc', curve: 'ed25519', userIDs: [{ name: 'Preview fixture' }], format: 'object' });
            const key = generated.privateKey, publicKey = generated.publicKey.armor();
            const payload = new TextEncoder().encode('Signed preview fixture');
            const message = await pgp.createMessage({ binary: payload, filename: 'fixture.txt' });
            const detached = await pgp.sign({ message, signingKeys: key, detached: true, format: 'binary' });
            const inspection = await inspectPgp(pgp, detached);
            const good = await verifyPgp(pgp, inspection, publicKey, payload);
            let tamperRejected = false;
            try { const bad = await verifyPgp(pgp, inspection, publicKey, new TextEncoder().encode('tampered')); tamperRejected = bad.every(s => !s.verified); }
            catch (err) { tamperRejected = /digest|signature|verif/i.test(err.message); }
            const signed = await pgp.sign({ message, signingKeys: key, format: 'binary' });
            const signedInspection = await inspectPgp(pgp, signed);
            const signedResult = await verifyPgp(pgp, signedInspection, publicKey);
            const clear = await pgp.sign({ message: await pgp.createCleartextMessage({ text: 'Cleartext fixture' }), signingKeys: key });
            const clearInspection = await inspectPgp(pgp, new TextEncoder().encode(clear));
            const clearResult = await verifyPgp(pgp, clearInspection, publicKey);
            const certificate = await inspectPgp(pgp, new TextEncoder().encode(publicKey));
            const encrypted = await inspectPgp(pgp, await pgp.encrypt({ message, passwords: ['test-fixture'], format: 'binary' }));
            return {
                good: good.every(s => s.verified), bad: tamperRejected, signed: signedResult.every(s => s.verified), clear: clearResult.every(s => s.verified),
                certificate: certificate.kind, encrypted: encrypted.kind,
                xml: summarizeXml(parseXml('<testsuites><testsuite><testcase><failure/></testcase></testsuite></testsuites>')),
                kmlRings: parseKml('<kml><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>1,2 2,3 1,2</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>').items[0].shapes[0].rings.length,
                fixtures: {
                    detached: await pgp.sign({ message, signingKeys: key, detached: true }), publicKey, clear, signed: Array.from(signed),
                    encrypted: Array.from(await pgp.encrypt({ message, passwords: ['test-fixture'], signingKeys: key, format: 'binary' })),
                },
            };
        });
        assert.equal(crypto.good, true); assert.equal(crypto.bad, true); assert.equal(crypto.signed, true); assert.equal(crypto.clear, true);
        assert.equal(crypto.certificate, 'certificate'); assert.equal(crypto.encrypted, 'encrypted message');
        assert.equal(crypto.xml.failures, 1); assert.equal(crypto.kmlRings, 1);
        await fs.writeFile(path.join(temp, 'signature.asc'), crypto.fixtures.detached);
        await fs.writeFile(path.join(temp, 'certificate.asc'), crypto.fixtures.publicKey);
        await fs.writeFile(path.join(temp, 'clear.asc'), crypto.fixtures.clear);
        await fs.writeFile(path.join(temp, 'signed.gpg'), Buffer.from(crypto.fixtures.signed));
        await fs.writeFile(path.join(temp, 'encrypted.pgp'), Buffer.from(crypto.fixtures.encrypted));
        for (const file of ['signature.asc', 'clear.asc', 'signed.gpg']) {
            await open(file);
            await page.getByRole('button', { name: 'Verify signature', exact: true }).waitFor({ timeout: 10000 }).catch(async err => { throw new Error(file + ': ' + (await page.locator('.bm-viewer-body').innerText()) + '\n' + err.message); });
        }
        await open('certificate.asc');
        await page.getByRole('cell', { name: 'Fingerprint', exact: true }).waitFor();
        await open('encrypted.pgp');
        await page.locator('.gpg-card input[type=password]').fill('test-fixture');
        await page.getByRole('button', { name: 'Decrypt', exact: true }).click();
        await page.getByRole('button', { name: 'Inspect / verify signatures', exact: true }).click();
        await page.locator('.gpg-body textarea').fill(crypto.fixtures.publicKey);
        await page.getByRole('button', { name: 'Verify signature', exact: true }).click();
        await page.getByText(/Valid signature for the supplied key/).waitFor();
        console.log('PASS OpenPGP detached, binary-container, cleartext and certificate inspection; valid and tampered signatures');
        assert.deepEqual(errors, []);
        console.log('PASS no uncaught browser errors');
    } finally {
        if (browser) await browser.close();
        if (server) server.kill();
        await fs.rm(temp, { recursive: true, force: true });
    }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
